/**
 * Vercel serverless function: GET /api/config
 *
 * Vercel serves `index.html` as a static file, so the page cannot read
 * `process.env` directly. This function exposes only the *public* runtime
 * configuration the browser needs:
 *
 *   - supabaseUrl      : public project URL
 *   - supabaseAnonKey  : public anon key (protected by RLS)
 *   - promptPayId      : the seller's PromptPay identifier
 *   - shopName         : display name
 *   - catalogue        : active products (from pomelo_catalogue)
 *   - content          : editable page text (from pomelo_page_content)
 *
 * The catalogue and page text are read from Supabase so the owner can edit
 * them in /admin.html without a redeploy. Both tables are public-read, so the
 * anon key is sufficient. If the RBAC migration (0002) has not been applied
 * yet, these reads fail silently and the client falls back to its built-in
 * defaults.
 *
 * The `service_role` key is never referenced here and must never be added to
 * this project's environment.
 */

import { createClient } from "@supabase/supabase-js";

/** Read a public table, returning [] on any error (e.g. table not created yet). */
async function safeSelect(supabase, table, columns, order) {
  try {
    let query = supabase.from(table).select(columns);
    if (order) query = query.order(order.column, { ascending: order.ascending });
    const { data, error } = await query;
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  // Cache at the edge for 5 minutes; config rarely changes.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300");

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";

  const config = {
    supabaseUrl,
    supabaseAnonKey,
    promptPayId: process.env.PROMPTPAY_ID || "",
    shopName: process.env.SHOP_NAME || "Pomelo Shop",
    catalogue: [],
    content: {},
  };

  // Pull the live catalogue + page text when Supabase is configured.
  if (supabaseUrl && supabaseAnonKey) {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const [items, settings, content] = await Promise.all([
      safeSelect(supabase, "pomelo_catalogue", "sku, label, unit_price, sort_order, active", {
        column: "sort_order",
        ascending: true,
      }),
      safeSelect(supabase, "pomelo_settings", "key, value", null),
      safeSelect(supabase, "pomelo_page_content", "key, value", null),
    ]);

    // Only expose active items, in the shape the storefront expects.
    config.catalogue = items
      .filter((it) => it.active !== false)
      .map((it) => ({ sku: it.sku, label: it.label, unitPrice: it.unit_price }));

    // A settings row overrides the env fallback for promptpay_id.
    for (const row of settings) {
      if (row.key === "promptpay_id" && row.value) config.promptPayId = row.value;
    }

    for (const row of content) {
      if (row.key) config.content[row.key] = row.value;
    }
  }

  // Surface a clear signal to the client when setup is incomplete, rather than
  // letting the page fail with an opaque network error later.
  const missing = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseAnonKey) missing.push("SUPABASE_ANON_KEY");
  if (!config.promptPayId) missing.push("PROMPTPAY_ID");

  res.status(200).json({ ...config, missing });
}

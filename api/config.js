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
 *   - promptPayQrPayload : confirmed EMVCo payload from an uploaded bank QR
 *                        (when set, the storefront builds the QR from this
 *                        instead of promptPayId)
 *   - shopName         : display name
 *   - catalogue        : active products (from pomelo_catalogue)
 *   - content          : editable page text (from pomelo_page_content)
 *   - deliveryMethods  : active delivery methods (from pomelo_delivery_methods)
 *
 * The catalogue, page text and delivery methods are read from Supabase so the
 * owner can edit them in /admin.html without a redeploy. All three tables are
 * public-read, so the anon key is sufficient. If the RBAC migration (0002) has
 * not been applied yet, these reads fail silently and the client falls back to
 * its built-in defaults.
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
  // Do NOT cache at the edge. The owner can change the payment QR at any time
  // from /admin.html, and a cached response would keep serving the previous
  // receiving account to buyers for the whole cache lifetime. The payload is
  // small and the endpoint is cheap, so correctness wins over caching here.
  res.setHeader("Cache-Control", "no-store, max-age=0");

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";

  const config = {
    supabaseUrl,
    supabaseAnonKey,
    promptPayId: process.env.PROMPTPAY_ID || "",
    promptPayQrPayload: "",
    shopName: process.env.SHOP_NAME || "Pomelo Shop",
    catalogue: [],
    content: {},
    deliveryMethods: [],
  };

  // Pull the live catalogue + page text when Supabase is configured.
  if (supabaseUrl && supabaseAnonKey) {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const [items, settings, content, methods] = await Promise.all([
      safeSelect(supabase, "pomelo_catalogue", "sku, label, unit_price, sort_order, active", {
        column: "sort_order",
        ascending: true,
      }),
      safeSelect(supabase, "pomelo_settings", "key, value", null),
      safeSelect(supabase, "pomelo_page_content", "key, value", null),
      safeSelect(
        supabase,
        "pomelo_delivery_methods",
        "code, label, description, map_url, time_window, sort_order, active",
        { column: "sort_order", ascending: true }
      ),
    ]);

    // Only expose active items, in the shape the storefront expects.
    config.catalogue = items
      .filter((it) => it.active !== false)
      .map((it) => ({ sku: it.sku, label: it.label, unitPrice: it.unit_price }));

    // Only expose active delivery methods, in the shape the storefront expects.
    config.deliveryMethods = methods
      .filter((m) => m.active !== false)
      .map((m) => ({
        code: m.code,
        label: m.label,
        description: m.description || "",
        mapUrl: m.map_url || "",
        timeWindow: m.time_window || "",
      }));

    // A settings row overrides the env fallback for promptpay_id.
    for (const row of settings) {
      if (row.key === "promptpay_id" && row.value) config.promptPayId = row.value;
      // A confirmed bank-QR payload takes precedence over the raw ID: the
      // storefront rebuilds the QR from it so the buyer pays the exact account
      // the owner verified in the admin console.
      if (row.key === "promptpay_qr_payload" && row.value) {
        config.promptPayQrPayload = row.value;
      }
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
  // Either a confirmed QR payload or a PromptPay ID is enough to take payment.
  if (!config.promptPayId && !config.promptPayQrPayload) missing.push("PROMPTPAY_ID");

  res.status(200).json({ ...config, missing });
}

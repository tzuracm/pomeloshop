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
 *
 * The `service_role` key is never referenced here and must never be added to
 * this project's environment.
 */

export default function handler(req, res) {
  // Cache at the edge for 5 minutes; config rarely changes.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300");

  const config = {
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    promptPayId: process.env.PROMPTPAY_ID || "",
    shopName: process.env.SHOP_NAME || "Pomelo Shop",
  };

  // Surface a clear signal to the client when setup is incomplete, rather than
  // letting the page fail with an opaque network error later.
  const missing = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseAnonKey) missing.push("SUPABASE_ANON_KEY");
  if (!config.promptPayId) missing.push("PROMPTPAY_ID");

  res.status(200).json({ ...config, missing });
}

/**
 * Vercel serverless function: /api/admin/settings
 *
 *   GET — read sensitive settings (any staff role: user/admin/owner)
 *   PUT — modify sensitive settings (owner ONLY)
 *
 * Settings are readable by everyone (the storefront needs the PromptPay ID to
 * build the QR), but only the owner may change them.
 *
 * Body for PUT: { key: string, value: string }  or  { entries: {k: v, ...} }
 */

import { requireRole, withErrors, sendJson, readBody, HttpError } from "./_auth.js";

/** Keys the owner is allowed to write. Extend as needed. */
const WRITABLE_KEYS = new Set(["promptpay_id", "bank_name", "bank_account", "bank_holder"]);

const MAX_VALUE = 500;

function handler(req, res) {
  if (req.method === "GET") return listSettings(req, res);
  if (req.method === "PUT") return putSettings(req, res);
  res.setHeader("Allow", "GET, PUT");
  return sendJson(res, 405, { error: "Method not allowed." });
}

async function listSettings(req, res) {
  const { admin } = await requireRole(req, "user");
  const { data, error } = await admin
    .from("pomelo_settings")
    .select("key, value, updated_at")
    .order("key", { ascending: true });

  if (error) throw new HttpError(500, "Failed to load settings: " + error.message);
  return sendJson(res, 200, { settings: data || [] });
}

function validateEntry(key, value) {
  const k = String(key || "").trim();
  if (!WRITABLE_KEYS.has(k)) {
    throw new HttpError(400, `Setting '${k}' is not writable. Allowed: ${[...WRITABLE_KEYS].join(", ")}.`);
  }
  const v = String(value == null ? "" : value).trim();
  if (v.length > MAX_VALUE) throw new HttpError(400, "Setting value too long.");
  return { key: k, value: v };
}

async function putSettings(req, res) {
  const { user, admin } = await requireRole(req, "owner");
  const body = readBody(req);

  let rows = [];
  if (body.entries && typeof body.entries === "object") {
    rows = Object.keys(body.entries).map((k) => validateEntry(k, body.entries[k]));
  } else {
    rows = [validateEntry(body.key, body.value)];
  }

  if (rows.length === 0) throw new HttpError(400, "No settings supplied.");

  const now = new Date().toISOString();
  const payload = rows.map((r) => ({ ...r, updated_at: now, updated_by: user.id }));

  const { data, error } = await admin
    .from("pomelo_settings")
    .upsert(payload, { onConflict: "key" })
    .select("key, value, updated_at");

  if (error) throw new HttpError(500, "Failed to save settings: " + error.message);
  return sendJson(res, 200, { settings: data || [] });
}

export default withErrors(handler);

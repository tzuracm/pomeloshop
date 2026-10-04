/**
 * Vercel serverless function: /api/admin/content
 *
 *   GET — read editable page text (any staff role)
 *   PUT — upsert page text (owner only)
 *
 * Body for PUT: { key: string, value: string }  or  { entries: {k: v, ...} }
 */

import { requireRole, withErrors, sendJson, readBody, HttpError } from "./_auth.js";

const MAX_KEY = 64;
const MAX_VALUE = 4000;

function handler(req, res) {
  if (req.method === "GET") return listContent(req, res);
  if (req.method === "PUT") return putContent(req, res);
  res.setHeader("Allow", "GET, PUT");
  return sendJson(res, 405, { error: "Method not allowed." });
}

async function listContent(req, res) {
  const { admin } = await requireRole(req, "user");
  const { data, error } = await admin
    .from("pomelo_page_content")
    .select("key, value, updated_at")
    .order("key", { ascending: true });

  if (error) throw new HttpError(500, "Failed to load content: " + error.message);
  return sendJson(res, 200, { content: data || [] });
}

function validateEntry(key, value) {
  const k = String(key || "").trim();
  const v = String(value == null ? "" : value);
  if (!k) throw new HttpError(400, "Content key is required.");
  if (k.length > MAX_KEY) throw new HttpError(400, "Content key too long.");
  if (v.length > MAX_VALUE) throw new HttpError(400, "Content value too long.");
  return { key: k, value: v };
}

async function putContent(req, res) {
  const { user, admin } = await requireRole(req, "owner");
  const body = readBody(req);

  // Accept either a single {key,value} or a batch {entries:{...}}.
  let rows = [];
  if (body.entries && typeof body.entries === "object") {
    rows = Object.keys(body.entries).map((k) => validateEntry(k, body.entries[k]));
  } else {
    rows = [validateEntry(body.key, body.value)];
  }

  if (rows.length === 0) throw new HttpError(400, "No content supplied.");

  const now = new Date().toISOString();
  const payload = rows.map((r) => ({ ...r, updated_at: now }));

  const { data, error } = await admin
    .from("pomelo_page_content")
    .upsert(payload, { onConflict: "key" })
    .select("key, value, updated_at");

  if (error) throw new HttpError(500, "Failed to save content: " + error.message);
  return sendJson(res, 200, { content: data || [], updated_by: user.id });
}

export default withErrors(handler);

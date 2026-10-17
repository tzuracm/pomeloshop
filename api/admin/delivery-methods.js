/**
 * Vercel serverless function: /api/admin/delivery-methods
 *
 *   GET    — list all delivery methods (any staff role)
 *   POST   — create a method (admin/owner); the `code` is generated server-side
 *   PATCH  — update a method (admin/owner)
 *   DELETE — remove a method (admin/owner)
 *
 * A delivery method is what the storefront shows under 交货方式:
 *   label        display name (e.g. 自提)
 *   description  optional sub-label (e.g. Self-Pickup)
 *   map_url      optional Google Maps link for the pickup point
 *   time_window  optional pickup time window (free text)
 *   sort_order   display order
 *   active       hidden methods are not offered to buyers
 *
 * `code` is a stable identifier stored on pomelo_orders.fulfilment. It is
 * generated from the label on create and is immutable afterwards so historical
 * orders keep resolving.
 */

import { requireRole, withErrors, sendJson, readBody, HttpError } from "./_auth.js";

const MAX_LABEL = 60;
const MAX_DESCRIPTION = 120;
const MAX_URL = 500;
const MAX_TIME_WINDOW = 120;

/** How many times to retry when a generated code collides. */
const CODE_MAX_ATTEMPTS = 25;

function handler(req, res) {
  switch (req.method) {
    case "GET":    return listMethods(req, res);
    case "POST":   return createMethod(req, res);
    case "PATCH":  return updateMethod(req, res);
    case "DELETE": return deleteMethod(req, res);
    default:
      res.setHeader("Allow", "GET, POST, PATCH, DELETE");
      return sendJson(res, 405, { error: "Method not allowed." });
  }
}

/**
 * Derive a URL-safe code from a human label.
 *   "自提"        -> "method"   (no ASCII letters to work with)
 *   "Grab 到付"   -> "grab"
 *   "Store Pickup"-> "store_pickup"
 * The caller appends a numeric suffix when needed, so the result is always
 * unique and never empty.
 */
function slugify(label) {
  const slug = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "method";
}

/** Generate the next free code for `label`. */
async function generateCode(admin, label) {
  const base = slugify(label);
  const { data, error } = await admin
    .from("pomelo_delivery_methods")
    .select("code")
    .like("code", base + "%");

  if (error) throw new HttpError(500, "Failed to generate code: " + error.message);

  const taken = new Set((data || []).map((r) => r.code));
  if (!taken.has(base)) return base;

  for (let n = 2; n < 1000; n++) {
    const candidate = base + "_" + n;
    if (!taken.has(candidate)) return candidate;
  }
  throw new HttpError(409, "Could not allocate a unique code; please retry.");
}

/** Validate and normalise a delivery-method payload. */
function normalise(body, { requireLabel }) {
  const out = {};

  if (requireLabel || Object.prototype.hasOwnProperty.call(body, "label")) {
    const label = String(body.label || "").trim();
    if (!label) throw new HttpError(400, "label is required.");
    if (label.length > MAX_LABEL) throw new HttpError(400, "label is too long.");
    out.label = label;
  }

  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    const d = String(body.description == null ? "" : body.description).trim();
    if (d.length > MAX_DESCRIPTION) throw new HttpError(400, "description is too long.");
    out.description = d;
  }

  if (Object.prototype.hasOwnProperty.call(body, "map_url")) {
    const u = String(body.map_url == null ? "" : body.map_url).trim();
    if (u.length > MAX_URL) throw new HttpError(400, "map_url is too long.");
    if (u && !/^https?:\/\//i.test(u)) {
      throw new HttpError(400, "map_url must start with http:// or https://.");
    }
    out.map_url = u;
  }

  if (Object.prototype.hasOwnProperty.call(body, "time_window")) {
    const t = String(body.time_window == null ? "" : body.time_window).trim();
    if (t.length > MAX_TIME_WINDOW) throw new HttpError(400, "time_window is too long.");
    out.time_window = t;
  }

  if (Object.prototype.hasOwnProperty.call(body, "sort_order")) {
    const s = Number(body.sort_order);
    out.sort_order = Number.isInteger(s) ? s : 0;
  }

  if (Object.prototype.hasOwnProperty.call(body, "active")) {
    out.active = Boolean(body.active);
  }

  return out;
}

async function listMethods(req, res) {
  const { admin } = await requireRole(req, "user");
  const { data, error } = await admin
    .from("pomelo_delivery_methods")
    .select("*")
    .order("sort_order", { ascending: true });

  if (error) throw new HttpError(500, "Failed to load delivery methods: " + error.message);
  return sendJson(res, 200, { methods: data || [] });
}

async function createMethod(req, res) {
  const { admin } = await requireRole(req, "admin");
  const body = readBody(req);
  const row = normalise(body, { requireLabel: true });

  // The code is always generated server-side; any client-supplied value is
  // ignored so identifiers stay stable and collision-free.
  for (let attempt = 0; attempt < CODE_MAX_ATTEMPTS; attempt++) {
    const code = await generateCode(admin, row.label);
    const { data, error } = await admin
      .from("pomelo_delivery_methods")
      .insert({ ...row, code })
      .select("*")
      .maybeSingle();

    if (!error) return sendJson(res, 201, { method: data });

    // 23505 = unique violation: another request took this code, try the next.
    if (error.code !== "23505") {
      throw new HttpError(500, "Failed to create delivery method: " + error.message);
    }
  }

  throw new HttpError(409, "Could not allocate a unique code; please retry.");
}

async function updateMethod(req, res) {
  const { admin } = await requireRole(req, "admin");
  const body = readBody(req);
  const code = String(body.code || "").trim();
  if (!code) throw new HttpError(400, "code is required.");

  const patch = normalise(body, { requireLabel: false });
  delete patch.code; // code is the key; never update it
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "No editable fields supplied.");
  }

  const { data, error } = await admin
    .from("pomelo_delivery_methods")
    .update(patch)
    .eq("code", code)
    .select("*")
    .maybeSingle();

  if (error) throw new HttpError(500, "Failed to update delivery method: " + error.message);
  if (!data) throw new HttpError(404, "Delivery method not found.");
  return sendJson(res, 200, { method: data });
}

async function deleteMethod(req, res) {
  const { admin } = await requireRole(req, "admin");
  const body = readBody(req);
  const code = String(body.code || req.query.code || "").trim();
  if (!code) throw new HttpError(400, "code is required.");

  const { error } = await admin
    .from("pomelo_delivery_methods")
    .delete()
    .eq("code", code);

  if (error) throw new HttpError(500, "Failed to delete delivery method: " + error.message);
  return sendJson(res, 200, { ok: true });
}

export default withErrors(handler);

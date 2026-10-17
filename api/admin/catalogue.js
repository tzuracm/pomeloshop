/**
 * Vercel serverless function: /api/admin/catalogue
 *
 *   GET    — list all catalogue items (any staff role)
 *   POST   — create an item (admin/owner); the SKU code is auto-generated
 *   PATCH  — update an item (admin/owner)
 *   DELETE — remove an item (admin/owner)
 *
 * `unit_price` is in THB (integer). The storefront converts to satang (×100).
 *
 * SKU codes are canonical identifiers of the form `POM-<SIZE>-<NNN>`
 * (e.g. `POM-5KG-001`). They are generated server-side on create and are
 * immutable afterwards, so historical order line items keep resolving.
 */

import { requireRole, withErrors, sendJson, readBody, HttpError } from "./_auth.js";

/** Canonical SKU shape: POM-<SIZE>-<NNN>, e.g. POM-5KG-001. */
const SKU_PATTERN = /^POM-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3,}$/;

/** How many times to retry when a generated SKU collides. */
const SKU_MAX_ATTEMPTS = 25;

function handler(req, res) {
  switch (req.method) {
    case "GET":    return listItems(req, res);
    case "POST":   return createItem(req, res);
    case "PATCH":  return updateItem(req, res);
    case "DELETE": return deleteItem(req, res);
    default:
      res.setHeader("Allow", "GET, POST, PATCH, DELETE");
      return sendJson(res, 405, { error: "Method not allowed." });
  }
}

/**
 * Derive the size token used inside a SKU from the human label.
 *   "5 kg 装"  -> "5KG"
 *   "10kg"     -> "10KG"
 *   "礼盒装"    -> "ITEM"
 */
function sizeToken(label) {
  const m = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/i.exec(String(label || ""));
  if (m) return (m[1] + m[2]).toUpperCase().replace(/\./g, "");
  return "ITEM";
}

/** Build the SKU prefix for a label, e.g. "POM-5KG". */
function skuPrefix(label) {
  return "POM-" + sizeToken(label);
}

/**
 * Generate the next free SKU for `label` by scanning existing codes that share
 * the same prefix and incrementing the highest sequence number.
 */
async function generateSku(admin, label) {
  const prefix = skuPrefix(label);
  const { data, error } = await admin
    .from("pomelo_catalogue")
    .select("sku")
    .like("sku", prefix + "-%");

  if (error) throw new HttpError(500, "Failed to generate sku: " + error.message);

  let max = 0;
  for (const row of data || []) {
    const m = /-(\d+)$/.exec(String(row.sku || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return prefix + "-" + String(max + 1).padStart(3, "0");
}

/** Validate and normalise a catalogue payload. */
function normalise(body, { requireSku }) {
  const out = {};

  if (requireSku || Object.prototype.hasOwnProperty.call(body, "sku")) {
    const sku = String(body.sku || "").trim().toUpperCase();
    if (!sku) throw new HttpError(400, "sku is required.");
    if (!SKU_PATTERN.test(sku)) {
      throw new HttpError(400, "sku must look like POM-5KG-001 (POM-<SIZE>-<NNN>).");
    }
    out.sku = sku;
  }

  if (requireSku || Object.prototype.hasOwnProperty.call(body, "label")) {
    const label = String(body.label || "").trim();
    if (!label) throw new HttpError(400, "label is required.");
    out.label = label;
  }

  if (requireSku || Object.prototype.hasOwnProperty.call(body, "unit_price")) {
    const price = Number(body.unit_price);
    if (!Number.isInteger(price) || price < 0) {
      throw new HttpError(400, "unit_price must be a non-negative integer (THB).");
    }
    out.unit_price = price;
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

async function listItems(req, res) {
  const { admin } = await requireRole(req, "user");
  const { data, error } = await admin
    .from("pomelo_catalogue")
    .select("*")
    .order("sort_order", { ascending: true });

  if (error) throw new HttpError(500, "Failed to load catalogue: " + error.message);
  return sendJson(res, 200, { items: data || [] });
}

async function createItem(req, res) {
  const { admin } = await requireRole(req, "admin");
  const body = readBody(req);
  const row = normalise(body, { requireSku: false });

  // The SKU is always generated server-side; any client-supplied value is
  // ignored so codes stay canonical and collision-free.
  for (let attempt = 0; attempt < SKU_MAX_ATTEMPTS; attempt++) {
    const sku = await generateSku(admin, row.label);
    const { data, error } = await admin
      .from("pomelo_catalogue")
      .insert({ ...row, sku })
      .select("*")
      .maybeSingle();

    if (!error) return sendJson(res, 201, { item: data });

    // 23505 = unique violation: another request took this code, try the next.
    if (error.code !== "23505") {
      throw new HttpError(500, "Failed to create item: " + error.message);
    }
  }

  throw new HttpError(409, "Could not allocate a unique sku; please retry.");
}

async function updateItem(req, res) {
  const { admin } = await requireRole(req, "admin");
  const body = readBody(req);
  const sku = String(body.sku || "").trim().toUpperCase();
  if (!sku) throw new HttpError(400, "sku is required.");

  const patch = normalise(body, { requireSku: false });
  delete patch.sku; // sku is the key; never update it
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "No editable fields supplied.");
  }

  const { data, error } = await admin
    .from("pomelo_catalogue")
    .update(patch)
    .eq("sku", sku)
    .select("*")
    .maybeSingle();

  if (error) throw new HttpError(500, "Failed to update item: " + error.message);
  if (!data) throw new HttpError(404, "Item not found.");
  return sendJson(res, 200, { item: data });
}

async function deleteItem(req, res) {
  const { admin } = await requireRole(req, "admin");
  const body = readBody(req);
  const sku = String(body.sku || req.query.sku || "").trim();
  if (!sku) throw new HttpError(400, "sku is required.");

  const { error } = await admin.from("pomelo_catalogue").delete().eq("sku", sku);
  if (error) throw new HttpError(500, "Failed to delete item: " + error.message);
  return sendJson(res, 200, { ok: true });
}

export default withErrors(handler);

/**
 * Vercel serverless function: /api/admin/catalogue
 *
 *   GET    — list all catalogue items (any staff role)
 *   POST   — create an item (admin/owner)
 *   PATCH  — update an item (admin/owner)
 *   DELETE — remove an item (admin/owner)
 *
 * `unit_price` is in THB (integer). The storefront converts to satang (×100).
 */

import { requireRole, withErrors, sendJson, readBody, HttpError } from "./_auth.js";

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

/** Validate and normalise a catalogue payload. */
function normalise(body, { requireSku }) {
  const out = {};

  if (requireSku || Object.prototype.hasOwnProperty.call(body, "sku")) {
    const sku = String(body.sku || "").trim();
    if (!sku) throw new HttpError(400, "sku is required.");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sku)) {
      throw new HttpError(400, "sku must be 1-64 chars: letters, digits, _ or -.");
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
  const row = normalise(body, { requireSku: true });

  const { data, error } = await admin
    .from("pomelo_catalogue")
    .insert(row)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") throw new HttpError(409, "An item with that sku already exists.");
    throw new HttpError(500, "Failed to create item: " + error.message);
  }
  return sendJson(res, 201, { item: data });
}

async function updateItem(req, res) {
  const { admin } = await requireRole(req, "admin");
  const body = readBody(req);
  const sku = String(body.sku || "").trim();
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

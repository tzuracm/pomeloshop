/**
 * Vercel serverless function: /api/admin/orders
 *
 *   GET   — list orders (any staff role: user/admin/owner)
 *   PATCH — update an order
 *             • user  : may change ONLY `status` and `note`
 *             • admin : may change any field
 *             • owner : may change any field
 *
 * The caller's role is verified server-side by requireRole(); the client is
 * never trusted to declare its own role.
 */

import { requireRole, withErrors, sendJson, readBody, HttpError } from "./_auth.js";

const ORDER_STATUSES = ["pending", "paid", "delivered", "cancelled"];

/** Fields a plain `user` is allowed to change. */
const USER_EDITABLE = ["status", "note"];

/** Fields an `admin`/`owner` may change. */
const ADMIN_EDITABLE = ["status", "note", "fulfilment", "slip_url", "total_satang", "items"];

function handler(req, res) {
  if (req.method === "GET") return listOrders(req, res);
  if (req.method === "PATCH") return patchOrder(req, res);
  res.setHeader("Allow", "GET, PATCH");
  return sendJson(res, 405, { error: "Method not allowed." });
}

async function listOrders(req, res) {
  const { admin } = await requireRole(req, "user");

  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const status = req.query.status;

  let query = admin
    .from("pomelo_orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status && ORDER_STATUSES.includes(status)) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) throw new HttpError(500, "Failed to load orders: " + error.message);

  return sendJson(res, 200, { orders: data || [] });
}

async function patchOrder(req, res) {
  const { role, admin } = await requireRole(req, "user");

  const body = readBody(req);
  const id = body.id;
  if (!id) throw new HttpError(400, "Order id is required.");

  const editable = role === "user" ? USER_EDITABLE : ADMIN_EDITABLE;

  // Build the update payload from whitelisted fields only.
  const patch = {};
  for (const key of editable) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      patch[key] = body[key];
    }
  }

  if (Object.keys(patch).length === 0) {
    throw new HttpError(
      400,
      role === "user"
        ? "A 'user' may only update: " + USER_EDITABLE.join(", ") + "."
        : "No editable fields supplied."
    );
  }

  // Validate status when present.
  if (patch.status && !ORDER_STATUSES.includes(patch.status)) {
    throw new HttpError(400, "Invalid status. Allowed: " + ORDER_STATUSES.join(", ") + ".");
  }

  // Validate total_satang when present (admin/owner only).
  if (Object.prototype.hasOwnProperty.call(patch, "total_satang")) {
    const n = Number(patch.total_satang);
    if (!Number.isInteger(n) || n < 0) {
      throw new HttpError(400, "total_satang must be a non-negative integer.");
    }
    patch.total_satang = n;
  }

  const { data, error } = await admin
    .from("pomelo_orders")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) throw new HttpError(500, "Failed to update order: " + error.message);
  if (!data) throw new HttpError(404, "Order not found.");

  return sendJson(res, 200, { order: data });
}

export default withErrors(handler);

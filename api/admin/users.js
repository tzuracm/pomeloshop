/**
 * Vercel serverless function: /api/admin/users
 *
 *   GET   — list staff accounts (owner only)
 *   PATCH — change a user's role (owner only)
 *
 * Guard rails:
 *   • Only an owner may call this endpoint.
 *   • An owner may not demote themselves (prevents accidental lockout).
 *   • The role must be one of user/admin/owner.
 */

import { requireRole, withErrors, sendJson, readBody, HttpError } from "./_auth.js";

const VALID_ROLES = ["user", "admin", "owner"];

function handler(req, res) {
  if (req.method === "GET") return listUsers(req, res);
  if (req.method === "PATCH") return updateRole(req, res);
  res.setHeader("Allow", "GET, PATCH");
  return sendJson(res, 405, { error: "Method not allowed." });
}

async function listUsers(req, res) {
  const { admin } = await requireRole(req, "owner");
  const { data, error } = await admin
    .from("profiles")
    .select("id, email, full_name, role, created_at")
    .order("created_at", { ascending: false });

  if (error) throw new HttpError(500, "Failed to load users: " + error.message);
  return sendJson(res, 200, { users: data || [] });
}

async function updateRole(req, res) {
  const { user, admin } = await requireRole(req, "owner");
  const body = readBody(req);

  const userId = String(body.userId || "").trim();
  const role = String(body.role || "").trim();

  if (!userId) throw new HttpError(400, "userId is required.");
  if (!VALID_ROLES.includes(role)) {
    throw new HttpError(400, "Invalid role. Allowed: " + VALID_ROLES.join(", ") + ".");
  }
  if (userId === user.id) {
    throw new HttpError(400, "You cannot change your own role.");
  }

  const { data, error } = await admin
    .from("profiles")
    .update({ role })
    .eq("id", userId)
    .select("id, email, full_name, role, created_at")
    .maybeSingle();

  if (error) throw new HttpError(500, "Failed to update role: " + error.message);
  if (!data) throw new HttpError(404, "User not found.");
  return sendJson(res, 200, { user: data });
}

export default withErrors(handler);

/**
 * Vercel serverless function: GET /api/admin/me
 *
 * Returns the authenticated caller's identity and role. This is the single
 * source of truth the admin console uses to decide which tabs to show.
 *
 *   { user: { id, email }, role: "user" | "admin" | "owner" }
 *
 * Any authenticated staff member (user/admin/owner) may call it. A caller with
 * no profile row is treated as a plain `user`.
 */

import { requireRole, withErrors, sendJson } from "./_auth.js";

function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  return getMe(req, res);
}

async function getMe(req, res) {
  const { user, role } = await requireRole(req, "user");
  return sendJson(res, 200, {
    user: { id: user.id, email: user.email || null },
    role,
  });
}

export default withErrors(handler);

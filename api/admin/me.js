/**
 * Vercel serverless function: GET /api/admin/me
 *
 * Returns the authenticated caller's identity and role. This is the single
 * source of truth the admin console uses to decide which tabs to show.
 *
 *   { user: { id, email }, role: "user" | "admin" | "owner",
 *     mustChangePassword: boolean }
 *
 * Any active staff member (user/admin/owner) may call it. A caller with no
 * profile row, an unknown role, or a non-active status is rejected (fail
 * closed) by requireRole().
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
  const { user, role, admin } = await requireRole(req, "user");

  const { data: profile, error } = await admin
    .from("profiles")
    .select("must_change_password")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    return sendJson(res, 500, { error: "Failed to load profile: " + error.message });
  }

  return sendJson(res, 200, {
    user: { id: user.id, email: user.email || null },
    role,
    mustChangePassword: !!(profile && profile.must_change_password),
  });
}

export default withErrors(handler);

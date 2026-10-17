/**
 * Vercel serverless function: POST /api/admin/change-password
 *
 * Lets the signed-in staff member replace their own password. This is the only
 * way to clear `profiles.must_change_password`, which the console uses to force
 * a change on first login.
 *
 * Body: { currentPassword: string, newPassword: string }
 *
 * Guard rails:
 *   • Any active staff role may call it (user/admin/owner).
 *   • The current password is verified by re-authenticating with the anon
 *     client, so a stolen access token alone cannot change the password.
 *   • The new password must be at least 8 characters and differ from the
 *     current one.
 *   • The flag is cleared with the service_role client, because the
 *     guard_profile_privileges trigger rejects self-service flag changes.
 */

import { requireRole, withErrors, sendJson, readBody, HttpError } from "./_auth.js";
import { createClient } from "@supabase/supabase-js";

const MIN_LENGTH = 8;

function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  return changePassword(req, res);
}

async function changePassword(req, res) {
  const { user, admin } = await requireRole(req, "user");
  const body = readBody(req);

  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");

  if (!currentPassword) {
    throw new HttpError(400, "Current password is required.");
  }
  if (newPassword.length < MIN_LENGTH) {
    throw new HttpError(400, `New password must be at least ${MIN_LENGTH} characters.`);
  }
  if (newPassword === currentPassword) {
    throw new HttpError(400, "The new password must differ from the current one.");
  }
  if (!user.email) {
    throw new HttpError(400, "This account has no email address to re-authenticate with.");
  }

  // Verify the current password by signing in again. A valid bearer token is
  // not enough: it proves the session, not knowledge of the password.
  const anon = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { error: verifyError } = await anon.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });

  if (verifyError) {
    throw new HttpError(400, "Current password is incorrect.");
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
    password: newPassword,
  });

  if (updateError) {
    throw new HttpError(500, "Failed to update password: " + updateError.message);
  }

  const { error: flagError } = await admin
    .from("profiles")
    .update({ must_change_password: false })
    .eq("id", user.id);

  if (flagError) {
    throw new HttpError(500, "Password changed but the profile flag could not be cleared: " + flagError.message);
  }

  return sendJson(res, 200, { ok: true });
}

export default withErrors(handler);

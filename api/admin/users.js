/**
 * Vercel serverless function: /api/admin/users
 *
 *   GET   — list staff accounts (owner only)
 *   POST  — provision a new staff account (owner only)
 *   PATCH — change a user's role and/or status, or reset their password
 *           (owner only)
 *
 * Guard rails:
 *   • Only an owner may call this endpoint.
 *   • An owner may not demote or suspend themselves (prevents accidental lockout).
 *   • The last active owner cannot be demoted or suspended.
 *   • The role must be one of user/admin/owner; the status one of
 *     pending/active/suspended.
 *   • New accounts are created with the service_role client. The email is the
 *     login identity; the initial password is DEFAULT_PASSWORD and the account
 *     is flagged `must_change_password`, so the holder must replace it on first
 *     login.
 */

import { requireRole, withErrors, sendJson, readBody, HttpError } from "./_auth.js";

const VALID_ROLES = ["user", "admin", "owner"];
const VALID_STATUSES = ["pending", "active", "suspended"];

/**
 * Shared bootstrap password for newly provisioned accounts. The account is
 * flagged `must_change_password`, so this value is only ever valid for the
 * first sign-in. An owner may override it by supplying `password` explicitly.
 *
 * NOTE: Supabase Auth enforces a 6-character minimum, so "1234" is rejected
 * with "Password should be at least 6 characters". Keep this at 6+ characters.
 */
const DEFAULT_PASSWORD = "123456";

const PROFILE_COLUMNS = "id, email, full_name, role, status, must_change_password, created_at";

function handler(req, res) {
  if (req.method === "GET") return listUsers(req, res);
  if (req.method === "POST") return createUser(req, res);
  if (req.method === "PATCH") return updateUser(req, res);
  res.setHeader("Allow", "GET, POST, PATCH");
  return sendJson(res, 405, { error: "Method not allowed." });
}

async function listUsers(req, res) {
  const { admin } = await requireRole(req, "owner");
  const { data, error } = await admin
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) throw new HttpError(500, "Failed to load users: " + error.message);
  return sendJson(res, 200, { users: data || [] });
}

/**
 * Provision a staff account. Public sign-up is disabled, so this is the only
 * way to add staff. The auth user is created with the service_role client; the
 * `on_auth_user_created` trigger creates the matching profile row.
 *
 * The email doubles as the login identity. Unless the owner supplies an
 * explicit password, the account starts on DEFAULT_PASSWORD and is forced to
 * change it on first login.
 */
async function createUser(req, res) {
  const { admin } = await requireRole(req, "owner");
  const body = readBody(req);

  const email = String(body.email || "").trim().toLowerCase();
  const explicitPassword = String(body.password || "");
  const fullName = String(body.fullName || "").trim();
  const role = String(body.role || "user").trim();
  const status = String(body.status || "active").trim();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, "A valid email is required.");
  }
  if (!VALID_ROLES.includes(role)) {
    throw new HttpError(400, "Invalid role. Allowed: " + VALID_ROLES.join(", ") + ".");
  }
  if (!VALID_STATUSES.includes(status)) {
    throw new HttpError(400, "Invalid status. Allowed: " + VALID_STATUSES.join(", ") + ".");
  }

  // Supabase enforces a minimum password length of 6. The shared bootstrap
  // password is shorter than the 8-character rule we apply to user-chosen
  // passwords, so only validate an explicit override.
  if (explicitPassword && explicitPassword.length < 8) {
    throw new HttpError(400, "A custom password must be at least 8 characters.");
  }

  const password = explicitPassword || DEFAULT_PASSWORD;
  const mustChange = !explicitPassword;

  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : undefined,
  });

  if (authError) {
    throw new HttpError(400, "Failed to create account: " + authError.message);
  }

  const userId = created && created.user ? created.user.id : null;
  if (!userId) throw new HttpError(500, "Account created but no user id was returned.");

  // The trigger inserts the profile; upsert so a missing trigger cannot leave
  // an account without a profile row.
  const { data, error } = await admin
    .from("profiles")
    .upsert(
      {
        id: userId,
        email,
        full_name: fullName || email,
        role,
        status,
        must_change_password: mustChange,
      },
      { onConflict: "id" }
    )
    .select(PROFILE_COLUMNS)
    .maybeSingle();

  if (error) throw new HttpError(500, "Failed to create profile: " + error.message);
  return sendJson(res, 201, { user: data });
}

async function updateUser(req, res) {
  const { user, admin } = await requireRole(req, "owner");
  const body = readBody(req);

  const userId = String(body.userId || "").trim();
  if (!userId) throw new HttpError(400, "userId is required.");

  const patch = {};
  const wantsPasswordReset = Object.prototype.hasOwnProperty.call(body, "resetPassword");

  if (Object.prototype.hasOwnProperty.call(body, "role")) {
    const role = String(body.role || "").trim();
    if (!VALID_ROLES.includes(role)) {
      throw new HttpError(400, "Invalid role. Allowed: " + VALID_ROLES.join(", ") + ".");
    }
    patch.role = role;
  }

  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    const status = String(body.status || "").trim();
    if (!VALID_STATUSES.includes(status)) {
      throw new HttpError(400, "Invalid status. Allowed: " + VALID_STATUSES.join(", ") + ".");
    }
    patch.status = status;
  }

  if (Object.keys(patch).length === 0 && !wantsPasswordReset) {
    throw new HttpError(400, "Supply a role, a status, or resetPassword.");
  }

  if (userId === user.id) {
    throw new HttpError(400, "You cannot change your own role or status.");
  }

  // Last-owner guard (the DB trigger enforces this too; fail early with a
  // clearer message).
  if (patch.role && patch.role !== "owner") {
    await assertNotLastOwner(admin, userId);
  }
  if (patch.status && patch.status !== "active") {
    await assertNotLastOwner(admin, userId);
  }

  // Owner-initiated password reset: put the account back on the bootstrap
  // password and force a change on next login.
  if (wantsPasswordReset) {
    const { error: pwError } = await admin.auth.admin.updateUserById(userId, {
      password: DEFAULT_PASSWORD,
    });
    if (pwError) {
      throw new HttpError(500, "Failed to reset password: " + pwError.message);
    }
    patch.must_change_password = true;
  }

  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "Nothing to update.");
  }

  const { data, error } = await admin
    .from("profiles")
    .update(patch)
    .eq("id", userId)
    .select(PROFILE_COLUMNS)
    .maybeSingle();

  if (error) throw new HttpError(500, "Failed to update user: " + error.message);
  if (!data) throw new HttpError(404, "User not found.");
  return sendJson(res, 200, { user: data });
}

/** Reject the change when `userId` is the only active owner. */
async function assertNotLastOwner(admin, userId) {
  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("role, status")
    .eq("id", userId)
    .maybeSingle();

  if (targetError) throw new HttpError(500, "Failed to load user: " + targetError.message);
  if (!target || target.role !== "owner" || target.status !== "active") return;

  const { count, error } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "owner")
    .eq("status", "active")
    .neq("id", userId);

  if (error) throw new HttpError(500, "Failed to count owners: " + error.message);
  if (!count) {
    throw new HttpError(400, "Cannot demote or suspend the last active owner.");
  }
}

export default withErrors(handler);

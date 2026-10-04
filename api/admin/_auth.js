/**
 * Shared auth + role helper for /api/admin/* Vercel functions.
 *
 * Every admin endpoint must:
 *   1. read the caller's Supabase access token from `Authorization: Bearer …`
 *   2. verify it with the ANON client (auth.getUser(token))
 *   3. load the caller's profiles.role with the SERVICE_ROLE client
 *   4. reject when the role rank is below the required minimum
 *
 * The role is ALWAYS re-checked here, server-side. The client is never trusted
 * to declare its own role.
 *
 * Required env vars (server-only):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";

/** Role hierarchy. Higher rank = more permissions. */
export const ROLE_RANK = { user: 1, admin: 2, owner: 3 };

/** Thrown by requireRole; carries an HTTP status for the handler to return. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Anon client — used only to verify the caller's access token. */
function anonClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new HttpError(500, "Server misconfigured: missing SUPABASE_URL or SUPABASE_ANON_KEY.");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Service-role client — bypasses RLS. NEVER expose this to the browser and
 * never return it from an endpoint.
 */
export function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new HttpError(
      500,
      "Server misconfigured: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY."
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Verify the caller and assert they hold at least `minRole`.
 *
 * @param {import('http').IncomingMessage} req
 * @param {"user"|"admin"|"owner"} minRole
 * @returns {Promise<{ user: object, role: string, admin: object }>}
 * @throws {HttpError} 401 when unauthenticated, 403 when under-privileged
 */
export async function requireRole(req, minRole) {
  const header = req.headers.authorization || req.headers.Authorization || "";
  const token = String(header).replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Missing bearer token.");

  const anon = anonClient();
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data || !data.user) {
    throw new HttpError(401, "Invalid or expired token.");
  }
  const user = data.user;

  const admin = serviceClient();
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    throw new HttpError(500, "Failed to load caller profile.");
  }

  const role = profile?.role || "user";
  const have = ROLE_RANK[role] || 0;
  const need = ROLE_RANK[minRole] || 0;
  if (have < need) {
    throw new HttpError(403, `Insufficient role: ${minRole} required.`);
  }

  return { user, role, admin };
}

/** Send a JSON response with no-store caching. */
export function sendJson(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

/**
 * Wrap a handler so HttpError becomes a clean JSON response and any other
 * error becomes a 500 without leaking internals.
 */
export function withErrors(handler) {
  return async function (req, res) {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      console.error("[pomelo:admin] unhandled error:", err);
      sendJson(res, 500, { error: "Internal server error." });
    }
  };
}

/** Parse a JSON body that may arrive as a string (Vercel usually pre-parses). */
export function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new HttpError(400, "Invalid JSON body.");
    }
  }
  return {};
}

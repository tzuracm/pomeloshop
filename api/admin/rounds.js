/**
 * Vercel serverless function: /api/admin/rounds
 *
 *   GET — list sales rounds (any staff role: user/admin/owner)
 *
 * Read-only by design: there is NO write endpoint. Rounds are opened and closed
 * exclusively by the database triggers in migration 0010, derived from whether
 * any catalogue item is active. Nothing here can create, close or edit a round.
 *
 * Response:
 *   {
 *     rounds: [{ id, roundNumber, startedAt, endedAt, isOpen }],  // newest first
 *     currentRoundId: string | null
 *   }
 *
 * `roundNumber` is derived at query time (1 = oldest) and is never stored, so
 * the numbering is always contiguous. Ordering is `started_at asc, id asc` —
 * `id` is the tiebreaker that keeps the numbering stable when two rounds share
 * the same `started_at`.
 */

import { requireRole, withErrors, sendJson, HttpError } from "./_auth.js";

function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  return listRounds(req, res);
}

async function listRounds(req, res) {
  const { admin } = await requireRole(req, "user");

  const { data, error } = await admin
    .from("pomelo_sales_rounds")
    .select("id, status, started_at, ended_at")
    .order("started_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new HttpError(500, "Failed to load sales rounds: " + error.message);

  const rows = data || [];

  // Number oldest → newest, then hand back newest first for the dropdown.
  const numbered = rows.map((r, i) => ({
    id: r.id,
    roundNumber: i + 1,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    isOpen: r.status === "open",
  }));

  const open = numbered.find((r) => r.isOpen);

  return sendJson(res, 200, {
    rounds: numbered.slice().reverse(),
    currentRoundId: open ? open.id : null,
  });
}

export default withErrors(handler);

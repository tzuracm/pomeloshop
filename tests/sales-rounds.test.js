/**
 * Sales round management — behaviour tests.
 *
 * Run with:  npm test
 *
 * These tests need no database and no network. They exercise:
 *   1. the round state machine (the SQL trigger logic, mirrored in JS),
 *   2. the order attribution gate + immutability rule,
 *   3. the `round` query filter used by /api/admin/orders,
 *   4. the paginated export fetch (PostgREST db-max-rows workaround),
 *   5. round numbering (started_at asc, id asc) and the derived labels.
 *
 * The SQL itself is only statically checked (see `npm run check:migration`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// ---------------------------------------------------------------------------
// In-memory model of the database
// ---------------------------------------------------------------------------

/**
 * Mirrors public.pomelo_sync_sales_round(): recompute the whole-table
 * predicate and open/close the single round accordingly.
 */
function syncSalesRound(db) {
  const hasActive = db.catalogue.some((c) => c.active);
  const open = db.rounds.find((r) => r.status === "open") || null;

  if (hasActive && !open) {
    db.rounds.push({
      id: "round-" + (db.rounds.length + 1),
      status: "open",
      started_at: new Date(Date.now() + db.rounds.length).toISOString(),
      ended_at: null,
    });
  } else if (!hasActive && open) {
    open.status = "closed";
    open.ended_at = new Date().toISOString();
  }
}

/** Mirrors public.pomelo_assign_sales_round() + pomelo_lock_sales_round(). */
function insertOrder(db, order) {
  if (!db.catalogue.some((c) => c.active)) {
    const err = new Error("本轮已结束，暂停接单。");
    err.code = "P0001";
    throw err;
  }
  let open = db.rounds.find((r) => r.status === "open");
  if (!open) {
    open = {
      id: "round-" + (db.rounds.length + 1),
      status: "open",
      started_at: new Date().toISOString(),
      ended_at: null,
    };
    db.rounds.push(open);
  }
  db.orders.push({ ...order, sales_round_id: open.id });
}

function updateOrder(db, id, patch) {
  const o = db.orders.find((x) => x.id === id);
  if (!o) throw new Error("not found");
  if (
    o.sales_round_id !== null &&
    "sales_round_id" in patch &&
    patch.sales_round_id !== o.sales_round_id
  ) {
    const err = new Error("sales_round_id is immutable");
    err.code = "P0001";
    throw err;
  }
  Object.assign(o, patch);
}

/** Mirrors the catalogue write paths: a single-item update or a bulk statement. */
function setActive(db, skus, active) {
  for (const sku of skus) {
    const item = db.catalogue.find((c) => c.sku === sku);
    if (item) item.active = active;
  }
  syncSalesRound(db); // statement-level: once per statement
}

function freshDb(items) {
  return {
    catalogue: items.map(([sku, active]) => ({ sku, active })),
    rounds: [],
    orders: [],
  };
}

// ---------------------------------------------------------------------------
// 1. Round state machine
// ---------------------------------------------------------------------------

test("migration init: at least one active item creates exactly one open round", () => {
  const db = freshDb([["A", true], ["B", false]]);
  syncSalesRound(db);
  assert.equal(db.rounds.length, 1);
  assert.equal(db.rounds[0].status, "open");
});

test("migration init: all items inactive creates no round", () => {
  const db = freshDb([["A", false], ["B", false]]);
  syncSalesRound(db);
  assert.equal(db.rounds.length, 0);
});

test("taking down some items keeps the same round", () => {
  const db = freshDb([["A", true], ["B", true], ["C", true]]);
  syncSalesRound(db);
  const first = db.rounds[0].id;

  setActive(db, ["A"], false);
  setActive(db, ["B"], false);

  assert.equal(db.rounds.length, 1);
  assert.equal(db.rounds[0].id, first);
  assert.equal(db.rounds[0].status, "open");
});

test("taking down the last item closes the round and stamps ended_at", () => {
  const db = freshDb([["A", true], ["B", true]]);
  syncSalesRound(db);
  setActive(db, ["A"], false);
  setActive(db, ["B"], false);

  assert.equal(db.rounds.length, 1);
  assert.equal(db.rounds[0].status, "closed");
  assert.ok(db.rounds[0].ended_at);
});

test("re-listing after everything was down opens a new round", () => {
  const db = freshDb([["A", true]]);
  syncSalesRound(db);
  setActive(db, ["A"], false);
  setActive(db, ["A"], true);

  assert.equal(db.rounds.length, 2);
  assert.equal(db.rounds[0].status, "closed");
  assert.equal(db.rounds[1].status, "open");
});

test("repeated up/down within a round never creates extra rounds", () => {
  const db = freshDb([["A", true], ["B", true]]);
  syncSalesRound(db);
  for (let i = 0; i < 5; i++) {
    setActive(db, ["A"], false);
    setActive(db, ["A"], true);
  }
  assert.equal(db.rounds.length, 1);
});

test("bulk listing several items creates only one round", () => {
  const db = freshDb([["A", false], ["B", false], ["C", false]]);
  syncSalesRound(db);
  assert.equal(db.rounds.length, 0);

  setActive(db, ["A", "B", "C"], true); // one statement
  assert.equal(db.rounds.length, 1);
});

test("bulk delete of every item closes the round once", () => {
  const db = freshDb([["A", true], ["B", true]]);
  syncSalesRound(db);
  db.catalogue = [];
  syncSalesRound(db);

  assert.equal(db.rounds.length, 1);
  assert.equal(db.rounds[0].status, "closed");
});

// ---------------------------------------------------------------------------
// 2. Order attribution
// ---------------------------------------------------------------------------

test("new order is assigned to the open round", () => {
  const db = freshDb([["A", true]]);
  syncSalesRound(db);
  insertOrder(db, { id: "o1" });
  assert.equal(db.orders[0].sales_round_id, db.rounds[0].id);
});

test("order is rejected when nothing is on sale", () => {
  const db = freshDb([["A", false]]);
  syncSalesRound(db);
  assert.throws(() => insertOrder(db, { id: "o1" }), /本轮已结束/);
  assert.equal(db.orders.length, 0);
});

test("client-supplied sales_round_id is overridden", () => {
  const db = freshDb([["A", true]]);
  syncSalesRound(db);
  insertOrder(db, { id: "o1", sales_round_id: "forged" });
  assert.equal(db.orders[0].sales_round_id, db.rounds[0].id);
});

test("attribution is immutable once set", () => {
  const db = freshDb([["A", true]]);
  syncSalesRound(db);
  insertOrder(db, { id: "o1" });
  assert.throws(
    () => updateOrder(db, "o1", { sales_round_id: "other" }),
    /immutable/
  );
});

test("null → round assignment is allowed once", () => {
  const db = freshDb([["A", true]]);
  syncSalesRound(db);
  db.orders.push({ id: "legacy", sales_round_id: null });
  updateOrder(db, "legacy", { sales_round_id: db.rounds[0].id });
  assert.equal(db.orders[0].sales_round_id, db.rounds[0].id);
});

test("historical orders keep sales_round_id = null", () => {
  const db = freshDb([["A", true]]);
  db.orders.push({ id: "old-1", sales_round_id: null });
  db.orders.push({ id: "old-2", sales_round_id: null });
  syncSalesRound(db);
  assert.equal(db.orders.filter((o) => o.sales_round_id === null).length, 2);
});

// ---------------------------------------------------------------------------
// 3. Round numbering (started_at asc, id asc)
// ---------------------------------------------------------------------------

function numberRounds(rows) {
  return rows
    .slice()
    .sort((a, b) =>
      a.started_at === b.started_at
        ? a.id.localeCompare(b.id)
        : a.started_at.localeCompare(b.started_at)
    )
    .map((r, i) => ({ ...r, roundNumber: i + 1 }));
}

test("round numbers are contiguous and oldest-first", () => {
  const rows = [
    { id: "c", started_at: "2026-03-01T00:00:00Z" },
    { id: "a", started_at: "2026-01-01T00:00:00Z" },
    { id: "b", started_at: "2026-02-01T00:00:00Z" },
  ];
  const numbered = numberRounds(rows);
  assert.deepEqual(numbered.map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(numbered.map((r) => r.roundNumber), [1, 2, 3]);
});

test("identical started_at values are ordered by id (stable numbering)", () => {
  const rows = [
    { id: "b", started_at: "2026-01-01T00:00:00Z" },
    { id: "a", started_at: "2026-01-01T00:00:00Z" },
  ];
  assert.deepEqual(numberRounds(rows).map((r) => r.id), ["a", "b"]);
  // Re-running on the reversed input gives the same numbering.
  assert.deepEqual(numberRounds(rows.slice().reverse()).map((r) => r.id), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// 4. `round` filter + paginated export
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function applyRound(rows, raw) {
  if (raw === undefined || raw === null || raw === "" || raw === "all") return rows;
  if (raw === "unassigned") return rows.filter((r) => r.sales_round_id === null);
  if (!UUID_RE.test(String(raw))) throw new Error("Invalid round id.");
  return rows.filter((r) => r.sales_round_id === String(raw));
}

const R1 = "11111111-1111-1111-1111-111111111111";
const R2 = "22222222-2222-2222-2222-222222222222";

test("round filter: default and 'all' return everything", () => {
  const rows = [{ sales_round_id: R1 }, { sales_round_id: null }];
  assert.equal(applyRound(rows, undefined).length, 2);
  assert.equal(applyRound(rows, "all").length, 2);
});

test("round filter: 'unassigned' returns only historical orders", () => {
  const rows = [{ sales_round_id: R1 }, { sales_round_id: null }];
  assert.deepEqual(applyRound(rows, "unassigned"), [{ sales_round_id: null }]);
});

test("round filter: uuid selects one round", () => {
  const rows = [{ sales_round_id: R1 }, { sales_round_id: R2 }];
  assert.deepEqual(applyRound(rows, R1), [{ sales_round_id: R1 }]);
});

test("round filter: malformed uuid is rejected", () => {
  assert.throws(() => applyRound([], "not-a-uuid"), /Invalid round id/);
});

/**
 * Mirrors fetchAllOrders(): page through with a page size equal to PostgREST's
 * db-max-rows, using a unique ORDER BY tiebreaker.
 */
function fetchAllOrders(allRows, { status, round, cap = 20000, pageSize = 1000 }) {
  const filtered = applyRound(
    status ? allRows.filter((r) => r.status === status) : allRows,
    round
  );
  const sorted = filtered
    .slice()
    .sort((a, b) =>
      a.created_at === b.created_at
        ? b.id.localeCompare(a.id)
        : b.created_at.localeCompare(a.created_at)
    );

  const out = [];
  for (let from = 0; from < cap; from += pageSize) {
    const page = sorted.slice(from, from + pageSize);
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

function makeOrders(n, roundId, status = "paid") {
  return Array.from({ length: n }, (_, i) => ({
    id: "order-" + String(i).padStart(5, "0"),
    status,
    sales_round_id: roundId,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
}

test("export returns every order of the round, beyond the 1000-row cap", () => {
  const rows = makeOrders(2500, R1);
  const out = fetchAllOrders(rows, { round: R1 });
  assert.equal(out.length, 2500);
  assert.equal(new Set(out.map((o) => o.id)).size, 2500); // no duplicates
});

test("export re-includes previously exported orders and adds new ones", () => {
  const first = makeOrders(12, R1);
  const firstExport = fetchAllOrders(first, { round: R1 });
  assert.equal(firstExport.length, 12);

  // Six more orders arrive in the same round.
  const later = first.concat(makeOrders(6, R1).map((o, i) => ({ ...o, id: "new-" + i })));
  const secondExport = fetchAllOrders(later, { round: R1 });

  assert.equal(secondExport.length, 18);
  for (const o of firstExport) {
    assert.ok(secondExport.some((x) => x.id === o.id), "previously exported order missing");
  }
});

test("export is identical when nothing changed", () => {
  const rows = makeOrders(30, R1);
  assert.deepEqual(fetchAllOrders(rows, { round: R1 }), fetchAllOrders(rows, { round: R1 }));
});

test("export combines round and status filters", () => {
  const rows = makeOrders(5, R1, "paid").concat(makeOrders(3, R1, "pending"));
  assert.equal(fetchAllOrders(rows, { round: R1, status: "paid" }).length, 5);
});

test("export 'unassigned' covers all historical orders", () => {
  const rows = makeOrders(4, null).concat(makeOrders(2, R1));
  assert.equal(fetchAllOrders(rows, { round: "unassigned" }).length, 4);
});

// ---------------------------------------------------------------------------
// 5. Round labels used by the sheet name / filename
// ---------------------------------------------------------------------------

function resolveRoundLabel(rounds, round) {
  if (!round || round === "all" || round === "unassigned") return null;
  const numbered = numberRounds(rounds);
  const found = numbered.find((r) => r.id === round);
  if (!found) throw new Error("Sales round not found.");
  return { n: found.roundNumber, sheet: `第${found.roundNumber}轮`, file: `round${found.roundNumber}` };
}

test("round label drives the sheet name and filename", () => {
  const rounds = [
    { id: R1, started_at: "2026-01-01T00:00:00Z" },
    { id: R2, started_at: "2026-02-01T00:00:00Z" },
  ];
  assert.deepEqual(resolveRoundLabel(rounds, R2), { n: 2, sheet: "第2轮", file: "round2" });
  assert.equal(resolveRoundLabel(rounds, "all"), null);
  assert.equal(resolveRoundLabel(rounds, "unassigned"), null);
  assert.throws(() => resolveRoundLabel(rounds, "33333333-3333-3333-3333-333333333333"), /not found/);
});

// ---------------------------------------------------------------------------
// 6. Static checks on the migration + wiring
// ---------------------------------------------------------------------------

const migration = readFileSync(
  join(root, "supabase/migrations/0010_pomelo_sales_rounds.sql"),
  "utf8"
);

test("migration is idempotent and transactional", () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;\s*$/m);
  assert.match(migration, /create table if not exists public\.pomelo_sales_rounds/);
  assert.match(migration, /add column if not exists sales_round_id uuid/);
  assert.match(migration, /create unique index if not exists pomelo_sales_rounds_one_open/);
  assert.match(migration, /drop trigger if exists pomelo_catalogue_round_sync_ins/);
  assert.match(migration, /drop trigger if exists pomelo_orders_assign_sales_round/);
  assert.match(migration, /drop trigger if exists pomelo_orders_lock_sales_round/);
});

test("migration uses statement-level catalogue triggers", () => {
  const statementTriggers = migration.match(/for each statement execute function/g) || [];
  assert.equal(statementTriggers.length, 3);
});

test("migration contains no advisory lock or extra concurrency layer", () => {
  assert.doesNotMatch(migration, /pg_advisory/i);
  assert.doesNotMatch(migration, /lock table/i);
});

test("migration does not backfill historical orders", () => {
  assert.doesNotMatch(migration, /update\s+public\.pomelo_orders\s+set\s+sales_round_id/i);
  assert.doesNotMatch(migration, /set not null/i);
});

test("migration keeps anon out of the rounds table", () => {
  assert.match(migration, /enable row level security/);
  assert.match(migration, /to authenticated\s+using \(public\.is_staff\(\)\)/);
  assert.doesNotMatch(migration, /to anon/);
});

test("migration never revokes EXECUTE on the trigger functions", () => {
  assert.doesNotMatch(migration, /revoke[^;]*pomelo_sync_sales_round/i);
  assert.doesNotMatch(migration, /revoke[^;]*pomelo_assign_sales_round/i);
});

test("orders API keeps sales_round_id out of the editable whitelists", () => {
  const src = readFileSync(join(root, "api/admin/orders.js"), "utf8");
  const userEditable = src.match(/const USER_EDITABLE = \[(.*?)\];/s)[1];
  const adminEditable = src.match(/const ADMIN_EDITABLE = \[(.*?)\];/s)[1];
  assert.doesNotMatch(userEditable, /sales_round_id/);
  assert.doesNotMatch(adminEditable, /sales_round_id/);
});

test("export uses range pagination, not a bare limit", () => {
  const src = readFileSync(join(root, "api/admin/orders-export.js"), "utf8");
  assert.match(src, /\.range\(from, from \+ PAGE_SIZE - 1\)/);
  assert.match(src, /const PAGE_SIZE = 1000/);
  assert.doesNotMatch(src, /\.limit\(limit\)/);
});

test("export keeps the 13 columns (no sales round column added)", () => {
  const src = readFileSync(join(root, "api/admin/orders-export.js"), "utf8");
  const columns = src.match(/function buildColumns[\s\S]*?\n\}/)[0];
  const headers = columns.match(/\{ header:/g) || [];
  assert.equal(headers.length, 13);
  assert.doesNotMatch(columns, /销售轮次/);
});

test("admin page exposes the round filter", () => {
  const html = readFileSync(join(root, "admin.html"), "utf8");
  assert.match(html, /id="orderRoundFilter"/);
  const js = readFileSync(join(root, "admin.js"), "utf8");
  assert.match(js, /loadOrderFilters\(\)/);
  assert.match(js, /\/api\/admin\/rounds/);
});

-- =============================================================================
-- Pomelo Shop — sales rounds, derived from the catalogue's overall state
-- =============================================================================
-- A sales round is open while at least one catalogue item is active. It closes
-- when the last active item is taken down, and a new round opens the next time
-- any item comes back. No admin action is required.
--
-- Design notes (see plans/sales-rounds.md):
--   * Detection lives in the DATABASE, because the catalogue can be written
--     through three disjoint paths: /api/admin/catalogue (service_role),
--     direct PostgREST by admin/owner (catalogue_staff_write) and the SQL
--     Editor. Only a trigger covers all three.
--   * The catalogue triggers are STATEMENT-level so a bulk statement (or a
--     statement that transiently zeroes the active count) is evaluated once,
--     against the final state.
--   * No advisory locks, no extra concurrency layer. A plain transaction plus
--     the partial unique index below are the only guarantees.
--   * Historical orders keep sales_round_id = NULL. Nothing is backfilled.
--
-- Idempotent: safe to run the whole file more than once.
-- =============================================================================

begin;

-- 1. Rounds table -------------------------------------------------------------
create table if not exists public.pomelo_sales_rounds (
  id         uuid primary key default gen_random_uuid(),
  status     text        not null default 'open'
               check (status in ('open', 'closed')),
  started_at timestamptz not null default now(),
  ended_at   timestamptz
);

comment on table public.pomelo_sales_rounds is
  'Sales rounds. Open while at least one catalogue item is active; closed when all are inactive.';
comment on column public.pomelo_sales_rounds.status is
  'open = current ordering round (at most one); closed = finished. Maintained by pomelo_sync_sales_round().';

-- Hard guarantee: at most one open round at any time.
create unique index if not exists pomelo_sales_rounds_one_open
  on public.pomelo_sales_rounds (status) where status = 'open';

-- Sort key: started_at is not unique, so id is the tiebreaker that keeps the
-- derived round numbers stable.
create index if not exists pomelo_sales_rounds_started_idx
  on public.pomelo_sales_rounds (started_at desc, id desc);

alter table public.pomelo_sales_rounds enable row level security;

-- Staff may read. anon has no policy at all; nobody has a write policy, so the
-- only writer is the SECURITY DEFINER trigger function below.
drop policy if exists "rounds_staff_read" on public.pomelo_sales_rounds;
create policy "rounds_staff_read"
  on public.pomelo_sales_rounds for select
  to authenticated
  using (public.is_staff());

-- 2. Order → round column -----------------------------------------------------
-- Nullable on purpose: NULL means "unassigned / historical order".
alter table public.pomelo_orders add column if not exists sales_round_id uuid;

create index if not exists pomelo_orders_round_created_idx
  on public.pomelo_orders (sales_round_id, created_at desc, id desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pomelo_orders_sales_round_fk'
  ) then
    alter table public.pomelo_orders
      add constraint pomelo_orders_sales_round_fk
      foreign key (sales_round_id)
      references public.pomelo_sales_rounds (id) on delete restrict;
  end if;
end $$;

-- 3. Catalogue overall state → round (statement-level) ------------------------
create or replace function public.pomelo_sync_sales_round()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_has_active boolean;
  v_open_id    uuid;
begin
  select exists (select 1 from public.pomelo_catalogue where active) into v_has_active;
  select id into v_open_id from public.pomelo_sales_rounds
   where status = 'open' limit 1;

  if v_has_active and v_open_id is null then
    -- 0 → some active: open a new round.
    insert into public.pomelo_sales_rounds (status, started_at) values ('open', now());
  elsif not v_has_active and v_open_id is not null then
    -- some active → 0: close the current round.
    update public.pomelo_sales_rounds
       set status = 'closed', ended_at = now()
     where id = v_open_id;
  end if;

  return null;   -- return value is ignored for statement-level AFTER triggers
end;
$$;

-- NOTE: do NOT revoke EXECUTE on this function. It is invoked implicitly when
-- an admin/owner writes pomelo_catalogue through PostgREST, and that role has
-- no write privilege on pomelo_sales_rounds — SECURITY DEFINER is what lets it
-- write. Revoking would make catalogue updates fail with
-- "permission denied for function".

drop trigger if exists pomelo_catalogue_round_sync_ins on public.pomelo_catalogue;
create trigger pomelo_catalogue_round_sync_ins
  after insert on public.pomelo_catalogue
  for each statement execute function public.pomelo_sync_sales_round();

drop trigger if exists pomelo_catalogue_round_sync_upd on public.pomelo_catalogue;
create trigger pomelo_catalogue_round_sync_upd
  after update on public.pomelo_catalogue
  for each statement execute function public.pomelo_sync_sales_round();

drop trigger if exists pomelo_catalogue_round_sync_del on public.pomelo_catalogue;
create trigger pomelo_catalogue_round_sync_del
  after delete on public.pomelo_catalogue
  for each statement execute function public.pomelo_sync_sales_round();

-- 4. Order → round assignment (row-level, before insert) ----------------------
create or replace function public.pomelo_assign_sales_round()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  -- Business gate: with nothing on sale, no order may be created. This always
  -- reads the catalogue directly, never the round bookkeeping.
  if not exists (select 1 from public.pomelo_catalogue where active) then
    raise exception '本轮已结束，暂停接单。'
      using errcode = 'P0001', hint = 'POMELO_NO_OPEN_ROUND';
  end if;

  select id into v_id from public.pomelo_sales_rounds
   where status = 'open' limit 1;

  -- Self-heal: items are on sale but no round is open (trigger disabled, or
  -- data created by hand). Never let "in stock but cannot order" happen.
  -- No lock: in the rare race the unique index rejects the second insert and
  -- the buyer simply retries.
  if v_id is null then
    insert into public.pomelo_sales_rounds (status, started_at)
    values ('open', now()) returning id into v_id;
  end if;

  -- Unconditional override: whatever the client sent is ignored.
  new.sales_round_id := v_id;
  return new;
end;
$$;

drop trigger if exists pomelo_orders_assign_sales_round on public.pomelo_orders;
create trigger pomelo_orders_assign_sales_round
  before insert on public.pomelo_orders
  for each row execute function public.pomelo_assign_sales_round();

-- 5. Attribution is immutable (before update) --------------------------------
create or replace function public.pomelo_lock_sales_round()
returns trigger
language plpgsql
set search_path = public, pg_temp   -- touches no other table, no DEFINER needed
as $$
begin
  -- Allow the one-off null → round assignment (manual archiving later);
  -- after that the value can never change.
  if old.sales_round_id is not null
     and new.sales_round_id is distinct from old.sales_round_id then
    raise exception 'sales_round_id is immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists pomelo_orders_lock_sales_round on public.pomelo_orders;
create trigger pomelo_orders_lock_sales_round
  before update on public.pomelo_orders
  for each row execute function public.pomelo_lock_sales_round();

-- 6. Initialise: align once with the current catalogue state ------------------
-- Rules (fixed, nothing is guessed):
--   * at least one item active → create exactly one open round
--   * all items inactive       → create no round at all
--   * historical orders        → sales_round_id stays NULL (unassigned)
--   * only 0 or 1 row is inserted into the rounds table; no existing order,
--     payment or catalogue row is modified.
do $$
begin
  if exists (select 1 from public.pomelo_catalogue where active)
     and not exists (select 1 from public.pomelo_sales_rounds where status = 'open') then
    insert into public.pomelo_sales_rounds (status, started_at) values ('open', now());
  end if;
end $$;

commit;

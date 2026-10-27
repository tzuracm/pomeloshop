-- =============================================================================
-- Pomelo Shop — pickup points on orders (admin + Excel visibility)
-- =============================================================================
-- Run this in the Supabase SQL Editor AFTER 0008_pomelo_settings_admin_write.sql.
--
-- WHY
-- ---
-- Buyers already choose exactly one pickup point: each pickup point is a row in
-- `pomelo_delivery_methods` and the chosen row's `code` is stored on the order as
-- `pomelo_orders.fulfilment`. The admin order list and the Excel export, however,
-- only printed the method label (`自提`), so staff could not tell which of the
-- three pickup points an order belongs to.
--
-- WHAT CHANGES
-- ------------
--   1. `pomelo_delivery_methods` gains explicit pickup-point fields:
--        pickup_point    short name  (e.g. 拉差达店)
--        pickup_address  full address / landmark
--      These are admin-only; the storefront keeps using label/description/
--      map_url/time_window and is NOT changed by this migration.
--
--   2. `pomelo_orders` gains a SNAPSHOT of the chosen method:
--        fulfilment_label, pickup_point, pickup_address,
--        pickup_time_window, pickup_map_url
--      The snapshot is filled by a trigger, never by the client, so renaming,
--      deactivating or deleting a pickup point never rewrites history.
--
--   3. Existing orders are backfilled from the current method rows.
--
-- The storefront is untouched: buyers keep submitting the same payload.
--
-- Idempotent and safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Pickup-point fields on delivery methods
-- -----------------------------------------------------------------------------
alter table public.pomelo_delivery_methods
  add column if not exists pickup_point   text not null default '',
  add column if not exists pickup_address text not null default '';

comment on column public.pomelo_delivery_methods.pickup_point is
  'Short pickup-point name used in the admin console and Excel export (e.g. 拉差达店).';
comment on column public.pomelo_delivery_methods.pickup_address is
  'Full pickup address / landmark. Used by staff and the Excel export.';

-- Existing rows keep an empty pickup_point. The admin console and the export
-- fall back to `description` (where the branch name currently lives, e.g.
-- 自提 / The Urbana 1) and then to `label`, so nothing changes until an admin
-- fills the real name.

-- -----------------------------------------------------------------------------
-- 2. Snapshot columns on orders
-- -----------------------------------------------------------------------------
alter table public.pomelo_orders
  add column if not exists fulfilment_label   text,
  add column if not exists pickup_point       text,
  add column if not exists pickup_address     text,
  add column if not exists pickup_time_window text,
  add column if not exists pickup_map_url     text;

comment on column public.pomelo_orders.fulfilment_label is
  'Snapshot of pomelo_delivery_methods.label at order time.';
comment on column public.pomelo_orders.pickup_point is
  'Snapshot of the chosen pickup point name at order time.';
comment on column public.pomelo_orders.pickup_address is
  'Snapshot of the chosen pickup address at order time.';
comment on column public.pomelo_orders.pickup_time_window is
  'Snapshot of the pickup time window at order time.';
comment on column public.pomelo_orders.pickup_map_url is
  'Snapshot of the pickup Google Maps link at order time.';

-- -----------------------------------------------------------------------------
-- 3. Server-side snapshot trigger
-- -----------------------------------------------------------------------------
-- Buyers INSERT orders with the anon key, so the snapshot must never be
-- client-controlled. The trigger overwrites the snapshot columns from the
-- canonical method row on insert and whenever `fulfilment` is changed.
create or replace function public.pomelo_snapshot_fulfilment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m public.pomelo_delivery_methods%rowtype;
begin
  select * into m
  from public.pomelo_delivery_methods
  where code = new.fulfilment;

  if found then
    new.fulfilment_label   := m.label;
    -- Fall back to the sub-label: rows created before this migration keep the
    -- branch name in `description` (e.g. 自提 / The Urbana 1).
    new.pickup_point       := coalesce(
      nullif(m.pickup_point, ''),
      nullif(m.description, ''),
      m.label
    );
    new.pickup_address     := coalesce(m.pickup_address, '');
    new.pickup_time_window := coalesce(m.time_window, '');
    new.pickup_map_url     := coalesce(m.map_url, '');
  else
    -- Method deleted or never existed: keep a readable label, keep whatever
    -- snapshot the row already had (e.g. on an update).
    new.fulfilment_label := coalesce(
      new.fulfilment_label,
      case new.fulfilment
        when 'self_pickup' then '自提'
        when 'grab_cod'    then 'Grab 到付'
        else new.fulfilment
      end
    );
    new.pickup_point       := coalesce(new.pickup_point, '');
    new.pickup_address     := coalesce(new.pickup_address, '');
    new.pickup_time_window := coalesce(new.pickup_time_window, '');
    new.pickup_map_url     := coalesce(new.pickup_map_url, '');
  end if;

  return new;
end;
$$;

drop trigger if exists pomelo_orders_snapshot_fulfilment on public.pomelo_orders;
create trigger pomelo_orders_snapshot_fulfilment
  before insert or update of fulfilment on public.pomelo_orders
  for each row execute function public.pomelo_snapshot_fulfilment();

-- -----------------------------------------------------------------------------
-- 4. Backfill historical orders
-- -----------------------------------------------------------------------------
-- Runs for every order that has no snapshot yet. The WHERE clause is written
-- so that re-running the migration also fills rows that were only partially
-- backfilled (e.g. an earlier run before pickup_point existed).
update public.pomelo_orders o
set fulfilment_label = coalesce(
      o.fulfilment_label,
      (select m.label from public.pomelo_delivery_methods m where m.code = o.fulfilment),
      case o.fulfilment
        when 'self_pickup' then '自提'
        when 'grab_cod'    then 'Grab 到付'
        else o.fulfilment
      end),
    pickup_point = coalesce(
      nullif(o.pickup_point, ''),
      (select nullif(m.pickup_point, '') from public.pomelo_delivery_methods m where m.code = o.fulfilment),
      (select nullif(m.description, '') from public.pomelo_delivery_methods m where m.code = o.fulfilment),
      (select m.label from public.pomelo_delivery_methods m where m.code = o.fulfilment),
      ''),
    pickup_address = coalesce(
      nullif(o.pickup_address, ''),
      (select m.pickup_address from public.pomelo_delivery_methods m where m.code = o.fulfilment),
      ''),
    pickup_time_window = coalesce(
      nullif(o.pickup_time_window, ''),
      (select m.time_window from public.pomelo_delivery_methods m where m.code = o.fulfilment),
      ''),
    pickup_map_url = coalesce(
      nullif(o.pickup_map_url, ''),
      (select m.map_url from public.pomelo_delivery_methods m where m.code = o.fulfilment),
      '')
where o.fulfilment_label is null
   or o.pickup_point is null
   or o.pickup_point = '';

-- -----------------------------------------------------------------------------
-- 5. Verify
-- -----------------------------------------------------------------------------
-- Expect: `missing_point` = 0 for every row. `with_point` counts the orders
-- that now carry a concrete pickup point (from pickup_point, description or
-- the label fallback).
select fulfilment,
       count(*) as orders,
       count(*) filter (where pickup_point is not null and pickup_point <> '') as with_point,
       count(*) filter (where pickup_point is null or pickup_point = '') as missing_point
from public.pomelo_orders
group by fulfilment
order by orders desc;

select code, label, pickup_point, pickup_address, active
from public.pomelo_delivery_methods
order by sort_order, code;

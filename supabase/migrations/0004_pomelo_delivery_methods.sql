-- =============================================================================
-- Pomelo Shop — dynamic delivery methods (交货方式)
-- =============================================================================
-- Run this in the Supabase SQL Editor AFTER 0003_pomelo_sku_codes.sql.
--
-- WHY
-- ---
-- The storefront used to hard-code exactly two fulfilment options
-- ('self_pickup' | 'grab_cod') in both the HTML and a CHECK constraint on
-- pomelo_orders.fulfilment. The owner now needs to add/remove delivery methods
-- from the admin console, so the option list must live in a table.
--
-- MODEL
-- -----
--   pomelo_delivery_methods
--     code        stable identifier stored on orders (e.g. 'self_pickup')
--     label       display name shown to buyers (e.g. '自提')
--     description optional sub-label (e.g. 'Self-Pickup')
--     map_url     optional Google Maps link (pickup point)
--     time_window optional pickup time window (free text)
--     sort_order  display order
--     active      hidden methods stay on old orders but are not offered
--
--   pomelo_orders.fulfilment keeps its historical values. The old CHECK
--   constraint is dropped so newly added method codes are accepted; the
--   storefront only ever submits codes that exist in the table.
--
-- SECURITY
-- --------
--   * public read (the storefront needs the list)
--   * admin/owner write (managed from /admin.html)
--
-- Idempotent and safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Delivery methods table
-- -----------------------------------------------------------------------------
create table if not exists public.pomelo_delivery_methods (
  code        text primary key,
  label       text not null,
  description text,
  map_url     text,
  time_window text,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.pomelo_delivery_methods is
  'Selectable delivery methods (交货方式). Public read; admin/owner write.';
comment on column public.pomelo_delivery_methods.code is
  'Stable identifier stored on pomelo_orders.fulfilment. Never change once used.';
comment on column public.pomelo_delivery_methods.map_url is
  'Optional Google Maps link for the pickup point.';
comment on column public.pomelo_delivery_methods.time_window is
  'Optional pickup time window, free text (e.g. 每天 10:00–18:00).';

alter table public.pomelo_delivery_methods enable row level security;

drop policy if exists "delivery_methods_public_read" on public.pomelo_delivery_methods;
create policy "delivery_methods_public_read"
  on public.pomelo_delivery_methods for select
  to anon, authenticated
  using (true);

drop policy if exists "delivery_methods_staff_write" on public.pomelo_delivery_methods;
create policy "delivery_methods_staff_write"
  on public.pomelo_delivery_methods for all
  to authenticated
  using (public.is_admin_or_owner())
  with check (public.is_admin_or_owner());

-- -----------------------------------------------------------------------------
-- 2. Seed the existing methods
-- -----------------------------------------------------------------------------
-- Grab is seeded INACTIVE: the storefront no longer offers it, but historical
-- orders that reference 'grab_cod' keep their label in the admin/Excel export.
insert into public.pomelo_delivery_methods
  (code, label, description, map_url, time_window, sort_order, active)
values
  ('self_pickup', '自提', 'Self-Pickup', '', '', 1, true),
  ('grab_cod',    'Grab 到付', 'Delivery on Delivery', '', '', 2, false)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- 3. Relax the orders CHECK constraint
-- -----------------------------------------------------------------------------
-- The old constraint only allowed the two hard-coded codes. Drop it so any
-- method code created from the admin console can be stored. The storefront
-- validates against the live table, so this does not open up arbitrary input.
alter table public.pomelo_orders
  drop constraint if exists pomelo_orders_fulfilment_check;

comment on column public.pomelo_orders.fulfilment is
  'Delivery method code (see pomelo_delivery_methods.code).';

-- -----------------------------------------------------------------------------
-- 4. Verify
-- -----------------------------------------------------------------------------
select code, label, description, map_url, time_window, sort_order, active
from public.pomelo_delivery_methods
order by sort_order, code;

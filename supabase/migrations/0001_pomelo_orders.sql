-- =============================================================================
-- Pomelo Shop — orders table + storage bucket + RLS policies
-- =============================================================================
-- Run this in the Supabase SQL Editor (or via `supabase db push`).
--
-- Model
-- -----
-- The shop is a "no registration" flow: buyers land on a static page, fill in
-- their WeChat name + phone, pick a spec, pay via PromptPay QR, upload a slip
-- and submit. There is no auth.uid() for buyers, so the anon role must be able
-- to INSERT an order and UPLOAD a slip — but must NOT be able to read other
-- people's orders or slips back out.
--
-- Security posture
-- ----------------
--   * pomelo_orders: anon may INSERT only. No SELECT/UPDATE/DELETE for anon.
--     (The seller reads orders through the Supabase dashboard / service role.)
--   * storage bucket "pomelo-slips": anon may INSERT (upload) only. Public
--     read is enabled so the seller can open the slip URL from the dashboard,
--     and so the URL stored on the order is directly viewable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Orders table
-- -----------------------------------------------------------------------------
create table if not exists public.pomelo_orders (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  -- Buyer identity (no account required)
  wechat_name   text        not null,
  phone         text        not null,

  -- Fulfilment: 'self_pickup' | 'grab_cod'
  fulfilment    text        not null
                  check (fulfilment in ('self_pickup', 'grab_cod')),

  -- Line items, e.g. [{"sku":"5kg","qty":2,"unit_price":180,"subtotal":360}]
  items         jsonb       not null default '[]'::jsonb,

  -- Money is stored in satang (integer) to avoid float rounding. 1 THB = 100.
  total_satang  integer     not null check (total_satang >= 0),

  -- Public URL of the uploaded transfer slip in the pomelo-slips bucket
  slip_url      text,

  -- Order lifecycle: pending -> paid -> delivered | cancelled
  status        text        not null default 'pending'
                  check (status in ('pending', 'paid', 'delivered', 'cancelled')),

  -- Free-form seller note
  note          text
);

comment on table  public.pomelo_orders is 'Pomelo Shop orders (no-registration flow).';
comment on column public.pomelo_orders.total_satang is 'Total amount in satang (1 THB = 100 satang).';
comment on column public.pomelo_orders.items is 'JSON array of line items: [{sku,qty,unit_price,subtotal}].';

create index if not exists pomelo_orders_created_at_idx
  on public.pomelo_orders (created_at desc);

create index if not exists pomelo_orders_status_idx
  on public.pomelo_orders (status);

-- -----------------------------------------------------------------------------
-- 2. Row Level Security
-- -----------------------------------------------------------------------------
alter table public.pomelo_orders enable row level security;

-- Buyers (anon) may create an order. They may NOT read it back, because the
-- order id is not a secret and a SELECT policy would leak every buyer's phone
-- number and slip to anyone who can guess/enumerate ids.
drop policy if exists "pomelo_orders_anon_insert" on public.pomelo_orders;
create policy "pomelo_orders_anon_insert"
  on public.pomelo_orders
  for insert
  to anon, authenticated
  with check (true);

-- The seller (service_role) bypasses RLS entirely, so no SELECT policy is
-- needed for the dashboard. If you later add an authenticated admin UI, add a
-- policy scoped to that role here, e.g.:
--
--   create policy "pomelo_orders_admin_read"
--     on public.pomelo_orders for select
--     to authenticated
--     using ( (auth.jwt() ->> 'role') = 'admin' );

-- -----------------------------------------------------------------------------
-- 3. Storage bucket for slips
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('pomelo-slips', 'pomelo-slips', true)
on conflict (id) do update set public = excluded.public;

-- Anon may upload a slip. We restrict the object path to a per-order folder so
-- uploads cannot overwrite arbitrary keys, and cap the size at 8 MB.
drop policy if exists "pomelo_slips_anon_upload" on storage.objects;
create policy "pomelo_slips_anon_upload"
  on storage.objects
  for insert
  to anon, authenticated
  with check (
    bucket_id = 'pomelo-slips'
    and (storage.foldername(name))[1] is not null
  );

-- Public read so the seller can open the slip URL from the dashboard.
drop policy if exists "pomelo_slips_public_read" on storage.objects;
create policy "pomelo_slips_public_read"
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'pomelo-slips');

-- -----------------------------------------------------------------------------
-- 4. Optional: tighten the bucket to images only + 8 MB limit
-- -----------------------------------------------------------------------------
update storage.buckets
set
  file_size_limit = 8388608, -- 8 MB
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
where id = 'pomelo-slips';

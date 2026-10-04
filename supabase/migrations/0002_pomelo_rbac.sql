-- =============================================================================
-- Pomelo Shop — Three-tier RBAC (owner / admin / user)
-- =============================================================================
-- Run this in the Supabase SQL Editor AFTER 0001_pomelo_orders.sql.
--
-- Model
-- -----
--   owner  Full control: edit page text + catalogue, manage orders, grant and
--          revoke admin/user roles, and MODIFY sensitive settings (PromptPay
--          ID, bank info).
--   admin  Manage products and orders. May VIEW sensitive settings but may NOT
--          modify them.
--   user   View the order list and update fulfilment status (arrange shipping).
--
-- Authentication is email + password via Supabase Auth. Staff sign in through
-- login.html; the admin UI (admin.html) calls Vercel functions under
-- /api/admin/* which re-check the caller's role server-side with the
-- service_role key.
--
-- Security posture
-- ----------------
--   * profiles            : a user reads/updates only their own row; owners may
--                           read/update all rows (role management).
--   * pomelo_settings     : PUBLIC READ (the storefront needs the PromptPay ID
--                           to build the QR), OWNER-ONLY WRITE.
--   * pomelo_catalogue    : public read; admin/owner write.
--   * pomelo_page_content : public read; owner write.
--   * pomelo_orders       : anon INSERT only (unchanged); staff SELECT/UPDATE.
--
-- All statements are idempotent and safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. profiles — extends auth.users
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  full_name  text,
  role       text not null default 'user'
             check (role in ('user', 'admin', 'owner')),
  created_at timestamptz not null default now()
);

comment on table public.profiles is 'Staff profiles extending auth.users (owner/admin/user).';

create index if not exists profiles_role_idx on public.profiles (role);

-- -----------------------------------------------------------------------------
-- 1b. Role helpers (SECURITY DEFINER)
-- -----------------------------------------------------------------------------
-- Policies on `profiles` cannot SELECT from `profiles` directly: Postgres would
-- re-enter the same policy and recurse infinitely. These SECURITY DEFINER
-- functions run with the definer's rights, bypass RLS, and are the ONLY safe
-- way to ask "what role is the current caller?" from inside a policy.
-- -----------------------------------------------------------------------------
create or replace function public.current_role()
returns text
language sql
stable
security definer set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'owner'
  );
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('user', 'admin', 'owner')
  );
$$;

create or replace function public.is_admin_or_owner()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'owner')
  );
$$;

-- Only authenticated staff may call these helpers.
revoke all on function public.current_role() from public;
revoke all on function public.is_owner() from public;
revoke all on function public.is_staff() from public;
revoke all on function public.is_admin_or_owner() from public;
grant execute on function public.current_role() to authenticated;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin_or_owner() to authenticated;

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 2. profiles RLS
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;

-- A user may read their own profile.
drop policy if exists "profiles_read_own" on public.profiles;
create policy "profiles_read_own"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

-- Owners may read all profiles (staff & role management).
drop policy if exists "profiles_owner_read_all" on public.profiles;
create policy "profiles_owner_read_all"
  on public.profiles for select
  to authenticated
  using (public.is_owner());

-- A user may update their own profile (e.g. full_name).
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Owners may update any profile (grant/revoke roles).
drop policy if exists "profiles_owner_update_all" on public.profiles;
create policy "profiles_owner_update_all"
  on public.profiles for update
  to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- -----------------------------------------------------------------------------
-- 3. pomelo_settings — public read, owner-only write
-- -----------------------------------------------------------------------------
create table if not exists public.pomelo_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.pomelo_settings is
  'Sensitive settings (PromptPay ID, bank info). Public read; owner-only write.';

alter table public.pomelo_settings enable row level security;

-- Public read: the storefront (anon) and all staff need the PromptPay ID.
drop policy if exists "settings_public_read" on public.pomelo_settings;
create policy "settings_public_read"
  on public.pomelo_settings for select
  to anon, authenticated
  using (true);

-- Owner-only write (insert/update/delete).
drop policy if exists "settings_owner_write" on public.pomelo_settings;
create policy "settings_owner_write"
  on public.pomelo_settings for all
  to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- Seed the PromptPay ID. Replace the placeholder with the real value, or edit
-- it later from the owner settings panel in admin.html.
insert into public.pomelo_settings (key, value)
values ('promptpay_id', 'REPLACE_WITH_REAL_PROMPTPAY_ID')
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- 4. pomelo_catalogue — public read, admin/owner write
-- -----------------------------------------------------------------------------
create table if not exists public.pomelo_catalogue (
  sku        text primary key,
  label      text not null,
  unit_price integer not null check (unit_price >= 0),  -- THB
  sort_order integer not null default 0,
  active     boolean not null default true
);

comment on table public.pomelo_catalogue is
  'Product catalogue. unit_price is in THB. Public read; admin/owner write.';

alter table public.pomelo_catalogue enable row level security;

drop policy if exists "catalogue_public_read" on public.pomelo_catalogue;
create policy "catalogue_public_read"
  on public.pomelo_catalogue for select
  to anon, authenticated
  using (true);

drop policy if exists "catalogue_staff_write" on public.pomelo_catalogue;
create policy "catalogue_staff_write"
  on public.pomelo_catalogue for all
  to authenticated
  using (public.is_admin_or_owner())
  with check (public.is_admin_or_owner());

-- Seed with the two SKUs currently hard-coded in app.js.
insert into public.pomelo_catalogue (sku, label, unit_price, sort_order) values
  ('5kg',  '5 kg 装',  180, 1),
  ('10kg', '10 kg 装', 330, 2)
on conflict (sku) do nothing;

-- -----------------------------------------------------------------------------
-- 5. pomelo_page_content — public read, owner write
-- -----------------------------------------------------------------------------
create table if not exists public.pomelo_page_content (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

comment on table public.pomelo_page_content is
  'Editable storefront text. Public read; owner-only write.';

alter table public.pomelo_page_content enable row level security;

drop policy if exists "content_public_read" on public.pomelo_page_content;
create policy "content_public_read"
  on public.pomelo_page_content for select
  to anon, authenticated
  using (true);

drop policy if exists "content_owner_write" on public.pomelo_page_content;
create policy "content_owner_write"
  on public.pomelo_page_content for all
  to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- Seed a couple of editable strings (owner can add more from the UI).
insert into public.pomelo_page_content (key, value) values
  ('hero_title',    '泰国柚子 · 新鲜直送'),
  ('hero_subtitle', '扫码支付 · 无需注册')
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- 6. pomelo_orders — staff SELECT/UPDATE (anon INSERT already exists in 0001)
-- -----------------------------------------------------------------------------
-- Staff (any role) may read orders.
drop policy if exists "orders_staff_read" on public.pomelo_orders;
create policy "orders_staff_read"
  on public.pomelo_orders for select
  to authenticated
  using (public.is_staff());

-- Staff may update orders. Column-level restrictions (a 'user' may only change
-- status/note) are enforced in the serverless function, since RLS is row-level.
drop policy if exists "orders_staff_update" on public.pomelo_orders;
create policy "orders_staff_update"
  on public.pomelo_orders for update
  to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- -----------------------------------------------------------------------------
-- 7. Bootstrap the first owner
-- -----------------------------------------------------------------------------
-- The owner account must exist in auth.users first (sign up via login.html or
-- create it in the Supabase dashboard). Then run the statement below ONCE with
-- your real owner email. It is idempotent.
--
--   update public.profiles
--   set role = 'owner'
--   where email = 'REPLACE_WITH_OWNER_EMAIL';
--
-- After that, the owner can grant admin/user roles from admin.html.
-- =============================================================================

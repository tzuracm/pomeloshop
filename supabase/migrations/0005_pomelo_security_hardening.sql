-- =============================================================================
-- Pomelo Shop — security hardening (P0/P1 fixes)
-- =============================================================================
-- Run this in the Supabase SQL Editor AFTER 0004_pomelo_delivery_methods.sql.
--
-- WHY
-- ---
-- The RBAC audit (plans/user-tier-permissions-audit.md) found that the database
-- trust boundary did not match the documented role model:
--
--   P0-1  Any authenticated user could PATCH their own profiles.role to 'owner'
--         through PostgREST, because RLS is row-level and the self-update policy
--         did not restrict columns.
--   P0-2  Public sign-up created a 'user' profile, and a missing profile was
--         treated as 'user', so any account could read every order.
--   P0-3  pomelo_settings was public-read, exposing bank_name / bank_account /
--         bank_holder to anyone holding the public anon key.
--   P1-1  A 'user' could bypass the API's status/note whitelist and change
--         total_satang / items / slip_url directly through PostgREST.
--   P1-2  There was no active/suspended state, so staff could not be offboarded.
--   P1-3  Anon INSERT accepted any slip_url, including javascript: URLs that the
--         admin console rendered as a clickable link.
--   P1-4  The slip bucket was publicly listable, exposing every transfer slip.
--
-- MODEL AFTER THIS MIGRATION
-- --------------------------
--   * profiles.status: pending | active | suspended. Only 'active' staff pass
--     the role helpers. New accounts start 'pending' (no access).
--   * Authenticated staff are READ-ONLY through PostgREST. Every mutation goes
--     through /api/admin/* with the service_role key, after a server-side check.
--   * anon may read only the payment keys it needs to build the QR.
--   * anon may INSERT orders and upload slips, but cannot read/list them.
--
-- All statements are idempotent and safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. profiles.status — account lifecycle
-- -----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists status text not null default 'pending';

-- Add the CHECK separately so re-runs are safe.
alter table public.profiles
  drop constraint if exists profiles_status_check;
alter table public.profiles
  add constraint profiles_status_check
  check (status in ('pending', 'active', 'suspended'));

comment on column public.profiles.status is
  'Account lifecycle: pending (no access), active (staff), suspended (no access).';

-- Backfill: every profile that already exists was created deliberately as a
-- staff account before this migration, so keep it working. Accounts created
-- from now on start 'pending' via handle_new_user() below.
update public.profiles
set status = 'active'
where status = 'pending'
  and role in ('user', 'admin', 'owner');

create index if not exists profiles_status_idx on public.profiles (status);

-- -----------------------------------------------------------------------------
-- 2. Role helpers — require an ACTIVE account
-- -----------------------------------------------------------------------------
-- Policies cannot SELECT from profiles directly (infinite recursion), so these
-- SECURITY DEFINER helpers remain the only safe way to ask "who is calling?".
-- They now also require status = 'active', which makes a pending or suspended
-- account fail every staff policy.
-- -----------------------------------------------------------------------------
create or replace function public.current_role()
returns text
language sql
stable
security definer set search_path = public
as $$
  select role from public.profiles
  where id = auth.uid() and status = 'active';
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'owner' and status = 'active'
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
    where id = auth.uid()
      and role in ('user', 'admin', 'owner')
      and status = 'active'
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
    where id = auth.uid()
      and role in ('admin', 'owner')
      and status = 'active'
  );
$$;

revoke all on function public.current_role() from public;
revoke all on function public.is_owner() from public;
revoke all on function public.is_staff() from public;
revoke all on function public.is_admin_or_owner() from public;
grant execute on function public.current_role() to authenticated;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin_or_owner() to authenticated;

-- -----------------------------------------------------------------------------
-- 3. New accounts start 'pending'
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    'pending'
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
-- 4. profiles RLS — no self-service role/status changes
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

-- P0-1: the old "profiles_update_own" policy let any authenticated user set
-- their own role to 'owner'. Remove it. Profile self-editing is not needed by
-- the app; role/status changes go through /api/admin/users (owner only).
drop policy if exists "profiles_update_own" on public.profiles;

-- Owners may update any profile (grant/revoke roles, activate/suspend).
drop policy if exists "profiles_owner_update_all" on public.profiles;
create policy "profiles_owner_update_all"
  on public.profiles for update
  to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- Defence in depth: even if a future policy allows a non-owner UPDATE, this
-- trigger rejects any change to role or status unless the caller is an active
-- owner. It also prevents demoting/suspending the last active owner.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  remaining_owners integer;
begin
  -- service_role (the admin API) and direct SQL have no auth.uid(); allow them.
  if auth.uid() is null then
    return new;
  end if;

  if not public.is_owner() then
    if new.role is distinct from old.role then
      raise exception 'Only an owner may change a role.' using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      raise exception 'Only an owner may change an account status.' using errcode = '42501';
    end if;
    return new;
  end if;

  -- Last-owner guard: never leave the shop without an active owner.
  if old.role = 'owner' and old.status = 'active'
     and (new.role is distinct from 'owner' or new.status is distinct from 'active') then
    select count(*) into remaining_owners
    from public.profiles
    where role = 'owner' and status = 'active' and id <> old.id;

    if remaining_owners = 0 then
      raise exception 'Cannot demote or suspend the last active owner.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_profile_privileges on public.profiles;
create trigger guard_profile_privileges
  before update on public.profiles
  for each row execute procedure public.guard_profile_privileges();

-- -----------------------------------------------------------------------------
-- 5. pomelo_settings — anon reads payment keys only
-- -----------------------------------------------------------------------------
alter table public.pomelo_settings enable row level security;

-- P0-3: the old policy was `using (true)` for anon, which exposed bank_name,
-- bank_account and bank_holder to anyone with the public anon key. The
-- storefront only needs the two payment keys.
drop policy if exists "settings_public_read" on public.pomelo_settings;
create policy "settings_anon_payment_read"
  on public.pomelo_settings for select
  to anon
  using (key in ('promptpay_id', 'promptpay_qr_payload'));

-- Active staff may read all settings (the admin console shows them).
drop policy if exists "settings_staff_read" on public.pomelo_settings;
create policy "settings_staff_read"
  on public.pomelo_settings for select
  to authenticated
  using (public.is_staff());

-- Owner-only write (insert/update/delete).
drop policy if exists "settings_owner_write" on public.pomelo_settings;
create policy "settings_owner_write"
  on public.pomelo_settings for all
  to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- -----------------------------------------------------------------------------
-- 6. pomelo_orders — staff read only; no direct UPDATE
-- -----------------------------------------------------------------------------
-- Staff (any active role) may read orders.
drop policy if exists "orders_staff_read" on public.pomelo_orders;
create policy "orders_staff_read"
  on public.pomelo_orders for select
  to authenticated
  using (public.is_staff());

-- P1-1: the old "orders_staff_update" policy let a 'user' change total_satang,
-- items and slip_url directly through PostgREST, bypassing the API whitelist.
-- All order mutations now go through /api/admin/orders (service_role).
drop policy if exists "orders_staff_update" on public.pomelo_orders;
revoke update on public.pomelo_orders from authenticated;
revoke update on public.pomelo_orders from anon;

-- P1-3: buyers insert orders directly with the anon key. Force the fields they
-- must not control and reject non-https slip URLs (javascript:/data: links were
-- rendered as clickable anchors in the admin console).
create or replace function public.sanitise_order_insert()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  new.status := 'pending';
  new.created_at := now();

  if new.slip_url is not null and new.slip_url <> '' then
    if new.slip_url !~* '^https://' then
      raise exception 'slip_url must be an https:// URL.' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists sanitise_order_insert on public.pomelo_orders;
create trigger sanitise_order_insert
  before insert on public.pomelo_orders
  for each row execute procedure public.sanitise_order_insert();

-- -----------------------------------------------------------------------------
-- 7. Storage — no anon listing of transfer slips
-- -----------------------------------------------------------------------------
-- P1-4: the bucket is public, so a direct object URL still works for staff.
-- But the anon SELECT policy allowed listing the whole bucket, exposing every
-- uploaded slip. Remove it; only active staff may list.
drop policy if exists "pomelo_slips_public_read" on storage.objects;

drop policy if exists "pomelo_slips_staff_read" on storage.objects;
create policy "pomelo_slips_staff_read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'pomelo-slips' and public.is_staff());

-- -----------------------------------------------------------------------------
-- 8. Verify
-- -----------------------------------------------------------------------------
select 'profiles.status column' as check, count(*) as present
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles' and column_name = 'status'
union all
select 'profiles_update_own policy (expect 0)', count(*)
from pg_policies
where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_update_own'
union all
select 'orders_staff_update policy (expect 0)', count(*)
from pg_policies
where schemaname = 'public' and tablename = 'pomelo_orders' and policyname = 'orders_staff_update'
union all
select 'settings_public_read policy (expect 0)', count(*)
from pg_policies
where schemaname = 'public' and tablename = 'pomelo_settings' and policyname = 'settings_public_read'
union all
select 'pomelo_slips_public_read policy (expect 0)', count(*)
from pg_policies
where schemaname = 'storage' and tablename = 'objects' and policyname = 'pomelo_slips_public_read'
union all
select 'authenticated UPDATE on orders (expect false)', count(*)
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'pomelo_orders'
  and grantee = 'authenticated' and privilege_type = 'UPDATE';

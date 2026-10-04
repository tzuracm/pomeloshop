-- =============================================================================
-- Pomelo Shop — rollback of 0001 + 0002 from the SHARED (open-play) project
-- =============================================================================
-- Run this ONCE in the SQL Editor of the OLD shared Supabase project
-- (the one open-play uses, ref `nglagtvjhgcfwzocoqio`).
--
-- WHY
-- ---
-- Pomelo's migrations 0001 + 0002 were applied to the shared project before we
-- decided to give Pomelo its own project. That left Pomelo-only objects behind
-- AND — more importantly — overwrote open-play's `public.handle_new_user()`
-- trigger function (both apps use the same trigger name `on_auth_user_created`).
--
-- This script:
--   1. Drops every Pomelo-only object (tables, bucket, policies, functions).
--   2. RESTORES open-play's shadow-aware `handle_new_user()` (from open-play
--      migration 0018) so new sign-ups behave exactly as before.
--   3. Leaves `public.profiles` and its data INTACT — it belongs to open-play.
--
-- SAFETY
-- ------
--   * Idempotent: every statement uses `if exists` / `drop ... if exists`.
--   * Does NOT touch open-play tables (sessions, bookings, venues, ...).
--   * Does NOT drop `public.profiles` (shared, owned by open-play).
--   * Run the whole file in one go. Review the SELECT at the end.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Pomelo-only tables (safe to drop — open-play never references them)
-- -----------------------------------------------------------------------------
drop table if exists public.pomelo_orders      cascade;
drop table if exists public.pomelo_settings    cascade;
drop table if exists public.pomelo_catalogue   cascade;
drop table if exists public.pomelo_page_content cascade;

-- -----------------------------------------------------------------------------
-- 2. Pomelo-only policies on the SHARED profiles table
-- -----------------------------------------------------------------------------
-- IMPORTANT: these must be dropped BEFORE the helper functions below, because
-- the policies depend on public.is_owner(). Dropping the functions first fails
-- with "cannot drop function ... because other objects depend on it".
-- These were created by pomelo 0002. open-play has its own policies on
-- `profiles`; only the pomelo-named ones are removed here.
drop policy if exists "profiles_read_own"          on public.profiles;
drop policy if exists "profiles_owner_read_all"    on public.profiles;
drop policy if exists "profiles_update_own"        on public.profiles;
drop policy if exists "profiles_owner_update_all"  on public.profiles;

-- Pomelo added this index; open-play does not use it.
drop index if exists public.profiles_role_idx;

-- -----------------------------------------------------------------------------
-- 3. Pomelo-only helper functions
-- -----------------------------------------------------------------------------
-- Safe now that no policy references them. `cascade` is a belt-and-braces
-- guard in case any other pomelo policy still depends on them.
drop function if exists public.is_admin_or_owner() cascade;
drop function if exists public.is_staff() cascade;
drop function if exists public.is_owner() cascade;
drop function if exists public.current_role() cascade;

-- -----------------------------------------------------------------------------
-- 4. Pomelo-only storage bucket + its policies
-- -----------------------------------------------------------------------------
-- Policies on storage.objects can be dropped from SQL.
drop policy if exists "pomelo_slips_anon_upload" on storage.objects;
drop policy if exists "pomelo_slips_public_read" on storage.objects;

-- NOTE: the bucket itself CANNOT be deleted from SQL. Supabase installs a
-- `storage.protect_delete()` trigger that raises:
--   "Direct deletion from storage tables is not allowed. Use the Storage API."
-- Delete the bucket from the Dashboard instead:
--   Storage → select the `pomelo-slips` bucket → Delete bucket.
-- (Empty it first if it contains uploaded slips.) This is a one-time manual
-- step; the SQL below does not touch storage.buckets.

-- -----------------------------------------------------------------------------
-- 5. RESTORE open-play's shadow-aware handle_new_user() (open-play 0018)
-- -----------------------------------------------------------------------------
-- Pomelo 0002 replaced this function with a simpler body. Restoring the
-- open-play version keeps shadow-profile / magic-link behaviour intact.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(new.email, '')));
begin
  -- Already have a profile for this auth user? Nothing to do.
  if exists (select 1 from public.profiles where id = new.id) then
    return new;
  end if;

  -- A shadow profile already exists for this email. Leave it in place;
  -- /auth/callback will link it to this auth user (preserving credits).
  if v_email <> '' and exists (
    select 1 from public.profiles
     where lower(email) = v_email
  ) then
    return new;
  end if;

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

-- Recreate the trigger so it points at the restored function body.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 6. Verify — expect ZERO rows for every query below
-- -----------------------------------------------------------------------------
-- (The `pomelo-slips` bucket is NOT checked here: it must be deleted manually
--  from the Dashboard, see section 7.)
select 'pomelo_orders'       as leftover, count(*) from information_schema.tables where table_schema = 'public' and table_name = 'pomelo_orders'
union all
select 'pomelo_settings',    count(*) from information_schema.tables where table_schema = 'public' and table_name = 'pomelo_settings'
union all
select 'pomelo_catalogue',   count(*) from information_schema.tables where table_schema = 'public' and table_name = 'pomelo_catalogue'
union all
select 'pomelo_page_content',count(*) from information_schema.tables where table_schema = 'public' and table_name = 'pomelo_page_content'
union all
select 'is_owner()',         count(*) from pg_proc where proname = 'is_owner'
union all
select 'current_role()',     count(*) from pg_proc where proname = 'current_role'
union all
select 'profiles_role_idx',  count(*) from pg_indexes where schemaname = 'public' and indexname = 'profiles_role_idx';

-- Confirm the restored trigger function is the shadow-aware one (should return
-- a body containing 'shadow profile').
select pg_get_functiondef('public.handle_new_user()'::regprocedure) as restored_function;

-- -----------------------------------------------------------------------------
-- 7. MANUAL STEP — delete the storage bucket
-- -----------------------------------------------------------------------------
-- SQL cannot delete a bucket (Supabase blocks direct storage-table deletes).
-- In the Dashboard: Storage -> `pomelo-slips` -> Delete bucket.
-- Empty it first if it still holds uploaded slips.

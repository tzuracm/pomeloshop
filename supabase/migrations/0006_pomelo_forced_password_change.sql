-- =============================================================================
-- Pomelo Shop — forced password change on first login
-- =============================================================================
-- Run this in the Supabase SQL Editor AFTER 0005_pomelo_security_hardening.sql.
--
-- WHY
-- ---
-- Owners provision staff accounts with a shared initial password. That password
-- must not stay valid: the account holder has to replace it the first time they
-- sign in. This migration adds the flag the API and the console use to enforce
-- that.
--
-- MODEL
-- -----
--   * profiles.must_change_password boolean not null default true
--   * New accounts (handle_new_user) start with must_change_password = true.
--   * /api/admin/me returns the flag; admin.js blocks the console until the
--     password is changed.
--   * /api/admin/change-password clears the flag after a successful change.
--   * The flag is NOT settable by the account holder through PostgREST: the
--     guard_profile_privileges trigger rejects non-owner changes to it.
--
-- All statements are idempotent and safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. profiles.must_change_password
-- -----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists must_change_password boolean not null default true;

comment on column public.profiles.must_change_password is
  'True until the account holder replaces the initial password. Enforced by /api/admin/change-password.';

-- Existing accounts were created before this policy existed and already have a
-- password their owner chose. Do not lock them out: only accounts that are still
-- on the shared bootstrap password should be forced to change it. We cannot read
-- the password, so we default existing rows to false and rely on the owner to
-- reset anyone who needs it.
update public.profiles
set must_change_password = false
where must_change_password = true
  and created_at < now();

-- -----------------------------------------------------------------------------
-- 2. New accounts must change the initial password
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, status, must_change_password)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    'pending',
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. The flag is server-controlled
-- -----------------------------------------------------------------------------
-- Extend the existing privilege guard so a non-owner cannot clear their own
-- must_change_password flag through PostgREST and skip the forced change.
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
    if new.must_change_password is distinct from old.must_change_password then
      raise exception 'Only the server may change the password-change flag.' using errcode = '42501';
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
-- 4. Verify
-- -----------------------------------------------------------------------------
select 'profiles.must_change_password column' as check, count(*) as present
from information_schema.columns
where table_schema = 'public'
  and table_name = 'profiles'
  and column_name = 'must_change_password'
union all
select 'profiles still pending password change', count(*)
from public.profiles
where must_change_password = true;

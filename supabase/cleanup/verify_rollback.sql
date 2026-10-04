-- =============================================================================
-- Pomelo Shop — verify the rollback from the SHARED (open-play) project
-- =============================================================================
-- Run this ON ITS OWN in the old shared project's SQL Editor.
-- (The Supabase SQL Editor only shows the result of the LAST statement when
--  several are submitted together, which is why the union table was hidden.)
--
-- Every `leftover` row below must be 0.
-- =============================================================================

select 'pomelo_orders'        as leftover, count(*) as count from information_schema.tables where table_schema = 'public' and table_name = 'pomelo_orders'
union all
select 'pomelo_settings',     count(*) from information_schema.tables where table_schema = 'public' and table_name = 'pomelo_settings'
union all
select 'pomelo_catalogue',    count(*) from information_schema.tables where table_schema = 'public' and table_name = 'pomelo_catalogue'
union all
select 'pomelo_page_content', count(*) from information_schema.tables where table_schema = 'public' and table_name = 'pomelo_page_content'
union all
select 'is_owner()',          count(*) from pg_proc where proname = 'is_owner'
union all
select 'is_staff()',          count(*) from pg_proc where proname = 'is_staff'
union all
select 'is_admin_or_owner()', count(*) from pg_proc where proname = 'is_admin_or_owner'
union all
select 'current_role()',      count(*) from pg_proc where proname = 'current_role'
union all
select 'profiles_role_idx',   count(*) from pg_indexes where schemaname = 'public' and indexname = 'profiles_role_idx'
union all
select 'pomelo profiles policies', count(*) from pg_policies
  where schemaname = 'public' and tablename = 'profiles'
    and policyname in ('profiles_read_own','profiles_owner_read_all','profiles_update_own','profiles_owner_update_all')
order by leftover;

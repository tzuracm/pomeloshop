-- =============================================================================
-- 0008 — pomelo_settings: admins may write the payment QR
-- =============================================================================
--
-- Why
-- ---
-- Payment configuration is an operational duty, not an ownership decision. The
-- owner should not be the only person who can replace a broken or rotated
-- receiving QR. `admin` and `owner` now both have full control; `user` has none.
--
-- What changes
-- ------------
-- 0005 created `settings_owner_write` with `using (public.is_owner())`. This
-- migration replaces it with `settings_admin_write`, gated on
-- `public.is_admin_or_owner()` — true for any active `admin` or `owner`.
-- (`is_staff()` is NOT used here: it also returns true for role `user`.)
--
-- The API layer enforces the same minimum role (`requireRole(req, "admin")` in
-- api/admin/payment-qr.js), so this policy is defence in depth, not the only
-- gate. The anon read policy from 0007 is untouched.
--
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

alter table public.pomelo_settings enable row level security;

-- Drop the owner-only write policy from 0005.
drop policy if exists "settings_owner_write" on public.pomelo_settings;

-- Admin + owner may insert/update/delete. `is_admin_or_owner()` requires an
-- active profile whose role is exactly `admin` or `owner`.
drop policy if exists "settings_admin_write" on public.pomelo_settings;
create policy "settings_admin_write"
  on public.pomelo_settings for all
  to authenticated
  using (public.is_admin_or_owner())
  with check (public.is_admin_or_owner());

comment on table public.pomelo_settings is
  'Payment configuration. Holds only the confirmed PromptPay QR payload (promptpay_qr_payload). Public read of that key; admin/owner write.';

-- -----------------------------------------------------------------------------
-- Verification
-- -----------------------------------------------------------------------------
-- Expect exactly one write policy: settings_admin_write.
select policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'pomelo_settings'
order by policyname;

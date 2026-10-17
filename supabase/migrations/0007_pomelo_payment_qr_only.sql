-- =============================================================================
-- Pomelo Shop — payment configuration is the confirmed QR only
-- =============================================================================
-- Run this in the Supabase SQL Editor AFTER 0006_pomelo_forced_password_change.sql.
--
-- WHY
-- ---
-- The old `敏感设置` panel stored four keys in `pomelo_settings`:
--
--   promptpay_id   — a manual PromptPay identifier
--   bank_name      — unused by any code path
--   bank_account   — unused by any code path
--   bank_holder    — unused by any code path
--
-- `promptpay_id` duplicated the receiving account already encoded in the
-- confirmed `promptpay_qr_payload`, and the bank fields were never read by the
-- storefront, the order views or the export. They only widened the sensitive
-- data surface. The admin console now has a single `收款二维码` tab, and the
-- confirmed payload is the only payment configuration.
--
-- DEPLOYMENT ORDER (important for an existing shop)
-- -------------------------------------------------
--   1. Deploy the code changes.
--   2. Sign in as owner and confirm a payment QR in the `收款二维码` tab.
--   3. Verify the storefront generates the correct QR.
--   4. THEN run this migration.
--
-- Running it before step 2 would leave a shop that only had `promptpay_id`
-- with no payment configuration at all. The confirmed `promptpay_qr_payload`
-- row is never touched by this migration.
--
-- All statements are idempotent and safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Drop the redundant settings rows
-- -----------------------------------------------------------------------------
delete from public.pomelo_settings
where key in ('promptpay_id', 'bank_name', 'bank_account', 'bank_holder');

-- -----------------------------------------------------------------------------
-- 2. Anonymous reads: the confirmed payload is the only public key
-- -----------------------------------------------------------------------------
-- Replaces the 0005 policy, which still allowed `promptpay_id`.
drop policy if exists "settings_anon_payment_read" on public.pomelo_settings;
create policy "settings_anon_payment_read"
  on public.pomelo_settings for select
  to anon
  using (key = 'promptpay_qr_payload');

-- Staff read and owner write policies from 0005 are unchanged.

-- -----------------------------------------------------------------------------
-- 3. Document the narrowed purpose of the table
-- -----------------------------------------------------------------------------
comment on table public.pomelo_settings is
  'Payment configuration. Holds only the confirmed PromptPay QR payload (promptpay_qr_payload). Public read of that key; owner-only write.';

-- -----------------------------------------------------------------------------
-- 4. Verify — expect exactly one row: promptpay_qr_payload (or zero if the
--    owner has not confirmed a QR yet)
-- -----------------------------------------------------------------------------
select key, updated_at
from public.pomelo_settings
order by key;

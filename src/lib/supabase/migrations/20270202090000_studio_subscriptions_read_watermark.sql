-- 20270202090000_studio_subscriptions_read_watermark.sql
-- BILLING-QA-6 (issue #354 R-B): ordering watermark for the platform subscription webhook.
--   * Adds ONE nullable column, stripe_state_read_at: the instant the webhook started the Stripe read whose state this row holds.
--   * The app writes a studio's subscription row only when its read started at or after the stored value, so a slower delivery
--     that read an older Stripe state can no longer overwrite a newer one. NULL (every existing row) means "no watermark yet": always writable.
--   * Additive and nullable: no backfill, no default, no index, no RLS or grant change. Old app code ignores the column.
-- ORDER: apply this SQL BEFORE the app that writes the column (a new app against a missing column fails every subscription delivery with 500).
-- Rollback: rollback/20270202090000_studio_subscriptions_read_watermark_rollback.sql (roll the app back first, then the column).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_subscriptions') is null then
    raise exception 'read-watermark precondition failed: public.studio_subscriptions is missing';
  end if;
end $$;

alter table public.studio_subscriptions
  add column if not exists stripe_state_read_at timestamptz;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'studio_subscriptions'
      and column_name = 'stripe_state_read_at' and data_type = 'timestamp with time zone'
  ) then
    raise exception 'read-watermark postflight failed: stripe_state_read_at is missing or not timestamptz';
  end if;
end $$;

comment on column public.studio_subscriptions.stripe_state_read_at is
  'Instant the subscription webhook started the Stripe read whose state this row holds. Writers apply a newer-or-equal read only; NULL = no watermark yet.';

commit;

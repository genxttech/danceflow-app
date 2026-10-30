-- Rollback of 20270202090000_studio_subscriptions_read_watermark.sql. Roll the app back FIRST (it writes this column).
-- Loses only the ordering watermark; no subscription state is stored in this column.
begin;
set local lock_timeout = '5s';
alter table public.studio_subscriptions drop column if exists stripe_state_read_at;
commit;

-- Rollback for 20260916013645_null_dead_subscription_plan_price_columns.sql
--
-- Restores this environment's own exact price_monthly / price_yearly
-- values from the snapshot the forward migration captured in
-- migration_support.subscription_plans_price_backup_20260916 immediately
-- before nulling them -- never a hardcoded literal, so this file behaves
-- correctly and identically whether run against DEV or PROD, even though
-- the two environments hold different historical values.
--
-- Restores price_monthly NOT NULL (safe: the preceding UPDATE guarantees
-- every row has a non-null value at that point, provided the forward
-- migration's snapshot succeeded for all 4 codes), clears the deprecation
-- column comments, and drops the now-consumed backup table. Does not touch
-- stripe_price_id_monthly, stripe_price_id_yearly, code, name, or any other
-- column/table.
--
-- This is a one-shot undo, not idempotent: a second invocation after the
-- backup table has already been dropped will fail cleanly at the `FROM
-- migration_support...` reference (table does not exist) rather than
-- silently corrupting data -- an intentional, accepted failure mode.

begin;

update public.subscription_plans sp
set
  price_monthly = b.price_monthly,
  price_yearly = b.price_yearly
from migration_support.subscription_plans_price_backup_20260916 b
where sp.code = b.code
  and sp.code in ('starter', 'growth', 'pro', 'organizer');

alter table public.subscription_plans
  alter column price_monthly set not null;

comment on column public.subscription_plans.price_monthly is null;
comment on column public.subscription_plans.price_yearly is null;

drop table if exists migration_support.subscription_plans_price_backup_20260916;

commit;

-- Pricing Data Hygiene -- database-cleanup slice.
--
-- CONTEXT: public.subscription_plans.price_monthly / price_yearly are dead
-- columns. Repo-wide audit (grep across src/ and every tracked .sql file
-- outside backups/, plus live pg_depend/pg_constraint/pg_views/pg_proc/
-- pg_policies checks) confirms zero application/runtime reads and zero
-- schema-level dependency on either column -- every customer-visible price
-- surface reads from the static plan catalog in src/lib/billing/plans.ts
-- instead. Live PROD values were reverified immediately before authoring
-- this migration and had already drifted from a 2026-07-15 backup snapshot,
-- confirming these columns are unmaintained and unreliable even as
-- historical reference.
--
-- This migration nulls rather than "corrects" the values -- setting them to
-- figures that mirror plans.ts would recreate a second, hand-maintained
-- source of truth that can silently drift again exactly as it already has.
-- NULL unambiguously signals "not authoritative" to any future engineer.
--
-- COLUMNS ARE KEPT (not dropped), because subscription_plans carries an RLS
-- policy (subscription_plans_public_select, roles={anon,authenticated})
-- exposing this table via Supabase's public REST API. No evidence of an
-- external consumer of price_monthly/price_yearly was found anywhere in
-- this repo, but it can't be fully ruled out -- keeping the columns
-- (nullable) means an unknown caller gets null instead of a hard
-- column-not-found error.
--
-- price_monthly is NOT NULL on both DEV and PROD (confirmed live via
-- information_schema.columns) -- this is dropped first so the nulling
-- UPDATE below can succeed. A first attempt at this migration (nulling
-- only, without this ALTER) failed transactionally on DEV with 23502 and
-- rolled back cleanly; this revision adds the missing step.
--
-- ROLLBACK DESIGN: rather than hardcode either environment's stale dollar
-- figures into the rollback (DEV and PROD already hold different values,
-- and a shared rollback file must not cross-contaminate one environment
-- with another's numbers -- confirmed live: DEV holds
-- 39.00/490.00,59.00/990.00,119.00/1190.00,0.00/NULL while PROD holds
-- 49.00/499.00,79.00/799.00,129.00/1299.00,12.00/NULL for
-- starter/growth/pro/organizer respectively), this migration first
-- snapshots each environment's own exact pre-migration values into a
-- migration-specific backup table, before nulling. The rollback then
-- restores from that same environment's own snapshot -- never a literal
-- hardcoded elsewhere. The snapshot table lives in a new, non-public
-- `migration_support` schema (no project-defined private schema existed
-- previously) so it is never exposed via Supabase's REST API (only
-- explicitly "exposed" schemas are REST-browsable; a newly created schema
-- is private by default, the same mechanism that already keeps
-- auth/storage/vault off the public API) -- reinforced with RLS enabled
-- and zero policies, plus explicit REVOKE from public/anon/authenticated.
--
-- Scope: exactly price_monthly and price_yearly, on exactly the 4 plan
-- rows (starter, growth, pro, organizer). Does not touch
-- stripe_price_id_monthly, stripe_price_id_yearly, code, name, or any other
-- column/table.

begin;

create schema if not exists migration_support;
revoke all on schema migration_support from public, anon, authenticated;

create table if not exists migration_support.subscription_plans_price_backup_20260916 (
  code text primary key,
  price_monthly numeric(10,2),
  price_yearly numeric(10,2),
  captured_at timestamptz not null default now()
);
alter table migration_support.subscription_plans_price_backup_20260916 enable row level security;
revoke all on migration_support.subscription_plans_price_backup_20260916 from public, anon, authenticated;

-- ON CONFLICT DO NOTHING: if this migration is ever accidentally rerun
-- after it already succeeded once, this must never overwrite a genuine
-- pre-migration snapshot with the post-migration NULL values.
insert into migration_support.subscription_plans_price_backup_20260916 (code, price_monthly, price_yearly)
select code, price_monthly, price_yearly
from public.subscription_plans
where code in ('starter', 'growth', 'pro', 'organizer')
on conflict (code) do nothing;

alter table public.subscription_plans
  alter column price_monthly drop not null;

update public.subscription_plans
set
  price_monthly = null,
  price_yearly = null
where code in ('starter', 'growth', 'pro', 'organizer');

comment on column public.subscription_plans.price_monthly is
  'Deprecated, not authoritative. Superseded by src/lib/billing/plans.ts. Prior value snapshotted in migration_support.subscription_plans_price_backup_20260916 before being nulled on 2026-09-16.';
comment on column public.subscription_plans.price_yearly is
  'Deprecated, not authoritative. Superseded by src/lib/billing/plans.ts. Prior value snapshotted in migration_support.subscription_plans_price_backup_20260916 before being nulled on 2026-09-16.';

commit;

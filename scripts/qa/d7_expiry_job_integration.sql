-- D7 Organizer Suite expiry job: integration run of the exact sequence the cron route performs
-- (src/app/api/cron/organizer-suite-entitlement-expiry/route.ts -> one RPC call as service_role per invocation).
-- Disposable, isolated PROD-equivalent Postgres ONLY (scripts/qa/iso-qa.mjs baseline + migration 20270203090000).
-- Never run against a hosted database. Run: psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/d7_expiry_job_integration.sql
\set ON_ERROR_STOP on
\pset footer off

create function pg_temp.t_assert(p_cond boolean, p_label text) returns void language plpgsql as $f$
begin
  if p_cond is not true then raise exception 'FAIL assert: %', p_label; end if;
  raise notice 'PASS assert: %', p_label;
end $f$;

-- What the route does: one call as service_role, count only.
create function pg_temp.job_run(p_as_of timestamptz) returns bigint language plpgsql as $f$
declare v bigint;
begin
  execute 'set local role service_role';
  select count(*) into v from public.expire_due_usage_addon_entitlements(p_as_of, 'organizer_suite');
  execute 'reset role';
  return v;
end $f$;

\echo === seed: NY studio (manual grant period_end 2027-07-09 + paid Stripe row), studio with open-ended grant, LA studio (grant 2027-07-09)
insert into public.studios (id, name, slug, timezone) values
  ('d7e00000-0000-0000-0000-000000000001', 'd7x ny', 'd7x-ny', 'America/New_York'),
  ('d7e00000-0000-0000-0000-000000000002', 'd7x open', 'd7x-open', 'America/New_York'),
  ('d7e00000-0000-0000-0000-000000000003', 'd7x la', 'd7x-la', 'America/Los_Angeles');

insert into public.usage_addon_entitlements
  (id, studio_id, workspace_type, feature_key, quantity_included, source, stripe_subscription_item_id, status, period_start, period_end, notes)
values
  ('e7e00000-0000-0000-0000-00000000000a', 'd7e00000-0000-0000-0000-000000000001', 'studio', 'organizer_suite', 1, 'manual_grant', null,
     'active', '2026-07-09', '2027-07-09', 'complimentary grant (test)'),
  ('e7e00000-0000-0000-0000-00000000000b', 'd7e00000-0000-0000-0000-000000000001', 'studio', 'organizer_suite', 1, 'stripe_subscription_item', 'si_d7x_test',
     'active', '2027-07-01', '2027-08-01', 'paid add-on (test)'),
  ('e7e00000-0000-0000-0000-00000000000c', 'd7e00000-0000-0000-0000-000000000002', 'studio', 'organizer_suite', 1, 'manual_grant', null,
     'active', null, null, 'open-ended grant (test)'),
  ('e7e00000-0000-0000-0000-00000000000d', 'd7e00000-0000-0000-0000-000000000003', 'studio', 'organizer_suite', 1, 'manual_grant', null,
     'active', '2026-07-09', '2027-07-09', 'LA grant (test)');

create temp table snap as select * from public.usage_addon_entitlements where id::text like 'e7e00000-%';
create temp table ev0 as select count(*) as n from public.usage_addon_entitlement_events;

\echo === dry-run twin input (rows the read-only dry-run would see), as JSON for the TS boundary check
\pset tuples_only on
\o /tmp/d7_dryrun_rows.json
select json_agg(json_build_object('id', e.id, 'source', e.source, 'status', e.status, 'period_start', e.period_start,
                                  'period_end', e.period_end, 'timezone', s.timezone) order by e.id)
from public.usage_addon_entitlements e join public.studios s on s.id = e.studio_id
where e.id::text like 'e7e00000-%';
\o
\pset tuples_only off

\echo === run 1: as_of 2027-07-09T03:59:59Z (one second before NY local midnight) -> 0
select pg_temp.t_assert(pg_temp.job_run('2027-07-09T03:59:59Z') = 0, 'run at 03:59:59Z expires 0');
select pg_temp.t_assert((select status from public.usage_addon_entitlements where id = 'e7e00000-0000-0000-0000-00000000000a') = 'active', 'NY grant still active before boundary');
select pg_temp.t_assert((select count(*) from public.usage_addon_entitlement_events) = (select n from ev0), 'no audit events from a no-op run');

\echo === run 2: as_of 2027-07-09T04:00:00Z (NY local midnight, EDT) -> exactly the NY grant
create temp table run2 as select now() as t;
select pg_temp.t_assert(pg_temp.job_run('2027-07-09T04:00:00Z') = 1, 'run at 04:00:00Z expires exactly 1');
select pg_temp.t_assert((select status from public.usage_addon_entitlements where id = 'e7e00000-0000-0000-0000-00000000000a') = 'expired', 'NY grant now expired');
select pg_temp.t_assert((select status from public.usage_addon_entitlements where id = 'e7e00000-0000-0000-0000-00000000000d') = 'active', 'LA grant (due 07:00Z) still active');

\echo === run 3: repeat at 04:00:00Z -> 0 (retry-safe)
select pg_temp.t_assert(pg_temp.job_run('2027-07-09T04:00:00Z') = 0, 'repeat run expires 0');
select pg_temp.t_assert(pg_temp.job_run('2027-07-09T05:00:00Z') = 0, 'next hourly run before LA midnight expires 0');

\echo === audit: exactly one status_change event for the transition, with the job reason/actor
select pg_temp.t_assert((select count(*) from public.usage_addon_entitlement_events where entitlement_id = 'e7e00000-0000-0000-0000-00000000000a' and event_type <> 'insert') = 1,
  'exactly one non-insert event for the NY grant');
select pg_temp.t_assert(exists (select 1 from public.usage_addon_entitlement_events
  where entitlement_id = 'e7e00000-0000-0000-0000-00000000000a' and event_type = 'status_change'
    and from_status = 'active' and to_status = 'expired'
    and actor = 'system:expire_due_usage_addon_entitlements'
    and reason like 'complimentary grant reached period_end (expire_due_usage_addon_entitlements, as_of 2027-07-09 04:00:00%'),
  'status_change active->expired with job reason and actor');
select pg_temp.t_assert((select count(*) from public.usage_addon_entitlement_events e, ev0 where true) - (select n from ev0) = 1,
  'the three runs wrote exactly one audit event in total');
select pg_temp.t_assert(current_setting('app.entitlement_actor', true) is null or current_setting('app.entitlement_actor', true) = '', 'actor setting restored after the call');

\echo === history preserved: row count unchanged, only status/updated_at changed on the NY grant
select pg_temp.t_assert((select count(*) from public.usage_addon_entitlements where id::text like 'e7e00000-%') = 4, 'all four rows still exist (nothing deleted)');
select pg_temp.t_assert(not exists (
  select 1 from snap s join public.usage_addon_entitlements u using (id)
  where (u.studio_id, u.organizer_id, u.workspace_type, u.feature_key, u.quantity_included, u.source, u.stripe_subscription_item_id,
         u.period_start, u.period_end, u.notes, u.created_at)
        is distinct from
        (s.studio_id, s.organizer_id, s.workspace_type, s.feature_key, s.quantity_included, s.source, s.stripe_subscription_item_id,
         s.period_start, s.period_end, s.notes, s.created_at)), 'non-status columns unchanged on every row');
select pg_temp.t_assert(not exists (
  select 1 from snap s join public.usage_addon_entitlements u using (id)
  where s.id <> 'e7e00000-0000-0000-0000-00000000000a' and (u.status, u.updated_at) is distinct from (s.status, s.updated_at)),
  'Stripe, open-ended and LA rows untouched (status and updated_at)');

\echo === access at 2027-07-09T04:00:00Z via the SQL twin of the shared boundary rule
select pg_temp.t_assert(public.usage_addon_entitlement_is_current(u.status, u.period_start, u.period_end, 'America/New_York', '2027-07-09T04:00:00Z') = false,
  'expired grant is not current') from public.usage_addon_entitlements u where u.id = 'e7e00000-0000-0000-0000-00000000000a';
select pg_temp.t_assert(public.usage_addon_entitlement_is_current(u.status, u.period_start, u.period_end, 'America/New_York', '2027-07-09T04:00:00Z') = true,
  'paid Stripe row is current') from public.usage_addon_entitlements u where u.id = 'e7e00000-0000-0000-0000-00000000000b';

\echo === post-run rows for the TS boundary check
\pset tuples_only on
\o /tmp/d7_after_rows.json
select json_agg(json_build_object('id', e.id, 'source', e.source, 'status', e.status, 'period_start', e.period_start,
                                  'period_end', e.period_end, 'timezone', s.timezone) order by e.id)
from public.usage_addon_entitlements e join public.studios s on s.id = e.studio_id
where e.id::text like 'e7e00000-%';
\o
\pset tuples_only off

\echo === final state
select u.id, u.source, u.status, u.period_end, s.timezone from public.usage_addon_entitlements u join public.studios s on s.id = u.studio_id
where u.id::text like 'e7e00000-%' order by u.id;
select entitlement_id, event_type, from_status, to_status, actor, reason from public.usage_addon_entitlement_events
where entitlement_id::text like 'e7e00000-%' order by created_at, entitlement_id;
\echo === SEQUENTIAL PART PASSED

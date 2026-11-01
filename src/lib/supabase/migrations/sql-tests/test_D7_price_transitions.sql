-- D7 WP-3 price transition records: disposable-database test. Never run against a hosted database.
-- Prerequisites (applied by scripts/qa/d7_price_transitions_sql.sh): stub roles/studios, 20270201090000, 20270204090000.
-- Each check raises on failure; the final notice is "ALL PASS".
\set ON_ERROR_STOP on

create temp table _r(name text, ok boolean);
grant all on _r to public;

create or replace function pg_temp.expect_error(p_sql text, p_state text, p_name text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into _r values (p_name, false);
  exception when others then
    insert into _r values (case when sqlstate = p_state then p_name else p_name || ' [got ' || sqlstate || ': ' || sqlerrm || ']' end, sqlstate = p_state);
  end;
end $$;

insert into public.studios(id) values ('00000000-0000-0000-0000-0000000000a1');
insert into public.protected_subscriptions(id, studio_id, stripe_subscription_id, protection_kind, terms_reference)
  values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'sub_TEST1', 'grandfathered_founder_legacy', 'test');
insert into public.protected_subscriptions(id, studio_id, stripe_subscription_id, protection_kind, terms_reference)
  values ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'sub_TEST2', 'grandfathered_founder_legacy', 'test');

insert into public.price_transition_notices(id, protected_subscription_id, studio_id, effective_at, new_stripe_price_id, new_unit_amount_cents, wording_reference)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', '2027-07-09T04:00:00Z', 'price_regular', 15900, 'wording-v1');

-- constraints
select pg_temp.expect_error($$update public.price_transition_notices set delivery_status = 'delivered' where id = '00000000-0000-0000-0000-0000000000c1'$$, '23514', 'delivered notice needs send evidence');
select pg_temp.expect_error($$insert into public.price_transition_notices(protected_subscription_id, studio_id, effective_at, new_stripe_price_id, new_unit_amount_cents, wording_reference) values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1', now(), 'regular', 100, 'w')$$, '23514', 'price id format');
select pg_temp.expect_error($$insert into public.price_transition_notices(protected_subscription_id, studio_id, effective_at, new_stripe_price_id, new_unit_amount_cents, wording_reference) values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1', now(), 'price_x', 0, 'w')$$, '23514', 'positive amount');

-- notice immutability: disclosed terms cannot change; delivery evidence can
select pg_temp.expect_error($$update public.price_transition_notices set new_unit_amount_cents = 1 where id = '00000000-0000-0000-0000-0000000000c1'$$, '42501', 'notice amount immutable');
select pg_temp.expect_error($$update public.price_transition_notices set effective_at = now() where id = '00000000-0000-0000-0000-0000000000c1'$$, '42501', 'notice date immutable');
select pg_temp.expect_error($$update public.price_transition_notices set wording_reference = 'x' where id = '00000000-0000-0000-0000-0000000000c1'$$, '42501', 'notice wording immutable');
update public.price_transition_notices set approved_by = '00000000-0000-0000-0000-0000000000d1', approved_at = now(),
  sent_at = now(), recipient = 'owner@example.test', message_id = 'm1', delivery_status = 'delivered' where id = '00000000-0000-0000-0000-0000000000c1';
insert into _r values ('delivery evidence can be recorded', true);
select pg_temp.expect_error($$update public.price_transition_notices set sent_at = now() - interval '40 days' where id = '00000000-0000-0000-0000-0000000000c1'$$, '42501', 'delivered sent_at cannot be backdated');
select pg_temp.expect_error($$update public.price_transition_notices set delivery_status = 'pending' where id = '00000000-0000-0000-0000-0000000000c1'$$, '42501', 'delivered cannot be withdrawn');
select pg_temp.expect_error($$update public.price_transition_notices set message_id = 'other' where id = '00000000-0000-0000-0000-0000000000c1'$$, '42501', 'delivered message id immutable');
select pg_temp.expect_error($$update public.price_transition_notices set approved_at = now() + interval '1 day' where id = '00000000-0000-0000-0000-0000000000c1'$$, '42501', 'approval immutable once set');
select pg_temp.expect_error($$delete from public.price_transition_notices where id = '00000000-0000-0000-0000-0000000000c1'$$, '42501', 'notice delete refused');
select pg_temp.expect_error($$truncate public.price_transition_notices$$, '0A000', 'notice truncate refused (referenced by a foreign key; the trigger covers the unreferenced case)');

-- transitions
insert into public.price_transitions(id, protected_subscription_id, notice_id, stripe_subscription_id, target_stripe_price_id, boundary_at, approved_by, dry_run)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'sub_TEST1', 'price_regular', '2027-07-09T04:00:00Z', '00000000-0000-0000-0000-0000000000d1', '{}');
select pg_temp.expect_error($$insert into public.price_transitions(protected_subscription_id, notice_id, stripe_subscription_id, target_stripe_price_id, boundary_at, approved_by, dry_run) values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1','sub_TEST1','price_regular','2027-07-09T04:00:00Z','00000000-0000-0000-0000-0000000000d1','{}')$$, '23505', 'second open transition refused (replay)');
select pg_temp.expect_error($$update public.price_transitions set status = 'scheduled' where id = '00000000-0000-0000-0000-0000000000e1'$$, '23514', 'scheduled needs a schedule id');
select pg_temp.expect_error($$update public.price_transitions set target_stripe_price_id = 'price_other' where id = '00000000-0000-0000-0000-0000000000e1'$$, '42501', 'approved target immutable');
select pg_temp.expect_error($$update public.price_transitions set boundary_at = now() where id = '00000000-0000-0000-0000-0000000000e1'$$, '42501', 'approved boundary immutable');
select pg_temp.expect_error($$update public.price_transitions set dry_run = '{"x":1}' where id = '00000000-0000-0000-0000-0000000000e1'$$, '42501', 'dry run snapshot immutable');
update public.price_transitions set status = 'scheduled', stripe_schedule_id = 'sub_sched_1', result = '{"ok":true}' where id = '00000000-0000-0000-0000-0000000000e1';
insert into _r values ('status, schedule id and result can be finalized', true);
select pg_temp.expect_error($$update public.price_transitions set stripe_schedule_id = 'sub_sched_other' where id = '00000000-0000-0000-0000-0000000000e1'$$, '42501', 'recorded schedule id immutable');
select pg_temp.expect_error($$update public.price_transitions set status = 'approved' where id = '00000000-0000-0000-0000-0000000000e1'$$, '42501', 'scheduled cannot return to approved');
update public.price_transitions set status = 'canceled' where id = '00000000-0000-0000-0000-0000000000e1';
select pg_temp.expect_error($$update public.price_transitions set status = 'approved' where id = '00000000-0000-0000-0000-0000000000e1'$$, '42501', 'finished transition cannot reopen');
select pg_temp.expect_error($$delete from public.price_transitions where id = '00000000-0000-0000-0000-0000000000e1'$$, '42501', 'transition delete refused');
select pg_temp.expect_error($$truncate public.price_transitions$$, '42501', 'transition truncate refused');
-- after a finished (failed) run a new open transition is allowed
insert into public.price_transitions(protected_subscription_id, notice_id, stripe_subscription_id, target_stripe_price_id, boundary_at, approved_by, dry_run)
  values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'sub_TEST1', 'price_regular', '2027-07-09T04:00:00Z', '00000000-0000-0000-0000-0000000000d1', '{}');
insert into _r values ('retry allowed after a canceled transition', true);

-- a transition cannot cite a notice that belongs to another protected subscription
select pg_temp.expect_error($$insert into public.price_transitions(protected_subscription_id, notice_id, stripe_subscription_id, target_stripe_price_id, boundary_at, approved_by, dry_run) values ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000c1','sub_TEST2','price_regular','2027-07-09T04:00:00Z','00000000-0000-0000-0000-0000000000d1','{}')$$, '23503', 'notice must belong to the same protected subscription');
-- delivery cannot be recorded without a prior approval
insert into public.price_transition_notices(id, protected_subscription_id, studio_id, effective_at, new_stripe_price_id, new_unit_amount_cents, wording_reference)
  values ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', '2027-07-09T04:00:00Z', 'price_regular', 15900, 'w');
select pg_temp.expect_error($$update public.price_transition_notices set sent_at = now(), recipient = 'a', message_id = 'm', delivery_status = 'delivered' where id = '00000000-0000-0000-0000-0000000000c9'$$, '23514', 'delivery needs a prior approval');

-- registry row cannot be deleted while referenced (restrict) and registry guard still applies
select pg_temp.expect_error($$delete from public.protected_subscriptions where id = '00000000-0000-0000-0000-0000000000b1'$$, '42501', 'registry delete still refused');

-- authorization
set role authenticated;
select pg_temp.expect_error($$select * from public.price_transitions$$, '42501', 'authenticated cannot read transitions');
select pg_temp.expect_error($$insert into public.price_transition_notices(protected_subscription_id, studio_id, effective_at, new_stripe_price_id, new_unit_amount_cents, wording_reference) values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1', now(), 'price_x', 1, 'w')$$, '42501', 'authenticated cannot write notices');
reset role;
set role anon;
select pg_temp.expect_error($$select * from public.price_transition_notices$$, '42501', 'anon cannot read notices');
reset role;
set role service_role;
select pg_temp.expect_error($$delete from public.price_transitions$$, '42501', 'service_role cannot delete transitions');
select pg_temp.expect_error($$truncate public.price_transitions$$, '42501', 'service_role cannot truncate transitions');
reset role;


-- ===== post-boundary reconciliation (complete_price_transition_reconciliation) =====
insert into public.protected_subscriptions(id, studio_id, stripe_subscription_id, stripe_customer_id, protection_kind, terms_reference)
  values ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', 'sub_TEST3', 'cus_TEST3', 'grandfathered_founder_legacy', 'test'),
         ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000a1', 'sub_TEST4', 'cus_TEST4', 'grandfathered_founder_legacy', 'test');
insert into public.price_transition_notices(id, protected_subscription_id, studio_id, effective_at, new_stripe_price_id, new_unit_amount_cents, wording_reference)
  values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', '2027-07-09T04:00:00Z', 'price_regular', 15900, 'w'),
         ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000a1', '2027-07-09T04:00:00Z', 'price_regular', 15900, 'w');
insert into public.price_transitions(id, protected_subscription_id, notice_id, stripe_subscription_id, target_stripe_price_id, boundary_at, approved_by, dry_run)
  values ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000c3', 'sub_TEST3', 'price_regular', '2027-07-09T04:00:00Z', '00000000-0000-0000-0000-0000000000d1', '{}'),
         ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000c4', 'sub_TEST4', 'price_regular', '2027-07-09T04:00:00Z', '00000000-0000-0000-0000-0000000000d1', '{}');

create or replace function pg_temp.evidence(p_sub text, p_price text, p_sched text, p_over jsonb default '{}') returns jsonb language sql as $f$
  select jsonb_build_object('subscription_id', p_sub, 'price_id', p_price, 'schedule_id', p_sched,
    'boundary_at', '2027-07-09T04:00:00Z', 'period_start', '2027-07-09T04:00:00Z',
    'customer_matches', 'true', 'studio_matches', 'true', 'phase_entered', 'true', 'price_changed', 'true', 'amount_matches_notice', 'true') || p_over
$f$;
grant execute on function pg_temp.evidence(text, text, text, jsonb) to public;

-- an approved (not yet scheduled) transition cannot be reconciled, nor jumped to reconciled by a direct update
set role service_role;
select pg_temp.expect_error($q$select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e3', pg_temp.evidence('sub_TEST3','price_regular','sub_sched_3'))$q$, '55000', 'approved transition cannot be reconciled');
select pg_temp.expect_error($q$update public.price_transitions set status = 'reconciled' where id = '00000000-0000-0000-0000-0000000000e3'$q$, '42501', 'direct approved->reconciled refused');
reset role;
update public.price_transitions set status = 'scheduled', stripe_schedule_id = 'sub_sched_3', schedule_verified_at = now() where id = '00000000-0000-0000-0000-0000000000e3';
update public.price_transitions set status = 'scheduled', stripe_schedule_id = 'sub_sched_4', schedule_verified_at = now() where id = '00000000-0000-0000-0000-0000000000e4';

set role service_role;
select pg_temp.expect_error($q$select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e3', pg_temp.evidence('sub_TEST3','price_regular','sub_sched_3','{"price_id":"price_other"}'))$q$, '22023', 'wrong price evidence refused');
select pg_temp.expect_error($q$select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e3', pg_temp.evidence('sub_OTHER','price_regular','sub_sched_3'))$q$, '22023', 'wrong subscription evidence refused');
select pg_temp.expect_error($q$select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e3', pg_temp.evidence('sub_TEST3','price_regular','sub_sched_3','{"period_start":"2027-07-10T04:00:00Z"}'))$q$, '22023', 'period start off the boundary refused');
select pg_temp.expect_error($q$select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e3', pg_temp.evidence('sub_TEST3','price_regular','sub_sched_3','{"phase_entered":"false"}'))$q$, '22023', 'schedule not activated refused');
select pg_temp.expect_error($q$select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e3', pg_temp.evidence('sub_TEST3','price_regular','sub_sched_3','{"price_changed":"false"}'))$q$, '22023', 'price not changed refused');
select pg_temp.expect_error($q$select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e3', pg_temp.evidence('sub_TEST3','price_regular','sub_sched_3','{"customer_matches":"false"}'))$q$, '22023', 'customer mismatch refused');
select pg_temp.expect_error($q$select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e3', pg_temp.evidence('sub_TEST3','price_regular','sub_sched_3','{"amount_matches_notice":"false"}'))$q$, '22023', 'amount mismatch refused');
select pg_temp.expect_error($q$select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e3', null)$q$, '22023', 'null evidence refused');
reset role;
insert into _r select 'failed attempts changed nothing', (select released_at is null from public.protected_subscriptions where id = '00000000-0000-0000-0000-0000000000b3')
  and (select status = 'scheduled' from public.price_transitions where id = '00000000-0000-0000-0000-0000000000e3');

set role service_role;
do $d$
declare first_result text; second_result text;
begin
  first_result := public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e3', pg_temp.evidence('sub_TEST3','price_regular','sub_sched_3'));
  second_result := public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e3', pg_temp.evidence('sub_TEST3','price_regular','sub_sched_3'));
  insert into _r values ('first call reconciles', first_result = 'reconciled');
  insert into _r values ('replay is a no-op', second_result = 'already_reconciled');
end $d$;
reset role;
insert into _r select 'registry released atomically with the transition',
  (select released_at is not null and released_reason = 'price_transition_reconciled:00000000-0000-0000-0000-0000000000e3' from public.protected_subscriptions where id = '00000000-0000-0000-0000-0000000000b3')
  and (select status = 'reconciled' and reconciled_at is not null and activated_at is not null and price_changed_at is not null and reconcile_evidence is not null from public.price_transitions where id = '00000000-0000-0000-0000-0000000000e3');
select pg_temp.expect_error($q$update public.price_transitions set review_reason = 'x' where id = '00000000-0000-0000-0000-0000000000e3'$q$, '42501', 'reconciled transition is immutable');
select pg_temp.expect_error($q$update public.protected_subscriptions set released_reason = 'edited' where id = '00000000-0000-0000-0000-0000000000b3'$q$, '42501', 'registry release stays immutable');

-- a registry row already released for another reason blocks reconciliation
update public.protected_subscriptions set released_at = now(), released_reason = 'manual release' where id = '00000000-0000-0000-0000-0000000000b4';
set role service_role;
select pg_temp.expect_error($q$select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e4', pg_temp.evidence('sub_TEST4','price_regular','sub_sched_4'))$q$, '55000', 'registry released for another reason refused');
reset role;
insert into _r select 'refused reconciliation left the transition open', (select status = 'scheduled' from public.price_transitions where id = '00000000-0000-0000-0000-0000000000e4');

-- needs_review is an open, operator-visible state
select pg_temp.expect_error($q$update public.price_transitions set status = 'needs_review' where id = '00000000-0000-0000-0000-0000000000e4'$q$, '23514', 'needs_review requires a reason');
update public.price_transitions set status = 'needs_review', review_reason = 'price mismatch', review_evidence = '{"seen":"price_other"}' where id = '00000000-0000-0000-0000-0000000000e4';
insert into _r values ('needs_review recorded with evidence', true);

-- authorization of the function
set role authenticated;
select pg_temp.expect_error($q$select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e4', '{}')$q$, '42501', 'authenticated cannot execute reconciliation');
reset role;
set role anon;
select pg_temp.expect_error($q$select public.complete_price_transition_reconciliation('00000000-0000-0000-0000-0000000000e4', '{}')$q$, '42501', 'anon cannot execute reconciliation');
reset role;
do $$
declare bad text;
begin
  select string_agg(name, '; ') into bad from _r where not ok;
  if bad is not null then raise exception 'FAILED CHECKS: %', bad; end if;
  raise notice 'ALL PASS (% checks)', (select count(*) from _r);
end $$;

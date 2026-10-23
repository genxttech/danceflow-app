-- Competition R2 (CI-D) -- competition entry refunds regression suite.
--
-- Covers 20270103090000_competition_r2_entry_refunds.sql. Today that is Section 1 only (registration cascade: a
-- cancelled / failed / refunded registration withdraws its entries AND scratches their open heat placements; entries
-- in locked or certified heats, and (owner Q1) entries that have danced, are never withdrawn automatically). The
-- ledger / RPC / webhook / accounting cases are concrete SPECIFICATIONS at the end, recorded (not run, not failures)
-- until the owner authorizes implementation (docs/competition/r2-entry-refunds.md §4.0, §4.1 T, §7).
--
-- Local Postgres only (isolated QA container); never hosted DEV/PROD. One transaction; the final block ALWAYS
-- raises, so nothing persists:
--   "COMPETITION R2 SQL SUITE PASS (<n> checks, <p> specs pending implementation)"  or  "COMPETITION R2 SQL SUITE FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_specs (name text, basis text) on commit drop;
create temp table t_ids (k text primary key, v uuid) on commit drop;
grant all on t_ids to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    set constraints all immediate;
    set constraints all deferred;
    insert into t_results values (p_name, true, 'ok');
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

create or replace function pg_temp.spec(p_name text, p_basis text) returns void
language sql as $$ insert into t_specs values (p_name, p_basis) $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-0c1d20' || p_suffix)::uuid $$;
create or replace function pg_temp.id(p_k text) returns uuid
language sql stable as $$ select v from t_ids where k = p_k $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.entry_status(p_entry text) returns text
language sql stable as $$ select status from public.event_competition_entries where id = pg_temp.u(p_entry) $$;
create or replace function pg_temp.placement(p_entry text) returns text
language sql stable as $$
  select string_agg(status, ',' order by status) from public.event_competition_heat_entries where entry_id = pg_temp.u(p_entry)
$$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Migration shape
-- ============================================================================
select pg_temp.chk('trigger function is the R2 body',
  (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.sync_competition_entries_from_registration()'::regprocedure)
    = '5fb5027897911eb2482efe03ec5cee19');
select pg_temp.chk('trigger is still wired to event_registrations',
  exists (select 1 from pg_trigger where tgname = 'sync_competition_entries_from_registration'
          and tgrelid = 'public.event_registrations'::regclass and not tgisinternal));

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
-- Registrations: f001 full refund, f002 cancel, f003 locked-heat mix, f004 partial refund, f005 payment failed,
-- f006 untouched bystander. Entries 0080xx; heat A (Bronze, unlocked) and heat B (Silver, locked later).
insert into auth.users (id, email) values (pg_temp.u('000001'), 't-r2-owner@example.test');
insert into public.profiles (id, email, full_name) values (pg_temp.u('000001'), 't-r2-owner@example.test', 'Owner');
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'R2 Studio', 't-r2-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values (pg_temp.u('00e001'), pg_temp.u('00a001'), 'R2 Comp', 't-r2-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
values (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Couples', 'single_dance', 'couple', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Bronze Couples', 'open'),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Silver Couples', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Final', 'final', 1),
  (pg_temp.u('006002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Final', 'final', 1);
insert into public.event_competition_dances (id, event_id, program_id, dance_key, name) values
  (pg_temp.u('004001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'two_step', 'Two Step'),
  (pg_temp.u('004002'), pg_temp.u('00e001'), pg_temp.u('001001'), 'waltz', 'Waltz');
insert into public.event_competition_division_dances (id, event_id, program_id, division_id, dance_id, sort_order) values
  (pg_temp.u('005011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('004001'), 1),
  (pg_temp.u('005021'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), pg_temp.u('004002'), 1);

insert into public.event_registrations (id, event_id, studio_id, attendee_first_name, attendee_last_name, attendee_email, status, payment_status)
select pg_temp.u('00f00' || n), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Reg', 'N' || n, 't-r2-reg' || n || '@example.test', 'confirmed', 'paid'
from generate_series(1, 6) n;

-- entry -> (registration, division)
create temp table t_entries (entry text, reg text, division text, label text) on commit drop;
grant all on t_entries to authenticated, anon, service_role;
insert into t_entries values
  ('008001', '00f001', '003001', 'Full refund placed scheduled'),
  ('008002', '00f001', '003001', 'Full refund placed checked in'),
  ('008003', '00f001', '003001', 'Full refund unplaced'),
  ('008004', '00f001', '003001', 'Full refund placed danced'),
  ('008005', '00f002', '003001', 'Cancelled placed'),
  ('008006', '00f003', '003002', 'Locked heat entry'),
  ('008007', '00f003', '003001', 'Locked-reg unlocked entry'),
  ('008008', '00f004', '003001', 'Partial refund placed'),
  ('008009', '00f005', '003001', 'Payment failed placed'),
  ('008010', '00f006', '003001', 'Bystander placed');
insert into public.event_competition_competitors (id, event_id, first_name, last_name, created_via)
select pg_temp.u('0070' || right(entry, 2)), pg_temp.u('00e001'), 'Dancer', label, 'staff' from t_entries;
insert into public.event_competition_entries (id, event_id, program_id, division_id, registration_id, display_name, status, eligibility_status)
select pg_temp.u(entry), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u(division), pg_temp.u(reg), label, 'confirmed', 'eligible' from t_entries;
insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, dance_role, display_name)
select pg_temp.u('00e001'), pg_temp.u(entry), pg_temp.u('0070' || right(entry, 2)), 'dancer', 'leader', label from t_entries;
insert into public.event_competition_entry_dances (event_id, entry_id, division_dance_id, dance_key, dance_label)
select pg_temp.u('00e001'), pg_temp.u(entry), case when division = '003001' then pg_temp.u('005011') else pg_temp.u('005021') end, 'offering', 'Offering'
from t_entries;

-- Plan: heat A = every Bronze entry except the unplaced one; heat B = the Silver (to-be-locked) entry.
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_ids values ('v1', public.create_competition_schedule_version(pg_temp.u('00e001'), 'v1', null));
select pg_temp.expect_ok('fixture: planner places the entries',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), jsonb_build_object('floorHeats', jsonb_build_array(
       jsonb_build_object('number', 1, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.u('003001'), 'roundId', pg_temp.u('006001'),
         'heatNumber', 1, 'name', 'Bronze Two Step', 'danceIds', jsonb_build_array(pg_temp.u('004001')),
         'entryIds', (select jsonb_agg(pg_temp.u(entry)) from t_entries where division = '003001' and entry <> '008003')))),
       jsonb_build_object('number', 2, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.u('003002'), 'roundId', pg_temp.u('006002'),
         'heatNumber', 1, 'name', 'Silver Waltz', 'danceIds', jsonb_build_array(pg_temp.u('004002')),
         'entryIds', jsonb_build_array(pg_temp.u('008006'))))))))$q$);
insert into t_ids select 'heat_a', id from public.event_competition_heats where schedule_version_id = pg_temp.id('v1') and division_id = pg_temp.u('003001');
insert into t_ids select 'heat_b', id from public.event_competition_heats where schedule_version_id = pg_temp.id('v1') and division_id = pg_temp.u('003002');
select pg_temp.expect_ok('fixture: lock heat B',
  $q$select public.set_competition_heat_lock_state(pg_temp.id('heat_b'), 'locked', 'Results in progress')$q$);
reset role;
update public.event_competition_heat_entries set status = 'checked_in' where entry_id = pg_temp.u('008002');
update public.event_competition_heat_entries set status = 'danced' where entry_id = pg_temp.u('008004');
select pg_temp.chk('fixture: 9 placements, heat B locked',
  (select count(*) from public.event_competition_heat_entries where event_id = pg_temp.u('00e001')) = 9
  and (select lock_state from public.event_competition_heats where id = pg_temp.id('heat_b')) = 'locked');

-- ============================================================================
-- Section 1 -- registration cascade (implemented)
-- ============================================================================
select pg_temp.expect_ok('full refund of a registration is accepted',
  $q$update public.event_registrations set payment_status = 'refunded', status = 'refunded' where id = pg_temp.u('00f001')$q$);
select pg_temp.chk('full refund: placed, not-danced entries withdrawn',
  pg_temp.entry_status('008001') = 'withdrawn' and pg_temp.entry_status('008002') = 'withdrawn');
select pg_temp.chk('full refund: unplaced entry withdrawn', pg_temp.entry_status('008003') = 'withdrawn');
select pg_temp.chk('full refund: scheduled placement scratched', pg_temp.placement('008001') = 'scratched', pg_temp.placement('008001'));
select pg_temp.chk('full refund: checked-in placement scratched', pg_temp.placement('008002') = 'scratched', pg_temp.placement('008002'));
select pg_temp.chk('Q1: an entry that has danced (unlocked heat) is NOT withdrawn', pg_temp.entry_status('008004') = 'confirmed', pg_temp.entry_status('008004'));
select pg_temp.chk('Q1: its danced placement is kept', pg_temp.placement('008004') = 'danced', pg_temp.placement('008004'));
select pg_temp.chk('full refund: withdrawal audited with fee handling refund',
  exists (select 1 from public.event_competition_entry_changes
          where entry_id = pg_temp.u('008001') and change_type = 'withdraw' and fee_handling = 'refund'));

select pg_temp.expect_ok('cancelling a registration is accepted',
  $q$update public.event_registrations set status = 'cancelled' where id = pg_temp.u('00f002')$q$);
select pg_temp.chk('cancel: entry withdrawn and placement scratched',
  pg_temp.entry_status('008005') = 'withdrawn' and pg_temp.placement('008005') = 'scratched');

select pg_temp.expect_ok('payment failure is accepted',
  $q$update public.event_registrations set payment_status = 'failed' where id = pg_temp.u('00f005')$q$);
select pg_temp.chk('payment failed: entry withdrawn and placement scratched',
  pg_temp.entry_status('008009') = 'withdrawn' and pg_temp.placement('008009') = 'scratched');

select pg_temp.expect_ok('full refund of a registration with an entry in a locked heat is accepted',
  $q$update public.event_registrations set payment_status = 'refunded', status = 'refunded' where id = pg_temp.u('00f003')$q$);
select pg_temp.chk('locked heat: its entry is NOT withdrawn (unchanged 10A guard)', pg_temp.entry_status('008006') = 'confirmed');
select pg_temp.chk('locked heat: its placement is NOT scratched', pg_temp.placement('008006') = 'scheduled', pg_temp.placement('008006'));
select pg_temp.chk('locked heat: the same registration''s unlocked entry is withdrawn and scratched',
  pg_temp.entry_status('008007') = 'withdrawn' and pg_temp.placement('008007') = 'scratched');

select pg_temp.expect_ok('partial refund is accepted',
  $q$update public.event_registrations set payment_status = 'partial' where id = pg_temp.u('00f004')$q$);
select pg_temp.chk('partial refund: entry and placement unchanged',
  pg_temp.entry_status('008008') = 'confirmed' and pg_temp.placement('008008') = 'scheduled');

select pg_temp.chk('bystander registration untouched',
  pg_temp.entry_status('008010') = 'confirmed' and pg_temp.placement('008010') = 'scheduled');

select pg_temp.expect_ok('re-firing the trigger on an already refunded registration is a no-op',
  $q$update public.event_registrations set notes = 'touch' where id = pg_temp.u('00f001')$q$);
select pg_temp.chk('re-fire: danced entry still confirmed, nothing else changed',
  pg_temp.entry_status('008004') = 'confirmed' and pg_temp.placement('008004') = 'danced' and pg_temp.placement('008001') = 'scratched');

-- SPECIFICATIONS (pending implementation authorization; not run, not failures). Concrete expected outcomes from
-- design §4.0 / §4.1 T / §7. Decisions: D1-D8 PROVISIONAL, C1/Q1/Q2 DECIDED. Each becomes a runnable check when
-- migration sections 2-7 are authorized. Cap / class / scope math is already unit-tested
-- (src/lib/payments/__tests__/competitionRefundRules.test.ts).
-- ============================================================================
-- request_competition_order_refund
select pg_temp.spec('T-req-1 entry cap: one-of-three entries, 10% order discount: max = gross - largest-remainder share (e.g. 2500 -> 2206 with a 1000 fee line)', 'D1');
select pg_temp.spec('T-req-2 request above the net cap raises; nothing inserted', 'D1');
select pg_temp.spec('T-req-3 fee add_on line refundable only when listed explicitly; never auto-added for an entry refund', 'D2');
select pg_temp.spec('T-req-4 sum over all lines <= Stripe captured amount (desk payment rows excluded from the cap)', 'D1/D2/C2');
select pg_temp.spec('T-req-5 replay of the same p_request_id returns the same refund id; different lines raise', 'idempotency');
select pg_temp.spec('T-req-6 item of another order / event refused (URL event <> order event)', 'authorization');
select pg_temp.spec('T-req-7 organizer_staff refused; organizer_admin, studio_owner, studio_admin, platform_admin allowed', 'D5');
select pg_temp.spec('T-req-8 unpaid / free / released order refused; missing or conflicting stored Stripe owner refused', 'PAY-DC-2A/PAY-WH-1');
select pg_temp.spec('T-req-9 two concurrent requests cannot exceed one cap (concurrency script)', 'idempotency');
-- observe_competition_stripe_refund (financial state F)
select pg_temp.spec('T-obs-1 requested -> succeeded: order partially_refunded; event_payments.refund_amount = sum succeeded; registration partial', 'F');
select pg_temp.spec('T-obs-2 all lines succeeded = captured: order refunded, registration refunded, payment refunded', 'F');
select pg_temp.spec('T-obs-3 pending counts against the cap but not as refunded money', 'REFUND-RECON-1');
select pg_temp.spec('T-obs-4 failed / canceled releases the cap; nothing refunded; no participation change', 'F');
select pg_temp.spec('T-obs-5 same stripe_refund_id observed via refund.created, refund.updated, charge.refunded: one row, one effect', 'idempotency');
select pg_temp.spec('T-obs-6 succeeded observed before pending: final state succeeded (out-of-order)', 'idempotency');
select pg_temp.spec('T-obs-7 account <> stored owner: refused, nothing written', 'PAY-DC-2A');
select pg_temp.spec('T-obs-8 succeeded -> failed reversal: totals drop, entry stays withdrawn, E-R raised (financial-only unless held)', 'F/E-R');
-- participation effects (P) and exceptions (E, Q1, Q2)
select pg_temp.spec('T-par-1 open-heat entry with withdraw_entry: withdrawn + scheduled/checked_in scratched; participation_outcome = withdrawn', 'P');
select pg_temp.spec('T-par-2 refund without withdraw: entry confirmed; outcome not_requested', 'D4');
select pg_temp.spec('T-par-3 entry in a locked heat: no change; one E-L parent + one competitive scope per locked heat with that round', 'D7/Q2');
select pg_temp.spec('T-par-4 entry with a danced placement in an unlocked heat: no change; E-L scoped to that round', 'Q1/Q2');
select pg_temp.spec('T-par-5 entry in a certified heat: no change to entry, placement, heat or results; E-C scoped to the certified round', 'D7/Q2');
select pg_temp.spec('T-par-6 mixed order (open + locked + certified entries): each entry follows its own class', 'P');
select pg_temp.spec('T-par-7 replay never writes a second participation_outcome, withdrawal, exception or scope', 'idempotency');
select pg_temp.spec('T-par-8 dashboard partial refund: unattributed exception; financial-only (no scope) unless an order entry is held', 'D6/Q2');
select pg_temp.spec('T-par-9 dashboard full refund via registration trigger: open entries withdrawn, held entries raise E-L/E-C', 'D6/Q1');
select pg_temp.spec('T-par-10 attribution of an unattributed refund respects caps and then applies P', 'D6');
-- resolution and K0 coupling
select pg_temp.spec('T-res-1 generic resolve_event_order_settlement_exception refuses competition_refund_* kinds', 'E');
select pg_temp.spec('T-res-2 E-L path 1: audited unlock -> withdraw -> scope resolves; certified unlock refused', 'E');
select pg_temp.spec('T-res-3 E-L path 2 keep_entry: requires note; organizer_staff refused', 'E/D5');
select pg_temp.spec('T-res-4 parent exception auto-resolves only when its last scope resolves', 'E');
select pg_temp.spec('T-res-5 scope resolution stamp is write-once; scope rows are append-only', 'E');
select pg_temp.spec('T-res-6 K0 precondition query blocks only the scoped round while unresolved (runs once F3 exists)', 'Q2/K0');
select pg_temp.spec('T-res-7 open exception older than 72h is re-queued for alert', 'point 7');
-- accounting (C1)
select pg_temp.spec('T-acc-1 one competition_entry_refund entry per succeeded refund, dated succeeded_at::date, source event_order_refunds', 'C1');
select pg_temp.spec('T-acc-2 competition revenue entry stays gross (no refund subtraction); normal event payments unchanged', 'C1');
select pg_temp.spec('T-acc-3 reversal posts a separate offsetting entry dated at reversal; locked-period entries never updated', 'C1');
select pg_temp.spec('T-acc-4 replay posts nothing new (unique source_table/source_id/entry_type/category)', 'C1');
select pg_temp.spec('T-acc-5 migration preflight refuses when a competition event_payments row already has refund_amount > 0', 'C1');
-- Stripe call (unit, app side)
select pg_temp.spec('T-app-1 Stripe refund params: amount, metadata.danceflow_refund_request_id, idempotencyKey comp-refund:<id>, stripeAccount stored owner, no refund_application_fee', 'D3');

-- ============================================================================
-- Verdict
-- ============================================================================
do $$
declare
  v_total int;
  v_pending int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select count(*) into v_pending from t_specs;
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'COMPETITION R2 SQL SUITE PASS (% checks, % specs pending implementation)', v_total, v_pending;
  end if;
  raise exception 'COMPETITION R2 SQL SUITE FAIL: %', v_failures;
end $$;

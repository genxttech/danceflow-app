-- Competition CF1 package A3 -- results integrity regression suite.
--
-- Covers 20270120093000_competition_cf1_a3_results_integrity.sql on top of the chain through A1 (20270120085000). A2 (lock) is NOT
-- required: rounds are locked through the E2 RPC; the A2 stage 'lock' is reported by A2.
-- Gates: U59 (calculate/approve refusal and the resolution routes), U60 (every scored round, clean non-callback rounds unaffected, the
-- two-couple minimum only for callback Finals), U61 (anchors, md5s, lock order, row locks), U69 (replay), U72 (evidence parity: the SQL
-- side prints the exclusion evidence for the TypeScript twin), U79 (pins and behaviour of the redefined functions), U80, U81, U82, U83.
-- U73 (engine accepts reason 'excluded') is conditional and reported BLOCKED: this tree registers no engine (REGISTERED_ENGINES = []).
-- Run as a SUPERUSER. One transaction, synthetic fixtures only (UUID block ...-cf1a30XXXXXX). The final block ALWAYS raises, so nothing persists:
--   "COMPETITION CF1 A3 SQL SUITE PASS (<n> checks, <b> blocked)"  or  "... FAIL: <failures>".
-- The notices "CF1A3_PARITY <json>" carry the evidence documents the vitest parity test recomputes (see __tests__/evidence.cf1a3.test.ts).
--
-- Rounds (one heat each unless noted; panel J1 A / J2 B / J3 C):
--   r1..r6   Final-only, one per discipline family (showcase, ballroom, country, west_coast_swing, collegiate_amateur, custom): the clean matrix
--   r7       exclusion resolved through the E2 REOPEN route          r8  exclusion resolved through the F2 CORRECTION route
--   r9       eligibility refusals at calculate / approve and replay  r10 refund-evidence classes (comped, partial, per-entry, cancelled, refunded)
--   r11/r14  callback Final (r11) after a promote_callback preliminary (r14): minimum of two  r12 one-couple Final-only division
--   r13      precedence: scratched, no-show and excluded together; the parity document
--   r15      every couple excluded: the heat drops out of the ranking set, participation stays

begin;

create temp table t_results (name text, ok boolean, detail text, status text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'), case when coalesce(p_ok, false) then 'PASS' else 'FAIL' end);
end $$;
create or replace function pg_temp.blocked(p_name text, p_why text) returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, true, p_why, 'BLOCKED');
end $$;
create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    perform pg_temp.chk(p_name, true, 'ok');
  exception when others then
    perform pg_temp.chk(p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;
-- The statement must fail with a message containing p_fragment; p_state, when given, must equal the SQLSTATE.
create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text, p_state text default null) returns void
language plpgsql as $$
declare
  v_unexpected boolean := false;
begin
  begin
    execute p_sql;
    v_unexpected := true;
    raise exception 'rollback probe';
  exception when others then
    if not v_unexpected then
      perform pg_temp.chk(p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0 and (p_state is null or sqlstate = p_state), sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then
    perform pg_temp.chk(p_name, false, 'statement unexpectedly succeeded');
  end if;
end $$;
-- Runs the statement and returns the PG_EXCEPTION_DETAIL of the error it raises (null when it does not raise).
create or replace function pg_temp.catch_detail(p_sql text) returns text
language plpgsql as $$
declare v_detail text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return v_detail;
  end;
  return null;
end $$;
create or replace function pg_temp.jd(p_text text) returns jsonb
language plpgsql as $$
begin
  return p_text::jsonb;
exception when others then
  return null;
end $$;
create or replace function pg_temp.try(p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    null;
  end;
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-cf1a30' || p_suffix)::uuid $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.rid(p int) returns uuid language sql immutable as $$ select pg_temp.u('06' || lpad(p::text, 2, '0') || '00') $$;
create or replace function pg_temp.dvid(p int) returns uuid language sql immutable as $$ select pg_temp.u('03' || lpad((case when p = 14 then 11 else p end)::text, 2, '0') || '00') $$;
create or replace function pg_temp.hid(p int) returns uuid language sql immutable as $$ select pg_temp.u('0d' || lpad(p::text, 2, '0') || '00') $$;
create or replace function pg_temp.eid(p int, i int) returns uuid language sql immutable as $$ select pg_temp.u('08' || lpad(p::text, 2, '0') || lpad(i::text, 2, '0')) $$;
create or replace function pg_temp.pid(n int) returns uuid language sql immutable as $$ select pg_temp.u('0010' || lpad(n::text, 2, '0')) $$;
create or replace function pg_temp.off(p_event text, p_user text) returns uuid
language sql stable security definer as $$
  select id from public.event_competition_officials where event_id = pg_temp.u(p_event) and user_id = pg_temp.u(p_user)
$$;
-- Placement marks for round p's heat: the REQUIRED ranking set (E2's expected entries), in entry-id order; judge j in 1..3 (3 = reversed).
create or replace function pg_temp.mkr(p int, p_judge int) returns jsonb
language sql stable security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'value', case when p_judge = 3 then x.cnt - x.rn + 1 else x.rn end) order by x.rn)
  from (select e as entry_id, row_number() over (order by e)::int rn, count(*) over ()::int cnt
        from unnest(public._compe2_heat_entries(pg_temp.hid(p))) e) x
$$;
-- One result row per entry of the round's ranking set (what the engine would return), placement by entry order.
create or replace function pg_temp.rows(p int) returns jsonb
language sql stable security definer as $$
  select coalesce(jsonb_agg(jsonb_build_object('entry_id', x.e, 'placement', x.rn) order by x.rn), '[]'::jsonb)
  from (select e, row_number() over (order by e)::int rn
        from unnest(public._compe2_round_entries(pg_temp.rid(p))) e where e <> all (public._compf2_no_show_entries(pg_temp.rid(p)))) x
$$;
create or replace function pg_temp.th() returns text language sql immutable as $$ select encode(sha256(convert_to('[{"step":1}]', 'UTF8')), 'hex') $$;
create or replace function pg_temp.vid(p int, p_version int) returns uuid
language sql stable security definer as $$
  select id from public.event_competition_result_versions where round_id = pg_temp.rid(p) and version = p_version
$$;
create or replace function pg_temp.rstatus(p int) returns text
language sql stable security definer as $$ select status from public.event_competition_rounds where id = pg_temp.rid(p) $$;
create or replace function pg_temp.vstatus(p int, p_version int) returns text
language sql stable security definer as $$
  select status from public.event_competition_result_versions where round_id = pg_temp.rid(p) and version = p_version
$$;
create or replace function pg_temp.nversions(p int) returns bigint
language sql stable security definer as $$ select count(*) from public.event_competition_result_versions where round_id = pg_temp.rid(p) $$;
create or replace function pg_temp.napprovals(p int) returns bigint
language sql stable security definer as $$
  select count(*) from public.event_competition_result_approvals a join public.event_competition_result_versions v on v.id = a.result_version_id where v.round_id = pg_temp.rid(p)
$$;
create or replace function pg_temp.hl1_danced(p_heat uuid) returns void language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_heats set status = 'complete' where id = p_heat;
  perform set_config('session_replication_role', 'origin', true);
end $$;
-- calculate / approve exactly as the app would (the database's own input hash); the caller's role is whoever is current.
create or replace function pg_temp.calc(p int, p_req uuid default gen_random_uuid()) returns jsonb
language plpgsql as $$
declare v_in jsonb;
begin
  v_in := public.competition_round_calculation_input(pg_temp.rid(p));
  return public.calculate_competition_round(pg_temp.rid(p), v_in ->> 'engine_key', v_in ->> 'engine_version', v_in ->> 'input_hash',
    pg_temp.th(), '[{"step":1}]'::jsonb, pg_temp.rows(p), '[]'::jsonb, p_req);
end $$;
create or replace function pg_temp.approve(p int, p_version int, p_reason text default null, p_req uuid default gen_random_uuid()) returns jsonb
language plpgsql as $$
begin
  return public.approve_competition_round_result(pg_temp.rid(p), pg_temp.vid(p, p_version), p_reason, p_req);
end $$;
create or replace function pg_temp.submit_as(p_user text, p int, p_judge int, p_reason text default null) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(pg_temp.u(p_user));
  v := public.submit_competition_ballot(pg_temp.rid(p), pg_temp.hid(p), pg_temp.mkr(p, p_judge), gen_random_uuid(), p_reason);
  execute 'reset role';
  return v;
end $$;
create or replace function pg_temp.ballots(p int, p_reason text default null) returns void
language plpgsql as $$
begin
  perform pg_temp.submit_as('000011', p, 1, p_reason);
  perform pg_temp.submit_as('000012', p, 2, p_reason);
  perform pg_temp.submit_as('000013', p, 3, p_reason);
end $$;
create or replace function pg_temp.lockit(p int, p_heat boolean default true) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.u('000001'));
  if p_heat then
    perform pg_temp.hl1_danced(pg_temp.hid(p));
    perform public.set_competition_heat_lock_state(pg_temp.hid(p), 'locked', 'fixture');
  end if;
  perform public.lock_competition_round_ballots(pg_temp.rid(p), gen_random_uuid());
  execute 'reset role';
end $$;
create or replace function pg_temp.prep(p int) returns void
language plpgsql as $$
begin
  perform pg_temp.ballots(p);
  perform pg_temp.lockit(p);
end $$;
create or replace function pg_temp.panel(p int) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.u('000001'));
  perform public.assign_competition_panel_member(pg_temp.rid(p), pg_temp.off('00e001', '000011'), 'A', gen_random_uuid());
  perform public.assign_competition_panel_member(pg_temp.rid(p), pg_temp.off('00e001', '000012'), 'B', gen_random_uuid());
  perform public.assign_competition_panel_member(pg_temp.rid(p), pg_temp.off('00e001', '000013'), 'C', gen_random_uuid());
  execute 'reset role';
end $$;
-- A co-signed exclusion of (round p, entry) written as the A5 definer functions would (superuser stands in; A5 is not part of this package).
create or replace function pg_temp.exclude(p int, p_entry uuid, p_seq int, p_kind text default 'other', p_reason text default 'Danced, then refunded') returns void
language plpgsql as $$
declare v_req uuid := gen_random_uuid();
begin
  insert into public.event_competition_round_exclusions
    (id, event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id)
  values (v_req, pg_temp.u('00e001'), pg_temp.rid(p), p_entry, '{}', 'exclude_requested', p_kind, p_reason, pg_temp.u('000001'), 'manager', gen_random_uuid(), p_seq, null);
  insert into public.event_competition_round_exclusions
    (event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id)
  values (pg_temp.u('00e001'), pg_temp.rid(p), p_entry, '{}', 'exclude_cosigned', p_kind, p_reason, pg_temp.u('000002'), 'chair', gen_random_uuid(), p_seq + 1, v_req);
end $$;
create or replace function pg_temp.blockers(p int) returns jsonb
language sql stable security definer as $$ select public._compe2_round_blockers(pg_temp.rid(p)) $$;
create or replace function pg_temp.canon_ev(p int) returns text
language sql stable security definer as $$
  select public._compf2_canon(public._compf2_evidence(pg_temp.rid(p), 'studio_ordinal_majority', '1'))
$$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (superuser; replica mode for placements, as the E2/F2/HL1 suites do)
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-cf1a3-owner@example.test'), (pg_temp.u('000002'), 't-cf1a3-owner2@example.test'),
  (pg_temp.u('000011'), 't-cf1a3-judge1@example.test'), (pg_temp.u('000012'), 't-cf1a3-judge2@example.test'), (pg_temp.u('000013'), 't-cf1a3-judge3@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'CF1A3 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-cf1a30%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-cf1a30%';

insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'CF1 A3 Studio', 't-cf1a3-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.u('000002'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000011'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000012'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000013'), pg_temp.u('00a001'), 'instructor', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'CF1 A3 Comp', 't-cf1a3-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);

-- Programs 1..6 = the six discipline families the CHECK constraints of 20260620/20260622 allow; 7 = ballroom with promote_callback.
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
select pg_temp.pid(f.n), pg_temp.u('00e001'), pg_temp.u('00a001'), 'P ' || f.fam, f.fam, 'relative', 'skating', 'configured',
       case when f.n = 7 then 'promote_callback' else 'none' end
from (values (1, 'showcase'), (2, 'ballroom'), (3, 'country'), (4, 'west_coast_swing'), (5, 'collegiate_amateur'), (6, 'custom'), (7, 'ballroom')) f(n, fam);
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
select pg_temp.u('0020' || lpad(n::text, 2, '0')), pg_temp.u('00e001'), pg_temp.pid(n), 'Contest ' || n, 'single_dance', 'pro_am', 'open' from generate_series(1, 7) n;

create temp table t_fix (n int primary key, prog int not null, rtype text not null, seq int not null, k int not null, method text not null) on commit drop;
insert into t_fix values
  (1, 1, 'final', 1, 3, 'ordinal_majority'), (2, 2, 'final', 1, 3, 'ordinal_majority'), (3, 3, 'final', 1, 3, 'ordinal_majority'),
  (4, 4, 'final', 1, 3, 'ordinal_majority'), (5, 5, 'final', 1, 3, 'ordinal_majority'), (6, 6, 'final', 1, 3, 'ordinal_majority'),
  (7, 3, 'final', 1, 3, 'ordinal_majority'), (8, 3, 'final', 1, 3, 'ordinal_majority'), (9, 3, 'final', 1, 3, 'ordinal_majority'),
  (10, 3, 'final', 1, 3, 'ordinal_majority'), (11, 7, 'final', 2, 3, 'ordinal_majority'), (12, 3, 'final', 1, 1, 'ordinal_majority'),
  (13, 3, 'final', 1, 5, 'ordinal_majority'), (14, 7, 'preliminary', 1, 0, 'callback_tally'), (15, 3, 'final', 1, 2, 'ordinal_majority');
-- one division per round, except r14 which shares r11's division
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
select pg_temp.dvid(n), pg_temp.u('00e001'), pg_temp.pid(prog), pg_temp.u('0020' || lpad(prog::text, 2, '0')), 'D' || n, 'open' from t_fix where n <> 14;
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
select pg_temp.rid(n), pg_temp.u('00e001'), pg_temp.pid(prog), pg_temp.dvid(n), 'R' || n, rtype, seq, 'draft', method from t_fix where n <> 14;
set session_replication_role = replica;
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
select pg_temp.rid(n), pg_temp.u('00e001'), pg_temp.pid(prog), pg_temp.dvid(n), 'R' || n, rtype, seq, 'approved', method, 2 from t_fix where n = 14;
set session_replication_role = origin;

insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.eid(f.n, i), pg_temp.u('00e001'), pg_temp.pid(f.prog), pg_temp.dvid(f.n), 'E' || f.n || '-' || i, 'confirmed', 'eligible', (f.n * 10 + i)::text
from t_fix f cross join lateral generate_series(1, f.k) i;

set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at)
values (pg_temp.u('00c001'), pg_temp.u('00e001'), 1, 'v1', 'published', now());
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status)
select pg_temp.hid(n), pg_temp.u('00e001'), pg_temp.dvid(n), pg_temp.rid(n), n, pg_temp.u('0020' || lpad(prog::text, 2, '0')), pg_temp.u('00c001'), 'scheduled'
from t_fix where k > 0;
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
select pg_temp.u('00e001'), pg_temp.dvid(f.n), pg_temp.hid(f.n), pg_temp.eid(f.n, i), i from t_fix f cross join lateral generate_series(1, f.k) i;
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
select pg_temp.u('00e001'), pg_temp.hid(n), 'waltz', 'Waltz', 1 from t_fix where k > 0;
set session_replication_role = origin;

select pg_temp.as_user(pg_temp.u('000001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000011'), 'judge', pg_temp.u('f10001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000012'), 'judge', pg_temp.u('f10002'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000013'), 'judge', pg_temp.u('f10003'));
reset role;
select pg_temp.panel(n) from generate_series(1, 13) n;
select pg_temp.panel(15);

set session_replication_role = replica;
update public.event_competition_rounds set status = 'active' where id in (select pg_temp.rid(n) from t_fix where k > 0 and n <> 14);
set session_replication_role = origin;

-- Programs profiled, locked and pinned (REG), as the F2 suite does.
do $$
begin
  if to_regprocedure('public.pin_competition_round_scoring(uuid)') is null then
    raise exception 'CF1 A3 suite needs REG 20270113 (pin_competition_round_scoring)';
  end if;
  set local session_replication_role = replica;
  update public.event_competition_programs set rules_profile_key = 'studio_simple', rules_profile_version = 1, profile_locked_at = now();
  insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at)
  select id, event_id, 'studio_simple', 1, jsonb_build_object('profile', jsonb_build_object('key', 'studio_simple', 'version', 1)), profile_locked_at
  from public.event_competition_programs;
  set local session_replication_role = origin;
  perform public.pin_competition_round_scoring(id) from public.event_competition_rounds;
end $$;

-- Orders / registrations used by r10 (refund evidence classes).
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, payment_status) values
  (pg_temp.u('0a0001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b1@example.test', 'paid'),
  (pg_temp.u('0a0002'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b2@example.test', 'partially_refunded'),
  (pg_temp.u('0a0003'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b3@example.test', 'refunded');
insert into public.event_registrations (id, studio_id, event_id, order_id, status, payment_status, attendee_first_name, attendee_last_name, attendee_email) values
  (pg_temp.u('0b0001'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'confirmed', 'paid', 'G', 'Paid', 'g1@example.test'),
  (pg_temp.u('0b0002'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'cancelled', 'paid', 'G', 'Cancelled', 'g2@example.test');

-- Ballots and locks through the real E2 RPCs for every round that is calculated or approved in this suite.
select pg_temp.prep(n) from unnest(array[1, 2, 3, 4, 5, 6, 9, 10, 11, 12]) n;

-- ============================================================================
-- 1. U79 / U61: pins, privileges, anchors, lock order (static) -- on the installed definitions
-- ============================================================================
select pg_temp.chk('U79: the ten redefined functions match the post-A3 md5 pins (CRs removed)',
  (select count(*) = 10 from (values
    ('public._compe2_round_heats(uuid)', '7a5a1563a9450e2ec3b807a69737f9f4'), ('public._compe2_heat_entries(uuid)', 'fdcb8728dde030c8d9772fdaf2963524'),
    ('public._compe2_round_entries(uuid)', '64859bac497c22fd7472b9e7ae6fc986'), ('public._compe2_guard_mark_insert()', '055adcc12d8f903a7570c93008f303a9'),
    ('public.competition_round_ballot_status(uuid)', '7d3bebe922fed33604666009d3a593a5'), ('public.competition_judge_ballot_sheet(uuid)', '2506cb2f466d1738fb1a8f298e805b5f'),
    ('public._compf2_evidence(uuid,text,text)', '415a823b4a689cae26b8a20187af58e7'), ('public.competition_round_results_review(uuid)', 'c9d747907caad0a88b75da1c53862f43'),
    ('public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)', 'bc3cc4397e740444a4d4a53d93b499cc'),
    ('public.approve_competition_round_result(uuid,uuid,text,uuid)', 'ac33e456925e64665db1ea0547bae18b')) t(sig, pin)
    where md5(replace(pg_get_functiondef(t.sig::regprocedure), E'\r', '')) = t.pin));
select pg_temp.chk('U61: lock_competition_round_ballots is NOT touched by A3 (still the HL1 text 6e417534...; A2 owns it)',
  md5(replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r', '')) in ('6e4175342d51ffe274d70ce413bae8c3')
  or position('_cf1_require_roster_eligible' in pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure)) > 0);
select pg_temp.chk('U79: _compe2_round_blockers and the no-show helpers are unchanged (no exclusion text in them)',
  position('_cf1_' in pg_get_functiondef('public._compe2_round_blockers(uuid)'::regprocedure)) = 0
  and position('_cf1_' in pg_get_functiondef('public._compf2_no_show_entries(uuid)'::regprocedure)) = 0
  and position('_cf1_' in pg_get_functiondef('public._compf2_heat_entry_no_show(uuid)'::regprocedure)) = 0
  and position('_cf1_' in pg_get_functiondef('public._compe2_round_judges(uuid)'::regprocedure)) = 0);
select pg_temp.chk('U79: every one of the six E2 functions carries the exclusion filter exactly once, right after the NS1 condition',
  (select bool_and((length(d) - length(replace(d, 'and not public._cf1_heat_entry_is_excluded(he.id)', ''))) / length('and not public._cf1_heat_entry_is_excluded(he.id)') = 1
                   and position('and not public.competition_heat_entry_is_no_show(he.id) and not public._cf1_heat_entry_is_excluded(he.id)' in d) > 0)
   from (select pg_get_functiondef(s::regprocedure) d from unnest(array['public._compe2_round_heats(uuid)', 'public._compe2_heat_entries(uuid)', 'public._compe2_round_entries(uuid)',
     'public._compe2_guard_mark_insert()', 'public.competition_round_ballot_status(uuid)', 'public.competition_judge_ballot_sheet(uuid)']) s) x));
select pg_temp.chk('U61: calculate: the lock statement and the roster check sit after the replay branch and the state check, before the engine pin',
  (with d as (select replace(pg_get_functiondef('public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)'::regprocedure), E'\r', '') t)
   select position('COMP_REQUEST_REUSED' in t) < position('COMP_RESULT_INVALID_TRANSITION' in t)
      and position('COMP_RESULT_INVALID_TRANSITION' in t) < position('for share' in t)
      and position('for share' in t) < position('_cf1_require_roster_eligible(p_round_id, ''calculate'')' in t)
      and position('_cf1_require_roster_eligible(p_round_id, ''calculate'')' in t) < position('COMP_ENGINE_NOT_AVAILABLE' in t)
      and position('for update' in t) < position('COMP_REQUEST_REUSED' in t)
      and (length(t) - length(replace(t, '_cf1_require_roster_eligible', ''))) / length('_cf1_require_roster_eligible') = 1
   from d));
select pg_temp.chk('U61: approve: the lock statement and the roster check sit AFTER the certification loop, immediately before the approved status write',
  (with d as (select replace(pg_get_functiondef('public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure), E'\r', '') t)
   select position('COMP_REQUEST_REUSED' in t) < position('COMP_SECOND_APPROVER_REQUIRED' in t)
      and position('set_competition_heat_lock_state' in t) < position('for share' in t)
      and position('for share' in t) < position('_cf1_require_roster_eligible(p_round_id, ''approve'')' in t)
      and position('_cf1_require_roster_eligible(p_round_id, ''approve'')' in t) < position('set status = ''approved'', updated_at' in t)
      and position('end loop' in t) < position('for share' in t)
      and (length(t) - length(replace(t, '_cf1_require_roster_eligible', ''))) / length('_cf1_require_roster_eligible') = 1
   from d));
select pg_temp.chk('U61: the entry lock is unfiltered, id-ordered, FOR SHARE over the ranking set; no function-level lock_timeout was added',
  (select bool_and(position('order by en.id for share' in t) > 0 and position('lock_timeout' in t) = 0 and position('FOR SHARE NOWAIT' in upper(t)) = 0)
   from (select pg_get_functiondef(s::regprocedure) t from unnest(array['public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)',
     'public.approve_competition_round_result(uuid,uuid,text,uuid)']) s) x)
  and not exists (select 1 from pg_proc p where p.proname in ('calculate_competition_round', 'approve_competition_round_result') and p.proconfig::text like '%lock_timeout%'));
select pg_temp.chk('U79: SECURITY DEFINER and search_path survive the redefinitions',
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']) from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname in ('_compe2_round_heats', '_compe2_heat_entries', '_compe2_round_entries', '_compe2_guard_mark_insert',
     'competition_round_ballot_status', 'competition_judge_ballot_sheet', '_compf2_evidence', 'competition_round_results_review', 'calculate_competition_round', 'approve_competition_round_result')));
select pg_temp.chk('U79: grants unchanged: internal helpers still not executable by authenticated/anon; the RPCs still are by authenticated, not anon',
  not has_function_privilege('authenticated', 'public._compf2_evidence(uuid,text,text)', 'execute')
  and not has_function_privilege('anon', 'public._compe2_round_entries(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._compe2_round_heats(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.approve_competition_round_result(uuid,uuid,text,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.competition_round_results_review(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)', 'execute'));

-- The pre-A3 evidence builder, reconstructed from the installed text by reversing A3's two replacements; its md5 must equal the pre-A3 pin.
do $$
declare
  v_def text := replace(pg_get_functiondef('public._compf2_evidence(uuid,text,text)'::regprocedure), E'\r', '');
  v_new2 text := $n$h2)))
                                       union all
                                       -- CF1 A3 (4.7): a couple excluded with a reason (kept: heat entries, ballots, marks), after scratched and no-show.
                                       select ex.entry_id, 'excluded'::text
                                       from public._cf1_excluded_entries(r.id) ex
                                       where ex.entry_id <> all (public._compf2_no_show_entries(r.id))
                                         and exists (select 1 from public.event_competition_heat_entries he
                                                     where he.entry_id = ex.entry_id and he.status <> 'scratched'
                                                       and he.heat_id in (select h.heat_id from public._compf2_round_all_heats(r.id) h))) u), '[]'::jsonb),$n$;
begin
  v_def := replace(v_def, v_new2, $o$h2)))) u), '[]'::jsonb),$o$);
  v_def := replace(v_def, 'and not public._compf2_heat_entry_no_show(he.id) and not public._cf1_heat_entry_is_excluded(he.id)', 'and not public._compf2_heat_entry_no_show(he.id)');
  perform pg_temp.chk('U79: reversing A3''s two replacements gives the pre-A3 evidence text (md5 2b1c9a22...: the rollback target is exact)',
    md5(v_def) = '2b1c9a22be4a4c4a4e5ba43adee37306', md5(v_def));
  v_def := replace(v_def, 'public._compf2_evidence(', 'public._a3test_evidence_pre(');
  execute v_def;
end $$;
create or replace function pg_temp.canon_pre(p int) returns text
language sql stable security definer as $$
  select public._compf2_canon(public._a3test_evidence_pre(pg_temp.rid(p), 'studio_ordinal_majority', '1'))
$$;
grant execute on function pg_temp.canon_pre(int) to authenticated;

-- ============================================================================
-- 2. U80 / U81 / U82 / U83: the clean matrix r1..r6 (one discipline family each) + r12 (one-couple Final-only): nothing changes
-- ============================================================================
select pg_temp.chk('U83: evidence of a round with NO exclusion is byte-identical to the pre-A3 builder, canonical text and hash (r1..r6, r9..r12, locked)',
  (select bool_and(pg_temp.canon_ev(n) = pg_temp.canon_pre(n) and public._compf2_sha256(pg_temp.canon_ev(n)) = public._compf2_sha256(pg_temp.canon_pre(n)))
   from unnest(array[1, 2, 3, 4, 5, 6, 9, 10, 11, 12]) n)
  and (select count(*) = 6 from public.event_competition_programs p where p.discipline_family in ('showcase', 'ballroom', 'country', 'west_coast_swing', 'collegiate_amateur', 'custom')
       and p.id in (pg_temp.pid(1), pg_temp.pid(2), pg_temp.pid(3), pg_temp.pid(4), pg_temp.pid(5), pg_temp.pid(6))));
select pg_temp.chk('U83: the jsonb documents are equal too, and no key was added (excludedEntries is [] for the clean rounds)',
  (select bool_and(public._compf2_evidence(pg_temp.rid(n), 'studio_ordinal_majority', '1') = public._a3test_evidence_pre(pg_temp.rid(n), 'studio_ordinal_majority', '1')
                   and public._compf2_evidence(pg_temp.rid(n), 'studio_ordinal_majority', '1') -> 'excludedEntries' = '[]'::jsonb
                   and (select array_agg(k order by k) from jsonb_object_keys(public._compf2_evidence(pg_temp.rid(n), 'studio_ordinal_majority', '1')) k)
                       = (select array_agg(k order by k) from jsonb_object_keys(public._a3test_evidence_pre(pg_temp.rid(n), 'studio_ordinal_majority', '1')) k))
   from unnest(array[1, 2, 3, 4, 5, 6, 9, 10, 11, 12]) n));

do $$
declare
  n int;
  v_fam text;
  v_calc jsonb;
  v_req uuid;
  v_apr uuid;
begin
  for n in 1..6 loop
    select discipline_family into v_fam from public.event_competition_programs where id = pg_temp.pid(n);
    perform pg_temp.chk('U81 ' || v_fam || ': round is ballots_locked with a three-couple ranking set (comped entries, no registration or order links: U82)',
      pg_temp.rstatus(n) = 'ballots_locked' and cardinality(public._compe2_round_entries(pg_temp.rid(n))) = 3
      and not exists (select 1 from public.event_competition_entries e where e.division_id = pg_temp.dvid(n) and (e.registration_id is not null or e.order_id is not null)));
    perform pg_temp.chk('U82 ' || v_fam || ': the roster check finds no problem for entries with neither registration nor order',
      not exists (select 1 from public._cf1_round_roster_problems(pg_temp.rid(n))));
    v_req := gen_random_uuid();
    perform pg_temp.as_user(pg_temp.u('000001'));
    begin
      v_calc := pg_temp.calc(n, v_req);
      perform pg_temp.chk('U81/U80 ' || v_fam || ': calculate succeeds (version 1, calculated)', (v_calc ->> 'replayed') = 'false' and (v_calc ->> 'version') = '1' and pg_temp.rstatus(n) = 'calculated');
      v_calc := pg_temp.calc(n, v_req);
      perform pg_temp.chk('U69 ' || v_fam || ': a calculate replay returns replayed:true and stores nothing new', (v_calc ->> 'replayed') = 'true' and pg_temp.nversions(n) = 1);
    exception when others then
      perform pg_temp.chk('U81/U80 ' || v_fam || ': calculate', false, sqlstate || ' ' || sqlerrm);
    end;
    execute 'reset role';
    perform pg_temp.as_user(pg_temp.u('000002'));
    v_apr := gen_random_uuid();
    begin
      v_calc := pg_temp.approve(n, 1, null, v_apr);
      perform pg_temp.chk('U81/U80 ' || v_fam || ': a second manager approves; status approved, heats certified',
        (v_calc ->> 'replayed') = 'false' and pg_temp.rstatus(n) = 'approved' and pg_temp.vstatus(n, 1) = 'approved'
        and (select lock_state = 'certified' from public.event_competition_heats where id = pg_temp.hid(n)) and pg_temp.napprovals(n) = 1);
      v_calc := pg_temp.approve(n, 1, null, v_apr);
      perform pg_temp.chk('U69 ' || v_fam || ': an approve replay returns replayed:true', (v_calc ->> 'replayed') = 'true' and pg_temp.napprovals(n) = 1);
    exception when others then
      perform pg_temp.chk('U81/U80 ' || v_fam || ': approve', false, sqlstate || ' ' || sqlerrm);
    end;
    execute 'reset role';
  end loop;
end $$;

-- r12: a ONE-couple Final-only division is not touched (the two-couple minimum is callback Finals only)
select pg_temp.chk('U60: r12 is a one-couple Final-only division: not a callback Final, one eligible couple, the roster check passes in both stages',
  not public._cf1_is_callback_final(pg_temp.rid(12)) and public._cf1_eligible_roster_count(pg_temp.rid(12)) = 1 and public._cf1_final_minimum_ok(pg_temp.rid(12)));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('U60: calculate on the one-couple Final-only division succeeds', $q$select pg_temp.calc(12)$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('U60: approve on the one-couple Final-only division succeeds', $q$select pg_temp.approve(12, 1)$q$);
reset role;
select pg_temp.chk('U60: r12 ends approved', pg_temp.rstatus(12) = 'approved');

-- ============================================================================
-- 3. U59 / U69: eligibility refusals at calculate and approve, replay, atomicity (r9)
-- ============================================================================
update public.event_competition_entries set eligibility_status = 'ineligible' where id = pg_temp.eid(9, 2);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('U59: calculate refuses an ineligible couple in the ranking set (COMP_ROSTER_ENTRY_UNAVAILABLE, P0001)', $q$select pg_temp.calc(9)$q$, 'COMP_ROSTER_ENTRY_UNAVAILABLE', 'P0001');
reset role;
select pg_temp.chk('U59: the refusal detail names stage "calculate", the round and the entry with its reason',
  (select (pg_temp.jd(d) ->> 'stage') = 'calculate' and (pg_temp.jd(d) ->> 'round_id') = pg_temp.rid(9)::text
          and (pg_temp.jd(d) -> 'entries' -> 0 ->> 'entry_id') = pg_temp.eid(9, 2)::text and (pg_temp.jd(d) -> 'entries' -> 0 ->> 'reason') = 'entry_ineligible'
   from (select pg_temp.catch_detail($q$select public.calculate_competition_round(pg_temp.rid(9), 'studio_ordinal_majority', '1', repeat('a', 64), pg_temp.th(), '[{"step":1}]', '[]', '[]', gen_random_uuid())$q$) d) x));
select pg_temp.chk('U59: nothing was stored by the refused calculation (no version; round still ballots_locked)', pg_temp.nversions(9) = 0 and pg_temp.rstatus(9) = 'ballots_locked');
update public.event_competition_entries set eligibility_status = 'eligible' where id = pg_temp.eid(9, 2);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('U59: after the cause is corrected (entry eligible again) calculate succeeds', $q$select pg_temp.calc(9, pg_temp.u('f90001'))$q$);
reset role;
-- replay after a LATER eligibility change: the insertion sits after the replay branch
update public.event_competition_entries set eligibility_status = 'ineligible' where id = pg_temp.eid(9, 2);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('U69: a calculate REPLAY after a later eligibility change is not refused (replayed:true)',
  (pg_temp.calc(9, pg_temp.u('f90001')) ->> 'replayed') = 'true');
select pg_temp.expect_msg('U69: a NEW request on the now-calculated round is refused by the STATE check first (the roster check runs after state validation)', $q$select pg_temp.calc(9)$q$, 'COMP_RESULT_INVALID_TRANSITION');
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('U59: approve refuses the same ineligible couple (stage approve)', $q$select pg_temp.approve(9, 1)$q$, 'COMP_ROSTER_ENTRY_UNAVAILABLE', 'P0001');
reset role;
select pg_temp.chk('U59: the refused approval rolled back EVERYTHING (version calculated, no approval row, no approval event, heat still locked, round calculated)',
  pg_temp.vstatus(9, 1) = 'calculated' and pg_temp.napprovals(9) = 0 and pg_temp.rstatus(9) = 'calculated'
  and (select lock_state = 'locked' from public.event_competition_heats where id = pg_temp.hid(9))
  and not exists (select 1 from public.event_competition_result_events where round_id = pg_temp.rid(9) and kind in ('result_approved', 'result_approval_override')));
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.chk('U59: the approve refusal detail says stage "approve", names the round and the entry',
  (select (pg_temp.jd(d) ->> 'stage') = 'approve' and (pg_temp.jd(d) ->> 'round_id') = pg_temp.rid(9)::text and (pg_temp.jd(d) -> 'entries' -> 0 ->> 'entry_id') = pg_temp.eid(9, 2)::text
   from (select pg_temp.catch_detail(format($q$select public.approve_competition_round_result(%L, %L, null, gen_random_uuid())$q$, pg_temp.rid(9), pg_temp.vid(9, 1))) d) x));
reset role;
update public.event_competition_entries set eligibility_status = 'eligible' where id = pg_temp.eid(9, 2);
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('U59: once corrected, approve succeeds', $q$select pg_temp.approve(9, 1, null, pg_temp.u('f90002'))$q$);
reset role;
-- approve replay after a later refund of the order/registration: not refused
update public.event_competition_entries set status = 'withdrawn' where id = pg_temp.eid(9, 3);
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.chk('U69: an approve REPLAY after a later status change is not refused (replayed:true)', (pg_temp.approve(9, 1, null, pg_temp.u('f90002')) ->> 'replayed') = 'true');
reset role;
update public.event_competition_entries set status = 'confirmed' where id = pg_temp.eid(9, 3);

-- ============================================================================
-- 4. U82 / U59: refund-evidence classes at calculate (r10): false positives that would block legitimate results
-- ============================================================================
set session_replication_role = replica;
-- e1: registration cancelled (refused) | e2: order partially_refunded (accepted) | e3: paid order + paid registration (accepted)
update public.event_competition_entries set registration_id = pg_temp.u('0b0002'), order_id = pg_temp.u('0a0001') where id = pg_temp.eid(10, 1);
update public.event_competition_entries set order_id = pg_temp.u('0a0002') where id = pg_temp.eid(10, 2);
update public.event_competition_entries set registration_id = pg_temp.u('0b0001'), order_id = pg_temp.u('0a0001') where id = pg_temp.eid(10, 3);
set session_replication_role = origin;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('U82: a CANCELLED registration blocks calculate (registration_cancelled)', $q$select pg_temp.calc(10)$q$, 'COMP_ROSTER_ENTRY_UNAVAILABLE');
reset role;
select pg_temp.chk('U82: only the cancelled-registration couple is named; the partially refunded and the paid couples are not',
  (select count(*) = 1 and bool_and(entry_id = pg_temp.eid(10, 1) and reason = 'registration_cancelled') from public._cf1_round_roster_problems(pg_temp.rid(10))));
set session_replication_role = replica;
update public.event_competition_entries set registration_id = null, order_id = null where id = pg_temp.eid(10, 1);
set session_replication_role = origin;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('U82: partially refunded order + paid registration + comped entry together do NOT block calculate (accepted false negatives until R2)', $q$select pg_temp.calc(10)$q$);
reset role;
select pg_temp.chk('U82: r10 calculated', pg_temp.rstatus(10) = 'calculated' and pg_temp.nversions(10) = 1);
-- a fully refunded order blocks approve (stage approve) and is reported per entry
update public.event_orders set payment_status = 'refunded' where id = pg_temp.u('0a0002');
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('U82: a fully REFUNDED order blocks approve for the entry it covers', $q$select pg_temp.approve(10, 1)$q$, 'COMP_ROSTER_ENTRY_UNAVAILABLE');
reset role;
select pg_temp.chk('U82: the refused approve names order_payment_refunded for e2 only',
  (select count(*) = 1 and bool_and(entry_id = pg_temp.eid(10, 2) and reason = 'order_payment_refunded') from public._cf1_round_roster_problems(pg_temp.rid(10))));
update public.event_orders set payment_status = 'partially_refunded' where id = pg_temp.u('0a0002');
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('U82: with the order back to partially_refunded, approve succeeds', $q$select pg_temp.approve(10, 1)$q$);
reset role;

-- ============================================================================
-- 5. U60 / U59: callback Final minimum of two (r11 after the promote_callback preliminary r14)
-- ============================================================================
select pg_temp.chk('U60: r11 is a callback Final (preliminary r14 in a promote_callback program); r12 / r1 are not',
  public._cf1_is_callback_final(pg_temp.rid(11)) and not public._cf1_is_callback_final(pg_temp.rid(12)) and not public._cf1_is_callback_final(pg_temp.rid(1)));
select pg_temp.exclude(11, pg_temp.eid(11, 1), 1);
select pg_temp.chk('U60: one exclusion leaves two eligible couples in the callback Final; the roster check passes',
  public._cf1_eligible_roster_count(pg_temp.rid(11)) = 2 and public._cf1_final_minimum_ok(pg_temp.rid(11)) and cardinality(public._compe2_round_entries(pg_temp.rid(11))) = 2);
select pg_temp.exclude(11, pg_temp.eid(11, 2), 3);
select pg_temp.chk('U60: two exclusions leave ONE couple', public._cf1_eligible_roster_count(pg_temp.rid(11)) = 1 and not public._cf1_final_minimum_ok(pg_temp.rid(11)));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('U60: calculate on a callback Final below two eligible couples -> COMP_ROSTER_BELOW_MINIMUM (P0001)', $q$select pg_temp.calc(11)$q$, 'COMP_ROSTER_BELOW_MINIMUM', 'P0001');
reset role;
select pg_temp.chk('U60: the refusal detail is {stage: calculate, eligible: 1, minimum: 2}',
  (select (pg_temp.jd(d) ->> 'stage') = 'calculate' and (pg_temp.jd(d) ->> 'eligible')::int = 1 and (pg_temp.jd(d) ->> 'minimum')::int = 2
   from (select pg_temp.catch_detail($q$select public.calculate_competition_round(pg_temp.rid(11), 'studio_ordinal_majority', '1', repeat('a', 64), pg_temp.th(), '[{"step":1}]', '[]', '[]', gen_random_uuid())$q$) d) x));
-- Reverse the second exclusion (seq 5 reverse request + seq 6 cosign) and calculate: the minimum is met again.
insert into public.event_competition_round_exclusions
  (id, event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id, reverses_id)
select pg_temp.u('0e1105'), pg_temp.u('00e001'), pg_temp.rid(11), pg_temp.eid(11, 2), '{}', 'reverse_requested', 'other', 'Refund resolved', pg_temp.u('000001'), 'manager', pg_temp.u('0f1105'), 5, null,
       (select id from public.event_competition_round_exclusions where round_id = pg_temp.rid(11) and entry_id = pg_temp.eid(11, 2) and kind = 'exclude_cosigned');
insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id)
values (pg_temp.u('00e001'), pg_temp.rid(11), pg_temp.eid(11, 2), '{}', 'reverse_cosigned', 'other', 'Refund resolved', pg_temp.u('000002'), 'chair', pg_temp.u('0f1106'), 6, pg_temp.u('0e1105'));
select pg_temp.chk('U60: the reversal restores the couple to the ranking set', cardinality(public._compe2_round_entries(pg_temp.rid(11))) = 2 and public._cf1_final_minimum_ok(pg_temp.rid(11)));

-- ============================================================================
-- 6. Exclusion semantics on the six E2 functions (r13: scratched + no-show + excluded + two normal couples)
-- ============================================================================
set session_replication_role = replica;
update public.event_competition_heat_entries set status = 'scratched' where heat_id = pg_temp.hid(13) and entry_id = pg_temp.eid(13, 1);
insert into public.event_competition_heat_no_shows (event_id, round_id, heat_id, heat_entry_id, entry_id, reason, marked_by, request_id)
select pg_temp.u('00e001'), pg_temp.rid(13), pg_temp.hid(13), he.id, he.entry_id, 'fixture no-show', pg_temp.u('000001'), pg_temp.u('0f' || '13' || '0' || (row_number() over ())::text)
from public.event_competition_heat_entries he where he.heat_id = pg_temp.hid(13) and he.entry_id = pg_temp.eid(13, 2);
set session_replication_role = origin;
select pg_temp.exclude(13, pg_temp.eid(13, 1), 1);   -- scratched AND excluded: scratched wins
select pg_temp.exclude(13, pg_temp.eid(13, 2), 3);   -- no-show AND excluded: no_show wins
select pg_temp.exclude(13, pg_temp.eid(13, 3), 5);   -- excluded only
select pg_temp.chk('U79: _compe2_round_entries / _compe2_heat_entries: only the two normal couples remain in the ranking set',
  public._compe2_round_entries(pg_temp.rid(13)) = (select array_agg(e order by e) from unnest(array[pg_temp.eid(13, 4), pg_temp.eid(13, 5)]) e)
  and public._compe2_heat_entries(pg_temp.hid(13)) = (select array_agg(e order by e) from unnest(array[pg_temp.eid(13, 4), pg_temp.eid(13, 5)]) e));
select pg_temp.chk('U79: the excluded couple''s heat entry keeps its recorded status (not scratched, not a no-show row, not rewritten)',
  (select status = 'scheduled' from public.event_competition_heat_entries where heat_id = pg_temp.hid(13) and entry_id = pg_temp.eid(13, 3))
  and not exists (select 1 from public.event_competition_heat_no_shows where entry_id = pg_temp.eid(13, 3))
  and (select count(*) from public.event_competition_heat_entries where heat_id = pg_temp.hid(13)) = 5);
select pg_temp.chk('U79: _compe2_round_heats keeps the heat (two normal couples)', (select count(*) = 1 from public._compe2_round_heats(pg_temp.rid(13))));
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.chk('U79: competition_judge_ballot_sheet lists exactly the two ranking-set couples',
  jsonb_array_length(public.competition_judge_ballot_sheet(pg_temp.rid(13)) -> 'heats' -> 0 -> 'entries') = 2);
reset role;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('U79: competition_round_ballot_status renders for the manager with exclusions present', $q$select public.competition_round_ballot_status(pg_temp.rid(13))$q$);
select pg_temp.chk('U79: the ballot status board expects the two ranking-set couples per judge (no mark for an excluded couple is expected)',
  (select position(pg_temp.eid(13, 3)::text in public.competition_round_ballot_status(pg_temp.rid(13))::text) = 0));
reset role;
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('U79: a ballot that still marks the excluded couple is refused (the required set is the ranking set)',
  format($q$select public.submit_competition_ballot(%L, %L, %L::jsonb, gen_random_uuid())$q$, pg_temp.rid(13), pg_temp.hid(13),
    jsonb_build_array(jsonb_build_object('entry_id', pg_temp.eid(13, 3), 'value', 1), jsonb_build_object('entry_id', pg_temp.eid(13, 4), 'value', 2), jsonb_build_object('entry_id', pg_temp.eid(13, 5), 'value', 3))::text),
  'COMP_BALLOT');
select pg_temp.expect_ok('U79: a ballot over the two ranking-set couples is accepted',
  format($q$select public.submit_competition_ballot(%L, %L, %L::jsonb, gen_random_uuid())$q$, pg_temp.rid(13), pg_temp.hid(13),
    jsonb_build_array(jsonb_build_object('entry_id', pg_temp.eid(13, 4), 'value', 1), jsonb_build_object('entry_id', pg_temp.eid(13, 5), 'value', 2))::text));
reset role;
-- ============================================================================
-- 7. U72 / U83: evidence for r13 -- precedence, participation kept, hash round trip; the parity document for vitest
-- ============================================================================
select pg_temp.chk('U79/U72: excludedEntries holds scratched (e1), no_show (e2) and excluded (e3), one row per entry, ordered by entry id',
  public._compf2_evidence(pg_temp.rid(13), 'studio_ordinal_majority', '1') -> 'excludedEntries' = jsonb_build_array(
    jsonb_build_object('entryId', pg_temp.eid(13, 1)::text, 'reason', 'scratched'),
    jsonb_build_object('entryId', pg_temp.eid(13, 2)::text, 'reason', 'no_show'),
    jsonb_build_object('entryId', pg_temp.eid(13, 3)::text, 'reason', 'excluded')));
select pg_temp.chk('U79: entries keeps EVERY participant (5), heats[].entryIds holds only the two ranking-set couples',
  jsonb_array_length(public._compf2_evidence(pg_temp.rid(13), 'studio_ordinal_majority', '1') -> 'entries') = 5
  and (public._compf2_evidence(pg_temp.rid(13), 'studio_ordinal_majority', '1') -> 'heats' -> 0 -> 'entryIds')
      = jsonb_build_array(pg_temp.eid(13, 4)::text, pg_temp.eid(13, 5)::text));
select pg_temp.chk('U79: the evidence hash binds the exclusion: the hash differs from the pre-A3 builder for r13 and ignores nothing else',
  public._compf2_sha256(pg_temp.canon_ev(13)) <> public._compf2_sha256(pg_temp.canon_pre(13)));
select pg_temp.chk('U72: the SQL canonical text of r13 evidence and its sha256 equal _compf2_input_hash',
  public._compf2_sha256(pg_temp.canon_ev(13)) = public._compf2_input_hash(pg_temp.rid(13), 'studio_ordinal_majority', '1'));
do $$
declare v_ev jsonb := public._compf2_evidence(pg_temp.rid(13), 'studio_ordinal_majority', '1');
begin
  raise notice 'CF1A3_PARITY %', jsonb_build_object('name', 'excluded_precedence_r13', 'evidence', v_ev, 'canonical', public._compf2_canon(v_ev),
    'input_hash', public._compf2_input_hash(pg_temp.rid(13), 'studio_ordinal_majority', '1'))::text;
  v_ev := public._compf2_evidence(pg_temp.rid(3), 'studio_ordinal_majority', '1');
  raise notice 'CF1A3_PARITY %', jsonb_build_object('name', 'no_exclusion_r3', 'evidence', v_ev, 'canonical', public._compf2_canon(v_ev),
    'input_hash', public._compf2_input_hash(pg_temp.rid(3), 'studio_ordinal_majority', '1'))::text;
end $$;

-- r15: every couple excluded: the heat drops out of the ranking set, participation and the reason stay in the evidence
select pg_temp.exclude(15, pg_temp.eid(15, 1), 1, 'ineligible', 'Became ineligible after dancing');
select pg_temp.exclude(15, pg_temp.eid(15, 2), 3, 'refunded', 'Refunded after dancing');
select pg_temp.chk('U79: r15: no ranking-set couple and no ballot heat remain, yet both couples stay in entries and are listed excluded',
  cardinality(public._compe2_round_entries(pg_temp.rid(15))) = 0 and (select count(*) = 0 from public._compe2_round_heats(pg_temp.rid(15)))
  and jsonb_array_length(public._compf2_evidence(pg_temp.rid(15), 'studio_ordinal_majority', '1') -> 'entries') = 2
  and (select bool_and(e ->> 'reason' = 'excluded') and count(*) = 2 from jsonb_array_elements(public._compf2_evidence(pg_temp.rid(15), 'studio_ordinal_majority', '1') -> 'excludedEntries') e)
  and public._compf2_evidence(pg_temp.rid(15), 'studio_ordinal_majority', '1') -> 'heats' = '[]'::jsonb);

-- ============================================================================
-- 8. U59: the resolution routes
-- ============================================================================
-- (a) E2 REOPEN route (r7): ballots filed, locked; a couple is excluded; the old ballots are stale; reopen, file corrected ballots, lock, calculate, approve.
select pg_temp.ballots(7);
select pg_temp.lockit(7);
select pg_temp.exclude(7, pg_temp.eid(7, 3), 1, 'refunded', 'Registration refunded after the heat was danced');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('U59 reopen: with the exclusion in place the already-locked round''s blockers report stale ballots',
  position('stale' in lower(pg_temp.blockers(7)::text)) > 0 or not coalesce((pg_temp.blockers(7) ->> 'ready')::boolean, false));
select pg_temp.expect_ok('U59 reopen: E2 reopen (ballots_locked -> active)', format($q$select public.reopen_competition_round_ballots(%L, 'exclusion recorded', gen_random_uuid())$q$, pg_temp.rid(7)));
reset role;
select pg_temp.chk('U59 reopen: the round is active again', pg_temp.rstatus(7) = 'active');
select pg_temp.submit_as('000011', 7, 1, 'ranking set changed by an exclusion');
select pg_temp.submit_as('000012', 7, 2, 'ranking set changed by an exclusion');
select pg_temp.submit_as('000013', 7, 3, 'ranking set changed by an exclusion');
select pg_temp.lockit(7, false);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('U59 reopen: calculate succeeds over the two ranking-set couples', $q$select pg_temp.calc(7)$q$);
reset role;
select pg_temp.chk('U59 reopen: the stored result has rows for the two ranking-set couples only (no row, placement or rank for the excluded couple)',
  (select count(*) = 2 from public.event_competition_result_rows where result_version_id = pg_temp.vid(7, 1))
  and not exists (select 1 from public.event_competition_result_rows where result_version_id = pg_temp.vid(7, 1) and entry_id = pg_temp.eid(7, 3)));
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('U59 reopen: approve succeeds', $q$select pg_temp.approve(7, 1)$q$);
reset role;
select pg_temp.chk('U59 reopen: the excluded couple''s ballots and marks were RETAINED (old ballot versions still exist, with a mark for the excluded entry)',
  exists (select 1 from public.event_competition_marks m join public.event_competition_ballots b on b.id = m.ballot_id where b.round_id = pg_temp.rid(7) and m.entry_id = pg_temp.eid(7, 3))
  and (select count(*) from public.event_competition_ballots where round_id = pg_temp.rid(7)) = 6);
-- (b) F2 CORRECTION route (r8): calculated -> correction -> exclusion -> corrected ballots -> recalculate -> approve
select pg_temp.ballots(8);
select pg_temp.lockit(8);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('U59 correction: r8 calculates with all three couples', $q$select pg_temp.calc(8)$q$);
select pg_temp.expect_ok('U59 correction: F2 correction opens (calculated -> ballots_locked)', format($q$select public.open_competition_round_correction(%L, 'one couple became ineligible after dancing', gen_random_uuid())$q$, pg_temp.rid(8)));
reset role;
select pg_temp.exclude(8, pg_temp.eid(8, 2), 1, 'ineligible', 'Became ineligible after dancing');
select pg_temp.chk('U59 correction: the invalidated version cannot be approved and the round awaits corrected ballots',
  pg_temp.vstatus(8, 1) in ('stale', 'superseded', 'calculated') and pg_temp.rstatus(8) = 'ballots_locked');
select pg_temp.submit_as('000011', 8, 1, 'ranking set changed by an exclusion');
select pg_temp.submit_as('000012', 8, 2, 'ranking set changed by an exclusion');
select pg_temp.submit_as('000013', 8, 3, 'ranking set changed by an exclusion');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('U59 correction: recalculation over the two ranking-set couples succeeds', $q$select pg_temp.calc(8)$q$);
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('U59 correction: approve of version 2 succeeds', $q$select pg_temp.approve(8, 2)$q$);
reset role;
select pg_temp.chk('U59 correction: version 2 holds two rows, none for the excluded couple', (select count(*) = 2 from public.event_competition_result_rows where result_version_id = pg_temp.vid(8, 2))
  and not exists (select 1 from public.event_competition_result_rows where result_version_id = pg_temp.vid(8, 2) and entry_id = pg_temp.eid(8, 2)));

-- ============================================================================
-- 9. Results review: the additive 'excluded' section (r7)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('review: the excluded section lists the couple with the recorded reason kind, reason, requester, co-signer and exclusion id',
  (select jsonb_array_length(x) = 1 and (x -> 0 ->> 'entry_id') = pg_temp.eid(7, 3)::text and (x -> 0 ->> 'reason_kind') = 'refunded'
          and (x -> 0 ->> 'reason') = 'Registration refunded after the heat was danced' and (x -> 0 ->> 'state') = 'excluded'
          and (x -> 0 ->> 'requested_by') = pg_temp.u('000001')::text and (x -> 0 ->> 'cosigned_by') = pg_temp.u('000002')::text
          and (x -> 0 ->> 'cosigned_by_role') = 'chair' and (x -> 0 ->> 'exclusion_id') is not null and (x -> 0 ->> 'display_name') = 'E7-3'
          and (x -> 0 ->> 'requested_by_name') = 'CF1A3 t-cf1a3-owner'
   from (select public.competition_round_results_review(pg_temp.rid(7)) -> 'excluded' x) s));
select pg_temp.chk('review: a round with no exclusion has excluded = [] and every pre-existing key is still present',
  (public.competition_round_results_review(pg_temp.rid(1)) -> 'excluded') = '[]'::jsonb
  and (select array_agg(k order by k) from jsonb_object_keys(public.competition_round_results_review(pg_temp.rid(1))) k)
      = array['blockers', 'excluded', 'round', 'versions', 'viewer_id', 'viewer_role']);
reset role;

-- U61 row locks actually taken by calculate / approve are proven by the two-session probe (sql-tests/concurrency/run_cf1_a3_locks.sh), not here:
-- inside one transaction an earlier statement's locks would mask the ones under test.

-- ============================================================================
-- 10. U73 (conditional) and the parts that belong to other packages
-- ============================================================================
select pg_temp.blocked('U73: the engine and its adapter accept reason "excluded"', 'conditional: no engine is registered in this tree (REGISTERED_ENGINES = []); the type widening is covered by vitest/tsc only');
select pg_temp.blocked('stage "lock" of COMP_ROSTER_ENTRY_UNAVAILABLE', 'A2 owns lock_competition_round_ballots; not part of this package');
select pg_temp.blocked('A5 exclusion functions (request / co-sign / reversal)', 'A5 not built; exclusion rows are inserted directly as the superuser stand-in for its definer functions');

-- ============================================================================
-- Verdict
-- ============================================================================
do $$
declare
  v_total int;
  v_blocked int;
  v_failures text;
begin
  select count(*), count(*) filter (where status = 'BLOCKED') into v_total, v_blocked from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'COMPETITION CF1 A3 SQL SUITE PASS (% checks, % blocked)', v_total, v_blocked;
  end if;
  raise exception 'COMPETITION CF1 A3 SQL SUITE FAIL: %', v_failures;
end $$;

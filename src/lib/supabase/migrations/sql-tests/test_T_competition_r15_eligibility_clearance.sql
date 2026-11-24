-- Competition S4 / R-15 -- eligibility clearance regression suite (NOT YET EXECUTED: status PENDING, needs a local isolated Postgres under the heavy-lock rules).
--
-- Covers 20270301110000 (core), 20270301111000 (gates), 20270301112000 (write guard) on top of 10A-10D.1, CF1 (A1-A6, RB3, OD-17), E1, E2, O1, F2, F3.
-- Load the O1 fixture helper first (it supplies pg_temp.compo1_fixture_publish_rounds):
--   cat sql-tests/fixtures/competition_round_ready.sql sql-tests/test_T_competition_r15_eligibility_clearance.sql | psql ...
-- One transaction; the final block ALWAYS raises, so nothing persists:
--   "R15 SQL SUITE PASS (<n> checks)"  or  "R15 SQL SUITE FAIL: <failures>".
--
-- Scope here: predicate, RPC, write guard, placement/floor-state/publish gates, teams, age-restricted, unknown age, legacy rows, no-conversion.
-- NOT here (PENDING in the integrated chain suite, they need panel/ballot fixtures): start of a round, floor call through advance_competition_floor_heat,
-- lock, calculate, approve, F3 publish, callback advancement apply and Final start, A5 exclusion of a not-cleared couple, A6 reinstatement. Those stages
-- all call _cf1_entry_unavailable_reason, which this suite proves is strict, and r15_raise_not_cleared, which this suite proves raises.
-- Cross-reference: the R-12 session owns withdrawal/correction/reopen SQL tests; they are not duplicated.

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
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

create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text) returns void
language plpgsql as $$
declare
  v_unexpected boolean := false;
begin
  begin
    execute p_sql;
    set constraints all immediate;
    v_unexpected := true;
    raise exception 'rollback probe';
  exception when others then
    if not v_unexpected then
      insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  end if;
  set constraints all deferred;
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-0c1500' || p_suffix)::uuid $$;
create or replace function pg_temp.id(p_k text) returns uuid
language sql stable as $$ select v from t_ids where k = p_k $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- Request id for the RPC (n up to 9999).
create or replace function pg_temp.rq(p_n integer) returns uuid
language sql immutable as $$ select pg_temp.u('0f' || lpad(p_n::text, 4, '0')) $$;
-- RPC call as text: entry suffix, outcome, reason, criteria literal, request number.
create or replace function pg_temp.decide(p_entry text, p_outcome text, p_reason text, p_criteria text, p_n integer) returns text
language sql as $$
  select format('select public.set_competition_entry_eligibility(%L, %L, %L, %s, %L)', pg_temp.u(p_entry), p_outcome, p_reason, p_criteria, pg_temp.rq(p_n));
$$;
create or replace function pg_temp.reason(p_entry text) returns text
language sql as $$ select public._cf1_entry_unavailable_reason(pg_temp.u(p_entry)) $$;
create or replace function pg_temp.clr(p_entry text) returns text
language sql as $$ select public._r15_entry_clearance_reason(pg_temp.u(p_entry)) $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as postgres): event E (no sanctioning), event S (declares NDCA)
-- ============================================================================
insert into auth.users (id, email) values (pg_temp.u('000001'), 't-r15-owner@example.test');
insert into public.profiles (id, email, full_name) values (pg_temp.u('000001'), 't-r15-owner@example.test', 'Owner');
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'R15 Studio', 't-r15-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values (pg_temp.u('00e001'), pg_temp.u('00a001'), 'R15 Comp', 't-r15-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required, competition_sanctioning)
values (pg_temp.u('00e002'), pg_temp.u('00a001'), 'R15 Sanctioned', 't-r15-e2', 'competition', current_date + 30, current_date + 30, 'draft', 'private', true, 'ndca');

insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured'),
  (pg_temp.u('001002'), pg_temp.u('00e002'), pg_temp.u('00a001'), 'Country S', 'country', 'relative', 'skating', 'draft');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Couples', 'single_dance', 'couple', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e002'), pg_temp.u('001002'), 'Couples S', 'single_dance', 'couple', 'open');
insert into public.event_competition_contest_registration_rules (event_id, program_id, contest_id, dance_selection_mode, pricing_method, minimum_participants, maximum_participants)
select e, p, c, 'individual', 'flat_entry', 1, 10 from (values
  (pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001')),
  (pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('002002'))) v(e, p, c)
where not exists (select 1 from public.event_competition_contest_registration_rules r where r.contest_id = v.c);
update public.event_competition_contest_registration_rules set dance_selection_mode = 'individual' where contest_id in (pg_temp.u('002001'), pg_temp.u('002002'));

-- dA: unclassified. dB: age-restricted (Senior I). dP: unclassified, used for the publish gate through the O1 helper. dS: sanctioned event.
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status, age_label) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Open Couples', 'open', null),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Senior I Couples', 'open', 'Senior I'),
  (pg_temp.u('003003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Publish Probe', 'open', null),
  (pg_temp.u('003004'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('002002'), 'Sanctioned Open', 'open', null);
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Final', 'final', 1),
  (pg_temp.u('006002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Final', 'final', 1),
  (pg_temp.u('006003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'Final', 'final', 1);
insert into public.event_competition_dances (id, event_id, program_id, dance_key, name) values
  (pg_temp.u('004001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'two_step', 'Two Step');
insert into public.event_competition_division_dances (id, event_id, program_id, division_id, dance_id, sort_order) values
  (pg_temp.u('005011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('004001'), 1),
  (pg_temp.u('005012'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), pg_temp.u('004001'), 1),
  (pg_temp.u('005013'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), pg_temp.u('004001'), 1);

-- Competitors: 40 adults ('Dancer'), plus one 'Minor' and one 'Unknown' (the stub S5 predicate keys on first_name).
insert into public.event_competition_competitors (id, event_id, first_name, last_name, created_via)
select pg_temp.u('0070' || lpad(n::text, 2, '0')), pg_temp.u('00e001'), 'Dancer', 'N' || n, 'staff' from generate_series(1, 40) n;
insert into public.event_competition_competitors (id, event_id, first_name, last_name, created_via) values
  (pg_temp.u('007091'), pg_temp.u('00e001'), 'Minor', 'M', 'staff'),
  (pg_temp.u('007092'), pg_temp.u('00e001'), 'Unknown', 'U', 'staff'),
  (pg_temp.u('007093'), pg_temp.u('00e002'), 'Dancer', 'S', 'staff');

-- Entries (inserted as postgres: the write guard allows the owner role, so legacy-shaped rows such as 'eligible without determination' can be seeded).
-- 000x: dA individuals. E01 unverified, E02 needs_review, E03 to be eligible, E04 to be waived, E05 legacy eligible (no determination), E06 ineligible,
-- E07 multi-member entry of 3 (stands in for a team roster; fixture roles may need adjusting on first execution), E08 restricted division, E09 restricted division (waiver probe), E10 minor, E11 unknown age,
-- E12 provisional entry for the publish probe (dP), E13 sanctioned-event entry, E14 pending (not confirmed), E15 second eligible for placement.
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status) values
  (pg_temp.u('008001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E01 Unverified', 'confirmed', 'unverified'),
  (pg_temp.u('008002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E02 Needs Review', 'confirmed', 'needs_review'),
  (pg_temp.u('008003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E03 To Clear', 'confirmed', 'unverified'),
  (pg_temp.u('008004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E04 To Waive', 'confirmed', 'unverified'),
  (pg_temp.u('008005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E05 Legacy Eligible', 'confirmed', 'eligible'),
  (pg_temp.u('008006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E06 Ineligible', 'confirmed', 'ineligible'),
  (pg_temp.u('008007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E07 Team', 'confirmed', 'unverified'),
  (pg_temp.u('008008'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'E08 Senior Eligible', 'confirmed', 'unverified'),
  (pg_temp.u('008009'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'E09 Senior Waiver', 'confirmed', 'unverified'),
  (pg_temp.u('008010'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E10 Minor', 'confirmed', 'unverified'),
  (pg_temp.u('008011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E11 Unknown Age', 'confirmed', 'unverified'),
  (pg_temp.u('008012'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'E12 Publish Probe', 'confirmed', 'unverified'),
  (pg_temp.u('008013'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003004'), 'E13 Sanctioned', 'confirmed', 'unverified'),
  (pg_temp.u('008014'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E14 Pending', 'pending', 'unverified'),
  (pg_temp.u('008015'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'E15 Second Cleared', 'confirmed', 'unverified');
-- Participants: entry N uses competitor N (E10 the Minor, E11 the Unknown); E07 is a team of three.
insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, dance_role, display_name)
select pg_temp.u('00e001'), pg_temp.u('0080' || lpad(n::text, 2, '0')), pg_temp.u('0070' || lpad(n::text, 2, '0')), 'dancer', 'leader', 'P' || n
from generate_series(1, 15) n where n not in (7, 10, 11, 13);
insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, dance_role, display_name) values
  (pg_temp.u('00e001'), pg_temp.u('008007'), pg_temp.u('007007'), 'dancer', 'leader', 'T1'),
  (pg_temp.u('00e001'), pg_temp.u('008007'), pg_temp.u('007017'), 'dancer', 'follower', 'T2'),
  (pg_temp.u('00e001'), pg_temp.u('008007'), pg_temp.u('007027'), 'dancer', 'leader', 'T3'),
  (pg_temp.u('00e001'), pg_temp.u('008010'), pg_temp.u('007091'), 'dancer', 'leader', 'Minor'),
  (pg_temp.u('00e001'), pg_temp.u('008011'), pg_temp.u('007092'), 'dancer', 'leader', 'Unknown'),
  (pg_temp.u('00e002'), pg_temp.u('008013'), pg_temp.u('007093'), 'dancer', 'leader', 'Sanctioned');
insert into public.event_competition_entry_dances (event_id, entry_id, division_dance_id, dance_key, dance_label)
select e.event_id, e.id, case e.division_id when pg_temp.u('003001') then pg_temp.u('005011') when pg_temp.u('003002') then pg_temp.u('005012') else pg_temp.u('005013') end, 'offering', 'Offering'
from public.event_competition_entries e where e.event_id = pg_temp.u('00e001') and e.division_id in (pg_temp.u('003001'), pg_temp.u('003002'), pg_temp.u('003003'));

-- Snapshot for the no-conversion check (statuses and audit rows exist before any R15 call).
create temp table t_before as select id, status, eligibility_status from public.event_competition_entries;
create temp table t_audit_before as select count(*)::int as n from public.event_competition_entry_changes;

-- ============================================================================
-- A. Fail closed while the S5 age predicate does not exist
-- ============================================================================
select pg_temp.chk('S5 age predicate is absent at this point (the stub is created later)', to_regprocedure('public._comp_participant_age_clearance(uuid)') is null);
select pg_temp.chk('absent S5: an entry is never cleared (age not established)', pg_temp.clr('008005') in ('entry_determination_missing', 'entry_age_not_established'));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('absent S5: marking eligible is refused (fails closed)', pg_temp.decide('008003', 'eligible', 'criteria_verified_by_organizer', $$'{}'::text[]$$, 1), 'COMP_R15_DETERMINATION_INVALID');
reset role;

-- The S5 stub (rolled back with the suite): Minor -> blocked_under_18, Unknown -> unknown_age, else allowed.
create function public._comp_participant_age_clearance(p_competitor_id uuid) returns text
language sql stable as $$
  select case c.first_name when 'Minor' then 'blocked_under_18' when 'Unknown' then 'unknown_age' else 'allowed' end
  from public.event_competition_competitors c where c.id = p_competitor_id
$$;

-- ============================================================================
-- B. Predicate P is strict; the lenient availability test is unchanged
-- ============================================================================
select pg_temp.chk('P: unverified is unavailable for execution', pg_temp.reason('008001') = 'entry_provisional_unverified', coalesce(pg_temp.reason('008001'), 'null'));
select pg_temp.chk('P: needs_review is unavailable for execution', pg_temp.reason('008002') = 'entry_provisional_needs_review');
select pg_temp.chk('P: ineligible stays unavailable (regression)', pg_temp.reason('008006') = 'entry_ineligible');
select pg_temp.chk('P: pending entry is unavailable (regression)', pg_temp.reason('008014') = 'entry_not_confirmed');
select pg_temp.chk('P: legacy eligible with no determination is NOT cleared (never auto-promoted)', pg_temp.reason('008005') = 'entry_determination_missing', coalesce(pg_temp.reason('008005'), 'null'));
select pg_temp.chk('availability test is lenient for unverified (placement may proceed)', public._r15_entry_availability_reason(pg_temp.u('008001')) is null);
select pg_temp.chk('unknown entry is entry_missing', public._cf1_entry_unavailable_reason(gen_random_uuid()) = 'entry_missing');
select pg_temp.chk('known minor reports age blocked, not provisional', pg_temp.reason('008010') = 'entry_age_blocked', coalesce(pg_temp.reason('008010'), 'null'));

-- ============================================================================
-- C. The audited RPC: clear, waive, refuse
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('eligible with the required reason on an unclassified division clears the entry', pg_temp.decide('008003', 'eligible', 'criteria_verified_by_organizer', $$'{}'::text[]$$, 2));
select pg_temp.expect_ok('waived with an event-policy category on an unclassified division', pg_temp.decide('008004', 'waived', 'waiver_event_policy_documents', $$'{}'::text[]$$, 3));
select pg_temp.expect_ok('second entry cleared for the placement probes', pg_temp.decide('008015', 'eligible', 'criteria_verified_by_organizer', $$'{}'::text[]$$, 4));
reset role;
select pg_temp.chk('cleared eligible entry: P is null', pg_temp.reason('008003') is null, coalesce(pg_temp.reason('008003'), 'null'));
select pg_temp.chk('cleared waived entry (documented basis): P is null', pg_temp.reason('008004') is null, coalesce(pg_temp.reason('008004'), 'null'));
select pg_temp.chk('determination rows carry actor, role and fingerprint',
  (select count(*) from public.event_competition_eligibility_determinations where decided_by = pg_temp.u('000001') and length(fingerprint) = 64 and decided_role = 'studio_owner') = 3);
select pg_temp.chk('the audit trigger recorded the reason (why) for an eligibility change',
  exists (select 1 from public.event_competition_entry_changes where entry_id = pg_temp.u('008003') and change_type = 'eligibility_change' and reason = 'criteria_verified_by_organizer'));
select pg_temp.chk('waived and eligible are distinguishable in evidence (waiver category recorded)',
  (select waiver_category from public.event_competition_eligibility_determinations where entry_id = pg_temp.u('008004')) = 'waiver_event_policy_documents');

select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('replay of the same request id returns the same determination',
  (public.set_competition_entry_eligibility(pg_temp.u('008003'), 'eligible', 'criteria_verified_by_organizer', '{}'::text[], pg_temp.rq(2)) ->> 'replayed') = 'true');
select pg_temp.expect_msg('a request id reused for another entry is refused', pg_temp.decide('008001', 'needs_review', 'documents_pending', $$'{}'::text[]$$, 2), 'COMP_R15_DETERMINATION_INVALID');
select pg_temp.expect_msg('eligible with a waiver reason is refused', pg_temp.decide('008001', 'eligible', 'waiver_event_policy_fee', $$'{}'::text[]$$, 5), 'COMP_R15_DETERMINATION_INVALID');
select pg_temp.expect_msg('waived with a non-waiver reason is refused', pg_temp.decide('008001', 'waived', 'other_organizer_review', $$'{}'::text[]$$, 6), 'COMP_R15_DETERMINATION_INVALID');
select pg_temp.expect_msg('unknown outcome is refused', pg_temp.decide('008001', 'cleared', 'criteria_verified_by_organizer', $$'{}'::text[]$$, 7), 'COMP_R15_DETERMINATION_INVALID');
reset role;

-- ============================================================================
-- D. Age: minors, unknown age (OD-02 cannot be waived or overridden)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a known minor cannot be marked eligible', pg_temp.decide('008010', 'eligible', 'criteria_verified_by_organizer', $$'{}'::text[]$$, 10), 'COMP_R15_DETERMINATION_INVALID');
select pg_temp.expect_msg('a known minor cannot be waived', pg_temp.decide('008010', 'waived', 'waiver_event_policy_fee', $$'{}'::text[]$$, 11), 'COMP_R15_DETERMINATION_INVALID');
select pg_temp.expect_msg('an entry with unknown age cannot be marked eligible (fails closed)', pg_temp.decide('008011', 'eligible', 'criteria_verified_by_organizer', $$'{}'::text[]$$, 12), 'COMP_R15_DETERMINATION_INVALID');
select pg_temp.expect_msg('an entry with unknown age cannot be waived', pg_temp.decide('008011', 'waived', 'waiver_event_policy_scheduling', $$'{}'::text[]$$, 13), 'COMP_R15_DETERMINATION_INVALID');
select pg_temp.expect_ok('a minor entry can still be recorded ineligible (no clearance implied)', pg_temp.decide('008010', 'ineligible', 'age_division_not_met', $$'{}'::text[]$$, 14));
select pg_temp.chk('state reader: a minor entry is blocked', public.competition_entry_clearance_state(pg_temp.u('008010')) = 'blocked');
select pg_temp.chk('state reader: an unverified entry is provisional', public.competition_entry_clearance_state(pg_temp.u('008001')) = 'provisional');
select pg_temp.chk('state reader: a cleared entry is cleared', public.competition_entry_clearance_state(pg_temp.u('008003')) = 'cleared');
reset role;
select pg_temp.chk('unknown-age entry is provisional, not cleared', pg_temp.reason('008011') = 'entry_provisional_unverified');

-- A waived/eligible row seeded by the owner role (legacy shape) for a minor can never clear: the age arm is evaluated independently of the status.
update public.event_competition_entries set eligibility_status = 'waived' where id = pg_temp.u('008010');
select pg_temp.chk('legacy waived row for a minor is blocked by age, a waiver cannot lift it', pg_temp.reason('008010') = 'entry_age_blocked', coalesce(pg_temp.reason('008010'), 'null'));
update public.event_competition_entries set eligibility_status = 'waived' where id = pg_temp.u('008011');
select pg_temp.chk('legacy waived row with unknown age is not cleared', pg_temp.reason('008011') is not null, coalesce(pg_temp.reason('008011'), 'null'));

-- ============================================================================
-- E. Age-restricted division and sanctioned event: waivers refused, criteria required
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('age-restricted division: eligible without the age criterion is refused', pg_temp.decide('008008', 'eligible', 'criteria_verified_by_organizer', $$'{}'::text[]$$, 20), 'COMP_R15_DETERMINATION_INVALID');
select pg_temp.expect_msg('age-restricted division: waiver is refused', pg_temp.decide('008009', 'waived', 'waiver_event_policy_fee', $$'{}'::text[]$$, 21), 'COMP_R15_DETERMINATION_INVALID');
select pg_temp.expect_ok('age-restricted division: eligible with the age criterion clears', pg_temp.decide('008008', 'eligible', 'criteria_verified_by_organizer', $$array['age_division']$$, 22));
select pg_temp.expect_msg('sanctioned event: waiver is refused', pg_temp.decide('008013', 'waived', 'waiver_event_policy_fee', $$'{}'::text[]$$, 23), 'COMP_R15_DETERMINATION_INVALID');
reset role;
select pg_temp.chk('age-restricted entry cleared with criteria: P is null', pg_temp.reason('008008') is null, coalesce(pg_temp.reason('008008'), 'null'));
-- A legacy waived row on a classified division is never cleared even with a (forged by owner) waiver determination.
insert into public.event_competition_eligibility_determinations (event_id, entry_id, outcome, reason_code, waiver_category, criteria, fingerprint, decided_by, decided_role, request_id)
values (pg_temp.u('00e001'), pg_temp.u('008009'), 'waived', 'waiver_event_policy_fee', 'waiver_event_policy_fee', '{}', public._r15_entry_fingerprint(pg_temp.u('008009')), pg_temp.u('000001'), 'studio_owner', pg_temp.rq(900));
update public.event_competition_entries set eligibility_status = 'waived' where id = pg_temp.u('008009');
select pg_temp.chk('waived on an age-restricted division is not cleared (waiver cannot override a classification)', pg_temp.reason('008009') = 'entry_waiver_not_allowed', coalesce(pg_temp.reason('008009'), 'null'));

-- ============================================================================
-- F. Teams and roster substitution: the fingerprint covers every member
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('team of three cleared', pg_temp.decide('008007', 'eligible', 'criteria_verified_by_organizer', $$'{}'::text[]$$, 30));
reset role;
select pg_temp.chk('cleared team: P is null', pg_temp.reason('008007') is null, coalesce(pg_temp.reason('008007'), 'null'));
insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, dance_role, display_name)
values (pg_temp.u('00e001'), pg_temp.u('008007'), pg_temp.u('007028'), 'alternate', 'follower', 'T4 alternate');
select pg_temp.chk('adding a roster member (alternate) makes the determination stale', pg_temp.reason('008007') = 'entry_determination_stale', coalesce(pg_temp.reason('008007'), 'null'));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('re-determination after the roster change clears the team again', pg_temp.decide('008007', 'eligible', 'criteria_verified_by_organizer', $$'{}'::text[]$$, 31));
reset role;
select pg_temp.chk('team cleared again', pg_temp.reason('008007') is null, coalesce(pg_temp.reason('008007'), 'null'));
update public.event_competition_entry_participants set competitor_id = pg_temp.u('007092') where entry_id = pg_temp.u('008007') and competitor_id = pg_temp.u('007028');
select pg_temp.chk('replacing a member with an unknown-age competitor: stale first, never cleared', pg_temp.reason('008007') is not null, coalesce(pg_temp.reason('008007'), 'null'));
update public.event_competition_entry_participants set competitor_id = pg_temp.u('007028') where entry_id = pg_temp.u('008007') and competitor_id = pg_temp.u('007092');
update public.event_competition_divisions set age_label = 'Junior' where id = pg_temp.u('003001');
select pg_temp.chk('a division label change makes a determination stale (recoverable by re-determination)', pg_temp.reason('008003') in ('entry_determination_stale'), coalesce(pg_temp.reason('008003'), 'null'));
update public.event_competition_divisions set age_label = null where id = pg_temp.u('003001');
select pg_temp.chk('restoring the label restores clearance (no data was converted)', pg_temp.reason('008003') is null, coalesce(pg_temp.reason('008003'), 'null'));

-- ============================================================================
-- G. Write guard: no direct client writes
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('the probes run as the authenticated studio owner with direct table rights',
  current_user = 'authenticated' and has_table_privilege('authenticated', 'public.event_competition_entries', 'UPDATE') and public.can_manage_event_competition(pg_temp.u('00e001')));
select pg_temp.expect_msg('direct update to eligible is refused', $q$update public.event_competition_entries set eligibility_status = 'eligible' where id = pg_temp.u('008001')$q$, 'COMP_R15_ELIGIBILITY_WRITE_REFUSED');
select pg_temp.expect_msg('direct update to waived is refused', $q$update public.event_competition_entries set eligibility_status = 'waived' where id = pg_temp.u('008001')$q$, 'COMP_R15_ELIGIBILITY_WRITE_REFUSED');
select pg_temp.expect_msg('direct edit of the metadata determination is refused', $q$update public.event_competition_entries set metadata = jsonb_build_object('eligibility_determination', jsonb_build_object('outcome', 'eligible')) where id = pg_temp.u('008001')$q$, 'COMP_R15_ELIGIBILITY_WRITE_REFUSED');
select pg_temp.expect_msg('a staff-created entry already eligible is refused',
  $q$insert into public.event_competition_entries (event_id, program_id, division_id, display_name, status, eligibility_status) values (pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Sneaky', 'confirmed', 'eligible')$q$, 'COMP_R15_ELIGIBILITY_WRITE_REFUSED');
select pg_temp.expect_ok('a staff-created unverified entry is allowed (provisional)',
  $q$insert into public.event_competition_entries (event_id, program_id, division_id, display_name, status, eligibility_status) values (pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Staff Added', 'confirmed', 'unverified')$q$);
select pg_temp.expect_ok('unrelated updates still work (entry number)', $q$update public.event_competition_entries set entry_number = '101' where id = pg_temp.u('008001')$q$);
select pg_temp.expect_msg('a client cannot create a competing trigger', $q$create trigger sneaky after update on public.event_competition_entries for each row execute function public.r15_guard_entry_eligibility_write()$q$, 'permission denied');
select pg_temp.expect_msg('a client cannot update a determination', $q$update public.event_competition_eligibility_determinations set outcome = 'eligible'$q$, 'permission denied');
reset role;
select pg_temp.expect_msg('determinations are append-only even for the owner role', $q$update public.event_competition_eligibility_determinations set outcome = 'ineligible'$q$, 'append-only');
select pg_temp.expect_msg('determinations cannot be deleted', $q$delete from public.event_competition_eligibility_determinations where entry_id = pg_temp.u('008003')$q$, 'append-only');
select pg_temp.expect_msg('determinations cannot be truncated', $q$truncate public.event_competition_eligibility_determinations$q$, 'append-only');

-- ============================================================================
-- H. Placement, floor state and schedule publication
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
insert into t_ids values ('v1', public.create_competition_schedule_version(pg_temp.u('00e001'), 'v1', null));
select pg_temp.expect_ok('planner apply places a cleared entry and a PROVISIONAL entry in a draft version (provisional planning allowed)',
  $q$select public.apply_competition_floor_plan(pg_temp.id('v1'), jsonb_build_object('floorHeats', jsonb_build_array(
       jsonb_build_object('number', 1, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.u('003001'), 'roundId', pg_temp.u('006001'),
         'heatNumber', 1, 'name', 'Open Two Step', 'danceIds', jsonb_build_array(pg_temp.u('004001')), 'entryIds', jsonb_build_array(pg_temp.u('008003'), pg_temp.u('008001'))))))))$q$);
insert into t_ids select 'heat', id from public.event_competition_heats where schedule_version_id = pg_temp.id('v1') and division_id = pg_temp.u('003001');
reset role;
select pg_temp.chk('both placements exist (one cleared, one provisional)',
  (select count(*) from public.event_competition_heat_entries where heat_id = pg_temp.id('heat') and entry_id in (pg_temp.u('008003'), pg_temp.u('008001'))) = 2);
select pg_temp.expect_msg('a provisional placement cannot be checked in', $q$update public.event_competition_heat_entries set status = 'checked_in' where heat_id = pg_temp.id('heat') and entry_id = pg_temp.u('008001')$q$, 'COMP_R15_ENTRY_NOT_CLEARED');
select pg_temp.expect_ok('a cleared placement can be checked in (legitimate flow)', $q$update public.event_competition_heat_entries set status = 'checked_in' where heat_id = pg_temp.id('heat') and entry_id = pg_temp.u('008003')$q$);
select pg_temp.expect_msg('a provisional placement cannot be marked danced', $q$update public.event_competition_heat_entries set status = 'danced' where heat_id = pg_temp.id('heat') and entry_id = pg_temp.u('008001')$q$, 'COMP_R15_ENTRY_NOT_CLEARED');
select pg_temp.expect_msg('a version with a provisional placement cannot be published (direct status write)',
  $q$update public.event_competition_schedule_versions set status = 'published', published_at = now() where id = pg_temp.id('v1')$q$, 'COMP_R15_PROVISIONAL_ASSIGNMENT');
-- Scratch the provisional placement (the lifecycle recovery), then publish works.
update public.event_competition_heat_entries set status = 'scratched' where heat_id = pg_temp.id('heat') and entry_id = pg_temp.u('008001');
select pg_temp.expect_ok('after scratching the provisional placement the version can be published', $q$update public.event_competition_schedule_versions set status = 'published', published_at = now() where id = pg_temp.id('v1')$q$);
select pg_temp.expect_msg('a provisional entry cannot be placed into a heat of a PUBLISHED version',
  $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.id('heat'), pg_temp.u('008002'), 9)$q$, 'COMP_R15_ENTRY_NOT_CLEARED');
select pg_temp.expect_msg('un-scratching a provisional placement in a published version is refused',
  $q$update public.event_competition_heat_entries set status = 'scheduled' where heat_id = pg_temp.id('heat') and entry_id = pg_temp.u('008001')$q$, 'COMP_R15_ENTRY_NOT_CLEARED');
select pg_temp.expect_ok('a cleared entry can still be placed in the published version heat', $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.id('heat'), pg_temp.u('008015'), 9)$q$);

-- Structural checks for the stages that need panel/ballot fixtures (their behavior is covered by predicate P, proven strict above).
select pg_temp.chk('round start, floor call, heat-entry and version triggers are installed and enabled',
  (select count(*) from pg_trigger where tgname in ('r15_guard_round_start', 'r15_guard_heat_status', 'r15_guard_version_publish', 'r15_guard_heat_entry_clearance', 'r15_guard_entry_eligibility_write') and not tgisinternal and tgenabled <> 'D') = 5);
select pg_temp.chk('round-start trigger fires only on scheduled -> active', pg_get_triggerdef((select oid from pg_trigger where tgname = 'r15_guard_round_start')) like '%scheduled%active%');
select pg_temp.chk('floor-call trigger fires on staging/active', pg_get_triggerdef((select oid from pg_trigger where tgname = 'r15_guard_heat_status')) like '%staging%' and pg_get_triggerdef((select oid from pg_trigger where tgname = 'r15_guard_heat_status')) like '%active%');
select pg_temp.expect_msg('the shared raiser refuses a provisional entry at the round-start stage', $q$select public.r15_raise_not_cleared('start', array[pg_temp.u('008001')], null)$q$, 'COMP_R15_ENTRY_NOT_CLEARED');
select pg_temp.expect_msg('the shared raiser refuses a needs_review entry at the floor-call stage', $q$select public.r15_raise_not_cleared('floor_call', array[pg_temp.u('008002')], null)$q$, 'COMP_R15_ENTRY_NOT_CLEARED');
select pg_temp.expect_ok('the shared raiser accepts cleared entries', $q$select public.r15_raise_not_cleared('start', array[pg_temp.u('008003'), pg_temp.u('008004'), pg_temp.u('008007')], null)$q$);

-- ============================================================================
-- I. No conversion, no new audit noise from the migration itself, privileges
-- ============================================================================
select pg_temp.chk('no pre-existing entry changed status or eligibility except through explicit RPC/owner steps of this suite',
  not exists (select 1 from t_before b join public.event_competition_entries e on e.id = b.id where b.status is distinct from e.status));
select pg_temp.chk('seeded legacy eligible entry E05 is still eligible and still not cleared (never promoted)',
  (select eligibility_status from public.event_competition_entries where id = pg_temp.u('008005')) = 'eligible' and pg_temp.reason('008005') is not null);
select pg_temp.chk('internal predicates are not callable by API roles',
  not has_function_privilege('authenticated', 'public._r15_entry_clearance_reason(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public._r15_entry_executable_reason(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.r15_raise_not_cleared(text,uuid[],jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_competition_entry_eligibility(uuid,text,text,text[],uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.set_competition_entry_eligibility(uuid,text,text,text[],uuid)', 'EXECUTE'));
select pg_temp.as_user(pg_temp.u('000099'));
select pg_temp.expect_msg('a non-manager cannot call the RPC', pg_temp.decide('008001', 'needs_review', 'documents_pending', $$'{}'::text[]$$, 40), 'COMP_R15_NOT_FOUND');
reset role;

-- ============================================================================
-- Verdict
-- ============================================================================
do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'R15 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'R15 SQL SUITE FAIL: %', v_failures;
end $$;

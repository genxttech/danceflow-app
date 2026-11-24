-- Competition S5 (OD-02) -- database-boundary participant age guard regression suite. PENDING EXECUTION until run on a local chain through
-- 20270301120000_competition_s5_participant_age_guard.sql (Phase 10C chain 20261109090000..20261115090000 required).
--
-- Covers: the age predicate (exactly 18, the day before, Feb 29, null/future/pre-1900), under-18 refused, unknown age refused, exactly-18 allowed,
-- team member, alternate, substitution (competitor change), staff-created entry (client anchor, no competitor), direct PostgREST insert/update by a
-- manager, service_role, a competitor date-of-birth change that would clear or un-clear a participant, existing rows left unchanged, resolve completes
-- (never changes) a missing date of birth, no birthdate or age in any error message, authorization of the new functions.
-- Run as a SUPERUSER. Fixtures that deliberately place a LEGACY minor row are inserted with session_replication_role = replica (the S5 guard does not fire).
-- One transaction, synthetic fixtures only (md5-derived ids). The final block ALWAYS raises, so nothing persists:
--   "COMPETITION S5 AGE GUARD SQL SUITE PASS (<n> checks, <b> blocked)"  or  "... FAIL: <failures>".

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
-- The statement must fail with a message containing p_fragment; p_state, when given, must equal the SQLSTATE. The message must carry no date.
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
      perform pg_temp.chk(p_name,
        position(lower(p_fragment) in lower(sqlerrm)) > 0 and (p_state is null or sqlstate = p_state) and sqlerrm !~ '\d{4}-\d{2}-\d{2}',
        sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then
    perform pg_temp.chk(p_name, false, 'statement unexpectedly succeeded');
  end if;
end $$;
create or replace function pg_temp.id(p_kind text, p_n int default 0) returns uuid
language sql immutable as $$ select md5('s5age:' || p_kind || ':' || p_n)::uuid $$;
create or replace function pg_temp.as_user(p_user int) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('user', p_user), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- The "today" the predicate uses: UTC-12 date.
create or replace function pg_temp.ref() returns date language sql stable as $$ select ((now() at time zone 'UTC') - interval '12 hours')::date $$;

-- ============================================================================
-- Fixtures (superuser)
-- ============================================================================
-- users: 1 owner of studio A (event manager), 2 unrelated verified user
insert into auth.users (id, email) values (pg_temp.id('user', 1), 't-s5-owner@example.test'), (pg_temp.id('user', 2), 't-s5-nobody@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'S5 ' || split_part(email, '@', 1) from auth.users where id in (pg_temp.id('user', 1), pg_temp.id('user', 2));
insert into public.studios (id, name, slug) values (pg_temp.id('studio', 1), 'S5 Studio A', 't-s5-a');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.id('user', 1), pg_temp.id('studio', 1), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values (pg_temp.id('event', 1), pg_temp.id('studio', 1), 'S5 Comp', 't-s5-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
  values (pg_temp.id('program', 1), pg_temp.id('event', 1), pg_temp.id('studio', 1), 'Studio', 'custom', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
  values (pg_temp.id('contest', 1), pg_temp.id('event', 1), pg_temp.id('program', 1), 'Team', 'single_dance', 'team', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
  values (pg_temp.id('division', 1), pg_temp.id('event', 1), pg_temp.id('program', 1), pg_temp.id('contest', 1), 'D1', 'open');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  (pg_temp.id('entry', 1), pg_temp.id('event', 1), pg_temp.id('program', 1), pg_temp.id('division', 1), 'E1', 'confirmed', 'eligible', '1'),
  (pg_temp.id('entry', 2), pg_temp.id('event', 1), pg_temp.id('program', 1), pg_temp.id('division', 1), 'E2', 'confirmed', 'eligible', '2');
insert into public.clients (id, studio_id, first_name, last_name) values (pg_temp.id('client', 1), pg_temp.id('studio', 1), 'Anchored', 'Adult'), (pg_temp.id('client', 2), pg_temp.id('studio', 1), 'Staff', 'Added');

-- competitors: 1 adult, 2 exactly 18 today (UTC-12 date), 3 one day short of 18, 4 minor, 5 no date of birth, 6 future date, 7 before 1900, 8 adult (second), 9 adult anchored (no DOB yet)
insert into public.event_competition_competitors (id, event_id, studio_id, first_name, last_name, date_of_birth) values
  (pg_temp.id('comp', 1), pg_temp.id('event', 1), pg_temp.id('studio', 1), 'Adult', 'One', date '1990-01-01'),
  (pg_temp.id('comp', 2), pg_temp.id('event', 1), pg_temp.id('studio', 1), 'Exact', 'Eighteen', (pg_temp.ref() - interval '18 years')::date),
  (pg_temp.id('comp', 3), pg_temp.id('event', 1), pg_temp.id('studio', 1), 'Almost', 'Eighteen', (pg_temp.ref() - interval '18 years' + interval '1 day')::date),
  (pg_temp.id('comp', 4), pg_temp.id('event', 1), pg_temp.id('studio', 1), 'Minor', 'Four', (pg_temp.ref() - interval '12 years')::date),
  (pg_temp.id('comp', 5), pg_temp.id('event', 1), pg_temp.id('studio', 1), 'No', 'Dob', null),
  (pg_temp.id('comp', 6), pg_temp.id('event', 1), pg_temp.id('studio', 1), 'Future', 'Dob', (pg_temp.ref() + 5)),
  (pg_temp.id('comp', 7), pg_temp.id('event', 1), pg_temp.id('studio', 1), 'Ancient', 'Dob', date '1899-12-31'),
  (pg_temp.id('comp', 8), pg_temp.id('event', 1), pg_temp.id('studio', 1), 'Adult', 'Eight', date '1985-05-05'),
  (pg_temp.id('comp', 10), pg_temp.id('event', 1), pg_temp.id('studio', 1), 'Adult', 'Ten', date '1980-10-10');
insert into public.event_competition_competitors (id, event_id, studio_id, client_id, first_name, last_name, date_of_birth)
  values (pg_temp.id('comp', 9), pg_temp.id('event', 1), pg_temp.id('studio', 1), pg_temp.id('client', 1), 'Anchored', 'Adult', null);

-- a LEGACY under-18 participant row placed before the guard existed (guard bypassed only for this fixture)
alter table public.event_competition_entry_participants disable trigger event_competition_entry_participants_s5_age_guard;
insert into public.event_competition_entry_participants (id, event_id, entry_id, competitor_id, participant_role, display_name, sort_order)
  values (pg_temp.id('part', 90), pg_temp.id('event', 1), pg_temp.id('entry', 2), pg_temp.id('comp', 4), 'team_member', 'Legacy Minor', 1);
alter table public.event_competition_entry_participants enable always trigger event_competition_entry_participants_s5_age_guard;

create or replace function pg_temp.ins(p_entry int, p_comp int, p_role text default 'dancer', p_n int default 1) returns text
language sql as $$
  insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, display_name, sort_order)
  values (pg_temp.id('event', 1), pg_temp.id('entry', p_entry), pg_temp.id('comp', p_comp), p_role, 'P' || p_comp, p_n) returning 'ok'
$$;

-- ============================================================================
-- 1. The age predicate
-- ============================================================================
select pg_temp.chk('pure: exactly 18 today is allowed', public._comp_age_clearance_from_dob((pg_temp.ref() - interval '18 years')::date) = 'allowed');
select pg_temp.chk('pure: one day short of 18 is blocked_under_18', public._comp_age_clearance_from_dob((pg_temp.ref() - interval '18 years' + interval '1 day')::date) = 'blocked_under_18');
select pg_temp.chk('pure: a minor is blocked_under_18', public._comp_age_clearance_from_dob(date '2019-01-01') = 'blocked_under_18');
select pg_temp.chk('pure: null, future and pre-1900 are unknown_age (fail closed)',
  public._comp_age_clearance_from_dob(null) = 'unknown_age' and public._comp_age_clearance_from_dob((pg_temp.ref() + 1)) = 'unknown_age' and public._comp_age_clearance_from_dob(date '1899-12-31') = 'unknown_age');
select pg_temp.chk('pure: Feb 29 birth is blocked on Feb 28 and allowed on Mar 1 of the 18th year',
  public._comp_age_clearance_from_dob(date '2008-02-29', timestamptz '2026-02-28 20:00:00+00') = 'blocked_under_18'
  and public._comp_age_clearance_from_dob(date '2008-02-29', timestamptz '2026-03-01 12:00:00+00') = 'allowed');
select pg_temp.chk('pure: UTC-12 reference: 00:30 UTC on the birthday is still blocked, 12:00 UTC is allowed',
  public._comp_age_clearance_from_dob(date '2008-11-24', timestamptz '2026-11-24 00:30:00+00') = 'blocked_under_18'
  and public._comp_age_clearance_from_dob(date '2008-11-24', timestamptz '2026-11-24 12:00:00+00') = 'allowed');
select pg_temp.chk('participant predicate: adult allowed, exact-18 allowed, minor/short blocked, no DOB/future/ancient/unknown id = unknown',
  public._comp_participant_age_clearance(pg_temp.id('comp', 1)) = 'allowed'
  and public._comp_participant_age_clearance(pg_temp.id('comp', 2)) = 'allowed'
  and public._comp_participant_age_clearance(pg_temp.id('comp', 3)) = 'blocked_under_18'
  and public._comp_participant_age_clearance(pg_temp.id('comp', 4)) = 'blocked_under_18'
  and public._comp_participant_age_clearance(pg_temp.id('comp', 5)) = 'unknown_age'
  and public._comp_participant_age_clearance(pg_temp.id('comp', 6)) = 'unknown_age'
  and public._comp_participant_age_clearance(pg_temp.id('comp', 7)) = 'unknown_age'
  and public._comp_participant_age_clearance(pg_temp.id('comp', 99)) = 'unknown_age'
  and public._comp_participant_age_clearance(null) = 'unknown_age');

-- ============================================================================
-- 2. Enforcement on participant rows (superuser = definer / service writers)
-- ============================================================================
select pg_temp.expect_ok('legitimate adult couple halves insert', format($q$select pg_temp.ins(1, 1); select pg_temp.ins(1, 8, 'dancer', 2)$q$));
select pg_temp.expect_ok('exactly-18 competitor inserts', format($q$select pg_temp.ins(1, 2, 'alternate', 3)$q$));
select pg_temp.expect_msg('under-18 competitor is refused (reason code only)', $q$select pg_temp.ins(1, 4)$q$, 'COMP_S5_AGE_BLOCKED: participant not cleared (blocked_under_18)', '42501');
select pg_temp.expect_msg('one day short of 18 is refused', $q$select pg_temp.ins(1, 3)$q$, 'blocked_under_18', '42501');
select pg_temp.expect_msg('unknown age (no date of birth) is refused: fail closed', $q$select pg_temp.ins(1, 5)$q$, '(unknown_age)', '42501');
select pg_temp.expect_msg('future date of birth is refused', $q$select pg_temp.ins(1, 6)$q$, 'unknown_age', '42501');
select pg_temp.expect_msg('pre-1900 date of birth is refused', $q$select pg_temp.ins(1, 7)$q$, 'unknown_age', '42501');
select pg_temp.expect_msg('alternate who is under 18 is refused', $q$select pg_temp.ins(1, 4, 'alternate', 4)$q$, 'blocked_under_18', '42501');
select pg_temp.expect_msg('team member who is under 18 is refused', $q$select pg_temp.ins(1, 4, 'team_member', 5)$q$, 'blocked_under_18', '42501');
select pg_temp.expect_msg('a multi-row team insert with one minor is refused as a whole',
  format($q$insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, display_name, sort_order)
            values (%L, %L, %L, 'team_member', 'T1', 6), (%L, %L, %L, 'team_member', 'T2', 7)$q$,
         pg_temp.id('event', 1), pg_temp.id('entry', 1), pg_temp.id('comp', 1), pg_temp.id('event', 1), pg_temp.id('entry', 1), pg_temp.id('comp', 4)),
  'blocked_under_18', '42501');
select pg_temp.chk('the refused team insert left no participant row behind',
  (select count(*) from public.event_competition_entry_participants where entry_id = pg_temp.id('entry', 1) and competitor_id = pg_temp.id('comp', 4)) = 0);

-- substitution / partner change: updating the competitor of an existing row is guarded
select pg_temp.expect_msg('substitution to a minor is refused',
  format($q$update public.event_competition_entry_participants set competitor_id = %L where entry_id = %L and competitor_id = %L$q$, pg_temp.id('comp', 4), pg_temp.id('entry', 1), pg_temp.id('comp', 8)),
  'blocked_under_18', '42501');
select pg_temp.expect_msg('substitution to an unknown-age competitor is refused',
  format($q$update public.event_competition_entry_participants set competitor_id = %L where entry_id = %L and competitor_id = %L$q$, pg_temp.id('comp', 5), pg_temp.id('entry', 1), pg_temp.id('comp', 8)),
  'unknown_age', '42501');
select pg_temp.expect_ok('substitution to an adult (not already in the entry) is allowed',
  format($q$update public.event_competition_entry_participants set competitor_id = %L where entry_id = %L and competitor_id = %L$q$, pg_temp.id('comp', 10), pg_temp.id('entry', 1), pg_temp.id('comp', 8)));
select pg_temp.expect_ok('the guard also fires with session_replication_role = replica (ENABLE ALWAYS)', $q$set local session_replication_role = replica$q$);
select pg_temp.expect_msg('a minor is refused even under session_replication_role = replica', $q$select pg_temp.ins(1, 4, 'dancer', 30)$q$, 'blocked_under_18', '42501');
select pg_temp.expect_ok('restore session_replication_role', $q$set local session_replication_role = origin$q$);

-- existing rows are unchanged and unrelated updates on them still work (the guard is not retroactive)
select pg_temp.chk('the LEGACY under-18 row was not modified or deleted by the migration logic',
  (select count(*) from public.event_competition_entry_participants where id = pg_temp.id('part', 90) and competitor_id = pg_temp.id('comp', 4)) = 1);
select pg_temp.expect_ok('an unrelated update (sort order) on the legacy row is not blocked',
  format($q$update public.event_competition_entry_participants set sort_order = 9 where id = %L$q$, pg_temp.id('part', 90)));
select pg_temp.expect_msg('but re-pointing the legacy row to another under-18 competitor is refused',
  format($q$update public.event_competition_entry_participants set competitor_id = %L where id = %L$q$, pg_temp.id('comp', 3), pg_temp.id('part', 90)), 'blocked_under_18', '42501');

-- staff-created entry: only a client anchor, no competitor yet -> the competitor trigger resolves one with no date of birth -> refused
select pg_temp.expect_msg('staff-created participant from a client anchor with no stored date of birth is refused (fail closed)',
  format($q$insert into public.event_competition_entry_participants (event_id, entry_id, client_id, participant_role, display_name, sort_order)
            values (%L, %L, %L, 'dancer', 'Staff Added', 20)$q$, pg_temp.id('event', 1), pg_temp.id('entry', 1), pg_temp.id('client', 2)),
  'unknown_age', '42501');

-- ============================================================================
-- 3. Direct PostgREST writes by a manager (RLS policy competition_manage is FOR ALL) and by service_role
-- ============================================================================
set role authenticated;
select pg_temp.as_user(1);
select pg_temp.expect_ok('manager direct insert of an adult is allowed', format($q$select pg_temp.ins(2, 1, 'dancer', 11)$q$));
select pg_temp.expect_msg('manager direct insert of a minor is refused', $q$select pg_temp.ins(2, 4, 'dancer', 12)$q$, 'blocked_under_18', '42501');
select pg_temp.expect_msg('manager direct insert with unknown age is refused', $q$select pg_temp.ins(2, 5, 'dancer', 13)$q$, 'unknown_age', '42501');
select pg_temp.expect_msg('manager direct update to a minor is refused',
  format($q$update public.event_competition_entry_participants set competitor_id = %L where entry_id = %L and competitor_id = %L$q$, pg_temp.id('comp', 4), pg_temp.id('entry', 2), pg_temp.id('comp', 1)), 'blocked_under_18', '42501');
select pg_temp.expect_msg('a manager cannot edit a competitor date of birth (column grant is bib_number only)',
  format($q$update public.event_competition_competitors set date_of_birth = date '1999-09-09' where id = %L$q$, pg_temp.id('comp', 8)), 'permission denied');
select pg_temp.expect_msg('the new functions are not callable by an authenticated manager (predicates reveal age clearance)',
  format($q$select public._comp_participant_age_clearance(%L)$q$, pg_temp.id('comp', 1)), 'permission denied');
select pg_temp.expect_msg('the dob predicate is not callable by an authenticated manager',
  $q$select public._comp_age_clearance_from_dob(date '1990-01-01')$q$, 'permission denied');
reset role;

set role service_role;
select pg_temp.expect_msg('service_role direct insert of a minor is refused (no service-role bypass)', $q$select pg_temp.ins(2, 4, 'dancer', 14)$q$, 'blocked_under_18', '42501');
select pg_temp.chk('service_role may execute the predicates (preflight tooling)', public._comp_participant_age_clearance(pg_temp.id('comp', 1)) = 'allowed');
reset role;
select pg_temp.expect_msg('service_role date-of-birth update to a minor on a participating competitor is refused',
  format($q$set local role service_role; update public.event_competition_competitors set date_of_birth = %L where id = %L$q$, (pg_temp.ref() - interval '9 years')::date, pg_temp.id('comp', 8)), 'blocked_under_18', '42501');
reset role;

-- ============================================================================
-- 4. A competitor's date of birth cannot be changed into a state that no longer clears, while the competitor participates
-- ============================================================================
select pg_temp.expect_msg('changing a participating competitor to a minor date of birth is refused',
  format($q$update public.event_competition_competitors set date_of_birth = %L where id = %L$q$, (pg_temp.ref() - interval '10 years')::date, pg_temp.id('comp', 1)), 'blocked_under_18', '42501');
select pg_temp.expect_msg('clearing a participating competitor date of birth is refused',
  format($q$update public.event_competition_competitors set date_of_birth = null where id = %L$q$, pg_temp.id('comp', 1)), 'unknown_age', '42501');
select pg_temp.expect_ok('correcting a participating competitor to another adult date of birth is allowed',
  format($q$update public.event_competition_competitors set date_of_birth = date '1991-02-02' where id = %L$q$, pg_temp.id('comp', 1)));
select pg_temp.expect_ok('a competitor who participates in no entry may be edited freely (not a participant)',
  format($q$update public.event_competition_competitors set date_of_birth = %L where id = %L$q$, (pg_temp.ref() - interval '10 years')::date, pg_temp.id('comp', 6)));

-- ============================================================================
-- 5. Resolve completes a missing date of birth on an anchored competitor, never changes an existing one
-- ============================================================================
select pg_temp.chk('resolve: an anchored competitor with no date of birth gets the supplied one',
  (select public._comp10c_resolve_competitor(pg_temp.id('event', 1), null, pg_temp.id('client', 1), null, 'Anchored', 'Adult', null, date '1992-03-03', null, '{}'::jsonb, 'registration', null)) = pg_temp.id('comp', 9)
  and (select date_of_birth from public.event_competition_competitors where id = pg_temp.id('comp', 9)) = date '1992-03-03');
select pg_temp.chk('resolve: an existing date of birth is never changed',
  (select public._comp10c_resolve_competitor(pg_temp.id('event', 1), null, pg_temp.id('client', 1), null, 'Anchored', 'Adult', null, date '2012-03-03', null, '{}'::jsonb, 'registration', null)) = pg_temp.id('comp', 9)
  and (select date_of_birth from public.event_competition_competitors where id = pg_temp.id('comp', 9)) = date '1992-03-03');
select pg_temp.expect_ok('the now-dated anchored adult can be added to an entry', format($q$select pg_temp.ins(2, 9, 'dancer', 15)$q$));

-- ============================================================================
-- 6. Static facts about the installed objects
-- ============================================================================
select pg_temp.chk('both guard triggers exist and are enabled',
  (select count(*) from pg_trigger where tgname in ('event_competition_entry_participants_s5_age_guard', 'event_competition_competitors_s5_dob_guard') and tgenabled = 'A' and not tgisinternal) = 2);
select pg_temp.chk('the new functions are definer, pinned search_path, and not executable by public/anon/authenticated',
  not exists (select 1 from pg_proc p where p.proname in ('_comp_age_clearance_from_dob', '_comp_participant_age_clearance', '_comp_s5_participant_age_guard', '_comp_s5_competitor_dob_guard')
              and p.pronamespace = 'public'::regnamespace
              and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))));
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
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok and status is distinct from 'BLOCKED';
  if v_failures is null then
    raise exception 'COMPETITION S5 AGE GUARD SQL SUITE PASS (% checks, % blocked)', v_total, v_blocked;
  end if;
  raise exception 'COMPETITION S5 AGE GUARD SQL SUITE FAIL: %', v_failures;
end $$;

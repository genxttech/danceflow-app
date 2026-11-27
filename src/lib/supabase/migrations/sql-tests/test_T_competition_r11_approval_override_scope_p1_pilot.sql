-- Competition R-11 -- LABELLED P1 PILOT COPY of test_T_competition_r11_approval_override_scope.sql (source commit d5c3bed52).
-- ============================================================================================================================================
-- THIS IS NOT THE ORIGINAL SUITE. A PASS HERE IS NEVER A PASS OF THE ORIGINAL. The original is unchanged and remains the R-11 evidence.
-- ============================================================================================================================================
-- For a chain that has 20270301180000 (pilot restrictions) installed; it refuses to run otherwise. LOCAL QA DATABASE ONLY, superuser, one
-- transaction, always raises: "COMPETITION R11 P1 PILOT COPY SQL SUITE PASS (<n> checks; ...)" or "... FAIL: <failures>".
-- Fixture change: each heat is marked complete BEFORE its ballots (the pilot accepts ballots only for a started heat).
-- Assertion names: original 111, here 93; kept by name 70; dropped 41; added 23.
-- Kept by name but pointed at a different row (4):
--   * audit: an approvals row cannot be updated (now r2's approval)
--   * audit: an approvals row cannot be deleted (now r2's approval)
--   * audit: a result event cannot be updated (the override reason is immutable) (now r2's result_approved event: no override event can exist)
--   * audit: a result event cannot be deleted (now r2's result_approved event)
-- DROPPED original assertions, each with the reason (read from the restriction triggers; the added assertions test the pilot's refusal where there
-- is one). Reasons marked NOT SHOWN UNREACHABLE are coverage gaps of this copy, not claims about the pilot:
--   * r1: A1 self-approves the INITIAL result with a substantive reason (20-500 characters, 4+ words)  [the calculator cannot approve in the pilot (COMP_P1_SECOND_APPROVER_REQUIRED)]
--   * r1: replay of the same request is idempotent  [the calculator cannot approve in the pilot (COMP_P1_SECOND_APPROVER_REQUIRED)]
--   * r1: the round is approved; the version is approved  [the calculator cannot approve in the pilot (COMP_P1_SECOND_APPROVER_REQUIRED)]
--   * r1: distinct audit kind result_approval_override (not result_approved) with actor, version, reason, calculator and refs.initial = true  [the calculator cannot approve in the pilot (COMP_P1_SECOND_APPROVER_REQUIRED)]
--   * r1: the approvals row carries the reason; approver = calculator  [the calculator cannot approve in the pilot (COMP_P1_SECOND_APPROVER_REQUIRED)]
--   * r3: boundary: exactly 20 characters and four words is accepted  [the calculator cannot approve in the pilot]
--   * r3: that approval is the audited override with the exact reason  [the calculator cannot approve in the pilot]
--   * r4: version 2 is calculated after a correction by A1 (calculator = opener), version 1 was approved by A2 and is now stale/superseded  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * RB-11.2: the calculator/opener cannot self-approve the corrected version with NO reason  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * RB-11.2: ...nor with a SUBSTANTIVE override reason  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * RB-11.2: ...the refusal text names the independent approver rule  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * r4: refusals left the corrected version calculated, no second approval row, no override event for the round  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * r4: independent manager A2 approves the corrected version  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * r4: replay of the independent approval is idempotent  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * r4: audit = result_approved, reason null, refs.initial = false, override false; approvals row without a reason  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * RB-11.2: the person who opened the correction (not the calculator) cannot approve it  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * RB-11.2: ...not even with a substantive reason  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * RB-11.2: the calculator of the corrected version cannot approve it with a substantive reason  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * r5: refusals changed nothing  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * r5: an independent third manager A3 approves  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * r5: approved by A3 as a normal approval with refs.initial = false  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * r6: no approval has ever existed for r6, yet a correction cause exists  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * RB-11.2: self-approval of the recalculated version after a correction opened from `calculated` is refused  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * r6: A2 approves  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * no-override (stale input hash): self-approval with a SUBSTANTIVE reason is refused COMP_RESULT_STALE  [NOT SHOWN UNREACHABLE (coverage gap): the original makes the input stale by scratching a couple, which is refused on a started heat; other routes to a stale input were not examined]
--   * no-override (stale input hash): and with no reason  [NOT SHOWN UNREACHABLE (coverage gap): the original makes the input stale by scratching a couple, which is refused on a started heat; other routes to a stale input were not examined]
--   * r7: nothing approved, no override event  [NOT SHOWN UNREACHABLE (coverage gap): the original makes the input stale by scratching a couple, which is refused on a started heat; other routes to a stale input were not examined]
--   * no-override (non-latest version): the superseded version 1 with a substantive reason is COMP_RESULT_STALE  [NOT SHOWN UNREACHABLE (coverage gap): the original creates the second version by a correction, which is off; other routes to a second version were not examined]
--   * no-override (roster): an ineligible couple refuses a self-approval with a substantive reason (COMP_ROSTER_ENTRY_UNAVAILABLE)  [replaced: the self-approval may be refused by either rule; the roster check is asserted through a second manager]
--   * audit: a correction cause cannot be updated (the immutable correction history the new rule reads)  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * audit: a correction cause cannot be deleted  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * audit: the override kind is distinct: override events exist only for self-approvals and every one has a reason, actor = calculator and refs.initial = true  [no override approval can exist]
--   * audit: every approval of a corrected version (version > 1 of a round with a correction cause) is by someone who is neither its calculator nor a correction opener  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * r12: now a callback Final with exactly one eligible couple, input hash unchanged  [callbacks are off: a callback Final cannot exist (COMP_P1_FINAL_ONLY)]
--   * no-override (minimum two couples): a self-approval with a substantive reason cannot bypass COMP_ROSTER_BELOW_MINIMUM  [callbacks are off: a callback Final cannot exist (COMP_P1_FINAL_ONLY)]
--   * no-override (minimum two couples): nor can an independent second manager approve  [callbacks are off: a callback Final cannot exist (COMP_P1_FINAL_ONLY)]
--   * r12: both refusals rolled back (version calculated, no approval, no override event)  [callbacks are off: a callback Final cannot exist (COMP_P1_FINAL_ONLY)]
--   * r14: only the cause row exists  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * single source (cause): the calculator cannot self-approve with a substantive reason  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * single source (cause): the opener named only by the cause row cannot approve  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
--   * single source (cause): an independent third manager approves  [corrections are off in the pilot (COMP_P1_CORRECTIONS_OFF): the corrected state cannot be created]
-- ============================================================================================================================================
--
-- The original header follows.
--
-- Competition R-11 correction -- approval override scope and reason standard regression suite.
--
-- Covers 20270301090000_competition_r11_approval_override_scope.sql (RB-11.1 substantive override reason, RB-11.2 no self-approval of a corrected
-- result) on top of the composed competition chain through PV-1 / OJ-1. NOT RUN IN CI. Run as a SUPERUSER on a LOCAL QA DATABASE ONLY, e.g.
-- through scripts/qa/r11/run-r11.sh. One transaction, synthetic fixtures only (UUID block ...-b11ff4XXXXXX). The final block ALWAYS raises, so
-- nothing persists:   "COMPETITION R11 SQL SUITE PASS (<n> checks)"  or  "COMPETITION R11 SQL SUITE FAIL: <failures>".
--
-- Composed chains: when S4 / R-15 is installed the fixtures clear every entry through set_competition_entry_eligibility (needs the S5 age predicate);
-- without S4 that step is skipped. The suite never stubs, disables or writes around an eligibility gate.
--
-- Run BEFORE the migration (characterization), the suite must FAIL exactly on the RB-11.1 / RB-11.2 / structural checks (prefix "RB-11.1", "RB-11.2",
-- "S:") and pass everything else; run AFTER it, every check must pass. The PR 859 static `it.fails` markers read only the F2 migration file, so they do
-- not flip by themselves; their flip condition is a re-point to this migration's text (see R-11-CORRECTION-MIGRATION.md).
--
-- Rounds (one heat of three entries each, panel J1 A / J2 B / J3 C), managers A1 (u01), A2 (u02), A3 (u03), all studio owners of event A:
--   r1  initial self-approval with a substantive reason (audit record)       r2  initial two-manager approval (reason supplied is discarded)
--   r3  insufficient override reasons                                         r4  corrected: calculator = correction opener (A1), A2 independent
--   r5  corrected: opener (A2) is not the calculator (A1), A3 independent     r6  correction opened from `calculated` (never approved)
--   r7  stale input hash with an override reason                              r8  superseded (non-latest) version with an override reason
--   r9  ineligible couple with an override reason                             r10 exclusion co-sign separation (request/co-sign by the same person)
--   r11 unauthorized callers of approve                                       r12 minimum-two callback Final with one couple (real helpers; own program)
--   r13 corrected shown by an earlier APPROVAL only                           r14 corrected shown by an A7 CAUSE row only
--   r15 corrected shown by an F2 correction EVENT only                        r16 stored rows that differ from the database's calculation (real PV-1)
-- No engine, gate or predicate is stubbed: results are the database engine's own rows (_comppv1_run) and PV-1 verifies them for real. The only
-- shortcuts are superuser fixture writes (session_replication_role = replica) to build states the lifecycle does not offer, each named at its use.

begin;
do $tx$
begin
  if now() = statement_timestamp() then
    raise exception 'R11 suite refused: run it inside one explicit transaction (no per-statement autocommit), on a local QA database only';
  end if;
end $tx$;

-- PILOT COPY precondition: only meaningful beside 20270301180000; elsewhere run the original suite.
do $pc$
begin
  if not exists (select 1 from pg_trigger where tgname = 'zz_compp1_approval' and tgrelid = 'public.event_competition_result_approvals'::regclass)
     or not exists (select 1 from pg_trigger where tgname = 'zz_compp1_ballots' and tgrelid = 'public.event_competition_ballots'::regclass) then
    raise exception 'R11 P1 pilot copy refused: the pilot restrictions are not installed; run the original suite.';
  end if;
end $pc$;

create or replace function pg_temp.hl1_danced(p_heat uuid) returns void language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_heats set status = 'complete' where id = p_heat;
  perform set_config('session_replication_role', 'origin', true);
end $$;
grant execute on function pg_temp.hl1_danced(uuid) to authenticated, anon, service_role;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

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
    insert into t_results values (p_name, true, 'ok');
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

-- The statement must FAIL and the message must contain the fragment. A statement that unexpectedly succeeds is rolled back (it must not leak state).
create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text) returns void
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
      insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  end if;
end $$;

-- Like expect_msg, but the refusal may carry either of two fragments (an ACL refusal or the function's own COMP_FORBIDDEN).
create or replace function pg_temp.expect_msg2(p_name text, p_sql text, p_f1 text, p_f2 text) returns void
language plpgsql as $$
declare v_unexpected boolean := false;
begin
  begin
    execute p_sql; v_unexpected := true; raise exception 'rollback probe';
  exception when others then
    if not v_unexpected then
      insert into t_results values (p_name, position(lower(p_f1) in lower(sqlerrm)) > 0 or position(lower(p_f2) in lower(sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then insert into t_results values (p_name, false, 'statement unexpectedly succeeded'); end if;
end $$;

create or replace function pg_temp.helper_ok(p text) returns boolean language sql security definer as $$ select public._cf1_reason_is_substantive(p) $$;
create or replace function pg_temp.u(p_suffix text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-b11ff4' || p_suffix)::uuid $$;
create or replace function pg_temp.n(p_sql text) returns bigint
language plpgsql as $$ declare r bigint; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.as_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end $$;
create or replace function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('role', 'service_role', true);
end $$;
create or replace function pg_temp.rid(p int) returns uuid language sql immutable as $$ select pg_temp.u('06' || lpad(p::text, 2, '0') || '00') $$;
create or replace function pg_temp.did(p int) returns uuid language sql immutable as $$ select pg_temp.u('03' || lpad(p::text, 2, '0') || '00') $$;
create or replace function pg_temp.hid(p int) returns uuid language sql immutable as $$ select pg_temp.u('0d' || lpad(p::text, 2, '0') || '00') $$;
create or replace function pg_temp.eid(p int, i int) returns uuid language sql immutable as $$ select pg_temp.u('08' || lpad(p::text, 2, '0') || lpad(i::text, 2, '0')) $$;
create or replace function pg_temp.off(p_event text, p_user text) returns uuid
language sql stable security definer as $$
  select id from public.event_competition_officials where event_id = pg_temp.u(p_event) and user_id = pg_temp.u(p_user)
$$;
create or replace function pg_temp.mkr(p int, p_vals jsonb) returns jsonb
language sql stable security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'value', p_vals -> (x.rn - 1)::int) order by x.rn)
  from (select he.entry_id, row_number() over (order by he.entry_id)::int rn
        from public.event_competition_heat_entries he where he.heat_id = pg_temp.hid(p)) x
$$;
-- The database's own engine result for an evidence document (PV-1's independent calculation). SECURITY DEFINER in pg_temp: the function is not
-- executable by API roles.
create or replace function pg_temp.run_engine(p_ev jsonb) returns jsonb
language sql stable security definer as $$ select public._comppv1_run('ordinal', p_ev) $$;
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
create or replace function pg_temp.napprovals(p int) returns bigint
language sql stable security definer as $$
  select count(*) from public.event_competition_result_approvals a join public.event_competition_result_versions v on v.id = a.result_version_id where v.round_id = pg_temp.rid(p)
$$;
create or replace function pg_temp.nevents(p int, p_kind text) returns bigint
language sql stable security definer as $$
  select count(*) from public.event_competition_result_events where round_id = pg_temp.rid(p) and kind = p_kind
$$;
create or replace function pg_temp.calc(p int, p_req uuid default gen_random_uuid()) returns jsonb
language plpgsql as $$
declare v_in jsonb; v_res jsonb;
begin
  v_in := public.competition_round_calculation_input(pg_temp.rid(p));
  v_res := pg_temp.run_engine(v_in -> 'evidence');
  if not coalesce((v_res ->> 'ok')::boolean, false) then
    raise exception 'R11 suite: the database engine refused round %: %', p, v_res ->> 'reason';
  end if;
  return public.calculate_competition_round(pg_temp.rid(p), v_in ->> 'engine_key', v_in ->> 'engine_version', v_in ->> 'input_hash',
    pg_temp.th(), '[{"step":1}]'::jsonb, v_res -> 'rows', coalesce(v_res -> 'warnings', '[]'::jsonb), p_req);
end $$;
create or replace function pg_temp.approve(p int, p_version int, p_reason text default null, p_req uuid default gen_random_uuid()) returns jsonb
language plpgsql as $$
begin
  return public.approve_competition_round_result(pg_temp.rid(p), pg_temp.vid(p, p_version), p_reason, p_req);
end $$;
create or replace function pg_temp.corr(p int, p_reason text default 'judge 2 mis-ranked the heat', p_req uuid default gen_random_uuid()) returns jsonb
language plpgsql as $$
begin
  return public.open_competition_round_correction(pg_temp.rid(p), p_reason, p_req);
end $$;
-- Runs as p_user (a fixture user suffix such as '000001'), then back to the superuser.
create or replace function pg_temp.as_calc(p_user text, p int) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.u(p_user)); perform pg_temp.calc(p); execute 'reset role';
end $$;
create or replace function pg_temp.as_approve(p_user text, p int, p_version int, p_reason text default null) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.u(p_user)); perform pg_temp.approve(p, p_version, p_reason); execute 'reset role';
end $$;
create or replace function pg_temp.as_corr(p_user text, p int) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.u(p_user)); perform pg_temp.corr(p); execute 'reset role';
end $$;

create or replace function pg_temp.submit_as(p_user text, p int, p_vals jsonb, p_reason text default null) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(pg_temp.u(p_user));
  v := public.submit_competition_ballot(pg_temp.rid(p), pg_temp.hid(p), pg_temp.mkr(p, p_vals), gen_random_uuid(), p_reason);
  execute 'reset role';
  return v;
end $$;
create or replace function pg_temp.ballots(p int) returns void
language plpgsql as $$
begin
  perform pg_temp.submit_as('000011', p, '[1,2,3]');
  perform pg_temp.submit_as('000012', p, '[1,3,2]');
  perform pg_temp.submit_as('000013', p, '[2,1,3]');
end $$;
create or replace function pg_temp.prep(p int) returns void
language plpgsql as $$
begin
  perform pg_temp.hl1_danced(pg_temp.hid(p));   -- pilot: ballots only for a heat that has started
  perform pg_temp.ballots(p);
  perform pg_temp.as_user(pg_temp.u('000001'));
  perform public.set_competition_heat_lock_state(pg_temp.hid(p), 'locked', 'fixture');
  perform public.lock_competition_round_ballots(pg_temp.rid(p), gen_random_uuid());
  execute 'reset role';
end $$;
create or replace function pg_temp.panel(p int, p_scorer boolean default false) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(pg_temp.u('000001'));
  perform public.assign_competition_panel_member(pg_temp.rid(p), pg_temp.off('00e001', '000011'), 'A', gen_random_uuid());
  perform public.assign_competition_panel_member(pg_temp.rid(p), pg_temp.off('00e001', '000012'), 'B', gen_random_uuid());
  perform public.assign_competition_panel_member(pg_temp.rid(p), pg_temp.off('00e001', '000013'), 'C', gen_random_uuid());
  if p_scorer then
    perform public.assign_competition_panel_member(pg_temp.rid(p), pg_temp.off('00e001', '000016'), null, gen_random_uuid());
  end if;
  execute 'reset role';
end $$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (superuser)
-- ============================================================================
-- users: 01 02 03 managers (studio owners A), 05 studio B owner, 11 12 13 judges, 16 scorer (r11 panel), 17 chair, 20 verified user without a role
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-r11-a1@example.test'), (pg_temp.u('000002'), 't-r11-a2@example.test'), (pg_temp.u('000003'), 't-r11-a3@example.test'),
  (pg_temp.u('000005'), 't-r11-owner-b@example.test'), (pg_temp.u('000011'), 't-r11-judge1@example.test'),
  (pg_temp.u('000012'), 't-r11-judge2@example.test'), (pg_temp.u('000013'), 't-r11-judge3@example.test'),
  (pg_temp.u('000016'), 't-r11-scorer@example.test'), (pg_temp.u('000017'), 't-r11-chair@example.test'),
  (pg_temp.u('000020'), 't-r11-nobody@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'R11 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-b11ff4%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now()
from auth.users where id::text like '00000000-0000-0000-0000-b11ff4%';

insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'R11 Studio A', 't-r11-studio-a'), (pg_temp.u('00b001'), 'R11 Studio B', 't-r11-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.u('000002'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000003'), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.u('000005'), pg_temp.u('00b001'), 'studio_owner', true),
  (pg_temp.u('000011'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000012'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000013'), pg_temp.u('00a001'), 'instructor', true), (pg_temp.u('000016'), pg_temp.u('00a001'), 'front_desk', true),
  (pg_temp.u('000017'), pg_temp.u('00a001'), 'instructor', true);

insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'R11 Comp', 't-r11-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured', 'none'),
  (pg_temp.u('001002'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Callback', 'ballroom', 'relative', 'skating', 'configured', 'promote_callback');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'ProAm', 'single_dance', 'pro_am', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e001'), pg_temp.u('001002'), 'Callback ProAm', 'single_dance', 'pro_am', 'open');
create or replace function pg_temp.prog(n int) returns uuid language sql immutable as $$ select pg_temp.u(case when n = 12 then '001002' else '001001' end) $$;
create or replace function pg_temp.cont(n int) returns uuid language sql immutable as $$ select pg_temp.u(case when n = 12 then '002002' else '002001' end) $$;
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
select pg_temp.did(d), pg_temp.u('00e001'), pg_temp.prog(d), pg_temp.cont(d), 'D' || d, 'open' from generate_series(1, 16) d;
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
select pg_temp.rid(n), pg_temp.u('00e001'), pg_temp.prog(n), pg_temp.did(n), 'R' || n, 'final', case when n = 12 then 2 else 1 end, 'draft', 'ordinal_majority' from generate_series(1, 16) n;
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.eid(n, i), pg_temp.u('00e001'), pg_temp.prog(n), pg_temp.did(n), 'E' || n || i, 'confirmed', 'eligible', (n * 10 + i)::text
from generate_series(1, 16) n cross join generate_series(1, 3) i;

-- S4 / R-15 (20270301110000+), when installed: an entry takes part only after the organizer clears it, and clearance needs an established adult age
-- (S5, 20270301120000). The suite establishes this the authorized way and ONLY that way: adult competitors as participants, then
-- set_competition_entry_eligibility called by manager A1 (before any heat placement, because the ENABLE ALWAYS placement gate also fires in replica
-- mode). No determination row is written directly, no gate or predicate is replaced or disabled. Without S4 nothing here runs. With S4 but without the
-- S5 age predicate clearance cannot be established, so the suite stops instead of working around it.
do $s4$
begin
  if to_regprocedure('public.set_competition_entry_eligibility(uuid,text,text,text[],uuid)') is null then
    return;
  end if;
  if to_regprocedure('public._comp_participant_age_clearance(uuid)') is null then
    raise exception 'R11 suite: S4 (R-15 clearance) is installed without the S5 age predicate; entries cannot be cleared through the lifecycle function. Install S5 (the suite never stubs or bypasses it).';
  end if;
  execute $i$
    insert into public.event_competition_competitors (id, event_id, first_name, last_name, created_via, date_of_birth)
    select pg_temp.u('07' || lpad(n::text, 2, '0') || lpad(i::text, 2, '0')), pg_temp.u('00e001'), 'Dancer', 'R11-' || n || '-' || i, 'staff', date '1985-06-15'
    from generate_series(1, 16) n cross join generate_series(1, 3) i $i$;
  execute $i$
    insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, dance_role, display_name)
    select pg_temp.u('00e001'), pg_temp.eid(n, i), pg_temp.u('07' || lpad(n::text, 2, '0') || lpad(i::text, 2, '0')), 'dancer', 'leader', 'R11 ' || n || '-' || i
    from generate_series(1, 16) n cross join generate_series(1, 3) i $i$;
  perform pg_temp.as_user(pg_temp.u('000001'));
  execute $i$
    select public.set_competition_entry_eligibility(pg_temp.eid(n, i), 'eligible', 'criteria_verified_by_organizer', '{}'::text[], gen_random_uuid())
    from generate_series(1, 16) n cross join generate_series(1, 3) i $i$;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $s4$;
reset role;
select pg_temp.chk('fixture (S4 present only): all 48 entries are cleared through set_competition_entry_eligibility and available for execution',
  case when to_regprocedure('public.set_competition_entry_eligibility(uuid,text,text,text[],uuid)') is null then true
       else (select count(*) = 48 and bool_and(public._cf1_entry_unavailable_reason(e.id) is null)
             from public.event_competition_entries e where e.event_id = pg_temp.u('00e001')) end);

set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values
  (pg_temp.u('00c001'), pg_temp.u('00e001'), 1, 'v1', 'published', now());
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status)
select pg_temp.hid(n), pg_temp.u('00e001'), pg_temp.did(n), pg_temp.rid(n), n, pg_temp.cont(n), pg_temp.u('00c001'), 'scheduled' from generate_series(1, 16) n;
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
select pg_temp.u('00e001'), pg_temp.did(n), pg_temp.hid(n), pg_temp.eid(n, i), i from generate_series(1, 16) n cross join generate_series(1, 3) i
where n <> 12 or i = 1;   -- r12 holds one couple only
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
select pg_temp.u('00e001'), pg_temp.hid(n), 'waltz', 'Waltz', 1 from generate_series(1, 16) n;
set session_replication_role = origin;

select pg_temp.as_user(pg_temp.u('000001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000011'), 'judge', pg_temp.u('f10001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000012'), 'judge', pg_temp.u('f10002'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000013'), 'judge', pg_temp.u('f10003'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000016'), 'scorer', pg_temp.u('f10005'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.u('000017'), 'chair', pg_temp.u('f10006'));
reset role;
select pg_temp.panel(n) from generate_series(1, 16) n where n <> 11;
select pg_temp.panel(11, true);

set session_replication_role = replica;
update public.event_competition_rounds set status = 'active' where id in (select pg_temp.rid(n) from generate_series(1, 16) n);
set session_replication_role = origin;

do $$
begin
  if to_regprocedure('public.pin_competition_round_scoring(uuid)') is null then
    raise exception 'R11 suite needs REG 20270113 (pin_competition_round_scoring)';
  end if;
  set local session_replication_role = replica;
  update public.event_competition_programs set rules_profile_key = 'studio_simple', rules_profile_version = 1, profile_locked_at = now();
  insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at)
  select id, event_id, 'studio_simple', 1, jsonb_build_object('profile', jsonb_build_object('key', 'studio_simple', 'version', 1)), profile_locked_at
  from public.event_competition_programs;
  set local session_replication_role = origin;
  perform public.pin_competition_round_scoring(id) from public.event_competition_rounds;
end $$;

select pg_temp.prep(n) from generate_series(1, 16) n where n <> 12;
-- r12: one couple, so each judge ranks it first
select pg_temp.hl1_danced(pg_temp.hid(12));   -- pilot: started before its ballots
select pg_temp.submit_as('000011', 12, '[1]'), pg_temp.submit_as('000012', 12, '[1]'), pg_temp.submit_as('000013', 12, '[1]');
select pg_temp.as_user(pg_temp.u('000001'));
select public.set_competition_heat_lock_state(pg_temp.hid(12), 'locked', 'fixture');
select public.lock_competition_round_ballots(pg_temp.rid(12), gen_random_uuid());
reset role;

select pg_temp.chk('fixture: r1..r16 are ballots_locked', (select count(*) = 16 from public.event_competition_rounds where status = 'ballots_locked'));

-- ============================================================================
-- S. Structure of the installed function (static facts about the pinned text; the md5 line is the post-migration pin)
-- ============================================================================
select pg_temp.chk('S: approve is SECURITY DEFINER with a pinned search_path, executable by authenticated and neither anon nor public',
  (select p.prosecdef and p.proconfig @> array['search_path=public, pg_temp'] from pg_proc p where p.oid = 'public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure)
  and has_function_privilege('authenticated', 'public.approve_competition_round_result(uuid,uuid,text,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.approve_competition_round_result(uuid,uuid,text,uuid)', 'execute'));
select pg_temp.chk('S: approve signature unchanged (p_round_id, p_result_version_id, p_override_reason, p_request_id)',
  (select array_to_string(proargnames, ',') = 'p_round_id,p_result_version_id,p_override_reason,p_request_id' from pg_proc where oid = 'public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure));
select pg_temp.chk('S: approve text is the post-R-11 pin (md5 2d178c29177ebf2ec14a46bf510ccc12, CRs removed)',
  md5(replace(pg_get_functiondef('public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure), E'\r', '')) = '2d178c29177ebf2ec14a46bf510ccc12');
select pg_temp.chk('S: ordering in the installed text: stale checks < history read < override refusal < audit event < roster check < approved write; PV-1 verify after the hash check',
  (with d as (select replace(pg_get_functiondef('public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure), E'\r', '') t)
   select position('COMP_REQUEST_REUSED' in t) < position('COMP_RESULT_STALE' in t)
      and position('recalculate before approving' in t) < position('_comppv1_verify' in t)
      and position('_comppv1_verify' in t) < position('v_initial :=' in t)
      and position('v_initial :=' in t) < position('_cf1_reason_is_substantive' in t)
      and position('_cf1_reason_is_substantive' in t) < position('_compf2_event' in t)
      and position('_compf2_event' in t) < position('_cf1_require_roster_eligible(p_round_id, ''approve'')' in t)
      and position('_cf1_require_roster_eligible(p_round_id, ''approve'')' in t) < position('set status = ''approved'', updated_at' in t)
      and (length(t) - length(replace(t, '_cf1_require_roster_eligible', ''))) / length('_cf1_require_roster_eligible') = 1 from d));
select pg_temp.chk('S: no client flag decides initial/corrected: the text reads only the three append-only history tables and never a parameter or the mutable correction_open / status of the round',
  (with d as (select replace(pg_get_functiondef('public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure), E'\r', '') t),
        s as (select substr(t, position('v_initial :=' in t), position('v_override := v_ver.calculated_by' in t) - position('v_initial :=' in t)) h from d)
   select position('event_competition_result_approvals' in h) > 0 and position('event_competition_correction_causes' in h) > 0 and position('event_competition_result_events' in h) > 0
      and position('p_override_reason' in h) = 0 and position('correction_open' in h) = 0 and position('v_round.status' in h) = 0 from s));
select pg_temp.chk('S: the three history tables carry the append-only trigger (update/delete) and the truncate trigger',
  (select count(distinct c.relname) = 3 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname in ('event_competition_result_approvals', 'event_competition_result_events', 'event_competition_correction_causes')
      and t.tgfoid = 'public.protect_competition_history_evidence()'::regprocedure and t.tgenabled in ('O', 'A') and not t.tgisinternal)
  and (select count(*) >= 6 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname in ('event_competition_result_approvals', 'event_competition_result_events', 'event_competition_correction_causes')
      and t.tgfoid = 'public.protect_competition_history_evidence()'::regprocedure and not t.tgisinternal));
select pg_temp.chk('S: no API role holds a write privilege on the three history tables',
  not exists (select 1 from information_schema.role_table_grants g
              where g.table_schema = 'public' and g.table_name in ('event_competition_result_approvals', 'event_competition_result_events', 'event_competition_correction_causes')
                and g.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC') and g.privilege_type <> 'SELECT'));
select pg_temp.chk('S: _cf1_reason_is_substantive is IMMUTABLE and not executable by any API role (reachable only from definer functions)',
  (select p.provolatile = 'i' and not p.prosecdef from pg_proc p where p.oid = 'public._cf1_reason_is_substantive(text)'::regprocedure)
  and not has_function_privilege('authenticated', 'public._cf1_reason_is_substantive(text)', 'execute')
  and not has_function_privilege('anon', 'public._cf1_reason_is_substantive(text)', 'execute'));
select pg_temp.chk('S: the four Final withdrawal RPCs exist (so the next check covers them)',
  (select count(distinct p.proname) = 4 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in
    ('withdraw_advanced_entry_from_final', 'reinstate_withdrawn_entry_to_final', 'cosign_final_withdrawal_request', 'cancel_final_withdrawal_request')));
select pg_temp.chk('S: none of the exclusion / withdrawal / correction co-sign / advancement RPCs takes an override, force or bypass parameter, and no body references an approval override',
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
               and p.proname in ('request_round_exclusion', 'cosign_round_exclusion', 'request_round_exclusion_reversal', 'cosign_round_exclusion_reversal',
                                 'cosign_competition_correction', 'apply_competition_round_advancement', 'publish_competition_round_result', 'withdraw_competition_round_result',
                                 'withdraw_advanced_entry_from_final', 'reinstate_withdrawn_entry_to_final', 'cosign_final_withdrawal_request', 'cancel_final_withdrawal_request')
               and (array_to_string(p.proargnames, ',') ~* '(override|force|bypass)' or position('result_approval_override' in p.prosrc) > 0)));

-- ============================================================================
-- r1 INITIAL self-approval with a substantive reason: still works, with its mandatory audit record
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('r1: A1 calculates', $q$select pg_temp.calc(1)$q$);
select pg_temp.expect_msg('pilot r1: the calculator cannot self-approve the initial result, even with a substantive reason', $q$select pg_temp.approve(1, 1, 'only manager present on the floor today')$q$, 'COMP_P1_SECOND_APPROVER_REQUIRED');
reset role;
select pg_temp.chk('pilot r1: the refusal recorded nothing (no approval, no override or approved event)', pg_temp.rstatus(1) = 'calculated' and pg_temp.vstatus(1, 1) = 'calculated' and pg_temp.napprovals(1) = 0
  and pg_temp.nevents(1, 'result_approval_override') = 0 and pg_temp.nevents(1, 'result_approved') = 0);

-- ============================================================================
-- r2 INITIAL two-manager approval: still works, no override, reason discarded
-- ============================================================================
select pg_temp.as_calc('000001', 2);
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('r2: A2 (not the calculator) approves; a supplied reason is ignored', format($q$select pg_temp.approve(2, 1, 'not needed for a second manager', %L)$q$, pg_temp.u('f40002')));
reset role;
select pg_temp.chk('r2: normal audit kind result_approved, reason null, refs.initial = true, override false',
  (select count(*) = 1 and bool_and(actor_user_id = pg_temp.u('000002') and reason is null and (refs ->> 'initial')::boolean and not (refs ->> 'override')::boolean)
   from public.event_competition_result_events where round_id = pg_temp.rid(2) and kind = 'result_approved')
  and pg_temp.nevents(2, 'result_approval_override') = 0
  and (select override_reason is null and approved_by <> calculated_by from public.event_competition_result_approvals where result_version_id = pg_temp.vid(2, 1)));

-- ============================================================================
-- r3 RB-11.1: insufficient override reasons are refused (self-approval of an initial result), the round stays calculated
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('r3: A1 calculates', $q$select pg_temp.calc(3)$q$);
select pg_temp.expect_msg('RB-11.1: no reason', $q$select pg_temp.approve(3, 1)$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1: whitespace-only reason', $q$select pg_temp.approve(3, 1, '     ')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1: one-character reason "x" is refused', $q$select pg_temp.approve(3, 1, 'x')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1: two-character reason', $q$select pg_temp.approve(3, 1, 'ok')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1: short placeholder "n/a" (refused by length)', $q$select pg_temp.approve(3, 1, 'n/a')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1: short placeholder "testing" (refused by length)', $q$select pg_temp.approve(3, 1, 'testing')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1: a repeated character (20+ characters)', $q$select pg_temp.approve(3, 1, repeat('a', 25))$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1: 20+ characters but a single word', $q$select pg_temp.approve(3, 1, 'sixteencharacterslongword')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1: four words but fewer than 20 characters', $q$select pg_temp.approve(3, 1, 'a b c d')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1: the same word repeated (20+ characters, only one distinct word)', $q$select pg_temp.approve(3, 1, 'urgent urgent urgent urgent urgent')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1: a reason over 500 characters made of distinct words (only the length rule applies)', format($q$select pg_temp.approve(3, 1, %L)$q$,
  (select string_agg('word' || g, ' ' order by g) from generate_series(1, 90) g)), 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.chk('RB-11.1: control: that reason is over 500 characters and would pass every other rule', (select length(string_agg('word' || g, ' ' order by g)) > 500 from generate_series(1, 90) g));
select pg_temp.expect_msg('RB-11.1 (review): "a b c d" padded with non-breaking spaces to 21+ characters', format($q$select pg_temp.approve(3, 1, %L)$q$, 'a b c d' || repeat(chr(160), 14)), 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1 (review): punctuation tokens only, 20+ characters (passes the shared helper)', $q$select pg_temp.approve(3, 1, '!!!! ???? .... ---- ++++')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1 (review): fewer than 12 letters/digits, otherwise valid (only the letters rule)', $q$select pg_temp.approve(3, 1, 'ab cd ef gh !!!!!!!!!!!!')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1 (review): three real words padded with punctuation words (only the four-real-words rule)', $q$select pg_temp.approve(3, 1, 'abcdefgh ijklmnop qrstuvwx !!!! ????')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1 (distinct): one word repeated plus punctuation tokens (passes the shared helper)', $q$select pg_temp.approve(3, 1, 'urgent urgent urgent urgent . -')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1 (distinct): one word varied only by case and punctuation', $q$select pg_temp.approve(3, 1, 'Urgentcase urgentcase! URGENTCASE, urgentcase?')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1 (distinct): only two different real words', $q$select pg_temp.approve(3, 1, 'urgent matter urgent matter - .')$q$, 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.chk('RB-11.1: control: the shared helper alone ACCEPTS the punctuation-padded cases (so the refusals above come from this function)',
  (select bool_and(pg_temp.helper_ok(s)) from unnest(array['!!!! ???? .... ---- ++++', 'ab cd ef gh !!!!!!!!!!!!', 'abcdefgh ijklmnop qrstuvwx !!!! ????', 'urgent urgent urgent urgent . -', 'Urgentcase urgentcase! URGENTCASE, urgentcase?']) s));
select pg_temp.expect_msg('RB-11.1 (review): a leading tab and three real words', format($q$select pg_temp.approve(3, 1, %L)$q$, E'\taaaaaaaaaaaaaaaaa b c'), 'COMP_SECOND_APPROVER_REQUIRED');
select pg_temp.expect_msg('RB-11.1 (review): zero-width padding', format($q$select pg_temp.approve(3, 1, %L)$q$, 'a b c d' || repeat(chr(8203), 14)), 'COMP_SECOND_APPROVER_REQUIRED');
reset role;
select pg_temp.chk('r3: every refusal left nothing behind (round and version calculated, no approval, no override or approved event)',
  pg_temp.rstatus(3) = 'calculated' and pg_temp.vstatus(3, 1) = 'calculated' and pg_temp.napprovals(3) = 0
  and pg_temp.nevents(3, 'result_approval_override') = 0 and pg_temp.nevents(3, 'result_approved') = 0
  and (select lock_state = 'locked' from public.event_competition_heats where id = pg_temp.hid(3)));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('pilot r3: a reason meeting the R-11 standard is still refused for the calculator', $q$select pg_temp.approve(3, 1, 'sole manager on site')$q$, 'COMP_P1_SECOND_APPROVER_REQUIRED');
reset role;
select pg_temp.chk('pilot r3: that refusal recorded nothing', pg_temp.rstatus(3) = 'calculated' and pg_temp.vstatus(3, 1) = 'calculated' and pg_temp.napprovals(3) = 0
  and pg_temp.nevents(3, 'result_approval_override') = 0 and pg_temp.nevents(3, 'result_approved') = 0);

-- ============================================================================
-- r4 RB-11.2: corrected result, calculator = correction opener (A1). Self-approval refused whatever the reason; independent A2 allowed
-- ============================================================================
select pg_temp.as_calc('000001', 4);
select pg_temp.as_approve('000002', 4, 1);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('pilot r4: opening a correction of an approved result is refused', $q$select pg_temp.corr(4)$q$, 'COMP_P1_CORRECTIONS_OFF');
reset role;
select pg_temp.chk('pilot r4: the approved version stands; no correction cause; one approval by the second manager', pg_temp.vstatus(4, 1) = 'approved' and pg_temp.rstatus(4) = 'approved' and pg_temp.napprovals(4) = 1
  and not exists (select 1 from public.event_competition_correction_causes where round_id = pg_temp.rid(4))
  and (select approved_by = pg_temp.u('000002') and override_reason is null from public.event_competition_result_approvals where result_version_id = pg_temp.vid(4, 1)));

-- ============================================================================
-- r5 RB-11.2: the opener (A2) is NOT the calculator (A1): the opener cannot approve either; a third manager (A3) can
-- ============================================================================
select pg_temp.as_calc('000001', 5);
select pg_temp.as_approve('000002', 5, 1);
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('pilot r5: a second manager cannot open a correction either', $q$select pg_temp.corr(5)$q$, 'COMP_P1_CORRECTIONS_OFF');
reset role;
select pg_temp.chk('pilot r5: nothing changed', pg_temp.vstatus(5, 1) = 'approved' and pg_temp.napprovals(5) = 1 and not exists (select 1 from public.event_competition_correction_causes where round_id = pg_temp.rid(5)));

-- ============================================================================
-- r6 RB-11.2: a correction opened from `calculated` (the first result was never approved) is still a correction
-- ============================================================================
select pg_temp.as_calc('000001', 6);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('pilot r6: a correction from calculated is refused', $q$select pg_temp.corr(6)$q$, 'COMP_P1_CORRECTIONS_OFF');
reset role;
select pg_temp.chk('pilot r6: the result stays calculated with no history', pg_temp.rstatus(6) = 'calculated' and pg_temp.vstatus(6, 1) = 'calculated' and pg_temp.napprovals(6) = 0
  and pg_temp.nevents(6, 'result_approval_override') = 0 and pg_temp.nevents(6, 'result_approved') = 0);

-- ============================================================================
-- r7 stale hash with an override reason: COMP_RESULT_STALE before the override branch (no override event, nothing approved)
-- ============================================================================
select pg_temp.as_calc('000001', 7);
set session_replication_role = replica;
select pg_temp.expect_msg2('pilot r7: a couple cannot be scratched from a started heat (the stale-input route the original used)', $q$update public.event_competition_heat_entries set status = 'scratched' where heat_id = pg_temp.hid(7) and entry_id = pg_temp.eid(7, 3)$q$, 'COMP_P1_STARTED_HEAT', 'COMP_S6_');
set session_replication_role = origin;
select pg_temp.chk('pilot r7: nothing approved', pg_temp.rstatus(7) = 'calculated' and pg_temp.vstatus(7, 1) = 'calculated' and pg_temp.napprovals(7) = 0
  and pg_temp.nevents(7, 'result_approval_override') = 0 and pg_temp.nevents(7, 'result_approved') = 0);
-- a non-latest version with an override reason: after a correction + recalculation, version 1 is no longer the latest
select pg_temp.as_calc('000001', 8);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('pilot r8: no second version can be created by a correction', $q$select pg_temp.corr(8)$q$, 'COMP_P1_CORRECTIONS_OFF');
reset role;
select pg_temp.chk('pilot r8: version 1 stays the only, calculated version', pg_temp.rstatus(8) = 'calculated' and pg_temp.vstatus(8, 1) = 'calculated' and pg_temp.napprovals(8) = 0
  and pg_temp.nevents(8, 'result_approval_override') = 0 and pg_temp.nevents(8, 'result_approved') = 0);

-- ============================================================================
-- r9 / r10 / r11: roster, exclusion co-sign separation, unauthorized callers
-- ============================================================================
select pg_temp.as_calc('000001', 9);
update public.event_competition_entries set eligibility_status = 'ineligible' where id = pg_temp.eid(9, 2);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg2('pilot r9: the calculator is refused for an ineligible couple (roster check or pilot second-approver rule)', $q$select pg_temp.approve(9, 1, 'only manager present on the floor today')$q$, 'COMP_ROSTER_ENTRY_UNAVAILABLE', 'COMP_P1_SECOND_APPROVER_REQUIRED');
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('pilot r9: a second manager is refused by the roster check', $q$select pg_temp.approve(9, 1)$q$, 'COMP_ROSTER_ENTRY_UNAVAILABLE');
reset role;
select pg_temp.chk('r9: the refused approval rolled back everything (version calculated, no approval, no override event, heat still locked, round calculated)',
  pg_temp.vstatus(9, 1) = 'calculated' and pg_temp.napprovals(9) = 0 and pg_temp.nevents(9, 'result_approval_override') = 0 and pg_temp.rstatus(9) = 'calculated'
  and (select lock_state = 'locked' from public.event_competition_heats where id = pg_temp.hid(9)));
update public.event_competition_entries set eligibility_status = 'eligible' where id = pg_temp.eid(9, 2);

-- exclusion co-sign separation: the same manager requests and co-signs; no override exists anywhere in that path
update public.event_competition_entries set eligibility_status = 'ineligible' where id = pg_temp.eid(10, 1);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('r10: A1 requests an exclusion', format($q$select public.request_round_exclusion(pg_temp.rid(10), pg_temp.eid(10, 1), 'ineligible', 'ineligible after the heat was danced', %L)$q$, pg_temp.u('f40010')));
reset role;
select set_config('r11.xid', (select id::text from public.event_competition_round_exclusions where round_id = pg_temp.rid(10) and kind = 'exclude_requested' limit 1), false);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('no-override (exclusion co-sign separation): the requester cannot co-sign', format($q$select public.cosign_round_exclusion(%L, gen_random_uuid())$q$,
  coalesce(nullif(current_setting('r11.xid'), ''), gen_random_uuid()::text)::uuid), 'COMP_EXCLUSION_COSIGN_SAME_PERSON');
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('r10: a different manager may co-sign (control)', format($q$select public.cosign_round_exclusion(%L, gen_random_uuid())$q$,
  coalesce(nullif(current_setting('r11.xid'), ''), gen_random_uuid()::text)::uuid));
reset role;

-- unauthorized callers of approve (r11 is calculated, never approved)
select pg_temp.as_calc('000001', 11);
select pg_temp.as_user(pg_temp.u('000017'));
select pg_temp.expect_msg('unauthorized: a chair cannot approve (COMP_FORBIDDEN)', $q$select pg_temp.approve(11, 1, 'chair attempting to approve this result')$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000016'));
select pg_temp.expect_msg('unauthorized: a scorer cannot approve', $q$select pg_temp.approve(11, 1, 'scorer attempting to approve this result')$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000011'));
select pg_temp.expect_msg('unauthorized: a judge cannot approve', $q$select pg_temp.approve(11, 1, 'judge attempting to approve this result')$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_msg('unauthorized: cross-tenant (studio B owner) cannot approve', $q$select pg_temp.approve(11, 1, 'other studio owner trying to approve')$q$, 'COMP_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000020'));
select pg_temp.expect_msg('unauthorized: an authenticated user with no role cannot approve', $q$select pg_temp.approve(11, 1, 'user without any role tries to approve')$q$, 'COMP_FORBIDDEN');
select pg_temp.as_anon();
select pg_temp.expect_msg('unauthorized: anon cannot execute approve', $q$select pg_temp.approve(11, 1, 'anonymous caller trying to approve')$q$, 'permission denied');
select pg_temp.as_service();
select pg_temp.expect_msg2('service_role (token without a user) is refused: permission denied where service_role holds no EXECUTE (this local image), otherwise COMP_FORBIDDEN because auth.uid() is null (RF-11.1; the grant is NOT changed by this migration)',
  $q$select pg_temp.approve(11, 1, 'service role key without a user session')$q$, 'COMP_FORBIDDEN', 'permission denied');
reset role;
select pg_temp.chk('r11: nothing approved by any unauthorized caller', pg_temp.vstatus(11, 1) = 'calculated' and pg_temp.napprovals(11) = 0 and pg_temp.nevents(11, 'result_approval_override') = 0);

-- ============================================================================
-- Audit immutability and event-kind distinctness
-- ============================================================================
select pg_temp.expect_msg('audit: an approvals row cannot be updated', format($q$update public.event_competition_result_approvals set override_reason = 'rewritten reason text here' where result_version_id = %L$q$, pg_temp.vid(2, 1)), 'append-only');
select pg_temp.expect_msg('audit: an approvals row cannot be deleted', format($q$delete from public.event_competition_result_approvals where result_version_id = %L$q$, pg_temp.vid(2, 1)), 'append-only');
select pg_temp.expect_msg('audit: a result event cannot be updated (the override reason is immutable)', format($q$update public.event_competition_result_events set reason = 'rewritten' where round_id = %L and kind = 'result_approved'$q$, pg_temp.rid(2)), 'append-only');
select pg_temp.expect_msg('audit: a result event cannot be deleted', format($q$delete from public.event_competition_result_events where round_id = %L and kind = 'result_approved'$q$, pg_temp.rid(2)), 'append-only');
select pg_temp.expect_msg('audit: result events cannot be truncated', $q$truncate public.event_competition_result_events$q$, 'append-only');
select pg_temp.expect_msg('audit: an API role cannot write the result events directly (no privilege)', $q$set local role authenticated; insert into public.event_competition_result_events (event_id, round_id, kind, actor_user_id, request_id) values (gen_random_uuid(), gen_random_uuid(), 'result_approved', gen_random_uuid(), gen_random_uuid())$q$, 'permission denied');
reset role;
select pg_temp.chk('pilot audit: no override approval exists at all (no override event, no approval row with a reason or by its calculator)',
  not exists (select 1 from public.event_competition_result_events where kind = 'result_approval_override' and event_id = pg_temp.u('00e001'))
  and not exists (select 1 from public.event_competition_result_approvals where event_id = pg_temp.u('00e001') and (override_reason is not null or approved_by = calculated_by)));
select pg_temp.chk('audit: no approved event for a corrected version carries a reason or the override flag',
  not exists (select 1 from public.event_competition_result_events e where e.kind in ('result_approved', 'result_approval_override') and e.refs ->> 'initial' = 'false'
              and (e.reason is not null or e.kind = 'result_approval_override')));
-- ============================================================================
-- r12 minimum-two callback Final with REAL helpers. One couple: a Final with no earlier round has no minimum, so it calculates. Fixture write
-- (replica) then puts a preliminary round before it in its promote_callback program, which makes it a callback Final without changing the stored
-- evidence (the input hash stays current), so approval reaches the roster check.
-- ============================================================================
select pg_temp.as_calc('000001', 12);
select pg_temp.chk('r12: calculated with one couple; not yet a callback Final', pg_temp.vstatus(12, 1) = 'calculated' and not public._cf1_is_callback_final(pg_temp.rid(12)));
set session_replication_role = replica;
select pg_temp.expect_msg('pilot r12: a preliminary round (which would make a callback Final) cannot be added', $q$insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values (pg_temp.u('061700'), pg_temp.u('00e001'), pg_temp.prog(12), pg_temp.did(12), 'R12 prelim', 'preliminary', 1, 'approved', 'callback_tally')$q$, 'COMP_P1_FINAL_ONLY');
set session_replication_role = origin;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('pilot r12: the calculator cannot self-approve the one-couple Final', $q$select pg_temp.approve(12, 1, 'only manager present on the floor today')$q$, 'COMP_P1_SECOND_APPROVER_REQUIRED');
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('pilot r12: a second manager cannot approve a Final with one ranked couple', $q$select pg_temp.approve(12, 1)$q$, 'COMP_P1_MINIMUM_COUPLES');
reset role;
select pg_temp.chk('pilot r12: both refusals recorded nothing', pg_temp.rstatus(12) = 'calculated' and pg_temp.vstatus(12, 1) = 'calculated' and pg_temp.napprovals(12) = 0
  and pg_temp.nevents(12, 'result_approval_override') = 0 and pg_temp.nevents(12, 'result_approved') = 0);

-- ============================================================================
-- r13: an earlier APPROVAL is the only history (no cause row, no correction event). Fixture write (replica) reopens the round without the
-- correction function, so only source 1 exists.
-- ============================================================================
select pg_temp.as_calc('000001', 13);
select pg_temp.as_approve('000002', 13, 1);
set session_replication_role = replica;
update public.event_competition_result_versions set status = 'stale' where id = pg_temp.vid(13, 1);
update public.event_competition_rounds set status = 'ballots_locked', correction_open = false where id = pg_temp.rid(13);
set session_replication_role = origin;
select pg_temp.as_calc('000001', 13);
select pg_temp.chk('r13: only the earlier approval exists', pg_temp.napprovals(13) = 1
  and not exists (select 1 from public.event_competition_correction_causes where round_id = pg_temp.rid(13))
  and not exists (select 1 from public.event_competition_result_events where round_id = pg_temp.rid(13) and refs ->> 'correction' = 'true'));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('single source (approval): the calculator cannot self-approve with a substantive reason', $q$select pg_temp.approve(13, 2, 'only manager present on the floor today')$q$, 'COMP_CORRECTION_APPROVER_REQUIRED');
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_ok('single source (approval): another manager (no correction opener exists) approves', $q$select pg_temp.approve(13, 2)$q$);
reset role;
select pg_temp.chk('r13: recorded with refs.initial = false', (select count(*) = 1 from public.event_competition_result_events where round_id = pg_temp.rid(13) and kind = 'result_approved' and refs ->> 'initial' = 'false'));

-- ============================================================================
-- r14: an A7 CAUSE row is the only history (superuser insert; opener A2). No approval of another version, no correction event.
-- ============================================================================
select pg_temp.as_calc('000001', 14);
select pg_temp.expect_msg('pilot r14: no correction cause can be recorded, even by the database owner', $q$insert into public.event_competition_correction_causes (event_id, round_id, cause, excluded_entry_ids, baseline_version_id, opened_by, reason, request_id) values (pg_temp.u('00e001'), pg_temp.rid(14), 'judge_entry_error', '{}'::uuid[], pg_temp.vid(14, 1), pg_temp.u('000002'), 'fixture cause only', gen_random_uuid())$q$, 'COMP_P1_CORRECTIONS_OFF');
select pg_temp.chk('pilot r14: no cause row exists and nothing is approved', not exists (select 1 from public.event_competition_correction_causes where round_id = pg_temp.rid(14)) and pg_temp.napprovals(14) = 0);

-- ============================================================================
-- r15: an F2 correction EVENT is the only history (superuser insert; opener A2). No approval of another version, no cause row.
-- ============================================================================
select pg_temp.as_calc('000001', 15);
insert into public.event_competition_result_events (event_id, round_id, kind, actor_user_id, from_state, to_state, request_id, reason, refs)
values (pg_temp.u('00e001'), pg_temp.rid(15), 'round_state_changed', pg_temp.u('000002'), 'calculated', 'ballots_locked', gen_random_uuid(), 'fixture event only', '{"correction": true}'::jsonb);
select pg_temp.chk('r15: only the correction event exists', pg_temp.napprovals(15) = 0
  and not exists (select 1 from public.event_competition_correction_causes where round_id = pg_temp.rid(15))
  and (select count(*) = 1 from public.event_competition_result_events where round_id = pg_temp.rid(15) and refs ->> 'correction' = 'true'));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('single source (event): the calculator cannot self-approve with a substantive reason', $q$select pg_temp.approve(15, 1, 'only manager present on the floor today')$q$, 'COMP_CORRECTION_APPROVER_REQUIRED');
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('single source (event): the opener named only by the event cannot approve', $q$select pg_temp.approve(15, 1)$q$, 'COMP_CORRECTION_APPROVER_REQUIRED');
reset role;
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_ok('single source (event): an independent third manager approves', $q$select pg_temp.approve(15, 1)$q$);
reset role;

-- ============================================================================
-- r16: real PV-1 at approval. Fixture write (replica) alters one stored placement; the input hash is still current.
-- ============================================================================
select pg_temp.as_calc('000001', 16);
set session_replication_role = replica;
update public.event_competition_result_rows set placement = coalesce(placement, 0) + 5 where result_version_id = pg_temp.vid(16, 1) and entry_id = pg_temp.eid(16, 1);
set session_replication_role = origin;
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('no-override (PV-1): a self-approval with a substantive reason cannot approve rows that differ from the database calculation', $q$select pg_temp.approve(16, 1, 'only manager present on the floor today')$q$, 'COMP_RESULT_RECOMPUTE_MISMATCH');
reset role;
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('no-override (PV-1): nor can a second manager', $q$select pg_temp.approve(16, 1)$q$, 'COMP_RESULT_RECOMPUTE_MISMATCH');
reset role;
select pg_temp.chk('r16: nothing approved', pg_temp.vstatus(16, 1) = 'calculated' and pg_temp.napprovals(16) = 0 and pg_temp.nevents(16, 'result_approval_override') = 0);

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
    raise exception 'COMPETITION R11 P1 PILOT COPY SQL SUITE PASS (% checks; not a pass of the original R11 suite)', v_total;
  end if;
  raise exception 'COMPETITION R11 P1 PILOT COPY SQL SUITE FAIL: %', v_failures;
end $$;

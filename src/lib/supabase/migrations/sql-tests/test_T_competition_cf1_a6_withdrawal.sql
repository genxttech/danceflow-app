-- Competition CF1 package A6 -- withdrawal and reinstatement regression suite.
--
-- Covers 20270120095000_competition_cf1_a6_withdrawal.sql on top of the chain through HL1, A1 (20270120085000) and A0 (20270120090000).
-- Gates: U37, U39, U41 (single-session part), U48 (a)/(b), U49, U51 (two-session part is in test_T_competition_cf1_a6_concurrency.sh), U52 (replica
-- part), U62, U63, plus OD-15 A (withdrawal minimum), request-id replay, separation of duties, evidence immutability and the event cascade.
-- Run as a SUPERUSER. Fixtures are placed with session_replication_role = replica (the ENABLE ALWAYS CF1 guards still fire, which the suite relies on).
-- One transaction, synthetic fixtures only (md5-derived ids). The final block ALWAYS raises, so nothing persists:
--   "COMPETITION CF1 A6 SQL SUITE PASS (<n> checks, <b> blocked)"  or  "... FAIL: <failures>".

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
-- The statement must fail with a message containing p_fragment; p_state, when given, must equal the SQLSTATE. Nothing it did persists.
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
create or replace function pg_temp.id(p_kind text, p_n int default 0, p_k int default 0) returns uuid
language sql immutable as $$ select md5('cf1a6:' || p_kind || ':' || p_n || ':' || p_k)::uuid $$;
create or replace function pg_temp.as_user(p_user int) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('user', p_user), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.as_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end $$;
create or replace function pg_temp.n(p_sql text) returns bigint
language plpgsql as $$ declare r bigint; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.try(p_sql text) returns jsonb
language plpgsql as $$
declare r jsonb;
begin
  begin
    execute p_sql into r;
  exception when others then
    return jsonb_build_object('error', sqlerrm, 'state', sqlstate);
  end;
  return r;
end $$;
create or replace function pg_temp.code(p_j jsonb) returns text language sql as $$ select split_part(coalesce(p_j->>'error', 'OK'), ':', 1) $$;
-- Superuser helper run under a role: executes SQL as the session owner (fixture mutations in the middle of a role-based section).
create or replace function pg_temp.su(p_sql text) returns void
language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  execute p_sql;
  perform set_config('session_replication_role', 'origin', true);
end $$;
create or replace function pg_temp.su_n(p_sql text) returns bigint
language plpgsql security definer as $$ declare r bigint; begin execute p_sql into r; return r; end $$;

-- The requester's half, the co-signer's half and both together (each as the given test user).
create or replace function pg_temp.req(p_kind text, p_n int, p_k int, p_user int, p_req int, p_reason text default 'the couple asked to leave the final after an injury') returns jsonb
language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  return pg_temp.try(format($q$select public.%s(%L, %L, %L, %L)$q$,
    case when p_kind = 'withdraw' then 'withdraw_advanced_entry_from_final' else 'reinstate_withdrawn_entry_to_final' end,
    pg_temp.id('fin', p_n), pg_temp.id('ent', p_n, p_k), p_reason, pg_temp.id('rq', p_req)));
end $$;
create or replace function pg_temp.cos(p_user int, p_req int) returns jsonb
language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  return pg_temp.try(format($q$select public.cosign_final_withdrawal_request(%L)$q$, pg_temp.id('rq', p_req)));
end $$;
create or replace function pg_temp.flow(p_kind text, p_n int, p_k int, p_req int, p_req_user int default 1, p_cos_user int default 2) returns jsonb
language plpgsql as $$
declare
  v_a jsonb;
begin
  v_a := pg_temp.req(p_kind, p_n, p_k, p_req_user, p_req);
  if v_a ? 'error' then return jsonb_build_object('step', 'request', 'error', v_a->>'error'); end if;
  return pg_temp.cos(p_cos_user, p_req);
end $$;
create or replace function pg_temp.ap(p_n int, p_a int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.as_user(1);
  return pg_temp.try(format($q$select public.apply_competition_round_advancement(%L, %L, %L)$q$, pg_temp.id('src', p_n), coalesce(
    (select rv.id from public.event_competition_result_versions rv where rv.round_id = pg_temp.id('src', p_n) and rv.status = 'approved' order by rv.version desc limit 1), pg_temp.id('rv', p_n)),
    pg_temp.id('a', p_a)));
end $$;
-- The status of the couple's heat entry in the active (non-cancelled) heat of Final n, or 'none'.
create or replace function pg_temp.hes(p_n int, p_k int) returns text language sql security definer as $$
  select coalesce((select he.status from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
                   where h.round_id = pg_temp.id('fin', p_n) and h.status <> 'cancelled' and he.entry_id = pg_temp.id('ent', p_n, p_k)), 'none') $$;
-- A digest of every heat entry of Final n (all heats, cancelled included).
create or replace function pg_temp.hedigest(p_n int) returns text language sql security definer as $$
  select coalesce(md5(string_agg(he.id::text || he.status || he.heat_id::text || he.entry_id::text || he.updated_at::text || he.floor_order::text, ',' order by he.id)), 'empty')
  from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id where h.round_id = pg_temp.id('fin', p_n) $$;
create or replace function pg_temp.regen(p_n int, p_ver int, p_adv int[]) returns void
language plpgsql security definer as $$
declare
  v_event uuid := (select event_id from public.event_competition_rounds where id = pg_temp.id('src', p_n));
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_rounds set status = 'approved' where id = pg_temp.id('src', p_n);
  -- chain-independent: the unique live index allows one calculated/approved version per round, and a fuller chain may leave one live after the correction
  update public.event_competition_result_versions set status = 'superseded' where round_id = pg_temp.id('src', p_n) and status in ('calculated', 'approved');
  insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
  values (pg_temp.id('rvg', p_n, p_ver), v_event, pg_temp.id('src', p_n), p_ver, 'callback_tally', '1', public._compf2_input_hash(pg_temp.id('src', p_n), 'callback_tally', '1'),
          repeat(md5('t' || p_ver), 2), '{}', '[]', pg_temp.id('user', 1), 'approved', pg_temp.id('req-rvg', p_n, p_ver));
  insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, advanced, output)
  select v_event, pg_temp.id('rvg', p_n, p_ver), pg_temp.id('ent', p_n, k), k = any (p_adv), '{}'
  from public.event_competition_entries e, generate_series(1, 4) k where e.id = pg_temp.id('ent', p_n, k);
  perform set_config('session_replication_role', 'origin', true);
end $$;
create or replace function pg_temp.state_probe(p_round_id uuid) returns jsonb language sql security definer as $$
  select coalesce(jsonb_agg(jsonb_build_object('request_id', q.request_id, 'stale', public._cf1_a6_is_stale(p_round_id, q.advancement_id, q.advancement_generation))), '[]'::jsonb)
  from public.event_competition_final_withdrawal_requests q where q.target_round_id = p_round_id and not exists (select 1 from public.event_competition_final_withdrawals w where w.request_id = q.request_id) $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures
-- ============================================================================
-- Users: 1 owner of studio A (manager), 2 admin of A (second manager), 3 front desk of A, 4 chair of event 1, 5 owner of studio B, 6 admin of A WITHOUT a
-- verified email, 7 judge of event 1.
insert into auth.users (id, email) select pg_temp.id('user', u), 't-cf1a6-u' || u || '@example.test' from generate_series(1, 7) u;
insert into public.profiles (id, email, full_name) select id, email, 'CF1A6 ' || split_part(email, '@', 1) from auth.users where email like 't-cf1a6-%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where email like 't-cf1a6-%' and email not like 't-cf1a6-u6@%';
insert into public.studios (id, name, slug) values (pg_temp.id('studio', 1), 'CF1 A6 Studio A', 't-cf1a6-a'), (pg_temp.id('studio', 2), 'CF1 A6 Studio B', 't-cf1a6-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.id('user', 1), pg_temp.id('studio', 1), 'studio_owner', true),
  (pg_temp.id('user', 2), pg_temp.id('studio', 1), 'studio_admin', true),
  (pg_temp.id('user', 3), pg_temp.id('studio', 1), 'front_desk', true),
  (pg_temp.id('user', 5), pg_temp.id('studio', 2), 'studio_owner', true),
  (pg_temp.id('user', 6), pg_temp.id('studio', 1), 'studio_admin', true);
-- Events: 1 normal (floor-mode live version), 4 cascade-delete event.
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
select pg_temp.id('evt', e), pg_temp.id('studio', 1), 'CF1 A6 Comp ' || e, 't-cf1a6-e' || e, 'competition', current_date + 30, current_date + 30, 'published', 'public', true
from generate_series(1, 4) e where e in (1, 4);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
select pg_temp.id('prg', e), pg_temp.id('evt', e), pg_temp.id('studio', 1), 'Callback program ' || e, 'country', 'relative', 'skating', 'configured', 'promote_callback'
from generate_series(1, 4) e where e in (1, 4);
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
select pg_temp.id('cts', e), pg_temp.id('evt', e), pg_temp.id('prg', e), 'Contest ' || e, 'single_dance', 'pro_am', 'open' from generate_series(1, 4) e where e in (1, 4);
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values
  (pg_temp.id('sv', 1), pg_temp.id('evt', 1), 1, 'V1', 'published', now()),
  (pg_temp.id('sv', 4), pg_temp.id('evt', 4), 1, 'V1', 'published', now());
-- Officials of event 1: the chair (user 4) and a judge (user 7).
insert into public.event_competition_officials (id, event_id, user_id, role, status) values
  (pg_temp.id('off', 4), pg_temp.id('evt', 1), pg_temp.id('user', 4), 'chair', 'active'),
  (pg_temp.id('off', 7), pg_temp.id('evt', 1), pg_temp.id('user', 7), 'judge', 'active');

-- Scenario builder (as A0's): division n of event e: approved callback round (src), a Final (fin) in status p_fin, p_entries entries (the first p_adv advanced),
-- a certified callback heat on floor heat n of the live version, one dance, and an approved result version with a matching input hash.
create or replace function pg_temp.mk(p_n int, p_e int default 1, p_entries int default 4, p_adv int default 3, p_fin text default 'scheduled') returns void
language plpgsql security definer as $$
declare
  v_hash text;
  v_event uuid := pg_temp.id('evt', p_e);
  v_ver uuid := pg_temp.id('sv', p_e);
  v_k int;
begin
  perform set_config('session_replication_role', 'replica', true);
  insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
  values (pg_temp.id('div', p_n), v_event, pg_temp.id('prg', p_e), pg_temp.id('cts', p_e), 'D' || p_n, 'open');
  insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
  values (pg_temp.id('src', p_n), v_event, pg_temp.id('prg', p_e), pg_temp.id('div', p_n), 'D' || p_n || ' Callback', 'preliminary', 1, 'approved', 'callback_tally', p_adv);
  insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
  values (pg_temp.id('fin', p_n), v_event, pg_temp.id('prg', p_e), pg_temp.id('div', p_n), 'D' || p_n || ' Final', 'final', 2, p_fin, 'ordinal_majority');
  for v_k in 1..p_entries loop
    insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
    values (pg_temp.id('ent', p_n, v_k), v_event, pg_temp.id('prg', p_e), pg_temp.id('div', p_n), 'e' || p_n || '-' || v_k, 'confirmed', 'eligible', (p_n * 100 + v_k)::text);
  end loop;
  insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values (pg_temp.id('cbf', p_n), v_event, v_ver, p_n);
  insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
  values (pg_temp.id('cbh', p_n), v_event, pg_temp.id('div', p_n), pg_temp.id('src', p_n), 1, 'complete', 'certified', pg_temp.id('cts', p_e), v_ver, pg_temp.id('cbf', p_n));
  insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number) values (v_event, pg_temp.id('cbh', p_n), 'waltz', 'Waltz', 1);
  insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
  select v_event, pg_temp.id('div', p_n), pg_temp.id('cbh', p_n), pg_temp.id('ent', p_n, k), k, 'danced' from generate_series(1, p_entries) k;
  select public._compf2_input_hash(pg_temp.id('src', p_n), 'callback_tally', '1') into v_hash;
  insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
  values (pg_temp.id('rv', p_n), v_event, pg_temp.id('src', p_n), 1, 'callback_tally', '1', v_hash, repeat(md5('t' || p_n), 2), '{}', '[]', pg_temp.id('user', 1), 'approved', pg_temp.id('req-rv', p_n));
  insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, advanced, output)
  select v_event, pg_temp.id('rv', p_n), pg_temp.id('ent', p_n, k), k <= p_adv, jsonb_build_object('tally', 10 - k) from generate_series(1, p_entries) k;
  perform set_config('session_replication_role', 'origin', true);
end $$;
grant execute on function pg_temp.mk(int, int, int, int, text) to authenticated, anon, service_role;

--  1 happy path, chair co-sign, minimum, start, post-start | 2 guard playground | 3 already-scratched (U49) | 4 carried-couple sequence (U48, U62)
--  5 withdrawal between revoke and apply | 6 lifecycle refusals | 7 reinstatement with an active heat | 8 event cascade (event 4)
select pg_temp.mk(1, 1, 5, 4);
select pg_temp.mk(2, 1, 5, 4);
select pg_temp.mk(3);
select pg_temp.mk(4);
select pg_temp.mk(5);
select pg_temp.mk(6);
select pg_temp.mk(7);
select pg_temp.mk(8, 4, 4, 4);
select pg_temp.mk(9);
-- fixture only: a 12-couple Final exceeds the default capacity guard, so the guard is off for this one insert
alter table public.event_competition_rounds disable trigger cf1_guard_callback_target_capacity;
select pg_temp.mk(10, 1, 12, 12);
alter table public.event_competition_rounds enable always trigger cf1_guard_callback_target_capacity;
select pg_temp.mk(11);
select pg_temp.mk(12);

-- ============================================================================
-- 1. Catalogue: grants, ENABLE ALWAYS, VOLATILE, search_path, RLS
-- ============================================================================
select pg_temp.chk('guard trigger is ENABLE ALWAYS (fires under session_replication_role = replica)',
  (select t.tgenabled = 'A' from pg_trigger t where t.tgname = 'cf1_guard_withdrawn_heat_entry' and t.tgrelid = 'public.event_competition_heat_entries'::regclass));
select pg_temp.chk('guard trigger is BEFORE INSERT OR UPDATE OF status, entry_id, heat_id OR DELETE (row level)',
  (select t.tgtype & 1 = 1 and t.tgtype & 2 = 2 and t.tgtype & 4 = 4 and t.tgtype & 8 = 8 and t.tgtype & 16 = 16
          and (select array_agg(a.attname order by a.attname) from unnest(t.tgattr) k join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = k) = array['entry_id', 'heat_id', 'status']::name[]
   from pg_trigger t where t.tgname = 'cf1_guard_withdrawn_heat_entry'));
select pg_temp.chk('U51: the guard function is VOLATILE, SECURITY DEFINER, search_path = public, pg_temp, no swallow of errors',
  (select p.provolatile = 'v' and p.prosecdef and p.proconfig @> array['search_path=public, pg_temp'] and position('when others' in lower(p.prosrc)) = 0
   from pg_proc p where p.proname = 'cf1_guard_withdrawn_heat_entry' and p.pronamespace = 'public'::regnamespace));
select pg_temp.chk('every A6 function is SECURITY DEFINER with the fixed search_path',
  (select count(*) = 14 and bool_and(p.prosecdef and p.proconfig @> array['search_path=public, pg_temp'])
   from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '\_cf1\_a6\_%' or p.proname in ('cf1_guard_withdrawn_heat_entry', 'withdraw_advanced_entry_from_final',
        'reinstate_withdrawn_entry_to_final', 'cosign_final_withdrawal_request', 'competition_final_withdrawal_state'))));
select pg_temp.chk('the four RPCs: execute for authenticated, none for anon / public / service_role',
  (select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('service_role', f, 'execute'))
   from unnest(array['public.withdraw_advanced_entry_from_final(uuid,uuid,text,uuid)'::regprocedure, 'public.reinstate_withdrawn_entry_to_final(uuid,uuid,text,uuid)'::regprocedure,
                     'public.cosign_final_withdrawal_request(uuid)'::regprocedure, 'public.competition_final_withdrawal_state(uuid)'::regprocedure]) f));
select pg_temp.chk('helpers, request function and guard: no execute grant for anon / authenticated / service_role (U70 style)',
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '\_cf1\_a6\_%' or p.proname = 'cf1_guard_withdrawn_heat_entry')
              and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))));
select pg_temp.chk('request table: RLS on, no policy, no grant for public / anon / authenticated / service_role, history triggers ENABLE ALWAYS',
  (select c.relrowsecurity from pg_class c where c.oid = 'public.event_competition_final_withdrawal_requests'::regclass)
  and not exists (select 1 from pg_policies where tablename = 'event_competition_final_withdrawal_requests')
  and not exists (select 1 from information_schema.role_table_grants g where g.table_name = 'event_competition_final_withdrawal_requests' and g.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role'))
  and (select count(*) = 2 and bool_and(t.tgenabled = 'A') from pg_trigger t where t.tgrelid = 'public.event_competition_final_withdrawal_requests'::regclass and t.tgname like 'protect_%'));
select pg_temp.chk('withdrawals table (A0): RLS on, no grants',
  not exists (select 1 from information_schema.role_table_grants g where g.table_name = 'event_competition_final_withdrawals' and g.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')));

-- ============================================================================
-- 2. Scenario 1: authorization, the two halves, replay, separation of duties (U63), minimum (OD-15 A), start, post-start
-- ============================================================================
set role authenticated;
select pg_temp.as_user(1);
select pg_temp.chk('scenario 1 applies (4 advanced of 5)', pg_temp.code(pg_temp.ap(1, 1)) = 'OK', pg_temp.ap(1, 1)::text);
reset role;
select pg_temp.chk('apply built a Final heat with 4 heat entries', (select count(*) = 4 from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id where h.round_id = pg_temp.id('fin', 1)));

-- anon cannot even call
select pg_temp.as_anon();
select pg_temp.expect_msg('anon: withdraw refused', format($q$select public.withdraw_advanced_entry_from_final(%L, %L, 'the couple asked to leave the final', %L)$q$, pg_temp.id('fin', 1), pg_temp.id('ent', 1, 1), pg_temp.id('rq', 99)), 'permission denied', '42501');
select pg_temp.expect_msg('anon: co-sign refused', format($q$select public.cosign_final_withdrawal_request(%L)$q$, pg_temp.id('rq', 99)), 'permission denied', '42501');
reset role;
select pg_temp.chk('U63: a front-desk user cannot request', pg_temp.code(pg_temp.req('withdraw', 1, 1, 3, 90)) = 'COMP_FORBIDDEN', pg_temp.req('withdraw', 1, 1, 3, 90)::text);
select pg_temp.chk('U63: the manager of another studio cannot request', pg_temp.code(pg_temp.req('withdraw', 1, 1, 5, 91)) = 'COMP_FORBIDDEN');
select pg_temp.chk('U63: the chair cannot REQUEST (requester is a manager)', pg_temp.code(pg_temp.req('withdraw', 1, 1, 4, 92)) = 'COMP_FORBIDDEN');
select pg_temp.chk('U63: a judge cannot request', pg_temp.code(pg_temp.req('withdraw', 1, 1, 7, 93)) = 'COMP_FORBIDDEN');
select pg_temp.chk('U63: a manager without a verified email cannot request', pg_temp.code(pg_temp.req('withdraw', 1, 1, 6, 94)) = 'COMP_FORBIDDEN');
reset role;
select pg_temp.chk('no request row was written by any refusal', (select count(*) = 0 from public.event_competition_final_withdrawal_requests));
select pg_temp.as_user(1);
select pg_temp.chk('a non-Final (callback) round is refused', pg_temp.code(pg_temp.try(format($q$select public.withdraw_advanced_entry_from_final(%L, %L, 'the couple asked to leave the final', %L)$q$, pg_temp.id('src', 1), pg_temp.id('ent', 1, 1), pg_temp.id('rq', 95)))) in ('COMP_WITHDRAWAL_NOT_CALLBACK_FINAL'));
select pg_temp.as_user(1);
select pg_temp.chk('a weak reason is COMP_WITHDRAWAL_REASON_WEAK', pg_temp.code(pg_temp.req('withdraw', 1, 1, 1, 96, 'bad')) = 'COMP_WITHDRAWAL_REASON_WEAK');
select pg_temp.chk('a missing request id is COMP_REQUEST_ID_REQUIRED', pg_temp.code(pg_temp.try(format($q$select public.withdraw_advanced_entry_from_final(%L, %L, 'the couple asked to leave the final', null)$q$, pg_temp.id('fin', 1), pg_temp.id('ent', 1, 1)))) = 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.chk('a couple that was not advanced (entry 5) is NOT_ON_ROSTER', pg_temp.code(pg_temp.req('withdraw', 1, 5, 1, 97)) = 'COMP_WITHDRAWAL_NOT_ON_ROSTER');
select pg_temp.chk('a couple of another division is NOT_ON_ROSTER', pg_temp.code(pg_temp.try(format($q$select public.withdraw_advanced_entry_from_final(%L, %L, 'the couple asked to leave the final', %L)$q$, pg_temp.id('fin', 1), pg_temp.id('ent', 2, 1), pg_temp.id('rq', 98)))) = 'COMP_WITHDRAWAL_NOT_ON_ROSTER');

-- the requester's half, replay
select pg_temp.chk('request: pending (first call, not a replay)', (pg_temp.req('withdraw', 1, 1, 1, 11) ->> 'state') = 'pending');
reset role;
select pg_temp.chk('request: one request row, no withdrawal row, the heat entry is untouched (U75 style replay wrote nothing twice)',
  (select count(*) = 1 from public.event_competition_final_withdrawal_requests) and (select count(*) = 0 from public.event_competition_final_withdrawals) and pg_temp.hes(1, 1) = 'scheduled');
select pg_temp.chk('replay: the same request again is replayed / pending', (pg_temp.req('withdraw', 1, 1, 1, 11) ->> 'replayed') = 'true');
select pg_temp.chk('replay: the same id for another couple is COMP_REQUEST_REUSED', pg_temp.code(pg_temp.req('withdraw', 1, 2, 1, 11)) = 'COMP_REQUEST_REUSED');
select pg_temp.chk('replay: the same id by another manager is COMP_REQUEST_REUSED', pg_temp.code(pg_temp.req('withdraw', 1, 1, 2, 11)) = 'COMP_REQUEST_REUSED');
select pg_temp.chk('replay: the same id as a reinstatement is COMP_REQUEST_REUSED', pg_temp.code(pg_temp.req('reinstate', 1, 1, 1, 11)) = 'COMP_REQUEST_REUSED');
reset role;
select pg_temp.chk('replay refusals wrote nothing', (select count(*) = 1 from public.event_competition_final_withdrawal_requests));

-- U63 co-sign refusals
select pg_temp.chk('U63: the requester cannot co-sign (same person)', pg_temp.code(pg_temp.cos(1, 11)) = 'COMP_WITHDRAWAL_COSIGN_SAME_PERSON', pg_temp.cos(1, 11)::text);
select pg_temp.chk('U63: a front-desk user cannot co-sign', pg_temp.code(pg_temp.cos(3, 11)) = 'COMP_FORBIDDEN');
select pg_temp.chk('U63: another studio''s manager cannot co-sign', pg_temp.code(pg_temp.cos(5, 11)) = 'COMP_FORBIDDEN');
select pg_temp.chk('U63: a judge cannot co-sign', pg_temp.code(pg_temp.cos(7, 11)) = 'COMP_FORBIDDEN');
select pg_temp.chk('U63: a manager without a verified email cannot co-sign', pg_temp.code(pg_temp.cos(6, 11)) = 'COMP_FORBIDDEN');
select pg_temp.chk('an unknown request is COMP_WITHDRAWAL_REQUEST_NOT_FOUND', pg_temp.code(pg_temp.cos(2, 77)) = 'COMP_WITHDRAWAL_REQUEST_NOT_FOUND');
reset role;
select pg_temp.chk('no refusal wrote a withdrawal row or touched the heat entry', (select count(*) = 0 from public.event_competition_final_withdrawals) and pg_temp.hes(1, 1) = 'scheduled');

-- the co-sign by a second manager
select pg_temp.chk('U37/U63: a second manager co-signs; row written, role manager', pg_temp.code(pg_temp.cos(2, 11)) = 'OK' and (pg_temp.cos(2, 11) ->> 'replayed') = 'true', pg_temp.cos(2, 11)::text);
reset role;
select pg_temp.chk('U37: the withdrawal row: seq 1, withdraw, requester user 1, co-signer user 2, role manager, request id, this transaction, prior scheduled, linked heat entry',
  (select count(*) = 1 and bool_and(w.seq = 1 and w.kind = 'withdraw' and w.requested_by = pg_temp.id('user', 1) and w.cosigned_by = pg_temp.id('user', 2) and w.cosigned_role = 'manager'
                                    and w.request_id = pg_temp.id('rq', 11) and w.prior_heat_entry_status = 'scheduled' and w.heat_entry_id is not null)
   from public.event_competition_final_withdrawals w where w.target_round_id = pg_temp.id('fin', 1) and w.entry_id = pg_temp.id('ent', 1, 1)));
select pg_temp.chk('U37: only the couple''s Final heat entry was scratched; the other three are untouched; the callback heat entry, the entry and its eligibility are unchanged',
  pg_temp.hes(1, 1) = 'scratched' and pg_temp.hes(1, 2) = 'scheduled' and pg_temp.hes(1, 3) = 'scheduled' and pg_temp.hes(1, 4) = 'scheduled'
  and (select status = 'danced' from public.event_competition_heat_entries where heat_id = pg_temp.id('cbh', 1) and entry_id = pg_temp.id('ent', 1, 1))
  and (select status = 'confirmed' and eligibility_status = 'eligible' from public.event_competition_entries where id = pg_temp.id('ent', 1, 1)));
select pg_temp.chk('replay of the co-sign by the same person wrote no second row', (select count(*) = 1 from public.event_competition_final_withdrawals where target_round_id = pg_temp.id('fin', 1)));
select pg_temp.chk('a co-sign replay by someone else is COMP_REQUEST_REUSED', pg_temp.code(pg_temp.cos(4, 11)) = 'COMP_REQUEST_REUSED');
select pg_temp.chk('the same couple again is COMP_WITHDRAWAL_ALREADY', pg_temp.code(pg_temp.req('withdraw', 1, 1, 1, 12)) = 'COMP_WITHDRAWAL_ALREADY');
select pg_temp.as_user(1);
select pg_temp.chk('the state reader: manager sees one withdrawn couple and no pending request', (pg_temp.try(format($q$select public.competition_final_withdrawal_state(%L)$q$, pg_temp.id('fin', 1))) -> 'withdrawn' -> 0 ->> 'entry_id') = pg_temp.id('ent', 1, 1)::text
  and jsonb_array_length(pg_temp.try(format($q$select public.competition_final_withdrawal_state(%L)$q$, pg_temp.id('fin', 1))) -> 'pending') = 0);
select pg_temp.as_user(3);
select pg_temp.chk('the state reader refuses a front-desk user', pg_temp.code(pg_temp.try(format($q$select public.competition_final_withdrawal_state(%L)$q$, pg_temp.id('fin', 1)))) = 'COMP_FORBIDDEN');
reset role;

-- chair co-sign, prior checked_in
select pg_temp.su(format($q$update public.event_competition_heat_entries set status = 'checked_in' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 1, 2), pg_temp.id('fin', 1)));
select pg_temp.chk('U63: the chair co-signs a second manager''s request; role chair is recorded; prior checked_in; seq 2',
  pg_temp.code(pg_temp.flow('withdraw', 1, 2, 13, 2, 4)) = 'OK' and pg_temp.hes(1, 2) = 'scratched', pg_temp.flow('withdraw', 1, 2, 13, 2, 4)::text);
reset role;
select pg_temp.chk('chair row: seq 2, cosigned_role chair, prior checked_in, requested by user 2, co-signed by user 4',
  (select w.seq = 2 and w.cosigned_role = 'chair' and w.prior_heat_entry_status = 'checked_in' and w.requested_by = pg_temp.id('user', 2) and w.cosigned_by = pg_temp.id('user', 4)
   from public.event_competition_final_withdrawals w where w.request_id = pg_temp.id('rq', 13)));
-- minimum: roster is 4, two withdrawn; a third would leave one
select pg_temp.chk('OD-15 A: a withdrawal that would leave fewer than two is COMP_ADVANCEMENT_BELOW_MINIMUM and changes nothing',
  pg_temp.code(pg_temp.req('withdraw', 1, 3, 1, 14)) = 'COMP_ADVANCEMENT_BELOW_MINIMUM' and pg_temp.hes(1, 3) = 'scheduled', pg_temp.req('withdraw', 1, 3, 1, 14)::text);
reset role;
select pg_temp.chk('OD-15 A: the refusal left no request row', (select count(*) = 0 from public.event_competition_final_withdrawal_requests where request_id = pg_temp.id('rq', 14)));
-- U41 (single session): seq 1, 2 with no gap or duplicate
select pg_temp.chk('U41: seq is 1, 2 (monotonic, duplicate-free) for the round', (select array_agg(seq order by seq) = array[1, 2]::bigint[] from public.event_competition_final_withdrawals where target_round_id = pg_temp.id('fin', 1)));
-- start passes with the recorded withdrawals
select pg_temp.expect_ok('U37/U45: the start passes (roster = advanced minus the two recorded withdrawals)', format($q$select pg_temp.su(%L)$q$, format($q$update public.event_competition_rounds set status = 'active' where id = %L$q$, pg_temp.id('fin', 1))));
select pg_temp.chk('after the start: a new withdrawal is COMP_ADVANCEMENT_FINAL_STARTED', pg_temp.code(pg_temp.req('withdraw', 1, 3, 1, 15)) = 'COMP_ADVANCEMENT_FINAL_STARTED', pg_temp.req('withdraw', 1, 3, 1, 15)::text);
select pg_temp.chk('after the start: a reinstatement is COMP_ADVANCEMENT_FINAL_STARTED (a withdrawn couple stays out)', pg_temp.code(pg_temp.req('reinstate', 1, 1, 1, 16)) = 'COMP_ADVANCEMENT_FINAL_STARTED');
reset role;
select pg_temp.expect_msg('I8 after the start: a direct un-scratch of a withdrawn couple is refused', format($q$select pg_temp.su(%L)$q$, format($q$update public.event_competition_heat_entries set status = 'checked_in' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 1, 1), pg_temp.id('fin', 1))), 'COMP_WITHDRAWAL_GUARD', '42501');

-- ============================================================================
-- 3. Scenario 7: reinstatement while the advancement is active (un-scratch to the prior status); P gate
-- ============================================================================
select pg_temp.as_user(1);
select pg_temp.chk('scenario 7 applies', pg_temp.code(pg_temp.ap(7, 7)) = 'OK');
reset role;
select pg_temp.su(format($q$update public.event_competition_heat_entries set status = 'checked_in' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 7, 2), pg_temp.id('fin', 7)));
select pg_temp.chk('U37: reinstating a couple that is not withdrawn is COMP_WITHDRAWAL_NOT_ACTIVE', pg_temp.code(pg_temp.req('reinstate', 7, 1, 1, 70)) = 'COMP_WITHDRAWAL_NOT_ACTIVE');
select pg_temp.chk('U37: withdraw couple 1 (prior scheduled) while couple 2 is checked in', pg_temp.code(pg_temp.flow('withdraw', 7, 1, 71)) = 'OK' and pg_temp.hes(7, 1) = 'scratched');
reset role;
select pg_temp.expect_msg('U37: a direct un-scratch of couple 1 is refused', format($q$select pg_temp.su(%L)$q$, format($q$update public.event_competition_heat_entries set status = 'scheduled' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 7, 1), pg_temp.id('fin', 7))), 'COMP_WITHDRAWAL_GUARD', '42501');
-- reinstate couple 1 (restores scheduled)
select pg_temp.chk('U37: the reinstatement is two-step as well, role manager, row seq 2', pg_temp.code(pg_temp.flow('reinstate', 7, 1, 72)) = 'OK', pg_temp.flow('reinstate', 7, 1, 72)::text);
reset role;
select pg_temp.chk('U37: reinstatement un-scratched to the stored prior status (scheduled), kind reinstate seq 2, heat entry referenced',
  pg_temp.hes(7, 1) = 'scheduled' and (select w.kind = 'reinstate' and w.seq = 2 and w.prior_heat_entry_status = 'scheduled' and w.heat_entry_id is not null
                                       from public.event_competition_final_withdrawals w where w.request_id = pg_temp.id('rq', 72)));
select pg_temp.chk('U37: the pair is no longer withdrawn, so a direct scratch and un-scratch is allowed again (no sticky protection)',
  public._cf1_a6_pair_state(pg_temp.id('fin', 7), pg_temp.id('ent', 7, 1)) = 'reinstate');
select pg_temp.expect_ok('direct scratch of a reinstated couple', format($q$select pg_temp.su(%L)$q$, format($q$update public.event_competition_heat_entries set status = 'scratched' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 7, 1), pg_temp.id('fin', 7))));
select pg_temp.su(format($q$update public.event_competition_heat_entries set status = 'scheduled' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 7, 1), pg_temp.id('fin', 7)));
-- P gate: couple 2 withdrawn (checked_in), made ineligible, reinstatement refused; revert, restored to checked_in
select pg_temp.chk('withdraw couple 2 (prior checked_in)', pg_temp.code(pg_temp.flow('withdraw', 7, 2, 73)) = 'OK');
select pg_temp.su(format($q$update public.event_competition_entries set eligibility_status = 'ineligible' where id = %L$q$, pg_temp.id('ent', 7, 2)));
select pg_temp.chk('P gate: an ineligible couple cannot be reinstated (COMP_WITHDRAWAL_ENTRY_UNAVAILABLE)', pg_temp.code(pg_temp.req('reinstate', 7, 2, 1, 74)) = 'COMP_WITHDRAWAL_ENTRY_UNAVAILABLE', pg_temp.req('reinstate', 7, 2, 1, 74)::text);
select pg_temp.su(format($q$update public.event_competition_entries set eligibility_status = 'eligible' where id = %L$q$, pg_temp.id('ent', 7, 2)));
select pg_temp.chk('P gate: once eligible again the reinstatement restores the stored prior status checked_in', pg_temp.code(pg_temp.flow('reinstate', 7, 2, 75)) = 'OK' and pg_temp.hes(7, 2) = 'checked_in', pg_temp.flow('reinstate', 7, 2, 75)::text);
reset role;
select pg_temp.chk('U41 (single session): seq per round is 1..4 for scenario 7', (select array_agg(seq order by seq) = array[1, 2, 3, 4]::bigint[] from public.event_competition_final_withdrawals where target_round_id = pg_temp.id('fin', 7)));

-- ============================================================================
-- 4. Scenario 3: U49 withdrawal against an already-scratched heat entry
-- ============================================================================
select pg_temp.as_user(1);
select pg_temp.chk('scenario 3 applies', pg_temp.code(pg_temp.ap(3, 3)) = 'OK');
reset role;
select pg_temp.su(format($q$update public.event_competition_heat_entries set status = 'scratched' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 3, 3), pg_temp.id('fin', 3)));
select pg_temp.expect_msg('U49: a direct scratch with no withdrawal row makes the start COMP_ADVANCEMENT_ROSTER_INCOMPLETE', format($q$select pg_temp.su(%L)$q$, format($q$update public.event_competition_rounds set status = 'active' where id = %L$q$, pg_temp.id('fin', 3))), 'COMP_ADVANCEMENT_ROSTER_INCOMPLETE');
select pg_temp.chk('U49: a withdrawal against the already-scratched heat entry is allowed', pg_temp.code(pg_temp.flow('withdraw', 3, 3, 31)) = 'OK', pg_temp.flow('withdraw', 3, 3, 31)::text);
reset role;
select pg_temp.chk('U49: prior status scratched, the heat entry is linked, its status did not change',
  (select w.prior_heat_entry_status = 'scratched' and w.heat_entry_id is not null from public.event_competition_final_withdrawals w where w.request_id = pg_temp.id('rq', 31)) and pg_temp.hes(3, 3) = 'scratched');
select pg_temp.chk('U49: reinstatement is refused COMP_ADVANCEMENT_REINSTATE_PRIOR_SCRATCH', pg_temp.code(pg_temp.req('reinstate', 3, 3, 1, 32)) = 'COMP_ADVANCEMENT_REINSTATE_PRIOR_SCRATCH', pg_temp.req('reinstate', 3, 3, 1, 32)::text);
reset role;
select pg_temp.expect_ok('U49: the recorded withdrawal clears ROSTER_INCOMPLETE (two couples remain)', format($q$select pg_temp.su(%L)$q$, format($q$update public.event_competition_rounds set status = 'active' where id = %L$q$, pg_temp.id('fin', 3))));

-- ============================================================================
-- 5. Scenario 4: U48 (a)/(b) and U62 -- the carried-couple sequence
-- ============================================================================
select pg_temp.as_user(1);
select pg_temp.chk('scenario 4: generation 1 applies', pg_temp.code(pg_temp.ap(4, 41)) = 'OK');
reset role;
select pg_temp.chk('scenario 4: withdraw couple 1 from generation 1', pg_temp.code(pg_temp.flow('withdraw', 4, 1, 41)) = 'OK' and pg_temp.hes(4, 1) = 'scratched');
select pg_temp.as_user(1);
select pg_temp.expect_ok('scenario 4: the correction is allowed and revokes generation 1 (the withdrawn couple is on the roster but carried)',
  format($q$select public.open_competition_round_correction(%L, 'judge error found in the callback', %L)$q$, pg_temp.id('src', 4), pg_temp.id('c', 41)));
reset role;
select pg_temp.chk('scenario 4: generation 1 is revoked, its heat is cancelled, the scratched row sits on the cancelled heat',
  public._cf1_active_advancement(pg_temp.id('fin', 4)) is null and (select bool_and(h.status = 'cancelled') from public.event_competition_heats h where h.round_id = pg_temp.id('fin', 4))
  and pg_temp.hes(4, 1) = 'none');
select pg_temp.regen(4, 2, array[1, 2, 3]);
select set_config('cf1a6.r', pg_temp.ap(4, 42)::text, false);
reset role;
select pg_temp.chk('scenario 4: generation 2 applies and carries couple 1 (no heat entry; flagged with the withdrawal id)',
  pg_temp.code(current_setting('cf1a6.r')::jsonb) = 'OK' and pg_temp.hes(4, 1) = 'none'
  and (select count(*) = 1 from public.event_competition_round_advancement_entries ae join public.event_competition_round_advancements a on a.id = ae.advancement_id
       where a.target_round_id = pg_temp.id('fin', 4) and a.generation = 2 and ae.entry_id = pg_temp.id('ent', 4, 1) and ae.carried_withdrawal_id is not null), current_setting('cf1a6.r'));
select pg_temp.chk('U48(a): while generation 2''s Final heat is active the reinstatement is refused COMP_ADVANCEMENT_REINSTATE_NO_HEAT_ENTRY',
  pg_temp.code(pg_temp.req('reinstate', 4, 1, 1, 42)) = 'COMP_ADVANCEMENT_REINSTATE_NO_HEAT_ENTRY', pg_temp.req('reinstate', 4, 1, 1, 42)::text);
reset role;
select pg_temp.chk('U48(a): nothing was written (no heat entry inserted, no row)', (select count(*) = 1 from public.event_competition_final_withdrawals where target_round_id = pg_temp.id('fin', 4)) and pg_temp.hes(4, 1) = 'none');
select pg_temp.as_user(1);
select pg_temp.expect_ok('scenario 4: a second authorized correction revokes generation 2',
  format($q$select public.open_competition_round_correction(%L, 'second judge error found in the callback', %L)$q$, pg_temp.id('src', 4), pg_temp.id('c', 42)));
reset role;
select pg_temp.chk('scenario 4: generation 2 is revoked', public._cf1_active_advancement(pg_temp.id('fin', 4)) is null);
-- snapshot of every heat entry of the Final before the reinstatement
select set_config('cf1a6.digest4', pg_temp.hedigest(4), false);
select set_config('cf1a6.he4', (select count(*)::text from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id where h.round_id = pg_temp.id('fin', 4)), false);
select set_config('cf1a6.wd4', (select count(*)::text from public.event_competition_final_withdrawals where target_round_id = pg_temp.id('fin', 4)), false);
select pg_temp.chk('U48(b)/U62: after the revoke the reinstatement is accepted (two-step)', pg_temp.code(pg_temp.flow('reinstate', 4, 1, 43)) = 'OK', pg_temp.flow('reinstate', 4, 1, 43)::text);
reset role;
select pg_temp.chk('U62: the reinstatement wrote exactly one row (the reinstatement row, no heat entry reference)',
  (select count(*) from public.event_competition_final_withdrawals where target_round_id = pg_temp.id('fin', 4))::text = (current_setting('cf1a6.wd4')::int + 1)::text
  and (select w.kind = 'reinstate' and w.heat_entry_id is null and w.prior_heat_entry_status is null and w.seq = 2 from public.event_competition_final_withdrawals w where w.request_id = pg_temp.id('rq', 43)));
select pg_temp.chk('U62: no heat entry changed or was added anywhere in the Final (digest and count identical, the cancelled heat untouched)',
  pg_temp.hedigest(4) = current_setting('cf1a6.digest4')
  and (select count(*)::text from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id where h.round_id = pg_temp.id('fin', 4)) = current_setting('cf1a6.he4'));
select pg_temp.regen(4, 3, array[1, 2, 3]);
select set_config('cf1a6.r', pg_temp.ap(4, 43)::text, false);
reset role;
select pg_temp.chk('U48(b): generation 3 applies and includes the reinstated couple with its own heat entry (not carried)',
  pg_temp.code(current_setting('cf1a6.r')::jsonb) = 'OK' and pg_temp.hes(4, 1) = 'scheduled'
  and (select ae.carried_withdrawal_id is null from public.event_competition_round_advancement_entries ae join public.event_competition_round_advancements a on a.id = ae.advancement_id
       where a.target_round_id = pg_temp.id('fin', 4) and a.generation = 3 and ae.entry_id = pg_temp.id('ent', 4, 1)), current_setting('cf1a6.r'));
reset role;
select pg_temp.chk('U48(b): after the reinstatement the old scratched row stays scratched in the cancelled heat (history)', exists (
  select 1 from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
  where h.round_id = pg_temp.id('fin', 4) and h.status = 'cancelled' and he.entry_id = pg_temp.id('ent', 4, 1) and he.status = 'scratched'));

-- ============================================================================
-- 6. Scenario 5: a withdrawal between a revoke and the next apply (no heat), with the ineligible-couple dead end
-- ============================================================================
select pg_temp.as_user(1);
select pg_temp.chk('scenario 5: generation 1 applies', pg_temp.code(pg_temp.ap(5, 51)) = 'OK');
select pg_temp.expect_ok('scenario 5: correction revokes generation 1', format($q$select public.open_competition_round_correction(%L, 'judge error found in the callback', %L)$q$, pg_temp.id('src', 5), pg_temp.id('c', 51)));
reset role;
select set_config('cf1a6.digest5', pg_temp.hedigest(5), false);
select pg_temp.chk('4.4: a withdrawal between the revoke and the next apply is accepted with no active advancement (row only)', pg_temp.code(pg_temp.flow('withdraw', 5, 2, 51)) = 'OK', pg_temp.flow('withdraw', 5, 2, 51)::text);
reset role;
select pg_temp.chk('4.4: that row has no heat entry reference, prior status null, and the cancelled heat is untouched',
  (select w.heat_entry_id is null and w.prior_heat_entry_status is null from public.event_competition_final_withdrawals w where w.request_id = pg_temp.id('rq', 51)) and pg_temp.hedigest(5) = current_setting('cf1a6.digest5'));
select pg_temp.chk('OD-15 A between revoke and apply: a second withdrawal would leave one couple and is refused', pg_temp.code(pg_temp.req('withdraw', 5, 3, 1, 52)) = 'COMP_ADVANCEMENT_BELOW_MINIMUM', pg_temp.req('withdraw', 5, 3, 1, 52)::text);
reset role;
select pg_temp.su(format($q$update public.event_competition_entries set eligibility_status = 'ineligible' where id = %L$q$, pg_temp.id('ent', 5, 2)));
select pg_temp.regen(5, 2, array[1, 2, 3]);
select pg_temp.chk('4.4 dead end gone: the ineligible, withdrawn couple does not block generation 2 (carried, not validated)', pg_temp.code(pg_temp.ap(5, 52)) = 'OK' and pg_temp.hes(5, 2) = 'none', pg_temp.ap(5, 52)::text);
reset role;
select pg_temp.su(format($q$update public.event_competition_entries set eligibility_status = 'eligible' where id = %L$q$, pg_temp.id('ent', 5, 2)));

-- ============================================================================
-- 7. Scenario 6: lifecycle refusals at the request and again at the co-sign
-- ============================================================================
select pg_temp.as_user(1);
select pg_temp.chk('scenario 6 applies', pg_temp.code(pg_temp.ap(6, 6)) = 'OK');
reset role;
select pg_temp.su(format($q$update public.event_competition_heats set lock_state = 'locked' where round_id = %L and status <> 'cancelled'$q$, pg_temp.id('fin', 6)));
select pg_temp.chk('a locked Final heat is COMP_ADVANCEMENT_FINAL_LOCKED', pg_temp.code(pg_temp.req('withdraw', 6, 1, 1, 60)) = 'COMP_ADVANCEMENT_FINAL_LOCKED', pg_temp.req('withdraw', 6, 1, 1, 60)::text);
reset role;
select pg_temp.su(format($q$update public.event_competition_heats set lock_state = 'open' where round_id = %L$q$, pg_temp.id('fin', 6)));
select pg_temp.su(format($q$update public.event_competition_heats set status = 'active' where round_id = %L and status <> 'cancelled'$q$, pg_temp.id('fin', 6)));
select pg_temp.chk('a started (active) Final heat is COMP_ADVANCEMENT_FINAL_STARTED', pg_temp.code(pg_temp.req('withdraw', 6, 1, 1, 61)) = 'COMP_ADVANCEMENT_FINAL_STARTED');
reset role;
select pg_temp.su(format($q$update public.event_competition_heats set status = 'scheduled' where round_id = %L and status <> 'cancelled'$q$, pg_temp.id('fin', 6)));
-- request while allowed, then the state changes before the co-sign
select pg_temp.chk('a request is accepted while the Final is open', (pg_temp.req('withdraw', 6, 1, 1, 63) ->> 'state') = 'pending');
reset role;
select pg_temp.su(format($q$update public.event_competition_rounds set status = 'active' where id = %L$q$, pg_temp.id('fin', 6)));
select pg_temp.chk('the co-sign revalidates under the locks: the started Final refuses it', pg_temp.code(pg_temp.cos(2, 63)) = 'COMP_ADVANCEMENT_FINAL_STARTED', pg_temp.cos(2, 63)::text);
reset role;
select pg_temp.chk('the refused co-sign wrote no withdrawal and left the heat entry', (select count(*) = 0 from public.event_competition_final_withdrawals where target_round_id = pg_temp.id('fin', 6)) and pg_temp.hes(6, 1) = 'scheduled');
select pg_temp.su(format($q$update public.event_competition_rounds set status = 'draft' where id = %L$q$, pg_temp.id('fin', 6)));
select pg_temp.chk('a draft Final accepts the co-sign', pg_temp.code(pg_temp.cos(2, 63)) = 'OK', pg_temp.cos(2, 63)::text);
reset role;
-- a ballot on the Final
select pg_temp.su(format($q$insert into public.event_competition_ballots (id, event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by)
  select %L, %L, %L, h.id, %L, 'ordinal_rank', 1, 1, 'judge_web', %L from public.event_competition_heats h where h.round_id = %L and h.status <> 'cancelled'$q$,
  pg_temp.id('bal', 6), pg_temp.id('evt', 1), pg_temp.id('fin', 6), pg_temp.id('off', 7), pg_temp.id('user', 7), pg_temp.id('fin', 6)));
select pg_temp.chk('a Final ballot is COMP_WITHDRAWAL_BALLOTS', pg_temp.code(pg_temp.req('withdraw', 6, 2, 1, 62)) = 'COMP_WITHDRAWAL_BALLOTS', pg_temp.req('withdraw', 6, 2, 1, 62)::text);
reset role;
reset role;

-- ============================================================================
-- 7b. Scenarios 9 and 10 (review fixes): approved-version roster (M1), request binding and requester revalidation (M2), duplicates and cap (Low-1)
-- ============================================================================
select pg_temp.as_user(1);
select pg_temp.chk('scenario 9 applies', pg_temp.code(pg_temp.ap(9, 91)) = 'OK');
reset role;
select pg_temp.chk('M2: a request is bound to the active advancement (advancement_id stored)', (pg_temp.req('withdraw', 9, 1, 1, 91) ->> 'state') = 'pending');
reset role;
select pg_temp.chk('M2: the stored advancement_id is the active one', (select q.advancement_id = public._cf1_active_advancement(pg_temp.id('fin', 9)) from public.event_competition_final_withdrawal_requests q where q.request_id = pg_temp.id('rq', 91)));
select pg_temp.chk('Low-1: a second live request for the same couple and kind (other request id) is COMP_WITHDRAWAL_REQUEST_PENDING', pg_temp.code(pg_temp.req('withdraw', 9, 1, 2, 92)) = 'COMP_WITHDRAWAL_REQUEST_PENDING', pg_temp.req('withdraw', 9, 1, 2, 92)::text);
select pg_temp.chk('Low-1: the same request id is still a replay', (pg_temp.req('withdraw', 9, 1, 1, 91) ->> 'replayed') = 'true');
select pg_temp.chk('Low-1: another couple is not blocked', (pg_temp.req('withdraw', 9, 2, 1, 93) ->> 'state') = 'pending');
-- M2: the requester loses the manager role / the verified email before the co-sign
select pg_temp.chk('M2 setup: user 2 requests couple 3', (pg_temp.req('withdraw', 9, 3, 2, 94) ->> 'state') = 'pending');
reset role;
select pg_temp.su(format($q$update public.user_studio_roles set active = false where user_id = %L$q$, pg_temp.id('user', 2)));
select pg_temp.chk('M2: a requester who is no longer a manager makes the co-sign COMP_WITHDRAWAL_REQUESTER_INVALID', pg_temp.code(pg_temp.cos(1, 94)) = 'COMP_WITHDRAWAL_REQUESTER_INVALID', pg_temp.cos(1, 94)::text);
reset role;
select pg_temp.su(format($q$update public.user_studio_roles set active = true where user_id = %L$q$, pg_temp.id('user', 2)));
select pg_temp.su(format($q$delete from public.verified_email_identities where user_id = %L$q$, pg_temp.id('user', 2)));
select pg_temp.chk('M2: a requester whose email is no longer verified makes the co-sign COMP_WITHDRAWAL_REQUESTER_INVALID', pg_temp.code(pg_temp.cos(1, 94)) = 'COMP_WITHDRAWAL_REQUESTER_INVALID', pg_temp.cos(1, 94)::text);
reset role;
select pg_temp.su(format($q$insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
  select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id = %L$q$, pg_temp.id('user', 2)));
select pg_temp.chk('M2: with the requester valid again the co-sign of request 94 succeeds', pg_temp.code(pg_temp.cos(1, 94)) = 'OK', pg_temp.cos(1, 94)::text);
reset role;
-- M2: the Final is corrected after the request (the bound advancement changes)
select pg_temp.as_user(1);
select pg_temp.expect_ok('scenario 9: correction revokes generation 1', format($q$select public.open_competition_round_correction(%L, 'judge error found in the callback', %L)$q$, pg_temp.id('src', 9), pg_temp.id('c', 91)));
reset role;
select pg_temp.chk('M2: a request made against generation 1 is COMP_WITHDRAWAL_REQUEST_STALE after the revoke', pg_temp.code(pg_temp.cos(2, 91)) = 'COMP_WITHDRAWAL_REQUEST_STALE', pg_temp.cos(2, 91)::text);
reset role;
select pg_temp.chk('Low-1: the reader flags the stale request', (select bool_or((x ->> 'stale')::boolean) from jsonb_array_elements(pg_temp.state_probe(pg_temp.id('fin', 9))) x where x ->> 'request_id' = pg_temp.id('rq', 91)::text));
-- M1: a newer, non-approved version that marks couple 4 advanced must not widen the roster. Chain-independent: F2's unique live index allows one calculated/approved version per round, so the newer version is 'stale' (non-live) and the older approved version is restored.
select pg_temp.su(format($q$update public.event_competition_result_versions set status = 'approved' where id = %L$q$, pg_temp.id('rv', 9)));
select pg_temp.su(format($q$insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
  values (%L, %L, %L, 2, 'callback_tally', '1', %L, %L, '{}', '[]', %L, 'stale', %L)$q$, pg_temp.id('rvu', 9), pg_temp.id('evt', 1), pg_temp.id('src', 9), repeat('c', 64), repeat('d', 64), pg_temp.id('user', 1), pg_temp.id('req-rvu', 9)));
select pg_temp.su(format($q$insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, advanced, output) select %L, %L, pg_temp.id('ent', 9, k), k <= 4, '{}' from generate_series(1, 4) k$q$, pg_temp.id('evt', 1), pg_temp.id('rvu', 9)));
select pg_temp.chk('M1: the roster is the latest APPROVED version (3 couples), not the newer stale one that marks 4 advanced', cardinality(public._cf1_a6_current_roster(pg_temp.id('fin', 9))) = 3, public._cf1_a6_current_roster(pg_temp.id('fin', 9))::text);
select pg_temp.chk('Low-1: the stale request no longer blocks a new one (the request reaches the precheck: couple 3 is already withdrawn, so BELOW_MINIMUM, not REQUEST_PENDING)', pg_temp.code(pg_temp.req('withdraw', 9, 1, 1, 95)) = 'COMP_ADVANCEMENT_BELOW_MINIMUM', pg_temp.req('withdraw', 9, 1, 1, 95)::text);
reset role;
select pg_temp.chk('M1/OD-15 A: a second withdrawal is BELOW_MINIMUM (approved roster 3, one already withdrawn; the unapproved version would have allowed it)', pg_temp.code(pg_temp.req('withdraw', 9, 2, 1, 96)) = 'COMP_ADVANCEMENT_BELOW_MINIMUM', pg_temp.req('withdraw', 9, 2, 1, 96)::text);
select pg_temp.chk('M1: a couple advanced only by the unapproved version is NOT_ON_ROSTER', pg_temp.code(pg_temp.req('withdraw', 9, 4, 1, 97)) = 'COMP_WITHDRAWAL_NOT_ON_ROSTER', pg_temp.req('withdraw', 9, 4, 1, 97)::text);
reset role;
-- Low-1 cap: 10 live requests per round, the 11th is refused
select set_config('cf1a6.cap', (select string_agg(pg_temp.req('withdraw', 10, k, 1, 100 + k) ->> 'state', ',') from generate_series(1, 10) k), false);
reset role;
select pg_temp.chk('Low-1 cap: ten live requests on a Final are accepted', current_setting('cf1a6.cap') = 'pending,pending,pending,pending,pending,pending,pending,pending,pending,pending', current_setting('cf1a6.cap'));
select pg_temp.chk('Low-1 cap: the 11th is COMP_WITHDRAWAL_TOO_MANY_PENDING', pg_temp.code(pg_temp.req('withdraw', 10, 11, 1, 111)) = 'COMP_WITHDRAWAL_TOO_MANY_PENDING', pg_temp.req('withdraw', 10, 11, 1, 111)::text);
reset role;

-- P2-1 (re-review): the null binding must not suffer an ABA. Scenario 11: request while no advancement exists (generation 0), apply, then revoke: the active advancement is null again, the generation is not.
select pg_temp.as_user(1);
select pg_temp.chk('P2-1: a request before any apply is accepted (generation 0, no advancement)', (pg_temp.req('withdraw', 11, 1, 1, 111) ->> 'state') = 'pending');
select pg_temp.chk('P2-1: it is not stale yet', not (select bool_or((x ->> 'stale')::boolean) from jsonb_array_elements(pg_temp.state_probe(pg_temp.id('fin', 11))) x));
select pg_temp.chk('P2-1: generation 1 applies', pg_temp.code(pg_temp.ap(11, 111)) = 'OK');
select pg_temp.expect_ok('P2-1: the correction revokes generation 1', format($q$select public.open_competition_round_correction(%L, 'judge error found in the callback', %L)$q$, pg_temp.id('src', 11), pg_temp.id('c', 111)));
reset role;
select pg_temp.chk('P2-1: the active advancement is null again, as when the request was made', public._cf1_active_advancement(pg_temp.id('fin', 11)) is null);
select pg_temp.chk('P2-1: the request is still STALE at the co-sign (a newer generation exists)', pg_temp.code(pg_temp.cos(2, 111)) = 'COMP_WITHDRAWAL_REQUEST_STALE', pg_temp.cos(2, 111)::text);
reset role;
select pg_temp.chk('P2-1: the reader flags it stale', (select bool_or((x ->> 'stale')::boolean) from jsonb_array_elements(pg_temp.state_probe(pg_temp.id('fin', 11))) x));
select pg_temp.chk('P3: a replay of the stale request reports state stale, not pending', (pg_temp.req('withdraw', 11, 1, 1, 111) ->> 'state') = 'stale', pg_temp.req('withdraw', 11, 1, 1, 111)::text);
reset role;
select pg_temp.chk('P2-1/Low-1: a stale request does not block or count: a new request for the same couple is accepted', (pg_temp.req('withdraw', 11, 1, 1, 112) ->> 'state') = 'pending', pg_temp.req('withdraw', 11, 1, 1, 112)::text);
reset role;

-- P2-2 (re-review): the fallback roster (a correction left no approved version). Scenario 12: withdraw a couple in that window, then the corrected version leaves that couple off the list.
select pg_temp.as_user(1);
select pg_temp.chk('P2-2: scenario 12 generation 1 applies', pg_temp.code(pg_temp.ap(12, 121)) = 'OK');
select pg_temp.expect_ok('P2-2: the correction revokes generation 1', format($q$select public.open_competition_round_correction(%L, 'judge error found in the callback', %L)$q$, pg_temp.id('src', 12), pg_temp.id('c', 121)));
reset role;
select pg_temp.chk('P2-2: no approved callback version exists in the window', not exists (select 1 from public.event_competition_result_versions rv where rv.round_id = pg_temp.id('src', 12) and rv.status = 'approved'));
select pg_temp.chk('P2-2: the fallback roster is the last applied list (3 couples)', cardinality(public._cf1_a6_current_roster(pg_temp.id('fin', 12))) = 3);
select pg_temp.chk('P2-2: a withdrawal in the window is accepted (row only)', pg_temp.code(pg_temp.flow('withdraw', 12, 2, 121)) = 'OK', pg_temp.flow('withdraw', 12, 2, 121)::text);
reset role;
select pg_temp.regen(12, 2, array[1, 3, 4]);
select pg_temp.chk('P2-2: the corrected list omits the withdrawn couple 2 and adds couple 4: generation 2 applies', pg_temp.code(pg_temp.ap(12, 122)) = 'OK', pg_temp.ap(12, 122)::text);
reset role;
select pg_temp.chk('P2-2: the withdrawn couple has no active heat entry, the others do',
  pg_temp.hes(12, 2) = 'none' and pg_temp.hes(12, 1) <> 'none' and pg_temp.hes(12, 3) <> 'none' and pg_temp.hes(12, 4) <> 'none',
  pg_temp.hes(12, 1) || ',' || pg_temp.hes(12, 2) || ',' || pg_temp.hes(12, 3) || ',' || pg_temp.hes(12, 4));

-- ============================================================================
-- 8. Scenario 2: the guard (U39) with every trigger, then in isolation; replica role (U52); evidence immutability
-- ============================================================================
select pg_temp.as_user(1);
select pg_temp.chk('scenario 2 applies', pg_temp.code(pg_temp.ap(2, 2)) = 'OK');
reset role;
select pg_temp.chk('scenario 2: withdraw couple 1', pg_temp.code(pg_temp.flow('withdraw', 2, 1, 21)) = 'OK' and pg_temp.hes(2, 1) = 'scratched');
reset role;
-- composed: every role, every direct write is refused (any trigger), the row is unchanged afterwards
select pg_temp.as_user(1);
select pg_temp.expect_msg('U39: as authenticated: status moves out of scratched (scheduled)', format($q$update public.event_competition_heat_entries set status = 'scheduled' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_msg('U39: as authenticated: status moves out of scratched (checked_in)', format($q$update public.event_competition_heat_entries set status = 'checked_in' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_msg('U39: as authenticated: status moves out of scratched (danced)', format($q$update public.event_competition_heat_entries set status = 'danced' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_msg('U39: as authenticated: delete of the scratched row is refused', format($q$delete from public.event_competition_heat_entries where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_msg('U39: as authenticated: an entry_id change of the withdrawn pair''s row is refused', format($q$update public.event_competition_heat_entries set entry_id = %L where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 5), pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), '', '42501');
select pg_temp.expect_msg('U39: as authenticated: a heat_id change of the withdrawn pair''s row is refused', format($q$update public.event_competition_heat_entries set heat_id = %L where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('cbh', 2), pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), '', null);
select pg_temp.expect_ok('(control) a status-only scratch of a NOT withdrawn couple in the same Final is still a plain direct write', format($q$update public.event_competition_heat_entries set status = 'checked_in' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 2), pg_temp.id('fin', 2)));
reset role;
-- service_role
set role service_role;
select pg_temp.expect_msg('U39: as service_role: un-scratch is refused', format($q$update public.event_competition_heat_entries set status = 'scheduled' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_msg('U39: as service_role: delete is refused', format($q$delete from public.event_competition_heat_entries where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
reset role;
select pg_temp.chk('U39: after all those attempts the withdrawn couple''s row is still scratched and unmoved', pg_temp.hes(2, 1) = 'scratched');
-- the superuser (table-owner-like) is covered by a row trigger too (only DISABLE TRIGGER / replica-without-ALWAYS / TRUNCATE are residual)
select pg_temp.expect_msg('U39: a superuser session is refused as well (triggers fire for every role)', format($q$update public.event_competition_heat_entries set status = 'scheduled' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
-- U52: replica role
set session_replication_role = replica;
select pg_temp.expect_msg('U52: under session_replication_role = replica the guard still fires (ENABLE ALWAYS)', format($q$update public.event_competition_heat_entries set status = 'scheduled' where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_msg('U52: under replica the delete is refused too', format($q$delete from public.event_competition_heat_entries where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
set session_replication_role = origin;
select pg_temp.blocked('U52: TRUNCATE of the heat entry table (not covered by a row trigger; hosted privilege is U46, A1)', 'no row trigger sees TRUNCATE; the FK from the withdrawals table makes a plain TRUNCATE fail locally, which is a side effect, not the guard');
-- evidence immutability
select pg_temp.expect_msg('evidence: UPDATE of a withdrawal row is refused', format($q$update public.event_competition_final_withdrawals set reason = 'changed afterwards' where request_id = %L$q$, pg_temp.id('rq', 21)), 'append-only');
select pg_temp.expect_msg('evidence: DELETE of a withdrawal row is refused', format($q$delete from public.event_competition_final_withdrawals where request_id = %L$q$, pg_temp.id('rq', 21)), 'append-only');
select pg_temp.expect_msg('evidence: TRUNCATE of the withdrawals table is refused (the FK from A0''s advancement entries / A6 requests blocks it first)', $q$truncate public.event_competition_final_withdrawals$q$, 'truncate');
select pg_temp.expect_msg('evidence: UPDATE of a request row is refused', format($q$update public.event_competition_final_withdrawal_requests set reason = 'changed afterwards' where request_id = %L$q$, pg_temp.id('rq', 21)), 'append-only');
select pg_temp.expect_msg('evidence: DELETE of a request row is refused', format($q$delete from public.event_competition_final_withdrawal_requests where request_id = %L$q$, pg_temp.id('rq', 21)), 'append-only');
select pg_temp.expect_msg('evidence: TRUNCATE of the request table is refused', $q$truncate public.event_competition_final_withdrawal_requests$q$, 'append-only');
select pg_temp.expect_msg('U41 backstop: a duplicate (target round, seq) is refused by the unique key', format($q$insert into public.event_competition_final_withdrawals (event_id, target_round_id, entry_id, seq, kind, reason, requested_by, cosigned_by, cosigned_role, request_id)
  values (%L, %L, %L, 1, 'withdraw', 'duplicate seq probe', %L, %L, 'manager', %L)$q$, pg_temp.id('evt', 1), pg_temp.id('fin', 2), pg_temp.id('ent', 2, 3), pg_temp.id('user', 1), pg_temp.id('user', 2), pg_temp.id('rq', 800)), 'event_competition_final_withdrawals_seq_key');
select pg_temp.expect_msg('U63 backstop: the table refuses requester = co-signer', format($q$insert into public.event_competition_final_withdrawals (event_id, target_round_id, entry_id, seq, kind, reason, requested_by, cosigned_by, cosigned_role, request_id)
  values (%L, %L, %L, 9, 'withdraw', 'same person probe', %L, %L, 'manager', %L)$q$, pg_temp.id('evt', 1), pg_temp.id('fin', 2), pg_temp.id('ent', 2, 3), pg_temp.id('user', 1), pg_temp.id('user', 1), pg_temp.id('rq', 801)), 'cosign_check');

-- ============================================================================
-- 9. Event cascade (scenario 8, event 4): withdrawal and request rows go with the event; the guard lets the cascade through
-- ============================================================================
select pg_temp.as_user(1);
select pg_temp.chk('scenario 8 applies', pg_temp.code(pg_temp.ap(8, 8)) = 'OK');
reset role;
select set_config('cf1a6.r', pg_temp.flow('withdraw', 8, 1, 81)::text || pg_temp.req('withdraw', 8, 2, 1, 82)::text, false);
reset role;
select pg_temp.chk('scenario 8: withdraw couple 1 (completed) and leave a pending request for couple 2', current_setting('cf1a6.r') like '%"kind": "withdraw"%"state": "pending"%', current_setting('cf1a6.r'));
reset role;
select pg_temp.expect_msg('NO ACTION FK: a direct delete of the scratched heat entry''s round is refused', format($q$delete from public.event_competition_rounds where id = %L$q$, pg_temp.id('fin', 8)), '', null);
-- (pre-existing, not CF1: deleting an event that still has a certified heat is refused by protect_locked_competition_heat_children, so the heats are opened first)
select pg_temp.su(format($q$update public.event_competition_heats set lock_state = 'open' where event_id = %L$q$, pg_temp.id('evt', 4)));
select pg_temp.expect_ok('deleting the event cascades through heats, heat entries (guard exception), withdrawals and requests', format($q$delete from public.events where id = %L$q$, pg_temp.id('evt', 4)));
select pg_temp.chk('the cascaded rows are gone with their event, other events keep theirs',
  not exists (select 1 from public.event_competition_final_withdrawals where event_id = pg_temp.id('evt', 4)) and not exists (select 1 from public.event_competition_final_withdrawal_requests where event_id = pg_temp.id('evt', 4))
  and exists (select 1 from public.event_competition_final_withdrawals where event_id = pg_temp.id('evt', 1)));

-- ============================================================================
-- 10. The guard in isolation (U39, every branch with its own message): all other user triggers on heat entries are disabled for this transaction,
--     then only the A6 guard is re-enabled ALWAYS. Also shows the residual: the table owner can DISABLE the trigger.
-- ============================================================================
set constraints all immediate;
alter table public.event_competition_heat_entries disable trigger user;
alter table public.event_competition_heat_entries enable always trigger cf1_guard_withdrawn_heat_entry;
select pg_temp.chk('isolation: only the A6 guard is active on the heat entry table', (select count(*) = 1 from pg_trigger t where t.tgrelid = 'public.event_competition_heat_entries'::regclass and not t.tgisinternal and t.tgenabled <> 'D'));
-- scenario 4's generation 3 has couple 1 reinstated (state reinstate). Scenario 5 has couple 2 withdrawn and carried: no heat entry in the active heat.
select pg_temp.chk('isolation fixture: scenario 5 couple 2 is withdrawn with no row in the active heat', public._cf1_a6_pair_state(pg_temp.id('fin', 5), pg_temp.id('ent', 5, 2)) = 'withdraw' and pg_temp.hes(5, 2) = 'none');
select pg_temp.expect_msg('U39 INSERT: a replacement heat entry for a withdrawn pair is refused', format($q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
  select %L, %L, h.id, %L, 9 from public.event_competition_heats h where h.round_id = %L and h.status <> 'cancelled'$q$, pg_temp.id('evt', 1), pg_temp.id('div', 5), pg_temp.id('ent', 5, 2), pg_temp.id('fin', 5)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_msg('U39 INSERT into the old cancelled heat of the round is refused as well (any heat of that round)', format($q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
  select %L, %L, h.id, %L, 9 from public.event_competition_heats h where h.round_id = %L and h.status = 'cancelled' limit 1$q$, pg_temp.id('evt', 1), pg_temp.id('div', 5), pg_temp.id('ent', 5, 2), pg_temp.id('fin', 5)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_ok('(control) the same insert for a NOT withdrawn pair passes the A6 guard (scenario 5 couple 4 is not on the roster)', format($q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
  select %L, %L, h.id, %L, 9 from public.event_competition_heats h where h.round_id = %L and h.status <> 'cancelled'$q$, pg_temp.id('evt', 1), pg_temp.id('div', 5), pg_temp.id('ent', 5, 4), pg_temp.id('fin', 5)));
select pg_temp.expect_msg('U39 UPDATE OF entry_id: pointing another row at a withdrawn entry is refused', format($q$update public.event_competition_heat_entries set entry_id = %L
  where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L and status <> 'cancelled')$q$, pg_temp.id('ent', 5, 2), pg_temp.id('ent', 5, 4), pg_temp.id('fin', 5)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_msg('U39 UPDATE OF entry_id: moving a withdrawn pair''s own row away is refused', format($q$update public.event_competition_heat_entries set entry_id = %L
  where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 5), pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_msg('U39 UPDATE OF heat_id: moving a withdrawn pair''s row to another heat is refused', format($q$update public.event_competition_heat_entries set heat_id = %L
  where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('cbh', 2), pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_msg('U39 UPDATE OF status: out of scratched is refused', format($q$update public.event_competition_heat_entries set status = 'scheduled'
  where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_msg('U39 DELETE: the scratched row is refused', format($q$delete from public.event_competition_heat_entries
  where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)), 'COMP_WITHDRAWAL_GUARD', '42501');
select pg_temp.expect_ok('(control) a no-op UPDATE OF status to the same value is not a move out of scratched', format($q$update public.event_competition_heat_entries set status = 'scratched'
  where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)));
select pg_temp.expect_ok('(control) scratching another non-withdrawn couple (status into scratched) passes', format($q$update public.event_competition_heat_entries set status = 'scratched'
  where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 3), pg_temp.id('fin', 2)));
select pg_temp.expect_ok('(control) moving a non-withdrawn couple''s row back out of scratched passes (the guard is pair-specific)', format($q$update public.event_competition_heat_entries set status = 'scheduled'
  where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 3), pg_temp.id('fin', 2)));
-- Residual (documented): the owner can disable the trigger and then the write goes through.
alter table public.event_competition_heat_entries disable trigger cf1_guard_withdrawn_heat_entry;
select pg_temp.expect_ok('residual: with the trigger DISABLED by the table owner the un-scratch goes through (the guard cannot stop a trigger owner)', format($q$update public.event_competition_heat_entries set status = 'scheduled'
  where entry_id = %L and heat_id in (select id from public.event_competition_heats where round_id = %L)$q$, pg_temp.id('ent', 2, 1), pg_temp.id('fin', 2)));

-- Not run in this file (listed so the matrix is complete)
select pg_temp.blocked('U41 (concurrent part), U51: real two-session races', 'see test_T_competition_cf1_a6_concurrency.sh');
select pg_temp.blocked('U63: "not anyone who files a replacement ballot"', 'a Final withdrawal is refused once the Final has any ballot (COMP_WITHDRAWAL_BALLOTS), so there is no replacement-ballot filer to exclude; the clause belongs to the OD-13 judge-entry correction (A0b / A5)');

-- ============================================================================
-- Verdict
-- ============================================================================
do $$
declare
  v_total int;
  v_blocked int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select count(*) into v_blocked from t_results where status = 'BLOCKED';
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where status = 'FAIL';
  if v_failures is null then
    raise exception 'COMPETITION CF1 A6 SQL SUITE PASS (% checks, % blocked)', v_total, v_blocked;
  end if;
  raise exception 'COMPETITION CF1 A6 SQL SUITE FAIL: %', v_failures;
end $$;

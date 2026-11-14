-- Competition CF1 OD-17 enforcement switch suite (20270120105000). Covers: ships dark, authorization, every release gate refusal, audit + replay,
-- OFF identity of the new guards, ON refusal per mutation (round start, heat-entry placement / un-scratch, forward round edges, advancement
-- insert), live-event hold, history protection, privileges. Run as a SUPERUSER on the chain through F3 + the OD-17 migration, WITH or WITHOUT R2
-- (the refund gate differs: r2_ledger vs an owner override; the suite branches on _cf1_refund_evidence_mode()). One transaction, synthetic
-- fixtures only (UUID block ...-c1d170XXXXXX); the final block ALWAYS raises, so nothing persists:
--   "COMPETITION CF1 OD17 SQL SUITE PASS (<n> checks)"  or  "... FAIL: <failures>".
-- Concurrency (enable vs a concurrent roster mutation) needs real second sessions: test_T_competition_cf1_od17_concurrency.sh.
-- Deliberately NOT covered here: the unconditional A2 / A3 / F3 / A0 checks (their own suites run unchanged = the OFF-identity proof).

begin;

-- A0 compatibility (same as the A2 suite): the hand-built heats / heat entries / rounds would be refused by A0's ENABLE ALWAYS guards. The OD-17
-- guards are named cf1_od17_guard_* (the cf1_ prefix is what the existing trigger-pinning suites accept); the loop re-enables them below.
do $$
declare r record;
begin
  for r in select t.tgname, t.tgrelid::regclass as rel from pg_trigger t
           where not t.tgisinternal and t.tgname like 'cf1_%'
             and t.tgrelid in ('public.event_competition_heats'::regclass, 'public.event_competition_heat_entries'::regclass,
                               'public.event_competition_rounds'::regclass, 'public.event_competition_entries'::regclass) loop
    execute format('alter table %s disable trigger %I', r.rel, r.tgname);
  end loop;
end $$;

-- The loop above also disabled the OD-17 guards (they carry the cf1_ prefix so the existing suites that pin trigger lists accept them): re-enable them.
alter table public.event_competition_rounds enable always trigger cf1_od17_guard_round_status;
alter table public.event_competition_heat_entries enable always trigger cf1_od17_guard_heat_entry;
alter table public.event_competition_round_advancements enable always trigger cf1_od17_guard_advancement;
-- The A0 Final-start guard stays enabled: it is a release gate input (chain_integrity) and is a no-op for non-callback rounds.
alter table public.event_competition_rounds enable always trigger cf1_guard_final_start;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_ids (k text primary key, v text) on commit drop;
grant all on t_ids to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-c1d170' || p_suffix)::uuid $$;

create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
end $$;

-- Persisting statement runner: 'OK' or 'SQLSTATE message | detail' (a failure rolls back only that statement).
create or replace function pg_temp.exec(p_sql text) returns text
language plpgsql as $$
declare d text;
begin
  begin
    execute p_sql;
    return 'OK';
  exception when others then
    get stacked diagnostics d = pg_exception_detail;
    return sqlstate || ' ' || sqlerrm || coalesce(' | ' || d, '');
  end;
end $$;

-- Heat-entry writer in replica mode for the NON-ALWAYS triggers (10D published-schedule guard, sync triggers); the OD-17 guard is ENABLE ALWAYS and still fires.
create or replace function pg_temp.exec_r(p_sql text) returns text
language plpgsql as $x$
declare r text;
begin
  perform set_config('session_replication_role', 'replica', true);
  r := pg_temp.exec(p_sql);
  perform set_config('session_replication_role', 'origin', true);
  return r;
end $x$;

-- Two-step check: run the action in one statement, then evaluate the condition in a FRESH statement (a same-query subselect would not see the action's writes).
create or replace function pg_temp.step_chk(p_name text, p_act text, p_cond text) returns void
language plpgsql as $x$
declare r text; v boolean;
begin
  begin
    execute p_act into r;
    execute 'select ' || replace(p_cond, '%R%', quote_literal(coalesce(r, ''))) into v;
    insert into t_results values (p_name, coalesce(v, false), left(coalesce(r, 'null'), 600));
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $x$;

-- Always-rolled-back probe: runs p_pre then p_sql; 'OK' when p_sql succeeded, else the error text. Nothing persists either way.
create or replace function pg_temp.probe(p_pre text, p_sql text) returns text
language plpgsql as $$
declare d text; v_out text := 'OK';
begin
  begin
    if p_pre is not null then execute p_pre; end if;
    begin
      execute p_sql;
    exception when others then
      get stacked diagnostics d = pg_exception_detail;
      v_out := sqlstate || ' ' || sqlerrm || coalesce(' | ' || d, '');
    end;
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PROBE_ROLLBACK' then return 'PRE FAILED: ' || sqlstate || ' ' || sqlerrm; end if;
  end;
  return v_out;
end $$;

-- Call an RPC expression (returning jsonb) as a user; persists on success. Returns the jsonb or {err, msg, detail}.
create or replace function pg_temp.call(p_user uuid, p_expr text) returns jsonb
language plpgsql as $$
declare v jsonb; d text;
begin
  begin
    perform pg_temp.as_user(p_user);
    execute 'select ' || p_expr into v;
    execute 'reset role';
    return coalesce(v, '{}'::jsonb);
  exception when others then
    get stacked diagnostics d = pg_exception_detail;
    return jsonb_build_object('err', sqlstate, 'msg', sqlerrm, 'detail', d);
  end;
end $$;

-- Probe variant of call(): rolled back, p_pre runs as the superuser first.
create or replace function pg_temp.call_probe(p_pre text, p_user uuid, p_expr text) returns jsonb
language plpgsql as $$
declare v jsonb; d text; v_out jsonb;
begin
  begin
    if p_pre is not null then execute p_pre; end if;
    begin
      perform pg_temp.as_user(p_user);
      execute 'select ' || p_expr into v;
      v_out := coalesce(v, '{}'::jsonb);
    exception when others then
      get stacked diagnostics d = pg_exception_detail;
      v_out := jsonb_build_object('err', sqlstate, 'msg', sqlerrm, 'detail', d);
    end;
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PROBE_ROLLBACK' then return jsonb_build_object('err', 'PRE', 'msg', sqlerrm); end if;
  end;
  return v_out;
end $$;

-- Fixture writer in replica mode (skips sync triggers / FKs); raises on failure.
create or replace function pg_temp.fx(p_sql text) returns void
language plpgsql as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  execute p_sql;
  perform set_config('session_replication_role', 'origin', true);
end $$;

-- O1 round start edge written directly (the audit row the O1 guard requires is written first, same transaction).
create or replace function pg_temp.edge(p_round uuid, p_from text, p_to text, p_kind text) returns text
language plpgsql as $$
begin
  return pg_temp.exec(format($f$
    select public._compo1_record(r.event_id, r.id, null, %L, %L, %L, %L::uuid, gen_random_uuid(), null, '{}'::jsonb)
    from public.event_competition_rounds r where r.id = %L::uuid;
    update public.event_competition_rounds set status = %L where id = %L::uuid;
  $f$, p_kind, p_from, p_to, pg_temp.u('000001'), p_round, p_to, p_round));
end $$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (superuser). u1 owner (verified) | u2 instructor (verified, not a manager) | u3 owner (NOT verified) | u4 other-studio owner (verified)
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-od17-owner@example.test'), (pg_temp.u('000002'), 't-od17-instr@example.test'),
  (pg_temp.u('000003'), 't-od17-unverified@example.test'), (pg_temp.u('000004'), 't-od17-other@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'OD17 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-c1d170%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now()
from auth.users where id::text like '00000000-0000-0000-0000-c1d170%' and id <> pg_temp.u('000003');
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'OD17 Studio', 't-od17-studio'), (pg_temp.u('00a002'), 'OD17 Other', 't-od17-other');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.u('000002'), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.u('000003'), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.u('000004'), pg_temp.u('00a002'), 'studio_owner', true);

-- E1 main (draft) | E2 OFF-identity sandbox (draft, never enabled) | E3 live (published)
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'OD17 Main', 't-od17-e1', 'competition', current_date + 30, current_date + 30, 'draft', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00a001'), 'OD17 Sandbox', 't-od17-e2', 'competition', current_date + 31, current_date + 31, 'draft', 'public', true),
  (pg_temp.u('00e003'), pg_temp.u('00a001'), 'OD17 Live', 't-od17-e3', 'competition', current_date + 32, current_date + 32, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'P1', 'country', 'relative', 'skating', 'configured'),
  (pg_temp.u('001002'), pg_temp.u('00e002'), pg_temp.u('00a001'), 'P2', 'country', 'relative', 'skating', 'configured'),
  (pg_temp.u('001003'), pg_temp.u('00e003'), pg_temp.u('00a001'), 'P3', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'C1', 'single_dance', 'pro_am', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e002'), pg_temp.u('001002'), 'C2', 'single_dance', 'pro_am', 'open');
-- Orders / registrations (the unavailable-couple evidence): G_K is paid and confirmed until a test cancels it.
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, payment_status) values
  (pg_temp.u('0a0001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'od17-b1@example.test', 'paid'),
  (pg_temp.u('0a0002'), pg_temp.u('00e002'), pg_temp.u('00a001'), 'B', 'od17-b2@example.test', 'paid');
insert into public.event_registrations (id, studio_id, event_id, order_id, status, payment_status, attendee_first_name, attendee_last_name, attendee_email) values
  (pg_temp.u('0b00a1'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'confirmed', 'paid', 'G', 'A', 'od17-ga@example.test'),
  (pg_temp.u('0b00b1'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'confirmed', 'paid', 'G', 'B', 'od17-gb@example.test'),
  (pg_temp.u('0b00c1'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'confirmed', 'paid', 'G', 'C', 'od17-gc@example.test'),
  (pg_temp.u('0b00d1'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'confirmed', 'paid', 'G', 'D', 'od17-gd@example.test'),
  (pg_temp.u('0b00e1'), pg_temp.u('00a001'), pg_temp.u('00e002'), pg_temp.u('0a0002'), 'confirmed', 'paid', 'G', 'X', 'od17-gx@example.test');

insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Da', 'open'),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Db', 'open'),
  (pg_temp.u('003003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Dc', 'open'),
  (pg_temp.u('003004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Dd', 'open'),
  (pg_temp.u('003011'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('002002'), 'Dx', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Ra', 'final', 1, 'scheduled', 'ordinal_majority'),
  (pg_temp.u('006002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'Rb', 'final', 1, 'scheduled', 'ordinal_majority'),
  (pg_temp.u('006003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'Rc', 'final', 1, 'scheduled', 'ordinal_majority'),
  (pg_temp.u('006004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003004'), 'Rd', 'final', 1, 'scheduled', 'ordinal_majority'),
  (pg_temp.u('006011'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003011'), 'Rx', 'final', 1, 'scheduled', 'ordinal_majority');
-- entries: K1 / K2 available; KD linked to a registration (a test cancels it to make the couple unavailable); s1 spare
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number, registration_id) values
  (pg_temp.u('008101'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'a1', 'confirmed', 'eligible', '101', null),
  (pg_temp.u('008102'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'a2', 'confirmed', 'eligible', '102', null),
  (pg_temp.u('008103'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'ad', 'confirmed', 'eligible', '103', pg_temp.u('0b00a1')),
  (pg_temp.u('008201'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'b1', 'confirmed', 'eligible', '201', null),
  (pg_temp.u('008202'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'b2', 'confirmed', 'eligible', '202', null),
  (pg_temp.u('008203'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'bd', 'confirmed', 'eligible', '203', pg_temp.u('0b00b1')),
  (pg_temp.u('008301'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'c1', 'confirmed', 'eligible', '301', null),
  (pg_temp.u('008302'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'c2', 'confirmed', 'eligible', '302', null),
  (pg_temp.u('008401'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003004'), 'd1', 'confirmed', 'eligible', '401', null),
  (pg_temp.u('008402'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003004'), 'd2', 'confirmed', 'eligible', '402', null),
  (pg_temp.u('008501'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003011'), 'x1', 'confirmed', 'eligible', '501', null),
  (pg_temp.u('008502'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003011'), 'x2', 'confirmed', 'eligible', '502', null),
  (pg_temp.u('008503'), pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003011'), 'xd', 'confirmed', 'eligible', '503', pg_temp.u('0b00e1')),
  (pg_temp.u('008901'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 's1', 'confirmed', 'eligible', '901', null);

set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values
  (pg_temp.u('00c001'), pg_temp.u('00e001'), 1, 'v1', 'published', now()),
  (pg_temp.u('00c002'), pg_temp.u('00e002'), 1, 'v1', 'published', now());
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values
  (pg_temp.u('00d001'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 1, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d002'), pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('006002'), 2, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d003'), pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.u('006003'), 3, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d004'), pg_temp.u('00e001'), pg_temp.u('003004'), pg_temp.u('006004'), 4, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d011'), pg_temp.u('00e002'), pg_temp.u('003011'), pg_temp.u('006011'), 1, pg_temp.u('002002'), pg_temp.u('00c002'), 'scheduled');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d001'), pg_temp.u('008101'), 1),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d001'), pg_temp.u('008102'), 2),
  (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d002'), pg_temp.u('008201'), 1),
  (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d002'), pg_temp.u('008202'), 2),
  (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d002'), pg_temp.u('008203'), 3),
  (pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.u('00d003'), pg_temp.u('008301'), 1),
  (pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.u('00d003'), pg_temp.u('008302'), 2),
  (pg_temp.u('00e001'), pg_temp.u('003004'), pg_temp.u('00d004'), pg_temp.u('008401'), 1),
  (pg_temp.u('00e001'), pg_temp.u('003004'), pg_temp.u('00d004'), pg_temp.u('008402'), 2),
  (pg_temp.u('00e002'), pg_temp.u('003011'), pg_temp.u('00d011'), pg_temp.u('008501'), 1),
  (pg_temp.u('00e002'), pg_temp.u('003011'), pg_temp.u('00d011'), pg_temp.u('008502'), 2);
set session_replication_role = origin;

-- The refund-evidence environment: R2 present (gate returns r2_ledger) or absent (needs a recorded owner override).
insert into t_ids values ('r2', (public._cf1_refund_evidence_mode() = 'r2_ledger')::text);
create temp table t_ovr (id uuid) on commit drop;
grant all on t_ovr to authenticated, anon, service_role;

-- break / restore helpers for the refund gate (probes only): R2 -> break the ledger shape; no R2 -> revoke the owner override
create or replace function pg_temp.break_refund_gate() returns text language plpgsql as $$
begin
  if (select v from t_ids where k = 'r2') = 'true' then
    return 'alter table public.event_order_refunds rename column status to status_x';
  end if;
  return format('select public._cf1_rb3_revoke_gate_override(%L, %L)', (select id from t_ovr), 'qa');
end $$;
grant execute on function pg_temp.break_refund_gate() to authenticated, anon, service_role;

-- ============================================================================
-- 1. Ships dark; privileges; guards installed
-- ============================================================================
select pg_temp.chk('S01 ships dark: no switch row and no audit row exist', (select count(*) from public.competition_cf1_od17_enforcement) = 0
  and (select count(*) from public.competition_cf1_od17_audit) = 0);
select pg_temp.chk('S02 every event reads OFF', not public._cf1_od17_enforced(pg_temp.u('00e001')) and not public._cf1_od17_enforced(pg_temp.u('00e002'))
  and not public._cf1_od17_enforced(pg_temp.u('00e003')) and not public._cf1_od17_enforced(gen_random_uuid()));
select pg_temp.chk('S03 the three guards exist and are ENABLE ALWAYS',
  (select count(*) from pg_trigger t where t.tgname in ('cf1_od17_guard_round_status', 'cf1_od17_guard_heat_entry', 'cf1_od17_guard_advancement') and t.tgenabled = 'A') = 3);
select pg_temp.chk('S04 anon has no execute on any OD-17 function; authenticated only on the two RPCs',
  not has_function_privilege('anon', 'public.cf1_od17_set_enforcement(uuid,boolean,text,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.cf1_od17_enforcement_state(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.cf1_od17_set_enforcement(uuid,boolean,text,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.cf1_od17_enforcement_state(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._cf1_od17_gates(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._cf1_od17_enforced(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public._cf1_od17_runtime_gate()', 'execute')
  and not has_function_privilege('service_role', 'public.cf1_od17_set_enforcement(uuid,boolean,text,uuid)', 'execute'));
select pg_temp.chk('S05 no direct table access for anon / authenticated / service_role',
  not has_table_privilege('authenticated', 'public.competition_cf1_od17_enforcement', 'select')
  and not has_table_privilege('authenticated', 'public.competition_cf1_od17_audit', 'select')
  and not has_table_privilege('service_role', 'public.competition_cf1_od17_enforcement', 'insert')
  and not has_table_privilege('anon', 'public.competition_cf1_od17_audit', 'select'));

-- ============================================================================
-- 2. OFF identity of the new guards (sandbox event E2, never enabled): an unavailable couple is placed, the round starts
-- ============================================================================
select pg_temp.fx($$update public.event_registrations set status = 'cancelled' where id = pg_temp.u('0b00e1')$$);
select pg_temp.chk('S06 OFF: predicate P is true for the cancelled-registration couple (fixture sanity)', public._cf1_entry_unavailable(pg_temp.u('008503')));
select pg_temp.chk('S07 OFF: placing the unavailable couple in a heat succeeds (as before this migration)',
  pg_temp.exec_r($$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
                 values (pg_temp.u('00e002'), pg_temp.u('003011'), pg_temp.u('00d011'), pg_temp.u('008503'), 3)$$) = 'OK');
select pg_temp.step_chk('S08 OFF: the round with that couple starts (scheduled -> active), no refusal',
  $a$select pg_temp.edge(pg_temp.u('006011'), 'scheduled', 'active', 'round_started')$a$,
  $c$%R% = 'OK' and (select status from public.event_competition_rounds where id = pg_temp.u('006011')) = 'active'$c$);
select pg_temp.chk('S09 OFF: an advancement insert is not gated by the refund gate (probe, even with the gate broken)',
  pg_temp.probe(pg_temp.break_refund_gate() || '; set local session_replication_role = replica', format(
    $q$insert into public.event_competition_round_advancements (event_id, program_id, division_id, source_round_id, target_round_id, generation, source_result_version_id,
         source_input_hash, source_trace_hash, advanced_count, target_capacity, applied_by, request_id)
       values (%L, %L, %L, %L, %L, 1, gen_random_uuid(), 'h', 'h', 1, 8, %L, gen_random_uuid())$q$,
    pg_temp.u('00e002'), pg_temp.u('001002'), pg_temp.u('003011'), pg_temp.u('006011'), pg_temp.u('006011'), pg_temp.u('000001'))) = 'OK');

-- ============================================================================
-- 3. Authorization and argument checks on E1 (every refusal writes nothing)
-- ============================================================================
select pg_temp.chk('A01 anon cannot call the switch', (pg_temp.call(null, format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'anon attempt reason'))) ->> 'err' = '42501');
select pg_temp.chk('A02 a studio instructor (not a manager) is refused COMP_FORBIDDEN',
  (pg_temp.call(pg_temp.u('000002'), format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'instructor attempt'))) ->> 'msg' like 'COMP_FORBIDDEN%');
select pg_temp.chk('A03 a verified owner of ANOTHER studio is refused COMP_FORBIDDEN',
  (pg_temp.call(pg_temp.u('000004'), format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'other studio attempt'))) ->> 'msg' like 'COMP_FORBIDDEN%');
select pg_temp.chk('A04 a manager without a verified email is refused COMP_VERIFIED_EMAIL_REQUIRED',
  (pg_temp.call(pg_temp.u('000003'), format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'unverified attempt'))) ->> 'msg' like 'COMP_VERIFIED_EMAIL_REQUIRED%');
select pg_temp.chk('A05 missing request id -> COMP_REQUEST_ID_REQUIRED',
  (pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, null)', pg_temp.u('00e001'), 'no request id given'))) ->> 'msg' like 'COMP_REQUEST_ID_REQUIRED%');
select pg_temp.chk('A06 reason shorter than 10 characters -> COMP_OD17_REASON_REQUIRED',
  (pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'short'))) ->> 'msg' like 'COMP_OD17_REASON_REQUIRED%');
select pg_temp.chk('A07 null enabled -> COMP_OD17_BAD_ARGUMENT',
  (pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, null, %L, gen_random_uuid())', pg_temp.u('00e001'), 'null enabled argument'))) ->> 'msg' like 'COMP_OD17_BAD_ARGUMENT%');
select pg_temp.chk('A08 unknown event -> COMP_FORBIDDEN (nothing to learn)',
  (pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(gen_random_uuid(), true, %L, gen_random_uuid())', 'unknown event attempt'))) ->> 'msg' like 'COMP_FORBIDDEN%');
select pg_temp.chk('A09 the state read: a non-manager is refused, a manager sees OFF and the gate evaluation',
  (pg_temp.call(pg_temp.u('000002'), format('public.cf1_od17_enforcement_state(%L)', pg_temp.u('00e001')))) ->> 'msg' like 'COMP_FORBIDDEN%'
  and (pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_enforcement_state(%L)', pg_temp.u('00e001')))) -> 'enabled' = 'false'::jsonb
  and (pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_enforcement_state(%L)', pg_temp.u('00e001')))) -> 'gates' ? 'refund_evidence');
select pg_temp.chk('A10 none of the refused calls wrote a switch or an audit row',
  (select count(*) from public.competition_cf1_od17_enforcement) = 0 and (select count(*) from public.competition_cf1_od17_audit) = 0);

-- ============================================================================
-- 4. Enable is refused while ANY gate is false (probes: rolled back). Baseline first: E1 has a clean roster.
-- ============================================================================
-- refund_evidence false: R2 present -> break the ledger shape (mismatch, no override); R2 absent -> mode absent, no override recorded yet
select pg_temp.chk('G01 gate refund_evidence false -> enable refused COMP_OD17_GATES_NOT_MET naming refund_evidence',
  (select r ->> 'msg' like 'COMP_OD17_GATES_NOT_MET%refund_evidence%' and (r ->> 'detail')::jsonb -> 'refund_evidence' ->> 'ok' = 'false'
   from (select pg_temp.call_probe(
     case when (select v from t_ids where k = 'r2') = 'true' then pg_temp.break_refund_gate() else null end,
     pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'refund gate false probe')) r) x));
-- from here on the refund gate must pass: R2 -> r2_ledger; no R2 -> record the owner's acceptance (RB3 override)
do $$
declare v_id uuid;
begin
  if (select v from t_ids where k = 'r2') <> 'true' then
    v_id := public._cf1_rb3_record_gate_override('absent', 'owner (qa fixture)', 'qa fixture acceptance of the absent refund-evidence false negative');
    insert into t_ovr values (v_id);
  end if;
end $$;
select pg_temp.chk('G02 refund gate now passes (r2_ledger, or override:absent without R2)',
  public._cf1_od17_refund_gate() = case when (select v from t_ids where k = 'r2') = 'true' then 'r2_ledger' else 'override:absent' end);
select pg_temp.chk('G03 baseline: every gate is true for E1 (no pre-existing problem)', (public._cf1_od17_gates(pg_temp.u('00e001')) ->> 'all_ok')::boolean,
  public._cf1_od17_gates(pg_temp.u('00e001'))::text);
select pg_temp.chk('G04 gate release_not_live: a published event is refused (E3), naming event_published',
  (select r ->> 'msg' like 'COMP_OD17_GATES_NOT_MET%release_not_live%' and ((r ->> 'detail')::jsonb -> 'release_not_live' -> 'detail') ? 'event_published'
   from (select pg_temp.call_probe(null, pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e003'), 'live event attempt')) r) x));
select pg_temp.chk('G05 gate release_not_live: a draft event whose status becomes published is refused (E1 probe)',
  (select r ->> 'msg' like 'COMP_OD17_GATES_NOT_MET%release_not_live%'
   from (select pg_temp.call_probe($$update public.events set status = 'published' where id = pg_temp.u('00e001')$$, pg_temp.u('000001'),
     format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'published probe')) r) x));
select pg_temp.chk('G06 gate release_not_live: an open competition registration program is refused (registration_open)',
  (select r ->> 'msg' like 'COMP_OD17_GATES_NOT_MET%release_not_live%' and ((r ->> 'detail')::jsonb -> 'release_not_live' -> 'detail') ? 'registration_open'
   from (select pg_temp.call_probe($$set local session_replication_role = replica; update public.event_competition_programs set registration_status = 'open' where id = pg_temp.u('001001')$$,
     pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'registration open probe')) r) x));
select pg_temp.chk('G07 gate release_not_live: a live schedule version is refused (schedule_live)',
  (select r ->> 'msg' like 'COMP_OD17_GATES_NOT_MET%release_not_live%' and ((r ->> 'detail')::jsonb -> 'release_not_live' -> 'detail') ? 'schedule_live'
   from (select pg_temp.call_probe($$set local session_replication_role = replica; update public.event_competition_schedule_versions set status = 'live' where id = pg_temp.u('00c001')$$,
     pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'schedule live probe')) r) x));
select pg_temp.chk('G08 gate chain_integrity: a missing recovery route (U66 function dropped in the probe) is refused, naming u66_recovery',
  (select r ->> 'msg' like 'COMP_OD17_GATES_NOT_MET%chain_integrity%' and ((r ->> 'detail')::jsonb -> 'chain_integrity' -> 'detail') ? 'u66_recovery'
   from (select pg_temp.call_probe('drop function public.recover_correction_for_exclusion(uuid,uuid,text,text,uuid)', pg_temp.u('000001'),
     format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'chain gate probe')) r) x));
select pg_temp.chk('G09 gate no_blocked_ties: a live callback result with an undecided row is refused',
  (select r ->> 'msg' like 'COMP_OD17_GATES_NOT_MET%no_blocked_ties%'
   from (select pg_temp.call_probe(format($p$set local session_replication_role = replica;
       insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
       values (%L, %L, %L, 1, 'studio_callback_tally', '1', repeat('a', 64), repeat('b', 64), '{}', '[]', %L, 'calculated', gen_random_uuid());
       insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, placement, advanced) values (%L, %L, %L, 1, null)$p$,
       pg_temp.u('007001'), pg_temp.u('00e001'), pg_temp.u('006001'), pg_temp.u('000001'), pg_temp.u('00e001'), pg_temp.u('007001'), pg_temp.u('008101')),
     pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'blocked tie probe')) r) x));
-- roster_clean: place the soon-unavailable couple of round a (OFF allows it), cancel its registration
select pg_temp.exec_r($$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
                      values (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d001'), pg_temp.u('008103'), 3)$$);
select pg_temp.fx($$update public.event_registrations set status = 'cancelled' where id = pg_temp.u('0b00a1')$$);
select pg_temp.chk('G10 gate roster_clean: a scheduled round holding an unavailable couple refuses the enable (detail lists the round)',
  (select r ->> 'msg' like 'COMP_OD17_GATES_NOT_MET%roster_clean%' and ((r ->> 'detail')::jsonb -> 'roster_clean' -> 'detail' -> 'rounds') ? pg_temp.u('006001')::text
   from (select pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'roster gate attempt')) r) x));
select pg_temp.chk('G11 every refused enable left no switch row and no audit row',
  (select count(*) from public.competition_cf1_od17_enforcement) = 0 and (select count(*) from public.competition_cf1_od17_audit) = 0);
-- resolve it: scratch the couple's placement (scratch is never gated), then the gates are true again
select pg_temp.exec_r($$update public.event_competition_heat_entries set status = 'scratched' where heat_id = pg_temp.u('00d001') and entry_id = pg_temp.u('008103')$$);
select pg_temp.chk('G12 after the scratch the roster gate is true again', (public._cf1_od17_gates(pg_temp.u('00e001')) ->> 'all_ok')::boolean, public._cf1_od17_gates(pg_temp.u('00e001'))::text);

-- ============================================================================
-- 5. Enable / replay / audit / disable
-- ============================================================================
select pg_temp.chk('E01 enable succeeds for the manager (changed = true, enabled = true, gates attached)',
  (select r ->> 'enabled' = 'true' and r ->> 'changed' = 'true' and r ->> 'replayed' = 'false' and (r -> 'gates' ->> 'all_ok') = 'true'
   from (select pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, %L)', pg_temp.u('00e001'), 'enabled for the synthetic QA event', pg_temp.u('0e0001'))) r) x));
select pg_temp.chk('E02 the switch row is ON and exactly one audit row exists (action enable, changed, actor, gate snapshot, refund gate recorded)',
  public._cf1_od17_enforced(pg_temp.u('00e001'))
  and (select count(*) from public.competition_cf1_od17_audit) = 1
  and exists (select 1 from public.competition_cf1_od17_audit a where a.request_id = pg_temp.u('0e0001') and a.action = 'enable' and a.changed and a.actor = pg_temp.u('000001')
              and a.event_id = pg_temp.u('00e001') and (a.gates ->> 'all_ok') = 'true'
              and a.refund_gate = case when (select v from t_ids where k = 'r2') = 'true' then 'r2_ledger' else 'override:absent' end));
select pg_temp.step_chk('E03 replay by request id returns replayed = true and writes nothing',
  $a$select pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, %L)', pg_temp.u('00e001'), 'enabled for the synthetic QA event', pg_temp.u('0e0001')))::text$a$,
  $c$(%R%::jsonb ->> 'replayed') = 'true' and (%R%::jsonb ->> 'changed') = 'true' and (select count(*) from public.competition_cf1_od17_audit) = 1$c$);
select pg_temp.step_chk('E04 the same request id for another action / another event is COMP_REQUEST_REUSED',
  $a$select (pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, false, %L, %L)', pg_temp.u('00e001'), 'disable with reused request id', pg_temp.u('0e0001'))) ->> 'msg')
         || '#@#' || (pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, %L)', pg_temp.u('00e002'), 'enable other event reused id', pg_temp.u('0e0001'))) ->> 'msg')$a$,
  $c$split_part(%R%, '#@#', 1) like 'COMP_REQUEST_REUSED%' and split_part(%R%, '#@#', 2) like 'COMP_REQUEST_REUSED%'
     and public._cf1_od17_enforced(pg_temp.u('00e001')) and not public._cf1_od17_enforced(pg_temp.u('00e002'))$c$);
select pg_temp.step_chk('E05 enabling an already-enabled event with a NEW request id is a recorded no-op (changed = false)',
  $a$select pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, %L)', pg_temp.u('00e001'), 'enable again, no change expected', pg_temp.u('0e0002')))::text$a$,
  $c$(%R%::jsonb ->> 'changed') = 'false' and (%R%::jsonb ->> 'enabled') = 'true' and (select count(*) from public.competition_cf1_od17_audit) = 2$c$);
select pg_temp.chk('E06 only E1 is ON: E2 and E3 stay OFF (per-event scope)', public._cf1_od17_enforced(pg_temp.u('00e001'))
  and not public._cf1_od17_enforced(pg_temp.u('00e002')) and not public._cf1_od17_enforced(pg_temp.u('00e003'))
  and (select count(*) from public.competition_cf1_od17_enforcement where enabled) = 1);
select pg_temp.chk('E07 the state read shows ON and the last change',
  (select r ->> 'enabled' = 'true' and r -> 'last_change' ->> 'action' = 'enable' from (select pg_temp.call(pg_temp.u('000001'),
     format('public.cf1_od17_enforcement_state(%L)', pg_temp.u('00e001'))) r) x));

-- ============================================================================
-- 6. ON: refusal per mutation (E1)
-- ============================================================================
select pg_temp.chk('M2a ON: inserting a heat entry for the unavailable couple is refused COMP_OD17_ROSTER_ENTRY_UNAVAILABLE (stage place)',
  pg_temp.exec_r($$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
                 values (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d002'), pg_temp.u('008103'), 9)$$) like '%COMP_OD17_ROSTER_ENTRY_UNAVAILABLE%"stage": "place"%',
  pg_temp.exec_r($$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
                 values (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d002'), pg_temp.u('008103'), 9)$$));
select pg_temp.chk('M2b ON: un-scratching the unavailable couple placement is refused and the row stays scratched',
  pg_temp.exec_r($$update public.event_competition_heat_entries set status = 'scheduled' where heat_id = pg_temp.u('00d001') and entry_id = pg_temp.u('008103')$$) like 'P0001 COMP_OD17_ROSTER_ENTRY_UNAVAILABLE%'
  and (select status from public.event_competition_heat_entries where heat_id = pg_temp.u('00d001') and entry_id = pg_temp.u('008103')) = 'scratched');
select pg_temp.chk('M2c ON: moving the unavailable couple to another heat is refused (heat_id change)',
  pg_temp.exec_r($$update public.event_competition_heat_entries set heat_id = pg_temp.u('00d002'), status = 'scheduled' where heat_id = pg_temp.u('00d001') and entry_id = pg_temp.u('008103')$$) like 'P0001 COMP_OD17_ROSTER_ENTRY_UNAVAILABLE%');
select pg_temp.chk('M2d ON: an AVAILABLE couple can still be placed, and a status-only update never re-checks',
  pg_temp.exec_r($$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
                 values (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d001'), pg_temp.u('008901'), 8)$$) = 'OK'
  and pg_temp.exec_r($$update public.event_competition_heat_entries set status = 'checked_in' where heat_id = pg_temp.u('00d001') and entry_id = pg_temp.u('008901')$$) = 'OK');
select pg_temp.chk('M2e ON: scratching is never gated (a refund can always be resolved by a scratch)',
  pg_temp.exec_r($$update public.event_competition_heat_entries set status = 'scratched' where heat_id = pg_temp.u('00d001') and entry_id = pg_temp.u('008901')$$) = 'OK');
-- M1 start: round b holds 'bd' (available when placed); the registration is cancelled AFTER the switch went ON
select pg_temp.fx($$update public.event_registrations set status = 'cancelled' where id = pg_temp.u('0b00b1')$$);
select pg_temp.step_chk('M1a ON: starting a round whose roster now holds an unavailable couple is refused (stage start), status unchanged, no transition event',
  $a$select pg_temp.edge(pg_temp.u('006002'), 'scheduled', 'active', 'round_started')$a$,
  $c$%R% like 'P0001 COMP_OD17_ROSTER_ENTRY_UNAVAILABLE%"stage": "start"%'
     and (select status from public.event_competition_rounds where id = pg_temp.u('006002')) = 'scheduled'
     and not exists (select 1 from public.event_competition_round_transition_events e where e.round_id = pg_temp.u('006002') and e.kind = 'round_started')$c$);
select pg_temp.step_chk('M1b ON: a round with a clean roster starts under ON; the OFF sandbox round started with its unavailable couple (S08)',
  $a$select pg_temp.edge(pg_temp.u('006003'), 'scheduled', 'active', 'round_started')$a$,
  $c$%R% = 'OK' and (select status from public.event_competition_rounds where id = pg_temp.u('006003')) = 'active'
     and (select status from public.event_competition_rounds where id = pg_temp.u('006011')) = 'active'$c$);
select pg_temp.step_chk('M1c ON: after the scratch of the unavailable couple the previously refused round starts',
  $a$select pg_temp.exec_r($z$update public.event_competition_heat_entries set status = 'scratched' where heat_id = pg_temp.u('00d002') and entry_id = pg_temp.u('008203')$z$)
         || '/' || pg_temp.edge(pg_temp.u('006002'), 'scheduled', 'active', 'round_started')$a$,
  $c$%R% = 'OK/OK' and (select status from public.event_competition_rounds where id = pg_temp.u('006002')) = 'active'$c$);
-- M3 forward edges and advancement insert under a FAILING refund gate
create or replace function pg_temp.rec_sql(p_round uuid) returns text language sql as $f$
  select format('select public._compo1_record(event_id, id, null, ''round_started'', ''scheduled'', ''active'', %L::uuid, gen_random_uuid(), null, ''{}''::jsonb) from public.event_competition_rounds where id = %L::uuid', pg_temp.u('000001')::text, p_round::text)
$f$;
grant execute on function pg_temp.rec_sql(uuid) to authenticated, anon, service_role;
select pg_temp.chk('M3a ON + refund gate intact: scheduled -> active of a clean round passes (probe)',
  pg_temp.probe(pg_temp.rec_sql(pg_temp.u('006004')), format($q$update public.event_competition_rounds set status = 'active' where id = %L$q$, pg_temp.u('006004'))) = 'OK');
select pg_temp.chk('M3b ON + refund gate lost: the same start is refused COMP_OD17_REFUND_GATE and the round stays scheduled (probe)',
  pg_temp.probe(pg_temp.break_refund_gate() || '; ' || pg_temp.rec_sql(pg_temp.u('006004')), format($q$update public.event_competition_rounds set status = 'active' where id = %L$q$, pg_temp.u('006004'))) like 'P0001 COMP_OD17_REFUND_GATE%'
  and (select status from public.event_competition_rounds where id = pg_temp.u('006004')) = 'scheduled');
create or replace function pg_temp.lock_edge_sql(p_round uuid) returns text language sql as $f$
  select format('insert into public.event_competition_ballot_events (event_id, round_id, kind, actor_user_id, from_state, to_state, request_id)
                  select event_id, id, ''round_state_changed'', %L::uuid, ''active'', ''ballots_locked'', gen_random_uuid() from public.event_competition_rounds where id = %L::uuid',
                 pg_temp.u('000001')::text, p_round::text)
$f$;
grant execute on function pg_temp.lock_edge_sql(uuid) to authenticated, anon, service_role;
select pg_temp.chk('M3c ON + refund gate intact: active -> ballots_locked of the active round c passes the OD-17 guard (probe, E2 lock audit row supplied)',
  pg_temp.probe(pg_temp.lock_edge_sql(pg_temp.u('006003')), format($q$update public.event_competition_rounds set status = 'ballots_locked' where id = %L$q$, pg_temp.u('006003'))) = 'OK');
select pg_temp.chk('M3c2 ON + refund gate lost: active -> ballots_locked is refused COMP_OD17_REFUND_GATE and the round stays active (probe)',
  pg_temp.probe(pg_temp.break_refund_gate() || '; ' || pg_temp.lock_edge_sql(pg_temp.u('006003')), format($q$update public.event_competition_rounds set status = 'ballots_locked' where id = %L$q$, pg_temp.u('006003'))) like 'P0001 COMP_OD17_REFUND_GATE%'
  and (select status from public.event_competition_rounds where id = pg_temp.u('006003')) = 'active');
select pg_temp.chk('M3d ON + refund gate lost: an advancement insert is refused COMP_OD17_REFUND_GATE; with the gate intact it is accepted (probes)',
  pg_temp.probe(pg_temp.break_refund_gate() || '; set local session_replication_role = replica',
    format($q$insert into public.event_competition_round_advancements (event_id, program_id, division_id, source_round_id, target_round_id, generation, source_result_version_id,
         source_input_hash, source_trace_hash, advanced_count, target_capacity, applied_by, request_id)
       values (%L, %L, %L, %L, %L, 1, gen_random_uuid(), 'h', 'h', 1, 8, %L, gen_random_uuid())$q$,
    pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('006001'), pg_temp.u('006002'), pg_temp.u('000001'))) like '%COMP_OD17_REFUND_GATE%'
  and pg_temp.probe('set local session_replication_role = replica',
    format($q$insert into public.event_competition_round_advancements (event_id, program_id, division_id, source_round_id, target_round_id, generation, source_result_version_id,
         source_input_hash, source_trace_hash, advanced_count, target_capacity, applied_by, request_id)
       values (%L, %L, %L, %L, %L, 1, gen_random_uuid(), 'h', 'h', 1, 8, %L, gen_random_uuid())$q$,
    pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), pg_temp.u('006001'), pg_temp.u('006002'), pg_temp.u('000001'))) = 'OK');
select pg_temp.chk('M3e only the five forward edges are gated (reopen / correction edges are the recovery routes and are not): edge list pinned in the guard',
  position($$('scheduled', 'active'), ('active', 'ballots_locked'), ('ballots_locked', 'calculated'),
                                        ('calculated', 'approved'), ('approved', 'published')$$ in (select pg_get_functiondef('public.cf1_od17_guard_round_status()'::regprocedure))) > 0);

-- ============================================================================
-- 7. Disable (also on a live event), then the live hold, history protection
-- ============================================================================
select pg_temp.step_chk('D01 disable by the manager: changed = true, switch OFF, audit row action disable',
  $a$select pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, false, %L, %L)', pg_temp.u('00e001'), 'disabled again after the synthetic QA', pg_temp.u('0e0003')))::text$a$,
  $c$(%R%::jsonb ->> 'enabled') = 'false' and (%R%::jsonb ->> 'changed') = 'true' and not public._cf1_od17_enforced(pg_temp.u('00e001'))
     and exists (select 1 from public.competition_cf1_od17_audit a where a.request_id = pg_temp.u('0e0003') and a.action = 'disable' and a.changed)$c$);
select pg_temp.chk('D02 after the disable the same guarded write behaves as before this migration (placing the unavailable couple is allowed again)',
  pg_temp.exec_r($$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
                 values (pg_temp.u('00e001'), pg_temp.u('003004'), pg_temp.u('00d004'), pg_temp.u('008103'), 9)$$) = 'OK');
-- an event that WAS enabled and is later published: the disable still works (no gates on disable), the enable is refused
update public.competition_cf1_od17_enforcement set enabled = true where event_id = pg_temp.u('00e001');
update public.events set status = 'published' where id = pg_temp.u('00e001');
select pg_temp.step_chk('D03 a published event that is ON can be switched OFF (disable has no gates)',
  $a$select pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, false, %L, %L)', pg_temp.u('00e001'), 'disable on a published event', pg_temp.u('0e0004')))::text$a$,
  $c$(%R%::jsonb ->> 'enabled') = 'false' and not public._cf1_od17_enforced(pg_temp.u('00e001'))$c$);
select pg_temp.chk('D04 and the same published event can never be enabled (live-event hold)',
  (pg_temp.call(pg_temp.u('000001'), format('public.cf1_od17_set_enforcement(%L, true, %L, gen_random_uuid())', pg_temp.u('00e001'), 'enable on a published event'))) ->> 'msg' like 'COMP_OD17_GATES_NOT_MET%release_not_live%');
select pg_temp.step_chk('H01 audit rows are append-only: update / delete / truncate are refused',
  $a$select pg_temp.exec($z$update public.competition_cf1_od17_audit set reason = 'tampered with the audit trail' $z$) || '#@#' || pg_temp.exec($z$delete from public.competition_cf1_od17_audit$z$)
         || '#@#' || pg_temp.exec($z$truncate public.competition_cf1_od17_audit$z$)$a$,
  $c$split_part(%R%, '#@#', 1) like '42501%' and split_part(%R%, '#@#', 2) like '42501%' and split_part(%R%, '#@#', 3) like '42501%'
     and (select count(*) from public.competition_cf1_od17_audit) = 4$c$);
select pg_temp.chk('H02 the audit trail has two enable rows and two disable rows',
  (select count(*) from public.competition_cf1_od17_audit where action = 'enable') = 2
  and (select count(*) from public.competition_cf1_od17_audit where action = 'disable') = 2);
select pg_temp.chk('H03 ships-dark invariant: no other event ever got a switch row', (select count(*) from public.competition_cf1_od17_enforcement where event_id <> pg_temp.u('00e001')) = 0);

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
    raise exception 'COMPETITION CF1 OD17 SQL SUITE PASS (% checks, r2=%)', v_total, (select v from t_ids where k = 'r2');
  end if;
  raise exception 'COMPETITION CF1 OD17 SQL SUITE FAIL: %', v_failures;
end $$;

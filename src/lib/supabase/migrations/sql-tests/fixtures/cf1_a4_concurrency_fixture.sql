
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
language sql immutable as $$ select md5('cf1a4:' || p_kind || ':' || p_n || ':' || p_k)::uuid $$;
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
  insert into public.event_competition_result_versions (id, event_id, round_id, version, engine_key, engine_version, input_hash, trace_hash, input, trace, calculated_by, status, request_id)
  values (pg_temp.id('rvg', p_n, p_ver), v_event, pg_temp.id('src', p_n), p_ver, 'callback_tally', '1', public._compf2_input_hash(pg_temp.id('src', p_n), 'callback_tally', '1'),
          repeat(md5('t' || p_ver), 2), '{}', '[]', pg_temp.id('user', 1), 'approved', pg_temp.id('req-rvg', p_n, p_ver));
  insert into public.event_competition_result_rows (event_id, result_version_id, entry_id, advanced, output)
  select v_event, pg_temp.id('rvg', p_n, p_ver), pg_temp.id('ent', p_n, k), k = any (p_adv), '{}'
  from public.event_competition_entries e, generate_series(1, 4) k where e.id = pg_temp.id('ent', p_n, k);
  perform set_config('session_replication_role', 'origin', true);
end $$;

-- ---------------------------------------------------------------------------
-- A4 helpers (post-start routes: ballots, lock, calculate, approve; ineligibility; Final-only builder)
-- ---------------------------------------------------------------------------
create or replace function pg_temp.fh(p_n int) returns uuid language sql security definer as $$
  select h.id from public.event_competition_heats h where h.round_id = pg_temp.id('fin', p_n) and h.status <> 'cancelled' order by h.created_at limit 1 $$;
create or replace function pg_temp.mkr(p int, p_judge int) returns jsonb
language sql security definer as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'value', case when p_judge = 3 then x.cnt - x.rn + 1 else x.rn end) order by x.rn)
  from (select e as entry_id, row_number() over (order by e)::int rn, count(*) over ()::int cnt from unnest(public._compe2_heat_entries(pg_temp.fh(p))) e) x $$;
create or replace function pg_temp.rows(p int) returns jsonb
language sql security definer as $$
  select coalesce(jsonb_agg(jsonb_build_object('entry_id', x.e, 'placement', x.rn) order by x.rn), '[]'::jsonb)
  from (select e, row_number() over (order by e)::int rn from unnest(public._compe2_round_entries(pg_temp.id('fin', p))) e where e <> all (public._compf2_no_show_entries(pg_temp.id('fin', p)))) x $$;
create or replace function pg_temp.th() returns text language sql immutable as $$ select encode(sha256(convert_to('[{"step":1}]', 'UTF8')), 'hex') $$;
create or replace function pg_temp.vid(p int, p_version int) returns uuid language sql security definer as $$
  select id from public.event_competition_result_versions where round_id = pg_temp.id('fin', p) and version = p_version $$;
create or replace function pg_temp.rstatus(p int) returns text language sql security definer as $$ select status from public.event_competition_rounds where id = pg_temp.id('fin', p) $$;
create or replace function pg_temp.vstatus(p int, p_version int) returns text language sql security definer as $$
  select status from public.event_competition_result_versions where round_id = pg_temp.id('fin', p) and version = p_version $$;
create or replace function pg_temp.hl1_danced(p_heat uuid) returns void language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_heats set status = 'complete' where id = p_heat;
  perform set_config('session_replication_role', 'origin', true);
end $$;
-- Each wrapper returns jsonb: the RPC result or {error, state}; the caller's role is whoever is current.
create or replace function pg_temp.calc(p int) returns jsonb language plpgsql as $$
declare v_in jsonb; v_r jsonb;
begin
  perform pg_temp.as_user(1);
  begin
    v_in := public.competition_round_calculation_input(pg_temp.id('fin', p));
    v_r := public.calculate_competition_round(pg_temp.id('fin', p), v_in ->> 'engine_key', v_in ->> 'engine_version', v_in ->> 'input_hash', pg_temp.th(), '[{"step":1}]'::jsonb, pg_temp.rows(p), '[]'::jsonb, gen_random_uuid());
  exception when others then v_r := jsonb_build_object('error', sqlerrm, 'state', sqlstate);
  end;
  execute 'reset role';
  return v_r;
end $$;
-- approve: user 2 (a second manager; the calculator is user 1)
create or replace function pg_temp.approve(p int, p_version int) returns jsonb language plpgsql as $$
declare v_r jsonb;
begin
  perform pg_temp.as_user(2);
  begin
    v_r := public.approve_competition_round_result(pg_temp.id('fin', p), pg_temp.vid(p, p_version), null, gen_random_uuid());
  exception when others then v_r := jsonb_build_object('error', sqlerrm, 'state', sqlstate);
  end;
  execute 'reset role';
  return v_r;
end $$;
create or replace function pg_temp.lock_try(p int) returns jsonb language plpgsql as $$
declare v_r jsonb;
begin
  perform pg_temp.as_user(1);
  begin
    v_r := public.lock_competition_round_ballots(pg_temp.id('fin', p), gen_random_uuid());
  exception when others then v_r := jsonb_build_object('error', sqlerrm, 'state', sqlstate);
  end;
  execute 'reset role';
  return v_r;
end $$;
create or replace function pg_temp.submit_as(p_user int, p int, p_judge int) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  v := public.submit_competition_ballot(pg_temp.id('fin', p), pg_temp.fh(p), pg_temp.mkr(p, p_judge), gen_random_uuid(), null);
  execute 'reset role';
  return v;
end $$;
create or replace function pg_temp.ballots(p int) returns void language plpgsql as $$
begin
  perform pg_temp.submit_as(11, p, 1); perform pg_temp.submit_as(12, p, 2); perform pg_temp.submit_as(13, p, 3);
end $$;
-- Heat danced + locked, then the ballots locked through the real RPC (HL1 order); returns the lock result.
create or replace function pg_temp.lockit(p int) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(1);
  perform pg_temp.hl1_danced(pg_temp.fh(p));
  perform public.set_competition_heat_lock_state(pg_temp.fh(p), 'locked', 'fixture');
  v := pg_temp.lock_try(p);
  execute 'reset role';
  return v;
end $$;
create or replace function pg_temp.panel(p int) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(1);
  perform public.assign_competition_panel_member(pg_temp.id('fin', p), pg_temp.id('off', 11), 'A', gen_random_uuid());
  perform public.assign_competition_panel_member(pg_temp.id('fin', p), pg_temp.id('off', 12), 'B', gen_random_uuid());
  perform public.assign_competition_panel_member(pg_temp.id('fin', p), pg_temp.id('off', 13), 'C', gen_random_uuid());
  execute 'reset role';
end $$;
create or replace function pg_temp.pin(p int) returns void language plpgsql security definer as $$
begin perform public.pin_competition_round_scoring(pg_temp.id('fin', p)); end $$;
-- "Start" = the round status update the start guard sits on (A0 suite does the same; superuser, replica mode, the ENABLE ALWAYS guard still fires).
create or replace function pg_temp.start(p int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.su(format($q$update public.event_competition_rounds set status = 'active' where id = %L$q$, pg_temp.id('fin', p)));
  return jsonb_build_object('error', 'OK');
exception when others then return jsonb_build_object('error', sqlerrm, 'state', sqlstate);
end $$;
create or replace function pg_temp.set_elig(p_n int, p_k int, p_elig text) returns void language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_entries set eligibility_status = p_elig where id = pg_temp.id('ent', p_n, p_k);
  perform set_config('session_replication_role', 'origin', true);
end $$;
create or replace function pg_temp.fin_entries(p_n int) returns bigint language sql security definer as $$
  select count(*) from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
  where h.round_id = pg_temp.id('fin', p_n) and h.status <> 'cancelled' and he.status <> 'scratched' $$;
create or replace function pg_temp.nheats(p_n int) returns bigint language sql security definer as $$
  select count(*) from public.event_competition_heats h where h.round_id = pg_temp.id('fin', p_n) $$;
-- Final-only division n in program p_prog (1 = promote_callback, 2 = none): no preliminary round, k entries, one scheduled heat, round 'scheduled'.
create or replace function pg_temp.mkf(p_n int, p_prog int, p_k int) returns void
language plpgsql security definer as $$
declare
  v_event uuid := pg_temp.id('evt', 1);
  v_ver uuid := pg_temp.id('sv', 1);
  v_k int;
begin
  perform set_config('session_replication_role', 'replica', true);
  insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
  values (pg_temp.id('div', p_n), v_event, pg_temp.id('prg', p_prog), pg_temp.id('cts', p_prog), 'F' || p_n, 'open');
  insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
  values (pg_temp.id('fin', p_n), v_event, pg_temp.id('prg', p_prog), pg_temp.id('div', p_n), 'F' || p_n || ' Final', 'final', 1, 'scheduled', 'ordinal_majority');
  for v_k in 1..p_k loop
    insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
    values (pg_temp.id('ent', p_n, v_k), v_event, pg_temp.id('prg', p_prog), pg_temp.id('div', p_n), 'f' || p_n || '-' || v_k, 'confirmed', 'eligible', (p_n * 10 + v_k)::text);
  end loop;
  insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values (pg_temp.id('cbf', p_n), v_event, v_ver, p_n);
  insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
  values (pg_temp.id('fhx', p_n), v_event, pg_temp.id('div', p_n), pg_temp.id('fin', p_n), 1, 'scheduled', 'open', pg_temp.id('cts', p_prog), v_ver, pg_temp.id('cbf', p_n));
  insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number) values (v_event, pg_temp.id('fhx', p_n), 'waltz', 'Waltz', 1);
  insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
  select v_event, pg_temp.id('div', p_n), pg_temp.id('fhx', p_n), pg_temp.id('ent', p_n, k), k, 'scheduled' from generate_series(1, p_k) k;
  perform set_config('session_replication_role', 'origin', true);
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;
-- A4 override: every RPC wrapper (ap / req / cos / flow go through try) hands the session back to the superuser, so later checks can read the tables.
create or replace function pg_temp.try(p_sql text) returns jsonb
language plpgsql as $$
declare r jsonb;
begin
  begin
    execute p_sql into r;
  exception when others then
    execute 'reset role';
    return jsonb_build_object('error', sqlerrm, 'state', sqlstate);
  end;
  execute 'reset role';
  return r;
end $$;
grant execute on function pg_temp.try(text) to authenticated, anon, service_role;
-- The heat danced and locked (HL1 order) WITHOUT locking the ballots; lockit = prelock + lock.
create or replace function pg_temp.prelock(p int) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(1);
  perform pg_temp.hl1_danced(pg_temp.fh(p));
  perform public.set_competition_heat_lock_state(pg_temp.fh(p), 'locked', 'fixture');
  execute 'reset role';
end $$;
grant execute on function pg_temp.prelock(int) to authenticated, anon, service_role;
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
  values (pg_temp.id('src', p_n), v_event, pg_temp.id('prg', p_e), pg_temp.id('div', p_n), 'D' || p_n || ' Callback', 'preliminary', 1, 'approved', 'callback_tally', greatest(p_adv, 2));
  insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
  values (pg_temp.id('fin', p_n), v_event, pg_temp.id('prg', p_e), pg_temp.id('div', p_n), 'D' || p_n || ' Final', 'final', 2, p_fin, 'ordinal_majority');
  for v_k in 1..p_entries loop
    insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
    values (pg_temp.id('ent', p_n, v_k), v_event, pg_temp.id('prg', p_e), pg_temp.id('div', p_n), 'e' || p_n || '-' || v_k, 'confirmed', 'eligible', (p_n * 10 + v_k)::text);
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

-- A co-signed exclusion of (round n, entry k) written as the A5 definer functions would (superuser stands in; the A5 suite covers the real functions).
create or replace function pg_temp.exclude(p_n int, p_k int, p_seq int) returns void
language plpgsql security definer as $$
declare v_req uuid := gen_random_uuid();
begin
  insert into public.event_competition_round_exclusions
    (id, event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id)
  values (v_req, pg_temp.id('evt', 1), pg_temp.id('fin', p_n), pg_temp.id('ent', p_n, p_k), '{}', 'exclude_requested', 'other', 'Danced, then refunded', pg_temp.id('user', 1), 'manager', gen_random_uuid(), p_seq, null);
  insert into public.event_competition_round_exclusions
    (event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id)
  values (pg_temp.id('evt', 1), pg_temp.id('fin', p_n), pg_temp.id('ent', p_n, p_k), '{}', 'exclude_cosigned', 'other', 'Danced, then refunded', pg_temp.id('user', 2), 'chair', gen_random_uuid(), p_seq + 1, v_req);
end $$;
-- NS1: the manager marks the couple's Final heat entry a no-show (real RPC).
create or replace function pg_temp.noshow(p_n int, p_k int) returns jsonb language plpgsql as $$
begin
  perform pg_temp.as_user(1);
  begin
    return public.mark_competition_heat_no_show((select he.id from public.event_competition_heat_entries he where he.heat_id = pg_temp.fh(p_n) and he.entry_id = pg_temp.id('ent', p_n, p_k)),
                                                'Did not report to the floor', gen_random_uuid());
  exception when others then return jsonb_build_object('error', sqlerrm, 'state', sqlstate);
  end;
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures
-- ============================================================================
-- Users: 1 owner, 2 admin (co-signer), 11 12 13 judges (instructors).
insert into auth.users (id, email) select pg_temp.id('user', u), 't-cf1a4-u' || u || '@example.test' from unnest(array[1, 2, 11, 12, 13]) u;
insert into public.profiles (id, email, full_name) select id, email, 'CF1A4 ' || split_part(email, '@', 1) from auth.users where email like 't-cf1a4-%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where email like 't-cf1a4-%';
insert into public.studios (id, name, slug) values (pg_temp.id('studio', 1), 'CF1 A4 Studio', 't-cf1a4-a');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.id('user', 1), pg_temp.id('studio', 1), 'studio_owner', true),
  (pg_temp.id('user', 2), pg_temp.id('studio', 1), 'studio_admin', true),
  (pg_temp.id('user', 11), pg_temp.id('studio', 1), 'instructor', true),
  (pg_temp.id('user', 12), pg_temp.id('studio', 1), 'instructor', true),
  (pg_temp.id('user', 13), pg_temp.id('studio', 1), 'instructor', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values (pg_temp.id('evt', 1), pg_temp.id('studio', 1), 'CF1 A4 Comp', 't-cf1a4-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
-- Program 1 promote_callback; program 2 advancement 'none' (Final-only divisions).
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
select pg_temp.id('prg', p), pg_temp.id('evt', 1), pg_temp.id('studio', 1), 'Program ' || p, 'country', 'relative', 'skating', 'configured', case when p = 1 then 'promote_callback' else 'none' end
from generate_series(1, 2) p;
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
select pg_temp.id('cts', p), pg_temp.id('evt', 1), pg_temp.id('prg', p), 'Contest ' || p, 'single_dance', 'pro_am', 'open' from generate_series(1, 2) p;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values (pg_temp.id('sv', 1), pg_temp.id('evt', 1), 1, 'V1', 'published', now());
insert into public.event_competition_officials (id, event_id, user_id, role, status)
select pg_temp.id('off', u), pg_temp.id('evt', 1), pg_temp.id('user', u), 'judge', 'active' from unnest(array[11, 12, 13]) u;

-- Programs profiled, locked (REG), as the F2 / A3 suites do, so rounds can be pinned.
do $$
begin
  if to_regprocedure('public.pin_competition_round_scoring(uuid)') is null then
    raise exception 'CF1 A4 suite needs REG 20270113 (pin_competition_round_scoring)';
  end if;
  set local session_replication_role = replica;
  update public.event_competition_programs set rules_profile_key = 'studio_simple', rules_profile_version = 1, profile_locked_at = now();
  insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at)
  select id, event_id, 'studio_simple', 1, jsonb_build_object('profile', jsonb_build_object('key', 'studio_simple', 'version', 1)), profile_locked_at from public.event_competition_programs;
  set local session_replication_role = origin;
end $$;

-- Callback scenarios (mk n, entries, advanced): 1 happy path T=2 | 2 one advanced | 3 none advanced | 4 three advanced (withdraw to two) | 5 two advanced (withdraw refused)
-- 6 three advanced (unrecorded scratch) | 7 two advanced, one ineligible at start | 8 no-show before lock | 9 exclusion before calculate | 10 exclusion before approve
-- 11 stale couple after start, restored | 12 two advanced, ineligible couple at lock (ENTRY_UNAVAILABLE precedes MINIMUM)
select pg_temp.mk(1, 1, 4, 2);
select pg_temp.mk(2, 1, 4, 1);
select pg_temp.mk(3, 1, 4, 0);
select pg_temp.mk(4, 1, 4, 3);
select pg_temp.mk(5, 1, 4, 2);
select pg_temp.mk(6, 1, 4, 3);
select pg_temp.mk(7, 1, 4, 2);
select pg_temp.mk(8, 1, 4, 2);
select pg_temp.mk(9, 1, 4, 2);
select pg_temp.mk(10, 1, 4, 2);
select pg_temp.mk(11, 1, 4, 2);
select pg_temp.mk(12, 1, 4, 2);
-- Final-only: 21 one couple in the Final-only program | 22 one couple in a Final-only division of the CALLBACK program (U60) | 23 two couples, control
select pg_temp.mkf(21, 2, 1);
select pg_temp.mkf(22, 1, 1);
select pg_temp.mkf(23, 2, 2);
select pg_temp.panel(n) from unnest(array[1, 7, 8, 9, 10, 11, 12, 21, 22, 23]) n;
select pg_temp.pin(n) from unnest(array[1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 21, 22, 23]) n;

select pg_temp.ap(4, 4);
select pg_temp.req('withdraw', 4, 1, 1, 41);
select pg_temp.req('withdraw', 4, 2, 1, 42);
select pg_temp.ap(6, 6);
select pg_temp.req('withdraw', 6, 1, 1, 61);
commit;

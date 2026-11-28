-- Competition P1 restricted pilot (20270301180000) -- refusal and happy-path suite. DRAFT: first run stopped in setup; repaired by review, not re-run.
-- Needs fixtures/r15_clear_entries.sql prepended on a chain with R-15 (S4).
-- Run as a SUPERUSER (supabase_admin) on a LOCAL QA database. One transaction, synthetic fixtures (UUID block ...-b1c0deXXXXXX), nothing persists.
-- The final block ALWAYS raises: "COMPETITION P1 PILOT RESTRICTIONS SQL SUITE PASS (<n> checks)" or "... FAIL: <failures>".
--
-- Superuser writes: base data only (users, studio, roles, events, programs, contests, divisions, dances, entries, one registration). Every later state change and
-- every refused attempt runs as role authenticated (set_config role + JWT claims: table privileges and RLS apply; NOT an HTTP request) through real functions or
-- plain table writes. No session_replication_role. ONE possible exception, section Z: event deletion (see there).
--
-- Chain: P1 itself requires 20270301090000 (R-11, PR 865) and 20270301141000 (S6, PR 877), so the whole suite needs both. Checks that depend on their behaviour:
--   H1 (calculator with a substantive reason: R-11 would allow it, only P1 refuses); X1-X5 (S6 refusal codes / S6 lifecycle RPC).
-- Option D (20270301170000) is optional: where a direct client write can be refused first by D (COMPD_*), 10D (COMP10D_*), S6 or U18, the check accepts that
-- code or the P1 code. State read-back is asserted in every refusal.
--
-- NOT covered (no real client caller reaches them, or they need concurrency): COMP_P1_BUSY; COMP_P1_ADVANCEMENT_OFF (callback rounds cannot exist);
-- the publication-insert sanction guard (sanctioning is fixed once a program is published, so approval refuses first); the P1 PLACEMENT-removal backstop
-- (S6 refuses direct writes first and the lifecycle / registration-sync paths refuse or skip a started heat first: section X proves the couple stays); the refund
-- path (_r2_apply_participation needs service-role Stripe refund fixtures). The entry guard's COMP_P1_STARTED_HEAT is expected from X5. The placement
-- guard's add branch is not reached on the composed chain: earlier triggers refuse X6 and X7 (10D) and X8 (U18-S). U5 is likewise refused by Option D
-- before the one-published-order index. No case was removed.
begin;
do $tx$
begin
  if now() = statement_timestamp() then
    raise exception 'P1 suite refused: run it inside one explicit transaction, on a local QA database only';
  end if;
  if (select count(*) from pg_trigger where tgname like 'zz\_compp1\_%' and not tgisinternal and tgenabled = 'A') <> 16
     or (select count(*) from pg_class where relkind = 'i' and relname in ('compp1_one_round_per_division', 'compp1_one_heat_per_round', 'compp1_one_published_order', 'compp1_one_dance_per_heat')) <> 4 then
    raise exception 'P1 suite refused: 20270301180000 is not installed as expected (16 ENABLE ALWAYS triggers, 4 indexes).';
  end if;
end $tx$;

create temp table t_results (seq serial, name text, ok boolean, detail text) on commit drop;
create temp table t_v (k text primary key, id uuid) on commit drop;

-- ids ----------------------------------------------------------------------------------------------------------------------------------------
create function pg_temp.u(s text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-b1c0de' || s)::uuid $$;
create function pg_temp.did(d int) returns uuid language sql immutable as $$ select pg_temp.u('0030' || lpad(d::text, 2, '0')) $$;
create function pg_temp.rid(d int) returns uuid language sql immutable as $$ select pg_temp.u('0060' || lpad(d::text, 2, '0')) $$;
create function pg_temp.eid(d int, i int) returns uuid language sql immutable as $$ select pg_temp.u('08' || lpad(d::text, 2, '0') || lpad(i::text, 2, '0')) $$;
create function pg_temp.ev(n int) returns uuid language sql immutable as $$ select pg_temp.u('00e00' || n) $$;
create function pg_temp.a1() returns uuid language sql immutable as $$ select pg_temp.u('000001') $$;
create function pg_temp.a2() returns uuid language sql immutable as $$ select pg_temp.u('000002') $$;
create function pg_temp.v(p text) returns uuid language sql stable as $$ select id from t_v where k = p $$;
create function pg_temp.heat(p_round int, p_v text) returns uuid language sql stable as $$
  select id from public.event_competition_heats where round_id = pg_temp.rid(p_round) and schedule_version_id = pg_temp.v(p_v) and status <> 'cancelled' $$;
create function pg_temp.fh(p_round int, p_v text) returns uuid language sql stable as $$
  select floor_heat_id from public.event_competition_heats where id = pg_temp.heat(p_round, p_v) $$;
create function pg_temp.he(p_heat uuid, p_entry uuid) returns uuid language sql stable as $$
  select id from public.event_competition_heat_entries where heat_id = p_heat and entry_id = p_entry $$;
create function pg_temp.off(p_event int, p_user text) returns uuid language sql stable as $$
  select id from public.event_competition_officials where event_id = pg_temp.ev(p_event) and user_id = pg_temp.u(p_user) $$;
create function pg_temp.latest(p_round int) returns uuid language sql stable as $$
  select id from public.event_competition_result_versions where round_id = pg_temp.rid(p_round) order by version desc limit 1 $$;
create function pg_temp.rstatus(p_round int) returns text language sql stable as $$ select status from public.event_competition_rounds where id = pg_temp.rid(p_round) $$;
-- ordinal marks for the couples that are on the heat now (not scratched, not no-show), in entry id order
create function pg_temp.marks(p_heat uuid, p_vals int[]) returns jsonb language sql stable as $$
  select jsonb_agg(jsonb_build_object('entry_id', x.entry_id, 'value', p_vals[x.rn]) order by x.rn)
  from (select he.entry_id, row_number() over (order by he.entry_id)::int rn from public.event_competition_heat_entries he
        where he.heat_id = p_heat and he.status <> 'scratched' and not coalesce(public.competition_heat_entry_is_no_show(he.id), false)) x $$;

-- competition state of one event (read by the owner session)
create function pg_temp.state(p_event uuid) returns text language plpgsql as $$
declare t text; part text; out_ text := '';
begin
  foreach t in array array['event_competition_programs', 'event_competition_divisions', 'event_competition_rounds', 'event_competition_schedule_versions',
    'event_competition_floor_heats', 'event_competition_heats', 'event_competition_heat_entries', 'event_competition_heat_dances', 'event_competition_entries',
    'event_competition_ballots', 'event_competition_marks', 'event_competition_result_versions', 'event_competition_result_rows',
    'event_competition_result_approvals', 'event_competition_result_publications', 'event_competition_result_events', 'event_competition_correction_causes'] loop
    execute format('select coalesce(string_agg(to_jsonb(x)::text, %L order by to_jsonb(x)::text), %L) from public.%I x where x.event_id = $1', ',', '', t) into part using p_event;
    out_ := out_ || t || ':' || md5(part) || ';';
  end loop;
  return out_;
end $$;

create function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into t_results (name, ok, detail) values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;

-- run one statement as an authenticated user; returns 'OK <rows>' or 'sqlstate message' (a failed statement leaves nothing behind)
create function pg_temp.try(p_actor uuid, p_sql text) returns text language plpgsql as $$
declare v text; n bigint;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    execute p_sql;
    get diagnostics n = row_count;
    v := 'OK ' || n;
  exception when others then
    v := sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

-- a legitimate action: must succeed and touch at least one row
create function pg_temp.act(p_name text, p_actor uuid, p_sql text) returns void language plpgsql as $$
declare v text;
begin
  v := pg_temp.try(p_actor, p_sql);
  perform pg_temp.chk(p_name, v like 'OK %' and v <> 'OK 0', v);
end $$;

-- a refused attempt: must fail with one of the patterns ('sqlstate message' LIKE) AND leave the event state unchanged; a success is rolled back and fails
create function pg_temp.neg(p_name text, p_event int, p_actor uuid, p_sql text, p_patterns text[]) returns void language plpgsql as $$
declare v text; b text; a text;
begin
  b := pg_temp.state(pg_temp.ev(p_event));
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    execute p_sql;
    raise exception using errcode = 'ZZ999', message = 'statement unexpectedly succeeded';
  exception when others then
    v := sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  a := pg_temp.state(pg_temp.ev(p_event));
  perform pg_temp.chk(p_name, v like any (p_patterns) and a = b, v || case when a = b then '' else ' [STATE CHANGED]' end);
end $$;

-- running order: new draft version with one numbered floor heat per round (all confirmed couples), through the real functions. p_dance_round gets p_dances.
-- Rounds of the judged divisions (1-4, 21) carry their one offered dance: the engine refuses to calculate a heat without exactly one (multi_dance_unsupported).
create function pg_temp.mkorder(p_key text, p_event int, p_rounds int[], p_dance_round int default null, p_dances uuid[] default '{}') returns void language plpgsql as $$
declare v_floor jsonb; v_id uuid; v text;
begin
  select jsonb_agg(jsonb_build_object('number', x.o, 'scoringHeats', jsonb_build_array(jsonb_build_object(
           'divisionId', pg_temp.did(x.n), 'roundId', pg_temp.rid(x.n), 'heatNumber', 1, 'name', 'P1 heat ' || x.n,
           'danceIds', case when x.n = p_dance_round then to_jsonb(p_dances)
                            when x.n in (1, 2, 3, 4, 21) then (select jsonb_agg(dd.dance_id) from public.event_competition_division_dances dd where dd.division_id = pg_temp.did(x.n))
                            else '[]'::jsonb end,
           'entryIds', (select jsonb_agg(e.id order by e.id) from public.event_competition_entries e where e.division_id = pg_temp.did(x.n) and e.status = 'confirmed')))) order by x.o)
    into v_floor from unnest(p_rounds) with ordinality x(n, o);
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.a1(), 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    v_id := public.create_competition_schedule_version(pg_temp.ev(p_event), 'P1 ' || p_key, null);
    perform public.apply_competition_floor_plan(v_id, jsonb_build_object('floorHeats', v_floor));
    v := 'OK';
  exception when others then
    v := sqlstate || ' ' || sqlerrm; v_id := null;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  insert into t_v values (p_key, v_id);
  perform pg_temp.chk('setup: running order ' || p_key || ' drafted', v = 'OK', v);
end $$;

-- the database engine's own rows (read-only computation; not executable by API roles, hence the definer wrapper)
create function pg_temp.run_engine(p_ev jsonb) returns jsonb language sql stable security definer as $$ select public._comppv1_run('ordinal', p_ev) $$;
create function pg_temp.calc(p_round uuid) returns jsonb language plpgsql as $$
declare v_in jsonb; v_res jsonb;
begin
  v_in := public.competition_round_calculation_input(p_round);
  v_res := pg_temp.run_engine(v_in -> 'evidence');
  if not coalesce((v_res ->> 'ok')::boolean, false) then
    raise exception 'P1 suite: the database engine refused: %', v_res ->> 'reason';
  end if;
  return public.calculate_competition_round(p_round, v_in ->> 'engine_key', v_in ->> 'engine_version', v_in ->> 'input_hash',
    encode(sha256(convert_to('[{"step":1}]', 'UTF8')), 'hex'), '[{"step":1}]'::jsonb, v_res -> 'rows', coalesce(v_res -> 'warnings', '[]'::jsonb), gen_random_uuid());
end $$;
grant execute on all functions in schema pg_temp to authenticated;

create function pg_temp.panel(p_event int, p_round int) returns void language plpgsql as $$
declare j record;
begin
  for j in select * from (values ('000011', 'A'), ('000012', 'B'), ('000013', 'C')) x(usr, letter) loop
    perform pg_temp.act('setup: panel ' || j.letter || ' round ' || p_round, pg_temp.a1(),
      format('select public.assign_competition_panel_member(%L, %L, %L, gen_random_uuid())', pg_temp.rid(p_round), pg_temp.off(p_event, j.usr), j.letter));
  end loop;
end $$;
create function pg_temp.sched_start(p_round int) returns void language plpgsql as $$
begin
  perform pg_temp.act('flow: schedule round ' || p_round, pg_temp.a1(), format('select public.schedule_competition_round(%L, gen_random_uuid())', pg_temp.rid(p_round)));
  perform pg_temp.act('flow: start round ' || p_round, pg_temp.a1(), format('select public.start_competition_round(%L, gen_random_uuid())', pg_temp.rid(p_round)));
end $$;
create function pg_temp.advance(p_round int, p_v text, p_to text) returns void language plpgsql as $$
begin
  perform pg_temp.act('flow: heat of round ' || p_round || ' -> ' || p_to, pg_temp.a1(),
    format('select public.advance_competition_floor_heat(%L, %L, gen_random_uuid())', pg_temp.fh(p_round, p_v), p_to));
end $$;
create function pg_temp.ballot(p_name text, p_user text, p_round int, p_v text, p_vals int[], p_reason text default null) returns void language plpgsql as $$
begin
  perform pg_temp.act(p_name, pg_temp.u(p_user), format('select public.submit_competition_ballot(%L, %L, %L::jsonb, gen_random_uuid(), %L)',
    pg_temp.rid(p_round), pg_temp.heat(p_round, p_v), pg_temp.marks(pg_temp.heat(p_round, p_v), p_vals), p_reason));
end $$;
create function pg_temp.lock_and_calc(p_round int, p_v text) returns void language plpgsql as $$
begin
  perform pg_temp.act('flow: lock heat of round ' || p_round, pg_temp.a1(), format('select public.set_competition_heat_lock_state(%L, %L, %L)', pg_temp.heat(p_round, p_v), 'locked', 'P1 suite heat lock'));
  perform pg_temp.act('flow: lock ballots of round ' || p_round, pg_temp.a1(), format('select public.lock_competition_round_ballots(%L, gen_random_uuid())', pg_temp.rid(p_round)));
end $$;
create function pg_temp.calculate(p_round int) returns void language plpgsql as $$
begin
  perform pg_temp.act('flow: calculate round ' || p_round || ' by A1', pg_temp.a1(), format('select pg_temp.calc(%L)', pg_temp.rid(p_round)));
end $$;

-- direct-write statement builders (text only; executed as authenticated)
create function pg_temp.new_round(p_event int, p_program text, p_div int, p_id uuid, p_seq int, p_type text default 'final', p_scoring text default 'ordinal_majority') returns text language sql as $$
  select format('insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values (%L, %L, %L, %L, %L, %L, %s, %L, %L)',
    p_id, pg_temp.ev(p_event), pg_temp.u(p_program), pg_temp.did(p_div), 'Round ' || p_div || '.' || p_seq, p_type, p_seq, 'draft', p_scoring) $$;
create function pg_temp.new_division(p_event int, p_program text, p_contest text, p_id uuid, p_name text) returns text language sql as $$
  select format('insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values (%L, %L, %L, %L, %L, %L)',
    p_id, pg_temp.ev(p_event), pg_temp.u(p_program), pg_temp.u(p_contest), p_name, 'open') $$;
create function pg_temp.new_program(p_event int, p_id uuid) returns text language sql as $$
  select format('insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values (%L, %L, %L, %L, %L, %L, %L, %L)',
    p_id, pg_temp.ev(p_event), pg_temp.u('00a001'), 'Extra program', 'country', 'relative', 'skating', 'draft') $$;

-- ============================================================================
-- Base data (superuser)
-- ============================================================================
insert into auth.users (id, email)
select pg_temp.u(s), 't-p1-' || s || '@example.test' from unnest(array['000001', '000002', '000011', '000012', '000013']) s;
insert into public.profiles (id, email, full_name) select id, email, 'P1 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-b1c0de%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-b1c0de%';
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'P1 Studio', 't-p1-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active)
select pg_temp.u(s), pg_temp.u('00a001'), (case when s in ('000001', '000002') then 'studio_owner' else 'instructor' end)::public.app_role, true
from unnest(array['000001', '000002', '000011', '000012', '000013']) s;
-- E1 main (none), E2 declares a governing body, E3 never starts (planner edits and deletion)
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required, competition_sanctioning)
select pg_temp.ev(n), pg_temp.u('00a001'), 'P1 Comp ' || n, 't-p1-e' || n, 'competition', current_date + 30, current_date + 30, 'published', 'public', true,
       case when n = 2 then 'ndca' else 'none' end from generate_series(1, 3) n;
-- programs: 001001 E1 (published below), 001002 E1 spare (stays draft), 001003 E2, 001004 E3
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, rules_profile_key, rules_profile_version)
select pg_temp.u(x.p), pg_temp.ev(x.e), pg_temp.u('00a001'), 'Program ' || x.p, 'country', 'relative', 'skating', 'draft', x.k, case when x.k is not null then 1 end
from (values ('001001', 1, 'studio_simple'), ('001002', 1, null), ('001003', 2, 'studio_simple'), ('001004', 3, null)) x(p, e, k);
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
select pg_temp.u(x.c), pg_temp.ev(x.e), pg_temp.u(x.p), 'Category ' || x.c, 'exhibition', 'pro_am', 'open'
from (values ('002001', 1, '001001'), ('002002', 1, '001002'), ('002003', 2, '001003'), ('002004', 3, '001004')) x(c, e, p);
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
select pg_temp.did(x.d), pg_temp.ev(x.e), pg_temp.u(x.p), pg_temp.u(x.c), 'D' || x.d, 'open'
from (values (1, 1, '001001', '002001'), (2, 1, '001001', '002001'), (3, 1, '001001', '002001'), (4, 1, '001001', '002001'), (5, 1, '001001', '002001'),
             (6, 1, '001002', '002002'), (7, 1, '001002', '002002'), (8, 1, '001002', '002002'),
             (21, 2, '001003', '002003'), (31, 3, '001004', '002004'), (32, 3, '001004', '002004')) x(d, e, p, c);
insert into public.event_competition_dances (id, event_id, program_id, dance_key, name, category_label, sort_order)
values (pg_temp.u('00d001'), pg_temp.ev(1), pg_temp.u('001001'), 'waltz', 'Waltz', 'Smooth', 10),
       (pg_temp.u('00d002'), pg_temp.ev(1), pg_temp.u('001001'), 'two_step', 'Two Step', 'Rhythm', 20);
insert into public.event_competition_division_dances (event_id, program_id, division_id, dance_id, entry_fee, currency, required, sort_order)
values (pg_temp.ev(1), pg_temp.u('001001'), pg_temp.did(5), pg_temp.u('00d001'), 0, 'USD', false, 10),
       (pg_temp.ev(1), pg_temp.u('001001'), pg_temp.did(5), pg_temp.u('00d002'), 0, 'USD', false, 20);
insert into public.event_registrations (id, event_id, studio_id, attendee_first_name, attendee_last_name, attendee_email, status, payment_status)
values (pg_temp.u('00f001'), pg_temp.ev(1), pg_temp.u('00a001'), 'Reg', 'One', 't-p1-reg@example.test', 'confirmed', 'paid');
-- couples: D1 3 (+ one pending, entry 4), D2 3, D3 1, D4 4 (entry 1 registration-linked), D5 2, D21 3, D31 2, D32 2
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number, registration_id)
select pg_temp.eid(d.id_n, i), d.event_id, d.program_id, d.id, 'Couple ' || d.id_n || '-' || i,
       case when d.id_n = 1 and i = 4 then 'pending' else 'confirmed' end, 'eligible', (d.id_n * 10 + i)::text,
       case when d.id_n = 4 and i = 1 then pg_temp.u('00f001') end
from (select dv.*, x.n as id_n, x.c from (values (1, 4), (2, 3), (3, 1), (4, 4), (5, 2), (21, 3), (31, 2), (32, 2)) x(n, c)
      join public.event_competition_divisions dv on dv.id = pg_temp.did(x.n)) d
cross join lateral generate_series(1, d.c) i;
-- one dance for each judged division, and every one of its couples registered for it (event 2 needs its own dance)
insert into public.event_competition_dances (id, event_id, program_id, dance_key, name, category_label, sort_order)
values (pg_temp.u('00d021'), pg_temp.ev(2), pg_temp.u('001003'), 'waltz', 'Waltz', 'Smooth', 10);
insert into public.event_competition_division_dances (event_id, program_id, division_id, dance_id, entry_fee, currency, required, sort_order)
select dv.event_id, dv.program_id, dv.id, case when x.n = 21 then pg_temp.u('00d021') else pg_temp.u('00d001') end, 0, 'USD', false, 10
from (values (1), (2), (3), (4), (21)) x(n) join public.event_competition_divisions dv on dv.id = pg_temp.did(x.n);
insert into public.event_competition_entry_dances (event_id, entry_id, division_dance_id, dance_key, dance_label)
select e.event_id, e.id, dd.id, 'waltz', 'Waltz'
from public.event_competition_entries e
join public.event_competition_division_dances dd on dd.division_id = e.division_id and dd.event_id = e.event_id
where e.division_id in (select pg_temp.did(n) from unnest(array[1, 2, 3, 4, 21]) n);
-- S4/R-15: running orders are published and rounds started, so the seeded couples need clearance before that. Clearance is recorded through
-- set_competition_entry_eligibility (fixtures/r15_clear_entries.sql, prepended by the runner; it also gives each couple an adult participant, S5). This
-- suite's three events only. Inert without R-15.
do $r15$
begin
  if to_regprocedure('pg_temp.r15_clear_entries(uuid)') is not null then
    perform pg_temp.r15_clear_entries(pg_temp.ev(n)) from generate_series(1, 3) n;
  end if;
end $r15$;

-- ============================================================================
-- E3: pre-start planner edits stay possible; recreate routes closed even before the start
-- ============================================================================
select pg_temp.act('P0 E3: add round D31', pg_temp.a1(), pg_temp.new_round(3, '001004', 31, pg_temp.rid(31), 1));
select pg_temp.act('P0 E3: add round D32', pg_temp.a1(), pg_temp.new_round(3, '001004', 32, pg_temp.rid(32), 1));
select pg_temp.act('P1 pre-start: add a program', pg_temp.a1(), pg_temp.new_program(3, pg_temp.u('0010f3')));
select pg_temp.act('P2 pre-start: remove that program', pg_temp.a1(), format('delete from public.event_competition_programs where id = %L', pg_temp.u('0010f3')));
select pg_temp.act('P3 pre-start: add a division', pg_temp.a1(), pg_temp.new_division(3, '001004', '002004', pg_temp.u('0030f3'), 'Extra'));
select pg_temp.act('P4 pre-start: remove that division', pg_temp.a1(), format('delete from public.event_competition_divisions where id = %L', pg_temp.u('0030f3')));
select pg_temp.mkorder('E3A', 3, array[31, 32]);
select pg_temp.act('P5 pre-start: move a scoring heat to a new numbered heat', pg_temp.a1(), format('select public.move_competition_scoring_heat_to_new_floor_heat(%L, 1)', pg_temp.heat(32, 'E3A')));
select pg_temp.act('P6 pre-start: reorder numbered heats', pg_temp.a1(), format('select public.move_competition_floor_heat(%L, 2)', pg_temp.fh(32, 'E3A')));
select pg_temp.act('P7 pre-start: renumber a draft scoring heat', pg_temp.a1(), format('update public.event_competition_heats set heat_number = 5 where id = %L', pg_temp.heat(31, 'E3A')));
select pg_temp.act('P8 pre-start: clear the draft plan', pg_temp.a1(), format('select public.clear_competition_floor_plan(%L)', pg_temp.v('E3A')));
select pg_temp.mkorder('E3B', 3, array[31, 32]);
select pg_temp.act('P9 pre-start: publish an order', pg_temp.a1(), format('select public.publish_competition_schedule_version(%L)', pg_temp.v('E3B')));
select pg_temp.mkorder('E3C', 3, array[31, 32]);
select pg_temp.act('P10 pre-start: replace the published order', pg_temp.a1(), format('select public.publish_competition_schedule_version(%L)', pg_temp.v('E3C')));
select pg_temp.chk('P11 the old order is superseded and exactly one is published',
  (select status from public.event_competition_schedule_versions where id = pg_temp.v('E3B')) = 'superseded'
  and (select count(*) from public.event_competition_schedule_versions where event_id = pg_temp.ev(3) and status in ('published', 'live')) = 1);
select pg_temp.act('CS0 pre-start: cancel a round', pg_temp.a1(), format('select public.cancel_competition_round(%L, %L, gen_random_uuid())', pg_temp.rid(32), 'planner change'));
select pg_temp.neg('CS1 pre-start: cancel then recreate is refused by the one-round index', 3, pg_temp.a1(),
  pg_temp.new_round(3, '001004', 32, pg_temp.u('0060f2'), 2), array['23505 %compp1_one_round_per_division%']);
select pg_temp.neg('NC0 pre-start: a second round in a division is refused by the one-round index', 3, pg_temp.a1(),
  pg_temp.new_round(3, '001004', 31, pg_temp.u('0060f1'), 2), array['23505 %compp1_one_round_per_division%']);

-- ============================================================================
-- E1 setup (through real functions)
-- ============================================================================
select pg_temp.act('setup: E1 round D' || n, pg_temp.a1(), pg_temp.new_round(1, '001001', n, pg_temp.rid(n), 1)) from generate_series(1, 5) n;
select pg_temp.act('setup: E1 round D7 (spare program, no heats)', pg_temp.a1(), pg_temp.new_round(1, '001002', 7, pg_temp.rid(7), 1));
select pg_temp.act('setup: publish E1 program', pg_temp.a1(), format('select public.publish_competition_program(%L)', pg_temp.u('001001')));
select pg_temp.act('setup: E1 judge ' || s, pg_temp.a1(), format('select public.add_competition_official(%L, %L, %L, gen_random_uuid())', pg_temp.ev(1), pg_temp.u(s), 'judge'))
from unnest(array['000011', '000012', '000013']) s;
select pg_temp.panel(1, 1); select pg_temp.panel(1, 3); select pg_temp.panel(1, 4);
select pg_temp.mkorder('V1', 1, array[1, 2, 3, 4]);
select pg_temp.act('setup: publish E1 order V1', pg_temp.a1(), format('select public.publish_competition_schedule_version(%L)', pg_temp.v('V1')));
select pg_temp.mkorder('V2', 1, array[2, 5], 5, array[pg_temp.u('00d001')]);   -- stays a draft
select pg_temp.act('setup: scratch couple 4-3 before the start', pg_temp.a1(),
  format('select public.change_competition_entry_lifecycle(%L, %L, %L, %L)', pg_temp.eid(4, 3), 'scratched', 'cannot attend', 'retain'));

-- pre-start negatives
select pg_temp.neg('F1 insert of a non-final round', 1, pg_temp.a1(), pg_temp.new_round(1, '001002', 6, pg_temp.u('0060f6'), 1, 'preliminary'), array['P0001 COMP_P1_FINAL_ONLY%']);
select pg_temp.neg('F2 retype of a round', 1, pg_temp.a1(), format('update public.event_competition_rounds set round_type = %L where id = %L', 'semifinal', pg_temp.rid(7)), array['P0001 COMP_P1_FINAL_ONLY%']);
select pg_temp.neg('F3 callback scoring', 1, pg_temp.a1(), pg_temp.new_round(1, '001002', 6, pg_temp.u('0060f6'), 1, 'final', 'callback_tally'), array['P0001 COMP_P1_CALLBACKS_OFF%']);
select pg_temp.neg('NC1 pre-start: second round in a published program division', 1, pg_temp.a1(),
  pg_temp.new_round(1, '001001', 2, pg_temp.u('0060f2'), 2), array['23505 %compp1_one_round_per_division%']);
select pg_temp.neg('U1 second heat of a round in a version (direct)', 1, pg_temp.a1(),
  format('insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status) values (%L, %L, %L, 78, %L, %L, %L, %L)',
    pg_temp.ev(1), pg_temp.did(5), pg_temp.rid(5), pg_temp.u('002001'), pg_temp.v('V2'), pg_temp.fh(2, 'V2'), 'scheduled'), array['23505 %compp1_one_heat_per_round%']);
select pg_temp.neg('U2 second dance on a heat (direct)', 1, pg_temp.a1(),
  format('insert into public.event_competition_heat_dances (event_id, heat_id, dance_id, dance_key, dance_label, sequence_number) values (%L, %L, %L, %L, %L, 2)',
    pg_temp.ev(1), pg_temp.heat(5, 'V2'), pg_temp.u('00d002'), 'two_step', 'Two Step'), array['23505 %compp1_one_dance_per_heat%']);
select pg_temp.act('setup: empty draft V4', pg_temp.a1(), format('select public.create_competition_schedule_version(%L, %L, null)', pg_temp.ev(1), 'P1 V4'));
insert into t_v select 'V4', id from public.event_competition_schedule_versions where event_id = pg_temp.ev(1) and name = 'P1 V4';
select pg_temp.neg('U3 planner: two scoring heats of one round', 1, pg_temp.a1(),
  format('select public.apply_competition_floor_plan(%L, %L::jsonb)', pg_temp.v('V4'), jsonb_build_object('floorHeats', (
    select jsonb_agg(jsonb_build_object('number', i, 'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.did(5), 'roundId', pg_temp.rid(5), 'heatNumber', i,
      'danceIds', '[]'::jsonb, 'entryIds', jsonb_build_array(pg_temp.eid(5, i))))) order by i) from generate_series(1, 2) i))), array['23505 %compp1_one_heat_per_round%']);
select pg_temp.neg('U4 planner: a scoring heat with two dances', 1, pg_temp.a1(),
  format('select public.apply_competition_floor_plan(%L, %L::jsonb)', pg_temp.v('V4'), jsonb_build_object('floorHeats', jsonb_build_array(jsonb_build_object('number', 1,
    'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.did(5), 'roundId', pg_temp.rid(5), 'heatNumber', 1,
      'danceIds', jsonb_build_array(pg_temp.u('00d001'), pg_temp.u('00d002')), 'entryIds', jsonb_build_array(pg_temp.eid(5, 1)))))))), array['23505 %compp1_one_dance_per_heat%']);
select pg_temp.neg('U5 a second published running order (direct)', 1, pg_temp.a1(),
  format('update public.event_competition_schedule_versions set status = %L, published_at = now() where id = %L', 'published', pg_temp.v('V2')),
  array['23505 %compp1_one_published_order%', '42501 COMPD_PUBLISHED_ORDER_WRITE_REFUSED%']);

-- ============================================================================
-- E1: the event starts (round 1 active, no heat called yet)
-- ============================================================================
select pg_temp.sched_start(1);
select pg_temp.neg('O1 running-order replacement by publication', 1, pg_temp.a1(),
  format('select public.publish_competition_schedule_version(%L)', pg_temp.v('V2')), array['P0001 COMP_P1_ORDER_FROZEN%']);
select pg_temp.neg('B1 ballot for a heat that has not started', 1, pg_temp.u('000011'),
  format('select public.submit_competition_ballot(%L, %L, %L::jsonb, gen_random_uuid(), null)', pg_temp.rid(1), pg_temp.heat(1, 'V1'), pg_temp.marks(pg_temp.heat(1, 'V1'), array[1, 2, 3])),
  array['P0001 COMP_P1_HEAT_NOT_STARTED%']);
-- structure
select pg_temp.neg('S1 add a program', 1, pg_temp.a1(), pg_temp.new_program(1, pg_temp.u('0010f1')), array['P0001 COMP_P1_STRUCTURE_FROZEN%']);
select pg_temp.neg('S2 add a division', 1, pg_temp.a1(), pg_temp.new_division(1, '001002', '002002', pg_temp.u('0030f1'), 'Late'), array['P0001 COMP_P1_STRUCTURE_FROZEN%']);
select pg_temp.neg('S3 remove a division', 1, pg_temp.a1(), format('delete from public.event_competition_divisions where id = %L', pg_temp.did(8)), array['P0001 COMP_P1_STRUCTURE_FROZEN%']);
select pg_temp.neg('S4 add a round', 1, pg_temp.a1(), pg_temp.new_round(1, '001002', 6, pg_temp.u('0060f6'), 1), array['P0001 COMP_P1_STRUCTURE_FROZEN%']);
select pg_temp.neg('S5 remove a round', 1, pg_temp.a1(), format('delete from public.event_competition_rounds where id = %L', pg_temp.rid(7)), array['P0001 COMP_P1_STRUCTURE_FROZEN%']);
select pg_temp.neg('S6 cancel a round that has no heats', 1, pg_temp.a1(),
  format('select public.cancel_competition_round(%L, %L, gen_random_uuid())', pg_temp.rid(7), 'running this round again'), array['P0001 COMP_P1_STRUCTURE_FROZEN%']);
select pg_temp.neg('NC2 second round in a division after the start', 1, pg_temp.a1(), pg_temp.new_round(1, '001001', 2, pg_temp.u('0060f2'), 2), array['P0001 COMP_P1_STRUCTURE_FROZEN%']);
select pg_temp.neg('CS2 cancel an unrun round (first step of cancel-and-recreate)', 1, pg_temp.a1(),
  format('select public.cancel_competition_round(%L, %L, gen_random_uuid())', pg_temp.rid(2), 'running this round again'), array['P0001 COMP_P1_ORDER_FROZEN%']);
-- heats through definer functions (these prove the P1 trigger itself)
select pg_temp.neg('H-D1 planner: delete heats (clear a draft plan)', 1, pg_temp.a1(), format('select public.clear_competition_floor_plan(%L)', pg_temp.v('V2')), array['P0001 COMP_P1_ORDER_FROZEN%']);
select pg_temp.neg('H-D2 planner: move a scoring heat', 1, pg_temp.a1(),
  format('select public.move_competition_scoring_heat_to_new_floor_heat(%L, 1)', pg_temp.heat(2, 'V2')), array['P0001 COMP_P1_ORDER_FROZEN%']);
select pg_temp.act('H-D3a a new empty draft may still be created', pg_temp.a1(), format('select public.create_competition_schedule_version(%L, %L, null)', pg_temp.ev(1), 'P1 V3'));
insert into t_v select 'V3', id from public.event_competition_schedule_versions where event_id = pg_temp.ev(1) and name = 'P1 V3';
select pg_temp.neg('H-D3b planner: add a heat', 1, pg_temp.a1(),
  format('select public.apply_competition_floor_plan(%L, %L::jsonb)', pg_temp.v('V3'), jsonb_build_object('floorHeats', jsonb_build_array(jsonb_build_object('number', 1,
    'scoringHeats', jsonb_build_array(jsonb_build_object('divisionId', pg_temp.did(5), 'roundId', pg_temp.rid(5), 'heatNumber', 1,
      'danceIds', '[]'::jsonb, 'entryIds', jsonb_build_array(pg_temp.eid(5, 1)))))))), array['P0001 COMP_P1_ORDER_FROZEN%']);
-- the day-of race script's last step: a replacement order copied from the running one cannot be created once the event has started
select pg_temp.neg('H-D3c copy the running order into a new draft after the start', 1, pg_temp.a1(),
  format('select public.create_competition_schedule_version(%L, %L, %L)', pg_temp.ev(1), 'P1 V-copy', pg_temp.v('V1')), array['P0001 COMP_P1_ORDER_FROZEN%']);
-- heats by direct write
select pg_temp.neg('H-W1 insert a heat', 1, pg_temp.a1(),
  format('insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, contest_id, status) values (%L, %L, %L, 91, %L, %L)',
    pg_temp.ev(1), pg_temp.did(7), pg_temp.rid(7), pg_temp.u('002002'), 'scheduled'), array['P0001 COMP_P1_ORDER_FROZEN%', '42501 COMPD_%']);
select pg_temp.neg('H-W2 renumber a draft heat', 1, pg_temp.a1(),
  format('update public.event_competition_heats set heat_number = 77 where id = %L', pg_temp.heat(2, 'V2')), array['P0001 COMP_P1_ORDER_FROZEN%']);
select pg_temp.neg('H-W3 delete a draft heat', 1, pg_temp.a1(), format('delete from public.event_competition_heats where id = %L', pg_temp.heat(2, 'V2')), array['P0001 COMP_P1_ORDER_FROZEN%']);
select pg_temp.neg('R1 move an unrun published heat to another round', 1, pg_temp.a1(),
  format('update public.event_competition_heats set round_id = %L, division_id = %L, contest_id = %L where id = %L', pg_temp.rid(7), pg_temp.did(7), pg_temp.u('002002'), pg_temp.heat(2, 'V1')),
  array['P0001 COMP_P1_ORDER_FROZEN%', '42501 COMPD_PUBLISHED_ORDER_WRITE_REFUSED%', 'P0001 Heats may only be placed into an editable draft schedule%']);
select pg_temp.neg('H-W4 cancel a published heat', 1, pg_temp.a1(), format('update public.event_competition_heats set status = %L where id = %L', 'cancelled', pg_temp.heat(2, 'V1')),
  array['P0001 COMP_P1_ORDER_FROZEN%', '42501 COMPD_PUBLISHED_ORDER_WRITE_REFUSED%']);
select pg_temp.neg('O2 unpublish the running order', 1, pg_temp.a1(), format('update public.event_competition_schedule_versions set status = %L where id = %L', 'draft', pg_temp.v('V1')),
  array['P0001 COMP_P1_ORDER_FROZEN%', '42501 COMPD_PUBLISHED_ORDER_WRITE_REFUSED%']);
select pg_temp.neg('O3 re-date the published order (published_at)', 1, pg_temp.a1(),
  format('update public.event_competition_schedule_versions set published_at = now() - interval %L where id = %L', '1 day', pg_temp.v('V1')),
  array['P0001 COMP_P1_ORDER_FROZEN%', '42501 COMPD_PUBLISHED_ORDER_WRITE_REFUSED%']);
select pg_temp.neg('O4 re-date the published order (created_at)', 1, pg_temp.a1(),
  format('update public.event_competition_schedule_versions set created_at = now() - interval %L where id = %L', '1 day', pg_temp.v('V1')),
  array['P0001 COMP_P1_ORDER_FROZEN%', '42501 COMPD_PUBLISHED_ORDER_WRITE_REFUSED%']);
select pg_temp.neg('HD1 insert a heat dance', 1, pg_temp.a1(),
  format('insert into public.event_competition_heat_dances (event_id, heat_id, dance_id, dance_key, dance_label, sequence_number) values (%L, %L, %L, %L, %L, 2)',
    pg_temp.ev(1), pg_temp.heat(5, 'V2'), pg_temp.u('00d002'), 'two_step', 'Two Step'), array['P0001 COMP_P1_ORDER_FROZEN%']);
select pg_temp.neg('HD2 change a heat dance', 1, pg_temp.a1(),
  format('update public.event_competition_heat_dances set dance_id = %L, dance_key = %L, dance_label = %L where heat_id = %L', pg_temp.u('00d002'), 'two_step', 'Two Step', pg_temp.heat(5, 'V2')),
  array['P0001 COMP_P1_ORDER_FROZEN%']);
select pg_temp.neg('HD3 delete a heat dance', 1, pg_temp.a1(), format('delete from public.event_competition_heat_dances where heat_id = %L', pg_temp.heat(5, 'V2')), array['P0001 COMP_P1_ORDER_FROZEN%']);

-- ============================================================================
-- Round 1 on the floor
-- ============================================================================
select pg_temp.advance(1, 'V1', 'staging');
select pg_temp.advance(1, 'V1', 'active');
select pg_temp.neg('B2 paper ballot entered by a manager', 1, pg_temp.a1(),
  format('select public.enter_competition_paper_ballot(%L, %L, %L, %L::jsonb, gen_random_uuid())', pg_temp.rid(1), pg_temp.heat(1, 'V1'), pg_temp.off(1, '000011'),
    pg_temp.marks(pg_temp.heat(1, 'V1'), array[1, 2, 3])), array['P0001 COMP_P1_PAPER_BALLOTS_OFF%']);
-- X: couples cannot leave or join a started heat
select pg_temp.neg('X1 scratch through the lifecycle function (existing S6 refusal)', 1, pg_temp.a1(),
  format('select public.change_competition_entry_lifecycle(%L, %L, %L, %L)', pg_temp.eid(1, 1), 'scratched', 'left the floor', 'retain'),
  array['P0001 COMP_ENTRY_LIFECYCLE_PLACED%', 'P0001 COMP_P1_STARTED_HEAT%']);
select pg_temp.neg('X2 delete a placement', 1, pg_temp.a1(), format('delete from public.event_competition_heat_entries where heat_id = %L and entry_id = %L', pg_temp.heat(1, 'V1'), pg_temp.eid(1, 1)),
  array['42501 COMP_S6_PARTICIPATION_WRITER%', '42501 COMP10D_SCHEDULE_PUBLISHED%', 'P0001 COMP_P1_STARTED_HEAT%']);
select pg_temp.neg('X3 scratch a placement', 1, pg_temp.a1(), format('update public.event_competition_heat_entries set status = %L where heat_id = %L and entry_id = %L', 'scratched', pg_temp.heat(1, 'V1'), pg_temp.eid(1, 1)),
  array['42501 COMP_S6_PARTICIPATION_WRITER%', '42501 COMP_U18S_SCRATCH_UNAUDITED%', 'P0001 COMP_P1_STARTED_HEAT%']);
select pg_temp.neg('X4 delete the couple', 1, pg_temp.a1(), format('delete from public.event_competition_entries where id = %L', pg_temp.eid(1, 1)),
  array['42501 COMP_S6_ENTRY_DELETE_WRITER%', 'P0001 COMP_P1_STARTED_HEAT%']);
select pg_temp.neg('X5 withdraw the couple by direct write', 1, pg_temp.a1(), format('update public.event_competition_entries set status = %L where id = %L', 'withdrawn', pg_temp.eid(1, 1)),
  array['42501 COMP_S6_ENTRY_STATUS_WRITER%', 'P0001 COMP_P1_STARTED_HEAT%']);
select pg_temp.neg('X6 insert a couple into a started heat', 1, pg_temp.a1(),
  format('insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values (%L, %L, %L, %L, 9)', pg_temp.ev(1), pg_temp.did(1), pg_temp.heat(1, 'V1'), pg_temp.eid(1, 4)),
  array['P0001 COMP_P1_STARTED_HEAT%', '42501 COMP10D_SCHEDULE_PUBLISHED%']);
select pg_temp.neg('X7 move a couple into a started heat', 1, pg_temp.a1(),
  format('update public.event_competition_heat_entries set heat_id = %L, division_id = %L where id = %L', pg_temp.heat(1, 'V1'), pg_temp.did(1), pg_temp.he(pg_temp.heat(2, 'V1'), pg_temp.eid(2, 1))),
  array['P0001 COMP_P1_STARTED_HEAT%', '42501 COMP10D_SCHEDULE_PUBLISHED%']);

select pg_temp.ballot('flow: round 1 ballot A', '000011', 1, 'V1', array[1, 2, 3]);
select pg_temp.ballot('flow: round 1 ballot B', '000012', 1, 'V1', array[1, 3, 2]);
select pg_temp.ballot('flow: round 1 ballot C', '000013', 1, 'V1', array[2, 1, 3]);
select pg_temp.ballot('B3 a judge may replace their own ballot while the round is active', '000011', 1, 'V1', array[1, 2, 3], 'entered in the wrong order');
select pg_temp.advance(1, 'V1', 'complete');
select pg_temp.lock_and_calc(1, 'V1');
select pg_temp.neg('K1 reopen locked ballots', 1, pg_temp.a1(),
  format('select public.reopen_competition_round_ballots(%L, %L, gen_random_uuid())', pg_temp.rid(1), 'check one ballot again'), array['P0001 COMP_P1_CORRECTIONS_OFF%']);
select pg_temp.calculate(1);
select pg_temp.neg('H1 calculator self-approval with a long reason', 1, pg_temp.a1(),
  format('select public.approve_competition_round_result(%L, %L, %L, gen_random_uuid())', pg_temp.rid(1), pg_temp.latest(1),
    'No other manager is available at the venue today, so I checked every result myself before approving'), array['P0001 COMP_P1_SECOND_APPROVER_REQUIRED%']);
select pg_temp.act('H2 a second manager approves', pg_temp.a2(),
  format('select public.approve_competition_round_result(%L, %L, null, gen_random_uuid())', pg_temp.rid(1), pg_temp.latest(1)));
-- CA: approved, not yet published
select pg_temp.neg('CA1 cancel an independently approved round', 1, pg_temp.a1(),
  format('select public.cancel_competition_round(%L, %L, gen_random_uuid())', pg_temp.rid(1), 'running this round again'), array['P0001 COMP_P1_STRUCTURE_FROZEN%']);
select pg_temp.neg('CA2 run it again as a new round', 1, pg_temp.a1(), pg_temp.new_round(1, '001001', 1, pg_temp.u('0060f1'), 2), array['P0001 COMP_P1_STRUCTURE_FROZEN%']);
select pg_temp.neg('K2 open a correction on an approved result', 1, pg_temp.a1(),
  format('select public.open_competition_round_correction(%L, %L, gen_random_uuid())', pg_temp.rid(1), 'one placing needs another look'), array['P0001 COMP_P1_CORRECTIONS_OFF%']);
select pg_temp.act('H3 publish the approved result', pg_temp.a1(),
  format('select public.publish_competition_round_result(%L, %L, %L, gen_random_uuid())', pg_temp.rid(1), pg_temp.latest(1), 'entrants'));
select pg_temp.chk('H4 happy path state: published, one current publication, second-manager approval without a reason, three ranked couples',
  pg_temp.rstatus(1) = 'published'
  and (select count(*) from public.event_competition_result_publications where round_id = pg_temp.rid(1) and withdrawn_at is null and superseded_by is null) = 1
  and exists (select 1 from public.event_competition_result_approvals a where a.result_version_id = pg_temp.latest(1) and a.approved_by = pg_temp.a2() and a.calculated_by = pg_temp.a1() and a.override_reason is null)
  and (select count(distinct entry_id) from public.event_competition_result_rows where result_version_id = pg_temp.latest(1)) = 3, pg_temp.rstatus(1));
select pg_temp.neg('N1 published couple name', 1, pg_temp.a1(), format('update public.event_competition_entries set display_name = %L where id = %L', 'Renamed', pg_temp.eid(1, 1)), array['P0001 COMP_P1_PUBLISHED_FROZEN%']);
select pg_temp.neg('N2 published entry number', 1, pg_temp.a1(), format('update public.event_competition_entries set entry_number = %L where id = %L', '999', pg_temp.eid(1, 1)), array['P0001 COMP_P1_PUBLISHED_FROZEN%']);
select pg_temp.neg('N3 published round name', 1, pg_temp.a1(), format('update public.event_competition_rounds set name = %L where id = %L', 'Renamed', pg_temp.rid(1)), array['P0001 COMP_P1_PUBLISHED_FROZEN%']);
select pg_temp.neg('N4 published division name', 1, pg_temp.a1(), format('update public.event_competition_divisions set name = %L where id = %L', 'Renamed', pg_temp.did(1)), array['P0001 COMP_P1_PUBLISHED_FROZEN%']);
select pg_temp.neg('N5 published program name', 1, pg_temp.a1(), format('update public.event_competition_programs set name = %L where id = %L', 'Renamed', pg_temp.u('001001')), array['P0001 COMP_P1_PUBLISHED_FROZEN%']);
select pg_temp.act('N6 an unpublished couple can still be renamed', pg_temp.a1(), format('update public.event_competition_entries set display_name = %L where id = %L', 'Renamed ok', pg_temp.eid(2, 1)));
select pg_temp.neg('K3 open a correction on a published result', 1, pg_temp.a1(),
  format('select public.open_competition_round_correction(%L, %L, gen_random_uuid())', pg_temp.rid(1), 'one placing needs another look'), array['P0001 COMP_P1_CORRECTIONS_OFF%']);

-- ============================================================================
-- Round 3: a one-couple final cannot be approved
-- ============================================================================
select pg_temp.sched_start(3);
select pg_temp.advance(3, 'V1', 'staging');
select pg_temp.advance(3, 'V1', 'active');
select pg_temp.ballot('flow: round 3 ballot ' || s, s, 3, 'V1', array[1]) from unnest(array['000011', '000012', '000013']) s;
select pg_temp.advance(3, 'V1', 'complete');
select pg_temp.lock_and_calc(3, 'V1');
select pg_temp.calculate(3);
select pg_temp.neg('M1 approval of a one-couple final', 1, pg_temp.a2(),
  format('select public.approve_competition_round_result(%L, %L, null, gen_random_uuid())', pg_temp.rid(3), pg_temp.latest(3)), array['P0001 COMP_P1_MINIMUM_COUPLES%']);

-- ============================================================================
-- Round 4: un-scratch, registration cancellation, No-show then ballot replacement
-- ============================================================================
select pg_temp.sched_start(4);
select pg_temp.advance(4, 'V1', 'staging');
select pg_temp.advance(4, 'V1', 'active');
select pg_temp.neg('X8 un-scratch a couple into a started heat', 1, pg_temp.a1(),
  format('update public.event_competition_heat_entries set status = %L where id = %L', 'scheduled', pg_temp.he(pg_temp.heat(4, 'V1'), pg_temp.eid(4, 3))),
  array['P0001 COMP_P1_STARTED_HEAT%', '42501 COMP_U18S_UNSCRATCH_WRITER%']);
-- invariant only: the existing registration sync leaves a couple in a started heat alone; the write may succeed or be refused by P1 (reported in the detail).
-- Zero rows or any other refusal fails: the sync would never have run and the invariant would prove nothing.
do $x9$
declare v text;
begin
  v := pg_temp.try(pg_temp.a1(), format('update public.event_registrations set status = %L where id = %L', 'cancelled', pg_temp.u('00f001')));
  perform pg_temp.chk('X9 registration cancellation leaves the couple in the started heat',
    ((v like 'OK %' and v <> 'OK 0') or v like 'P0001 COMP_P1_STARTED_HEAT%')
    and (select status from public.event_competition_entries where id = pg_temp.eid(4, 1)) = 'confirmed'
    and (select status from public.event_competition_heat_entries where id = pg_temp.he(pg_temp.heat(4, 'V1'), pg_temp.eid(4, 1))) = 'scheduled', v);
end $x9$;
select pg_temp.ballot('flow: round 4 ballot ' || s, s, 4, 'V1', array[1, 2, 3]) from unnest(array['000011', '000012', '000013']) s;
select pg_temp.act('B4a manager records a No-show after the ballots', pg_temp.a1(),
  format('select public.mark_competition_heat_no_show(%L, %L, gen_random_uuid())', pg_temp.he(pg_temp.heat(4, 'V1'), pg_temp.eid(4, 4)), 'did not take the floor'));
select pg_temp.ballot('B4b a judge replaces the now stale ballot', '000011', 4, 'V1', array[1, 2], 'a couple did not take the floor');

-- ============================================================================
-- E2: an event that declares a governing body
-- ============================================================================
select pg_temp.act('setup: E2 round', pg_temp.a1(), pg_temp.new_round(2, '001003', 21, pg_temp.rid(21), 1));
select pg_temp.act('setup: publish E2 program', pg_temp.a1(), format('select public.publish_competition_program(%L)', pg_temp.u('001003')));
select pg_temp.act('setup: E2 judge ' || s, pg_temp.a1(), format('select public.add_competition_official(%L, %L, %L, gen_random_uuid())', pg_temp.ev(2), pg_temp.u(s), 'judge'))
from unnest(array['000011', '000012', '000013']) s;
select pg_temp.panel(2, 21);
select pg_temp.mkorder('G1', 2, array[21]);
select pg_temp.act('setup: publish E2 order', pg_temp.a1(), format('select public.publish_competition_schedule_version(%L)', pg_temp.v('G1')));
select pg_temp.sched_start(21);
select pg_temp.advance(21, 'G1', 'staging');
select pg_temp.advance(21, 'G1', 'active');
select pg_temp.ballot('flow: E2 ballot ' || s, s, 21, 'G1', array[1, 2, 3]) from unnest(array['000011', '000012', '000013']) s;
select pg_temp.advance(21, 'G1', 'complete');
select pg_temp.lock_and_calc(21, 'G1');
select pg_temp.calculate(21);
select pg_temp.neg('G2 approval for a declared governing body', 2, pg_temp.a2(),
  format('select public.approve_competition_round_result(%L, %L, null, gen_random_uuid())', pg_temp.rid(21), pg_temp.latest(21)), array['P0001 COMP_P1_SANCTION_BLOCKED%']);

-- ============================================================================
-- Z: event deletion (E3: programs, divisions, rounds incl. a cancelled one, published and superseded orders, heats, placements, couples)
-- Attempted as the manager. If the database gives authenticated no DELETE on events (no error, zero rows), the owner session deletes instead: the P1 triggers
-- are ENABLE ALWAYS and bind the owner too, so the cascade is still proved. The detail of Z1 says which path ran.
-- ============================================================================
do $z$
declare v text; v_path text := 'authenticated';
begin
  v := pg_temp.try(pg_temp.a1(), format('delete from public.events where id = %L', pg_temp.ev(3)));
  if v = 'OK 0' or v like '42501 permission denied for table events%' then
    v_path := 'owner session (authenticated: ' || v || ')';
    begin
      delete from public.events where id = pg_temp.ev(3);
      v := 'OK 1';
    exception when others then
      v := sqlstate || ' ' || sqlerrm;
    end;
  end if;
  perform pg_temp.chk('Z1 deleting an event cascades through the P1 triggers', v = 'OK 1', v_path || ': ' || v);
  perform pg_temp.chk('Z2 nothing of the deleted event remains',
    not exists (select 1 from public.events where id = pg_temp.ev(3))
    and not exists (select 1 from public.event_competition_programs where event_id = pg_temp.ev(3))
    and not exists (select 1 from public.event_competition_rounds where event_id = pg_temp.ev(3))
    and not exists (select 1 from public.event_competition_heats where event_id = pg_temp.ev(3))
    and not exists (select 1 from public.event_competition_entries where event_id = pg_temp.ev(3)));
end $z$;

do $end$
declare n int; f text;
begin
  select count(*), string_agg(name || ' [' || left(detail, 300) || ']', ' | ' order by seq) filter (where not ok) into n, f from t_results;
  if f is null then
    raise exception 'COMPETITION P1 PILOT RESTRICTIONS SQL SUITE PASS (% checks)', n;
  end if;
  raise exception 'COMPETITION P1 PILOT RESTRICTIONS SQL SUITE FAIL: %', f;
end $end$;
rollback;

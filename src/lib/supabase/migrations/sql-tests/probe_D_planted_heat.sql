-- Option D probe: does a planted heat (no schedule version, under a draft numbered floor heat) leave a PUBLISHED order's entries and dances
-- directly writable? Executed writes as authenticated manager A1, read back afterwards. LOCAL QA DATABASE ONLY, superuser; the last block always
-- raises, so nothing persists: "D PROBE: REPRODUCED ..." or "D PROBE: NOT REPRODUCED ...".
begin;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.u(p text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-d0d0ff' || p)::uuid $$;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;
insert into auth.users (id, email) values (pg_temp.u('000001'), 't-d-a1@example.test');
insert into public.profiles (id, email, full_name) values (pg_temp.u('000001'), 't-d-a1@example.test', 'D A1');
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
values (pg_temp.u('000001'), 't-d-a1@example.test', now(), now(), 'otp', 'web_callback', 'bound', now());
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'D Studio', 't-d-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
select pg_temp.u('00e00' || n), pg_temp.u('00a001'), 'D Comp ' || n, 't-d-e' || n, 'competition', current_date + 30, current_date + 30, 'published', 'public', true from generate_series(1, 3) n;
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
select pg_temp.u('00100' || n), pg_temp.u('00e00' || n), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured' from generate_series(1, 3) n;
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
select pg_temp.u('00200' || n), pg_temp.u('00e00' || n), pg_temp.u('00100' || n), 'ProAm', 'single_dance', 'pro_am', 'open' from generate_series(1, 3) n;
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
select pg_temp.u('00300' || n), pg_temp.u('00e00' || n), pg_temp.u('00100' || n), pg_temp.u('00200' || n), 'D' || n, 'open' from generate_series(1, 3) n;
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
select pg_temp.u('0060' || lpad(x.r::text, 2, '0')), pg_temp.u('00e00' || x.e), pg_temp.u('00100' || x.e), pg_temp.u('00300' || x.e), 'R' || x.r, 'final', x.s, 'draft', 'ordinal_majority'
from (values (1, 1, 1), (2, 1, 2), (3, 1, 3), (5, 3, 1)) x(r, e, s);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.u('0080' || lpad(i::text, 2, '0')), pg_temp.u('00e003'), pg_temp.u('001003'), pg_temp.u('003003'), 'E' || i, 'confirmed', 'eligible', i::text from generate_series(1, 2) i;
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
values (pg_temp.u('008003'), pg_temp.u('00e003'), pg_temp.u('001003'), pg_temp.u('003003'), 'E3', 'confirmed', 'eligible', '3');
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status) values (pg_temp.u('00c005'), pg_temp.u('00e003'), 1, 'v5', 'draft');
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values
  (pg_temp.u('00f051'), pg_temp.u('00e003'), pg_temp.u('00c005'), 1), (pg_temp.u('00f052'), pg_temp.u('00e003'), pg_temp.u('00c005'), 2);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status, name)
values (pg_temp.u('00d051'), pg_temp.u('00e003'), pg_temp.u('003003'), pg_temp.u('006005'), 1, pg_temp.u('002003'), pg_temp.u('00c005'), pg_temp.u('00f051'), 'scheduled', 'h51');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
select pg_temp.u('00e003'), pg_temp.u('003003'), pg_temp.u('00d051'), pg_temp.u('0080' || lpad(i::text, 2, '0')), i from generate_series(1, 2) i;
set session_replication_role = origin;
create temp table t_step (n int, step text, outcome text) on commit drop;
grant all on t_step to authenticated;
create or replace function pg_temp.step(p_n int, p_step text, p_sql text) returns void language plpgsql as $f$
declare v_rows bigint;
begin
  begin
    perform pg_temp.as_user(pg_temp.u('000001'));
    execute p_sql;
    get diagnostics v_rows = row_count;
    execute 'reset role';
    insert into t_step values (p_n, p_step, 'accepted rows ' || v_rows);
  exception when others then
    execute 'reset role';
    insert into t_step values (p_n, p_step, 'refused: ' || left(sqlerrm, 160));
  end;
end $f$;
select pg_temp.step(1, 'plant a heat with no version under draft floor heat 2', $q$insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, floor_heat_id, status, name) values (pg_temp.u('00d052'), pg_temp.u('00e003'), pg_temp.u('003003'), pg_temp.u('006005'), 2, pg_temp.u('002003'), pg_temp.u('00f052'), 'scheduled', 'planted')$q$);
select pg_temp.step(2, 'publish the draft', $q$select public.publish_competition_schedule_version(pg_temp.u('00c005'))$q$);
select pg_temp.step(3, 'add an entry to the planted heat after publication', $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values (pg_temp.u('00e003'), pg_temp.u('003003'), pg_temp.u('00d052'), pg_temp.u('008003'), 1)$q$);
select pg_temp.step(4, 'add a dance to the planted heat after publication', $q$insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number) values (pg_temp.u('00e003'), pg_temp.u('00d052'), 'tango', 'Tango', 1)$q$);
select pg_temp.step(5, 'change that dance', $q$update public.event_competition_heat_dances set dance_key = 'foxtrot', dance_label = 'Foxtrot' where heat_id = pg_temp.u('00d052')$q$);
create temp table t_read on commit drop as select
  (select status from public.event_competition_schedule_versions where id = pg_temp.u('00c005')) as order_status,
  (select count(*) from public.event_competition_heats where floor_heat_id = pg_temp.u('00f052') and schedule_version_id is null) as planted_heats,
  (select count(*) from public.event_competition_heat_entries where heat_id = pg_temp.u('00d052')) as planted_entries,
  (select string_agg(dance_label, ',') from public.event_competition_heat_dances where heat_id = pg_temp.u('00d052')) as planted_dances;
select pg_temp.step(6, 'control: add an entry to the properly versioned published heat', $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values (pg_temp.u('00e003'), pg_temp.u('003003'), pg_temp.u('00d051'), pg_temp.u('008003'), 3)$q$);
select pg_temp.step(7, 'delete the planted entry', $q$delete from public.event_competition_heat_entries where heat_id = pg_temp.u('00d052')$q$);
do $$
declare v_steps text; r record;
begin
  select string_agg(n || '. ' || step || ' -> ' || outcome, ' | ' order by n) into v_steps from t_step;
  select * into r from t_read;
  raise exception 'D PROBE: % :: read-back after step 5: order=%, planted heats=%, planted entries=%, planted dances=% :: %',
    case when r.order_status = 'published' and r.planted_heats = 1 and r.planted_entries = 1 and r.planted_dances = 'Foxtrot' then 'REPRODUCED' else 'NOT REPRODUCED' end,
    r.order_status, r.planted_heats, r.planted_entries, coalesce(r.planted_dances, 'none'), v_steps;
end $$;

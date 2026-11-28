-- F3 read-back (OD-31 finding F3, re-run WITH a state read-back as required by the owner decision of 2026-11-24). Run as a superuser on a database carrying U18 / U18-S;
-- it is run BEFORE and AFTER the S6 migrations: before, it shows whether the forged-marker chain actually changes state; after, it shows S6 closes the first step.
-- Prints one result table and rolls back; no PASS/FAIL line (it is an experiment, the runner records the table).
begin;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.try_as(p_role text, p_sql text) returns text language plpgsql as $$
declare v text := 'OK';
begin
  execute format('set local role %I', p_role);
  begin execute p_sql; exception when others then v := sqlstate || ' ' || sqlerrm; end;
  reset role;
  return v;
end $$;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;

-- fixtures (session_replication_role = replica only places rows; the guard is exercised afterwards with it reset)
set local session_replication_role = replica;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-cf1033000001', 't-cf1033-m@example.test');
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-cf1033000001', 't-cf1033-m@example.test', 'CF1018 manager');
insert into public.studios (id, name, slug) values ('00000000-0000-0000-0000-cf1033a00001', 'CF1 U18 Studio', 't-cf1033-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('00000000-0000-0000-0000-cf1033000001', '00000000-0000-0000-0000-cf1033a00001', 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values ('00000000-0000-0000-0000-cf1033e00001', '00000000-0000-0000-0000-cf1033a00001', 'U18', 't-cf1033-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method)
values ('00000000-0000-0000-0000-cf1033001001', '00000000-0000-0000-0000-cf1033e00001', '00000000-0000-0000-0000-cf1033a00001', 'P', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values ('00000000-0000-0000-0000-cf1033002001', '00000000-0000-0000-0000-cf1033e00001', '00000000-0000-0000-0000-cf1033001001', 'C', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at)
values ('00000000-0000-0000-0000-cf1033c00001', '00000000-0000-0000-0000-cf1033e00001', 1, 'V1', 'published', now());
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
values ('00000000-0000-0000-0000-cf1033003001', '00000000-0000-0000-0000-cf1033e00001', '00000000-0000-0000-0000-cf1033001001', '00000000-0000-0000-0000-cf1033002001', 'D', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count)
values ('00000000-0000-0000-0000-cf1033006001', '00000000-0000-0000-0000-cf1033e00001', '00000000-0000-0000-0000-cf1033001001', '00000000-0000-0000-0000-cf1033003001', 'R', 'preliminary', 1, 'active', 'callback_tally', 3);
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number)
values ('00000000-0000-0000-0000-cf1033009001', '00000000-0000-0000-0000-cf1033e00001', '00000000-0000-0000-0000-cf1033c00001', 1);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, status, lock_state, contest_id, schedule_version_id, floor_heat_id)
values ('00000000-0000-0000-0000-cf1033d00001', '00000000-0000-0000-0000-cf1033e00001', '00000000-0000-0000-0000-cf1033003001', '00000000-0000-0000-0000-cf1033006001', 1, 'scheduled', 'open', '00000000-0000-0000-0000-cf1033002001', '00000000-0000-0000-0000-cf1033c00001', '00000000-0000-0000-0000-cf1033009001');
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
values ('00000000-0000-0000-0000-cf1033e00001', '00000000-0000-0000-0000-cf1033d00001', 'waltz', 'Waltz', 1);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select ('00000000-0000-0000-0000-cf1033800' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1033e00001', '00000000-0000-0000-0000-cf1033001001', '00000000-0000-0000-0000-cf1033003001', 'e' || i, 'confirmed', 'eligible', '9' || i
from generate_series(1, 5) i;
insert into public.event_competition_heat_entries (id, event_id, division_id, heat_id, entry_id, floor_order, status)
select ('00000000-0000-0000-0000-cf1033900' || lpad(i::text, 3, '0'))::uuid, '00000000-0000-0000-0000-cf1033e00001', '00000000-0000-0000-0000-cf1033003001', '00000000-0000-0000-0000-cf1033d00001',
       ('00000000-0000-0000-0000-cf1033800' || lpad(i::text, 3, '0'))::uuid, i, case when i = 4 then 'danced' else 'scheduled' end
from generate_series(1, 4) i;
set local session_replication_role = origin;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-cf1033000001","role":"authenticated"}', true);

create temp table t_f3 (step text, outcome text, parent_status text, heat_entry_status text, audit_scratch_rows bigint);
grant all on t_f3 to authenticated;
create or replace function pg_temp.snap(p_step text, p_outcome text, p_entry uuid) returns void language sql as $$
  insert into t_f3 values (p_step, p_outcome, (select status from public.event_competition_entries where id = p_entry),
    (select string_agg(status, ',') from public.event_competition_heat_entries where entry_id = p_entry),
    (select count(*) from public.event_competition_entry_changes where entry_id = p_entry and change_type = 'scratch')) $$;
-- entry 1: audited parent scratch by the client, forged marker, direct heat-entry scratch
select pg_temp.snap('0 initial (entry 1)', '-', '00000000-0000-0000-0000-cf1033800001');
select pg_temp.snap('1 client scratches the PARENT entry directly', pg_temp.try_as('authenticated', $q$update public.event_competition_entries set status = 'scratched' where id = '00000000-0000-0000-0000-cf1033800001'$q$), '00000000-0000-0000-0000-cf1033800001');
select set_config('app.competition_entry_change_type', 'scratch', true);
select pg_temp.snap('2 forged marker + client scratches the HEAT entry directly', pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'scratched' where entry_id = '00000000-0000-0000-0000-cf1033800001'$q$), '00000000-0000-0000-0000-cf1033800001');
select set_config('app.competition_entry_change_type', '', true);
-- entry 2: marker only, parent not scratched
select set_config('app.competition_entry_change_type', 'scratch', true);
select pg_temp.snap('3 marker only (parent NOT scratched), heat entry scratch (entry 2)', pg_temp.try_as('authenticated', $q$update public.event_competition_heat_entries set status = 'scratched' where entry_id = '00000000-0000-0000-0000-cf1033800002'$q$), '00000000-0000-0000-0000-cf1033800002');
select set_config('app.competition_entry_change_type', '', true);
select * from t_f3 order by step;
rollback;

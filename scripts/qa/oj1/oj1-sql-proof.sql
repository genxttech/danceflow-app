-- OJ-1 SQL-level proof (local QA database only; ONE transaction, always rolled back). Shows that the authority the app reuses,
-- E1's my_competition_judging_assignments(), gives an organizer-team-only judge exactly their own active assignments:
--   P1 organizer membership with no official row: no rows
--   P2 an active judge assignment on event A (organizer event): rows for A only, never for event B of another tenant
--   P3 the official is deactivated (revoked): no rows at once
--   P4 the organizer membership ends while the official row stays active: no rows (team-member rule)
-- Usage: psql -v ev_a=<event uuid> -v ev_b=<event uuid of another studio> -v round_a=<draft round of ev_a> -f oj1-sql-proof.sql
--   P5 E2 round role and judge ballot sheet refuse an official whose team membership ended (P7 control: restored => allowed)
\set ON_ERROR_STOP 1
begin;
select set_config('oj1.ev_a', :'ev_a', true), set_config('oj1.ev_b', :'ev_b', true);
create temp table oj1_out (step text, rows integer, events text) on commit drop;
grant all on oj1_out to authenticated;

do $$
declare
  v_user uuid := gen_random_uuid();
  v_org uuid := gen_random_uuid();
  v_email text := 'oj1-' || substr(v_user::text, 1, 8) || '@e2e.test';
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
  values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_email, now(), now(), now());
  insert into public.verified_email_identities (user_id, email, method, source, credential_status, bound_at) values (v_user, v_email, 'otp', 'web_callback', 'bound', now());
  insert into public.organizers (id, name, slug) values (v_org, 'OJ1 proof organizer', 'oj1-proof-' || substr(v_org::text, 1, 8));
  insert into public.organizer_users (organizer_id, user_id, role, active) values (v_org, v_user, 'organizer_admin', true);
  update public.events set organizer_id = v_org where id = current_setting('oj1.ev_a')::uuid;
  perform set_config('oj1.user', v_user::text, true);
  perform set_config('oj1.org', v_org::text, true);
  if exists (select 1 from public.user_studio_roles where user_id = v_user) then
    raise exception 'fixture error: the proof user must not be studio staff';
  end if;
end $$;

create function pg_temp.oj1_read(p_step text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', current_setting('oj1.user'), true);
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('oj1.user'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into oj1_out
  select p_step, count(*), coalesce(string_agg(distinct a.event_id::text, ','), '')
  from public.my_competition_judging_assignments() a;
  execute 'reset role';
end $$;

select pg_temp.oj1_read('P1 organizer membership only');

insert into public.event_competition_officials (event_id, user_id, role, status)
values (current_setting('oj1.ev_a')::uuid, current_setting('oj1.user')::uuid, 'judge', 'active');
select pg_temp.oj1_read('P2 active judge on event A');

update public.event_competition_officials set status = 'inactive', deactivated_at = now(), deactivation_reason = 'OJ-1 proof: assignment revoked'
where event_id = current_setting('oj1.ev_a')::uuid and user_id = current_setting('oj1.user')::uuid;
select pg_temp.oj1_read('P3 official deactivated');

update public.event_competition_officials set status = 'active', deactivated_at = null, deactivation_reason = null
where event_id = current_setting('oj1.ev_a')::uuid and user_id = current_setting('oj1.user')::uuid;
update public.organizer_users set active = false where user_id = current_setting('oj1.user')::uuid;
select pg_temp.oj1_read('P4 organizer membership ended');

-- P5/P6/P7 (review P2, E2 authority): an official whose team membership ENDED keeps an active official row. E2's round role and the judge
-- ballot sheet must refuse them too (E1 team-member rule); restoring the membership is the positive control.
create function pg_temp.oj1_e2(p_step text, p_round uuid) returns void language plpgsql as $f$
declare v_role text; v_sheet text;
begin
  perform set_config('request.jwt.claim.sub', current_setting('oj1.user'), true);
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('oj1.user'), 'role', 'authenticated')::text, true);
  v_role := public._compe2_round_role(p_round);
  begin
    execute 'set local role authenticated';
    perform public.competition_judge_ballot_sheet(p_round);
    v_sheet := 'sheet returned';
    execute 'reset role';
  exception when others then
    v_sheet := split_part(sqlerrm, ':', 1);
    execute 'reset role';
  end;
  insert into oj1_out values (p_step, case when v_role is null then 0 else 1 end, coalesce(v_role, 'no role') || ' / ' || v_sheet);
end $f$;
update public.event_competition_officials set role = 'scorer'
where event_id = current_setting('oj1.ev_a')::uuid and user_id = current_setting('oj1.user')::uuid;
insert into public.event_competition_panel_assignments (event_id, round_id, official_id, judge_letter)
select o.event_id, :'round_a'::uuid, o.id, null from public.event_competition_officials o
where o.event_id = current_setting('oj1.ev_a')::uuid and o.user_id = current_setting('oj1.user')::uuid;
select pg_temp.oj1_e2('P5 E2 role + sheet, membership ended', :'round_a'::uuid);
update public.organizer_users set active = true where user_id = current_setting('oj1.user')::uuid;
select pg_temp.oj1_e2('P7 E2 role + sheet, membership restored (control)', :'round_a'::uuid);

select json_agg(json_build_object('step', step, 'rows', rows, 'events', events,
                                  'onlyEventA', events in ('', current_setting('oj1.ev_a')),
                                  'containsEventB', position(current_setting('oj1.ev_b') in events) > 0) order by step) from oj1_out;
rollback;

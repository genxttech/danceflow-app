-- LOCAL DISPOSABLE STACK ONLY. M1+M2+M3 live-table gate probe; always rolls back (final raise).
begin;
create temp table r (name text, ok boolean, detail text) on commit drop;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin begin execute p_sql; return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end; end $$;
create or replace function pg_temp.try_as(p_role text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  begin execute format('set local role %I', p_role); execute p_sql; v := 'ok';
  exception when others then v := sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  return v;
end $$;
create or replace function pg_temp.chk(n text, ok boolean, d text default '') returns void language sql as $$ insert into r values (n, coalesce(ok, false), d) $$;
create temp table ins (t text, sql text) on commit drop;
grant all on r, ins to anon, authenticated, service_role, intake_destructive;

insert into public.studios (id, name, slug) values ('a5700000-0000-0000-0000-00000000000a', 'NSI D3 local probe', 'nsi-d3-local-a57');
insert into public.clients (id, studio_id, first_name, last_name) values ('a5700000-0000-0000-0000-0000000000a1', 'a5700000-0000-0000-0000-00000000000a', 'Synthetic', 'D3');
insert into public.intake_templates (id, studio_id, name) values ('a5700000-0000-0000-0000-000000000701', 'a5700000-0000-0000-0000-00000000000a', 'T');
-- Gate B open for this studio: only Gate A (platform retention) must refuse
insert into public.intake_settings (studio_id, enabled, default_template_id) values ('a5700000-0000-0000-0000-00000000000a', true, 'a5700000-0000-0000-0000-000000000701');

insert into ins values
 ('intake_requests', $q$insert into public.intake_requests (studio_id, client_id, template_id, source) values ('a5700000-0000-0000-0000-00000000000a', 'a5700000-0000-0000-0000-0000000000a1', 'a5700000-0000-0000-0000-000000000701', 'manual')$q$),
 ('intake_request_appointments', $q$insert into public.intake_request_appointments (studio_id, request_id, appointment_id, attached_by) values ('a5700000-0000-0000-0000-00000000000a', gen_random_uuid(), gen_random_uuid(), 'staff')$q$),
 ('intake_respondents', $q$insert into public.intake_respondents (studio_id, request_id, client_id, role, display_name, assurance) values ('a5700000-0000-0000-0000-00000000000a', gen_random_uuid(), 'a5700000-0000-0000-0000-0000000000a1', 'student', 'X', 'declared_unverified')$q$),
 ('intake_responses', $q$insert into public.intake_responses (studio_id, request_id, client_id, audience, template_version_id) values ('a5700000-0000-0000-0000-00000000000a', gen_random_uuid(), 'a5700000-0000-0000-0000-0000000000a1', 'student', gen_random_uuid())$q$),
 ('intake_response_revisions', $q$insert into public.intake_response_revisions (studio_id, response_id, revision, changed_by_actor) values ('a5700000-0000-0000-0000-00000000000a', gen_random_uuid(), 1, 'system')$q$),
 ('intake_minor_determinations', $q$insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold) values ('a5700000-0000-0000-0000-00000000000a', gen_random_uuid(), false, 'declared', current_date, 18)$q$),
 ('intake_completions', $q$insert into public.intake_completions (studio_id, request_id, client_id, template_id, template_version_id, version_number, student_response_id) values ('a5700000-0000-0000-0000-00000000000a', gen_random_uuid(), 'a5700000-0000-0000-0000-0000000000a1', 'a5700000-0000-0000-0000-000000000701', gen_random_uuid(), 1, gen_random_uuid())$q$),
 ('intake_client_relationship_state', $q$insert into public.intake_client_relationship_state (studio_id, client_id) values ('a5700000-0000-0000-0000-00000000000a', 'a5700000-0000-0000-0000-0000000000a1')$q$),
 ('intake_guardian_designations', $q$insert into public.intake_guardian_designations (studio_id, client_id, link_id, designated_by) values ('a5700000-0000-0000-0000-00000000000a', 'a5700000-0000-0000-0000-0000000000a1', gen_random_uuid(), gen_random_uuid())$q$);

select pg_temp.chk('G1 owner direct insert into ' || t || ' refused by the closed collection gate (Gate B open)', v like '42501%retention_policy_incomplete%', v)
from (select t, pg_temp.try(sql) v from ins) s;
select pg_temp.chk('G2 ' || ro || ' cannot insert into ' || t || ' (no privilege)', v like '42501%permission denied%', v)
from (select t, ro, pg_temp.try_as(ro, sql) v from ins, unnest(array['anon', 'authenticated', 'service_role', 'intake_destructive']) ro) s;
select pg_temp.chk('G3 TRUNCATE refused on ' || t, pg_temp.try(format('truncate public.%I cascade', t)) like '42501%TRUNCATE%')
from ins;
select pg_temp.chk('G4 ' || ro || ' cannot read ' || t, pg_temp.try_as(ro, format('select 1 from public.%I limit 1', t)) like '42501%permission denied%')
from ins, unnest(array['anon', 'authenticated', 'service_role']) ro;
select pg_temp.chk('G5 restricted role can read (policy-scoped) but table is empty',
  pg_temp.try_as('intake_destructive', 'select 1 from public.intake_requests limit 1') = 'ok');
select pg_temp.chk('G6 no first-use marker, no audit rows and no live rows after all refused attempts',
  not exists (select 1 from public.intake_audit_events)
  and not exists (select 1 from public.intake_requests) and not exists (select 1 from public.intake_respondents)
  and not exists (select 1 from public.intake_responses) and not exists (select 1 from public.intake_client_relationship_state));
select pg_temp.chk('G7 fulfillment_state of an unknown request is incomplete (read-only helper works)',
  intake_private.fulfillment_state(gen_random_uuid()) = 'incomplete');
do $$ declare n int; f text; begin
  select count(*), string_agg(name || ' -> ' || detail, ' | ') filter (where not ok) into n, f from r;
  if f is null then raise exception 'NSI D3 LOCAL BEHAVIOUR PASS (% checks)', n; else raise exception 'NSI D3 LOCAL BEHAVIOUR FAIL: %', f; end if;
end $$;

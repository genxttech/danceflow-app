-- LOCAL DISPOSABLE STACK ONLY. M1-M4 retained-evidence probe; synthetic fixtures; always rolls back (final raise).
begin;
create temp table r (name text, ok boolean, detail text) on commit drop;
grant all on r to anon, authenticated, service_role, intake_destructive;
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

-- synthetic fixtures (no real people)
insert into public.studios (id, name, slug) values ('a5800000-0000-0000-0000-00000000000a', 'NSI D4 local probe', 'nsi-d4-local-a58');
insert into public.clients (id, studio_id, first_name, last_name) values ('a5800000-0000-0000-0000-0000000000a1', 'a5800000-0000-0000-0000-00000000000a', 'Synthetic', 'D4');
insert into public.intake_templates (id, studio_id, name) values ('a5800000-0000-0000-0000-000000000701', 'a5800000-0000-0000-0000-00000000000a', 'T');
insert into public.intake_template_versions (id, studio_id, template_id, version_number, status, schema, schema_sha256, max_answer_bytes, published_at)
values ('a5800000-0000-0000-0000-000000000702', 'a5800000-0000-0000-0000-00000000000a', 'a5800000-0000-0000-0000-000000000701', 1, 'published', '{"sections":[]}', 'h', 10, now());
insert into public.intake_settings (studio_id, enabled, default_template_id) values ('a5800000-0000-0000-0000-00000000000a', true, 'a5800000-0000-0000-0000-000000000701');

-- statement templates (request id substituted later)
create temp table ev (k text primary key, sql text) on commit drop;
grant all on ev to anon, authenticated, service_role, intake_destructive;
insert into ev values ('evidence', $q$insert into public.intake_consent_evidence (studio_id, request_ref, client_ref, respondent_role, assurance, required_assurance,
    event_type, consent_text, consent_text_sha256, template_version_ref, template_schema_sha256, outcome, actor_type, retention_basis, retain_until,
    platform_policy_version, acknowledged_at)
  values ('a5800000-0000-0000-0000-00000000000a', '%s', 'a5800000-0000-0000-0000-0000000000a1', 'student', 'declared_unverified', 'email_code_verified',
    'acknowledged', 'synthetic consent', encode(extensions.digest('synthetic consent', 'sha256'), 'hex'), 'a5800000-0000-0000-0000-000000000702', 'h',
    'accepted', 'student', 'evidentiary', '2026-01-01'::timestamptz + interval '%s days', %s, '2026-01-01'::timestamptz)$q$);

-- 1. closed gate: evidence insert refused before any validation, even via direct owner SQL
select pg_temp.chk('E01 dark: owner insert into intake_consent_evidence refused by the collection gate',
  pg_temp.try(format((select sql from ev where k = 'evidence'), gen_random_uuid(), 3650, 999)) like '42501%retention_policy_incomplete%');
select pg_temp.chk('E02 dark: owner insert into intake_consent_evidence_identity refused by the collection gate',
  pg_temp.try($q$insert into public.intake_consent_evidence_identity (studio_id, evidence_id, retain_until) values ('a5800000-0000-0000-0000-00000000000a', gen_random_uuid(), now())$q$)
  like '42501%retention_policy_incomplete%');
select pg_temp.chk(format('E03 %s cannot %s retained evidence', ro, op),
  pg_temp.try_as(ro, case op when 'read' then 'select 1 from public.intake_consent_evidence limit 1'
                             when 'insert' then format((select sql from ev where k = 'evidence'), gen_random_uuid(), 3650, 999)
                             when 'update' then 'update public.intake_consent_evidence set outcome = ''x'''
                             when 'delete' then 'delete from public.intake_consent_evidence'
                             else 'truncate public.intake_consent_evidence' end) like '42501%permission denied%')
from unnest(array['anon', 'authenticated', 'service_role', 'intake_destructive']) ro, unnest(array['read', 'insert', 'update', 'delete', 'truncate']) op;
select pg_temp.chk('E04 no evidence, live, audit, hold or marker rows exist after the refused attempts',
  not exists (select 1 from public.intake_consent_evidence) and not exists (select 1 from public.intake_consent_evidence_identity)
  and not exists (select 1 from public.intake_requests) and not exists (select 1 from public.intake_audit_events) and not exists (select 1 from public.intake_legal_holds));

-- 2. open the gate inside this rolled-back transaction only, to exercise the evidence rules on a synthetic row
create or replace function public.intake_platform_policy()
returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
  post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
  audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
language sql stable set search_path = pg_catalog, pg_temp
as $$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text $$;
insert into public.intake_requests (id, studio_id, client_id, template_id, source) values
  ('a5800000-0000-0000-0000-000000000801', 'a5800000-0000-0000-0000-00000000000a', 'a5800000-0000-0000-0000-0000000000a1', 'a5800000-0000-0000-0000-000000000701', 'manual');
update public.intake_requests set pinned_version_id = 'a5800000-0000-0000-0000-000000000702', status = 'invited', issued_at = now() where id = 'a5800000-0000-0000-0000-000000000801';
select pg_temp.chk('E05 evidence retention must equal the approved platform period',
  pg_temp.try(format((select sql from ev where k = 'evidence'), 'a5800000-0000-0000-0000-000000000801', 99999, 999)) like '22023%approved platform period%');
select pg_temp.chk('E06 evidence must reference an existing request of this client and its pinned version',
  pg_temp.try(format((select sql from ev where k = 'evidence'), gen_random_uuid(), 3650, 999)) like '42501%does not match%');
select pg_temp.chk('E07 consent text hash must match the text (extensions.digest check)',
  pg_temp.try(replace(format((select sql from ev where k = 'evidence'), 'a5800000-0000-0000-0000-000000000801', 3650, 999),
    'encode(extensions.digest(''synthetic consent'', ''sha256''), ''hex'')', 'repeat(''0'', 64)')) like '23514%text_hash%');
select pg_temp.chk('E08 valid synthetic evidence row accepted with the gate open (test policy, rolled back)',
  pg_temp.try(format((select sql from ev where k = 'evidence'), 'a5800000-0000-0000-0000-000000000801', 3650, 999)) = 'ok');
select pg_temp.chk('E09 evidence is append-only for the owner (update refused)',
  pg_temp.try('update public.intake_consent_evidence set outcome = ''changed''') like '42501%append-only%');
select pg_temp.chk('E10 evidence is append-only for the owner (delete refused)',
  pg_temp.try('delete from public.intake_consent_evidence') like '42501%append-only%');
select pg_temp.chk('E11 TRUNCATE refused on both evidence tables',
  pg_temp.try('truncate public.intake_consent_evidence cascade') like '42501%TRUNCATE%' and pg_temp.try('truncate public.intake_consent_evidence_identity') like '42501%TRUNCATE%');
select pg_temp.chk('E12 restricted role cannot delete or update evidence in I1 (no privilege; I6 adds hold-aware expiry)',
  pg_temp.try_as('intake_destructive', 'delete from public.intake_consent_evidence') like '42501%permission denied%'
  and pg_temp.try_as('intake_destructive', 'update public.intake_consent_evidence set outcome = ''x''') like '42501%permission denied%');
select pg_temp.chk('E13 identity retention must equal the approved period and not exceed the core evidence',
  pg_temp.try(format($q$insert into public.intake_consent_evidence_identity (studio_id, evidence_id, retain_until) values ('a5800000-0000-0000-0000-00000000000a', '%s', '2026-01-01'::timestamptz + interval '9999 days')$q$,
    (select id from public.intake_consent_evidence limit 1))) like '22023%identity retention%');
select pg_temp.chk('E14 valid identity row accepted, then append-only',
  pg_temp.try(format($q$insert into public.intake_consent_evidence_identity (studio_id, evidence_id, retain_until) values ('a5800000-0000-0000-0000-00000000000a', '%s', '2026-01-01'::timestamptz + interval '365 days')$q$,
    (select id from public.intake_consent_evidence limit 1))) = 'ok'
  and pg_temp.try('update public.intake_consent_evidence_identity set minimized_reason = ''x''') like '42501%append-only%');
select pg_temp.chk('E15 the first personal insert wrote exactly one first-use marker (rolled back with this probe)',
  (select count(*) = 1 from public.intake_audit_events where retention_class = 'environment_marker'));
do $$ declare n int; f text; begin
  select count(*), string_agg(name || ' -> ' || detail, ' | ') filter (where not ok) into n, f from r;
  if f is null then raise exception 'NSI D4 LOCAL BEHAVIOUR PASS (% checks)', n; else raise exception 'NSI D4 LOCAL BEHAVIOUR FAIL: %', f; end if;
end $$;

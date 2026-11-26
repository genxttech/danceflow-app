-- NSI I1 foundation -- DEV-SAFE regression suite for migrations 20261118090000 .. 20261118094000.
--
-- Safe for shared DEV: creates NO auth.users / profiles rows (approved V1 baseline item 8). Fixtures (studio, client,
-- appointment, template) are synthetic and exist only inside this transaction. The final block ALWAYS raises, so
-- nothing persists: "NSI I1 DEV-SAFE SUITE PASS (<n> checks)" or "NSI I1 DEV-SAFE SUITE FAIL: <failures>".
-- Covers: catalog/privilege matrix, restricted role, private schema, hot-table invariants, default-grant regression,
-- and the dark collection gate (every personal-data writer refuses while platform retention periods are unapproved).
-- REQUIRED: the pre-migration appointments fingerprint recorded at D-0, passed as a setting, e.g.
--   PGOPTIONS='-c nsi.appointments_fp=<md5>'   (check F14 FAILS when it is missing)
-- recorded BEFORE applying M1 with exactly this query (triggers, constraints, indexes and inbound foreign keys):
--   select md5((select string_agg(tgname||pg_get_triggerdef(oid),'|' order by tgname) from pg_trigger
--               where tgrelid='public.appointments'::regclass and not tgisinternal)
--     || (select string_agg(conname||pg_get_constraintdef(oid),'|' order by conname) from pg_constraint where conrelid='public.appointments'::regclass)
--     || (select string_agg(indexdef,'|' order by indexname) from pg_indexes where schemaname='public' and tablename='appointments')
--     || (select coalesce(string_agg(conrelid::regclass::text||conname,'|' order by conname),'') from pg_constraint where confrelid='public.appointments'::regclass));
-- The full functional suite (staff identities, gate-open paths, erasure) is test_T_nsi_i1_local.sql (local only).

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; return 'ok';
  exception when others then return sqlstate || ' ' || sqlerrm; end;
end $$;

create or replace function pg_temp.try_as_service(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  begin
    execute 'set local role service_role';
    execute p_sql;
    v := 'ok';
  exception when others then v := sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  return v;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Catalog and privileges
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.chk('F01 catalog self-check passes', pg_temp.try('select intake_private.assert_catalog()') = 'ok',
  pg_temp.try('select intake_private.assert_catalog()'));
select pg_temp.chk('F02 exactly 19 intake tables (18 + M7 grants; 22 from M12), all with RLS',
  (select count(*) = case when to_regclass('public.intake_sessions') is not null then (case when to_regclass('public.intake_email_challenges') is not null then 25 when to_regclass('public.intake_guardian_attestations') is not null then 23 else 22 end) else 19 end and bool_and(relrowsecurity) from pg_class where relnamespace = 'public'::regnamespace and relname like 'intake\_%' and relkind = 'r'));
select pg_temp.chk(format('F03 %s has no privilege on %s', r, c.relname),
  not (has_table_privilege(r, c.oid, 'SELECT') or has_table_privilege(r, c.oid, 'INSERT') or has_table_privilege(r, c.oid, 'UPDATE')
       or has_table_privilege(r, c.oid, 'DELETE') or has_table_privilege(r, c.oid, 'TRUNCATE')))
from pg_class c, unnest(array['anon', 'service_role']) r
where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and c.relkind = 'r';
select pg_temp.chk(format('F04 authenticated privilege on %s matches matrix', c.relname),
  case when c.relname in ('intake_templates', 'intake_template_versions', 'intake_service_assignments', 'intake_studio_retention_choices', 'intake_settings')
       then has_table_privilege('authenticated', c.oid, 'SELECT') and not has_table_privilege('authenticated', c.oid, 'INSERT')
            and not has_table_privilege('authenticated', c.oid, 'UPDATE') and not has_table_privilege('authenticated', c.oid, 'DELETE')
       else not (has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'INSERT')
                 or has_table_privilege('authenticated', c.oid, 'UPDATE') or has_table_privilege(  'authenticated', c.oid, 'DELETE')) end)
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and c.relkind = 'r';
select pg_temp.chk(format('F05 intake_destructive privilege on %s matches matrix', c.relname),
  case when c.relname in ('intake_requests', 'intake_request_appointments', 'intake_respondents', 'intake_responses', 'intake_response_revisions',
                          'intake_minor_determinations', 'intake_completions', 'intake_client_relationship_state', 'intake_guardian_designations',
                          'intake_invitations', 'intake_sessions', 'intake_rate_limits', 'intake_guardian_attestations',
                          'intake_guardian_invitation_requests', 'intake_email_challenges')
       then has_table_privilege('intake_destructive', c.oid, 'SELECT') and has_table_privilege('intake_destructive', c.oid, 'DELETE')
            and not has_table_privilege('intake_destructive', c.oid, 'INSERT') and not has_table_privilege('intake_destructive', c.oid, 'UPDATE')
       else not (has_table_privilege('intake_destructive', c.oid, 'SELECT') or has_table_privilege('intake_destructive', c.oid, 'INSERT')
                 or has_table_privilege('intake_destructive', c.oid, 'UPDATE') or has_table_privilege('intake_destructive', c.oid, 'DELETE')) end)
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and c.relkind = 'r';
select pg_temp.chk('F06 no NSI function executable by anon',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
                and has_function_privilege('anon', p.oid, 'EXECUTE')));
select pg_temp.chk('F07 service_role executes exactly the service surface',
  (select array_agg(distinct p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
     and has_function_privilege('service_role', p.oid, 'EXECUTE'))
  = (select array_agg(x order by x) from unnest(array['intake_ensure_request', 'intake_platform_policy', 'intake_reconcile_preview', 'intake_reconcile_status', 'intake_save_draft', 'intake_submit_response']::name[] || case when to_regclass('public.intake_sessions') is not null then array['intake_exchange_invitation', 'intake_purge_expired', 'intake_rate_limit_hit', 'intake_revoke_all_invitations_for_key', 'intake_revoke_session', 'intake_session_context']::name[] else '{}'::name[] end || case when to_regprocedure('public.intake_determine_minor_from_birthday(uuid,uuid)') is not null then array['intake_declare_minor_status', 'intake_determine_minor_from_birthday', 'intake_session_minor_state']::name[] else '{}'::name[] end) x));
select pg_temp.chk('F08 no intake_private function executable by authenticated or service_role',
  not exists (select 1 from pg_proc p where p.pronamespace = 'intake_private'::regnamespace
              and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('service_role', p.oid, 'EXECUTE'))));
select pg_temp.chk('F09 erase implementation owned by intake_destructive; wrappers and other functions owned by postgres',
  (select pg_get_userbyid(proowner) = 'intake_destructive' from pg_proc where oid = 'intake_private.erase_client_impl(uuid,uuid,uuid,text,boolean,text)'::regprocedure)
  and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
                    and p.proname not in ('erase_client_impl', 'purge_expired_impl') and pg_get_userbyid(p.proowner) <> 'postgres'));
select pg_temp.chk('F10 every NSI function pins search_path = pg_catalog, pg_temp',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
                and (p.proconfig is null or not ('search_path=pg_catalog, pg_temp' = any (p.proconfig)))));
select pg_temp.chk('F11 intake_private usable only by postgres and intake_destructive (USAGE only); role has no CREATE on public',
  not has_schema_privilege('anon', 'intake_private', 'USAGE') and not has_schema_privilege('authenticated', 'intake_private', 'USAGE')
  and not has_schema_privilege('service_role', 'intake_private', 'USAGE') and has_schema_privilege('intake_destructive', 'intake_private', 'USAGE')
  and not has_schema_privilege('intake_destructive', 'intake_private', 'CREATE')
  and not has_schema_privilege('intake_destructive', 'public', 'CREATE'));
select pg_temp.chk('F12 restricted role attributes and SET-only membership',
  exists (select 1 from pg_roles where rolname = 'intake_destructive' and not rolcanlogin and not rolinherit and not rolbypassrls and not rolsuper and not rolcreaterole)
  and exists (select 1 from pg_auth_members where roleid = 'intake_destructive'::regrole and member = 'postgres'::regrole and set_option and not inherit_option)
  and not exists (select 1 from pg_auth_members where roleid = 'intake_destructive'::regrole and (member <> 'postgres'::regrole or inherit_option)));
select pg_temp.chk('F13 no intake trigger, FK or index on appointments',
  not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.appointments'::regclass
              and (p.pronamespace = 'intake_private'::regnamespace or p.proname like 'intake\_%'))
  and not exists (select 1 from pg_constraint c where c.confrelid = 'public.appointments'::regclass and c.conrelid::regclass::text like '%intake\_%')
  and not exists (select 1 from pg_indexes where tablename = 'appointments' and indexname like '%intake%'));
select pg_temp.chk('F14 appointments fingerprint (triggers, constraints, indexes, inbound FKs) equals the mandatory D-0 baseline',
  nullif(current_setting('nsi.appointments_fp', true), '') is not null
  and current_setting('nsi.appointments_fp', true) = (select md5(
        (select string_agg(tgname || pg_get_triggerdef(oid), '|' order by tgname) from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal)
     || (select string_agg(conname || pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid = 'public.appointments'::regclass)
     || (select string_agg(indexdef, '|' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'appointments')
     || (select coalesce(string_agg(conrelid::regclass::text || conname, '|' order by conname), '') from pg_constraint where confrelid = 'public.appointments'::regclass))),
  'supplied=' || coalesce(nullif(current_setting('nsi.appointments_fp', true), ''), '<missing: set nsi.appointments_fp>'));
do $$ declare v text; begin
  begin
    create table public.intake_zz_regression_probe (id int);
    perform intake_private.assert_catalog();
    v := 'self-check did not fail';
  exception when others then v := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.chk('F15 a new intake table without the R25 seal is detected (default-grant regression)', v like '42501%intake_zz_regression_probe%', v);
end $$;
select pg_temp.chk('F16 shipped platform policy: draft 90/180/90 approved, every other period NULL',
  (select policy_version = 1 and draft_retention_days = 90 and draft_max_days = 180 and draft_protected_window_days = 90
          and post_relationship_max_days is null and evidence_core_days is null and evidence_identity_days is null
          and audit_operational_days is null and audit_security_days is null and hold_record_days_after_release is null
   from public.intake_platform_policy()));
select pg_temp.chk('F17 Gate A is closed', not intake_private.retention_gate_open());

-- ---------------------------------------------------------------------------------------------------------------
-- Dark gate with synthetic fixtures (no auth users)
-- ---------------------------------------------------------------------------------------------------------------
insert into public.studios (id, name, slug) values ('a5200000-0000-0000-0000-00000000000a', 'NSI DEV-safe Studio', 'nsi-devsafe-a52');
insert into public.clients (id, studio_id, first_name, last_name)
values ('a5200000-0000-0000-0000-0000000000a1', 'a5200000-0000-0000-0000-00000000000a', 'Synthetic', 'DevSafe');
insert into public.appointments (id, studio_id, client_id, appointment_type, status, starts_at, ends_at)
values ('a5200000-0000-0000-0000-000000000501', 'a5200000-0000-0000-0000-00000000000a', 'a5200000-0000-0000-0000-0000000000a1',
        'private_lesson', 'scheduled', now() + interval '10 days', now() + interval '10 days 1 hour');
insert into public.intake_templates (id, studio_id, name) values ('a5200000-0000-0000-0000-000000000701', 'a5200000-0000-0000-0000-00000000000a', 'DevSafe');
insert into public.intake_settings (studio_id, enabled, default_template_id)
values ('a5200000-0000-0000-0000-00000000000a', true, 'a5200000-0000-0000-0000-000000000701');
insert into public.intake_service_assignments (studio_id, appointment_type, template_id)
values ('a5200000-0000-0000-0000-00000000000a', 'private_lesson', 'a5200000-0000-0000-0000-000000000701');
select pg_temp.chk('F18 service ensure_request creates nothing while dark (M1-M9: refused with retention_policy_incomplete; from M10 the evaluator answers no-obligation first and returns NULL)',
  (pg_temp.try_as_service($q$select public.intake_ensure_request('a5200000-0000-0000-0000-00000000000a', 'a5200000-0000-0000-0000-0000000000a1',
    'a5200000-0000-0000-0000-000000000501')$q$) like '%retention_policy_incomplete%'
   or (exists (select 1 from pg_proc where proname = 'intake_ensure_request' and prosrc ~ 'nsi-body:m1[01]')
       and not exists (select 1 from public.intake_requests where client_id = 'a5200000-0000-0000-0000-0000000000a1'))));
select pg_temp.chk('F19 direct owner insert into intake_requests refused by the gate trigger',
  pg_temp.try($q$insert into public.intake_requests (studio_id, client_id, template_id, source)
    values ('a5200000-0000-0000-0000-00000000000a', 'a5200000-0000-0000-0000-0000000000a1', 'a5200000-0000-0000-0000-000000000701', 'manual')$q$)
  like '%retention_policy_incomplete%');
select pg_temp.chk('F20 direct owner insert into relationship state refused by the gate trigger',
  pg_temp.try($q$insert into public.intake_client_relationship_state (studio_id, client_id)
    values ('a5200000-0000-0000-0000-00000000000a', 'a5200000-0000-0000-0000-0000000000a1')$q$) like '%retention_policy_incomplete%');
select pg_temp.chk('F21 service_role cannot read or write live personal tables directly',
  pg_temp.try_as_service('select count(*) from public.intake_requests') like '42501%'
  and pg_temp.try_as_service('delete from public.intake_responses') like '42501%');
select pg_temp.chk('F22 TRUNCATE refused on live personal and retained tables',
  pg_temp.try('truncate public.intake_requests cascade') like '42501%' and pg_temp.try('truncate public.intake_audit_events') like '42501%');
select pg_temp.chk('F23 no environment marker and no personal rows exist',
  not exists (select 1 from public.intake_audit_events where retention_class = 'environment_marker')
  and not exists (select 1 from public.intake_requests) and not exists (select 1 from public.intake_responses)
  and not exists (select 1 from public.intake_consent_evidence));
select pg_temp.chk('F24 rollback stays eligible: no audit event other than reference-free operational events',
  not exists (select 1 from public.intake_audit_events where retention_class <> 'operational'
              or request_ref is not null or client_ref is not null or hold_ref is not null)
  and not exists (select 1 from public.intake_legal_holds));

do $$
declare v_total int; v_fail text;
begin
  select count(*), string_agg(name || ' -> ' || detail, ' | ') filter (where not ok) into v_total, v_fail from t_results;
  if v_fail is null then
    raise exception 'NSI I1 DEV-SAFE SUITE PASS (% checks)', v_total;
  else
    raise exception 'NSI I1 DEV-SAFE SUITE FAIL: %', v_fail;
  end if;
end $$;

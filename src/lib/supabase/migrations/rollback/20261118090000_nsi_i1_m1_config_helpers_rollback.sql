-- Rollback of 20261118090000_nsi_i1_m1_config_helpers.sql (NSI I1 M1). Guarded as described in the M5 rollback;
-- configuration rows require SET LOCAL nsi.rollback_config_export = '<sha256 of the exported config>'. Requires the
-- M2 rollback to have run first. Drops the private schema (no CASCADE) and the restricted role last.

begin;

do $$ begin
  if to_regclass('public.intake_audit_events') is not null then
    raise exception 'nsi rollback order: roll back M2 (20261118091000) first';
  end if;
end $$;

set local lock_timeout = '5s';

-- Guard (schema plan §11, F7/F13/A10): lock every existing NSI table (table-number order), then decide eligibility.
do $guard$
declare
  t text;
  v_tables text[] := array['intake_settings', 'intake_studio_retention_choices', 'intake_templates', 'intake_template_versions',
    'intake_service_assignments', 'intake_legal_holds', 'intake_audit_events', 'intake_requests', 'intake_request_appointments',
    'intake_respondents', 'intake_responses', 'intake_response_revisions', 'intake_minor_determinations', 'intake_completions',
    'intake_client_relationship_state', 'intake_guardian_designations', 'intake_consent_evidence', 'intake_consent_evidence_identity'];
  v_personal text[] := array['intake_legal_holds', 'intake_requests', 'intake_request_appointments', 'intake_respondents',
    'intake_responses', 'intake_response_revisions', 'intake_minor_determinations', 'intake_completions',
    'intake_client_relationship_state', 'intake_guardian_designations', 'intake_consent_evidence', 'intake_consent_evidence_identity'];
  v_config text[] := array['intake_settings', 'intake_studio_retention_choices', 'intake_templates', 'intake_template_versions',
    'intake_service_assignments'];
  v_n bigint;
  v_config_rows bigint := 0;
  v_ack text := current_setting('nsi.rollback_config_export', true);
begin
  foreach t in array v_tables loop
    if to_regclass('public.' || t) is not null then
      execute format('lock table public.%I in access exclusive mode', t);
    end if;
  end loop;
  if to_regclass('public.intake_audit_events') is not null then
    if exists (select 1 from public.intake_audit_events where retention_class = 'environment_marker') then
      raise exception 'nsi_rollback_refused_data_present: environment first-use marker exists (forward-fix only)';
    end if;
    if exists (select 1 from public.intake_audit_events where retention_class <> 'operational'
               or request_ref is not null or client_ref is not null or hold_ref is not null) then
      raise exception 'nsi_rollback_refused_data_present: non-configuration audit events exist (forward-fix only)';
    end if;
  end if;
  foreach t in array v_personal loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into v_n;
      if v_n > 0 then
        raise exception 'nsi_rollback_refused_data_present: % has % rows (forward-fix only)', t, v_n;
      end if;
    end if;
  end loop;
  foreach t in array v_config loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into v_n;
      v_config_rows := v_config_rows + v_n;
    end if;
  end loop;
  if v_config_rows > 0 and coalesce(v_ack, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'nsi_rollback_refused_data_present: % configuration rows exist; export them and set nsi.rollback_config_export to the export SHA-256', v_config_rows;
  end if;
end
$guard$;

drop table if exists public.intake_settings;
drop table if exists public.intake_service_assignments;
drop table if exists public.intake_studio_retention_choices;
drop table if exists public.intake_template_versions;
drop table if exists public.intake_templates;
drop function if exists intake_private.assert_catalog();
drop function if exists intake_private.template_floor_guard();
drop function if exists intake_private.template_version_guard();
drop function if exists intake_private.assert_envelope(uuid, uuid, uuid);
drop function if exists intake_private.assert_document_version(uuid, uuid);
drop function if exists intake_private.link_is_verified_self(uuid, uuid, uuid);
drop function if exists intake_private.link_is_verified_guardian(uuid, uuid, uuid);
drop function if exists intake_private.assert_link_for_client(uuid, uuid, uuid);
drop function if exists intake_private.assert_client_in_studio(uuid, uuid);
drop function if exists intake_private.new_obligation_allowed(uuid);
drop function if exists intake_private.retention_gate_open();
drop function if exists intake_private.assert_staff(uuid, text);
drop function if exists public.intake_has_staff_role(uuid);
drop function if exists intake_private.studio_role(uuid);
drop function if exists public.intake_is_platform_admin();
drop function if exists public.intake_platform_policy();
drop function if exists intake_private.config_append_only();
drop function if exists intake_private.refuse_truncate();
drop function if exists intake_private.touch_updated_at();
drop schema if exists intake_private;  -- no CASCADE: fails if anything unexpected remains
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'intake_destructive') then
    if exists (select 1 from pg_proc where proowner = 'intake_destructive'::regrole)
       or exists (select 1 from pg_class where relowner = 'intake_destructive'::regrole) then
      raise exception 'nsi rollback: intake_destructive still owns objects';
    end if;
    execute 'drop role intake_destructive';
  end if;
end $$;

commit;

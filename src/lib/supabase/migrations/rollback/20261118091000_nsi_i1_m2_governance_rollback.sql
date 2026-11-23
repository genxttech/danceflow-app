-- Rollback of 20261118091000_nsi_i1_m2_governance.sql (NSI I1 M2). Guarded as described in the M5 rollback.
-- Requires the M3 rollback to have run first. The environment marker and any non-configuration audit event block
-- this rollback permanently.

begin;

do $$ begin
  if to_regclass('public.intake_requests') is not null then
    raise exception 'nsi rollback order: roll back M3 (20261118092000) first';
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

drop table if exists public.intake_audit_events;
drop table if exists public.intake_legal_holds;
drop function if exists intake_private.audit_guard();
drop function if exists intake_private.legal_hold_guard();
drop function if exists intake_private.erasure_barrier_active(uuid, uuid);
drop function if exists intake_private.audit_write(uuid, text, text, uuid, text, uuid, uuid, text, uuid, uuid, jsonb, text);
drop function if exists intake_private.client_has_active_hold(uuid, uuid);
drop function if exists intake_private.is_held(uuid, uuid, uuid, uuid, uuid, uuid);
select intake_private.assert_catalog();

commit;

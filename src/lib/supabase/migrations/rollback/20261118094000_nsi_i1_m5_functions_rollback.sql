-- Rollback of 20261118094000_nsi_i1_m5_functions.sql (NSI I1 M5).
-- Guarded: locks every NSI table, then refuses after first use (environment marker) or when any personal/retained
-- data or non-configuration audit event exists; configuration rows need an exported-config acknowledgment
-- (SET LOCAL nsi.rollback_config_export = '<sha256>'). Role-owned objects are dropped while acting as
-- intake_destructive (postgres holds SET but not INHERIT on the role). Application rollback precedes SQL rollback.

begin;

-- (no later NSI migration)

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

set local role intake_destructive;
drop function if exists intake_private.erase_client_impl(uuid, uuid, uuid, text, boolean, text);
reset role;
drop function if exists public.intake_erase_client(uuid, uuid, text, text);
drop function if exists public.intake_release_erasure_barrier(uuid, uuid, text, text);
drop function if exists public.intake_create_legal_hold(uuid, text, uuid, text, text, timestamptz, text);
drop function if exists public.intake_release_legal_hold(uuid, uuid, text);
drop function if exists public.intake_ensure_request(uuid, uuid, uuid, text);
drop function if exists public.intake_save_draft(uuid, uuid, text, jsonb, jsonb, int);
drop function if exists public.intake_submit_response(uuid, uuid, text, int, jsonb);
drop function if exists public.intake_save_template_draft(uuid, uuid, text, jsonb, boolean, uuid, text);
drop function if exists public.intake_publish_template_version(uuid, uuid);
drop function if exists public.intake_set_reintake_floor(uuid, uuid, int);
drop function if exists public.intake_set_service_assignment(uuid, text, uuid);
drop function if exists public.intake_update_settings(uuid, jsonb);
drop function if exists public.intake_set_retention_choice(uuid, int);
drop function if exists public.intake_get_status(uuid, uuid);
drop function if exists public.intake_get_answers(uuid, uuid);
drop function if exists public.intake_designate_guardian(uuid, uuid, uuid, text);
drop function if exists public.intake_select_guardian_recipient(uuid, uuid, uuid, text);
drop function if exists public.intake_record_minor_determination(uuid, uuid, boolean, text);
drop function if exists public.intake_drift_report(uuid);
drop function if exists public.intake_extend_draft_retention(uuid, uuid, uuid, text);
drop function if exists intake_private.assert_drift_free(uuid, uuid, uuid);
drop function if exists intake_private.drift_detected(uuid, uuid, uuid);
drop function if exists intake_private.has_intake_records(uuid, uuid);
drop function if exists intake_private.compute_draft_retention(uuid);
drop function if exists intake_private.appointment_snapshot(uuid, uuid, uuid);
drop function if exists intake_private.validate_answers(jsonb, text, jsonb, boolean);
drop function if exists intake_private.schema_max_answer_bytes(jsonb);
drop function if exists intake_private.lock_client(uuid, uuid);
select intake_private.assert_catalog();

commit;

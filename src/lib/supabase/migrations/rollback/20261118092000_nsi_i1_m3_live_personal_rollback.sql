-- Rollback of 20261118092000_nsi_i1_m3_live_personal.sql (NSI I1 M3). Guarded as described in the M5 rollback.
-- Requires the M4 rollback to have run first.

begin;

do $$ begin
  if to_regclass('public.intake_consent_evidence') is not null then
    raise exception 'nsi rollback order: roll back M4 (20261118093000) first';
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

drop table if exists public.intake_completions;
drop table if exists public.intake_response_revisions;
drop table if exists public.intake_responses;
drop table if exists public.intake_respondents;
drop table if exists public.intake_minor_determinations;
drop table if exists public.intake_request_appointments;
drop table if exists public.intake_requests;
drop table if exists public.intake_guardian_designations;
drop table if exists public.intake_client_relationship_state;
drop function if exists intake_private.fulfillment_state(uuid);
drop function if exists intake_private.assurance_rank(text);
drop function if exists intake_private.designations_guard();
drop function if exists intake_private.relationship_state_guard();
drop function if exists intake_private.append_only_guard();
drop function if exists intake_private.responses_guard();
drop function if exists intake_private.respondents_guard();
drop function if exists intake_private.request_appointments_guard();
drop function if exists intake_private.requests_guard();
drop function if exists intake_private.tenant_guard();
drop function if exists intake_private.delete_guard();
drop function if exists intake_private.collection_gate();
drop function if exists intake_private.subject_of(text, uuid, uuid);
select intake_private.assert_catalog();

commit;

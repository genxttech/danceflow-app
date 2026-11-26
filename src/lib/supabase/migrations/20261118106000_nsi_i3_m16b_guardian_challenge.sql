-- New Student Intake (NSI) I3-2 -- M16b: two-party guardian invitation and recipient-bound email challenge
-- (spec NSI_I3_2_M16b_DB_Spec.md, revision 5 in section 12 governs; owner chose address Option B; level 13).
--
-- Creates   public.intake_guardian_invitation_requests, public.intake_email_challenges (no address and no code is stored),
--           their guards, public.intake_guardian_request_invitation (authenticated, assert_staff 'send'),
--           public.intake_guardian_finalize_invitation, public.intake_guardian_challenge_target,
--           public.intake_issue_email_challenge, public.intake_verify_email_challenge (service_role),
--           a unique index: one current guardian respondent per request.
-- Changes   invitations (recipient hash columns; guardian audience; issued_by two_party) and sessions (guardian audience).
-- Replaces  respondents_guard (declared_unverified -> email_code_verified only from a consumed challenge), link_valid (guardian
--           branch), invitations_update_guard, intake_issue_invitation (ends student sessions only), intake_revoke_invitations
--           (also ends open requests), erase_client_impl, purge_expired_impl, the audit event-type CHECK, assert_catalog.
-- Dark      Nothing calls these functions. Activation needs I3-4 (session-bound guardian save and submit with the typed-address
--           check) and email delivery. Gate A closed: every writer returns gate_closed. No billing gating.
-- Depends on: M16a (or a later M16a.x). Refuses to run on M15 or older, when any m16c-or-later marker exists, and when a request
--           already has more than one current guardian respondent.
-- Rollback: rollback/20261118106000_nsi_i3_m16b_guardian_challenge_rollback.sql (refused once any guardian invitation, session, request, challenge, verified
--           respondent or new audit event exists).
-- NOT APPLIED to any shared environment.

begin;

set local lock_timeout = '5s';

do $$
declare v_dup int;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'intake_attest_guardian' and p.prosrc ~ 'nsi-body:m16a') then
    raise exception 'nsi M16b requires M16a (staff attestation is not at the M16a level)' using errcode = '55000';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname in ('public', 'intake_private') and p.prosrc ~ 'nsi-body:m(16[c-z]|1[7-9]|[2-9][0-9])') then
    raise exception 'nsi M16b refused: a later NSI migration (M16c or newer) is already applied' using errcode = '55000';
  end if;
  lock table public.intake_respondents in share row exclusive mode;
  select count(*) into v_dup from (select r.request_id from public.intake_respondents r
    where r.role = 'guardian' and r.superseded_at is null group by r.request_id having count(*) > 1) d;
  if v_dup > 0 then
    raise exception 'nsi M16b refused: % request(s) have more than one current guardian respondent; resolve them first (nothing was changed)', v_dup using errcode = '55000';
  end if;
end $$;

create or replace function intake_private.assert_catalog()
returns void language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_errors text[] := '{}';
  r record;
  v_role text;
  v_priv text;
  v_m int;
  v_present int;
  v_total int;
  v_complete int[] := '{}';
  v_expected text[];
  v_actual text[];
  v_roles constant text[] := array['anon', 'authenticated', 'service_role', 'intake_destructive'];
  v_table_privs text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  c_live constant text[] := array['intake_requests', 'intake_request_appointments', 'intake_respondents',
    'intake_responses', 'intake_response_revisions', 'intake_minor_determinations', 'intake_completions',
    'intake_client_relationship_state', 'intake_guardian_designations'];
  c_config constant text[] := array['intake_templates', 'intake_template_versions', 'intake_service_assignments',
    'intake_studio_retention_choices', 'intake_settings'];
  c_config_qual constant text := '(public.intake_has_staff_role(studio_id) OR public.intake_is_platform_admin())';
  -- relations: name | migration | direct grants (grantee:PRIVILEGE, comma separated, sorted)
  c_rel constant text[] := array[
    'intake_templates|1|authenticated:SELECT',
    'intake_template_versions|1|authenticated:SELECT',
    'intake_service_assignments|1|authenticated:SELECT',
    'intake_studio_retention_choices|1|authenticated:SELECT',
    'intake_settings|1|authenticated:SELECT',
    'intake_legal_holds|2|',
    'intake_audit_events|2|',
    'intake_requests|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_request_appointments|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_respondents|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_responses|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_response_revisions|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_minor_determinations|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_completions|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_client_relationship_state|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_guardian_designations|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_consent_evidence|4|',
    'intake_consent_evidence_identity|4|',
    'intake_feature_grants|7|',
    'intake_invitations|10|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_sessions|10|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_rate_limits|10|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_guardian_attestations|12|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_guardian_invitation_requests|13|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_email_challenges|13|intake_destructive:DELETE,intake_destructive:SELECT'];
  -- functions: schema.name | migration | EXECUTE grantees other than the owner (sorted) | security definer (t/f)
  c_fn constant text[] := array[
    'public.intake_platform_policy|1|authenticated,service_role|f',
    'public.intake_is_platform_admin|1|authenticated|t',
    'public.intake_has_staff_role|1|authenticated|t',
    'intake_private.touch_updated_at|1||f',
    'intake_private.refuse_truncate|1||f',
    'intake_private.config_append_only|1||f',
    'intake_private.studio_role|1||t',
    'intake_private.assert_staff|1||t',
    'intake_private.retention_gate_open|1||f',
    'intake_private.new_obligation_allowed|1||t',
    'intake_private.assert_client_in_studio|1||t',
    'intake_private.assert_link_for_client|1||t',
    'intake_private.link_is_verified_guardian|1||t',
    'intake_private.link_is_verified_self|1||t',
    'intake_private.assert_document_version|1||t',
    'intake_private.assert_envelope|1||t',
    'intake_private.template_version_guard|1||f',
    'intake_private.template_floor_guard|1||f',
    'intake_private.assert_catalog|1||f',
    'intake_private.is_held|2|intake_destructive|t',
    'intake_private.client_has_active_hold|2|intake_destructive|t',
    'intake_private.audit_write|2|intake_destructive|t',
    'intake_private.erasure_barrier_active|2|intake_destructive|t',
    'intake_private.legal_hold_guard|2||f',
    'intake_private.audit_guard|2||f',
    'intake_private.subject_of|3|intake_destructive|t',
    'intake_private.collection_gate|3||f',
    'intake_private.delete_guard|3||f',
    'intake_private.tenant_guard|3||f',
    'intake_private.requests_guard|3||f',
    'intake_private.request_appointments_guard|3||f',
    'intake_private.respondents_guard|3||f',
    'intake_private.responses_guard|3||f',
    'intake_private.append_only_guard|3||f',
    'intake_private.relationship_state_guard|3||f',
    'intake_private.designations_guard|3||f',
    'intake_private.assurance_rank|3||f',
    'intake_private.fulfillment_state|3|intake_destructive|t',
    'intake_private.evidence_insert_guard|4||f',
    'intake_private.evidence_identity_insert_guard|4||f',
    'intake_private.evidence_guard|4||f',
    'intake_private.lock_client|5||f',
    'intake_private.schema_max_answer_bytes|5||f',
    'intake_private.validate_answers|5||f',
    'intake_private.appointment_snapshot|5||t',
    'intake_private.compute_draft_retention|5||t',
    'intake_private.has_intake_records|5||t',
    'intake_private.drift_detected|5||t',
    'intake_private.assert_drift_free|5||t',
    'public.intake_save_template_draft|5|authenticated|t',
    'public.intake_publish_template_version|5|authenticated|t',
    'public.intake_set_reintake_floor|5|authenticated|t',
    'public.intake_set_service_assignment|5|authenticated|t',
    'public.intake_update_settings|5|authenticated|t',
    'public.intake_set_retention_choice|5|authenticated|t',
    'public.intake_get_status|5|authenticated|t',
    'public.intake_get_answers|5|authenticated|t',
    'public.intake_designate_guardian|5|authenticated|t',
    'public.intake_select_guardian_recipient|5|authenticated|t',
    'public.intake_record_minor_determination|5|authenticated|t',
    'public.intake_drift_report|5|authenticated|t',
    'public.intake_extend_draft_retention|5|authenticated|t',
    'public.intake_ensure_request|5|service_role|t',
    'public.intake_save_draft|5|service_role|t',
    'public.intake_submit_response|5|service_role|t',
    'intake_private.erase_client_impl|5|postgres|t',
    'public.intake_erase_client|5|authenticated|t',
    'public.intake_release_erasure_barrier|5|authenticated|t',
    'public.intake_create_legal_hold|5|authenticated|t',
    'public.intake_release_legal_hold|5|authenticated|t',
    'intake_private.evaluate_appointment_eligibility|6||t',
    'public.intake_reconcile_preview|6|service_role|t',
    'public.intake_reconcile_status|6|service_role|t',
    'intake_private.feature_granted|7||t',
    'intake_private.feature_grants_guard|7||f',
    'public.intake_grant_feature|7|authenticated|t',
    'public.intake_revoke_feature|7|authenticated|t',
    'public.intake_feature_status|7|authenticated|t',
    'intake_private.service_type_template|8||t',
    'intake_private.write_service_type|8||t',
    'public.intake_set_service_type|8|authenticated|t',
    'public.intake_simulate_eligibility|8|authenticated|t',
    'intake_private.template_archive_guard|9||t',
    'public.intake_archive_template|9|authenticated|t',
    'public.intake_restore_template|9|authenticated|t',
    'intake_private.invitations_insert_guard|10||t',
    'intake_private.invitations_update_guard|10||f',
    'intake_private.sessions_insert_guard|10||t',
    'intake_private.sessions_update_guard|10||f',
    'intake_private.rate_limits_update_guard|10||f',
    'intake_private.link_valid|10||t',
    'public.intake_issue_invitation|10|authenticated|t',
    'public.intake_next_invitation_generation|10|authenticated|t',
    'intake_private.request_has_live_target|10||t',
    'intake_private.try_lock_client|10|intake_destructive|f',
    'intake_private.legal_hold_insert_guard|10||t',
    'public.intake_revoke_invitations|10|authenticated|t',
    'public.intake_revoke_all_invitations_for_key|10|service_role|t',
    'public.intake_rate_limit_hit|10|service_role|t',
    'public.intake_exchange_invitation|10|service_role|t',
    'public.intake_session_context|10|service_role|t',
    'public.intake_revoke_session|10|service_role|t',
    'intake_private.purge_expired_impl|10|postgres|t',
    'public.intake_purge_expired|10|service_role|t',
    'intake_private.studio_local_date|11||f',
    'intake_private.age_in_years|11||f',
    'public.intake_determine_minor_from_birthday|11|service_role|t',
    'public.intake_declare_minor_status|11|service_role|t',
    'public.intake_session_minor_state|11|service_role|t',
    'public.intake_minor_basis|11|authenticated|t',
    'intake_private.attestations_insert_guard|12||t',
    'intake_private.attestations_update_guard|12||f',
    'public.intake_attest_guardian|12|authenticated|t',
    'intake_private.guardian_requests_insert_guard|13||t',
    'intake_private.guardian_requests_update_guard|13||f',
    'intake_private.challenges_insert_guard|13||t',
    'intake_private.challenges_update_guard|13||f',
    'public.intake_guardian_request_invitation|13|authenticated|t',
    'public.intake_guardian_finalize_invitation|13|service_role|t',
    'public.intake_guardian_challenge_target|13|service_role|t',
    'public.intake_issue_email_challenge|13|service_role|t',
    'public.intake_verify_email_challenge|13|service_role|t'];
  -- triggers: table | trigger | function | migration | timing and events | level | arguments  (full definition is
  -- compared; the four generic M3 triggers per live table are added below)
  c_trg text[] := array[
    'intake_template_versions|intake_template_versions_guard|template_version_guard|1|BEFORE INSERT OR DELETE OR UPDATE|ROW|',
    'intake_template_versions|intake_template_versions_no_truncate|refuse_truncate|1|BEFORE TRUNCATE|STATEMENT|',
    'intake_templates|intake_templates_floor_guard|template_floor_guard|1|BEFORE UPDATE|ROW|',
    'intake_templates|intake_templates_touch|touch_updated_at|1|BEFORE UPDATE|ROW|',
    'intake_service_assignments|intake_service_assignments_touch|touch_updated_at|1|BEFORE UPDATE|ROW|',
    'intake_settings|intake_settings_touch|touch_updated_at|1|BEFORE UPDATE|ROW|',
    'intake_studio_retention_choices|intake_studio_retention_choices_append_only|config_append_only|1|BEFORE DELETE OR UPDATE|ROW|',
    'intake_studio_retention_choices|intake_studio_retention_choices_no_truncate|refuse_truncate|1|BEFORE TRUNCATE|STATEMENT|',
    'intake_legal_holds|intake_legal_holds_guard|legal_hold_guard|2|BEFORE DELETE OR UPDATE|ROW|',
    'intake_legal_holds|intake_legal_holds_no_truncate|refuse_truncate|2|BEFORE TRUNCATE|STATEMENT|',
    'intake_audit_events|intake_audit_events_guard|audit_guard|2|BEFORE DELETE OR UPDATE|ROW|',
    'intake_audit_events|intake_audit_events_no_truncate|refuse_truncate|2|BEFORE TRUNCATE|STATEMENT|',
    'intake_requests|intake_requests_30_guard|requests_guard|3|BEFORE UPDATE|ROW|',
    'intake_requests|intake_requests_40_touch|touch_updated_at|3|BEFORE UPDATE|ROW|',
    'intake_request_appointments|intake_request_appointments_30_guard|request_appointments_guard|3|BEFORE UPDATE|ROW|',
    'intake_respondents|intake_respondents_30_guard|respondents_guard|3|BEFORE UPDATE|ROW|',
    'intake_responses|intake_responses_30_guard|responses_guard|3|BEFORE INSERT OR UPDATE|ROW|',
    'intake_response_revisions|intake_response_revisions_30_guard|append_only_guard|3|BEFORE UPDATE|ROW|',
    'intake_minor_determinations|intake_minor_determinations_30_guard|append_only_guard|3|BEFORE UPDATE|ROW|',
    'intake_completions|intake_completions_30_guard|append_only_guard|3|BEFORE UPDATE|ROW|',
    'intake_client_relationship_state|intake_client_relationship_state_30_guard|relationship_state_guard|3|BEFORE UPDATE|ROW|',
    'intake_client_relationship_state|intake_client_relationship_state_40_touch|touch_updated_at|3|BEFORE UPDATE|ROW|',
    'intake_guardian_designations|intake_guardian_designations_30_guard|designations_guard|3|BEFORE UPDATE|ROW|',
    'intake_consent_evidence|intake_consent_evidence_10_gate|collection_gate|4|BEFORE INSERT|ROW|''continuing''',
    'intake_consent_evidence|intake_consent_evidence_20_validate|evidence_insert_guard|4|BEFORE INSERT|ROW|',
    'intake_consent_evidence|intake_consent_evidence_30_guard|evidence_guard|4|BEFORE DELETE OR UPDATE|ROW|',
    'intake_consent_evidence|intake_consent_evidence_no_truncate|refuse_truncate|4|BEFORE TRUNCATE|STATEMENT|',
    'intake_consent_evidence_identity|intake_consent_evidence_identity_10_gate|collection_gate|4|BEFORE INSERT|ROW|''continuing''',
    'intake_consent_evidence_identity|intake_consent_evidence_identity_20_validate|evidence_identity_insert_guard|4|BEFORE INSERT|ROW|',
    'intake_consent_evidence_identity|intake_consent_evidence_identity_30_guard|evidence_guard|4|BEFORE DELETE OR UPDATE|ROW|',
    'intake_consent_evidence_identity|intake_consent_evidence_identity_no_truncate|refuse_truncate|4|BEFORE TRUNCATE|STATEMENT|',
    'intake_feature_grants|intake_feature_grants_30_guard|feature_grants_guard|7|BEFORE DELETE OR UPDATE|ROW|',
    'intake_feature_grants|intake_feature_grants_no_truncate|refuse_truncate|7|BEFORE TRUNCATE|STATEMENT|',
    'intake_templates|intake_templates_30_archive_guard|template_archive_guard|9|BEFORE UPDATE|ROW|',
    'intake_invitations|intake_invitations_10_gate|collection_gate|10|BEFORE INSERT|ROW|''new_obligation''',
    'intake_invitations|intake_invitations_20_tenant|invitations_insert_guard|10|BEFORE INSERT|ROW|',
    'intake_invitations|intake_invitations_30_guard|invitations_update_guard|10|BEFORE UPDATE|ROW|',
    'intake_invitations|intake_invitations_90_delete|delete_guard|10|BEFORE DELETE|ROW|',
    'intake_invitations|intake_invitations_no_truncate|refuse_truncate|10|BEFORE TRUNCATE|STATEMENT|',
    'intake_sessions|intake_sessions_10_gate|collection_gate|10|BEFORE INSERT|ROW|''continuing''',
    'intake_sessions|intake_sessions_20_tenant|sessions_insert_guard|10|BEFORE INSERT|ROW|',
    'intake_sessions|intake_sessions_30_guard|sessions_update_guard|10|BEFORE UPDATE|ROW|',
    'intake_sessions|intake_sessions_90_delete|delete_guard|10|BEFORE DELETE|ROW|',
    'intake_sessions|intake_sessions_no_truncate|refuse_truncate|10|BEFORE TRUNCATE|STATEMENT|',
    'intake_rate_limits|intake_rate_limits_30_guard|rate_limits_update_guard|10|BEFORE UPDATE|ROW|',
    'intake_rate_limits|intake_rate_limits_90_delete|delete_guard|10|BEFORE DELETE|ROW|',
    'intake_rate_limits|intake_rate_limits_no_truncate|refuse_truncate|10|BEFORE TRUNCATE|STATEMENT|',
    'intake_legal_holds|intake_legal_holds_05_lock|legal_hold_insert_guard|10|BEFORE INSERT|ROW|',
    'intake_guardian_attestations|intake_guardian_attestations_10_gate|collection_gate|12|BEFORE INSERT|ROW|''continuing''',
    'intake_guardian_attestations|intake_guardian_attestations_20_tenant|attestations_insert_guard|12|BEFORE INSERT|ROW|',
    'intake_guardian_attestations|intake_guardian_attestations_30_guard|attestations_update_guard|12|BEFORE UPDATE|ROW|',
    'intake_guardian_attestations|intake_guardian_attestations_90_delete|delete_guard|12|BEFORE DELETE|ROW|',
    'intake_guardian_attestations|intake_guardian_attestations_no_truncate|refuse_truncate|12|BEFORE TRUNCATE|STATEMENT|',
    'intake_guardian_invitation_requests|intake_guardian_invitation_requests_10_gate|collection_gate|13|BEFORE INSERT|ROW|''new_obligation''',
    'intake_guardian_invitation_requests|intake_guardian_invitation_requests_20_tenant|guardian_requests_insert_guard|13|BEFORE INSERT|ROW|',
    'intake_guardian_invitation_requests|intake_guardian_invitation_requests_30_guard|guardian_requests_update_guard|13|BEFORE UPDATE|ROW|',
    'intake_guardian_invitation_requests|intake_guardian_invitation_requests_90_delete|delete_guard|13|BEFORE DELETE|ROW|',
    'intake_guardian_invitation_requests|intake_guardian_invitation_requests_no_truncate|refuse_truncate|13|BEFORE TRUNCATE|STATEMENT|',
    'intake_email_challenges|intake_email_challenges_10_gate|collection_gate|13|BEFORE INSERT|ROW|''continuing''',
    'intake_email_challenges|intake_email_challenges_20_tenant|challenges_insert_guard|13|BEFORE INSERT|ROW|',
    'intake_email_challenges|intake_email_challenges_30_guard|challenges_update_guard|13|BEFORE UPDATE|ROW|',
    'intake_email_challenges|intake_email_challenges_90_delete|delete_guard|13|BEFORE DELETE|ROW|',
    'intake_email_challenges|intake_email_challenges_no_truncate|refuse_truncate|13|BEFORE TRUNCATE|STATEMENT|'];
  -- policies: table | policy | cmd | permissive | roles | qual | with check | migration   (built below)
  -- version tripwire: functions replaced by a later migration must still carry that migration's marker comment, so replaying an
  -- OLDER migration (which would silently restore an older body) fails closed.  name | marker | migration
  c_guard constant text[] := array[
    'intake_private.assert_staff|nsi-body:m7|7',
    'intake_private.new_obligation_allowed|nsi-body:m7|7',
    'public.intake_update_settings|nsi-body:m7|7',
    'public.intake_set_service_assignment|nsi-body:m8|8',
    'intake_private.evaluate_appointment_eligibility|nsi-body:m11|8',
    'public.intake_reconcile_preview|nsi-body:m11|8',
    'public.intake_ensure_request|nsi-body:m11|8',
    'public.intake_save_template_draft|nsi-body:m9|9',
    'public.intake_publish_template_version|nsi-body:m9|9',
    'public.intake_issue_invitation|nsi-body:m16b|13',
    'intake_private.erase_client_impl|nsi-body:m16b|13',
    'intake_private.purge_expired_impl|nsi-body:m16b|13',
    'public.intake_revoke_session|nsi-body:m14|10',
    'intake_private.client_has_active_hold|nsi-body:m14|10',
    'intake_private.is_held|nsi-body:m14|10',
    'public.intake_erase_client|nsi-body:m14|10',
    'intake_private.delete_guard|nsi-body:m14|10',
    'intake_private.legal_hold_insert_guard|nsi-body:m14|10',
    'intake_private.lock_client|nsi-body:m14|10',
    'intake_private.try_lock_client|nsi-body:m14|10',
    'public.intake_create_legal_hold|nsi-body:m14|10',
    'intake_private.fulfillment_state|nsi-body:m15|11',
    'intake_private.respondents_guard|nsi-body:m16b|13',
    'intake_private.audit_write|nsi-body:m16a|12',
    'intake_private.link_valid|nsi-body:m16b|13',
    'intake_private.invitations_update_guard|nsi-body:m16b|13',
    'public.intake_revoke_invitations|nsi-body:m16b|13'
  ]; -- guard-end
  c_pol text[] := '{}';
  v_t text;
begin
  -- ----- inventory expansion --------------------------------------------------------------------------------------
  foreach v_t in array c_live loop
    c_trg := c_trg || array[
      v_t || '|' || v_t || '_10_gate|collection_gate|3|BEFORE INSERT|ROW|'
          || case when v_t in ('intake_requests', 'intake_request_appointments') then '''new_obligation''' else '''continuing''' end,
      v_t || '|' || v_t || '_20_tenant|tenant_guard|3|BEFORE INSERT|ROW|',
      v_t || '|' || v_t || '_90_delete|delete_guard|3|BEFORE DELETE|ROW|',
      v_t || '|' || v_t || '_no_truncate|refuse_truncate|3|BEFORE TRUNCATE|STATEMENT|'];
    c_pol := c_pol || array[v_t || '|' || v_t || '_destructive_select|r|t|intake_destructive|true||3',
                            v_t || '|' || v_t || '_destructive_delete|d|t|intake_destructive|true||3'];
  end loop;
  foreach v_t in array c_config loop
    c_pol := c_pol || (v_t || '|' || v_t || '_staff_read|r|t|authenticated|' || c_config_qual || '||1');
  end loop;
  foreach v_t in array array['intake_invitations', 'intake_sessions', 'intake_rate_limits'] loop
    c_pol := c_pol || array[v_t || '|' || v_t || '_destructive_select|r|t|intake_destructive|true||10',
                            v_t || '|' || v_t || '_destructive_delete|d|t|intake_destructive|true||10'];
  end loop;
  c_pol := c_pol || array['intake_guardian_attestations|intake_guardian_attestations_destructive_select|r|t|intake_destructive|true||12',
                          'intake_guardian_attestations|intake_guardian_attestations_destructive_delete|d|t|intake_destructive|true||12'];
  foreach v_t in array array['intake_guardian_invitation_requests', 'intake_email_challenges'] loop
    c_pol := c_pol || array[v_t || '|' || v_t || '_destructive_select|r|t|intake_destructive|true||13',
                            v_t || '|' || v_t || '_destructive_delete|d|t|intake_destructive|true||13'];
  end loop;
  if current_setting('server_version_num')::int >= 170000 then
    v_table_privs := v_table_privs || 'MAINTAIN'::text;
  end if;

  -- ----- which migrations are present (each must be complete; present migrations must be M1..Mk) -------------------
  for v_m in 1 .. 13 loop
    select count(*) filter (where to_regclass('public.' || split_part(x, '|', 1)) is not null), count(*)
    into v_present, v_total from unnest(c_rel) x where split_part(x, '|', 2)::int = v_m;
    select v_present + count(*) filter (where exists (
             select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = split_part(split_part(x, '|', 1), '.', 1) and p.proname = split_part(split_part(x, '|', 1), '.', 2))),
           v_total + count(*)
    into v_present, v_total from unnest(c_fn) x where split_part(x, '|', 2)::int = v_m;
    if v_present = v_total then
      v_complete := v_complete || v_m;
    elsif v_present > 0 then
      v_errors := v_errors || format('M%s is partially deployed (%s of %s objects)', v_m, v_present, v_total);
    end if;
  end loop;
  if not (1 = any (v_complete)) then
    v_errors := v_errors || 'M1 is not completely deployed'::text;
  end if;
  if v_complete <> (select coalesce(array_agg(g order by g), '{}') from generate_series(1, coalesce(cardinality(v_complete), 0)) g) then
    v_errors := v_errors || format('present migrations are not a prefix M1..Mk: %s', v_complete);
  end if;

  -- ----- restricted role, memberships, schema, default ACLs, session ---------------------------------------------
  if not exists (select 1 from pg_roles where rolname = 'intake_destructive' and not rolcanlogin and not rolinherit
                   and not rolbypassrls and not rolsuper and not rolcreaterole and not rolcreatedb and not rolreplication) then
    v_errors := v_errors || 'role intake_destructive missing or has elevated attributes'::text;
  else
    -- postgres needs SET (never INHERIT); hosted creation may add an implicit admin-only row for the creator.
    if not exists (select 1 from pg_auth_members am where am.roleid = 'intake_destructive'::regrole
                     and am.member = 'postgres'::regrole and am.set_option and not am.inherit_option) then
      v_errors := v_errors || 'postgres lacks SET membership in intake_destructive'::text;
    end if;
    if exists (select 1 from pg_auth_members am where am.roleid = 'intake_destructive'::regrole
                 and (am.member <> 'postgres'::regrole or am.inherit_option)) then
      v_errors := v_errors || 'intake_destructive has an unexpected or INHERIT membership'::text;
    end if;
    if exists (select 1 from pg_auth_members am where am.member = 'intake_destructive'::regrole) then
      v_errors := v_errors || 'intake_destructive is a member of another role'::text;
    end if;
    if has_schema_privilege('intake_destructive', 'public', 'CREATE') then
      v_errors := v_errors || 'intake_destructive can CREATE in schema public'::text;
    end if;
    if exists (select 1 from pg_default_acl d where d.defaclrole = 'intake_destructive'::regrole) then
      v_errors := v_errors || 'default privileges are defined by intake_destructive'::text;
    end if;
  end if;
  select array(select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type
               from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
               where n.nspname = 'intake_private' and a.grantee <> n.nspowner order by 1)
  into v_actual;
  if v_actual is distinct from array['intake_destructive:USAGE'] then
    v_errors := v_errors || format('intake_private privileges are %s (expected intake_destructive:USAGE)', v_actual);
  end if;
  if (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'intake_private') is distinct from 'postgres' then
    v_errors := v_errors || 'intake_private is not owned by postgres'::text;
  end if;
  if exists (select 1 from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = 'intake_private') then
    v_errors := v_errors || 'default privileges exist for schema intake_private'::text;
  end if;
  if current_setting('session_replication_role') <> 'origin' then
    v_errors := v_errors || 'session_replication_role is not origin (guard triggers would not fire)'::text;
  end if;

  -- ----- relations ------------------------------------------------------------------------------------------------
  for r in select c.oid, c.relname, n.nspname, c.relkind, c.relacl, c.relrowsecurity, pg_get_userbyid(c.relowner) as owner, c.relowner,
                  (select x from unnest(c_rel) x where split_part(x, '|', 1) = c.relname and n.nspname = 'public') as inv
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where ((n.nspname = 'public' and c.relname like 'intake\_%') or n.nspname = 'intake_private')
             and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c') loop
    if r.inv is null or r.relkind <> 'r' then
      v_errors := v_errors || format('unexpected relation %s.%s (kind %s)', r.nspname, r.relname, r.relkind);
      continue;
    end if;
    if r.owner <> 'postgres' then v_errors := v_errors || format('relation %s owned by %s', r.relname, r.owner); end if;
    if not r.relrowsecurity then v_errors := v_errors || format('relation %s has RLS disabled', r.relname); end if;
    if r.relacl is null then
      v_errors := v_errors || format('relation %s has a default (NULL) ACL', r.relname);
    end if;
    select array(select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type
                 from aclexplode(coalesce(r.relacl, acldefault('r', r.relowner))) a where a.grantee <> r.relowner order by 1)
    into v_actual;
    v_expected := coalesce(array(select x from unnest(string_to_array(nullif(split_part(r.inv, '|', 3), ''), ',')) x order by 1), '{}');
    if v_actual <> v_expected then
      v_errors := v_errors || format('relation %s grants %s (expected %s)', r.relname, v_actual, v_expected);
    end if;
    if exists (select 1 from pg_attribute a where a.attrelid = r.oid and a.attnum > 0 and a.attacl is not null) then
      v_errors := v_errors || format('relation %s has column-level grants', r.relname);
    end if;
    foreach v_role in array v_roles loop
      foreach v_priv in array v_table_privs loop
        if has_table_privilege(v_role, r.oid, v_priv) <> ((v_role || ':' || v_priv) = any (v_expected)) then
          v_errors := v_errors || format('relation %s: %s %s %s', r.relname, v_role,
            case when has_table_privilege(v_role, r.oid, v_priv) then 'unexpectedly holds' else 'lacks' end, v_priv);
        end if;
      end loop;
      if has_any_column_privilege(v_role, r.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
         and not exists (select 1 from unnest(v_expected) e where e like v_role || ':%' and split_part(e, ':', 2) in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')) then
        v_errors := v_errors || format('relation %s: %s holds a column privilege', r.relname, v_role);
      end if;
    end loop;
  end loop;

  -- ----- functions ------------------------------------------------------------------------------------------------
  for r in select n.nspname || '.' || p.proname as qname, count(*) as n
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private'
           group by 1 having count(*) > 1 loop
    v_errors := v_errors || format('function %s has %s overloads', r.qname, r.n);
  end loop;
  for r in select p.oid, n.nspname || '.' || p.proname as qname, p.proacl, p.prosecdef, p.proconfig, p.proowner,
                  pg_get_userbyid(p.proowner) as owner,
                  (select x from unnest(c_fn) x where split_part(x, '|', 1) = n.nspname || '.' || p.proname) as inv
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private' loop
    if r.inv is null then
      v_errors := v_errors || format('unexpected function %s', r.qname);
      continue;
    end if;
    if r.qname in ('intake_private.erase_client_impl', 'intake_private.purge_expired_impl') then
      if r.owner <> 'intake_destructive' then
        v_errors := v_errors || format('function %s must be owned by intake_destructive (is %s)', r.qname, r.owner);
      end if;
    elsif r.owner <> 'postgres' then
      v_errors := v_errors || format('function %s owned by %s', r.qname, r.owner);
    end if;
    if r.proacl is null then
      v_errors := v_errors || format('function %s has a default (NULL) ACL (PUBLIC execute)', r.qname);
    end if;
    if r.proconfig is null or not ('search_path=pg_catalog, pg_temp' = any (r.proconfig)) then
      v_errors := v_errors || format('function %s has no pinned search_path', r.qname);
    end if;
    if r.prosecdef <> (split_part(r.inv, '|', 4) = 't') then
      v_errors := v_errors || format('function %s SECURITY DEFINER is %s', r.qname, r.prosecdef);
    end if;
    select array(select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
                 from aclexplode(coalesce(r.proacl, acldefault('f', r.proowner))) a where a.grantee <> r.proowner order by 1)
    into v_actual;
    v_expected := coalesce(array(select x from unnest(string_to_array(nullif(split_part(r.inv, '|', 3), ''), ',')) x order by 1), '{}');
    if v_actual <> v_expected then
      v_errors := v_errors || format('function %s executable by %s (expected %s)', r.qname, v_actual, v_expected);
    end if;
    foreach v_role in array v_roles loop
      if has_function_privilege(v_role, r.oid, 'EXECUTE') <> (v_role = r.owner or v_role = any (v_expected)) then
        v_errors := v_errors || format('function %s: effective EXECUTE for %s is %s', r.qname, v_role,
          has_function_privilege(v_role, r.oid, 'EXECUTE'));
      end if;
    end loop;
  end loop;

  -- ----- triggers (exact full definitions for the present migrations: timing, events, level, WHEN condition,
  --       function schema and arguments; all enabled) ---------------------------------------------------------------
  select array(select split_part(x, '|', 1) || ' :: ' || format('CREATE TRIGGER %s %s ON public.%s FOR EACH %s EXECUTE FUNCTION intake_private.%s(%s)',
                        split_part(x, '|', 2), split_part(x, '|', 5), split_part(x, '|', 1), split_part(x, '|', 6),
                        split_part(x, '|', 3), split_part(x, '|', 7))
               from unnest(c_trg) x where split_part(x, '|', 4)::int = any (v_complete) order by 1)
  into v_expected;
  select array(select c.relname || ' :: ' || pg_get_triggerdef(t.oid)
               from pg_trigger t join pg_class c on c.oid = t.tgrelid
               where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and not t.tgisinternal order by 1)
  into v_actual;
  if v_actual <> v_expected then
    v_errors := v_errors || format('trigger drift: missing %s, unexpected %s',
      array(select unnest(v_expected) except select unnest(v_actual)), array(select unnest(v_actual) except select unnest(v_expected)));
  end if;
  for r in select c.relname, t.tgname, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and t.tgenabled <> 'O' loop
    v_errors := v_errors || format('trigger %s.%s is not enabled in origin mode (tgenabled=%s)', r.relname, r.tgname, r.tgenabled);
  end loop;

  -- ----- RLS policies (exact set for the present migrations) ------------------------------------------------------
  select array(select split_part(x, '|', 1) || '|' || split_part(x, '|', 2) || '|' || split_part(x, '|', 3) || '|' || split_part(x, '|', 4)
                      || '|' || split_part(x, '|', 5) || '|' || split_part(x, '|', 6) || '|' || split_part(x, '|', 7)
               from unnest(c_pol) x where split_part(x, '|', 8)::int = any (v_complete) order by 1)
  into v_expected;
  select array(select c.relname || '|' || pl.polname || '|' || pl.polcmd::text || '|' || case when pl.polpermissive then 't' else 'f' end
                      || '|' || array_to_string(array(select case when o = 0 then 'PUBLIC' else pg_get_userbyid(o) end from unnest(pl.polroles) o order by 1), ',')
                      || '|' || coalesce(pg_get_expr(pl.polqual, pl.polrelid), '') || '|' || coalesce(pg_get_expr(pl.polwithcheck, pl.polrelid), '')
               from pg_policy pl join pg_class c on c.oid = pl.polrelid
               where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' order by 1)
  into v_actual;
  if v_actual <> v_expected then
    v_errors := v_errors || format('policy drift: missing %s, unexpected %s',
      array(select unnest(v_expected) except select unnest(v_actual)), array(select unnest(v_actual) except select unnest(v_expected)));
  end if;

  foreach v_t in array c_guard loop
    if split_part(v_t, '|', 3)::int = any (v_complete) and not exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname || '.' || p.proname = split_part(v_t, '|', 1) and position(split_part(v_t, '|', 2) in p.prosrc) > 0) then
      v_errors := v_errors || format('function %s does not carry the %s marker (an older body was restored?)', split_part(v_t, '|', 1), split_part(v_t, '|', 2));
    end if;
  end loop;

  -- ----- hot table untouched --------------------------------------------------------------------------------------
  if exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace n on n.oid = p.pronamespace
             where t.tgrelid = 'public.appointments'::regclass and (n.nspname = 'intake_private' or p.proname like 'intake\_%')) then
    v_errors := v_errors || 'an intake trigger exists on public.appointments'::text;
  end if;
  if exists (select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
             where c.contype = 'f' and c.confrelid = 'public.appointments'::regclass and t.relname like 'intake\_%') then
    v_errors := v_errors || 'an intake foreign key references public.appointments'::text;
  end if;

  if cardinality(v_errors) > 0 then
    raise exception 'nsi catalog self-check failed: %', array_to_string(v_errors, '; ') using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Audit event types (widened by four; the rollback narrows it again and is refused once any of these events exists)
-- ---------------------------------------------------------------------------------------------------------------
alter table public.intake_audit_events drop constraint intake_audit_events_event_type_check;
alter table public.intake_audit_events add constraint intake_audit_events_event_type_check check (event_type = any (array[
  'environment_first_personal_use', 'template_draft_saved', 'template_version_published', 'reintake_floor_set', 'service_assignment_set', 'settings_updated', 'retention_choice_set', 'request_created', 'appointment_attached', 'draft_saved', 'response_submitted', 'completion_recorded', 'minor_determination_recorded', 'guardian_designated', 'guardian_recipient_selected', 'draft_retention_extended', 'staff_viewed_answers', 'drift_report_run', 'tenant_drift_detected', 'legal_hold_created', 'legal_hold_released', 'erasure_record', 'erasure_barrier_released', 'erasure_refused_hold', 'gate_refused', 'feature_granted', 'feature_revoked', 'template_archived', 'template_restored',
  'invitation_issued', 'invitation_revoked', 'link_exchanged', 'session_revoked', 'guardian_attested', 'guardian_invitation_requested', 'guardian_invitation_issued', 'guardian_email_challenge_issued', 'guardian_email_verified']::text[]));

-- ---------------------------------------------------------------------------------------------------------------
-- Invitations and sessions: guardian audience, two-party issue, recipient bound as a keyed hash (never an address)
-- ---------------------------------------------------------------------------------------------------------------
alter table public.intake_invitations add column if not exists recipient_email_hmac text null
  constraint intake_invitations_recipient_len check (recipient_email_hmac is null or char_length(recipient_email_hmac) between 1 and 128);
alter table public.intake_invitations add column if not exists recipient_email_hmac_kid smallint null;

alter table public.intake_invitations drop constraint if exists intake_invitations_audience_check;
alter table public.intake_invitations add constraint intake_invitations_audience_check check (audience in ('student', 'guardian'));
alter table public.intake_invitations drop constraint if exists intake_invitations_issued_by_check;
alter table public.intake_invitations add constraint intake_invitations_issued_by_check check (issued_by in ('staff', 'reconciler', 'two_party'));
alter table public.intake_invitations drop constraint if exists intake_invitations_recipient_iff;
alter table public.intake_invitations add constraint intake_invitations_recipient_iff check
  ((audience = 'guardian') = (recipient_email_hmac is not null and recipient_email_hmac_kid is not null and issued_by = 'two_party'));
alter table public.intake_invitations drop constraint if exists intake_invitations_recipient_student_null;
alter table public.intake_invitations add constraint intake_invitations_recipient_student_null check
  (audience = 'guardian' or (recipient_email_hmac is null and recipient_email_hmac_kid is null and issued_by <> 'two_party'));
alter table public.intake_sessions drop constraint if exists intake_sessions_audience_check;
alter table public.intake_sessions add constraint intake_sessions_audience_check check (audience in ('student', 'guardian'));

-- at most one current guardian respondent per request (the preflight above refuses a database that already breaks this)
create unique index if not exists intake_respondents_one_open_guardian
  on public.intake_respondents (request_id) where role = 'guardian' and superseded_at is null;

-- ---------------------------------------------------------------------------------------------------------------
-- Pending guardian invitation requests (the staff half of the two-party handshake). Holds a keyed hash, never an address.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.intake_guardian_invitation_requests (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  request_id uuid not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  recipient_email_hmac text not null check (char_length(recipient_email_hmac) between 1 and 128),
  recipient_email_hmac_kid smallint not null,
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finalized_invitation_id uuid null,
  finalized_at timestamptz null,
  superseded_at timestamptz null,
  constraint intake_guardian_invitation_requests_studio_id_key unique (studio_id, id),
  constraint intake_guardian_invitation_requests_request_fk foreign key (studio_id, request_id)
    references public.intake_requests (studio_id, id) on delete restrict,
  constraint intake_guardian_invitation_requests_invitation_fk foreign key (studio_id, finalized_invitation_id)
    references public.intake_invitations (studio_id, id) on delete restrict,
  constraint intake_guardian_invitation_requests_finalized_pair check ((finalized_at is null) = (finalized_invitation_id is null)),
  constraint intake_guardian_invitation_requests_one_end check (finalized_at is null or superseded_at is null),
  constraint intake_guardian_invitation_requests_expiry check (expires_at > requested_at)
);
create unique index if not exists intake_guardian_invitation_requests_one_open
  on public.intake_guardian_invitation_requests (request_id) where finalized_at is null and superseded_at is null;
create index if not exists intake_guardian_invitation_requests_request on public.intake_guardian_invitation_requests (request_id);
create index if not exists intake_guardian_invitation_requests_invitation on public.intake_guardian_invitation_requests (finalized_invitation_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Email challenges. The code is never stored (only its keyed hash); the address is never stored here.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.intake_email_challenges (
  id uuid primary key,
  studio_id uuid not null references public.studios(id) on delete restrict,
  request_id uuid not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  respondent_id uuid not null,
  invitation_id uuid not null,
  email_hmac text not null check (char_length(email_hmac) between 1 and 128),
  email_hmac_kid smallint not null,
  code_hash bytea not null check (octet_length(code_hash) = 32),
  expires_at timestamptz not null,
  attempts smallint not null default 0 check (attempts between 0 and 5),
  consumed_at timestamptz null,
  superseded_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint intake_email_challenges_studio_id_key unique (studio_id, id),
  constraint intake_email_challenges_request_fk foreign key (studio_id, request_id)
    references public.intake_requests (studio_id, id) on delete restrict,
  constraint intake_email_challenges_respondent_fk foreign key (studio_id, respondent_id)
    references public.intake_respondents (studio_id, id) on delete restrict,
  constraint intake_email_challenges_invitation_fk foreign key (studio_id, invitation_id)
    references public.intake_invitations (studio_id, id) on delete restrict,
  constraint intake_email_challenges_one_end check (consumed_at is null or superseded_at is null)
);
create unique index if not exists intake_email_challenges_one_open
  on public.intake_email_challenges (respondent_id) where consumed_at is null and superseded_at is null;
create index if not exists intake_email_challenges_respondent on public.intake_email_challenges (respondent_id, created_at);
create index if not exists intake_email_challenges_invitation on public.intake_email_challenges (invitation_id);
create index if not exists intake_email_challenges_request on public.intake_email_challenges (request_id);

revoke all on public.intake_guardian_invitation_requests, public.intake_email_challenges from public, anon, authenticated, service_role;
alter table public.intake_guardian_invitation_requests enable row level security;
alter table public.intake_email_challenges enable row level security;
grant select, delete on public.intake_guardian_invitation_requests, public.intake_email_challenges to intake_destructive;
do $$
declare t text;
begin
  foreach t in array array['intake_guardian_invitation_requests', 'intake_email_challenges'] loop
    execute format('drop policy if exists %I on public.%I', t || '_destructive_select', t);
    execute format('create policy %I on public.%I for select to intake_destructive using (true)', t || '_destructive_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_destructive_delete', t);
    execute format('create policy %I on public.%I for delete to intake_destructive using (true)', t || '_destructive_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------------------------
create or replace function intake_private.guardian_requests_insert_guard()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
declare q public.intake_requests;
begin
  select * into q from public.intake_requests r where r.id = new.request_id;
  if q.id is null or q.studio_id <> new.studio_id or q.client_id <> new.client_id then
    raise exception 'nsi: guardian invitation request does not belong to the studio and client' using errcode = '42501';
  end if;
  if q.status not in ('invited', 'in_progress') then
    raise exception 'nsi: guardian invitation request needs an open, invited request' using errcode = '42501';
  end if;
  if new.finalized_at is not null or new.finalized_invitation_id is not null or new.superseded_at is not null then
    raise exception 'nsi: a guardian invitation request starts open' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function intake_private.guardian_requests_update_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
begin
  if new.id <> old.id or new.studio_id <> old.studio_id or new.request_id <> old.request_id or new.client_id <> old.client_id
     or new.recipient_email_hmac <> old.recipient_email_hmac or new.recipient_email_hmac_kid <> old.recipient_email_hmac_kid
     or new.requested_by <> old.requested_by or new.requested_at <> old.requested_at or new.expires_at <> old.expires_at
     or (old.finalized_at is not null and (new.finalized_at is distinct from old.finalized_at
                                           or new.finalized_invitation_id is distinct from old.finalized_invitation_id))
     or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) then
    raise exception 'nsi: a guardian invitation request is finalized or superseded once and nothing else changes' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function intake_private.challenges_insert_guard()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
declare
  q public.intake_requests;
  p public.intake_respondents;
  i public.intake_invitations;
begin
  select * into q from public.intake_requests r where r.id = new.request_id;
  if q.id is null or q.studio_id <> new.studio_id or q.client_id <> new.client_id then
    raise exception 'nsi: challenge request does not belong to the studio and client' using errcode = '42501';
  end if;
  select * into p from public.intake_respondents x where x.id = new.respondent_id;
  if p.id is null or p.studio_id <> new.studio_id or p.request_id <> new.request_id or p.client_id <> new.client_id
     or p.role <> 'guardian' or p.superseded_at is not null or p.redacted_at is not null then
    raise exception 'nsi: challenge respondent must be the current guardian respondent of this request' using errcode = '42501';
  end if;
  if p.email_hmac is distinct from new.email_hmac or p.email_hmac_kid is distinct from new.email_hmac_kid then
    raise exception 'nsi: challenge hash must be the hash of the respondent' using errcode = '42501';
  end if;
  select * into i from public.intake_invitations x where x.id = new.invitation_id;
  if i.id is null or i.studio_id <> new.studio_id or i.request_id <> new.request_id or i.audience <> 'guardian'
     or i.revoked_at is not null or i.expires_at <= now()
     or i.generation <> (select max(x.generation) from public.intake_invitations x where x.request_id = i.request_id and x.audience = 'guardian')
     or i.recipient_email_hmac is distinct from new.email_hmac or i.recipient_email_hmac_kid is distinct from new.email_hmac_kid then
    raise exception 'nsi: challenge needs the live guardian invitation bound to the same recipient' using errcode = '42501';
  end if;
  if new.attempts <> 0 or new.consumed_at is not null or new.superseded_at is not null then
    raise exception 'nsi: a challenge starts open with no attempts' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function intake_private.challenges_update_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
begin
  if new.id <> old.id or new.studio_id <> old.studio_id or new.request_id <> old.request_id or new.client_id <> old.client_id
     or new.respondent_id <> old.respondent_id or new.invitation_id <> old.invitation_id or new.email_hmac <> old.email_hmac
     or new.email_hmac_kid <> old.email_hmac_kid or new.code_hash <> old.code_hash or new.expires_at <> old.expires_at
     or new.created_at <> old.created_at
     or (new.attempts <> old.attempts and (new.attempts <> old.attempts + 1 or old.consumed_at is not null or old.superseded_at is not null))
     or (old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at)
     or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) then
    raise exception 'nsi: a challenge only counts attempts up by one, and is consumed or superseded once' using errcode = '42501';
  end if;
  return new;
end $$;

do $$
declare t text; v_prefix text;
begin
  foreach t in array array['intake_guardian_invitation_requests', 'intake_email_challenges'] loop
    v_prefix := case when t = 'intake_email_challenges' then 'challenges' else 'guardian_requests' end;
    execute format('drop trigger if exists %I on public.%I', t || '_10_gate', t);
    execute format('create trigger %I before insert on public.%I for each row execute function intake_private.collection_gate(%L)',
                   t || '_10_gate', t, case when t = 'intake_email_challenges' then 'continuing' else 'new_obligation' end);
    execute format('drop trigger if exists %I on public.%I', t || '_20_tenant', t);
    execute format('create trigger %I before insert on public.%I for each row execute function intake_private.%I()',
                   t || '_20_tenant', t, v_prefix || '_insert_guard');
    execute format('drop trigger if exists %I on public.%I', t || '_30_guard', t);
    execute format('create trigger %I before update on public.%I for each row execute function intake_private.%I()',
                   t || '_30_guard', t, v_prefix || '_update_guard');
    execute format('drop trigger if exists %I on public.%I', t || '_90_delete', t);
    execute format('create trigger %I before delete on public.%I for each row execute function intake_private.delete_guard()', t || '_90_delete', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function intake_private.refuse_truncate()', t || '_no_truncate', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Replaced guards and link check
-- ---------------------------------------------------------------------------------------------------------------
create or replace function intake_private.respondents_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
begin
  if new.id <> old.id or new.studio_id <> old.studio_id or new.request_id <> old.request_id
     or new.client_id <> old.client_id or new.role <> old.role or new.display_name <> old.display_name
     or new.declared_relationship is distinct from old.declared_relationship or new.created_at <> old.created_at
     or (new.assurance <> old.assurance and not (old.assurance = 'declared_unverified' and new.assurance = 'staff_attested'
         and exists (select 1 from public.intake_guardian_attestations a where a.respondent_id = old.id and a.request_id = old.request_id and a.studio_id = old.studio_id))
       -- email verified: only from a consumed challenge of the latest, unrevoked guardian invitation, for exactly the stored (non-null) hash
       and not (old.assurance = 'declared_unverified' and new.assurance = 'email_code_verified' and old.role = 'guardian'
         and new.email_hmac is not null and new.email_hmac_kid is not null
         and exists (select 1 from public.intake_email_challenges c
                     join public.intake_invitations i on i.id = c.invitation_id and i.studio_id = c.studio_id
                     where c.respondent_id = old.id and c.request_id = old.request_id and c.studio_id = old.studio_id
                       and c.consumed_at is not null and c.email_hmac = new.email_hmac and c.email_hmac_kid = new.email_hmac_kid
                       and i.audience = 'guardian' and i.revoked_at is null
                       and i.generation = (select max(x.generation) from public.intake_invitations x
                                           where x.request_id = i.request_id and x.audience = 'guardian'))))
     or (new.assurance_at <> old.assurance_at and new.assurance = old.assurance)
     or (new.email is distinct from old.email and new.email is not null)
     or (new.email_hmac is distinct from old.email_hmac and new.email_hmac is not null)
     or (new.email_hmac_kid is distinct from old.email_hmac_kid and new.email_hmac_kid is not null)
     or (new.auth_user_id is distinct from old.auth_user_id and new.auth_user_id is not null)
     or (new.source_link_id is distinct from old.source_link_id and new.source_link_id is not null)
     or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at)
     or (old.redacted_at is not null and new.redacted_at is distinct from old.redacted_at) then
    raise exception 'nsi: respondent attribution is immutable outside the documented allowlist' using errcode = '42501';
  end if;
  if (new.email is distinct from old.email or new.redacted_at is distinct from old.redacted_at)
     and current_user <> 'intake_destructive' and new.auth_user_id is not distinct from old.auth_user_id then
    raise exception 'nsi: respondent redaction is reserved to the restricted role' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function intake_private.link_valid(p_invitation_id uuid)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
declare
  i public.intake_invitations;
  q public.intake_requests;
  v_minor boolean;
begin
  select * into i from public.intake_invitations x where x.id = p_invitation_id;
  if i.id is null or i.revoked_at is not null or i.expires_at <= now() then return false; end if;
  if i.generation <> (select max(x.generation) from public.intake_invitations x where x.request_id = i.request_id and x.audience = i.audience) then
    return false;
  end if;
  select * into q from public.intake_requests r where r.id = i.request_id and r.studio_id = i.studio_id;
  if q.id is null or q.status not in ('invited', 'in_progress') then return false; end if;
  -- a guardian link works only while the latest determination says minor and staff have not chosen a linked recipient instead
  if i.audience = 'guardian' then
    if q.guardian_recipient_link_id is not null then return false; end if;
    select d.is_minor into v_minor from public.intake_minor_determinations d where d.request_id = q.id order by d.created_at desc, d.id desc limit 1;
    if v_minor is distinct from true then return false; end if;
  end if;
  if not intake_private.retention_gate_open() then return false; end if;
  if intake_private.erasure_barrier_active(q.studio_id, q.client_id) then return false; end if;
  return intake_private.request_has_live_target(q.id);
end $$;

create or replace function intake_private.invitations_update_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
begin
  if new.id <> old.id or new.studio_id <> old.studio_id or new.request_id <> old.request_id or new.audience <> old.audience
     or new.generation <> old.generation or new.kid <> old.kid or new.token_salt <> old.token_salt or new.token_hash <> old.token_hash
     or new.issued_by <> old.issued_by or new.issued_by_user is distinct from old.issued_by_user
     or new.recipient_email_hmac is distinct from old.recipient_email_hmac or new.recipient_email_hmac_kid is distinct from old.recipient_email_hmac_kid
     or new.pinned_version_id <> old.pinned_version_id or new.expires_at <> old.expires_at or new.created_at <> old.created_at
     or (old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at or new.revoked_reason is distinct from old.revoked_reason)) then
    raise exception 'nsi: invitations are immutable except one revocation' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Staff: request a guardian invitation (authenticated; assert_staff 'send'). Records the recipient hash only.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.intake_guardian_request_invitation(p_studio_id uuid, p_request_id uuid,
  p_recipient_email_hmac text, p_recipient_kid smallint)
returns text language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
declare
  v_role text := intake_private.assert_staff(p_studio_id, 'send');
  v_client uuid;
  q public.intake_requests;
  v_minor boolean;
  v_id uuid;
  v_gen int;
  v_superseded int;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'nsi: a guardian invitation requires READ COMMITTED (the barrier and hold checks rely on seeing every committed change)' using errcode = '55000';
  end if;
  if p_recipient_email_hmac is null or char_length(p_recipient_email_hmac) not between 1 and 128 or p_recipient_kid is null then
    raise exception 'nsi: a guardian invitation needs the recipient hash and its key id' using errcode = '22023';
  end if;
  select r.client_id into v_client from public.intake_requests r where r.id = p_request_id and r.studio_id = p_studio_id;
  if v_client is null then raise exception 'nsi: record unavailable' using errcode = '42501'; end if;
  if not intake_private.retention_gate_open() then return 'gate_closed'; end if;
  perform intake_private.assert_drift_free(p_studio_id, v_client, p_request_id);
  if intake_private.erasure_barrier_active(p_studio_id, v_client) then return 'erasure_barrier'; end if;
  perform intake_private.lock_client(p_studio_id, v_client);
  select * into q from public.intake_requests r where r.id = p_request_id and r.studio_id = p_studio_id for update;
  if q.id is null then
    if intake_private.erasure_barrier_active(p_studio_id, v_client) then return 'erasure_barrier'; end if;
    raise exception 'nsi: record unavailable' using errcode = '42501';
  end if;
  perform intake_private.assert_drift_free(p_studio_id, q.client_id, q.id);
  if intake_private.erasure_barrier_active(p_studio_id, q.client_id) then return 'erasure_barrier'; end if;
  if q.status not in ('invited', 'in_progress') or q.pinned_version_id is null then return 'not_open'; end if;
  if not intake_private.request_has_live_target(q.id) then return 'no_live_target'; end if;
  perform 1 from public.intake_responses r where r.request_id = q.id order by r.request_id, r.audience for update;
  if exists (select 1 from public.intake_responses r where r.request_id = q.id and r.audience = 'guardian' and r.status = 'submitted') then
    return 'already_submitted';
  end if;
  if q.guardian_recipient_link_id is not null then return 'recipient_link_set'; end if;
  select d.is_minor into v_minor from public.intake_minor_determinations d where d.request_id = q.id order by d.created_at desc, d.id desc limit 1;
  if v_minor is distinct from true then return 'not_minor'; end if;
  -- the old link stops now: invitations, sessions, the open pending row, open challenges, the unsubmitted draft and respondent
  update public.intake_invitations i set revoked_at = now(), revoked_reason = 'resent'
    where i.request_id = q.id and i.audience = 'guardian' and i.revoked_at is null;
  update public.intake_sessions s set revoked_at = now() where s.request_id = q.id and s.audience = 'guardian' and s.revoked_at is null;
  update public.intake_guardian_invitation_requests g set superseded_at = now()
    where g.request_id = q.id and g.finalized_at is null and g.superseded_at is null;
  update public.intake_email_challenges c set superseded_at = now()
    where c.request_id = q.id and c.consumed_at is null and c.superseded_at is null;
  update public.intake_responses r set status = 'superseded' where r.request_id = q.id and r.audience = 'guardian' and r.status = 'draft';
  update public.intake_respondents p set superseded_at = now() where p.request_id = q.id and p.role = 'guardian' and p.superseded_at is null;
  get diagnostics v_superseded = row_count;
  insert into public.intake_guardian_invitation_requests (studio_id, request_id, client_id, recipient_email_hmac,
    recipient_email_hmac_kid, requested_by, expires_at)
  values (p_studio_id, q.id, q.client_id, p_recipient_email_hmac, p_recipient_kid, auth.uid(), now() + interval '15 minutes')
  returning id into v_id;
  select coalesce(max(i.generation), 0) + 1 into v_gen from public.intake_invitations i where i.request_id = q.id and i.audience = 'guardian';
  perform intake_private.audit_write(p_studio_id, 'guardian_invitation_requested', 'staff', auth.uid(), v_role, q.id, q.client_id,
    'intake_guardian_invitation_request', v_id, null,
    jsonb_build_object('audience', 'guardian', 'generation', v_gen, 'count', v_superseded), 'operational');
  return 'requested:' || v_id::text || ':' || v_gen::text;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Server: finalize the pending request into a guardian invitation (service_role). Copies the recipient; never an address.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.intake_guardian_finalize_invitation(p_pending_id uuid, p_invitation_id uuid, p_generation int,
  p_kid text, p_token_salt bytea, p_token_hash bytea, p_expires_at timestamptz)
returns text language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
declare
  g public.intake_guardian_invitation_requests;
  q public.intake_requests;
  v_studio uuid;
  v_client uuid;
  v_minor boolean;
  v_gen int;
  v_resp int;
  v_other int;
  v_n int;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'nsi: a guardian invitation requires READ COMMITTED (the barrier and hold checks rely on seeing every committed change)' using errcode = '55000';
  end if;
  if p_pending_id is null or p_invitation_id is null or p_generation is null or p_generation < 1 or p_kid is null or p_kid !~ '^[A-Za-z0-9_-]{8}$'
     or p_token_salt is null or octet_length(p_token_salt) <> 16 or p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'nsi: invalid invitation parameters' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at < now() + interval '1 hour' or p_expires_at > now() + interval '30 days' then
    raise exception 'nsi: invitation expiry must be between 1 hour and 30 days from now' using errcode = '22023';
  end if;
  if not intake_private.retention_gate_open() then return 'gate_closed'; end if;
  select * into g from public.intake_guardian_invitation_requests x where x.id = p_pending_id;
  if g.id is null then return 'invalid'; end if;
  v_studio := g.studio_id;
  v_client := g.client_id;
  perform intake_private.assert_drift_free(v_studio, v_client, g.request_id);
  if intake_private.erasure_barrier_active(v_studio, v_client) then return 'erasure_barrier'; end if;
  perform intake_private.lock_client(v_studio, v_client);
  select * into g from public.intake_guardian_invitation_requests x where x.id = p_pending_id for update;
  if g.id is null then
    if intake_private.erasure_barrier_active(v_studio, v_client) then return 'erasure_barrier'; end if;
    return 'invalid';
  end if;
  select * into q from public.intake_requests r where r.id = g.request_id and r.studio_id = g.studio_id for update;
  if q.id is null then return 'invalid'; end if;
  perform intake_private.assert_drift_free(q.studio_id, q.client_id, q.id);
  if intake_private.erasure_barrier_active(q.studio_id, q.client_id) then return 'erasure_barrier'; end if;
  if g.finalized_at is not null then return 'already_finalized'; end if;
  if g.superseded_at is not null then return 'superseded'; end if;
  if g.expires_at <= now() then return 'expired'; end if;
  if exists (select 1 from public.intake_invitations i where i.request_id = q.id and i.revoked_reason = 'staff_revoked' and i.revoked_at > g.requested_at) then
    return 'superseded';
  end if;
  if q.status not in ('invited', 'in_progress') or q.pinned_version_id is null then return 'not_open'; end if;
  if not intake_private.request_has_live_target(q.id) then return 'no_live_target'; end if;
  perform 1 from public.intake_responses r where r.request_id = q.id order by r.request_id, r.audience for update;
  if exists (select 1 from public.intake_responses r where r.request_id = q.id and r.audience = 'guardian' and r.status = 'submitted') then
    return 'already_submitted';
  end if;
  if q.guardian_recipient_link_id is not null then return 'recipient_link_set'; end if;
  select d.is_minor into v_minor from public.intake_minor_determinations d where d.request_id = q.id order by d.created_at desc, d.id desc limit 1;
  if v_minor is distinct from true then return 'not_minor'; end if;
  select coalesce(max(i.generation), 0) + 1 into v_gen from public.intake_invitations i where i.request_id = q.id and i.audience = 'guardian';
  if v_gen <> p_generation then
    raise exception 'nsi: generation mismatch (expected %, the request is at %); re-read the next generation and derive the token again', p_generation, v_gen using errcode = '22023';
  end if;
  -- anything that appeared between the staff request and this call is superseded again
  update public.intake_email_challenges c set superseded_at = now()
    where c.request_id = q.id and c.consumed_at is null and c.superseded_at is null;
  get diagnostics v_other = row_count;
  update public.intake_responses r set status = 'superseded' where r.request_id = q.id and r.audience = 'guardian' and r.status = 'draft';
  get diagnostics v_n = row_count;
  v_other := v_other + v_n;
  update public.intake_respondents p set superseded_at = now() where p.request_id = q.id and p.role = 'guardian' and p.superseded_at is null;
  get diagnostics v_resp = row_count;
  if v_resp + v_other > 0 then
    perform intake_private.audit_write(q.studio_id, 'guardian_invitation_requested', 'system', null, null, q.id, q.client_id,
      'intake_guardian_invitation_request', g.id, null, jsonb_build_object('audience', 'guardian', 'generation', v_gen, 'count', v_resp), 'operational');
  end if;
  update public.intake_invitations i set revoked_at = now(), revoked_reason = 'resent'
    where i.request_id = q.id and i.audience = 'guardian' and i.revoked_at is null;
  update public.intake_sessions s set revoked_at = now() where s.request_id = q.id and s.audience = 'guardian' and s.revoked_at is null;
  insert into public.intake_invitations (id, studio_id, request_id, audience, generation, kid, token_salt, token_hash, issued_by,
    issued_by_user, pinned_version_id, expires_at, recipient_email_hmac, recipient_email_hmac_kid)
  values (p_invitation_id, q.studio_id, q.id, 'guardian', v_gen, p_kid, p_token_salt, p_token_hash, 'two_party', g.requested_by,
    q.pinned_version_id, p_expires_at, g.recipient_email_hmac, g.recipient_email_hmac_kid);
  update public.intake_guardian_invitation_requests x set finalized_invitation_id = p_invitation_id, finalized_at = now() where x.id = g.id;
  perform intake_private.audit_write(q.studio_id, 'guardian_invitation_issued', 'system', null, null, q.id, q.client_id,
    'intake_invitation', p_invitation_id, null, jsonb_build_object('audience', 'guardian', 'generation', v_gen), 'operational');
  return 'issued:' || v_gen::text;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Server: the address to mail the code to. Read only; zero rows on any refusal; used only inside the issuing handler.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.intake_guardian_challenge_target(p_session_hash bytea)
returns table (email text, email_hmac_kid smallint) language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
declare
  s public.intake_sessions;
  i public.intake_invitations;
  q public.intake_requests;
begin
  if p_session_hash is null or octet_length(p_session_hash) <> 32 then return; end if;
  if not intake_private.retention_gate_open() then return; end if;
  select * into s from public.intake_sessions x where x.session_hash = p_session_hash;
  if s.id is null or s.revoked_at is not null or s.absolute_expires_at <= now() or s.idle_expires_at <= now()
     or s.audience <> 'guardian' or not intake_private.link_valid(s.invitation_id) then
    return;
  end if;
  select * into q from public.intake_requests r where r.id = s.request_id and r.studio_id = s.studio_id;
  if q.id is null or intake_private.erasure_barrier_active(q.studio_id, q.client_id) then return; end if;
  perform intake_private.assert_drift_free(q.studio_id, q.client_id, q.id);
  select * into i from public.intake_invitations x where x.id = s.invitation_id;
  return query
    select p.email, p.email_hmac_kid from public.intake_respondents p
    where p.request_id = q.id and p.studio_id = q.studio_id and p.role = 'guardian' and p.superseded_at is null and p.redacted_at is null
      and p.assurance = 'declared_unverified' and p.email is not null
      and p.email_hmac = i.recipient_email_hmac and p.email_hmac_kid = i.recipient_email_hmac_kid;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Server: issue an email challenge for the guardian session. Returns an outcome word only.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.intake_issue_email_challenge(p_session_hash bytea, p_challenge_id uuid, p_code_hash bytea,
  p_ip_bucket bytea, p_email_bucket bytea, p_send_to_email_hmac text, p_send_to_kid smallint)
returns text language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
declare
  s public.intake_sessions;
  i public.intake_invitations;
  q public.intake_requests;
  p public.intake_respondents;
  v_client uuid;
  v_bucket bytea;
  v_ok boolean;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'nsi: an email challenge requires READ COMMITTED (the barrier and hold checks rely on seeing every committed change)' using errcode = '55000';
  end if;
  if p_session_hash is null or octet_length(p_session_hash) <> 32 or p_challenge_id is null or p_code_hash is null
     or octet_length(p_code_hash) <> 32 or p_ip_bucket is null or octet_length(p_ip_bucket) <> 32 or p_email_bucket is null
     or octet_length(p_email_bucket) <> 32 then
    return 'invalid';
  end if;
  if not intake_private.retention_gate_open() then return 'gate_closed'; end if;
  select * into s from public.intake_sessions x where x.session_hash = p_session_hash;
  if s.id is null then return 'invalid'; end if;
  select r.client_id into v_client from public.intake_requests r where r.id = s.request_id and r.studio_id = s.studio_id;
  if v_client is null then return 'invalid'; end if;
  perform intake_private.lock_client(s.studio_id, v_client);
  select * into s from public.intake_sessions x where x.session_hash = p_session_hash for update;
  if s.id is null or s.revoked_at is not null or s.absolute_expires_at <= now() or s.idle_expires_at <= now()
     or s.audience <> 'guardian' or not intake_private.link_valid(s.invitation_id) then
    return 'invalid';
  end if;
  select * into q from public.intake_requests r where r.id = s.request_id and r.studio_id = s.studio_id for update;
  if q.id is null then return 'invalid'; end if;
  perform intake_private.assert_drift_free(q.studio_id, q.client_id, q.id);
  if intake_private.erasure_barrier_active(q.studio_id, q.client_id) then return 'erasure_barrier'; end if;
  select * into i from public.intake_invitations x where x.id = s.invitation_id;
  select * into p from public.intake_respondents x
   where x.request_id = q.id and x.studio_id = q.studio_id and x.role = 'guardian' and x.superseded_at is null for update;
  -- every attempt is counted, in the database, before anything is compared; over a limit nothing is compared
  v_bucket := sha256(convert_to('intake/challenge-issue/v1|' || coalesce(p.id, q.id)::text, 'UTF8'));
  v_ok := public.intake_rate_limit_hit(v_bucket, 5, 3600);
  v_ok := public.intake_rate_limit_hit(v_bucket, 20, 86400) and v_ok;
  v_ok := public.intake_rate_limit_hit(p_ip_bucket, 30, 3600) and v_ok;
  v_ok := public.intake_rate_limit_hit(p_email_bucket, 10, 3600) and v_ok;
  if not v_ok then return 'limited'; end if;
  if p.id is null or p.redacted_at is not null then return 'invalid'; end if;
  if p.assurance <> 'declared_unverified' then return 'already_done'; end if;
  if i.recipient_email_hmac is distinct from p.email_hmac or i.recipient_email_hmac_kid is distinct from p.email_hmac_kid
     or i.recipient_email_hmac is distinct from p_send_to_email_hmac or i.recipient_email_hmac_kid is distinct from p_send_to_kid then
    return 'invalid';
  end if;
  if exists (select 1 from public.intake_email_challenges c where c.id = p_challenge_id) then return 'invalid'; end if;
  -- caps counted from challenge rows, under the client lock
  if (select count(*) from public.intake_email_challenges c where c.respondent_id = p.id and c.created_at > now() - interval '60 minutes') >= 5
     or (select count(*) from public.intake_email_challenges c where c.respondent_id = p.id and c.created_at > now() - interval '24 hours') >= 10
     or (select count(*) from public.intake_email_challenges c where c.invitation_id = i.id) >= 50 then
    return 'limited';
  end if;
  update public.intake_email_challenges c set superseded_at = now()
    where c.respondent_id = p.id and c.consumed_at is null and c.superseded_at is null;
  insert into public.intake_email_challenges (id, studio_id, request_id, client_id, respondent_id, invitation_id, email_hmac,
    email_hmac_kid, code_hash, expires_at)
  values (p_challenge_id, q.studio_id, q.id, q.client_id, p.id, i.id, i.recipient_email_hmac, i.recipient_email_hmac_kid,
    p_code_hash, now() + interval '10 minutes');
  perform intake_private.audit_write(q.studio_id, 'guardian_email_challenge_issued', 'guardian', null, null, q.id, q.client_id,
    'intake_email_challenge', p_challenge_id, null, jsonb_build_object('audience', 'guardian', 'generation', i.generation), 'operational');
  return 'ok';
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Server: verify a code. The attempt is counted before the comparison and the function returns (never raises) after it.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.intake_verify_email_challenge(p_session_hash bytea, p_challenge_id uuid, p_code_hash bytea)
returns text language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
declare
  s public.intake_sessions;
  i public.intake_invitations;
  q public.intake_requests;
  p public.intake_respondents;
  c public.intake_email_challenges;
  v_client uuid;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'nsi: an email challenge requires READ COMMITTED (the barrier and hold checks rely on seeing every committed change)' using errcode = '55000';
  end if;
  if p_session_hash is null or octet_length(p_session_hash) <> 32 or p_challenge_id is null or p_code_hash is null
     or octet_length(p_code_hash) <> 32 then
    return 'invalid';
  end if;
  if not intake_private.retention_gate_open() then return 'gate_closed'; end if;
  select * into s from public.intake_sessions x where x.session_hash = p_session_hash;
  if s.id is null then return 'invalid'; end if;
  select r.client_id into v_client from public.intake_requests r where r.id = s.request_id and r.studio_id = s.studio_id;
  if v_client is null then return 'invalid'; end if;
  perform intake_private.lock_client(s.studio_id, v_client);
  select * into s from public.intake_sessions x where x.session_hash = p_session_hash for update;
  if s.id is null or s.revoked_at is not null or s.absolute_expires_at <= now() or s.idle_expires_at <= now()
     or s.audience <> 'guardian' or not intake_private.link_valid(s.invitation_id) then
    return 'invalid';
  end if;
  select * into q from public.intake_requests r where r.id = s.request_id and r.studio_id = s.studio_id for update;
  if q.id is null then return 'invalid'; end if;
  perform intake_private.assert_drift_free(q.studio_id, q.client_id, q.id);
  if intake_private.erasure_barrier_active(q.studio_id, q.client_id) then return 'erasure_barrier'; end if;
  select * into i from public.intake_invitations x where x.id = s.invitation_id;
  select * into p from public.intake_respondents x
   where x.request_id = q.id and x.studio_id = q.studio_id and x.role = 'guardian' and x.superseded_at is null for update;
  -- resolved only through this session's request, respondent and invitation: a foreign or unknown id costs nobody an attempt
  select * into c from public.intake_email_challenges x
   where x.id = p_challenge_id and x.request_id = q.id and x.studio_id = q.studio_id for update;
  if c.id is null or p.id is null or c.respondent_id <> p.id or c.invitation_id <> s.invitation_id then return 'invalid'; end if;
  if c.superseded_at is not null then return 'superseded'; end if;
  if c.expires_at <= now() then return 'expired'; end if;
  if c.consumed_at is not null then return 'invalid'; end if;
  if p.assurance <> 'declared_unverified' then return 'already_done'; end if;
  if p.redacted_at is not null or p.email_hmac is distinct from c.email_hmac or p.email_hmac_kid is distinct from c.email_hmac_kid
     or i.recipient_email_hmac is distinct from c.email_hmac or i.recipient_email_hmac_kid is distinct from c.email_hmac_kid then
    return 'invalid';
  end if;
  if c.attempts >= 5 then return 'locked'; end if;
  update public.intake_email_challenges x set attempts = x.attempts + 1 where x.id = c.id;
  if c.code_hash <> p_code_hash then return 'invalid'; end if;
  update public.intake_email_challenges x set consumed_at = now() where x.id = c.id;
  update public.intake_respondents x set assurance = 'email_code_verified', assurance_at = now() where x.id = p.id;
  perform intake_private.audit_write(q.studio_id, 'guardian_email_verified', 'guardian', null, null, q.id, q.client_id,
    'intake_respondent', p.id, null, jsonb_build_object('audience', 'guardian', 'generation', i.generation), 'operational');
  return 'ok';
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Staff issue (only change: a student re-issue ends student sessions only) and staff revoke-all (also ends open requests)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.intake_issue_invitation(p_studio_id uuid, p_request_id uuid, p_invitation_id uuid, p_generation int, p_kid text,
  p_token_salt bytea, p_token_hash bytea, p_expires_at timestamptz)
returns uuid language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
declare
  v_role text := intake_private.assert_staff(p_studio_id, 'send');
  v_client uuid;
  q public.intake_requests;
  v_ver uuid;
  v_gen int;
begin
  if p_invitation_id is null or p_generation is null or p_generation < 1 or p_kid is null or p_kid !~ '^[A-Za-z0-9_-]{8}$' or p_token_salt is null or octet_length(p_token_salt) <> 16
     or p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'nsi: invalid invitation parameters' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at < now() + interval '1 hour' or p_expires_at > now() + interval '30 days' then
    raise exception 'nsi: invitation expiry must be between 1 hour and 30 days from now' using errcode = '22023';
  end if;
  select r.client_id into v_client from public.intake_requests r where r.id = p_request_id and r.studio_id = p_studio_id;
  if v_client is null then raise exception 'nsi: unknown request' using errcode = '22023'; end if;
  perform intake_private.lock_client(p_studio_id, v_client);
  select * into q from public.intake_requests r where r.id = p_request_id and r.studio_id = p_studio_id for update;
  if q.id is null then raise exception 'nsi: unknown request' using errcode = '22023'; end if;
  if q.status not in ('pending', 'invited', 'in_progress') then
    raise exception 'nsi: the request is not open' using errcode = '22023';
  end if;
  -- everything that could make the new link unusable is checked BEFORE the previous generation is touched
  if not intake_private.request_has_live_target(q.id) then
    raise exception 'nsi: the request has no live appointment to complete intake for' using errcode = '22023';
  end if;
  if q.pinned_version_id is null then
    select v.id into v_ver from public.intake_template_versions v
    where v.studio_id = p_studio_id and v.template_id = q.template_id and v.status = 'published'
    order by v.version_number desc limit 1;
    if v_ver is null then raise exception 'nsi: the form has no published version' using errcode = '22023'; end if;
    update public.intake_requests r set pinned_version_id = v_ver where r.id = q.id;
  else
    v_ver := q.pinned_version_id;
  end if;
  select coalesce(max(i.generation), 0) + 1 into v_gen from public.intake_invitations i where i.request_id = q.id and i.audience = 'student';
  if v_gen <> p_generation then
    raise exception 'nsi: generation mismatch (expected %, the request is at %); re-read the next generation and derive the token again', p_generation, v_gen using errcode = '22023';
  end if;
  update public.intake_invitations i set revoked_at = now(), revoked_reason = 'resent'
    where i.request_id = q.id and i.audience = 'student' and i.revoked_at is null;
  update public.intake_sessions s set revoked_at = now() where s.request_id = q.id and s.audience = 'student' and s.revoked_at is null;
  insert into public.intake_invitations (id, studio_id, request_id, audience, generation, kid, token_salt, token_hash, issued_by,
                                         issued_by_user, pinned_version_id, expires_at)
  values (p_invitation_id, p_studio_id, q.id, 'student', v_gen, p_kid, p_token_salt, p_token_hash, 'staff', auth.uid(), v_ver, p_expires_at);
  if q.status = 'pending' then
    update public.intake_requests r set status = 'invited', issued_at = now() where r.id = q.id;
  end if;
  perform intake_private.audit_write(p_studio_id, 'invitation_issued', 'staff', auth.uid(), v_role, q.id, q.client_id, 'intake_invitation',
    p_invitation_id, null, jsonb_build_object('generation', v_gen, 'audience', 'student'), 'operational');
  return p_invitation_id;
end $$;

create or replace function public.intake_revoke_invitations(p_studio_id uuid, p_request_id uuid)
returns int language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
declare
  v_role text := intake_private.assert_staff(p_studio_id, 'send');
  v_client uuid;
  v_n int;
  v_p int;
begin
  select r.client_id into v_client from public.intake_requests r where r.id = p_request_id and r.studio_id = p_studio_id;
  if v_client is null then raise exception 'nsi: unknown request' using errcode = '22023'; end if;
  perform intake_private.lock_client(p_studio_id, v_client);
  perform 1 from public.intake_invitations i where i.request_id = p_request_id and i.revoked_at is null order by i.id for update;
  update public.intake_invitations i set revoked_at = now(), revoked_reason = 'staff_revoked'
    where i.request_id = p_request_id and i.revoked_at is null;
  get diagnostics v_n = row_count;
  -- stop everything also ends an open guardian invitation request, so it cannot be finalized afterwards
  update public.intake_guardian_invitation_requests g set superseded_at = now()
    where g.request_id = p_request_id and g.studio_id = p_studio_id and g.finalized_at is null and g.superseded_at is null;
  get diagnostics v_p = row_count;
  update public.intake_sessions s set revoked_at = now() where s.request_id = p_request_id and s.revoked_at is null;
  if v_n > 0 or v_p > 0 then
    perform intake_private.audit_write(p_studio_id, 'invitation_revoked', 'staff', auth.uid(), v_role, p_request_id, v_client, 'intake_request',
      p_request_id, null, jsonb_build_object('count', v_n), 'operational');
  end if;
  return v_n;
end $$;

revoke all on function public.intake_guardian_request_invitation(uuid, uuid, text, smallint) from public, anon, authenticated, service_role, intake_destructive;
grant execute on function public.intake_guardian_request_invitation(uuid, uuid, text, smallint) to authenticated;
revoke all on function public.intake_guardian_finalize_invitation(uuid, uuid, int, text, bytea, bytea, timestamptz) from public, anon, authenticated, service_role, intake_destructive;
grant execute on function public.intake_guardian_finalize_invitation(uuid, uuid, int, text, bytea, bytea, timestamptz) to service_role;
revoke all on function public.intake_guardian_challenge_target(bytea) from public, anon, authenticated, service_role, intake_destructive;
grant execute on function public.intake_guardian_challenge_target(bytea) to service_role;
revoke all on function public.intake_issue_email_challenge(bytea, uuid, bytea, bytea, bytea, text, smallint) from public, anon, authenticated, service_role, intake_destructive;
grant execute on function public.intake_issue_email_challenge(bytea, uuid, bytea, bytea, bytea, text, smallint) to service_role;
revoke all on function public.intake_verify_email_challenge(bytea, uuid, bytea) from public, anon, authenticated, service_role, intake_destructive;
grant execute on function public.intake_verify_email_challenge(bytea, uuid, bytea) to service_role;
revoke all on function intake_private.guardian_requests_insert_guard() from public, anon, authenticated, service_role, intake_destructive;
revoke all on function intake_private.guardian_requests_update_guard() from public, anon, authenticated, service_role, intake_destructive;
revoke all on function intake_private.challenges_insert_guard() from public, anon, authenticated, service_role, intake_destructive;
revoke all on function intake_private.challenges_update_guard() from public, anon, authenticated, service_role, intake_destructive;

-- ---------------------------------------------------------------------------------------------------------------
-- Erase and purge (replaced, restricted role): challenges and pending requests go before the rows they reference.
-- ---------------------------------------------------------------------------------------------------------------
grant create on schema intake_private to intake_destructive;
set local role intake_destructive;
create or replace function intake_private.erase_client_impl(p_studio_id uuid, p_client_id uuid, p_actor uuid,
  p_reason_code text, p_drift boolean, p_case_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
declare
  v_counts jsonb := '{}'::jsonb;
  v_n int;
begin
  if current_user <> 'intake_destructive' then
    raise exception 'nsi: erasure implementation must run as the restricted role' using errcode = '42501';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'nsi: erasure requires READ COMMITTED (the hold checks rely on seeing every committed hold)' using errcode = '55000';
  end if;
  if intake_private.client_has_active_hold(p_studio_id, p_client_id) then
    perform intake_private.audit_write(p_studio_id, 'erasure_refused_hold', 'platform_admin', p_actor, 'platform_admin', null,
      p_client_id, null, null, null, jsonb_strip_nulls(jsonb_build_object('reason_code', p_reason_code, 'case_ref', p_case_ref)),
      'erasure_record');
    return jsonb_build_object('outcome', 'refused', 'refused', 'legal_hold');
  end if;
  delete from public.intake_completions where studio_id = p_studio_id and client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('completions', v_n);
  delete from public.intake_response_revisions rv using public.intake_responses r
    where rv.response_id = r.id and r.studio_id = p_studio_id and r.client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('revisions', v_n);
  delete from public.intake_responses where studio_id = p_studio_id and client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('responses', v_n);
  delete from public.intake_email_challenges where studio_id = p_studio_id and client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('email_challenges', v_n);
  delete from public.intake_guardian_invitation_requests where studio_id = p_studio_id and client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invitation_requests', v_n);
  delete from public.intake_guardian_attestations where studio_id = p_studio_id and client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('attestations', v_n);
  delete from public.intake_respondents where studio_id = p_studio_id and client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('respondents', v_n);
  delete from public.intake_minor_determinations md using public.intake_requests q
    where md.request_id = q.id and q.studio_id = p_studio_id and q.client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('minor_determinations', v_n);
  delete from public.intake_request_appointments ra using public.intake_requests q
    where ra.request_id = q.id and q.studio_id = p_studio_id and q.client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('request_appointments', v_n);
  delete from public.intake_sessions s using public.intake_requests q
    where s.request_id = q.id and q.studio_id = p_studio_id and q.client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('sessions', v_n);
  delete from public.intake_invitations i using public.intake_requests q
    where i.request_id = q.id and q.studio_id = p_studio_id and q.client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invitations', v_n);
  delete from public.intake_requests where studio_id = p_studio_id and client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('requests', v_n);
  delete from public.intake_guardian_designations where studio_id = p_studio_id and client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('designations', v_n);
  delete from public.intake_client_relationship_state where studio_id = p_studio_id and client_id = p_client_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('relationship_state', v_n);
  perform intake_private.audit_write(p_studio_id, 'erasure_record', 'platform_admin', p_actor, 'platform_admin', null,
    p_client_id, null, null, null,
    jsonb_strip_nulls(jsonb_build_object('counts', v_counts, 'drift', p_drift, 'reason_code', p_reason_code, 'case_ref', p_case_ref)),
    'erasure_record');
  return v_counts || jsonb_build_object('outcome', 'erased');
end $$;
create or replace function intake_private.purge_expired_impl(p_limit int)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m16b
declare
  -- Advisory transaction locks are taken for at most this many distinct clients per call (far below max_locks_per_transaction).
  c_max_clients constant int := 50;
  v_keys text[];
  v_locked text[];
  v_s int; v_r int; v_i int; v_c int; v_g int;
begin
  if current_user <> 'intake_destructive' then
    raise exception 'nsi: purge must run as the restricted role' using errcode = '42501';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'nsi: the purge requires READ COMMITTED (the hold checks rely on seeing every committed hold)' using errcode = '55000';
  end if;
  -- 1. bounded candidate clients (reads only): held clients are excluded here with the SAME predicate (the definer function; the restricted role has no table privilege on the holds) as the delete-time check, so they
  --    never consume the window; ordered by the oldest eligible-since per client, then by key
  select coalesce(array_agg(x.k order by x.since, x.k), '{}') into v_keys from (
    select c.k, min(c.since) as since from (
      select s.studio_id::text || ':' || q.client_id::text as k, s.studio_id as sid, q.client_id as cid,
             least(s.absolute_expires_at, coalesce(s.revoked_at, 'infinity'::timestamptz)) + interval '24 hours' as since
        from public.intake_sessions s join public.intake_requests q on q.id = s.request_id
       where s.absolute_expires_at < now() - interval '24 hours' or s.revoked_at < now() - interval '24 hours'
      union all
      select i.studio_id::text || ':' || q.client_id::text, i.studio_id, q.client_id, i.expires_at + interval '90 days'
        from public.intake_invitations i join public.intake_requests q on q.id = i.request_id
       where i.expires_at < now() - interval '90 days'
         and not exists (select 1 from public.intake_sessions s2 where s2.invitation_id = i.id)
         and not exists (select 1 from public.intake_email_challenges ch where ch.invitation_id = i.id)
         and not exists (select 1 from public.intake_guardian_invitation_requests g2 where g2.finalized_invitation_id = i.id)
      union all
      select ch.studio_id::text || ':' || ch.client_id::text, ch.studio_id, ch.client_id,
             greatest(ch.expires_at, least(i.expires_at, coalesce(i.revoked_at, 'infinity'::timestamptz))) + interval '24 hours'
        from public.intake_email_challenges ch join public.intake_invitations i on i.id = ch.invitation_id
       where ch.consumed_at is null and ch.expires_at < now() - interval '24 hours'
         and (i.expires_at < now() - interval '24 hours' or i.revoked_at < now() - interval '24 hours')
      union all
      select g.studio_id::text || ':' || g.client_id::text, g.studio_id, g.client_id, g.expires_at
        from public.intake_guardian_invitation_requests g
       where g.finalized_at is null and g.expires_at < now()
      union all
      select g.studio_id::text || ':' || g.client_id::text, g.studio_id, g.client_id, i.expires_at + interval '90 days'
        from public.intake_guardian_invitation_requests g join public.intake_invitations i on i.id = g.finalized_invitation_id
       where i.expires_at < now() - interval '90 days'
         and not exists (select 1 from public.intake_email_challenges ch where ch.invitation_id = i.id)
    ) c
    where not intake_private.client_has_active_hold(c.sid, c.cid)
    group by c.k order by min(c.since), c.k limit c_max_clients) x;
  -- 2. non-waiting client locks, all in this one statement (a client whose lock a writer holds is skipped)
  select coalesce(array_agg(k.k), '{}') into v_locked from unnest(v_keys) as k(k)
   where intake_private.try_lock_client(split_part(k.k, ':', 1)::uuid, split_part(k.k, ':', 2)::uuid);
  -- 3. deletes in LATER statements, ordered like the candidates (eligible time, then id); the hold check is repeated here (race protection)
  -- challenges first, then pending requests: both reference invitations (restrict), which are deleted last
  delete from public.intake_email_challenges d where d.id in (
    select x.id from public.intake_email_challenges x join public.intake_invitations i on i.id = x.invitation_id
    where x.consumed_at is null and x.expires_at < now() - interval '24 hours'
         and (i.expires_at < now() - interval '24 hours' or i.revoked_at < now() - interval '24 hours')
      and (x.studio_id::text || ':' || x.client_id::text) = any (v_locked)
      and not intake_private.client_has_active_hold(x.studio_id, x.client_id)
    order by x.expires_at, x.id limit p_limit);
  get diagnostics v_c = row_count;
  delete from public.intake_guardian_invitation_requests d where d.id in (
    select x.id from public.intake_guardian_invitation_requests x
    where ((x.finalized_at is null and x.expires_at < now())
           or exists (select 1 from public.intake_invitations i where i.id = x.finalized_invitation_id and i.expires_at < now() - interval '90 days'
                      and not exists (select 1 from public.intake_email_challenges ch where ch.invitation_id = i.id)))
      and (x.studio_id::text || ':' || x.client_id::text) = any (v_locked)
      and not intake_private.client_has_active_hold(x.studio_id, x.client_id)
    order by x.expires_at, x.id limit p_limit);
  get diagnostics v_g = row_count;
  delete from public.intake_sessions s where s.id in (
    select x.id from public.intake_sessions x join public.intake_requests q on q.id = x.request_id
    where (x.absolute_expires_at < now() - interval '24 hours' or x.revoked_at < now() - interval '24 hours')
      and (x.studio_id::text || ':' || q.client_id::text) = any (v_locked)
      and not intake_private.client_has_active_hold(x.studio_id, q.client_id)
    order by least(x.absolute_expires_at, coalesce(x.revoked_at, 'infinity'::timestamptz)), x.id limit p_limit);
  get diagnostics v_s = row_count;
  delete from public.intake_rate_limits l where (l.bucket_hash, l.window_seconds, l.window_start) in (
    select x.bucket_hash, x.window_seconds, x.window_start from public.intake_rate_limits x
    where x.window_start < now() - interval '24 hours' order by x.bucket_hash, x.window_seconds, x.window_start limit p_limit);
  get diagnostics v_r = row_count;
  delete from public.intake_invitations i where i.id in (
    select x.id from public.intake_invitations x join public.intake_requests q on q.id = x.request_id
    where x.expires_at < now() - interval '90 days'
      and not exists (select 1 from public.intake_sessions s2 where s2.invitation_id = x.id)
         and not exists (select 1 from public.intake_email_challenges ch where ch.invitation_id = x.id)
         and not exists (select 1 from public.intake_guardian_invitation_requests g2 where g2.finalized_invitation_id = x.id)
      and (x.studio_id::text || ':' || q.client_id::text) = any (v_locked)
      and not intake_private.client_has_active_hold(x.studio_id, q.client_id)
    order by x.expires_at, x.id limit p_limit);
  get diagnostics v_i = row_count;
  return jsonb_build_object('sessions', v_s, 'rate_limits', v_r, 'invitations', v_i, 'challenges', v_c, 'invitation_requests', v_g,
                            'clients_candidate', cardinality(v_keys), 'clients_locked', cardinality(v_locked));
end $$;
revoke all on function intake_private.erase_client_impl(uuid, uuid, uuid, text, boolean, text) from public, anon, authenticated, service_role;
grant execute on function intake_private.erase_client_impl(uuid, uuid, uuid, text, boolean, text) to postgres;
revoke all on function intake_private.purge_expired_impl(int) from public, anon, authenticated, service_role;
grant execute on function intake_private.purge_expired_impl(int) to postgres;
reset role;
revoke create on schema intake_private from intake_destructive;


select intake_private.assert_catalog();

commit;

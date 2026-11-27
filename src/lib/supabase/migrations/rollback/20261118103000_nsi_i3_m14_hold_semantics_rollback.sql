-- Rollback for NSI I3-1 (M14). Restores, byte for byte: M2 is_held and client_has_active_hold, M3 delete_guard, M5 lock_client, intake_erase_client and
-- intake_create_legal_hold, M12 try_lock_client and erase_client_impl, M13 purge_expired_impl, intake_revoke_session and assert_catalog; drops the hold-insert
-- trigger and function. REFUSED when the retention gate is open, when ANY hold row exists (active or released: the restored predicate is weaker), or when an
-- M15 object exists. Run before any rollback of M13.
begin;
set local lock_timeout = '5s';
lock table public.intake_legal_holds in access exclusive mode;
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'intake_private' and p.proname = 'purge_expired_impl' and position('nsi-body:m14' in p.prosrc) > 0) then
    raise exception 'nsi rollback M14 refused: the purge implementation is not at the M14 level' using errcode = '55000';
  end if;
  if intake_private.retention_gate_open() then
    raise exception 'nsi rollback M14 refused: the retention gate is open' using errcode = '55000';
  end if;
  if exists (select 1 from public.intake_legal_holds) then
    raise exception 'nsi rollback M14 refused: legal hold rows exist (the restored hold predicate is weaker)' using errcode = '55000';
  end if;
  if to_regprocedure('public.intake_determine_minor_from_birthday(uuid,uuid)') is not null then
    raise exception 'nsi rollback M14 refused: a later NSI migration (M15 or newer) is applied' using errcode = '55000';
  end if;
end $$;

drop trigger if exists intake_legal_holds_05_lock on public.intake_legal_holds;
create or replace function intake_private.client_has_active_hold(p_studio_id uuid, p_client_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from public.intake_legal_holds h
                 where h.studio_id = p_studio_id and h.client_ref = p_client_id
                   and h.released_at is null and h.effective_at <= now());
$$;

create or replace function intake_private.is_held(p_studio_id uuid, p_client_id uuid, p_request_id uuid,
  p_response_id uuid, p_evidence_id uuid, p_envelope_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1 from public.intake_legal_holds h
    where h.studio_id = p_studio_id and h.released_at is null and h.effective_at <= now()
      and ((h.scope_type = 'client' and h.scope_ref = p_client_id)
        or (h.scope_type = 'request' and h.scope_ref = p_request_id)
        or (h.scope_type = 'response' and h.scope_ref = p_response_id)
        or (h.scope_type = 'evidence' and h.scope_ref = p_evidence_id)
        or (h.scope_type = 'envelope' and h.scope_ref = p_envelope_id)));
$$;

create or replace function intake_private.lock_client(p_studio_id uuid, p_client_id uuid)
returns void language sql volatile
set search_path = pg_catalog, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('intake:client:' || p_studio_id::text || ':' || p_client_id::text, 0));
$$;

create or replace function intake_private.try_lock_client(p_studio_id uuid, p_client_id uuid)
returns boolean language sql volatile
set search_path = pg_catalog, pg_temp
as $$
  select pg_try_advisory_xact_lock(hashtextextended('intake:client:' || p_studio_id::text || ':' || p_client_id::text, 0));
$$;

create or replace function intake_private.delete_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row jsonb := to_jsonb(old);
  v_studio uuid := (v_row ->> 'studio_id')::uuid;
  v_client uuid := (v_row ->> 'client_id')::uuid;
begin
  if current_user <> 'intake_destructive' then
    raise exception 'nsi: protected change refused for %', current_user using errcode = '42501';
  end if;
  if v_client is null then
    v_client := intake_private.subject_of(tg_table_name, (v_row ->> 'request_id')::uuid, (v_row ->> 'response_id')::uuid);
  end if;
  if v_client is not null and intake_private.client_has_active_hold(v_studio, v_client) then
    raise exception 'nsi: subject is under an active legal hold' using errcode = '42501';
  end if;
  return old;
end $$;

create or replace function public.intake_erase_client(p_studio_id uuid, p_client_id uuid, p_reason_code text,
  p_case_ref text default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_drift boolean;
  v_result jsonb;
begin
  perform intake_private.assert_staff(p_studio_id, 'erasure');
  if p_studio_id is null or not exists (select 1 from public.studios s where s.id = p_studio_id) then
    raise exception 'nsi: unknown studio' using errcode = '22023';
  end if;
  if p_reason_code is null or p_reason_code not in ('data_subject_request', 'guardian_request', 'studio_request', 'legal_requirement', 'other') then
    raise exception 'nsi: reason code required (data_subject_request, guardian_request, studio_request, legal_requirement, other)' using errcode = '22023';
  end if;
  if p_case_ref is not null and p_case_ref !~ '^[A-Z]{2,10}-[0-9]{1,12}$' then
    raise exception 'nsi: case reference must be a ticket identifier like SUP-1234 (^[A-Z]{2,10}-[0-9]{1,12}$)' using errcode = '22023';
  end if;
  if p_client_id is null or (not exists (select 1 from public.clients c where c.id = p_client_id)
                             and not intake_private.has_intake_records(p_studio_id, p_client_id)) then
    raise exception 'nsi: unknown client' using errcode = '22023';
  end if;
  -- A17: scope is the intake rows' own studio; drift never blocks erasure (recorded instead).
  v_drift := not exists (select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id);
  -- Locks in canonical order (L1 -> L2 -> L3 -> L4 -> L5); the implementation then deletes.
  perform intake_private.lock_client(p_studio_id, p_client_id);
  if not intake_private.retention_gate_open() and not intake_private.has_intake_records(p_studio_id, p_client_id) then
    return jsonb_build_object('outcome', 'no_records', 'erased', false, 'reason', 'no_records', 'drift', v_drift);
  end if;
  perform 1 from public.intake_client_relationship_state s where s.studio_id = p_studio_id and s.client_id = p_client_id for update;
  perform 1 from public.intake_requests q where q.studio_id = p_studio_id and q.client_id = p_client_id order by q.id for update;
  perform 1 from public.intake_responses r where r.studio_id = p_studio_id and r.client_id = p_client_id order by r.request_id, r.audience for update;
  perform 1 from public.intake_guardian_designations d where d.studio_id = p_studio_id and d.client_id = p_client_id and d.superseded_at is null for update;
  v_result := intake_private.erase_client_impl(p_studio_id, p_client_id, v_actor, p_reason_code, v_drift, p_case_ref);
  return v_result || jsonb_build_object('drift', v_drift);
end $$;

create or replace function public.intake_create_legal_hold(p_studio_id uuid, p_scope_type text, p_scope_ref uuid,
  p_reason text, p_retention_basis text, p_review_due_at timestamptz, p_external_reference text default null)
returns uuid language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_client uuid;
  v_id uuid;
begin
  perform intake_private.assert_staff(p_studio_id, 'hold_admin');
  v_client := case p_scope_type
    when 'client' then (select c.id from public.clients c where c.id = p_scope_ref and c.studio_id = p_studio_id)
    when 'request' then (select q.client_id from public.intake_requests q where q.id = p_scope_ref and q.studio_id = p_studio_id)
    when 'response' then (select r.client_id from public.intake_responses r where r.id = p_scope_ref and r.studio_id = p_studio_id)
    when 'evidence' then (select e.client_ref from public.intake_consent_evidence e where e.id = p_scope_ref and e.studio_id = p_studio_id)
    when 'envelope' then (select e.client_id from public.document_sign_envelopes e where e.id = p_scope_ref and e.studio_id = p_studio_id)
    else null end;
  if v_client is null then
    raise exception 'nsi: hold scope not found in this studio' using errcode = '42501';
  end if;
  perform intake_private.lock_client(p_studio_id, v_client);
  if p_scope_type = 'client' and intake_private.erasure_barrier_active(p_studio_id, v_client) then
    raise exception 'nsi: client has been erased; a client-level hold cannot be created' using errcode = '22023';
  end if;
  if not intake_private.retention_gate_open() and not intake_private.has_intake_records(p_studio_id, v_client) then
    raise exception 'nsi: legal hold not applicable: no intake records exist for this subject while collection is closed' using errcode = '22023';
  end if;
  insert into public.intake_legal_holds (studio_id, scope_type, scope_ref, client_ref, reason, retention_basis,
    external_reference, review_due_at, created_by)
  values (p_studio_id, p_scope_type, p_scope_ref, v_client, p_reason, p_retention_basis, p_external_reference, p_review_due_at, auth.uid())
  returning id into v_id;
  perform intake_private.audit_write(p_studio_id, 'legal_hold_created', 'platform_admin', auth.uid(), 'platform_admin', null,
    v_client, 'intake_legal_hold', v_id, v_id, jsonb_build_object('scope_type', p_scope_type), 'legal_hold');
  return v_id;
end $$;

create or replace function public.intake_revoke_session(p_session_hash bytea)
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m13
declare s public.intake_sessions;
begin
  if p_session_hash is null or octet_length(p_session_hash) <> 32 then return; end if;
  select * into s from public.intake_sessions x where x.session_hash = p_session_hash for update;
  if s.id is null or s.revoked_at is not null then return; end if;
  update public.intake_sessions x set revoked_at = now() where x.id = s.id;
  perform intake_private.audit_write(s.studio_id, 'session_revoked', 'system', null, null, s.request_id, null, 'intake_session', s.id, null,
    jsonb_build_object('audience', s.audience), 'operational');
end $$;

grant create on schema intake_private to intake_destructive;
set local role intake_destructive;
create or replace function intake_private.erase_client_impl(p_studio_id uuid, p_client_id uuid, p_actor uuid,
  p_reason_code text, p_drift boolean, p_case_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m12
declare
  v_counts jsonb := '{}'::jsonb;
  v_n int;
begin
  if current_user <> 'intake_destructive' then
    raise exception 'nsi: erasure implementation must run as the restricted role' using errcode = '42501';
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
-- nsi-body:m13
declare
  -- Advisory transaction locks are taken for at most this many distinct clients per call: far below max_locks_per_transaction
  -- (default 64 per allowed connection slot), so a purge can never exhaust the shared lock table.
  c_max_clients constant int := 50;
  v_keys text[];
  v_locked text[];
  v_s int; v_r int; v_i int;
begin
  if current_user <> 'intake_destructive' then
    raise exception 'nsi: purge must run as the restricted role' using errcode = '42501';
  end if;
  -- 1. bounded candidate clients (reads only: no locks, no deletes)
  select coalesce(array_agg(x.k), '{}') into v_keys from (
    select distinct c.k from (
      select s.studio_id::text || ':' || q.client_id::text as k
        from public.intake_sessions s join public.intake_requests q on q.id = s.request_id
       where s.absolute_expires_at < now() - interval '24 hours' or s.revoked_at < now() - interval '24 hours'
      union all
      select i.studio_id::text || ':' || q.client_id::text
        from public.intake_invitations i join public.intake_requests q on q.id = i.request_id
       where i.expires_at < now() - interval '90 days'
         and not exists (select 1 from public.intake_sessions s2 where s2.invitation_id = i.id)
    ) c order by c.k limit c_max_clients) x;
  -- 2. non-waiting client locks, all in this one statement (a client whose lock is held by a writer is simply skipped)
  select coalesce(array_agg(k.k), '{}') into v_locked from unnest(v_keys) as k(k)
   where intake_private.try_lock_client(split_part(k.k, ':', 1)::uuid, split_part(k.k, ':', 2)::uuid);
  -- 3. deletes: the legal-hold check runs in these LATER statements (fresh snapshot), only for clients whose lock this call holds
  delete from public.intake_sessions s where s.id in (
    select x.id from public.intake_sessions x join public.intake_requests q on q.id = x.request_id
    where (x.absolute_expires_at < now() - interval '24 hours' or x.revoked_at < now() - interval '24 hours')
      and (x.studio_id::text || ':' || q.client_id::text) = any (v_locked)
      and not intake_private.client_has_active_hold(x.studio_id, q.client_id)
    order by x.id limit p_limit);
  get diagnostics v_s = row_count;
  delete from public.intake_rate_limits l where (l.bucket_hash, l.window_seconds, l.window_start) in (
    select x.bucket_hash, x.window_seconds, x.window_start from public.intake_rate_limits x
    where x.window_start < now() - interval '24 hours' order by x.bucket_hash, x.window_seconds, x.window_start limit p_limit);
  get diagnostics v_r = row_count;
  delete from public.intake_invitations i where i.id in (
    select x.id from public.intake_invitations x join public.intake_requests q on q.id = x.request_id
    where x.expires_at < now() - interval '90 days'
      and not exists (select 1 from public.intake_sessions s2 where s2.invitation_id = x.id)
      and (x.studio_id::text || ':' || q.client_id::text) = any (v_locked)
      and not intake_private.client_has_active_hold(x.studio_id, q.client_id)
    order by x.id limit p_limit);
  get diagnostics v_i = row_count;
  return jsonb_build_object('sessions', v_s, 'rate_limits', v_r, 'invitations', v_i,
                            'clients_candidate', cardinality(v_keys), 'clients_locked', cardinality(v_locked));
end $$;
revoke all on function intake_private.erase_client_impl(uuid, uuid, uuid, text, boolean, text) from public, anon, authenticated, service_role;
grant execute on function intake_private.erase_client_impl(uuid, uuid, uuid, text, boolean, text) to postgres;
revoke all on function intake_private.purge_expired_impl(int) from public, anon, authenticated, service_role;
grant execute on function intake_private.purge_expired_impl(int) to postgres;
reset role;
revoke create on schema intake_private from intake_destructive;

drop function if exists intake_private.legal_hold_insert_guard();

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
    'intake_rate_limits|10|intake_destructive:DELETE,intake_destructive:SELECT'];
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
    'public.intake_revoke_invitations|10|authenticated|t',
    'public.intake_revoke_all_invitations_for_key|10|service_role|t',
    'public.intake_rate_limit_hit|10|service_role|t',
    'public.intake_exchange_invitation|10|service_role|t',
    'public.intake_session_context|10|service_role|t',
    'public.intake_revoke_session|10|service_role|t',
    'intake_private.purge_expired_impl|10|postgres|t',
    'public.intake_purge_expired|10|service_role|t'];
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
    'intake_rate_limits|intake_rate_limits_no_truncate|refuse_truncate|10|BEFORE TRUNCATE|STATEMENT|'];
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
    'intake_private.erase_client_impl|nsi-body:m12|10',
    'public.intake_issue_invitation|nsi-body:m12|10',
    'intake_private.purge_expired_impl|nsi-body:m13|10',
    'public.intake_revoke_session|nsi-body:m13|10'
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
  if current_setting('server_version_num')::int >= 170000 then
    v_table_privs := v_table_privs || 'MAINTAIN'::text;
  end if;

  -- ----- which migrations are present (each must be complete; present migrations must be M1..Mk) -------------------
  for v_m in 1 .. 10 loop
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

select intake_private.assert_catalog();

commit;

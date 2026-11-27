-- New Student Intake (NSI) I1 -- M5 of 5: callable functions (staff RPCs, service RPCs, erasure, holds).
--
-- Creates
--   internal  intake_private.lock_client, schema_max_answer_bytes, validate_answers, appointment_snapshot,
--             compute_draft_retention, has_intake_records, drift_detected, assert_drift_free
--   staff     public.intake_save_template_draft, intake_publish_template_version, intake_set_reintake_floor,
--             intake_set_service_assignment, intake_update_settings, intake_set_retention_choice, intake_get_status,
--             intake_get_answers, intake_designate_guardian, intake_select_guardian_recipient,
--             intake_record_minor_determination, intake_drift_report, intake_extend_draft_retention
--   service   public.intake_ensure_request, intake_save_draft, intake_submit_response
--   operator  public.intake_erase_client + intake_private.erase_client_impl (created AS intake_destructive),
--             public.intake_release_erasure_barrier, intake_create_legal_hold, intake_release_legal_hold
-- Depends on: M1-M4.
-- Authorization: staff RPCs call intake_private.assert_staff(p_studio_id, capability) (V1 baseline); operator RPCs
--   require profiles.platform_role = 'platform_admin' and take the actor from auth.uid() (no actor parameter);
--   service RPCs are service_role only and validate every argument against rows.
-- Locks (schema plan §8.1): L1 per-client advisory lock first, then relationship state, requests (by id), responses
--   (by request_id, audience), designations, holds. Template publish uses only the template row.
-- Ships dark: with the platform retention periods NULL every personal-data writer refuses (Gate A).
-- Privileges (R25): M5's own functions revoked from PUBLIC/anon/authenticated/service_role, then class grants;
--   assert_catalog() runs last.
-- Rollback: rollback/20261118094000_nsi_i1_m5_functions_rollback.sql (guarded; drops role-owned objects as the role).

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------------------------
create or replace function intake_private.lock_client(p_studio_id uuid, p_client_id uuid)
returns void language sql volatile
set search_path = pg_catalog, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('intake:client:' || p_studio_id::text || ':' || p_client_id::text, 0));
$$;

-- Validates a template schema and returns its worst-case answer size in bytes (UTF-8 at 4 bytes per character).
create or replace function intake_private.schema_max_answer_bytes(p_schema jsonb)
returns int language plpgsql immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_section jsonb;
  v_field jsonb;
  v_opt jsonb;
  v_keys text[] := '{}';
  v_total bigint := 2;
  v_fields int := 0;
  v_type text;
  v_key text;
  v_opt_keys text[];
  v_max_opt int;
begin
  if jsonb_typeof(p_schema -> 'sections') <> 'array' or jsonb_array_length(p_schema -> 'sections') = 0 then
    raise exception 'nsi: schema must contain a non-empty sections array' using errcode = '22023';
  end if;
  for v_section in select * from jsonb_array_elements(p_schema -> 'sections') loop
    if coalesce(v_section ->> 'audience', '') not in ('student', 'guardian', 'both') then
      raise exception 'nsi: section audience must be student, guardian or both' using errcode = '22023';
    end if;
    if char_length(coalesce(v_section ->> 'title', '')) > 500 then
      raise exception 'nsi: section title too long' using errcode = '22023';
    end if;
    if jsonb_typeof(v_section -> 'fields') <> 'array' then
      raise exception 'nsi: section fields must be an array' using errcode = '22023';
    end if;
    for v_field in select * from jsonb_array_elements(v_section -> 'fields') loop
      v_fields := v_fields + 1;
      v_key := v_field ->> 'key';
      v_type := v_field ->> 'type';
      if v_key is null or v_key !~ '^[a-z][a-z0-9_]{0,63}$' or v_key = any (v_keys) then
        raise exception 'nsi: field key missing, invalid or duplicated: %', coalesce(v_key, '<null>') using errcode = '22023';
      end if;
      v_keys := v_keys || v_key;
      if v_type is null or v_type not in ('short_text', 'long_text', 'single_choice', 'checkboxes', 'dropdown', 'yes_no', 'date', 'acknowledgment') then
        raise exception 'nsi: field % has an unsupported type', v_key using errcode = '22023';
      end if;
      if coalesce(v_field ->> 'visibility', '') not in ('staff_only', 'front_desk', 'instructor_visible') then
        raise exception 'nsi: field % needs visibility staff_only, front_desk or instructor_visible', v_key using errcode = '22023';
      end if;
      if coalesce(v_field ->> 'subject_scope', '') not in ('about_student', 'about_guardian', 'consent') then
        raise exception 'nsi: field % needs subject_scope about_student, about_guardian or consent', v_key using errcode = '22023';
      end if;
      if char_length(coalesce(v_field ->> 'label', '')) not between 1 and 500 then
        raise exception 'nsi: field % label must be 1-500 characters', v_key using errcode = '22023';
      end if;
      v_total := v_total + 4 * char_length(v_key) + 8;
      if v_type in ('single_choice', 'checkboxes', 'dropdown') then
        if jsonb_typeof(v_field -> 'options') <> 'array' or jsonb_array_length(v_field -> 'options') not between 1 and 50 then
          raise exception 'nsi: field % needs 1-50 options', v_key using errcode = '22023';
        end if;
        v_opt_keys := '{}'; v_max_opt := 0;
        for v_opt in select * from jsonb_array_elements(v_field -> 'options') loop
          if coalesce(v_opt ->> 'key', '') !~ '^[a-z0-9][a-z0-9_]{0,63}$' or (v_opt ->> 'key') = any (v_opt_keys)
             or char_length(coalesce(v_opt ->> 'label', '')) not between 1 and 500 then
            raise exception 'nsi: field % has an invalid option', v_key using errcode = '22023';
          end if;
          v_opt_keys := v_opt_keys || (v_opt ->> 'key');
          v_max_opt := greatest(v_max_opt, char_length(v_opt ->> 'key'));
        end loop;
        v_total := v_total + case when v_type = 'checkboxes'
                                  then 2 + cardinality(v_opt_keys) * (4 * v_max_opt + 3)
                                  else 4 * v_max_opt + 2 end;
      else
        v_total := v_total + case v_type
          when 'short_text' then 4 * 500 + 2
          when 'long_text' then 4 * 5000 + 2
          when 'date' then 12
          else 5 end;
      end if;
    end loop;
  end loop;
  if v_fields = 0 or v_fields > 200 then
    raise exception 'nsi: schema must define 1-200 fields' using errcode = '22023';
  end if;
  if v_total > 262144 then
    raise exception 'nsi: worst-case answer size % bytes exceeds the 262144-byte limit', v_total using errcode = '22023';
  end if;
  return v_total::int;
end $$;

-- Validates answers for one audience against a published schema. p_require_complete enforces required fields.
create or replace function intake_private.validate_answers(p_schema jsonb, p_audience text, p_answers jsonb, p_require_complete boolean)
returns void language plpgsql immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_fields jsonb := '{}'::jsonb;
  v_section jsonb;
  v_field jsonb;
  v_key text;
  v_val jsonb;
  v_type text;
  v_opts text[];
  v_d date;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'nsi: answers must be a JSON object' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(p_answers)) > 200 then
    raise exception 'nsi: too many answers' using errcode = '22023';
  end if;
  for v_section in select * from jsonb_array_elements(p_schema -> 'sections') loop
    if v_section ->> 'audience' in (p_audience, 'both') then
      for v_field in select * from jsonb_array_elements(v_section -> 'fields') loop
        v_fields := v_fields || jsonb_build_object(v_field ->> 'key', v_field);
      end loop;
    end if;
  end loop;
  for v_key, v_val in select * from jsonb_each(p_answers) loop
    v_field := v_fields -> v_key;
    if v_field is null then
      raise exception 'nsi: unknown answer key %', v_key using errcode = '22023';
    end if;
    v_type := v_field ->> 'type';
    select coalesce(array_agg(o ->> 'key'), '{}') into v_opts from jsonb_array_elements(coalesce(v_field -> 'options', '[]')) o;
    if v_type = 'short_text' and not (jsonb_typeof(v_val) = 'string' and char_length(v_val #>> '{}') <= 500) then
      raise exception 'nsi: answer % must be text of at most 500 characters', v_key using errcode = '22023';
    elsif v_type = 'long_text' and not (jsonb_typeof(v_val) = 'string' and char_length(v_val #>> '{}') <= 5000) then
      raise exception 'nsi: answer % must be text of at most 5000 characters', v_key using errcode = '22023';
    elsif v_type in ('single_choice', 'dropdown') and not (jsonb_typeof(v_val) = 'string' and (v_val #>> '{}') = any (v_opts)) then
      raise exception 'nsi: answer % must be one of the defined options', v_key using errcode = '22023';
    elsif v_type = 'checkboxes' and not (jsonb_typeof(v_val) = 'array' and jsonb_array_length(v_val) <= 50
           and not exists (select 1 from jsonb_array_elements(v_val) e
                           where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any (v_opts)))
           and (select count(distinct e #>> '{}') from jsonb_array_elements(v_val) e) = jsonb_array_length(v_val)) then
      raise exception 'nsi: answer % must be a list of distinct defined options', v_key using errcode = '22023';
    elsif v_type in ('yes_no', 'acknowledgment') and jsonb_typeof(v_val) <> 'boolean' then
      raise exception 'nsi: answer % must be true or false', v_key using errcode = '22023';
    elsif v_type = 'date' then
      if jsonb_typeof(v_val) <> 'string' or (v_val #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'nsi: answer % must be an ISO date', v_key using errcode = '22023';
      end if;
      begin
        v_d := (v_val #>> '{}')::date;
      exception when others then
        raise exception 'nsi: answer % must be a valid date', v_key using errcode = '22023';
      end;
    end if;
  end loop;
  if p_require_complete then
    for v_key, v_field in select * from jsonb_each(v_fields) loop
      if coalesce((v_field ->> 'required')::boolean, false) and (p_answers -> v_key is null
         or (v_field ->> 'type' = 'acknowledgment' and p_answers -> v_key <> 'true'::jsonb)) then
        raise exception 'nsi: required answer % is missing', v_key using errcode = '22023';
      end if;
    end loop;
  end if;
end $$;

-- Soft appointment read (no FK, no trigger on appointments): returns NULL fields when not found in this studio/client.
create or replace function intake_private.appointment_snapshot(p_studio_id uuid, p_client_id uuid, p_appointment_id uuid,
  out appointment_type text, out status text, out starts_at timestamptz, out ends_at timestamptz,
  out cancelled_at timestamptz, out created_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select a.appointment_type::text, a.status::text, a.starts_at, a.ends_at, a.cancelled_at, a.created_at
  from public.appointments a
  where a.id = p_appointment_id and a.studio_id = p_studio_id and a.client_id = p_client_id;
$$;

-- Draft retention (approved rule): purge = least(anchor + 90d, greatest(first_save + 180d, protected_until)).
create or replace function intake_private.compute_draft_retention(p_request_id uuid)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  q public.intake_requests;
  v_policy record;
  a record;
  v_anchor_at timestamptz;
  v_kind text;
begin
  select * into q from public.intake_requests r where r.id = p_request_id for update;
  select * into v_policy from public.intake_platform_policy();
  select * into a from intake_private.appointment_snapshot(q.studio_id, q.client_id, coalesce(q.draft_anchor_appointment_id, q.anchor_appointment_id));
  if a.status = 'cancelled' then
    v_kind := 'appointment_cancelled'; v_anchor_at := coalesce(a.cancelled_at, now());
  elsif a.ends_at is not null then
    v_kind := 'appointment_end'; v_anchor_at := a.ends_at;
  else
    v_kind := 'appointment_end'; v_anchor_at := coalesce(q.draft_first_saved_at, now());
  end if;
  if q.draft_first_saved_at is null then
    q.draft_first_saved_at := now();
    q.draft_max_at := now() + make_interval(days => v_policy.draft_max_days);
    -- Automatic protection, once: a legitimate future appointment keeps its own following window.
    if a.status in ('scheduled', 'rescheduled', 'confirmed') and a.ends_at > now() then
      q.draft_protected_appointment_id := coalesce(q.draft_anchor_appointment_id, q.anchor_appointment_id);
      q.draft_protected_until := a.ends_at + make_interval(days => v_policy.draft_protected_window_days);
    end if;
  end if;
  update public.intake_requests r set
    draft_first_saved_at = q.draft_first_saved_at,
    draft_max_at = q.draft_max_at,
    draft_anchor_appointment_id = coalesce(q.draft_anchor_appointment_id, q.anchor_appointment_id),
    draft_anchor_kind = v_kind,
    draft_anchor_at = v_anchor_at,
    draft_protected_appointment_id = q.draft_protected_appointment_id,
    draft_protected_until = q.draft_protected_until,
    draft_purge_after = least(v_anchor_at + make_interval(days => v_policy.draft_retention_days),
                              greatest(q.draft_max_at, coalesce(q.draft_protected_until, q.draft_max_at))),
    platform_policy_version = v_policy.policy_version
  where r.id = p_request_id;
end $$;

-- Does this studio hold any intake record (live or retained) for this client?
create or replace function intake_private.has_intake_records(p_studio_id uuid, p_client_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from public.intake_requests q where q.studio_id = p_studio_id and q.client_id = p_client_id)
      or exists (select 1 from public.intake_client_relationship_state s where s.studio_id = p_studio_id and s.client_id = p_client_id)
      or exists (select 1 from public.intake_guardian_designations d where d.studio_id = p_studio_id and d.client_id = p_client_id)
      or exists (select 1 from public.intake_consent_evidence e where e.studio_id = p_studio_id and e.client_ref = p_client_id);
$$;

-- F10 (read paths): live client ownership check. On drift of existing intake records it writes a persisted security
-- audit event and returns true; the caller then returns no data (a generic, non-revealing refusal). A client that is
-- simply not in this studio and has no intake records here returns true without an event.
create or replace function intake_private.drift_detected(p_studio_id uuid, p_client_id uuid, p_request_id uuid)
returns boolean language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if exists (select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id) then
    return false;
  end if;
  if intake_private.has_intake_records(p_studio_id, p_client_id) then
    perform intake_private.audit_write(p_studio_id, 'tenant_drift_detected', 'system', auth.uid(), null, p_request_id,
      p_client_id, null, null, null, '{}'::jsonb, 'security');
  end if;
  return true;
end $$;

-- F10 (write paths): refuse with a generic error. The refused write itself is the protection (an audit row written
-- here would roll back with the error); drift stays discoverable through intake_drift_report and read paths.
create or replace function intake_private.assert_drift_free(p_studio_id uuid, p_client_id uuid, p_request_id uuid)
returns void language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if not exists (select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id) then
    raise exception 'nsi: record unavailable' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Staff RPCs (authenticated; authorization in body)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.intake_save_template_draft(p_studio_id uuid, p_template_id uuid, p_name text,
  p_schema jsonb, p_reintake_required boolean default false, p_document_template_version_ref uuid default null,
  p_privacy_notice_version text default null)
returns uuid language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := intake_private.assert_staff(p_studio_id, 'configure');
  v_template uuid := p_template_id;
  v_version uuid;
  v_next int;
begin
  perform intake_private.schema_max_answer_bytes(p_schema);
  perform intake_private.assert_document_version(p_studio_id, p_document_template_version_ref);
  if v_template is null then
    insert into public.intake_templates (studio_id, name, created_by) values (p_studio_id, p_name, auth.uid())
    returning id into v_template;
  else
    perform 1 from public.intake_templates t where t.id = v_template and t.studio_id = p_studio_id for update;
    if not found then raise exception 'nsi: template not found' using errcode = '42501'; end if;
    if p_name is not null then update public.intake_templates set name = p_name where id = v_template; end if;
  end if;
  select v.id into v_version from public.intake_template_versions v where v.template_id = v_template and v.status = 'draft';
  if v_version is null then
    select coalesce(max(v.version_number), 0) + 1 into v_next from public.intake_template_versions v where v.template_id = v_template;
    insert into public.intake_template_versions (studio_id, template_id, version_number, schema, reintake_required,
      document_template_version_ref, privacy_notice_version)
    values (p_studio_id, v_template, v_next, p_schema, coalesce(p_reintake_required, false), p_document_template_version_ref, p_privacy_notice_version)
    returning id into v_version;
  else
    update public.intake_template_versions set schema = p_schema, reintake_required = coalesce(p_reintake_required, false),
      document_template_version_ref = p_document_template_version_ref, privacy_notice_version = p_privacy_notice_version
    where id = v_version;
  end if;
  perform intake_private.audit_write(p_studio_id, 'template_draft_saved', 'staff', auth.uid(), v_role, null, null,
    'intake_template_version', v_version, null, '{}'::jsonb, 'operational');
  return v_version;
end $$;

create or replace function public.intake_publish_template_version(p_studio_id uuid, p_version_id uuid)
returns int language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := intake_private.assert_staff(p_studio_id, 'configure');
  v public.intake_template_versions;
begin
  select * into v from public.intake_template_versions x where x.id = p_version_id and x.studio_id = p_studio_id;
  if v.id is null or v.status <> 'draft' then
    raise exception 'nsi: only a draft version of this studio can be published' using errcode = '22023';
  end if;
  perform 1 from public.intake_templates t where t.id = v.template_id for update;
  update public.intake_template_versions set
    status = 'published',
    schema_sha256 = encode(extensions.digest(v.schema::text, 'sha256'), 'hex'),
    max_answer_bytes = intake_private.schema_max_answer_bytes(v.schema),
    published_at = now(),
    published_by = auth.uid()
  where id = p_version_id;
  perform intake_private.audit_write(p_studio_id, 'template_version_published', 'staff', auth.uid(), v_role, null, null,
    'intake_template_version', p_version_id, null, jsonb_build_object('version_number', v.version_number), 'operational');
  return v.version_number;
end $$;

create or replace function public.intake_set_reintake_floor(p_studio_id uuid, p_template_id uuid, p_version_number int)
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_role text := intake_private.assert_staff(p_studio_id, 'configure');
begin
  update public.intake_templates set reintake_floor_version = p_version_number, floor_effective_at = now()
  where id = p_template_id and studio_id = p_studio_id;
  if not found then raise exception 'nsi: template not found' using errcode = '42501'; end if;
  perform intake_private.audit_write(p_studio_id, 'reintake_floor_set', 'staff', auth.uid(), v_role, null, null,
    'intake_template', p_template_id, null, jsonb_build_object('version_number', p_version_number), 'operational');
end $$;

create or replace function public.intake_set_service_assignment(p_studio_id uuid, p_appointment_type text, p_template_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_role text := intake_private.assert_staff(p_studio_id, 'configure');
begin
  if p_template_id is null then
    delete from public.intake_service_assignments where studio_id = p_studio_id and appointment_type = p_appointment_type::public.appointment_type;
  else
    insert into public.intake_service_assignments (studio_id, appointment_type, template_id)
    values (p_studio_id, p_appointment_type::public.appointment_type, p_template_id)
    on conflict (studio_id, appointment_type) do update set template_id = excluded.template_id;
  end if;
  perform intake_private.audit_write(p_studio_id, 'service_assignment_set', 'staff', auth.uid(), v_role, null, null,
    'intake_template', p_template_id, null, jsonb_build_object('appointment_type', p_appointment_type), 'operational');
end $$;

-- Settings patch. Permission flags (front-desk guardian selection, admin draft extensions) are owner-only.
create or replace function public.intake_update_settings(p_studio_id uuid, p_changes jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := intake_private.assert_staff(p_studio_id, 'configure');
  c_allowed constant text[] := array['enabled', 'minor_age_threshold', 'default_template_id', 'front_desk_guardian_selection',
    'draft_extension_admins_enabled', 'min_guardian_assurance', 'surge_threshold_per_run', 'surge_threshold_24h',
    'invite_max_lifetime_days'];
  s public.intake_settings;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_changes) k where not (k = any (c_allowed))) then
    raise exception 'nsi: unsupported settings change' using errcode = '22023';
  end if;
  if (p_changes ? 'front_desk_guardian_selection' or p_changes ? 'draft_extension_admins_enabled') and v_role <> 'studio_owner' then
    raise exception 'nsi: only the studio owner can change intake permission flags' using errcode = '42501';
  end if;
  insert into public.intake_settings (studio_id) values (p_studio_id) on conflict (studio_id) do nothing;
  select * into s from public.intake_settings x where x.studio_id = p_studio_id for update;
  update public.intake_settings set
    enabled = coalesce((p_changes ->> 'enabled')::boolean, s.enabled),
    enabled_at = case when coalesce((p_changes ->> 'enabled')::boolean, s.enabled) and not s.enabled then now() else s.enabled_at end,
    minor_age_threshold = coalesce((p_changes ->> 'minor_age_threshold')::smallint, s.minor_age_threshold),
    default_template_id = case when p_changes ? 'default_template_id' then (p_changes ->> 'default_template_id')::uuid else s.default_template_id end,
    front_desk_guardian_selection = coalesce((p_changes ->> 'front_desk_guardian_selection')::boolean, s.front_desk_guardian_selection),
    draft_extension_admins_enabled = coalesce((p_changes ->> 'draft_extension_admins_enabled')::boolean, s.draft_extension_admins_enabled),
    min_guardian_assurance = coalesce(p_changes ->> 'min_guardian_assurance', s.min_guardian_assurance),
    surge_threshold_per_run = coalesce((p_changes ->> 'surge_threshold_per_run')::int, s.surge_threshold_per_run),
    surge_threshold_24h = case when p_changes ? 'surge_threshold_24h' then (p_changes ->> 'surge_threshold_24h')::int else s.surge_threshold_24h end,
    invite_max_lifetime_days = case when p_changes ? 'invite_max_lifetime_days' then (p_changes ->> 'invite_max_lifetime_days')::int else s.invite_max_lifetime_days end,
    updated_by = auth.uid()
  where studio_id = p_studio_id;
  perform intake_private.audit_write(p_studio_id, 'settings_updated', 'staff', auth.uid(), v_role, null, null, null, null, null,
    case when p_changes ? 'enabled' then jsonb_build_object('enabled', (p_changes ->> 'enabled')::boolean) else '{}'::jsonb end, 'operational');
end $$;

-- A1: studios choose only the post-relationship duration, capped by the approved platform maximum.
create or replace function public.intake_set_retention_choice(p_studio_id uuid, p_post_relationship_days int)
returns uuid language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := intake_private.assert_staff(p_studio_id, 'retention_choice');
  v_policy record;
  v_id uuid;
  v_next int;
begin
  select * into v_policy from public.intake_platform_policy();
  if v_policy.post_relationship_max_days is null then
    raise exception 'nsi: platform post-relationship maximum is not approved' using errcode = '42501';
  end if;
  if p_post_relationship_days is not null and (p_post_relationship_days < 1 or p_post_relationship_days > v_policy.post_relationship_max_days) then
    raise exception 'nsi: post-relationship days must be between 1 and the platform maximum' using errcode = '22023';
  end if;
  insert into public.intake_settings (studio_id) values (p_studio_id) on conflict (studio_id) do nothing;
  perform 1 from public.intake_settings s where s.studio_id = p_studio_id for update;
  select coalesce(max(c.version), 0) + 1 into v_next from public.intake_studio_retention_choices c where c.studio_id = p_studio_id;
  insert into public.intake_studio_retention_choices (studio_id, version, post_relationship_days, platform_policy_version, created_by)
  values (p_studio_id, v_next, p_post_relationship_days, v_policy.policy_version, auth.uid()) returning id into v_id;
  update public.intake_settings set active_retention_choice_id = v_id, updated_by = auth.uid() where studio_id = p_studio_id;
  perform intake_private.audit_write(p_studio_id, 'retention_choice_set', 'staff', auth.uid(), v_role, null, null,
    'intake_studio_retention_choice', v_id, null, '{}'::jsonb, 'operational');
  return v_id;
end $$;

create or replace function public.intake_get_status(p_studio_id uuid, p_client_id uuid)
returns table (request_id uuid, template_id uuid, status text, pinned_version_number int, fulfillment text,
  issued_at timestamptz, submitted_at timestamptz, anchor_appointment_id uuid, guardian_recipient_basis text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform intake_private.assert_staff(p_studio_id, 'view_status');
  if intake_private.drift_detected(p_studio_id, p_client_id, null) then
    return;
  end if;
  return query
    select q.id, q.template_id, q.status, v.version_number, intake_private.fulfillment_state(q.id),
           q.issued_at, q.submitted_at, q.anchor_appointment_id, q.guardian_recipient_basis
    from public.intake_requests q
    left join public.intake_template_versions v on v.id = q.pinned_version_id
    where q.studio_id = p_studio_id and q.client_id = p_client_id
    order by q.created_at desc;
end $$;

-- Answers scoped by role and field visibility. Platform admins have no answer access (V1 baseline 1).
create or replace function public.intake_get_answers(p_studio_id uuid, p_request_id uuid)
returns table (audience text, field_key text, answer jsonb, visibility text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text;
  q public.intake_requests;
  v_schema jsonb;
begin
  begin
    v_role := intake_private.assert_staff(p_studio_id, 'view_all_answers');
  exception when sqlstate '42501' then
    v_role := intake_private.assert_staff(p_studio_id, 'view_operational');
  end;
  select * into q from public.intake_requests r where r.id = p_request_id and r.studio_id = p_studio_id;
  if q.id is null then raise exception 'nsi: record unavailable' using errcode = '42501'; end if;
  if intake_private.drift_detected(p_studio_id, q.client_id, q.id) then
    return;
  end if;
  select v.schema into v_schema from public.intake_template_versions v where v.id = q.pinned_version_id;
  perform intake_private.audit_write(p_studio_id, 'staff_viewed_answers', 'staff', auth.uid(), v_role, q.id, q.client_id,
    null, null, null, '{}'::jsonb, 'security');
  return query
    select r.audience, kv.key, kv.value, f ->> 'visibility'
    from public.intake_responses r
    cross join lateral jsonb_each(coalesce(r.answers, '{}'::jsonb)) kv
    cross join lateral (
      select fld from jsonb_array_elements(v_schema -> 'sections') sec, jsonb_array_elements(sec -> 'fields') fld
      where fld ->> 'key' = kv.key limit 1) x(f)
    where r.request_id = q.id and r.status in ('draft', 'submitted') and r.redacted_at is null
      and (v_role in ('studio_owner', 'studio_admin') or (f ->> 'visibility') in ('front_desk', 'instructor_visible'));
end $$;

create or replace function public.intake_designate_guardian(p_studio_id uuid, p_client_id uuid, p_link_id uuid, p_reason text default null)
returns uuid language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := intake_private.assert_staff(p_studio_id, 'designate_guardian');
  v_id uuid;
begin
  perform intake_private.assert_drift_free(p_studio_id, p_client_id, null);
  perform intake_private.lock_client(p_studio_id, p_client_id);
  perform 1 from public.intake_guardian_designations d
  where d.studio_id = p_studio_id and d.client_id = p_client_id and d.superseded_at is null for update;
  update public.intake_guardian_designations set superseded_at = now()
  where studio_id = p_studio_id and client_id = p_client_id and superseded_at is null;
  insert into public.intake_guardian_designations (studio_id, client_id, link_id, designated_by, reason)
  values (p_studio_id, p_client_id, p_link_id, auth.uid(), p_reason) returning id into v_id;
  perform intake_private.audit_write(p_studio_id, 'guardian_designated', 'staff', auth.uid(), v_role, null, p_client_id,
    'intake_guardian_designation', v_id, null, '{}'::jsonb, 'operational');
  return v_id;
end $$;

-- Recipient selection: before guardian submission only; bumps routing generation, supersedes prior guardian
-- respondent and guardian draft; consent evidence is untouched.
create or replace function public.intake_select_guardian_recipient(p_studio_id uuid, p_request_id uuid, p_link_id uuid, p_reason text default null)
returns int language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := intake_private.assert_staff(p_studio_id, 'designate_guardian');
  q public.intake_requests;
begin
  select * into q from public.intake_requests r where r.id = p_request_id and r.studio_id = p_studio_id;
  if q.id is null then raise exception 'nsi: record unavailable' using errcode = '42501'; end if;
  perform intake_private.assert_drift_free(p_studio_id, q.client_id, q.id);
  if not intake_private.retention_gate_open() then
    raise exception 'nsi: retention_policy_incomplete (platform retention periods are not approved)' using errcode = '42501';
  end if;
  perform intake_private.lock_client(p_studio_id, q.client_id);
  select * into q from public.intake_requests r where r.id = p_request_id for update;
  perform 1 from public.intake_responses r where r.request_id = q.id order by r.request_id, r.audience for update;
  if exists (select 1 from public.intake_responses r where r.request_id = q.id and r.audience = 'guardian' and r.status = 'submitted') then
    raise exception 'nsi: guardian consent already submitted; re-consent requires a new request' using errcode = '22023';
  end if;
  if not intake_private.link_is_verified_guardian(p_studio_id, q.client_id, p_link_id) then
    raise exception 'nsi: recipient must be a verified guardian link of this client' using errcode = '42501';
  end if;
  update public.intake_responses set status = 'superseded' where request_id = q.id and audience = 'guardian' and status = 'draft';
  update public.intake_respondents set superseded_at = now() where request_id = q.id and role = 'guardian' and superseded_at is null;
  update public.intake_requests set guardian_recipient_link_id = p_link_id, guardian_recipient_basis = 'staff_selected',
    guardian_recipient_selected_by = auth.uid(), guardian_recipient_selected_at = now(),
    guardian_routing_generation = q.guardian_routing_generation + 1
  where id = q.id;
  perform intake_private.audit_write(p_studio_id, 'guardian_recipient_selected', 'staff', auth.uid(), v_role, q.id, q.client_id,
    null, null, null, jsonb_build_object('generation', q.guardian_routing_generation + 1), 'operational');
  return q.guardian_routing_generation + 1;
end $$;

-- Staff override of a request's minor status (P1-1): owner/admin only (capability minor_override, distinct from
-- front-desk attestation) with a mandatory reason, because a later "not a minor" determination removes an
-- outstanding guardian-consent requirement. Accepted consent evidence is never changed.
create or replace function public.intake_record_minor_determination(p_studio_id uuid, p_request_id uuid, p_is_minor boolean,
  p_reason text)
returns uuid language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := intake_private.assert_staff(p_studio_id, 'minor_override');
  q public.intake_requests;
  v_id uuid;
  v_threshold smallint;
begin
  if p_is_minor is null then raise exception 'nsi: minor status required' using errcode = '22023'; end if;
  if coalesce(btrim(p_reason), '') = '' or char_length(p_reason) > 1000 then
    raise exception 'nsi: reason required (1-1000 characters)' using errcode = '22023';
  end if;
  select * into q from public.intake_requests r where r.id = p_request_id and r.studio_id = p_studio_id;
  if q.id is null then raise exception 'nsi: record unavailable' using errcode = '42501'; end if;
  perform intake_private.assert_drift_free(p_studio_id, q.client_id, q.id);
  perform intake_private.lock_client(p_studio_id, q.client_id);
  perform 1 from public.intake_requests r where r.id = q.id for update;
  select coalesce(s.minor_age_threshold, 18) into v_threshold from public.intake_settings s where s.studio_id = p_studio_id;
  insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold, actor_user_id, reason)
  values (p_studio_id, q.id, p_is_minor, 'staff_override', current_date, coalesce(v_threshold, 18), auth.uid(), p_reason)
  returning id into v_id;
  perform intake_private.audit_write(p_studio_id, 'minor_determination_recorded', 'staff', auth.uid(), v_role, q.id, q.client_id,
    null, null, null, '{}'::jsonb, 'operational');
  return v_id;
end $$;

create or replace function public.intake_drift_report(p_studio_id uuid)
returns table (object_type text, object_id uuid, issue text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_role text := intake_private.assert_staff(p_studio_id, 'drift_report');
begin
  -- Read-only report: operational class with no subject references, so running it never blocks a dark rollback.
  perform intake_private.audit_write(p_studio_id, 'drift_report_run', 'staff', auth.uid(), v_role, null, null, null, null, null, '{}'::jsonb, 'operational');
  return query
    select 'intake_request'::text, q.id, 'client no longer belongs to this studio'::text
    from public.intake_requests q left join public.clients c on c.id = q.client_id
    where q.studio_id = p_studio_id and (c.id is null or c.studio_id <> q.studio_id)
    union all
    select 'intake_guardian_designation', d.id, 'designated link is no longer a verified guardian link'
    from public.intake_guardian_designations d
    where d.studio_id = p_studio_id and d.superseded_at is null
      and (d.link_id is null or not intake_private.link_is_verified_guardian(d.studio_id, d.client_id, d.link_id))
    union all
    select 'intake_request', q.id, 'guardian recipient link is no longer a verified guardian link'
    from public.intake_requests q
    where q.studio_id = p_studio_id and q.guardian_recipient_link_id is not null
      and not intake_private.link_is_verified_guardian(q.studio_id, q.client_id, q.guardian_recipient_link_id);
end $$;

-- Draft-retention extension: explicit, audited, protects a new legitimate future appointment's following window.
create or replace function public.intake_extend_draft_retention(p_studio_id uuid, p_request_id uuid, p_appointment_id uuid, p_reason text)
returns timestamptz language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := intake_private.assert_staff(p_studio_id, 'extend_draft');
  q public.intake_requests;
  a record;
  v_policy record;
  v_purge timestamptz;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'nsi: reason required' using errcode = '22023'; end if;
  select * into q from public.intake_requests r where r.id = p_request_id and r.studio_id = p_studio_id;
  if q.id is null then raise exception 'nsi: record unavailable' using errcode = '42501'; end if;
  perform intake_private.assert_drift_free(p_studio_id, q.client_id, q.id);
  if not intake_private.retention_gate_open() then
    raise exception 'nsi: retention_policy_incomplete (platform retention periods are not approved)' using errcode = '42501';
  end if;
  perform intake_private.lock_client(p_studio_id, q.client_id);
  select * into q from public.intake_requests r where r.id = p_request_id for update;
  if q.draft_first_saved_at is null then raise exception 'nsi: no draft to extend' using errcode = '22023'; end if;
  select * into a from intake_private.appointment_snapshot(p_studio_id, q.client_id, p_appointment_id);
  if a.status is null or a.status not in ('scheduled', 'rescheduled', 'confirmed') or a.ends_at <= now()
     or a.appointment_type not in ('private_lesson', 'intro_lesson', 'coaching') then
    raise exception 'nsi: extension requires a live, qualifying future appointment of this client' using errcode = '22023';
  end if;
  select * into v_policy from public.intake_platform_policy();
  update public.intake_requests set
    draft_protected_appointment_id = p_appointment_id,
    draft_protected_until = a.ends_at + make_interval(days => v_policy.draft_protected_window_days),
    draft_anchor_appointment_id = p_appointment_id,
    draft_anchor_kind = 'appointment_end',
    draft_anchor_at = a.ends_at,
    draft_purge_after = least(a.ends_at + make_interval(days => v_policy.draft_retention_days),
      greatest(q.draft_max_at, a.ends_at + make_interval(days => v_policy.draft_protected_window_days))),
    draft_extension_count = q.draft_extension_count + 1,
    draft_last_extension_by = auth.uid(),
    draft_last_extension_at = now(),
    draft_last_extension_reason = p_reason
  where id = q.id
  returning draft_purge_after into v_purge;
  perform intake_private.audit_write(p_studio_id, 'draft_retention_extended', 'staff', auth.uid(), v_role, q.id, q.client_id,
    null, null, null, jsonb_build_object('extension_count', q.draft_extension_count + 1), 'operational');
  return v_purge;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Service RPCs (service_role only)
-- ---------------------------------------------------------------------------------------------------------------
-- Creates or returns the open obligation for (studio, client, template). Reuses a valid completion (version at or
-- above the floor; consent outstanding counts as existing). Appointment checked softly (no FK on appointments).
create or replace function public.intake_ensure_request(p_studio_id uuid, p_client_id uuid, p_appointment_id uuid,
  p_source text default 'auto')
returns uuid language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  a record;
  v_template uuid;
  t public.intake_templates;
  v_id uuid;
  v_completed uuid;
begin
  if p_source not in ('auto', 'manual') then raise exception 'nsi: invalid source' using errcode = '22023'; end if;
  perform intake_private.assert_client_in_studio(p_studio_id, p_client_id);
  perform intake_private.lock_client(p_studio_id, p_client_id);
  if p_appointment_id is not null then
    select * into a from intake_private.appointment_snapshot(p_studio_id, p_client_id, p_appointment_id);
    if a.status is null or a.status not in ('scheduled', 'rescheduled', 'confirmed') or a.starts_at <= now() then
      raise exception 'nsi: appointment is not a live future appointment of this client' using errcode = '22023';
    end if;
    select sa.template_id into v_template from public.intake_service_assignments sa
    where sa.studio_id = p_studio_id and sa.appointment_type::text = a.appointment_type;
    if v_template is null and a.appointment_type not in ('private_lesson', 'intro_lesson', 'coaching') then
      raise exception 'nsi: appointment type does not qualify for intake' using errcode = '22023';
    end if;
  elsif p_source = 'auto' then
    raise exception 'nsi: automatic requests need a qualifying appointment' using errcode = '22023';
  end if;
  if v_template is null then
    select s.default_template_id into v_template from public.intake_settings s where s.studio_id = p_studio_id;
  end if;
  select * into t from public.intake_templates x where x.id = v_template and x.studio_id = p_studio_id and x.status = 'active';
  if t.id is null then raise exception 'nsi: no active intake template applies' using errcode = '22023'; end if;
  -- reuse a valid completion
  select q.id into v_completed
  from public.intake_completions c join public.intake_requests q on q.id = c.request_id
  where c.client_id = p_client_id and c.template_id = t.id
    and (t.reintake_floor_version is null or c.version_number >= t.reintake_floor_version)
  order by c.completed_at desc limit 1;
  if v_completed is not null and p_source = 'auto' then
    return v_completed;
  end if;
  if p_source = 'auto' and p_appointment_id is not null and t.reintake_floor_version is not null and a.created_at < t.floor_effective_at
     and exists (select 1 from public.intake_completions c where c.client_id = p_client_id and c.template_id = t.id) then
    return null;  -- appointment predates the required re-intake floor; not retroactively subject
  end if;
  insert into public.intake_requests (studio_id, client_id, template_id, source, anchor_appointment_id)
  values (p_studio_id, p_client_id, t.id, p_source, p_appointment_id)
  on conflict (studio_id, client_id, template_id) where status in ('pending', 'invited', 'in_progress', 'suspended') do nothing
  returning id into v_id;
  if v_id is null then
    select q.id into v_id from public.intake_requests q
    where q.studio_id = p_studio_id and q.client_id = p_client_id and q.template_id = t.id
      and q.status in ('pending', 'invited', 'in_progress', 'suspended')
    for update;
  else
    perform intake_private.audit_write(p_studio_id, 'request_created', 'system', null, null, v_id, p_client_id, null, null,
      null, '{}'::jsonb, 'operational');
  end if;
  if p_appointment_id is not null then
    insert into public.intake_request_appointments (studio_id, request_id, appointment_id, attached_by)
    values (p_studio_id, v_id, p_appointment_id, 'reconciler') on conflict (request_id, appointment_id) do nothing;
  end if;
  return v_id;
end $$;

-- Draft save: L1 -> L3 -> L4, compare-and-set on revision (NULL never matches), schema validation against the pinned
-- version. Respondent assurance is DERIVED, never taken from the caller (P1-2): a verified link of this client
-- (guardian link for the guardian audience, the client's own linked account for the student) gives link_verified and
-- binds the link's account; anything else is declared_unverified. Email-code and staff attestation need I3 records.
create or replace function public.intake_save_draft(p_studio_id uuid, p_request_id uuid, p_audience text,
  p_respondent jsonb, p_answers jsonb, p_expected_revision int)
returns int language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  q public.intake_requests;
  r public.intake_responses;
  v_schema jsonb;
  v_respondent uuid;
  v_rev int;
  v_link uuid;
  v_assurance text := 'declared_unverified';
  v_link_user uuid;
begin
  if p_audience not in ('student', 'guardian') then raise exception 'nsi: invalid audience' using errcode = '22023'; end if;
  if p_respondent ? 'assurance' or p_respondent ? 'auth_user_id' then
    raise exception 'nsi: respondent assurance and account are derived from verified links, not supplied' using errcode = '22023';
  end if;
  select * into q from public.intake_requests x where x.id = p_request_id and x.studio_id = p_studio_id;
  if q.id is null then raise exception 'nsi: record unavailable' using errcode = '42501'; end if;
  perform intake_private.assert_drift_free(p_studio_id, q.client_id, q.id);
  if not intake_private.retention_gate_open() then
    raise exception 'nsi: retention_policy_incomplete (platform retention periods are not approved)' using errcode = '42501';
  end if;
  if intake_private.erasure_barrier_active(p_studio_id, q.client_id) then
    raise exception 'nsi: erasure_barrier_active (no new intake records for an erased client)' using errcode = '42501';
  end if;
  perform intake_private.lock_client(p_studio_id, q.client_id);
  select * into q from public.intake_requests x where x.id = p_request_id for update;
  if q.pinned_version_id is null or q.status not in ('invited', 'in_progress', 'submitted') then
    raise exception 'nsi: request is not open for answers' using errcode = '22023';
  end if;
  select v.schema into v_schema from public.intake_template_versions v where v.id = q.pinned_version_id;
  perform intake_private.validate_answers(v_schema, p_audience, p_answers, false);
  select * into r from public.intake_responses x where x.request_id = q.id and x.audience = p_audience
    and x.status in ('draft', 'submitted') for update;
  if r.id is not null and r.status = 'submitted' then
    raise exception 'nsi: response already submitted' using errcode = '22023';
  end if;
  if r.id is null then
    if p_expected_revision is distinct from 0 then raise exception 'nsi: revision_conflict' using errcode = '40001'; end if;
    v_link := (p_respondent ->> 'source_link_id')::uuid;
    if p_audience = 'guardian' and q.guardian_recipient_link_id is not null and v_link is distinct from q.guardian_recipient_link_id then
      raise exception 'nsi: the guardian respondent must be the selected guardian recipient' using errcode = '42501';
    end if;
    if v_link is not null and (case when p_audience = 'guardian' then intake_private.link_is_verified_guardian(p_studio_id, q.client_id, v_link)
                                    else intake_private.link_is_verified_self(p_studio_id, q.client_id, v_link) end) then
      v_assurance := 'link_verified';
      select l.user_id into v_link_user from public.client_account_links l where l.id = v_link;
    end if;
    insert into public.intake_respondents (studio_id, request_id, client_id, role, display_name, email, email_hmac,
      email_hmac_kid, declared_relationship, source_link_id, auth_user_id, assurance)
    values (p_studio_id, q.id, q.client_id, p_audience, p_respondent ->> 'display_name', p_respondent ->> 'email',
      p_respondent ->> 'email_hmac', (p_respondent ->> 'email_hmac_kid')::smallint, p_respondent ->> 'declared_relationship',
      v_link, v_link_user, v_assurance)
    returning id into v_respondent;
    insert into public.intake_responses (studio_id, request_id, client_id, audience, respondent_id, template_version_id, answers)
    values (p_studio_id, q.id, q.client_id, p_audience, v_respondent, q.pinned_version_id, p_answers);
    v_rev := 1;
  else
    if r.revision is distinct from p_expected_revision then raise exception 'nsi: revision_conflict' using errcode = '40001'; end if;
    update public.intake_responses set answers = p_answers, revision = r.revision + 1, last_saved_at = now()
    where id = r.id;
    v_rev := r.revision + 1;
  end if;
  if q.status = 'invited' then
    update public.intake_requests set status = 'in_progress' where id = q.id;
  end if;
  perform intake_private.compute_draft_retention(q.id);
  perform intake_private.audit_write(p_studio_id, 'draft_saved', p_audience, null, null, q.id, q.client_id, null, null, null,
    jsonb_build_object('audience', p_audience), 'operational');
  return v_rev;
end $$;

-- Submit: L1 -> L2 -> L3 -> L4. Only an issued, open request accepts a submission (P1-3). A student submission needs
-- a recorded minor determination (P2-4: no silent "adult" default). A guardian submission must carry consent
-- evidence from a respondent whose assurance meets the studio minimum, which is pinned on the evidence (P2-3, N5).
-- Consent evidence uses approved platform periods; exactly one completion per request (unique + request lock).
-- Returns the derived fulfillment state.
create or replace function public.intake_submit_response(p_studio_id uuid, p_request_id uuid, p_audience text,
  p_expected_revision int, p_consent jsonb default null)
returns text language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  q public.intake_requests;
  r public.intake_responses;
  p public.intake_respondents;
  v public.intake_template_versions;
  v_policy record;
  v_minor boolean;
  v_student uuid;
  v_guardian uuid;
  v_ev uuid;
  v_required text;
  rs public.intake_client_relationship_state;
  v_days int;
begin
  select * into q from public.intake_requests x where x.id = p_request_id and x.studio_id = p_studio_id;
  if q.id is null then raise exception 'nsi: record unavailable' using errcode = '42501'; end if;
  perform intake_private.assert_drift_free(p_studio_id, q.client_id, q.id);
  if not intake_private.retention_gate_open() then
    raise exception 'nsi: retention_policy_incomplete (platform retention periods are not approved)' using errcode = '42501';
  end if;
  if intake_private.erasure_barrier_active(p_studio_id, q.client_id) then
    raise exception 'nsi: erasure_barrier_active (no new intake records for an erased client)' using errcode = '42501';
  end if;
  perform intake_private.lock_client(p_studio_id, q.client_id);
  select * into rs from public.intake_client_relationship_state s where s.client_id = q.client_id for update;
  select * into q from public.intake_requests x where x.id = p_request_id for update;
  if q.pinned_version_id is null or q.status not in ('invited', 'in_progress', 'submitted') then
    raise exception 'nsi: request is not open for answers (status %)', q.status using errcode = '22023';
  end if;
  perform 1 from public.intake_responses x where x.request_id = q.id order by x.request_id, x.audience for update;
  select * into r from public.intake_responses x where x.request_id = q.id and x.audience = p_audience and x.status = 'draft';
  if r.id is null then raise exception 'nsi: no draft response to submit' using errcode = '22023'; end if;
  if r.revision is distinct from p_expected_revision then raise exception 'nsi: revision_conflict' using errcode = '40001'; end if;
  select * into v from public.intake_template_versions x where x.id = q.pinned_version_id;
  perform intake_private.validate_answers(v.schema, p_audience, r.answers, true);
  select * into p from public.intake_respondents x where x.id = r.respondent_id;
  select * into v_policy from public.intake_platform_policy();
  select coalesce((select s.min_guardian_assurance from public.intake_settings s where s.studio_id = p_studio_id), 'email_code_verified')
  into v_required;
  if p_audience = 'student' and not exists (select 1 from public.intake_minor_determinations d where d.request_id = q.id) then
    raise exception 'nsi: minor_determination_required (record whether the student is a minor before submission)' using errcode = '22023';
  end if;
  if p_audience = 'guardian' then
    if p_consent is null or coalesce(btrim(p_consent ->> 'consent_text'), '') = '' then
      raise exception 'nsi: a guardian submission must carry consent evidence' using errcode = '22023';
    end if;
    -- I1: only affirmative consent completes a guardian response. A decline is refused before anything is written,
    -- so the guardian draft stays a draft and a later acknowledgment can still submit (no stuck submitted state).
    if coalesce(p_consent ->> 'event_type', 'acknowledged') <> 'acknowledged' then
      raise exception 'nsi: guardian_consent_not_affirmative (only acknowledged consent completes a guardian response in this release)'
        using errcode = '22023';
    end if;
    if coalesce(intake_private.assurance_rank(p.assurance), 0) < intake_private.assurance_rank(v_required) then
      raise exception 'nsi: guardian assurance % is below the studio minimum %', p.assurance, v_required using errcode = '42501';
    end if;
  end if;
  -- Consistency (any audience): an acknowledged consent must carry the outcome 'accepted' (missing = accepted). A
  -- contradictory pair such as acknowledged + rejected is refused before anything is written. Guardian declines are an
  -- I3 workflow (refused above).
  if p_consent is not null and coalesce(p_consent ->> 'event_type', 'acknowledged') = 'acknowledged'
     and coalesce(p_consent ->> 'outcome', 'accepted') <> 'accepted' then
    raise exception 'nsi: contradictory_consent (acknowledged consent must have outcome accepted)' using errcode = '22023';
  end if;
  update public.intake_responses set status = 'submitted', submitted_at = now(), notice_version = v.privacy_notice_version,
    platform_policy_version = v_policy.policy_version
  where id = r.id;
  if p_consent is not null then
    insert into public.intake_consent_evidence (studio_id, request_ref, client_ref, respondent_ref, respondent_role,
      declared_relationship, assurance, required_assurance, event_type, acknowledged_at, consent_text, consent_text_sha256,
      template_version_ref, template_schema_sha256, sign_envelope_ref, signed_sha256, outcome, actor_type, retention_basis,
      retain_until, platform_policy_version)
    values (p_studio_id, q.id, q.client_id, p.id, p_audience, p.declared_relationship, p.assurance, v_required,
      coalesce(p_consent ->> 'event_type', 'acknowledged'), now(), p_consent ->> 'consent_text',
      encode(extensions.digest(p_consent ->> 'consent_text', 'sha256'), 'hex'), v.id, v.schema_sha256,
      (p_consent ->> 'sign_envelope_ref')::uuid, p_consent ->> 'signed_sha256', coalesce(p_consent ->> 'outcome', 'accepted'),
      p_audience, coalesce(p_consent ->> 'retention_basis', 'evidentiary'),
      now() + make_interval(days => v_policy.evidence_core_days), v_policy.policy_version)
    returning id into v_ev;
    if p_consent ? 'identity' then
      insert into public.intake_consent_evidence_identity (studio_id, evidence_id, subject_display_name, respondent_display_name,
        respondent_email_hmac, respondent_email_hmac_kid, retain_until)
      select p_studio_id, v_ev, p_consent #>> '{identity,subject_display_name}', p.display_name,
             p_consent #>> '{identity,respondent_email_hmac}', (p_consent #>> '{identity,respondent_email_hmac_kid}')::smallint,
             e.acknowledged_at + make_interval(days => v_policy.evidence_identity_days)
      from public.intake_consent_evidence e where e.id = v_ev;
    end if;
  end if;
  -- relationship already ended: start the answer clock immediately
  if rs.state = 'ended' then
    v_days := least(coalesce((select c.post_relationship_days from public.intake_studio_retention_choices c
                              join public.intake_settings s on s.active_retention_choice_id = c.id
                              where s.studio_id = p_studio_id), v_policy.post_relationship_max_days),
                    v_policy.post_relationship_max_days);
    update public.intake_responses set
      retention_state = case when v_days is null then 'clock_pending_policy' else 'clock_running' end,
      answers_redact_after = case when v_days is null then null else rs.ended_at + make_interval(days => v_days) end
    where id = r.id;
  end if;
  -- completion: student submitted, and guardian too when the latest determination says minor
  if not exists (select 1 from public.intake_completions c where c.request_id = q.id) then
    select d.is_minor into v_minor from public.intake_minor_determinations d where d.request_id = q.id
    order by d.created_at desc, d.id desc limit 1;
    select x.id into v_student from public.intake_responses x where x.request_id = q.id and x.audience = 'student' and x.status = 'submitted';
    select x.id into v_guardian from public.intake_responses x where x.request_id = q.id and x.audience = 'guardian' and x.status = 'submitted';
    if v_student is not null and v_minor is not null and (v_minor = false or v_guardian is not null) then
      insert into public.intake_completions (studio_id, request_id, client_id, template_id, template_version_id, version_number,
        student_response_id, guardian_response_id)
      values (p_studio_id, q.id, q.client_id, q.template_id, v.id, v.version_number, v_student, v_guardian);
      update public.intake_requests set status = 'submitted', submitted_at = now() where id = q.id and status <> 'submitted';
      perform intake_private.audit_write(p_studio_id, 'completion_recorded', 'system', null, null, q.id, q.client_id, null, null,
        null, jsonb_build_object('version_number', v.version_number), 'operational');
    end if;
  end if;
  perform intake_private.audit_write(p_studio_id, 'response_submitted', p_audience, null, null, q.id, q.client_id, null, null,
    null, jsonb_build_object('audience', p_audience), 'operational');
  return intake_private.fulfillment_state(q.id);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Operator RPCs: erasure (wrapper + role-owned implementation), barrier release, legal holds
-- ---------------------------------------------------------------------------------------------------------------
-- Implementation created AS the restricted role (rehearsed pattern): it owns the function and the grant to postgres.
-- CREATE on intake_private is granted to the role only for this transaction (assert_catalog requires USAGE only).
-- A refusal under a legal hold RETURNS {"outcome":"refused","refused":"legal_hold"} instead of raising, so its audit
-- event persists (P2-1). The erasure record carries the wrapper's drift flag, the reason code and the optional
-- support-case reference (P2-9); free-text reasons are not taken.
grant create on schema intake_private to intake_destructive;
set local role intake_destructive;
create or replace function intake_private.erase_client_impl(p_studio_id uuid, p_client_id uuid, p_actor uuid,
  p_reason_code text, p_drift boolean, p_case_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
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
revoke all on function intake_private.erase_client_impl(uuid, uuid, uuid, text, boolean, text) from public, anon, authenticated, service_role;
grant execute on function intake_private.erase_client_impl(uuid, uuid, uuid, text, boolean, text) to postgres;
reset role;
revoke create on schema intake_private from intake_destructive;

-- Optional support-case reference for operator actions: NULL, or a ticket identifier matching '^[A-Z]{2,10}-[0-9]{1,12}$'
-- (e.g. SUP-1234; at most 23 characters, no names, e-mail addresses or free text). Validated inline by both operator RPCs.

-- Erasure (platform admin). p_reason_code is one of: data_subject_request, guardian_request, studio_request,
-- legal_requirement, other. Unknown (NULL or nonexistent) studios and unknown clients are refused before anything is
-- written. Result "outcome" is one of:
--   erased      per-table counts and the drift flag; an erasure record (and so an erasure barrier) is written
--   refused     the client is under a legal hold; nothing deleted; the refusal is audited. Callers MUST treat this
--               as a failure (the RPC returns normally so the audit event persists)
--   no_records  the collection gate is closed and this studio holds no intake records for the client: nothing is
--               written at all (no audit event, no barrier, no first-use marker), so a dark-state call never blocks
--               the migration rollback. Callers must treat it as "nothing to erase", not as a completed erasure.
-- Lawful erasure of existing intake records is unchanged (records exist => erased or refused).
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

-- Barrier release (platform admin). p_reason_code is one of: erased_in_error, new_relationship, legal_requirement, other.
-- Optional support-case reference as for erasure. Without an active barrier nothing is written.
create or replace function public.intake_release_erasure_barrier(p_studio_id uuid, p_client_id uuid, p_reason_code text,
  p_case_ref text default null)
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  perform intake_private.assert_staff(p_studio_id, 'barrier_release');
  if p_reason_code is null or p_reason_code not in ('erased_in_error', 'new_relationship', 'legal_requirement', 'other') then
    raise exception 'nsi: reason code required (erased_in_error, new_relationship, legal_requirement, other)' using errcode = '22023';
  end if;
  if p_case_ref is not null and p_case_ref !~ '^[A-Z]{2,10}-[0-9]{1,12}$' then
    raise exception 'nsi: case reference must be a ticket identifier like SUP-1234 (^[A-Z]{2,10}-[0-9]{1,12}$)' using errcode = '22023';
  end if;
  perform intake_private.lock_client(p_studio_id, p_client_id);
  if not intake_private.erasure_barrier_active(p_studio_id, p_client_id) then
    raise exception 'nsi: no active erasure barrier for this client' using errcode = '22023';
  end if;
  perform intake_private.audit_write(p_studio_id, 'erasure_barrier_released', 'platform_admin', auth.uid(), 'platform_admin',
    null, p_client_id, null, null, null, jsonb_strip_nulls(jsonb_build_object('reason_code', p_reason_code, 'case_ref', p_case_ref)),
    'erasure_record');
end $$;

-- Legal hold (platform admin). Eligibility (P2-7): a hold preserves intake records, so while the collection gate is
-- closed it may be created only when this studio already holds intake records for the subject (records collected
-- before the gate closed stay holdable). With no records there is nothing to preserve, and creating one would store
-- a free-text reason under an unapproved retention period. Once Gate A is open, any in-studio subject is eligible.
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

create or replace function public.intake_release_legal_hold(p_studio_id uuid, p_hold_id uuid, p_release_reason text)
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  h public.intake_legal_holds;
  v_days int;
begin
  perform intake_private.assert_staff(p_studio_id, 'hold_admin');
  if coalesce(btrim(p_release_reason), '') = '' then raise exception 'nsi: release reason required' using errcode = '22023'; end if;
  select * into h from public.intake_legal_holds x where x.id = p_hold_id and x.studio_id = p_studio_id;
  if h.id is null or h.released_at is not null then
    raise exception 'nsi: active hold not found' using errcode = '22023';
  end if;
  perform intake_private.lock_client(p_studio_id, h.client_ref);
  perform 1 from public.intake_legal_holds x where x.id = h.id for update;
  select p.hold_record_days_after_release into v_days from public.intake_platform_policy() p;
  update public.intake_legal_holds set released_at = now(), released_by = auth.uid(), release_reason = p_release_reason,
    record_state = case when v_days is null then 'released_pending_policy' else 'released_scheduled' end,
    record_retain_until = case when v_days is null then null else now() + make_interval(days => v_days) end
  where id = h.id;
  perform intake_private.audit_write(p_studio_id, 'legal_hold_released', 'platform_admin', auth.uid(), 'platform_admin', null,
    h.client_ref, 'intake_legal_hold', h.id, h.id, '{}'::jsonb, 'legal_hold');
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- R25: revoke M5's own postgres-owned functions from API roles (the role-owned implementation is handled above as
-- the role), then class grants. Functions of M1-M4 are left untouched.
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where pg_get_userbyid(p.proowner) = 'postgres'
             and ((n.nspname = 'intake_private' and p.proname in ('lock_client', 'schema_max_answer_bytes', 'validate_answers',
                    'appointment_snapshot', 'compute_draft_retention', 'has_intake_records', 'drift_detected', 'assert_drift_free'))
               or (n.nspname = 'public' and p.proname in ('intake_save_template_draft', 'intake_publish_template_version',
                    'intake_set_reintake_floor', 'intake_set_service_assignment', 'intake_update_settings', 'intake_set_retention_choice',
                    'intake_get_status', 'intake_get_answers', 'intake_designate_guardian', 'intake_select_guardian_recipient',
                    'intake_record_minor_determination', 'intake_drift_report', 'intake_extend_draft_retention', 'intake_ensure_request',
                    'intake_save_draft', 'intake_submit_response', 'intake_erase_client', 'intake_release_erasure_barrier',
                    'intake_create_legal_hold', 'intake_release_legal_hold'))) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, intake_destructive', f.sig);
  end loop;
end $$;
grant execute on function public.intake_save_template_draft(uuid, uuid, text, jsonb, boolean, uuid, text) to authenticated;
grant execute on function public.intake_publish_template_version(uuid, uuid) to authenticated;
grant execute on function public.intake_set_reintake_floor(uuid, uuid, int) to authenticated;
grant execute on function public.intake_set_service_assignment(uuid, text, uuid) to authenticated;
grant execute on function public.intake_update_settings(uuid, jsonb) to authenticated;
grant execute on function public.intake_set_retention_choice(uuid, int) to authenticated;
grant execute on function public.intake_get_status(uuid, uuid) to authenticated;
grant execute on function public.intake_get_answers(uuid, uuid) to authenticated;
grant execute on function public.intake_designate_guardian(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.intake_select_guardian_recipient(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.intake_record_minor_determination(uuid, uuid, boolean, text) to authenticated;
grant execute on function public.intake_drift_report(uuid) to authenticated;
grant execute on function public.intake_extend_draft_retention(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.intake_erase_client(uuid, uuid, text, text) to authenticated;
grant execute on function public.intake_release_erasure_barrier(uuid, uuid, text, text) to authenticated;
grant execute on function public.intake_create_legal_hold(uuid, text, uuid, text, text, timestamptz, text) to authenticated;
grant execute on function public.intake_release_legal_hold(uuid, uuid, text) to authenticated;
grant execute on function public.intake_ensure_request(uuid, uuid, uuid, text) to service_role;
grant execute on function public.intake_save_draft(uuid, uuid, text, jsonb, jsonb, int) to service_role;
grant execute on function public.intake_submit_response(uuid, uuid, text, int, jsonb) to service_role;

select intake_private.assert_catalog();

commit;

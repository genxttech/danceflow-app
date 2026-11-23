-- New Student Intake (NSI) I1 -- M3 of 5: live personal records (schema-plan tables 8-16).
--
-- Creates
--   tables  public.intake_requests, public.intake_request_appointments, public.intake_respondents,
--           public.intake_responses, public.intake_response_revisions, public.intake_minor_determinations,
--           public.intake_completions, public.intake_client_relationship_state, public.intake_guardian_designations
--   funcs   intake_private.subject_of, collection_gate, delete_guard, tenant guards, per-table immutability guards,
--           fulfillment_state
-- Depends on: M1 (helpers, gates, tenant checks, assert_catalog), M2 (audit_write, client_has_active_hold,
--   erasure_barrier_active), public.clients, public.client_account_links, auth.users.
-- Rules: live personal rows hard-reference clients with RESTRICT (R1); intake-to-intake references are composite
--   (studio_id, x) (R4); no reference to public.appointments (soft uuid only); tenant/ownership columns immutable
--   (R20); every insert passes Gate A + erasure barrier, and new obligations also Gate B (N1/N3); deletes only by
--   the restricted role and never under an active hold (R18); completions immutable (A4).
-- Privileges (R25): no API-role access; RLS enabled; only intake_destructive may SELECT/DELETE (policy-scoped).
-- Rollback: rollback/20261118092000_nsi_i1_m3_live_personal_rollback.sql (guarded).

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.intake_requests (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  template_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'invited', 'in_progress', 'suspended', 'submitted', 'expired', 'waived', 'cancelled_by_staff')),
  resume_status text null check (resume_status is null or resume_status in ('pending', 'invited', 'in_progress')),
  source text not null check (source in ('auto', 'manual')),
  supersedes_request_id uuid null,
  pinned_version_id uuid null,
  anchor_appointment_id uuid null,
  issued_at timestamptz null,
  submitted_at timestamptz null,
  suspended_at timestamptz null,
  expires_at timestamptz null,
  platform_policy_version int null,
  draft_first_saved_at timestamptz null,
  draft_anchor_appointment_id uuid null,
  draft_anchor_kind text null check (draft_anchor_kind is null or draft_anchor_kind in ('appointment_end', 'appointment_cancelled')),
  draft_anchor_at timestamptz null,
  draft_max_at timestamptz null,
  draft_protected_appointment_id uuid null,
  draft_protected_until timestamptz null,
  draft_extension_count int not null default 0 check (draft_extension_count >= 0),
  draft_last_extension_by uuid null,
  draft_last_extension_at timestamptz null,
  draft_last_extension_reason text null check (draft_last_extension_reason is null or char_length(draft_last_extension_reason) <= 1000),
  draft_purge_after timestamptz null,
  guardian_recipient_link_id uuid null references public.client_account_links(id) on delete set null,
  guardian_recipient_basis text null check (guardian_recipient_basis is null or guardian_recipient_basis in ('sole_verified', 'designated_primary', 'staff_selected')),
  guardian_recipient_selected_by uuid null,
  guardian_recipient_selected_at timestamptz null,
  guardian_routing_generation int not null default 0 check (guardian_routing_generation >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint intake_requests_studio_id_key unique (studio_id, id),
  constraint intake_requests_template_fk foreign key (studio_id, template_id)
    references public.intake_templates (studio_id, id) on delete restrict,
  constraint intake_requests_pinned_fk foreign key (studio_id, pinned_version_id)
    references public.intake_template_versions (studio_id, id) on delete restrict,
  constraint intake_requests_supersedes_fk foreign key (studio_id, supersedes_request_id)
    references public.intake_requests (studio_id, id) on delete set null (supersedes_request_id),
  constraint intake_requests_draft_dates check (draft_first_saved_at is null or (draft_purge_after is not null and draft_max_at is not null)),
  constraint intake_requests_protection_pair check (draft_protected_until is null or draft_protected_appointment_id is not null),
  constraint intake_requests_extension_actor check (draft_extension_count = 0 or draft_last_extension_by is not null),
  constraint intake_requests_suspend_resume check ((status = 'suspended') = (resume_status is not null)),
  constraint intake_requests_not_self check (supersedes_request_id is null or supersedes_request_id <> id)
);
create unique index if not exists intake_requests_one_open
  on public.intake_requests (studio_id, client_id, template_id) where status in ('pending', 'invited', 'in_progress', 'suspended');
create index if not exists intake_requests_studio_status on public.intake_requests (studio_id, status);
create index if not exists intake_requests_client on public.intake_requests (client_id);
create index if not exists intake_requests_draft_purge on public.intake_requests (studio_id, draft_purge_after) where draft_purge_after is not null;
create index if not exists intake_requests_anchor on public.intake_requests (studio_id, anchor_appointment_id) where anchor_appointment_id is not null;

create table if not exists public.intake_request_appointments (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  request_id uuid not null,
  appointment_id uuid not null,
  attached_by text not null check (attached_by in ('reconciler', 'staff')),
  attached_by_user uuid null,
  detached_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint intake_request_appointments_studio_id_key unique (studio_id, id),
  constraint intake_request_appointments_request_fk foreign key (studio_id, request_id)
    references public.intake_requests (studio_id, id) on delete cascade,
  constraint intake_request_appointments_pair_key unique (request_id, appointment_id)
);

create table if not exists public.intake_respondents (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  request_id uuid not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  role text not null check (role in ('student', 'guardian')),
  display_name text not null check (char_length(display_name) between 1 and 200),
  email text null check (email is null or char_length(email) <= 320),
  email_hmac text null check (email_hmac is null or char_length(email_hmac) <= 128),
  email_hmac_kid smallint null,
  declared_relationship text null check (declared_relationship is null or declared_relationship in ('parent', 'legal_guardian', 'other_authorized')),
  auth_user_id uuid null references auth.users(id) on delete set null,
  source_link_id uuid null references public.client_account_links(id) on delete set null,
  assurance text not null check (assurance in ('link_verified', 'email_code_verified', 'declared_unverified', 'staff_attested')),
  assurance_at timestamptz not null default now(),
  superseded_at timestamptz null,
  redacted_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint intake_respondents_studio_id_key unique (studio_id, id),
  constraint intake_respondents_request_fk foreign key (studio_id, request_id)
    references public.intake_requests (studio_id, id) on delete restrict,
  constraint intake_respondents_hmac_pair check ((email_hmac is null) = (email_hmac_kid is null)),
  constraint intake_respondents_guardian_relationship check (role = 'student' or declared_relationship is not null)
);
create index if not exists intake_respondents_request on public.intake_respondents (request_id);

create table if not exists public.intake_responses (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  request_id uuid not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  audience text not null check (audience in ('student', 'guardian')),
  respondent_id uuid null,
  template_version_id uuid not null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'superseded')),
  revision int not null default 1 check (revision >= 1),
  answers jsonb null check (answers is null or (jsonb_typeof(answers) = 'object' and octet_length(answers::text) <= 262144)),
  submitted_at timestamptz null,
  last_saved_at timestamptz not null default now(),
  retention_state text not null default 'active'
    check (retention_state in ('active', 'clock_running', 'clock_pending_policy', 'redaction_due', 'redacted')),
  platform_policy_version int null,
  retention_choice_id uuid null,
  notice_version text null check (notice_version is null or char_length(notice_version) <= 200),
  answers_redact_after timestamptz null,
  redacted_at timestamptz null,
  redacted_by uuid null,
  redaction_reason text null check (redaction_reason is null or redaction_reason in
    ('draft_purge', 'retention_expiry', 'staff_request', 'subject_request', 'guardian_request', 'superseded_draft')),
  created_at timestamptz not null default now(),
  constraint intake_responses_studio_id_key unique (studio_id, id),
  constraint intake_responses_request_fk foreign key (studio_id, request_id)
    references public.intake_requests (studio_id, id) on delete restrict,
  constraint intake_responses_respondent_fk foreign key (studio_id, respondent_id)
    references public.intake_respondents (studio_id, id) on delete restrict,
  constraint intake_responses_version_fk foreign key (studio_id, template_version_id)
    references public.intake_template_versions (studio_id, id) on delete restrict,
  constraint intake_responses_retention_choice_fk foreign key (studio_id, retention_choice_id)
    references public.intake_studio_retention_choices (studio_id, id) on delete restrict,
  constraint intake_responses_clock_has_date check (retention_state <> 'clock_running' or answers_redact_after is not null),
  constraint intake_responses_redacted_no_answers check (redacted_at is null or answers is null),
  constraint intake_responses_redacted_state check ((retention_state = 'redacted') = (redacted_at is not null)),
  constraint intake_responses_submitted_at check ((status = 'submitted') = (submitted_at is not null) or status = 'superseded')
);
create unique index if not exists intake_responses_one_live_per_audience
  on public.intake_responses (request_id, audience) where status in ('draft', 'submitted');
create index if not exists intake_responses_client on public.intake_responses (client_id);
create index if not exists intake_responses_redact_due on public.intake_responses (studio_id, answers_redact_after)
  where redacted_at is null and answers_redact_after is not null;

create table if not exists public.intake_response_revisions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  response_id uuid not null,
  revision int not null check (revision >= 1),
  answers jsonb null check (answers is null or (jsonb_typeof(answers) = 'object' and octet_length(answers::text) <= 262144)),
  changed_by_actor text not null check (changed_by_actor in ('student', 'guardian', 'staff', 'system')),
  changed_by_user uuid null,
  reason text null check (reason is null or char_length(reason) <= 1000),
  created_at timestamptz not null default now(),
  constraint intake_response_revisions_studio_id_key unique (studio_id, id),
  constraint intake_response_revisions_response_fk foreign key (studio_id, response_id)
    references public.intake_responses (studio_id, id) on delete restrict,
  constraint intake_response_revisions_key unique (response_id, revision)
);

create table if not exists public.intake_minor_determinations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  request_id uuid not null,
  is_minor boolean not null,
  source text not null check (source in ('birthday', 'declared', 'staff_override')),
  evaluated_on date not null,
  threshold smallint not null check (threshold between 13 and 21),
  declared_value_class text null check (declared_value_class is null or char_length(declared_value_class) <= 32),
  actor_user_id uuid null,
  reason text null check (reason is null or char_length(reason) <= 1000),
  created_at timestamptz not null default clock_timestamp(),
  constraint intake_minor_determinations_studio_id_key unique (studio_id, id),
  constraint intake_minor_determinations_request_fk foreign key (studio_id, request_id)
    references public.intake_requests (studio_id, id) on delete restrict,
  constraint intake_minor_determinations_override_reason check (
    source <> 'staff_override' or (reason is not null and btrim(reason) <> '' and actor_user_id is not null))
);
create index if not exists intake_minor_determinations_request on public.intake_minor_determinations (request_id, created_at desc);

create table if not exists public.intake_completions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  request_id uuid not null,
  client_id uuid not null references public.clients(id) on delete restrict,
  template_id uuid not null,
  template_version_id uuid not null,
  version_number int not null check (version_number >= 1),
  student_response_id uuid null,
  guardian_response_id uuid null,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint intake_completions_studio_id_key unique (studio_id, id),
  constraint intake_completions_request_key unique (request_id),
  constraint intake_completions_request_fk foreign key (studio_id, request_id)
    references public.intake_requests (studio_id, id) on delete restrict,
  constraint intake_completions_template_fk foreign key (studio_id, template_id)
    references public.intake_templates (studio_id, id) on delete restrict,
  constraint intake_completions_version_fk foreign key (studio_id, template_version_id)
    references public.intake_template_versions (studio_id, id) on delete restrict,
  constraint intake_completions_student_fk foreign key (studio_id, student_response_id)
    references public.intake_responses (studio_id, id) on delete restrict,
  constraint intake_completions_guardian_fk foreign key (studio_id, guardian_response_id)
    references public.intake_responses (studio_id, id) on delete restrict,
  constraint intake_completions_has_response check (student_response_id is not null or guardian_response_id is not null)
);
create index if not exists intake_completions_client on public.intake_completions (client_id, template_id, completed_at desc);

create table if not exists public.intake_client_relationship_state (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  state text not null default 'active' check (state in ('active', 'ended')),
  ended_at timestamptz null,
  ended_basis text null check (ended_basis is null or ended_basis in ('staff_marked', 'client_erasure')),
  marked_by uuid null,
  reactivated_at timestamptz null,
  platform_policy_version int null,
  retention_choice_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint intake_client_relationship_state_studio_id_key unique (studio_id, id),
  constraint intake_client_relationship_state_client_key unique (client_id),
  constraint intake_client_relationship_state_ended check ((state = 'ended') = (ended_at is not null and ended_basis is not null))
);

create table if not exists public.intake_guardian_designations (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  link_id uuid null references public.client_account_links(id) on delete set null,
  designated_by uuid not null,
  designated_at timestamptz not null default now(),
  reason text null check (reason is null or char_length(reason) <= 1000),
  superseded_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint intake_guardian_designations_studio_id_key unique (studio_id, id)
);
create unique index if not exists intake_guardian_designations_one_active
  on public.intake_guardian_designations (studio_id, client_id) where superseded_at is null;

-- R25
revoke all on public.intake_requests, public.intake_request_appointments, public.intake_respondents,
  public.intake_responses, public.intake_response_revisions, public.intake_minor_determinations,
  public.intake_completions, public.intake_client_relationship_state, public.intake_guardian_designations
  from public, anon, authenticated, service_role;
alter table public.intake_requests enable row level security;
alter table public.intake_request_appointments enable row level security;
alter table public.intake_respondents enable row level security;
alter table public.intake_responses enable row level security;
alter table public.intake_response_revisions enable row level security;
alter table public.intake_minor_determinations enable row level security;
alter table public.intake_completions enable row level security;
alter table public.intake_client_relationship_state enable row level security;
alter table public.intake_guardian_designations enable row level security;
grant select, delete on public.intake_requests, public.intake_request_appointments, public.intake_respondents,
  public.intake_responses, public.intake_response_revisions, public.intake_minor_determinations,
  public.intake_completions, public.intake_client_relationship_state, public.intake_guardian_designations
  to intake_destructive;

do $$
declare t text;
begin
  foreach t in array array['intake_requests', 'intake_request_appointments', 'intake_respondents', 'intake_responses',
    'intake_response_revisions', 'intake_minor_determinations', 'intake_completions',
    'intake_client_relationship_state', 'intake_guardian_designations'] loop
    execute format('drop policy if exists %I on public.%I', t || '_destructive_select', t);
    execute format('create policy %I on public.%I for select to intake_destructive using (true)', t || '_destructive_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_destructive_delete', t);
    execute format('create policy %I on public.%I for delete to intake_destructive using (true)', t || '_destructive_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Subject resolution (studio, client) for any live personal row; used by the gate and delete guard.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function intake_private.subject_of(p_table text, p_request_id uuid, p_response_id uuid)
returns uuid language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_client uuid;
begin
  if p_response_id is not null then
    select r.client_id into v_client from public.intake_responses r where r.id = p_response_id;
  elsif p_request_id is not null then
    select q.client_id into v_client from public.intake_requests q where q.id = p_request_id;
  end if;
  return v_client;
end $$;

-- Collection gate (N1/N3/N6). TG_ARGV[0] = 'new_obligation' adds Gate B.
create or replace function intake_private.collection_gate()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_studio uuid := (v_row ->> 'studio_id')::uuid;
  v_client uuid := coalesce((v_row ->> 'client_id')::uuid, (v_row ->> 'client_ref')::uuid);
begin
  if v_client is null then
    v_client := intake_private.subject_of(tg_table_name, coalesce((v_row ->> 'request_id')::uuid, (v_row ->> 'request_ref')::uuid),
                                          (v_row ->> 'response_id')::uuid);
  end if;
  if v_client is null and tg_table_name = 'intake_consent_evidence_identity' then
    select e.client_ref into v_client from public.intake_consent_evidence e where e.id = new.evidence_id;
  end if;
  if not intake_private.retention_gate_open() then
    raise exception 'nsi: retention_policy_incomplete (platform retention periods are not approved)' using errcode = '42501';
  end if;
  if tg_nargs > 0 and tg_argv[0] = 'new_obligation' and not intake_private.new_obligation_allowed(v_studio) then
    raise exception 'nsi: new_obligation_not_allowed (studio intake disabled or not entitled)' using errcode = '42501';
  end if;
  if v_client is null or intake_private.erasure_barrier_active(v_studio, v_client) then
    raise exception 'nsi: erasure_barrier_active (no new intake records for an erased client)' using errcode = '42501';
  end if;
  perform intake_private.audit_write(null, null, null, null, null, null, null, null, null, null, null, 'environment_marker');
  return new;
end $$;

-- Deletes only by the restricted role, never under an active hold on the subject (R18, R2).
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

-- Assurance ordering (N5): link_verified > email_code_verified = staff_attested > declared_unverified.
create or replace function intake_private.assurance_rank(p_assurance text)
returns int language sql immutable
set search_path = pg_catalog, pg_temp
as $$
  select case p_assurance when 'link_verified' then 3 when 'email_code_verified' then 2 when 'staff_attested' then 2
                          when 'declared_unverified' then 0 else null end;
$$;

-- Tenant consistency and reference coherence at insert (R5, P2-10). Updates of these columns are refused by the
-- immutability guards. Respondent assurance is verified against authoritative rows (P1-2): link_verified needs a
-- verified link of this client (guardian or own account) and binds auth_user_id to that link's account;
-- email_code_verified and staff_attested need verification records that arrive with I3, so I1 refuses them.
create or replace function intake_private.tenant_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_studio uuid := (v_row ->> 'studio_id')::uuid;
  v_client uuid := (v_row ->> 'client_id')::uuid;
  v_req_client uuid;
  v_req public.intake_requests;
  v_link_user uuid;
begin
  if v_row ? 'client_id' then
    perform intake_private.assert_client_in_studio(v_studio, v_client);
  end if;
  if v_row ? 'request_id' and v_row ? 'client_id' then
    select q.client_id into v_req_client from public.intake_requests q where q.id = (v_row ->> 'request_id')::uuid;
    if v_req_client is distinct from v_client then
      raise exception 'nsi: row client does not match the request client' using errcode = '42501';
    end if;
  end if;
  if tg_table_name = 'intake_requests' then
    perform intake_private.assert_link_for_client(v_studio, v_client, (v_row ->> 'guardian_recipient_link_id')::uuid);
    if new.pinned_version_id is not null and not exists (
         select 1 from public.intake_template_versions v
         where v.id = new.pinned_version_id and v.studio_id = new.studio_id and v.template_id = new.template_id
           and v.status = 'published') then
      raise exception 'nsi: pinned version must be a published version of the request template' using errcode = '42501';
    end if;
    if new.supersedes_request_id is not null and not exists (
         select 1 from public.intake_requests q where q.id = new.supersedes_request_id and q.client_id = new.client_id) then
      raise exception 'nsi: superseded request belongs to another client' using errcode = '42501';
    end if;
  elsif tg_table_name = 'intake_respondents' then
    perform intake_private.assert_link_for_client(v_studio, v_client, new.source_link_id);
    if new.assurance = 'link_verified' then
      if new.source_link_id is null
         or not (case when new.role = 'guardian' then intake_private.link_is_verified_guardian(v_studio, v_client, new.source_link_id)
                      else intake_private.link_is_verified_self(v_studio, v_client, new.source_link_id) end) then
        raise exception 'nsi: link_verified assurance requires a verified % link of this client', new.role using errcode = '42501';
      end if;
      select l.user_id into v_link_user from public.client_account_links l where l.id = new.source_link_id;
      if new.auth_user_id is distinct from v_link_user then
        raise exception 'nsi: respondent account must be the verified link''s account' using errcode = '42501';
      end if;
    elsif new.assurance in ('email_code_verified', 'staff_attested') then
      raise exception 'nsi: % assurance requires a verification record (not available in this release)', new.assurance
        using errcode = '42501';
    elsif new.auth_user_id is not null then
      raise exception 'nsi: an account can be attached to a respondent only through a verified link' using errcode = '42501';
    end if;
  elsif tg_table_name = 'intake_responses' then
    if new.respondent_id is not null and not exists (
         select 1 from public.intake_respondents p
         where p.id = new.respondent_id and p.request_id = new.request_id and p.role = new.audience and p.superseded_at is null) then
      raise exception 'nsi: respondent does not belong to this request and audience' using errcode = '42501';
    end if;
  elsif tg_table_name = 'intake_completions' then
    select * into v_req from public.intake_requests q where q.id = new.request_id;
    if v_req.template_id is distinct from new.template_id or v_req.pinned_version_id is distinct from new.template_version_id
       or not exists (select 1 from public.intake_template_versions v
                      where v.id = new.template_version_id and v.version_number = new.version_number) then
      raise exception 'nsi: completion must match the request template and pinned version' using errcode = '42501';
    end if;
    if (new.student_response_id is not null and not exists (
          select 1 from public.intake_responses x where x.id = new.student_response_id and x.request_id = new.request_id
            and x.audience = 'student' and x.status = 'submitted'))
       or (new.guardian_response_id is not null and not exists (
          select 1 from public.intake_responses x where x.id = new.guardian_response_id and x.request_id = new.request_id
            and x.audience = 'guardian' and x.status = 'submitted')) then
      raise exception 'nsi: completion responses must be submitted responses of this request' using errcode = '42501';
    end if;
  elsif tg_table_name = 'intake_guardian_designations' then
    if new.link_id is null or not intake_private.link_is_verified_guardian(v_studio, v_client, new.link_id) then
      raise exception 'nsi: designation requires a verified guardian link of this client' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Immutability guards (R20, A4, status machine)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function intake_private.requests_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare v_ok boolean;
begin
  if new.id <> old.id or new.studio_id <> old.studio_id or new.client_id <> old.client_id
     or new.template_id <> old.template_id or new.source <> old.source or new.created_at <> old.created_at
     or (new.supersedes_request_id is distinct from old.supersedes_request_id and new.supersedes_request_id is not null) then
    raise exception 'nsi: request ownership references are immutable' using errcode = '42501';
  end if;
  if old.pinned_version_id is not null and new.pinned_version_id is distinct from old.pinned_version_id then
    raise exception 'nsi: pinned template version is immutable once set' using errcode = '42501';
  end if;
  if old.pinned_version_id is null and new.pinned_version_id is not null and not exists (
       select 1 from public.intake_template_versions v
       where v.id = new.pinned_version_id and v.studio_id = new.studio_id and v.template_id = new.template_id
         and v.status = 'published') then
    raise exception 'nsi: pinned version must be a published version of the request template' using errcode = '42501';
  end if;
  if new.guardian_recipient_link_id is distinct from old.guardian_recipient_link_id and new.guardian_recipient_link_id is not null then
    perform intake_private.assert_link_for_client(new.studio_id, new.client_id, new.guardian_recipient_link_id);
  end if;
  if new.status <> old.status then
    v_ok := case old.status
      when 'pending' then new.status in ('invited', 'suspended', 'expired', 'waived', 'cancelled_by_staff')
      when 'invited' then new.status in ('in_progress', 'submitted', 'suspended', 'expired', 'waived', 'cancelled_by_staff')
      when 'in_progress' then new.status in ('submitted', 'suspended', 'expired', 'waived', 'cancelled_by_staff')
      when 'suspended' then new.status in ('pending', 'invited', 'in_progress', 'expired', 'waived', 'cancelled_by_staff')
      else false end;
    if not v_ok or (old.status = 'suspended' and new.status in ('pending', 'invited', 'in_progress') and new.status <> old.resume_status) then
      raise exception 'nsi: invalid request status transition % -> %', old.status, new.status using errcode = '22023';
    end if;
  end if;
  if old.draft_extension_count > new.draft_extension_count then
    raise exception 'nsi: draft extension count cannot decrease' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function intake_private.request_appointments_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id <> old.id or new.studio_id <> old.studio_id or new.request_id <> old.request_id
     or new.appointment_id <> old.appointment_id or new.attached_by <> old.attached_by
     or new.attached_by_user is distinct from old.attached_by_user or new.created_at <> old.created_at
     or (old.detached_at is not null and new.detached_at is distinct from old.detached_at) then
    raise exception 'nsi: request appointment links are append-only' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function intake_private.respondents_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id <> old.id or new.studio_id <> old.studio_id or new.request_id <> old.request_id
     or new.client_id <> old.client_id or new.role <> old.role or new.display_name <> old.display_name
     or new.declared_relationship is distinct from old.declared_relationship or new.assurance <> old.assurance
     or new.assurance_at <> old.assurance_at or new.created_at <> old.created_at
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

-- Responses: pin and ownership immutable; drafts editable; submitted rows change only by redaction (restricted role)
-- or by retention-clock stamping; a guardian response may join a submitted request only while consent is outstanding.
create or replace function intake_private.responses_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_req public.intake_requests;
begin
  if tg_op = 'INSERT' then
    select * into v_req from public.intake_requests q where q.id = new.request_id;
    if v_req.pinned_version_id is null or new.template_version_id <> v_req.pinned_version_id then
      raise exception 'nsi: response must use the request''s pinned template version' using errcode = '42501';
    end if;
    if v_req.status not in ('invited', 'in_progress', 'submitted') then
      raise exception 'nsi: request is not open for answers (status %)', v_req.status using errcode = '42501';
    end if;
    if v_req.status = 'submitted' and not (new.audience = 'guardian'
         and intake_private.fulfillment_state(new.request_id) = 'guardian_consent_outstanding') then
      raise exception 'nsi: request already submitted' using errcode = '42501';
    end if;
    if new.status <> 'draft' then
      raise exception 'nsi: responses start as drafts' using errcode = '22023';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.studio_id <> old.studio_id or new.request_id <> old.request_id
     or new.client_id <> old.client_id or new.audience <> old.audience
     or new.template_version_id <> old.template_version_id or new.created_at <> old.created_at
     or (old.respondent_id is not null and new.respondent_id is distinct from old.respondent_id) then
    raise exception 'nsi: response ownership references are immutable' using errcode = '42501';
  end if;
  if old.status = 'submitted' then
    if new.status <> 'submitted' or new.revision <> old.revision or new.submitted_at <> old.submitted_at
       or new.last_saved_at <> old.last_saved_at then
      raise exception 'nsi: submitted responses are immutable' using errcode = '42501';
    end if;
    if new.answers is distinct from old.answers or new.redacted_at is distinct from old.redacted_at
       or new.redaction_reason is distinct from old.redaction_reason or new.redacted_by is distinct from old.redacted_by then
      if current_user <> 'intake_destructive' or new.answers is not null or new.redacted_at is null
         or old.redacted_at is not null then
        raise exception 'nsi: submitted responses change only by redaction by the restricted role' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;
  if old.status = 'superseded' then
    if new.status <> 'superseded' or new.revision <> old.revision then
      raise exception 'nsi: superseded responses are immutable' using errcode = '42501';
    end if;
    if new.answers is distinct from old.answers and (current_user <> 'intake_destructive' or new.answers is not null) then
      raise exception 'nsi: superseded responses change only by redaction by the restricted role' using errcode = '42501';
    end if;
    return new;
  end if;
  -- draft
  if old.respondent_id is null and new.respondent_id is not null and not exists (
       select 1 from public.intake_respondents p
       where p.id = new.respondent_id and p.request_id = new.request_id and p.role = new.audience and p.superseded_at is null) then
    raise exception 'nsi: respondent does not belong to this request and audience' using errcode = '42501';
  end if;
  if new.status = 'submitted' then
    if new.answers is null or new.respondent_id is null then
      raise exception 'nsi: a submitted response needs answers and a respondent' using errcode = '22023';
    end if;
    select * into v_req from public.intake_requests q where q.id = new.request_id;
    if v_req.status not in ('invited', 'in_progress', 'submitted') then
      raise exception 'nsi: request is not open for answers (status %)', v_req.status using errcode = '42501';
    end if;
  end if;
  if new.revision < old.revision then
    raise exception 'nsi: revision cannot decrease' using errcode = '22023';
  end if;
  return new;
end $$;

create or replace function intake_private.append_only_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Revisions: the only change allowed is redaction of answers by the restricted role. (Field access is via jsonb so
  -- the same guard is safe on tables without an answers column.)
  if tg_table_name = 'intake_response_revisions' and current_user = 'intake_destructive' then
    if (to_jsonb(new) -> 'answers') = 'null'::jsonb and (to_jsonb(old) -> 'answers') <> 'null'::jsonb
       and (to_jsonb(new) - 'answers') = (to_jsonb(old) - 'answers') then
      return new;
    end if;
  end if;
  raise exception 'nsi: % rows are immutable', tg_table_name using errcode = '42501';
end $$;

create or replace function intake_private.relationship_state_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id <> old.id or new.studio_id <> old.studio_id or new.client_id <> old.client_id or new.created_at <> old.created_at then
    raise exception 'nsi: relationship state ownership is immutable' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function intake_private.designations_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id <> old.id or new.studio_id <> old.studio_id or new.client_id <> old.client_id
     or new.designated_by <> old.designated_by or new.designated_at <> old.designated_at
     or new.reason is distinct from old.reason or new.created_at <> old.created_at
     or (new.link_id is distinct from old.link_id and new.link_id is not null)
     or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) then
    raise exception 'nsi: guardian designations are immutable except supersession' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Derived fulfillment (A4, N5). Completions are never updated.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function intake_private.fulfillment_state(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_minor boolean;
  v_satisfied boolean := false;
begin
  if not exists (select 1 from public.intake_completions c where c.request_id = p_request_id) then
    return 'incomplete';
  end if;
  select d.is_minor into v_minor from public.intake_minor_determinations d
  where d.request_id = p_request_id order by d.created_at desc, d.id desc limit 1;
  if coalesce(v_minor, false) = false then
    return 'complete';
  end if;
  if to_regclass('public.intake_consent_evidence') is not null then
    select exists (
      select 1 from public.intake_responses r
      join public.intake_respondents p on p.id = r.respondent_id
      join public.intake_consent_evidence e on e.request_ref = r.request_id and e.respondent_ref = p.id
      where r.request_id = p_request_id and r.audience = 'guardian' and r.status = 'submitted' and p.superseded_at is null
        and e.event_type in ('acknowledged', 'attested')
        and coalesce(intake_private.assurance_rank(p.assurance), 0) >= coalesce(intake_private.assurance_rank(e.required_assurance), 99))
    into v_satisfied;
  end if;
  return case when v_satisfied then 'complete' else 'guardian_consent_outstanding' end;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['intake_requests', 'intake_request_appointments', 'intake_respondents', 'intake_responses',
    'intake_response_revisions', 'intake_minor_determinations', 'intake_completions',
    'intake_client_relationship_state', 'intake_guardian_designations'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_10_gate', t);
    if t in ('intake_requests', 'intake_request_appointments') then
      execute format('create trigger %I before insert on public.%I for each row execute function intake_private.collection_gate(%L)', t || '_10_gate', t, 'new_obligation');
    else
      execute format('create trigger %I before insert on public.%I for each row execute function intake_private.collection_gate(%L)', t || '_10_gate', t, 'continuing');
    end if;
    execute format('drop trigger if exists %I on public.%I', t || '_20_tenant', t);
    execute format('create trigger %I before insert on public.%I for each row execute function intake_private.tenant_guard()', t || '_20_tenant', t);
    execute format('drop trigger if exists %I on public.%I', t || '_90_delete', t);
    execute format('create trigger %I before delete on public.%I for each row execute function intake_private.delete_guard()', t || '_90_delete', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function intake_private.refuse_truncate()', t || '_no_truncate', t);
  end loop;
end $$;

drop trigger if exists intake_requests_30_guard on public.intake_requests;
create trigger intake_requests_30_guard before update on public.intake_requests
  for each row execute function intake_private.requests_guard();
drop trigger if exists intake_requests_40_touch on public.intake_requests;
create trigger intake_requests_40_touch before update on public.intake_requests
  for each row execute function intake_private.touch_updated_at();
drop trigger if exists intake_request_appointments_30_guard on public.intake_request_appointments;
create trigger intake_request_appointments_30_guard before update on public.intake_request_appointments
  for each row execute function intake_private.request_appointments_guard();
drop trigger if exists intake_respondents_30_guard on public.intake_respondents;
create trigger intake_respondents_30_guard before update on public.intake_respondents
  for each row execute function intake_private.respondents_guard();
drop trigger if exists intake_responses_30_guard on public.intake_responses;
create trigger intake_responses_30_guard before insert or update on public.intake_responses
  for each row execute function intake_private.responses_guard();
drop trigger if exists intake_response_revisions_30_guard on public.intake_response_revisions;
create trigger intake_response_revisions_30_guard before update on public.intake_response_revisions
  for each row execute function intake_private.append_only_guard();
drop trigger if exists intake_minor_determinations_30_guard on public.intake_minor_determinations;
create trigger intake_minor_determinations_30_guard before update on public.intake_minor_determinations
  for each row execute function intake_private.append_only_guard();
drop trigger if exists intake_completions_30_guard on public.intake_completions;
create trigger intake_completions_30_guard before update on public.intake_completions
  for each row execute function intake_private.append_only_guard();
drop trigger if exists intake_client_relationship_state_30_guard on public.intake_client_relationship_state;
create trigger intake_client_relationship_state_30_guard before update on public.intake_client_relationship_state
  for each row execute function intake_private.relationship_state_guard();
drop trigger if exists intake_client_relationship_state_40_touch on public.intake_client_relationship_state;
create trigger intake_client_relationship_state_40_touch before update on public.intake_client_relationship_state
  for each row execute function intake_private.touch_updated_at();
drop trigger if exists intake_guardian_designations_30_guard on public.intake_guardian_designations;
create trigger intake_guardian_designations_30_guard before update on public.intake_guardian_designations
  for each row execute function intake_private.designations_guard();

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'intake_private' and p.proname in ('subject_of', 'collection_gate', 'delete_guard',
             'tenant_guard', 'requests_guard', 'request_appointments_guard', 'respondents_guard', 'responses_guard',
             'append_only_guard', 'relationship_state_guard', 'designations_guard', 'assurance_rank', 'fulfillment_state') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end $$;
grant execute on function intake_private.subject_of(text, uuid, uuid) to intake_destructive;
grant execute on function intake_private.fulfillment_state(uuid) to intake_destructive;

select intake_private.assert_catalog();

commit;

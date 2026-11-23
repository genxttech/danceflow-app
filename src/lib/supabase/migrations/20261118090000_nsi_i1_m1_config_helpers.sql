-- New Student Intake (NSI) I1 -- M1 of 5: configuration, platform policy, helpers, restricted role, private schema.
--
-- Design: docs/student-intake/NSI_I1_Schema_Plan.md (rev 4.3) and NSI_I1_Implementation_Plan.md.
-- Ships DARK: the platform retention policy returns NULL for every non-draft period, so the collection gate
-- (Gate A) stays closed and no personal intake data can be written.
--
-- Creates
--   role    intake_destructive (NOLOGIN NOINHERIT NOBYPASSRLS) + GRANT intake_destructive TO postgres WITH SET TRUE, INHERIT FALSE
--   schema  intake_private (not exposed to PostgREST; USAGE/CREATE only for intake_destructive)
--   tables  public.intake_templates, public.intake_template_versions, public.intake_service_assignments,
--           public.intake_studio_retention_choices, public.intake_settings           (schema-plan tables 1-5; config)
--   funcs   public.intake_platform_policy()                       -- migration-controlled platform retention authority
--           public.intake_is_platform_admin(), public.intake_has_staff_role(uuid)   -- RLS helpers (boolean only)
--           intake_private.studio_role, assert_staff, retention_gate_open, new_obligation_allowed,
--           assert_client_in_studio, assert_link_for_client, link_is_verified_guardian, assert_document_version,
--           assert_envelope, touch_updated_at, refuse_truncate, version guards, floor guard, append-only guard,
--           assert_catalog (fail-closed privilege/RLS/owner/search_path self-check, called last in every NSI migration)
-- Depends on (existing): public.studios, public.clients, public.client_account_links, public.document_templates,
--   public.document_template_versions, public.document_sign_envelopes, public.profiles, public.user_studio_roles,
--   type public.app_role, type public.appointment_type.
-- Does NOT touch public.appointments or any existing table.
-- Privileges (rule R25): every object created here is revoked from PUBLIC, anon, authenticated, service_role in this
--   migration, then granted only as listed; tables have RLS enabled; assert_catalog() runs last.
-- Rollback: rollback/20261118090000_nsi_i1_m1_config_helpers_rollback.sql (guarded; refuses if intake data exists).

begin;

-- Bounded wait for the locks taken by the FK additions (studios, clients, client_account_links, auth.users):
-- fail fast instead of queueing behind a long transaction.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------------------------
-- Restricted role and private schema (rehearsed pattern: SET membership; implementations created AS the role in M5)
-- ---------------------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'intake_destructive') then
    create role intake_destructive nologin noinherit nobypassrls;
  end if;
end $$;
grant intake_destructive to postgres with set true, inherit false;

create schema if not exists intake_private;
revoke all on schema intake_private from public, anon, authenticated, service_role, intake_destructive;
-- USAGE only. M5 grants CREATE to the role for the duration of its own transaction (to create the role-owned
-- implementation) and revokes it again before commit.
grant usage on schema intake_private to intake_destructive;

-- ---------------------------------------------------------------------------------------------------------------
-- Shared trigger helpers
-- ---------------------------------------------------------------------------------------------------------------
create or replace function intake_private.touch_updated_at()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function intake_private.refuse_truncate()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'nsi: TRUNCATE of % is not permitted', tg_table_name using errcode = '42501';
end $$;

-- Config rows may disappear only through the studio CASCADE (rule R8); any other delete/update is refused.
create or replace function intake_private.config_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.studios s where s.id = old.studio_id) then
      raise exception 'nsi: % rows are append-only', tg_table_name using errcode = '42501';
    end if;
    return old;
  end if;
  raise exception 'nsi: % rows are append-only', tg_table_name using errcode = '42501';
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Platform retention authority (A1): values change only by a reviewed migration. NULL = not approved.
-- Draft values (90/180/90) are owner-approved; every other period stays NULL, keeping Gate A closed (I1 is dark).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.intake_platform_policy()
returns table (
  policy_version int,
  draft_retention_days int,
  draft_max_days int,
  draft_protected_window_days int,
  post_relationship_max_days int,
  evidence_core_days int,
  evidence_identity_days int,
  audit_operational_days int,
  audit_security_days int,
  hold_record_days_after_release int,
  approved_basis_ref text
)
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  select 1, 90, 180, 90, null::int, null::int, null::int, null::int, null::int, null::int, null::text;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Config tables (schema-plan tables 1-5). Studio FK CASCADE (non-personal configuration, rule R8).
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.intake_templates (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'archived')),
  reintake_floor_version int null check (reintake_floor_version is null or reintake_floor_version >= 1),
  floor_effective_at timestamptz null,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint intake_templates_studio_id_key unique (studio_id, id),
  constraint intake_templates_floor_pair check ((reintake_floor_version is null) = (floor_effective_at is null))
);

create table if not exists public.intake_template_versions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  template_id uuid not null,
  version_number int not null check (version_number >= 1),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  schema jsonb not null check (jsonb_typeof(schema) = 'object' and octet_length(schema::text) <= 131072),
  schema_sha256 text null,
  max_answer_bytes int null check (max_answer_bytes is null or max_answer_bytes between 1 and 262144),
  reintake_required boolean not null default false,
  document_template_version_ref uuid null,
  privacy_notice_version text null check (privacy_notice_version is null or char_length(privacy_notice_version) <= 200),
  published_at timestamptz null,
  published_by uuid null,
  archived_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint intake_template_versions_studio_id_key unique (studio_id, id),
  constraint intake_template_versions_template_number_key unique (template_id, version_number),
  constraint intake_template_versions_template_fk foreign key (studio_id, template_id)
    references public.intake_templates (studio_id, id) on delete no action,
  constraint intake_template_versions_published_complete check (
    status = 'draft' or (schema_sha256 is not null and max_answer_bytes is not null and published_at is not null))
);
create unique index if not exists intake_template_versions_one_draft
  on public.intake_template_versions (template_id) where status = 'draft';

create table if not exists public.intake_service_assignments (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  appointment_type public.appointment_type not null
    check (appointment_type in ('private_lesson', 'intro_lesson', 'coaching')),
  template_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint intake_service_assignments_studio_id_key unique (studio_id, id),
  constraint intake_service_assignments_type_key unique (studio_id, appointment_type),
  constraint intake_service_assignments_template_fk foreign key (studio_id, template_id)
    references public.intake_templates (studio_id, id) on delete no action
);

-- Studio retention choice: only the post-relationship duration, capped by the platform maximum (A1).
create table if not exists public.intake_studio_retention_choices (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  version int not null check (version >= 1),
  effective_from timestamptz not null default now(),
  post_relationship_days int null check (post_relationship_days is null or post_relationship_days >= 1),
  platform_policy_version int not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint intake_studio_retention_choices_studio_id_key unique (studio_id, id),
  constraint intake_studio_retention_choices_version_key unique (studio_id, version)
);

create table if not exists public.intake_settings (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  enabled boolean not null default false,
  enabled_at timestamptz null,
  minor_age_threshold smallint not null default 18 check (minor_age_threshold between 13 and 21),
  default_template_id uuid null,
  active_retention_choice_id uuid null,
  front_desk_guardian_selection boolean not null default false,
  draft_extension_admins_enabled boolean not null default false,
  min_guardian_assurance text not null default 'email_code_verified'
    check (min_guardian_assurance in ('link_verified', 'email_code_verified', 'staff_attested')),
  surge_threshold_per_run int not null default 25 check (surge_threshold_per_run >= 1),
  surge_threshold_24h int null check (surge_threshold_24h is null or surge_threshold_24h >= 1),
  invite_max_lifetime_days int null check (invite_max_lifetime_days is null or invite_max_lifetime_days >= 1),
  updated_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint intake_settings_default_template_fk foreign key (studio_id, default_template_id)
    references public.intake_templates (studio_id, id) on delete set null (default_template_id),
  constraint intake_settings_retention_choice_fk foreign key (studio_id, active_retention_choice_id)
    references public.intake_studio_retention_choices (studio_id, id) on delete no action
);

-- R25: explicit revokes, RLS, then intended grants (config readable by studio staff only; written via RPCs only)
revoke all on public.intake_templates, public.intake_template_versions, public.intake_service_assignments,
  public.intake_studio_retention_choices, public.intake_settings from public, anon, authenticated, service_role;
alter table public.intake_templates enable row level security;
alter table public.intake_template_versions enable row level security;
alter table public.intake_service_assignments enable row level security;
alter table public.intake_studio_retention_choices enable row level security;
alter table public.intake_settings enable row level security;
grant select on public.intake_templates, public.intake_template_versions, public.intake_service_assignments,
  public.intake_studio_retention_choices, public.intake_settings to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Identity helpers. Platform admin = profiles.platform_role only (A2). Booleans only; safe for RLS use.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.intake_is_platform_admin()
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.platform_role = 'platform_admin');
$$;

create or replace function intake_private.studio_role(p_studio_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select r.role::text
  from public.user_studio_roles r
  where r.user_id = auth.uid() and r.studio_id = p_studio_id and r.active = true
  limit 1;
$$;

-- Staff read access to config: active staff role in that studio (client and organizer roles excluded).
create or replace function public.intake_has_staff_role(p_studio_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(intake_private.studio_role(p_studio_id) in ('studio_owner', 'studio_admin', 'front_desk', 'instructor'), false);
$$;

-- Capability matrix (plan §7.3, approved V1 baseline). Returns the acting role; raises 42501 otherwise.
-- Platform admins hold only: view_status, configure_read, drift_report, hold_admin, erasure, barrier_release.
-- 'attest' (in-person attestation, front desk included) is distinct from 'minor_override' (changing a request's
-- minor status, which can remove a guardian-consent requirement): owner and admin only.
create or replace function intake_private.assert_staff(p_studio_id uuid, p_capability text)
returns text language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text;
  v_settings public.intake_settings;
begin
  if auth.uid() is null then
    raise exception 'nsi: not authorized' using errcode = '42501';
  end if;
  if p_capability in ('hold_admin', 'erasure', 'barrier_release') then
    if public.intake_is_platform_admin() then return 'platform_admin'; end if;
    raise exception 'nsi: not authorized' using errcode = '42501';
  end if;
  if p_studio_id is null then
    raise exception 'nsi: studio required' using errcode = '22023';
  end if;
  v_role := intake_private.studio_role(p_studio_id);
  select * into v_settings from public.intake_settings s where s.studio_id = p_studio_id;
  if v_role = 'studio_owner' and p_capability in
       ('configure', 'configure_read', 'view_status', 'send', 'view_all_answers', 'view_operational',
        'designate_guardian', 'attest', 'minor_override', 'extend_draft', 'retention_choice', 'drift_report') then
    return v_role;
  end if;
  if v_role = 'studio_admin' and (p_capability in
       ('configure', 'configure_read', 'view_status', 'send', 'view_all_answers', 'view_operational',
        'designate_guardian', 'attest', 'minor_override', 'retention_choice', 'drift_report')
       or (p_capability = 'extend_draft' and coalesce(v_settings.draft_extension_admins_enabled, false))) then
    return v_role;
  end if;
  if v_role = 'front_desk' and (p_capability in ('view_status', 'send', 'view_operational', 'attest')
       or (p_capability = 'designate_guardian' and coalesce(v_settings.front_desk_guardian_selection, false))) then
    return v_role;
  end if;
  if p_capability in ('view_status', 'configure_read', 'drift_report') and public.intake_is_platform_admin() then
    return 'platform_admin';
  end if;
  raise exception 'nsi: not authorized' using errcode = '42501';
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Collection gates (N1). Gate A: platform retention approved (every personal-data insert).
-- Gate B: studio enabled (new obligations / outreach only). Entitlement is app-side until N2 (I2).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function intake_private.retention_gate_open()
returns boolean language sql stable
set search_path = pg_catalog, pg_temp
as $$
  select p.post_relationship_max_days is not null and p.evidence_core_days is not null
     and p.evidence_identity_days is not null and p.audit_operational_days is not null
     and p.audit_security_days is not null and p.hold_record_days_after_release is not null
     and p.draft_retention_days is not null and p.draft_max_days is not null
     and p.draft_protected_window_days is not null
  from public.intake_platform_policy() p;
$$;

create or replace function intake_private.new_obligation_allowed(p_studio_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce((select s.enabled from public.intake_settings s where s.studio_id = p_studio_id), false);
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Tenant helpers (R5 / F9 / F10 / A12). Raise 42501 on any cross-studio or cross-client reference.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function intake_private.assert_client_in_studio(p_studio_id uuid, p_client_id uuid)
returns void language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_client_id is null or not exists (
       select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id) then
    raise exception 'nsi: client is not in this studio' using errcode = '42501';
  end if;
end $$;

create or replace function intake_private.assert_link_for_client(p_studio_id uuid, p_client_id uuid, p_link_id uuid)
returns void language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_link_id is null then return; end if;
  if not exists (select 1 from public.client_account_links l
                 where l.id = p_link_id and l.studio_id = p_studio_id and l.client_id = p_client_id) then
    raise exception 'nsi: account link does not belong to this client and studio' using errcode = '42501';
  end if;
end $$;

-- L3 / N4-compatible guardian verification: studio-initiated, linked, guardian or parent, account attached.
create or replace function intake_private.link_is_verified_guardian(p_studio_id uuid, p_client_id uuid, p_link_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from public.client_account_links l
                 where l.id = p_link_id and l.studio_id = p_studio_id and l.client_id = p_client_id
                   and l.status = 'linked' and l.relationship_type in ('guardian', 'parent')
                   and l.initiated_by = 'studio' and l.user_id is not null);
$$;

-- Student self link: the client's own linked account (status linked implies the account-claim flow completed).
create or replace function intake_private.link_is_verified_self(p_studio_id uuid, p_client_id uuid, p_link_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from public.client_account_links l
                 where l.id = p_link_id and l.studio_id = p_studio_id and l.client_id = p_client_id
                   and l.status = 'linked' and l.relationship_type = 'self' and l.user_id is not null);
$$;

-- F9 / A12: Documents ownership via document_templates; studio scope only; published and not archived.
create or replace function intake_private.assert_document_version(p_studio_id uuid, p_version_ref uuid)
returns void language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_version_ref is null then return; end if;
  if not exists (
       select 1 from public.document_template_versions v
       join public.document_templates t on t.id = v.template_id
       where v.id = p_version_ref and v.published_at is not null and v.archived_at is null
         and t.scope = 'studio' and t.studio_id = p_studio_id and t.organizer_id is null
         and coalesce(t.is_active, false) = true) then
    raise exception 'nsi: document template version is not a usable studio template of this studio' using errcode = '42501';
  end if;
end $$;

create or replace function intake_private.assert_envelope(p_studio_id uuid, p_client_id uuid, p_envelope_ref uuid)
returns void language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_envelope_ref is null then return; end if;
  if not exists (select 1 from public.document_sign_envelopes e
                 where e.id = p_envelope_ref and e.studio_id = p_studio_id and e.client_id = p_client_id) then
    raise exception 'nsi: signing envelope does not belong to this client and studio' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Config guards
-- ---------------------------------------------------------------------------------------------------------------
-- Published versions are immutable; only published -> archived (+archived_at) may change. Non-draft rows may be
-- deleted only by the studio CASCADE; referenced rows are protected by RESTRICT foreign keys from M3/M4.
create or replace function intake_private.template_version_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.studios s where s.id = old.studio_id) then
      raise exception 'nsi: published or archived template versions cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if new.studio_id is distinct from old.studio_id or new.template_id is distinct from old.template_id then
      raise exception 'nsi: template version ownership is immutable' using errcode = '42501';
    end if;
    if old.status <> 'draft' then
      if not (old.status = 'published' and new.status = 'archived' or new.status = old.status)
         or new.schema is distinct from old.schema or new.schema_sha256 is distinct from old.schema_sha256
         or new.version_number is distinct from old.version_number
         or new.max_answer_bytes is distinct from old.max_answer_bytes
         or new.reintake_required is distinct from old.reintake_required
         or new.document_template_version_ref is distinct from old.document_template_version_ref
         or new.privacy_notice_version is distinct from old.privacy_notice_version
         or new.published_at is distinct from old.published_at
         or new.published_by is distinct from old.published_by then
        raise exception 'nsi: published template versions are immutable' using errcode = '42501';
      end if;
      if new.status = 'archived' and new.archived_at is null then
        new.archived_at := now();
      end if;
      return new;
    end if;
  end if;
  if new.status = 'published' then
    perform intake_private.assert_document_version(new.studio_id, new.document_template_version_ref);
  end if;
  return new;
end $$;

-- Re-intake floor only increases and must name a published reintake_required version of this template.
create or replace function intake_private.template_floor_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.studio_id is distinct from old.studio_id then
    raise exception 'nsi: template ownership is immutable' using errcode = '42501';
  end if;
  if new.reintake_floor_version is distinct from old.reintake_floor_version then
    if new.reintake_floor_version is null
       or (old.reintake_floor_version is not null and new.reintake_floor_version < old.reintake_floor_version)
       or not exists (select 1 from public.intake_template_versions v
                      where v.template_id = new.id and v.version_number = new.reintake_floor_version
                        and v.status in ('published', 'archived') and v.reintake_required) then
      raise exception 'nsi: invalid re-intake floor' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists intake_template_versions_guard on public.intake_template_versions;
create trigger intake_template_versions_guard before insert or update or delete on public.intake_template_versions
  for each row execute function intake_private.template_version_guard();
drop trigger if exists intake_templates_floor_guard on public.intake_templates;
create trigger intake_templates_floor_guard before update on public.intake_templates
  for each row execute function intake_private.template_floor_guard();
drop trigger if exists intake_templates_touch on public.intake_templates;
create trigger intake_templates_touch before update on public.intake_templates
  for each row execute function intake_private.touch_updated_at();
drop trigger if exists intake_service_assignments_touch on public.intake_service_assignments;
create trigger intake_service_assignments_touch before update on public.intake_service_assignments
  for each row execute function intake_private.touch_updated_at();
drop trigger if exists intake_settings_touch on public.intake_settings;
create trigger intake_settings_touch before update on public.intake_settings
  for each row execute function intake_private.touch_updated_at();
drop trigger if exists intake_studio_retention_choices_append_only on public.intake_studio_retention_choices;
create trigger intake_studio_retention_choices_append_only before update or delete on public.intake_studio_retention_choices
  for each row execute function intake_private.config_append_only();
drop trigger if exists intake_template_versions_no_truncate on public.intake_template_versions;
create trigger intake_template_versions_no_truncate before truncate on public.intake_template_versions
  for each statement execute function intake_private.refuse_truncate();
drop trigger if exists intake_studio_retention_choices_no_truncate on public.intake_studio_retention_choices;
create trigger intake_studio_retention_choices_no_truncate before truncate on public.intake_studio_retention_choices
  for each statement execute function intake_private.refuse_truncate();

-- Config RLS: staff of that studio (or platform admin) may read; nobody writes directly.
drop policy if exists intake_templates_staff_read on public.intake_templates;
create policy intake_templates_staff_read on public.intake_templates for select to authenticated
  using (public.intake_has_staff_role(studio_id) or public.intake_is_platform_admin());
drop policy if exists intake_template_versions_staff_read on public.intake_template_versions;
create policy intake_template_versions_staff_read on public.intake_template_versions for select to authenticated
  using (public.intake_has_staff_role(studio_id) or public.intake_is_platform_admin());
drop policy if exists intake_service_assignments_staff_read on public.intake_service_assignments;
create policy intake_service_assignments_staff_read on public.intake_service_assignments for select to authenticated
  using (public.intake_has_staff_role(studio_id) or public.intake_is_platform_admin());
drop policy if exists intake_studio_retention_choices_staff_read on public.intake_studio_retention_choices;
create policy intake_studio_retention_choices_staff_read on public.intake_studio_retention_choices for select to authenticated
  using (public.intake_has_staff_role(studio_id) or public.intake_is_platform_admin());
drop policy if exists intake_settings_staff_read on public.intake_settings;
create policy intake_settings_staff_read on public.intake_settings for select to authenticated
  using (public.intake_has_staff_role(studio_id) or public.intake_is_platform_admin());

-- ---------------------------------------------------------------------------------------------------------------
-- Fail-closed catalog self-check (R25). Called as the last statement of every NSI migration and rollback.
-- It holds the complete I1 inventory (relations, functions, triggers, policies) tagged by migration, works out which
-- migrations are present, and requires each present migration to be complete and exact:
--   * no partial migration, and migrations present only as a prefix (M1..Mk)
--   * no unexpected intake relation (any kind, sequences and views included) or function, and no overloads
--   * owners, RLS on, pinned search_path, SECURITY DEFINER flag as designed
--   * direct ACLs exactly as designed (missing AND excess grants, any grantee, PUBLIC, PG17 MAINTAIN)
--   * effective privileges of anon / authenticated / service_role / intake_destructive exactly as designed
--   * no column-level grants; triggers and policies exactly as designed and enabled
--   * restricted role attributes, memberships, schema privileges and default ACLs
--   * nothing intake-owned attached to public.appointments
-- Raises 42501 listing every deviation.
-- ---------------------------------------------------------------------------------------------------------------
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
    'intake_consent_evidence_identity|4|'];
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
    'public.intake_release_legal_hold|5|authenticated|t'];
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
    'intake_consent_evidence_identity|intake_consent_evidence_identity_no_truncate|refuse_truncate|4|BEFORE TRUNCATE|STATEMENT|'];
  -- policies: table | policy | cmd | permissive | roles | qual | with check | migration   (built below)
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
  if current_setting('server_version_num')::int >= 170000 then
    v_table_privs := v_table_privs || 'MAINTAIN'::text;
  end if;

  -- ----- which migrations are present (each must be complete; present migrations must be M1..Mk) -------------------
  for v_m in 1 .. 5 loop
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
    if r.qname = 'intake_private.erase_client_impl' then
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

-- R25 for functions: revoke M1's own functions from every API role (and PUBLIC), then class grants. The list is
-- explicit so that re-applying M1 after M5 never strips grants of later migrations.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where (n.nspname = 'public' and p.proname in ('intake_platform_policy', 'intake_is_platform_admin', 'intake_has_staff_role'))
              or (n.nspname = 'intake_private' and p.proname in ('touch_updated_at', 'refuse_truncate', 'config_append_only',
                    'studio_role', 'assert_staff', 'retention_gate_open', 'new_obligation_allowed', 'assert_client_in_studio',
                    'assert_link_for_client', 'link_is_verified_guardian', 'link_is_verified_self', 'assert_document_version',
                    'assert_envelope', 'template_version_guard', 'template_floor_guard', 'assert_catalog')) loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, intake_destructive', f.sig);
  end loop;
end $$;
grant execute on function public.intake_platform_policy() to authenticated, service_role;
grant execute on function public.intake_is_platform_admin() to authenticated;
grant execute on function public.intake_has_staff_role(uuid) to authenticated;

select intake_private.assert_catalog();

commit;

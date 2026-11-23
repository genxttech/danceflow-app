-- New Student Intake (NSI) I1 -- M2 of 5: governance (legal holds, audit events, erasure barrier, first-use marker).
--
-- Creates
--   tables  public.intake_legal_holds, public.intake_audit_events            (schema-plan tables 6-7; retained)
--   funcs   intake_private.is_held, intake_private.client_has_active_hold, intake_private.audit_write,
--           intake_private.erasure_barrier_active, intake_private.legal_hold_guard, intake_private.audit_guard
-- Depends on: M1 (intake_private schema, refuse_truncate, assert_catalog, intake_platform_policy), public.studios.
-- Retained records hold soft references only (R1). The single environment marker has studio_id NULL (N6).
-- Studio FK RESTRICT (R8): a studio with retained records needs the offboarding procedure (I6).
-- Privileges (R25): no API-role access at all; RLS enabled with no policies; assert_catalog() runs last.
-- Rollback: rollback/20261118091000_nsi_i1_m2_governance_rollback.sql (guarded).

begin;

set local lock_timeout = '5s';

create table if not exists public.intake_legal_holds (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  scope_type text not null check (scope_type in ('client', 'request', 'response', 'evidence', 'envelope')),
  scope_ref uuid not null,
  client_ref uuid not null,
  reason text not null check (char_length(reason) between 1 and 1000),
  retention_basis text not null check (char_length(retention_basis) between 1 and 1000),
  external_reference text null check (external_reference is null or char_length(external_reference) <= 1000),
  effective_at timestamptz not null default now(),
  review_due_at timestamptz not null,
  created_by uuid not null,
  released_at timestamptz null,
  released_by uuid null,
  release_reason text null check (release_reason is null or char_length(release_reason) <= 1000),
  record_state text not null default 'active'
    check (record_state in ('active', 'released_pending_policy', 'released_scheduled', 'metadata_minimized')),
  record_retain_until timestamptz null,
  metadata_minimized_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint intake_legal_holds_studio_id_key unique (studio_id, id),
  constraint intake_legal_holds_release_all_or_none check (
    (released_at is null and released_by is null and release_reason is null)
    or (released_at is not null and released_by is not null and release_reason is not null)),
  constraint intake_legal_holds_state_release check ((record_state = 'active') = (released_at is null)),
  constraint intake_legal_holds_scheduled_has_date check (record_state <> 'released_scheduled' or record_retain_until is not null),
  constraint intake_legal_holds_client_scope check (scope_type <> 'client' or scope_ref = client_ref),
  constraint intake_legal_holds_review_after_effective check (review_due_at > effective_at)
);
create unique index if not exists intake_legal_holds_one_active_per_scope
  on public.intake_legal_holds (studio_id, scope_type, scope_ref) where released_at is null;
create index if not exists intake_legal_holds_active_client
  on public.intake_legal_holds (studio_id, client_ref) where released_at is null;

create table if not exists public.intake_audit_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid null references public.studios(id) on delete restrict,
  event_type text not null check (event_type in (
    'environment_first_personal_use', 'template_draft_saved', 'template_version_published', 'reintake_floor_set',
    'service_assignment_set', 'settings_updated', 'retention_choice_set', 'request_created', 'appointment_attached',
    'draft_saved', 'response_submitted', 'completion_recorded', 'minor_determination_recorded',
    'guardian_designated', 'guardian_recipient_selected', 'draft_retention_extended', 'staff_viewed_answers',
    'drift_report_run', 'tenant_drift_detected', 'legal_hold_created', 'legal_hold_released',
    'erasure_record', 'erasure_barrier_released', 'erasure_refused_hold', 'gate_refused')),
  actor_type text not null check (actor_type in ('student', 'guardian', 'staff', 'system', 'platform_admin')),
  actor_user_id uuid null,
  actor_role text null check (actor_role is null or char_length(actor_role) <= 64),
  request_ref uuid null,
  client_ref uuid null,
  object_type text null check (object_type is null or char_length(object_type) <= 64),
  object_ref uuid null,
  hold_ref uuid null,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 4096),
  retention_class text not null check (retention_class in ('operational', 'security', 'erasure_record', 'legal_hold', 'environment_marker')),
  retain_until timestamptz null,
  retention_state text not null default 'pending_policy'
    check (retention_state in ('pending_policy', 'scheduled', 'held', 'permanent_marker')),
  refs_minimized_at timestamptz null,
  created_at timestamptz not null default clock_timestamp(),
  constraint intake_audit_events_marker_scope check (
    (retention_class = 'environment_marker') = (studio_id is null)),
  constraint intake_audit_events_marker_shape check (
    retention_class <> 'environment_marker'
    or (retention_state = 'permanent_marker' and request_ref is null and client_ref is null and object_ref is null
        and hold_ref is null and actor_user_id is null and metadata = '{}'::jsonb)),
  constraint intake_audit_events_permanent_only_marker check (
    (retention_state = 'permanent_marker') = (retention_class = 'environment_marker')),
  constraint intake_audit_events_scheduled_has_date check (retention_state <> 'scheduled' or retain_until is not null)
);
create unique index if not exists intake_audit_events_one_marker
  on public.intake_audit_events ((true)) where retention_class = 'environment_marker';
create index if not exists intake_audit_events_studio_created on public.intake_audit_events (studio_id, created_at desc);
create index if not exists intake_audit_events_client on public.intake_audit_events (studio_id, client_ref, created_at);
create index if not exists intake_audit_events_retention on public.intake_audit_events (studio_id, retention_state, retain_until);

revoke all on public.intake_legal_holds, public.intake_audit_events from public, anon, authenticated, service_role;
alter table public.intake_legal_holds enable row level security;
alter table public.intake_audit_events enable row level security;

-- ---------------------------------------------------------------------------------------------------------------
-- Hold checks
-- ---------------------------------------------------------------------------------------------------------------
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

-- Any active hold whose subject is this client (client-, request-, response-, evidence- or envelope-scoped).
create or replace function intake_private.client_has_active_hold(p_studio_id uuid, p_client_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from public.intake_legal_holds h
                 where h.studio_id = p_studio_id and h.client_ref = p_client_id
                   and h.released_at is null and h.effective_at <= now());
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Audit writer (never gated, never fails closed on retention). Metadata keys are allowlisted; no personal content.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function intake_private.audit_write(
  p_studio_id uuid, p_event_type text, p_actor_type text, p_actor_user_id uuid, p_actor_role text,
  p_request_ref uuid, p_client_ref uuid, p_object_type text, p_object_ref uuid, p_hold_ref uuid,
  p_metadata jsonb, p_retention_class text)
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_policy record;
  v_days int;
  v_state text := 'pending_policy';
  v_until timestamptz := null;
  v_meta jsonb := coalesce(p_metadata, '{}'::jsonb);
  c_allowed_keys constant text[] := array['count', 'counts', 'drift', 'reason_code', 'gate', 'capability',
    'status_from', 'status_to', 'generation', 'version_number', 'appointment_type', 'audience', 'basis', 'enabled',
    'scope_type', 'extension_count', 'case_ref'];
begin
  if p_retention_class = 'environment_marker' then
    insert into public.intake_audit_events (studio_id, event_type, actor_type, retention_class, retention_state)
    values (null, 'environment_first_personal_use', 'system', 'environment_marker', 'permanent_marker')
    on conflict ((true)) where retention_class = 'environment_marker' do nothing;
    return;
  end if;
  if exists (select 1 from jsonb_object_keys(v_meta) k where not (k = any (c_allowed_keys))) then
    raise exception 'nsi: audit metadata contains a key outside the allowlist' using errcode = '22023';
  end if;
  select * into v_policy from public.intake_platform_policy();
  v_days := case p_retention_class
              when 'operational' then v_policy.audit_operational_days
              when 'security' then v_policy.audit_security_days
              else null end;
  if p_client_ref is not null and intake_private.client_has_active_hold(p_studio_id, p_client_ref) then
    v_state := 'held';
  elsif v_days is not null then
    v_state := 'scheduled';
    v_until := now() + make_interval(days => v_days);
  end if;
  insert into public.intake_audit_events (studio_id, event_type, actor_type, actor_user_id, actor_role, request_ref,
    client_ref, object_type, object_ref, hold_ref, metadata, retention_class, retain_until, retention_state)
  values (p_studio_id, p_event_type, p_actor_type, p_actor_user_id, p_actor_role, p_request_ref, p_client_ref,
    p_object_type, p_object_ref, p_hold_ref, v_meta, p_retention_class, v_until, v_state);
end $$;

-- Erasure barrier (N3): active while the latest erasure_record / erasure_barrier_released event for the client is
-- an erasure_record. Append-only: the original record is never modified.
create or replace function intake_private.erasure_barrier_active(p_studio_id uuid, p_client_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce((
    select a.event_type = 'erasure_record'
    from public.intake_audit_events a
    where a.studio_id = p_studio_id and a.client_ref = p_client_id
      and a.event_type in ('erasure_record', 'erasure_barrier_released')
    order by a.created_at desc, a.id desc
    limit 1), false);
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------------------------
-- Holds: scope, subject, reason and creation facts are immutable. Allowed: one release (fields NULL -> set,
-- state active -> released_*), later scheduling (released_pending_policy -> released_scheduled), and metadata
-- minimization by the restricted role (I6). Deletes are refused (purge is an I6 function of the restricted role).
create or replace function intake_private.legal_hold_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if current_user <> 'intake_destructive' then
      raise exception 'nsi: legal holds cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.id <> old.id or new.studio_id <> old.studio_id or new.scope_type <> old.scope_type
     or new.scope_ref <> old.scope_ref or new.client_ref <> old.client_ref or new.retention_basis <> old.retention_basis
     or new.effective_at <> old.effective_at or new.review_due_at <> old.review_due_at
     or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'nsi: legal hold facts are immutable' using errcode = '42501';
  end if;
  if old.released_at is not null and (new.released_at is distinct from old.released_at
       or new.released_by is distinct from old.released_by) then
    raise exception 'nsi: a released hold cannot be re-released or reopened' using errcode = '42501';
  end if;
  if (new.reason is distinct from old.reason or new.external_reference is distinct from old.external_reference
      or (old.release_reason is not null and new.release_reason is distinct from old.release_reason)
      or new.metadata_minimized_at is distinct from old.metadata_minimized_at)
     and current_user <> 'intake_destructive' then
    raise exception 'nsi: hold metadata can only be minimized by the restricted role' using errcode = '42501';
  end if;
  return new;
end $$;

-- Audit events are append-only for every role; only the restricted role may minimize references (I6), and the
-- environment marker can never change.
create or replace function intake_private.audit_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.retention_class = 'environment_marker' then
    raise exception 'nsi: the environment first-use marker is permanent' using errcode = '42501';
  end if;
  if current_user <> 'intake_destructive' then
    raise exception 'nsi: audit events are append-only' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists intake_legal_holds_guard on public.intake_legal_holds;
create trigger intake_legal_holds_guard before update or delete on public.intake_legal_holds
  for each row execute function intake_private.legal_hold_guard();
drop trigger if exists intake_audit_events_guard on public.intake_audit_events;
create trigger intake_audit_events_guard before update or delete on public.intake_audit_events
  for each row execute function intake_private.audit_guard();
drop trigger if exists intake_legal_holds_no_truncate on public.intake_legal_holds;
create trigger intake_legal_holds_no_truncate before truncate on public.intake_legal_holds
  for each statement execute function intake_private.refuse_truncate();
drop trigger if exists intake_audit_events_no_truncate on public.intake_audit_events;
create trigger intake_audit_events_no_truncate before truncate on public.intake_audit_events
  for each statement execute function intake_private.refuse_truncate();

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'intake_private' and p.proname in ('is_held', 'client_has_active_hold', 'audit_write',
             'erasure_barrier_active', 'legal_hold_guard', 'audit_guard') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end $$;
grant execute on function intake_private.is_held(uuid, uuid, uuid, uuid, uuid, uuid) to intake_destructive;
grant execute on function intake_private.client_has_active_hold(uuid, uuid) to intake_destructive;
grant execute on function intake_private.audit_write(uuid, text, text, uuid, text, uuid, uuid, text, uuid, uuid, jsonb, text) to intake_destructive;
grant execute on function intake_private.erasure_barrier_active(uuid, uuid) to intake_destructive;

select intake_private.assert_catalog();

commit;

-- New Student Intake (NSI) I1 -- M4 of 5: retained consent evidence (schema-plan tables 17-18).
--
-- Creates
--   tables  public.intake_consent_evidence           (non-identifying, append-only, separate retention)
--           public.intake_consent_evidence_identity  (identifying details, separately expirable)
--   funcs   intake_private.evidence_insert_guard, evidence_identity_insert_guard, evidence_guard
-- Depends on: M1 (helpers, assert_envelope, intake_platform_policy), M2, M3 (collection_gate, requests, respondents).
-- Rules: soft references only, validated at insert (R1); retention dates NOT NULL and computed from the approved
--   platform policy, otherwise the insert fails closed (R6 / P1-6); required assurance pinned at acceptance (N5);
--   every insert passes Gate A and the erasure barrier.
-- Privileges (R25): no API-role or restricted-role access in I1 (expiry/minimization arrive in I6); RLS enabled.
-- Rollback: rollback/20261118093000_nsi_i1_m4_retained_evidence_rollback.sql (guarded).

begin;

set local lock_timeout = '5s';

create table if not exists public.intake_consent_evidence (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  request_ref uuid not null,
  client_ref uuid not null,
  respondent_ref uuid null,
  respondent_role text not null check (respondent_role in ('student', 'guardian')),
  declared_relationship text null check (declared_relationship is null or declared_relationship in ('parent', 'legal_guardian', 'other_authorized')),
  assurance text not null check (assurance in ('link_verified', 'email_code_verified', 'declared_unverified', 'staff_attested')),
  required_assurance text not null check (required_assurance in ('link_verified', 'email_code_verified', 'staff_attested')),
  event_type text not null check (event_type in ('acknowledged', 'declined', 'attested', 'withdrawn')),
  acknowledged_at timestamptz not null default now(),
  consent_text text not null check (char_length(consent_text) between 1 and 20000),
  consent_text_sha256 text not null check (consent_text_sha256 ~ '^[0-9a-f]{64}$'),
  template_version_ref uuid not null,
  template_schema_sha256 text not null check (char_length(template_schema_sha256) between 1 and 128),
  sign_envelope_ref uuid null,
  signed_sha256 text null check (signed_sha256 is null or char_length(signed_sha256) <= 128),
  outcome text not null check (char_length(outcome) between 1 and 64),
  actor_type text not null check (actor_type in ('student', 'guardian', 'staff', 'system')),
  actor_user_id uuid null,
  actor_role text null check (actor_role is null or char_length(actor_role) <= 64),
  retention_basis text not null check (retention_basis in ('legal', 'contractual', 'evidentiary')),
  retain_until timestamptz not null,
  platform_policy_version int not null,
  refs_minimized_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint intake_consent_evidence_studio_id_key unique (studio_id, id),
  constraint intake_consent_evidence_text_hash check (consent_text_sha256 = encode(extensions.digest(consent_text, 'sha256'), 'hex'))
);
create index if not exists intake_consent_evidence_client on public.intake_consent_evidence (studio_id, client_ref);
create index if not exists intake_consent_evidence_request on public.intake_consent_evidence (request_ref);
create index if not exists intake_consent_evidence_retention on public.intake_consent_evidence (studio_id, retain_until);

create table if not exists public.intake_consent_evidence_identity (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  evidence_id uuid not null,
  subject_display_name text null check (subject_display_name is null or char_length(subject_display_name) <= 200),
  respondent_display_name text null check (respondent_display_name is null or char_length(respondent_display_name) <= 200),
  respondent_email_hmac text null check (respondent_email_hmac is null or char_length(respondent_email_hmac) <= 128),
  respondent_email_hmac_kid smallint null,
  retain_until timestamptz not null,
  minimized_at timestamptz null,
  minimized_reason text null check (minimized_reason is null or char_length(minimized_reason) <= 1000),
  created_at timestamptz not null default now(),
  constraint intake_consent_evidence_identity_studio_id_key unique (studio_id, id),
  constraint intake_consent_evidence_identity_evidence_key unique (evidence_id),
  constraint intake_consent_evidence_identity_evidence_fk foreign key (studio_id, evidence_id)
    references public.intake_consent_evidence (studio_id, id) on delete cascade,
  constraint intake_consent_evidence_identity_hmac_pair check ((respondent_email_hmac is null) = (respondent_email_hmac_kid is null))
);

revoke all on public.intake_consent_evidence, public.intake_consent_evidence_identity from public, anon, authenticated, service_role;
alter table public.intake_consent_evidence enable row level security;
alter table public.intake_consent_evidence_identity enable row level security;

-- Insert validation: soft references exist and agree (same studio, request client, pinned version), envelope is the
-- client's, retention date equals the approved platform period (fails closed when not approved).
create or replace function intake_private.evidence_insert_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_req public.intake_requests;
  v_days int;
  v_version int;
begin
  select p.evidence_core_days, p.policy_version into v_days, v_version from public.intake_platform_policy() p;
  if v_days is null then
    raise exception 'nsi: evidence_retention_unapproved' using errcode = '42501';
  end if;
  select * into v_req from public.intake_requests q where q.id = new.request_ref;
  if v_req.id is null or v_req.studio_id <> new.studio_id or v_req.client_id <> new.client_ref then
    raise exception 'nsi: evidence request reference does not match studio and client' using errcode = '42501';
  end if;
  if v_req.pinned_version_id is distinct from new.template_version_ref then
    raise exception 'nsi: evidence must reference the request''s pinned template version' using errcode = '42501';
  end if;
  if new.respondent_ref is not null and not exists (
       select 1 from public.intake_respondents r where r.id = new.respondent_ref and r.request_id = new.request_ref
         and r.role = new.respondent_role) then
    raise exception 'nsi: evidence respondent reference does not belong to the request' using errcode = '42501';
  end if;
  perform intake_private.assert_envelope(new.studio_id, new.client_ref, new.sign_envelope_ref);
  if new.retain_until <> new.acknowledged_at + make_interval(days => v_days) or new.platform_policy_version <> v_version then
    raise exception 'nsi: evidence retention must equal the approved platform period' using errcode = '22023';
  end if;
  return new;
end $$;

create or replace function intake_private.evidence_identity_insert_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_days int;
  v_core public.intake_consent_evidence;
begin
  select p.evidence_identity_days into v_days from public.intake_platform_policy() p;
  if v_days is null then
    raise exception 'nsi: evidence_retention_unapproved' using errcode = '42501';
  end if;
  select * into v_core from public.intake_consent_evidence e where e.id = new.evidence_id;
  if new.retain_until <> v_core.acknowledged_at + make_interval(days => v_days) or new.retain_until > v_core.retain_until then
    raise exception 'nsi: identity retention must equal the approved period and not exceed the core evidence' using errcode = '22023';
  end if;
  return new;
end $$;

-- Append-only: updates and deletes only by the restricted role (I6 minimization/expiry), never under a hold.
-- Not reachable in I1 (the restricted role has no privilege on these tables). I6 release gate (P2-11): before the
-- role is granted UPDATE/DELETE here, this guard must also honour request- and response-scoped holds, and identity
-- rows must be deleted explicitly by the role (the ON DELETE CASCADE runs as the table owner and is refused here).
create or replace function intake_private.evidence_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(old) end;
  v_client uuid;
begin
  if current_user <> 'intake_destructive' then
    raise exception 'nsi: retained evidence is append-only' using errcode = '42501';
  end if;
  if tg_table_name = 'intake_consent_evidence' then
    v_client := (v_row ->> 'client_ref')::uuid;
  else
    select e.client_ref into v_client from public.intake_consent_evidence e where e.id = (v_row ->> 'evidence_id')::uuid;
  end if;
  if intake_private.is_held((v_row ->> 'studio_id')::uuid, v_client, null, null,
       coalesce((v_row ->> 'evidence_id')::uuid, (v_row ->> 'id')::uuid), (v_row ->> 'sign_envelope_ref')::uuid)
     or intake_private.is_held((v_row ->> 'studio_id')::uuid, v_client, null, null, null, null) then
    raise exception 'nsi: evidence is under an active legal hold' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists intake_consent_evidence_10_gate on public.intake_consent_evidence;
create trigger intake_consent_evidence_10_gate before insert on public.intake_consent_evidence
  for each row execute function intake_private.collection_gate('continuing');
drop trigger if exists intake_consent_evidence_20_validate on public.intake_consent_evidence;
create trigger intake_consent_evidence_20_validate before insert on public.intake_consent_evidence
  for each row execute function intake_private.evidence_insert_guard();
drop trigger if exists intake_consent_evidence_30_guard on public.intake_consent_evidence;
create trigger intake_consent_evidence_30_guard before update or delete on public.intake_consent_evidence
  for each row execute function intake_private.evidence_guard();
drop trigger if exists intake_consent_evidence_no_truncate on public.intake_consent_evidence;
create trigger intake_consent_evidence_no_truncate before truncate on public.intake_consent_evidence
  for each statement execute function intake_private.refuse_truncate();

drop trigger if exists intake_consent_evidence_identity_10_gate on public.intake_consent_evidence_identity;
create trigger intake_consent_evidence_identity_10_gate before insert on public.intake_consent_evidence_identity
  for each row execute function intake_private.collection_gate('continuing');
drop trigger if exists intake_consent_evidence_identity_20_validate on public.intake_consent_evidence_identity;
create trigger intake_consent_evidence_identity_20_validate before insert on public.intake_consent_evidence_identity
  for each row execute function intake_private.evidence_identity_insert_guard();
drop trigger if exists intake_consent_evidence_identity_30_guard on public.intake_consent_evidence_identity;
create trigger intake_consent_evidence_identity_30_guard before update or delete on public.intake_consent_evidence_identity
  for each row execute function intake_private.evidence_guard();
drop trigger if exists intake_consent_evidence_identity_no_truncate on public.intake_consent_evidence_identity;
create trigger intake_consent_evidence_identity_no_truncate before truncate on public.intake_consent_evidence_identity
  for each statement execute function intake_private.refuse_truncate();

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'intake_private' and p.proname in ('evidence_insert_guard', 'evidence_identity_insert_guard', 'evidence_guard') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end $$;

select intake_private.assert_catalog();

commit;

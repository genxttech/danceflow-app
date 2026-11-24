-- Competition S4 / R-15 -- eligibility clearance core (slot 20270301110000). ADDITIVE: no existing function, trigger, row or status is changed.
--
-- Owner decision R-15 (2026-11-24, DanceFlow Studio/Custom policy, never a governing-body rule): provisional, clearly identified internal scheduling may include
-- entries awaiting eligibility review, but such assignments cannot become executable; official heat participation, floor calls, ballot inclusion, advancement,
-- scoring, placement and result publication REQUIRE eligibility clearance. `ineligible` stays blocked. `waived` is accepted only for an explicitly waivable
-- Studio policy with an authorized, audited basis and never overrides OD-02 (under 18) or a mandatory body requirement. Unknown age fails closed.
-- Design: docs/competition/r15-eligibility-enforcement-design.md (PR 862). Gates are in 20270301130000, the write guard in 20270301131000.
--
-- WHAT THIS FILE ADDS
--   1. event_competition_eligibility_determinations: append-only evidence (who, role, when, outcome, reason code, waiver category, criteria, server-side
--      fingerprint). Written only by set_competition_entry_eligibility. Nothing is backfilled: existing entries keep their status and have NO determination.
--   2. _r15_entry_availability_reason(uuid): the EXISTING predicate P, byte-for-byte the RB3 body of _cf1_entry_unavailable_reason, kept under a new name so the
--      gates migration can make _cf1_entry_unavailable_reason strict while placement keeps the lenient test.
--   3. _r15_age_state(uuid): the ONLY bridge to the S5 age predicate (public._comp_participant_age_clearance, owned by S5, slot 20270301120000). It is called
--      dynamically; while that function does not exist, or for any result other than 'allowed', the entry is NOT age-cleared (fail closed).
--   4. _r15_entry_fingerprint, _r15_required_criteria, _r15_entry_clearance_reason (NULL = cleared), competition_entry_clearance_state.
--   5. set_competition_entry_eligibility: the only audited way to change eligibility_status (the write guard in 131000 refuses direct client writes).
--
-- Clearance of an entry (all must hold): status is eligible or waived; the LATEST determination row equals that status; its fingerprint equals the live
-- fingerprint (division, age/skill/role labels, participant competitor+role set: a roster substitution or label change makes it stale); an `eligible`
-- determination lists every required criterion; a `waived` determination has a waiver category, the entry needs no age/status/level criterion and the event
-- declares no sanctioning at all (none, not even 'other'); the S5 age state is 'allowed'. Existing eligible/waived rows without a determination are PROVISIONAL, never promoted.
--
-- Rollback: rollback/20270301110000_competition_r15_eligibility_clearance_core_rollback.sql (refuses while any determination exists).
-- RELEASE ORDER = timestamp order: 20270301090000 (S1/S2), 100000-102000 (S3), 110000 (this file, S4 core), 120000 (S5 age predicate), 130000 (S4 gates),
-- 131000 (S4 write guard); the app switches to the RPC between 110000 and 130000/131000.
-- ROLLBACK ORDER = reverse release order: S4 guard 131000, S4 gates 130000, S5 120000, THEN this file. Never roll back S5 while the gates are installed: the gates
-- reach S5 through _r15_age_state, which fails closed when S5 is absent, and that would freeze Competition. This file's rollback refuses while the gates are installed.
-- S4 alone (without S5) yields age state 'unknown' for every entry: nothing can be cleared, which is the intended fail-closed behavior; no stub ships in any migration.

begin;

do $$
begin
  if to_regprocedure('public._cf1_entry_unavailable_reason(uuid)') is null
     or to_regprocedure('public._cf1_entry_refund_evidence_reason(uuid)') is null
     or to_regprocedure('public.protect_competition_history_evidence()') is null
     or to_regprocedure('public.can_manage_event_competition(uuid)') is null then
    raise exception 'R15 core preflight: CF1 A1/RB3 or 10A helpers are missing; apply the earlier competition migrations first.';
  end if;
  if to_regclass('public.event_competition_eligibility_determinations') is not null then
    raise exception 'R15 core preflight: event_competition_eligibility_determinations already exists.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'events' and column_name = 'competition_sanctioning') then
    raise exception 'R15 core preflight: events.competition_sanctioning is missing (REG/S4-2).';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Append-only determination evidence
-- ---------------------------------------------------------------------------------------------------------------------------------
create table public.event_competition_eligibility_determinations (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  event_id uuid not null references public.events(id) on delete cascade,
  entry_id uuid not null,
  outcome text not null check (outcome in ('unverified', 'eligible', 'needs_review', 'ineligible', 'waived')),
  reason_code text not null check (reason_code in (
    'criteria_verified_by_organizer',
    'waiver_event_policy_documents', 'waiver_event_policy_fee', 'waiver_event_policy_scheduling',
    'age_division_not_met', 'age_not_established', 'status_not_established', 'level_not_met',
    'whose_age_rule_unresolved', 'documents_pending', 'other_organizer_review')),
  waiver_category text null,
  criteria text[] not null default '{}'::text[],
  fingerprint text not null check (length(fingerprint) = 64),
  decided_by uuid not null,
  decided_role text not null check (length(btrim(decided_role)) > 0),
  decided_at timestamptz not null default now(),
  request_id uuid not null unique,
  constraint event_competition_eligibility_determinations_waiver_check
    check ((outcome = 'waived') = (waiver_category is not null)),
  constraint event_competition_eligibility_determinations_criteria_check
    check (criteria <@ array['age_division', 'status', 'level']::text[])
);
create index event_competition_eligibility_determinations_entry_idx
  on public.event_competition_eligibility_determinations(entry_id, seq desc);

alter table public.event_competition_eligibility_determinations enable row level security;
create policy competition_eligibility_determinations_read on public.event_competition_eligibility_determinations
  for select to authenticated using (public.can_manage_event_competition(event_id));
revoke all on public.event_competition_eligibility_determinations from public, anon, authenticated, service_role;
grant select on public.event_competition_eligibility_determinations to authenticated, service_role;

create trigger protect_event_competition_eligibility_determinations_history
  before update or delete on public.event_competition_eligibility_determinations
  for each row execute function public.protect_competition_history_evidence();
create trigger protect_event_competition_eligibility_determinations_truncate
  before truncate on public.event_competition_eligibility_determinations
  for each statement execute function public.protect_competition_history_evidence();
alter table public.event_competition_eligibility_determinations enable always trigger protect_event_competition_eligibility_determinations_history;
alter table public.event_competition_eligibility_determinations enable always trigger protect_event_competition_eligibility_determinations_truncate;

comment on table public.event_competition_eligibility_determinations is
  'R-15 append-only eligibility determinations (actor, role, time, outcome, reason code, waiver category, criteria, server fingerprint). Written only by set_competition_entry_eligibility. No birthdate, age or credential is stored.';

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. Predicate P under a stable name (same body as the RB3 _cf1_entry_unavailable_reason)
-- ---------------------------------------------------------------------------------------------------------------------------------
create function public._r15_entry_availability_reason(p_entry_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when e.id is null then 'entry_missing'
    when e.status is distinct from 'confirmed' then 'entry_not_confirmed'
    when e.eligibility_status = 'ineligible' then 'entry_ineligible'
    when r.status = 'cancelled' then 'registration_cancelled'
    when r.status = 'refunded' then 'registration_refunded'
    when r.payment_status = 'failed' then 'registration_payment_failed'
    when r.payment_status = 'refunded' then 'registration_payment_refunded'
    when o.payment_status = 'failed' then 'order_payment_failed'
    when o.payment_status = 'refunded' then 'order_payment_refunded'
    else public._cf1_entry_refund_evidence_reason(e.id)
  end
  from (select 1) one
  left join public.event_competition_entries e on e.id = p_entry_id
  left join public.event_registrations r on r.id = e.registration_id
  left join public.event_orders o on o.id = e.order_id;
$$;
revoke all on function public._r15_entry_availability_reason(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. Age bridge to S5 (fail closed)
-- ---------------------------------------------------------------------------------------------------------------------------------
create function public._r15_age_state(p_entry_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_fn regprocedure := to_regprocedure('public._comp_participant_age_clearance(uuid)');
  -- The S5 function must be owned by the same role that owns this function: a stub planted by another role cannot declare competitors adult.
  v_have boolean := v_fn is not null and (select p.proowner from pg_proc p where p.oid = v_fn) = (select p.proowner from pg_proc p where p.oid = 'public._r15_age_state(uuid)'::regprocedure);
  v_p record;
  v_r text;
  v_n integer := 0;
  v_unknown boolean := false;
begin
  for v_p in select p.competitor_id from public.event_competition_entry_participants p where p.entry_id = p_entry_id loop
    v_n := v_n + 1;
    if not v_have or v_p.competitor_id is null then
      v_unknown := true;
      continue;
    end if;
    execute 'select public._comp_participant_age_clearance($1)' into v_r using v_p.competitor_id;
    if v_r = 'blocked_under_18' then
      return 'blocked';
    elsif v_r is distinct from 'allowed' then
      v_unknown := true;
    end if;
  end loop;
  if v_n = 0 or v_unknown then
    return 'unknown';
  end if;
  return 'allowed';
end;
$$;
revoke all on function public._r15_age_state(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. Fingerprint, required criteria, clearance reason
-- ---------------------------------------------------------------------------------------------------------------------------------
-- Same label rules as the OD-03/OD-18 application gate: an unknown label counts as a classification (fails closed).
create function public._r15_age_label_restricted(p_label text)
returns boolean
language sql
immutable
as $$ select lower(btrim(coalesce(p_label, ''))) <> all (array['', 'open', 'all', 'all ages', 'any', 'any age', 'none', 'n/a', 'na']) $$;
revoke all on function public._r15_age_label_restricted(text) from public, anon, authenticated, service_role;

create function public._r15_class_label_restricted(p_label text)
returns boolean
language sql
immutable
as $$ select lower(btrim(coalesce(p_label, ''))) <> all (array['', 'all levels', 'any level', 'no level', 'none', 'n/a', 'na']) $$;
revoke all on function public._r15_class_label_restricted(text) from public, anon, authenticated, service_role;

create function public._r15_entry_fingerprint(p_entry_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select encode(sha256(convert_to(jsonb_build_array(
    e.id, e.created_at, e.division_id, d.age_label, d.skill_label, d.role_label,
    coalesce((select jsonb_agg(jsonb_build_array(p.competitor_id, p.participant_role, p.dance_role) order by p.competitor_id, p.participant_role, p.dance_role)
              from public.event_competition_entry_participants p where p.entry_id = e.id), '[]'::jsonb))::text, 'UTF8')), 'hex')
  from public.event_competition_entries e
  left join public.event_competition_divisions d on d.id = e.division_id
  where e.id = p_entry_id;
$$;
revoke all on function public._r15_entry_fingerprint(uuid) from public, anon, authenticated, service_role;

create function public._r15_required_criteria(p_entry_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_d record;
  v_req text[] := '{}'::text[];
begin
  select d.age_label, d.skill_label, d.role_label into v_d
  from public.event_competition_entries e join public.event_competition_divisions d on d.id = e.division_id
  where e.id = p_entry_id;
  if not found then
    return array['age_division', 'level', 'status']::text[];   -- unknown division: fail closed
  end if;
  if public._r15_age_label_restricted(v_d.age_label) then v_req := v_req || 'age_division'; end if;
  if public._r15_class_label_restricted(v_d.skill_label) then v_req := v_req || 'level'; end if;
  if public._r15_class_label_restricted(v_d.role_label)
     or exists (select 1 from public.event_competition_entry_participants p where p.entry_id = p_entry_id and p.participant_role in ('professional', 'student')) then
    v_req := v_req || 'status';
  end if;
  return v_req;
end;
$$;
revoke all on function public._r15_required_criteria(uuid) from public, anon, authenticated, service_role;

-- NULL = cleared (executable). Otherwise the first matching reason. Does NOT include predicate P (status, refunds); callers that need both use
-- _cf1_entry_unavailable_reason after 20270301130000.
create function public._r15_entry_clearance_reason(p_entry_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  e public.event_competition_entries%rowtype;
  d public.event_competition_eligibility_determinations%rowtype;
  v_age text;
  v_req text[];
begin
  select * into e from public.event_competition_entries where id = p_entry_id;
  if not found then
    return 'entry_missing';
  end if;
  v_age := public._r15_age_state(p_entry_id);
  if v_age = 'blocked' then return 'entry_age_blocked'; end if;
  if e.eligibility_status = 'ineligible' then return 'entry_ineligible'; end if;
  if e.eligibility_status = 'unverified' then return 'entry_provisional_unverified'; end if;
  if e.eligibility_status = 'needs_review' then return 'entry_provisional_needs_review'; end if;
  select * into d from public.event_competition_eligibility_determinations x where x.entry_id = p_entry_id order by x.seq desc limit 1;
  if not found then return 'entry_determination_missing'; end if;
  if d.outcome is distinct from e.eligibility_status or d.event_id is distinct from e.event_id then return 'entry_determination_mismatch'; end if;
  if d.fingerprint is distinct from public._r15_entry_fingerprint(p_entry_id) then return 'entry_determination_stale'; end if;
  v_req := public._r15_required_criteria(p_entry_id);
  if e.eligibility_status = 'eligible' then
    if not (v_req <@ d.criteria) then return 'entry_criteria_missing'; end if;
  else
    if cardinality(v_req) > 0
       or exists (select 1 from public.events ev where ev.id = e.event_id and ev.competition_sanctioning <> 'none') then
      return 'entry_waiver_not_allowed';
    end if;
    if d.waiver_category is null then return 'entry_waiver_basis_missing'; end if;
  end if;
  if v_age <> 'allowed' then return 'entry_age_not_established'; end if;
  return null;
end;
$$;
revoke all on function public._r15_entry_clearance_reason(uuid) from public, anon, authenticated, service_role;

create function public._r15_entry_executable_reason(p_entry_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select coalesce(public._r15_entry_availability_reason(p_entry_id), public._r15_entry_clearance_reason(p_entry_id)); $$;
revoke all on function public._r15_entry_executable_reason(uuid) from public, anon, authenticated, service_role;

-- Reader for the UI: 'cleared' | 'provisional' | 'blocked'. Event managers only.
create function public.competition_entry_clearance_state(p_entry_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid;
  v_clear text;
begin
  select event_id into v_event from public.event_competition_entries where id = p_entry_id;
  if v_event is null or not public.can_manage_event_competition(v_event) then
    raise exception 'COMP_R15_NOT_FOUND: entry was not found or cannot be managed.' using errcode = '42501';
  end if;
  v_clear := public._r15_entry_clearance_reason(p_entry_id);
  if public._r15_entry_availability_reason(p_entry_id) is not null or v_clear in ('entry_ineligible', 'entry_age_blocked') then
    return 'blocked';
  end if;
  return case when v_clear is null then 'cleared' else 'provisional' end;
end;
$$;
revoke all on function public.competition_entry_clearance_state(uuid) from public, anon;
grant execute on function public.competition_entry_clearance_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 5. The audited write path
-- ---------------------------------------------------------------------------------------------------------------------------------
create function public.set_competition_entry_eligibility(
  p_entry_id uuid,
  p_outcome text,
  p_reason_code text,
  p_criteria text[],
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  e public.event_competition_entries%rowtype;
  v_uid uuid := auth.uid();
  v_role text;
  v_prior public.event_competition_eligibility_determinations%rowtype;
  v_criteria text[] := coalesce(p_criteria, '{}'::text[]);
  v_req text[];
  v_age text;
  v_waiver text;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'COMP_R15_NOT_FOUND: sign in to record an eligibility decision.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_R15_DETERMINATION_INVALID: a request id is required.' using errcode = '23514';
  end if;
  select * into e from public.event_competition_entries where id = p_entry_id for update;
  if not found or not public.can_manage_event_competition(e.event_id) then
    raise exception 'COMP_R15_NOT_FOUND: entry was not found or cannot be managed.' using errcode = '42501';
  end if;
  select * into v_prior from public.event_competition_eligibility_determinations where request_id = p_request_id;
  if found then
    if v_prior.entry_id is distinct from p_entry_id then
      raise exception 'COMP_R15_DETERMINATION_INVALID: this request id was already used for a different entry.' using errcode = '23505';
    end if;
    if v_prior.decided_by is distinct from v_uid or v_prior.outcome is distinct from p_outcome or v_prior.reason_code is distinct from p_reason_code then
      raise exception 'COMP_R15_DETERMINATION_INVALID: this request id was already used for a different decision.' using errcode = '23505';
    end if;
    return jsonb_build_object('replayed', true, 'determination_id', v_prior.id, 'entry_id', p_entry_id, 'outcome', v_prior.outcome);
  end if;
  if e.status in ('withdrawn', 'scratched', 'disqualified', 'complete') then
    raise exception 'COMP_R15_DETERMINATION_INVALID: a % entry cannot be given an eligibility decision.', e.status using errcode = '23514';
  end if;
  if p_reason_code is null then
    raise exception 'COMP_R15_DETERMINATION_INVALID: a reason code is required.' using errcode = '23514';
  end if;
  if p_outcome is null or p_outcome not in ('unverified', 'eligible', 'needs_review', 'ineligible', 'waived') then
    raise exception 'COMP_R15_DETERMINATION_INVALID: a valid eligibility outcome is required.' using errcode = '23514';
  end if;
  if not (v_criteria <@ array['age_division', 'status', 'level']::text[]) then
    raise exception 'COMP_R15_DETERMINATION_INVALID: unknown verification criterion.' using errcode = '23514';
  end if;

  if p_outcome in ('eligible', 'waived') then
    v_age := public._r15_age_state(p_entry_id);
    if v_age <> 'allowed' then
      raise exception 'COMP_R15_DETERMINATION_INVALID: every competitor must have an established adult age; this cannot be waived.' using errcode = '23514';
    end if;
    v_req := public._r15_required_criteria(p_entry_id);
  end if;

  if p_outcome = 'eligible' then
    if p_reason_code is distinct from 'criteria_verified_by_organizer' then
      raise exception 'COMP_R15_DETERMINATION_INVALID: marking an entry eligible requires the reason "criteria verified by organizer".' using errcode = '23514';
    end if;
    if not (v_req <@ v_criteria) then
      raise exception 'COMP_R15_DETERMINATION_INVALID: this entry''s division requires verification of: %.', array_to_string(v_req, ', ') using errcode = '23514';
    end if;
  elsif p_outcome = 'waived' then
    if p_reason_code not in ('waiver_event_policy_documents', 'waiver_event_policy_fee', 'waiver_event_policy_scheduling') then
      raise exception 'COMP_R15_DETERMINATION_INVALID: a waiver needs an event-policy category (documents, fee or scheduling).' using errcode = '23514';
    end if;
    if cardinality(v_req) > 0 then
      raise exception 'COMP_R15_DETERMINATION_INVALID: a waiver cannot be used for a division with age, status or level criteria.' using errcode = '23514';
    end if;
    if exists (select 1 from public.events ev where ev.id = e.event_id and ev.competition_sanctioning <> 'none') then
      raise exception 'COMP_R15_DETERMINATION_INVALID: a waiver cannot be used for an event that declares any sanctioning.' using errcode = '23514';
    end if;
    v_waiver := p_reason_code;
  else
    if p_reason_code not in ('age_division_not_met', 'age_not_established', 'status_not_established', 'level_not_met',
                             'whose_age_rule_unresolved', 'documents_pending', 'other_organizer_review') then
      raise exception 'COMP_R15_DETERMINATION_INVALID: choose a reason for this decision.' using errcode = '23514';
    end if;
  end if;

  select usr.role into v_role
  from public.user_studio_roles usr join public.events ev on ev.studio_id = usr.studio_id
  where usr.user_id = v_uid and ev.id = e.event_id and usr.active order by usr.role limit 1;

  insert into public.event_competition_eligibility_determinations (
    event_id, entry_id, outcome, reason_code, waiver_category, criteria, fingerprint, decided_by, decided_role, request_id
  ) values (
    e.event_id, p_entry_id, p_outcome, p_reason_code, v_waiver, v_criteria, public._r15_entry_fingerprint(p_entry_id), v_uid,
    coalesce(v_role, 'event_manager'), p_request_id
  ) returning id into v_id;

  perform set_config('app.competition_entry_change_type', 'eligibility_change', true);
  perform set_config('app.competition_entry_change_reason', p_reason_code, true);
  update public.event_competition_entries set eligibility_status = p_outcome where id = p_entry_id;
  perform set_config('app.competition_entry_change_type', '', true);
  perform set_config('app.competition_entry_change_reason', '', true);

  return jsonb_build_object('replayed', false, 'determination_id', v_id, 'entry_id', p_entry_id, 'outcome', p_outcome);
end;
$$;
revoke all on function public.set_competition_entry_eligibility(uuid, text, text, text[], uuid) from public, anon;
grant execute on function public.set_competition_entry_eligibility(uuid, text, text, text[], uuid) to authenticated;

-- Postflight: every object exists, API roles cannot call the internals, and no existing entry or audit row was touched by this file.
do $$
begin
  if to_regprocedure('public._r15_entry_clearance_reason(uuid)') is null
     or to_regprocedure('public.set_competition_entry_eligibility(uuid,text,text,text[],uuid)') is null
     or has_function_privilege('authenticated', 'public._r15_entry_clearance_reason(uuid)', 'execute')
     or has_function_privilege('anon', 'public._r15_entry_availability_reason(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._r15_age_state(uuid)', 'execute') then
    raise exception 'R15 core postflight: function privileges or objects are wrong.';
  end if;
  if public._r15_entry_availability_reason(gen_random_uuid()) is distinct from 'entry_missing' then
    raise exception 'R15 core postflight: availability predicate does not report entry_missing.';
  end if;
end $$;

commit;

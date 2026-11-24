-- Competition OS S5 (OD-02): database-boundary under-18 guard for EVERY competition participant row. GIT-ONLY DRAFT: NOT APPLIED anywhere (no DEV, no PROD).
--
-- Owner decision OD-02 (2026-11-23): for initial Competition OS activation no competitor under 18 may be registered, across ALL competition event
-- types (Studio / Custom included). PR 835 enforces that in the application at checkout; this migration enforces it where the rows are written, so team
-- roster changes, alternates, substitutions, staff-created entries, studio registrations, guest or anchored identities, roster edits after
-- registration, partner changes and direct PostgREST writes by managers cannot bypass it. UI validation alone is insufficient.
--
-- RELEASE ORDER AND ACTIVATION GATES (read before any apply; none is requested by this draft):
--   * Apply the app change that REQUIRES a date of birth (PR 835 and its stack) BEFORE or WITH this migration. Without it every registration whose roster person has no
--     date of birth fails closed with age_not_established, and staff or legacy participant inserts from a client or instructor anchor fail unless that competitor already
--     has a stored date of birth.
--   * Existing competition SQL suites insert participants for competitors without a date of birth and must be given adult dates of birth before they run on a chain that
--     includes this file (listed in the PR).
--   * Activation-gate query (run read-only before public activation; both counts must be 0, otherwise an owner decision is needed; rows are never auto-deleted):
--       select count(*) filter (where public._comp_participant_age_clearance(competitor_id) = 'blocked_under_18') as under_18,
--              count(*) filter (where public._comp_participant_age_clearance(competitor_id) = 'unknown_age') as unknown_age
--       from public.event_competition_entry_participants;
--   * The guard trusts the date of birth it is given (self-attested at registration or entered by staff); the first date of birth written for an anchored competitor is kept.
--   * Correcting a participating competitor's date of birth to one that does not clear is refused by design (remove the participant row first, with the usual withdrawal
--     process); erasure of a date of birth of a participating competitor is therefore also refused. OWNER DECISION needed if a correction/erasure path is wanted.
--
-- ONE enforcement point, ONE age predicate (this migration OWNS the age predicate; the broader eligibility-clearance predicate of the S4 work CALLS it):
--   public._comp_age_clearance_from_dob(date, timestamptz)  -> 'allowed' | 'blocked_under_18' | 'unknown_age'   (pure; reason codes only)
--   public._comp_participant_age_clearance(uuid competitor)  -> same three codes (reads the competitor's stored date of birth)
--   trigger event_competition_entry_participants_s5_age_guard   BEFORE INSERT OR UPDATE OF competitor_id, event_id on event_competition_entry_participants
--   trigger event_competition_competitors_s5_dob_guard         BEFORE UPDATE OF date_of_birth on event_competition_competitors
-- Every person who competes is an event_competition_entry_participants row (couple halves, team members, alternates, substitutes, pro/am students and
-- professionals alike), and every such row points at an event_competition_competitors row that stores the date of birth. The trigger fires for EVERY
-- writer: manager PostgREST writes (policy competition_manage is FOR ALL), SECURITY DEFINER registration RPCs (start_competition_registration),
-- service_role, and the sync/bridge triggers. It is not bypassable by a flag or setting. (Both triggers are ENABLE ALWAYS. Only a table owner or superuser who disables or drops them can skip them.)
--
-- Fail closed: a missing, future or pre-1900 date of birth is 'unknown_age' and is refused exactly like an under-18. No waiver, eligibility status or
-- organizer determination can lift it: there is no override path in this file.
-- Privacy: the predicate and the error messages carry a reason code only. No birthdate or computed age is returned, raised, logged or echoed.
-- Reference date: today in UTC-12 (the earliest timezone date on Earth), so nobody is counted as an adult early; this is the same rule as the application gate.
-- Scope: only competition participant rows and competitor rows. General DanceFlow student records, NSI, event registration attendees of non-competition
-- events and ordinary studio scheduling are not touched.
--
-- Existing rows are NOT modified and NEVER deleted. The guard fires only when a participant row is inserted or its competitor/event changes (or a competitor's
-- date of birth changes while participants exist). A preflight below reports COUNTS ONLY of existing participant rows that would not clear today.
--
-- Also: _comp10c_resolve_competitor may now COMPLETE a missing date of birth on an existing anchored competitor (never change an existing one). Without it a
-- legitimate adult whose competitor row was created without a date of birth could never be registered again once this guard exists.
--
-- Authorization: the new functions are not callable by public, anon or authenticated; the two predicates are executable by service_role (preflight and
-- tooling). Triggers execute as the function owner regardless.
-- Rollback: rollback/20270301120000_competition_s5_participant_age_guard_rollback.sql (restores the previous _comp10c_resolve_competitor body byte for byte).

begin;

do $$
begin
  if to_regclass('public.event_competition_entry_participants') is null
     or to_regclass('public.event_competition_competitors') is null
     or to_regprocedure('public._comp10c_resolve_competitor(uuid, uuid, uuid, uuid, text, text, text, date, text, jsonb, text, uuid)') is null then
    raise exception '20270301120000 requires the Phase 10C competitor registration chain (20261109090000)';
  end if;
  -- Pinned body hash (CR removed) of the 20261109090000 definition; a drifted hosted body must be reconciled before this applies.
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._comp10c_resolve_competitor(uuid, uuid, uuid, uuid, text, text, text, date, text, jsonb, text, uuid)'::regprocedure), E'\r', '')) <> 'cb549703a9daf25bb70f0c424bec01cf' then
    raise exception '20270301120000: public._comp10c_resolve_competitor is not the expected 20261109090000 definition; reconcile before applying';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The age predicate (pure).
-- ---------------------------------------------------------------------------
create or replace function public._comp_age_clearance_from_dob(p_dob date, p_as_of timestamptz default now())
returns text
language plpgsql
stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ref date := (((p_as_of at time zone 'UTC') - interval '12 hours'))::date;
begin
  if p_dob is null or p_dob > v_ref or p_dob < date '1900-01-01' then
    return 'unknown_age';
  end if;
  -- 18 on the birthday: date - 18 years never lands before a Feb 29 birthday, so a Feb 29 birth becomes an adult on Mar 1 of a non-leap year at the earliest.
  if p_dob <= (v_ref - interval '18 years')::date then
    return 'allowed';
  end if;
  return 'blocked_under_18';
end;
$$;

revoke all on function public._comp_age_clearance_from_dob(date, timestamptz) from public, anon, authenticated;
grant execute on function public._comp_age_clearance_from_dob(date, timestamptz) to service_role;

create or replace function public._comp_participant_age_clearance(p_competitor_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_dob date;
  v_found boolean;
begin
  if p_competitor_id is null then
    return 'unknown_age';
  end if;
  select true, c.date_of_birth into v_found, v_dob from public.event_competition_competitors c where c.id = p_competitor_id;
  if v_found is not true then
    return 'unknown_age';
  end if;
  return public._comp_age_clearance_from_dob(v_dob, now());
end;
$$;

revoke all on function public._comp_participant_age_clearance(uuid) from public, anon, authenticated;
grant execute on function public._comp_participant_age_clearance(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. The enforcement point on every participant row.
-- ---------------------------------------------------------------------------
create or replace function public._comp_s5_participant_age_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_code text;
begin
  -- Not retroactive: an update that changes neither the competitor nor the event leaves a legacy row alone.
  if tg_op = 'UPDATE' and new.competitor_id is not distinct from old.competitor_id and new.event_id is not distinct from old.event_id then
    return new;
  end if;
  -- Serialize with a concurrent date-of-birth change on the same competitor (the competitor guard looks for committed participants).
  perform 1 from public.event_competition_competitors c where c.id = new.competitor_id for share;
  v_code := public._comp_participant_age_clearance(new.competitor_id);
  if v_code <> 'allowed' then
    -- Reason code only: never a birthdate, an age, a name or an id.
    raise exception 'COMP_S5_AGE_BLOCKED: participant not cleared (%)', v_code using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public._comp_s5_participant_age_guard() from public, anon, authenticated;

-- Sorts after event_competition_entry_participants_competitor (which resolves competitor_id from client/instructor anchors first).
drop trigger if exists event_competition_entry_participants_s5_age_guard on public.event_competition_entry_participants;
create trigger event_competition_entry_participants_s5_age_guard
  before insert or update
  on public.event_competition_entry_participants
  for each row execute function public._comp_s5_participant_age_guard();
-- ENABLE ALWAYS, like the other guards in this schema: a session with session_replication_role = replica does not skip it.
alter table public.event_competition_entry_participants enable always trigger event_competition_entry_participants_s5_age_guard;

-- ---------------------------------------------------------------------------
-- 3. A competitor's date of birth cannot be changed (or removed) to something that no longer clears, while the competitor participates in an entry.
-- ---------------------------------------------------------------------------
create or replace function public._comp_s5_competitor_dob_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_code text;
begin
  if new.date_of_birth is not distinct from old.date_of_birth then
    return new;
  end if;
  if not exists (select 1 from public.event_competition_entry_participants p where p.competitor_id = new.id) then
    return new;
  end if;
  v_code := public._comp_age_clearance_from_dob(new.date_of_birth, now());
  if v_code <> 'allowed' then
    raise exception 'COMP_S5_AGE_BLOCKED: competitor change not cleared (%)', v_code using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public._comp_s5_competitor_dob_guard() from public, anon, authenticated;

drop trigger if exists event_competition_competitors_s5_dob_guard on public.event_competition_competitors;
create trigger event_competition_competitors_s5_dob_guard
  before update of date_of_birth
  on public.event_competition_competitors
  for each row execute function public._comp_s5_competitor_dob_guard();
alter table public.event_competition_competitors enable always trigger event_competition_competitors_s5_dob_guard;

-- ---------------------------------------------------------------------------
-- 4. Complete (never change) a missing date of birth when an anchored competitor is resolved again.
-- ---------------------------------------------------------------------------
create or replace function public._comp10c_resolve_competitor(
  p_event_id uuid,
  p_user_id uuid,
  p_client_id uuid,
  p_instructor_id uuid,
  p_first_name text,
  p_last_name text,
  p_email text,
  p_date_of_birth date,
  p_primary_role text,
  p_external_ids jsonb,
  p_created_via text,
  p_created_order_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_id uuid;
  v_row public.event_competition_competitors%rowtype;
begin
  if p_user_id is null and p_client_id is null and p_instructor_id is null then
    insert into public.event_competition_competitors (
      event_id, studio_id, first_name, last_name, email, date_of_birth, primary_role, external_ids, created_via, created_order_id
    ) values (
      p_event_id, p_event_id /* replaced by guard */, p_first_name, coalesce(p_last_name, ''), p_email, p_date_of_birth,
      p_primary_role, coalesce(p_external_ids, '{}'::jsonb), p_created_via, p_created_order_id
    ) returning id into v_id;
    return v_id;
  end if;

  -- Serialize anchored resolution per event so concurrent registrations converge on one row.
  perform pg_advisory_xact_lock(hashtextextended('comp10c:competitor:' || p_event_id::text, 0));

  select array_agg(distinct c.id) into v_ids
  from public.event_competition_competitors c
  where c.event_id = p_event_id
    and ((p_user_id is not null and c.user_id = p_user_id)
      or (p_client_id is not null and c.client_id = p_client_id)
      or (p_instructor_id is not null and c.instructor_id = p_instructor_id));

  if coalesce(array_length(v_ids, 1), 0) > 1 then
    raise exception 'COMP10C_ANCHOR_CONFLICT: these identity anchors belong to different competitors at this event.';
  end if;

  if coalesce(array_length(v_ids, 1), 0) = 1 then
    select * into v_row from public.event_competition_competitors where id = v_ids[1] for update;
    if (p_user_id is not null and v_row.user_id is not null and v_row.user_id <> p_user_id)
       or (p_client_id is not null and v_row.client_id is not null and v_row.client_id <> p_client_id)
       or (p_instructor_id is not null and v_row.instructor_id is not null and v_row.instructor_id <> p_instructor_id) then
      raise exception 'COMP10C_ANCHOR_CONFLICT: these identity anchors belong to different people.';
    end if;
    -- Only trusted callers reach here, so missing anchors may be completed (never changed).
    -- S5: a missing date of birth may be completed too (never changed): the participant age guard needs a stored date of birth.
    update public.event_competition_competitors
    set user_id = coalesce(user_id, p_user_id),
        client_id = coalesce(client_id, p_client_id),
        instructor_id = coalesce(instructor_id, p_instructor_id),
        date_of_birth = coalesce(date_of_birth, p_date_of_birth)
    where id = v_row.id
      and ((user_id is null and p_user_id is not null)
        or (client_id is null and p_client_id is not null)
        or (instructor_id is null and p_instructor_id is not null)
        or (date_of_birth is null and p_date_of_birth is not null));
    return v_row.id;
  end if;

  insert into public.event_competition_competitors (
    event_id, studio_id, user_id, client_id, instructor_id, first_name, last_name, email, date_of_birth,
    primary_role, external_ids, created_via, created_order_id
  ) values (
    p_event_id, p_event_id /* replaced by guard */, p_user_id, p_client_id, p_instructor_id, p_first_name,
    coalesce(p_last_name, ''), p_email, p_date_of_birth, p_primary_role, coalesce(p_external_ids, '{}'::jsonb),
    p_created_via, p_created_order_id
  ) returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public._comp10c_resolve_competitor(uuid, uuid, uuid, uuid, text, text, text, date, text, jsonb, text, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Preflight (COUNTS ONLY): existing participant rows that would not clear today. Nothing is modified or deleted.
-- ---------------------------------------------------------------------------
do $$
declare
  v_under int;
  v_unknown int;
  v_total int;
begin
  select count(*) filter (where public._comp_participant_age_clearance(p.competitor_id) = 'blocked_under_18'),
         count(*) filter (where public._comp_participant_age_clearance(p.competitor_id) = 'unknown_age'),
         count(*)
    into v_under, v_unknown, v_total
  from public.event_competition_entry_participants p;
  raise notice 'S5 preflight (counts only): % participant rows, % under 18, % unknown age. Existing rows are left unchanged and are never deleted; they stay readable and keep working until the competitor or event on the row is changed.', v_total, v_under, v_unknown;
end $$;

notify pgrst, 'reload schema';
commit;

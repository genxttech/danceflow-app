-- Rollback for 20270301120000_competition_s5_participant_age_guard.sql: drops the S5 triggers and functions and restores
-- public._comp10c_resolve_competitor to its 20261109090000 body byte for byte. Existing rows are untouched. GIT-ONLY: not applied anywhere.
-- Order: roll back anything that CALLS the S5 predicates (the S4 eligibility-clearance predicate) BEFORE this file: PL/pgSQL callers are not dependency-tracked, so dropping
-- the predicates succeeds and a still-installed caller would then fail only at run time. Dates of birth completed by the new resolve function stay in place after rollback.

begin;

do $$
begin
  -- Reverse RELEASE order: S4 gates (20270301112000, 20270301111000) come off BEFORE this file. S4's gates reach the age predicate through
  -- _r15_age_state, which fails closed when the predicate is absent: dropping it while the gates are installed would freeze Competition operations.
  if exists (select 1 from pg_trigger where tgname in ('r15_guard_round_start', 'r15_guard_heat_status', 'r15_guard_heat_entry_clearance', 'r15_guard_version_publish', 'r15_guard_entry_eligibility_write') and not tgisinternal) then
    raise exception 'S5 rollback refused: the S4 (R-15) gates or write guard are still installed; roll back 20270301112000 and 20270301111000 first. Nothing was changed.';
  end if;
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._comp10c_resolve_competitor(uuid, uuid, uuid, uuid, text, text, text, date, text, jsonb, text, uuid)'::regprocedure), E'\r', '')) <> '3e80dd88a91cfaa6c5e8aff30cb41055' then
    raise exception 'S5 rollback: public._comp10c_resolve_competitor is not the S5 definition; reconcile before rolling back';
  end if;
end $$;

drop trigger if exists event_competition_entry_participants_s5_age_guard on public.event_competition_entry_participants;
drop trigger if exists event_competition_competitors_s5_dob_guard on public.event_competition_competitors;
drop function if exists public._comp_s5_participant_age_guard();
drop function if exists public._comp_s5_competitor_dob_guard();
drop function if exists public._comp_participant_age_clearance(uuid);
drop function if exists public._comp_age_clearance_from_dob(date, timestamptz);

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
    update public.event_competition_competitors
    set user_id = coalesce(user_id, p_user_id),
        client_id = coalesce(client_id, p_client_id),
        instructor_id = coalesce(instructor_id, p_instructor_id)
    where id = v_row.id
      and ((user_id is null and p_user_id is not null)
        or (client_id is null and p_client_id is not null)
        or (instructor_id is null and p_instructor_id is not null));
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

do $$
begin
  if md5(replace((select p.prosrc from pg_proc p where p.oid = 'public._comp10c_resolve_competitor(uuid, uuid, uuid, uuid, text, text, text, date, text, jsonb, text, uuid)'::regprocedure), E'\r', '')) <> 'cb549703a9daf25bb70f0c424bec01cf' then
    raise exception 'S5 rollback: the restored _comp10c_resolve_competitor does not match the 20261109090000 body';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

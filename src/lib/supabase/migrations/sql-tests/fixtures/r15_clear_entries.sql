-- WARNING: test-only. Never run on DEV/PROD or any database that persists. It requires the real S5 age predicate; only with r15.allow_s5_standin = on does it plant a
-- marked stand-in in schema public. Run ONLY on an isolated local Postgres, inside a suite transaction that always rolls back.
--
-- Test-only fixture helper (never part of a migration). After 20270301130000 an entry needs eligibility CLEARANCE before it is placed in a published or running
-- order, so every existing Competition suite that seeds `eligible`/`waived` entries must also obtain their clearance. It does so the way an organizer does:
-- through public.set_competition_entry_eligibility, called as an authenticated event manager. It does not insert determination rows and does not disable a gate.
--
--   cat sql-tests/fixtures/r15_clear_entries.sql sql-tests/<suite>.sql | psql ...
--   -- after the suite seeds its entries (and any participants of its own), and before it places them:
--   select pg_temp.r15_clear_entries();                 -- or pg_temp.r15_clear_entries('<event uuid>')
--
-- What it does for every eligible/waived entry (status pending, confirmed or waitlisted) that is not currently cleared:
--   1. as the fixture owner, if the entry has NO participant, adds one adult competitor (date of birth 1985-06-15) as its participant: an entry without a
--      participant has no established age and can never be cleared. Existing participants are never modified (their dates of birth are the suite's business).
--   2. as a manager of the event, records the determination for the entry's CURRENT status with the required criteria. Any refusal propagates and fails the suite.
-- It never changes an entry's status. Call it again after a suite changes a roster: the stale determination is then renewed, as an organizer would.
create or replace function pg_temp.r15_clear_entries(p_event uuid default null) returns integer
language plpgsql as $$
declare
  v_e record;
  v_m record;
  v_n integer := 0;
  v_comp uuid;
  v_req text[];
  v_actor uuid;
  v_role text;
  v_claims text;
  v_s5 regprocedure;
begin
  -- Baseline databases (R-15 not applied): nothing to clear, so the same suite runs before and after the migrations.
  if to_regprocedure('public.set_competition_entry_eligibility(uuid,text,text,text[],uuid)') is null then
    return 0;
  end if;
  -- The real S5 predicate is required. A stand-in is created only on explicit request (r15.allow_s5_standin = on), never over an existing function, and is marked
  -- so every later run can tell. Without the request a chain that lacks S5 fails here: a composed run can never silently pass on a substitute.
  v_s5 := to_regprocedure('public._comp_participant_age_clearance(uuid)');
  if v_s5 is null or coalesce(obj_description(v_s5, 'pg_proc'), '') = 'R15-TEST-STAND-IN' then
    if coalesce(current_setting('r15.allow_s5_standin', true), '') <> 'on' then
      raise exception 'R15-NO-REAL-S5: the S5 age predicate is not installed (or a test stand-in is). Apply 20270301120000, or set r15.allow_s5_standin = on to run without it on purpose.';
    end if;
    raise warning 'R15 fixture: using the S5 TEST STAND-IN; this run is not evidence about the age gate.';
    if v_s5 is null then
      execute $f$create function public._comp_participant_age_clearance(p_competitor_id uuid) returns text language sql stable as $b$
        select coalesce((select case c.first_name when 'Minor' then 'blocked_under_18' when 'Unknown' then 'unknown_age' else 'allowed' end
                         from public.event_competition_competitors c where c.id = p_competitor_id), 'unknown_age') $b$ $f$;
      comment on function public._comp_participant_age_clearance(uuid) is 'R15-TEST-STAND-IN';
    end if;
  end if;
  for v_e in
    select e.id, e.event_id, e.eligibility_status, e.display_name
    from public.event_competition_entries e
    where e.eligibility_status in ('eligible', 'waived') and e.status in ('pending', 'confirmed', 'waitlisted')
      and (p_event is null or e.event_id = p_event)
      and public._r15_entry_clearance_reason(e.id) is not null
    order by e.id
  loop
    if not exists (select 1 from public.event_competition_entry_participants p where p.entry_id = v_e.id) then
      -- studio_id is given explicitly: the guard that normally fills it does not fire under session_replication_role = replica.
      insert into public.event_competition_competitors (event_id, studio_id, first_name, last_name, created_via, date_of_birth)
      values (v_e.event_id, (select ev.studio_id from public.events ev where ev.id = v_e.event_id), 'Fixture', 'Adult ' || v_e.id, 'staff', date '1985-06-15') returning id into v_comp;
      insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, display_name)
      values (v_e.event_id, v_e.id, v_comp, 'dancer', v_e.display_name);
    end if;
    v_req := public._r15_required_criteria(v_e.id);
    v_role := current_setting('role');
    v_claims := coalesce(current_setting('request.jwt.claims', true), '');
    v_actor := null;
    for v_m in
      select r.user_id from public.user_studio_roles r join public.events ev on ev.studio_id = r.studio_id
      where ev.id = v_e.event_id and r.active order by r.role desc, r.user_id
    loop
      perform set_config('request.jwt.claims', json_build_object('sub', v_m.user_id, 'role', 'authenticated')::text, true);
      if public.can_manage_event_competition(v_e.event_id) then
        v_actor := v_m.user_id;
        exit;
      end if;
    end loop;
    if v_actor is null then
      raise exception 'r15 fixture: no studio manager can manage event %', v_e.event_id;
    end if;
    perform set_config('role', 'authenticated', true);
    perform public.set_competition_entry_eligibility(
      v_e.id, v_e.eligibility_status,
      case v_e.eligibility_status when 'eligible' then 'criteria_verified_by_organizer' else 'waiver_event_policy_scheduling' end,
      case v_e.eligibility_status when 'eligible' then v_req else '{}'::text[] end,
      gen_random_uuid());
    perform set_config('role', v_role, true);
    perform set_config('request.jwt.claims', v_claims, true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Test-only fixture helper (never part of a migration): gets competition rounds to `scheduled` / `active` through the REAL
-- O1 functions, with no bypasses. Defines session-level pg_temp functions; load it BEFORE the suite that uses it:
--
--   cat sql-tests/fixtures/competition_round_ready.sql sql-tests/<suite>.sql | psql ...
--
-- (the suite then starts its own `begin;`; pg_temp functions survive for the session). Requires 10A-10D.1, E1 (the panel readiness
-- function) and O1 to be installed.
--
-- Preconditions per round (the helper creates nothing but the schedule): the round's division has at least one confirmed,
-- non-ineligible entry (the first by entry_number is used) and, where the division offers dances, that entry is registered for
-- them (entry_dances). `p_actor` must be a user who can manage the round's event (can_manage_event_competition).
-- compo1_fixture_activate_round additionally assumes E1's competition_round_panel_ready(round) is true for the round (assign a
-- real panel first, or in a throwaway test transaction replace that function with a stand-in; the helper never does).
--
--   pg_temp.compo1_fixture_publish_rounds(p_rounds uuid[], p_actor uuid) returns uuid
--       All rounds must belong to one event. Creates a draft schedule version, applies a floor plan with ONE numbered floor heat
--       (and one scoring heat) per round, in array order, and publishes it via publish_competition_schedule_version.
--       Returns the published version id. Call it ONCE per event: publishing again supersedes the earlier order and the
--       earlier rounds' heats would no longer be in the live version.
--   pg_temp.compo1_fixture_publish_round(p_round uuid, p_actor uuid) returns uuid        (one-round wrapper)
--   pg_temp.compo1_fixture_activate_round(p_round uuid, p_actor uuid) returns text
--       schedule_competition_round then start_competition_round (fresh request ids). Returns the round status ('active').
--       The round must already be in a published order (publish_round(s) first).
--
-- The caller's role and request.jwt.claims are restored on return.

create or replace function pg_temp.compo1_fixture_as(p_actor uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.compo1_fixture_publish_rounds(p_rounds uuid[], p_actor uuid) returns uuid
language plpgsql as $$
declare
  v_prev_role text := current_setting('role');
  v_prev_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_event uuid;
  v_found integer;
  v_events integer;
  v_round uuid;
  v_division uuid;
  v_entry uuid;
  v_dances jsonb;
  v_floor jsonb := '[]'::jsonb;
  v_i integer := 0;
  v_version uuid;
begin
  select count(*), count(distinct event_id), min(event_id::text)::uuid into v_found, v_events, v_event
  from public.event_competition_rounds where id = any (p_rounds);
  if p_rounds is null or cardinality(p_rounds) = 0 or v_found <> cardinality(p_rounds) or v_events <> 1 then
    raise exception 'compo1_fixture: every round must exist and all rounds must belong to one event';
  end if;

  foreach v_round in array p_rounds loop
    v_i := v_i + 1;
    select division_id into v_division from public.event_competition_rounds where id = v_round;
    select e.id into v_entry
    from public.event_competition_entries e
    where e.division_id = v_division and e.event_id = v_event and e.status = 'confirmed' and e.eligibility_status <> 'ineligible'
    order by e.entry_number, e.id limit 1;
    if v_entry is null then
      raise exception 'compo1_fixture: division % has no confirmed, eligible entry for round %', v_division, v_round;
    end if;
    select coalesce(jsonb_agg(distinct dd.dance_id), '[]'::jsonb) into v_dances
    from public.event_competition_entry_dances ed
    join public.event_competition_division_dances dd on dd.id = ed.division_dance_id
    where ed.entry_id = v_entry and ed.status <> 'scratched';
    v_floor := v_floor || jsonb_build_array(jsonb_build_object(
      'number', v_i,
      'scoringHeats', jsonb_build_array(jsonb_build_object(
        'divisionId', v_division, 'roundId', v_round, 'heatNumber', 1, 'name', 'Fixture heat ' || v_i,
        'danceIds', v_dances, 'entryIds', jsonb_build_array(v_entry)))));
  end loop;

  perform pg_temp.compo1_fixture_as(p_actor);
  v_version := public.create_competition_schedule_version(v_event, 'Fixture running order', null);
  perform public.apply_competition_floor_plan(v_version, jsonb_build_object('floorHeats', v_floor));
  perform public.publish_competition_schedule_version(v_version);

  perform set_config('role', v_prev_role, true);
  perform set_config('request.jwt.claims', v_prev_claims, true);
  return v_version;
end $$;

create or replace function pg_temp.compo1_fixture_publish_round(p_round uuid, p_actor uuid) returns uuid
language sql as $$ select pg_temp.compo1_fixture_publish_rounds(array[p_round], p_actor) $$;

create or replace function pg_temp.compo1_fixture_activate_round(p_round uuid, p_actor uuid) returns text
language plpgsql as $$
declare
  v_prev_role text := current_setting('role');
  v_prev_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_status text;
begin
  perform pg_temp.compo1_fixture_as(p_actor);
  perform public.schedule_competition_round(p_round, gen_random_uuid());
  perform public.start_competition_round(p_round, gen_random_uuid());
  select status into v_status from public.event_competition_rounds where id = p_round;
  perform set_config('role', v_prev_role, true);
  perform set_config('request.jwt.claims', v_prev_claims, true);
  return v_status;
end $$;

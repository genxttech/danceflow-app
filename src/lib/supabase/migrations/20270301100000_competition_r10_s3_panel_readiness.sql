-- 20270301100000_competition_r10_s3_panel_readiness.sql
--
-- COMPETITION R-10 part 3 (S3): Studio panel readiness must agree with the ballot lock and the scoring engines.
-- DRAFT FOR REVIEW. NOT APPLIED to DEV or PROD. Design: docs/competition/governance/judging-integrity/R10-studio-panel-readiness-correction.md
-- (PR 858, sections 5 and 14). Studio/Custom policy only (DanceFlow policy, K1 X-3); governing-body panel rules are separate future profiles.
--
-- What changes:
--   1. New internal helper _comp_r10_panel_check(round, exclude_official): evaluates the round's panel over the SAME set the lock and the
--      engines use (all lettered, non-absent judges of _compe2_round_judges), against _compe2_panel_rule, restricted to the methods that
--      have an approved ballot format and a registered engine (ordinal_majority, callback_tally). Also reports lettered, non-absent judges
--      that fail the E1 eligibility filter (active, verified email, team member).
--   2. competition_round_panel_status is redefined (same signature, same grants, same old keys, new keys added):
--        - the default minimum is the scoring method's rule (3, odd) instead of 1; min_panel_judges / minimum_panel_size can only RAISE it;
--        - a malformed min_panel_judges fails closed (configured_minimum_invalid) instead of falling back to 1;
--        - an unsupported scoring method (none, relative_placement, skating, proficiency_rating, ...) is not ready (scoring_method_unsupported);
--        - absence is read (attendance), an even panel is refused (panel_even), an ineligible lettered judge is refused (panel_member_ineligible);
--        - after the round has started, ready is evaluated against the rule only (the lock's prerequisite); the organizer-raised minimum is
--          reported separately as meets_configured_minimum.
--   competition_round_panel_ready is unchanged (it reads ready), so O1 start_competition_round needs no edit.
--   NOT changed: _compe2_panel_rule, _compe2_round_blockers, lock_competition_round_ballots, the engines (the lock is never loosened).
-- No row of any table is read for write or edited. Rollback: rollback/20270301100000_competition_r10_s3_panel_readiness_rollback.sql.

begin;

do $$
declare
  v_def text;
begin
  if to_regprocedure('public.competition_round_panel_status(uuid)') is null
     or to_regprocedure('public._compe2_panel_rule(text)') is null
     or to_regprocedure('public._compe2_round_judges(uuid)') is null
     or to_regprocedure('public._compe2_is_absent(uuid, uuid)') is null
     or to_regprocedure('public._comp_e1_is_team_member(uuid, uuid)') is null
     or to_regprocedure('public.verified_email_for_user(uuid)') is null then
    raise exception 'R10-S3 preflight: E1/E2 objects are missing.';
  end if;
  if to_regprocedure('public._comp_r10_panel_check(uuid, uuid)') is not null then
    raise exception 'R10-S3 preflight: already applied or partially applied (roll back or clean up first).';
  end if;
  v_def := replace(pg_get_functiondef('public.competition_round_panel_status(uuid)'::regprocedure), E'\r', '');
  if position('v_min integer := 1;' in v_def) = 0 or position('_comp_r10_panel_check' in v_def) > 0 then
    raise exception 'R10-S3 preflight: competition_round_panel_status is not the reviewed E1 definition; coordinate before changing it.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Helper: the panel as the lock and the engines see it
-- ---------------------------------------------------------------------------
create function public._comp_r10_panel_check(p_round_id uuid, p_exclude_official uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_scoring text;
  v_event uuid;
  v_known boolean;
  v_rule_min integer;
  v_odd boolean;
  v_assigned integer := 0;
  v_present integer := 0;
  v_ineligible integer := 0;
  v_eligible_assigned integer := 0;
begin
  select r.scoring_method, r.event_id into v_scoring, v_event from public.event_competition_rounds r where r.id = p_round_id;
  select pr.known, pr.min_judges, pr.odd_required into v_known, v_rule_min, v_odd from public._compe2_panel_rule(v_scoring) pr;
  -- Only methods with an approved ballot format and a registered engine can ballot and lock. proficiency_rating has a lock rule but no
  -- approved format or engine, so it is not startable (review finding 3).
  v_known := coalesce(v_known, false) and v_scoring in ('ordinal_majority', 'callback_tally');
  select count(*),
         count(*) filter (where not public._compe2_is_absent(p_round_id, j.official_id)
                            and (p_exclude_official is null or j.official_id <> p_exclude_official)),
         count(*) filter (where not public._compe2_is_absent(p_round_id, j.official_id)
                            and (p_exclude_official is null or j.official_id <> p_exclude_official)
                            and not (j.official_status = 'active'
                                     and public.verified_email_for_user(j.user_id) is not null
                                     and public._comp_e1_is_team_member(v_event, j.user_id))),
         count(*) filter (where j.official_status = 'active'
                            and public.verified_email_for_user(j.user_id) is not null
                            and public._comp_e1_is_team_member(v_event, j.user_id))
    into v_assigned, v_present, v_ineligible, v_eligible_assigned
  from public._compe2_round_judges(p_round_id) j;
  return jsonb_build_object(
    'known', v_known, 'rule_min', v_rule_min, 'odd_required', coalesce(v_odd, false),
    'assigned', v_assigned, 'present', v_present, 'ineligible_present', v_ineligible, 'eligible_assigned', v_eligible_assigned,
    'rule_ok', v_known and v_present >= v_rule_min and (not coalesce(v_odd, false) or v_present % 2 = 1));
end;
$$;
revoke all on function public._comp_r10_panel_check(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Readiness v2
-- ---------------------------------------------------------------------------
create or replace function public.competition_round_panel_status(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_round public.event_competition_rounds;
  v_chk jsonb;
  v_known boolean;
  v_rule_min integer;
  v_odd boolean;
  v_present integer;
  v_cfg integer;
  v_cfg_bad boolean := false;
  v_started boolean;
  v_min integer;
  v_cfg_min integer;
  v_scorers integer;
  v_chair boolean;
  v_missing text[] := '{}';
begin
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  if not found or (auth.uid() is not null and not public.can_manage_event_competition(v_round.event_id)) then
    return jsonb_build_object('ready', false, 'missing', jsonb_build_array('unavailable'));
  end if;
  v_chk := public._comp_r10_panel_check(p_round_id, null);
  v_known := (v_chk ->> 'known')::boolean;
  v_rule_min := (v_chk ->> 'rule_min')::integer;
  v_odd := (v_chk ->> 'odd_required')::boolean;
  v_present := (v_chk ->> 'present')::integer;
  v_started := v_round.status not in ('draft', 'scheduled');
  if v_round.configuration ? 'min_panel_judges' then
    if jsonb_typeof(v_round.configuration -> 'min_panel_judges') = 'number'
       and (v_round.configuration ->> 'min_panel_judges') ~ '^[0-9]{1,2}$'
       and (v_round.configuration ->> 'min_panel_judges')::integer >= 1 then
      v_cfg := (v_round.configuration ->> 'min_panel_judges')::integer;
    else
      v_cfg_bad := true; -- fail closed: never fall back to a default
    end if;
  end if;
  v_cfg_min := greatest(coalesce(v_rule_min, 1), coalesce(v_cfg, 1), coalesce(v_round.minimum_panel_size, 1));
  -- Before start the organizer-raised minimum applies; after start only the rule (the lock's prerequisite) is a hard requirement.
  v_min := case when v_started then coalesce(v_rule_min, 1) else v_cfg_min end;
  select count(*) filter (where o.role = 'scorer')
    into v_scorers
  from public.event_competition_panel_assignments a
  join public.event_competition_officials o on o.id = a.official_id and o.event_id = a.event_id
  where a.round_id = p_round_id and o.status = 'active'
    and public.verified_email_for_user(o.user_id) is not null
    and public._comp_e1_is_team_member(o.event_id, o.user_id);
  select exists (select 1 from public.event_competition_officials o
                 where o.event_id = v_round.event_id and o.role = 'chair' and o.status = 'active'
                   and public.verified_email_for_user(o.user_id) is not null
                   and public._comp_e1_is_team_member(o.event_id, o.user_id)) into v_chair;
  if not v_known then v_missing := array_append(v_missing, 'scoring_method_unsupported'); end if;
  if v_cfg_bad and not v_started then v_missing := array_append(v_missing, 'configured_minimum_invalid'); end if;
  if v_present < v_min then v_missing := array_append(v_missing, 'judges'); end if;
  if v_known and v_odd and v_present % 2 = 0 then v_missing := array_append(v_missing, 'panel_even'); end if;
  if (v_chk ->> 'ineligible_present')::integer > 0 then v_missing := array_append(v_missing, 'panel_member_ineligible'); end if;
  return jsonb_build_object(
    'ready', coalesce(array_length(v_missing, 1), 0) = 0,
    'judge_count', (v_chk ->> 'eligible_assigned')::integer,
    'present_judge_count', v_present,
    'min_judges', v_min,
    'rule_min_judges', v_rule_min,
    'odd_required', v_odd,
    'rule_known', v_known,
    'scoring_method', v_round.scoring_method,
    'meets_configured_minimum', (not v_cfg_bad) and v_present >= v_cfg_min,
    'scorer_count', v_scorers,
    'chair_designated', v_chair,
    'missing', to_jsonb(v_missing));
end;
$$;

do $$
begin
  if position('_comp_r10_panel_check' in replace(pg_get_functiondef('public.competition_round_panel_status(uuid)'::regprocedure), E'\r', '')) = 0 then
    raise exception 'R10-S3: competition_round_panel_status was not redefined.';
  end if;
end $$;

comment on function public._comp_r10_panel_check(uuid, uuid) is
  'R10-S3: the round panel as the lock and engines see it (lettered, non-absent judges) against the Studio rule. Internal.';

commit;

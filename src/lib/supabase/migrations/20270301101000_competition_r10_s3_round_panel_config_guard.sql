-- 20270301101000_competition_r10_s3_round_panel_config_guard.sql
--
-- COMPETITION R-10 part 3 (S3), hardening: validate the panel minimum a manager writes on event_competition_rounds.
-- DRAFT FOR REVIEW. NOT APPLIED to DEV or PROD. Design: PR 858 sections 5.2 and 14 (findings 1, 9).
-- Readiness v2 (20270301100000) is the real fix and neutralizes bad stored values; this trigger only stops new bad values and post-start drift.
--
-- A new BEFORE INSERT OR UPDATE OF configuration, scoring_method, minimum_panel_size trigger:
--   * configuration.min_panel_judges, when present, must be a JSON number, a whole number 1..99; for ordinal_majority / callback_tally it must
--     also be at least the rule minimum (3) and odd (an even value cannot make the panel odd);
--   * the key cannot change once the round has left draft/scheduled;
--   * on UPDATE it validates only when the key or the scoring method changed, so unrelated configuration edits on a legacy row are never blocked by this trigger
--     (max_entries_per_heat stays owned by the CF1 capacity guard, which is not touched);
--   * it never looks at panel assignments, so a draft panel can be edited freely (mid-edit states stay legal).
-- SECURITY DEFINER (it reads _compe2_panel_rule, which authenticated cannot execute) with a pinned search_path, ALWAYS enabled.
-- No existing function is redefined. No row is edited.

begin;

do $$
begin
  if to_regprocedure('public._compe2_panel_rule(text)') is null or to_regclass('public.event_competition_rounds') is null then
    raise exception 'R10-S3-2 preflight: E2 objects are missing.';
  end if;
  if to_regprocedure('public._comp_r10_guard_round_panel_config()') is not null then
    raise exception 'R10-S3-2 preflight: already applied (roll back or clean up first).';
  end if;
end $$;

create function public._comp_r10_guard_round_panel_config()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_known boolean;
  v_rule_min integer;
  v_odd boolean;
  v_raw text;
  v_n integer;
begin
  if tg_op = 'UPDATE' then
    if (new.configuration -> 'min_panel_judges') is not distinct from (old.configuration -> 'min_panel_judges')
       and new.scoring_method is not distinct from old.scoring_method then
      return new;
    end if;
    if old.status not in ('draft', 'scheduled')
       and (new.configuration -> 'min_panel_judges') is distinct from (old.configuration -> 'min_panel_judges') then
      raise exception 'COMP_ROUND_CONFIG_FROZEN: the panel minimum cannot change once the round has started (status: %).', old.status
        using errcode = 'P0001';
    end if;
  end if;
  if new.configuration is not null and jsonb_typeof(new.configuration) = 'object' and new.configuration ? 'min_panel_judges' then
    v_raw := new.configuration ->> 'min_panel_judges';
    if jsonb_typeof(new.configuration -> 'min_panel_judges') <> 'number' or v_raw is null or v_raw !~ '^[0-9]{1,2}$' or v_raw::integer < 1 then
      raise exception 'COMP_PANEL_MIN_INVALID: min_panel_judges must be a whole number from 1 to 99.' using errcode = 'P0001';
    end if;
    v_n := v_raw::integer;
    select pr.known, pr.min_judges, pr.odd_required into v_known, v_rule_min, v_odd from public._compe2_panel_rule(new.scoring_method) pr;
    if coalesce(v_known, false) and (v_n < v_rule_min or (coalesce(v_odd, false) and v_n % 2 = 0)) then
      raise exception 'COMP_PANEL_MIN_BELOW_RULE: this scoring method needs at least % judges and an odd panel; the minimum cannot be set to %.',
        v_rule_min, v_n using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public._comp_r10_guard_round_panel_config() from public, anon, authenticated, service_role;

create trigger compr10_guard_round_panel_config
  before insert or update of configuration, scoring_method, minimum_panel_size on public.event_competition_rounds
  for each row execute function public._comp_r10_guard_round_panel_config();
alter table public.event_competition_rounds enable always trigger compr10_guard_round_panel_config;

commit;

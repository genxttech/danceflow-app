-- 20261112090000_phase10d1_heat_entry_eligibility.sql
--
-- PHASE 10 -- 10D.1: heat entry eligibility integrity.
--
-- 10D enforced entry eligibility (status 'confirmed' and eligibility_status <> 'ineligible') only inside
-- apply_competition_floor_plan. The June-era competition_manage policy still lets an authorized manager write
-- event_competition_heat_entries directly through the API, so a hand-crafted call could place a pending,
-- waitlisted, scratched, withdrawn, disqualified, complete or ineligible entry.
--
-- This migration moves the rule into the existing 10D deferred integrity authority
-- (_comp10d_check_floor_heat_integrity, already fired by the comp10d_heat_entry_floor_integrity constraint
-- trigger on every heat-entry insert/update), next to the competitor-conflict and music checks. No new
-- validator, trigger, table or column; no data is rewritten. Planner/RPC pre-checks stay as early UX checks.
--
-- Status-only updates of an existing placement (checked_in, scratched, danced, disqualified) are not
-- re-checked: change_competition_entry_lifecycle scratches the placements of an entry it withdraws.
-- Scratched placements still do not count as active floor conflicts (unchanged 10D semantics).
--
-- Rollback: rollback/20261112090000_phase10d1_heat_entry_eligibility_rollback.sql (restores the 10D body).

begin;

do $$
begin
  if md5(pg_get_functiondef('public._comp10d_check_floor_heat_integrity()'::regprocedure)) <> '115297ed38d09bed8456e9ca18c3b31d' then
    raise exception '10D.1 preflight: _comp10d_check_floor_heat_integrity is not the reviewed 10D definition.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'comp10d_heat_entry_floor_integrity'
                 and tgrelid = 'public.event_competition_heat_entries'::regclass and tgdeferrable and tginitdeferred) then
    raise exception '10D.1 preflight: the 10D heat-entry integrity trigger is missing.';
  end if;
end $$;

CREATE OR REPLACE FUNCTION public._comp10d_check_floor_heat_integrity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_heat uuid;
  v_floor uuid;
  v_number integer;
  v_name text;
  v_problem record;
  v_entry record;
begin
  -- 10D.1: a heat may hold only competition entries that are confirmed and not ruled ineligible. Checked
  -- whenever an entry is PLACED (insert, or a change of entry/heat), however the row was written: planner
  -- apply, organizer RPCs or a direct authenticated write. Status-only updates of an existing placement
  -- (checked_in, scratched, danced) are day-of floor states and are never re-checked here, so withdrawing an
  -- entry can still scratch its placements.
  -- (Nested IFs: this function also fires for heats and heat dances, which have no entry_id.)
  if tg_table_name = 'event_competition_heat_entries' then
    if tg_op = 'INSERT' or new.entry_id is distinct from old.entry_id or new.heat_id is distinct from old.heat_id then
      if exists (select 1 from public.event_competition_heat_entries he where he.id = new.id) then
        select e.display_name, e.status, e.eligibility_status into v_entry
        from public.event_competition_entries e
        where e.id = new.entry_id and e.event_id = new.event_id;
        if v_entry.status is distinct from 'confirmed' or v_entry.eligibility_status = 'ineligible' then
          raise exception 'COMP10D_ENTRY_NOT_SCHEDULABLE: % is not a confirmed, eligible entry.', coalesce(v_entry.display_name, 'This entry')
            using errcode = '23514';
        end if;
      end if;
    end if;
  end if;

  if tg_table_name = 'event_competition_heats' then
    v_heat := new.id;
    v_floor := new.floor_heat_id;
  else
    v_heat := new.heat_id;
    select floor_heat_id into v_floor from public.event_competition_heats where id = v_heat;
  end if;
  v_name := public._comp10d_scoring_heat_duplicate(v_heat);
  if v_name is not null then
    raise exception 'COMP10D_COMPETITOR_CONFLICT: % is entered more than once in the same scoring heat.', v_name
      using errcode = '23514';
  end if;
  if v_floor is not null then
    select heat_number into v_number from public.event_competition_floor_heats where id = v_floor;
    for v_problem in
      select * from public._comp10d_floor_heat_problems(v_floor) pr order by (pr.problem = 'competitor_conflict') desc
    loop
      if v_problem.problem = 'competitor_conflict' then
        raise exception 'COMP10D_COMPETITOR_CONFLICT: % (heat %).', v_problem.detail, v_number using errcode = '23514';
      end if;
      raise exception 'COMP10D_INCOMPATIBLE_MUSIC: heat % would mix % -- divisions on the floor together must share the same dance or music.',
        v_number, v_problem.detail using errcode = '23514';
    end loop;
  end if;
  return null;
end;
$function$
;

revoke all on function public._comp10d_check_floor_heat_integrity() from public, anon, authenticated;

do $$
begin
  if position('COMP10D_ENTRY_NOT_SCHEDULABLE' in pg_get_functiondef('public._comp10d_check_floor_heat_integrity()'::regprocedure)) = 0 then
    raise exception '10D.1 postflight: eligibility rule not installed.';
  end if;
end $$;

commit;

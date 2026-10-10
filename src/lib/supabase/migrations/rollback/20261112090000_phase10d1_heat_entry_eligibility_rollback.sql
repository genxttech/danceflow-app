-- rollback/20261112090000_phase10d1_heat_entry_eligibility_rollback.sql
--
-- Restores the 10D body of _comp10d_check_floor_heat_integrity verbatim (eligibility enforced again only by
-- apply_competition_floor_plan). No data change. Safe at any time.

begin;

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
begin
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
  if md5(pg_get_functiondef('public._comp10d_check_floor_heat_integrity()'::regprocedure)) <> '115297ed38d09bed8456e9ca18c3b31d' then
    raise exception '10D.1 rollback postflight: the 10D body was not restored exactly.';
  end if;
end $$;

commit;

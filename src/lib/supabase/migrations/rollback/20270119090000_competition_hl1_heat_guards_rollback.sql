-- Rollback for 20270119090000_competition_hl1_heat_guards.sql.
-- Drops the two triggers and three helper functions and removes the single HL1 insertion from lock_competition_round_ballots,
-- verifying the md5 pin of the restored (post-SS1) text. Order: roll the app back first, then run this.

begin;

drop trigger if exists hl1_guard_heat_reopen on public.event_competition_heats;
drop trigger if exists hl1_guard_heat_lock on public.event_competition_heats;
drop function if exists public._hl1_guard_heat_reopen();
drop function if exists public._hl1_guard_heat_lock();

do $$
declare
  v_def text := replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r', '');
  v_new constant text :=
    E'  -- HL1: every ballot heat must have been danced (on the floor / finished, or a danced placement); an early heat lock alone is not enough.\n' ||
    E'  if exists (select 1 from public._compe2_round_heats(p_round_id) bh join public.event_competition_heats hh on hh.id = bh.heat_id\n' ||
    E'               where public._hl1_heat_is_danced(hh.id, hh.status) is not true) then\n' ||
    E'    raise exception ''COMP_HL1_HEAT_NOT_DANCED: every heat of the round must be danced before its ballots can be locked.'' using errcode = ''P0001'', detail = v_block::text;\n' ||
    E'  end if;\n\n';
begin
  if (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new) <> 1 then
    raise exception 'HL1 rollback refused: lock_competition_round_ballots does not hold the HL1 text exactly once (changed since HL1).';
  end if;
  v_def := replace(v_def, v_new, '');
  if md5(v_def) <> 'a10fc61528af902c0d7fd0e00caaa155' then
    raise exception 'HL1 rollback refused: restored text does not match the pinned pre-HL1 body.';
  end if;
  execute v_def;
end $$;

drop function if exists public._hl1_heat_is_danced(uuid, text);

commit;

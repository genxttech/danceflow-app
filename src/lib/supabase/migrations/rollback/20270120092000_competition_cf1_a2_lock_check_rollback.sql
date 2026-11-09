-- Rollback for 20270120092000_competition_cf1_a2_lock_check.sql.
-- Removes the single A2 block from lock_competition_round_ballots and verifies that the restored text is exactly the post-HL1 body
-- (md5 6e4175342d51ffe274d70ce413bae8c3). Order: app first, then this file, THEN HL1's rollback (HL1's rollback pins the pre-HL1 text).
-- Refused if the installed text is not the A2 text exactly once (changed since A2).

begin;

do $$
declare
  v_def text := replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r', '');
  v_block constant text :=
    E'  -- CF1 A2 (OD-17 D, stage lock; OD-15 A for callback Finals): entries of the ranking set last in the lock order (A.3), then the check in a fresh statement.\n' ||
    E'  perform 1 from public.event_competition_entries ce where ce.id = any (public._compe2_round_entries(p_round_id)) order by ce.id for share;\n' ||
    E'  perform public._cf1_require_roster_eligible(p_round_id, ''lock'');\n\n';
begin
  if (length(v_def) - length(replace(v_def, v_block, ''))) / length(v_block) <> 1 then
    raise exception 'CF1-A2 rollback refused: lock_competition_round_ballots does not hold the A2 block exactly once (changed since A2).';
  end if;
  v_def := replace(v_def, v_block, '');
  if md5(v_def) <> '6e4175342d51ffe274d70ce413bae8c3' then
    raise exception 'CF1-A2 rollback refused: the restored text does not match the pinned post-HL1 body.';
  end if;
  execute v_def;
end $$;

commit;

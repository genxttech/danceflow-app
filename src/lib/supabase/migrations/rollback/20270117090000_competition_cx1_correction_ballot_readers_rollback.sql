-- Rollback for 20270117090000_competition_cx1_correction_ballot_readers.sql.
-- Restores the two readers by reversing the single replacement and verifying the md5 pin of the restored (post-NS1) text.
-- Order: roll the app back first (it tolerates a missing correction_open: forms then stay closed during a correction), then run this.

begin;

do $$
declare
  r record;
  v_def text;
  v_old constant text := '''status'', v_round.status, ''scoring_method''';
  v_new constant text := '''status'', v_round.status, ''correction_open'', v_round.correction_open, ''scoring_method''';
begin
  for r in select * from (values
    ('public.competition_round_ballot_status(uuid)', '__PIN_STATUS__'),
    ('public.competition_judge_ballot_sheet(uuid)', '__PIN_SHEET__')
  ) as t(sig, pin) loop
    v_def := replace(pg_get_functiondef(r.sig::regprocedure), E'\r', '');
    if (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new) <> 1 then
      raise exception 'CX1 rollback refused: % does not hold the CX1 text exactly once (changed since CX1).', r.sig;
    end if;
    v_def := replace(v_def, v_new, v_old);
    if md5(v_def) <> r.pin then
      raise exception 'CX1 rollback refused: restored % does not match the pinned pre-CX1 text.', r.sig;
    end if;
    execute v_def;
  end loop;
end $$;

commit;

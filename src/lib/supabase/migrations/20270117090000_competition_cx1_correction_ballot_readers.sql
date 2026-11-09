-- Competition CX1: expose correction_open to the two ballot readers so the judge sheet and the ballot desk can show forms while a
-- results correction is open.
--
-- F2 (20270114) added event_competition_rounds.correction_open and patched the E2 write path to accept a ballot when the round is
-- `active` OR (`ballots_locked` AND correction_open). The two E2 readers return the round status but not that flag, and a judge or
-- scorer cannot read event_competition_rounds directly, so the UI could not tell a plain lock from an open correction.
--
-- Redefined (definer, stable; signature, grants and authorization checks unchanged):
--   competition_round_ballot_status(uuid)    round object gains 'correction_open'
--   competition_judge_ballot_sheet(uuid)     round object gains 'correction_open'
-- In each function the single text  'status', v_round.status, 'scoring_method'  becomes
--   'status', v_round.status, 'correction_open', v_round.correction_open, 'scoring_method'
-- Exact md5 pins of pg_get_functiondef with CRs removed, taken after E2 -> F2 -> NS1 (NS1 rewrote both bodies). Rollback restores them.
-- No write path, guard or grant changes: the DB guards stay the authority.
--
-- Apply order: after 20270116090000, SQL before the app. Rollback: app first, then the rollback file.

begin;

do $$
declare
  r record;
  v_def text;
  v_old constant text := '''status'', v_round.status, ''scoring_method''';
  v_new constant text := '''status'', v_round.status, ''correction_open'', v_round.correction_open, ''scoring_method''';
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'event_competition_rounds' and column_name = 'correction_open') then
    raise exception 'CX1 preflight: event_competition_rounds.correction_open is missing (F2 20270114 is not applied).';
  end if;
  if to_regprocedure('public.competition_heat_entry_is_no_show(uuid)') is null then
    raise exception 'CX1 preflight: NS1 20270115 is not applied.';
  end if;

  for r in select * from (values
    ('public.competition_round_ballot_status(uuid)', 'd1aca173a954764731862a341a1d5e7e'),
    ('public.competition_judge_ballot_sheet(uuid)', 'eada65f81faa04248816773818006a14')
  ) as t(sig, pin) loop
    v_def := replace(pg_get_functiondef(r.sig::regprocedure), E'\r', '');
    if md5(v_def) <> r.pin then
      raise exception 'CX1 preflight: % differs from the pinned E2/F2/NS1 text (md5 %); coordinate before changing it.', r.sig, md5(v_def);
    end if;
    if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
      raise exception 'CX1 preflight: % does not contain the expected round status text exactly once.', r.sig;
    end if;
    execute replace(v_def, v_old, v_new);
  end loop;
end $$;

commit;

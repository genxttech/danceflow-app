-- Rollback for 20270120096000_competition_cf1_a7_od13_correction_integrity.sql.
-- ROLL-FORWARD ONLY once a cause, co-sign or correction-ballot row exists: those rows are the audit of why a result changed.
-- Order: A7 rolls back BEFORE A6/A5/A3/A2/A4a/A0/A1 (it reads the A3 evidence and the A1/A5 exclusion rows) and after the app.
-- Restores the exact pinned prior text of _compe2_insert_ballot by reversing each replacement, verifying that the installed text still is
-- the post-A7 text (md5) and that the restored text matches the pre-A7 md5.

begin;

lock table public.event_competition_correction_causes in access exclusive mode;
lock table public.event_competition_correction_cosigns in access exclusive mode;
lock table public.event_competition_ballot_corrections in access exclusive mode;

do $$
begin
  if exists (select 1 from public.event_competition_correction_causes)
     or exists (select 1 from public.event_competition_correction_cosigns)
     or exists (select 1 from public.event_competition_ballot_corrections) then
    raise exception 'CF1-A7 rollback refused: correction cause / co-sign / ballot-correction rows exist (append-only audit); roll forward.';
  end if;
end $$;

create function pg_temp.cf1a7_pin_restore(p_sig text, p_pre text, p_post text, p_olds text[], p_news text[]) returns void
language plpgsql as $$
declare
  v_def text;
  v_i integer;
begin
  v_def := replace(pg_get_functiondef(p_sig::regprocedure), E'\r', '');
  if md5(v_def) <> p_post then
    raise exception 'CF1-A7 rollback refused: % is not the post-A7 text (md5 %, expected %); it changed since A7.', p_sig, md5(v_def), p_post;
  end if;
  for v_i in reverse array_length(p_olds, 1) .. 1 loop
    if (length(v_def) - length(replace(v_def, p_news[v_i], ''))) / length(p_news[v_i]) <> 1 then
      raise exception 'CF1-A7 rollback refused: % does not hold A7 text % exactly once.', p_sig, v_i;
    end if;
    v_def := replace(v_def, p_news[v_i], p_olds[v_i]);
  end loop;
  if md5(v_def) <> p_pre then
    raise exception 'CF1-A7 rollback refused: restored % does not match the pinned pre-A7 text.', p_sig;
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(p_sig::regprocedure), E'\r', '')) <> p_pre then
    raise exception 'CF1-A7 rollback: installed text of % does not match the pinned pre-A7 md5 after restore.', p_sig;
  end if;
end $$;

select pg_temp.cf1a7_pin_restore(
  'public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)', '4e16740112345ac0c306e841b82ac473', 'e5cecd7b4cff91bbdb7222cc5061b4d9',
  array[
    $o$v_reason text := nullif(btrim(coalesce(p_reason, '')), '');$o$,
    $o$insert into public.event_competition_ballots$o$,
    $o$from jsonb_array_elements(v_marks) m;$o$
  ],
  array[
    $n$v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_cf1_cause uuid;$n$,
    $n$-- CF1 A7 (OD-13): the correction-ballot rule, after the v_prior block and before the ballot INSERT.
    v_cf1_cause := public._cf1_check_correction_ballot(p_round_id, p_official_id, v_prior.id, v_marks, p_actor, p_entered_by);
    insert into public.event_competition_ballots$n$,
    $n$from jsonb_array_elements(v_marks) m;
  if v_cf1_cause is not null then
    perform public._cf1_record_ballot_correction(v_ballot.id, v_cf1_cause, p_actor, v_reason, p_request_id);
  end if;$n$
  ]);

drop trigger cf1_a7_backstop_ballot on public.event_competition_ballots;
drop trigger cf1_a7_backstop_correction on public.event_competition_ballot_corrections;
drop trigger cf1_a7_record_correction_cause on public.event_competition_rounds;
drop trigger cf1_a7_guard_cosign_insert on public.event_competition_correction_cosigns;
drop trigger cf1_a7_guard_exclusion_during_correction on public.event_competition_round_exclusions;

drop function public.cosign_competition_correction(uuid, uuid);
drop function public.competition_round_correction(uuid);
drop function public.cf1_a7_backstop_ballot();
drop function public.cf1_a7_backstop_correction();
drop function public.cf1_a7_record_correction_cause();
drop function public.cf1_a7_guard_cosign_insert();
drop function public.cf1_a7_guard_exclusion_during_correction();
drop function public._cf1_a7_backstop(uuid);
drop function public._cf1_check_correction_ballot(uuid, uuid, uuid, jsonb, uuid, uuid);
drop function public._cf1_record_ballot_correction(uuid, uuid, uuid, text, uuid);
drop function public._cf1_a7_rule(uuid, public.event_competition_correction_causes, uuid[], uuid[], uuid[]);
drop function public._cf1_a7_new_exclusions(uuid, uuid);
drop function public._cf1_a7_filers(uuid, uuid, uuid);
drop function public._cf1_a7_current_cause(uuid);
drop function public._cf1_a7_picks(uuid);
drop function public._cf1_a7_excluded_set(jsonb);

drop table public.event_competition_ballot_corrections;
drop table public.event_competition_correction_cosigns;
drop table public.event_competition_correction_causes;

commit;

-- rollback/20270114090000_competition_f2_results_lifecycle_rollback.sql
--
-- Reverts F2: restores E2's two ballot-status conditions, drops the lifecycle RPCs, guards and tables, and removes
-- event_competition_rounds.correction_open.
-- REFUSES (no evidence loss) if any result version, row, approval or audit row exists, if another table references an F2
-- table (F3 publications: roll F3 back first), or if a round is in an F2-owned state (calculated / approved) or has an
-- open correction. Roll the APP back first, then F3, then this file.

begin;

do $$
begin
  if to_regclass('public.event_competition_result_versions') is null then
    raise exception 'F2 rollback: event_competition_result_versions is absent (F2 not applied).';
  end if;
  if exists (select 1 from public.event_competition_result_versions)
     or exists (select 1 from public.event_competition_result_rows)
     or exists (select 1 from public.event_competition_result_approvals)
     or exists (select 1 from public.event_competition_result_events) then
    raise exception 'F2 rollback refused: result versions, rows, approvals or audit evidence exist.';
  end if;
  if exists (
    select 1 from pg_constraint c
    where c.confrelid in ('public.event_competition_result_versions'::regclass, 'public.event_competition_result_rows'::regclass,
                          'public.event_competition_result_approvals'::regclass, 'public.event_competition_result_events'::regclass)
      and c.conrelid not in ('public.event_competition_result_versions'::regclass, 'public.event_competition_result_rows'::regclass,
                             'public.event_competition_result_approvals'::regclass, 'public.event_competition_result_events'::regclass)
  ) then
    raise exception 'F2 rollback refused: another table references an F2 table (roll back F3 first).';
  end if;
  if exists (select 1 from public.event_competition_rounds r where r.status in ('calculated', 'approved') or r.correction_open) then
    raise exception 'F2 rollback refused: a round is calculated, approved or has an open correction.';
  end if;
end $$;

-- Restore E2's text (reverse of the exactly-once replacements in the F2 migration; fail if the F2 text is not found once).
do $$
declare
  v_def text;
  v_old_a constant text := 'if v_status is distinct from ''active'' and not (v_status = ''ballots_locked'' and exists (select 1 from public.event_competition_rounds cr where cr.id = new.round_id and cr.correction_open)) then';
  v_new_a constant text := 'if v_status is distinct from ''active'' then';
  v_old_b constant text := 'if v_round.status <> ''active'' and not (v_round.status = ''ballots_locked'' and v_round.correction_open) then';
  v_new_b constant text := 'if v_round.status <> ''active'' then';
begin
  v_def := pg_get_functiondef('public._compe2_guard_ballot_insert()'::regprocedure);
  if (length(v_def) - length(replace(v_def, v_old_a, ''))) / length(v_old_a) <> 1 then
    raise exception 'F2 rollback: _compe2_guard_ballot_insert does not carry the F2 condition exactly once.';
  end if;
  execute replace(v_def, v_old_a, v_new_a);

  v_def := pg_get_functiondef('public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)'::regprocedure);
  if (length(v_def) - length(replace(v_def, v_old_b, ''))) / length(v_old_b) <> 1 then
    raise exception 'F2 rollback: _compe2_insert_ballot does not carry the F2 condition exactly once.';
  end if;
  execute replace(v_def, v_old_b, v_new_b);
end $$;

do $$
begin
  if md5(replace(pg_get_functiondef('public._compe2_guard_ballot_insert()'::regprocedure), E'\r', '')) <> 'bf42705de4337864940a6f73b54afda9'
     or md5(replace(pg_get_functiondef('public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)'::regprocedure), E'\r', '')) <> 'f28880cece349cd1a52179f89ccf2e7c' then
    raise exception 'F2 rollback: restored E2 bodies do not match the pinned #331 text; rolled back.';
  end if;
end $$;

drop trigger if exists compf2_guard_ballot_order on public.event_competition_ballots;
drop function if exists public._compf2_guard_ballot_order();
drop trigger if exists compf2_invalidate_on_ballot on public.event_competition_ballots;
drop function if exists public._compf2_invalidate_on_ballot();
drop function if exists public._compf2_invalidate_versions(uuid, uuid, text, jsonb);
drop trigger if exists compf2_guard_round_status on public.event_competition_rounds;
drop function if exists public._compf2_guard_round_status();

drop function if exists public.open_competition_round_correction(uuid, text, uuid);
drop function if exists public.complete_competition_round(uuid, uuid);
drop function if exists public.approve_competition_round_result(uuid, uuid, text, uuid);
drop function if exists public.calculate_competition_round(uuid, text, text, text, text, jsonb, jsonb, jsonb, uuid);
drop function if exists public.competition_audit_log(uuid, uuid, integer);
drop function if exists public.competition_round_results_review(uuid);
drop function if exists public.competition_round_calculation_input(uuid);

drop table public.event_competition_result_events;
drop table public.event_competition_result_approvals;
drop table public.event_competition_result_rows;
drop table public.event_competition_result_versions;

drop function if exists public._compf2_event(uuid, uuid, uuid, text, uuid, text, text, uuid, text, jsonb);
drop function if exists public._compf2_input_hash(uuid, text, text);
drop function if exists public._compf2_evidence(uuid, text, text);
drop function if exists public._compf2_no_show_entries(uuid);
drop function if exists public._compf2_heat_entry_no_show(uuid);
drop function if exists public._compf2_round_all_heats(uuid);
drop function if exists public._compf2_engine_pin(uuid);
drop function if exists public._compf2_sha256(text);
drop function if exists public._compf2_canon(jsonb);
drop function if exists public._compf2_guard_version_update();
drop function if exists public._compf2_guard_version_insert();
drop function if exists public._compf2_guard_row_insert();
drop function if exists public._compf2_guard_approval_insert();

alter table public.event_competition_rounds drop column correction_open;

commit;

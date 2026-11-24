-- 20270219090000_competition_od04_event_delete_guard.sql
--
-- COMPETITION OS -- OD-04 (owner decision 2026-11-23, Option A "BLOCK"): an event that holds scoring evidence can no longer be hard-deleted.
--
-- STATUS: GIT-ONLY. NOT APPLIED ANYWHERE (not on DEV, not on PROD). PROD (and DEV) apply requires separate, explicit owner approval.
--         Apply this SQL before any app change that depends on it (there is none: the app has no event-delete path).
--         Rollback: rollback/20270219090000_competition_od04_event_delete_guard_rollback.sql
--
-- WHY. Before this migration a plain `delete from public.events` removed every ballot, mark, result, publication and audit row, because
-- every Competition OS table references events(id) ON DELETE CASCADE and the append-only guard (protect_competition_history_evidence,
-- 20261107090000) deliberately lets a row go when its parent event no longer exists. The results contract (scoring-results-contract.md
-- section 10) said event deletion was blocked once a ballot exists; no such guard existed (audit row X-18 / OD-04).
--
-- WHAT THIS DOES.
--   * BEFORE DELETE trigger on public.events (row level): refuses the delete when ANY row exists in the "scoring evidence" tables listed in
--     _compod04_evidence_tables() for that event. The check runs BEFORE any cascade starts, so no evidence row is ever touched. It covers
--     every path that deletes an events row: a direct delete, the cascade of a studio / organizer / owner delete, a bulk delete.
--     Studio and Custom programs are covered the same way: the test is "evidence rows exist", not a body/format/profile.
--   * BEFORE TRUNCATE trigger on public.events (statement level): refuses while evidence exists for ANY event.
--   * Both triggers are ENABLE ALWAYS, so `session_replication_role = replica` does not bypass them.
--   * The guard takes FOR UPDATE on the event row before it looks, so a concurrent ballot / result insert (which holds FOR KEY SHARE on the
--     event row through its foreign key) either commits first (and is seen) or waits until the delete has finished (and then fails its foreign key).
--   * The evidence reader is SECURITY DEFINER with a pinned search_path so row-level security cannot hide evidence from the deleting role.
--
-- WHAT THIS DOES NOT DO (stated so nobody over-reads it).
--   * An event WITHOUT scoring evidence is deleted exactly as before (existing authorization, existing cascades). Ordinary (non-competition)
--     events have no such rows and are unaffected; no other table, policy, privilege or function is changed.
--   * It does not archive, hide or time-limit anything and it deletes nothing automatically. There is NO "30 days then delete" behavior:
--     NDCA III.E item 2 (retain original adjudicators' score sheets 30 days after the event closes) and WSDC Registry Event Rules 3.1 item 9
--     (results open to competitors at least 30 days) are minimum durations; this guard keeps the evidence for as long as the event row exists.
--   * It does not stop a database superuser from `alter table ... disable trigger` or from dropping the trigger (accepted residual risk, same
--     class as the other Competition OS guards), and it does not govern deletes of individual child rows (those are the existing append-only
--     triggers and state guards).
--
-- "SCORING EVIDENCE" = rows that record what a judge marked, what was calculated or decided from it, what was published, or a correction to any of
-- those. It is decided per table in _compod04_evidence_tables(); the SQL suite fails if a table reachable from events is neither listed there nor
-- named in its own explicit not-protected list, so a new table cannot silently fall outside the decision.
--
-- Design decisions taken here (DanceFlow policy, not a governing-body rule; recorded in the rule register as OD04-0001..0003):
--   * Drafts (event_competition_ballot_drafts) are NOT evidence (they are working copies that never enter hashes or results).
--   * Setup, registration, schedule, heat, officials/panel, check-in and money tables are NOT scoring evidence: an event that has none of the
--     listed rows (for example one that was only set up or only took registrations) stays deletable, as the owner required.
--   * Money has its own protection (competition refund tables are ON DELETE RESTRICT) and is untouched.

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflight: every protected table must exist (the chain through CF1 / F3 must be applied first)
-- ---------------------------------------------------------------------------
do $$
declare
  v_name text;
begin
  if to_regclass('public.events') is null then
    raise exception 'OD-04 preflight: public.events is missing.';
  end if;
  foreach v_name in array array[
    'event_competition_ballots', 'event_competition_marks', 'event_competition_ballot_events', 'event_competition_ballot_corrections',
    'event_competition_judge_attendance',
    'event_competition_result_versions', 'event_competition_result_rows', 'event_competition_result_events',
    'event_competition_result_approvals', 'event_competition_result_publications',
    'event_competition_round_advancements', 'event_competition_round_advancement_entries', 'event_competition_round_advancement_heats',
    'event_competition_round_advancement_revocations', 'event_competition_round_capacity_events',
    'event_competition_round_exclusions', 'event_competition_correction_causes', 'event_competition_correction_cosigns',
    'event_competition_final_withdrawals', 'event_competition_final_withdrawal_requests',
    'event_competition_final_withdrawal_request_cancellations'
  ] loop
    if to_regclass('public.' || quote_ident(v_name)) is null then
      raise exception 'OD-04 preflight: table public.% is missing (apply the Competition chain through CF1 and F3 first).', v_name;
    end if;
  end loop;
  if exists (
    select 1 from pg_trigger
    where tgrelid = 'public.events'::regclass and tgname in ('a00_compod04_events_delete_guard', 'a00_compod04_events_truncate_guard')
  ) then
    raise exception 'OD-04 preflight: the guard is already installed (roll back or clean up a partial earlier run first).';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The decision: which tables hold protected scoring evidence
-- ---------------------------------------------------------------------------
create or replace function public._compod04_evidence_tables()
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select array[
    -- judges' ballots and everything that records, corrects or locks them (E2, CX1)
    'event_competition_ballots',
    'event_competition_marks',
    'event_competition_ballot_events',
    'event_competition_ballot_corrections',
    'event_competition_judge_attendance',
    -- calculated results, their approval, publication and audit (F2, F3, PV-1)
    'event_competition_result_versions',
    'event_competition_result_rows',
    'event_competition_result_events',
    'event_competition_result_approvals',
    'event_competition_result_publications',
    -- decisions derived from results or that change a result's population (CF1 A0, A1, A5, A6, A7)
    'event_competition_round_advancements',
    'event_competition_round_advancement_entries',
    'event_competition_round_advancement_heats',
    'event_competition_round_advancement_revocations',
    'event_competition_round_capacity_events',
    'event_competition_round_exclusions',
    'event_competition_correction_causes',
    'event_competition_correction_cosigns',
    'event_competition_final_withdrawals',
    'event_competition_final_withdrawal_requests',
    'event_competition_final_withdrawal_request_cancellations'
  ]::text[];
$$;

-- Returns the protected tables that hold at least one row for the event ('{}' = none). SECURITY DEFINER so RLS cannot hide evidence from
-- the role that issues the delete.
create or replace function public._compod04_event_evidence(p_event uuid)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_table text;
  v_has boolean;
  v_found text[] := '{}'::text[];
begin
  foreach v_table in array public._compod04_evidence_tables() loop
    execute format('select exists (select 1 from public.%I where event_id = $1)', v_table) into v_has using p_event;
    if v_has then
      v_found := v_found || v_table;
    end if;
  end loop;
  return v_found;
end;
$$;

-- Returns the protected tables that hold at least one row for ANY event (used by the TRUNCATE guard).
create or replace function public._compod04_any_evidence()
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_table text;
  v_has boolean;
  v_found text[] := '{}'::text[];
begin
  foreach v_table in array public._compod04_evidence_tables() loop
    execute format('select exists (select 1 from public.%I)', v_table) into v_has;
    if v_has then
      v_found := v_found || v_table;
    end if;
  end loop;
  return v_found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The guards
-- ---------------------------------------------------------------------------
create or replace function public.compod04_guard_event_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_found text[];
begin
  -- Serialize with concurrent evidence writers: they hold FOR KEY SHARE on this row through their foreign key, so this waits for them
  -- (and then sees their rows) or they wait for this transaction (and then fail their foreign key).
  perform 1 from public.events e where e.id = old.id for update;

  v_found := public._compod04_event_evidence(old.id);
  if cardinality(v_found) > 0 then
    raise exception 'COMP_EVENT_HAS_SCORING_EVIDENCE: event % holds scoring evidence and cannot be deleted (%). Cancel, complete or hide the event instead; nothing was removed.',
      old.id, array_to_string(v_found, ', ')
      using errcode = '23503',
            hint = 'OD-04: a Competition OS event with ballots, results, publications or their corrections is retained. Set the event status to cancelled or completed, or its visibility to private.';
  end if;
  return old;
end;
$$;

create or replace function public.compod04_guard_event_truncate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_found text[];
begin
  v_found := public._compod04_any_evidence();
  if cardinality(v_found) > 0 then
    raise exception 'COMP_EVENT_HAS_SCORING_EVIDENCE: events cannot be truncated while scoring evidence exists (%).', array_to_string(v_found, ', ')
      using errcode = '23503';
  end if;
  return null;
end;
$$;

revoke all on function public._compod04_evidence_tables() from public, anon, authenticated;
revoke all on function public._compod04_event_evidence(uuid) from public, anon, authenticated;
revoke all on function public._compod04_any_evidence() from public, anon, authenticated;
revoke all on function public.compod04_guard_event_delete() from public, anon, authenticated;
revoke all on function public.compod04_guard_event_truncate() from public, anon, authenticated;

-- "a00_" sorts the delete guard ahead of any other BEFORE DELETE trigger on events, so no other trigger can act before the check.
create trigger a00_compod04_events_delete_guard
  before delete on public.events
  for each row execute function public.compod04_guard_event_delete();
alter table public.events enable always trigger a00_compod04_events_delete_guard;

create trigger a00_compod04_events_truncate_guard
  before truncate on public.events
  for each statement execute function public.compod04_guard_event_truncate();
alter table public.events enable always trigger a00_compod04_events_truncate_guard;

comment on function public.compod04_guard_event_delete() is
  'OD-04 (2026-11-23): refuses to delete an events row while any scoring-evidence row exists for it (see _compod04_evidence_tables). Not a retention timer: nothing is deleted automatically.';

commit;

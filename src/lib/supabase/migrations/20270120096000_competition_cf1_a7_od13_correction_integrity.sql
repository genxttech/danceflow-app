-- Competition CF1 package A7: OD-13 correction-ballot integrity (Option R), judge-entry-error co-sign, ballot-correction storage.
--
-- Design: docs/competition/callback-to-final-advancement-design.md 4.1 (OD-13, Option R), 4.6 (OD-13b C, OD-13c A, OD-19 D), A.9.
-- A0 left this scope out (docs/competition/cf1-a0-contract.md "Status / not delivered"). Stacked on A0 + A1 + A3 + A5.
--
--   Tables (insert-only; RLS on, no policies, no grants of any kind; history triggers ENABLE ALWAYS):
--     event_competition_correction_causes      one row per correction opening, written by a status-edge trigger, never updated
--     event_competition_correction_cosigns     one row per judge_entry_error cause (separate row, never an edit of the cause)
--     event_competition_ballot_corrections     original / replacement / reason / actor / at / diff, one per correction ballot
--   Functions:
--     cosign_competition_correction(cause_id, request_id)       chair or manager, verified email (authenticated only)
--     competition_round_correction(round_id)                     read: cause, co-sign, live restricted set, correction ballots (A7 extra)
--     _cf1_check_correction_ballot / _cf1_record_ballot_correction   called from the pinned _compe2_insert_ballot (no grants)
--     _cf1_a7_rule, _cf1_a7_excluded_set, _cf1_a7_picks, _cf1_a7_current_cause, _cf1_a7_filers   (no grants)
--   Triggers:
--     cf1_a7_record_correction_cause   AFTER UPDATE OF status ON event_competition_rounds (the F2 correction edge): derives and stores the cause,
--                                      raises COMP_CORRECTION_CAUSE_REQUIRED when it cannot. The F2 RPC needs no signature change.
--     cf1_a7_guard_cosign_insert       BEFORE INSERT ON ..._cosigns: cause kind and co-signer is not the opener (the RPC checks role and current correction)
--     cf1_a7_guard_exclusion_during_correction   BEFORE INSERT ON round_exclusions (A1 table): refuses every exclusion decision while a correction is open (A7-1)
--     cf1_a7_backstop_ballot / _correction   DEFERRED constraint triggers: the same rule at commit, so no other writer can bypass the RPC check
--   Redefined (pinned text-replace, md5 from an applied chain): public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid), three
--   single-line anchors: a declaration, the check before the ballot INSERT (after the v_prior block), the record after the marks INSERT.
--
-- Rule (callback_yes@1 only; a correction opened when the round is calculated / approved / published, i.e. round.correction_open):
--   X = (exclusion set now) minus (exclusion set of the baseline result version), where "exclusion set" is exactly what the F2 evidence computes
--   (scratched, NS1 no-show, A5 excluded). X is read live, the cause row snapshots X at open.
--   Option R: the cause is entry_exclusion OR X is not empty. A judge may file a new version only if the current ballot holds a pick in X; every other
--   pick must stay, every pick in X must go, nothing else changes (COMP_CORRECTION_BALLOT_NOT_PERMITTED / _RESTRICTED).
--   Option F: otherwise (judge_entry_error) any valid ballot, but only after a co-sign by a different person from the opener who is not the filer.
--   A first ballot (no current ballot) cannot be filed during a correction.
--
-- Lock order: cosign = event advisory lock, round FOR UPDATE (serialises with ballot filers, which hold the round FOR SHARE). The trigger runs
-- inside the F2 RPC's round lock. Ballot filing is unchanged (pair advisory lock, round FOR SHARE).
-- Rollback: rollback/20270120096000_competition_cf1_a7_od13_correction_integrity_rollback.sql (refused once a cause row exists).

begin;

do $$
begin
  if to_regclass('public.event_competition_round_exclusions') is null
     or to_regprocedure('public._cf1_excluded_entries(uuid)') is null then
    raise exception 'CF1-A7 preflight: A1 (20270120085000) is missing.';
  end if;
  if position('_cf1_excluded_entries' in pg_get_functiondef('public._compf2_evidence(uuid,text,text)'::regprocedure)) = 0 then
    raise exception 'CF1-A7 preflight: A3 (20270120093000) is missing (the F2 evidence does not read the A5 exclusions).';
  end if;
  if to_regprocedure('public.cosign_round_exclusion(uuid,uuid)') is null then
    raise exception 'CF1-A7 preflight: A5 (20270120094000) is missing.';
  end if;
  if to_regprocedure('public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)') is null
     or to_regprocedure('public._compe2_round_role(uuid)') is null
     or to_regprocedure('public._compo1_lock_event(uuid)') is null
     or to_regprocedure('public.verified_email_for_user(uuid)') is null
     or to_regprocedure('public.protect_competition_history_evidence()') is null
     or to_regprocedure('public._compf2_event(uuid,uuid,uuid,text,uuid,text,text,uuid,text,jsonb)') is null then
    raise exception 'CF1-A7 preflight: E2 / F2 / O1 objects are missing.';
  end if;
  if to_regclass('public.event_competition_correction_causes') is not null
     or to_regclass('public.event_competition_correction_cosigns') is not null
     or to_regclass('public.event_competition_ballot_corrections') is not null
     or to_regprocedure('public.cosign_competition_correction(uuid,uuid)') is not null
     or position('_cf1_check_correction_ballot' in pg_get_functiondef('public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)'::regprocedure)) > 0 then
    raise exception 'CF1-A7 preflight: A7 appears to be applied already (roll back or clean up a partial earlier run first).';
  end if;
end $$;

-- Pinned text-replace helper (session-local): the installed text must match the pin, every old text must occur exactly once, and the
-- redefined text must match the expected md5.
create function pg_temp.cf1a7_pin_replace(p_sig text, p_pre text, p_post text, p_olds text[], p_news text[]) returns void
language plpgsql as $$
declare
  v_def text;
  v_i integer;
begin
  v_def := replace(pg_get_functiondef(p_sig::regprocedure), E'\r', '');
  if md5(v_def) <> p_pre then
    raise exception 'CF1-A7 preflight: % differs from the pinned text (md5 %, expected %); coordinate before changing it.', p_sig, md5(v_def), p_pre;
  end if;
  for v_i in 1 .. array_length(p_olds, 1) loop
    if (length(v_def) - length(replace(v_def, p_olds[v_i], ''))) / length(p_olds[v_i]) <> 1 then
      raise exception 'CF1-A7 preflight: % does not contain anchor % exactly once.', p_sig, v_i;
    end if;
    v_def := replace(v_def, p_olds[v_i], p_news[v_i]);
  end loop;
  if md5(v_def) <> p_post then
    raise exception 'CF1-A7: redefined text of % has md5 % (expected %).', p_sig, md5(v_def), p_post;
  end if;
  execute v_def;
  if md5(replace(pg_get_functiondef(p_sig::regprocedure), E'\r', '')) <> p_post then
    raise exception 'CF1-A7: installed text of % does not match the expected post-A7 md5 after redefinition.', p_sig;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.event_competition_correction_causes (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  cause text not null,
  excluded_entry_ids uuid[] not null default '{}'::uuid[],
  baseline_version_id uuid not null,
  opened_by uuid not null,
  reason text not null,
  at timestamptz not null default now(),
  request_id uuid not null,
  transaction_id bigint not null default txid_current(),
  constraint event_competition_correction_causes_round_fk
    foreign key (round_id, event_id) references public.event_competition_rounds(id, event_id),
  constraint event_competition_correction_causes_baseline_fk
    foreign key (baseline_version_id, event_id) references public.event_competition_result_versions(id, event_id),
  constraint event_competition_correction_causes_cause_check check (cause in ('entry_exclusion', 'judge_entry_error')),
  constraint event_competition_correction_causes_excluded_check
    check ((cause = 'entry_exclusion') = (cardinality(excluded_entry_ids) > 0)),
  constraint event_competition_correction_causes_reason_check check (length(btrim(reason)) between 1 and 500),
  unique (id, event_id),
  unique (request_id)
);
create index event_competition_correction_causes_round_idx on public.event_competition_correction_causes(round_id, seq desc);

create table public.event_competition_correction_cosigns (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  cause_id uuid not null,
  cosigned_by uuid not null,
  role text not null,
  at timestamptz not null default now(),
  request_id uuid not null,
  transaction_id bigint not null default txid_current(),
  constraint event_competition_correction_cosigns_cause_fk
    foreign key (cause_id, event_id) references public.event_competition_correction_causes(id, event_id),
  constraint event_competition_correction_cosigns_role_check check (role in ('chair', 'manager')),
  unique (cause_id),
  unique (request_id)
);

create table public.event_competition_ballot_corrections (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  round_id uuid not null,
  official_id uuid not null,
  ballot_id uuid not null,
  supersedes_id uuid not null,
  cause_id uuid not null,
  reason text not null,
  actor uuid not null,
  at timestamptz not null default now(),
  original_picks uuid[] not null,
  replacement_picks uuid[] not null,
  diff jsonb not null,
  request_id uuid not null,
  transaction_id bigint not null default txid_current(),
  constraint event_competition_ballot_corrections_ballot_fk
    foreign key (ballot_id, event_id) references public.event_competition_ballots(id, event_id),
  constraint event_competition_ballot_corrections_supersedes_fk
    foreign key (supersedes_id, event_id) references public.event_competition_ballots(id, event_id),
  constraint event_competition_ballot_corrections_cause_fk
    foreign key (cause_id, event_id) references public.event_competition_correction_causes(id, event_id),
  constraint event_competition_ballot_corrections_official_fk
    foreign key (official_id, event_id) references public.event_competition_officials(id, event_id),
  constraint event_competition_ballot_corrections_reason_check check (length(btrim(reason)) between 1 and 500),
  constraint event_competition_ballot_corrections_diff_check
    check (jsonb_typeof(diff) = 'object' and diff ? 'removed' and diff ? 'added' and diff ? 'unchanged'),
  unique (ballot_id),
  unique (request_id)
);
create index event_competition_ballot_corrections_round_idx on public.event_competition_ballot_corrections(round_id, at);
create index event_competition_ballot_corrections_cause_idx on public.event_competition_ballot_corrections(cause_id);

comment on table public.event_competition_correction_causes is
  'CF1 OD-13: insert-only record of why a correction was opened (entry_exclusion or judge_entry_error), derived by the system at the status edge; never supplied by a caller.';
comment on table public.event_competition_correction_cosigns is
  'CF1 OD-13b/OD-19: insert-only co-sign (chair or manager, a different person from the opener) required before a judge_entry_error replacement ballot is accepted.';
comment on table public.event_competition_ballot_corrections is
  'CF1 OD-13: insert-only original/replacement picks, reason, actor, time and diff of every callback_yes correction ballot, written in the replacement ballot''s transaction.';

alter table public.event_competition_correction_causes enable row level security;
alter table public.event_competition_correction_cosigns enable row level security;
alter table public.event_competition_ballot_corrections enable row level security;
revoke all on public.event_competition_correction_causes from public, anon, authenticated, service_role;
revoke all on public.event_competition_correction_cosigns from public, anon, authenticated, service_role;
revoke all on public.event_competition_ballot_corrections from public, anon, authenticated, service_role;

create trigger protect_event_competition_correction_causes_history
  before update or delete on public.event_competition_correction_causes
  for each row execute function public.protect_competition_history_evidence();
create trigger protect_event_competition_correction_causes_hist_trunc
  before truncate on public.event_competition_correction_causes
  for each statement execute function public.protect_competition_history_evidence();
create trigger protect_event_competition_correction_cosigns_history
  before update or delete on public.event_competition_correction_cosigns
  for each row execute function public.protect_competition_history_evidence();
create trigger protect_event_competition_correction_cosigns_hist_trunc
  before truncate on public.event_competition_correction_cosigns
  for each statement execute function public.protect_competition_history_evidence();
create trigger protect_event_competition_ballot_corrections_history
  before update or delete on public.event_competition_ballot_corrections
  for each row execute function public.protect_competition_history_evidence();
create trigger protect_event_competition_ballot_corrections_hist_trunc
  before truncate on public.event_competition_ballot_corrections
  for each statement execute function public.protect_competition_history_evidence();
alter table public.event_competition_correction_causes enable always trigger protect_event_competition_correction_causes_history;
alter table public.event_competition_correction_causes enable always trigger protect_event_competition_correction_causes_hist_trunc;
alter table public.event_competition_correction_cosigns enable always trigger protect_event_competition_correction_cosigns_history;
alter table public.event_competition_correction_cosigns enable always trigger protect_event_competition_correction_cosigns_hist_trunc;
alter table public.event_competition_ballot_corrections enable always trigger protect_event_competition_ballot_corrections_history;
alter table public.event_competition_ballot_corrections enable always trigger protect_event_competition_ballot_corrections_hist_trunc;

-- ---------------------------------------------------------------------------
-- 2. Internal helpers (no grants)
-- ---------------------------------------------------------------------------
-- entry ids named by an evidence 'excludedEntries' array, sorted and distinct
create function public._cf1_a7_excluded_set(p_excluded jsonb)
returns uuid[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct (e ->> 'entryId')::uuid order by (e ->> 'entryId')::uuid), '{}'::uuid[])
  from jsonb_array_elements(case when jsonb_typeof(p_excluded) = 'array' then p_excluded else '[]'::jsonb end) e;
$$;

-- the entry ids a callback ballot picks, sorted
create function public._cf1_a7_picks(p_ballot_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(m.entry_id order by m.entry_id), '{}'::uuid[])
  from public.event_competition_marks m where m.ballot_id = p_ballot_id;
$$;

-- the cause row of the correction that is currently open (the latest one written for the round)
create function public._cf1_a7_current_cause(p_round_id uuid)
returns public.event_competition_correction_causes
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.* from public.event_competition_correction_causes c where c.round_id = p_round_id order by c.seq desc limit 1;
$$;

-- user ids that file a ballot: the submitter, the judge and the entering scorer
create function public._cf1_a7_filers(p_actor uuid, p_official_id uuid, p_entered_by uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct u), '{}'::uuid[]) from (
    select p_actor as u
    union all select o.user_id from public.event_competition_officials o where o.id in (p_official_id, p_entered_by)
  ) s where u is not null;
$$;

-- exclusion set now minus the baseline's, read exactly as the F2 evidence computes it
create function public._cf1_a7_new_exclusions(p_round_id uuid, p_baseline_version_id uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base public.event_competition_result_versions;
begin
  select * into v_base from public.event_competition_result_versions v where v.id = p_baseline_version_id;
  if not found then
    raise exception 'COMP_CORRECTION_CAUSE_REQUIRED: the baseline result version is missing.' using errcode = 'P0001';
  end if;
  return coalesce(array(
    select x from unnest(public._cf1_a7_excluded_set(public._compf2_evidence(p_round_id, v_base.engine_key, v_base.engine_version) -> 'excludedEntries')) x
    except
    select x from unnest(public._cf1_a7_excluded_set(v_base.input -> 'excludedEntries')) x), '{}'::uuid[]);
end;
$$;

-- The rule, shared by the RPC-side check and the commit-time backstops. Raises, or returns.
create function public._cf1_a7_rule(
  p_round_id uuid, p_cause public.event_competition_correction_causes, p_old uuid[], p_new uuid[], p_filers uuid[]
) returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_x uuid[];
  v_ox uuid[];
  v_dropped uuid[];
  v_kept uuid[];
  v_added uuid[];
begin
  -- A7-2 (owner decision): the manager who opened the correction never files its replacement ballot, in either mode.
  if p_cause.opened_by = any (p_filers) then
    raise exception 'COMP_CORRECTION_OPENER_CONFLICT: the person who opened this correction cannot file its replacement ballot; a separate eligible official must.'
      using errcode = 'P0001';
  end if;
  v_x := public._cf1_a7_new_exclusions(p_round_id, p_cause.baseline_version_id);
  if p_cause.cause = 'entry_exclusion' or cardinality(v_x) > 0 then
    v_ox := array(select x from unnest(p_old) x where x = any (v_x));
    if cardinality(v_ox) = 0 then
      raise exception 'COMP_CORRECTION_BALLOT_NOT_PERMITTED: this correction is limited to the excluded couples; the judge''s current ballot has no pick among them.'
        using errcode = 'P0001';
    end if;
    v_dropped := array(select x from unnest(p_old) x where x <> all (v_x) and x <> all (p_new));
    v_kept := array(select x from unnest(p_new) x where x = any (v_x));
    v_added := array(select x from unnest(p_new) x where x <> all (p_old));
    if cardinality(v_dropped) > 0 or cardinality(v_kept) > 0 or cardinality(v_added) <> cardinality(v_ox) then
      raise exception 'COMP_CORRECTION_BALLOT_RESTRICTED: only the excluded picks may be replaced, each by a new couple not already picked and not excluded.'
        using errcode = 'P0001',
              detail = jsonb_build_object('removed_other_picks', to_jsonb(v_dropped), 'kept_excluded', to_jsonb(v_kept),
                                          'expected_replacements', cardinality(v_ox), 'added', to_jsonb(v_added))::text;
    end if;
    return;
  end if;
  if not exists (select 1 from public.event_competition_correction_cosigns s where s.cause_id = p_cause.id) then
    raise exception 'COMP_CORRECTION_COSIGN_REQUIRED: a judge-entry correction needs a co-sign by the chair or another manager before a replacement ballot is accepted.'
      using errcode = 'P0001';
  end if;
  if exists (select 1 from public.event_competition_correction_cosigns s where s.cause_id = p_cause.id and s.cosigned_by = any (p_filers)) then
    raise exception 'COMP_CORRECTION_COSIGNER_CONFLICT: the co-signer of this correction cannot file a replacement ballot under it.' using errcode = 'P0001';
  end if;
end;
$$;

-- Called by the pinned _compe2_insert_ballot, after the v_prior block and immediately before the ballot INSERT.
-- Returns the cause id when the ballot is a correction ballot under an open correction, null when the rule does not apply.
create function public._cf1_check_correction_ballot(
  p_round_id uuid, p_official_id uuid, p_prior_id uuid, p_marks jsonb, p_actor uuid, p_entered_by uuid
) returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_round public.event_competition_rounds;
  v_format text;
  v_fver integer;
  v_cause public.event_competition_correction_causes;
begin
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  if not found or not v_round.correction_open then
    return null;
  end if;
  select f.format, f.version into v_format, v_fver from public._compe2_format_for_scoring(v_round.scoring_method) f;
  if v_format = 'callback_yes' and v_fver is distinct from 1 then
    raise exception 'COMP_CORRECTION_FORMAT_UNSUPPORTED: callback_yes@% has no correction rule; corrections fail closed.', v_fver using errcode = 'P0001';
  end if;
  if v_format is distinct from 'callback_yes' then
    return null;
  end if;
  v_cause := public._cf1_a7_current_cause(p_round_id);
  if v_cause.id is null then
    raise exception 'COMP_CORRECTION_CAUSE_REQUIRED: this correction has no recorded cause; reopen it.' using errcode = 'P0001';
  end if;
  if p_prior_id is null then
    raise exception 'COMP_CORRECTION_BALLOT_NOT_PERMITTED: a first ballot cannot be filed during a correction; only a judge''s existing ballot can be corrected.'
      using errcode = 'P0001';
  end if;
  perform public._cf1_a7_rule(
    p_round_id, v_cause, public._cf1_a7_picks(p_prior_id),
    coalesce(array(select (m ->> 'entry_id')::uuid from jsonb_array_elements(p_marks) m order by 1), '{}'::uuid[]),
    public._cf1_a7_filers(p_actor, p_official_id, p_entered_by));
  return v_cause.id;
end;
$$;

-- Called by the pinned _compe2_insert_ballot after the marks are inserted: stores original, replacement, reason, actor, time and diff.
create function public._cf1_record_ballot_correction(p_ballot_id uuid, p_cause_id uuid, p_actor uuid, p_reason text, p_request_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_b public.event_competition_ballots;
  v_old uuid[];
  v_new uuid[];
  v_removed uuid[];
  v_added uuid[];
begin
  select * into v_b from public.event_competition_ballots b where b.id = p_ballot_id;
  v_old := public._cf1_a7_picks(v_b.supersedes_id);
  v_new := public._cf1_a7_picks(v_b.id);
  v_removed := array(select x from unnest(v_old) x where x <> all (v_new));
  v_added := array(select x from unnest(v_new) x where x <> all (v_old));
  insert into public.event_competition_ballot_corrections
    (event_id, round_id, official_id, ballot_id, supersedes_id, cause_id, reason, actor, original_picks, replacement_picks, diff, request_id)
  values (v_b.event_id, v_b.round_id, v_b.official_id, v_b.id, v_b.supersedes_id, p_cause_id, p_reason, p_actor, v_old, v_new,
          jsonb_build_object('removed', to_jsonb(v_removed), 'added', to_jsonb(v_added), 'unchanged', cardinality(v_old) - cardinality(v_removed)),
          p_request_id);
end;
$$;

revoke all on function public._cf1_a7_excluded_set(jsonb) from public, anon, authenticated, service_role;
revoke all on function public._cf1_a7_picks(uuid) from public, anon, authenticated, service_role;
revoke all on function public._cf1_a7_current_cause(uuid) from public, anon, authenticated, service_role;
revoke all on function public._cf1_a7_filers(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._cf1_a7_new_exclusions(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._cf1_a7_rule(uuid, public.event_competition_correction_causes, uuid[], uuid[], uuid[]) from public, anon, authenticated, service_role;
revoke all on function public._cf1_check_correction_ballot(uuid, uuid, uuid, jsonb, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public._cf1_record_ballot_correction(uuid, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Status-edge trigger: derive and store the cause when a correction opens
-- ---------------------------------------------------------------------------
create function public.cf1_a7_record_correction_cause()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ev public.event_competition_result_events;
  v_base public.event_competition_result_versions;
  v_x uuid[];
begin
  if not (new.status = 'ballots_locked' and new.correction_open and old.status in ('calculated', 'approved', 'published')) then
    return new;
  end if;
  select * into v_ev from public.event_competition_result_events e
  where e.round_id = new.id and e.event_id = new.event_id and e.transaction_id = txid_current()
    and e.kind = 'round_state_changed' and e.to_state = 'ballots_locked'
  order by e.occurred_at desc limit 1;
  if not found then
    raise exception 'COMP_CORRECTION_CAUSE_REQUIRED: the correction has no audit row; its cause cannot be recorded.' using errcode = 'P0001';
  end if;
  -- Baseline: the highest-numbered version whatever its status (F2 has already marked it stale in this transaction when it was approved).
  select * into v_base from public.event_competition_result_versions v where v.round_id = new.id order by v.version desc limit 1;
  if not found then
    raise exception 'COMP_CORRECTION_CAUSE_REQUIRED: the round has no result version to compare against.' using errcode = 'P0001';
  end if;
  v_x := public._cf1_a7_new_exclusions(new.id, v_base.id);
  insert into public.event_competition_correction_causes
    (event_id, round_id, cause, excluded_entry_ids, baseline_version_id, opened_by, reason, request_id)
  values (new.event_id, new.id, case when cardinality(v_x) > 0 then 'entry_exclusion' else 'judge_entry_error' end, v_x, v_base.id,
          v_ev.actor_user_id, left(coalesce(nullif(btrim(v_ev.reason), ''), 'correction opened'), 500), v_ev.request_id);
  return new;
end;
$$;
revoke all on function public.cf1_a7_record_correction_cause() from public, anon, authenticated, service_role;

create trigger cf1_a7_record_correction_cause after update of status on public.event_competition_rounds
  for each row when (new.status = 'ballots_locked' and new.correction_open) execute function public.cf1_a7_record_correction_cause();
alter table public.event_competition_rounds enable always trigger cf1_a7_record_correction_cause;

-- ---------------------------------------------------------------------------
-- 4. Co-sign: guard trigger and RPC
-- ---------------------------------------------------------------------------
create function public.cf1_a7_guard_cosign_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cause public.event_competition_correction_causes;
begin
  select * into v_cause from public.event_competition_correction_causes c where c.id = new.cause_id and c.event_id = new.event_id;
  if not found or v_cause.cause <> 'judge_entry_error' then
    raise exception 'COMP_CORRECTION_COSIGN_NOT_REQUIRED: only a judge_entry_error correction takes a co-sign.' using errcode = 'P0001';
  end if;
  if new.cosigned_by = v_cause.opened_by then
    raise exception 'COMP_CORRECTION_COSIGN_SAME_PERSON: the co-signer must be a different person from the opener.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_a7_guard_cosign_insert() from public, anon, authenticated, service_role;
create trigger cf1_a7_guard_cosign_insert before insert on public.event_competition_correction_cosigns
  for each row execute function public.cf1_a7_guard_cosign_insert();
alter table public.event_competition_correction_cosigns enable always trigger cf1_a7_guard_cosign_insert;

create function public.cosign_competition_correction(p_cause_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_cause public.event_competition_correction_causes;
  v_round public.event_competition_rounds;
  v_role text;
  v_prev public.event_competition_correction_cosigns;
  v_row public.event_competition_correction_cosigns;
begin
  if v_uid is null or p_cause_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_cause from public.event_competition_correction_causes c where c.id = p_cause_id;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  v_role := public._compe2_round_role(v_cause.round_id);
  if coalesce(v_role, '') not in ('manager', 'chair') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required to co-sign a correction.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;

  perform public._compo1_lock_event(v_cause.event_id);
  select * into v_round from public.event_competition_rounds r where r.id = v_cause.round_id for update;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;

  select * into v_prev from public.event_competition_correction_cosigns s where s.request_id = p_request_id;
  if found then
    if v_prev.cause_id = p_cause_id and v_prev.cosigned_by = v_uid then
      return jsonb_build_object('replayed', true, 'cosign_id', v_prev.id, 'cause_id', v_prev.cause_id, 'role', v_prev.role);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_cause.cause <> 'judge_entry_error' then
    raise exception 'COMP_CORRECTION_COSIGN_NOT_REQUIRED: only a judge_entry_error correction takes a co-sign.' using errcode = 'P0001';
  end if;
  if not v_round.correction_open or v_cause.id is distinct from (public._cf1_a7_current_cause(v_cause.round_id)).id then
    raise exception 'COMP_CORRECTION_NOT_OPEN: this correction is not the round''s open correction.' using errcode = 'P0001';
  end if;
  if v_cause.opened_by = v_uid then
    raise exception 'COMP_CORRECTION_COSIGN_SAME_PERSON: the co-signer must be a different person from the opener.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.event_competition_correction_cosigns s where s.cause_id = p_cause_id) then
    raise exception 'COMP_CORRECTION_ALREADY_COSIGNED: this correction has already been co-signed.' using errcode = 'P0001';
  end if;
  -- Not anyone who has filed a replacement ballot under this correction (later filers are refused at the ballot insert).
  if exists (
    select 1 from public.event_competition_ballots b
    left join public.event_competition_officials o on o.id = b.official_id and o.event_id = b.event_id
    left join public.event_competition_officials s on s.id = b.entered_by_official_id and s.event_id = b.event_id
    where b.round_id = v_cause.round_id and b.supersedes_id is not null and b.submitted_at >= v_cause.at
      and (b.submitted_by = v_uid or o.user_id = v_uid or s.user_id = v_uid)) then
    raise exception 'COMP_CORRECTION_COSIGNER_FILED_BALLOT: a person who filed a replacement ballot under this correction cannot co-sign it.' using errcode = 'P0001';
  end if;

  begin
    insert into public.event_competition_correction_cosigns (event_id, cause_id, cosigned_by, role, request_id)
    values (v_cause.event_id, p_cause_id, v_uid, v_role, p_request_id)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end;
  return jsonb_build_object('replayed', false, 'cosign_id', v_row.id, 'cause_id', v_row.cause_id, 'role', v_row.role);
end;
$$;

-- Read side for the correction screens (the tables have no grants): cause, co-sign, the live restricted set and the correction ballots.
create function public.competition_round_correction(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_round public.event_competition_rounds;
  v_cause public.event_competition_correction_causes;
  v_cos public.event_competition_correction_cosigns;
  v_x uuid[];
begin
  if v_uid is null or coalesce(public._compe2_round_role(p_round_id), '') not in ('manager', 'chair')
     or public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  v_cause := public._cf1_a7_current_cause(p_round_id);
  if v_cause.id is null then
    return jsonb_build_object('round_id', p_round_id, 'correction_open', coalesce(v_round.correction_open, false), 'cause', null);
  end if;
  select * into v_cos from public.event_competition_correction_cosigns s where s.cause_id = v_cause.id;
  v_x := case when v_round.correction_open then public._cf1_a7_new_exclusions(p_round_id, v_cause.baseline_version_id) else '{}'::uuid[] end;
  return jsonb_build_object(
    'round_id', p_round_id, 'correction_open', v_round.correction_open,
    'cause', jsonb_build_object('id', v_cause.id, 'cause', v_cause.cause, 'excluded_entry_ids', to_jsonb(v_cause.excluded_entry_ids),
                                'baseline_version_id', v_cause.baseline_version_id, 'opened_by', v_cause.opened_by, 'reason', v_cause.reason, 'at', v_cause.at),
    'restricted', v_cause.cause = 'entry_exclusion' or cardinality(v_x) > 0,
    'restricted_entry_ids', to_jsonb(v_x),
    'cosign', case when v_cos.id is null then null
                   else jsonb_build_object('id', v_cos.id, 'cosigned_by', v_cos.cosigned_by, 'role', v_cos.role, 'at', v_cos.at) end,
    'ballots', coalesce((select jsonb_agg(jsonb_build_object('ballot_id', c.ballot_id, 'supersedes_id', c.supersedes_id, 'official_id', c.official_id,
                                                            'actor', c.actor, 'at', c.at, 'reason', c.reason, 'diff', c.diff) order by c.at, c.id)
                         from public.event_competition_ballot_corrections c where c.cause_id = v_cause.id), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4b. A7-1 (owner decision, design 4.1 strict rule): no exclusion decision of any kind is recorded while a ballot correction is open for the
-- round. The round row is locked first, so the check serialises with F2's open (round FOR UPDATE) and with A5 (which already holds it).
-- The live excluded-set lookup in _cf1_a7_rule stays as defence in depth only.
-- ---------------------------------------------------------------------------
create function public.cf1_a7_guard_exclusion_during_correction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_open boolean;
begin
  select r.correction_open into v_open from public.event_competition_rounds r
  where r.id = new.round_id and r.event_id = new.event_id for update;
  if coalesce(v_open, false) then
    raise exception 'COMP_CORRECTION_EXCLUSION_DURING_CORRECTION: a ballot correction is open for this round; complete it (recalculate) before recording an exclusion decision.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_a7_guard_exclusion_during_correction() from public, anon, authenticated, service_role;
create trigger cf1_a7_guard_exclusion_during_correction before insert on public.event_competition_round_exclusions
  for each row execute function public.cf1_a7_guard_exclusion_during_correction();
alter table public.event_competition_round_exclusions enable always trigger cf1_a7_guard_exclusion_during_correction;

-- ---------------------------------------------------------------------------
-- 5. Commit-time backstops (deferred constraint triggers): the same rule for any writer
-- ---------------------------------------------------------------------------
create function public._cf1_a7_backstop(p_ballot_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_b public.event_competition_ballots;
  v_round public.event_competition_rounds;
  v_cause public.event_competition_correction_causes;
  v_c public.event_competition_ballot_corrections;
  v_old uuid[];
  v_new uuid[];
begin
  select * into v_b from public.event_competition_ballots b where b.id = p_ballot_id;
  if not found or v_b.ballot_format <> 'callback_yes' then
    return;
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = v_b.round_id;
  if not found or not v_round.correction_open then
    return;
  end if;
  v_cause := public._cf1_a7_current_cause(v_b.round_id);
  if v_cause.id is null then
    raise exception 'COMP_CORRECTION_CAUSE_REQUIRED: this correction has no recorded cause.' using errcode = 'P0001';
  end if;
  if v_b.supersedes_id is null then
    raise exception 'COMP_CORRECTION_BALLOT_NOT_PERMITTED: a first ballot cannot be filed during a correction.' using errcode = 'P0001';
  end if;
  select * into v_c from public.event_competition_ballot_corrections c where c.ballot_id = v_b.id;
  if not found then
    raise exception 'COMP_CORRECTION_BALLOT_UNRECORDED: a correction ballot needs its correction record.' using errcode = 'P0001';
  end if;
  v_old := public._cf1_a7_picks(v_b.supersedes_id);
  v_new := public._cf1_a7_picks(v_b.id);
  if v_c.supersedes_id <> v_b.supersedes_id or v_c.cause_id <> v_cause.id or v_c.original_picks <> v_old or v_c.replacement_picks <> v_new
     or v_c.diff -> 'removed' is distinct from to_jsonb(array(select x from unnest(v_old) x where x <> all (v_new)))
     or v_c.diff -> 'added' is distinct from to_jsonb(array(select x from unnest(v_new) x where x <> all (v_old))) then
    raise exception 'COMP_CORRECTION_BALLOT_UNRECORDED: the correction record does not match the ballot.' using errcode = 'P0001';
  end if;
  perform public._cf1_a7_rule(v_b.round_id, v_cause, v_old, v_new,
    public._cf1_a7_filers(v_b.submitted_by, v_b.official_id, v_b.entered_by_official_id));
end;
$$;
revoke all on function public._cf1_a7_backstop(uuid) from public, anon, authenticated, service_role;

create function public.cf1_a7_backstop_ballot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._cf1_a7_backstop(new.id);
  return null;
end;
$$;
create function public.cf1_a7_backstop_correction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._cf1_a7_backstop(new.ballot_id);
  return null;
end;
$$;
revoke all on function public.cf1_a7_backstop_ballot() from public, anon, authenticated, service_role;
revoke all on function public.cf1_a7_backstop_correction() from public, anon, authenticated, service_role;

create constraint trigger cf1_a7_backstop_ballot after insert on public.event_competition_ballots
  deferrable initially deferred for each row execute function public.cf1_a7_backstop_ballot();
create constraint trigger cf1_a7_backstop_correction after insert on public.event_competition_ballot_corrections
  deferrable initially deferred for each row execute function public.cf1_a7_backstop_correction();
alter table public.event_competition_ballots enable always trigger cf1_a7_backstop_ballot;
alter table public.event_competition_ballot_corrections enable always trigger cf1_a7_backstop_correction;

-- ---------------------------------------------------------------------------
-- 6. _compe2_insert_ballot: three single-line anchors (pinned)
-- ---------------------------------------------------------------------------
select pg_temp.cf1a7_pin_replace(
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

-- 6b. The pinned function keeps its original owner, which can differ from the role applying this migration (e.g. postgres vs
-- supabase_admin). It calls the two _cf1_ helpers defined above, which are revoked from everyone: grant its owner explicitly (same as A0 9b).
do $own$
declare
  v_owner name;
begin
  for v_owner in
    select distinct pg_get_userbyid(p.proowner) from pg_proc p
    where p.oid = 'public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)'::regprocedure
  loop
    if v_owner::text <> current_user then
      execute format('grant execute on function public._cf1_check_correction_ballot(uuid, uuid, uuid, jsonb, uuid, uuid), public._cf1_record_ballot_correction(uuid, uuid, uuid, text, uuid) to %I', v_owner);
    end if;
  end loop;
end $own$;

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.cosign_competition_correction(uuid, uuid) from public, anon, service_role;
revoke all on function public.competition_round_correction(uuid) from public, anon, service_role;
grant execute on function public.cosign_competition_correction(uuid, uuid) to authenticated;
grant execute on function public.competition_round_correction(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Postflight
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  where (p.proname like '\_cf1\_a7\_%' or p.proname in ('_cf1_check_correction_ballot', '_cf1_record_ballot_correction',
         'cf1_a7_record_correction_cause', 'cf1_a7_guard_cosign_insert', 'cf1_a7_backstop_ballot', 'cf1_a7_backstop_correction', 'cf1_a7_guard_exclusion_during_correction'))
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
         or has_function_privilege('service_role', p.oid, 'execute'));
  if v_bad is not null then
    raise exception 'CF1-A7 postflight: internal functions are executable by an API role: %', v_bad;
  end if;
  if has_function_privilege('anon', 'public.cosign_competition_correction(uuid,uuid)', 'execute')
     or has_function_privilege('service_role', 'public.cosign_competition_correction(uuid,uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.cosign_competition_correction(uuid,uuid)', 'execute') then
    raise exception 'CF1-A7 postflight: cosign_competition_correction grants are wrong.';
  end if;
  if exists (select 1 from information_schema.role_table_grants g
             where g.table_schema = 'public' and g.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
               and g.table_name in ('event_competition_correction_causes', 'event_competition_correction_cosigns', 'event_competition_ballot_corrections')) then
    raise exception 'CF1-A7 postflight: a new table carries a grant.';
  end if;
  if (select count(*) from pg_trigger t where not t.tgisinternal and t.tgenabled = 'A'
        and t.tgname in ('cf1_a7_record_correction_cause', 'cf1_a7_guard_cosign_insert', 'cf1_a7_backstop_ballot', 'cf1_a7_backstop_correction', 'cf1_a7_guard_exclusion_during_correction')) <> 5 then
    raise exception 'CF1-A7 postflight: an A7 trigger is not ENABLE ALWAYS.';
  end if;
  -- The A7 definer helpers (owned by the applying role) call these; an owner mismatch would fail every correction open (reviewer finding).
  if exists (select 1 from unnest(array['public._compf2_evidence(uuid,text,text)', 'public._compe2_round_role(uuid)',
                                        'public._compe2_format_for_scoring(text)', 'public.verified_email_for_user(uuid)',
                                        'public._compo1_lock_event(uuid)']) f
             where not has_function_privilege(current_user, f, 'execute')) then
    raise exception 'CF1-A7 postflight: the applying role cannot execute a function the A7 helpers call (owner mismatch); grant it first.';
  end if;
end $$;

commit;

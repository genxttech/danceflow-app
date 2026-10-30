-- Competition CF1 package A5: the audited "Excluded, with reason" action (OD-20).
--
-- Design: docs/competition/callback-to-final-advancement-design.md (4.7, 4.6 predicate P, A.2 / A.3 lock order, A.9.2 package A5).
-- Contract: docs/competition/cf1-a5-contract.md. Stacks on A1 (20270120085000: the table and the helpers). A5 redefines NO existing function.
--
--   request_round_exclusion(round, entry, reason_kind, reason, request_id)       manager        -> exclude_requested
--   cosign_round_exclusion(decision_id, request_id)                              chair/manager  -> exclude_cosigned   (takes effect)
--   request_round_exclusion_reversal(round, entry, reason, request_id)           manager        -> reverse_requested
--   cosign_round_exclusion_reversal(decision_id, request_id)                     chair/manager  -> reverse_cosigned   (takes effect)
--   competition_round_exclusions(round)                                          chair/manager  read (A5 extra, see contract)
--
-- Every public function is SECURITY DEFINER, search_path = public, pg_temp, revoke all from public/anon, grant execute to authenticated ONLY.
-- The table written here (A1) has no grants of any kind: these functions are its only writers.
-- Internal helpers (_cf1_a5_*) carry no grants at all.
--
-- Lock order (A.3): event advisory lock (_compo1_lock_event) -> round FOR UPDATE (assigns seq) -> entry FOR SHARE -> the couple's heat
-- entries FOR SHARE in id order (the order of change_competition_entry_lifecycle). Authorization reads happen before any lock.
-- The action writes only the exclusion table: no heat entry, ballot, round or result row is touched, and no round transition exists.
--
-- Lifecycle: round in (active, ballots_locked); refused in every other state and for ANY round with a publication row (fail closed
-- until F3 provides the withdraw / supersede exit, release blocker RB2).
--
-- Also added: BEFORE INSERT trigger on event_competition_ballots refusing a REPLACEMENT ballot (supersedes_id not null) filed by a person
-- who co-signed an exclusion decision in that round (design 4.1 / OD-19 D: the co-signer is never anyone who files a replacement ballot).
--
-- Rollback: rollback/20270120094000_competition_cf1_a5_exclusion_action_rollback.sql; position 2 (A6 first, then this one); ROLL-FORWARD
-- ONLY once an exclusion row exists.

begin;

do $$
begin
  if to_regclass('public.event_competition_round_exclusions') is null
     or to_regprocedure('public._cf1_entry_unavailable(uuid)') is null
     or to_regprocedure('public._cf1_heat_entry_is_excluded(uuid)') is null then
    raise exception 'CF1-A5 preflight: A1 (20270120085000) is missing.';
  end if;
  if to_regprocedure('public._compe2_round_role(uuid)') is null
     or to_regprocedure('public._compo1_lock_event(uuid)') is null
     or to_regprocedure('public._hl1_heat_is_danced(uuid,text)') is null
     or to_regprocedure('public.competition_heat_entry_is_no_show(uuid)') is null
     or to_regprocedure('public.verified_email_for_user(uuid)') is null then
    raise exception 'CF1-A5 preflight: E2 / O1 / HL1 / NS1 / LAUNCH-SEC-1C objects are missing.';
  end if;
  if to_regprocedure('public.request_round_exclusion(uuid,uuid,text,text,uuid)') is not null
     or to_regprocedure('public.cosign_round_exclusion(uuid,uuid)') is not null
     or to_regprocedure('public.request_round_exclusion_reversal(uuid,uuid,text,uuid)') is not null
     or to_regprocedure('public.cosign_round_exclusion_reversal(uuid,uuid)') is not null then
    raise exception 'CF1-A5 preflight: an A5 function already exists.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Internal helpers (no grants)
-- ---------------------------------------------------------------------------

-- The round must have NO publication row, even a withdrawn one (fail closed). Absent F3 table: no row can exist.
create function public._cf1_a5_require_no_publication(p_round_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_exists boolean := false;
begin
  if to_regclass('public.event_competition_result_publications') is null then
    return;
  end if;
  begin
    execute 'select exists (select 1 from public.event_competition_result_publications p where p.round_id = $1)' into v_exists using p_round_id;
  exception
    when undefined_column or undefined_table then
      raise exception 'COMP_EXCLUSION_PUBLICATION_EXISTS: publication state could not be verified; the exclusion action is refused.' using errcode = 'P0001';
  end;
  if v_exists then
    raise exception 'COMP_EXCLUSION_PUBLICATION_EXISTS: this round has a publication row; the exclusion action is refused until the F3 withdraw/supersede exit exists.'
      using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public._cf1_a5_require_no_publication(uuid) from public, anon, authenticated, service_role;

-- The heat entries of an entry in the non-cancelled heats of a round, ids ascending (the snapshot; also the lock list).
create function public._cf1_a5_entry_heat_entries(p_round_id uuid, p_entry_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(he.id order by he.id), '{}'::uuid[])
  from public.event_competition_heat_entries he
  join public.event_competition_heats h on h.id = he.heat_id and h.event_id = he.event_id
  where h.round_id = p_round_id and h.status <> 'cancelled' and he.entry_id = p_entry_id;
$$;
revoke all on function public._cf1_a5_entry_heat_entries(uuid, uuid) from public, anon, authenticated, service_role;

-- "Danced" by the heat (4.7): a non-scratched, non-no-show heat entry of the entry in a heat that HL1 reads as danced.
-- The heat entry's own status is NOT required to read 'danced' (no function writes that value).
create function public._cf1_a5_entry_danced(p_round_id uuid, p_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.event_competition_heat_entries he
    join public.event_competition_heats h on h.id = he.heat_id and h.event_id = he.event_id
    where h.round_id = p_round_id and he.entry_id = p_entry_id
      and h.status <> 'cancelled'
      and he.status <> 'scratched'
      and not public.competition_heat_entry_is_no_show(he.id)
      and public._hl1_heat_is_danced(h.id, h.status));
$$;
revoke all on function public._cf1_a5_entry_danced(uuid, uuid) from public, anon, authenticated, service_role;

-- The effective row of (round, entry): the highest-seq CO-SIGNED row (null columns when there is none).
create function public._cf1_a5_effective(p_round_id uuid, p_entry_id uuid)
returns public.event_competition_round_exclusions
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select x.* from public.event_competition_round_exclusions x
  where x.round_id = p_round_id and x.entry_id = p_entry_id and x.kind in ('exclude_cosigned', 'reverse_cosigned')
  order by x.seq desc limit 1;
$$;
revoke all on function public._cf1_a5_effective(uuid, uuid) from public, anon, authenticated, service_role;

-- A person who filed a REPLACEMENT ballot (supersedes_id not null) in the round, as submitter, as the judge, or as the entering scorer.
create function public._cf1_a5_filed_replacement_ballot(p_round_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.event_competition_ballots b
    left join public.event_competition_officials o on o.id = b.official_id and o.event_id = b.event_id
    left join public.event_competition_officials s on s.id = b.entered_by_official_id and s.event_id = b.event_id
    where b.round_id = p_round_id and b.supersedes_id is not null
      and (b.submitted_by = p_user_id or o.user_id = p_user_id or s.user_id = p_user_id));
$$;
revoke all on function public._cf1_a5_filed_replacement_ballot(uuid, uuid) from public, anon, authenticated, service_role;

-- The JSON every write returns (and replays).
create function public._cf1_a5_result(p_row public.event_competition_round_exclusions, p_replayed boolean)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'replayed', p_replayed, 'exclusion_id', p_row.id, 'kind', p_row.kind, 'decision_id', p_row.decision_id, 'reverses_id', p_row.reverses_id,
    'round_id', p_row.round_id, 'entry_id', p_row.entry_id, 'seq', p_row.seq, 'reason_kind', p_row.reason_kind,
    'in_effect', p_row.kind in ('exclude_cosigned', 'reverse_cosigned'));
$$;
revoke all on function public._cf1_a5_result(public.event_competition_round_exclusions, boolean) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. request_round_exclusion
-- ---------------------------------------------------------------------------
create function public.request_round_exclusion(
  p_round_id uuid, p_entry_id uuid, p_reason_kind text, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_round public.event_competition_rounds;
  v_entry public.event_competition_entries;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_prev public.event_competition_round_exclusions;
  v_eff public.event_competition_round_exclusions;
  v_row public.event_competition_round_exclusions;
  v_snapshot uuid[];
begin
  if v_uid is null or p_round_id is null or p_entry_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  if not found or public._compe2_round_role(p_round_id) is distinct from 'manager' then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required to request an exclusion.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if p_reason_kind is null or p_reason_kind not in ('ineligible', 'refunded', 'other') then
    raise exception 'COMP_EXCLUSION_REASON_KIND: the reason kind must be ineligible, refunded or other.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'COMP_EXCLUSION_REASON_REQUIRED: an exclusion needs a reason (3-500 characters).' using errcode = 'P0001';
  end if;

  perform public._compo1_lock_event(v_round.event_id);
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;

  select * into v_prev from public.event_competition_round_exclusions x where x.request_id = p_request_id;
  if found then
    if v_prev.kind = 'exclude_requested' and v_prev.actor = v_uid and v_prev.round_id = p_round_id and v_prev.entry_id = p_entry_id
       and v_prev.reason_kind = p_reason_kind and v_prev.reason = v_reason then
      return public._cf1_a5_result(v_prev, true);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status not in ('active', 'ballots_locked') then
    raise exception 'COMP_EXCLUSION_WINDOW: an exclusion can be requested only while the round is active or its ballots are locked (round is %); from calculated/approved use the F2 correction first.', v_round.status
      using errcode = 'P0001';
  end if;
  perform public._cf1_a5_require_no_publication(p_round_id);

  select * into v_entry from public.event_competition_entries e where e.id = p_entry_id and e.event_id = v_round.event_id for share;
  if not found then
    raise exception 'COMP_EXCLUSION_ENTRY_NOT_IN_ROUND: the entry does not belong to this round.' using errcode = 'P0001';
  end if;
  perform 1 from public.event_competition_heat_entries he
   where he.id = any (public._cf1_a5_entry_heat_entries(p_round_id, p_entry_id)) order by he.id for share;
  v_snapshot := public._cf1_a5_entry_heat_entries(p_round_id, p_entry_id);
  if coalesce(array_length(v_snapshot, 1), 0) = 0 then
    raise exception 'COMP_EXCLUSION_ENTRY_NOT_IN_ROUND: the entry has no heat entry in this round.' using errcode = 'P0001';
  end if;
  if not public._cf1_a5_entry_danced(p_round_id, p_entry_id) then
    raise exception 'COMP_EXCLUSION_NOT_DANCED: this couple has not danced in this round; use a scratch, a withdrawal or an NS1 no-show.' using errcode = 'P0001';
  end if;

  v_eff := public._cf1_a5_effective(p_round_id, p_entry_id);
  if v_eff.kind = 'exclude_cosigned' then
    raise exception 'COMP_EXCLUSION_ALREADY: this couple is already excluded from the round.' using errcode = 'P0001';
  end if;
  if not public._cf1_entry_unavailable(p_entry_id) then
    raise exception 'COMP_EXCLUSION_NOT_UNAVAILABLE: the couple is currently eligible and not refunded; an exclusion needs a currently true ineligible/refund predicate.' using errcode = 'P0001';
  end if;

  begin
    insert into public.event_competition_round_exclusions
      (event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq)
    values (v_round.event_id, p_round_id, p_entry_id, v_snapshot, 'exclude_requested', p_reason_kind, v_reason, v_uid, 'manager', p_request_id,
            (select coalesce(max(x.seq), 0) + 1 from public.event_competition_round_exclusions x where x.round_id = p_round_id))
    returning * into v_row;
  exception when unique_violation then
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end;
  return public._cf1_a5_result(v_row, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. cosign_round_exclusion
-- ---------------------------------------------------------------------------
create function public.cosign_round_exclusion(p_decision_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_dec public.event_competition_round_exclusions;
  v_round public.event_competition_rounds;
  v_role text;
  v_prev public.event_competition_round_exclusions;
  v_eff public.event_competition_round_exclusions;
  v_row public.event_competition_round_exclusions;
  v_snapshot uuid[];
begin
  if v_uid is null or p_decision_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_dec from public.event_competition_round_exclusions x where x.id = p_decision_id;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  v_role := public._compe2_round_role(v_dec.round_id);
  if coalesce(v_role, '') not in ('manager', 'chair') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required to co-sign an exclusion.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if v_dec.kind <> 'exclude_requested' then
    raise exception 'COMP_EXCLUSION_DECISION_KIND: this is not an exclusion request.' using errcode = 'P0001';
  end if;

  perform public._compo1_lock_event(v_dec.event_id);
  select * into v_round from public.event_competition_rounds r where r.id = v_dec.round_id for update;

  select * into v_prev from public.event_competition_round_exclusions x where x.request_id = p_request_id;
  if found then
    if v_prev.kind = 'exclude_cosigned' and v_prev.decision_id = p_decision_id and v_prev.actor = v_uid then
      return public._cf1_a5_result(v_prev, true);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status not in ('active', 'ballots_locked') then
    raise exception 'COMP_EXCLUSION_WINDOW: an exclusion can be co-signed only while the round is active or its ballots are locked (round is %).', v_round.status
      using errcode = 'P0001';
  end if;
  perform public._cf1_a5_require_no_publication(v_dec.round_id);

  if v_dec.actor = v_uid then
    raise exception 'COMP_EXCLUSION_COSIGN_SAME_PERSON: the co-signer must be a different person from the requester.' using errcode = 'P0001';
  end if;
  if public._cf1_a5_filed_replacement_ballot(v_dec.round_id, v_uid) then
    raise exception 'COMP_EXCLUSION_COSIGNER_FILED_BALLOT: a person who filed a replacement ballot in this round cannot co-sign an exclusion.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.event_competition_round_exclusions x where x.decision_id = p_decision_id) then
    raise exception 'COMP_EXCLUSION_DECISION_COMPLETED: this request has already been co-signed.' using errcode = 'P0001';
  end if;

  perform 1 from public.event_competition_entries e where e.id = v_dec.entry_id and e.event_id = v_dec.event_id for share;
  perform 1 from public.event_competition_heat_entries he
   where he.id = any (public._cf1_a5_entry_heat_entries(v_dec.round_id, v_dec.entry_id)) order by he.id for share;

  v_eff := public._cf1_a5_effective(v_dec.round_id, v_dec.entry_id);
  if v_eff.id is not null and v_eff.seq > v_dec.seq then
    raise exception 'COMP_EXCLUSION_REQUEST_STALE: a later decision exists for this couple; request again.' using errcode = 'P0001';
  end if;
  if v_eff.kind = 'exclude_cosigned' then
    raise exception 'COMP_EXCLUSION_ALREADY: this couple is already excluded from the round.' using errcode = 'P0001';
  end if;
  v_snapshot := public._cf1_a5_entry_heat_entries(v_dec.round_id, v_dec.entry_id);
  if not public._cf1_a5_entry_danced(v_dec.round_id, v_dec.entry_id) then
    raise exception 'COMP_EXCLUSION_NOT_DANCED: this couple has not danced in this round; use a scratch, a withdrawal or an NS1 no-show.' using errcode = 'P0001';
  end if;
  if not public._cf1_entry_unavailable(v_dec.entry_id) then
    raise exception 'COMP_EXCLUSION_NOT_UNAVAILABLE: the couple is currently eligible and not refunded; an exclusion needs a currently true ineligible/refund predicate.' using errcode = 'P0001';
  end if;

  begin
    insert into public.event_competition_round_exclusions
      (event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id)
    values (v_dec.event_id, v_dec.round_id, v_dec.entry_id, v_snapshot, 'exclude_cosigned', v_dec.reason_kind, v_dec.reason, v_uid, v_role, p_request_id,
            (select coalesce(max(x.seq), 0) + 1 from public.event_competition_round_exclusions x where x.round_id = v_dec.round_id), v_dec.id)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end;
  return public._cf1_a5_result(v_row, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. request_round_exclusion_reversal
-- ---------------------------------------------------------------------------
create function public.request_round_exclusion_reversal(p_round_id uuid, p_entry_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_round public.event_competition_rounds;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_prev public.event_competition_round_exclusions;
  v_eff public.event_competition_round_exclusions;
  v_row public.event_competition_round_exclusions;
  v_snapshot uuid[];
begin
  if v_uid is null or p_round_id is null or p_entry_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  if not found or public._compe2_round_role(p_round_id) is distinct from 'manager' then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required to request an exclusion reversal.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'COMP_EXCLUSION_REASON_REQUIRED: a reversal needs a reason (3-500 characters).' using errcode = 'P0001';
  end if;

  perform public._compo1_lock_event(v_round.event_id);
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;

  select * into v_prev from public.event_competition_round_exclusions x where x.request_id = p_request_id;
  if found then
    if v_prev.kind = 'reverse_requested' and v_prev.actor = v_uid and v_prev.round_id = p_round_id and v_prev.entry_id = p_entry_id
       and v_prev.reason = v_reason then
      return public._cf1_a5_result(v_prev, true);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status not in ('active', 'ballots_locked') then
    raise exception 'COMP_EXCLUSION_WINDOW: an exclusion reversal can be requested only while the round is active or its ballots are locked (round is %).', v_round.status
      using errcode = 'P0001';
  end if;
  perform public._cf1_a5_require_no_publication(p_round_id);

  perform 1 from public.event_competition_entries e where e.id = p_entry_id and e.event_id = v_round.event_id for share;
  perform 1 from public.event_competition_heat_entries he
   where he.id = any (public._cf1_a5_entry_heat_entries(p_round_id, p_entry_id)) order by he.id for share;
  v_snapshot := public._cf1_a5_entry_heat_entries(p_round_id, p_entry_id);

  v_eff := public._cf1_a5_effective(p_round_id, p_entry_id);
  if v_eff.id is null or v_eff.kind <> 'exclude_cosigned' then
    raise exception 'COMP_EXCLUSION_NOT_ACTIVE: this couple is not currently excluded from the round.' using errcode = 'P0001';
  end if;
  if public._cf1_entry_unavailable(p_entry_id) then
    raise exception 'COMP_EXCLUSION_STILL_UNAVAILABLE: the couple is still ineligible or refunded; correct the cause first (a still-unavailable couple cannot be reinstated).' using errcode = 'P0001';
  end if;

  begin
    insert into public.event_competition_round_exclusions
      (event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, reverses_id)
    values (v_round.event_id, p_round_id, p_entry_id, v_snapshot, 'reverse_requested', v_eff.reason_kind, v_reason, v_uid, 'manager', p_request_id,
            (select coalesce(max(x.seq), 0) + 1 from public.event_competition_round_exclusions x where x.round_id = p_round_id), v_eff.id)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end;
  return public._cf1_a5_result(v_row, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. cosign_round_exclusion_reversal
-- ---------------------------------------------------------------------------
create function public.cosign_round_exclusion_reversal(p_decision_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_dec public.event_competition_round_exclusions;
  v_round public.event_competition_rounds;
  v_role text;
  v_prev public.event_competition_round_exclusions;
  v_eff public.event_competition_round_exclusions;
  v_row public.event_competition_round_exclusions;
  v_snapshot uuid[];
begin
  if v_uid is null or p_decision_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_dec from public.event_competition_round_exclusions x where x.id = p_decision_id;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  v_role := public._compe2_round_role(v_dec.round_id);
  if coalesce(v_role, '') not in ('manager', 'chair') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required to co-sign an exclusion reversal.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if v_dec.kind <> 'reverse_requested' then
    raise exception 'COMP_EXCLUSION_DECISION_KIND: this is not an exclusion reversal request.' using errcode = 'P0001';
  end if;

  perform public._compo1_lock_event(v_dec.event_id);
  select * into v_round from public.event_competition_rounds r where r.id = v_dec.round_id for update;

  select * into v_prev from public.event_competition_round_exclusions x where x.request_id = p_request_id;
  if found then
    if v_prev.kind = 'reverse_cosigned' and v_prev.decision_id = p_decision_id and v_prev.actor = v_uid then
      return public._cf1_a5_result(v_prev, true);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  if v_round.status not in ('active', 'ballots_locked') then
    raise exception 'COMP_EXCLUSION_WINDOW: an exclusion reversal can be co-signed only while the round is active or its ballots are locked (round is %).', v_round.status
      using errcode = 'P0001';
  end if;
  perform public._cf1_a5_require_no_publication(v_dec.round_id);

  if v_dec.actor = v_uid then
    raise exception 'COMP_EXCLUSION_COSIGN_SAME_PERSON: the co-signer must be a different person from the requester.' using errcode = 'P0001';
  end if;
  if public._cf1_a5_filed_replacement_ballot(v_dec.round_id, v_uid) then
    raise exception 'COMP_EXCLUSION_COSIGNER_FILED_BALLOT: a person who filed a replacement ballot in this round cannot co-sign an exclusion reversal.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.event_competition_round_exclusions x where x.decision_id = p_decision_id) then
    raise exception 'COMP_EXCLUSION_DECISION_COMPLETED: this request has already been co-signed.' using errcode = 'P0001';
  end if;

  perform 1 from public.event_competition_entries e where e.id = v_dec.entry_id and e.event_id = v_dec.event_id for share;
  perform 1 from public.event_competition_heat_entries he
   where he.id = any (public._cf1_a5_entry_heat_entries(v_dec.round_id, v_dec.entry_id)) order by he.id for share;

  v_eff := public._cf1_a5_effective(v_dec.round_id, v_dec.entry_id);
  if v_eff.id is null or v_eff.kind <> 'exclude_cosigned' or v_eff.id is distinct from v_dec.reverses_id then
    raise exception 'COMP_EXCLUSION_REQUEST_STALE: the exclusion this reversal names is no longer the couple''s effective decision; request again.' using errcode = 'P0001';
  end if;
  if public._cf1_entry_unavailable(v_dec.entry_id) then
    raise exception 'COMP_EXCLUSION_STILL_UNAVAILABLE: the couple is still ineligible or refunded; correct the cause first (a still-unavailable couple cannot be reinstated).' using errcode = 'P0001';
  end if;
  v_snapshot := public._cf1_a5_entry_heat_entries(v_dec.round_id, v_dec.entry_id);

  begin
    insert into public.event_competition_round_exclusions
      (event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id, reverses_id)
    values (v_dec.event_id, v_dec.round_id, v_dec.entry_id, v_snapshot, 'reverse_cosigned', v_dec.reason_kind, v_dec.reason, v_uid, v_role, p_request_id,
            (select coalesce(max(x.seq), 0) + 1 from public.event_competition_round_exclusions x where x.round_id = v_dec.round_id), v_dec.id, v_dec.reverses_id)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end;
  return public._cf1_a5_result(v_row, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Read (A5 extra): the round's exclusion decisions with their state, for the co-signer's list and the audit view.
--    Managers and the round's chair only (the table has no grants; this is the only client read of PENDING requests).
-- ---------------------------------------------------------------------------
create function public.competition_round_exclusions(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_round_id is null or coalesce(public._compe2_round_role(p_round_id), '') not in ('manager', 'chair') then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required to read exclusions.' using errcode = '42501';
  end if;
  return jsonb_build_object('round_id', p_round_id, 'rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', x.id, 'seq', x.seq, 'kind', x.kind, 'entry_id', x.entry_id, 'reason_kind', x.reason_kind, 'reason', x.reason,
      'actor', x.actor, 'actor_role', x.actor_role, 'at', x.at, 'decision_id', x.decision_id, 'reverses_id', x.reverses_id,
      'evidence_heat_entry_ids', x.evidence_heat_entry_ids,
      'completed', exists (select 1 from public.event_competition_round_exclusions c where c.decision_id = x.id))
      order by x.seq)
    from public.event_competition_round_exclusions x where x.round_id = p_round_id), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Separation of duties on replacement ballots: a co-signer of an exclusion decision of the round cannot file a replacement ballot in it.
--    Serialized with the co-sign: ballot filing holds the round FOR SHARE, the co-sign holds it FOR UPDATE.
-- ---------------------------------------------------------------------------
create function public._cf1_a5_guard_replacement_ballot_filer()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if new.supersedes_id is not null and exists (
       select 1 from public.event_competition_round_exclusions x
       where x.round_id = new.round_id and x.kind in ('exclude_cosigned', 'reverse_cosigned')
         and (x.actor = new.submitted_by
              or x.actor in (select o.user_id from public.event_competition_officials o
                              where o.event_id = new.event_id and o.id in (new.official_id, new.entered_by_official_id)))) then
    raise exception 'COMP_EXCLUSION_COSIGNER_CONFLICT: a person who co-signed an exclusion decision in this round cannot file a replacement ballot in it.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public._cf1_a5_guard_replacement_ballot_filer() from public, anon, authenticated, service_role;
create trigger cf1_a5_guard_replacement_ballot_filer
  before insert on public.event_competition_ballots
  for each row execute function public._cf1_a5_guard_replacement_ballot_filer();

-- ---------------------------------------------------------------------------
-- 8. Privileges: authenticated only (no anon, no service_role, no PUBLIC)
-- ---------------------------------------------------------------------------
revoke all on function public.request_round_exclusion(uuid, uuid, text, text, uuid) from public, anon, service_role;
revoke all on function public.cosign_round_exclusion(uuid, uuid) from public, anon, service_role;
revoke all on function public.request_round_exclusion_reversal(uuid, uuid, text, uuid) from public, anon, service_role;
revoke all on function public.cosign_round_exclusion_reversal(uuid, uuid) from public, anon, service_role;
revoke all on function public.competition_round_exclusions(uuid) from public, anon, service_role;
grant execute on function public.request_round_exclusion(uuid, uuid, text, text, uuid) to authenticated;
grant execute on function public.cosign_round_exclusion(uuid, uuid) to authenticated;
grant execute on function public.request_round_exclusion_reversal(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.cosign_round_exclusion_reversal(uuid, uuid) to authenticated;
grant execute on function public.competition_round_exclusions(uuid) to authenticated;

comment on function public.request_round_exclusion(uuid, uuid, text, text, uuid) is
  'CF1 A5 (OD-20): a manager requests that a couple who danced and is now ineligible/refunded be excluded from the round''s ranking. Takes effect only when co-signed.';

commit;

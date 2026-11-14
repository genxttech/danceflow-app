-- Competition CF1 U66: narrow recovery path for the A7 exclusion-vs-open-correction deadlock.
--
-- Problem (A7, 20270120095500): cf1_a7_guard_exclusion_during_correction refuses EVERY exclusion decision while round.correction_open. A correction
-- ends only by replacement ballots and a recalculation, and a couple that became ineligible or refunded after the result was calculated blocks that
-- recalculation (COMP_ROSTER_ENTRY_UNAVAILABLE), while the exclusion that would unblock it is refused. A round can therefore deadlock.
--
-- Owner decision (CF1 integration-4): allow a NARROW recovery, only when ALL of these hold, every one checked INSIDE this transaction under the round lock:
--   * the round is in an open correction (ballots_locked + correction_open) with a recorded cause row that is the round's current cause
--   * there is no CURRENT publication of the round (a withdrawn or superseded one does not count; F3 absent = no publication)
--   * no replacement (correction) ballot was filed since the correction opened (a first ballot cannot be filed during a correction: A7)
--   * the correction has no co-sign
--   * the round holds no live (calculated / approved) result version, and its callback Final holds no active advancement
--   AND the exclusion request itself is valid (the couple is unavailable, danced, not already excluded: request_round_exclusion re-checks all of it).
-- Anything else keeps refusing with the existing code (COMP_CORRECTION_EXCLUSION_DURING_CORRECTION, or COMP_CORRECTION_NOT_OPEN when there is no
-- correction). There is NO general bypass: the A7 guard trigger is untouched, no function other than this RPC can clear correction_open, and the
-- exclusion is only ever a REQUEST here (co-sign by a second person stays the normal A5 route).
--
-- What it does, in ONE transaction (all or nothing: an invalid exclusion request rolls the cancellation back):
--   1. event advisory lock, round FOR UPDATE (the A5 / A7 order; publish, withdraw, ballot filers (round FOR SHARE) and the co-sign all serialise here)
--   2. re-checks the conditions above; refuses with the existing code and a detail listing the failed conditions
--   3. writes ONE audit row (round_state_changed ballots_locked -> ballots_locked, refs.u66_recovery = true, cause id, entry, reason) -- the cause row,
--      the baseline version, its invalidation rows and every earlier audit row stay exactly as they were (nothing is deleted or updated)
--   4. clears round.correction_open through the trigger below (it fires only with that audit row in the same transaction)
--   5. calls request_round_exclusion (same user, same request id): the exclusion decision is recorded as a normal 'exclude_requested' row
-- The round is then a plain ballots_locked round: the co-sign of the exclusion, the E2 reopen (to re-collect ballots) and the recalculation follow
-- the ordinary routes. A later correction opens a NEW cause row.
--
-- Objects
--   public.recover_correction_for_exclusion(round, entry, reason_kind, reason, request)   authenticated; manager with a verified email
--   public.competition_round_correction_recovery(round)                                  authenticated read (manager / chair): eligible + blockers
--   public._cf1_u66_blockers(round)                                                        helper (no grants), shared by both
--   public.cf1_u66_clear_correction_open() + trigger zz_cf1_u66_clear_correction_open     BEFORE UPDATE OF correction_open ON event_competition_rounds
--                                                                                          (named to fire after compf2_guard_round_status, which re-derives the flag)
--   public.cf1_u66_block_reopen() + trigger cf1_u66_block_reopen                           BEFORE UPDATE OF status ON event_competition_rounds (INT5-SECFIX P2-1, below)
-- Rollback: rollback/20270120103000_competition_cf1_u66_correction_recovery_rollback.sql (refused once a recovery audit row exists).
--
-- INT5-SECFIX P2-1 (independent review): U66 clears correction_open without a publication or co-sign, so a lone manager could open a correction, recover
-- it, then call E2 reopen_competition_round_ballots (it refuses only approved / published versions and publication rows) and have judges file superseding
-- ballots on the now-active round with NONE of the A7 correction restrictions (Option R, judge_entry_error co-sign, ballot-correction rows apply only
-- while correction_open); before U66 the F2 guard COMPF2_CORRECTION_REOPEN stopped this. Choice (smallest fix that keeps the approved purpose): a trigger
-- refuses the status edge ballots_locked -> active while a U66 recovery of the round is unresolved, i.e. a u66_recovery audit row has no LATER
-- result_calculated event of the round. The exclusion co-sign and the recalculation (ballots_locked -> calculated) stay open, which is what the deadlock
-- recovery needs; re-collecting ballots goes through a NEW correction (with the A7 rules) after the recalculation. Rejected alternative: a second-manager
-- co-sign of the cancellation (changes the approved U66 policy). E2 is pinned and untouched: the guard is a status trigger owned by U66 (ENABLE ALWAYS), so it
-- also covers any other writer of that edge. Error: COMP_REOPEN_RECOVERY_PENDING.

begin;

do $$
begin
  if to_regprocedure('public.request_round_exclusion(uuid,uuid,text,text,uuid)') is null
     or to_regprocedure('public._a5_cf1_reason_ok(text)') is null THEN
    raise exception 'CF1-U66 preflight: A5 (20270120094000) is missing.';
  end if;
  if to_regprocedure('public.cf1_a7_guard_exclusion_during_correction()') is null
     or to_regprocedure('public._cf1_a7_current_cause(uuid)') is null
     or to_regclass('public.event_competition_correction_causes') is null
     or to_regclass('public.event_competition_correction_cosigns') is null
     or to_regclass('public.event_competition_ballot_corrections') is null then
    raise exception 'CF1-U66 preflight: A7 (20270120095500) is missing.';
  end if;
  if to_regprocedure('public._cf1_callback_successor(uuid)') is null or to_regprocedure('public._cf1_active_advancement(uuid)') is null
     or to_regprocedure('public._compo1_lock_event(uuid)') is null or to_regprocedure('public._compe2_round_role(uuid)') is null
     or to_regprocedure('public.verified_email_for_user(uuid)') is null
     or to_regprocedure('public._compf2_event(uuid,uuid,uuid,text,uuid,text,text,uuid,text,jsonb)') is null THEN
    raise exception 'CF1-U66 preflight: A0 / O1 / E2 / F2 objects are missing.';
  end if;
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.event_competition_rounds'::regclass and t.tgname = 'compf2_guard_round_status') then
    raise exception 'CF1-U66 preflight: the F2 round status guard is missing.';
  end if;
  if to_regprocedure('public.recover_correction_for_exclusion(uuid,uuid,text,text,uuid)') is not null
     or to_regprocedure('public._cf1_u66_blockers(uuid)') is not null
     or to_regprocedure('public.cf1_u66_block_reopen()') is not null
     or exists (select 1 from pg_trigger t where t.tgrelid = 'public.event_competition_rounds'::regclass and t.tgname = 'cf1_u66_block_reopen')
     or exists (select 1 from pg_trigger t where t.tgrelid = 'public.event_competition_rounds'::regclass and t.tgname = 'zz_cf1_u66_clear_correction_open') then
    raise exception 'CF1-U66 preflight: U66 appears to be applied already (roll back or clean up a partial earlier run first).';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Blockers (helper, no grants). Returns the failed conditions; empty = recovery is allowed. The caller holds the round lock when it matters.
-- ---------------------------------------------------------------------------
create function public._cf1_u66_blockers(p_round_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_round public.event_competition_rounds;
  v_cause public.event_competition_correction_causes;
  v_out text[] := '{}';
  v_pub boolean := false;
  v_succ uuid;
begin
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  if not found then
    return array['round_missing'];
  end if;
  if not (v_round.status = 'ballots_locked' and v_round.correction_open) then
    return array['no_open_correction'];
  end if;
  v_cause := public._cf1_a7_current_cause(p_round_id);
  if v_cause.id is null or v_cause.event_id is distinct from v_round.event_id then
    return array['no_recorded_cause'];
  end if;

  -- Current publication (F3). Table absent = none. A wrong shape fails closed; a deadlock / lock timeout / cancel propagates (retry with the same request id).
  if to_regclass('public.event_competition_result_publications') is not null then
    begin
      execute 'select exists (select 1 from public.event_competition_result_publications p where p.round_id = $1 and p.withdrawn_at is null and p.superseded_by is null)'
        into v_pub using p_round_id;
    exception when undefined_table or undefined_column or datatype_mismatch or syntax_error or invalid_text_representation or wrong_object_type then
      v_pub := true;
    end;
    if coalesce(v_pub, true) then
      v_out := array_append(v_out, 'current_publication'::text);
    end if;
  end if;

  if exists (select 1 from public.event_competition_ballot_corrections c where c.cause_id = v_cause.id)
     or exists (select 1 from public.event_competition_ballots b where b.round_id = p_round_id and b.event_id = v_round.event_id and b.supersedes_id is not null and b.submitted_at >= v_cause.at) then
    v_out := array_append(v_out, 'replacement_ballot'::text);
  end if;
  if exists (select 1 from public.event_competition_correction_cosigns s where s.cause_id = v_cause.id) then
    v_out := array_append(v_out, 'cosign'::text);
  end if;
  if exists (select 1 from public.event_competition_result_versions v
             where v.round_id = p_round_id and v.event_id = v_round.event_id and v.status in ('calculated', 'approved')) then
    v_out := array_append(v_out, 'live_result_version'::text);
  end if;
  v_succ := public._cf1_callback_successor(p_round_id);
  if v_succ is not null and public._cf1_active_advancement(v_succ) is not null then
    v_out := array_append(v_out, 'active_advancement'::text);
  end if;
  return v_out;
end;
$$;
revoke all on function public._cf1_u66_blockers(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The only writer of correction_open = false: a BEFORE trigger that requires the U66 audit row of the same transaction.
-- ---------------------------------------------------------------------------
create function public.cf1_u66_clear_correction_open()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- F2's guard (an earlier trigger) has already re-derived the flag; only the narrow U66 transition may override it.
  if old.correction_open and new.correction_open and new.status = 'ballots_locked' and old.status = 'ballots_locked'
     and exists (select 1 from public.event_competition_result_events e
                 where e.round_id = old.id and e.event_id = old.event_id and e.kind = 'round_state_changed'
                   and e.from_state = 'ballots_locked' and e.to_state = 'ballots_locked'
                   and e.refs ->> 'u66_recovery' = 'true' and e.transaction_id = txid_current()) then
    new.correction_open := false;
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_u66_clear_correction_open() from public, anon, authenticated, service_role;
create trigger zz_cf1_u66_clear_correction_open before update of correction_open on public.event_competition_rounds
  for each row execute function public.cf1_u66_clear_correction_open();
alter table public.event_competition_rounds enable always trigger zz_cf1_u66_clear_correction_open;

-- ---------------------------------------------------------------------------
-- 2b. INT5-SECFIX P2-1: no E2 reopen (ballots_locked -> active) while a U66 recovery of the round is unresolved.
-- ---------------------------------------------------------------------------
create function public.cf1_u66_block_reopen()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = 'ballots_locked' and new.status = 'active'
     and exists (select 1 from public.event_competition_result_events u
                 where u.round_id = old.id and u.event_id = old.event_id and u.kind = 'round_state_changed' and u.refs ->> 'u66_recovery' = 'true'
                   and not exists (select 1 from public.event_competition_result_events c
                                   where c.round_id = u.round_id and c.event_id = u.event_id and c.kind = 'result_calculated' and c.occurred_at > u.occurred_at)) then
    raise exception 'COMP_REOPEN_RECOVERY_PENDING: a correction of this round was cancelled through the exclusion recovery and has not been recalculated yet; recalculate the result (after the exclusion is co-signed), then use a new correction for ballot changes.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_u66_block_reopen() from public, anon, authenticated, service_role;
create trigger cf1_u66_block_reopen before update of status on public.event_competition_rounds
  for each row execute function public.cf1_u66_block_reopen();
alter table public.event_competition_rounds enable always trigger cf1_u66_block_reopen;

-- ---------------------------------------------------------------------------
-- 3. recover_correction_for_exclusion
-- ---------------------------------------------------------------------------
create function public.recover_correction_for_exclusion(
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
  v_cause public.event_competition_correction_causes;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_prev public.event_competition_result_events;
  v_row public.event_competition_round_exclusions;
  v_block text[];
  v_excl jsonb;
begin
  if v_uid is null or p_round_id is null or p_entry_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  if not found or public._compe2_round_role(p_round_id) is distinct from 'manager' then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required to recover a correction.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if p_reason_kind is null or p_reason_kind not in ('ineligible', 'refunded', 'other') then
    raise exception 'COMP_EXCLUSION_REASON_KIND: the reason kind must be ineligible, refunded or other.' using errcode = 'P0001';
  end if;
  if not public._a5_cf1_reason_ok(v_reason) then
    raise exception 'COMP_EXCLUSION_REASON_REQUIRED: an exclusion needs a reason (3-500 characters).' using errcode = 'P0001';
  end if;

  -- Lock order of A5 / A7: event advisory lock, then the round row.
  perform public._compo1_lock_event(v_round.event_id);
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;

  select * into v_prev from public.event_competition_result_events e where e.request_id = p_request_id;
  if found then
    if v_prev.kind = 'round_state_changed' and v_prev.refs ->> 'u66_recovery' = 'true' and v_prev.actor_user_id = v_uid
       and v_prev.round_id = p_round_id and v_prev.refs ->> 'entry_id' = p_entry_id::text then
      select * into v_row from public.event_competition_round_exclusions x where x.request_id = p_request_id;
      return jsonb_build_object('replayed', true, 'round_id', p_round_id, 'correction_cancelled', true, 'cause_id', v_prev.refs ->> 'cause_id',
                                'exclusion', case when v_row.id is null then null else public._a5_cf1_result(v_row, true) end);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  v_block := public._cf1_u66_blockers(p_round_id);
  if v_block = array['no_open_correction'] then
    raise exception 'COMP_CORRECTION_NOT_OPEN: this round has no open correction; use the normal exclusion request.' using errcode = 'P0001';
  end if;
  if cardinality(v_block) > 0 then
    raise exception 'COMP_CORRECTION_EXCLUSION_DURING_CORRECTION: a ballot correction is open for this round and the recovery path does not apply (%); complete the correction (recalculate) before recording an exclusion decision.',
      array_to_string(v_block, ', ') using errcode = 'P0001', detail = jsonb_build_object('blockers', to_jsonb(v_block))::text;
  end if;

  v_cause := public._cf1_a7_current_cause(p_round_id);
  perform public._compf2_event(v_round.event_id, p_round_id, null, 'round_state_changed', v_uid, 'ballots_locked', 'ballots_locked', p_request_id, v_reason,
    jsonb_build_object('u66_recovery', true, 'correction_cancelled', true, 'cause_id', v_cause.id, 'cause', v_cause.cause, 'cause_seq', v_cause.seq,
                       'entry_id', p_entry_id, 'reason_kind', p_reason_kind, 'baseline_version_id', v_cause.baseline_version_id));
  update public.event_competition_rounds set correction_open = false, updated_at = now() where id = p_round_id;
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  if v_round.correction_open or v_round.status <> 'ballots_locked' then
    raise exception 'COMP_CORRECTION_EXCLUSION_DURING_CORRECTION: the correction could not be cancelled.' using errcode = 'P0001';
  end if;

  -- The exclusion itself is an ordinary A5 request (same user, same request id): any invalid request rolls the cancellation back with it.
  v_excl := public.request_round_exclusion(p_round_id, p_entry_id, p_reason_kind, v_reason, p_request_id);
  return jsonb_build_object('replayed', false, 'round_id', p_round_id, 'correction_cancelled', true, 'cause_id', v_cause.id, 'exclusion', v_excl);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Read: is the recovery path available (managers and the chair read it; the round lock is not taken)
-- ---------------------------------------------------------------------------
create function public.competition_round_correction_recovery(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_block text[];
begin
  if v_uid is null or p_round_id is null or coalesce(public._compe2_round_role(p_round_id), '') not in ('manager', 'chair')
     or public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  v_block := public._cf1_u66_blockers(p_round_id);
  return jsonb_build_object('round_id', p_round_id, 'correction_open', v_block is distinct from array['no_open_correction'],
                            'eligible', cardinality(v_block) = 0, 'blockers', to_jsonb(v_block));
end;
$$;

revoke all on function public.recover_correction_for_exclusion(uuid, uuid, text, text, uuid) from public, anon, service_role;
revoke all on function public.competition_round_correction_recovery(uuid) from public, anon, service_role;
grant execute on function public.recover_correction_for_exclusion(uuid, uuid, text, text, uuid) to authenticated;
grant execute on function public.competition_round_correction_recovery(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Postflight
-- ---------------------------------------------------------------------------
do $$
begin
  if (select count(*) from pg_trigger t where t.tgrelid = 'public.event_competition_rounds'::regclass and t.tgname = 'zz_cf1_u66_clear_correction_open' and t.tgenabled = 'A') <> 1 then
    raise exception 'CF1-U66 postflight: the clear trigger is missing or not ENABLE ALWAYS.';
  end if;
  if (select count(*) from pg_trigger t where t.tgrelid = 'public.event_competition_rounds'::regclass and t.tgname = 'cf1_u66_block_reopen' and t.tgenabled = 'A') <> 1
     or has_function_privilege('anon', 'public.cf1_u66_block_reopen()', 'execute') or has_function_privilege('authenticated', 'public.cf1_u66_block_reopen()', 'execute') then
    raise exception 'CF1-U66 postflight: the reopen guard is missing, not ENABLE ALWAYS, or granted.';
  end if;
  if has_function_privilege('anon', 'public.recover_correction_for_exclusion(uuid,uuid,text,text,uuid)', 'execute')
     or has_function_privilege('public', 'public.recover_correction_for_exclusion(uuid,uuid,text,text,uuid)', 'execute')
     or has_function_privilege('anon', 'public._cf1_u66_blockers(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._cf1_u66_blockers(uuid)', 'execute') then
    raise exception 'CF1-U66 postflight: a function grant is wrong.';
  end if;
end $$;

commit;

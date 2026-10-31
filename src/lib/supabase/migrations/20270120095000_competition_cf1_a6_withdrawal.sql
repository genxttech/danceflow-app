-- Competition CF1 package A6: withdrawal and reinstatement of an advanced couple (OD-10 part 2 B, OD-18 A, OD-19 D).
--
-- Design: docs/competition/callback-to-final-advancement-design.md (rev 21) 4.3-4.6, 5 (I7/I8), A.2, A.3, A.9; contract: docs/competition/cf1-a6-contract.md.
-- Slot 20270120095000, after A0 (20270120090000) and A1 (20270120085000). LOCAL ONLY until separately authorized; nothing here is applied to a hosted project.
--
-- Adds:  the pending-request table (a withdrawal needs a co-signer, and A0's table has cosigned_by NOT NULL, so the requester's half is stored here);
--        withdraw_advanced_entry_from_final / reinstate_withdrawn_entry_to_final (the requester's half), cosign_final_withdrawal_request (the
--        co-signer's half, the only writer of event_competition_final_withdrawals), competition_final_withdrawal_state (read);
--        cf1_guard_withdrawn_heat_entry (BEFORE INSERT / UPDATE OF status, entry_id, heat_id / DELETE on heat entries, ENABLE ALWAYS, VOLATILE).
-- Not here: the withdrawal table and apply's carried-withdrawal handling (A0), the exclusion action (A5), the app (B).
--
-- Apply order: SQL before app. Rollback: app first, then the rollback file (refused once any withdrawal / request row exists).

begin;

-- ---------------------------------------------------------------------------
-- 0. Preflight: A0 and A1 objects, the slot is free.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.event_competition_final_withdrawals') is null
     or to_regprocedure('public._cf1_withdrawn_entries(uuid)') is null
     or to_regprocedure('public._cf1_active_advancement(uuid)') is null
     or to_regprocedure('public._cf1_callback_source(uuid)') is null
     or to_regprocedure('public._cf1_reason_is_substantive(text)') is null
     or to_regprocedure('public._cf1_is_callback_final(uuid)') is null
     or to_regprocedure('public._cf1_entry_unavailable(uuid)') is null
     or to_regprocedure('public._cf1_entry_unavailable_reason(uuid)') is null
     or to_regprocedure('public._cf1_count_available_entries(uuid[])') is null then
    raise exception 'CF1-A6 preflight: A0 (20270120090000) and A1 (20270120085000) are missing.';
  end if;
  if to_regprocedure('public._compo1_lock_event(uuid)') is null
     or to_regprocedure('public._compe2_round_role(uuid)') is null
     or to_regprocedure('public.verified_email_for_user(uuid)') is null
     or to_regprocedure('public.protect_competition_history_evidence()') is null then
    raise exception 'CF1-A6 preflight: O1 / E2 / history-protection functions are missing.';
  end if;
  if to_regclass('public.event_competition_final_withdrawal_requests') is not null
     or to_regclass('public.event_competition_final_withdrawal_request_cancellations') is not null
     or to_regprocedure('public.cf1_guard_withdrawn_heat_entry()') is not null
     or to_regprocedure('public.withdraw_advanced_entry_from_final(uuid,uuid,text,uuid)') is not null then
    raise exception 'CF1-A6 preflight: A6 objects already exist.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The pending-request table. Insert-only evidence, RLS on, no policies, no grants. NO ACTION foreign keys; the event cascade removes it.
--    A request is completed by a co-sign: the withdrawals row then carries request_id = this row's request_id.
-- ---------------------------------------------------------------------------
create table public.event_competition_final_withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  target_round_id uuid not null,
  entry_id uuid not null,
  kind text not null check (kind in ('withdraw', 'reinstate')),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  requested_by uuid not null,
  -- the active advancement of the Final when the request was made (null: none); the co-sign refuses if it changed
  advancement_id uuid references public.event_competition_round_advancements(id),
  -- the highest advancement generation of the Final when the request was made (0: none ever); it closes the ABA hole of the null binding above (apply then revoke returns to "null" with a higher generation)
  advancement_generation integer not null default 0,
  -- the approved callback result version when the request was made (null: none); a request is stale once the Final is built from a different result (a correction and a re-approval with another roster)
  source_result_version_id uuid references public.event_competition_result_versions(id),
  request_id uuid not null unique,
  transaction_id bigint not null default txid_current(),
  at timestamptz not null default now(),
  constraint event_competition_final_withdrawal_requests_ref_uq unique (request_id, event_id, target_round_id, entry_id),
  constraint event_competition_final_withdrawal_requests_round_fk foreign key (target_round_id, event_id) references public.event_competition_rounds(id, event_id),
  constraint event_competition_final_withdrawal_requests_entry_fk foreign key (entry_id, event_id) references public.event_competition_entries(id, event_id)
);
create index event_competition_final_withdrawal_requests_round_idx on public.event_competition_final_withdrawal_requests (target_round_id, entry_id);

alter table public.event_competition_final_withdrawal_requests enable row level security;
revoke all on public.event_competition_final_withdrawal_requests from public, anon, authenticated, service_role;
create trigger protect_cf1_wdreq_history before update or delete on public.event_competition_final_withdrawal_requests
  for each row execute function public.protect_competition_history_evidence();
create trigger protect_cf1_wdreq_history_truncate before truncate on public.event_competition_final_withdrawal_requests
  for each statement execute function public.protect_competition_history_evidence();
alter table public.event_competition_final_withdrawal_requests enable always trigger protect_cf1_wdreq_history;
alter table public.event_competition_final_withdrawal_requests enable always trigger protect_cf1_wdreq_history_truncate;

-- The cancellation of a pending request (D-B): insert-only evidence, one row per request (unique request_id), RLS on, no policies, no grants.
create table public.event_competition_final_withdrawal_request_cancellations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  target_round_id uuid not null,
  entry_id uuid not null,
  request_id uuid not null unique,
  reason text not null check (length(btrim(reason)) between 20 and 500),
  cancelled_by uuid not null,
  cancelled_role text not null check (cancelled_role in ('manager', 'chair')),
  by_requester boolean not null,
  transaction_id bigint not null default txid_current(),
  at timestamptz not null default now(),
  constraint event_competition_final_withdrawal_cancellations_request_fk foreign key (request_id, event_id, target_round_id, entry_id) references public.event_competition_final_withdrawal_requests(request_id, event_id, target_round_id, entry_id),
  constraint event_competition_final_withdrawal_cancellations_round_fk foreign key (target_round_id, event_id) references public.event_competition_rounds(id, event_id)
);
create index event_competition_final_withdrawal_cancellations_round_idx on public.event_competition_final_withdrawal_request_cancellations (target_round_id);

alter table public.event_competition_final_withdrawal_request_cancellations enable row level security;
revoke all on public.event_competition_final_withdrawal_request_cancellations from public, anon, authenticated, service_role;
create trigger protect_cf1_wdcxl_history before update or delete on public.event_competition_final_withdrawal_request_cancellations
  for each row execute function public.protect_competition_history_evidence();
create trigger protect_cf1_wdcxl_history_truncate before truncate on public.event_competition_final_withdrawal_request_cancellations
  for each statement execute function public.protect_competition_history_evidence();
alter table public.event_competition_final_withdrawal_request_cancellations enable always trigger protect_cf1_wdcxl_history;
alter table public.event_competition_final_withdrawal_request_cancellations enable always trigger protect_cf1_wdcxl_history_truncate;

-- ---------------------------------------------------------------------------
-- 2. Readers (definer, no grants). Volatile on purpose: each statement takes a fresh snapshot (READ COMMITTED sees a concurrent commit).
-- ---------------------------------------------------------------------------
-- The effective state of a pair: 'withdraw' | 'reinstate' (the row with the highest seq) or null (no row).
create function public._cf1_a6_pair_state(p_round_id uuid, p_entry_id uuid)
returns text
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select w.kind
  from public.event_competition_final_withdrawals w
  where w.target_round_id = p_round_id and w.entry_id = p_entry_id
  order by w.seq desc
  limit 1;
$$;

-- The latest APPROVED callback result version of the Final's callback round (the one apply would use), or null.
create function public._cf1_a6_approved_version(p_round_id uuid)
returns uuid
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select rv.id from public.event_competition_result_versions rv
  where rv.round_id = public._cf1_callback_source(p_round_id) and rv.status = 'approved' and rv.engine_key like '%callback_tally%'
  order by rv.version desc limit 1;
$$;

-- D-A (owner): a NEW withdrawal / reinstatement is refused while the Final's callback round has an open correction, or while no approved callback result exists
-- and no advancement is active (a correction revoked the advancement and invalidated the result): the roster is unknown until a corrected result is approved.
create function public._cf1_a6_roster_blocked(p_round_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  -- Opening a correction revokes the active advancement and invalidates the approved result in the same transaction (F2 / A0), and only approving a corrected result
  -- ends it, so "no active advancement and no approved callback result" is exactly "the callback is under correction (or was never approved)".
  -- (A non-callback Final has no source and is reported blocked here; _cf1_a6_precheck refuses it earlier with COMP_WITHDRAWAL_NOT_CALLBACK_FINAL.)
  select public._cf1_active_advancement(p_round_id) is null and public._cf1_a6_approved_version(p_round_id) is null;
$$;

-- The couples of the Final's current roster: the active advancement's list, else the latest APPROVED callback result's advanced rows (between a revoke and the next apply), else none.
create function public._cf1_a6_current_roster(p_round_id uuid)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_adv uuid := public._cf1_active_advancement(p_round_id);
  v_src uuid;
  v_ver uuid;
  v_ids uuid[];
begin
  if v_adv is not null then
    select coalesce(array_agg(distinct ae.entry_id), '{}') into v_ids from public.event_competition_round_advancement_entries ae where ae.advancement_id = v_adv;
    return v_ids;
  end if;
  v_src := public._cf1_callback_source(p_round_id);
  -- the same version apply would use: the latest APPROVED callback version (a newer calculated / invalidated version never counts)
  v_ver := public._cf1_a6_approved_version(p_round_id);
  if v_ver is null then
    -- no approved version right now (a correction invalidated it): no roster. A new withdrawal is refused in that window (_cf1_a6_roster_blocked, owner D-A); never an outdated last-applied list.
    return '{}';
  end if;
  select coalesce(array_agg(distinct rr.entry_id), '{}') into v_ids from public.event_competition_result_rows rr where rr.result_version_id = v_ver and rr.advanced is true;
  return v_ids;
end;
$$;

-- Was the couple on the Final's roster at some point: in some advancement of the round (any generation) or in the latest callback result?
create function public._cf1_a6_on_roster(p_round_id uuid, p_entry_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select p_entry_id = any (public._cf1_a6_current_roster(p_round_id))
      or exists (select 1 from public.event_competition_round_advancement_entries ae
                 join public.event_competition_round_advancements a on a.id = ae.advancement_id
                 where a.target_round_id = p_round_id and ae.entry_id = p_entry_id);
$$;

-- The one non-cancelled heat of a Final while an advancement is active (null otherwise).
create function public._cf1_a6_active_heat(p_round_id uuid)
returns uuid
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select h.id
  from public.event_competition_heats h
  where h.round_id = p_round_id and h.status <> 'cancelled' and public._cf1_active_advancement(p_round_id) is not null
  order by h.created_at, h.id
  limit 1;
$$;

-- The shared precondition check of both halves (read-only; the caller holds the locks that make it reliable).
create function public._cf1_a6_precheck(p_kind text, p_round_id uuid, p_entry_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_round public.event_competition_rounds;
  v_entry public.event_competition_entries;
  v_state text;
  v_prior record;
  v_roster uuid[];
  v_heat uuid;
  v_he public.event_competition_heat_entries;
begin
  select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
  if not found or not public._cf1_is_callback_final(p_round_id) then
    raise exception 'COMP_WITHDRAWAL_NOT_CALLBACK_FINAL: only a Final built from a callback result has withdrawals.' using errcode = 'P0001';
  end if;
  select * into v_entry from public.event_competition_entries e where e.id = p_entry_id and e.event_id = v_round.event_id;
  if not found then
    raise exception 'COMP_WITHDRAWAL_NOT_ON_ROSTER: that couple is not an entry of this event.' using errcode = 'P0001';
  end if;
  if v_round.status not in ('draft', 'scheduled') or exists (select 1 from public.event_competition_heats h where h.round_id = p_round_id and h.status in ('staging', 'active', 'complete')) then
    raise exception 'COMP_ADVANCEMENT_FINAL_STARTED: the Final has started; its roster can no longer change (round is %).', v_round.status using errcode = 'P0001';
  end if;
  if exists (select 1 from public.event_competition_ballots b where b.round_id = p_round_id) then
    raise exception 'COMP_WITHDRAWAL_BALLOTS: the Final already has ballots.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.event_competition_heats h where h.round_id = p_round_id and h.status <> 'cancelled' and h.lock_state <> 'open') then
    raise exception 'COMP_ADVANCEMENT_FINAL_LOCKED: a Final heat is locked; reopen it first.' using errcode = 'P0001';
  end if;
  if public._cf1_a6_roster_blocked(p_round_id) then
    raise exception 'COMP_WITHDRAWAL_NO_APPROVED_RESULT: the callback result is being corrected; withdrawals and reinstatements wait until a corrected result is approved.' using errcode = 'P0001';
  end if;
  v_state := public._cf1_a6_pair_state(p_round_id, p_entry_id);
  v_heat := public._cf1_a6_active_heat(p_round_id);
  select * into v_he from public.event_competition_heat_entries he where he.heat_id = v_heat and he.entry_id = p_entry_id;

  if p_kind = 'withdraw' then
    if v_state = 'withdraw' then
      raise exception 'COMP_WITHDRAWAL_ALREADY: this couple is already withdrawn from the Final.' using errcode = 'P0001';
    end if;
    if not public._cf1_a6_on_roster(p_round_id, p_entry_id) then
      raise exception 'COMP_WITHDRAWAL_NOT_ON_ROSTER: this couple was not advanced to this Final.' using errcode = 'P0001';
    end if;
    if v_he.id is not null and v_he.status not in ('scheduled', 'checked_in', 'scratched') then
      raise exception 'COMP_WITHDRAWAL_PRIOR_STATUS: the couple''s Final heat entry is % and cannot be withdrawn.', v_he.status using errcode = 'P0001';
    end if;
    -- OD-15 A: a withdrawal may not leave a callback Final with fewer than two eligible couples.
    select coalesce(array_agg(x), '{}') into v_roster
    from unnest(public._cf1_a6_current_roster(p_round_id)) x
    where x <> p_entry_id and x not in (select w.entry_id from public._cf1_withdrawn_entries(p_round_id) w);
    if public._cf1_count_available_entries(v_roster) < 2 then
      raise exception 'COMP_ADVANCEMENT_BELOW_MINIMUM: a callback Final needs at least two eligible couples; this withdrawal would leave %.', public._cf1_count_available_entries(v_roster)
        using errcode = 'P0001';
    end if;
  else
    if v_state is distinct from 'withdraw' then
      raise exception 'COMP_WITHDRAWAL_NOT_ACTIVE: this couple is not withdrawn from the Final.' using errcode = 'P0001';
    end if;
    select w.* into v_prior from public.event_competition_final_withdrawals w
    where w.target_round_id = p_round_id and w.entry_id = p_entry_id and w.kind = 'withdraw' order by w.seq desc limit 1;
    if v_prior.prior_heat_entry_status = 'scratched' then
      raise exception 'COMP_ADVANCEMENT_REINSTATE_PRIOR_SCRATCH: the couple was already scratched before the withdrawal; the scratch is not undone.' using errcode = 'P0001';
    end if;
    if public._cf1_entry_unavailable(p_entry_id)
       or (v_entry.event_id, v_entry.program_id, v_entry.division_id) is distinct from (v_round.event_id, v_round.program_id, v_round.division_id) then
      raise exception 'COMP_WITHDRAWAL_ENTRY_UNAVAILABLE: the couple is not eligible (%).', coalesce(public._cf1_entry_unavailable_reason(p_entry_id), 'wrong_scope')
        using errcode = 'P0001';
    end if;
    -- OD-18 A: no heat entry is ever inserted. While an active Final heat exists the couple must still have its scratched row there.
    if v_heat is not null and (v_he.id is null or v_he.status <> 'scratched'
                               or v_prior.heat_entry_id is distinct from v_he.id
                               or v_prior.prior_heat_entry_status is null or v_prior.prior_heat_entry_status not in ('scheduled', 'checked_in')) then
      raise exception 'COMP_ADVANCEMENT_REINSTATE_NO_HEAT_ENTRY: the active Final heat has no heat entry for this couple; correct the callback (revoke), reinstate, then advance again.'
        using errcode = 'P0001';
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The guard (I8): a withdrawn pair's heat entry stays out. Unconditional (before and after the start); the only exception is that the
--    pair's effective state is no longer 'withdraw' (a reinstatement row of this transaction is the highest seq). VOLATILE, fail closed.
-- ---------------------------------------------------------------------------
create function public.cf1_guard_withdrawn_heat_entry()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_round uuid;
  v_new_round uuid;
begin
  if tg_op = 'DELETE' then
    -- The event (or the heat) is going away: the cascade removes the evidence with it (the withdrawals FK to the heat entry backstops a direct heat delete).
    if not exists (select 1 from public.events e where e.id = old.event_id)
       or not exists (select 1 from public.event_competition_heats h where h.id = old.heat_id) then
      return old;
    end if;
  elsif tg_op = 'UPDATE' and old.heat_id = new.heat_id and old.entry_id = new.entry_id and old.status is not distinct from new.status then
    return new;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    select h.round_id into v_old_round from public.event_competition_heats h where h.id = old.heat_id;
    if v_old_round is not null and public._cf1_a6_pair_state(v_old_round, old.entry_id) = 'withdraw' then
      if tg_op = 'DELETE' then
        raise exception 'COMP_WITHDRAWAL_GUARD: the heat entry of a withdrawn couple cannot be deleted.' using errcode = '42501';
      end if;
      if old.status = 'scratched' and new.status <> 'scratched' then
        raise exception 'COMP_WITHDRAWAL_GUARD: a withdrawn couple stays scratched; only an audited reinstatement can restore it.' using errcode = '42501';
      end if;
      if old.heat_id is distinct from new.heat_id or old.entry_id is distinct from new.entry_id then
        raise exception 'COMP_WITHDRAWAL_GUARD: the heat entry of a withdrawn couple cannot be moved or re-pointed.' using errcode = '42501';
      end if;
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or old.heat_id is distinct from new.heat_id or old.entry_id is distinct from new.entry_id) then
    select h.round_id into v_new_round from public.event_competition_heats h where h.id = new.heat_id;
    if v_new_round is not null and public._cf1_a6_pair_state(v_new_round, new.entry_id) = 'withdraw' then
      raise exception 'COMP_WITHDRAWAL_GUARD: a withdrawn couple cannot be given a heat entry in this round.' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- can_manage_event_competition(event) for an explicit user (the original reads auth.uid()); same four branches. Re-check both if the original changes.
create function public._cf1_a6_can_manage(p_uid uuid, p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_uid is not null and exists (
    select 1 from public.events e
    where e.id = p_event_id
      and (exists (select 1 from public.profiles p where p.id = p_uid and p.platform_role = 'platform_admin')
           or e.created_by = p_uid
           or exists (select 1 from public.user_studio_roles usr where usr.studio_id = e.studio_id and usr.user_id = p_uid and usr.active = true and usr.role in ('studio_owner', 'studio_admin'))
           or exists (select 1 from public.organizer_users ou where ou.organizer_id = e.organizer_id and ou.user_id = p_uid and ou.active = true
                      and ou.role in ('organizer_owner', 'organizer_admin', 'organizer_staff'))));
$$;

-- Is a request bound to something other than the Final's current state: another active advancement, or any new generation since it was made (apply then revoke included).
create function public._cf1_a6_is_stale(p_round_id uuid, p_advancement_id uuid, p_generation integer, p_version uuid)
returns boolean
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select p_advancement_id is distinct from public._cf1_active_advancement(p_round_id)
      or p_generation is distinct from coalesce((select max(a.generation) from public.event_competition_round_advancements a where a.target_round_id = p_round_id), 0)
      or p_version is distinct from public._cf1_a6_approved_version(p_round_id);
$$;

-- The pending requests of a Final that can still be co-signed: not completed and bound to the Final's current state (see _cf1_a6_is_stale).
create function public._cf1_a6_live_requests(p_round_id uuid)
returns setof public.event_competition_final_withdrawal_requests
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select q.* from public.event_competition_final_withdrawal_requests q
  where q.target_round_id = p_round_id
    and not exists (select 1 from public.event_competition_final_withdrawals w where w.request_id = q.request_id)
    and not exists (select 1 from public.event_competition_final_withdrawal_request_cancellations c where c.request_id = q.request_id)
    and not public._cf1_a6_is_stale(p_round_id, q.advancement_id, q.advancement_generation, q.source_result_version_id);
$$;

-- ---------------------------------------------------------------------------
-- 4. The requester's half: record a pending request (checks run now for an early refusal and again, under the locks, at the co-sign).
-- ---------------------------------------------------------------------------
create function public._cf1_a6_request(p_kind text, p_round_id uuid, p_entry_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_round public.event_competition_rounds;
  v_prev public.event_competition_final_withdrawal_requests;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_done boolean;
  v_adv uuid;
begin
  if v_uid is null or p_round_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public._compe2_round_role(p_round_id) is distinct from 'manager' or public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if p_request_id is null or p_entry_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id and a couple are required.' using errcode = 'P0001';
  end if;
  begin
    select * into v_round from public.event_competition_rounds r where r.id = p_round_id;
    perform public._compo1_lock_event(v_round.event_id);
    select * into v_round from public.event_competition_rounds r where r.id = p_round_id for update;

    select * into v_prev from public.event_competition_final_withdrawal_requests q where q.request_id = p_request_id;
    if found then
      if v_prev.target_round_id = p_round_id and v_prev.entry_id = p_entry_id and v_prev.kind = p_kind and v_prev.requested_by = v_uid then
        v_done := exists (select 1 from public.event_competition_final_withdrawals w where w.request_id = p_request_id);
        return jsonb_build_object('replayed', true, 'state', case when v_done then 'completed'
                                  when exists (select 1 from public.event_competition_final_withdrawal_request_cancellations c where c.request_id = p_request_id) then 'cancelled'
                                  when public._cf1_a6_is_stale(p_round_id, v_prev.advancement_id, v_prev.advancement_generation, v_prev.source_result_version_id) then 'stale' else 'pending' end,
                                  'request_id', p_request_id, 'kind', p_kind);
      end if;
      raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.event_competition_final_withdrawals w where w.request_id = p_request_id) then
      raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
    end if;

    if not public._cf1_reason_is_substantive(v_reason) then
      raise exception 'COMP_WITHDRAWAL_REASON_WEAK: the reason must be 20-500 characters, at least 4 words, not a placeholder.' using errcode = 'P0001';
    end if;
    perform public._cf1_a6_precheck(p_kind, p_round_id, p_entry_id);
    -- one live request per (round, couple, kind), and at most 10 live requests per round (stale or completed ones do not count)
    if exists (select 1 from public._cf1_a6_live_requests(p_round_id) q where q.entry_id = p_entry_id and q.kind = p_kind) then
      raise exception 'COMP_WITHDRAWAL_REQUEST_PENDING: a request for this couple is already waiting for a co-signer.' using errcode = 'P0001';
    end if;
    if (select count(*) from public._cf1_a6_live_requests(p_round_id)) >= 10 then
      raise exception 'COMP_WITHDRAWAL_TOO_MANY_PENDING: this Final already has 10 requests waiting for a co-signer.' using errcode = 'P0001';
    end if;
    v_adv := public._cf1_active_advancement(p_round_id);
    insert into public.event_competition_final_withdrawal_requests (event_id, target_round_id, entry_id, kind, reason, requested_by, advancement_id, advancement_generation, source_result_version_id, request_id)
    values (v_round.event_id, p_round_id, p_entry_id, p_kind, v_reason, v_uid, v_adv,
            coalesce((select max(a.generation) from public.event_competition_round_advancements a where a.target_round_id = p_round_id), 0), public._cf1_a6_approved_version(p_round_id), p_request_id);
    return jsonb_build_object('replayed', false, 'state', 'pending', 'request_id', p_request_id, 'kind', p_kind);
  exception
    when lock_not_available or deadlock_detected then
      raise exception 'COMP_ADVANCEMENT_CONCURRENT_CHANGE: someone changed this round at the same moment; nothing was changed. Try again.' using errcode = '55P03';
  end;
end;
$$;

create function public.withdraw_advanced_entry_from_final(p_round_id uuid, p_entry_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select public._cf1_a6_request('withdraw', p_round_id, p_entry_id, p_reason, p_request_id);
$$;

create function public.reinstate_withdrawn_entry_to_final(p_round_id uuid, p_entry_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select public._cf1_a6_request('reinstate', p_round_id, p_entry_id, p_reason, p_request_id);
$$;

-- ---------------------------------------------------------------------------
-- 5. The co-signer's half: the only writer of event_competition_final_withdrawals.
--    Lock order (A.3): event lock -> Final round FOR UPDATE -> Final heats FOR UPDATE NOWAIT (id order) -> their heat entries FOR UPDATE (id order)
--    -> the entry FOR SHARE; then a fresh-statement revalidation, seq assigned under the round lock, the row, then the heat entry status.
-- ---------------------------------------------------------------------------
create function public.cosign_final_withdrawal_request(p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_req public.event_competition_final_withdrawal_requests;
  v_done public.event_competition_final_withdrawals;
  v_round public.event_competition_rounds;
  v_role text;
  v_seq bigint;
  v_heat uuid;
  v_he public.event_competition_heat_entries;
  v_prior record;
  v_prior_status text := null;
  v_he_id uuid := null;
  v_row uuid;
begin
  if v_uid is null or p_request_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_req from public.event_competition_final_withdrawal_requests q where q.request_id = p_request_id;
  if not found then
    raise exception 'COMP_WITHDRAWAL_REQUEST_NOT_FOUND: no such withdrawal request.' using errcode = 'P0001';
  end if;
  -- OD-19 D (inherits OD-13b C): the chair or an authorized manager, with a verified email.
  v_role := public._compe2_round_role(v_req.target_round_id);
  if v_role is null or v_role not in ('manager', 'chair') or public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  begin
    perform public._compo1_lock_event(v_req.event_id);
    select * into v_round from public.event_competition_rounds r where r.id = v_req.target_round_id for update;

    -- Replay (before any state check).
    select * into v_done from public.event_competition_final_withdrawals w where w.request_id = p_request_id;
    if found then
      if v_done.cosigned_by = v_uid then
        return jsonb_build_object('replayed', true, 'withdrawal_id', v_done.id, 'kind', v_done.kind, 'seq', v_done.seq, 'entry_id', v_done.entry_id,
                                  'heat_entry_id', v_done.heat_entry_id, 'prior_heat_entry_status', v_done.prior_heat_entry_status);
      end if;
      raise exception 'COMP_REQUEST_REUSED: this request was already co-signed by someone else.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.event_competition_final_withdrawal_request_cancellations c where c.request_id = p_request_id) then
      raise exception 'COMP_WITHDRAWAL_REQUEST_CANCELLED: this request was cancelled; request again.' using errcode = 'P0001';
    end if;
    if v_uid = v_req.requested_by then
      raise exception 'COMP_WITHDRAWAL_COSIGN_SAME_PERSON: the co-signer must be a different person from the requester.' using errcode = '42501';
    end if;

    -- The requester must still be a verified manager, and the request still bound to the Final's active advancement.
    if not public._cf1_a6_can_manage(v_req.requested_by, v_req.event_id) or public.verified_email_for_user(v_req.requested_by) is null then
      raise exception 'COMP_WITHDRAWAL_REQUESTER_INVALID: the requester is no longer a verified manager of this event; request again.' using errcode = '42501';
    end if;
    if public._cf1_a6_is_stale(v_req.target_round_id, v_req.advancement_id, v_req.advancement_generation, v_req.source_result_version_id) then
      raise exception 'COMP_WITHDRAWAL_REQUEST_STALE: the Final was advanced or corrected after this request was made; request again.' using errcode = 'P0001';
    end if;

    -- Locks: Final heats (NOWAIT), their heat entries, then the entry.
    perform 1 from public.event_competition_heats h where h.round_id = v_req.target_round_id order by h.id for update nowait;
    perform 1 from public.event_competition_heat_entries he
      where he.heat_id in (select h.id from public.event_competition_heats h where h.round_id = v_req.target_round_id) order by he.id for update;
    perform 1 from public.event_competition_entries e where e.id = v_req.entry_id for share;

    -- Revalidate in fresh statements.
    perform public._cf1_a6_precheck(v_req.kind, v_req.target_round_id, v_req.entry_id);
    v_heat := public._cf1_a6_active_heat(v_req.target_round_id);
    select * into v_he from public.event_competition_heat_entries he where he.heat_id = v_heat and he.entry_id = v_req.entry_id;

    select coalesce(max(w.seq), 0) + 1 into v_seq from public.event_competition_final_withdrawals w where w.target_round_id = v_req.target_round_id;

    if v_req.kind = 'withdraw' then
      if v_he.id is not null then
        v_he_id := v_he.id;
        v_prior_status := v_he.status;
      end if;
      insert into public.event_competition_final_withdrawals
        (event_id, target_round_id, entry_id, seq, kind, reason, requested_by, cosigned_by, cosigned_role, request_id, heat_entry_id, prior_heat_entry_status)
      values (v_req.event_id, v_req.target_round_id, v_req.entry_id, v_seq, 'withdraw', v_req.reason, v_req.requested_by, v_uid, v_role, p_request_id, v_he_id, v_prior_status)
      returning id into v_row;
      if v_prior_status in ('scheduled', 'checked_in') then
        update public.event_competition_heat_entries set status = 'scratched' where id = v_he_id;
      end if;
    else
      select w.* into v_prior from public.event_competition_final_withdrawals w
      where w.target_round_id = v_req.target_round_id and w.entry_id = v_req.entry_id and w.kind = 'withdraw' order by w.seq desc limit 1;
      if v_he.id is not null then
        v_he_id := v_he.id;
        v_prior_status := v_prior.prior_heat_entry_status;
        if v_prior_status is null or v_prior_status not in ('scheduled', 'checked_in') then
          raise exception 'COMP_ADVANCEMENT_REINSTATE_NO_HEAT_ENTRY: the withdrawal did not scratch this heat entry; nothing to restore.' using errcode = 'P0001';
        end if;
      end if;
      -- The reinstatement row is written first: it is the highest seq, so the guard no longer treats the pair as withdrawn.
      insert into public.event_competition_final_withdrawals
        (event_id, target_round_id, entry_id, seq, kind, reason, requested_by, cosigned_by, cosigned_role, request_id, heat_entry_id, prior_heat_entry_status)
      values (v_req.event_id, v_req.target_round_id, v_req.entry_id, v_seq, 'reinstate', v_req.reason, v_req.requested_by, v_uid, v_role, p_request_id, v_he_id, v_prior_status)
      returning id into v_row;
      if v_he_id is not null then
        update public.event_competition_heat_entries set status = v_prior_status where id = v_he_id;
      end if;
    end if;
    return jsonb_build_object('replayed', false, 'withdrawal_id', v_row, 'kind', v_req.kind, 'seq', v_seq, 'entry_id', v_req.entry_id,
                              'heat_entry_id', v_he_id, 'prior_heat_entry_status', v_prior_status);
  exception
    when lock_not_available or deadlock_detected then
      raise exception 'COMP_ADVANCEMENT_CONCURRENT_CHANGE: a Final heat or one of its couples is being changed; nothing was changed. Try again.' using errcode = '55P03';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5b. Cancel a pending request (D-B, owner): the requester or any authorized manager / the chair, verified email, a recorded reason. One insert-only
--     evidence row per request; idempotent for the same person; it cannot undo a completed withdrawal / reinstatement. Lock order as the co-sign:
--     event lock -> Final round FOR UPDATE, so a cancel and a co-sign of the same request serialize and exactly one wins (the loser gets
--     COMP_WITHDRAWAL_REQUEST_CANCELLED or COMP_WITHDRAWAL_REQUEST_COMPLETED). No automatic expiry.
-- ---------------------------------------------------------------------------
create function public.cancel_final_withdrawal_request(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_req public.event_competition_final_withdrawal_requests;
  v_prev public.event_competition_final_withdrawal_request_cancellations;
  v_round public.event_competition_rounds;
  v_role text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_row uuid;
begin
  if v_uid is null or p_request_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_req from public.event_competition_final_withdrawal_requests q where q.request_id = p_request_id;
  if not found then
    raise exception 'COMP_WITHDRAWAL_REQUEST_NOT_FOUND: no such withdrawal request.' using errcode = 'P0001';
  end if;
  v_role := public._compe2_round_role(v_req.target_round_id);
  if v_role is null or v_role not in ('manager', 'chair') or public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  begin
    perform public._compo1_lock_event(v_req.event_id);
    select * into v_round from public.event_competition_rounds r where r.id = v_req.target_round_id for update;

    select * into v_prev from public.event_competition_final_withdrawal_request_cancellations c where c.request_id = p_request_id;
    if found then
      if v_prev.cancelled_by = v_uid then
        return jsonb_build_object('replayed', true, 'state', 'cancelled', 'request_id', p_request_id, 'cancellation_id', v_prev.id, 'kind', v_req.kind, 'entry_id', v_req.entry_id);
      end if;
      raise exception 'COMP_WITHDRAWAL_REQUEST_CANCELLED: this request was already cancelled by someone else.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.event_competition_final_withdrawals w where w.request_id = p_request_id) then
      raise exception 'COMP_WITHDRAWAL_REQUEST_COMPLETED: this request was already co-signed; a completed withdrawal is undone only by a reinstatement.' using errcode = 'P0001';
    end if;
    if not public._cf1_reason_is_substantive(v_reason) then
      raise exception 'COMP_WITHDRAWAL_REASON_WEAK: the reason must be 20-500 characters, at least 4 words, not a placeholder.' using errcode = 'P0001';
    end if;
    insert into public.event_competition_final_withdrawal_request_cancellations (event_id, target_round_id, entry_id, request_id, reason, cancelled_by, cancelled_role, by_requester)
    values (v_req.event_id, v_req.target_round_id, v_req.entry_id, p_request_id, v_reason, v_uid, v_role, v_uid = v_req.requested_by)
    returning id into v_row;
    return jsonb_build_object('replayed', false, 'state', 'cancelled', 'request_id', p_request_id, 'cancellation_id', v_row, 'kind', v_req.kind, 'entry_id', v_req.entry_id);
  exception
    when lock_not_available or deadlock_detected then
      raise exception 'COMP_ADVANCEMENT_CONCURRENT_CHANGE: someone changed this round at the same moment; nothing was changed. Try again.' using errcode = '55P03';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Read: the effective withdrawals and the pending requests of a Final (manager or chair, verified email). No locks.
-- ---------------------------------------------------------------------------
create function public.competition_final_withdrawal_state(p_round_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  v_role := public._compe2_round_role(p_round_id);
  if v_uid is null or v_role is null or v_role not in ('manager', 'chair') or public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'withdrawn', coalesce((select jsonb_agg(jsonb_build_object('entry_id', w.entry_id, 'withdrawal_id', w.withdrawal_id) order by w.entry_id)
                           from public._cf1_withdrawn_entries(p_round_id) w), '[]'::jsonb),
    'pending', coalesce((select jsonb_agg(jsonb_build_object('request_id', q.request_id, 'kind', q.kind, 'entry_id', q.entry_id, 'requested_by', q.requested_by,
                                                              'reason', q.reason, 'at', q.at, 'stale', public._cf1_a6_is_stale(p_round_id, q.advancement_id, q.advancement_generation, q.source_result_version_id)) order by q.at, q.id)
                         from public.event_competition_final_withdrawal_requests q
                         where q.target_round_id = p_round_id
                           and not exists (select 1 from public.event_competition_final_withdrawals w where w.request_id = q.request_id)
                           and not exists (select 1 from public.event_competition_final_withdrawal_request_cancellations c where c.request_id = q.request_id)), '[]'::jsonb),
    'cancelled', coalesce((select jsonb_agg(jsonb_build_object('request_id', c.request_id, 'kind', q.kind, 'entry_id', c.entry_id, 'requested_by', q.requested_by, 'cancelled_by', c.cancelled_by,
                                                                'by_requester', c.by_requester, 'reason', c.reason, 'at', c.at) order by c.at, c.id)
                           from public.event_competition_final_withdrawal_request_cancellations c
                           join public.event_competition_final_withdrawal_requests q on q.request_id = c.request_id
                           where c.target_round_id = p_round_id), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants and the trigger (ENABLE ALWAYS: it fires under session_replication_role = replica).
-- ---------------------------------------------------------------------------
revoke all on function public._cf1_a6_pair_state(uuid, uuid), public._cf1_a6_current_roster(uuid), public._cf1_a6_on_roster(uuid, uuid),
  public._cf1_a6_active_heat(uuid), public._cf1_a6_roster_blocked(uuid), public._cf1_a6_precheck(text, uuid, uuid), public.cf1_guard_withdrawn_heat_entry(),
  public._cf1_a6_request(text, uuid, uuid, text, uuid), public._cf1_a6_can_manage(uuid, uuid), public._cf1_a6_live_requests(uuid), public._cf1_a6_is_stale(uuid, uuid, integer, uuid), public._cf1_a6_approved_version(uuid)
  from public, anon, authenticated, service_role;

-- The invoker 10D triggers never call these; the guard runs as its owner. Only the five RPCs are callable, by authenticated.
revoke all on function public.withdraw_advanced_entry_from_final(uuid, uuid, text, uuid), public.reinstate_withdrawn_entry_to_final(uuid, uuid, text, uuid),
  public.cosign_final_withdrawal_request(uuid), public.competition_final_withdrawal_state(uuid), public.cancel_final_withdrawal_request(uuid, text) from public, anon, service_role;
grant execute on function public.withdraw_advanced_entry_from_final(uuid, uuid, text, uuid), public.reinstate_withdrawn_entry_to_final(uuid, uuid, text, uuid),
  public.cosign_final_withdrawal_request(uuid), public.competition_final_withdrawal_state(uuid), public.cancel_final_withdrawal_request(uuid, text) to authenticated;

create trigger cf1_guard_withdrawn_heat_entry before insert or update of status, entry_id, heat_id or delete on public.event_competition_heat_entries
  for each row execute function public.cf1_guard_withdrawn_heat_entry();
alter table public.event_competition_heat_entries enable always trigger cf1_guard_withdrawn_heat_entry;

commit;

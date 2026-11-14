-- Competition CF1 OD-17 enforcement switch (slot 20270120105000). Ships DARK: no event has the switch ON after this migration.
--
-- WHAT OD-17 IS (design callback-to-final-advancement-design.md section 4.6 a, owner decision 2026-10-30, scope: ALL scored rounds, ALL disciplines):
-- a couple that is "unavailable" under predicate P (A1 _cf1_entry_unavailable_reason: entry not confirmed / ineligible / registration or order
-- cancelled, refunded or payment-failed / RB3+RB3R per-entry refund evidence) must not silently receive an official ranking or advance.
-- RB1 (restated rev 21): the cross-checks are NOT enabled for live events until the exclusion action, the recovery routes, F3 and the
-- cross-discipline regression suites are done. The owner direction for this slice: keep live-event OD-17 DISABLED until all release gates pass.
--
-- WHERE THE CHECK ALREADY EXISTS (unconditional in this tree, NOT gated by this migration, cannot be gated without changing today's behaviour):
--   A2  lock_competition_round_ballots           _cf1_require_roster_eligible(round, 'lock')
--   A3  calculate_competition_round / approve_*  _cf1_require_roster_eligible(round, 'calculate' | 'approve')
--   F3  publish_competition_round_result         _cf1_require_roster_eligible(round, 'approve')
--   A0  apply_competition_round_advancement, cf1_guard_final_start (callback Final start), A6 withdrawal count: P at apply / start / withdraw
--   10D.1 heat-entry placement: status confirmed and eligibility_status <> 'ineligible' only (NOT registration / order / refund state)
-- For those, "applying the migration IS the enablement" (A3 contract). This slice therefore does not touch them: with the switch OFF every
-- existing function and trigger behaves exactly as before (the added triggers below return immediately).
--
-- WHAT THIS ADDS (only when the event's switch is ON; the gaps where P was not enforced at the authoritative mutation boundary):
--   M1  round start (scheduled -> active) of ANY scored round (A0 only guards the callback Final): P over the ranking set, else
--       COMP_OD17_ROSTER_ENTRY_UNAVAILABLE (stage 'start'). Runs after the round FOR UPDATE and the event advisory lock of start_competition_round.
--   M2  heat-entry placement (insert, entry/heat change, un-scratch): P on the entry, else COMP_OD17_ROSTER_ENTRY_UNAVAILABLE (stage 'place').
--       Covers floor-plan apply, callback advancement apply, A6 reinstatement and any direct write.
--   M3  forward round edges (scheduled->active, active->ballots_locked, ballots_locked->calculated, calculated->approved, approved->published)
--       and the insert of a round advancement: the RB3 refund-evidence gate (_cf1_od17_refund_gate) is re-run, so a revoked owner override or a
--       broken R2 ledger fails CLOSED (COMP_OD17_REFUND_GATE) instead of silently missing refunds. Reopen / correction edges are NOT gated
--       (they are the recovery routes).
--
-- SWITCH: public.competition_cf1_od17_enforcement (one row per event, enabled boolean, OFF when no row). Changed only by
-- cf1_od17_set_enforcement(event, enabled, reason, request_id) (SECURITY DEFINER, event manager with a verified email, replay by request id,
-- one audit row per successful call in competition_cf1_od17_audit). ENABLE refuses unless every gate of _cf1_od17_gates(event) is true:
--   refund_evidence   _cf1_od17_refund_gate() returns 'r2_ledger' or 'override:*' (RB3)
--   release_not_live  event.status <> 'published', no program with registration_status = 'open', no schedule version 'live'
--                     (no documented release-gate flag exists for OD-17 on live events: this HOLD is absolute until the owner defines one)
--   chain_integrity   A2/A3/F3 functions carry the roster check; A0 start guard enabled; A5 exclusion action, A6 withdrawal, U66 recovery,
--                     F3 publication withdraw and RB3/RB3R evidence objects exist (RB1 a: recovery routes built)
--   no_blocked_ties   no live callback_tally result version of the event holds an undecided (advanced is null) row (approved owner policy:
--                     an over-capacity tie stays UNRESOLVED; no tie-breaker, no partial advancement)
--   roster_clean      no round of the event in scheduled / active / ballots_locked / calculated / approved holds an unavailable couple
-- Not machine-checkable (RB1 b regression suites U80-U85 and the owner written acceptances) are recorded by the mandatory reason text only.
-- DISABLE has no gates and works for any event.
--
-- Lock order (A.3): event advisory lock (_compo1_lock_event) -> od17 advisory lock (exclusive, enable/disable only) -> gate reads (no row locks).
-- The three triggers take a SHARED od17 advisory lock first, so a concurrent enable waits for in-flight placements / edges and the placement
-- sees the committed switch; the start trigger then takes the ranking-set entries FOR SHARE in id order (A3 order: round row, then entries).
-- No trigger takes the event lock, so an RPC that already holds it (start, apply, A6) keeps the event -> round -> heat entry -> entry order.
-- Rollback: rollback/20270120105000_competition_cf1_od17_enforcement_rollback.sql (refuses while any event is ON or any audit row exists).

begin;

do $$
begin
  if to_regprocedure('public._cf1_entry_unavailable_reason(uuid)') is null
     or to_regprocedure('public._cf1_round_roster_problems(uuid)') is null
     or to_regprocedure('public._cf1_entry_unavailable(uuid)') is null then
    raise exception 'CF1-OD17 preflight: A1 (20270120085000) is missing.';
  end if;
  if to_regprocedure('public._cf1_od17_refund_gate()') is null then
    raise exception 'CF1-OD17 preflight: RB3 (20270120102000, _cf1_od17_refund_gate) is missing.';
  end if;
  if to_regprocedure('public._compo1_lock_event(uuid)') is null
     or to_regprocedure('public.can_manage_event_competition(uuid)') is null
     or to_regprocedure('public.verified_email_for_user(uuid)') is null
     or to_regprocedure('public.protect_competition_history_evidence()') is null
     or to_regprocedure('public._compe2_round_entries(uuid)') is null then
    raise exception 'CF1-OD17 preflight: O1 / E1 / E2 helpers are missing.';
  end if;
  if to_regclass('public.event_competition_round_advancements') is null
     or to_regclass('public.event_competition_heat_entries') is null
     or to_regclass('public.event_competition_rounds') is null then
    raise exception 'CF1-OD17 preflight: A0 tables are missing.';
  end if;
  if to_regclass('public.competition_cf1_od17_enforcement') is not null
     or to_regclass('public.competition_cf1_od17_audit') is not null
     or to_regprocedure('public.cf1_od17_set_enforcement(uuid,boolean,text,uuid)') is not null then
    raise exception 'CF1-OD17 preflight: an OD-17 enforcement object already exists.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tables (no direct access of any kind; the definer functions are the only readers and writers)
-- ---------------------------------------------------------------------------
create table public.competition_cf1_od17_enforcement (
  event_id uuid primary key references public.events(id) on delete cascade,
  enabled boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  last_request_id uuid
);
comment on table public.competition_cf1_od17_enforcement is
  'CF1 OD-17: per-event enforcement switch (no row or enabled = false means OFF). Written only by cf1_od17_set_enforcement.';
alter table public.competition_cf1_od17_enforcement enable row level security;
revoke all on public.competition_cf1_od17_enforcement from public, anon, authenticated, service_role;

create table public.competition_cf1_od17_audit (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  action text not null check (action in ('enable', 'disable')),
  changed boolean not null,
  actor uuid not null,
  request_id uuid not null unique,
  reason text not null check (length(btrim(reason)) between 10 and 500),
  refund_gate text,
  gates jsonb,
  at timestamptz not null default now(),
  transaction_id bigint not null default txid_current()
);
comment on table public.competition_cf1_od17_audit is
  'CF1 OD-17: append-only audit of every successful enable / disable (gate snapshot at enable). Roll forward only.';
create index competition_cf1_od17_audit_event_idx on public.competition_cf1_od17_audit (event_id, at desc);
alter table public.competition_cf1_od17_audit enable row level security;
revoke all on public.competition_cf1_od17_audit from public, anon, authenticated, service_role;
create trigger protect_competition_cf1_od17_audit_history before update or delete on public.competition_cf1_od17_audit
  for each row execute function public.protect_competition_history_evidence();
create trigger protect_competition_cf1_od17_audit_history_truncate before truncate on public.competition_cf1_od17_audit
  for each statement execute function public.protect_competition_history_evidence();
alter table public.competition_cf1_od17_audit enable always trigger protect_competition_cf1_od17_audit_history;
alter table public.competition_cf1_od17_audit enable always trigger protect_competition_cf1_od17_audit_history_truncate;

-- ---------------------------------------------------------------------------
-- 2. Readers
-- ---------------------------------------------------------------------------
create function public._cf1_od17_enforced(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select s.enabled from public.competition_cf1_od17_enforcement s where s.event_id = p_event_id), false);
$$;
revoke all on function public._cf1_od17_enforced(uuid) from public, anon, authenticated, service_role;

-- Machine-checkable release gates for one event. VOLATILE on purpose: every statement takes a fresh snapshot (the caller holds the locks).
create function public._cf1_od17_gates(p_event_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_refund text;
  v_refund_ok boolean := true;
  v_live text[] := '{}';
  v_missing text[] := '{}';
  v_ties integer;
  v_problem_rounds jsonb;
  v_problem_entries integer;
  v_gates jsonb;
begin
  -- RB3 refund evidence
  begin
    v_refund := public._cf1_od17_refund_gate();
  exception when others then
    v_refund_ok := false;
    v_refund := sqlerrm;
  end;

  -- Live-event hold (no documented release flag exists: absolute)
  if exists (select 1 from public.events e where e.id = p_event_id and e.status = 'published') then
    v_live := array_append(v_live, 'event_published');
  end if;
  if exists (select 1 from public.event_competition_programs p where p.event_id = p_event_id and p.registration_status = 'open') then
    v_live := array_append(v_live, 'registration_open');
  end if;
  if exists (select 1 from public.event_competition_schedule_versions v where v.event_id = p_event_id and v.status = 'live') then
    v_live := array_append(v_live, 'schedule_live');
  end if;

  -- Chain integrity: the unconditional checks and recovery routes the RB1 gate relies on are really installed
  select coalesce(array_agg(c.k order by c.k), '{}') into v_missing
  from (values
    ('a2_lock_check',          exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'lock_competition_round_ballots' and position('_cf1_require_roster_eligible' in p.prosrc) > 0)),
    ('a3_calculate_check',     exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'calculate_competition_round' and position('_cf1_require_roster_eligible' in p.prosrc) > 0)),
    ('a3_approve_check',       exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'approve_competition_round_result' and position('_cf1_require_roster_eligible' in p.prosrc) > 0)),
    ('f3_publish_check',       exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'publish_competition_round_result' and position('_cf1_require_roster_eligible' in p.prosrc) > 0)),
    ('a3_exclusion_in_ranking', exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_compe2_round_entries' and position('_cf1_heat_entry_is_excluded' in p.prosrc) > 0)),
    ('a0_apply',               exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'apply_competition_round_advancement')),
    ('a0_final_start_guard',   exists (select 1 from pg_trigger t where t.tgname = 'cf1_guard_final_start' and t.tgrelid = 'public.event_competition_rounds'::regclass and t.tgenabled <> 'D')),
    ('a5_exclusion_action',    exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'request_round_exclusion')),
    ('a6_withdrawal',          exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'withdraw_advanced_entry_from_final')),
    ('u66_recovery',           exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'recover_correction_for_exclusion')),
    ('f3_withdraw_publication', exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'withdraw_competition_round_result')),
    ('rb3_refund_evidence',    exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_cf1_entry_refund_evidence_reason')),
    ('rb3r_reconciliation',    exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'request_cf1_refund_evidence_release'))
  ) c(k, ok) where not c.ok;

  -- Blocked ties: undecided rows on a live callback result stay UNRESOLVED (approved policy); nothing may be enabled over one
  select count(distinct v.id) into v_ties
  from public.event_competition_result_versions v
  join public.event_competition_result_rows rr on rr.result_version_id = v.id
  where v.event_id = p_event_id and v.engine_key like '%callback_tally%' and v.status not in ('stale', 'superseded') and rr.advanced is null;

  -- Roster clean: no running or pending round already holds an unavailable couple
  select coalesce(jsonb_agg(x.round_id), '[]'::jsonb), coalesce(sum(x.n), 0) into v_problem_rounds, v_problem_entries
  from (select r.id as round_id, (select count(*) from public._cf1_round_roster_problems(r.id)) as n
        from public.event_competition_rounds r
        where r.event_id = p_event_id and r.status in ('scheduled', 'active', 'ballots_locked', 'calculated', 'approved')) x
  where x.n > 0;

  v_gates := jsonb_build_object(
    'refund_evidence', jsonb_build_object('ok', v_refund_ok, 'detail', v_refund),
    'release_not_live', jsonb_build_object('ok', cardinality(v_live) = 0, 'detail', to_jsonb(v_live)),
    'chain_integrity', jsonb_build_object('ok', cardinality(v_missing) = 0, 'detail', to_jsonb(v_missing)),
    'no_blocked_ties', jsonb_build_object('ok', v_ties = 0, 'detail', v_ties),
    'roster_clean', jsonb_build_object('ok', v_problem_entries = 0, 'detail', jsonb_build_object('rounds', v_problem_rounds, 'entries', v_problem_entries))
  );
  return v_gates || jsonb_build_object('all_ok', (select bool_and((g.value ->> 'ok')::boolean) from jsonb_each(v_gates) g));
end;
$$;
revoke all on function public._cf1_od17_gates(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Runtime guards (all return immediately while the event's switch is OFF)
-- ---------------------------------------------------------------------------
create function public._cf1_od17_runtime_gate()
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform public._cf1_od17_refund_gate();
  exception when others then
    raise exception 'COMP_OD17_REFUND_GATE: the refund-evidence release gate no longer holds, so OD-17 enforcement refuses to proceed (%).', sqlerrm
      using errcode = 'P0001';
  end;
end;
$$;
revoke all on function public._cf1_od17_runtime_gate() from public, anon, authenticated, service_role;

create function public.cf1_od17_guard_round_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bad jsonb;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if not ((old.status, new.status) in (('scheduled', 'active'), ('active', 'ballots_locked'), ('ballots_locked', 'calculated'),
                                        ('calculated', 'approved'), ('approved', 'published'))) then
    return new;
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('cf1od17:' || new.event_id::text, 0));
  if not public._cf1_od17_enforced(new.event_id) then
    return new;
  end if;
  perform public._cf1_od17_runtime_gate();
  if old.status = 'scheduled' and new.status = 'active' then
    -- Ranking-set entries FOR SHARE in id order (A3 order: the caller holds the round row), then the check as a separate statement (fresh snapshot).
    perform 1 from public.event_competition_entries en where en.id = any (public._compe2_round_entries(new.id)) order by en.id for share;
    select jsonb_agg(jsonb_build_object('entry_id', p.entry_id, 'reason', p.reason) order by p.entry_id) into v_bad
    from public._cf1_round_roster_problems(new.id) p;
    if v_bad is not null then
      raise exception 'COMP_OD17_ROSTER_ENTRY_UNAVAILABLE: % couple(s) in this round are no longer eligible; the round was not started.', jsonb_array_length(v_bad)
        using errcode = 'P0001', detail = jsonb_build_object('stage', 'start', 'round_id', new.id, 'entries', v_bad)::text;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_od17_guard_round_status() from public, anon, authenticated, service_role;

create function public.cf1_od17_guard_heat_entry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text;
begin
  if new.status = 'scratched' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and not (new.entry_id is distinct from old.entry_id or new.heat_id is distinct from old.heat_id or old.status = 'scratched') then
    return new;
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('cf1od17:' || new.event_id::text, 0));
  if not public._cf1_od17_enforced(new.event_id) then
    return new;
  end if;
  v_reason := public._cf1_entry_unavailable_reason(new.entry_id);
  if v_reason is not null then
    raise exception 'COMP_OD17_ROSTER_ENTRY_UNAVAILABLE: this couple is no longer eligible and cannot be placed in a heat.'
      using errcode = 'P0001', detail = jsonb_build_object('stage', 'place', 'heat_id', new.heat_id,
                                                           'entries', jsonb_build_array(jsonb_build_object('entry_id', new.entry_id, 'reason', v_reason)))::text;
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_od17_guard_heat_entry() from public, anon, authenticated, service_role;

create function public.cf1_od17_guard_advancement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock_shared(hashtextextended('cf1od17:' || new.event_id::text, 0));
  if public._cf1_od17_enforced(new.event_id) then
    perform public._cf1_od17_runtime_gate();
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_od17_guard_advancement() from public, anon, authenticated, service_role;

create trigger cf1_od17_guard_round_status before update of status on public.event_competition_rounds
  for each row execute function public.cf1_od17_guard_round_status();
create trigger cf1_od17_guard_heat_entry before insert or update of entry_id, heat_id, status on public.event_competition_heat_entries
  for each row execute function public.cf1_od17_guard_heat_entry();
create trigger cf1_od17_guard_advancement before insert on public.event_competition_round_advancements
  for each row execute function public.cf1_od17_guard_advancement();
alter table public.event_competition_rounds enable always trigger cf1_od17_guard_round_status;
alter table public.event_competition_heat_entries enable always trigger cf1_od17_guard_heat_entry;
alter table public.event_competition_round_advancements enable always trigger cf1_od17_guard_advancement;

-- ---------------------------------------------------------------------------
-- 4. The audited switch
-- ---------------------------------------------------------------------------
create function public.cf1_od17_set_enforcement(p_event_id uuid, p_enabled boolean, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_action text;
  v_prev public.competition_cf1_od17_audit;
  v_was boolean;
  v_gates jsonb;
  v_gate text;
begin
  if v_uid is null or p_event_id is null
     or not exists (select 1 from public.events e where e.id = p_event_id)
     or not public.can_manage_event_competition(p_event_id) then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required to change OD-17 enforcement.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if p_enabled is null then
    raise exception 'COMP_OD17_BAD_ARGUMENT: enabled must be true or false.' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception 'COMP_OD17_REASON_REQUIRED: give a reason of 10 to 500 characters (cite the release evidence).' using errcode = 'P0001';
  end if;
  v_action := case when p_enabled then 'enable' else 'disable' end;

  -- Lock order: event advisory lock, then the exclusive od17 lock (waits for in-flight placements / edges, blocks new ones).
  perform public._compo1_lock_event(p_event_id);
  perform pg_advisory_xact_lock(hashtextextended('cf1od17:' || p_event_id::text, 0));

  select * into v_prev from public.competition_cf1_od17_audit a where a.request_id = p_request_id;
  if found then
    if v_prev.event_id = p_event_id and v_prev.actor = v_uid and v_prev.action = v_action then
      return jsonb_build_object('replayed', true, 'event_id', p_event_id, 'action', v_prev.action, 'enabled', public._cf1_od17_enforced(p_event_id),
                                'changed', v_prev.changed, 'gates', v_prev.gates, 'audit_id', v_prev.id);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;

  v_was := public._cf1_od17_enforced(p_event_id);
  if p_enabled then
    v_gates := public._cf1_od17_gates(p_event_id);
    if (v_gates ->> 'all_ok')::boolean is not true then
      select string_agg(g.key, ', ' order by g.key) into v_gate from jsonb_each(v_gates) g
       where g.key <> 'all_ok' and (g.value ->> 'ok')::boolean is not true;
      raise exception 'COMP_OD17_GATES_NOT_MET: OD-17 enforcement cannot be enabled; failing gate(s): %.', v_gate
        using errcode = 'P0001', detail = v_gates::text;
    end if;
  end if;

  insert into public.competition_cf1_od17_enforcement (event_id, enabled, changed_at, changed_by, last_request_id)
  values (p_event_id, p_enabled, now(), v_uid, p_request_id)
  on conflict (event_id) do update
    set enabled = excluded.enabled, changed_at = now(), changed_by = v_uid, last_request_id = p_request_id;
  insert into public.competition_cf1_od17_audit (event_id, action, changed, actor, request_id, reason, refund_gate, gates)
  values (p_event_id, v_action, v_was is distinct from p_enabled, v_uid, p_request_id, v_reason,
          case when p_enabled then v_gates -> 'refund_evidence' ->> 'detail' end, v_gates);
  return jsonb_build_object('replayed', false, 'event_id', p_event_id, 'action', v_action, 'enabled', p_enabled,
                            'changed', v_was is distinct from p_enabled, 'gates', v_gates);
end;
$$;
revoke all on function public.cf1_od17_set_enforcement(uuid, boolean, text, uuid) from public, anon, service_role;
grant execute on function public.cf1_od17_set_enforcement(uuid, boolean, text, uuid) to authenticated;

-- Read: the switch and the live gate evaluation (event managers only; takes no locks)
create function public.cf1_od17_enforcement_state(p_event_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or p_event_id is null or not public.can_manage_event_competition(p_event_id) then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  return jsonb_build_object('event_id', p_event_id, 'enabled', public._cf1_od17_enforced(p_event_id), 'gates', public._cf1_od17_gates(p_event_id),
    'last_change', (select jsonb_build_object('action', a.action, 'at', a.at, 'changed', a.changed)
                    from public.competition_cf1_od17_audit a where a.event_id = p_event_id order by a.at desc, a.id limit 1));
end;
$$;
revoke all on function public.cf1_od17_enforcement_state(uuid) from public, anon, service_role;
grant execute on function public.cf1_od17_enforcement_state(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Postflight
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.competition_cf1_od17_enforcement) then
    raise exception 'CF1-OD17 postflight: a switch row exists after apply (must ship dark).';
  end if;
  if (select count(*) from pg_trigger t where t.tgname in ('cf1_od17_guard_round_status', 'cf1_od17_guard_heat_entry', 'cf1_od17_guard_advancement')
        and t.tgenabled = 'A') <> 3 then
    raise exception 'CF1-OD17 postflight: the three guards must exist and be ENABLE ALWAYS.';
  end if;
  if has_function_privilege('anon', 'public.cf1_od17_set_enforcement(uuid,boolean,text,uuid)', 'execute')
     or has_function_privilege('anon', 'public._cf1_od17_gates(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._cf1_od17_gates(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._cf1_od17_enforced(uuid)', 'execute') then
    raise exception 'CF1-OD17 postflight: privilege leak.';
  end if;
end $$;

commit;

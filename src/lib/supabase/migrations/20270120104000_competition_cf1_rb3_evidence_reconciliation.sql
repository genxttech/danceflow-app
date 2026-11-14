-- Competition CF1 RB3 evidence reconciliation (owner decision RB3): fail-closed refund evidence + an AUTHORIZED, AUDITABLE release path.
--
-- Builds on 20270120102000 (RB3). Does not touch A-series / F3 migrations, does not wire OD-17 enforcement, never writes to a provider,
-- payment or refund record (no UPDATE / DELETE / INSERT on event_order_refunds, event_order_refund_allocations, event_payments, event_orders).
--
-- 1. FAIL-CLOSED HARDENING of public._cf1_entry_refund_evidence_reason(uuid) (same signature; R2 ledger mode only - while R2 is absent / mismatched
--    the RB3 gate refuses, see _cf1_od17_refund_gate). New unavailable reasons, in addition to the four of RB3:
--      entry_refund_unattributed_order   now also: ANY source (staff included), SUCCEEDED refund of the entry's order or registration whose allocations
--                                        sum to LESS than the refund amount (none = RB3 G5; some = partially attributed). Another entry's full
--                                        attribution does not clear it.
--      entry_refund_pending              now also: a requested / pending / requires_action refund (any source) whose allocations sum to less than its
--                                        amount (partially attributed / not yet attributed).
--      entry_refund_evidence_contradictory  a non-failed refund whose allocations sum to MORE than the refund amount.
--      entry_refund_evidence_missing     refund state outside the ledger: the order says partially_refunded while the ledger has no succeeded refund,
--                                        or event_payments of the order / registration record more refunded money than the ledger's succeeded refunds
--                                        (desk / legacy / externally recorded refunds), or a payment is marked refunded with no succeeded ledger refund.
--    A refund matches an entry by order_id OR by registration_id. failed / canceled refunds still do not count (Stripe reversal).
--
-- 2. RECONCILIATION (release path). Table competition_cf1_rb3_reconciliations is APPEND-ONLY (UPDATE / DELETE / TRUNCATE refused, ENABLE ALWAYS):
--      release_requested  written by request_cf1_refund_evidence_release (studio owner / admin, event creator, organizer staff, platform admin; verified email)
--      release_cosigned   written by cosign_cf1_refund_evidence_release, a DIFFERENT person (same pattern as A5 exclusions)
--      release_revoked    written by revoke_cf1_refund_evidence_release (one person suffices: revoking only closes)
--    Every row carries the order, the entry, the refund ids, a server-built evidence snapshot and its md5 fingerprint. A written reason (>= 20 chars) is
--    required. Idempotent replay by request_id. Per-entry advisory lock serialises the three functions.
--    RELEASE: an entry's reason entry_refund_recorded (and only that one) is cleared when a cosigned decision exists whose fingerprint EQUALS the fingerprint
--    of the CURRENT evidence, no later revocation exists, and the current evidence is fully attributed: every non-failed refund of the order / registration
--    is succeeded, allocations sum exactly to the refund amount, no allocation names the entry with withdraw_entry = true (a withdrawal request is never
--    reconciled away), nothing pending / blocked / contradictory / missing. Any later change of any refund, allocation, scope or order status changes the
--    fingerprint, so the release lapses by itself. The decision never creates, edits or settles a refund.
--    NEVER releasable (stay unavailable; owner decisions): entry_refund_withdrawal_blocked (R2 scope resolution path), entry_refund_pending,
--    entry_refund_unattributed_order (R2 attribute_competition_refund path), entry_refund_evidence_contradictory, entry_refund_evidence_missing.
--
-- Apply order: slot 20270120104000, after RB3 (20270120102000). SQL before app. Rollback restores the RB3 function body exactly and refuses while any
-- reconciliation row exists (they are audit evidence: export first).

begin;

do $$
begin
  if to_regprocedure('public._cf1_entry_refund_evidence_reason(uuid)') is null
     or to_regprocedure('public._cf1_refund_evidence_mode()') is null
     or to_regprocedure('public._cf1_od17_refund_gate()') is null then
    raise exception 'CF1-RB3R preflight: CF1 RB3 (20270120102000) is missing.';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public._cf1_entry_refund_evidence_reason(uuid)'::regprocedure)
       is distinct from 'c4e51b4094dfb43d92c93935a21f3a7b' then
    raise exception 'CF1-RB3R preflight: _cf1_entry_refund_evidence_reason is not the RB3 definition.';
  end if;
  if to_regclass('public.competition_cf1_rb3_reconciliations') is not null
     or to_regprocedure('public._cf1_rb3_raw(uuid)') is not null
     or to_regprocedure('public.request_cf1_refund_evidence_release(uuid,text,uuid)') is not null then
    raise exception 'CF1-RB3R preflight: a reconciliation object already exists.';
  end if;
  if to_regprocedure('public._cf1_a6_can_manage(uuid,uuid)') is null or to_regprocedure('public.verified_email_for_user(uuid)') is null then
    raise exception 'CF1-RB3R preflight: _cf1_a6_can_manage / verified_email_for_user is missing.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Audit table (append-only)
-- ---------------------------------------------------------------------------------------------------------------------------------
create table public.competition_cf1_rb3_reconciliations (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  event_id uuid not null references public.events(id) on delete restrict,
  entry_id uuid not null references public.event_competition_entries(id) on delete restrict,
  order_id uuid not null references public.event_orders(id) on delete restrict,
  kind text not null check (kind in ('release_requested', 'release_cosigned', 'release_revoked')),
  decision_id uuid null references public.competition_cf1_rb3_reconciliations(id) on delete restrict,
  request_id uuid not null unique,
  actor uuid not null,
  actor_role text not null,
  reason text not null check (length(btrim(reason)) >= 20 and length(reason) <= 1000),
  basis_reason text not null check (basis_reason = 'entry_refund_recorded'),
  refund_ids uuid[] not null,
  evidence jsonb not null,
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  constraint competition_cf1_rb3_reconciliations_decision_shape check ((kind = 'release_requested') = (decision_id is null))
);
create unique index competition_cf1_rb3_reconciliations_one_cosign on public.competition_cf1_rb3_reconciliations(decision_id) where kind = 'release_cosigned';
create index competition_cf1_rb3_reconciliations_entry_idx on public.competition_cf1_rb3_reconciliations(entry_id, seq);
comment on table public.competition_cf1_rb3_reconciliations is
  'CF1 RB3R: append-only audit of refund-evidence release decisions (request / cosign / revoke). Never edits provider, payment or refund records.';

create function public._cf1_rb3r_protect()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'CF1-RB3R: reconciliation rows are append-only.' using errcode = '42501';
end;
$$;
create trigger cf1_rb3r_protect before update or delete on public.competition_cf1_rb3_reconciliations
  for each row execute function public._cf1_rb3r_protect();
create trigger cf1_rb3r_no_truncate before truncate on public.competition_cf1_rb3_reconciliations
  for each statement execute function public._cf1_rb3r_protect();
alter table public.competition_cf1_rb3_reconciliations enable always trigger cf1_rb3r_protect;
alter table public.competition_cf1_rb3_reconciliations enable always trigger cf1_rb3r_no_truncate;

alter table public.competition_cf1_rb3_reconciliations enable row level security;
revoke all on public.competition_cf1_rb3_reconciliations from public, anon, authenticated, service_role;
-- no direct table access for any API role: managers read through cf1_refund_evidence_state (the A6 manager helper is not executable by authenticated, so no policy).

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. Evidence snapshot / fingerprint (R2 ledger mode only; plpgsql: the R2 tables resolve at first execution)
-- ---------------------------------------------------------------------------------------------------------------------------------
create function public._cf1_rb3_snapshot(p_entry_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_e public.event_competition_entries;
  v_order_status text;
  v_reg_status text;
  v_pay_cents bigint;
  v_pay_refunded boolean;
  v_refunds jsonb;
  v_scopes jsonb;
begin
  select * into v_e from public.event_competition_entries where id = p_entry_id;
  if not found then
    return null;
  end if;
  select o.payment_status into v_order_status from public.event_orders o where o.id = v_e.order_id;
  select r.payment_status into v_reg_status from public.event_registrations r where r.id = v_e.registration_id;
  select coalesce(sum(round(coalesce(ep.refund_amount, 0) * 100)), 0)::bigint, coalesce(bool_or(ep.status = 'refunded'), false)
    into v_pay_cents, v_pay_refunded
  from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id
  where er.order_id = v_e.order_id or er.id = v_e.registration_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'order_id', r.order_id, 'registration_id', r.registration_id, 'status', r.status, 'source', r.source, 'amount_cents', r.amount_cents,
           'alloc_cents', (select coalesce(sum(a.amount_cents), 0) from public.event_order_refund_allocations a where a.refund_id = r.id),
           'allocations', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'entry_id', a.entry_id, 'line_kind', a.line_kind,
                              'amount_cents', a.amount_cents, 'withdraw_entry', a.withdraw_entry, 'outcome', a.participation_outcome) order by a.id), '[]'::jsonb)
                           from public.event_order_refund_allocations a where a.refund_id = r.id)
         ) order by r.id), '[]'::jsonb)
    into v_refunds
  from public.event_order_refunds r
  where r.order_id = v_e.order_id or (v_e.registration_id is not null and r.registration_id = v_e.registration_id);
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'refund_id', s.refund_id, 'resolution', s.resolution) order by s.id), '[]'::jsonb)
    into v_scopes
  from public.event_competition_refund_exception_scopes s where s.entry_id = p_entry_id;
  return jsonb_build_object(
    'entry_id', p_entry_id, 'order_id', v_e.order_id, 'registration_id', v_e.registration_id,
    'order_payment_status', v_order_status, 'registration_payment_status', v_reg_status,
    'payments_refund_cents', v_pay_cents, 'payments_marked_refunded', v_pay_refunded,
    'refunds', v_refunds, 'scopes', v_scopes);
end;
$$;
revoke all on function public._cf1_rb3_snapshot(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. Raw classification (no reconciliation applied): reason + whether the case is reconciliation-releasable
-- ---------------------------------------------------------------------------------------------------------------------------------
create function public._cf1_rb3_raw(p_entry_id uuid, out reason text, out releasable boolean)
returns record
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_blocked boolean;
  v_recorded boolean;
  v_pending boolean;
  v_wd_unresolved boolean;
  v_entry_alloc boolean;
  v_part_succ boolean;
  v_part_pend boolean;
  v_over boolean;
  v_hidden boolean;
  v_other_open boolean;
  v_e public.event_competition_entries;
  v_order_status text;
  v_ledger_cents bigint;
  v_pay_cents bigint;
  v_pay_refunded boolean;
begin
  reason := null;
  releasable := false;
  if p_entry_id is null or public._cf1_refund_evidence_mode() <> 'r2_ledger' then
    return;
  end if;

  -- (RB3) allocations that name the entry; failed / canceled refunds do not count.
  select coalesce(bool_or(r.status = 'succeeded' and not x.resolved
                          and a.withdraw_entry and (a.participation_outcome is null or a.participation_outcome = 'exception_open')), false),
         coalesce(bool_or(r.status = 'succeeded' and not x.resolved
                          and not (a.withdraw_entry and (a.participation_outcome is null or a.participation_outcome = 'exception_open'))), false),
         coalesce(bool_or(r.status in ('requested', 'pending', 'requires_action')), false),
         coalesce(bool_or(r.status = 'succeeded' and not x.resolved and a.withdraw_entry), false),
         count(*) > 0
    into v_blocked, v_recorded, v_pending, v_wd_unresolved, v_entry_alloc
  from public.event_order_refund_allocations a
  join public.event_order_refunds r on r.id = a.refund_id
  cross join lateral (
    select exists (select 1 from public.event_competition_refund_exception_scopes s
                   where s.entry_id = a.entry_id and s.refund_id = a.refund_id
                     and s.kind in ('competition_refund_entry_locked_heat', 'competition_refund_entry_certified_heat'))
           and not exists (select 1 from public.event_competition_refund_exception_scopes s
                           where s.entry_id = a.entry_id and s.refund_id = a.refund_id
                             and s.kind in ('competition_refund_entry_locked_heat', 'competition_refund_entry_certified_heat')
                             and (s.resolution is null or s.resolution not in ('keep_entry', 'result_stands', 'k0_correction'))) as resolved
  ) x
  where a.entry_id = p_entry_id and a.line_kind = 'entry'
    and r.status in ('requested', 'pending', 'requires_action', 'succeeded');

  select * into v_e from public.event_competition_entries where id = p_entry_id;
  select o.payment_status into v_order_status from public.event_orders o where o.id = v_e.order_id;

  -- (RB3R) refunds of the entry's order or registration, attribution totals, over-attribution
  select coalesce(bool_or(q.status = 'succeeded' and q.alloc < q.amount_cents), false) and v_order_status is distinct from 'refunded',
         coalesce(bool_or(q.status in ('requested', 'pending', 'requires_action') and q.alloc < q.amount_cents), false),
         coalesce(bool_or(q.status in ('requested', 'pending', 'requires_action', 'succeeded') and q.alloc > q.amount_cents), false),
         coalesce(sum(q.amount_cents) filter (where q.status = 'succeeded'), 0)
    into v_part_succ, v_part_pend, v_over, v_ledger_cents
  from (
    select r.status, r.amount_cents,
           (select coalesce(sum(a.amount_cents), 0) from public.event_order_refund_allocations a where a.refund_id = r.id) as alloc
    from public.event_order_refunds r
    where r.order_id = v_e.order_id or (v_e.registration_id is not null and r.registration_id = v_e.registration_id)
  ) q;

  -- (RB3R) refund money recorded outside the ledger
  select coalesce(sum(round(coalesce(ep.refund_amount, 0) * 100)), 0)::bigint, coalesce(bool_or(ep.status = 'refunded'), false)
    into v_pay_cents, v_pay_refunded
  from public.event_payments ep join public.event_registrations er on er.id = ep.registration_id
  where er.order_id = v_e.order_id or er.id = v_e.registration_id;
  v_hidden := (v_order_status = 'partially_refunded' and v_ledger_cents = 0)
              or v_pay_cents > v_ledger_cents
              or (v_pay_refunded and v_ledger_cents = 0);

  reason := case when v_blocked then 'entry_refund_withdrawal_blocked'
                 when v_recorded then 'entry_refund_recorded'
                 when v_pending or v_part_pend then 'entry_refund_pending'
                 when v_part_succ then 'entry_refund_unattributed_order'
                 when v_over then 'entry_refund_evidence_contradictory'
                 when v_hidden then 'entry_refund_evidence_missing'
                 else null end;
  v_other_open := v_blocked or v_pending or v_part_pend or v_part_succ or v_over or v_hidden or v_wd_unresolved;
  releasable := reason = 'entry_refund_recorded' and v_entry_alloc and not v_other_open;
end;
$$;
revoke all on function public._cf1_rb3_raw(uuid) from public, anon, authenticated, service_role;

-- A cosigned, unrevoked decision whose fingerprint equals the CURRENT evidence fingerprint.
create function public._cf1_rb3_release_valid(p_entry_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_fp text := md5(public._cf1_rb3_snapshot(p_entry_id)::text);
begin
  return exists (
    select 1 from public.competition_cf1_rb3_reconciliations c
    where c.entry_id = p_entry_id and c.kind = 'release_cosigned' and c.evidence_fingerprint = v_fp
      and not exists (select 1 from public.competition_cf1_rb3_reconciliations v
                      where v.entry_id = p_entry_id and v.kind = 'release_revoked' and v.seq > c.seq));
end;
$$;
revoke all on function public._cf1_rb3_release_valid(uuid) from public, anon, authenticated, service_role;

create or replace function public._cf1_entry_refund_evidence_reason(p_entry_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_raw record;
begin
  select * into v_raw from public._cf1_rb3_raw(p_entry_id);
  if v_raw.reason = 'entry_refund_recorded' and v_raw.releasable and public._cf1_rb3_release_valid(p_entry_id) then
    return null;
  end if;
  return v_raw.reason;
end;
$$;
revoke all on function public._cf1_entry_refund_evidence_reason(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. Actions
-- ---------------------------------------------------------------------------------------------------------------------------------
create function public._cf1_rb3r_result(p_row public.competition_cf1_rb3_reconciliations, p_replayed boolean)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object('decision_id', p_row.id, 'kind', p_row.kind, 'entry_id', p_row.entry_id, 'order_id', p_row.order_id,
                            'refund_ids', to_jsonb(p_row.refund_ids), 'evidence_fingerprint', p_row.evidence_fingerprint, 'replayed', p_replayed);
$$;
revoke all on function public._cf1_rb3r_result(public.competition_cf1_rb3_reconciliations, boolean) from public, anon, authenticated, service_role;

-- shared guard: authenticated manager of the entry's event, verified email; returns the entry
create function public._cf1_rb3r_guard(p_entry_id uuid, p_request_id uuid, p_reason text, p_need_reason boolean)
returns public.event_competition_entries
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_e public.event_competition_entries;
begin
  if v_uid is null or p_entry_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_e from public.event_competition_entries where id = p_entry_id;
  if not found or not public._cf1_a6_can_manage(v_uid, v_e.event_id) then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required for refund-evidence reconciliation.' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'COMP_REQUEST_ID_REQUIRED: a request id is required.' using errcode = 'P0001';
  end if;
  if p_need_reason and (p_reason is null or length(btrim(p_reason)) < 20 or length(p_reason) > 1000) then
    raise exception 'CF1_RB3_REASON_REQUIRED: a written reason of at least 20 characters is required.' using errcode = 'P0001';
  end if;
  if v_e.order_id is null then
    raise exception 'CF1_RB3_NO_ORDER: the entry has no order; there is no refund evidence to reconcile.' using errcode = 'P0001';
  end if;
  return v_e;
end;
$$;
revoke all on function public._cf1_rb3r_guard(uuid, uuid, text, boolean) from public, anon, authenticated, service_role;

create function public.request_cf1_refund_evidence_release(p_entry_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_e public.event_competition_entries;
  v_prev public.competition_cf1_rb3_reconciliations;
  v_raw record;
  v_snap jsonb;
  v_row public.competition_cf1_rb3_reconciliations;
  v_con text;
begin
  v_e := public._cf1_rb3r_guard(p_entry_id, p_request_id, p_reason, true);
  perform pg_advisory_xact_lock(hashtextextended('cf1_rb3r:' || p_entry_id::text, 0));
  select * into v_prev from public.competition_cf1_rb3_reconciliations where request_id = p_request_id;
  if found then
    if v_prev.kind = 'release_requested' and v_prev.entry_id = p_entry_id and v_prev.actor = v_uid then
      return public._cf1_rb3r_result(v_prev, true);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;
  select * into v_raw from public._cf1_rb3_raw(p_entry_id);
  if v_raw.reason is null then
    raise exception 'CF1_RB3_NOTHING_TO_RELEASE: the entry has no refund-evidence unavailability.' using errcode = 'P0001';
  end if;
  if not v_raw.releasable then
    raise exception 'CF1_RB3_NOT_RELEASABLE: % cannot be released by reconciliation (a ledger path or an owner decision is required).', v_raw.reason using errcode = 'P0001';
  end if;
  if public._cf1_rb3_release_valid(p_entry_id) then
    raise exception 'CF1_RB3_ALREADY_RELEASED: a co-signed release already covers the current evidence.' using errcode = 'P0001';
  end if;
  v_snap := public._cf1_rb3_snapshot(p_entry_id);
  begin
    insert into public.competition_cf1_rb3_reconciliations
      (event_id, entry_id, order_id, kind, request_id, actor, actor_role, reason, basis_reason, refund_ids, evidence, evidence_fingerprint)
    values (v_e.event_id, v_e.id, v_e.order_id, 'release_requested', p_request_id, v_uid, 'manager', btrim(p_reason), v_raw.reason,
            coalesce((select array_agg((x ->> 'id')::uuid order by x ->> 'id') from jsonb_array_elements(v_snap -> 'refunds') x), '{}'::uuid[]),
            v_snap, md5(v_snap::text))
    returning * into v_row;
  exception when unique_violation then
    get stacked diagnostics v_con = constraint_name;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end;
  return public._cf1_rb3r_result(v_row, false);
end;
$$;

create function public.cosign_cf1_refund_evidence_release(p_decision_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_dec public.competition_cf1_rb3_reconciliations;
  v_prev public.competition_cf1_rb3_reconciliations;
  v_raw record;
  v_snap jsonb;
  v_row public.competition_cf1_rb3_reconciliations;
begin
  if v_uid is null or p_decision_id is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_dec from public.competition_cf1_rb3_reconciliations where id = p_decision_id;
  if not found then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  perform public._cf1_rb3r_guard(v_dec.entry_id, p_request_id, null, false);
  perform pg_advisory_xact_lock(hashtextextended('cf1_rb3r:' || v_dec.entry_id::text, 0));
  select * into v_prev from public.competition_cf1_rb3_reconciliations where request_id = p_request_id;
  if found then
    if v_prev.kind = 'release_cosigned' and v_prev.decision_id = p_decision_id and v_prev.actor = v_uid then
      return public._cf1_rb3r_result(v_prev, true);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;
  if v_dec.kind <> 'release_requested' then
    raise exception 'CF1_RB3_DECISION_KIND: this is not a release request.' using errcode = 'P0001';
  end if;
  if v_dec.actor = v_uid then
    raise exception 'CF1_RB3_COSIGN_SAME_PERSON: the co-signer must be a different person from the requester.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.competition_cf1_rb3_reconciliations x where x.decision_id = p_decision_id and x.kind = 'release_cosigned') then
    raise exception 'CF1_RB3_DECISION_COMPLETED: this request has already been co-signed.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.competition_cf1_rb3_reconciliations x where x.entry_id = v_dec.entry_id and x.seq > v_dec.seq and x.kind = 'release_requested') then
    raise exception 'CF1_RB3_REQUEST_STALE: a later release request exists for this entry; request again.' using errcode = 'P0001';
  end if;
  select * into v_raw from public._cf1_rb3_raw(v_dec.entry_id);
  if v_raw.reason is distinct from 'entry_refund_recorded' or not v_raw.releasable then
    raise exception 'CF1_RB3_NOT_RELEASABLE: the evidence is no longer releasable (now %).', coalesce(v_raw.reason, 'clear') using errcode = 'P0001';
  end if;
  v_snap := public._cf1_rb3_snapshot(v_dec.entry_id);
  if md5(v_snap::text) <> v_dec.evidence_fingerprint then
    raise exception 'CF1_RB3_EVIDENCE_CHANGED: the refund evidence changed since the request; request again.' using errcode = 'P0001';
  end if;
  begin
    insert into public.competition_cf1_rb3_reconciliations
      (event_id, entry_id, order_id, kind, decision_id, request_id, actor, actor_role, reason, basis_reason, refund_ids, evidence, evidence_fingerprint)
    values (v_dec.event_id, v_dec.entry_id, v_dec.order_id, 'release_cosigned', v_dec.id, p_request_id, v_uid, 'manager', v_dec.reason, v_dec.basis_reason,
            v_dec.refund_ids, v_snap, v_dec.evidence_fingerprint)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end;
  return public._cf1_rb3r_result(v_row, false);
end;
$$;

create function public.revoke_cf1_refund_evidence_release(p_entry_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_e public.event_competition_entries;
  v_prev public.competition_cf1_rb3_reconciliations;
  v_cos public.competition_cf1_rb3_reconciliations;
  v_row public.competition_cf1_rb3_reconciliations;
begin
  v_e := public._cf1_rb3r_guard(p_entry_id, p_request_id, p_reason, true);
  perform pg_advisory_xact_lock(hashtextextended('cf1_rb3r:' || p_entry_id::text, 0));
  select * into v_prev from public.competition_cf1_rb3_reconciliations where request_id = p_request_id;
  if found then
    if v_prev.kind = 'release_revoked' and v_prev.entry_id = p_entry_id and v_prev.actor = v_uid then
      return public._cf1_rb3r_result(v_prev, true);
    end if;
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end if;
  select * into v_cos from public.competition_cf1_rb3_reconciliations c
   where c.entry_id = p_entry_id and c.kind = 'release_cosigned'
     and not exists (select 1 from public.competition_cf1_rb3_reconciliations v where v.entry_id = p_entry_id and v.kind = 'release_revoked' and v.seq > c.seq)
   order by c.seq desc limit 1;
  if not found then
    raise exception 'CF1_RB3_NOTHING_TO_REVOKE: the entry has no active co-signed release.' using errcode = 'P0001';
  end if;
  begin
    insert into public.competition_cf1_rb3_reconciliations
      (event_id, entry_id, order_id, kind, decision_id, request_id, actor, actor_role, reason, basis_reason, refund_ids, evidence, evidence_fingerprint)
    values (v_e.event_id, v_e.id, v_e.order_id, 'release_revoked', v_cos.id, p_request_id, v_uid, 'manager', btrim(p_reason), v_cos.basis_reason,
            v_cos.refund_ids, v_cos.evidence, v_cos.evidence_fingerprint)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'COMP_REQUEST_REUSED: request id was already used for a different request.' using errcode = 'P0001';
  end;
  return public._cf1_rb3r_result(v_row, false);
end;
$$;

-- Read: the effective and raw state for managers (evidence, decisions). Reads only.
create function public.cf1_refund_evidence_state(p_entry_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_e public.event_competition_entries;
  v_raw record;
begin
  if v_uid is null then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  select * into v_e from public.event_competition_entries where id = p_entry_id;
  if not found or not public._cf1_a6_can_manage(v_uid, v_e.event_id) then
    raise exception 'COMP_FORBIDDEN: not allowed.' using errcode = '42501';
  end if;
  if public.verified_email_for_user(v_uid) is null then
    raise exception 'COMP_VERIFIED_EMAIL_REQUIRED: a verified email credential is required to read refund evidence.' using errcode = '42501';
  end if;
  select * into v_raw from public._cf1_rb3_raw(p_entry_id);
  return jsonb_build_object(
    'entry_id', p_entry_id,
    'effective_reason', public._cf1_entry_refund_evidence_reason(p_entry_id),
    'raw_reason', v_raw.reason, 'releasable', v_raw.releasable,
    'evidence', public._cf1_rb3_snapshot(p_entry_id),
    'decisions', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'decision_id', c.decision_id, 'actor', c.actor,
                                     'reason', c.reason, 'fingerprint', c.evidence_fingerprint, 'created_at', c.created_at) order by c.seq)
                           from public.competition_cf1_rb3_reconciliations c where c.entry_id = p_entry_id), '[]'::jsonb));
end;
$$;

revoke all on function public.request_cf1_refund_evidence_release(uuid, text, uuid) from public, anon, service_role;
revoke all on function public.cosign_cf1_refund_evidence_release(uuid, uuid) from public, anon, service_role;
revoke all on function public.revoke_cf1_refund_evidence_release(uuid, text, uuid) from public, anon, service_role;
revoke all on function public.cf1_refund_evidence_state(uuid) from public, anon, service_role;
grant execute on function public.request_cf1_refund_evidence_release(uuid, text, uuid) to authenticated;
grant execute on function public.cosign_cf1_refund_evidence_release(uuid, uuid) to authenticated;
grant execute on function public.revoke_cf1_refund_evidence_release(uuid, text, uuid) to authenticated;
grant execute on function public.cf1_refund_evidence_state(uuid) to authenticated;
revoke all on function public._cf1_rb3r_protect() from public, anon, authenticated, service_role;

-- Postflight: the redefined predicate must still run for the migration user and report nothing for a random entry.
do $$
declare
  v_mode text := public._cf1_refund_evidence_mode();
begin
  if (select pg_get_userbyid(proowner) from pg_proc where oid = 'public._cf1_entry_refund_evidence_reason(uuid)'::regprocedure) <> current_user
     or (select pg_get_userbyid(proowner) from pg_proc where oid = 'public._cf1_rb3_raw(uuid)'::regprocedure) <> current_user then
    raise exception 'CF1-RB3R postflight: the evidence functions are not owned by the migration user (%).', current_user;
  end if;
  if has_function_privilege('anon', 'public._cf1_entry_refund_evidence_reason(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._cf1_rb3_raw(uuid)', 'execute')
     or has_function_privilege('anon', 'public.request_cf1_refund_evidence_release(uuid,text,uuid)', 'execute') then
    raise exception 'CF1-RB3R postflight: unexpected function privileges.';
  end if;
  if public._cf1_entry_refund_evidence_reason(gen_random_uuid()) is not null
     or public._cf1_entry_unavailable_reason(gen_random_uuid()) is distinct from 'entry_missing' then
    raise exception 'CF1-RB3R postflight: the predicate reports a reason for a random entry.';
  end if;
  if v_mode = 'r2_ledger' and (select reason from public._cf1_rb3_raw(gen_random_uuid())) is not null then
    raise exception 'CF1-RB3R postflight: the raw classifier reports a reason for a random entry.';
  end if;
end $$;

commit;

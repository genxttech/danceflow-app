-- Competition CF1 RB3: per-entry refund evidence for predicate P (release blocker RB3).
--
-- Design: docs/competition/callback-to-final-advancement-design.md 4.6 (predicate P) and A.9.6 RB3. Depends on, but does not contain,
-- R2 (PR 292, migration 20270103090000: event_order_refunds, event_order_refund_allocations, event_competition_refund_exception_scopes).
--
-- What changes: ONE function is redefined (_cf1_entry_unavailable_reason, same signature, same result for every A1 case) and new helpers
-- are added. P gains a last clause (iii-c) that reads ONLY verified R2 ledger facts and FAILS CLOSED. An entry is UNAVAILABLE when:
--   entry_refund_withdrawal_blocked    a SUCCEEDED refund allocation names it, staff asked for the withdrawal and it was blocked
--                                      (outcome exception_open, or not yet applied) and no audited scope resolution keeps the entry
--   entry_refund_recorded              any other SUCCEEDED refund allocation names it (G2 withdraw_entry = false, G3 partial amount, a
--                                      withdrawal outcome on a still-confirmed entry, ...) and no audited scope resolution keeps the entry
--   entry_refund_pending               a refund in requested / pending / requires_action names it (G4), OR an unattributed
--                                      stripe_dashboard refund in pending / requires_action exists on the entry's order
--   entry_refund_unattributed_order    a SUCCEEDED stripe_dashboard refund on the entry's order has no allocation at all (G5: R2's
--                                      competition_refund_unattributed exception, the entry cannot be guessed) while the order is not
--                                      fully refunded; it clears when staff attribute the refund (attribute_competition_refund)
-- "Audited resolution" = R2 event_competition_refund_exception_scopes rows for (entry, refund) of the locked/certified-heat kinds that
-- are ALL resolved with keep_entry, result_stands or k0_correction (withdrawn_after_unlock withdraws the entry, so status already
-- makes it unavailable). A refund that Stripe later reports failed / canceled (reversed) stops counting. No new policy and no new
-- resolution kind: R2 has no resolution that releases an entry after a refund with withdraw_entry = false, a partial refund or a
-- pending refund; those entries stay unavailable until R2 provides that path (owner decision, see the RB3 report).
--
-- R2 is NOT required to apply this migration. While R2's ledger does not exist the new clause returns null and P is byte-for-byte the
-- A1 behaviour. _cf1_refund_evidence_mode() returns 'absent' (none of the three R2 tables), 'r2_ledger' (all three tables with every
-- column used here) or 'r2_shape_mismatch' (anything else: the clause then also returns null, which is a false negative, so the gate
-- below refuses). _cf1_od17_refund_gate() is the release gate: it raises while the mode is not 'r2_ledger' unless an explicit audited
-- owner override row exists for that mode. This migration does NOT wire the gate into A1/A2/A3 (see the hook note near the end).
--
-- The R2 tables are read with STATIC SQL inside a plpgsql body: plpgsql resolves relations at first execution, so the migration applies
-- without R2 and the mode guard keeps the absent / mismatch modes from ever reaching the statements. No string building, no dependency
-- on the R2 tables (R2 can be rolled back without touching this file), and the postflight below exercises the statements when R2 exists.
--
-- Apply order: slot 20270120102000, after A7 (20270120095500). SQL before app. Rollback restores the A1 body exactly.
-- No grants to anon, authenticated or service_role.

begin;

do $$
begin
  if to_regprocedure('public._cf1_entry_unavailable_reason(uuid)') is null then
    raise exception 'CF1-RB3 preflight: CF1 A1 (20270120085000) is missing.';
  end if;
  if to_regprocedure('public._cf1_entry_refund_evidence_reason(uuid)') is not null
     or to_regprocedure('public._cf1_refund_evidence_mode()') is not null
     or to_regprocedure('public._cf1_od17_refund_gate()') is not null then
    raise exception 'CF1-RB3 preflight: an RB3 function already exists.';
  end if;
  if to_regclass('public.competition_cf1_rb3_gate_overrides') is not null then
    raise exception 'CF1-RB3 preflight: competition_cf1_rb3_gate_overrides already exists.';
  end if;
  -- R2 present only partly is a broken chain, not "absent".
  if (to_regclass('public.event_order_refund_allocations') is null) <> (to_regclass('public.event_order_refunds') is null)
     or (to_regclass('public.event_order_refund_allocations') is null) <> (to_regclass('public.event_competition_refund_exception_scopes') is null) then
    raise exception 'CF1-RB3 preflight: the R2 refund ledger is only partly present.';
  end if;
end $$;

-- pg_attribute (not information_schema): information_schema.columns hides columns the CALLER cannot read, which would report a false mismatch.
create function public._cf1_refund_evidence_mode()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with req(t, c) as (values
    ('event_order_refunds', 'id'), ('event_order_refunds', 'order_id'), ('event_order_refunds', 'status'), ('event_order_refunds', 'source'),
    ('event_order_refund_allocations', 'refund_id'), ('event_order_refund_allocations', 'order_id'), ('event_order_refund_allocations', 'entry_id'),
    ('event_order_refund_allocations', 'line_kind'), ('event_order_refund_allocations', 'withdraw_entry'), ('event_order_refund_allocations', 'participation_outcome'),
    ('event_competition_refund_exception_scopes', 'entry_id'), ('event_competition_refund_exception_scopes', 'refund_id'),
    ('event_competition_refund_exception_scopes', 'kind'), ('event_competition_refund_exception_scopes', 'resolution')
  ), s as (
    select
      (select count(*) from unnest(array['event_order_refunds', 'event_order_refund_allocations', 'event_competition_refund_exception_scopes']) x(t)
        where to_regclass('public.' || x.t) is not null) as tables_present,
      (select count(*) from req) as cols_needed,
      (select count(*) from req join pg_attribute a on a.attrelid = to_regclass('public.' || req.t) and a.attname = req.c and a.attnum > 0 and not a.attisdropped) as cols_present
  )
  select case when tables_present = 0 then 'absent'
              when tables_present = 3 and cols_present = cols_needed then 'r2_ledger'
              else 'r2_shape_mismatch' end
  from s;
$$;
revoke all on function public._cf1_refund_evidence_mode() from public, anon, authenticated, service_role;

create function public._cf1_entry_refund_evidence_reason(p_entry_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_blocked boolean;
  v_recorded boolean;
  v_pending boolean;
  v_unattr_succeeded boolean;
  v_unattr_pending boolean;
begin
  if p_entry_id is null or public._cf1_refund_evidence_mode() <> 'r2_ledger' then
    return null;
  end if;

  -- Allocations that name the entry. failed / canceled refunds (including a succeeded refund Stripe later reversed) do not count.
  select coalesce(bool_or(r.status = 'succeeded' and not x.resolved
                          and a.withdraw_entry and (a.participation_outcome is null or a.participation_outcome = 'exception_open')), false),
         coalesce(bool_or(r.status = 'succeeded' and not x.resolved
                          and not (a.withdraw_entry and (a.participation_outcome is null or a.participation_outcome = 'exception_open'))), false),
         coalesce(bool_or(r.status in ('requested', 'pending', 'requires_action')), false)
    into v_blocked, v_recorded, v_pending
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

  -- Dashboard (externally initiated) refunds on the entry's order that have no allocation at all: R2 cannot say which entry they concern.
  select coalesce(bool_or(r.status = 'succeeded'), false),
         coalesce(bool_or(r.status in ('pending', 'requires_action')), false)
    into v_unattr_succeeded, v_unattr_pending
  from public.event_competition_entries e
  join public.event_orders o on o.id = e.order_id
  join public.event_order_refunds r on r.order_id = o.id
  where e.id = p_entry_id
    and o.payment_status is distinct from 'refunded'
    and r.source = 'stripe_dashboard'
    and r.status in ('succeeded', 'pending', 'requires_action')
    and not exists (select 1 from public.event_order_refund_allocations a2 where a2.refund_id = r.id);

  return case when v_blocked then 'entry_refund_withdrawal_blocked'
              when v_recorded then 'entry_refund_recorded'
              when v_pending or v_unattr_pending then 'entry_refund_pending'
              when v_unattr_succeeded then 'entry_refund_unattributed_order'
              else null end;
end;
$$;
revoke all on function public._cf1_entry_refund_evidence_reason(uuid) from public, anon, authenticated, service_role;

-- Same body as A1 plus the last CASE arm.
create or replace function public._cf1_entry_unavailable_reason(p_entry_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when e.id is null then 'entry_missing'
    when e.status is distinct from 'confirmed' then 'entry_not_confirmed'
    when e.eligibility_status = 'ineligible' then 'entry_ineligible'
    when r.status = 'cancelled' then 'registration_cancelled'
    when r.status = 'refunded' then 'registration_refunded'
    when r.payment_status = 'failed' then 'registration_payment_failed'
    when r.payment_status = 'refunded' then 'registration_payment_refunded'
    when o.payment_status = 'failed' then 'order_payment_failed'
    when o.payment_status = 'refunded' then 'order_payment_refunded'
    else public._cf1_entry_refund_evidence_reason(e.id)
  end
  from (select 1) one
  left join public.event_competition_entries e on e.id = p_entry_id
  left join public.event_registrations r on r.id = e.registration_id
  left join public.event_orders o on o.id = e.order_id;
$$;
revoke all on function public._cf1_entry_unavailable_reason(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Release gate for OD-17 D (RB3). Explicit, audited, owner-accepted override rows; append-only (a row can only be revoked once).
-- ---------------------------------------------------------------------------------------------------------------------------------
create table public.competition_cf1_rb3_gate_overrides (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('absent', 'r2_shape_mismatch')),
  accepted_by text not null check (btrim(accepted_by) <> ''),
  note text not null check (length(btrim(note)) >= 20),
  accepted_at timestamptz not null default now(),
  revoked_at timestamptz null,
  revoked_by text null,
  constraint competition_cf1_rb3_gate_overrides_revoke check ((revoked_at is null) = (revoked_by is null))
);
comment on table public.competition_cf1_rb3_gate_overrides is
  'CF1 RB3: owner acceptance of the refund-evidence false negative (R2 ledger absent / shape mismatch) so _cf1_od17_refund_gate() passes. Append-only; revoke once.';
alter table public.competition_cf1_rb3_gate_overrides enable row level security;
revoke all on public.competition_cf1_rb3_gate_overrides from public, anon, authenticated, service_role;

create function public._cf1_rb3_protect_gate_overrides()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and old.revoked_at is null and new.revoked_at is not null
     and (to_jsonb(new) - array['revoked_at', 'revoked_by']) = (to_jsonb(old) - array['revoked_at', 'revoked_by']) then
    return new;
  end if;
  raise exception 'CF1-RB3: gate override rows are append-only (a row can only be revoked once).' using errcode = '42501';
end;
$$;
create trigger cf1_rb3_gate_overrides_protect before update or delete on public.competition_cf1_rb3_gate_overrides
  for each row execute function public._cf1_rb3_protect_gate_overrides();
create trigger cf1_rb3_gate_overrides_no_truncate before truncate on public.competition_cf1_rb3_gate_overrides
  for each statement execute function public._cf1_rb3_protect_gate_overrides();
alter table public.competition_cf1_rb3_gate_overrides enable always trigger cf1_rb3_gate_overrides_protect;
alter table public.competition_cf1_rb3_gate_overrides enable always trigger cf1_rb3_gate_overrides_no_truncate;

create function public._cf1_rb3_record_gate_override(p_mode text, p_accepted_by text, p_note text)
returns uuid
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into public.competition_cf1_rb3_gate_overrides (mode, accepted_by, note) values (p_mode, p_accepted_by, p_note) returning id;
$$;
revoke all on function public._cf1_rb3_record_gate_override(text, text, text) from public, anon, authenticated, service_role;

create function public._cf1_rb3_revoke_gate_override(p_id uuid, p_revoked_by text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  update public.competition_cf1_rb3_gate_overrides set revoked_at = now(), revoked_by = p_revoked_by where id = p_id and revoked_at is null;
  return found;
end;
$$;
revoke all on function public._cf1_rb3_revoke_gate_override(uuid, text) from public, anon, authenticated, service_role;

-- Returns the passing state ('r2_ledger' or 'override:<mode>') or raises CF1_RB3_REFUND_EVIDENCE_GATE.
-- r2_ledger additionally exercises the evidence query with a random uuid, so a broken shape / privilege refuses instead of failing open.
create function public._cf1_od17_refund_gate()
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text := public._cf1_refund_evidence_mode();
begin
  if v_mode = 'r2_ledger' then
    begin
      perform public._cf1_entry_refund_evidence_reason(gen_random_uuid());
    exception when others then
      raise exception 'CF1_RB3_REFUND_EVIDENCE_GATE: the R2 refund evidence query failed (%): predicate P would silently miss refunds.', sqlerrm
        using errcode = 'P0001';
    end;
    return 'r2_ledger';
  end if;
  if exists (select 1 from public.competition_cf1_rb3_gate_overrides o where o.mode = v_mode and o.revoked_at is null) then
    return 'override:' || v_mode;
  end if;
  raise exception 'CF1_RB3_REFUND_EVIDENCE_GATE: refund-evidence mode is % (R2 ledger not usable): predicate P cannot see per-entry refunds. Apply R2 or record an owner override.', v_mode
    using errcode = 'P0001';
end;
$$;
revoke all on function public._cf1_od17_refund_gate() from public, anon, authenticated, service_role;

-- Hook note (not wired here on purpose): A3 (20270120093000) has no switch, applying it IS the OD-17 enablement, and the single runtime choke
-- point is A1's _cf1_require_roster_eligible(round, stage). Wiring `perform public._cf1_od17_refund_gate();` as its first statement after the
-- stage check would make every ballot lock / calculate / approve on an R2-absent database fail, i.e. change A1 behaviour in R2-absent mode, and
-- rewrites an A1-owned function. Until then the release runbook MUST run `select public._cf1_od17_refund_gate();` on the target database
-- after this migration and before the app release; the call raises while R2 is not usable and no override exists.

-- Postflight (mode r2_ledger only): the new clause must run for the function owner, which is the migration's own user.
do $$
declare
  v_mode text := public._cf1_refund_evidence_mode();
  v_t text;
begin
  if v_mode = 'r2_shape_mismatch' then
    raise exception 'CF1-RB3 postflight: the R2 refund ledger is present but its shape does not match what predicate P reads.';
  end if;
  if v_mode = 'absent' then
    raise notice 'CF1-RB3 postflight: R2 ledger absent; predicate P is the A1 behaviour until R2 is applied. Run _cf1_od17_refund_gate() before OD-17 D is enabled.';
    return;
  end if;
  if (select pg_get_userbyid(proowner) from pg_proc where oid = 'public._cf1_entry_unavailable_reason(uuid)'::regprocedure) <> current_user
     or (select pg_get_userbyid(proowner) from pg_proc where oid = 'public._cf1_entry_refund_evidence_reason(uuid)'::regprocedure) <> current_user then
    raise exception 'CF1-RB3 postflight: the predicate functions are not owned by the migration user (%).', current_user;
  end if;
  foreach v_t in array array['event_order_refunds', 'event_order_refund_allocations', 'event_competition_refund_exception_scopes'] loop
    if not has_table_privilege(current_user, 'public.' || v_t, 'select') then
      raise exception 'CF1-RB3 postflight: % cannot select public.%.', current_user, v_t;
    end if;
  end loop;
  if public._cf1_entry_refund_evidence_reason(gen_random_uuid()) is not null then
    raise exception 'CF1-RB3 postflight: the evidence query returned a reason for a random entry.';
  end if;
  if public._cf1_entry_unavailable_reason(gen_random_uuid()) is distinct from 'entry_missing' then
    raise exception 'CF1-RB3 postflight: the unavailable-reason function does not report entry_missing for a random entry.';
  end if;
end $$;

commit;

-- 20270221090100_twilio_dispute_negative_balance_holds.sql
-- TW-4F financial safety (slice B): Stripe dispute hold, dispute alert, an UNALLOCATED estimated-provider-dispute-fee record, and the negative-available-credit alert.
-- (Reserved slot 20270221090000; that exact version is already taken on main by 20270221090000_event_registration_claim_function.sql, so this file uses 090100.)
--
-- PROBLEM. tw4_credit_apply_dispute (20261125090000) takes disputed credit back and may push the balance negative with no hold, no administrator alert and no record
-- of Stripe's dispute fee. Negative balances in general (dispute, absorbed inbound down to its ceiling, usage settlement) raised no alert either.
--
-- WHAT THIS FILE DOES
--  1. Every NEW dispute withdrawal (tw4_credit_apply_dispute, action 'withdrawn', including one capped to nothing left because the payment was already refunded)
--     writes ONE row in studio_sms_credit_dispute_holds, one 'credit_hold' audit row, and ONE administrator alert (kind 'credit_dispute', deduped per dispute row).
--     The row records Stripe's dispute fee as an ESTIMATED PROVIDER FEE with allocation 'unallocated' (est_provider_fee_cents, an estimate of Stripe's standard fee:
--     _tw4dh_est_provider_fee_cents(); fee_allocation = 'unallocated'). WHO BEARS IT IS NOT DECIDED (an owner decision); nothing here allocates it. That fee is
--     NEVER posted to the ledger, never debited from a studio balance, never an adjustment, never charged to the studio, never a price and never shown to a studio. Replays and redeliveries (same dispute id, any event id)
--     add nothing: the existing function returns 'replayed' before this code runs, and the row and the alert are unique per dispute row besides.
--  0. DARK: TWO database switches, both default OFF (no row = OFF), platform administrator only with a written reason, append-only log:
--     tw4_dispute_record_switch_set ('record') gates EVERYTHING this file adds that runs on its own: the dispute-hold row / audit / alert (1) and the negative-credit trigger (5).
--     With it OFF a dispute and a negative balance behave exactly as before this file, and nothing is written, so the rollback stays possible.
--     tw4_dispute_hold_switch_set ('hold') gates the account hold (2) and needs 'record' ON. Once 'record' has been ON and has produced a row or an alert, this migration is
--     FORWARD-ONLY (the rollback refuses to delete that evidence).
--  2. The automatic HOLD is placed only while the 'hold' switch is ON. With 'record' ON and 'hold' OFF the row is
--     recorded as 'not_held' and the alert says no hold was placed: the money paths behave exactly as before. With the switch on the business's credit account is
--     put on hold (the EXISTING hold: studio_sms_credit_accounts.hold, reason 'dispute'), so it blocks exactly what the existing hold blocks (every fee-bearing
--     reservation, checkout and top-up, recurring charges, and chargeable outbound texts through _tw4c_require_funds) and nothing else: STOP/START/HELP handling,
--     inbound recording (tw4_inbound_record), compliance and error replies (tw4_inbound_reply_allowed) never read the hold and are untouched by this file.
--     A hold that already existed (a manual one) is left as it is; its reason is not overwritten, and the alert says the account was already on hold.
--  3. A dispute decided in the studio's favour (action 'reinstated') raises ONE informational 'credit_dispute' alert when its hold is still in place. The hold is NOT
--     released automatically: an administrator releases it (step 4) after review.
--  4. tw4_credit_dispute_hold_release: platform administrator, written note (10-500 characters), the business must match the hold (a wrong business is refused),
--     idempotent (a released hold returns replayed), audited. The account hold is cleared only when no other dispute hold of the business is still held AND the
--     account's hold reason is still 'dispute' (a manual hold placed meanwhile stays). tw4_credit_set_hold now refuses to CLEAR a hold while a dispute hold is held
--     (release each one with its note instead) and reserves the reason 'dispute' for the automatic hold; otherwise it is unchanged.
--  5. Any transition of a business's AVAILABLE credit (settled balance minus open reservations) from zero or more to below zero raises ONE administrator alert
--     (kind 'credit_negative'), whatever caused it, deduped per transition (the ledger sequence that caused it); recovering and dipping again alerts again. It is a
--     notification only: it places NO hold (a negative balance already blocks new spending through _tw4c_require_funds and the setup / recurring checks). Only while 'record' is ON.
--     The trigger can never fail the statement that moved the balance (an inbound STOP/START/HELP debit included): its work runs in a sub-transaction that turns any error into a warning.
-- Alerts use the existing outbox (studio_sms_provider_alerts via _tw4rfl_alert), the existing delivery runner, its kill switch and its escalation. Summaries carry no amounts.
-- No Stripe call, no Twilio call, no new studio fee, no price change. Service role only; tables RLS on with no API-role grants.
-- Requires 20261125090000 (dispute state), 20261211090000 (alert outbox kinds) and 20261231140000 (the current alert-kind list).
-- Precondition: no account is on a manual hold whose reason is 'dispute' (that reason becomes reserved).
-- Rollback: rollback/20270221090100_twilio_dispute_negative_balance_holds_rollback.sql (refuses once any dispute-hold row, switch change or alert of the new kinds exists, or if
-- tw4_credit_apply_dispute / tw4_credit_set_hold is no longer the version this file installs).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
declare
  v_name text;
  v_def text;
  v_vals text[];
begin
  if to_regclass('public.studio_sms_credit_disputes') is null or to_regprocedure('public.tw4_credit_apply_dispute(text,text,integer,text,text)') is null
     or to_regprocedure('public._tw4rfl_alert(uuid,uuid,uuid,text,text,text,text,text)') is null or to_regprocedure('public.tw4_credit_set_hold(uuid,boolean,text,uuid)') is null
     or to_regprocedure('public.tw4_rfl_inbound_allowance_check()') is null then
    raise exception 'dispute hold precondition failed: 20261125090000, 20261211090000 and 20261231140000 are not all applied';
  end if;
  if to_regclass('public.studio_sms_credit_dispute_holds') is not null then
    raise exception 'dispute hold precondition failed: already applied';
  end if;
  -- This file replaces two function bodies wholesale. It applies only over the exact versions it was written against (20261125090000 / 20261122090000; the 20270221090100
  -- bodies are accepted for a re-run), so a later change to either is never silently overwritten. md5 of prosrc with CR removed.
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.tw4_credit_apply_dispute(text,text,integer,text,text)'::regprocedure)
       not in ('e3541ee9ce86e59e3db30503c72da4da', 'df3dcf4a24e3d1b2e50b124c6fcf6c40') then
    raise exception 'dispute hold precondition failed: tw4_credit_apply_dispute is not the 20261125090000 version this file replaces' using errcode = '55000';
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.tw4_credit_set_hold(uuid,boolean,text,uuid)'::regprocedure)
       not in ('07787632259d7dbd237abea79c43c636', '909beeb0074685391d2e2af65749372e') then
    raise exception 'dispute hold precondition failed: tw4_credit_set_hold is not the 20261122090000 version this file replaces' using errcode = '55000';
  end if;
  -- the reason 'dispute' becomes reserved for the automatic hold: a manual hold that already carries it would be mistaken for one (and cleared by a dispute release)
  if exists (select 1 from public.studio_sms_credit_accounts a where a.hold and lower(btrim(coalesce(a.hold_reason, ''))) = 'dispute') then
    raise exception 'dispute hold precondition failed: an account is on a manual hold whose reason is "dispute"; give it another reason with tw4_credit_set_hold first';
  end if;
  select c.conname, pg_get_constraintdef(c.oid) into v_name, v_def from pg_constraint c
   where c.conrelid = 'public.studio_sms_provider_alerts'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%authorization_expiring%';
  if v_def is null or v_name <> 'studio_sms_provider_alerts_kind_check' then
    raise exception 'dispute hold precondition failed: the alert-kind constraint is missing';
  end if;
  select array_agg(distinct m[1] order by m[1]) into v_vals from regexp_matches(substring(v_def from 'ANY (.*)$'), '([a-z][a-z0-9_]*)', 'g') m where m[1] not in ('text', 'array');
  if v_vals is null or cardinality(v_vals) < 18 or not ('inbound_volume_high' = any (v_vals)) then
    raise exception 'could not read the alert kinds from %', v_def;
  end if;
  lock table public.studio_sms_provider_alerts in access exclusive mode;
  v_vals := (select array_agg(distinct x order by x) from unnest(v_vals || array['credit_dispute', 'credit_negative']) x);
  execute format('alter table public.studio_sms_provider_alerts drop constraint %I', v_name);
  execute format('alter table public.studio_sms_provider_alerts add constraint %I check (kind = any (%L::text[]))', v_name, v_vals);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the switch (append-only log; the latest row wins; no row = OFF)
-- ---------------------------------------------------------------------------------------------------------------
create table public.studio_sms_dispute_hold_switch_log (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('record', 'hold')),
  enabled boolean not null,
  changed_by uuid not null,
  reason text not null check (char_length(btrim(reason)) between 10 and 300),
  changed_at timestamptz not null default clock_timestamp(),
  seq bigserial not null
);
create index studio_sms_dispute_hold_switch_log_latest on public.studio_sms_dispute_hold_switch_log (scope, seq desc);

-- one row per recorded dispute withdrawal: the hold decision, the estimated, unallocated provider dispute fee and the release
create table public.studio_sms_credit_dispute_holds (
  id uuid primary key default gen_random_uuid(),
  dispute_row_id uuid not null references public.studio_sms_credit_disputes(id) on delete restrict,
  topup_id uuid not null references public.studio_sms_credit_topups(id) on delete restrict,
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  claim_cents int not null check (claim_cents > 0),
  withdrawn_cents int not null check (withdrawn_cents >= 0),
  est_provider_fee_cents int not null check (est_provider_fee_cents >= 0),   -- an ESTIMATE of Stripe's dispute fee; who bears it is undecided; never charged to the studio, never in the ledger
  fee_basis text not null check (fee_basis in ('stripe_standard_fee_estimate')),
  fee_allocation text not null default 'unallocated' check (fee_allocation in ('unallocated')),   -- allocation is an owner decision; this migration never makes it
  hold_state text not null check (hold_state in ('held', 'not_held', 'released')),
  not_held_reason text null check (not_held_reason is null or not_held_reason in ('auto_hold_switch_off')),
  account_already_held boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  released_by uuid null,
  released_at timestamptz null,
  release_note text null check (release_note is null or char_length(btrim(release_note)) between 10 and 500),
  constraint studio_sms_credit_dispute_holds_one unique (dispute_row_id),
  constraint studio_sms_credit_dispute_holds_not_held check ((hold_state = 'not_held') = (not_held_reason is not null)),
  constraint studio_sms_credit_dispute_holds_released check ((hold_state = 'released') = (released_at is not null and released_by is not null and release_note is not null))
);
create index studio_sms_credit_dispute_holds_held on public.studio_sms_credit_dispute_holds (legal_entity_id) where hold_state = 'held';

revoke all on public.studio_sms_dispute_hold_switch_log, public.studio_sms_credit_dispute_holds from public, anon, authenticated, service_role;
revoke all on sequence public.studio_sms_dispute_hold_switch_log_seq_seq from public, anon, authenticated, service_role;
alter table public.studio_sms_dispute_hold_switch_log enable row level security;
alter table public.studio_sms_credit_dispute_holds enable row level security;

-- the switch log is append-only (the generic credit guard refuses every update / delete of a table it does not special-case)
create trigger studio_sms_dispute_hold_switch_log_guard before update or delete on public.studio_sms_dispute_hold_switch_log for each row execute function public._tw4c_immutable_guard();
create trigger studio_sms_dispute_hold_switch_log_truncate before truncate on public.studio_sms_dispute_hold_switch_log for each statement execute function public._tw4c_truncate_guard();

-- a dispute hold only moves held -> released, once, and only its release fields change; nothing is ever deleted
create function public._tw4dh_guard()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'dispute hold evidence is never deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.dispute_row_id is distinct from old.dispute_row_id or new.topup_id is distinct from old.topup_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.claim_cents is distinct from old.claim_cents or new.withdrawn_cents is distinct from old.withdrawn_cents
     or new.est_provider_fee_cents is distinct from old.est_provider_fee_cents or new.fee_basis is distinct from old.fee_basis or new.fee_allocation is distinct from old.fee_allocation or new.not_held_reason is distinct from old.not_held_reason
     or new.account_already_held is distinct from old.account_already_held or new.created_at is distinct from old.created_at
     or old.hold_state <> 'held' or new.hold_state <> 'released' then
    raise exception 'a dispute hold only moves from held to released, once' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger studio_sms_credit_dispute_holds_guard before update or delete on public.studio_sms_credit_dispute_holds for each row execute function public._tw4dh_guard();
create trigger studio_sms_credit_dispute_holds_truncate before truncate on public.studio_sms_credit_dispute_holds for each statement execute function public._tw4c_truncate_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- constants and the switch
-- ---------------------------------------------------------------------------------------------------------------
-- Stripe's standard dispute RECEIVED fee (US cards), recorded as an ESTIMATE only (allocation: undecided). A separate dispute COUNTERED fee may also apply and is NOT modelled. The actual fee is on Stripe's balance transaction
-- (reconciled by hand, see docs/twilio/TW-4F_Dispute_And_Negative_Balance_Runbook.md). Never charged to anyone by this code.
create function public._tw4dh_est_provider_fee_cents()
returns int language sql immutable
set search_path = pg_catalog, pg_temp
as $$ select 1500 $$;

-- two switches, both OFF until an administrator turns them on (each: latest row of its scope wins; no row = OFF):
--   'record' : the dispute-hold record, its admin alert and the negative-available-credit alert (trigger). OFF = a dispute and a negative balance behave exactly as before this file.
--   'hold'   : the automatic account hold. It needs 'record' ON (a hold is always recorded and alerted).
create function public._tw4dh_switch_on(p_scope text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select coalesce((select l.enabled from public.studio_sms_dispute_hold_switch_log l where l.scope = p_scope order by l.seq desc limit 1), false) $$;

create function public._tw4dh_auto_hold_on()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select public._tw4dh_switch_on('hold') $$;

create function public._tw4dh_record_on()
returns boolean language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$ select public._tw4dh_switch_on('record') $$;

create function public.tw4_dispute_hold_switch_set(p_enabled boolean, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_enabled is null or p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'the dispute-hold switch needs on/off and a written reason (10-300 characters)' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_dispute_hold_switch'));
  if p_enabled and not public._tw4dh_record_on() then
    raise exception 'turn the dispute record switch on first: an automatic hold is always recorded and alerted' using errcode = '55000';
  end if;
  insert into public.studio_sms_dispute_hold_switch_log (scope, enabled, changed_by, reason) values ('hold', p_enabled, p_actor, btrim(p_reason));
  return jsonb_build_object('scope', 'hold', 'enabled', p_enabled);
end $$;

create function public.tw4_dispute_record_switch_set(p_enabled boolean, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  if p_enabled is null or p_reason is null or char_length(btrim(p_reason)) not between 10 and 300 then
    raise exception 'the dispute record switch needs on/off and a written reason (10-300 characters)' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('tw4_dispute_hold_switch'));
  if not p_enabled and public._tw4dh_auto_hold_on() then
    raise exception 'turn the automatic dispute hold off first' using errcode = '55000';
  end if;
  insert into public.studio_sms_dispute_hold_switch_log (scope, enabled, changed_by, reason) values ('record', p_enabled, p_actor, btrim(p_reason));
  return jsonb_build_object('scope', 'record', 'enabled', p_enabled);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the dispute hook (called by tw4_credit_apply_dispute with the business's account row already locked)
-- ---------------------------------------------------------------------------------------------------------------
create function public._tw4dh_on_withdrawn(p_dispute_row uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  d public.studio_sms_credit_disputes;
  a public.studio_sms_credit_accounts;
  h public.studio_sms_credit_dispute_holds;
  v_on boolean := public._tw4dh_auto_hold_on();
  v_fee int := public._tw4dh_est_provider_fee_cents();
begin
  if not public._tw4dh_record_on() then
    return;   -- dark: with the record switch off a dispute behaves exactly as it did before this file (no row, no audit, no alert, no hold)
  end if;
  select * into d from public.studio_sms_credit_disputes x where x.id = p_dispute_row;
  if d.id is null then
    raise exception 'unknown dispute row' using errcode = '22023';
  end if;
  a := public._tw4c_lock(d.legal_entity_id);   -- already held by the caller: re-taking it is a no-op and keeps this function safe on its own
  if exists (select 1 from public.studio_sms_credit_dispute_holds x where x.dispute_row_id = d.id) then
    return;
  end if;
  if v_on and not a.hold then
    update public.studio_sms_credit_accounts set hold = true, hold_reason = 'dispute' where legal_entity_id = d.legal_entity_id;
  end if;
  insert into public.studio_sms_credit_dispute_holds (dispute_row_id, topup_id, legal_entity_id, claim_cents, withdrawn_cents, est_provider_fee_cents, fee_basis, hold_state, not_held_reason, account_already_held)
  values (d.id, d.topup_id, d.legal_entity_id, d.claim_cents, d.withdrawn_cents, v_fee, 'stripe_standard_fee_estimate',
          case when v_on then 'held' else 'not_held' end, case when v_on then null else 'auto_hold_switch_off' end, a.hold)
  returning * into h;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (public._tw4c_any_location(d.legal_entity_id), null, 'system', null, 'credit_hold',
          left('dispute_hold;state=' || h.hold_state || ';hold=' || h.id || ';withdrawn_cents=' || d.withdrawn_cents || ';est_provider_dispute_fee_cents=' || v_fee
               || ';fee_basis=stripe_standard_fee_estimate;fee_allocation=unallocated;studio_charged=0', 300));
  if v_on and a.hold then
    -- the account was already on hold (a manual hold, or another dispute's hold): nothing changed on the account and its reason was left as it is
    perform public._tw4rfl_alert(d.legal_entity_id, null, null, 'credit_dispute', 'dispute:' || d.id, 'admin', 'critical',
      'A Stripe dispute was opened on a prepaid texting credit purchase. The credit account was already on hold, so no new hold was placed and its reason was left as it is. The dispute is recorded as held. Who bears Stripe''s dispute fee has not been decided. Review it and release the dispute hold with a written note.');
  elsif v_on then
    perform public._tw4rfl_alert(d.legal_entity_id, null, null, 'credit_dispute', 'dispute:' || d.id, 'admin', 'critical',
      'A Stripe dispute was opened on a prepaid texting credit purchase. The credit account was placed on hold. Who bears Stripe''s dispute fee has not been decided. Review it and release the hold with a written note.');
  else
    perform public._tw4rfl_alert(d.legal_entity_id, null, null, 'credit_dispute', 'dispute:' || d.id, 'admin', 'critical',
      'A Stripe dispute was opened on a prepaid texting credit purchase. The automatic dispute hold is switched off, so no hold was placed. Who bears Stripe''s dispute fee has not been decided. Review the account.');
  end if;
end $$;

create function public._tw4dh_on_reinstated(p_dispute_row uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare h public.studio_sms_credit_dispute_holds;
begin
  if not public._tw4dh_record_on() then
    return;   -- dark: the record switch gates every hook this file adds
  end if;
  select * into h from public.studio_sms_credit_dispute_holds x where x.dispute_row_id = p_dispute_row;
  if h.id is not null and h.hold_state = 'held' then
    perform public._tw4rfl_alert(h.legal_entity_id, null, null, 'credit_dispute', 'dispute:' || p_dispute_row || ':won', 'admin', 'info',
      'A Stripe dispute on a prepaid texting credit purchase was decided in the studio''s favour. Its hold stays in place until an administrator releases it with a written note.');
  end if;
end $$;

-- 20261125090000's body, with the two hook calls added (marked 20270221090100); nothing else changes
create or replace function public.tw4_credit_apply_dispute(p_payment_ref text, p_dispute_id text, p_amount_cents int, p_action text, p_event_id text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  t public.studio_sms_credit_topups;
  d public.studio_sms_credit_disputes;
  r jsonb;
  v_amount int;
  v_other_open int;
  v_row uuid;
begin
  if p_dispute_id is null or char_length(btrim(p_dispute_id)) < 3 or p_event_id is null or char_length(btrim(p_event_id)) < 3 or p_action not in ('withdrawn', 'reinstated') then
    raise exception 'invalid dispute event' using errcode = '22023';
  end if;
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and (x.provider_ref = p_payment_ref or x.payment_intent_ref = p_payment_ref) limit 1;
  if t.id is null or t.status <> 'settled' then
    raise exception 'no settled payment for this dispute' using errcode = '22023';
  end if;
  perform public._tw4c_lock(t.legal_entity_id);
  select * into t from public.studio_sms_credit_topups x where x.id = t.id for update;
  select * into d from public.studio_sms_credit_disputes x where x.topup_id = t.id and x.dispute_id = p_dispute_id;

  if p_action = 'withdrawn' then
    if p_amount_cents is null or p_amount_cents <= 0 then
      raise exception 'invalid dispute amount' using errcode = '22023';
    end if;
    if d.id is not null then
      return jsonb_build_object('replayed', true); -- created, then funds_withdrawn, or a redelivery: one withdrawal per dispute id
    end if;
    -- never take back more than is still unreversed (a refunded payment can also be disputed): the debit is capped, never an error that retries forever.
    -- The dispute's FULL claim is still recorded, so while it is open it keeps counting against what any other dispute of this payment may give back.
    v_amount := greatest(least(p_amount_cents, t.amount_cents - t.refunded_cents - t.disputed_cents), 0);
    insert into public.studio_sms_credit_disputes (topup_id, legal_entity_id, dispute_id, claim_cents, withdrawn_cents)
    values (t.id, t.legal_entity_id, p_dispute_id, p_amount_cents, v_amount) returning id into v_row;
    if v_amount = 0 then
      perform public._tw4dh_on_withdrawn(v_row);   -- 20270221090100: a dispute of an already-refunded payment still carries a Stripe dispute fee (hold, alert, fee record)
      return jsonb_build_object('replayed', false, 'capped_to_zero', true);
    end if;
    r := public._tw4c_post(t.legal_entity_id, t.paid_by_studio_id, 'topup_reversed', -v_amount, 0, 'dispute_w:' || t.id || ':' || p_dispute_id, null, t.provider_ref, null,
           left('dispute withdrawn;event=' || p_event_id, 280));
    update public.studio_sms_credit_topups set disputed_cents = disputed_cents + v_amount, reversed_cents = reversed_cents + v_amount where id = t.id;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (public._tw4c_any_location(t.legal_entity_id), null, 'system', null, 'credit_reversal', left('dispute;cents=' || v_amount || ';ref=' || t.provider_ref, 300));
    perform public._tw4dh_on_withdrawn(v_row);   -- 20270221090100
    return r;
  end if;

  -- reinstated (the dispute was decided in the studio's favour): only once per dispute id, and never more than the payment minus refunds minus what the other
  -- still-open disputes claim, whatever order the provider's events arrived in
  if d.id is null then
    raise exception 'this dispute has not been recorded for the payment' using errcode = '22023'; -- its withdrawal event has not been processed yet: retried, never dropped
  end if;
  if d.state = 'won' then
    return jsonb_build_object('replayed', true);
  end if;
  select coalesce(sum(x.claim_cents), 0) into v_other_open from public.studio_sms_credit_disputes x where x.topup_id = t.id and x.dispute_id <> p_dispute_id and x.state = 'open';
  v_amount := greatest(least(d.withdrawn_cents, t.amount_cents - t.refunded_cents - v_other_open, t.disputed_cents), 0);
  update public.studio_sms_credit_disputes set state = 'won', reinstated_cents = v_amount, resolved_at = now() where id = d.id;
  perform public._tw4dh_on_reinstated(d.id);   -- 20270221090100: informs the administrator; the hold is released only by tw4_credit_dispute_hold_release
  if v_amount = 0 then
    return jsonb_build_object('replayed', false, 'capped_to_zero', true);
  end if;
  r := public._tw4c_post(t.legal_entity_id, t.paid_by_studio_id, 'adjustment', v_amount, 0, 'dispute_r:' || t.id || ':' || p_dispute_id, null, t.provider_ref, null,
         left('dispute reinstated;event=' || p_event_id, 280));
  update public.studio_sms_credit_topups set disputed_cents = disputed_cents - v_amount, reversed_cents = reversed_cents - v_amount where id = t.id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (public._tw4c_any_location(t.legal_entity_id), null, 'system', null, 'credit_adjustment', left('dispute reinstated;cents=' || v_amount || ';ref=' || t.provider_ref, 300));
  return r;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- release (platform administrator, written note, idempotent, audited)
-- ---------------------------------------------------------------------------------------------------------------
create function public.tw4_credit_dispute_hold_release(p_entity_id uuid, p_hold_id uuid, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  h public.studio_sms_credit_dispute_holds;
  a public.studio_sms_credit_accounts;
  v_cleared boolean := false;
begin
  perform public._tw4c_admin(p_actor);
  if p_entity_id is null or p_hold_id is null then
    raise exception 'name the business and the dispute hold' using errcode = '22023';
  end if;
  select * into h from public.studio_sms_credit_dispute_holds x where x.id = p_hold_id;
  if h.id is null or h.legal_entity_id <> p_entity_id then
    raise exception 'no such dispute hold for this business' using errcode = '22023';   -- a hold of another business is never released through this one
  end if;
  a := public._tw4c_lock(h.legal_entity_id);
  select * into h from public.studio_sms_credit_dispute_holds x where x.id = p_hold_id for update;
  if h.hold_state = 'released' then
    return jsonb_build_object('hold_id', h.id, 'state', 'released', 'replayed', true, 'account_on_hold', a.hold);
  end if;
  if h.hold_state = 'not_held' then
    raise exception 'this dispute placed no hold (the automatic hold was switched off)' using errcode = '22023';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 10 and 500 then
    raise exception 'a release needs a written note (10-500 characters)' using errcode = '22023';
  end if;
  update public.studio_sms_credit_dispute_holds set hold_state = 'released', released_by = p_actor, released_at = clock_timestamp(), release_note = btrim(p_note) where id = h.id;
  -- the account hold goes only when no other dispute hold of this business is still held and the hold is still the automatic one (a manual hold stays)
  if a.hold and a.hold_reason = 'dispute'
     and not exists (select 1 from public.studio_sms_credit_dispute_holds x where x.legal_entity_id = h.legal_entity_id and x.hold_state = 'held' and x.id <> h.id) then
    update public.studio_sms_credit_accounts set hold = false, hold_reason = null where legal_entity_id = h.legal_entity_id;
    v_cleared := true;
  end if;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (public._tw4c_any_location(h.legal_entity_id), null, 'platform_admin', p_actor, 'credit_hold',
          left('dispute_hold_released;hold=' || h.id || ';account_hold_cleared=' || v_cleared || ';note=' || btrim(p_note), 300));
  return jsonb_build_object('hold_id', h.id, 'state', 'released', 'replayed', false, 'account_hold_cleared', v_cleared, 'account_on_hold', not v_cleared and a.hold);
end $$;

-- the administrator's list (no studio data, no Stripe identifiers beyond the dispute id the administrator needs to find the case in Stripe)
create function public.tw4_credit_dispute_holds_list(p_actor uuid, p_entity_id uuid default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  return coalesce((select jsonb_agg(jsonb_build_object('hold_id', h.id, 'legal_entity_id', h.legal_entity_id, 'dispute_id', d.dispute_id, 'dispute_state', d.state,
      'hold_state', h.hold_state, 'claim_cents', h.claim_cents, 'withdrawn_cents', h.withdrawn_cents, 'est_provider_fee_cents', h.est_provider_fee_cents, 'fee_basis', h.fee_basis, 'fee_allocation', h.fee_allocation,
      'account_already_held', h.account_already_held, 'created_at', h.created_at, 'released_at', h.released_at) order by h.created_at desc, h.id)
    from public.studio_sms_credit_dispute_holds h join public.studio_sms_credit_disputes d on d.id = h.dispute_row_id
   where p_entity_id is null or h.legal_entity_id = p_entity_id), '[]'::jsonb);
end $$;

-- 20261122090000's body, plus: a hold cannot be CLEARED while a dispute hold is held, and the reason 'dispute' is reserved for the automatic hold
create or replace function public.tw4_credit_set_hold(p_entity_id uuid, p_hold boolean, p_reason text, p_actor uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public._tw4c_admin(p_actor);
  perform public._tw4c_lock(p_entity_id);
  if p_hold and (p_reason is null or char_length(btrim(p_reason)) < 5) then
    raise exception 'a hold needs a reason' using errcode = '22023';
  end if;
  if p_hold and lower(btrim(p_reason)) = 'dispute' then
    raise exception 'the hold reason "dispute" is reserved for the automatic dispute hold' using errcode = '22023';
  end if;
  if not p_hold and exists (select 1 from public.studio_sms_credit_dispute_holds h where h.legal_entity_id = p_entity_id and h.hold_state = 'held') then
    raise exception 'this account has a dispute hold: release each with tw4_credit_dispute_hold_release and a written note' using errcode = '55000';
  end if;
  update public.studio_sms_credit_accounts set hold = p_hold, hold_reason = case when p_hold then left(btrim(p_reason), 300) else null end where legal_entity_id = p_entity_id;
  insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
  values (public._tw4c_any_location(p_entity_id), null, 'platform_admin', p_actor, 'credit_hold', left('hold=' || p_hold, 300));
  return jsonb_build_object('hold', p_hold);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- negative AVAILABLE credit: one alert per transition from >= 0 to < 0, whatever moved the balance (notification only)
-- ---------------------------------------------------------------------------------------------------------------
create function public._tw4dh_negative_alert()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_seq bigint;
begin
  -- A notification must NEVER fail the statement that moved the balance (an inbound STOP/START/HELP debit included): dark while the record switch is off, and any
  -- error while reading the switch or writing the alert is reduced to a warning in its own sub-transaction.
  begin
    if not public._tw4dh_record_on() then
      return null;
    end if;
    select coalesce(max(l.seq), 0) into v_seq from public.studio_sms_credit_ledger l where l.legal_entity_id = new.legal_entity_id;
    perform public._tw4rfl_alert(new.legal_entity_id, null, null, 'credit_negative', 'neg:' || new.legal_entity_id || ':' || v_seq, 'admin', 'critical',
      'Available prepaid texting credit for a business fell below zero. New fee-bearing operations and chargeable texts are already refused; STOP, START and HELP are unaffected. Review the account.');
  exception when others then
    raise warning 'credit_negative alert not written (%): %', sqlstate, sqlerrm;
  end;
  return null;
end $$;
create trigger studio_sms_credit_accounts_negative_alert after update of balance_cents, reserved_cents on public.studio_sms_credit_accounts for each row
  when ((old.balance_cents - old.reserved_cents) >= 0 and (new.balance_cents - new.reserved_cents) < 0) execute function public._tw4dh_negative_alert();

-- ---------------------------------------------------------------------------------------------------------------
-- privileges
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function public._tw4dh_guard(), public._tw4dh_est_provider_fee_cents(), public._tw4dh_switch_on(text), public._tw4dh_record_on(), public._tw4dh_auto_hold_on(), public._tw4dh_on_withdrawn(uuid), public._tw4dh_on_reinstated(uuid),
  public._tw4dh_negative_alert() from public, anon, authenticated, service_role;
revoke all on function public.tw4_dispute_hold_switch_set(boolean, uuid, text), public.tw4_dispute_record_switch_set(boolean, uuid, text), public.tw4_credit_dispute_hold_release(uuid, uuid, uuid, text),
  public.tw4_credit_dispute_holds_list(uuid, uuid), public.tw4_credit_apply_dispute(text, text, int, text, text), public.tw4_credit_set_hold(uuid, boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function public.tw4_dispute_hold_switch_set(boolean, uuid, text), public.tw4_dispute_record_switch_set(boolean, uuid, text), public.tw4_credit_dispute_hold_release(uuid, uuid, uuid, text),
  public.tw4_credit_dispute_holds_list(uuid, uuid), public.tw4_credit_apply_dispute(text, text, int, text, text), public.tw4_credit_set_hold(uuid, boolean, text, uuid)
  to service_role;

commit;

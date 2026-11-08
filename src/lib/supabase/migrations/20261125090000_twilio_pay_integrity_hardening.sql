-- 20261125090000_twilio_pay_integrity_hardening.sql
-- Prepaid-credit payment-integrity hardening (after TW-4F-3b-pay / TW-4F-3b-UI).
--  1. A held credit account is not sold more credit, enforced in the database with the same hold policy and error (TW007) as spending:
--     tw4_credit_checkout_context (before any Stripe session exists) and, under the account lock, tw4_credit_topup_pending (a hold placed in between still wins).
--     The context now returns the hold flag, which the application requires to be exactly false (an older or unknown answer fails closed).
--     Settlement of a payment already made is NOT blocked by a hold: the money was taken, so it is credited (and stays unspendable while the hold lasts).
--  2. Disputes get their own state table (studio_sms_credit_disputes: claim, amount actually taken back, outcome). tw4_credit_apply_dispute caps a withdrawal to what is
--     still unreversed but remembers the full claim, and a reinstatement can never return more than the payment minus refunds minus what the payment's OTHER open
--     disputes claim, in any event order. Replays and duplicates under new event ids are no-ops.
-- Requires 20261123090000. Rollback: rollback/20261125090000_twilio_pay_integrity_hardening_rollback.sql (restores the 20261123090000 bodies; refuses once dispute rows exist).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.tw4_credit_apply_dispute(text,text,integer,text,text)') is null or to_regprocedure('public.tw4_credit_checkout_context(uuid,uuid)') is null then
    raise exception 'pay-integrity precondition failed: TW-4F-3b-pay is not applied';
  end if;
  if to_regclass('public.studio_sms_credit_disputes') is not null then
    raise exception 'pay-integrity precondition failed: already applied';
  end if;
  -- disputes recorded by the pay migration are backfilled from the ledger, which only knows what was actually taken back. A dispute capped to nothing left only an audit
  -- note, and a payment with several disputes lost their claims: neither can be reconstructed, so the migration refuses and they are reviewed by hand first.
  if exists (select 1 from public.studio_sms_onboarding_audit au where au.note like 'dispute_nothing_left;%')
     or exists (select 1 from public.studio_sms_credit_ledger l where l.idempotency_key like 'dispute_w:%' group by l.legal_entity_id, substr(l.idempotency_key, 1, 11 + 36) having count(*) > 1) then
    raise exception 'pay-integrity precondition failed: legacy dispute records need manual review first' using errcode = '55000';
  end if;
end $$;

-- one row per dispute of a credit purchase: the claim, what was actually taken back (capped to what was unreversed) and the outcome. This is the state the
-- reinstatement rule needs; the ledger stays the record of money.
create table public.studio_sms_credit_disputes (
  id uuid primary key default gen_random_uuid(),
  topup_id uuid not null references public.studio_sms_credit_topups(id) on delete restrict,
  legal_entity_id uuid not null references public.studio_sms_legal_entities(id) on delete restrict,
  dispute_id text not null check (char_length(btrim(dispute_id)) between 3 and 200),
  claim_cents int not null check (claim_cents > 0),
  withdrawn_cents int not null check (withdrawn_cents >= 0),
  reinstated_cents int not null default 0 check (reinstated_cents >= 0),
  state text not null default 'open' check (state in ('open', 'won')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz null,
  constraint studio_sms_credit_disputes_unique unique (topup_id, dispute_id),
  constraint studio_sms_credit_disputes_amounts check (withdrawn_cents <= claim_cents and reinstated_cents <= withdrawn_cents),
  constraint studio_sms_credit_disputes_state check ((state = 'won') = (resolved_at is not null))
);
revoke all on public.studio_sms_credit_disputes from public, anon, authenticated, service_role;
alter table public.studio_sms_credit_disputes enable row level security;

-- disputes recorded by the pay migration before this table existed (the ledger is the source)
insert into public.studio_sms_credit_disputes (topup_id, legal_entity_id, dispute_id, claim_cents, withdrawn_cents, reinstated_cents, state, resolved_at)
select t.id, l.legal_entity_id, substr(l.idempotency_key, char_length('dispute_w:' || t.id || ':') + 1), -l.balance_delta_cents, -l.balance_delta_cents,
       coalesce((select r.balance_delta_cents from public.studio_sms_credit_ledger r where r.legal_entity_id = l.legal_entity_id
                  and r.idempotency_key = 'dispute_r:' || t.id || ':' || substr(l.idempotency_key, char_length('dispute_w:' || t.id || ':') + 1)), 0),
       case when exists (select 1 from public.studio_sms_credit_ledger r where r.legal_entity_id = l.legal_entity_id
                          and r.idempotency_key = 'dispute_r:' || t.id || ':' || substr(l.idempotency_key, char_length('dispute_w:' || t.id || ':') + 1)) then 'won' else 'open' end,
       case when exists (select 1 from public.studio_sms_credit_ledger r where r.legal_entity_id = l.legal_entity_id
                          and r.idempotency_key = 'dispute_r:' || t.id || ':' || substr(l.idempotency_key, char_length('dispute_w:' || t.id || ':') + 1)) then now() end
  from public.studio_sms_credit_ledger l join public.studio_sms_credit_topups t on l.idempotency_key like 'dispute\_w:' || t.id || ':%' and l.legal_entity_id = t.legal_entity_id;

create or replace function public.tw4_credit_checkout_context(p_studio_id uuid, p_user_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_entity uuid;
  a public.studio_sms_credit_accounts;
begin
  if p_user_id is null or p_studio_id is null or not exists (
       select 1 from public.user_studio_roles r where r.user_id = p_user_id and r.studio_id = p_studio_id and r.active = true and r.role in ('studio_owner', 'studio_admin')) then
    raise exception 'not authorized to buy SMS credit for this studio' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    raise exception 'this studio has no verified legal business yet' using errcode = 'TW010';
  end if;
  -- the same hold policy as spending (tw4_spend_reserve): a held account is not sold more credit. No account row yet means nothing has ever been held.
  select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = v_entity;
  if a.hold then
    raise exception 'the credit account is on hold' using errcode = 'TW007';
  end if;
  return jsonb_build_object('legal_entity_id', v_entity, 'hold', coalesce(a.hold, false));
end $$;

create or replace function public.tw4_credit_topup_pending(p_entity_id uuid, p_paid_by_studio_id uuid, p_provider_ref text, p_amount_cents int, p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  t public.studio_sms_credit_topups;
  v_pending bigint;
begin
  if p_expires_at is not null and (p_expires_at <= now() or p_expires_at > now() + interval '24 hours') then
    raise exception 'a checkout must expire within the next 24 hours' using errcode = '22023';
  end if;
  a := public._tw4c_lock(p_entity_id);
  select * into t from public.studio_sms_credit_topups x where x.provider = 'stripe' and x.provider_ref = p_provider_ref;
  if t.id is not null then
    if t.legal_entity_id <> p_entity_id or t.amount_cents <> p_amount_cents then
      raise exception 'this payment belongs to another legal business or amount' using errcode = '23505';
    end if;
    return jsonb_build_object('topup_id', t.id, 'status', t.status);
  end if;
  if a.hold then
    raise exception 'the credit account is on hold' using errcode = 'TW007'; -- re-checked under the account lock: a hold placed after the checkout context was read still wins
  end if;
  if p_amount_cents not in (2500, 5000, 10000) then
    raise exception 'top-ups are $25, $50 or $100 packs' using errcode = '22023';
  end if;
  select coalesce(sum(x.amount_cents), 0) into v_pending from public.studio_sms_credit_topups x
   where x.legal_entity_id = p_entity_id and x.status = 'pending' and (x.expires_at is null or x.expires_at > now());
  if a.balance_cents + v_pending + p_amount_cents > 50000 then
    raise exception 'this top-up would exceed the $500 balance ceiling' using errcode = 'TW009';
  end if;
  insert into public.studio_sms_credit_topups (legal_entity_id, paid_by_studio_id, provider, provider_ref, amount_cents, expires_at)
  values (p_entity_id, p_paid_by_studio_id, 'stripe', p_provider_ref, p_amount_cents, p_expires_at) returning * into t;
  return jsonb_build_object('topup_id', t.id, 'status', t.status);
end $$;

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
    values (t.id, t.legal_entity_id, p_dispute_id, p_amount_cents, v_amount);
    if v_amount = 0 then
      return jsonb_build_object('replayed', false, 'capped_to_zero', true);
    end if;
    r := public._tw4c_post(t.legal_entity_id, t.paid_by_studio_id, 'topup_reversed', -v_amount, 0, 'dispute_w:' || t.id || ':' || p_dispute_id, null, t.provider_ref, null,
           left('dispute withdrawn;event=' || p_event_id, 280));
    update public.studio_sms_credit_topups set disputed_cents = disputed_cents + v_amount, reversed_cents = reversed_cents + v_amount where id = t.id;
    insert into public.studio_sms_onboarding_audit (studio_id, onboarding_id, actor_type, actor_user_id, action, note)
    values (public._tw4c_any_location(t.legal_entity_id), null, 'system', null, 'credit_reversal', left('dispute;cents=' || v_amount || ';ref=' || t.provider_ref, 300));
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

-- create or replace keeps each function's privileges (service_role only); asserted again so the file is self-contained
revoke all on function public.tw4_credit_checkout_context(uuid, uuid), public.tw4_credit_topup_pending(uuid, uuid, text, int, timestamptz),
  public.tw4_credit_apply_dispute(text, text, int, text, text) from public, anon, authenticated;
grant execute on function public.tw4_credit_checkout_context(uuid, uuid), public.tw4_credit_topup_pending(uuid, uuid, text, int, timestamptz),
  public.tw4_credit_apply_dispute(text, text, int, text, text) to service_role;

commit;

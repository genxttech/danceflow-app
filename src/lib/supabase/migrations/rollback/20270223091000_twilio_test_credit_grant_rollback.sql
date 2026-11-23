-- Rollback for 20270223091000_twilio_test_credit_grant.sql. Re-runnable (a second run finds nothing to drop and succeeds).
-- No application code calls these functions (the TypeScript wrapper is dark behind TW4_TEST_CREDIT_ENABLED), so the order app/SQL does not matter; roll the app back first anyway.
-- REFUSES while ANY row this migration created exists: a switch change, a budget (even at 0), a budget change, a grant, a movement, a test ledger entry, a test approval
-- reference or a test audit row. That is evidence of money decisions and is never destroyed. To roll back after use: reverse the unused test credit
-- (tw4_credit_test_reverse) and leave the migration applied; the switch OFF is the operational rollback.
begin;

set local lock_timeout = '5s';

do $$
declare v_rows bigint := 0;
begin
  if to_regclass('public.studio_sms_test_credit_budgets') is not null then
    execute 'select (select count(*) from public.studio_sms_test_credit_switch_log) + (select count(*) from public.studio_sms_test_credit_budgets)
               + (select count(*) from public.studio_sms_test_credit_budget_changes) + (select count(*) from public.studio_sms_test_credit_grants)
               + (select count(*) from public.studio_sms_test_credit_movements)' into v_rows;
  end if;
  v_rows := v_rows + (select count(*) from public.studio_sms_credit_ledger l where l.kind in ('test_grant', 'test_grant_reversed'))
                   + (select count(*) from public.studio_sms_approval_refs r where r.source in ('test_credit_budget', 'test_credit_grant'))
                   + (select count(*) from public.studio_sms_onboarding_audit x where x.action in ('credit_test_budget_set', 'credit_test_grant', 'credit_test_reversal'));
  if v_rows > 0 then
    raise exception 'Refusing to roll back 20270223091000: % test-credit rows exist (evidence is never dropped). Turn the switch off and reverse unused test credit instead.', v_rows;
  end if;
end $$;

-- the two redefined functions go back to their predecessor bodies byte-exactly (20261123 sms_credit_overview, 20261125 tw4_credit_topup_pending); grants are kept
-- by create or replace. Only when this migration's body is live (a re-run after a completed rollback changes nothing).
do $outer$
begin
  if to_regprocedure('public._tw4tc_unused(uuid)') is not null then
    execute $ov$
create or replace function public.sms_credit_overview(p_studio_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
  v_entity uuid;
begin
  if auth.uid() is null or coalesce(public._sms_onb_studio_role(p_studio_id), '') not in ('studio_owner', 'studio_admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select es.legal_entity_id into v_entity from public.studio_sms_entity_studios es where es.studio_id = p_studio_id;
  if v_entity is null then
    return jsonb_build_object('legal_business', false, 'balance_cents', 0, 'reserved_cents', 0, 'available_cents', 0, 'on_hold', false, 'low_balance', false, 'pending_topups_cents', 0, 'this_location_net_charges_cents', 0);
  end if;
  select * into a from public.studio_sms_credit_accounts x where x.legal_entity_id = v_entity;
  return jsonb_build_object(
    'legal_business', true,
    'balance_cents', coalesce(a.balance_cents, 0), 'reserved_cents', coalesce(a.reserved_cents, 0),
    'available_cents', greatest(coalesce(a.balance_cents, 0) - coalesce(a.reserved_cents, 0), 0),
    'on_hold', coalesce(a.hold, false), 'low_balance', a.low_balance_flagged_at is not null, 'low_balance_threshold_cents', coalesce(a.low_balance_threshold_cents, 1000),
    'pending_topups_cents', coalesce((select sum(t.amount_cents) from public.studio_sms_credit_topups t where t.legal_entity_id = v_entity and t.status = 'pending' and (t.expires_at is null or t.expires_at > now())), 0),
    'this_location_net_charges_cents', coalesce((select -sum(l.balance_delta_cents) from public.studio_sms_credit_ledger l
        where l.legal_entity_id = v_entity and l.studio_id = p_studio_id and l.kind in ('capture', 'usage_charge', 'usage_refund')), 0),
    'pilot_ceiling_cents', (select x.ceiling_cents from public.studio_sms_pilot_exceptions x where x.legal_entity_id = v_entity),
    'pilot_used_cents', coalesce((select sum(r.amount_cents) from public.studio_sms_credit_reservations r where r.legal_entity_id = v_entity and r.funding = 'pilot' and r.status in ('reserved', 'captured')), 0));
end $$;
$ov$;
    execute $tp$
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
$tp$;
  end if;
end $outer$;
drop function if exists public._tw4tc_unused(uuid);

drop trigger if exists studio_sms_credit_ledger_40_test_credit on public.studio_sms_credit_ledger;
drop function if exists public.tw4_credit_test_status(uuid);
drop function if exists public.tw4_credit_test_reverse(uuid, int, text, text, uuid);
drop function if exists public.tw4_credit_test_grant(uuid, int, text, uuid, date, text, text, int, text, text, text);
drop function if exists public.tw4_credit_test_budget_set(uuid, int, text, uuid, date, text, text, int, text, text, text);
drop function if exists public.tw4_credit_test_set_switch(boolean, uuid, text);
drop function if exists public._tw4tc_ledger_trigger();
drop function if exists public._tw4tc_on_ledger(public.studio_sms_credit_ledger, text);
drop function if exists public._tw4tc_open_sms(uuid);
drop function if exists public._tw4tc_budget(uuid);
drop function if exists public._tw4tc_require_pilot(uuid);
drop function if exists public._tw4tc_check_evidence(uuid, text, bigint, date, text, text, bigint, text, text, text);
drop function if exists public._tw4tc_switch_on();
drop table if exists public.studio_sms_test_credit_movements;
drop table if exists public.studio_sms_test_credit_grants;
drop table if exists public.studio_sms_test_credit_budget_changes;
drop table if exists public.studio_sms_test_credit_budgets;
drop table if exists public.studio_sms_test_credit_switch_log;
drop function if exists public._tw4tc_guard();

-- the ledger kinds: back to the 20261122 definitions (no test rows exist: refused above).
-- NOTE: the kind and shape lists below are written out (hard-coded) from 20261122. If a LATER migration adds ledger kinds, this rollback must be updated with them
-- (or rolled back after that migration's own rollback); applying it as-is would drop those kinds from the check.
do $$
begin
  if exists (select 1 from pg_constraint c where c.conrelid = 'public.studio_sms_credit_ledger'::regclass and pg_get_constraintdef(c.oid) like '%test_grant%') then
    alter table public.studio_sms_credit_ledger drop constraint studio_sms_credit_ledger_kind_check;
    alter table public.studio_sms_credit_ledger add constraint studio_sms_credit_ledger_kind_check
      check (kind in ('topup_settled', 'topup_reversed', 'reserve', 'release', 'capture', 'usage_charge', 'usage_refund', 'adjustment'));
    alter table public.studio_sms_credit_ledger drop constraint studio_sms_credit_ledger_shape;
    alter table public.studio_sms_credit_ledger add constraint studio_sms_credit_ledger_shape check (
      case kind
        when 'topup_settled' then balance_delta_cents > 0 and reserved_delta_cents = 0
        when 'topup_reversed' then balance_delta_cents < 0 and reserved_delta_cents = 0
        when 'reserve' then balance_delta_cents = 0 and reserved_delta_cents > 0
        when 'release' then balance_delta_cents = 0 and reserved_delta_cents < 0
        when 'capture' then balance_delta_cents < 0 and reserved_delta_cents = balance_delta_cents
        when 'usage_charge' then balance_delta_cents < 0 and reserved_delta_cents = 0
        when 'usage_refund' then balance_delta_cents > 0 and reserved_delta_cents = 0
        else balance_delta_cents <> 0 and reserved_delta_cents = 0
      end);
  end if;
end $$;

-- the approval-reference registry: remove ONLY this migration's two sources and clauses (a sibling's sources stay)
do $$
declare
  v_src text;
  v_shape text;
  v_sources text[];
  v_b text := ' OR (source = ''test_credit_budget''::text AND spend_event_id IS NULL AND kind IS NULL AND funding IS NULL AND studio_id IS NULL AND amount_cents IS NOT NULL)';
  v_g text := ' OR (source = ''test_credit_grant''::text AND spend_event_id IS NULL AND kind IS NULL AND funding IS NULL AND studio_id IS NULL AND amount_cents IS NOT NULL)';
  v_b_pg text := ' OR ((source = ''test_credit_budget''::text) AND (spend_event_id IS NULL) AND (kind IS NULL) AND (funding IS NULL) AND (studio_id IS NULL) AND (amount_cents IS NOT NULL))';
  v_g_pg text := ' OR ((source = ''test_credit_grant''::text) AND (spend_event_id IS NULL) AND (kind IS NULL) AND (funding IS NULL) AND (studio_id IS NULL) AND (amount_cents IS NOT NULL))';
begin
  select pg_get_constraintdef(c.oid) into v_src from pg_constraint c where c.conrelid = 'public.studio_sms_approval_refs'::regclass and c.conname = 'studio_sms_approval_refs_source_check';
  select pg_get_constraintdef(c.oid) into v_shape from pg_constraint c where c.conrelid = 'public.studio_sms_approval_refs'::regclass and c.conname = 'studio_sms_approval_refs_shape';
  if position('test_credit' in v_src) > 0 then
    select array_agg(distinct m[1] order by m[1]) into v_sources from regexp_matches(substring(v_src from 'ANY ((.*))'), '([a-z_]+)', 'g') m
      where m[1] not in ('text', 'array', 'test_credit_budget', 'test_credit_grant');
    alter table public.studio_sms_approval_refs drop constraint studio_sms_approval_refs_source_check;
    execute format('alter table public.studio_sms_approval_refs add constraint studio_sms_approval_refs_source_check check (source = any (%L::text[]))', v_sources);
  end if;
  if position('test_credit' in v_shape) > 0 then
    v_shape := replace(replace(replace(replace(v_shape, v_b_pg, ''), v_g_pg, ''), v_b, ''), v_g, '');
    if position('test_credit' in v_shape) > 0 then
      raise exception 'test-credit rollback: could not remove the test_credit clauses from %', v_shape;
    end if;
    v_shape := regexp_replace(v_shape, '^CHECK ', '');
    alter table public.studio_sms_approval_refs drop constraint studio_sms_approval_refs_shape;
    execute 'alter table public.studio_sms_approval_refs add constraint studio_sms_approval_refs_shape check ' || v_shape;
  end if;
end $$;

-- the audit vocabulary: remove ONLY this migration's three actions (no such rows exist: refused above)
do $$
declare
  v_def text;
  v_actions text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_onboarding_audit'::regclass and c.conname = 'studio_sms_onboarding_audit_action_check';
  if position('credit_test_' in v_def) > 0 then
    select array_agg(distinct m[1] order by m[1]) into v_actions from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m
      where m[1] not in ('text', 'credit_test_budget_set', 'credit_test_grant', 'credit_test_reversal');
    alter table public.studio_sms_onboarding_audit drop constraint studio_sms_onboarding_audit_action_check;
    execute format('alter table public.studio_sms_onboarding_audit add constraint studio_sms_onboarding_audit_action_check check (action = any (%L::text[]))', v_actions);
  end if;
end $$;

commit;

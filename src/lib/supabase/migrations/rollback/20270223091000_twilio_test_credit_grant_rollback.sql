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

drop trigger if exists studio_sms_credit_ledger_40_test_credit on public.studio_sms_credit_ledger;
drop function if exists public.tw4_credit_test_status(uuid);
drop function if exists public.tw4_credit_test_reverse(uuid, int, text, text, uuid);
drop function if exists public.tw4_credit_test_grant(uuid, int, text, uuid, date, text, text, int, text, text, text);
drop function if exists public.tw4_credit_test_budget_set(uuid, int, text, uuid, date, text, text, int, text, text, text);
drop function if exists public.tw4_credit_test_set_switch(boolean, uuid, text);
drop function if exists public._tw4tc_ledger_trigger();
drop function if exists public._tw4tc_on_ledger(public.studio_sms_credit_ledger, text);
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

-- the ledger kinds: back to the 20261122 definitions (no test rows exist: refused above)
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

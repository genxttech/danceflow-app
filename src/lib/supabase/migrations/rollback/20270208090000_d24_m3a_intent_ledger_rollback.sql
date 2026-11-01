-- Rollback of 20270208090000_d24_m3a_intent_ledger.sql. REFUSES (unless `set d24.m3a_rollback_exported = 'yes';` was run in the same session AFTER exporting
-- hosted_invoice_creation_intents and hosted_invoice_creation_intent_events) while any intent or audit row exists: export first.
-- Stop the creation flow first (nothing may create invoices while the ledger is gone). Restores the M1 d24_register_invoice VERBATIM
-- (caller-supplied account, per-account lock only): after this rollback the M2-A blockers are open again, so the creation integration must not run.
-- Registry rows created through the ledger stay (they are M1 evidence).
begin;
set local lock_timeout = '5s';
lock table public.hosted_invoice_creation_intents, public.hosted_invoice_creation_intent_events, public.hosted_invoice_business_object_types in access exclusive mode;
do $$
begin
  if (exists (select 1 from public.hosted_invoice_creation_intents) or exists (select 1 from public.hosted_invoice_creation_intent_events))
     and coalesce(current_setting('d24.m3a_rollback_exported', true), '') <> 'yes' then
    raise exception 'd24 m3a rollback refused: intent evidence exists; export it first';
  end if;
end $$;
drop function if exists public._d24_intent_json(public.hosted_invoice_creation_intents);
drop function if exists public._d24_intent_lock(uuid, uuid);
drop function if exists public.d24_intent_list_recoverable(integer, integer, uuid);
drop function if exists public.d24_intent_abandon(uuid, uuid, text, integer);
drop function if exists public.d24_intent_fail(uuid, uuid, text, boolean);
drop function if exists public.d24_intent_register(uuid, uuid);
drop function if exists public.d24_intent_mark_provider_created(uuid, uuid, text, boolean, boolean, text);
drop function if exists public.d24_intent_begin(uuid, text, text, text, uuid);
drop index if exists public.hosted_invoice_registry_invoice_idx;
drop table public.hosted_invoice_creation_intent_events;
drop table public.hosted_invoice_creation_intents;
drop table public.hosted_invoice_business_object_types;
drop function if exists public.d24_register_business_object_type(text, regprocedure);
drop function if exists public._d24_clean_code(text);
drop function if exists public._d24_intent_event(uuid, uuid, text, text, text, text);
drop function if exists public._d24_check_owner(uuid, text, text);
drop function if exists public._d24_studio_account(uuid);
drop function if exists public._d24_bot_guard();
drop function if exists public._d24_intent_guard();

-- Record a DanceFlow-issued invoice in the trusted registry and adopt any facts that arrived before it.
create or replace function public.d24_register_invoice(
  p_studio_id uuid, p_stripe_account_id text, p_stripe_invoice_id text, p_livemode boolean,
  p_business_object_type text, p_business_object_id text, p_created_by uuid default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_reg uuid;
  v_row uuid;
  v_adopted boolean := false;
  v_other uuid;
  v_other_acct text;
begin
  if p_studio_id is null or p_stripe_invoice_id is null or p_livemode is null then
    raise exception 'd24_register_invoice: studio, invoice id and livemode are required' using errcode = '22023';
  end if;
  perform set_config('d24.writer', 'on', true);
  perform public._d24_key_lock(p_stripe_account_id, p_stripe_invoice_id);

  insert into public.hosted_invoice_registry (studio_id, stripe_account_id, stripe_invoice_id, livemode, business_object_type, business_object_id, created_by)
  values (p_studio_id, p_stripe_account_id, p_stripe_invoice_id, p_livemode, p_business_object_type, p_business_object_id, p_created_by)
  on conflict (coalesce(stripe_account_id, ''), stripe_invoice_id) do nothing
  returning id into v_reg;

  if v_reg is null then
    -- already registered: idempotent only when identical; a different owner is refused, never overwritten
    select id into v_reg from public.hosted_invoice_registry
    where coalesce(stripe_account_id, '') = coalesce(p_stripe_account_id, '') and stripe_invoice_id = p_stripe_invoice_id
      and studio_id = p_studio_id and business_object_type = p_business_object_type and business_object_id = p_business_object_id
      and livemode = p_livemode;
    if v_reg is null then
      raise exception 'd24_registration_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('outcome', 'already_registered', 'registry_id', v_reg);
  end if;

  -- the same invoice id seen under another account scope was never ours: flag it, never attribute it
  for v_other_acct in select distinct account_key from public.hosted_invoices
      where stripe_invoice_id = p_stripe_invoice_id and account_key <> coalesce(p_stripe_account_id, '') order by account_key loop
    perform public._d24_key_lock(nullif(v_other_acct, ''), p_stripe_invoice_id);
  end loop;
  for v_other in select id from public.hosted_invoices
      where stripe_invoice_id = p_stripe_invoice_id and coalesce(stripe_account_id, '') <> coalesce(p_stripe_account_id, '') and studio_id is null
      order by id for update loop
    perform public._d24_flag(v_other, 'account_scope_mismatch', true);
    perform public._d24_refresh_state(v_other, 'registration', null);
  end loop;
  select id into v_row from public.hosted_invoices
  where coalesce(stripe_account_id, '') = coalesce(p_stripe_account_id, '') and stripe_invoice_id = p_stripe_invoice_id
  for update;
  if v_row is not null then
    v_adopted := public._d24_try_adopt(v_row);
    perform public._d24_classify(v_row);
    perform public._d24_refresh_state(v_row, 'registration', null);
  end if;
  return jsonb_build_object('outcome', 'registered', 'registry_id', v_reg, 'adopted_existing_facts', v_adopted and v_row is not null);
end $$;
commit;

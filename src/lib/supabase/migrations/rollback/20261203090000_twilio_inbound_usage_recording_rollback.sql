-- Rollback of 20261203090000 (inbound usage recording). Restores _tw4ml_month_parts and tw4_credit_debit_usage as of 20261201090000, removes the
-- 'sms_inbound' price kind from the live kind list (leaving every other kind as it is) and drops the inbound objects.
-- REFUSES once any inbound record, exposure ceiling or 'sms_inbound' price row exists (financial evidence): from then on the stance is forward-fix only.
-- Roll the application back first.
begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_inbound_usage') is null then
    raise exception 'inbound-recording rollback: not applied';
  end if;
  if exists (select 1 from public.studio_sms_inbound_usage) or exists (select 1 from public.studio_sms_inbound_exposure_ceilings)
     or exists (select 1 from public.studio_sms_price_list where kind = 'sms_inbound')
     or exists (select 1 from public.studio_sms_credit_ledger where idempotency_key like 'usage:in:%') then
    raise exception 'inbound-recording rollback refused: inbound records, ceilings or inbound prices exist' using errcode = '55000';
  end if;
end $$;

drop function public.sms_inbound_admin_overview(uuid), public._tw4in_reconciliation_gaps(), public.tw4_inbound_exposure_set(uuid, uuid, int, text),
  public.tw4_inbound_reply_allowed(text, text, text, int), public.tw4_inbound_record(uuid, text, text, int, int, text, text, timestamptz, text), public._tw4in_ceiling(uuid);
drop table public.sms_inbound_reply_counters;
drop table public.studio_sms_inbound_usage;
drop table public.studio_sms_inbound_exposure_ceilings;

do $$
declare
  v_def text;
  v_kinds text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = 'public.studio_sms_price_list'::regclass and c.conname = 'studio_sms_price_list_kind_check';
  -- the identifiers inside ANY (...), whichever form Postgres prints, minus the type name and the inbound kind
  select array_agg(distinct m[1] order by m[1]) into v_kinds from regexp_matches(substring(v_def from 'ANY \((.*)\)'), '([a-z][a-z0-9_]*)', 'g') m
   where m[1] not in ('text', 'sms_inbound');
  if v_kinds is null or cardinality(v_kinds) < 2 then
    raise exception 'could not read the price kinds from %', v_def;
  end if;
  alter table public.studio_sms_price_list drop constraint studio_sms_price_list_kind_check;
  execute format('alter table public.studio_sms_price_list add constraint studio_sms_price_list_kind_check check (kind = any (%L::text[]))', v_kinds);
end $$;

-- as of 20261201090000
create or replace function public._tw4ml_month_parts(p_entity uuid, p_key text)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  s timestamptz := public._tw4ml_month_start(p_entity, p_key);
  e timestamptz := public._tw4ml_month_start(p_entity, public._tw4ml_key_add(p_key, 1));
  v_usage bigint;
  v_recurring bigint;
  v_reserved bigint;
begin
  select coalesce(sum(-l.balance_delta_cents), 0) into v_usage from public.studio_sms_credit_ledger l
    left join public.studio_sms_credit_reservations r on r.id = l.reservation_id
   where l.legal_entity_id = p_entity and l.kind in ('usage_charge', 'usage_refund')
     and coalesce(r.created_at, l.created_at) >= s and coalesce(r.created_at, l.created_at) < e;
  -- a captured recurring fee belongs to the month its funds were reserved in (a set-aside captured by a later month's charge is NOT counted a second time there)
  select coalesce(sum(-l.balance_delta_cents), 0) into v_recurring from public.studio_sms_credit_ledger l
    left join public.studio_sms_credit_reservations r on r.id = l.reservation_id
   where l.legal_entity_id = p_entity and l.kind = 'capture' and (l.idempotency_key like 'capture:rec:%' or l.idempotency_key like 'capture:commit:%')
     and coalesce(r.created_at, l.created_at) >= s and coalesce(r.created_at, l.created_at) < e;
  select coalesce(sum(r.amount_cents), 0) into v_reserved from public.studio_sms_credit_reservations r
   where r.legal_entity_id = p_entity and r.status = 'reserved' and (r.reservation_key like 'rec:%' or r.reservation_key like 'commit:%' or r.reservation_key like 'sms:%')
     and r.created_at >= s and r.created_at < e;
  return jsonb_build_object('usage_cents', v_usage, 'recurring_cents', v_recurring, 'reserved_cents', v_reserved, 'total_cents', v_usage + v_recurring + v_reserved,
                            'starts_at', s, 'ends_at', e);
end $$;

-- as of 20261201090000
create or replace function public.tw4_credit_debit_usage(p_entity_id uuid, p_studio_id uuid, p_cents int, p_key text, p_ref text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  a public.studio_sms_credit_accounts;
begin
  if p_cents is null or p_cents <= 0 or p_studio_id is null then
    raise exception 'invalid usage amount or location' using errcode = '22023';
  end if;
  if p_key is null or p_key like 'sms:%' then
    raise exception 'this key namespace belongs to billed texts' using errcode = '22023';
  end if;
  a := public._tw4c_lock(p_entity_id);
  -- a replay of a debit that already happened must succeed even if the account has since run low or the month's limit is used up
  if exists (select 1 from public.studio_sms_credit_ledger l where l.legal_entity_id = p_entity_id and l.idempotency_key = 'usage:' || p_key) then
    return public._tw4c_post(p_entity_id, p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
  end if;
  perform public._tw4ml_ensure_tz(p_entity_id);
  perform public._tw4c_require_funds(a, p_cents);
  perform public._tw4ml_require_room(p_entity_id, p_cents);   -- fail closed: funds AND the month's limit
  return public._tw4c_post(p_entity_id, p_studio_id, 'usage_charge', -p_cents, 0, 'usage:' || p_key, null, p_ref, null, null);
end $$;

commit;

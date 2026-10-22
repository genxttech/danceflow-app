-- TW-4F: platform-administrator, READ-ONLY views over campaign orphans (studio_sms_prov_orphans, 20261212):
--
--   * tw4_prov_orphan_exposure   every provider-owned orphan from discovery until it is closed, registered or not, with its reconciliation status and its cost kept
--                                strictly apart: a recorded provider cost (from the recurring-fee lifecycle's own exposure rows) is shown only when it exists; otherwise the
--                                cost is explicitly UNKNOWN (null), never zero and never estimated here.
--   * tw4_prov_orphan_alert_status  where each orphan alert stands in the lifecycle's existing alert queue and the existing outbound email queue: waiting (and whether
--                                delivery is switched off), claimed, failed (will retry / exhausted), handed to the outbound queue, queued-not-sent, sent, send failed,
--                                and whether an exhausted delivery was escalated. A queued notification is never reported as delivered.
--
-- Nothing here writes: both functions are STABLE, create no studio charge, touch no credit reservation, no pilot ceiling, no sender, no orphan row and no alert.
-- They reuse the lifecycle's ledger (studio_sms_provider_resources / _exposure / _alerts / studio_sms_rfl_alert_deliveries) and the outbound email queue
-- (outbound_deliveries); they add no ledger and no delivery system. Registered orphans are already rows of tw4_rfl_exposure_report: each registered resource is
-- counted ONCE in the aggregate here, and the report says so, so a caller never adds the two reports together.
--
-- Requires 20261212090000 (orphans) and 20261211090000 (RFL ops: delivery switch and delivery records). Apply in numeric order.

do $$
begin
  if to_regclass('public.studio_sms_prov_orphans') is null or to_regclass('public.studio_sms_rfl_alert_deliveries') is null
     or to_regprocedure('public.tw4_rfl_switch_enabled(text)') is null or to_regclass('public.outbound_deliveries') is null then
    raise exception 'orphan exposure views require the fee-resolution evidence (20261212090000) and RFL ops (20261211090000) migrations';
  end if;
end $$;

create or replace function public.tw4_prov_orphan_exposure(p_actor uuid, p_legal_entity_id uuid default null, p_include_closed boolean default false)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v jsonb;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  with base as (
    select x.id as orphan_id, x.legal_entity_id, x.studio_id, x.twilio_account_sid, x.resource_kind, x.provider_sid, x.scope_sid, x.status,
           x.discovered_at, x.registered_at, x.closed_at, x.rfl_resource_id,
           floor(extract(epoch from clock_timestamp() - x.discovered_at) / 86400)::int as age_days,
           case when clock_timestamp() - x.discovered_at <= interval '8 days' - interval '1 microsecond' then '0-7'
                when clock_timestamp() - x.discovered_at < interval '31 days' then '8-30'
                when clock_timestamp() - x.discovered_at < interval '91 days' then '31-90' else '90+' end as aging_bucket,
           (select r.provider_state from public.studio_sms_provider_resources r where r.id = x.rfl_resource_id) as rfl_provider_state,
           c.n_rows, c.n_open, c.expected, c.billed,
           -- one registered resource is one exposure: a SID that was closed and later reappeared can have two orphan rows for the same resource
           (x.rfl_resource_id is null or row_number() over (partition by x.rfl_resource_id order by (x.status = 'closed'), x.discovered_at, x.id) = 1) as counted
      from public.studio_sms_prov_orphans x
      left join lateral (
        select count(*)::int as n_rows, (count(*) filter (where e.state = 'open'))::int as n_open,
               sum(e.expected_provider_cents) filter (where e.state = 'open')::bigint as expected, sum(e.provider_billed_cents) filter (where e.state = 'open')::bigint as billed
          from public.studio_sms_provider_exposure e where e.resource_id = x.rfl_resource_id) c on x.rfl_resource_id is not null
     where (p_legal_entity_id is null or x.legal_entity_id = p_legal_entity_id) and (p_include_closed or x.status <> 'closed')
  ), shaped as (
    select b.*,
           (b.rfl_resource_id is not null) as registered,
           case b.status when 'open' then 'unreconciled' when 'registered' then 'registered_in_lifecycle' else 'closed' end as reconciliation,
           case when b.rfl_resource_id is null or coalesce(b.n_rows, 0) = 0 then 'unknown' when b.n_open > 0 then 'recorded' else 'none_open' end as cost_basis
      from base b
  )
  select jsonb_build_object(
    'orphans', coalesce(jsonb_agg(jsonb_build_object(
      'orphan_id', s.orphan_id, 'legal_entity_id', s.legal_entity_id, 'studio_id', s.studio_id, 'twilio_account_sid', s.twilio_account_sid,
      'resource_kind', s.resource_kind, 'provider_sid', s.provider_sid, 'scope_sid', s.scope_sid,
      'provider_owned', true, 'ownership', 'provider resource not accounted for by the ledger and never requested by the studio',
      'status', s.status, 'registration', case when s.registered then 'registered' else 'unregistered' end, 'reconciliation', s.reconciliation,
      'rfl_resource_id', s.rfl_resource_id, 'rfl_provider_state', s.rfl_provider_state,
      'discovered_at', s.discovered_at, 'registered_at', s.registered_at, 'closed_at', s.closed_at, 'age_days', s.age_days, 'aging_bucket', s.aging_bucket,
      'blocks_fee_bearing_operations', s.status <> 'closed',
      'cost', jsonb_build_object(
        'basis', s.cost_basis,
        'known', s.cost_basis <> 'unknown',
        'provider_billed_cents', case when s.cost_basis = 'recorded' then s.billed end,
        'expected_provider_cents_estimate', case when s.cost_basis = 'recorded' then s.expected end,
        'open_exposure_periods', case when s.cost_basis <> 'unknown' then s.n_open end,
        'closed_exposure_periods', case when s.cost_basis <> 'unknown' then s.n_rows - s.n_open end,
        'in_rfl_exposure_report', s.registered,
        'counted_in_aggregate', s.counted)
    ) order by s.discovered_at, s.orphan_id), '[]'::jsonb),
    'aggregate', jsonb_build_object(
      'open_unregistered', count(*) filter (where s.status = 'open'),
      'registered', count(*) filter (where s.status = 'registered'),
      'closed', count(*) filter (where s.status = 'closed'),
      'cost_unknown', count(*) filter (where s.status <> 'closed' and s.cost_basis = 'unknown'),
      -- OPEN exposure periods of REGISTERED orphans only (the rows tw4_rfl_exposure_report lists), each registered resource once; null when nothing is open or recorded.
      -- Closed periods (covered, cancelled, absorbed, not billed) are history, not exposure. Unregistered orphans never contribute an amount.
      'provider_billed_cents', sum(s.billed) filter (where s.status = 'registered' and s.counted and s.cost_basis = 'recorded'),
      'expected_provider_cents_estimate', sum(s.expected) filter (where s.status = 'registered' and s.counted and s.cost_basis = 'recorded'),
      'registered_amounts_overlap_rfl_exposure_report', true),
    'notes', jsonb_build_array(
      'Unregistered orphans have no recorded cost: the amount is unknown, not zero.',
      'Amounts are OPEN lifecycle exposure periods only; closed periods are history.',
      'Registered orphans are lifecycle resources: their amounts are the lifecycle exposure rows and are already in tw4_rfl_exposure_report; do not add the two.',
      'Past unauthorized provider charges are borne by DanceFlow; nothing here charges a studio.'))
    into v
    from shaped s;
  return v;
end $$;

create or replace function public.tw4_prov_orphan_alert_status(p_actor uuid, p_legal_entity_id uuid default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v jsonb;
  v_enabled boolean;
begin
  if not public._tw4_r1_is_platform_admin(p_actor) then
    raise exception 'actor must be a platform admin' using errcode = '42501';
  end if;
  v_enabled := public.tw4_rfl_switch_enabled('delivery');
  select jsonb_build_object(
    'delivery_enabled', v_enabled,
    'meaning', jsonb_build_object(
      'alert_status_delivered', 'handed to the outbound email queue; it is not proof that a mailbox received anything',
      'send_state_sent', 'the outbound queue reports the message as sent to the mail provider (mailbox delivery is not tracked)'),
    'alerts', coalesce(jsonb_agg(row_data order by (row_data ->> 'created_at'), (row_data ->> 'alert_id')), '[]'::jsonb))
    into v
    from (
      select jsonb_build_object(
        'alert_id', a.id, 'orphan_id', o.id, 'legal_entity_id', a.legal_entity_id, 'studio_id', a.studio_id,
        'audience', a.audience, 'severity', a.severity, 'dedupe_key', a.dedupe_key, 'status', a.status, 'attempts', a.attempts,
        'created_at', a.created_at, 'claimed_at', a.claimed_at, 'delivered_at', a.delivered_at, 'last_error', a.last_error,
        'phase', case a.status
                   when 'pending' then case when v_enabled then 'waiting_for_delivery_worker' else 'waiting_delivery_disabled' end
                   when 'sending' then case when a.claimed_at >= now() - interval '15 minutes' then 'claimed_in_progress'
                                            when a.attempts >= 5 then 'failed_exhausted'
                                            when v_enabled then 'claim_abandoned_will_retry' else 'claim_abandoned_delivery_disabled' end
                   when 'failed' then case when a.attempts >= 5 then 'failed_exhausted' when v_enabled then 'failed_will_retry' else 'failed_delivery_disabled' end
                   else 'handed_to_outbound_queue' end,
        'escalated', exists (select 1 from public.studio_sms_provider_alerts z where z.kind = 'alert_delivery_exhausted' and z.dedupe_key = 'exhausted:' || a.id),
        'recipients', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'recipient_ref', d.recipient_ref, 'recipient_kind', d.recipient_kind, 'record_outcome', d.outcome, 'recorded_at', d.recorded_at,
                   'send_state', case
                     when d.outcome in ('invalid_recipient', 'no_recipient') then d.outcome
                     when q.id is null then 'queued_unconfirmed'
                     when q.status = 'sent' then 'sent'
                     when q.status = 'queued' then 'queued_not_sent'
                     when q.status = 'failed' then 'send_failed'
                     else q.status end,
                   'sent_at', q.sent_at) order by d.recipient_ref)
            from public.studio_sms_rfl_alert_deliveries d
            left join public.outbound_deliveries q on q.dedupe_key = 'rfl:' || a.id || ':' || d.recipient_ref
           where d.alert_id = a.id), '[]'::jsonb)
      ) as row_data
        from public.studio_sms_provider_alerts a
        join public.studio_sms_prov_orphans o on o.id::text = split_part(a.dedupe_key, ':', 2)
       where a.kind = 'inventory_gap' and a.dedupe_key like 'prov_orphan:%' and split_part(a.dedupe_key, ':', 3) in ('owner', 'admin') and (p_legal_entity_id is null or a.legal_entity_id = p_legal_entity_id)
    ) t;
  return v;
end $$;

revoke all on function public.tw4_prov_orphan_exposure(uuid, uuid, boolean), public.tw4_prov_orphan_alert_status(uuid, uuid) from public, anon, authenticated;
grant execute on function public.tw4_prov_orphan_exposure(uuid, uuid, boolean), public.tw4_prov_orphan_alert_status(uuid, uuid) to service_role;

do $$
begin
  if has_function_privilege('anon', 'public.tw4_prov_orphan_exposure(uuid,uuid,boolean)', 'EXECUTE') or has_function_privilege('authenticated', 'public.tw4_prov_orphan_exposure(uuid,uuid,boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.tw4_prov_orphan_alert_status(uuid,uuid)', 'EXECUTE') or has_function_privilege('authenticated', 'public.tw4_prov_orphan_alert_status(uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.tw4_prov_orphan_exposure(uuid,uuid,boolean)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.tw4_prov_orphan_alert_status(uuid,uuid)', 'EXECUTE') then
    raise exception 'orphan exposure views postcondition failed: unexpected privileges';
  end if;
end $$;

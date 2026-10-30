-- 20270202100000_apply_studio_subscription_state_rpc.sql
-- BILLING-QA-6 (issue #354 R-B, P2 residual): ONE transaction, under a row lock, applies a Stripe subscription read to
--   studio_subscriptions + the studios billing snapshot + the Organizer Suite add-on entitlements, so a slower delivery that read an
--   older Stripe state can no longer overwrite the snapshot or entitlements a newer delivery already wrote.
--   * Serialization point: SELECT ... FOR UPDATE on the studios row. A read stamped OLDER than studio_subscriptions.stripe_state_read_at
--     returns 'stale' and writes nothing. An unstamped read (event-payload fallback) applies without moving the watermark.
--   * billing_plan changes only when the caller passes a valid plan and the studio has no billing override (as before).
--   * Add-on entitlements: keyed by the Stripe subscription ITEM id (update, else insert); manual rows are never touched; an item owned by
--     another studio raises. No ON CONFLICT (studio_id, feature_key) constraint is relied on (the repo has none).
--   * The BILLING-QA-3 superseded rule is re-checked under the lock and returns 'superseded' (no writes).
--   * Service role only (security definer, search_path pinned, no grants to anon/authenticated/public).
-- Requires 20270202090000 (stripe_state_read_at). Rollback: rollback/20270202100000_apply_studio_subscription_state_rpc_rollback.sql (app first).
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'studio_subscriptions' and column_name = 'stripe_state_read_at'
  ) then
    raise exception 'apply_studio_subscription_state precondition failed: run 20270202090000 first';
  end if;
  if to_regclass('public.usage_addon_entitlements') is null then
    raise exception 'apply_studio_subscription_state precondition failed: public.usage_addon_entitlements is missing';
  end if;
end $$;

create or replace function public.apply_studio_subscription_state(
  p_studio_id uuid,
  p_subscription jsonb,
  p_read_started_at timestamptz,
  p_snapshot jsonb,
  p_addon jsonb
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '10s'
as $fn$
declare
  v_existing_id uuid;
  v_existing_watermark timestamptz;
  v_now timestamptz := now();
  v_item_id text;
  v_active boolean;
  v_item_ids text[];
  v_owner uuid;
  v_existing_sub_id text;
  v_existing_status text;
begin
  if p_studio_id is null or p_subscription is null or p_snapshot is null then
    raise exception 'apply_studio_subscription_state: studio, subscription and snapshot are required';
  end if;

  -- Serialization point: every apply for one studio queues here.
  perform 1 from public.studios where id = p_studio_id for no key update;
  if not found then
    raise exception 'apply_studio_subscription_state: studio % not found', p_studio_id;
  end if;

  select id, stripe_state_read_at, stripe_subscription_id, status
  into v_existing_id, v_existing_watermark, v_existing_sub_id, v_existing_status
  from public.studio_subscriptions where studio_id = p_studio_id for update;

  -- BILLING-QA-3 superseded rule, re-checked UNDER the lock (the app's pre-check read is unlocked): a different subscription that is
  -- no longer live must not overwrite the studio's live one, whatever its read stamp.
  if v_existing_id is not null and v_existing_sub_id is not null
     and v_existing_sub_id is distinct from p_subscription->>'stripe_subscription_id'
     and v_existing_status in ('trialing', 'active', 'past_due')
     and (p_subscription->>'status') not in ('trialing', 'active', 'past_due') then
    return 'superseded';
  end if;

  if v_existing_id is not null and p_read_started_at is not null
     and v_existing_watermark is not null and v_existing_watermark > p_read_started_at then
    return 'stale';
  end if;

  if v_existing_id is not null then
    update public.studio_subscriptions set
      subscription_plan_id = (p_subscription->>'subscription_plan_id')::uuid,
      stripe_subscription_id = p_subscription->>'stripe_subscription_id',
      status = p_subscription->>'status',
      billing_interval = p_subscription->>'billing_interval',
      current_period_start = (p_subscription->>'current_period_start')::timestamptz,
      current_period_end = (p_subscription->>'current_period_end')::timestamptz,
      cancel_at_period_end = coalesce((p_subscription->>'cancel_at_period_end')::boolean, false),
      cancelled_at = (p_subscription->>'cancelled_at')::timestamptz,
      ended_at = (p_subscription->>'ended_at')::timestamptz,
      updated_at = v_now,
      stripe_state_read_at = coalesce(p_read_started_at, stripe_state_read_at)
    where id = v_existing_id;
  else
    insert into public.studio_subscriptions (
      studio_id, subscription_plan_id, stripe_subscription_id, status, billing_interval,
      current_period_start, current_period_end, cancel_at_period_end, cancelled_at, ended_at,
      created_at, updated_at, stripe_state_read_at
    ) values (
      p_studio_id,
      (p_subscription->>'subscription_plan_id')::uuid,
      p_subscription->>'stripe_subscription_id',
      p_subscription->>'status',
      p_subscription->>'billing_interval',
      (p_subscription->>'current_period_start')::timestamptz,
      (p_subscription->>'current_period_end')::timestamptz,
      coalesce((p_subscription->>'cancel_at_period_end')::boolean, false),
      (p_subscription->>'cancelled_at')::timestamptz,
      (p_subscription->>'ended_at')::timestamptz,
      v_now, v_now, p_read_started_at
    );
  end if;

  update public.studios set
    stripe_customer_id = p_snapshot->>'stripe_customer_id',
    stripe_subscription_id = p_snapshot->>'stripe_subscription_id',
    subscription_status = p_snapshot->>'subscription_status',
    trial_ends_at = (p_snapshot->>'trial_ends_at')::timestamptz,
    updated_at = v_now
  where id = p_studio_id;

  -- Comped/ambassador studios (billing_override_enabled) keep their own plan; the app passes only a valid Starter/Growth/Pro.
  if nullif(p_snapshot->>'billing_plan', '') is not null then
    update public.studios set billing_plan = (p_snapshot->>'billing_plan')::public.billing_plan
    where id = p_studio_id and coalesce(billing_override_enabled, false) = false;
  end if;

  if p_addon is not null then
    v_active := coalesce((p_addon->>'active')::boolean, false);
    select coalesce(array_agg(value), '{}') into v_item_ids
    from jsonb_array_elements_text(coalesce(p_addon->'item_ids', '[]'::jsonb));

    -- Keyed by the Stripe subscription ITEM id (the only unique key; a studio can hold several historical rows after remove + re-add).
    -- Never touches manual/comped rows, never rewrites another row's item id, and refuses an item that belongs to another studio.
    foreach v_item_id in array v_item_ids loop
      select studio_id into v_owner from public.usage_addon_entitlements where stripe_subscription_item_id = v_item_id;
      if found and v_owner is distinct from p_studio_id then
        raise exception 'apply_studio_subscription_state: subscription item % belongs to another studio', v_item_id;
      end if;
      if found then
        update public.usage_addon_entitlements set
          workspace_type = 'studio', feature_key = 'organizer_suite', source = 'stripe_subscription_item',
          quantity_included = 1, status = case when v_active then 'active' else 'canceled' end, updated_at = v_now
        where stripe_subscription_item_id = v_item_id and studio_id = p_studio_id;
      else
        insert into public.usage_addon_entitlements (
          studio_id, workspace_type, feature_key, source, stripe_subscription_item_id, quantity_included, status, updated_at
        ) values (
          p_studio_id, 'studio', 'organizer_suite', 'stripe_subscription_item', v_item_id, 1,
          case when v_active then 'active' else 'canceled' end, v_now
        );
      end if;
    end loop;

    update public.usage_addon_entitlements set status = 'canceled', updated_at = v_now
    where studio_id = p_studio_id and feature_key = 'organizer_suite' and source = 'stripe_subscription_item'
      and status = 'active'
      and (stripe_subscription_item_id is null or not (stripe_subscription_item_id = any (v_item_ids)) or not v_active);
  end if;

  return 'applied';
end;
$fn$;

revoke all on function public.apply_studio_subscription_state(uuid, jsonb, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_studio_subscription_state(uuid, jsonb, timestamptz, jsonb, jsonb) to service_role;

commit;

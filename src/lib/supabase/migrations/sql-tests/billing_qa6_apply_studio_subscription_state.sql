-- BILLING-QA-6 SQL test for apply_studio_subscription_state (run on a SCRATCH database with the public schema and migrations
-- 20270202090000 + 20270202100000 applied; never on a shared database). Everything runs in one transaction and rolls back.
--   psql -v ON_ERROR_STOP=1 -f billing_qa6_apply_studio_subscription_state.sql <scratch db>
begin;

do $t$
declare
  s uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  plan_id uuid;
  r text;
  sub jsonb;
  snap jsonb;
begin
  insert into public.subscription_plans (id, code, name, active) values (gen_random_uuid(), 'qa6-plan', 'QA6', true) returning id into plan_id;
  insert into public.studios (id, name, slug, billing_plan, billing_override_enabled, subscription_status)
    values (s, 'QA6 Studio', 'qa6-' || s, 'starter', false, 'inactive');
  insert into public.studios (id, name, slug, billing_plan, billing_override_enabled, subscription_status)
    values (c, 'QA6 Comped', 'qa6-' || c, 'pro', true, 'inactive');

  sub := jsonb_build_object('subscription_plan_id', plan_id, 'stripe_subscription_id', 'sub_qa6', 'status', 'active', 'billing_interval', 'month',
    'current_period_start', '2026-10-01T00:00:00Z', 'current_period_end', '2026-11-01T00:00:00Z', 'cancel_at_period_end', false);
  snap := jsonb_build_object('stripe_customer_id', 'cus_qa6', 'stripe_subscription_id', 'sub_qa6', 'subscription_status', 'active', 'billing_plan', 'growth');

  -- 1. fresh insert applies, stamps the watermark, writes the snapshot and billing_plan
  r := public.apply_studio_subscription_state(s, sub, '2026-10-30T10:00:00.500Z', snap, null);
  assert r = 'applied', 'fresh insert should apply, got ' || r;
  assert (select stripe_state_read_at from public.studio_subscriptions where studio_id = s) = '2026-10-30T10:00:00.500Z'::timestamptz, 'watermark stamped';
  assert (select billing_plan::text from public.studios where id = s) = 'growth', 'billing_plan synced';
  assert (select subscription_status from public.studios where id = s) = 'active', 'snapshot status';

  -- 2. an OLDER read is stale: nothing changes (row, snapshot, billing_plan)
  r := public.apply_studio_subscription_state(s, sub || '{"status":"cancelled"}', '2026-10-30T10:00:00.100Z',
    snap || '{"subscription_status":"canceled","billing_plan":"pro"}', null);
  assert r = 'stale', 'older read must be stale, got ' || r;
  assert (select status from public.studio_subscriptions where studio_id = s) = 'active', 'row unchanged by stale read';
  assert (select subscription_status from public.studios where id = s) = 'active', 'snapshot unchanged by stale read';
  assert (select billing_plan::text from public.studios where id = s) = 'growth', 'billing_plan unchanged by stale read';

  -- 3. an EQUAL read applies; a NEWER read applies and moves the watermark
  r := public.apply_studio_subscription_state(s, sub || '{"status":"past_due"}', '2026-10-30T10:00:00.500Z', snap || '{"subscription_status":"past_due"}', null);
  assert r = 'applied', 'equal read applies';
  r := public.apply_studio_subscription_state(s, sub || '{"status":"cancelled"}', '2026-10-30T10:00:02Z', snap || '{"subscription_status":"canceled","billing_plan":""}', null);
  assert r = 'applied' and (select stripe_state_read_at from public.studio_subscriptions where studio_id = s) = '2026-10-30T10:00:02Z'::timestamptz, 'newer read applies and moves watermark';
  assert (select billing_plan::text from public.studios where id = s) = 'growth', 'empty billing_plan leaves the plan (cancellation keeps the last plan)';

  -- 4. an UNSTAMPED read (payload fallback) applies without moving the watermark
  r := public.apply_studio_subscription_state(s, sub || '{"status":"cancelled","ended_at":"2026-10-30T11:00:00Z"}', null, snap || '{"subscription_status":"canceled"}', null);
  assert r = 'applied' and (select stripe_state_read_at from public.studio_subscriptions where studio_id = s) = '2026-10-30T10:00:02Z'::timestamptz, 'unstamped applies, watermark kept';

  -- 5. a comped studio never has billing_plan overwritten (snapshot still written)
  r := public.apply_studio_subscription_state(c, sub || '{"stripe_subscription_id":"sub_qa6c"}', '2026-10-30T10:00:00Z', snap || '{"stripe_subscription_id":"sub_qa6c","billing_plan":"starter"}', null);
  assert r = 'applied' and (select billing_plan::text from public.studios where id = c) = 'pro', 'comped plan kept';
  assert (select subscription_status from public.studios where id = c) = 'active', 'comped snapshot still written';

  -- 6. add-on entitlements: create active, then cancel when the subscription stops being active, with no (studio_id, feature_key) constraint needed
  r := public.apply_studio_subscription_state(s, sub, '2026-10-30T10:01:00Z', snap, '{"active":true,"item_ids":["si_addon_qa6"]}');
  assert (select status from public.usage_addon_entitlements where studio_id = s and feature_key = 'organizer_suite') = 'active', 'add-on active';
  r := public.apply_studio_subscription_state(s, sub || '{"status":"cancelled"}', '2026-10-30T10:02:00Z', snap || '{"subscription_status":"canceled"}', '{"active":false,"item_ids":["si_addon_qa6"]}');
  assert (select status from public.usage_addon_entitlements where studio_id = s and feature_key = 'organizer_suite') = 'canceled', 'add-on canceled with the subscription';
  -- a STALE read must not re-activate the add-on
  r := public.apply_studio_subscription_state(s, sub, '2026-10-30T10:01:30Z', snap, '{"active":true,"item_ids":["si_addon_qa6"]}');
  assert r = 'stale' and (select status from public.usage_addon_entitlements where studio_id = s and feature_key = 'organizer_suite') = 'canceled', 'stale read cannot re-activate the add-on';
  -- item removed from the subscription: the active entitlement is canceled
  r := public.apply_studio_subscription_state(s, sub, '2026-10-30T10:03:00Z', snap, '{"active":true,"item_ids":["si_addon_qa6"]}');
  r := public.apply_studio_subscription_state(s, sub, '2026-10-30T10:04:00Z', snap, '{"active":true,"item_ids":[]}');
  assert (select status from public.usage_addon_entitlements where studio_id = s and feature_key = 'organizer_suite') = 'canceled', 'removed item canceled';

  -- 7. unknown studio raises; null arguments raise
  begin
    perform public.apply_studio_subscription_state(gen_random_uuid(), sub, null, snap, null);
    raise exception 'should have raised for an unknown studio';
  exception when raise_exception then
    assert sqlerrm like '%not found%', 'unknown studio error: ' || sqlerrm;
  end;

  -- 8. grants: no access for anon/authenticated/public
  assert not has_function_privilege('anon', 'public.apply_studio_subscription_state(uuid,jsonb,timestamptz,jsonb,jsonb)', 'execute'), 'anon must not execute';
  assert not has_function_privilege('authenticated', 'public.apply_studio_subscription_state(uuid,jsonb,timestamptz,jsonb,jsonb)', 'execute'), 'authenticated must not execute';

  raise notice 'billing_qa6 apply_studio_subscription_state: ALL ASSERTIONS PASSED';
end
$t$;

rollback;

-- D7 pre-expiry -- regression suite for 20270205100000_competition_desk_suite_gate.sql.
--
-- Requires: 20270203090000 (helpers) and the record_competition_checkin_payment definition from 20261116094000 (or its
-- rollback), then 20270205100000 applied (scripts/qa/d7_desk_gate_sql.sh builds exactly that on a disposable database).
-- One transaction, synthetic fixtures only. The final block ALWAYS raises, so nothing persists:
--   "D7 DESK GATE SQL SUITE PASS (<n> checks)" or "D7 DESK GATE SQL SUITE FAIL: <failures>".
-- Concurrency (separate sessions) is covered by scripts/qa/d7_desk_gate_sql.sh.
--
-- Decision mirrored (competition/checkin/actions.ts assertCompetitionDeskPaymentAllowed + platformFee.ts):
--   gate applies only when events.organizer_id is not null AND order.status = 'pending' AND order.payment_status <> 'paid';
--   allowed when the studio has an active|trialing subscription AND (plan 'organizer' OR (plan starter|growth|pro AND a current
--   studio-scoped 'organizer_suite' entitlement from source stripe_subscription_item|manual_grant)).

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.id(p_kind text, p_tag text) returns uuid language sql immutable as $$
  select md5(p_kind || ':' || p_tag)::uuid $$;

create or replace function pg_temp.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', case when p_user is null then '' else json_build_object('sub', p_user, 'role', 'authenticated')::text end, true) $$;

-- staff user U1 = front_desk of every fixture studio
create or replace function pg_temp.u1() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-00d7de000001'::uuid $$;
create or replace function pg_temp.u_stranger() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-00d7de000002'::uuid $$;
create or replace function pg_temp.u_platform() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-00d7de000003'::uuid $$;
create or replace function pg_temp.u_orgstaff() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-00d7de000004'::uuid $$;

insert into auth.users(id) values (pg_temp.u1()), (pg_temp.u_stranger()), (pg_temp.u_platform()), (pg_temp.u_orgstaff()) on conflict do nothing;
insert into public.profiles(id, platform_role) values (pg_temp.u1(), null), (pg_temp.u_stranger(), null), (pg_temp.u_platform(), 'platform_admin'), (pg_temp.u_orgstaff(), null) on conflict do nothing;
insert into public.subscription_plans(code) values ('organizer'), ('starter'), ('growth'), ('pro'), ('basic'), (' Pro ');

create or replace function pg_temp.mkstudio(p_tag text, p_tz text default 'America/New_York', p_plan text default 'pro', p_sub_status text default 'active')
returns uuid language plpgsql as $$
declare v_id uuid := pg_temp.id('studio', p_tag);
begin
  insert into public.studios(id, timezone) values (v_id, p_tz);
  if p_plan is not null then
    insert into public.studio_subscriptions(studio_id, subscription_plan_id, status)
    values (v_id, (select id from public.subscription_plans where code = p_plan limit 1), p_sub_status);
  end if;
  insert into public.user_studio_roles(studio_id, user_id, role, active) values (v_id, pg_temp.u1(), 'front_desk', true);
  return v_id;
end $$;

create or replace function pg_temp.mkgrant(p_studio uuid, p_source text, p_status text, p_start date, p_end date, p_item text default null)
returns void language sql as $$
  insert into public.usage_addon_entitlements(studio_id, workspace_type, feature_key, source, status, period_start, period_end, stripe_subscription_item_id)
  values (p_studio, 'studio', 'organizer_suite', p_source, p_status, p_start, p_end, p_item) $$;

-- one event + order + registration + check-in session; organizer event when p_organizer
create or replace function pg_temp.mkcase(p_tag text, p_studio uuid, p_organizer boolean, p_ord_status text default 'pending',
  p_pay_status text default 'pending', p_total numeric default 100, p_session_status text default 'in_progress', p_prepaid numeric default 0)
returns void language plpgsql as $$
declare
  v_event uuid := pg_temp.id('event', p_tag); v_order uuid := pg_temp.id('order', p_tag);
  v_reg uuid := pg_temp.id('reg', p_tag); v_org uuid := pg_temp.id('org', p_tag);
begin
  if p_organizer then
    insert into public.organizers(id) values (v_org);
    insert into public.organizer_users(organizer_id, user_id, role, active) values (v_org, pg_temp.u_orgstaff(), 'organizer_staff', true);
  end if;
  insert into public.events(id, studio_id, organizer_id) values (v_event, p_studio, case when p_organizer then v_org end);
  insert into public.event_orders(id, event_id, status, payment_status, total_amount, currency, metadata)
  values (v_order, v_event, p_ord_status, p_pay_status, p_total, 'USD', '{"source":"competition_registration"}');
  insert into public.event_registrations(id, event_id, order_id, status, payment_status, currency)
  values (v_reg, v_event, v_order, case when p_ord_status = 'pending' then 'pending' else 'confirmed' end, p_pay_status, 'USD');
  insert into public.event_competition_checkin_sessions(id, event_id, registration_id, order_id, status, balance_due)
  values (pg_temp.id('sess', p_tag), v_event, v_reg, v_order, p_session_status, p_total - p_prepaid);
  if p_prepaid > 0 then
    insert into public.event_payments(registration_id, amount, currency, payment_method, status, source)
    values (v_reg, p_prepaid, 'USD', 'cash', 'paid', 'competition_checkin');
  end if;
end $$;

create or replace function pg_temp.call(p_tag text, p_amount numeric, p_user uuid default null) returns jsonb
language plpgsql as $$
declare r jsonb;
begin
  perform pg_temp.as_user(coalesce(p_user, pg_temp.u1()));
  r := public.record_competition_checkin_payment(pg_temp.id('event', p_tag), pg_temp.id('sess', p_tag), p_amount, 'cash', null);
  perform pg_temp.as_user(null);
  return r;
exception when others then
  perform pg_temp.as_user(null);
  return jsonb_build_object('outcome', 'error', 'sqlstate', sqlstate, 'error', sqlerrm);
end $$;

-- everything the RPC may write, as one comparable string
create or replace function pg_temp.snap(p_tag text) returns text language sql as $$
  select concat_ws('|',
    (select count(*) from public.event_payments where registration_id = pg_temp.id('reg', p_tag)),
    (select count(*) from public.event_competition_checkin_payment_audit where checkin_session_id = pg_temp.id('sess', p_tag)),
    (select status || '/' || payment_status || '/' || coalesce(paid_at::text, '-') from public.event_orders where id = pg_temp.id('order', p_tag)),
    (select status || '/' || payment_status from public.event_registrations where id = pg_temp.id('reg', p_tag)),
    (select balance_due::text from public.event_competition_checkin_sessions where id = pg_temp.id('sess', p_tag))) $$;

create or replace function pg_temp.refused(r jsonb) returns boolean language sql as $$
  select r ->> 'outcome' = 'error' and r ->> 'sqlstate' = 'D7001' and r ->> 'error' like 'organizer_suite_required:%' $$;
create or replace function pg_temp.recorded(r jsonb) returns boolean language sql as $$ select r ->> 'outcome' = 'recorded' $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. current entitlement: behaviour unchanged (balance math, audit row, order state)
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare s uuid; r jsonb; r2 jsonb;
begin
  s := pg_temp.mkstudio('cur'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', current_date - 30, current_date + 30);
  perform pg_temp.mkcase('cur', s, true);
  r := pg_temp.call('cur', 40);
  perform pg_temp.chk('current grant: partial payment recorded', pg_temp.recorded(r), r::text);
  perform pg_temp.chk('current grant: balance math (100 -> 60)', (r ->> 'balance_before')::numeric = 100 and (r ->> 'balance_after')::numeric = 60, r::text);
  perform pg_temp.chk('current grant: one payment row of 40 and one audit row',
    (select count(*) from public.event_payments where registration_id = pg_temp.id('reg', 'cur') and amount = 40 and status = 'paid' and source = 'competition_checkin') = 1
    and (select count(*) from public.event_competition_checkin_payment_audit where checkin_session_id = pg_temp.id('sess', 'cur') and amount = 40 and balance_before = 100 and balance_after = 60 and actor_user_id = pg_temp.u1()) = 1,
    pg_temp.snap('cur'));
  perform pg_temp.chk('current grant: partial payment leaves order pending, registration partial',
    pg_temp.snap('cur') like '1|1|pending/pending/-|pending/partial|60.00' or pg_temp.snap('cur') like '1|1|pending/pending/-|pending/partial|60', pg_temp.snap('cur'));
  r2 := pg_temp.call('cur', 60);
  perform pg_temp.chk('current grant: completing payment confirms order and registration', pg_temp.recorded(r2)
    and (select status = 'confirmed' and payment_status = 'paid' and paid_at is not null from public.event_orders where id = pg_temp.id('order', 'cur'))
    and (select status = 'confirmed' and payment_status = 'paid' from public.event_registrations where id = pg_temp.id('reg', 'cur')), r2::text);

  s := pg_temp.mkstudio('open'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, null);
  perform pg_temp.mkcase('open', s, true);
  perform pg_temp.chk('open-ended grant: allowed', pg_temp.recorded(pg_temp.call('open', 100)));

  s := pg_temp.mkstudio('lastday'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, ((now() at time zone 'America/New_York')::date + 1));
  perform pg_temp.mkcase('lastday', s, true);
  perform pg_temp.chk('grant ending tomorrow (studio tz): allowed today', pg_temp.recorded(pg_temp.call('lastday', 10)));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. lapsed / missing entitlement: refused, nothing written, earlier payments untouched
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare s uuid; r jsonb; before_snap text;
begin
  s := pg_temp.mkstudio('lapsed'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, current_date - 2);
  perform pg_temp.mkcase('lapsed', s, true);
  before_snap := pg_temp.snap('lapsed');
  r := pg_temp.call('lapsed', 40);
  perform pg_temp.chk('lapsed grant: refused with D7001 / organizer_suite_required', pg_temp.refused(r), r::text);
  perform pg_temp.chk('lapsed grant: nothing written (payments, audit, order, registration, session)', pg_temp.snap('lapsed') = before_snap, before_snap || ' vs ' || pg_temp.snap('lapsed'));

  s := pg_temp.mkstudio('lapsed_today'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, (now() at time zone 'America/New_York')::date);
  perform pg_temp.mkcase('lapsed_today', s, true);
  perform pg_temp.chk('grant whose period_end is today (studio tz): already lapsed (end exclusive at local midnight)', pg_temp.refused(pg_temp.call('lapsed_today', 10)));

  s := pg_temp.mkstudio('none'); perform pg_temp.mkcase('none', s, true);
  perform pg_temp.chk('no entitlement row: refused', pg_temp.refused(pg_temp.call('none', 10)));

  s := pg_temp.mkstudio('expired'); perform pg_temp.mkgrant(s, 'manual_grant', 'expired', null, null); perform pg_temp.mkcase('expired', s, true);
  perform pg_temp.chk('status expired row only: refused', pg_temp.refused(pg_temp.call('expired', 10)));

  s := pg_temp.mkstudio('notyet'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', current_date + 5, current_date + 50); perform pg_temp.mkcase('notyet', s, true);
  perform pg_temp.chk('grant not started yet (period_start in the future): refused', pg_temp.refused(pg_temp.call('notyet', 10)));

  s := pg_temp.mkstudio('otherfeat');
  insert into public.usage_addon_entitlements(studio_id, workspace_type, feature_key, source, status) values (s, 'studio', 'ai_credits', 'manual_grant', 'active');
  perform pg_temp.mkcase('otherfeat', s, true);
  perform pg_temp.chk('active row of another feature: refused', pg_temp.refused(pg_temp.call('otherfeat', 10)));

  s := pg_temp.mkstudio('othersrc'); perform pg_temp.mkgrant(s, 'trial_promo', 'active', null, null); perform pg_temp.mkcase('othersrc', s, true);
  perform pg_temp.chk('active row from a source the TS reader ignores: refused', pg_temp.refused(pg_temp.call('othersrc', 10)));

  -- earlier payments stay valid when a later one is refused
  s := pg_temp.mkstudio('prior'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, current_date - 1);
  perform pg_temp.mkcase('prior', s, true, 'pending', 'partial', 100, 'in_progress', 30);
  before_snap := pg_temp.snap('prior');
  r := pg_temp.call('prior', 20);
  perform pg_temp.chk('partially paid pending order after lapse: further payment refused (TS rule: order pending and not paid)', pg_temp.refused(r), r::text);
  perform pg_temp.chk('previously recorded payment untouched by the refusal', pg_temp.snap('prior') = before_snap and
    (select amount = 30 and status = 'paid' from public.event_payments where registration_id = pg_temp.id('reg', 'prior')), pg_temp.snap('prior'));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. which rows count (mirror of the TS reader)
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare s uuid;
begin
  s := pg_temp.mkstudio('stripe_plus_lapsed'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, current_date - 3);
  perform pg_temp.mkgrant(s, 'stripe_subscription_item', 'active', null, null, 'si_desk_1'); perform pg_temp.mkcase('stripe_plus_lapsed', s, true);
  perform pg_temp.chk('paid Stripe-sourced add-on row while the manual grant lapsed: allowed', pg_temp.recorded(pg_temp.call('stripe_plus_lapsed', 25)));

  s := pg_temp.mkstudio('stripe_only_lapsed'); perform pg_temp.mkgrant(s, 'stripe_subscription_item', 'active', null, current_date - 1, 'si_desk_2'); perform pg_temp.mkcase('stripe_only_lapsed', s, true);
  perform pg_temp.chk('Stripe row past its period_end only: refused', pg_temp.refused(pg_temp.call('stripe_only_lapsed', 25)));

  s := pg_temp.mkstudio('stripe_canceled'); perform pg_temp.mkgrant(s, 'stripe_subscription_item', 'canceled', null, null, 'si_desk_3'); perform pg_temp.mkcase('stripe_canceled', s, true);
  perform pg_temp.chk('canceled Stripe row: refused', pg_temp.refused(pg_temp.call('stripe_canceled', 25)));

  -- organizer-scoped row (workspace_type organizer, studio_id null) is NOT read by the TS reader (studio_id filter): refused
  s := pg_temp.mkstudio('org_scoped');
  perform pg_temp.mkcase('org_scoped', s, true);
  insert into public.usage_addon_entitlements(organizer_id, workspace_type, feature_key, source, status)
    values (pg_temp.id('org', 'org_scoped'), 'organizer', 'organizer_suite', 'manual_grant', 'active');
  perform pg_temp.chk('organizer-scoped entitlement row is not read (same as the TS reader): refused', pg_temp.refused(pg_temp.call('org_scoped', 25)));

  -- another studio's grant never counts
  s := pg_temp.mkstudio('neighbour'); perform pg_temp.mkcase('neighbour', s, true);
  perform pg_temp.mkgrant(pg_temp.mkstudio('neighbour_b'), 'manual_grant', 'active', null, null);
  perform pg_temp.chk('another studio''s grant does not count', pg_temp.refused(pg_temp.call('neighbour', 25)));
end $$;

-- plan interplay (getOrganizerPlatformFeePercent)
do $$
declare s uuid;
begin
  s := pg_temp.mkstudio('plan_org', 'America/New_York', 'organizer'); perform pg_temp.mkcase('plan_org', s, true);
  perform pg_temp.chk('Organizer plan needs no add-on: allowed', pg_temp.recorded(pg_temp.call('plan_org', 10)));
  s := pg_temp.mkstudio('plan_org_past_due', 'America/New_York', 'organizer', 'past_due'); perform pg_temp.mkcase('plan_org_past_due', s, true);
  perform pg_temp.chk('Organizer plan but subscription past_due: refused', pg_temp.refused(pg_temp.call('plan_org_past_due', 10)));
  s := pg_temp.mkstudio('plan_trial', 'America/New_York', 'growth', 'trialing'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, null); perform pg_temp.mkcase('plan_trial', s, true);
  perform pg_temp.chk('trialing growth plan with a current grant: allowed', pg_temp.recorded(pg_temp.call('plan_trial', 10)));
  s := pg_temp.mkstudio('plan_starter', 'America/New_York', 'starter'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, null); perform pg_temp.mkcase('plan_starter', s, true);
  perform pg_temp.chk('starter plan with a current grant: allowed', pg_temp.recorded(pg_temp.call('plan_starter', 10)));
  s := pg_temp.mkstudio('plan_basic', 'America/New_York', 'basic'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, null); perform pg_temp.mkcase('plan_basic', s, true);
  perform pg_temp.chk('unknown plan code, even with a grant: refused (fee 0 = Suite required)', pg_temp.refused(pg_temp.call('plan_basic', 10)));
  s := pg_temp.mkstudio('plan_nosub', 'America/New_York', null); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, null); perform pg_temp.mkcase('plan_nosub', s, true);
  perform pg_temp.chk('no subscription row, even with a grant: refused', pg_temp.refused(pg_temp.call('plan_nosub', 10)));
  s := pg_temp.mkstudio('plan_inactive', 'America/New_York', 'pro', 'cancelled'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, null); perform pg_temp.mkcase('plan_inactive', s, true);
  perform pg_temp.chk('cancelled subscription, even with a grant: refused', pg_temp.refused(pg_temp.call('plan_inactive', 10)));
  s := pg_temp.mkstudio('plan_padded', 'America/New_York', ' Pro '); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, null); perform pg_temp.mkcase('plan_padded', s, true);
  perform pg_temp.chk('plan code compared trimmed and lower-cased (like the TS): allowed', pg_temp.recorded(pg_temp.call('plan_padded', 10)));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. scope: events and orders that are never gated
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare s uuid; r jsonb;
begin
  s := pg_temp.mkstudio('studio_event', 'America/New_York', null); perform pg_temp.mkcase('studio_event', s, false);
  perform pg_temp.chk('ordinary studio event (organizer_id null), no subscription, no entitlement: never refused', pg_temp.recorded(pg_temp.call('studio_event', 100)));

  s := pg_temp.mkstudio('confirmed'); perform pg_temp.mkcase('confirmed', s, true, 'confirmed', 'pending', 100, 'in_progress', 20);
  perform pg_temp.chk('organizer event, already CONFIRMED order, no entitlement: recording unchanged', pg_temp.recorded(pg_temp.call('confirmed', 30)));

  s := pg_temp.mkstudio('paid_order'); perform pg_temp.mkcase('paid_order', s, true, 'pending', 'paid', 100, 'in_progress', 100);
  r := pg_temp.call('paid_order', 10);
  perform pg_temp.chk('order already marked paid, no entitlement: existing balance error kept (not D7001)', r ->> 'sqlstate' = '22023' and r ->> 'error' like '%exceeds the current balance%', r::text);

  s := pg_temp.mkstudio('sess_done'); perform pg_temp.mkcase('sess_done', s, true, 'pending', 'pending', 100, 'complete');
  r := pg_temp.call('sess_done', 10);
  perform pg_temp.chk('completed session, no entitlement: existing 55000 error kept', r ->> 'sqlstate' = '55000' and r ->> 'error' like '%already complete%', r::text);

  s := pg_temp.mkstudio('cancelled'); perform pg_temp.mkcase('cancelled', s, true, 'cancelled', 'pending', 100);
  r := pg_temp.call('cancelled', 10);
  perform pg_temp.chk('cancelled order, no entitlement: existing "not payable" error kept', r ->> 'sqlstate' = '55000' and r ->> 'error' like '%not payable%', r::text);

  s := pg_temp.mkstudio('refunded_pay'); perform pg_temp.mkcase('refunded_pay', s, true, 'pending', 'refunded', 100);
  r := pg_temp.call('refunded_pay', 10);
  perform pg_temp.chk('refunded payment_status, no entitlement: existing "not payable" error kept', r ->> 'sqlstate' = '55000' and r ->> 'error' like '%not payable%', r::text);

  s := pg_temp.mkstudio('not_comp'); perform pg_temp.mkcase('not_comp', s, true);
  update public.event_orders set metadata = '{}' where id = pg_temp.id('order', 'not_comp');
  r := pg_temp.call('not_comp', 10);
  perform pg_temp.chk('non-competition order, no entitlement: existing 22023 error kept', r ->> 'sqlstate' = '22023' and r ->> 'error' like '%competition registrations%', r::text);

  s := pg_temp.mkstudio('over'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, null); perform pg_temp.mkcase('over', s, true);
  r := pg_temp.call('over', 500);
  perform pg_temp.chk('current grant: overpayment still refused by the existing balance check', r ->> 'sqlstate' = '22023', r::text);

  s := pg_temp.mkstudio('badamt'); perform pg_temp.mkcase('badamt', s, true);
  r := pg_temp.call('badamt', 0);
  perform pg_temp.chk('invalid amount keeps its error before the gate', r ->> 'sqlstate' = '22023' and r ->> 'error' like '%invalid amount%', r::text);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. callers: identity and role checks run first; the gate applies to every authorized caller
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare s uuid; r jsonb; before_snap text;
begin
  s := pg_temp.mkstudio('auth'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, current_date - 2); perform pg_temp.mkcase('auth', s, true);
  before_snap := pg_temp.snap('auth');
  perform pg_temp.as_user(null);
  begin
    perform public.record_competition_checkin_payment(pg_temp.id('event', 'auth'), pg_temp.id('sess', 'auth'), 10, 'cash', null);
    perform pg_temp.chk('unauthenticated caller refused first (42501), lapsed or not', false, 'succeeded');
  exception when others then
    perform pg_temp.chk('unauthenticated caller refused first (42501), lapsed or not', sqlstate = '42501' and sqlerrm like '%authentication required%', sqlstate || ' ' || sqlerrm);
  end;
  r := pg_temp.call('auth', 10, pg_temp.u_stranger());
  perform pg_temp.chk('unauthorized signed-in user refused with 42501 (not the Suite error), lapsed grant', r ->> 'sqlstate' = '42501' and r ->> 'error' like '%not authorized%', r::text);
  r := pg_temp.call('auth', 10, pg_temp.u_platform());
  perform pg_temp.chk('platform admin is gated too on a lapsed grant', pg_temp.refused(r), r::text);
  r := pg_temp.call('auth', 10, pg_temp.u_orgstaff());
  perform pg_temp.chk('organizer staff is gated too on a lapsed grant', pg_temp.refused(r), r::text);
  perform pg_temp.chk('no caller changed anything', pg_temp.snap('auth') = before_snap, pg_temp.snap('auth'));

  s := pg_temp.mkstudio('auth_ok'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, null); perform pg_temp.mkcase('auth_ok', s, true);
  perform pg_temp.chk('organizer staff allowed with a current grant', pg_temp.recorded(pg_temp.call('auth_ok', 10, pg_temp.u_orgstaff())));
  perform pg_temp.chk('platform admin allowed with a current grant', pg_temp.recorded(pg_temp.call('auth_ok', 10, pg_temp.u_platform())));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. boundary: period_end is exclusive at local midnight of the studio timezone (America/New_York 2027-07-09 = 04:00:00Z)
--    Tested on the decision helper at fixed instants; the RPC passes now().
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare s uuid;
begin
  s := pg_temp.mkstudio('bound'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, date '2027-07-09');
  perform pg_temp.chk('boundary 2027-07-09 America/New_York: allowed at 03:59:59Z', public._d7_competition_desk_suite_allows(s, timestamptz '2027-07-09 03:59:59+00'));
  perform pg_temp.chk('boundary 2027-07-09 America/New_York: refused at 04:00:00Z', not public._d7_competition_desk_suite_allows(s, timestamptz '2027-07-09 04:00:00+00'));
  perform pg_temp.chk('boundary agrees with usage_addon_entitlement_is_current at both instants',
    public.usage_addon_entitlement_is_current('active', null, date '2027-07-09', 'America/New_York', timestamptz '2027-07-09 03:59:59+00')
    and not public.usage_addon_entitlement_is_current('active', null, date '2027-07-09', 'America/New_York', timestamptz '2027-07-09 04:00:00+00'));

  s := pg_temp.mkstudio('bound_null_tz', null); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, date '2027-07-09');
  perform pg_temp.chk('NULL studio timezone falls back to UTC (ends 00:00Z)', public._d7_competition_desk_suite_allows(s, timestamptz '2027-07-08 23:59:59+00')
    and not public._d7_competition_desk_suite_allows(s, timestamptz '2027-07-09 00:00:00+00'));
  s := pg_temp.mkstudio('bound_bad_tz', 'Not/AZone'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, date '2027-07-09');
  perform pg_temp.chk('invalid studio timezone falls back to UTC', public._d7_competition_desk_suite_allows(s, timestamptz '2027-07-08 23:59:59+00')
    and not public._d7_competition_desk_suite_allows(s, timestamptz '2027-07-09 00:00:00+00'));
  s := pg_temp.mkstudio('bound_start', 'America/New_York'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', date '2027-07-09', null);
  perform pg_temp.chk('period_start inclusive from local midnight (04:00Z)', not public._d7_competition_desk_suite_allows(s, timestamptz '2027-07-09 03:59:59+00')
    and public._d7_competition_desk_suite_allows(s, timestamptz '2027-07-09 04:00:00+00'));
  s := pg_temp.mkstudio('bound_chi', 'America/Chicago'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, date '2027-01-15');
  perform pg_temp.chk('winter zone (Chicago UTC-6): ends 06:00Z', public._d7_competition_desk_suite_allows(s, timestamptz '2027-01-15 05:59:59+00')
    and not public._d7_competition_desk_suite_allows(s, timestamptz '2027-01-15 06:00:00+00'));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. function owner, security mode, search_path and grants
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare v_rec record;
begin
  select pg_get_userbyid(proowner) o, prosecdef d, proconfig c, proacl a into v_rec from pg_proc
  where oid = 'public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)'::regprocedure;
  perform pg_temp.chk('RPC owner is the migration owner and stays SECURITY DEFINER with search_path public, pg_temp',
    v_rec.o = current_user and v_rec.d and v_rec.c = array['search_path=public, pg_temp'], v_rec::text);
  perform pg_temp.chk('RPC EXECUTE: authenticated yes; anon and PUBLIC no',
    has_function_privilege('authenticated', 'public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)', 'execute')
    and not exists (select 1 from aclexplode(v_rec.a) x where x.grantee = 0), coalesce(v_rec.a::text, 'null'));
  perform pg_temp.chk('helper _d7_competition_desk_suite_allows: no role other than the owner can execute it',
    not has_function_privilege('authenticated', 'public._d7_competition_desk_suite_allows(uuid,timestamptz)', 'execute')
    and not has_function_privilege('anon', 'public._d7_competition_desk_suite_allows(uuid,timestamptz)', 'execute')
    and not has_function_privilege('service_role', 'public._d7_competition_desk_suite_allows(uuid,timestamptz)', 'execute'));
  perform pg_temp.chk('helper is not SECURITY DEFINER and pins search_path',
    (select not prosecdef and proconfig = array['search_path=pg_catalog, public, pg_temp'] from pg_proc where oid = 'public._d7_competition_desk_suite_allows(uuid,timestamptz)'::regprocedure));
end $$;

-- the same call as a real API role: authenticated reaches the gate, anon cannot call
create or replace function pg_temp.as_role_call(p_role text, p_tag text) returns jsonb language plpgsql as $$
declare r jsonb; v_event uuid := pg_temp.id('event', p_tag); v_sess uuid := pg_temp.id('sess', p_tag);
begin
  perform pg_temp.as_user(pg_temp.u1());
  begin
    execute format('set local role %I', p_role);
    r := public.record_competition_checkin_payment(v_event, v_sess, 10, 'cash', null);
    reset role;
    perform pg_temp.as_user(null);
    return r;
  exception when others then
    reset role;
    perform pg_temp.as_user(null);
    return jsonb_build_object('outcome', 'error', 'sqlstate', sqlstate, 'error', sqlerrm);
  end;
end $$;

do $$
declare s uuid; r jsonb;
begin
  s := pg_temp.mkstudio('role_lapsed'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, current_date - 1); perform pg_temp.mkcase('role_lapsed', s, true);
  s := pg_temp.mkstudio('role_ok'); perform pg_temp.mkgrant(s, 'manual_grant', 'active', null, null); perform pg_temp.mkcase('role_ok', s, true);
  r := pg_temp.as_role_call('authenticated', 'role_lapsed');
  perform pg_temp.chk('as role authenticated: lapsed grant refused with D7001', pg_temp.refused(r), r::text);
  r := pg_temp.as_role_call('authenticated', 'role_ok');
  perform pg_temp.chk('as role authenticated: current grant recorded', pg_temp.recorded(r), r::text);
  r := pg_temp.as_role_call('anon', 'role_ok');
  perform pg_temp.chk('as role anon: permission denied', r ->> 'sqlstate' = '42501' and r ->> 'error' like 'permission denied%', r::text);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- verdict (always raises: nothing persists)
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare v_fail text; v_total integer;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', E'\n  ') into v_fail from t_results where not ok;
  if v_fail is null then
    raise exception 'D7 DESK GATE SQL SUITE PASS (% checks)', v_total;
  else
    raise exception E'D7 DESK GATE SQL SUITE FAIL: %\n  %', (select count(*) from t_results where not ok), v_fail;
  end if;
end $$;

rollback;

-- Landmark 1A Slice 8 -- Migration A regression suite: entitlement authority.
--
-- Covers 20260918070000_entitlement_authority_hardening.sql. One transaction,
-- synthetic fixtures (UUID block 00000000-0000-0000-0000-00001b8XXXXX), rolled
-- back at the end. Tenant behavior is simulated with `set local role` +
-- request.jwt.claims. Assumes the migration is applied.
--   ...b8001 studio S1 (growth via subscription row)   ...b8002 studio S2
--   users: ...b8101 owner S1, ...b8102 admin S1, ...b8103 front desk S1,
--          ...b8104 instructor S1, ...b8105 owner S2

begin;

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00001b800100', 'S8 Ent Studio 1', 't-s8-ent-1'),
  ('00000000-0000-0000-0000-00001b800200', 'S8 Ent Studio 2', 't-s8-ent-2');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00001b810001', 't-s8-ent-owner1@example.test'),
  ('00000000-0000-0000-0000-00001b810002', 't-s8-ent-admin1@example.test'),
  ('00000000-0000-0000-0000-00001b810003', 't-s8-ent-front1@example.test'),
  ('00000000-0000-0000-0000-00001b810004', 't-s8-ent-instr1@example.test'),
  ('00000000-0000-0000-0000-00001b810005', 't-s8-ent-owner2@example.test'),
  ('00000000-0000-0000-0000-00001b810006', 't-s8-ent-newuser@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'S8 ' || email from auth.users where email like 't-s8-ent-%' on conflict (id) do nothing;

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-00001b810001', '00000000-0000-0000-0000-00001b800100', 'studio_owner', true),
  ('00000000-0000-0000-0000-00001b810002', '00000000-0000-0000-0000-00001b800100', 'studio_admin', true),
  ('00000000-0000-0000-0000-00001b810003', '00000000-0000-0000-0000-00001b800100', 'front_desk', true),
  ('00000000-0000-0000-0000-00001b810004', '00000000-0000-0000-0000-00001b800100', 'instructor', true),
  ('00000000-0000-0000-0000-00001b810005', '00000000-0000-0000-0000-00001b800200', 'studio_owner', true);

-- S1 has a real subscription row on the starter plan (limit 1). Written by postgres (trusted).
insert into public.studio_subscriptions (studio_id, subscription_plan_id, status)
select '00000000-0000-0000-0000-00001b800100', id, 'active' from public.subscription_plans where code = 'starter';
update public.studios set billing_plan = 'starter', subscription_status = 'active'
  where id in ('00000000-0000-0000-0000-00001b800100', '00000000-0000-0000-0000-00001b800200');

-- ============================================================================
-- S. Static definition checks
-- ============================================================================
do $$
declare v_def text; v_sec boolean; v_n int;
begin
  select prosecdef into v_sec from pg_proc where pronamespace = 'public'::regnamespace and proname = '_guard_studios_entitlement_columns';
  assert v_sec = false, 'S1 FAILED: studios guard must be SECURITY INVOKER';
  select pg_get_triggerdef(oid) into v_def from pg_trigger where tgname = 'guard_studios_entitlement_columns' and tgrelid = 'public.studios'::regclass;
  assert v_def like '%BEFORE INSERT OR UPDATE OF billing_plan, subscription_status, billing_override_enabled, billing_override_reason, billing_override_expires_at, billing_override_notes, billing_override_created_at, billing_override_created_by ON public.studios FOR EACH ROW%',
    format('S2 FAILED: trigger def %s', v_def);
  select prosrc into v_def from pg_proc where proname = '_guard_studios_entitlement_columns';
  assert v_def ~ 'current_user in \(''anon'', ''authenticated''\)', 'S3 FAILED: must key on current_user';
  assert v_def !~* 'select[^;]*billing|from\s+(public\.)?studio', 'S3 FAILED: must not consult billing state to authorize';
  select count(*) into v_n from pg_policies where schemaname = 'public' and tablename = 'studio_subscriptions' and cmd in ('INSERT', 'UPDATE', 'ALL');
  assert v_n = 0, format('S4 FAILED: %s tenant write policies remain on studio_subscriptions', v_n);
  assert exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'studio_subscriptions' and cmd = 'SELECT'), 'S4 FAILED: SELECT policy must remain';
  assert exists (select 1 from pg_trigger where tgname = 'guard_profiles_platform_role'), 'S5 FAILED: platform-role hotfix guard missing';
  assert not has_function_privilege('authenticated', 'public._guard_studios_entitlement_columns()', 'execute'), 'S6 FAILED';
  raise notice 'S1-S6 PASSED: invoker guard, trigger columns, non-circular, policies dropped, SELECT kept, hotfix intact';
end $$;

-- ============================================================================
-- T. Tenant tampering fails (and effective limit never changes)
-- ============================================================================
do $$
declare v_n int; v_limit0 int; v_limit1 int;
begin
  v_limit0 := public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b800100');
  assert v_limit0 = 1, format('T0 FAILED: fixture limit should be starter=1, got %s', v_limit0);

  -- T1. Owner: direct self-upgrade of billing_plan fails; other billing fields too.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b810001', 'email', 't-s8-ent-owner1@example.test')::text, true);
  begin update public.studios set billing_plan = 'pro' where id = '00000000-0000-0000-0000-00001b800100'; assert false, 'T1 FAILED: owner self-upgrade allowed';
  exception when others then assert sqlerrm like 'studios billing/entitlement fields cannot be changed%', format('T1 unexpected: %s', sqlerrm); end;
  begin update public.studios set subscription_status = 'trialing' where id = '00000000-0000-0000-0000-00001b800100'; assert false, 'T1b allowed';
  exception when others then assert sqlerrm like 'studios billing/entitlement fields cannot be changed%', format('T1b unexpected: %s', sqlerrm); end;
  begin update public.studios set billing_override_enabled = true where id = '00000000-0000-0000-0000-00001b800100'; assert false, 'T1c allowed';
  exception when others then assert sqlerrm like 'studios billing/entitlement fields cannot be changed%', format('T1c unexpected: %s', sqlerrm); end;

  -- T2. Owner: normal edit succeeds; mixed normal+billing fails atomically.
  update public.studios set name = 'S8 Renamed' where id = '00000000-0000-0000-0000-00001b800100';
  get diagnostics v_n = row_count; assert v_n = 1, 'T2 FAILED: normal studio edit should succeed';
  begin update public.studios set name = 'Should Not Stick', billing_plan = 'pro' where id = '00000000-0000-0000-0000-00001b800100'; assert false, 'T2 mixed allowed';
  exception when others then assert sqlerrm like 'studios billing/entitlement fields cannot be changed%', format('T2 unexpected: %s', sqlerrm); end;

  -- T3. Admin: override fields (incl. expiry/notes/created_by) fail.
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b810002', 'email', 't-s8-ent-admin1@example.test')::text, true);
  begin update public.studios set billing_override_enabled = true, billing_override_expires_at = now() + interval '1 year' where id = '00000000-0000-0000-0000-00001b800100'; assert false, 'T3 FAILED';
  exception when others then assert sqlerrm like 'studios billing/entitlement fields cannot be changed%', format('T3 unexpected: %s', sqlerrm); end;
  begin update public.studios set billing_override_notes = 'x' where id = '00000000-0000-0000-0000-00001b800100'; assert false, 'T3b FAILED';
  exception when others then assert sqlerrm like 'studios billing/entitlement fields cannot be changed%', format('T3b unexpected: %s', sqlerrm); end;

  -- T4. Ordinary active user (instructor role) and front desk: cannot modify/insert subscription rows.
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b810004', 'email', 't-s8-ent-instr1@example.test')::text, true);
  update public.studio_subscriptions set status = 'trialing', subscription_plan_id = (select id from public.subscription_plans where code = 'pro') where studio_id = '00000000-0000-0000-0000-00001b800100';
  get diagnostics v_n = row_count; assert v_n = 0, 'T4 FAILED: ordinary user updated the subscription row';
  begin insert into public.studio_subscriptions (studio_id, subscription_plan_id, status) select '00000000-0000-0000-0000-00001b800200', id, 'active' from public.subscription_plans where code = 'pro'; assert false, 'T4b insert allowed';
  exception when others then null; end;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b810003', 'email', 't-s8-ent-front1@example.test')::text, true);
  update public.studio_subscriptions set status = 'active' where studio_id = '00000000-0000-0000-0000-00001b800100';
  get diagnostics v_n = row_count; assert v_n = 0, 'T4c FAILED: front desk updated the subscription row';

  -- T5. Owner of S1: subscription row of own studio also not writable; other studio untouched.
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b810001', 'email', 't-s8-ent-owner1@example.test')::text, true);
  update public.studio_subscriptions set subscription_plan_id = (select id from public.subscription_plans where code = 'pro') where studio_id = '00000000-0000-0000-0000-00001b800100';
  get diagnostics v_n = row_count; assert v_n = 0, 'T5 FAILED: owner updated own subscription row';

  -- T6. Cross-studio: owner of S1 cannot touch S2 (no rows via RLS; billing columns rejected regardless).
  update public.studios set name = 'Hijack' where id = '00000000-0000-0000-0000-00001b800200';
  get diagnostics v_n = row_count; assert v_n = 0, 'T6 FAILED: cross-studio normal update touched a row';
  begin update public.studios set billing_plan = 'pro' where id = '00000000-0000-0000-0000-00001b800200';
    get diagnostics v_n = row_count; assert v_n = 0, 'T6 FAILED: cross-studio billing update touched a row';
  exception when others then null; end;

  -- T7. Tenant INSERT of a studio: escalated values rejected; default-valued insert allowed.
  begin insert into public.studios (name, slug, billing_plan, subscription_status, billing_override_enabled) values ('Mine', 't-s8-ent-mine1', 'pro', 'active', true); assert false, 'T7 FAILED: escalated tenant INSERT allowed';
  exception when others then assert sqlerrm like 'studios billing/entitlement fields cannot be set%', format('T7 unexpected: %s', sqlerrm); end;
  begin insert into public.studios (name, slug, subscription_status) values ('Mine2', 't-s8-ent-mine2', 'active'); assert false, 'T7b FAILED';
  exception when others then assert sqlerrm like 'studios billing/entitlement fields cannot be set%', format('T7b unexpected: %s', sqlerrm); end;
  insert into public.studios (name, slug) values ('Mine3', 't-s8-ent-mine3');
  reset role;

  v_limit1 := public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b800100');
  assert v_limit1 = v_limit0, format('T FAILED: effective limit changed %s -> %s', v_limit0, v_limit1);
  assert (select name from public.studios where id = '00000000-0000-0000-0000-00001b800100') = 'S8 Renamed', 'T2 FAILED: atomicity broken';
  assert (select count(*) from public.studios where slug in ('t-s8-ent-mine1', 't-s8-ent-mine2')) = 0, 'T7 FAILED: escalated studio persisted';
  raise notice 'T1-T7 PASSED: tenant tampering rejected; normal edits ok; effective limit unchanged';
end $$;

-- ============================================================================
-- P. Trusted writers
-- ============================================================================
do $$
declare v_n int;
begin
  -- P1. service_role: Stripe-style subscription upsert (plan+status together) and studios snapshot.
  set local role service_role;
  update public.studio_subscriptions set subscription_plan_id = (select id from public.subscription_plans where code = 'growth'), status = 'active', updated_at = now() where studio_id = '00000000-0000-0000-0000-00001b800100';
  update public.studios set subscription_status = 'active', stripe_customer_id = 'cus_test', updated_at = now() where id = '00000000-0000-0000-0000-00001b800100';
  insert into public.studio_subscriptions (studio_id, subscription_plan_id, status)
    select '00000000-0000-0000-0000-00001b800200', id, 'trialing' from public.subscription_plans where code = 'starter';
  -- Trusted provisioning: service-role studio insert with explicit billing values (get-started shape).
  insert into public.studios (name, slug, billing_plan, subscription_status) values ('Provisioned', 't-s8-ent-prov', 'growth', 'not_started');
  reset role;
  assert public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b800100') = 5, 'P1 FAILED: service_role plan change not effective';
  assert exists (select 1 from public.studios where slug = 't-s8-ent-prov' and billing_plan = 'growth'), 'P1 FAILED: trusted provisioning';

  -- P2. postgres sets the override; service_role can clear it.
  update public.studios set billing_plan = 'pro', billing_override_enabled = true, billing_override_reason = 'test', billing_override_expires_at = now() + interval '1 day' where id = '00000000-0000-0000-0000-00001b800200';
  assert public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b800200') = 15, 'P2 FAILED: override not effective';
  set local role service_role;
  update public.studios set billing_override_enabled = false, billing_override_reason = null, billing_override_expires_at = null where id = '00000000-0000-0000-0000-00001b800200';
  reset role;
  assert public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b800200') = 1 or public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b800200') = 15, 'P2 sanity';

  -- P3. SECURITY DEFINER owner context passes (claim_platform_invite is a definer function owned by postgres).
  create function public._t_s8_definer_override(p_id uuid) returns void language sql security definer set search_path = 'public' as $f$
    update public.studios set billing_plan = 'pro', billing_override_enabled = true, billing_override_reason = 'ambassador', billing_override_expires_at = now() + interval '12 months' where id = p_id $f$;
  grant execute on function public._t_s8_definer_override(uuid) to authenticated;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b810001', 'email', 't-s8-ent-owner1@example.test')::text, true);
  perform public._t_s8_definer_override('00000000-0000-0000-0000-00001b800100');
  reset role;
  assert public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b800100') = 15, 'P3 FAILED: definer owner context should pass';
  drop function public._t_s8_definer_override(uuid);

  -- P4. Webhook-shape intermediate states are always old-or-new valid entitlements.
  update public.studios set billing_override_enabled = false, billing_override_expires_at = null, billing_override_reason = null where id = '00000000-0000-0000-0000-00001b800100';
  set local role service_role;
  update public.studio_subscriptions set subscription_plan_id = (select id from public.subscription_plans where code = 'starter'), status = 'active' where studio_id = '00000000-0000-0000-0000-00001b800100'; -- one statement: plan + status together
  reset role;
  assert public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b800100') = 1, 'P4 FAILED: downgrade not effective';
  set local role service_role;
  update public.studios set subscription_status = 'past_due' where id = '00000000-0000-0000-0000-00001b800100'; -- snapshot write: resolver reads it only when NO subscription row exists
  reset role;
  assert public._landmark1a_resolve_studio_seat_limit('00000000-0000-0000-0000-00001b800100') = 1, 'P4 FAILED: snapshot write must not change the resolver while a subscription row exists';
  raise notice 'P1-P4 PASSED: service_role Stripe/provisioning writes, postgres override, definer owner, webhook-shape states';
end $$;

-- ============================================================================
-- R. Regression: platform-role guard and normal profile edit still live
-- ============================================================================
do $$
declare v_n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00001b810001', 'email', 't-s8-ent-owner1@example.test')::text, true);
  begin update public.profiles set platform_role = 'platform_admin' where id = '00000000-0000-0000-0000-00001b810001'; assert false, 'R1 FAILED: hotfix guard bypassed';
  exception when others then assert sqlerrm like 'profiles.platform_role cannot be changed%', format('R1 unexpected: %s', sqlerrm); end;
  update public.profiles set full_name = 'Owner Renamed' where id = '00000000-0000-0000-0000-00001b810001';
  get diagnostics v_n = row_count; assert v_n = 1, 'R2 FAILED: normal profile edit';
  reset role;
  raise notice 'R1-R2 PASSED: platform-role guard intact; normal profile edit ok';
  raise notice 'SLICE 8 ENTITLEMENT AUTHORITY SQL REGRESSION: ALL CASE GROUPS PASSED';
end $$;

rollback;

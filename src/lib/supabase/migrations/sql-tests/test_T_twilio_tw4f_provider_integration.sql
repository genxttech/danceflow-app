-- TW-4F provider integration -- database regression suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY).
-- Covers 20261129090000_twilio_tw4f_provider_integration.sql (on top of TW-4A .. TW-4F-3a). One transaction, synthetic fixtures (UUID block
-- a5900000-...), rolled back by an always-raising final block: "PROVIDER SUITE PASS (<n> checks)" or "PROVIDER SUITE FAIL: ...".
-- REFUSES to run unless the session sets tw4a.test_local = 'on'. Privileges are asserted with has_*_privilege (the local image crashes on a
-- permission-denied function call by an API role). No Twilio call exists anywhere in this slice.

begin;

do $$ begin
  if coalesce(current_setting('tw4a.test_local', true), '') <> 'on' then
    raise exception 'TW-4F provider suite refused: set tw4a.test_local = ''on'' only on a disposable local stack';
  end if;
end $$;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_kv (k text primary key, v text) on commit drop;
grant all on t_kv to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.kv(p_k text) returns text language sql as $$ select v from t_kv where k = p_k $$;
create or replace function pg_temp.setkv(p_k text, p_v text) returns void language sql as $$
  insert into t_kv values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.u(p_k text) returns uuid language sql as $$ select pg_temp.kv(p_k)::uuid $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin begin execute p_sql; return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end; end $$;
create or replace function pg_temp.val_as(p_role text, p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', case when p_user is null then '' else json_build_object('sub', p_user, 'role', p_role)::text end, true);
  begin execute format('set local role %I', p_role); execute p_sql into v;
  exception when others then v := 'ERR ' || sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
create or replace function pg_temp.auth(p_user text, p_sql text) returns text language sql as $$ select pg_temp.val_as('authenticated', pg_temp.u(p_user), p_sql) $$;
create or replace function pg_temp.svc(p_sql text) returns text language sql as $$ select pg_temp.val_as('service_role', null, p_sql) $$;

-- ids and fixtures -----------------------------------------------------------------------------------------------------
select pg_temp.setkv('sa', 'a5900000-0000-0000-0000-00000000000a');
select pg_temp.setkv('sa2', 'a5900000-0000-0000-0000-00000000000c');
select pg_temp.setkv('sb', 'a5900000-0000-0000-0000-00000000000b');
select pg_temp.setkv('owner_a', 'a5900000-0000-0000-0000-000000000101');
select pg_temp.setkv('padmin', 'a5900000-0000-0000-0000-000000000401');
select pg_temp.setkv('plain', 'a5900000-0000-0000-0000-000000000501');
select pg_temp.setkv('ea', 'a5900000-0000-0000-0000-0000000e000a');
select pg_temp.setkv('eb', 'a5900000-0000-0000-0000-0000000e000b');
select pg_temp.setkv('ac_a', 'AC' || repeat('a', 32));
select pg_temp.setkv('ac_b', 'AC' || repeat('b', 32));
select pg_temp.setkv('msg', 'SM' || repeat('c', 32));
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select pg_temp.kv(k)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', k || '@tw4fprov-test.invalid', now(), now()
from unnest(array['owner_a', 'padmin', 'plain']) k;
insert into public.profiles (id, platform_role)
select pg_temp.kv(k)::uuid, case when k = 'padmin' then 'platform_admin' end from unnest(array['owner_a', 'padmin', 'plain']) k
on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values
  (pg_temp.u('sa'), 'Prov Studio A', 'prov-studio-a', null), (pg_temp.u('sa2'), 'Prov Studio A2', 'prov-studio-a2', null), (pg_temp.u('sb'), 'Prov Studio B', 'prov-studio-b', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('owner_a'), pg_temp.u('sa'), 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, created_by) values
  (pg_temp.u('ea'), 'Prov Dance A LLC', '1111', pg_temp.u('padmin')), (pg_temp.u('eb'), 'Prov Dance B LLC', '2222', pg_temp.u('padmin'));
-- (fixture shortcut: both A locations as 'founding' links; the attestation path for additional locations is covered by the 3a suite)
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note) values
  (pg_temp.u('sa'), pg_temp.u('ea'), 'founding', pg_temp.u('padmin'), 'synthetic fixture link'), (pg_temp.u('sa2'), pg_temp.u('ea'), 'founding', pg_temp.u('padmin'), 'synthetic fixture link'),
  (pg_temp.u('sb'), pg_temp.u('eb'), 'founding', pg_temp.u('padmin'), 'synthetic fixture link');
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values
  (pg_temp.u('ea'), pg_temp.kv('ac_a'), 'df:test:a', 'test', 'active', pg_temp.u('padmin')),
  (pg_temp.u('eb'), pg_temp.kv('ac_b'), 'df:test:b', 'test', 'closed', pg_temp.u('padmin'));

-- ===== P: privileges ======================================================================================================
select pg_temp.chk('P01 the five new functions: service_role only (never anon/authenticated/public), security definer, pinned search_path',
  (select bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE')
                   and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.prosecdef and 'search_path=pg_catalog, public, pg_temp' = any (p.proconfig))
   from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('tw4_webhook_account', 'sms_webhook_receipt_seen', 'sms_webhook_receipt_record', 'tw4_onboarding_set_tier', 'tw4_runner_tier'))
  and (select count(*) = 5 from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('tw4_webhook_account', 'sms_webhook_receipt_seen', 'sms_webhook_receipt_record', 'tw4_onboarding_set_tier', 'tw4_runner_tier'))
  and not has_function_privilege('service_role', 'public._sms_webhook_receipts_guard()', 'EXECUTE'));
select pg_temp.chk('P02 the two new tables: RLS on, no privileges for any API role',
  (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.sms_webhook_receipts'::regclass, 'public.studio_sms_tier_decisions'::regclass))
  and not has_table_privilege('service_role', 'public.sms_webhook_receipts', 'SELECT') and not has_table_privilege('authenticated', 'public.sms_webhook_receipts', 'SELECT')
  and not has_table_privilege('anon', 'public.sms_webhook_receipts', 'INSERT')
  and not has_table_privilege('service_role', 'public.studio_sms_tier_decisions', 'SELECT') and not has_table_privilege('authenticated', 'public.studio_sms_tier_decisions', 'SELECT'));
select pg_temp.chk('P03 nothing financial or shared was touched: the audit vocabulary has no new action and no price/spend/credit function references the new objects',
  pg_get_constraintdef((select oid from pg_constraint where conname = 'studio_sms_onboarding_audit_action_check')) !~ 'tier'
  and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'tw4\_spend%' or p.proname like 'tw4\_price%' or p.proname like '%credit%' or p.proname like '%monthly%')
                  and (pg_get_functiondef(p.oid) ~ 'sms_webhook_receipts' or pg_get_functiondef(p.oid) ~ 'tier_decisions')));

-- ===== A: webhook account resolution ======================================================================================
select pg_temp.chk('A01 an active subaccount resolves to its legal business and ALL of that business''s studios (sorted), nothing else',
  (pg_temp.svc(format('select public.tw4_webhook_account(%L)::text', pg_temp.kv('ac_a'))))::jsonb
    = jsonb_build_object('found', true, 'legal_entity_id', pg_temp.kv('ea'), 'status', 'active',
        'studio_ids', (select jsonb_agg(x order by x) from unnest(array[pg_temp.kv('sa'), pg_temp.kv('sa2')]) x)),
  pg_temp.svc(format('select public.tw4_webhook_account(%L)::text', pg_temp.kv('ac_a'))));
select pg_temp.chk('A02 a closed account, an unknown SID, a malformed SID and NULL do not resolve',
  pg_temp.svc(format('select public.tw4_webhook_account(%L)::text', pg_temp.kv('ac_b'))) = '{"found": false}'
  and pg_temp.svc(format('select public.tw4_webhook_account(%L)::text', 'AC' || repeat('d', 32))) = '{"found": false}'
  and pg_temp.svc('select public.tw4_webhook_account(''AC123'')::text') = '{"found": false}'
  and pg_temp.svc(format('select public.tw4_webhook_account(%L)::text', pg_temp.kv('ac_a') || ''' or ''1''=''1')) = '{"found": false}'
  and pg_temp.svc('select public.tw4_webhook_account(null)::text') = '{"found": false}');
update public.studio_sms_twilio_accounts set status = 'suspended' where legal_entity_id = pg_temp.u('ea');
select pg_temp.chk('A03 a suspended subaccount still resolves (callbacks for messages already sent keep arriving)',
  (pg_temp.svc(format('select public.tw4_webhook_account(%L)::text', pg_temp.kv('ac_a'))))::jsonb ->> 'status' = 'suspended');
update public.studio_sms_twilio_accounts set status = 'active' where legal_entity_id = pg_temp.u('ea');

-- ===== R: replay ledger ==================================================================================================
select pg_temp.setkv('r1', pg_temp.svc(format('select public.sms_webhook_receipt_seen(''status'', %L)::text', pg_temp.kv('msg') || ':delivered')));
select pg_temp.setkv('r2', pg_temp.svc(format('select public.sms_webhook_receipt_record(''status'', %L, %L)::text', pg_temp.kv('msg') || ':delivered', pg_temp.kv('ac_a'))));
select pg_temp.setkv('r3', pg_temp.svc(format('select public.sms_webhook_receipt_record(''status'', %L, %L)::text', pg_temp.kv('msg') || ':delivered', pg_temp.kv('ac_a'))));
select pg_temp.setkv('r4', pg_temp.svc(format('select public.sms_webhook_receipt_record(''status'', %L, null)::text', pg_temp.kv('msg') || ':delivered')));
select pg_temp.setkv('r5', pg_temp.svc(format('select public.sms_webhook_receipt_seen(''status'', %L)::text', pg_temp.kv('msg') || ':delivered')));
select pg_temp.setkv('r6', pg_temp.svc(format('select public.sms_webhook_receipt_record(''inbound'', %L, null)::text', pg_temp.kv('msg'))));
select pg_temp.chk('R01 the first record is true, a duplicate is false (whatever the account), and seen() reflects it; kinds are independent',
  pg_temp.kv('r1') = 'false' and pg_temp.kv('r2') = 'true' and pg_temp.kv('r3') = 'false' and pg_temp.kv('r4') = 'false' and pg_temp.kv('r5') = 'true' and pg_temp.kv('r6') = 'true',
  concat_ws(',', pg_temp.kv('r1'), pg_temp.kv('r2'), pg_temp.kv('r3'), pg_temp.kv('r4'), pg_temp.kv('r5'), pg_temp.kv('r6')));
select pg_temp.chk('R02 invalid kinds, keys and account SIDs are refused',
  pg_temp.svc('select public.sms_webhook_receipt_record(''other'', ''SMabc'', null)::text') like 'ERR 22023%'
  and pg_temp.svc('select public.sms_webhook_receipt_record(''inbound'', ''ab'', null)::text') like 'ERR 22023%'
  and pg_temp.svc(format('select public.sms_webhook_receipt_record(''inbound'', %L, null)::text', repeat('x', 161))) like 'ERR 22023%'
  and pg_temp.svc('select public.sms_webhook_receipt_record(''inbound'', ''SMvalid-key'', ''nope'')::text') like 'ERR 23514%');
select pg_temp.chk('R03 receipts are append-only (no update, delete or truncate, even for the table owner)',
  pg_temp.try('update public.sms_webhook_receipts set account_sid = null') like '42501%'
  and pg_temp.try('delete from public.sms_webhook_receipts') like '42501%'
  and (select count(*) = 2 from public.sms_webhook_receipts)
  -- (TRUNCATE cannot be tried inside this open transaction: assert the statement trigger instead)
  and exists (select 1 from pg_trigger where tgrelid = 'public.sms_webhook_receipts'::regclass and tgname = 'sms_webhook_receipts_20_no_truncate' and tgtype & 32 = 32));

-- ===== T: registration tier ================================================================================================
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''prov fixtures'')::text', pg_temp.kv('sa')));
select pg_temp.auth('owner_a', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sa'),
  '{"legal_name":"Prov Dance A LLC","entity_type":"llc","industry":"EDUCATION","website_choice":"danceflow"}'));
select pg_temp.setkv('onb', (select id::text from public.studio_sms_onboarding where studio_id = pg_temp.u('sa')));
select pg_temp.chk('T00 fixture: studio A has an onboarding with no tier chosen', pg_temp.kv('onb') is not null
  and (select tier is null from public.studio_sms_onboarding where id = pg_temp.u('onb')), coalesce(pg_temp.kv('onb'), 'none'));

select pg_temp.chk('T01 only a platform admin may set the tier; unknown tiers and missing reasons are refused; nothing is written then',
  pg_temp.svc(format('select public.tw4_onboarding_set_tier(%L, %L, ''low_volume_standard'', ''eligible'')::text', pg_temp.kv('sa'), pg_temp.kv('plain'))) like 'ERR 42501%'
  and pg_temp.svc(format('select public.tw4_onboarding_set_tier(%L, %L, ''low_volume_standard'', ''eligible'')::text', pg_temp.kv('sa'), pg_temp.kv('owner_a'))) like 'ERR 42501%'
  and pg_temp.svc(format('select public.tw4_onboarding_set_tier(%L, %L, ''sole_proprietor'', ''eligible'')::text', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and pg_temp.svc(format('select public.tw4_onboarding_set_tier(%L, %L, ''low_volume_standard'', ''  '')::text', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and pg_temp.svc(format('select public.tw4_onboarding_set_tier(%L, %L, ''low_volume_standard'', ''eligible'')::text', pg_temp.kv('sb'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and (select count(*) = 0 from public.studio_sms_tier_decisions));
-- (side-effecting calls run in their own statements: AND gives no evaluation order)
select pg_temp.setkv('t2a', pg_temp.svc(format('select public.tw4_onboarding_set_tier(%L, %L, ''low_volume_standard'', ''EIN registered, under 2k segments/day'')::text', pg_temp.kv('sa'), pg_temp.kv('padmin'))));
select pg_temp.setkv('t2b', pg_temp.svc(format('select public.tw4_onboarding_set_tier(%L, %L, ''low_volume_standard'', ''again'')::text', pg_temp.kv('sa'), pg_temp.kv('padmin'))));
select pg_temp.chk('T02 a platform admin sets Low-Volume Standard with a reason; the decision is evidence; setting it again changes nothing',
  pg_temp.kv('t2a')::jsonb = '{"tier": "low_volume_standard", "changed": true}'
  and pg_temp.kv('t2b')::jsonb = '{"tier": "low_volume_standard", "changed": false}'
  and (select tier = 'low_volume_standard' from public.studio_sms_onboarding where id = pg_temp.u('onb'))
  and (select count(*) = 1 and bool_and(previous_tier is null and decided_by = pg_temp.u('padmin')) from public.studio_sms_tier_decisions where onboarding_id = pg_temp.u('onb')));
select pg_temp.chk('T03 tier decisions are append-only',
  pg_temp.try('update public.studio_sms_tier_decisions set tier = ''standard''') like '42501%'
  and pg_temp.try('delete from public.studio_sms_tier_decisions') like '42501%'
  and exists (select 1 from pg_trigger where tgrelid = 'public.studio_sms_tier_decisions'::regclass and tgname = 'studio_sms_tier_decisions_20_no_truncate'));

update public.studio_sms_onboarding set lease_owner = 'run-prov', lease_expires_at = now() + interval '5 minutes' where id = pg_temp.u('onb');
select pg_temp.chk('T04 the runner reads the tier only under its lease; a held lease blocks a tier change',
  (pg_temp.svc(format('select public.tw4_runner_tier(%L, ''run-prov'')::text', pg_temp.kv('onb'))))::jsonb = '{"tier": "low_volume_standard", "chosen": true}'
  and pg_temp.svc(format('select public.tw4_runner_tier(%L, ''someone-else'')::text', pg_temp.kv('onb'))) like 'ERR 55P03%'
  and pg_temp.svc(format('select public.tw4_onboarding_set_tier(%L, %L, ''standard'', ''back'')::text', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like 'ERR 55P03%');
update public.studio_sms_onboarding set lease_owner = null, lease_expires_at = null where id = pg_temp.u('onb');

select pg_temp.setkv('t5', pg_temp.svc(format('select public.tw4_onboarding_set_tier(%L, %L, ''standard'', ''owner chose Standard'')::text', pg_temp.kv('sa'), pg_temp.kv('padmin'))));
select pg_temp.chk('T05 back to Standard is recorded with the previous tier',
  pg_temp.kv('t5')::jsonb = '{"tier": "standard", "changed": true}'
  and (select count(*) = 1 from public.studio_sms_tier_decisions where onboarding_id = pg_temp.u('onb') and tier = 'standard' and previous_tier = 'low_volume_standard'), pg_temp.kv('t5'));

-- once a brand attempt exists, the tier is frozen
alter table public.studio_sms_provisioning_steps disable trigger user;
insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, status, friendly_name, fee_bearing, twilio_account_sid)
select o.id, o.studio_id, 'B1', o.submission_seq, 'unknown_outcome', 'df:test:b1', true, pg_temp.kv('ac_a') from public.studio_sms_onboarding o where o.id = pg_temp.u('onb');
alter table public.studio_sms_provisioning_steps enable trigger user;
select pg_temp.chk('T06 the tier is frozen once any brand attempt exists (even an unknown outcome)',
  pg_temp.svc(format('select public.tw4_onboarding_set_tier(%L, %L, ''low_volume_standard'', ''after brand'')::text', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like 'ERR 55000%'
  and (select tier = 'standard' from public.studio_sms_onboarding where id = pg_temp.u('onb')));

do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'PROVIDER SUITE PASS (% checks)', v_n;
  else raise exception 'PROVIDER SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

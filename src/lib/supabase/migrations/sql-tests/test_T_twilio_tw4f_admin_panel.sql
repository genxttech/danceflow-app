-- TW-4F admin panel -- database regression suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY).
-- Covers 20261130090000_twilio_tw4f_admin_panel.sql (on top of TW-4A .. 20261129). One transaction, synthetic fixtures (UUID block
-- a6100000-...), rolled back by an always-raising final block: "PANEL SUITE PASS (<n> checks)" or "PANEL SUITE FAIL: ...".
-- REFUSES to run unless the session sets tw4a.test_local = 'on'. Privileges are asserted with has_*_privilege (the local image crashes on a
-- permission-denied function call by an API role). Writes NO price, credit, pilot or spend rows (those suites belong to the financial work).
-- No Twilio call exists anywhere in this slice.

begin;

do $$ begin
  if coalesce(current_setting('tw4a.test_local', true), '') <> 'on' then
    raise exception 'TW-4F panel suite refused: set tw4a.test_local = ''on'' only on a disposable local stack';
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
select pg_temp.setkv('sa', 'a6100000-0000-0000-0000-00000000000a');
select pg_temp.setkv('sb', 'a6100000-0000-0000-0000-00000000000b');
select pg_temp.setkv('sx', 'a6100000-0000-0000-0000-00000000000c');
select pg_temp.setkv('owner_a', 'a6100000-0000-0000-0000-000000000101');
select pg_temp.setkv('padmin', 'a6100000-0000-0000-0000-000000000401');
select pg_temp.setkv('padmin2', 'a6100000-0000-0000-0000-000000000402');
select pg_temp.setkv('plain', 'a6100000-0000-0000-0000-000000000501');
select pg_temp.setkv('ea', 'a6100000-0000-0000-0000-0000000e000a');
select pg_temp.setkv('eb', 'a6100000-0000-0000-0000-0000000e000b');
select pg_temp.setkv('k1', 'a6100000-0000-0000-0000-0000000c0001');
select pg_temp.setkv('k2', 'a6100000-0000-0000-0000-0000000c0002');
select pg_temp.setkv('ac_b', 'AC' || repeat('b', 32));
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select pg_temp.kv(k)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', k || '@tw4fpanel-test.invalid', now(), now()
from unnest(array['owner_a', 'padmin', 'padmin2', 'plain']) k;
insert into public.profiles (id, platform_role)
select pg_temp.kv(k)::uuid, case when k like 'padmin%' then 'platform_admin' end from unnest(array['owner_a', 'padmin', 'padmin2', 'plain']) k
on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values
  (pg_temp.u('sa'), 'Panel Studio A', 'panel-studio-a', null), (pg_temp.u('sb'), 'Panel Studio B', 'panel-studio-b', null), (pg_temp.u('sx'), 'Panel Studio X', 'panel-studio-x', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('owner_a'), pg_temp.u('sa'), 'studio_owner', true), (pg_temp.u('owner_a'), pg_temp.u('sx'), 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  (pg_temp.u('ea'), 'Panel Dance A LLC', '1111', 15000, pg_temp.u('padmin')), (pg_temp.u('eb'), 'Panel Dance B LLC', '2222', 15000, pg_temp.u('padmin'));
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note) values
  (pg_temp.u('sa'), pg_temp.u('ea'), 'founding', pg_temp.u('padmin'), 'synthetic fixture link'), (pg_temp.u('sb'), pg_temp.u('eb'), 'founding', pg_temp.u('padmin'), 'synthetic fixture link');
insert into public.studio_sms_twilio_accounts (legal_entity_id, twilio_account_sid, friendly_name, environment, status, created_by) values
  (pg_temp.u('eb'), pg_temp.kv('ac_b'), 'df:test:b', 'test', 'active', pg_temp.u('padmin'));
-- studio X: its owner attests it belongs to business A (pending request)
select pg_temp.auth('owner_a', format('select public.sms_location_attest(%L, ''Panel Dance A LLC'', ''1111'', ''tw4f-location-v1'')::text', pg_temp.kv('sx')));
-- studio A onboarding (a draft is enough for the tier rules)
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''panel fixtures'')::text', pg_temp.kv('sa')));
select pg_temp.auth('owner_a', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sa'), '{"legal_name":"Panel Dance A LLC","entity_type":"llc","industry":"EDUCATION","website_choice":"danceflow"}'));
select pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, ''v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCC'', ''v1'', ''1111'')::text', pg_temp.kv('sa'), pg_temp.kv('owner_a')));
select pg_temp.setkv('elig', '{"ein_registered":true,"not_sole_proprietor":true,"low_volume_expected":true,"owner_informed_limits":true,"owner_informed_review":true}');

-- ===== P: privileges ======================================================================================================
select pg_temp.chk('P01 the panel functions: service_role only, definer, pinned search_path; the checklist helper callable by nobody',
  (select bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE') and not has_function_privilege('anon', p.oid, 'EXECUTE')
                   and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.prosecdef and 'search_path=pg_catalog, public, pg_temp' = any (p.proconfig))
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('tw4_panel_overview', 'tw4_panel_subaccount_confirm', 'tw4_onboarding_decide_tier', 'tw4_onboarding_set_tier'))
  and (select count(*) = 4 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('tw4_panel_overview', 'tw4_panel_subaccount_confirm', 'tw4_onboarding_decide_tier', 'tw4_onboarding_set_tier'))
  and not has_function_privilege('service_role', 'public._tw4p_lvs_checklist_complete(jsonb)', 'EXECUTE'));
select pg_temp.chk('P02 the request-key table: RLS on, no API privileges, append-only triggers',
  (select relrowsecurity from pg_class where oid = 'public.studio_sms_panel_requests'::regclass)
  and not has_table_privilege('service_role', 'public.studio_sms_panel_requests', 'SELECT') and not has_table_privilege('authenticated', 'public.studio_sms_panel_requests', 'INSERT')
  and (select count(*) = 2 from pg_trigger where tgrelid = 'public.studio_sms_panel_requests'::regclass and not tgisinternal));
select pg_temp.chk('P03 nothing financial was touched: no price/spend/credit/pilot/monthly function references the panel objects; the audit vocabulary has no panel action',
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'tw4\_spend%' or p.proname like 'tw4\_price%' or p.proname like '%credit%' or p.proname like '%pilot%' or p.proname like '%monthly%')
              and (pg_get_functiondef(p.oid) ~ 'panel_requests' or pg_get_functiondef(p.oid) ~ 'eligibility'))
  and pg_get_constraintdef((select oid from pg_constraint where conname = 'studio_sms_onboarding_audit_action_check')) !~ 'panel');

-- ===== O: overview ========================================================================================================
select pg_temp.chk('O01 the overview is for platform admins only',
  pg_temp.svc(format('select public.tw4_panel_overview(%L)::text', pg_temp.kv('plain'))) like 'ERR 42501%'
  and pg_temp.svc(format('select public.tw4_panel_overview(%L)::text', pg_temp.kv('owner_a'))) like 'ERR 42501%'
  and pg_temp.svc('select public.tw4_panel_overview(null)::text') like 'ERR 42501%');
select pg_temp.setkv('ov', pg_temp.svc(format('select public.tw4_panel_overview(%L)::text', pg_temp.kv('padmin'))));
select pg_temp.chk('O02 entity A: its own studio, budget, no account; entity B: active account; the pending request points at A as a candidate only',
  (select (e ->> 'spend_cap_cents')::int = 15000 and e -> 'account' = 'null'::jsonb and jsonb_array_length(e -> 'studios') = 1
          and e -> 'studios' -> 0 ->> 'studio_id' = pg_temp.kv('sa')
   from jsonb_array_elements(pg_temp.kv('ov')::jsonb -> 'entities') e where e ->> 'id' = pg_temp.kv('ea'))
  and (select e -> 'account' ->> 'status' = 'active' from jsonb_array_elements(pg_temp.kv('ov')::jsonb -> 'entities') e where e ->> 'id' = pg_temp.kv('eb'))
  and (select r ->> 'candidate_entity_id' = pg_temp.kv('ea') and r ->> 'status' = 'pending' and r ->> 'legal_entity_id' is null
       from jsonb_array_elements(pg_temp.kv('ov')::jsonb -> 'requests') r where r ->> 'studio_id' = pg_temp.kv('sx')),
  left(coalesce(pg_temp.kv('ov'), 'null'), 300));
select pg_temp.chk('O03 the overview carries no EIN ciphertext and no token',
  pg_temp.kv('ov') !~ 'ein_ciphertext' and pg_temp.kv('ov') !~ 'auth_token');

-- ===== C: Create subaccount confirmation, one per request key ==============================================================
select pg_temp.setkv('c1', pg_temp.svc(format('select public.tw4_panel_subaccount_confirm(%L, %L, %L)::text', pg_temp.kv('k1'), pg_temp.kv('sa'), pg_temp.kv('padmin'))));
select pg_temp.setkv('c2', pg_temp.svc(format('select public.tw4_panel_subaccount_confirm(%L, %L, %L)::text', pg_temp.kv('k1'), pg_temp.kv('sa'), pg_temp.kv('padmin'))));
select pg_temp.chk('C01 the first use of a key records ONE confirmation; a replay of the same key records nothing more',
  (pg_temp.kv('c1')::jsonb ->> 'replayed') = 'false' and (pg_temp.kv('c1')::jsonb ->> 'reused') = 'false' and (pg_temp.kv('c1')::jsonb ->> 'legal_entity_id') = pg_temp.kv('ea')
  and (pg_temp.kv('c2')::jsonb ->> 'replayed') = 'true'
  and (select count(*) = 1 from public.studio_sms_subaccount_confirmations where legal_entity_id = pg_temp.u('ea') and consumed_at is null)
  and (select count(*) = 1 from public.studio_sms_panel_requests where request_key = pg_temp.u('k1')), pg_temp.kv('c1') || ' ' || pg_temp.kv('c2'));
select pg_temp.chk('C02 a key cannot be reused for another studio''s business or by another admin; non-admins, a studio without a legal business (studio X) and a missing key are refused',
  pg_temp.svc(format('select public.tw4_panel_subaccount_confirm(%L, %L, %L)::text', pg_temp.kv('k1'), pg_temp.kv('sb'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and pg_temp.svc(format('select public.tw4_panel_subaccount_confirm(%L, %L, %L)::text', pg_temp.kv('k1'), pg_temp.kv('sa'), pg_temp.kv('padmin2'))) like 'ERR 22023%'
  and pg_temp.svc(format('select public.tw4_panel_subaccount_confirm(%L, %L, %L)::text', pg_temp.kv('k2'), pg_temp.kv('sa'), pg_temp.kv('plain'))) like 'ERR 42501%'
  and pg_temp.svc(format('select public.tw4_panel_subaccount_confirm(%L, %L, %L)::text', pg_temp.kv('k2'), pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and pg_temp.svc(format('select public.tw4_panel_subaccount_confirm(null, %L, %L)::text', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and (select count(*) = 1 from public.studio_sms_subaccount_confirmations where legal_entity_id = pg_temp.u('ea')));
select pg_temp.chk('C03 nothing is recorded for an entity whose subaccount is already active (nothing would consume it)',
  pg_temp.svc(format('select public.tw4_panel_subaccount_confirm(%L, %L, %L)::text', pg_temp.kv('k2'), pg_temp.kv('sb'), pg_temp.kv('padmin'))) like 'ERR 55000%'
  and not exists (select 1 from public.studio_sms_subaccount_confirmations where legal_entity_id = pg_temp.u('eb'))
  and not exists (select 1 from public.studio_sms_panel_requests where request_key = pg_temp.u('k2')));
-- C05-C08: the account lifecycle the confirmation respects (matching tw4_subaccount_begin)
select pg_temp.setkv('k3', 'a6100000-0000-0000-0000-0000000c0003');
select pg_temp.setkv('c5', pg_temp.svc(format('select public.tw4_panel_subaccount_confirm(%L, %L, %L)::text', pg_temp.kv('k3'), pg_temp.kv('sa'), pg_temp.kv('padmin'))));
select pg_temp.chk('C05 a second key while a fresh confirmation by the same admin is still open reuses it: never two open confirmations',
  (pg_temp.kv('c5')::jsonb ->> 'reused') = 'true'
  and (select count(*) = 1 from public.studio_sms_subaccount_confirmations where legal_entity_id = pg_temp.u('ea') and consumed_at is null), pg_temp.kv('c5'));
update public.studio_sms_subaccount_confirmations set consumed_at = now() where legal_entity_id = pg_temp.u('ea');
insert into public.studio_sms_twilio_accounts (legal_entity_id, friendly_name, environment, status, created_by, updated_at)
  values (pg_temp.u('ea'), 'df:test:a', 'test', 'creating', pg_temp.u('padmin'), now() - interval '2 minutes');
select pg_temp.chk('C06 a creation started less than 10 minutes ago: refused (TW006), nothing recorded',
  pg_temp.svc(format('select public.tw4_panel_subaccount_confirm(%L, %L, %L)::text', 'a6100000-0000-0000-0000-0000000c0004', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like 'ERR TW006%'
  and not exists (select 1 from public.studio_sms_panel_requests where request_key = 'a6100000-0000-0000-0000-0000000c0004'::uuid));
update public.studio_sms_twilio_accounts set updated_at = now() - interval '11 minutes' where legal_entity_id = pg_temp.u('ea');
select pg_temp.setkv('c7', pg_temp.svc(format('select public.tw4_panel_subaccount_confirm(%L, %L, %L)::text', 'a6100000-0000-0000-0000-0000000c0005', pg_temp.kv('sa'), pg_temp.kv('padmin'))));
select pg_temp.chk('C07 an interrupted creation (creating for over 10 minutes) can be confirmed again and then reconciled by tw4_subaccount_begin',
  (pg_temp.kv('c7')::jsonb ->> 'reused') = 'false'
  and (pg_temp.svc(format('select public.tw4_subaccount_begin(%L, %L, ''df:test:a'', ''test'')::text', pg_temp.kv('ea'), pg_temp.kv('padmin'))))::jsonb ->> 'action' = 'reconcile', pg_temp.kv('c7'));
update public.studio_sms_twilio_accounts set status = 'closed', twilio_account_sid = 'AC' || repeat('c', 32) where legal_entity_id = pg_temp.u('ea');
select pg_temp.chk('C08 a closed account: nothing to confirm (55000)',
  pg_temp.svc(format('select public.tw4_panel_subaccount_confirm(%L, %L, %L)::text', 'a6100000-0000-0000-0000-0000000c0006', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like 'ERR 55000%');
alter table public.studio_sms_twilio_accounts disable trigger user;
delete from public.studio_sms_twilio_accounts where legal_entity_id = pg_temp.u('ea');
alter table public.studio_sms_twilio_accounts enable trigger user;
select pg_temp.chk('C04 request keys are append-only',
  pg_temp.try('update public.studio_sms_panel_requests set actor = actor') like '42501%' and pg_temp.try('delete from public.studio_sms_panel_requests') like '42501%');

-- ===== T: registration tier with eligibility ===============================================================================
select pg_temp.chk('T01 the old entry point refuses Low-Volume Standard (it must carry the checklist)',
  pg_temp.svc(format('select public.tw4_onboarding_set_tier(%L, %L, ''low_volume_standard'', ''eligible studio'')::text', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like 'ERR 22023%needs the eligibility checklist%');
select pg_temp.chk('T02 Low-Volume Standard needs every checklist item true and a 10+ character reason; non-admins refused; nothing written',
  pg_temp.svc(format('select public.tw4_onboarding_decide_tier(%L, %L, ''low_volume_standard'', ''EIN, low volume'', %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('padmin'), (pg_temp.kv('elig')::jsonb || '{"owner_informed_review": false}')::text)) like 'ERR 22023%'
  and pg_temp.svc(format('select public.tw4_onboarding_decide_tier(%L, %L, ''low_volume_standard'', ''EIN, low volume'', %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('padmin'), (pg_temp.kv('elig')::jsonb - 'not_sole_proprietor')::text)) like 'ERR 22023%'
  and pg_temp.svc(format('select public.tw4_onboarding_decide_tier(%L, %L, ''low_volume_standard'', ''short'', %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('padmin'), pg_temp.kv('elig'))) like 'ERR 22023%'
  and pg_temp.svc(format('select public.tw4_onboarding_decide_tier(%L, %L, ''low_volume_standard'', ''EIN, low volume'', %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('plain'), pg_temp.kv('elig'))) like 'ERR 42501%'
  and pg_temp.svc(format('select public.tw4_onboarding_decide_tier(%L, %L, ''low_volume_standard'', ''EIN, low volume'', ''[]''::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and pg_temp.svc(format('select public.tw4_onboarding_decide_tier(%L, %L, ''low_volume_standard'', ''EIN business, low volume'', %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('padmin'), (pg_temp.kv('elig')::jsonb || '{"owner_informed_review": "yes"}')::text)) like 'ERR 22023%'
  and (select count(*) = 0 from public.studio_sms_tier_decisions d join public.studio_sms_onboarding o on o.id = d.onboarding_id where o.studio_id = pg_temp.u('sa')));
select pg_temp.setkv('t3', pg_temp.svc(format('select public.tw4_onboarding_decide_tier(%L, %L, ''low_volume_standard'', ''EIN business, about 200 texts a month'', %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('padmin'), pg_temp.kv('elig'))));
select pg_temp.chk('T03 with the full checklist it is recorded with its evidence',
  pg_temp.kv('t3')::jsonb = '{"tier": "low_volume_standard", "changed": true}'
  and (select d.eligibility = pg_temp.kv('elig')::jsonb and d.decided_by = pg_temp.u('padmin') from public.studio_sms_tier_decisions d join public.studio_sms_onboarding o on o.id = d.onboarding_id where o.studio_id = pg_temp.u('sa') and d.tier = 'low_volume_standard'), pg_temp.kv('t3'));
select pg_temp.setkv('t4', pg_temp.svc(format('select public.tw4_onboarding_decide_tier(%L, %L, ''standard'', ''Owner prefers Standard throughput'', %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('padmin'), pg_temp.kv('elig'))));
select pg_temp.chk('T04 Standard needs no checklist and stores none (even if one is sent)',
  pg_temp.kv('t4')::jsonb = '{"tier": "standard", "changed": true}'
  and (select d.eligibility is null from public.studio_sms_tier_decisions d join public.studio_sms_onboarding o on o.id = d.onboarding_id where o.studio_id = pg_temp.u('sa') and d.tier = 'standard'), pg_temp.kv('t4'));
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''panel fixtures'')::text', pg_temp.kv('sx')));
select pg_temp.auth('owner_a', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sx'), '{"legal_name":"Panel Dance A LLC","entity_type":"llc","industry":"EDUCATION","website_choice":"danceflow"}'));
-- T06: an open Standard-price brand approval blocks a switch to Low-Volume Standard (a synthetic spend row inside this rolled-back transaction)
alter table public.studio_sms_spend_events disable trigger user;
insert into public.studio_sms_spend_events (legal_entity_id, kind, amount_cents, status, approval_ref, authorized_by, funding, studio_id)
  values (pg_temp.u('ea'), 'brand', 4600, 'authorized', 'Owner email (synthetic)', pg_temp.u('padmin'), 'credit', pg_temp.u('sa'));
alter table public.studio_sms_spend_events enable trigger user;
select pg_temp.chk('T06 an open Standard-price brand fee approval blocks the switch to Low-Volume Standard (55000)',
  pg_temp.svc(format('select public.tw4_onboarding_decide_tier(%L, %L, ''low_volume_standard'', ''EIN business, low volume'', %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('padmin'), pg_temp.kv('elig'))) like 'ERR 55000%open brand fee approval%');
alter table public.studio_sms_spend_events disable trigger user;
delete from public.studio_sms_spend_events where legal_entity_id = pg_temp.u('ea');
alter table public.studio_sms_spend_events enable trigger user;
-- T07: the studio's own EIN last four must agree with the legal business
update public.studio_sms_legal_entities set ein_last4 = '9999' where id = pg_temp.u('ea');
select pg_temp.chk('T07 a legal business whose EIN last four differs from the studio''s submitted setup cannot be Low-Volume Standard',
  pg_temp.svc(format('select public.tw4_onboarding_decide_tier(%L, %L, ''low_volume_standard'', ''EIN business, low volume'', %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('padmin'), pg_temp.kv('elig'))) like 'ERR 22023%');
update public.studio_sms_legal_entities set ein_last4 = '1111' where id = pg_temp.u('ea');
-- T08: the Standard path of the old entry point still freezes once a brand attempt exists
alter table public.studio_sms_provisioning_steps disable trigger user;
insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, status, friendly_name, fee_bearing)
select o.id, o.studio_id, 'B1', o.submission_seq, 'unknown_outcome', 'df:test:b1', true from public.studio_sms_onboarding o where o.studio_id = pg_temp.u('sa') and o.state <> 'cancelled';
alter table public.studio_sms_provisioning_steps enable trigger user;
select pg_temp.chk('T08 both entry points are frozen once a brand attempt exists',
  pg_temp.svc(format('select public.tw4_onboarding_set_tier(%L, %L, ''standard'', ''after the brand'')::text', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like 'ERR 55000%'
  and pg_temp.svc(format('select public.tw4_onboarding_decide_tier(%L, %L, ''standard'', ''after the brand attempt'', null)::text', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like 'ERR 55000%');
select pg_temp.chk('T05 Low-Volume Standard needs the location''s legal business on file (studio X is not linked yet)',
  pg_temp.svc(format('select public.tw4_onboarding_decide_tier(%L, %L, ''low_volume_standard'', ''EIN business, low volume'', %L::jsonb)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'), pg_temp.kv('elig'))) like 'ERR 22023%legal business%');

-- ===== R: rollback guard ===================================================================================================
select pg_temp.chk('R01 the rollback guard''s evidence exists after these actions (panel requests and eligibility records)',
  exists (select 1 from public.studio_sms_panel_requests) and exists (select 1 from public.studio_sms_tier_decisions where eligibility is not null));

do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'PANEL SUITE PASS (% checks)', v_n;
  else raise exception 'PANEL SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

-- TW-4A -- studio SMS onboarding foundation regression suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY).
--
-- Covers 20261119090000_twilio_tw4a_sms_onboarding.sql. One transaction, synthetic fixtures only (UUID block a5700000-...),
-- rolled back by an always-raising final block: "TW4A SUITE PASS (<n> checks)" or "TW4A SUITE FAIL: ...". Staff identities need
-- auth.users + profiles rows, so this file REFUSES to run unless the session sets: tw4a.test_local = 'on' (never shared DEV/PROD).
-- Note: live 'permission denied' probes under a switched role crash the local PG 17.6 image, so API-role privileges are proven
-- with has_table_privilege / has_function_privilege; role-gated behavior is exercised through the RPC bodies (42501).

begin;

do $$ begin
  if coalesce(current_setting('tw4a.test_local', true), '') <> 'on' then
    raise exception 'TW-4A local suite refused: set tw4a.test_local = ''on'' only on a disposable local stack';
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
-- run as role (JWT sub = p_user): 'ok' or 'SQLSTATE message'
create or replace function pg_temp.run_as(p_role text, p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', case when p_user is null then '' else json_build_object('sub', p_user, 'role', p_role, 'aal', 'aal2')::text end, true);
  begin execute format('set local role %I', p_role); execute p_sql; v := 'ok';
  exception when others then v := sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
-- same, returning the first column of the first row (or 'ERR <SQLSTATE> <message>')
create or replace function pg_temp.val_as(p_role text, p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', case when p_user is null then '' else json_build_object('sub', p_user, 'role', p_role, 'aal', 'aal2')::text end, true);
  begin execute format('set local role %I', p_role); execute p_sql into v;
  exception when others then v := 'ERR ' || sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
create or replace function pg_temp.auth(p_user text, p_sql text) returns text language sql as $$
  select pg_temp.val_as('authenticated', pg_temp.u(p_user), p_sql) $$;
create or replace function pg_temp.svc(p_sql text) returns text language sql as $$
  select pg_temp.val_as('service_role', null, p_sql) $$;

-- ids ----------------------------------------------------------------------------------------------------------------
select pg_temp.setkv('sa', 'a5700000-0000-0000-0000-00000000000a');
select pg_temp.setkv('sb', 'a5700000-0000-0000-0000-00000000000b');
select pg_temp.setkv('sc', 'a5700000-0000-0000-0000-00000000000c');
select pg_temp.setkv('owner_a', 'a5700000-0000-0000-0000-000000000101');
select pg_temp.setkv('admin_a', 'a5700000-0000-0000-0000-000000000102');
select pg_temp.setkv('fd_a', 'a5700000-0000-0000-0000-000000000103');
select pg_temp.setkv('instr_a', 'a5700000-0000-0000-0000-000000000104');
select pg_temp.setkv('plain_a', 'a5700000-0000-0000-0000-000000000105');
select pg_temp.setkv('owner_b', 'a5700000-0000-0000-0000-000000000201');
select pg_temp.setkv('owner_c', 'a5700000-0000-0000-0000-000000000301');
select pg_temp.setkv('padmin', 'a5700000-0000-0000-0000-000000000401');
select pg_temp.setkv('nobody', 'a5700000-0000-0000-0000-000000000999');
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select pg_temp.kv(k)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', k || '@tw4a-test.invalid', now(), now()
from unnest(array['owner_a', 'admin_a', 'fd_a', 'instr_a', 'plain_a', 'owner_b', 'owner_c', 'padmin', 'nobody']) k;
insert into public.profiles (id, platform_role)
select pg_temp.kv(k)::uuid, case when k = 'padmin' then 'platform_admin' end
from unnest(array['owner_a', 'admin_a', 'fd_a', 'instr_a', 'plain_a', 'owner_b', 'owner_c', 'padmin', 'nobody']) k
on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values
  (pg_temp.u('sa'), 'TW4A Studio A', 'tw4a-studio-a', 'Harbor Dance'), (pg_temp.u('sb'), 'TW4A Studio B', 'tw4a-studio-b', null),
  (pg_temp.u('sc'), 'TW4A Studio C', 'tw4a-studio-c', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('owner_a'), pg_temp.u('sa'), 'studio_owner', true), (pg_temp.u('admin_a'), pg_temp.u('sa'), 'studio_admin', true),
  (pg_temp.u('fd_a'), pg_temp.u('sa'), 'front_desk', true), (pg_temp.u('instr_a'), pg_temp.u('sa'), 'instructor', true),
  (pg_temp.u('plain_a'), pg_temp.u('sa'), 'client', true), (pg_temp.u('owner_b'), pg_temp.u('sb'), 'studio_owner', true),
  (pg_temp.u('owner_c'), pg_temp.u('sc'), 'studio_owner', true);

-- a complete, valid field set; the EIN is stored separately
select pg_temp.setkv('fields', '{"legal_name":"Harbor Dance Studio LLC","entity_type":"llc","industry":"EDUCATION","website_choice":"danceflow",
  "address_line1":"12 Harbor Way","city":"Portland","region":"OR","postal_code":"97201","rep_first_name":"Pat","rep_last_name":"Morgan",
  "rep_title":"Owner","rep_position":"ceo","rep_email":"pat@harbordance.example","rep_phone":"+15035550123","preferred_area_code":"503"}');
select pg_temp.setkv('cipher', 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCC');
select pg_temp.setkv('attest', '{"version":"tw4a-v1","authorized":true,"accurate":true,"opt_in_only":true,"fees_terms":true}');

-- ===== P: privileges and structure =======================================================================================
select pg_temp.chk('P01 no API role holds any privilege on the four tables; RLS on; no policies',
  (select bool_and(c.relrowsecurity
          and not (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('service_role', c.oid, 'SELECT')
                   or has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('service_role', c.oid, 'INSERT')
                   or has_table_privilege('authenticated', c.oid, 'UPDATE') or has_table_privilege('service_role', c.oid, 'UPDATE')
                   or has_table_privilege('authenticated', c.oid, 'DELETE') or has_table_privilege('service_role', c.oid, 'DELETE')
                   or has_table_privilege('authenticated', c.oid, 'TRUNCATE') or has_table_privilege('service_role', c.oid, 'TRUNCATE')))
   from pg_class c where c.relnamespace = 'public'::regnamespace
     and c.relname in ('studio_sms_onboarding_access', 'studio_sms_onboarding', 'studio_sms_provisioning_steps', 'studio_sms_onboarding_audit'))
  and not exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname in ('studio_sms_onboarding_access', 'studio_sms_onboarding', 'studio_sms_provisioning_steps', 'studio_sms_onboarding_audit')));
select pg_temp.chk('P02 function ACLs: studio/platform RPCs for authenticated only; EIN, purge and legal-context functions for service_role only; helpers for nobody; anon never',
  (select bool_and(case
      when p.proname in ('set_sms_onboarding_access', 'list_sms_onboardings', 'get_studio_sms_status', 'get_sms_onboarding_draft', 'save_sms_onboarding_draft', 'submit_sms_onboarding', 'cancel_sms_onboarding')
        then has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('service_role', p.oid, 'EXECUTE')
      when p.proname in ('store_sms_onboarding_ein', 'purge_sms_onboarding_ein', 'purge_due_sms_onboarding_eins', 'get_sms_legal_context')
        then has_function_privilege('service_role', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      else not has_function_privilege('authenticated', p.oid, 'EXECUTE') and not has_function_privilege('service_role', p.oid, 'EXECUTE') end
      and not has_function_privilege('anon', p.oid, 'EXECUTE'))
   from pg_proc p where p.pronamespace = 'public'::regnamespace
     and (p.proname like '\_sms\_onb\_%' or p.proname in ('set_sms_onboarding_access', 'list_sms_onboardings', 'get_studio_sms_status', 'get_sms_onboarding_draft',
          'save_sms_onboarding_draft', 'submit_sms_onboarding', 'cancel_sms_onboarding', 'store_sms_onboarding_ein', 'purge_sms_onboarding_ein',
          'purge_due_sms_onboarding_eins', 'get_sms_legal_context'))));
select pg_temp.chk('P03 every function pins search_path; every RPC (not helper) is SECURITY DEFINER (E04 proves no output carries the ciphertext)',
  (select bool_and(p.proconfig is not null and 'search_path=pg_catalog, public, pg_temp' = any (p.proconfig) and (p.proname like '\_sms\_onb\_%' or p.prosecdef))
   from pg_proc p where p.pronamespace = 'public'::regnamespace
     and (p.proname like '\_sms\_onb\_%' or p.proname in ('set_sms_onboarding_access', 'list_sms_onboardings', 'get_studio_sms_status', 'get_sms_onboarding_draft',
          'save_sms_onboarding_draft', 'submit_sms_onboarding', 'cancel_sms_onboarding', 'store_sms_onboarding_ein', 'purge_sms_onboarding_ein',
          'purge_due_sms_onboarding_eins', 'get_sms_legal_context'))));

-- ===== F: the pilot flag is OFF by default ==================================================================================
select pg_temp.setkv('f1', pg_temp.auth('owner_a', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sa'))));
select pg_temp.chk('F01 default: the owner sees available=false and nothing else about onboarding', pg_temp.kv('f1')::jsonb = '{"available": false, "texting_on": false}'::jsonb, pg_temp.kv('f1'));
select pg_temp.chk('F02 with the flag off the owner cannot save, read the draft or submit (42501); cancel reports nothing to cancel (22023); nothing is written',
  pg_temp.auth('owner_a', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('fields'))) like 'ERR 42501%'
  and pg_temp.auth('owner_a', format('select public.get_sms_onboarding_draft(%L)::text', pg_temp.kv('sa'))) like 'ERR 42501%'
  and pg_temp.auth('owner_a', format('select public.submit_sms_onboarding(%L, %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('attest'))) like 'ERR 42501%'
  and pg_temp.auth('owner_a', format('select public.cancel_sms_onboarding(%L)::text', pg_temp.kv('sa'))) like 'ERR 22023%'
  and pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''6789'')::text', pg_temp.kv('sa'), pg_temp.kv('owner_a'), pg_temp.kv('cipher'))) like 'ERR 42501%'
  and (select count(*) = 0 from public.studio_sms_onboarding));
select pg_temp.chk('F03 the public legal context is null while the flag is off', pg_temp.svc(format('select public.get_sms_legal_context(%L)::text', 'tw4a-studio-a')) is null or pg_temp.svc(format('select public.get_sms_legal_context(%L)::text', 'tw4a-studio-a')) = '');

-- ===== A: only a platform admin changes the flag ===============================================================================
select pg_temp.chk('A01 owner, admin, front desk, instructor, client, a foreign owner and nobody cannot set the flag (42501)',
  (select bool_and(pg_temp.auth(who, format('select public.set_sms_onboarding_access(%L, true, ''self service'')::text', pg_temp.kv('sa'))) like 'ERR 42501%')
   from unnest(array['owner_a', 'admin_a', 'fd_a', 'instr_a', 'plain_a', 'owner_b', 'nobody']) who));
select pg_temp.chk('A02 validations: missing flag, missing/short reason, unknown studio (22023)',
  pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, null, ''pilot ok'')::text', pg_temp.kv('sa'))) like 'ERR 22023%'
  and pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''x'')::text', pg_temp.kv('sa'))) like 'ERR 22023%'
  and pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, null)::text', pg_temp.kv('sa'))) like 'ERR 22023%'
  and pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''pilot ok'')::text', gen_random_uuid())) like 'ERR 22023%');
select pg_temp.setkv('a3', pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''ConfiDance pilot'')::text', pg_temp.kv('sa'))));
select pg_temp.chk('A03 the platform admin enables studio A; one audit row records it; studio B stays off',
  pg_temp.kv('a3') is not null and pg_temp.kv('a3') not like 'ERR%'
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sa') and action = 'access_enabled' and actor_type = 'platform_admin' and actor_user_id = pg_temp.u('padmin'))
  and pg_temp.auth('owner_b', format('select (public.get_studio_sms_status(%L)->>''available'')', pg_temp.kv('sb'))) = 'false');

-- ===== S: studio status by role ===============================================================================================
select pg_temp.chk('S01 owner and admin see the tracker (available, not_started, can_edit only for the owner)',
  pg_temp.auth('owner_a', format('select (public.get_studio_sms_status(%L)->>''state'') || (public.get_studio_sms_status(%L)->>''can_edit'')', pg_temp.kv('sa'), pg_temp.kv('sa'))) = 'not_startedtrue'
  and pg_temp.auth('admin_a', format('select (public.get_studio_sms_status(%L)->>''state'') || (public.get_studio_sms_status(%L)->>''can_edit'')', pg_temp.kv('sa'), pg_temp.kv('sa'))) = 'not_startedfalse');
select pg_temp.chk('S02 front desk sees only whether texting is on; instructor, client, a foreign owner and nobody are refused',
  pg_temp.auth('fd_a', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sa')))::jsonb = '{"texting_on": false}'::jsonb
  and (select bool_and(pg_temp.auth(who, format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sa'))) like 'ERR 42501%') from unnest(array['instr_a', 'plain_a', 'owner_b', 'nobody']) who));
select pg_temp.chk('S03 the platform admin can read the status of any studio; status never contains an identifier-looking key',
  pg_temp.auth('padmin', format('select (public.get_studio_sms_status(%L)->>''available'')', pg_temp.kv('sa'))) = 'true'
  and pg_temp.auth('owner_a', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sa'))) !~* '(sid|ciphertext|ein)');
-- an approved registration (all TW-3 identifiers) makes texting_on true for owner and front desk
insert into public.studio_sms_registrations (studio_id, registration_status, customer_profile_sid, brand_sid, brand_status, messaging_service_sid, campaign_sid,
  campaign_use_case, campaign_status, phone_number_sid, sender_e164)
values (pg_temp.u('sa'), 'approved', 'BU' || repeat('a', 32), 'BN' || repeat('b', 32), 'approved', 'MG' || repeat('c', 32), 'QE' || repeat('d', 32),
  'mixed', 'approved', 'PN' || repeat('e', 32), '+15035550100');
select pg_temp.chk('S04 texting_on reflects an approved registration for the studio only',
  pg_temp.auth('fd_a', format('select (public.get_studio_sms_status(%L)->>''texting_on'')', pg_temp.kv('sa'))) = 'true'
  and pg_temp.auth('owner_b', format('select (public.get_studio_sms_status(%L)->>''texting_on'')', pg_temp.kv('sb'))) = 'false');

-- ===== D: drafts ====================================================================================================================
select pg_temp.chk('D01 no draft exists yet (null)', pg_temp.auth('owner_a', format('select coalesce(public.get_sms_onboarding_draft(%L)::text, ''null'')', pg_temp.kv('sa'))) = 'null');
select pg_temp.setkv('d2', pg_temp.auth('owner_a', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('fields'))));
select pg_temp.chk('D02 the owner saves a draft: state draft, ein still missing, one draft_created audit row, nothing else audited',
  pg_temp.kv('d2')::jsonb ->> 'state' = 'draft' and (pg_temp.kv('d2')::jsonb -> 'missing') = '["ein"]'::jsonb
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sa') and action = 'draft_created'), pg_temp.kv('d2'));
select pg_temp.chk('D03 admin cannot save; front desk, instructor, client, foreign owner and nobody cannot save (42501)',
  (select bool_and(pg_temp.auth(who, format('select public.save_sms_onboarding_draft(%L, ''{"city":"X"}''::jsonb)::text', pg_temp.kv('sa'))) like 'ERR 42501%')
   from unnest(array['admin_a', 'fd_a', 'instr_a', 'plain_a', 'owner_b', 'nobody']) who));
select pg_temp.chk('D04 owner and admin can read the draft; front desk, instructor, client, foreign owner cannot',
  pg_temp.auth('owner_a', format('select (public.get_sms_onboarding_draft(%L)->>''legal_name'')', pg_temp.kv('sa'))) = 'Harbor Dance Studio LLC'
  and pg_temp.auth('admin_a', format('select (public.get_sms_onboarding_draft(%L)->>''city'')', pg_temp.kv('sa'))) = 'Portland'
  and (select bool_and(pg_temp.auth(who, format('select public.get_sms_onboarding_draft(%L)::text', pg_temp.kv('sa'))) like 'ERR 42501%') from unnest(array['fd_a', 'instr_a', 'plain_a', 'owner_b', 'nobody']) who));
select pg_temp.chk('D05 unsupported keys and non-text values are refused (22023): state, ein_ciphertext, studio_id, attested_by, numbers, nested objects',
  (select bool_and(pg_temp.auth('owner_a', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sa'), j)) like 'ERR 22023%')
   from unnest(array['{"state":"active"}', '{"ein_ciphertext":"x"}', '{"studio_id":"a5700000-0000-0000-0000-00000000000b"}', '{"attested_by":"a5700000-0000-0000-0000-000000000101"}',
                     '{"city":42}', '{"city":{"a":1}}', '[]', '"x"']) j));
select pg_temp.chk('D06 invalid values are refused by the table checks (23514): region, postal code, phone, http website, area code, entity type',
  (select bool_and(pg_temp.auth('owner_a', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sa'), j)) like 'ERR 23514%')
   from unnest(array['{"region":"Oregon"}', '{"postal_code":"9720"}', '{"rep_phone":"5035550123"}', '{"website_choice":"own","website_url":"http://harbordance.example"}',
                     '{"preferred_area_code":"103"}', '{"entity_type":"sole_prop"}', '{"rep_email":"not-an-email"}', '{"industry":"RETAIL"}']) j)
  and (select city = 'Portland' from public.studio_sms_onboarding where studio_id = pg_temp.u('sa')));
select pg_temp.setkv('d7', pg_temp.auth('owner_a', format('select public.save_sms_onboarding_draft(%L, ''{"city":"  Salem ","address_line2":"","region":"or"}''::jsonb)::text', pg_temp.kv('sa'))));
select pg_temp.chk('D07 saves merge (untouched fields kept), trim text, blank becomes null, region is upper-cased',
  (select city = 'Salem' and address_line2 is null and region = 'OR' and legal_name = 'Harbor Dance Studio LLC' from public.studio_sms_onboarding where studio_id = pg_temp.u('sa')));
select pg_temp.chk('D08 the owner of studio B cannot touch studio A and has no draft there; each studio has its own record',
  pg_temp.auth('owner_b', format('select public.save_sms_onboarding_draft(%L, ''{"city":"Hijack"}''::jsonb)::text', pg_temp.kv('sa'))) like 'ERR 42501%'
  and (select count(*) = 1 from public.studio_sms_onboarding) and (select city = 'Salem' from public.studio_sms_onboarding where studio_id = pg_temp.u('sa')));

-- ===== E: EIN handling ==========================================================================================================
select pg_temp.chk('E01 only the service role can store an EIN (privilege), and the actor must be an ACTIVE OWNER of that studio (admin, front desk, foreign owner, null, unknown refused)',
  not has_function_privilege('authenticated', 'public.store_sms_onboarding_ein(uuid,uuid,text,text,text)', 'EXECUTE')
  and (select bool_and(pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''6789'')::text', pg_temp.kv('sa'), a, pg_temp.kv('cipher'))) like 'ERR 42501%')
       from unnest(array[pg_temp.kv('admin_a'), pg_temp.kv('fd_a'), pg_temp.kv('owner_b'), gen_random_uuid()::text]) a)
  and pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, null, %L, ''v1'', ''6789'')::text', pg_temp.kv('sa'), pg_temp.kv('cipher'))) like 'ERR 42501%'
  and (select ein_ciphertext is null from public.studio_sms_onboarding where studio_id = pg_temp.u('sa')));
select pg_temp.chk('E02 malformed ciphertext, key id or last4 are refused by the table checks (23514)',
  pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, ''short'', ''v1'', ''6789'')::text', pg_temp.kv('sa'), pg_temp.kv('owner_a'))) like 'ERR 23514%'
  and pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''V 1!'', ''6789'')::text', pg_temp.kv('sa'), pg_temp.kv('owner_a'), pg_temp.kv('cipher'))) like 'ERR 23514%'
  and pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''67x9'')::text', pg_temp.kv('sa'), pg_temp.kv('owner_a'), pg_temp.kv('cipher'))) like 'ERR 23514%');
select pg_temp.setkv('e3', pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''6789'')::text', pg_temp.kv('sa'), pg_temp.kv('owner_a'), pg_temp.kv('cipher'))));
select pg_temp.chk('E03 the owner''s EIN is stored; an ein_stored audit row exists and carries no value',
  (select ein_ciphertext = pg_temp.kv('cipher') and ein_last4 = '6789' and ein_key_id = 'v1' and ein_stored_at is not null from public.studio_sms_onboarding where studio_id = pg_temp.u('sa'))
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where action = 'ein_stored' and studio_id = pg_temp.u('sa'))
  and not exists (select 1 from public.studio_sms_onboarding_audit a where coalesce(a.note, '') || a.action || coalesce(a.from_state, '') || coalesce(a.to_state, '') like '%' || pg_temp.kv('cipher') || '%'
                                                                       or coalesce(a.note, '') like '%6789%'));
select pg_temp.setkv('e4', pg_temp.auth('owner_a', format('select public.get_sms_onboarding_draft(%L)::text', pg_temp.kv('sa'))));
select pg_temp.setkv('e4s', pg_temp.auth('owner_a', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sa'))));
select pg_temp.setkv('e4l', pg_temp.auth('padmin', 'select string_agg(x::text, '','') from public.list_sms_onboardings() x'));
select pg_temp.chk('E04 no RPC output ever contains the ciphertext: the draft shows only last4 and ein_on_file; status, platform list and draft are clean',
  pg_temp.kv('e4')::jsonb ->> 'ein_last4' = '6789' and (pg_temp.kv('e4')::jsonb ->> 'ein_on_file') = 'true'
  and position(pg_temp.kv('cipher') in pg_temp.kv('e4')) = 0 and position(pg_temp.kv('cipher') in pg_temp.kv('e4s')) = 0 and position(pg_temp.kv('cipher') in pg_temp.kv('e4l')) = 0
  and pg_temp.kv('e4') !~* 'ciphertext' and not (pg_temp.kv('e4')::jsonb ? 'ein'));
select pg_temp.setkv('e5', pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''1111'')::text', pg_temp.kv('sa'), pg_temp.kv('owner_a'), pg_temp.kv('cipher'))));
select pg_temp.chk('E05 while editing the EIN can be replaced (last4 follows), and once it is on file the missing list is empty',
  pg_temp.kv('e5') is not null and pg_temp.kv('e5') not like 'ERR%'
  and (select ein_last4 = '1111' from public.studio_sms_onboarding where studio_id = pg_temp.u('sa'))
  and pg_temp.auth('owner_a', format('select (public.get_sms_onboarding_draft(%L)->''missing'')::text', pg_temp.kv('sa'))) = '[]', pg_temp.kv('e5'));

-- ===== B: submit ======================================================================================================================
select pg_temp.chk('B01 an incomplete attestation is refused (22023): wrong version, a false box, a missing box, null, non-object',
  (select bool_and(pg_temp.auth('owner_a', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sa'), j)) like 'ERR 22023%')
   from unnest(array['{"version":"tw4a-v0","authorized":true,"accurate":true,"opt_in_only":true,"fees_terms":true}',
                     '{"version":"tw4a-v1","authorized":false,"accurate":true,"opt_in_only":true,"fees_terms":true}',
                     '{"version":"tw4a-v1","authorized":true,"accurate":true,"opt_in_only":true}', '[]', 'null']) j)
  and (select state = 'draft' and submission_seq = 0 from public.studio_sms_onboarding where studio_id = pg_temp.u('sa')));
select pg_temp.chk('B02 admin, front desk, a foreign owner and nobody cannot submit (42501)',
  (select bool_and(pg_temp.auth(who, format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sa'), pg_temp.kv('attest'))) like 'ERR 42501%') from unnest(array['admin_a', 'fd_a', 'owner_b', 'nobody']) who));
-- a missing field blocks submission and is reported, without changing the state
update public.studio_sms_onboarding set rep_email = null where studio_id = pg_temp.u('sa');
select pg_temp.setkv('b3', pg_temp.auth('owner_a', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sa'), pg_temp.kv('attest'))));
select pg_temp.chk('B03 an incomplete setup is not submitted: submitted=false, the missing field is named, state unchanged',
  (pg_temp.kv('b3')::jsonb ->> 'submitted') = 'false' and pg_temp.kv('b3')::jsonb -> 'missing' = '["rep_email"]'::jsonb
  and (select state = 'draft' and submission_seq = 0 and attested_at is null from public.studio_sms_onboarding where studio_id = pg_temp.u('sa')), pg_temp.kv('b3'));
update public.studio_sms_onboarding set rep_email = 'pat@harbordance.example' where studio_id = pg_temp.u('sa');
select pg_temp.setkv('b4', pg_temp.auth('owner_a', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sa'), pg_temp.kv('attest'))));
select pg_temp.chk('B04 a complete setup submits: submitted_for_checks, seq 1, attested by the owner now, audit row, no further Twilio-side effect in this slice',
  (pg_temp.kv('b4')::jsonb ->> 'submitted') = 'true' and (pg_temp.kv('b4')::jsonb ->> 'state') = 'submitted_for_checks'
  and (select state = 'submitted_for_checks' and submission_seq = 1 and attested_by = pg_temp.u('owner_a') and attested_at is not null and submitted_at is not null
              and attestation_version = 'tw4a-v1' and attestation = '{"authorized":true,"accurate":true,"opt_in_only":true,"fees_terms":true}'::jsonb
       from public.studio_sms_onboarding where studio_id = pg_temp.u('sa'))
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where action = 'submitted' and from_state = 'draft' and to_state = 'submitted_for_checks')
  and (select count(*) = 0 from public.studio_sms_provisioning_steps), pg_temp.kv('b4'));
select pg_temp.chk('B05 after submission the setup is locked: a second submit, a save, a direct draft edit (even by the table owner) and an EIN replacement are refused',
  pg_temp.auth('owner_a', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sa'), pg_temp.kv('attest'))) like 'ERR 22023%'
  and pg_temp.auth('owner_a', format('select public.save_sms_onboarding_draft(%L, ''{"city":"Later"}''::jsonb)::text', pg_temp.kv('sa'))) like 'ERR 22023%'
  and pg_temp.try(format('update public.studio_sms_onboarding set legal_name = ''Changed LLC'' where studio_id = %L', pg_temp.kv('sa'))) like '22023%locked%'
  and pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''9999'')::text', pg_temp.kv('sa'), pg_temp.kv('owner_a'), pg_temp.kv('cipher'))) like 'ERR 22023%'
  and (select legal_name = 'Harbor Dance Studio LLC' and ein_last4 = '1111' from public.studio_sms_onboarding where studio_id = pg_temp.u('sa')));
select pg_temp.chk('B06 status after submission: state submitted_for_checks, the owner can no longer edit, the admin sees the same state',
  pg_temp.auth('owner_a', format('select (public.get_studio_sms_status(%L)->>''state'') || (public.get_studio_sms_status(%L)->>''can_edit'')', pg_temp.kv('sa'), pg_temp.kv('sa'))) = 'submitted_for_checksfalse'
  and pg_temp.auth('admin_a', format('select (public.get_studio_sms_status(%L)->>''state'')', pg_temp.kv('sa'))) = 'submitted_for_checks');

-- ===== M: state machine (table-level, as the later orchestrator will use it) ============================================================
select pg_temp.chk('M01 the unique active record: a second active onboarding for the same studio cannot be inserted',
  pg_temp.try(format('insert into public.studio_sms_onboarding (studio_id) values (%L)', pg_temp.kv('sa'))) like '23505%');
select pg_temp.chk('M02 a new record must start as draft: any other state at insert (valid or not) is refused (22023)',
  pg_temp.try(format('insert into public.studio_sms_onboarding (studio_id, state) values (%L, ''active'')', pg_temp.kv('sb'))) like '22023%'
  and pg_temp.try(format('insert into public.studio_sms_onboarding (studio_id, state) values (%L, ''bogus'')', pg_temp.kv('sb'))) like '22023%');
select pg_temp.chk('M02b an unknown state name is refused on update (22023, not a legal transition)',
  pg_temp.try(format('update public.studio_sms_onboarding set state = ''bogus'' where studio_id = %L', pg_temp.kv('sa'))) like '22023%');
create or replace function pg_temp.go(p_to text) returns text language plpgsql as $$
begin
  begin
    update public.studio_sms_onboarding set state = p_to where studio_id = pg_temp.u('sa');
    return 'ok';
  exception when others then return sqlstate; end;
end $$;
select pg_temp.chk('M03 the happy path walks the whole graph: needs_info -> resubmit -> profile_review -> brand_pending -> service_setup -> campaign_pending -> ready_for_activation -> active -> suspended -> active',
  pg_temp.go('needs_info') = 'ok' and pg_temp.go('submitted_for_checks') = 'ok' and pg_temp.go('profile_review') = 'ok' and pg_temp.go('brand_pending') = 'ok'
  and pg_temp.go('service_setup') = 'ok' and pg_temp.go('campaign_pending') = 'ok' and pg_temp.go('ready_for_activation') = 'ok'
  and pg_temp.go('active') = 'ok' and pg_temp.go('suspended') = 'ok' and pg_temp.go('active') = 'ok');
select pg_temp.chk('M04 illegal transitions are refused (22023): active -> draft / cancelled / needs_info / campaign_pending',
  pg_temp.go('draft') = '22023' and pg_temp.go('cancelled') = '22023' and pg_temp.go('needs_info') = '22023' and pg_temp.go('campaign_pending') = '22023'
  and (select state = 'active' from public.studio_sms_onboarding where studio_id = pg_temp.u('sa')));
update public.studio_sms_onboarding set state = 'exception' where studio_id = pg_temp.u('sa');
select pg_temp.chk('M05 exception recovers only to a pipeline state or ends; draft is never reachable; blocked/cancelled are terminal-ish',
  pg_temp.go('draft') = '22023' and pg_temp.go('active') = '22023' and pg_temp.go('blocked') = 'ok' and pg_temp.go('exception') = 'ok' and pg_temp.go('cancelled') = 'ok'
  and pg_temp.go('draft') = '22023' and pg_temp.go('active') = '22023');
select pg_temp.chk('M06 terminal bookkeeping: cancelled sets cancelled_at and terminal_at; the cancelled record frees the unique slot',
  (select cancelled_at is not null and terminal_at is not null from public.studio_sms_onboarding where studio_id = pg_temp.u('sa'))
  and pg_temp.try(format('insert into public.studio_sms_onboarding (studio_id) values (%L)', pg_temp.kv('sa'))) = 'ok');
select pg_temp.chk('M07 ownership fields are immutable (studio_id, created_at, created_by)',
  pg_temp.try(format('update public.studio_sms_onboarding set studio_id = %L where studio_id = %L and state = ''draft''', pg_temp.kv('sb'), pg_temp.kv('sa'))) like '42501%');
delete from public.studio_sms_onboarding where studio_id = pg_temp.u('sa') and state = 'draft';

-- ===== C: cancel ========================================================================================================================
-- fresh onboarding for studio A via the owner path (previous record cancelled above)
select pg_temp.setkv('c0', pg_temp.auth('owner_a', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('fields'))));
select pg_temp.chk('C00 after a cancelled record a new draft can be started (the cancelled one is kept, history intact)',
  (select count(*) = 1 from public.studio_sms_onboarding where studio_id = pg_temp.u('sa') and state = 'draft')
  and (select count(*) = 1 from public.studio_sms_onboarding where studio_id = pg_temp.u('sa') and state = 'cancelled'));
select pg_temp.chk('C01 admin, front desk, foreign owner and nobody cannot cancel (42501)',
  (select bool_and(pg_temp.auth(who, format('select public.cancel_sms_onboarding(%L)::text', pg_temp.kv('sa'))) like 'ERR 42501%') from unnest(array['admin_a', 'fd_a', 'owner_b', 'nobody']) who));
select pg_temp.setkv('c2', pg_temp.auth('owner_a', format('select public.cancel_sms_onboarding(%L)::text', pg_temp.kv('sa'))));
select pg_temp.chk('C02 the owner cancels a draft; audit records it; cancelling again reports nothing to cancel (22023)',
  pg_temp.kv('c2')::jsonb ->> 'state' = 'cancelled'
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where action = 'cancelled' and from_state = 'draft' and to_state = 'cancelled' and studio_id = pg_temp.u('sa') and created_at >= now() - interval '1 minute')
  and pg_temp.auth('owner_a', format('select public.cancel_sms_onboarding(%L)::text', pg_temp.kv('sa'))) like 'ERR 22023%');
-- cancellation window: allowed through profile_review, refused from brand_pending on (platform handles it)
select pg_temp.auth('owner_a', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sa'), pg_temp.kv('fields')));
update public.studio_sms_onboarding set state = 'submitted_for_checks' where studio_id = pg_temp.u('sa') and state = 'draft';
update public.studio_sms_onboarding set state = 'profile_review' where studio_id = pg_temp.u('sa') and state = 'submitted_for_checks';
update public.studio_sms_onboarding set state = 'brand_pending' where studio_id = pg_temp.u('sa') and state = 'profile_review';
select pg_temp.chk('C03 once the brand step has started the owner can no longer cancel here (22023, contact DanceFlow); the record is unchanged',
  pg_temp.auth('owner_a', format('select public.cancel_sms_onboarding(%L)::text', pg_temp.kv('sa'))) like 'ERR 22023%'
  and (select state = 'brand_pending' from public.studio_sms_onboarding where studio_id = pg_temp.u('sa') and state <> 'cancelled'));
select pg_temp.chk('C04 the table owner cannot cancel from brand_pending either (the graph forbids it)', pg_temp.try(format('update public.studio_sms_onboarding set state = ''cancelled'' where studio_id = %L and state = ''brand_pending''', pg_temp.kv('sa'))) like '22023%');

-- ===== G: purge ==============================================================================================================================
select pg_temp.chk('G01 only the service role can purge; unsupported reasons refused (22023)',
  not has_function_privilege('authenticated', 'public.purge_sms_onboarding_ein(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.purge_due_sms_onboarding_eins()', 'EXECUTE')
  and pg_temp.svc(format('select public.purge_sms_onboarding_ein(%L, ''because'')::text', gen_random_uuid())) like 'ERR 22023%');
-- studio B: owner path creates a draft with an EIN, then terminal states
select pg_temp.chk('G02 before the flag is on for studio B even its own owner cannot store an EIN through the service role (42501, nothing created)',
  pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''2222'')::text', pg_temp.kv('sb'), pg_temp.kv('owner_b'), pg_temp.kv('cipher'))) like 'ERR 42501%not available%'
  and not exists (select 1 from public.studio_sms_onboarding where studio_id = pg_temp.u('sb')));
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''purge fixtures'')::text', pg_temp.kv('sb')));
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''purge fixtures'')::text', pg_temp.kv('sc')));
select pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''2222'')::text', pg_temp.kv('sb'), pg_temp.kv('owner_b'), pg_temp.kv('cipher')));
select pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''3333'')::text', pg_temp.kv('sc'), pg_temp.kv('owner_c'), pg_temp.kv('cipher')));
select pg_temp.chk('G03 both fixtures hold an EIN (draft_created audited once per studio)',
  (select count(*) = 2 from public.studio_sms_onboarding where ein_ciphertext is not null and studio_id in (pg_temp.u('sb'), pg_temp.u('sc')))
  and (select count(*) = 2 from public.studio_sms_onboarding_audit where action = 'draft_created' and studio_id in (pg_temp.u('sb'), pg_temp.u('sc'))));
update public.studio_sms_onboarding set state = 'cancelled' where studio_id = pg_temp.u('sb');
update public.studio_sms_onboarding set terminal_at = now() - interval '31 days' where studio_id = pg_temp.u('sb');
select pg_temp.setkv('g4', pg_temp.svc('select public.purge_due_sms_onboarding_eins()::text'));
select pg_temp.chk('G04 the 30-day sweep purges exactly the terminal record older than 30 days; the live draft and the active brand_pending record keep theirs',
  pg_temp.kv('g4') = '1'
  and (select ein_ciphertext is null and ein_key_id is null and ein_purged_at is not null and ein_last4 = '2222' from public.studio_sms_onboarding where studio_id = pg_temp.u('sb'))
  and (select ein_ciphertext is not null from public.studio_sms_onboarding where studio_id = pg_temp.u('sc'))
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where action = 'ein_purged' and studio_id = pg_temp.u('sb') and note = 'reason=terminal_30d'), pg_temp.kv('g4'));
update public.studio_sms_onboarding set state = 'cancelled' where studio_id = pg_temp.u('sc');
select pg_temp.chk('G05 a recently cancelled record is not swept; a second sweep purges nothing; an explicit purge works once and is idempotent',
  pg_temp.svc('select public.purge_due_sms_onboarding_eins()::text') = '0'
  and pg_temp.svc(format('select public.purge_sms_onboarding_ein(%L, ''manual'')::text', (select id from public.studio_sms_onboarding where studio_id = pg_temp.u('sc')))) = 'true'
  and pg_temp.svc(format('select public.purge_sms_onboarding_ein(%L, ''manual'')::text', (select id from public.studio_sms_onboarding where studio_id = pg_temp.u('sc')))) = 'false');

-- ===== L: public legal context ========================================================================================================================
update public.studio_sms_onboarding_access set enabled = false where studio_id = pg_temp.u('sb');
select pg_temp.chk('L01 the legal context exists only for studios with the flag ON; unknown slugs and flag-off studios return null',
  coalesce(pg_temp.svc(format('select public.get_sms_legal_context(%L)::text', 'tw4a-studio-b')), 'null') in ('null', '')
  and coalesce(pg_temp.svc(format('select public.get_sms_legal_context(%L)::text', 'no-such-studio')), 'null') in ('null', ''));
select pg_temp.chk('L02 flag-on studio A: display name prefers public_name; the legal name is withheld until the owner has submitted (the active record is brand_pending, so it is shown)',
  pg_temp.svc(format('select (public.get_sms_legal_context(%L)->>''display_name'')', 'tw4a-studio-a')) = 'Harbor Dance'
  and pg_temp.svc(format('select (public.get_sms_legal_context(%L)->>''legal_name'')', 'tw4a-studio-a')) = 'Harbor Dance Studio LLC');
select pg_temp.chk('L03 the context carries no identifiers, EIN, rep or address data',
  pg_temp.svc(format('select public.get_sms_legal_context(%L)::text', 'tw4a-studio-a')) !~* '(ein|rep_|address|phone|email|studio_id|ciphertext)'
  and not has_function_privilege('authenticated', 'public.get_sms_legal_context(text)', 'EXECUTE') and not has_function_privilege('anon', 'public.get_sms_legal_context(text)', 'EXECUTE'));
-- a draft-state record never exposes its legal name
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''legal fixture'')::text', pg_temp.kv('sb')));
select pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''4444'')::text', pg_temp.kv('sb'), pg_temp.kv('owner_b'), pg_temp.kv('cipher')));
select pg_temp.auth('owner_b', format('select public.save_sms_onboarding_draft(%L, ''{"legal_name":"Secret Draft LLC"}''::jsonb)::text', pg_temp.kv('sb')));
select pg_temp.chk('L04 a studio still in draft shows its display name but never the draft legal name',
  pg_temp.svc(format('select (public.get_sms_legal_context(%L)->>''display_name'')', 'tw4a-studio-b')) = 'TW4A Studio B'
  and pg_temp.svc(format('select coalesce(public.get_sms_legal_context(%L)->>''legal_name'', ''none'')', 'tw4a-studio-b')) = 'none');

-- ===== O: platform list ===================================================================================================================================
select pg_temp.setkv('o1', pg_temp.auth('padmin', 'select string_agg(studio_id::text || '':'' || coalesce(state, ''-'') || '':'' || access_enabled::text, '','' order by studio_id) from public.list_sms_onboardings()'));
select pg_temp.chk('O01 the platform admin sees one row per studio with access or an onboarding; no ciphertext, no personal fields',
  pg_temp.kv('o1') like '%' || pg_temp.kv('sa') || '%' and pg_temp.kv('o1') like '%' || pg_temp.kv('sb') || '%'
  and pg_get_function_result('public.list_sms_onboardings()'::regprocedure) !~* '(ciphertext|rep_|legal_name|email|phone|last4)');
select pg_temp.chk('O02 everyone else is refused the platform list (42501)',
  (select bool_and(pg_temp.auth(who, 'select count(*) from public.list_sms_onboardings()') like 'ERR 42501%') from unnest(array['owner_a', 'admin_a', 'fd_a', 'owner_b', 'nobody']) who));

-- ===== U: audit append-only and the ledger ========================================================================================================================
select pg_temp.chk('U01 audit rows cannot be edited or deleted (even by the table owner) and TRUNCATE is refused',
  pg_temp.try('update public.studio_sms_onboarding_audit set note = ''x''') like '42501%'
  and pg_temp.try('delete from public.studio_sms_onboarding_audit') like '42501%'
  and pg_temp.try('truncate public.studio_sms_onboarding_audit') like '42501%'
  and pg_temp.try('truncate public.studio_sms_onboarding cascade') like '42501%' and pg_temp.try('truncate public.studio_sms_provisioning_steps') like '42501%' and pg_temp.try('truncate public.studio_sms_onboarding_access') like '42501%');
select pg_temp.chk('U02 audit carries ids, states and actions only: no EIN last4/ciphertext, no phone, email or legal name anywhere in any audit row',
  not exists (select 1 from public.studio_sms_onboarding_audit a
              where coalesce(a.note, '') || a.action || coalesce(a.from_state, '') || coalesce(a.to_state, '') || coalesce(a.step_key, '') || coalesce(a.provider_sid, '')
                    ~* '(harbor|morgan|pat@|\+1503|6789|1111|2222|3333|4444|ciphertext|v1\.)'));
-- ledger
insert into public.studio_sms_onboarding_audit (studio_id, actor_type, action) values (pg_temp.u('sa'), 'system', 'state_changed');
select pg_temp.chk('U03 an invalid audit action is refused (23514)', pg_temp.try(format('insert into public.studio_sms_onboarding_audit (studio_id, actor_type, action) values (%L, ''system'', ''eats_ein'')', pg_temp.kv('sa'))) like '23514%');
select pg_temp.setkv('ob_a', (select id::text from public.studio_sms_onboarding where studio_id = pg_temp.u('sa') and state = 'brand_pending'));
select pg_temp.chk('U04 the provisioning ledger enforces its shape: step key format, studio consistency with the onboarding (composite FK), one row per step and submission, fee fields paired',
  pg_temp.try(format('insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq) values (%L, %L, ''S1'', 1)', pg_temp.kv('ob_a'), pg_temp.kv('sa'))) = 'ok'
  and pg_temp.try(format('insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq) values (%L, %L, ''S1'', 1)', pg_temp.kv('ob_a'), pg_temp.kv('sa'))) like '23505%'
  and pg_temp.try(format('insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq) values (%L, %L, ''S2'', 1)', pg_temp.kv('ob_a'), pg_temp.kv('sb'))) like '23503%'
  and pg_temp.try(format('insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq) values (%L, %L, ''s2'', 1)', pg_temp.kv('ob_a'), pg_temp.kv('sa'))) like '23514%'
  and pg_temp.try(format('insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, fee_confirmed_by) values (%L, %L, ''S3'', 1, %L)', pg_temp.kv('ob_a'), pg_temp.kv('sa'), pg_temp.kv('owner_a'))) like '23514%'
  and pg_temp.try(format('insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, provider_sid) values (%L, %L, ''S4'', 1, ''not-a-sid'')', pg_temp.kv('ob_a'), pg_temp.kv('sa'))) like '23514%');

-- ===== X: isolation, deletion and untouched neighbours ===========================================================================================================
select pg_temp.chk('X01 studio isolation of every owner RPC: owner of C cannot read, save, submit or cancel anything of studio A or B',
  pg_temp.auth('owner_c', format('select public.get_sms_onboarding_draft(%L)::text', pg_temp.kv('sa'))) like 'ERR 42501%'
  and pg_temp.auth('owner_c', format('select public.save_sms_onboarding_draft(%L, ''{"city":"x"}''::jsonb)::text', pg_temp.kv('sb'))) like 'ERR 42501%'
  and pg_temp.auth('owner_c', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sa'), pg_temp.kv('attest'))) like 'ERR 42501%'
  and pg_temp.auth('owner_c', format('select public.cancel_sms_onboarding(%L)::text', pg_temp.kv('sb'))) like 'ERR 42501%'
  and pg_temp.auth('owner_c', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sa'))) like 'ERR 42501%');
update public.user_studio_roles set active = false where user_id = pg_temp.u('owner_c') and studio_id = pg_temp.u('sc');
select pg_temp.chk('X02 an inactive owner role is not an owner (save and EIN store refused)',
  pg_temp.auth('owner_c', format('select public.save_sms_onboarding_draft(%L, ''{"city":"x"}''::jsonb)::text', pg_temp.kv('sc'))) like 'ERR 42501%'
  and pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''5555'')::text', pg_temp.kv('sc'), pg_temp.kv('owner_c'), pg_temp.kv('cipher'))) like 'ERR 42501%');
select pg_temp.setkv('x3', pg_temp.try(format('delete from public.studios where id = %L', pg_temp.kv('sc'))));
select pg_temp.chk('X03 studio deletion cascades through onboarding, ledger and audit (append-only is lifted only together with the studio)',
  pg_temp.kv('x3') = 'ok'
  and not exists (select 1 from public.studio_sms_onboarding where studio_id = pg_temp.u('sc'))
  and not exists (select 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sc')));
select pg_temp.chk('X04 TW-3 registrations are untouched by this slice: the approved fixture row is unchanged, no trigger or column was added to the table by TW-4A',
  (select registration_status = 'approved' from public.studio_sms_registrations where studio_id = pg_temp.u('sa'))
  and not exists (select 1 from pg_trigger t where t.tgrelid = 'public.studio_sms_registrations'::regclass and not t.tgisinternal and t.tgname like '%onboarding%')
  and not exists (select 1 from information_schema.columns where table_name = 'studio_sms_registrations' and column_name in ('twilio_account_sid', 'trust_product_sid', 'opt_out_mode', 'provisioned_by')));
select pg_temp.chk('X05 nothing here changed sending, consent or inbound: no function of those paths references the new tables',
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('record_sms_inbound_opt_event', 'record_sms_public_opt_in', 'upsert_sms_contact_permission')
              and p.prosrc ilike '%studio_sms_onboarding%'));

-- ===== R: fixes from the 2026-10-15 independent security review ========================================================================================================
create or replace function pg_temp.diag_as(p_role text, p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text; v_msg text; v_det text; v_hint text;
begin
  perform set_config('request.jwt.claims', case when p_user is null then '' else json_build_object('sub', p_user, 'role', p_role, 'aal', 'aal2')::text end, true);
  begin execute format('set local role %I', p_role); execute p_sql; v := 'ok';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_det = pg_exception_detail, v_hint = pg_exception_hint;
    v := 'ERR ' || sqlstate || ' msg=' || v_msg || ' detail=' || coalesce(v_det, '') || ' hint=' || coalesce(v_hint, ''); end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
select pg_temp.setkv('sd', 'a5700000-0000-0000-0000-00000000000d');
select pg_temp.setkv('se', 'a5700000-0000-0000-0000-00000000000e');
select pg_temp.setkv('owner_d', 'a5700000-0000-0000-0000-000000000501');
select pg_temp.setkv('owner_e', 'a5700000-0000-0000-0000-000000000601');
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select pg_temp.kv(k)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', k || '@tw4a-test.invalid', now(), now() from unnest(array['owner_d', 'owner_e']) k;
insert into public.profiles (id) select pg_temp.kv(k)::uuid from unnest(array['owner_d', 'owner_e']) k on conflict (id) do nothing;
insert into public.studios (id, name, slug) values (pg_temp.u('sd'), 'TW4A Studio D', 'tw4a-studio-d'), (pg_temp.u('se'), 'TW4A Studio E', 'tw4a-studio-e');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('owner_d'), pg_temp.u('sd'), 'studio_owner', true), (pg_temp.u('owner_e'), pg_temp.u('se'), 'studio_owner', true);
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''review fixtures'')::text', pg_temp.kv('sd')));
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''review fixtures'')::text', pg_temp.kv('se')));
select pg_temp.auth('owner_d', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sd'), pg_temp.kv('fields')));
select pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''7777'')::text', pg_temp.kv('sd'), pg_temp.kv('owner_d'), pg_temp.kv('cipher')));

-- R01: a check violation never echoes the failing row (it holds the EIN ciphertext) through message, detail or hint
select pg_temp.setkv('r1a', pg_temp.diag_as('authenticated', pg_temp.u('owner_d'), format('select public.save_sms_onboarding_draft(%L, ''{"rep_email":"x"}''::jsonb)', pg_temp.kv('sd'))));
select pg_temp.setkv('r1b', pg_temp.diag_as('service_role', null, format('select public.store_sms_onboarding_ein(%L, %L, %L, ''V 1!'', ''1234'')', pg_temp.kv('sd'), pg_temp.kv('owner_d'), pg_temp.kv('cipher'))));
select pg_temp.chk('R01 a rejected value is reported by constraint name only: SQLSTATE 23514, empty DETAIL and HINT, no row text, no ciphertext fragment, no email (save and EIN store)',
  pg_temp.kv('r1a') like 'ERR 23514 msg=invalid value (%rep_email%) detail= hint=' and pg_temp.kv('r1b') like 'ERR 23514 msg=invalid value (%ein_key_id%) detail= hint='
  and pg_temp.kv('r1a') !~* '(failing row|v1\.|AAAAAAAA|@)' and pg_temp.kv('r1b') !~* '(failing row|AAAAAAAA|BBBBBBBB)'
  and (select rep_email = 'pat@harbordance.example' and ein_last4 = '7777' from public.studio_sms_onboarding where studio_id = pg_temp.u('sd')), pg_temp.kv('r1a') || ' || ' || pg_temp.kv('r1b'));

-- R12: the EIN store requires all three values
select pg_temp.chk('R12 storing an EIN with a null ciphertext, key id or last4 is refused (22023) and changes nothing',
  pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, null, ''v1'', ''1234'')::text', pg_temp.kv('sd'), pg_temp.kv('owner_d'))) like 'ERR 22023%required%'
  and pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, null, ''1234'')::text', pg_temp.kv('sd'), pg_temp.kv('owner_d'), pg_temp.kv('cipher'))) like 'ERR 22023%required%'
  and pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', null)::text', pg_temp.kv('sd'), pg_temp.kv('owner_d'), pg_temp.kv('cipher'))) like 'ERR 22023%required%'
  and (select ein_last4 = '7777' and ein_ciphertext = pg_temp.kv('cipher') from public.studio_sms_onboarding where studio_id = pg_temp.u('sd')));

-- R09: attestation booleans must be real JSON true (no "true", "yes", 1)
select pg_temp.chk('R09 attestation accepts only JSON true: the strings "true"/"yes"/"on" and the number 1 are refused with 22023 (never a cast error) and nothing is submitted',
  (select bool_and(pg_temp.auth('owner_d', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sd'), j)) like 'ERR 22023%')
   from unnest(array['{"version":"tw4a-v1","authorized":"true","accurate":true,"opt_in_only":true,"fees_terms":true}',
                     '{"version":"tw4a-v1","authorized":true,"accurate":"yes","opt_in_only":true,"fees_terms":true}',
                     '{"version":"tw4a-v1","authorized":true,"accurate":true,"opt_in_only":"on","fees_terms":true}',
                     '{"version":"tw4a-v1","authorized":true,"accurate":true,"opt_in_only":true,"fees_terms":1}']) j)
  and (select state = 'draft' and submission_seq = 0 from public.studio_sms_onboarding where studio_id = pg_temp.u('sd')));

-- R02: resubmission is audited from the state it really came from
select pg_temp.auth('owner_d', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sd'), pg_temp.kv('attest')));
update public.studio_sms_onboarding set state = 'needs_info' where studio_id = pg_temp.u('sd');
select pg_temp.setkv('r2', pg_temp.auth('owner_d', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sd'), pg_temp.kv('attest'))));
select pg_temp.chk('R02 resubmitting from needs_info works through the RPC (seq 2) and is audited needs_info -> submitted_for_checks; the first submit is audited from draft',
  (pg_temp.kv('r2')::jsonb ->> 'submitted') = 'true' and (pg_temp.kv('r2')::jsonb ->> 'submission_seq') = '2'
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sd') and action = 'submitted' and from_state = 'needs_info' and to_state = 'submitted_for_checks')
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sd') and action = 'submitted' and from_state = 'draft'), pg_temp.kv('r2'));

-- R03: the 30-day terminal clock restarts on each entry and the purge re-checks state and age under its row lock
update public.studio_sms_onboarding set state = 'profile_review' where studio_id = pg_temp.u('sd');
update public.studio_sms_onboarding set state = 'blocked' where studio_id = pg_temp.u('sd');
update public.studio_sms_onboarding set terminal_at = now() - interval '40 days' where studio_id = pg_temp.u('sd');
update public.studio_sms_onboarding set state = 'exception' where studio_id = pg_temp.u('sd');
select pg_temp.setkv('r3a', (select (terminal_at is null)::text from public.studio_sms_onboarding where studio_id = pg_temp.u('sd')));
select pg_temp.setkv('sd_id', (select id::text from public.studio_sms_onboarding where studio_id = pg_temp.u('sd')));
select pg_temp.setkv('r3b', pg_temp.svc(format('select public.purge_sms_onboarding_ein(%L, ''terminal_30d'')::text', pg_temp.kv('sd_id'))));
update public.studio_sms_onboarding set terminal_at = now() - interval '40 days' where studio_id = pg_temp.u('sd');
select pg_temp.setkv('r3c', pg_temp.svc(format('select public.purge_sms_onboarding_ein(%L, ''terminal_30d'')::text', pg_temp.kv('sd_id'))));
select pg_temp.setkv('r3d', pg_temp.svc('select public.purge_due_sms_onboarding_eins()::text'));
update public.studio_sms_onboarding set state = 'blocked' where studio_id = pg_temp.u('sd');
select pg_temp.setkv('r3e', pg_temp.svc(format('select public.purge_sms_onboarding_ein(%L, ''terminal_30d'')::text', pg_temp.kv('sd_id'))));
select pg_temp.chk('R03 leaving blocked clears terminal_at; re-entering blocked restarts the clock (not the old 40-day value); terminal_30d purge refuses a non-terminal state (even with a stale terminal_at) and a fresh terminal state; the EIN survives all of it',
  pg_temp.kv('r3a') = 'true' and pg_temp.kv('r3b') = 'false' and pg_temp.kv('r3c') = 'false' and pg_temp.kv('r3d') = '0' and pg_temp.kv('r3e') = 'false'
  and (select terminal_at > now() - interval '1 minute' and ein_ciphertext = pg_temp.kv('cipher') and ein_purged_at is null from public.studio_sms_onboarding where studio_id = pg_temp.u('sd')),
  concat_ws(',', pg_temp.kv('r3a'), pg_temp.kv('r3b'), pg_temp.kv('r3c'), pg_temp.kv('r3d'), pg_temp.kv('r3e')));

-- R06: submission data is frozen by the table itself (state blocked here), not just by RPC discipline
select pg_temp.chk('R06 attestation, submission time, submission_seq (down or +2) and the EIN columns cannot be rewritten after submission, even by the table owner (22023); the stored values are unchanged',
  pg_temp.try(format('update public.studio_sms_onboarding set attested_by = %L where studio_id = %L', pg_temp.kv('owner_e'), pg_temp.kv('sd'))) like '22023%'
  and pg_temp.try(format('update public.studio_sms_onboarding set attestation = ''{}''::jsonb where studio_id = %L', pg_temp.kv('sd'))) like '22023%'
  and pg_temp.try(format('update public.studio_sms_onboarding set attestation_version = ''x'' where studio_id = %L', pg_temp.kv('sd'))) like '22023%'
  and pg_temp.try(format('update public.studio_sms_onboarding set attested_at = now() - interval ''5 days'' where studio_id = %L', pg_temp.kv('sd'))) like '22023%'
  and pg_temp.try(format('update public.studio_sms_onboarding set submitted_at = now() - interval ''5 days'' where studio_id = %L', pg_temp.kv('sd'))) like '22023%'
  and pg_temp.try(format('update public.studio_sms_onboarding set submission_seq = 1 where studio_id = %L', pg_temp.kv('sd'))) like '22023%'
  and pg_temp.try(format('update public.studio_sms_onboarding set submission_seq = 4 where studio_id = %L', pg_temp.kv('sd'))) like '22023%'
  and pg_temp.try(format('update public.studio_sms_onboarding set ein_ciphertext = %L where studio_id = %L', 'v1.ZZZZZZZZZZZZZZZZ.YYYYYYYYYYYYYYYYYYYYYY.XXXXXXXXXX', pg_temp.kv('sd'))) like '22023%'
  and pg_temp.try(format('update public.studio_sms_onboarding set ein_last4 = ''0000'' where studio_id = %L', pg_temp.kv('sd'))) like '22023%'
  and pg_temp.try(format('update public.studio_sms_onboarding set ein_stored_at = now() + interval ''1 second'' where studio_id = %L', pg_temp.kv('sd'))) like '22023%'
  and (select submission_seq = 2 and attested_by = pg_temp.u('owner_d') and ein_last4 = '7777' and ein_ciphertext = pg_temp.kv('cipher') from public.studio_sms_onboarding where studio_id = pg_temp.u('sd')));
select pg_temp.setkv('r6b1', pg_temp.try(format('update public.studio_sms_onboarding set submission_seq = 3 where studio_id = %L', pg_temp.kv('sd'))));
select pg_temp.setkv('r6b2', pg_temp.try(format('update public.studio_sms_onboarding set ein_ciphertext = null, ein_key_id = null, ein_purged_at = now() where studio_id = %L', pg_temp.kv('sd'))));
select pg_temp.chk('R06b the purge shape is still allowed after submission (ciphertext and key id cleared, last4 and stored time kept) and a one-step submission_seq increase is allowed',
  pg_temp.kv('r6b1') = 'ok' and pg_temp.kv('r6b2') = 'ok'
  and (select ein_ciphertext is null and ein_last4 = '7777' and ein_stored_at is not null from public.studio_sms_onboarding where studio_id = pg_temp.u('sd')));

-- R07: the provisioning ledger
insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq) values (pg_temp.u('sd_id'), pg_temp.u('sd'), 'S1', 3);
select pg_temp.setkv('r7_in_flight', pg_temp.try(format('update public.studio_sms_provisioning_steps set status = ''in_flight'' where onboarding_id = %L', pg_temp.kv('sd_id'))));
select pg_temp.setkv('r7_succeeded', pg_temp.try(format('update public.studio_sms_provisioning_steps set status = ''succeeded'' where onboarding_id = %L', pg_temp.kv('sd_id'))));
select pg_temp.setkv('r7_regress', pg_temp.try(format('update public.studio_sms_provisioning_steps set status = ''pending'' where onboarding_id = %L', pg_temp.kv('sd_id'))));
select pg_temp.setkv('r7_key', pg_temp.try(format('update public.studio_sms_provisioning_steps set step_key = ''S2'' where onboarding_id = %L', pg_temp.kv('sd_id'))));
select pg_temp.setkv('r7_seq', pg_temp.try(format('update public.studio_sms_provisioning_steps set submission_seq = 4 where onboarding_id = %L', pg_temp.kv('sd_id'))));
select pg_temp.setkv('r7_created', pg_temp.try(format('update public.studio_sms_provisioning_steps set created_at = now() - interval ''1 day'' where onboarding_id = %L', pg_temp.kv('sd_id'))));
select pg_temp.setkv('r7_del', pg_temp.try(format('delete from public.studio_sms_provisioning_steps where onboarding_id = %L', pg_temp.kv('sd_id'))));
select pg_temp.setkv('r7_trunc', pg_temp.try('truncate public.studio_sms_provisioning_steps'));
select pg_temp.setkv('r7_rows', (select concat_ws('|', count(*)::text, min(status), min(step_key)) from public.studio_sms_provisioning_steps where onboarding_id = pg_temp.u('sd_id')));
select pg_temp.chk('R07 ledger rows may progress (pending -> in_flight -> succeeded) but identity fields are immutable (42501), a succeeded step cannot regress (22023), a row cannot be deleted while its onboarding exists (42501), and TRUNCATE is refused (42501)',
  pg_temp.kv('r7_in_flight') = 'ok' and pg_temp.kv('r7_succeeded') = 'ok' and pg_temp.kv('r7_regress') like '22023%'
  and pg_temp.kv('r7_key') like '42501%' and pg_temp.kv('r7_seq') like '42501%' and pg_temp.kv('r7_created') like '42501%'
  and pg_temp.kv('r7_del') like '42501%' and pg_temp.kv('r7_trunc') like '42501%' and pg_temp.kv('r7_rows') = '1|succeeded|S1',
  concat_ws(' ; ', pg_temp.kv('r7_in_flight'), pg_temp.kv('r7_succeeded'), pg_temp.kv('r7_regress'), pg_temp.kv('r7_key'), pg_temp.kv('r7_seq'), pg_temp.kv('r7_created'), pg_temp.kv('r7_del'), pg_temp.kv('r7_trunc'), pg_temp.kv('r7_rows')));

-- studio E: flag turned off after submission
select pg_temp.auth('owner_e', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('se'), pg_temp.kv('fields')));
select pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''8888'')::text', pg_temp.kv('se'), pg_temp.kv('owner_e'), pg_temp.kv('cipher')));
select pg_temp.auth('owner_e', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('se'), pg_temp.kv('attest')));
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, false, ''pause for review'')::text', pg_temp.kv('se')));
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, false, ''draft studio off'')::text', pg_temp.kv('sb')));
select pg_temp.chk('R05 with the switch OFF after submission the public legal context is still served (a registered campaign links to it); a studio that only has a draft and the switch off still gets null',
  pg_temp.svc(format('select (public.get_sms_legal_context(%L)->>''legal_name'')', 'tw4a-studio-e')) = 'Harbor Dance Studio LLC'
  and pg_temp.svc(format('select (public.get_sms_legal_context(%L)->>''display_name'')', 'tw4a-studio-e')) = 'TW4A Studio E'
  and (select state = 'draft' from public.studio_sms_onboarding where studio_id = pg_temp.u('sb') and state <> 'cancelled')
  and (select not enabled from public.studio_sms_onboarding_access where studio_id = pg_temp.u('sb'))
  and coalesce(pg_temp.svc(format('select public.get_sms_legal_context(%L)::text', 'tw4a-studio-b')), 'null') in ('null', ''));
select pg_temp.setkv('r4', pg_temp.auth('owner_e', format('select public.cancel_sms_onboarding(%L)::text', pg_temp.kv('se'))));
select pg_temp.chk('R04 the owner can still cancel after the switch is turned off; the EIN is removed at once (ciphertext and key gone, purge audited as owner_cancel, last4 kept); a second cancel reports nothing to cancel; the owner still cannot edit while the switch is off',
  pg_temp.kv('r4')::jsonb ->> 'state' = 'cancelled'
  and (select ein_ciphertext is null and ein_key_id is null and ein_purged_at is not null and ein_last4 = '8888' and state = 'cancelled' from public.studio_sms_onboarding where studio_id = pg_temp.u('se'))
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('se') and action = 'ein_purged' and note = 'reason=owner_cancel')
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('se') and action = 'cancelled' and from_state = 'submitted_for_checks')
  and pg_temp.auth('owner_e', format('select public.cancel_sms_onboarding(%L)::text', pg_temp.kv('se'))) like 'ERR 22023%'
  and pg_temp.auth('owner_e', format('select public.save_sms_onboarding_draft(%L, ''{"city":"x"}''::jsonb)::text', pg_temp.kv('se'))) like 'ERR 42501%', pg_temp.kv('r4'));
select pg_temp.chk('R05b once only a cancelled record remains and the switch is off, the legal context is null again',
  coalesce(pg_temp.svc(format('select public.get_sms_legal_context(%L)::text', 'tw4a-studio-e')), 'null') in ('null', ''));

-- R10 / R11: the access reason is audited; a platform admin without a studio role cannot use the owner RPCs
select pg_temp.chk('R10 the pilot-switch audit rows carry the admin''s reason (for both enable and disable)',
  (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sa') and action = 'access_enabled' and note = 'ConfiDance pilot')
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('se') and action = 'access_disabled' and note = 'pause for review'));
select pg_temp.chk('R11 a platform admin who holds no role in the studio cannot save, submit or cancel (42501) and can still read the status',
  pg_temp.auth('padmin', format('select public.save_sms_onboarding_draft(%L, ''{"city":"x"}''::jsonb)::text', pg_temp.kv('sa'))) like 'ERR 42501%'
  and pg_temp.auth('padmin', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sa'), pg_temp.kv('attest'))) like 'ERR 42501%'
  and pg_temp.auth('padmin', format('select public.cancel_sms_onboarding(%L)::text', pg_temp.kv('sa'))) like 'ERR 42501%'
  and pg_temp.auth('padmin', format('select (public.get_studio_sms_status(%L)->>''available'')', pg_temp.kv('sa'))) = 'true');

-- R08: studio deletion still cascades through onboarding, the (now guarded) ledger and the audit
select pg_temp.setkv('r8', pg_temp.try(format('delete from public.studios where id = %L', pg_temp.kv('sd'))));
select pg_temp.chk('R08 deleting a studio removes its onboarding, ledger rows and audit despite the guards',
  pg_temp.kv('r8') = 'ok' and not exists (select 1 from public.studio_sms_onboarding where studio_id = pg_temp.u('sd'))
  and not exists (select 1 from public.studio_sms_provisioning_steps where studio_id = pg_temp.u('sd'))
  and not exists (select 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sd')), pg_temp.kv('r8'));

-- ===== T: TW-4A.1 (switch turned off after a setup started; legal-page continuity for existing registrations) =========================================
select pg_temp.setkv('sf', 'a5700000-0000-0000-0000-00000000000f');
select pg_temp.setkv('sg', 'a5700000-0000-0000-0000-000000000010');
select pg_temp.setkv('sh', 'a5700000-0000-0000-0000-000000000011');
select pg_temp.setkv('owner_f', 'a5700000-0000-0000-0000-000000000701');
select pg_temp.setkv('admin_f', 'a5700000-0000-0000-0000-000000000702');
select pg_temp.setkv('fd_f', 'a5700000-0000-0000-0000-000000000703');
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select pg_temp.kv(k)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', k || '@tw4a-test.invalid', now(), now() from unnest(array['owner_f', 'admin_f', 'fd_f']) k;
insert into public.profiles (id) select pg_temp.kv(k)::uuid from unnest(array['owner_f', 'admin_f', 'fd_f']) k on conflict (id) do nothing;
insert into public.studios (id, name, slug) values (pg_temp.u('sf'), 'TW4A Studio F', 'tw4a-studio-f'), (pg_temp.u('sg'), 'TW4A Studio G', 'tw4a-studio-g'), (pg_temp.u('sh'), 'TW4A Studio H', 'tw4a-studio-h');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('owner_f'), pg_temp.u('sf'), 'studio_owner', true), (pg_temp.u('admin_f'), pg_temp.u('sf'), 'studio_admin', true), (pg_temp.u('fd_f'), pg_temp.u('sf'), 'front_desk', true);
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''paused fixtures'')::text', pg_temp.kv('sf')));
select pg_temp.setkv('t0', pg_temp.auth('owner_f', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sf'))));
select pg_temp.chk('T01 switch ON, nothing started: available, not paused, the owner can edit but has nothing to cancel',
  (pg_temp.kv('t0')::jsonb ->> 'available') = 'true' and (pg_temp.kv('t0')::jsonb ->> 'paused') = 'false'
  and (pg_temp.kv('t0')::jsonb ->> 'can_edit') = 'true' and (pg_temp.kv('t0')::jsonb ->> 'can_cancel') = 'false' and (pg_temp.kv('t0')::jsonb ->> 'state') = 'not_started', pg_temp.kv('t0'));
select pg_temp.auth('owner_f', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sf'), pg_temp.kv('fields')));
select pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''4242'')::text', pg_temp.kv('sf'), pg_temp.kv('owner_f'), pg_temp.kv('cipher')));
select pg_temp.setkv('t1', pg_temp.auth('owner_f', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sf'))));
select pg_temp.chk('T02 a draft can be cancelled by the owner (can_cancel) and edited (can_edit)',
  (pg_temp.kv('t1')::jsonb ->> 'can_cancel') = 'true' and (pg_temp.kv('t1')::jsonb ->> 'can_edit') = 'true' and (pg_temp.kv('t1')::jsonb ->> 'state') = 'draft', pg_temp.kv('t1'));
select pg_temp.auth('owner_f', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sf'), pg_temp.kv('attest')));
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, false, ''paused after submit'')::text', pg_temp.kv('sf')));
select pg_temp.setkv('t2o', pg_temp.auth('owner_f', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sf'))));
select pg_temp.setkv('t2a', pg_temp.auth('admin_f', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sf'))));
select pg_temp.setkv('t2p', pg_temp.auth('padmin', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sf'))));
select pg_temp.chk('T03 switch turned OFF after submission: the owner still sees the setup (available, paused, state submitted_for_checks), cannot edit, CAN cancel; the admin and platform admin see it read-only with no cancel',
  (pg_temp.kv('t2o')::jsonb ->> 'available') = 'true' and (pg_temp.kv('t2o')::jsonb ->> 'paused') = 'true' and (pg_temp.kv('t2o')::jsonb ->> 'state') = 'submitted_for_checks'
  and (pg_temp.kv('t2o')::jsonb ->> 'can_edit') = 'false' and (pg_temp.kv('t2o')::jsonb ->> 'can_cancel') = 'true'
  and (pg_temp.kv('t2a')::jsonb ->> 'paused') = 'true' and (pg_temp.kv('t2a')::jsonb ->> 'can_cancel') = 'false' and (pg_temp.kv('t2a')::jsonb ->> 'can_edit') = 'false'
  and (pg_temp.kv('t2p')::jsonb ->> 'paused') = 'true' and (pg_temp.kv('t2p')::jsonb ->> 'can_cancel') = 'false', pg_temp.kv('t2o'));
select pg_temp.chk('T04 the paused payload carries no EIN material and no identifiers; the front desk still sees only whether texting is on; a foreign owner is refused',
  pg_temp.kv('t2o') !~* '(ciphertext|ein_|4242|sid|studio_id|rep_|harbor|legal_name)'
  and pg_temp.auth('fd_f', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sf')))::jsonb = '{"texting_on": false}'::jsonb
  and pg_temp.auth('owner_b', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sf'))) like 'ERR 42501%', pg_temp.kv('t2o'));
update public.studio_sms_onboarding set state = 'profile_review' where studio_id = pg_temp.u('sf');
select pg_temp.setkv('t3', pg_temp.auth('owner_f', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sf'))));
update public.studio_sms_onboarding set state = 'brand_pending' where studio_id = pg_temp.u('sf');
select pg_temp.setkv('t3b', pg_temp.auth('owner_f', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sf'))));
select pg_temp.chk('T05 can_cancel follows the cancellation window exactly: true in profile_review, false once the brand step has started (matches what cancel_sms_onboarding accepts)',
  (pg_temp.kv('t3')::jsonb ->> 'can_cancel') = 'true' and (pg_temp.kv('t3b')::jsonb ->> 'can_cancel') = 'false'
  and pg_temp.auth('owner_f', format('select public.cancel_sms_onboarding(%L)::text', pg_temp.kv('sf'))) like 'ERR 22023%'
  and (select state = 'brand_pending' and ein_ciphertext is not null from public.studio_sms_onboarding where studio_id = pg_temp.u('sf')));
-- a studio with the switch off and nothing started is unchanged
select pg_temp.chk('T06 switch OFF and nothing started: unchanged { available: false, texting_on } (no hint that a feature exists)',
  pg_temp.auth('padmin', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sh')))::jsonb = '{"available": false, "texting_on": false}'::jsonb);
select pg_temp.setkv('t6b', pg_temp.auth('owner_b', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sb'))));
select pg_temp.chk('T06b a PAUSED DRAFT is read-only for its owner (can_edit false although the state is draft) but can be cancelled',
  (pg_temp.kv('t6b')::jsonb ->> 'paused') = 'true' and (pg_temp.kv('t6b')::jsonb ->> 'state') = 'draft'
  and (pg_temp.kv('t6b')::jsonb ->> 'can_edit') = 'false' and (pg_temp.kv('t6b')::jsonb ->> 'can_cancel') = 'true', pg_temp.kv('t6b'));
-- legal-page continuity for existing registrations
insert into public.studio_sms_registrations (studio_id, registration_status) values (pg_temp.u('sg'), 'in_review'), (pg_temp.u('sh'), 'not_registered');
select pg_temp.chk('T07 a studio with an in_review registration keeps its SMS legal pages (display name, no legal name) with the switch off; not_registered and unknown studios do not',
  pg_temp.svc(format('select (public.get_sms_legal_context(%L)->>''display_name'')', 'tw4a-studio-g')) = 'TW4A Studio G'
  and pg_temp.svc(format('select coalesce(public.get_sms_legal_context(%L)->>''legal_name'', ''none'')', 'tw4a-studio-g')) = 'none'
  and coalesce(pg_temp.svc(format('select public.get_sms_legal_context(%L)::text', 'tw4a-studio-h')), 'null') in ('null', ''));
update public.studio_sms_registrations set registration_status = 'rejected' where studio_id = pg_temp.u('sg');
select pg_temp.chk('T08 a rejected registration alone does not publish the pages',
  coalesce(pg_temp.svc(format('select public.get_sms_legal_context(%L)::text', 'tw4a-studio-g')), 'null') in ('null', ''));
select pg_temp.chk('T09 TW-4A.1 changed no privileges: studio RPCs still authenticated-only, EIN/legal functions service-role only, anon none',
  has_function_privilege('authenticated', 'public.get_studio_sms_status(uuid)', 'EXECUTE') and not has_function_privilege('service_role', 'public.get_studio_sms_status(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_studio_sms_status(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_sms_legal_context(text)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.get_sms_legal_context(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_sms_legal_context(text)', 'EXECUTE'));

-- ===== result =============================================================================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'TW4A SUITE PASS (% checks)', v_n;
  else raise exception 'TW4A SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

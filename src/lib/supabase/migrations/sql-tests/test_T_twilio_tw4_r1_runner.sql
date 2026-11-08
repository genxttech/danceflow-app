-- TW-4 R1 -- brand runner database functions regression suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY).
-- Covers 20261119092000_twilio_tw4_r1_brand_runner.sql (on top of TW-4A and TW-4A.1). One transaction, synthetic fixtures
-- (UUID block a5100000-...), rolled back by an always-raising final block: "R1 SUITE PASS (<n> checks)" or "R1 SUITE FAIL: ...".
-- REFUSES to run unless the session sets tw4a.test_local = 'on'. No Twilio call exists anywhere in this slice.

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
select pg_temp.setkv('sx', 'a5100000-0000-0000-0000-00000000000a');
select pg_temp.setkv('sy', 'a5100000-0000-0000-0000-00000000000b');
select pg_temp.setkv('owner_x', 'a5100000-0000-0000-0000-000000000101');
select pg_temp.setkv('owner_y', 'a5100000-0000-0000-0000-000000000201');
select pg_temp.setkv('padmin', 'a5100000-0000-0000-0000-000000000401');
select pg_temp.setkv('padmin2', 'a5100000-0000-0000-0000-000000000402');
select pg_temp.setkv('plain', 'a5100000-0000-0000-0000-000000000501');
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select pg_temp.kv(k)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', k || '@tw4r1-test.invalid', now(), now()
from unnest(array['owner_x', 'owner_y', 'padmin', 'padmin2', 'plain']) k;
insert into public.profiles (id, platform_role)
select pg_temp.kv(k)::uuid, case when k like 'padmin%' then 'platform_admin' end from unnest(array['owner_x', 'owner_y', 'padmin', 'padmin2', 'plain']) k
on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name) values
  (pg_temp.u('sx'), 'R1 Studio X', 'r1-studio-x', 'R1 Dance X'), (pg_temp.u('sy'), 'R1 Studio Y', 'r1-studio-y', null);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('owner_x'), pg_temp.u('sx'), 'studio_owner', true), (pg_temp.u('owner_y'), pg_temp.u('sy'), 'studio_owner', true);
select pg_temp.setkv('fields', '{"legal_name":"R1 Dance Studio LLC","entity_type":"llc","industry":"EDUCATION","website_choice":"danceflow",
  "address_line1":"12 Harbor Way","city":"Portland","region":"OR","postal_code":"97201","rep_first_name":"Pat","rep_last_name":"Morgan",
  "rep_title":"Owner","rep_position":"ceo","rep_email":"pat@r1dance.example","rep_phone":"+15035550123","preferred_area_code":"503"}');
select pg_temp.setkv('cipher', 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCC');
select pg_temp.setkv('attest', '{"version":"tw4a-v1","authorized":true,"accurate":true,"opt_in_only":true,"fees_terms":true}');
select pg_temp.setkv('sid_bu', 'BU' || repeat('a', 32));
select pg_temp.setkv('sid_it', 'IT' || repeat('b', 32));
select pg_temp.setkv('sid_bn', 'BN' || repeat('c', 32));

-- a fn call as the service role returning text ('ERR <state> <msg>' on failure)
create or replace function pg_temp.rpc(p_sql text) returns text language sql as $$ select pg_temp.svc(p_sql) $$;

-- ===== P: privileges ======================================================================================================
select pg_temp.chk('P01 runner functions: service_role only, never anon/authenticated; helpers for nobody; all definer with pinned search_path',
  (select bool_and(case when p.proname like 'tw4\_runner\_%' then has_function_privilege('service_role', p.oid, 'EXECUTE') and p.prosecdef
                        else not has_function_privilege('service_role', p.oid, 'EXECUTE') end
                   and not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   and 'search_path=pg_catalog, public, pg_temp' = any (p.proconfig))
   from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'tw4\_runner\_%' or p.proname like '\_tw4\_r1\_%'))
  and (select count(*) = 11 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'tw4\_runner\_%')
  and not has_table_privilege('service_role', 'public.studio_sms_runner_windows', 'SELECT') and not has_table_privilege('authenticated', 'public.studio_sms_runner_windows', 'SELECT')
  and (select relrowsecurity from pg_class where oid = 'public.studio_sms_runner_windows'::regclass));
select pg_temp.chk('P02 the audit vocabulary gained exactly the three runner actions',
  pg_get_constraintdef((select oid from pg_constraint where conname = 'studio_sms_onboarding_audit_action_check')) ~ 'runner_step'
  and pg_get_constraintdef((select oid from pg_constraint where conname = 'studio_sms_onboarding_audit_action_check')) ~ 'runner_ein_read'
  and pg_get_constraintdef((select oid from pg_constraint where conname = 'studio_sms_onboarding_audit_action_check')) ~ 'runner_lease'
  and pg_get_constraintdef((select oid from pg_constraint where conname = 'studio_sms_onboarding_audit_action_check')) ~ 'runner_window');

-- onboarding for studio X: pilot on, owner saves + EIN + submits (the 4A paths)
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''r1 fixtures'')::text', pg_temp.kv('sx')));
select pg_temp.auth('owner_x', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sx'), pg_temp.kv('fields')));
select pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''4242'')::text', pg_temp.kv('sx'), pg_temp.kv('owner_x'), pg_temp.kv('cipher')));
select pg_temp.setkv('onb', (select id::text from public.studio_sms_onboarding where studio_id = pg_temp.u('sx')));

-- ===== W: the runner window (database kill switch) =============================================================================
select pg_temp.chk('W01 a closed window refuses a run claim (TW001) even for a platform admin with the pilot switch on; refresh mode needs no window',
  pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR TW001%'
  and pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300, ''bogus'')::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR 22023%');
select pg_temp.chk('W02 only a platform admin can open a window; hours must be 0-72 and a reason is required; unknown studios are refused',
  pg_temp.rpc(format('select public.tw4_runner_set_window(%L, %L, 24, ''pilot run'')::text', pg_temp.kv('sx'), pg_temp.kv('owner_x'))) like 'ERR 42501%'
  and pg_temp.rpc(format('select public.tw4_runner_set_window(%L, null, 24, ''pilot run'')::text', pg_temp.kv('sx'))) like 'ERR 42501%'
  and pg_temp.rpc(format('select public.tw4_runner_set_window(%L, %L, 73, ''pilot run'')::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_set_window(%L, %L, -1, ''pilot run'')::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_set_window(%L, %L, 24, ''x'')::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_set_window(%L, %L, 24, ''pilot run'')::text', gen_random_uuid(), pg_temp.kv('padmin'))) like 'ERR 22023%');
select pg_temp.setkv('w3', pg_temp.rpc(format('select public.tw4_runner_set_window(%L, %L, 24, ''ConfiDance pilot run'')::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))));
select pg_temp.chk('W03 opening a window returns its expiry (about 24 hours), stores the reason and who opened it, and is audited',
  pg_temp.kv('w3')::timestamptz > now() + interval '23 hours' and pg_temp.kv('w3')::timestamptz < now() + interval '25 hours'
  and (select reason = 'ConfiDance pilot run' and opened_by = pg_temp.u('padmin') from public.studio_sms_runner_windows where studio_id = pg_temp.u('sx'))
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sx') and action = 'runner_window' and actor_user_id = pg_temp.u('padmin')), pg_temp.kv('w3'));
update public.studio_sms_runner_windows set expires_at = now() - interval '1 second' where studio_id = pg_temp.u('sx');
select pg_temp.chk('W04 an expired window is closed (TW001)',
  pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR TW001%');
select pg_temp.rpc(format('select public.tw4_runner_set_window(%L, %L, 24, ''ConfiDance pilot run'')::text', pg_temp.kv('sx'), pg_temp.kv('padmin')));
select pg_temp.chk('W05 hours = 0 closes the window immediately', pg_temp.rpc(format('select public.tw4_runner_set_window(%L, %L, 0, ''stop'')::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) is not null
  and pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR TW001%');
select pg_temp.rpc(format('select public.tw4_runner_set_window(%L, %L, 24, ''ConfiDance pilot run'')::text', pg_temp.kv('sx'), pg_temp.kv('padmin')));

-- ===== C: claim =====================================================================================================================
select pg_temp.chk('C01 a draft onboarding is not runnable (22023); a non-platform-admin actor and a null actor are refused (42501)',
  pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('owner_x'))) like 'ERR 42501%'
  and pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('plain'))) like 'ERR 42501%'
  and pg_temp.rpc(format('select public.tw4_runner_claim(%L, null, ''run-1'', 300)::text', pg_temp.kv('sx'))) like 'ERR 42501%');
select pg_temp.auth('owner_x', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sx'), pg_temp.kv('attest')));
select pg_temp.chk('C02 the pilot switch must be ON: with it off the claim is refused (42501) even for a platform admin',
  (select 1) = 1 and pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, false, ''pause'')::text', pg_temp.kv('sx'))) is not null
  and pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR 42501%');
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''resume'')::text', pg_temp.kv('sx')));
select pg_temp.chk('C03 invalid lease parameters are refused (22023)',
  pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, '''', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 5)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 100000)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) like 'ERR 22023%');
select pg_temp.setkv('claim', pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))));
select pg_temp.chk('C04 a claim returns the onboarding id, state, seq and an empty step list, and records a runner_lease audit row',
  (pg_temp.kv('claim')::jsonb ->> 'onboarding_id') = pg_temp.kv('onb') and (pg_temp.kv('claim')::jsonb ->> 'state') = 'submitted_for_checks'
  and (pg_temp.kv('claim')::jsonb ->> 'submission_seq') = '1' and pg_temp.kv('claim')::jsonb -> 'steps' = '[]'::jsonb
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sx') and action = 'runner_lease' and actor_user_id = pg_temp.u('padmin')), pg_temp.kv('claim'));
select pg_temp.chk('C05 a second run cannot take a live lease (55P03); the same owner may re-claim; every other studio is untouched',
  pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-2'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin2'))) like 'ERR 55P03%'
  and pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))) not like 'ERR%'
  and (select count(*) = 0 from public.studio_sms_onboarding where studio_id = pg_temp.u('sy')));
update public.studio_sms_onboarding set lease_expires_at = now() - interval '1 second' where id = pg_temp.u('onb');
select pg_temp.setkv('c6', pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-2'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin2'))));
select pg_temp.chk('C06 an expired lease can be taken over by another run',
  pg_temp.kv('c6') not like 'ERR%' and (select lease_owner = 'run-2' from public.studio_sms_onboarding where id = pg_temp.u('onb')), pg_temp.kv('c6'));
select pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin')) ) ;
update public.studio_sms_onboarding set lease_owner = null, lease_expires_at = null where id = pg_temp.u('onb');
select pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin')));

-- ===== I: inputs and EIN ===========================================================================================================
select pg_temp.setkv('inp', pg_temp.rpc(format('select public.tw4_runner_get_inputs(%L, ''run-1'')::text', pg_temp.kv('onb'))));
select pg_temp.chk('I01 the lease holder gets the draft fields and the studio slug; no ciphertext, only last4',
  (pg_temp.kv('inp')::jsonb ->> 'legal_name') = 'R1 Dance Studio LLC' and (pg_temp.kv('inp')::jsonb ->> 'studio_slug') = 'r1-studio-x'
  and (pg_temp.kv('inp')::jsonb ->> 'ein_last4') = '4242' and pg_temp.kv('inp') !~* '(ciphertext|v1\.|AAAAAAAA)' and pg_temp.kv('inp')::jsonb -> 'missing' = '[]'::jsonb, pg_temp.kv('inp'));
select pg_temp.chk('I02 a wrong, null or empty lease owner is refused (55P03/22023); so is an unknown onboarding',
  pg_temp.rpc(format('select public.tw4_runner_get_inputs(%L, ''run-9'')::text', pg_temp.kv('onb'))) like 'ERR 55P03%'
  and pg_temp.rpc(format('select public.tw4_runner_get_inputs(%L, null)::text', pg_temp.kv('onb'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_get_ein(%L, ''run-9'', %L)::text', pg_temp.kv('onb'), pg_temp.kv('padmin'))) like 'ERR 55P03%'
  and pg_temp.rpc(format('select public.tw4_runner_get_inputs(%L, ''run-1'')::text', gen_random_uuid())) like 'ERR 22023%');
select pg_temp.setkv('einr', pg_temp.rpc(format('select public.tw4_runner_get_ein(%L, ''run-1'', %L)::text', pg_temp.kv('onb'), pg_temp.kv('padmin'))));
select pg_temp.chk('I03 the lease holder receives the ciphertext token and key id (never a clear EIN) and the read is audited without any value',
  (pg_temp.kv('einr')::jsonb ->> 'ciphertext') = pg_temp.kv('cipher') and (pg_temp.kv('einr')::jsonb ->> 'key_id') = 'v1'
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sx') and action = 'runner_ein_read' and actor_user_id = pg_temp.u('padmin') and coalesce(note, '') !~* '(v1\.|4242)')
  and pg_temp.rpc(format('select public.tw4_runner_get_ein(%L, ''run-1'', %L)::text', pg_temp.kv('onb'), pg_temp.kv('owner_x'))) like 'ERR 42501%'
  and pg_temp.rpc(format('select public.tw4_runner_get_ein(%L, ''run-1'', null)::text', pg_temp.kv('onb'))) like 'ERR 42501%', pg_temp.kv('einr'));

-- ===== K: the kill switch also stops a run that is already in progress (R1.1) ============================================================
select pg_temp.rpc(format('select public.tw4_runner_set_window(%L, %L, 0, ''pull the switch mid-run'')::text', pg_temp.kv('sx'), pg_temp.kv('padmin')));
select pg_temp.setkv('k1', pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''S3'', ''df:test:S3'', false, null)::text', pg_temp.kv('onb'))));
select pg_temp.setkv('k2', pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''B1'', ''df:test:B1'', true, %L)::text', pg_temp.kv('onb'), pg_temp.kv('padmin'))));
select pg_temp.chk('K01 with the window closed mid-run a lease holder can no longer begin ANY step, paid or not (TW001), and nothing is written to the ledger; the lease holder can still read what it needs to wind down',
  pg_temp.kv('k1') like 'ERR TW001%' and pg_temp.kv('k2') like 'ERR TW001%'
  and (select count(*) = 0 from public.studio_sms_provisioning_steps where onboarding_id = pg_temp.u('onb') and step_key in ('S3', 'B1'))
  and pg_temp.rpc(format('select public.tw4_runner_get_inputs(%L, ''run-1'')::text', pg_temp.kv('onb'))) not like 'ERR%', pg_temp.kv('k1') || ' | ' || pg_temp.kv('k2'));
select pg_temp.rpc(format('select public.tw4_runner_set_window(%L, %L, 24, ''ConfiDance pilot run'')::text', pg_temp.kv('sx'), pg_temp.kv('padmin')));
select pg_temp.chk('K02 reopening the window lets the same lease holder continue',
  (pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''S3'', ''df:test:S3'', false, null)::text', pg_temp.kv('onb')))::jsonb ->> 'action') = 'execute');
select pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-1'', ''S3'', ''failed'', null, ''x'', ''y'')::text', pg_temp.kv('onb')));

-- ===== B: ledger protocol ==========================================================================================================
select pg_temp.chk('B01 unknown steps and a missing fee flag are refused (22023)',
  pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''X9'', ''n'', false, null)::text', pg_temp.kv('onb'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''S1'', ''n'', null, null)::text', pg_temp.kv('onb'))) like 'ERR 22023%');
select pg_temp.setkv('b2', pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''S1'', ''df:test:S1'', false, null)::text', pg_temp.kv('onb'))));
select pg_temp.chk('B02 a new step is marked in_flight and told to execute; started_at is set',
  (pg_temp.kv('b2')::jsonb ->> 'action') = 'execute'
  and (select status = 'in_flight' and started_at is not null and fee_bearing = false and friendly_name = 'df:test:S1' from public.studio_sms_provisioning_steps where onboarding_id = pg_temp.u('onb') and step_key = 'S1'), pg_temp.kv('b2'));
select pg_temp.setkv('b3', pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''S1'', ''df:test:S1'', false, null)::text', pg_temp.kv('onb'))));
select pg_temp.chk('B03 beginning an in_flight step again says reconcile (never execute a second create blindly)', (pg_temp.kv('b3')::jsonb ->> 'action') = 'reconcile', pg_temp.kv('b3'));
select pg_temp.chk('B04 finishing: a succeeded step needs a valid provider sid (22023); an unknown step or status is refused; a step that was never started is refused',
  pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-1'', ''S1'', ''succeeded'', ''not-a-sid'', null, null)::text', pg_temp.kv('onb'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-1'', ''S1'', ''succeeded'', null, null, null)::text', pg_temp.kv('onb'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-1'', ''S1'', ''bogus'', null, null, null)::text', pg_temp.kv('onb'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-1'', ''S2'', ''failed'', null, ''x'', ''y'')::text', pg_temp.kv('onb'))) like 'ERR 22023%');
select pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-1'', ''S1'', ''unknown_outcome'', null, ''timeout'', ''network'')::text', pg_temp.kv('onb')));
select pg_temp.setkv('b5', pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''S1'', ''df:test:S1'', false, null)::text', pg_temp.kv('onb'))));
select pg_temp.chk('B05 an unknown_outcome step must also be reconciled before any retry', (pg_temp.kv('b5')::jsonb ->> 'action') = 'reconcile' and (pg_temp.kv('b5')::jsonb ->> 'status') = 'unknown_outcome', pg_temp.kv('b5'));
select pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-1'', ''S1'', ''succeeded'', %L, null, null)::text', pg_temp.kv('onb'), pg_temp.kv('sid_bu')));
select pg_temp.setkv('b6', pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''S1'', ''df:test:S1'', false, null)::text', pg_temp.kv('onb'))));
select pg_temp.chk('B06 reconciliation can adopt a found resource: the step succeeds with its sid and the next begin says skip with that sid',
  (pg_temp.kv('b6')::jsonb ->> 'action') = 'skip' and (pg_temp.kv('b6')::jsonb ->> 'provider_sid') = pg_temp.kv('sid_bu'), pg_temp.kv('b6'));
select pg_temp.chk('B07 a succeeded step cannot regress (ledger guard) and its sid cannot be replaced by a failure',
  pg_temp.try(format('update public.studio_sms_provisioning_steps set status = ''failed'' where onboarding_id = %L and step_key = ''S1''', pg_temp.kv('onb'))) like '22023%');
select pg_temp.chk('B07b the provider sid of a succeeded step is frozen even for the table owner (22023); an unchanged update is harmless',
  pg_temp.try(format('update public.studio_sms_provisioning_steps set provider_sid = ''BU'' || repeat(''7'', 32) where onboarding_id = %L and step_key = ''S1''', pg_temp.kv('onb'))) like '22023%sid of a succeeded step%'
  and pg_temp.try(format('update public.studio_sms_provisioning_steps set error_code = null where onboarding_id = %L and step_key = ''S1''', pg_temp.kv('onb'))) = 'ok'
  and (select provider_sid = pg_temp.kv('sid_bu') from public.studio_sms_provisioning_steps where onboarding_id = pg_temp.u('onb') and step_key = 'S1'));
select pg_temp.chk('B08 a fee-bearing step needs a platform-admin confirmation: none, a non-admin, and the studio owner are refused (42501) and nothing is started',
  pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''B1'', ''df:test:B1'', true, null)::text', pg_temp.kv('onb'))) like 'ERR 42501%'
  and pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''B1'', ''df:test:B1'', true, %L)::text', pg_temp.kv('onb'), pg_temp.kv('plain'))) like 'ERR 42501%'
  and pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''B1'', ''df:test:B1'', true, %L)::text', pg_temp.kv('onb'), pg_temp.kv('owner_x'))) like 'ERR 42501%'
  and (select count(*) = 0 from public.studio_sms_provisioning_steps where onboarding_id = pg_temp.u('onb') and step_key = 'B1'));
select pg_temp.setkv('b9', pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''B1'', ''df:test:B1'', true, %L)::text', pg_temp.kv('onb'), pg_temp.kv('padmin'))));
select pg_temp.chk('B09 with a platform admin confirmation the fee step starts and the ledger records who confirmed and when',
  (pg_temp.kv('b9')::jsonb ->> 'action') = 'execute'
  and (select fee_bearing and fee_confirmed_by = pg_temp.u('padmin') and fee_confirmed_at is not null and status = 'in_flight' from public.studio_sms_provisioning_steps where onboarding_id = pg_temp.u('onb') and step_key = 'B1'), pg_temp.kv('b9'));
select pg_temp.chk('B10 a fee step left in_flight is never executed again: a re-begin (even confirmed) says reconcile',
  (pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''B1'', ''df:test:B1'', true, %L)::text', pg_temp.kv('onb'), pg_temp.kv('padmin')))::jsonb ->> 'action') = 'reconcile');
select pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-1'', ''B1'', ''failed'', null, ''20001'', ''rejected by Twilio'')::text', pg_temp.kv('onb')));
select pg_temp.chk('B11 a failed fee step needs a fresh confirmation to run again',
  pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''B1'', ''df:test:B1'', true, null)::text', pg_temp.kv('onb'))) like 'ERR 42501%'
  and (pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''B1'', ''df:test:B1'', true, %L)::text', pg_temp.kv('onb'), pg_temp.kv('padmin')))::jsonb ->> 'action') = 'execute');
select pg_temp.chk('B12 step audit rows carry step and status only (no sid, no EIN, no message text)',
  (select count(*) >= 3 from public.studio_sms_onboarding_audit where action = 'runner_step' and studio_id = pg_temp.u('sx'))
  and not exists (select 1 from public.studio_sms_onboarding_audit a where a.action = 'runner_step' and (coalesce(a.note, '') ~* '(BU[0-9a-f]{32}|4242|v1\.|rejected by Twilio)')));

select pg_temp.chk('B13 the fee flag is derived from the STEP: claiming "not paid" for B1, or "paid" for another step, is refused (22023), so the confirmation cannot be bypassed by the caller',
  pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''B1'', ''x'', false, null)::text', pg_temp.kv('onb'))) like 'ERR 22023%does not match%'
  and pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''S2'', ''x'', true, %L)::text', pg_temp.kv('onb'), pg_temp.kv('padmin'))) like 'ERR 22023%does not match%'
  and pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''S2'', ''x'', false, null, true)::text', pg_temp.kv('onb'))) like 'ERR 22023%does not match%');
select pg_temp.chk('B14 a succeeded step is final: finishing it again (even with another sid) is refused (22023) and its sid is unchanged; so is finishing a failed step that was not begun again',
  pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-1'', ''S1'', ''succeeded'', %L, null, null)::text', pg_temp.kv('onb'), 'BU' || repeat('9', 32))) like 'ERR 22023%not open%'
  and pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-1'', ''S1'', ''failed'', null, ''x'', ''y'')::text', pg_temp.kv('onb'))) like 'ERR 22023%not open%'
  and (select provider_sid = pg_temp.kv('sid_bu') and status = 'succeeded' from public.studio_sms_provisioning_steps where onboarding_id = pg_temp.u('onb') and step_key = 'S1'));
update public.studio_sms_onboarding set lease_expires_at = now() + interval '10 seconds' where id = pg_temp.u('onb');
select pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''S2'', ''df:test:S2'', false, null)::text', pg_temp.kv('onb')));
select pg_temp.chk('B15 every step renews the lease, so a long run is not taken over mid-way',
  (select lease_expires_at > now() + interval '4 minutes' from public.studio_sms_onboarding where id = pg_temp.u('onb')));

-- ===== T: transitions ==============================================================================================================
select pg_temp.chk('T01 the runner may only move to profile_review, brand_pending, needs_info or exception (refused by the runner itself, not just by the state graph); unknown field names are refused',
  pg_temp.rpc(format('select public.tw4_runner_transition(%L, ''run-1'', ''active'', ''x'', null, null)::text', pg_temp.kv('onb'))) like 'ERR 22023%not allowed for the runner%'
  and pg_temp.rpc(format('select public.tw4_runner_transition(%L, ''run-1'', ''service_setup'', ''x'', null, null)::text', pg_temp.kv('onb'))) like 'ERR 22023%not allowed for the runner%'
  and pg_temp.rpc(format('select public.tw4_runner_transition(%L, ''run-1'', ''needs_info'', ''S10'', ''e'', ''ein_ciphertext'')::text', pg_temp.kv('onb'))) like 'ERR 22023%');
select pg_temp.chk('T02 the 4A state graph still applies: submitted_for_checks cannot jump to brand_pending (22023)',
  pg_temp.rpc(format('select public.tw4_runner_transition(%L, ''run-1'', ''brand_pending'', ''B1'', null, null)::text', pg_temp.kv('onb'))) like 'ERR 22023%');
select pg_temp.setkv('t3', pg_temp.rpc(format('select public.tw4_runner_transition(%L, ''run-1'', ''profile_review'', ''S11'', null, null)::text', pg_temp.kv('onb'))));
select pg_temp.chk('T03 submitted_for_checks -> profile_review is allowed and audited as a state change by the runner',
  (pg_temp.kv('t3')::jsonb ->> 'state') = 'profile_review'
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sx') and action = 'state_changed' and from_state = 'submitted_for_checks' and to_state = 'profile_review'), pg_temp.kv('t3'));
select pg_temp.chk('T04 a repeat transition to the current state changes nothing', (pg_temp.rpc(format('select public.tw4_runner_transition(%L, ''run-1'', ''profile_review'', ''S11'', null, null)::text', pg_temp.kv('onb')))::jsonb ->> 'state') = 'profile_review');
select pg_temp.chk('T05 the owner cannot run, transition or read anything through the API: no privilege on the runner functions',
  not has_function_privilege('authenticated', 'public.tw4_runner_transition(uuid,text,text,text,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.tw4_runner_get_ein(uuid,text,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.tw4_runner_claim(uuid,uuid,text,integer,text)', 'EXECUTE'));

-- needs_info and resubmission start a new ledger generation
select pg_temp.setkv('n1', pg_temp.rpc(format('select public.tw4_runner_transition(%L, ''run-1'', ''needs_info'', ''S10'', ''noncompliant'', ''rep_email'')::text', pg_temp.kv('onb'))));
select pg_temp.setkv('n1s', pg_temp.auth('owner_x', format('select public.get_studio_sms_status(%L)::text', pg_temp.kv('sx'))));
select pg_temp.chk('N01 needs_info records the failing field and the owner sees it highlighted (needs_info_fields) and may edit',
  (pg_temp.kv('n1')::jsonb ->> 'state') = 'needs_info'
  and (select last_error_field = 'rep_email' and last_error_code = 'noncompliant' from public.studio_sms_onboarding where id = pg_temp.u('onb'))
  and (pg_temp.kv('n1s')::jsonb ->> 'state') = 'needs_info' and pg_temp.kv('n1s')::jsonb -> 'needs_info_fields' = '["rep_email"]'::jsonb
  and (pg_temp.kv('n1s')::jsonb ->> 'can_edit') = 'true', pg_temp.kv('n1s'));
select pg_temp.auth('owner_x', format('select public.save_sms_onboarding_draft(%L, ''{"rep_email":"pat@fixed.example"}''::jsonb)::text', pg_temp.kv('sx')));
select pg_temp.auth('owner_x', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sx'), pg_temp.kv('attest')));
select pg_temp.setkv('claim2', pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-1'', 300)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))));
select pg_temp.chk('N02 after the resubmission: seq 2, state submitted_for_checks, no ledger rows for the new generation (the old ones stay as history)',
  (pg_temp.kv('claim2')::jsonb ->> 'submission_seq') = '2' and (pg_temp.kv('claim2')::jsonb ->> 'state') = 'submitted_for_checks' and pg_temp.kv('claim2')::jsonb -> 'steps' = '[]'::jsonb
  and (select count(*) >= 2 from public.studio_sms_provisioning_steps where onboarding_id = pg_temp.u('onb') and submission_seq = 1), pg_temp.kv('claim2'));

select pg_temp.chk('N03 resubmission cannot start a SECOND paid brand: while the studio has an unresolved earlier brand attempt (generation 1 left B1 in flight) the paid step is refused (55000) even with a platform-admin confirmation',
  pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''B1'', ''df:test:B1b'', true, %L)::text', pg_temp.kv('onb'), pg_temp.kv('padmin'))) like 'ERR 55000%'
  and (select count(*) = 0 from public.studio_sms_provisioning_steps where onboarding_id = pg_temp.u('onb') and step_key = 'B1' and submission_seq = 2));
-- a human confirmed at Twilio that the generation-1 attempt produced nothing: only then is the ledger row marked failed
update public.studio_sms_provisioning_steps set status = 'failed' where onboarding_id = pg_temp.u('onb') and step_key = 'B1' and submission_seq = 1;

-- ===== R: brand mirror and approval =================================================================================================
select pg_temp.chk('R01 recording a brand needs the customer-profile step to have succeeded in this generation (22023) and a valid brand sid/status',
  pg_temp.rpc(format('select public.tw4_runner_record_brand(%L, ''run-1'', %L, ''in_review'')::text', pg_temp.kv('onb'), pg_temp.kv('sid_bn'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_record_brand(%L, ''run-1'', ''BN123'', ''in_review'')::text', pg_temp.kv('onb'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_record_brand(%L, ''run-1'', %L, ''weird'')::text', pg_temp.kv('onb'), pg_temp.kv('sid_bn'))) like 'ERR 22023%');
select pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''S1'', ''df:test:S1b'', false, null)::text', pg_temp.kv('onb')));
select pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-1'', ''S1'', ''succeeded'', %L, null, null)::text', pg_temp.kv('onb'), pg_temp.kv('sid_bu')));
select pg_temp.rpc(format('select public.tw4_runner_transition(%L, ''run-1'', ''profile_review'', ''S11'', null, null)::text', pg_temp.kv('onb')));
select pg_temp.chk('R01b a brand that is not this onboarding''s succeeded B1 step cannot be mirrored (22023)',
  pg_temp.rpc(format('select public.tw4_runner_record_brand(%L, ''run-1'', %L, ''in_review'')::text', pg_temp.kv('onb'), pg_temp.kv('sid_bn'))) like 'ERR 22023%');
select pg_temp.setkv('b1g2', pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-1'', ''B1'', ''df:test:B1b'', true, %L)::text', pg_temp.kv('onb'), pg_temp.kv('padmin'))));
select pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-1'', ''B1'', ''succeeded'', %L, null, null)::text', pg_temp.kv('onb'), pg_temp.kv('sid_bn')));
select pg_temp.rpc(format('select public.tw4_runner_transition(%L, ''run-1'', ''brand_pending'', ''B1'', null, null)::text', pg_temp.kv('onb')));
select pg_temp.setkv('rb', pg_temp.rpc(format('select public.tw4_runner_record_brand(%L, ''run-1'', %L, ''in_review'')::text', pg_temp.kv('onb'), pg_temp.kv('sid_bn'))));
select pg_temp.chk('R02 the TW-3 registration row is created in_review with the profile and brand sids; it is not approved and carries no sender/campaign',
  (select registration_status = 'in_review' and customer_profile_sid = pg_temp.kv('sid_bu') and brand_sid = pg_temp.kv('sid_bn') and brand_status = 'in_review'
          and campaign_sid is null and messaging_service_sid is null and sender_e164 is null and approved_at is null
   from public.studio_sms_registrations where studio_id = pg_temp.u('sx')), pg_temp.kv('rb'));
select pg_temp.chk('R03 a different brand cannot overwrite the recorded one (22023); the same brand can be re-recorded with a new status',
  pg_temp.rpc(format('select public.tw4_runner_record_brand(%L, ''run-1'', %L, ''in_review'')::text', pg_temp.kv('onb'), 'BN' || repeat('d', 32))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_record_brand(%L, ''run-1'', %L, ''in_review'')::text', pg_temp.kv('onb'), pg_temp.kv('sid_bn'))) not like 'ERR%');
select pg_temp.chk('R04 brand_approved is refused until the registration mirror says approved (22023); the EIN is untouched',
  pg_temp.rpc(format('select public.tw4_runner_brand_approved(%L, ''run-1'')::text', pg_temp.kv('onb'))) like 'ERR 22023%'
  and (select ein_ciphertext is not null from public.studio_sms_onboarding where id = pg_temp.u('onb')));
select pg_temp.rpc(format('select public.tw4_runner_record_brand(%L, ''run-1'', %L, ''approved'')::text', pg_temp.kv('onb'), pg_temp.kv('sid_bn')));
select pg_temp.setkv('ba', pg_temp.rpc(format('select public.tw4_runner_brand_approved(%L, ''run-1'')::text', pg_temp.kv('onb'))));
select pg_temp.chk('R05 brand approved: state service_setup, the EIN ciphertext and key are purged (last4 kept) with a brand_approved audit row; the registration is still NOT approved for sending',
  (pg_temp.kv('ba')::jsonb ->> 'state') = 'service_setup'
  and (select ein_ciphertext is null and ein_key_id is null and ein_last4 = '4242' and ein_purged_at is not null from public.studio_sms_onboarding where id = pg_temp.u('onb'))
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sx') and action = 'ein_purged' and note = 'reason=brand_approved')
  and (select registration_status = 'in_review' and brand_status = 'approved' from public.studio_sms_registrations where studio_id = pg_temp.u('sx')), pg_temp.kv('ba'));
select pg_temp.chk('R06 after the purge the runner cannot read an EIN (22023) and cannot run brand_approved twice (22023)',
  pg_temp.rpc(format('select public.tw4_runner_get_ein(%L, ''run-1'', %L)::text', pg_temp.kv('onb'), pg_temp.kv('padmin'))) like 'ERR 22023%'
  and pg_temp.rpc(format('select public.tw4_runner_brand_approved(%L, ''run-1'')::text', pg_temp.kv('onb'))) like 'ERR 22023%');

-- ===== S: status and isolation ======================================================================================================
select pg_temp.setkv('st', pg_temp.rpc(format('select public.tw4_runner_status(%L, %L)::text', pg_temp.kv('sx'), pg_temp.kv('padmin'))));
select pg_temp.chk('S01 the platform summary shows state, step and per-step status/fee confirmation, and contains no SID, no EIN and no personal field',
  (pg_temp.kv('st')::jsonb ->> 'state') = 'service_setup' and (pg_temp.kv('st')::jsonb ->> 'brand_status') = 'approved'
  and pg_temp.kv('st') !~* '(BU[0-9a-f]{32}|BN[0-9a-f]{32}|ciphertext|4242|pat@|R1 Dance|\+1503)', pg_temp.kv('st'));
select pg_temp.chk('S02 the summary refuses a non-platform-admin actor (42501) and reports null for a studio without an onboarding',
  pg_temp.rpc(format('select public.tw4_runner_status(%L, %L)::text', pg_temp.kv('sx'), pg_temp.kv('owner_x'))) like 'ERR 42501%'
  and pg_temp.rpc(format('select public.tw4_runner_status(%L, %L)::text', pg_temp.kv('sy'), pg_temp.kv('padmin'))) is null);
select pg_temp.chk('S03 the runner never touches studio Y: no onboarding, ledger, registration, window or runner audit rows exist for it yet',
  not exists (select 1 from public.studio_sms_onboarding where studio_id = pg_temp.u('sy'))
  and not exists (select 1 from public.studio_sms_provisioning_steps where studio_id = pg_temp.u('sy'))
  and not exists (select 1 from public.studio_sms_registrations where studio_id = pg_temp.u('sy'))
  and not exists (select 1 from public.studio_sms_runner_windows where studio_id = pg_temp.u('sy'))
  and not exists (select 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sy') and action like 'runner%'));
select pg_temp.setkv('s4', pg_temp.rpc(format('select public.tw4_runner_release(%L, ''run-1'')::text', pg_temp.kv('onb'))));
select pg_temp.chk('S04 releasing the lease clears it; a released run can no longer read inputs (55P03)',
  pg_temp.kv('s4') not like 'ERR%' and pg_temp.rpc(format('select public.tw4_runner_get_inputs(%L, ''run-1'')::text', pg_temp.kv('onb'))) like 'ERR 55P03%'
  and (select lease_owner is null from public.studio_sms_onboarding where id = pg_temp.u('onb')), pg_temp.kv('s4'));
select pg_temp.chk('S05 nothing here changed sending: the approved-registration invariant still refuses an approval without a campaign, number and sender',
  pg_temp.try(format('update public.studio_sms_registrations set registration_status = ''approved'' where studio_id = %L', pg_temp.kv('sx'))) like '23514%');

-- ===== M: a MOCK brand is never mirrored and never approves anything (studio Y) ========================================================
select pg_temp.auth('padmin', format('select public.set_sms_onboarding_access(%L, true, ''r1 mock fixtures'')::text', pg_temp.kv('sy')));
select pg_temp.auth('owner_y', format('select public.save_sms_onboarding_draft(%L, %L::jsonb)::text', pg_temp.kv('sy'), pg_temp.kv('fields')));
select pg_temp.svc(format('select public.store_sms_onboarding_ein(%L, %L, %L, ''v1'', ''5555'')::text', pg_temp.kv('sy'), pg_temp.kv('owner_y'), pg_temp.kv('cipher')));
select pg_temp.auth('owner_y', format('select public.submit_sms_onboarding(%L, %L)::text', pg_temp.kv('sy'), pg_temp.kv('attest')));
select pg_temp.setkv('onby', (select id::text from public.studio_sms_onboarding where studio_id = pg_temp.u('sy')));
select pg_temp.rpc(format('select public.tw4_runner_set_window(%L, %L, 24, ''mock dry run'')::text', pg_temp.kv('sy'), pg_temp.kv('padmin')));
select pg_temp.rpc(format('select public.tw4_runner_claim(%L, %L, ''run-y'', 300)::text', pg_temp.kv('sy'), pg_temp.kv('padmin')));
select pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-y'', ''S1'', ''df:test:y:S1'', false, null)::text', pg_temp.kv('onby')));
select pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-y'', ''S1'', ''succeeded'', %L, null, null)::text', pg_temp.kv('onby'), pg_temp.kv('sid_bu')));
select pg_temp.rpc(format('select public.tw4_runner_transition(%L, ''run-y'', ''profile_review'', ''S11'', null, null)::text', pg_temp.kv('onby')));
select pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-y'', ''B1'', ''df:test:y:B1'', true, %L, true)::text', pg_temp.kv('onby'), pg_temp.kv('padmin')));
select pg_temp.rpc(format('select public.tw4_runner_finish_step(%L, ''run-y'', ''B1'', ''succeeded'', %L, null, null)::text', pg_temp.kv('onby'), 'BN' || repeat('7', 32)));
select pg_temp.rpc(format('select public.tw4_runner_transition(%L, ''run-y'', ''brand_pending'', ''B1'', null, null)::text', pg_temp.kv('onby')));
select pg_temp.setkv('m1', pg_temp.rpc(format('select public.tw4_runner_record_brand(%L, ''run-y'', %L, ''approved'')::text', pg_temp.kv('onby'), 'BN' || repeat('7', 32))));
select pg_temp.setkv('m2', pg_temp.rpc(format('select public.tw4_runner_brand_approved(%L, ''run-y'')::text', pg_temp.kv('onby'))));
select pg_temp.chk('M01 the mock flag is recorded on the paid step and shown in the summary; a mock brand cannot be mirrored (22023) and cannot approve the onboarding (22023); the studio gets no registration row and keeps its EIN',
  (select mock and fee_bearing from public.studio_sms_provisioning_steps where onboarding_id = pg_temp.u('onby') and step_key = 'B1')
  and pg_temp.kv('m1') like 'ERR 22023%mock%' and pg_temp.kv('m2') like 'ERR 22023%mock%'
  and (select state = 'brand_pending' and ein_ciphertext is not null from public.studio_sms_onboarding where id = pg_temp.u('onby'))
  and not exists (select 1 from public.studio_sms_registrations where studio_id = pg_temp.u('sy'))
  and pg_temp.rpc(format('select (public.tw4_runner_status(%L, %L)->''steps'')::text', pg_temp.kv('sy'), pg_temp.kv('padmin'))) like '%"mock": true%', pg_temp.kv('m1') || ' | ' || pg_temp.kv('m2'));
select pg_temp.chk('M02 a mock flag on a step that is not the paid step is refused (22023)',
  pg_temp.rpc(format('select public.tw4_runner_begin_step(%L, ''run-y'', ''S2'', ''x'', false, null, true)::text', pg_temp.kv('onby'))) like 'ERR 22023%');

-- ===== X: an onboarding stuck in exception loses its EIN after 30 days ================================================================
select pg_temp.rpc(format('select public.tw4_runner_transition(%L, ''run-y'', ''exception'', ''B1'', ''x'', null)::text', pg_temp.kv('onby')));
select pg_temp.setkv('x0', pg_temp.svc('select public.purge_due_sms_onboarding_eins()::text'));
select pg_temp.chk('X01 a RECENT exception keeps its EIN (the sweep purges nothing; a direct stale_exception purge is refused with false)',
  pg_temp.kv('x0') = '0' and pg_temp.svc(format('select public.purge_sms_onboarding_ein(%L, ''stale_exception'')::text', pg_temp.kv('onby'))) = 'false'
  and (select ein_ciphertext is not null from public.studio_sms_onboarding where id = pg_temp.u('onby')));
alter table public.studio_sms_onboarding disable trigger studio_sms_onboarding_10_integrity;
update public.studio_sms_onboarding set updated_at = now() - interval '31 days' where id = pg_temp.u('onby');
alter table public.studio_sms_onboarding enable trigger studio_sms_onboarding_10_integrity;
select pg_temp.setkv('x1', pg_temp.svc('select public.purge_due_sms_onboarding_eins()::text'));
select pg_temp.chk('X02 an exception older than 30 days is purged by the sweep (reason stale_exception, audited); the ciphertext and key are gone and the last four stay',
  pg_temp.kv('x1') = '1'
  and (select ein_ciphertext is null and ein_key_id is null and ein_last4 = '5555' and ein_purged_at is not null from public.studio_sms_onboarding where id = pg_temp.u('onby'))
  and (select count(*) = 1 from public.studio_sms_onboarding_audit where studio_id = pg_temp.u('sy') and action = 'ein_purged' and note = 'reason=stale_exception'), pg_temp.kv('x1'));
select pg_temp.chk('X03 the sweep still never touches a non-terminal, non-exception onboarding (studio X is in service_setup with its EIN already purged; nothing else changed)',
  pg_temp.svc('select public.purge_due_sms_onboarding_eins()::text') = '0');

do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'R1 SUITE PASS (% checks)', v_n;
  else raise exception 'R1 SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

-- Wave + Google Calendar cross-tenant RLS suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY). Covers 20270223140000 (apply it first); otherwise it only seeds test rows.
-- Prints "WAVE GOOGLE RLS SUITE PASS (<n> checks)" or "... FAIL: ..." from an always-raising final block. Refuses unless wavetest.local = 'on'.
-- Never calls a function the caller lacks EXECUTE on (that segfaults some local images); privileges are asserted with has_function_privilege instead.
begin;
do $$ begin
  if coalesce(current_setting('wavetest.local', true), '') <> 'on' then
    raise exception 'wave/google rls suite refused: set wavetest.local = ''on'' only on a disposable local stack';
  end if;
end $$;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
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

-- Fixtures: studios A and B, owner of each, a front-desk user in A.
insert into auth.users (id, email) values
  ('e0000000-0000-4000-8000-0000000000a1', 'ownerA@wrls.test'),
  ('e0000000-0000-4000-8000-0000000000a2', 'frontA@wrls.test'),
  ('e0000000-0000-4000-8000-0000000000b1', 'ownerB@wrls.test');
insert into public.profiles (id) select id from auth.users where email like '%@wrls.test' on conflict do nothing;
insert into public.studios (id, name, slug) values
  ('e1000000-0000-4000-8000-00000000000a', 'WRLS A', 'wrls-a'), ('e1000000-0000-4000-8000-00000000000b', 'WRLS B', 'wrls-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('e0000000-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-00000000000a', 'studio_owner', true),
  ('e0000000-0000-4000-8000-0000000000a2', 'e1000000-0000-4000-8000-00000000000a', 'front_desk', true),
  ('e0000000-0000-4000-8000-0000000000b1', 'e1000000-0000-4000-8000-00000000000b', 'studio_owner', true);

-- One full Wave data set per studio.
insert into public.studio_wave_connections (id, studio_id, status) values
  ('e2000000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-00000000000a', 'connected'),
  ('e2000000-0000-4000-8000-00000000000b', 'e1000000-0000-4000-8000-00000000000b', 'connected');
insert into public.studio_wave_credentials (connection_id, encrypted_access_token) values
  ('e2000000-0000-4000-8000-00000000000a', 'v1.a.b.c'), ('e2000000-0000-4000-8000-00000000000b', 'v1.d.e.f');
insert into public.studio_wave_businesses (connection_id, studio_id, wave_business_id, name) values
  ('e2000000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-00000000000a', 'bizA', 'A'), ('e2000000-0000-4000-8000-00000000000b', 'e1000000-0000-4000-8000-00000000000b', 'bizB', 'B');
insert into public.studio_wave_accounts (connection_id, studio_id, wave_account_id, name) values
  ('e2000000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-00000000000a', 'acctA', 'A'), ('e2000000-0000-4000-8000-00000000000b', 'e1000000-0000-4000-8000-00000000000b', 'acctB', 'B');
insert into public.studio_wave_account_mappings (studio_id, connection_id, accounting_category, wave_account_id, wave_account_name) values
  ('e1000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-00000000000a', 'tuition', 'acctA', 'A'), ('e1000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-00000000000b', 'tuition', 'acctB', 'B');
insert into public.studio_wave_payment_method_mappings (studio_id, connection_id, payment_method_key, wave_account_id, wave_account_name) values
  ('e1000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-00000000000a', 'cash', 'acctA', 'A'), ('e1000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-00000000000b', 'cash', 'acctB', 'B');
insert into public.studio_wave_posting_entitlements (studio_id, status) values
  ('e1000000-0000-4000-8000-00000000000a', 'pilot'), ('e1000000-0000-4000-8000-00000000000b', 'pilot');
-- runs: A has a review run and an approved run; B has a review run
insert into public.studio_wave_sync_runs (id, studio_id, connection_id, status, period_start, period_end, currency) values
  ('e3000000-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-00000000000a', 'review', '2026-11-01', '2026-11-30', 'USD'),
  ('e3000000-0000-4000-8000-0000000000b1', 'e1000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-00000000000b', 'review', '2026-11-01', '2026-11-30', 'USD');
insert into public.studio_wave_sync_runs (id, studio_id, connection_id, status, period_start, period_end, currency, approved_at) values
  ('e3000000-0000-4000-8000-0000000000a2', 'e1000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-00000000000a', 'approved', '2026-10-01', '2026-10-31', 'USD', now());
insert into public.studio_wave_sync_lines (run_id, studio_id, entry_date, payment_method_key, category, direction, amount, currency, wave_category_account_id, wave_category_account_name, wave_anchor_account_id, wave_anchor_account_name) values
  ('e3000000-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-00000000000a', '2026-11-02', 'cash', 'tuition', 'credit', 5, 'USD', 'x', 'x', 'y', 'y'),
  ('e3000000-0000-4000-8000-0000000000b1', 'e1000000-0000-4000-8000-00000000000b', '2026-11-02', 'cash', 'tuition', 'credit', 5, 'USD', 'x', 'x', 'y', 'y');
insert into public.studio_wave_sync_reservations (studio_id, idempotency_key, run_id) values
  ('e1000000-0000-4000-8000-00000000000a', 'kA', 'e3000000-0000-4000-8000-0000000000a1'), ('e1000000-0000-4000-8000-00000000000b', 'kB', 'e3000000-0000-4000-8000-0000000000b1');
insert into public.studio_wave_audit_events (studio_id, connection_id, event_type, outcome) values
  ('e1000000-0000-4000-8000-00000000000a', 'e2000000-0000-4000-8000-00000000000a', 'seed', 'succeeded'), ('e1000000-0000-4000-8000-00000000000b', 'e2000000-0000-4000-8000-00000000000b', 'seed', 'succeeded');
-- Google: one studio-scope connection per studio
insert into public.studio_google_calendar_connections (id, studio_id, status, connection_scope) values
  ('e4000000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-00000000000a', 'connected', 'studio'),
  ('e4000000-0000-4000-8000-00000000000b', 'e1000000-0000-4000-8000-00000000000b', 'connected', 'studio');

-- 1. Read isolation on every studio-keyed Wave table: own owner sees own (1), other tenant owner sees 0 of A's, front desk 0, anon none.
do $$
declare t text; ownA text; crossB text; front text; anonv text;
begin
  foreach t in array array['studio_wave_connections','studio_wave_businesses','studio_wave_accounts','studio_wave_account_mappings','studio_wave_payment_method_mappings','studio_wave_posting_entitlements','studio_wave_sync_reservations','studio_wave_audit_events'] loop
    ownA := pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', format('select count(*)::text from public.%I where studio_id = %L', t, 'e1000000-0000-4000-8000-00000000000a'));
    crossB := pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', format('select count(*)::text from public.%I where studio_id = %L', t, 'e1000000-0000-4000-8000-00000000000a'));
    front := pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a2', format('select count(*)::text from public.%I where studio_id = %L', t, 'e1000000-0000-4000-8000-00000000000a'));
    anonv := pg_temp.val_as('anon', null, format('select count(*)::text from public.%I', t));
    perform pg_temp.chk(t || ': owner reads own studio', ownA = '1', ownA);
    perform pg_temp.chk(t || ': other tenant owner reads none of A', crossB = '0', crossB);
    perform pg_temp.chk(t || ': front desk reads none', front = '0', front);
    perform pg_temp.chk(t || ': anon reads none', anonv = '0' or anonv like 'ERR%', anonv);
  end loop;
  -- runs and lines have 2 rows for A (runs) / 1 (lines)
  perform pg_temp.chk('runs: owner reads own two runs', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', 'select count(*)::text from public.studio_wave_sync_runs') = '2');
  perform pg_temp.chk('runs: other tenant sees only its own', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', 'select count(*)::text from public.studio_wave_sync_runs') = '1');
  perform pg_temp.chk('lines: owner reads own line only', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', 'select count(*)::text from public.studio_wave_sync_lines') = '1');
  perform pg_temp.chk('lines: front desk reads none', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a2', 'select count(*)::text from public.studio_wave_sync_lines') = '0');
end $$;

-- 2. Credentials: no authenticated policy, so no row is ever readable or writable by a studio user; the service role can.
select pg_temp.chk('wave credentials: RLS on and no policy', (select relrowsecurity from pg_class where oid = 'public.studio_wave_credentials'::regclass) and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'studio_wave_credentials'));
select pg_temp.chk('wave credentials: own owner reads nothing', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', 'select count(*)::text from public.studio_wave_credentials') in ('0') or pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', 'select count(*)::text from public.studio_wave_credentials') like 'ERR%');
select pg_temp.chk('wave credentials: other tenant owner reads nothing', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', 'select count(*)::text from public.studio_wave_credentials') in ('0') or pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', 'select count(*)::text from public.studio_wave_credentials') like 'ERR%');
select pg_temp.chk('wave credentials: owner cannot insert or update', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$with u as (update public.studio_wave_credentials set encrypted_access_token = 'hax' returning 1) select count(*)::text from u$q$) in ('0') or pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$with u as (update public.studio_wave_credentials set encrypted_access_token = 'hax' returning 1) select count(*)::text from u$q$) like 'ERR%');
select pg_temp.chk('wave credentials: token unchanged after attempted update', (select encrypted_access_token from public.studio_wave_credentials where connection_id = 'e2000000-0000-4000-8000-00000000000a') = 'v1.a.b.c');
select pg_temp.chk('wave credentials: service role can read', pg_temp.val_as('service_role', null, 'select count(*)::text from public.studio_wave_credentials') = '2');
select pg_temp.chk('wave credentials: anon reads nothing', pg_temp.val_as('anon', null, 'select count(*)::text from public.studio_wave_credentials') in ('0') or pg_temp.val_as('anon', null, 'select count(*)::text from public.studio_wave_credentials') like 'ERR%');

-- 3. Cross-tenant writes are rejected.
select pg_temp.chk('other tenant cannot update A connection', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', $q$with u as (update public.studio_wave_connections set last_error = 'x' where studio_id = 'e1000000-0000-4000-8000-00000000000a' returning 1) select count(*)::text from u$q$) = '0');
select pg_temp.chk('other tenant cannot map accounts into A', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', $q$insert into public.studio_wave_account_mappings (studio_id, connection_id, accounting_category, wave_account_id, wave_account_name) values ('e1000000-0000-4000-8000-00000000000a','e2000000-0000-4000-8000-00000000000a','fees','z','z') returning 'ok'$q$) like 'ERR%');
select pg_temp.chk('other tenant cannot create a run for A', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', $q$insert into public.studio_wave_sync_runs (studio_id, connection_id, status, period_start, period_end, currency) values ('e1000000-0000-4000-8000-00000000000a','e2000000-0000-4000-8000-00000000000a','review','2026-09-01','2026-09-30','USD') returning 'ok'$q$) like 'ERR%');
select pg_temp.chk('other tenant cannot delete A review run', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', $q$with d as (delete from public.studio_wave_sync_runs where id = 'e3000000-0000-4000-8000-0000000000a1' returning 1) select count(*)::text from d$q$) = '0');
select pg_temp.chk('front desk cannot update own studio connection', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a2', $q$with u as (update public.studio_wave_connections set last_error = 'x' where studio_id = 'e1000000-0000-4000-8000-00000000000a' returning 1) select count(*)::text from u$q$) = '0');
select pg_temp.chk('owner can update own studio connection (control)', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$with u as (update public.studio_wave_connections set last_error = 'x' where studio_id = 'e1000000-0000-4000-8000-00000000000a' returning 1) select count(*)::text from u$q$) = '1');

-- 4. Run and line lifecycle rules.
select pg_temp.chk('owner can create a review run (control)', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$insert into public.studio_wave_sync_runs (studio_id, connection_id, status, period_start, period_end, currency) values ('e1000000-0000-4000-8000-00000000000a','e2000000-0000-4000-8000-00000000000a','review','2026-09-01','2026-09-30','USD') returning 'ok'$q$) = 'ok');
select pg_temp.chk('owner cannot create an already-approved run', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$insert into public.studio_wave_sync_runs (studio_id, connection_id, status, period_start, period_end, currency, approved_at) values ('e1000000-0000-4000-8000-00000000000a','e2000000-0000-4000-8000-00000000000a','approved','2026-08-01','2026-08-31','USD', now()) returning 'ok'$q$) like 'ERR%');
select pg_temp.chk('owner cannot add a line to an approved run', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$insert into public.studio_wave_sync_lines (run_id, studio_id, entry_date, payment_method_key, category, direction, amount, currency, wave_category_account_id, wave_category_account_name, wave_anchor_account_id, wave_anchor_account_name) values ('e3000000-0000-4000-8000-0000000000a2','e1000000-0000-4000-8000-00000000000a','2026-10-02','cash','tuition','credit',5,'USD','x','x','y','y') returning 'ok'$q$) like 'ERR%');
select pg_temp.chk('owner cannot delete an approved run', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$with d as (delete from public.studio_wave_sync_runs where id = 'e3000000-0000-4000-8000-0000000000a2' returning 1) select count(*)::text from d$q$) = '0');
select pg_temp.chk('owner cannot add a line to the OTHER tenant review run', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$insert into public.studio_wave_sync_lines (run_id, studio_id, entry_date, payment_method_key, category, direction, amount, currency, wave_category_account_id, wave_category_account_name, wave_anchor_account_id, wave_anchor_account_name) values ('e3000000-0000-4000-8000-0000000000b1','e1000000-0000-4000-8000-00000000000b','2026-11-03','cash','tuition','credit',5,'USD','x','x','y','y') returning 'ok'$q$) like 'ERR%');

-- 5. Entitlements are platform-admin controlled; audit rows cannot be forged or edited by studio users.
select pg_temp.chk('owner cannot grant own entitlement', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$with u as (update public.studio_wave_posting_entitlements set status = 'active' where studio_id = 'e1000000-0000-4000-8000-00000000000a' returning 1) select count(*)::text from u$q$) = '0');
select pg_temp.chk('owner cannot insert an entitlement for another studio', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$insert into public.studio_wave_posting_entitlements (studio_id, status) values ('e1000000-0000-4000-8000-00000000000b','active') on conflict (studio_id) do update set status = 'active' returning 'ok'$q$) like 'ERR%');
select pg_temp.chk('entitlement unchanged', (select status from public.studio_wave_posting_entitlements where studio_id = 'e1000000-0000-4000-8000-00000000000a') = 'pilot' and (select status from public.studio_wave_posting_entitlements where studio_id = 'e1000000-0000-4000-8000-00000000000b') = 'pilot');
select pg_temp.chk('owner cannot forge an audit event', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$insert into public.studio_wave_audit_events (studio_id, event_type, outcome) values ('e1000000-0000-4000-8000-00000000000a','forged','succeeded') returning 'ok'$q$) like 'ERR%');
select pg_temp.chk('audit rows are immutable even for the table owner', pg_temp.val_as('postgres', null, $q$update public.studio_wave_audit_events set outcome = 'failed' returning 'ok'$q$) like '%immutable%');

-- 6. Controlled toggles and RPC boundaries.
select pg_temp.chk('owner cannot flip posting_enabled with a plain UPDATE', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$update public.studio_wave_connections set posting_enabled = true where studio_id = 'e1000000-0000-4000-8000-00000000000a' returning 'ok'$q$) like '%controlled Wave posting toggle%');
select pg_temp.chk('approve RPC rejects another tenant run', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', $q$select public.approve_studio_wave_sync_run('e3000000-0000-4000-8000-0000000000a1')::text$q$) like '%unavailable%');
select pg_temp.chk('cancel RPC rejects another tenant run', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', $q$select public.cancel_studio_wave_sync_run('e3000000-0000-4000-8000-0000000000a1')::text$q$) like '%unavailable%');
select pg_temp.chk('approve RPC rejects a front-desk user of the same studio', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a2', $q$select public.approve_studio_wave_sync_run('e3000000-0000-4000-8000-0000000000a1')::text$q$) like '%unavailable%');
select pg_temp.chk('run A1 still in review after rejected approvals', (select status from public.studio_wave_sync_runs where id = 'e3000000-0000-4000-8000-0000000000a1') = 'review');
select pg_temp.chk('autopost claim function is service-role only', has_function_privilege('service_role', 'public.claim_next_wave_sync_line_for_autopost(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.claim_next_wave_sync_line_for_autopost(uuid)', 'execute') and not has_function_privilege('anon', 'public.claim_next_wave_sync_line_for_autopost(uuid)', 'execute'));
select pg_temp.chk('anon calling approve gets unavailable, not access', pg_temp.val_as('anon', null, $q$select public.approve_studio_wave_sync_run('e3000000-0000-4000-8000-0000000000a1')::text$q$) like '%unavailable%');

-- 7. Google Calendar connections: tenant isolation for studio-scope rows.
select pg_temp.chk('google: owner reads own studio connection', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000a1', $q$select count(*)::text from public.studio_google_calendar_connections where studio_id = 'e1000000-0000-4000-8000-00000000000a'$q$) = '1');
select pg_temp.chk('google: other tenant reads none of A', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', $q$select count(*)::text from public.studio_google_calendar_connections where studio_id = 'e1000000-0000-4000-8000-00000000000a'$q$) = '0');
select pg_temp.chk('google: other tenant cannot update A connection', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', $q$with u as (update public.studio_google_calendar_connections set status = 'disconnected' where studio_id = 'e1000000-0000-4000-8000-00000000000a' returning 1) select count(*)::text from u$q$) = '0');
select pg_temp.chk('google: other tenant cannot insert a connection into A', pg_temp.val_as('authenticated', 'e0000000-0000-4000-8000-0000000000b1', $q$insert into public.studio_google_calendar_connections (studio_id, status, connection_scope) values ('e1000000-0000-4000-8000-00000000000a','connected','studio') returning 'ok'$q$) like 'ERR%');
select pg_temp.chk('google: anon reads none', pg_temp.val_as('anon', null, 'select count(*)::text from public.studio_google_calendar_connections') in ('0') or pg_temp.val_as('anon', null, 'select count(*)::text from public.studio_google_calendar_connections') like 'ERR%');
select pg_temp.chk('google: A connection untouched', (select status from public.studio_google_calendar_connections where id = 'e4000000-0000-4000-8000-00000000000a') = 'connected');

do $$ declare n int; f text; begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into n, f from t_results;
  if f is null then raise exception 'WAVE GOOGLE RLS SUITE PASS (% checks)', n; else raise exception 'WAVE GOOGLE RLS SUITE FAIL: %', f; end if;
end $$;

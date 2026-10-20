-- TW-4F panel monthly limits -- database regression suite (LOCAL / DISPOSABLE ENVIRONMENTS ONLY).
-- Covers 20261202150000_twilio_tw4f_panel_monthly_limits.sql (on top of 20261128090000 and 20261130090000). One transaction, synthetic fixtures (UUID
-- block a6200000-...), rolled back by an always-raising final block: "PANEL MONTHLY SUITE PASS (<n> checks)" or "PANEL MONTHLY SUITE FAIL: ...".
-- REFUSES to run unless the session sets tw4a.test_local = 'on'. Privileges are asserted with has_*_privilege (the local image crashes on a
-- permission-denied function call by an API role). The only financial rows are a monthly limit set through tw4_monthly_limit_set_admin and one
-- synthetic usage ledger row, all rolled back. No Twilio or Stripe call exists anywhere in this slice.
--   psql -v ON_ERROR_STOP=0 -c "set tw4a.test_local = 'on'" -f test_T_twilio_tw4f_panel_monthly_limits.sql

begin;

do $$ begin
  if coalesce(current_setting('tw4a.test_local', true), '') <> 'on' then
    raise exception 'TW-4F panel monthly suite refused: set tw4a.test_local = ''on'' only on a disposable local stack';
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
-- the panel's row for one legal business, from the platform admin's read (service role) taken once after the fixtures (key 'panel')
create or replace function pg_temp.panel_row(p_entity text) returns jsonb language sql as $$
  select e from jsonb_array_elements(pg_temp.kv('panel')::jsonb) e where e->>'legal_entity_id' = pg_temp.kv(p_entity) $$;

-- ids and fixtures -----------------------------------------------------------------------------------------------------
select pg_temp.setkv('sa', 'a6200000-0000-4000-8000-00000000000a');
select pg_temp.setkv('sb', 'a6200000-0000-4000-8000-00000000000b');
select pg_temp.setkv('owner_a', 'a6200000-0000-4000-8000-000000000101');
select pg_temp.setkv('owner_b', 'a6200000-0000-4000-8000-000000000201');
select pg_temp.setkv('padmin', 'a6200000-0000-4000-8000-000000000401');
select pg_temp.setkv('plain', 'a6200000-0000-4000-8000-000000000501');
select pg_temp.setkv('ea', 'a6200000-0000-4000-8000-0000000e000a');
select pg_temp.setkv('eb', 'a6200000-0000-4000-8000-0000000e000b');
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select pg_temp.kv(k)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', k || '@tw4fpanelml-test.invalid', now(), now()
from unnest(array['owner_a', 'owner_b', 'padmin', 'plain']) k;
insert into public.profiles (id, platform_role)
select pg_temp.kv(k)::uuid, case when k = 'padmin' then 'platform_admin' end from unnest(array['owner_a', 'owner_b', 'padmin', 'plain']) k
on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug, public_name, timezone) values
  (pg_temp.u('sa'), 'Panel ML Studio A', 'panel-ml-studio-a', null, 'America/Chicago'), (pg_temp.u('sb'), 'Panel ML Studio B', 'panel-ml-studio-b', null, 'Pacific/Auckland');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('owner_a'), pg_temp.u('sa'), 'studio_owner', true), (pg_temp.u('owner_b'), pg_temp.u('sb'), 'studio_owner', true);
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  (pg_temp.u('ea'), 'Panel ML A LLC', '3331', 15000, pg_temp.u('padmin')), (pg_temp.u('eb'), 'Panel ML B LLC', '3332', 15000, pg_temp.u('padmin'));
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note) values
  (pg_temp.u('sa'), pg_temp.u('ea'), 'founding', pg_temp.u('padmin'), 'synthetic fixture link'), (pg_temp.u('sb'), pg_temp.u('eb'), 'founding', pg_temp.u('padmin'), 'synthetic fixture link');
-- business A: a limit this month, a different one next month, a timezone change next month, and one synthetic usage charge this month
select pg_temp.setkv('cur', public._tw4ml_month_key(pg_temp.u('ea'), now()));
select pg_temp.setkv('nxt', public._tw4ml_key_add(pg_temp.kv('cur'), 1));
select pg_temp.setkv('set1', pg_temp.svc(format('select public.tw4_monthly_limit_set_admin(%L, %L, 5000, null, ''fixture: the limit for this month'')::text', pg_temp.kv('ea'), pg_temp.kv('padmin'))));
select pg_temp.setkv('set2', pg_temp.svc(format('select public.tw4_monthly_limit_set_admin(%L, %L, 8000, %L, ''fixture: the limit for next month'')::text', pg_temp.kv('ea'), pg_temp.kv('padmin'), pg_temp.kv('nxt'))));
select pg_temp.setkv('tz', pg_temp.svc(format('select public.tw4_entity_timezone_set_admin(%L, %L, ''America/Denver'', ''fixture: moving the month'')::text', pg_temp.kv('ea'), pg_temp.kv('padmin'))));
set local session_replication_role = replica;
insert into public.studio_sms_credit_ledger (legal_entity_id, seq, kind, balance_delta_cents, reserved_delta_cents, idempotency_key, studio_id, created_at)
values (pg_temp.u('ea'), (select coalesce(max(seq), 0) + 1 from public.studio_sms_credit_ledger where legal_entity_id = pg_temp.u('ea')), 'usage_charge', -700, 0,
        'usage:panel-ml-fixture', pg_temp.u('sa'), now());
reset session_replication_role;
select pg_temp.setkv('tz_rows_b', (select count(*)::text from public.studio_sms_entity_timezones where legal_entity_id = pg_temp.u('eb')));

select pg_temp.chk('F01 fixtures: the admin limit and timezone actions succeeded',
  pg_temp.kv('set1') not like 'ERR%' and pg_temp.kv('set2') not like 'ERR%' and pg_temp.kv('tz') not like 'ERR%',
  pg_temp.kv('set1') || ' | ' || pg_temp.kv('set2') || ' | ' || pg_temp.kv('tz'));

-- ===== P: privileges ======================================================================================================
select pg_temp.chk('P01 service_role only; anon, authenticated and public cannot execute',
  has_function_privilege('service_role', 'public.tw4_panel_monthly_limits(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.tw4_panel_monthly_limits(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.tw4_panel_monthly_limits(uuid)', 'EXECUTE'));
select pg_temp.chk('P02 security definer, STABLE (read-only), pinned search_path',
  (select p.prosecdef and p.provolatile = 's' and p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%' from pg_proc p where p.oid = 'public.tw4_panel_monthly_limits(uuid)'::regprocedure));

-- ===== A: the actor must be a platform admin =============================================================================
select pg_temp.chk('A01 a signed-in user who is not a platform admin is refused (42501)',
  pg_temp.svc(format('select public.tw4_panel_monthly_limits(%L)::text', pg_temp.kv('plain'))) like 'ERR 42501%');
select pg_temp.chk('A02 a studio OWNER is refused too: the panel read is not an owner read (42501)',
  pg_temp.svc(format('select public.tw4_panel_monthly_limits(%L)::text', pg_temp.kv('owner_a'))) like 'ERR 42501%');
select pg_temp.chk('A03 no actor is refused (42501)', pg_temp.svc('select public.tw4_panel_monthly_limits(null)::text') like 'ERR 42501%');
select pg_temp.chk('A04 an unknown actor is refused (42501)',
  pg_temp.svc('select public.tw4_panel_monthly_limits(''a6200000-0000-4000-8000-00000000ffff'')::text') like 'ERR 42501%');

-- ===== E: the figures equal the owner's own screen ========================================================================
select pg_temp.setkv('panel', pg_temp.svc(format('select public.tw4_panel_monthly_limits(%L)::text', pg_temp.kv('padmin'))));
select pg_temp.setkv('owner_view_a', pg_temp.auth('owner_a', format('select public.sms_monthly_limit_overview(%L)::text', pg_temp.kv('sa'))));
select pg_temp.setkv('owner_view_b', pg_temp.auth('owner_b', format('select public.sms_monthly_limit_overview(%L)::text', pg_temp.kv('sb'))));
select pg_temp.chk('E01 business A: the panel row equals the owner''s overview on every shared key',
  (pg_temp.panel_row('ea') - 'legal_entity_id') = (pg_temp.kv('owner_view_a')::jsonb - 'on_hold' - 'available_cents'),
  coalesce(pg_temp.panel_row('ea')::text, 'missing') || ' vs ' || coalesce(pg_temp.kv('owner_view_a'), 'missing'));
select pg_temp.chk('E02 business B (nothing configured): equal as well',
  (pg_temp.panel_row('eb') - 'legal_entity_id') = (pg_temp.kv('owner_view_b')::jsonb - 'on_hold' - 'available_cents'),
  coalesce(pg_temp.panel_row('eb')::text, 'missing') || ' vs ' || coalesce(pg_temp.kv('owner_view_b'), 'missing'));
select pg_temp.chk('E03 business A figures: approved limit, next month''s limit, this month''s usage, timezone and next month''s timezone',
  (select (r->>'limit_cents')::int = 5000 and (r->>'effective_limit_cents')::int = 5000 and (r->>'next_month_limit_cents')::int = 8000
      and (r->'parts'->>'usage_cents')::int = 700 and (r->'parts'->>'total_cents')::int = 700
      and r->>'timezone' = 'America/Chicago' and r->>'next_month_timezone' = 'America/Denver' and r->>'month' = pg_temp.kv('cur')
      and jsonb_array_length(r->'recent_changes') = 2 and r->'recent_changes'->0->>'changed_by_role' = 'platform_admin'
   from (select pg_temp.panel_row('ea') r) x), coalesce(pg_temp.panel_row('ea')::text, 'missing'));
select pg_temp.chk('E04 business B figures stay its own: no limit, no usage, its founding location''s timezone (no cross-business mixing)',
  (select (r->>'limit_cents')::int = 0 and (r->>'effective_limit_cents')::int = 0 and (r->'parts'->>'total_cents')::int = 0
      and r->>'timezone' = 'Pacific/Auckland' and jsonb_array_length(r->'recent_changes') = 0
   from (select pg_temp.panel_row('eb') r) x), coalesce(pg_temp.panel_row('eb')::text, 'missing'));
select pg_temp.chk('E05 reading never records a timezone (it does not call _tw4ml_ensure_tz)',
  (select count(*)::text from public.studio_sms_entity_timezones where legal_entity_id = pg_temp.u('eb')) = pg_temp.kv('tz_rows_b'));
-- (the shared local stack may gain or lose other suites' fixtures meanwhile, so this checks ids, not a global count)
select pg_temp.chk('E06 one row per legal business: each id once, both fixture businesses present',
  (select count(*) = count(distinct e->>'legal_entity_id') and bool_and((e->>'legal_entity_id')::uuid is not null)
          and count(*) filter (where e->>'legal_entity_id' in (pg_temp.kv('ea'), pg_temp.kv('eb'))) = 2
     from jsonb_array_elements(pg_temp.kv('panel')::jsonb) e));

-- ===== D: _tw4ml_default_tz (20261202140000) gives the same answers as before =============================================
select pg_temp.setkv('ec', 'a6200000-0000-4000-8000-0000000e000c');
select pg_temp.setkv('ed', 'a6200000-0000-4000-8000-0000000e000d');
select pg_temp.setkv('sc1', 'a6200000-0000-4000-8000-0000000000c1');
select pg_temp.setkv('sc2', 'a6200000-0000-4000-8000-0000000000c2');
select pg_temp.setkv('sc3', 'a6200000-0000-4000-8000-0000000000c3');
insert into public.studios (id, name, slug, public_name, timezone) values
  (pg_temp.u('sc1'), 'Panel ML C1', 'panel-ml-c1', null, 'Not/AZone'), (pg_temp.u('sc2'), 'Panel ML C2', 'panel-ml-c2', null, 'posix/Europe/Paris'),
  (pg_temp.u('sc3'), 'Panel ML C3', 'panel-ml-c3', null, 'Europe/Paris');
insert into public.studio_sms_legal_entities (id, legal_name, ein_last4, spend_cap_cents, created_by) values
  (pg_temp.u('ec'), 'Panel ML C LLC', '3333', 0, pg_temp.u('padmin')), (pg_temp.u('ed'), 'Panel ML D LLC', '3334', 0, pg_temp.u('padmin'));
insert into public.studio_sms_entity_studios (studio_id, legal_entity_id, link_kind, linked_by, verification_note, linked_at) values
  (pg_temp.u('sc3'), pg_temp.u('ec'), 'founding', pg_temp.u('padmin'), 'synthetic fixture link', now() - interval '1 day'),
  (pg_temp.u('sc2'), pg_temp.u('ec'), 'founding', pg_temp.u('padmin'), 'synthetic fixture link', now() - interval '2 days'),
  (pg_temp.u('sc1'), pg_temp.u('ec'), 'founding', pg_temp.u('padmin'), 'synthetic fixture link', now() - interval '3 days');
select pg_temp.chk('D01 the founding location''s zone when it is valid (business A: America/Chicago)', public._tw4ml_default_tz(pg_temp.u('ea')) = 'America/Chicago');
select pg_temp.chk('D02 an invalid zone and a posix/ zone are skipped; the next location by linked_at wins (Europe/Paris)',
  public._tw4ml_default_tz(pg_temp.u('ec')) = 'Europe/Paris', public._tw4ml_default_tz(pg_temp.u('ec')));
select pg_temp.chk('D03 no linked location: UTC', public._tw4ml_default_tz(pg_temp.u('ed')) = 'UTC');
select pg_temp.chk('D04 an unknown business: UTC', public._tw4ml_default_tz('a6200000-0000-4000-8000-0000000effff') = 'UTC');
select pg_temp.chk('D05 same volatility, security, search_path and (no API) privileges as before',
  (select p.prosecdef and p.provolatile = 's' and p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%'
     from pg_proc p where p.oid = 'public._tw4ml_default_tz(uuid)'::regprocedure)
  and not has_function_privilege('authenticated', 'public._tw4ml_default_tz(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public._tw4ml_default_tz(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public._tw4ml_default_tz(uuid)', 'EXECUTE'));

do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 400) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'PANEL MONTHLY SUITE PASS (% checks)', v_n;
  else raise exception 'PANEL MONTHLY SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

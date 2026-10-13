-- Marketing M-0 -- regression suite for 20261117091000 (stage 2: tenant recipient-write lockdown).
--
-- Run only after BOTH M-0 migrations are applied. Tenants keep read access to their own recipients, cannot write
-- recipient rows by any path, cannot call the legacy page RPC; the service-role pipeline (sync, claim, complete,
-- unsubscribe by token) keeps working.
-- One transaction, synthetic fixtures only (UUID block 00000000-0000-0000-0000-0000ae2XXXXX). The final block ALWAYS
-- raises, so nothing persists: "M-0 STAGE 2 SUITE PASS (<n> checks)" or "M-0 STAGE 2 SUITE FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_kv (k text primary key, v text) on commit drop;
grant all on t_kv to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  exception when others then
    insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlstate || ' ' || sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
  end;
end $$;

create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $f$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, true, 'ok');
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $f$;

create or replace function pg_temp.kv(p_k text) returns text language sql as $$ select v from t_kv where k = p_k $$;
create or replace function pg_temp.as_user(p_user text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true) $$;

-- Stage 1 lands frozen; this rolled-back transaction exercises the unfrozen pipeline.
select public.marketing_set_send_freeze(false, 'M-0 stage 2 suite (rolled back)');

-- ---------------------------------------------------------------------------------------------------------------
-- Schema state
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.chk('stage 2: no tenant manage policy on studio recipients',
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'marketing_campaign_recipients' and cmd <> 'SELECT' and permissive = 'PERMISSIVE'));
select pg_temp.chk('stage 2: no tenant manage policy on organizer recipients',
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'organizer_marketing_campaign_recipients' and cmd <> 'SELECT' and permissive = 'PERMISSIVE'));

select pg_temp.chk(format('privileges: %s cannot %s %s', r, p, t),
  not has_table_privilege(r, 'public.' || t, p))
from unnest(array['anon', 'authenticated']) r,
     unnest(array['insert', 'update', 'delete', 'truncate']) p,
     unnest(array['marketing_campaign_recipients', 'organizer_marketing_campaign_recipients']) t;
select pg_temp.chk('privileges: tenants keep read access to recipients',
  has_table_privilege('authenticated', 'public.marketing_campaign_recipients', 'select')
  and has_table_privilege('authenticated', 'public.organizer_marketing_campaign_recipients', 'select'));

select pg_temp.chk(format('legacy RPC: %s cannot execute', r),
  not has_function_privilege(r, 'public.unsubscribe_marketing_recipient(text)', 'execute'))
from unnest(array['anon', 'authenticated']) r;
select pg_temp.chk('legacy RPC: PUBLIC grant removed',
  not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where p.oid = 'public.unsubscribe_marketing_recipient(text)'::regprocedure and a.grantee = 0));
select pg_temp.chk('legacy RPC: service_role keeps execute',
  has_function_privilege('service_role', 'public.unsubscribe_marketing_recipient(text)', 'execute'));
select pg_temp.chk('pipeline functions: service_role only',
  bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute')
           and not has_function_privilege('anon', f, 'execute')))
from unnest(array[
  'public.marketing_sync_campaign_recipients(text,uuid,uuid,jsonb)',
  'public.marketing_claim_campaign_recipient(text,uuid,uuid,uuid,integer)',
  'public.marketing_unsubscribe_by_token(text,text)']) f;

-- ---------------------------------------------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------------------------------------------
insert into public.studios (id, name, slug) values ('00000000-0000-0000-0000-0000ae200001', 'M0 S2 Studio', 'm0-s2-studio');
insert into public.organizers (id, name, slug) values ('00000000-0000-0000-0000-0000ae200101', 'M0 S2 Org', 'm0-s2-org');
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000ae200201', 'm0-s2-staff@example.com', now()),
  ('00000000-0000-0000-0000-0000ae200204', 'm0-s2-org@example.com', now());
insert into public.profiles (id, email) select id, email from auth.users where id::text like '00000000-0000-0000-0000-0000ae2002%';
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000ae200201', '00000000-0000-0000-0000-0000ae200001', 'studio_owner', true);
insert into public.organizer_users (organizer_id, user_id, role, active) values
  ('00000000-0000-0000-0000-0000ae200101', '00000000-0000-0000-0000-0000ae200204', 'organizer_owner', true);
insert into public.marketing_campaigns (id, studio_id, name, subject, body_text, status, audience_type) values
  ('00000000-0000-0000-0000-0000ae200401', '00000000-0000-0000-0000-0000ae200001', 'C', 'S', 'B', 'draft', 'manual');
insert into public.organizer_marketing_campaigns (id, organizer_id, name, subject, body_text, status) values
  ('00000000-0000-0000-0000-0000ae200404', '00000000-0000-0000-0000-0000ae200101', 'O', 'S', 'B', 'draft');

-- the service-role pipeline still writes
set local role service_role;
select pg_temp.chk('pipeline: service_role sync works (studio)',
  public.marketing_sync_campaign_recipients('studio', '00000000-0000-0000-0000-0000ae200001', '00000000-0000-0000-0000-0000ae200401',
    jsonb_build_array(jsonb_build_object('email', 'm0-s2-a@example.com'), jsonb_build_object('email', 'm0-s2-b@example.com'))) ->> 'outcome' = 'synced');
select pg_temp.chk('pipeline: service_role sync works (organizer)',
  public.marketing_sync_campaign_recipients('organizer', '00000000-0000-0000-0000-0000ae200101', '00000000-0000-0000-0000-0000ae200404',
    jsonb_build_array(jsonb_build_object('email', 'm0-s2-a@example.com'))) ->> 'outcome' = 'synced');
insert into t_kv select 'rid', id::text from public.marketing_campaign_recipients
  where campaign_id = '00000000-0000-0000-0000-0000ae200401' and email = 'm0-s2-a@example.com';
insert into t_kv select 'tok', unsubscribe_token from public.marketing_campaign_recipients
  where campaign_id = '00000000-0000-0000-0000-0000ae200401' and email = 'm0-s2-b@example.com';
insert into t_kv select 'orid', id::text from public.organizer_marketing_campaign_recipients
  where campaign_id = '00000000-0000-0000-0000-0000ae200404';
select pg_temp.chk('pipeline: service_role claim works',
  public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae200001', '00000000-0000-0000-0000-0000ae200401',
    pg_temp.kv('rid')::uuid, 600) ->> 'outcome' = 'claimed');
select pg_temp.chk('pipeline: service_role unsubscribe by token works',
  (public.marketing_unsubscribe_by_token(pg_temp.kv('tok'), 'one_click') ->> 'ok')::boolean);
reset role;
select pg_temp.chk('pipeline: unsubscribe marked the pending row',
  (select status from public.marketing_campaign_recipients where unsubscribe_token = pg_temp.kv('tok')) = 'unsubscribed');

-- ---------------------------------------------------------------------------------------------------------------
-- Tenants: read only
-- ---------------------------------------------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae200201');
select pg_temp.chk('studio staff: can read own recipients',
  (select count(*) from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae200401') = 2);
select pg_temp.expect_msg('studio staff: cannot insert a recipient',
  $q$insert into public.marketing_campaign_recipients (campaign_id, studio_id, email, status)
     values ('00000000-0000-0000-0000-0000ae200401', '00000000-0000-0000-0000-0000ae200001', 'm0-s2-x@example.com', 'pending')$q$, '42501');
select pg_temp.expect_msg('studio staff: cannot mark a recipient sent (old app path)',
  format($q$update public.marketing_campaign_recipients set status = 'sent', sent_at = now() where id = %L$q$, pg_temp.kv('rid')), '42501');
select pg_temp.expect_msg('studio staff: cannot delete recipients (old app regenerate)',
  $q$delete from public.marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae200401'$q$, '42501');
select pg_temp.expect_msg('studio staff: cannot truncate recipients',
  $q$truncate public.marketing_campaign_recipients$q$, '42501');
select pg_temp.expect_msg('studio staff: cannot call the pipeline directly',
  $q$select public.marketing_claim_campaign_recipient('studio', '00000000-0000-0000-0000-0000ae200001', '00000000-0000-0000-0000-0000ae200401', gen_random_uuid(), 600)$q$, '42501');
update public.marketing_campaigns set name = 'C renamed' where id = '00000000-0000-0000-0000-0000ae200401';
select pg_temp.chk('studio staff: campaign drafts stay editable',
  (select name from public.marketing_campaigns where id = '00000000-0000-0000-0000-0000ae200401') = 'C renamed');

select pg_temp.as_user('00000000-0000-0000-0000-0000ae200204');
select pg_temp.chk('organizer user: can read own recipients',
  (select count(*) from public.organizer_marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae200404') = 1);
select pg_temp.expect_msg('organizer user: cannot mark a recipient sent',
  format($q$update public.organizer_marketing_campaign_recipients set status = 'sent' where id = %L$q$, pg_temp.kv('orid')), '42501');
select pg_temp.expect_msg('organizer user: cannot delete recipients',
  $q$delete from public.organizer_marketing_campaign_recipients where campaign_id = '00000000-0000-0000-0000-0000ae200404'$q$, '42501');
reset role;

set local role anon;
select pg_temp.expect_msg('anon: cannot call the legacy unsubscribe RPC',
  format($q$select public.unsubscribe_marketing_recipient(%L)$q$, pg_temp.kv('tok')), '42501');
select pg_temp.expect_msg('anon: cannot unsubscribe by token directly',
  format($q$select public.marketing_unsubscribe_by_token(%L, 'one_click')$q$, pg_temp.kv('tok')), '42501');
select pg_temp.expect_msg('anon: cannot queue an outbound delivery',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, status) values ('00000000-0000-0000-0000-0000ae200001', 'email', 'appointment_confirmed', 'x@example.com', 'queued')$q$, '42501');
reset role;

-- ---------------------------------------------------------------------------------------------------------------
-- Outbound deliveries (D): no client-role write path at all
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.chk(format('outbound: %s cannot %s outbound_deliveries', r, p), not has_table_privilege(r, 'public.outbound_deliveries', p))
from unnest(array['anon', 'authenticated']) r, unnest(array['insert', 'update', 'delete', 'truncate']) p;
select pg_temp.chk('outbound: no client write policy remains',
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'outbound_deliveries'
              and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and 'service_role' <> all (roles)));
select pg_temp.chk('outbound: staff keep read access (communications history)', has_table_privilege('authenticated', 'public.outbound_deliveries', 'select'));
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-0000ae200301', '00000000-0000-0000-0000-0000ae200001', 'S2', 'Client', 'm0-s2-client@example.com', 'active');
insert into public.appointments (id, studio_id, client_id, appointment_type, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000ae200801', '00000000-0000-0000-0000-0000ae200001', '00000000-0000-0000-0000-0000ae200301', 'private_lesson', now() + interval '1 day', now() + interval '1 day 1 hour');
set local role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-0000ae200201');
select pg_temp.expect_msg('outbound: studio owner cannot queue even a valid appointment notification directly',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, related_table, related_id, status)
     values ('00000000-0000-0000-0000-0000ae200001', 'email', 'appointment_confirmed', 'm0-s2-client@example.com', 'appointments', '00000000-0000-0000-0000-0000ae200801', 'queued')$q$, '42501');
reset role;
set local role service_role;
select pg_temp.expect_ok('outbound: the server (service role) still queues it',
  $q$insert into public.outbound_deliveries (studio_id, channel, template_key, recipient_email, related_table, related_id, status, dedupe_key)
     values ('00000000-0000-0000-0000-0000ae200001', 'email', 'appointment_confirmed', 'm0-s2-client@example.com', 'appointments', '00000000-0000-0000-0000-0000ae200801', 'queued', 'm0-s2-od')$q$);
reset role;

-- ---------------------------------------------------------------------------------------------------------------
-- Verdict (always raises: nothing persists)
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare
  v_total integer;
  v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok)
  into v_total, v_failures
  from t_results;
  if v_failures is null then
    raise exception 'M-0 STAGE 2 SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'M-0 STAGE 2 SUITE FAIL: %', v_failures;
end $$;

rollback;

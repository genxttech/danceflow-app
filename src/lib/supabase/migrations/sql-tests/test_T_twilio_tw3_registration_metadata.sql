-- TW-3 -- studio_sms_registrations registration-metadata regression suite.
--
-- Covers 20261106090000_twilio_tw3_registration_metadata.sql. One transaction, synthetic
-- fixtures only (UUID block 00000000-0000-0000-0000-0000c0a7XXXX), rolled back at the end:
-- nothing persists. Tenant behavior is simulated with `set local role` + request.jwt.claims.
-- Assumes the forward migration has been applied. The last statement prints one verdict row.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000c0a70001', 't-tw3-owner-a@example.test'),
  ('00000000-0000-0000-0000-0000c0a70002', 't-tw3-platform@example.test');

insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-0000c0a70001', 't-tw3-owner-a@example.test', 'Owner A');
insert into public.profiles (id, email, full_name, platform_role) values
  ('00000000-0000-0000-0000-0000c0a70002', 't-tw3-platform@example.test', 'Platform', 'platform_admin');

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000c0a7a0a1', 'TW3 Studio A', 't-tw3-studio-a'),
  ('00000000-0000-0000-0000-0000c0a7a0b1', 'TW3 Studio B', 't-tw3-studio-b'),
  ('00000000-0000-0000-0000-0000c0a7a0c1', 'TW3 Studio C', 't-tw3-studio-c');

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000c0a70001', '00000000-0000-0000-0000-0000c0a7a0a1', 'studio_owner', true);

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon;

create or replace function pg_temp.expect_fail(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  exception when others then
    insert into t_results values (p_name, true, sqlstate);
  end;
end $$;

create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, true, 'ok');
  exception when others then
    insert into t_results values (p_name, false, sqlerrm);
  end;
end $$;
grant execute on function pg_temp.expect_fail(text, text), pg_temp.expect_ok(text, text) to authenticated, anon;

-- Schema shape ---------------------------------------------------------------
insert into t_results
select 'six TW-3 columns exist',
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='studio_sms_registrations'
      and column_name in ('customer_profile_sid','brand_sid','phone_number_sid','campaign_use_case','brand_status','campaign_status')) = 6,
  null;
insert into t_results
select 'brand/campaign status default not_started and not null',
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='studio_sms_registrations'
      and column_name in ('brand_status','campaign_status') and is_nullable='NO'
      and column_default = '''not_started''::text') = 2,
  null;
insert into t_results
select 'no secret-shaped column on the table',
  not exists (select 1 from information_schema.columns
    where table_schema='public' and table_name='studio_sms_registrations'
      and column_name ~* '(token|secret|password|api_key|auth)'),
  null;

-- Platform admin -------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000c0a70002","role":"authenticated"}', true);

select pg_temp.expect_ok('admin creates registration with defaults',
  $q$insert into public.studio_sms_registrations (studio_id) values ('00000000-0000-0000-0000-0000c0a7a0a1')$q$);
select pg_temp.expect_ok('admin stores every identifier + use case + in_review states',
  $q$update public.studio_sms_registrations set registration_status='in_review',
       customer_profile_sid='BU11111111111111111111111111111111',
       brand_sid='BN22222222222222222222222222222222',
       messaging_service_sid='MG33333333333333333333333333333333',
       campaign_sid='QE44444444444444444444444444444444',
       phone_number_sid='PN55555555555555555555555555555555',
       sender_e164='+15550100001', campaign_use_case='mixed',
       brand_status='in_review', campaign_status='in_review'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$);

select pg_temp.expect_fail('approved with Brand still in review rejected',
  $q$update public.studio_sms_registrations set registration_status='approved', campaign_status='approved'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$);
select pg_temp.expect_fail('approved with Campaign still in review rejected',
  $q$update public.studio_sms_registrations set registration_status='approved', brand_status='approved'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$);
select pg_temp.expect_ok('component states can be approved before the aggregate',
  $q$update public.studio_sms_registrations set brand_status='approved', campaign_status='approved'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$);
select pg_temp.expect_ok('aggregate approved once everything is present and approved',
  $q$update public.studio_sms_registrations set registration_status='approved'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$);

select pg_temp.expect_fail('approved without Customer Profile SID rejected',
  $q$update public.studio_sms_registrations set customer_profile_sid=null where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$);
select pg_temp.expect_fail('approved without Brand SID rejected',
  $q$update public.studio_sms_registrations set brand_sid=null where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$);
select pg_temp.expect_fail('approved without Phone Number SID rejected',
  $q$update public.studio_sms_registrations set phone_number_sid=null where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$);
select pg_temp.expect_fail('approved without use case rejected',
  $q$update public.studio_sms_registrations set campaign_use_case=null where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$);
select pg_temp.expect_fail('approved without Messaging Service SID rejected',
  $q$update public.studio_sms_registrations set messaging_service_sid=null where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$);
select pg_temp.expect_fail('approved without Campaign SID rejected',
  $q$update public.studio_sms_registrations set campaign_sid=null where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$);
select pg_temp.expect_fail('approved without sender rejected',
  $q$update public.studio_sms_registrations set sender_e164=null where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$);

-- Studio B: empty row for contradiction / format checks
select pg_temp.expect_ok('admin creates second registration',
  $q$insert into public.studio_sms_registrations (studio_id) values ('00000000-0000-0000-0000-0000c0a7a0b1')$q$);
select pg_temp.expect_fail('campaign approved without campaign SID rejected',
  $q$update public.studio_sms_registrations set campaign_status='approved', campaign_use_case='mixed'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('campaign approved without use case rejected',
  $q$update public.studio_sms_registrations set campaign_status='approved', campaign_sid='QE66666666666666666666666666666666'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('brand approved without brand SID rejected',
  $q$update public.studio_sms_registrations set brand_status='approved'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('phone number SID without sender rejected',
  $q$update public.studio_sms_registrations set phone_number_sid='PN77777777777777777777777777777777'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('use case outside the supported set rejected',
  $q$update public.studio_sms_registrations set campaign_use_case='marketing'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('invalid brand status rejected',
  $q$update public.studio_sms_registrations set brand_status='approved_ish' where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('invalid campaign status rejected',
  $q$update public.studio_sms_registrations set campaign_status='live' where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('null brand status rejected',
  $q$update public.studio_sms_registrations set brand_status=null where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('Customer Profile SID with Brand prefix rejected',
  $q$update public.studio_sms_registrations set customer_profile_sid='BN11111111111111111111111111111111' where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('Brand SID with Customer Profile prefix rejected',
  $q$update public.studio_sms_registrations set brand_sid='BU22222222222222222222222222222222' where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('Phone Number SID with wrong prefix rejected',
  $q$update public.studio_sms_registrations set sender_e164='+15550100002', phone_number_sid='MG55555555555555555555555555555555' where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('short Brand SID rejected',
  $q$update public.studio_sms_registrations set brand_sid='BN123' where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('Phone Number SID cannot be reused by another studio',
  $q$update public.studio_sms_registrations set sender_e164='+15550100002', phone_number_sid='PN55555555555555555555555555555555'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_ok('rejected / suspended states are storable without full setup',
  $q$update public.studio_sms_registrations set registration_status='rejected', brand_status='rejected', campaign_status='suspended'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_ok('suspended aggregate is storable',
  $q$update public.studio_sms_registrations set registration_status='suspended'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);

-- Pre-existing rules still hold
select pg_temp.expect_fail('malformed Messaging Service SID still rejected',
  $q$update public.studio_sms_registrations set messaging_service_sid='QE88888888888888888888888888888888' where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);
select pg_temp.expect_fail('studio_id still immutable',
  $q$update public.studio_sms_registrations set studio_id='00000000-0000-0000-0000-0000c0a7a0c1' where studio_id='00000000-0000-0000-0000-0000c0a7a0b1'$q$);

reset role;

-- Ordinary studio owner: no access to the new metadata ------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000c0a70001","role":"authenticated"}', true);

create temp table t_owner_view on commit drop as
  select count(*)::int as visible from public.studio_sms_registrations;
grant select on t_owner_view to authenticated;

create or replace function pg_temp.owner_update_rows(p_sql text) returns int
language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function pg_temp.owner_update_rows(text) to authenticated;

insert into t_results
select 'owner sees no registration rows', (select visible from t_owner_view) = 0, (select visible::text from t_owner_view);
insert into t_results
select 'owner cannot edit TW-3 metadata on own studio (0 rows)',
  pg_temp.owner_update_rows($q$update public.studio_sms_registrations set brand_status='approved', brand_sid='BN22222222222222222222222222222222'
     where studio_id='00000000-0000-0000-0000-0000c0a7a0a1'$q$) = 0, null;
select pg_temp.expect_fail('owner cannot insert metadata',
  $q$insert into public.studio_sms_registrations (studio_id, brand_status) values ('00000000-0000-0000-0000-0000c0a7a0c1','approved')$q$);

reset role;
set local role anon;
select pg_temp.expect_fail('anon cannot read metadata', $q$select brand_sid from public.studio_sms_registrations$q$);
reset role;

select case when bool_and(ok) then 'TW-3 SQL SUITE PASS (' || count(*) || ' checks)'
            else 'TW-3 SQL SUITE FAIL' end as verdict,
       coalesce(string_agg(name || ' => ' || detail, '; ') filter (where not ok), '') as failures
from t_results;

rollback;

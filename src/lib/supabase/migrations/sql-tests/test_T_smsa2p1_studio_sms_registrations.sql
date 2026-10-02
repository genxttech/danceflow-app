-- SMS-A2P-1 -- studio_sms_registrations regression suite.
--
-- Covers 20261012090000_smsa2p1_studio_sms_registrations.sql. One transaction,
-- synthetic fixtures only (UUID block 00000000-0000-0000-0000-00005a2000XX),
-- rolled back at the end: nothing persists. Tenant behavior is simulated with
-- `set local role` + request.jwt.claims. Assumes the forward migration has
-- been applied. Every check raises on failure; success prints one result row.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00005a200001', 't-a2p-owner-a@example.test'),
  ('00000000-0000-0000-0000-00005a200002', 't-a2p-owner-b@example.test'),
  ('00000000-0000-0000-0000-00005a200003', 't-a2p-admin@example.test');

insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-00005a200001', 't-a2p-owner-a@example.test', 'Owner A'),
  ('00000000-0000-0000-0000-00005a200002', 't-a2p-owner-b@example.test', 'Owner B');

insert into public.profiles (id, email, full_name, platform_role) values
  ('00000000-0000-0000-0000-00005a200003', 't-a2p-admin@example.test', 'Admin', 'platform_admin');

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00005a2000a1', 'A2P Test Studio A', 't-a2p-studio-a'),
  ('00000000-0000-0000-0000-00005a2000b1', 'A2P Test Studio B', 't-a2p-studio-b');

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-00005a200001', '00000000-0000-0000-0000-00005a2000a1', 'studio_owner', true),
  ('00000000-0000-0000-0000-00005a200002', '00000000-0000-0000-0000-00005a2000b1', 'studio_owner', true);

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon;

-- Helper: run a statement, record whether it was denied/rejected as expected.
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

-- ============================================================================
-- Ordinary studio owner (owns studio A only)
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00005a200001","role":"authenticated"}', true);

select pg_temp.expect_fail('owner cannot create own registration',
  $q$insert into public.studio_sms_registrations (studio_id) values ('00000000-0000-0000-0000-00005a2000a1')$q$);
select pg_temp.expect_fail('owner cannot create approved registration',
  $q$insert into public.studio_sms_registrations (studio_id, registration_status, messaging_service_sid, campaign_sid, sender_e164)
     values ('00000000-0000-0000-0000-00005a2000a1','approved','MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','QEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','+15550100001')$q$);
select pg_temp.expect_fail('owner cannot create for another studio',
  $q$insert into public.studio_sms_registrations (studio_id) values ('00000000-0000-0000-0000-00005a2000b1')$q$);

reset role;
set local role anon;
select pg_temp.expect_fail('anon cannot insert',
  $q$insert into public.studio_sms_registrations (studio_id) values ('00000000-0000-0000-0000-00005a2000a1')$q$);
select pg_temp.expect_fail('anon cannot select',
  $q$select count(*) from public.studio_sms_registrations$q$);
reset role;

-- ============================================================================
-- Platform admin
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00005a200003","role":"authenticated"}', true);

select pg_temp.expect_ok('admin can create (not_registered default)',
  $q$insert into public.studio_sms_registrations (studio_id) values ('00000000-0000-0000-0000-00005a2000a1')$q$);
select pg_temp.expect_ok('admin can update to in_review with identifiers',
  $q$update public.studio_sms_registrations set registration_status='in_review',
       messaging_service_sid='MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       campaign_sid='QEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       sender_e164='+15550100001'
     where studio_id='00000000-0000-0000-0000-00005a2000a1'$q$);
select pg_temp.expect_ok('admin can approve with all identifiers',
  $q$update public.studio_sms_registrations set registration_status='approved'
     where studio_id='00000000-0000-0000-0000-00005a2000a1'$q$);
select pg_temp.expect_ok('admin can create second studio',
  $q$insert into public.studio_sms_registrations (studio_id) values ('00000000-0000-0000-0000-00005a2000b1')$q$);

select pg_temp.expect_fail('duplicate studio registration rejected',
  $q$insert into public.studio_sms_registrations (studio_id) values ('00000000-0000-0000-0000-00005a2000a1')$q$);
select pg_temp.expect_fail('invalid status rejected',
  $q$update public.studio_sms_registrations set registration_status='enabled'
     where studio_id='00000000-0000-0000-0000-00005a2000b1'$q$);
select pg_temp.expect_fail('approved without identifiers rejected',
  $q$update public.studio_sms_registrations set registration_status='approved'
     where studio_id='00000000-0000-0000-0000-00005a2000b1'$q$);
select pg_temp.expect_fail('malformed Messaging Service SID rejected',
  $q$update public.studio_sms_registrations set messaging_service_sid='QEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
     where studio_id='00000000-0000-0000-0000-00005a2000b1'$q$);
select pg_temp.expect_fail('malformed Campaign SID rejected',
  $q$update public.studio_sms_registrations set campaign_sid='MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
     where studio_id='00000000-0000-0000-0000-00005a2000b1'$q$);
select pg_temp.expect_fail('malformed sender rejected',
  $q$update public.studio_sms_registrations set sender_e164='555-0100'
     where studio_id='00000000-0000-0000-0000-00005a2000b1'$q$);
select pg_temp.expect_fail('identifier reuse across studios rejected',
  $q$update public.studio_sms_registrations set messaging_service_sid='MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
     where studio_id='00000000-0000-0000-0000-00005a2000b1'$q$);
select pg_temp.expect_fail('studio_id immutable',
  $q$update public.studio_sms_registrations set studio_id='00000000-0000-0000-0000-00005a2000b1'
     where studio_id='00000000-0000-0000-0000-00005a2000a1'$q$);
select pg_temp.expect_fail('platform admin cannot delete (no delete policy/grant)',
  $q$delete from public.studio_sms_registrations where studio_id='00000000-0000-0000-0000-00005a2000b1'$q$);

reset role;

-- ============================================================================
-- Ordinary owner against existing rows (studio A has an approved registration)
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00005a200001","role":"authenticated"}', true);

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
select 'owner sees no registration rows (own studio included)', (select visible from t_owner_view) = 0, (select visible::text from t_owner_view);
insert into t_results
select 'owner cannot update own approved row (0 rows affected)',
  pg_temp.owner_update_rows($q$update public.studio_sms_registrations set sender_e164='+15550109999'
     where studio_id='00000000-0000-0000-0000-00005a2000a1'$q$) = 0, null;
insert into t_results
select 'owner cannot mark other studio approved (0 rows affected)',
  pg_temp.owner_update_rows($q$update public.studio_sms_registrations set registration_status='rejected'
     where studio_id='00000000-0000-0000-0000-00005a2000b1'$q$) = 0, null;
select pg_temp.expect_fail('owner cannot delete',
  $q$delete from public.studio_sms_registrations where studio_id='00000000-0000-0000-0000-00005a2000a1'$q$);

reset role;

-- ============================================================================
-- Server-derived fields (as postgres, after the admin flow above)
-- ============================================================================
insert into t_results
select 'approved row has approved_at + submitted_at + created_by set by trigger',
  approved_at is not null and submitted_at is not null and created_by = '00000000-0000-0000-0000-00005a200003',
  registration_status
from public.studio_sms_registrations where studio_id = '00000000-0000-0000-0000-00005a2000a1';

insert into t_results
select 'not_registered row has no approved_at',
  approved_at is null and submitted_at is null,
  registration_status
from public.studio_sms_registrations where studio_id = '00000000-0000-0000-0000-00005a2000b1';

-- Verdict
select case when bool_and(ok) then 'SMS-A2P-1 SQL SUITE PASS (' || count(*) || ' checks)'
            else 'SMS-A2P-1 SQL SUITE FAIL' end as verdict,
       coalesce(string_agg(name || ' => ' || detail, '; ') filter (where not ok), '') as failures
from t_results;

rollback;

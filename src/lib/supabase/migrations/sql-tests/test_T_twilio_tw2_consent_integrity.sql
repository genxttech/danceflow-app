-- TW-2 -- SMS consent integrity regression suite.
--
-- Covers 20261105090000_twilio_tw2_consent_integrity.sql. One transaction, synthetic
-- fixtures only (UUID block 00000000-0000-0000-0000-0000c0a5XXXX, 555-01xx phones).
-- Tenant behavior is simulated with `set local role` + request.jwt.claims. Assumes the
-- forward migration has been applied. The final block ALWAYS raises, so the whole
-- transaction aborts and nothing persists; its message is the verdict:
--   "TW-2 SQL SUITE PASS (<n> checks)"  or  "TW-2 SQL SUITE FAIL: <failures>".

begin;

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000c0a50001', 't-tw2-owner-a@example.test'),
  ('00000000-0000-0000-0000-0000c0a50002', 't-tw2-admin-a@example.test'),
  ('00000000-0000-0000-0000-0000c0a50003', 't-tw2-front-a@example.test'),
  ('00000000-0000-0000-0000-0000c0a50004', 't-tw2-instr-a@example.test'),
  ('00000000-0000-0000-0000-0000c0a50005', 't-tw2-inactive-a@example.test'),
  ('00000000-0000-0000-0000-0000c0a50006', 't-tw2-owner-b@example.test'),
  ('00000000-0000-0000-0000-0000c0a50007', 't-tw2-platform@example.test'),
  ('00000000-0000-0000-0000-0000c0a50008', 't-tw2-org-1@example.test'),
  ('00000000-0000-0000-0000-0000c0a50009', 't-tw2-org-2@example.test');

insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-0000c0a50001', 't-tw2-owner-a@example.test', 'Owner A'),
  ('00000000-0000-0000-0000-0000c0a50002', 't-tw2-admin-a@example.test', 'Admin A'),
  ('00000000-0000-0000-0000-0000c0a50003', 't-tw2-front-a@example.test', 'Front A'),
  ('00000000-0000-0000-0000-0000c0a50004', 't-tw2-instr-a@example.test', 'Instructor A'),
  ('00000000-0000-0000-0000-0000c0a50005', 't-tw2-inactive-a@example.test', 'Inactive A'),
  ('00000000-0000-0000-0000-0000c0a50006', 't-tw2-owner-b@example.test', 'Owner B'),
  ('00000000-0000-0000-0000-0000c0a50008', 't-tw2-org-1@example.test', 'Organizer One'),
  ('00000000-0000-0000-0000-0000c0a50009', 't-tw2-org-2@example.test', 'Organizer Two');
insert into public.profiles (id, email, full_name, platform_role) values
  ('00000000-0000-0000-0000-0000c0a50007', 't-tw2-platform@example.test', 'Platform', 'platform_admin');

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0000c0a5a0a1', 'TW2 Studio A', 't-tw2-studio-a'),
  ('00000000-0000-0000-0000-0000c0a5a0b1', 'TW2 Studio B', 't-tw2-studio-b');

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0000c0a50001', '00000000-0000-0000-0000-0000c0a5a0a1', 'studio_owner', true),
  ('00000000-0000-0000-0000-0000c0a50002', '00000000-0000-0000-0000-0000c0a5a0a1', 'studio_admin', true),
  ('00000000-0000-0000-0000-0000c0a50003', '00000000-0000-0000-0000-0000c0a5a0a1', 'front_desk', true),
  ('00000000-0000-0000-0000-0000c0a50004', '00000000-0000-0000-0000-0000c0a5a0a1', 'instructor', true),
  ('00000000-0000-0000-0000-0000c0a50005', '00000000-0000-0000-0000-0000c0a5a0a1', 'studio_owner', false),
  ('00000000-0000-0000-0000-0000c0a50006', '00000000-0000-0000-0000-0000c0a5a0b1', 'studio_owner', true);

insert into public.clients (id, studio_id, first_name, last_name, phone) values
  ('00000000-0000-0000-0000-0000c0a5c001', '00000000-0000-0000-0000-0000c0a5a0a1', 'Tw2', 'One', '+15550170001'),
  ('00000000-0000-0000-0000-0000c0a5c002', '00000000-0000-0000-0000-0000c0a5a0a1', 'Tw2', 'Two', '+15550170002'),
  ('00000000-0000-0000-0000-0000c0a5c003', '00000000-0000-0000-0000-0000c0a5a0a1', 'Tw2', 'Three', '+15550170001'),
  ('00000000-0000-0000-0000-0000c0a5c004', '00000000-0000-0000-0000-0000c0a5a0a1', 'Tw2', 'Four', '+15550170004'),
  ('00000000-0000-0000-0000-0000c0a5c005', '00000000-0000-0000-0000-0000c0a5a0a1', 'Tw2', 'Five', '+15550170005'),
  ('00000000-0000-0000-0000-0000c0a5c006', '00000000-0000-0000-0000-0000c0a5a0a1', 'Tw2', 'Six', '+15550170006'),
  ('00000000-0000-0000-0000-0000c0a5c009', '00000000-0000-0000-0000-0000c0a5a0a1', 'Tw2', 'Nine', '+15550170009'),
  ('00000000-0000-0000-0000-0000c0a5c00a', '00000000-0000-0000-0000-0000c0a5a0a1', 'Tw2', 'Ten', '+15550170010'),
  ('00000000-0000-0000-0000-0000c0a5c0b1', '00000000-0000-0000-0000-0000c0a5a0b1', 'Tw2', 'B-One', '+15550170001'),
  ('00000000-0000-0000-0000-0000c0a5c0b2', '00000000-0000-0000-0000-0000c0a5a0b1', 'Tw2', 'B-Two', '+15550170002');

insert into public.organizers (id, name, slug) values
  ('00000000-0000-0000-0000-0000c0a5d001', 'TW2 Org 1', 't-tw2-org-1'),
  ('00000000-0000-0000-0000-0000c0a5d002', 'TW2 Org 2', 't-tw2-org-2');
insert into public.organizer_users (organizer_id, user_id, role, active) values
  ('00000000-0000-0000-0000-0000c0a5d001', '00000000-0000-0000-0000-0000c0a50008', 'organizer_owner', true),
  ('00000000-0000-0000-0000-0000c0a5d002', '00000000-0000-0000-0000-0000c0a50009', 'organizer_owner', true);
insert into public.organizer_contacts (id, organizer_id, email) values
  ('00000000-0000-0000-0000-0000c0a5e001', '00000000-0000-0000-0000-0000c0a5d001', 't-tw2-contact-1@example.test'),
  ('00000000-0000-0000-0000-0000c0a5e002', '00000000-0000-0000-0000-0000c0a5d002', 't-tw2-contact-2@example.test');

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create temp table t_legacy as
  select count(*) as n from public.sms_consent_history where actor_type is null;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.expect_fail(p_name text, p_sql text, p_state text default null) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  exception when others then
    insert into t_results values (p_name, p_state is null or sqlstate = p_state, sqlstate || ' ' || sqlerrm);
  end;
end $$;

create or replace function pg_temp.expect_hint(p_name text, p_sql text, p_hint text) returns void
language plpgsql as $$
declare v_hint text;
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    insert into t_results values (p_name, v_hint = p_hint, sqlstate || ' hint=' || coalesce(v_hint, ''));
  end;
end $$;

create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, true, 'ok');
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

grant execute on function pg_temp.chk(text, boolean, text), pg_temp.expect_fail(text, text, text),
  pg_temp.expect_hint(text, text, text), pg_temp.expect_ok(text, text) to authenticated, anon, service_role;

-- Count helpers (as postgres)
create or replace function pg_temp.hist(p_studio uuid, p_phone text, p_event text default null) returns int
language sql as $$
  select count(*)::int from public.sms_consent_history
  where studio_id = p_studio and phone_e164 = p_phone and (p_event is null or event_type = p_event)
$$;

create or replace function pg_temp.status(p_studio uuid, p_client uuid, p_phone text) returns text
language sql as $$
  select consent_status from public.sms_contact_permissions
  where studio_id = p_studio and client_id is not distinct from p_client and phone_e164 = p_phone
    and (p_client is not null or organizer_contact_id is null)
$$;

-- Operational send gate (mirrors the app): client row opted_in AND no opt-out for studio+phone.
create or replace function pg_temp.can_send(p_studio uuid, p_client uuid, p_phone text) returns boolean
language sql as $$
  select coalesce((select consent_status = 'opted_in' and opted_out_at is null
                   from public.sms_contact_permissions
                   where studio_id = p_studio and client_id = p_client and phone_e164 = p_phone), false)
     and not exists (select 1 from public.sms_contact_permissions
                     where studio_id = p_studio and phone_e164 = p_phone and consent_status = 'opted_out')
$$;

-- Readable aliases as psql-free literals
-- A  = 00000000-0000-0000-0000-0000c0a5a0a1   B = ...c0a5a0b1
-- P1 = +15550170001 (cA1, cA3, cB1)   P2 = +15550170002 (cA2, cB2)   P9 = +15550170009 (unknown)

-- ============================================================================
-- 1. Grants: no direct writes to current state or history
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a50001","role":"authenticated"}', true);

select pg_temp.expect_fail('owner cannot INSERT consent rows directly',
  $q$insert into public.sms_contact_permissions (studio_id, client_id, phone_e164, consent_status)
     values ('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c001','+15550170001','opted_in')$q$, '42501');
select pg_temp.expect_fail('owner cannot UPDATE consent rows directly',
  $q$update public.sms_contact_permissions set consent_status = 'opted_in'$q$, '42501');
select pg_temp.expect_fail('owner cannot DELETE consent rows directly',
  $q$delete from public.sms_contact_permissions$q$, '42501');
select pg_temp.expect_fail('owner cannot INSERT history',
  $q$insert into public.sms_consent_history (studio_id, phone_e164, new_consent_status) values ('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001','opted_in')$q$, '42501');
select pg_temp.expect_fail('owner cannot UPDATE history', $q$update public.sms_consent_history set consent_note = 'x'$q$, '42501');
select pg_temp.expect_fail('owner cannot DELETE history', $q$delete from public.sms_consent_history$q$, '42501');
select pg_temp.expect_fail('owner cannot TRUNCATE history', $q$truncate public.sms_consent_history$q$, '42501');
select pg_temp.expect_fail('authenticated cannot call inbound opt event',
  $q$select public.record_sms_inbound_opt_event('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001','start')$q$, '42501');
select pg_temp.expect_fail('authenticated cannot call public opt-in',
  $q$select public.record_sms_public_opt_in('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c001','+15550170001','public_lead_form',null)$q$, '42501');
select pg_temp.expect_fail('authenticated cannot set consent context',
  $q$select public._sms_consent_set_context('staff_opt_in','staff',null,null,null)$q$, '42501');
reset role;

set local role anon;
select pg_temp.expect_fail('anon cannot call staff upsert',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c001',null,'+15550170001','opted_in')$q$, '42501');
select pg_temp.expect_fail('anon cannot read consent rows', $q$select 1 from public.sms_contact_permissions limit 1$q$, '42501');
select pg_temp.expect_fail('anon cannot read history', $q$select 1 from public.sms_consent_history limit 1$q$, '42501');
reset role;

set local role service_role;
select pg_temp.expect_fail('service_role cannot INSERT consent rows directly',
  $q$insert into public.sms_contact_permissions (studio_id, client_id, phone_e164, consent_status)
     values ('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c001','+15550170001','opted_in')$q$, '42501');
select pg_temp.expect_fail('service_role cannot UPDATE consent rows directly',
  $q$update public.sms_contact_permissions set consent_status = 'opted_in' where false$q$, '42501');
select pg_temp.expect_fail('service_role cannot INSERT history',
  $q$insert into public.sms_consent_history (studio_id, phone_e164, new_consent_status) values ('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001','opted_in')$q$, '42501');
select pg_temp.expect_fail('service_role cannot DELETE history', $q$delete from public.sms_consent_history$q$, '42501');
reset role;

-- Even the table owner cannot rewrite history or write consent without the canonical context.
select pg_temp.expect_fail('owner role: history UPDATE refused by trigger',
  $q$update public.sms_consent_history set consent_note = consent_note$q$, '42501');
select pg_temp.expect_fail('owner role: history DELETE refused by trigger',
  $q$delete from public.sms_consent_history$q$, '42501');
select pg_temp.expect_fail('owner role: history TRUNCATE refused by trigger',
  $q$truncate public.sms_consent_history$q$, '42501');
select pg_temp.expect_fail('owner role: consent write without canonical context refused',
  $q$insert into public.sms_contact_permissions (studio_id, client_id, phone_e164, consent_status)
     values ('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c001','+15550170001','opted_in')$q$, '42501');
select pg_temp.chk('no history FK can delete or rewrite evidence',
  not exists (select 1 from pg_constraint where conrelid = 'public.sms_consent_history'::regclass and contype = 'f'
              and (confdeltype in ('n','d') or confrelid in ('public.sms_contact_permissions'::regclass, 'public.clients'::regclass, 'auth.users'::regclass))));

-- ============================================================================
-- 2. Staff upsert: authorization, tenant checks, actor evidence
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a50001","role":"authenticated"}', true);
select pg_temp.expect_ok('owner A records opt-in for client A1',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c001',null,'+15550170001','opted_in','studio_staff_manual','verbal')$q$);
select pg_temp.expect_ok('owner A repeats the identical opt-in (no-op)',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c001',null,'+15550170001','opted_in','studio_staff_manual','verbal')$q$);
select pg_temp.expect_fail('owner A cannot use a Studio B client id',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c0b1',null,'+15550170001','opted_in')$q$, 'P0002');
select pg_temp.expect_fail('owner A cannot act in Studio B',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0b1',null,'00000000-0000-0000-0000-0000c0a5c0b1',null,'+15550170001','opted_in')$q$, '42501');
select pg_temp.expect_fail('owner A cannot attach an organizer contact to a studio record',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,null,'00000000-0000-0000-0000-0000c0a5e001','+15550170001','opted_in')$q$, '22023');
select pg_temp.expect_fail('owner A cannot use a non-E.164 phone',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c001',null,'5550170001','opted_in')$q$, '22023');
reset role;

select pg_temp.chk('opt-in stored', pg_temp.status('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c001','+15550170001') = 'opted_in');
select pg_temp.expect_fail('owner role: re-pointing a consent row to another client without context refused',
  $q$update public.sms_contact_permissions set client_id = '00000000-0000-0000-0000-0000c0a5c002'
     where client_id = '00000000-0000-0000-0000-0000c0a5c001'$q$, '42501');
select pg_temp.expect_fail('owner role: changing a consent row''s phone without context refused',
  $q$update public.sms_contact_permissions set phone_e164 = '+15550170088'
     where client_id = '00000000-0000-0000-0000-0000c0a5c001'$q$, '42501');
select pg_temp.chk('Studio B client got no Studio A row',
  not exists (select 1 from public.sms_contact_permissions where client_id = '00000000-0000-0000-0000-0000c0a5c0b1'));
select pg_temp.chk('staff opt-in appended exactly one history event with frozen actor',
  (select count(*) = 1 and bool_and(event_type = 'staff_opt_in' and actor_type = 'staff' and actor_role = 'studio_owner'
          and actor_name = 'Owner A' and changed_by = '00000000-0000-0000-0000-0000c0a50001'
          and previous_consent_status is null and new_consent_status = 'opted_in')
   from public.sms_consent_history where client_id = '00000000-0000-0000-0000-0000c0a5c001'));

do $$
declare r record;
begin
  for r in select * from (values
    ('00000000-0000-0000-0000-0000c0a50002', 'studio_admin', true),
    ('00000000-0000-0000-0000-0000c0a50003', 'front_desk', true),
    ('00000000-0000-0000-0000-0000c0a50004', 'instructor', false),
    ('00000000-0000-0000-0000-0000c0a50005', 'inactive owner', false),
    ('00000000-0000-0000-0000-0000c0a50006', 'Studio B owner', false),
    ('00000000-0000-0000-0000-0000c0a50007', 'platform admin', false)) v(uid, label, allowed)
  loop
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', r.uid, 'role', 'authenticated')::text, true);
    if r.allowed then
      perform pg_temp.expect_ok(r.label || ' may record consent (client A2)',
        $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c002',null,'+15550170002','opted_in','studio_staff_manual',null)$q$);
    else
      perform pg_temp.expect_fail(r.label || ' may not record Studio A consent',
        $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c002',null,'+15550170002','opted_out','studio_staff_manual',null)$q$, '42501');
    end if;
    execute 'reset role';
  end loop;
end $$;

select pg_temp.chk('client A2 opted in by admin, front desk was a no-op',
  pg_temp.status('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c002','+15550170002') = 'opted_in'
  and pg_temp.hist('00000000-0000-0000-0000-0000c0a5a0a1','+15550170002') = 1
  and (select actor_role from public.sms_consent_history where client_id = '00000000-0000-0000-0000-0000c0a5c002') = 'studio_admin');

-- Organizer workspace tenant check
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a50008","role":"authenticated"}', true);
select pg_temp.expect_fail('organizer 1 cannot use organizer 2''s contact',
  $q$select public.upsert_sms_contact_permission(null,'00000000-0000-0000-0000-0000c0a5d001',null,'00000000-0000-0000-0000-0000c0a5e002','+15550170003','opted_in')$q$, 'P0002');
select pg_temp.expect_fail('organizer 1 cannot act for organizer 2',
  $q$select public.upsert_sms_contact_permission(null,'00000000-0000-0000-0000-0000c0a5d002',null,'00000000-0000-0000-0000-0000c0a5e002','+15550170003','opted_in')$q$, '42501');
select pg_temp.expect_ok('organizer 1 records its own contact',
  $q$select public.upsert_sms_contact_permission(null,'00000000-0000-0000-0000-0000c0a5d001',null,'00000000-0000-0000-0000-0000c0a5e001','+15550170003','opted_in')$q$);
reset role;

-- Studio B baseline for isolation: B client on the same phone P1, and on P2.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a50006","role":"authenticated"}', true);
select pg_temp.expect_ok('owner B opts in B1 on P1',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0b1',null,'00000000-0000-0000-0000-0000c0a5c0b1',null,'+15550170001','opted_in','studio_staff_manual',null)$q$);
select pg_temp.expect_ok('owner B opts in B2 on P2',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0b1',null,'00000000-0000-0000-0000-0000c0a5c0b2',null,'+15550170002','opted_in','studio_staff_manual',null)$q$);
reset role;

-- ============================================================================
-- 3. Consumer STOP is authoritative; staff cannot reverse it
-- ============================================================================
create temp table t_snap_a1 as select * from public.sms_consent_history
  where studio_id = '00000000-0000-0000-0000-0000c0a5a0a1' and phone_e164 = '+15550170001';

set local role service_role;
select pg_temp.expect_ok('inbound STOP for Studio A, P1',
  $q$select public.record_sms_inbound_opt_event('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001','stop')$q$);
reset role;

select pg_temp.chk('STOP: client A1 opted out with consumer source; original opt-in evidence kept',
  (select consent_status = 'opted_out' and opted_out_source = 'twilio_inbound_stop' and opted_out_at is not null
          and consent_source = 'studio_staff_manual' and consent_at is not null
   from public.sms_contact_permissions where client_id = '00000000-0000-0000-0000-0000c0a5c001'));
select pg_temp.chk('STOP: studio+phone-level opt-out row stored (no identity)',
  (select count(*) = 1 and bool_and(consent_status = 'opted_out' and opted_out_source = 'twilio_inbound_stop')
   from public.sms_contact_permissions
   where studio_id = '00000000-0000-0000-0000-0000c0a5a0a1' and phone_e164 = '+15550170001'
     and client_id is null and organizer_contact_id is null));
select pg_temp.chk('STOP: two inbound_stop events (client row + phone-level row), consumer actor',
  (select count(*) = 2 and bool_and(actor_type = 'consumer' and changed_by is null and new_consent_status = 'opted_out')
   from public.sms_consent_history
   where studio_id = '00000000-0000-0000-0000-0000c0a5a0a1' and phone_e164 = '+15550170001' and event_type = 'inbound_stop'));
select pg_temp.chk('STOP: Studio B consent for the same phone untouched',
  pg_temp.status('00000000-0000-0000-0000-0000c0a5a0b1','00000000-0000-0000-0000-0000c0a5c0b1','+15550170001') = 'opted_in'
  and not exists (select 1 from public.sms_contact_permissions
                  where studio_id = '00000000-0000-0000-0000-0000c0a5a0b1' and client_id is null)
  and pg_temp.hist('00000000-0000-0000-0000-0000c0a5a0b1','+15550170001','inbound_stop') = 0);
select pg_temp.chk('STOP blocks sends for A1', not pg_temp.can_send('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c001','+15550170001'));
select pg_temp.chk('Studio B still sendable on the same phone', pg_temp.can_send('00000000-0000-0000-0000-0000c0a5a0b1','00000000-0000-0000-0000-0000c0a5c0b1','+15550170001'));

create temp table t_cnt as select pg_temp.hist('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001') as n;
grant select on t_cnt to authenticated;

do $$
declare r record;
begin
  for r in select * from (values
    ('00000000-0000-0000-0000-0000c0a50001', 'owner'),
    ('00000000-0000-0000-0000-0000c0a50002', 'admin'),
    ('00000000-0000-0000-0000-0000c0a50003', 'front desk')) v(uid, label)
  loop
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', r.uid, 'role', 'authenticated')::text, true);
    perform pg_temp.expect_hint(r.label || ' cannot re-opt-in a consumer STOP',
      $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c001',null,'+15550170001','opted_in','studio_staff_manual','staff override')$q$,
      'sms_consumer_opt_out_locked');
    perform pg_temp.expect_hint(r.label || ' cannot reset a consumer STOP to unknown',
      $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c001',null,'+15550170001','unknown','studio_staff_manual',null)$q$,
      'sms_consumer_opt_out_locked');
    perform pg_temp.expect_hint(r.label || ' cannot opt in another client on the STOPped phone',
      $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c003',null,'+15550170001','opted_in','studio_staff_manual',null)$q$,
      'sms_consumer_opt_out_locked');
    perform pg_temp.expect_ok(r.label || ' staff opt-out on a consumer STOP is a no-op',
      $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c001',null,'+15550170001','opted_out','studio_staff_manual','noted')$q$);
    execute 'reset role';
  end loop;
end $$;

select pg_temp.chk('after staff attempts: A1 still consumer opted-out',
  (select consent_status = 'opted_out' and opted_out_source = 'twilio_inbound_stop'
   from public.sms_contact_permissions where client_id = '00000000-0000-0000-0000-0000c0a5c001'));
select pg_temp.chk('after staff attempts: no false history events',
  pg_temp.hist('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001') = (select n from t_cnt));
select pg_temp.chk('after staff attempts: no row created for client A3',
  not exists (select 1 from public.sms_contact_permissions where client_id = '00000000-0000-0000-0000-0000c0a5c003'));

set local role service_role;
select pg_temp.expect_ok('repeated STOP is accepted',
  $q$select public.record_sms_inbound_opt_event('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001','stop')$q$);
reset role;
select pg_temp.chk('repeated STOP appends nothing', pg_temp.hist('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001') = (select n from t_cnt));

-- A public form cannot clear a consumer STOP (Twilio still blocks until START).
set local role service_role;
select pg_temp.chk('public opt-in on a STOPped client is refused',
  public.record_sms_public_opt_in('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c001','+15550170001','public_lead_form','disclosure=a2p1b-v1') = 'opted_out');
reset role;
select pg_temp.chk('refused public opt-in appended nothing', pg_temp.hist('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001') = (select n from t_cnt));

-- Legacy consumer STOP (pre-TW-2 row with no phone-level row) is also protected.
select public._sms_consent_set_context('inbound_stop', 'system', null, null, 'suite fixture');
insert into public.sms_contact_permissions (studio_id, client_id, phone_e164, consent_status, consent_source, consent_at, opted_out_at, opted_out_source)
values ('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c006','+15550170006','opted_out','public_lead_form', now(), now(), 'twilio_inbound_stop');
select public._sms_consent_clear_context();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a50003","role":"authenticated"}', true);
select pg_temp.expect_hint('front desk cannot clear a legacy client-level consumer STOP',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c006',null,'+15550170006','opted_in','studio_staff_manual',null)$q$,
  'sms_consumer_opt_out_locked');
reset role;

-- ============================================================================
-- 4. STOP from a phone with no consent record or client
-- ============================================================================
set local role service_role;
select pg_temp.expect_ok('unknown-phone STOP for Studio A, P9',
  $q$select public.record_sms_inbound_opt_event('00000000-0000-0000-0000-0000c0a5a0a1','+15550170009','stop')$q$);
reset role;

select pg_temp.chk('unknown-phone STOP persisted as a studio+phone row with no identity',
  (select count(*) = 1 and bool_and(consent_status = 'opted_out' and client_id is null and organizer_contact_id is null
                                     and organizer_id is null and opted_out_source = 'twilio_inbound_stop')
   from public.sms_contact_permissions where studio_id = '00000000-0000-0000-0000-0000c0a5a0a1' and phone_e164 = '+15550170009'));
select pg_temp.chk('unknown-phone STOP has exactly one unknown_phone_stop event',
  pg_temp.hist('00000000-0000-0000-0000-0000c0a5a0a1','+15550170009') = 1
  and pg_temp.hist('00000000-0000-0000-0000-0000c0a5a0a1','+15550170009','unknown_phone_stop') = 1);
select pg_temp.chk('unknown-phone STOP did not touch Studio B',
  not exists (select 1 from public.sms_contact_permissions where studio_id = '00000000-0000-0000-0000-0000c0a5a0b1' and phone_e164 = '+15550170009'));

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a50001","role":"authenticated"}', true);
select pg_temp.expect_hint('later client association of the STOPped phone cannot be opted in by staff',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c009',null,'+15550170009','opted_in','studio_staff_manual',null)$q$,
  'sms_consumer_opt_out_locked');
reset role;
set local role service_role;
select pg_temp.chk('later public opt-in for the STOPped phone is refused',
  public.record_sms_public_opt_in('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c009','+15550170009','public_booking_form',null) = 'opted_out');
reset role;
select pg_temp.chk('unknown-phone STOP blocks sends once the phone is associated',
  not pg_temp.can_send('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c009','+15550170009'));
select public._sms_consent_set_context('staff_opt_in', 'system', null, null, 'suite fixture');
select pg_temp.expect_fail('phone-level rows can never hold opted_in',
  $q$update public.sms_contact_permissions set consent_status = 'opted_in'
     where studio_id = '00000000-0000-0000-0000-0000c0a5a0a1' and phone_e164 = '+15550170009' and client_id is null$q$, '23514');
select public._sms_consent_clear_context();

-- ============================================================================
-- 5. Consumer START re-enables only through the consumer path
-- ============================================================================
set local role service_role;
select pg_temp.chk('inbound START for Studio A, P1 restores one client row',
  (public.record_sms_inbound_opt_event('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001','start')->>'rows_changed')::int = 1);
reset role;

select pg_temp.chk('START: client A1 opted in again with new consumer evidence',
  (select consent_status = 'opted_in' and consent_source = 'twilio_inbound_start' and opted_out_at is null and opted_out_source is null
   from public.sms_contact_permissions where client_id = '00000000-0000-0000-0000-0000c0a5c001'));
select pg_temp.chk('START: phone-level block lifted to unknown (never consent)',
  (select consent_status = 'unknown' and opted_out_at is null
   from public.sms_contact_permissions where studio_id = '00000000-0000-0000-0000-0000c0a5a0a1' and phone_e164 = '+15550170001' and client_id is null));
select pg_temp.chk('START: history has STOP and START events, START by consumer',
  pg_temp.hist('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001','inbound_stop') = 2
  and (select count(*) = 2 and bool_and(actor_type = 'consumer')
       from public.sms_consent_history where studio_id = '00000000-0000-0000-0000-0000c0a5a0a1'
         and phone_e164 = '+15550170001' and event_type = 'inbound_start'));
select pg_temp.chk('START: earlier history rows are byte-identical',
  (select count(*) = (select count(*) from t_snap_a1) from public.sms_consent_history h
   join t_snap_a1 s on s.id = h.id
   where row(h.sms_contact_permission_id, h.client_id, h.previous_consent_status, h.new_consent_status, h.consent_source,
             h.consent_note, h.changed_by, h.changed_at, h.event_type, h.actor_type, h.actor_role, h.actor_name)
     is not distinct from
         row(s.sms_contact_permission_id, s.client_id, s.previous_consent_status, s.new_consent_status, s.consent_source,
             s.consent_note, s.changed_by, s.changed_at, s.event_type, s.actor_type, s.actor_role, s.actor_name)));
select pg_temp.chk('START restores send eligibility for A1', pg_temp.can_send('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c001','+15550170001'));

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a50003","role":"authenticated"}', true);
select pg_temp.expect_ok('after START, staff edits are allowed again',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c001',null,'+15550170001','opted_out','studio_staff_manual','asked at desk')$q$);
select pg_temp.expect_ok('a staff opt-out can be reversed by staff (not consumer-originated)',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c001',null,'+15550170001','opted_in','studio_staff_manual','re-confirmed')$q$);
reset role;
select pg_temp.chk('staff opt-out / opt-in recorded as staff events',
  pg_temp.hist('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001','staff_opt_out') = 1
  and pg_temp.hist('00000000-0000-0000-0000-0000c0a5a0a1','+15550170001','staff_opt_in') = 2);

-- START never creates consent; START in A does not affect B.
set local role service_role;
select public.record_sms_inbound_opt_event('00000000-0000-0000-0000-0000c0a5a0b1','+15550170002','stop');
select pg_temp.chk('START for unknown phone lifts the block but creates no consent',
  (public.record_sms_inbound_opt_event('00000000-0000-0000-0000-0000c0a5a0a1','+15550170009','start')->>'rows_changed')::int = 0);
select public.record_sms_inbound_opt_event('00000000-0000-0000-0000-0000c0a5a0a1','+15550170002','start');
reset role;
select pg_temp.chk('unknown-phone START: phone-level row unknown, no client row',
  (select consent_status from public.sms_contact_permissions where studio_id = '00000000-0000-0000-0000-0000c0a5a0a1' and phone_e164 = '+15550170009' and client_id is null) = 'unknown'
  and not exists (select 1 from public.sms_contact_permissions where client_id = '00000000-0000-0000-0000-0000c0a5c009')
  and pg_temp.hist('00000000-0000-0000-0000-0000c0a5a0a1','+15550170009','inbound_start') = 1);
select pg_temp.chk('Studio A START does not clear Studio B STOP',
  pg_temp.status('00000000-0000-0000-0000-0000c0a5a0b1','00000000-0000-0000-0000-0000c0a5c0b2','+15550170002') = 'opted_out'
  and pg_temp.status('00000000-0000-0000-0000-0000c0a5a0b1', null, '+15550170002') = 'opted_out');
select pg_temp.chk('Studio B STOP did not touch Studio A client A2',
  pg_temp.status('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c002','+15550170002') = 'opted_in');

-- START never turns a staff-recorded opt-out without prior consent evidence into consent.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a50001","role":"authenticated"}', true);
select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c00a',null,'+15550170010','opted_out','studio_staff_manual','asked not to text');
reset role;
set local role service_role;
select pg_temp.chk('START restores nothing for a client with no prior consent evidence',
  (public.record_sms_inbound_opt_event('00000000-0000-0000-0000-0000c0a5a0a1','+15550170010','start')->>'rows_changed')::int = 0);
reset role;
select pg_temp.chk('client without prior consent stays opted out after START',
  pg_temp.status('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c00a','+15550170010') = 'opted_out'
  and not pg_temp.can_send('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c00a','+15550170010'));

-- ============================================================================
-- 6. Public opt-in
-- ============================================================================
set local role service_role;
select pg_temp.chk('public opt-in inserts fresh consent',
  public.record_sms_public_opt_in('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c004','+15550170004','public_lead_form','disclosure=a2p1b-v1;form=public_lead_form') = 'inserted');
select pg_temp.chk('public opt-in again is already_opted_in',
  public.record_sms_public_opt_in('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c004','+15550170004','public_lead_form',null) = 'already_opted_in');
select pg_temp.expect_fail('public opt-in rejects a Studio B client under Studio A',
  $q$select public.record_sms_public_opt_in('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c0b1','+15550170001','public_lead_form',null)$q$, 'P0002');
select pg_temp.expect_fail('public opt-in rejects unknown sources',
  $q$select public.record_sms_public_opt_in('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c004','+15550170004','staff_typed_it',null)$q$, '22023');
reset role;
select pg_temp.chk('public opt-in history: one consumer public_opt_in event with disclosure evidence',
  (select count(*) = 1 and bool_and(event_type = 'public_opt_in' and actor_type = 'consumer' and consent_source = 'public_lead_form'
                                     and consent_note like 'disclosure=a2p1b-v1%')
   from public.sms_consent_history where client_id = '00000000-0000-0000-0000-0000c0a5c004'));

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a50001","role":"authenticated"}', true);
select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c005',null,'+15550170005','unknown','studio_staff_manual',null);
reset role;
set local role service_role;
select pg_temp.chk('public opt-in upgrades an unknown row',
  public.record_sms_public_opt_in('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c005','+15550170005','public_booking_form','disclosure=a2p1b-v1;form=public_booking_form') = 'upgraded');
reset role;
select pg_temp.chk('upgrade appended consumer public_opt_in after the staff event',
  (select string_agg(event_type, ',' order by changed_at, actor_type desc) from public.sms_consent_history
   where client_id = '00000000-0000-0000-0000-0000c0a5c005') = 'staff_consent_update,public_opt_in');

-- ============================================================================
-- 7. Atomicity: state and history commit or fail together
-- ============================================================================
create or replace function pg_temp.boom() returns trigger language plpgsql as $$
begin raise exception 'forced failure' using errcode = 'XX001'; end $$;

create temp table t_before as
  select (select count(*) from public.sms_consent_history) as hist,
         (select count(*) from public.sms_contact_permissions) as perms;

-- (a) history insert fails -> consent state unchanged
create trigger zz_tw2_boom_history before insert on public.sms_consent_history
  for each row execute function pg_temp.boom();
set local role service_role;
select pg_temp.expect_fail('STOP fails when history cannot be written',
  $q$select public.record_sms_inbound_opt_event('00000000-0000-0000-0000-0000c0a5a0a1','+15550170004','stop')$q$, 'XX001');
select pg_temp.expect_fail('unknown-phone STOP fails when history cannot be written',
  $q$select public.record_sms_inbound_opt_event('00000000-0000-0000-0000-0000c0a5a0a1','+15550170008','stop')$q$, 'XX001');
select pg_temp.expect_fail('public opt-in fails when history cannot be written',
  $q$select public.record_sms_public_opt_in('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c003','+15550170007','public_lead_form',null)$q$, 'XX001');
reset role;
drop trigger zz_tw2_boom_history on public.sms_consent_history;
select pg_temp.chk('history failure left consent state unchanged',
  pg_temp.status('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5c004','+15550170004') = 'opted_in'
  and not exists (select 1 from public.sms_contact_permissions where phone_e164 in ('+15550170008', '+15550170007'))
  and (select perms from t_before) = (select count(*) from public.sms_contact_permissions));

-- (b) state write fails -> no history
create trigger zz_tw2_boom_state before insert or update on public.sms_contact_permissions
  for each row execute function pg_temp.boom();
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a50001","role":"authenticated"}', true);
select pg_temp.expect_fail('staff edit fails when state cannot be written',
  $q$select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c004',null,'+15550170004','opted_out','studio_staff_manual',null)$q$, 'XX001');
reset role;
set local role service_role;
select pg_temp.expect_fail('unknown-phone STOP fails when state cannot be written',
  $q$select public.record_sms_inbound_opt_event('00000000-0000-0000-0000-0000c0a5a0a1','+15550170008','stop')$q$, 'XX001');
reset role;
drop trigger zz_tw2_boom_state on public.sms_contact_permissions;
select pg_temp.chk('state failure appended no history (no orphan evidence)',
  (select hist from t_before) = (select count(*) from public.sms_consent_history));

-- ============================================================================
-- 8. Actor evidence, visibility, evidence survival
-- ============================================================================
update public.profiles set full_name = 'Renamed Owner' where id = '00000000-0000-0000-0000-0000c0a50001';
select pg_temp.chk('actor name is frozen on history (profile rename does not change it)',
  (select string_agg(distinct actor_name, ',') from public.sms_consent_history
   where client_id = '00000000-0000-0000-0000-0000c0a5c001' and changed_by = '00000000-0000-0000-0000-0000c0a50001') = 'Owner A');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a50006","role":"authenticated"}', true);
select pg_temp.chk('Studio B owner cannot read Studio A history',
  (select count(*) from public.sms_consent_history where studio_id = '00000000-0000-0000-0000-0000c0a5a0a1') = 0);
select pg_temp.chk('Studio B owner reads own history',
  (select count(*) from public.sms_consent_history where studio_id = '00000000-0000-0000-0000-0000c0a5a0b1') > 0);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a50001","role":"authenticated"}', true);
select pg_temp.chk('Studio A owner reads Studio A history',
  (select count(*) from public.sms_consent_history where studio_id = '00000000-0000-0000-0000-0000c0a5a0a1') > 0);
reset role;

-- Deleting a staff user who edited consent works (created_by/updated_by SET NULL is not a
-- consent event) and leaves the frozen actor evidence on history untouched.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000c0a5000b', 't-tw2-front-del@example.test');
insert into public.profiles (id, email, full_name) values ('00000000-0000-0000-0000-0000c0a5000b', 't-tw2-front-del@example.test', 'Front Leaver');
insert into public.user_studio_roles (user_id, studio_id, role, active)
values ('00000000-0000-0000-0000-0000c0a5000b', '00000000-0000-0000-0000-0000c0a5a0a1', 'front_desk', true);
insert into public.clients (id, studio_id, first_name, last_name, phone)
values ('00000000-0000-0000-0000-0000c0a5c00b', '00000000-0000-0000-0000-0000c0a5a0a1', 'Tw2', 'Eleven', '+15550170011');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000c0a5000b","role":"authenticated"}', true);
select public.upsert_sms_contact_permission('00000000-0000-0000-0000-0000c0a5a0a1',null,'00000000-0000-0000-0000-0000c0a5c00b',null,'+15550170011','opted_in','studio_staff_manual','intake');
reset role;
create temp table t_hist_c00b as select count(*) as n from public.sms_consent_history where client_id = '00000000-0000-0000-0000-0000c0a5c00b';
delete from public.user_studio_roles where user_id = '00000000-0000-0000-0000-0000c0a5000b';
delete from public.profiles where id = '00000000-0000-0000-0000-0000c0a5000b';
select pg_temp.expect_ok('deleting a staff user who edited consent succeeds',
  $q$delete from auth.users where id = '00000000-0000-0000-0000-0000c0a5000b'$q$);
select pg_temp.chk('user deletion nulls only the current-row actor refs; consent unchanged',
  (select consent_status = 'opted_in' and created_by is null and updated_by is null
   from public.sms_contact_permissions where client_id = '00000000-0000-0000-0000-0000c0a5c00b'));
select pg_temp.chk('user deletion keeps history actor id, name and role; appends nothing',
  (select count(*) = (select n from t_hist_c00b)
          and bool_and(changed_by = '00000000-0000-0000-0000-0000c0a5000b' and actor_name = 'Front Leaver' and actor_role = 'front_desk')
   from public.sms_consent_history where client_id = '00000000-0000-0000-0000-0000c0a5c00b'));

create temp table t_hist_c4 as select count(*) as n from public.sms_consent_history where client_id = '00000000-0000-0000-0000-0000c0a5c004';
delete from public.clients where id = '00000000-0000-0000-0000-0000c0a5c004';
select pg_temp.chk('client deletion removes current consent but keeps history evidence',
  not exists (select 1 from public.sms_contact_permissions where client_id = '00000000-0000-0000-0000-0000c0a5c004')
  and (select count(*) from public.sms_consent_history where client_id = '00000000-0000-0000-0000-0000c0a5c004') = (select n from t_hist_c4)
  and (select n from t_hist_c4) > 0);

select pg_temp.chk('legacy (pre-TW-2) history rows untouched',
  (select count(*) from public.sms_consent_history where actor_type is null) = (select n from t_legacy));
select pg_temp.chk('every TW-2 history row is attributed',
  not exists (select 1 from public.sms_consent_history h
              where h.studio_id in ('00000000-0000-0000-0000-0000c0a5a0a1','00000000-0000-0000-0000-0000c0a5a0b1')
                and (h.actor_type is null or h.event_type in ('created','status_change','note_update'))));

-- ============================================================================
-- Verdict (always aborts the transaction)
-- ============================================================================
do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*), string_agg(name || ' => ' || detail, '; ') filter (where not ok)
  into v_total, v_failures from t_results;

  if v_failures is null then
    raise exception 'TW-2 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'TW-2 SQL SUITE FAIL: %', v_failures;
end $$;

rollback;

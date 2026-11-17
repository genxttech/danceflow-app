-- claim_my_event_registrations() (migration 20270221090000) -- verified-email claim of the buyer's own event registrations.
-- Requires 1C-A (20261008090000) and 1C-B. One transaction, synthetic fixtures (UUID block 00000000-0000-0000-0000-00c1a0XXXXXX);
-- bound identities are produced through the real 1C-A functions. The final block ALWAYS raises
-- "CLAIM SQL SUITE PASS (<n> checks)" or "CLAIM SQL SUITE FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlerrm; end $$;

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00c1a0000101', 'Claim Studio A', 't-claim-a'),
  ('00000000-0000-0000-0000-00c1a0000102', 'Claim Studio B', 't-claim-b');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00c1a0001001', 'cl-a@example.test'),   -- verified + bound
  ('00000000-0000-0000-0000-00c1a0001002', 'cl-u@example.test'),   -- proof only (binding_required): NOT verified
  ('00000000-0000-0000-0000-00c1a0001003', 'cl-b@example.test'),   -- verified + bound (second user)
  ('00000000-0000-0000-0000-00c1a0001004', 'cl-n@example.test');   -- no proof at all
insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-00c1a0001001', 'cl-a@example.test', 'CL A'),
  ('00000000-0000-0000-0000-00c1a0001002', 'cl-u@example.test', 'CL U'),
  ('00000000-0000-0000-0000-00c1a0001003', 'cl-b@example.test', 'CL B'),
  ('00000000-0000-0000-0000-00c1a0001004', 'cl-n@example.test', 'CL N')
on conflict (id) do nothing;

-- sessions: *a = proof session (before binding), *b = post-binding session
insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('00000000-0000-0000-0000-00c1a000a01a', '00000000-0000-0000-0000-00c1a0001001', now() - interval '1 minute', now()),
  ('00000000-0000-0000-0000-00c1a000a01b', '00000000-0000-0000-0000-00c1a0001001', now(), now()),
  ('00000000-0000-0000-0000-00c1a000a02a', '00000000-0000-0000-0000-00c1a0001002', now() - interval '1 minute', now()),
  ('00000000-0000-0000-0000-00c1a000a02b', '00000000-0000-0000-0000-00c1a0001002', now(), now()),
  ('00000000-0000-0000-0000-00c1a000a03a', '00000000-0000-0000-0000-00c1a0001003', now() - interval '1 minute', now()),
  ('00000000-0000-0000-0000-00c1a000a03b', '00000000-0000-0000-0000-00c1a0001003', now(), now()),
  ('00000000-0000-0000-0000-00c1a000a04b', '00000000-0000-0000-0000-00c1a0001004', now(), now());
insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values
  (gen_random_uuid(), '00000000-0000-0000-0000-00c1a000a01a', now(), now(), 'otp'),
  (gen_random_uuid(), '00000000-0000-0000-0000-00c1a000a01b', now(), now(), 'password'),
  (gen_random_uuid(), '00000000-0000-0000-0000-00c1a000a02a', now(), now(), 'otp'),
  (gen_random_uuid(), '00000000-0000-0000-0000-00c1a000a02b', now(), now(), 'password'),
  (gen_random_uuid(), '00000000-0000-0000-0000-00c1a000a03a', now(), now(), 'otp'),
  (gen_random_uuid(), '00000000-0000-0000-0000-00c1a000a03b', now(), now(), 'password'),
  (gen_random_uuid(), '00000000-0000-0000-0000-00c1a000a04b', now(), now(), 'password');

create function pg_temp.as_user(p_sub text, p_sid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated', 'session_id', p_sid)::text, true);
end $$;

do $$
declare r text;
begin
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-00c1a0001001', '00000000-0000-0000-0000-00c1a000a01a');
  r := public.record_email_proof_web();
  if r <> 'binding_required' then raise exception 'FIXTURE a proof: %', r; end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-00c1a0001002', '00000000-0000-0000-0000-00c1a000a02a');
  r := public.record_email_proof_web();
  if r <> 'binding_required' then raise exception 'FIXTURE u proof: %', r; end if;
  perform pg_temp.as_user('00000000-0000-0000-0000-00c1a0001003', '00000000-0000-0000-0000-00c1a000a03a');
  r := public.record_email_proof_web();
  if r <> 'binding_required' then raise exception 'FIXTURE b proof: %', r; end if;
  reset role;
  if not public.complete_email_binding('00000000-0000-0000-0000-00c1a0001001', '00000000-0000-0000-0000-00c1a000a01a')
     or not public.complete_email_binding('00000000-0000-0000-0000-00c1a0001003', '00000000-0000-0000-0000-00c1a000a03a') then
    raise exception 'FIXTURE binding failed';
  end if;
end $$;

insert into public.events (id, studio_id, name, slug, event_type, status, visibility, start_date, end_date, timezone) values
  ('00000000-0000-0000-0000-00c1a0000201', '00000000-0000-0000-0000-00c1a0000101', 'Claim Event A', 'claim-sql-event-a', 'special_event', 'published', 'public', '2027-06-05', '2027-06-05', 'America/Chicago'),
  ('00000000-0000-0000-0000-00c1a0000202', '00000000-0000-0000-0000-00c1a0000102', 'Claim Event B', 'claim-sql-event-b', 'special_event', 'published', 'public', '2027-06-05', '2027-06-05', 'America/Chicago');

create or replace function pg_temp.reg(p_id text, p_event text, p_status text, p_pay text, p_email text, p_user uuid default null)
returns void language plpgsql as $$
begin
  insert into public.event_registrations (id, event_id, studio_id, status, payment_status, quantity, unit_price, total_price, currency,
                                          registration_source, attendee_first_name, attendee_last_name, attendee_email, user_id)
  values (('00000000-0000-0000-0000-00c1a00003' || p_id)::uuid, ('00000000-0000-0000-0000-00c1a00002' || p_event)::uuid,
          case p_event when '01' then '00000000-0000-0000-0000-00c1a0000101'::uuid else '00000000-0000-0000-0000-00c1a0000102'::uuid end,
          p_status, p_pay, 1, 10, 10, 'USD', 'public_event_page', 'Pat', 'Buyer', p_email, p_user);
end $$;

-- 01: guest web purchase, plain email;  02: other studio, mixed case + whitespace;  03: cancelled;  04: refunded
-- 05: already owned by user B (must never move);  06: other email;  07: null email;  08: unverified user's email;  09: no-proof user's email
select pg_temp.reg('01', '01', 'confirmed', 'paid', 'cl-a@example.test');
select pg_temp.reg('02', '02', 'confirmed', 'paid', '  CL-A@Example.Test ');
select pg_temp.reg('03', '01', 'cancelled', 'refunded', 'cl-a@example.test');
select pg_temp.reg('04', '01', 'refunded', 'refunded', 'cl-a@example.test');
select pg_temp.reg('05', '01', 'confirmed', 'paid', 'cl-a@example.test', '00000000-0000-0000-0000-00c1a0001003');
select pg_temp.reg('06', '01', 'confirmed', 'paid', 'someone-else@example.test');
select pg_temp.reg('07', '01', 'confirmed', 'paid', null);
select pg_temp.reg('08', '01', 'confirmed', 'paid', 'cl-u@example.test');
select pg_temp.reg('09', '01', 'confirmed', 'paid', 'cl-n@example.test');

-- a guest attendee row carrying A's email on someone else's registration (06) must not be a claim key
insert into public.event_registration_attendees (registration_id, event_id, first_name, last_name, sort_order)
values ('00000000-0000-0000-0000-00c1a0000306', '00000000-0000-0000-0000-00c1a0000201', 'Guest', 'cl-a@example.test', 1);

create or replace function pg_temp.claim_as(p_sub text, p_sid text) returns integer language plpgsql as $$
declare v integer;
begin
  set local role authenticated;
  perform pg_temp.as_user(p_sub, p_sid);
  v := public.claim_my_event_registrations();
  reset role;
  return v;
end $$;

create or replace function pg_temp.owner_of(p_id text) returns uuid language sql as $$
  select user_id from public.event_registrations where id = ('00000000-0000-0000-0000-00c1a00003' || p_id)::uuid $$;

create or replace function pg_temp.others() returns text language sql as $$
  select (select count(*) from public.clients)::text || '/' || (select count(*) from public.client_account_links)::text || '/'
      || (select count(*) from public.notifications)::text || '/' || (select count(*) from public.payments)::text || '/'
      || (select count(*) from public.event_registration_attendees)::text || '/' || (select count(*) from public.event_orders)::text
$$;

select pg_temp.others() as before \gset
select md5(string_agg(id::text || coalesce(attendee_email, '') || status || payment_status || coalesce(studio_id::text, ''), ',' order by id)) as shape_before
  from public.event_registrations \gset

-- ---------------------------------------------------------------------------------------------------------------
-- Not verified: nothing changes
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.claim_as('00000000-0000-0000-0000-00c1a0001002', '00000000-0000-0000-0000-00c1a000a02b') as nu \gset
select pg_temp.chk('unverified (proof only, not bound): claims nothing even though its email matches a row', :nu = 0 and pg_temp.owner_of('08') is null, :'nu');
select pg_temp.claim_as('00000000-0000-0000-0000-00c1a0001004', '00000000-0000-0000-0000-00c1a000a04b') as nn \gset
select pg_temp.chk('no proof at all: claims nothing', :nn = 0 and pg_temp.owner_of('09') is null, :'nn');
select pg_temp.claim_as('00000000-0000-0000-0000-00c1a0001001', '00000000-0000-0000-0000-00c1a000a02b') as nf \gset
select pg_temp.chk('verified user presenting another user''s session id: claims nothing', :nf = 0 and pg_temp.owner_of('01') is null, :'nf');
select pg_temp.claim_as('00000000-0000-0000-0000-00c1a0001001', '00000000-0000-0000-0000-00c1a000a01a') as np \gset
select pg_temp.chk('verified user on the pre-binding proof session: claims nothing', :np = 0 and pg_temp.owner_of('01') is null, :'np');

do $$ begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('test.n', public.claim_my_event_registrations()::text, true);
  reset role;
exception when others then
  reset role;
  perform set_config('test.n', 'err:' || sqlerrm, true);
end $$;
select pg_temp.chk('no auth uid (empty claims): returns 0 and changes nothing', current_setting('test.n') = '0', current_setting('test.n'));

-- ---------------------------------------------------------------------------------------------------------------
-- Verified user claims
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.claim_as('00000000-0000-0000-0000-00c1a0001001', '00000000-0000-0000-0000-00c1a000a01b') as n1 \gset
select pg_temp.chk('verified user: claims every unclaimed registration with their email (4: both studios, case/whitespace, cancelled, refunded)', :n1 = 4, :'n1');
select pg_temp.chk('claimed rows now belong to the user (incl. cancelled/refunded history and the other studio)',
  pg_temp.owner_of('01') = '00000000-0000-0000-0000-00c1a0001001' and pg_temp.owner_of('02') = '00000000-0000-0000-0000-00c1a0001001'
  and pg_temp.owner_of('03') = '00000000-0000-0000-0000-00c1a0001001' and pg_temp.owner_of('04') = '00000000-0000-0000-0000-00c1a0001001');
select pg_temp.chk('a row owned by another account is never taken', pg_temp.owner_of('05') = '00000000-0000-0000-0000-00c1a0001003');
select pg_temp.chk('rows with another email, a null email, or another user''s email are untouched',
  pg_temp.owner_of('06') is null and pg_temp.owner_of('07') is null and pg_temp.owner_of('08') is null and pg_temp.owner_of('09') is null);
select pg_temp.chk('a guest attendee row carrying the email is not a claim key (its registration stays unclaimed, attendee unchanged)',
  pg_temp.owner_of('06') is null
  and (select last_name from public.event_registration_attendees where registration_id = '00000000-0000-0000-0000-00c1a0000306') = 'cl-a@example.test');

select pg_temp.claim_as('00000000-0000-0000-0000-00c1a0001001', '00000000-0000-0000-0000-00c1a000a01b') as n2 \gset
select pg_temp.chk('replay: second call claims nothing and changes nothing', :n2 = 0 and pg_temp.owner_of('01') = '00000000-0000-0000-0000-00c1a0001001', :'n2');

select pg_temp.claim_as('00000000-0000-0000-0000-00c1a0001003', '00000000-0000-0000-0000-00c1a000a03b') as n3 \gset
select pg_temp.chk('another verified user claims nothing of A''s; A''s rows and B''s own row keep their owners',
  :n3 = 0 and pg_temp.owner_of('01') = '00000000-0000-0000-0000-00c1a0001001' and pg_temp.owner_of('05') = '00000000-0000-0000-0000-00c1a0001003', :'n3');

-- ---------------------------------------------------------------------------------------------------------------
-- Account deletion nulls user_id (history preserved); a later re-signup with the same verified email re-claims
-- ---------------------------------------------------------------------------------------------------------------
update public.event_registrations set user_id = null where user_id = '00000000-0000-0000-0000-00c1a0001001';
select pg_temp.chk('after account deletion the rows are unowned', pg_temp.owner_of('01') is null and pg_temp.owner_of('03') is null);
select pg_temp.claim_as('00000000-0000-0000-0000-00c1a0001001', '00000000-0000-0000-0000-00c1a000a01b') as n4 \gset
select pg_temp.chk('re-claim after deletion + re-signup (same verified email): all 4 rows come back', :n4 = 4, :'n4');

-- ---------------------------------------------------------------------------------------------------------------
-- The claim makes the existing self-read policy work, without any new read surface
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare v_regs integer; v_foreign integer;
begin
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-00c1a0001001', '00000000-0000-0000-0000-00c1a000a01b');
  select count(*) into v_regs from public.event_registrations where lower(btrim(attendee_email)) = 'cl-a@example.test';
  select count(*) into v_foreign from public.event_registrations where user_id is distinct from '00000000-0000-0000-0000-00c1a0001001';
  reset role;
  perform set_config('test.read', v_regs || '/' || v_foreign, true);
end $$;
select pg_temp.chk('after claiming, the user reads their own registrations (existing self policy) and no one else''s',
  split_part(current_setting('test.read'), '/', 1)::int = 4 and split_part(current_setting('test.read'), '/', 2)::int = 0, current_setting('test.read'));

-- ---------------------------------------------------------------------------------------------------------------
-- Nothing outside event_registrations.user_id was written
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.chk('no writes to clients, links, notifications, payments, attendees or orders', pg_temp.others() = :'before', pg_temp.others() || ' vs ' || :'before');
select pg_temp.chk('only user_id changed on registrations (email, status, payment, studio unchanged)',
  (select md5(string_agg(id::text || coalesce(attendee_email, '') || status || payment_status || coalesce(studio_id::text, ''), ',' order by id)) from public.event_registrations) = :'shape_before');

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges and definition
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.chk('privileges: authenticated may execute; anon, service_role and PUBLIC may not',
  has_function_privilege('authenticated', 'public.claim_my_event_registrations()', 'execute')
  and not has_function_privilege('anon', 'public.claim_my_event_registrations()', 'execute')
  and not has_function_privilege('service_role', 'public.claim_my_event_registrations()', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where p.oid = 'public.claim_my_event_registrations()'::regprocedure and a.grantee = 0));
select pg_temp.chk('definition: parameterless, SECURITY DEFINER, search_path pinned, returns integer',
  (select pronargs = 0 and prosecdef and prorettype = 'integer'::regtype and exists (select 1 from unnest(proconfig) c where c like 'search_path=%')
   from pg_proc where oid = 'public.claim_my_event_registrations()'::regprocedure));
select pg_temp.chk('anon is refused (permission denied)',
  pg_temp.try($q$set local role anon; select public.claim_my_event_registrations()$q$) like '%permission denied%');
reset role;

do $$
declare v_total integer; v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into v_total, v_failures from t_results;
  if v_failures is null then raise exception 'CLAIM SQL SUITE PASS (% checks)', v_total; end if;
  raise exception 'CLAIM SQL SUITE FAIL: %', v_failures;
end $$;

rollback;

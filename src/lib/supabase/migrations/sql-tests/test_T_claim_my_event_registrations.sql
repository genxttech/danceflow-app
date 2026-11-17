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
-- 05: already owned by user B (must never move);  06: other email;  07: blank email (column is NOT NULL);  08: unverified user's email;  09: no-proof user's email
select pg_temp.reg('01', '01', 'confirmed', 'paid', 'cl-a@example.test');
select pg_temp.reg('02', '02', 'confirmed', 'paid', '  CL-A@Example.Test ');
select pg_temp.reg('03', '01', 'cancelled', 'refunded', 'cl-a@example.test');
select pg_temp.reg('04', '01', 'refunded', 'refunded', 'cl-a@example.test');
select pg_temp.reg('05', '01', 'confirmed', 'paid', 'cl-a@example.test', '00000000-0000-0000-0000-00c1a0001003');
select pg_temp.reg('06', '01', 'confirmed', 'paid', 'someone-else@example.test');
select pg_temp.reg('07', '01', 'confirmed', 'paid', '   ');
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
select pg_temp.chk('rows with another email, a blank email, or another user''s email are untouched',
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

-- ---------------------------------------------------------------------------------------------------------------
-- Order-backed registrations (PAY-WH-1 guard), purchaser vs holder boundary, studio-sold tickets, byte-level snapshot
-- ---------------------------------------------------------------------------------------------------------------
insert into public.clients (id, studio_id, first_name, last_name, email, status) values
  ('00000000-0000-0000-0000-00c1a0000c01', '00000000-0000-0000-0000-00c1a0000101', 'Studio', 'Client', 'studio-client@example.test', 'lead');

create or replace function pg_temp.mk_ord(p_n text, p_buyer text, p_reg_email text, p_owner uuid default null, p_status text default 'confirmed', p_pay text default 'paid')
returns void language plpgsql as $$
declare v_o uuid := ('00000000-0000-0000-0000-00c1a00004' || p_n)::uuid;
begin
  insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, currency, status, payment_status, paid_at, metadata)
  values (v_o, '00000000-0000-0000-0000-00c1a0000201', '00000000-0000-0000-0000-00c1a0000101', 'Purchaser ' || p_n, p_buyer, 10, 10, 'USD', p_status, p_pay, now(), '{"source":"event_cart_v1"}'::jsonb);
  insert into public.event_registrations (id, order_id, event_id, studio_id, status, payment_status, quantity, unit_price, total_price, currency,
                                          registration_source, attendee_first_name, attendee_last_name, attendee_email, user_id)
  values (('00000000-0000-0000-0000-00c1a00005' || p_n)::uuid, v_o, '00000000-0000-0000-0000-00c1a0000201', '00000000-0000-0000-0000-00c1a0000101',
          p_status, p_pay, 1, 10, 10, 'USD', 'public_event_page', 'Holder', p_n, p_reg_email, p_owner);
end $$;

create or replace function pg_temp.owner5(p_n text) returns uuid language sql as $$
  select user_id from public.event_registrations where id = ('00000000-0000-0000-0000-00c1a00005' || p_n)::uuid $$;

-- 11: own purchase (order buyer = holder = A);  12: gift TO A (order buyer = B, holder A);  13: gift FROM A (order buyer = A, holder B)
-- 14: order-backed, already owned by B (A email);  15: unverified user's own order-backed purchase;  16: pending order-backed hold (A)
select pg_temp.mk_ord('11', 'cl-a@example.test', 'cl-a@example.test');
select pg_temp.mk_ord('12', 'cl-b@example.test', 'cl-a@example.test');
select pg_temp.mk_ord('13', 'cl-a@example.test', 'cl-b@example.test');
select pg_temp.mk_ord('14', 'cl-a@example.test', 'cl-a@example.test', '00000000-0000-0000-0000-00c1a0001003');
select pg_temp.mk_ord('15', 'cl-u@example.test', 'cl-u@example.test');
select pg_temp.mk_ord('16', 'cl-a@example.test', 'cl-a@example.test', null, 'pending', 'pending');
-- 17: studio-sold (orderless, admin source, linked studio client, internal notes), holder A
insert into public.event_registrations (id, event_id, studio_id, client_id, status, payment_status, quantity, unit_price, total_price, currency,
                                        registration_source, attendee_first_name, attendee_last_name, attendee_email, notes)
values ('00000000-0000-0000-0000-00c1a0000517', '00000000-0000-0000-0000-00c1a0000201', '00000000-0000-0000-0000-00c1a0000101',
        '00000000-0000-0000-0000-00c1a0000c01', 'confirmed', 'paid', 1, 10, 10, 'USD', 'admin', 'Studio', 'Sold', 'cl-a@example.test',
        'Manual ticket sale created from workspace by user staff-internal-id');

create or replace function pg_temp.snap_all() returns text language plpgsql as $$
declare t text; r text := ''; v text;
begin
  foreach t in array array['event_orders','payments','event_registration_attendees','commerce_entitlements','commerce_orders','clients',
    'client_account_links','notifications','event_settlement_outbox','event_settlements','accounting_entries','marketing_unsubscribes',
    'marketing_email_suppressions','marketing_campaign_recipients','organizer_marketing_unsubscribes','event_order_settlement_exceptions',
    'payment_settlement_conflicts','event_ticket_types','events','studios']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('select coalesce(md5(string_agg(x::text, %L order by x::text)), %L) from public.%I x', ',', 'empty', t) into v;
      r := r || t || '=' || v || ';';
    end if;
  end loop;
  return r;
end $$;
create or replace function pg_temp.regs_minus_owner() returns text language sql as $$
  select md5(string_agg((to_jsonb(x) - 'user_id' - 'updated_at')::text, ',' order by x.id)) from public.event_registrations x $$;

create temp table t_upd as select id, updated_at from public.event_registrations;
select pg_temp.snap_all() as snap_before \gset
select pg_temp.regs_minus_owner() as regs_before \gset

select pg_temp.claim_as('00000000-0000-0000-0000-00c1a0001002', '00000000-0000-0000-0000-00c1a000a02b') as m_u \gset
select pg_temp.chk('unverified user: an order-backed registration with their email is not claimed', :m_u = 0 and pg_temp.owner5('15') is null, :'m_u');

select pg_temp.claim_as('00000000-0000-0000-0000-00c1a0001001', '00000000-0000-0000-0000-00c1a000a01b') as m_a \gset
select pg_temp.chk('A claims the order-backed own purchase (11), the gift held by A (12), the pending hold (16) and the studio-sold ticket (17)', :m_a = 4, :'m_a');
select pg_temp.chk('own order-backed purchase and pending hold are claimed without tripping the PAY-WH-1 guard',
  pg_temp.owner5('11') = '00000000-0000-0000-0000-00c1a0001001' and pg_temp.owner5('16') = '00000000-0000-0000-0000-00c1a0001001');
select pg_temp.chk('gift: the registration holder email (A) claims it, not the purchaser by being the order buyer',
  pg_temp.owner5('12') = '00000000-0000-0000-0000-00c1a0001001');
select pg_temp.chk('gift the other way: A as order purchaser does not claim a registration held by another email', pg_temp.owner5('13') is null);
select pg_temp.chk('an already-claimed order-backed row (14) is never reassigned', pg_temp.owner5('14') = '00000000-0000-0000-0000-00c1a0001003');
select pg_temp.chk('studio-sold ticket is claimed by the holder verified email only', pg_temp.owner5('17') = '00000000-0000-0000-0000-00c1a0001001');

select pg_temp.claim_as('00000000-0000-0000-0000-00c1a0001003', '00000000-0000-0000-0000-00c1a000a03b') as m_b \gset
select pg_temp.chk('B claims only the registration held by B (13), not the order B purchased (12)',
  :m_b = 1 and pg_temp.owner5('13') = '00000000-0000-0000-0000-00c1a0001003' and pg_temp.owner5('12') = '00000000-0000-0000-0000-00c1a0001001', :'m_b');

select pg_temp.claim_as('00000000-0000-0000-0000-00c1a0001001', '00000000-0000-0000-0000-00c1a000a01b') as m_a2 \gset
select pg_temp.chk('replay: nothing further to claim', :m_a2 = 0, :'m_a2');

select pg_temp.chk('payments, orders, attendees, entitlements, clients/leads, links, notifications, settlement, accounting, marketing, tickets, events and studios are byte-identical',
  pg_temp.snap_all() = :'snap_before');
select pg_temp.chk('registrations: every column except user_id and updated_at is byte-identical after the claims', pg_temp.regs_minus_owner() = :'regs_before');
select count(*) as upd_changed from public.event_registrations r join t_upd u on u.id = r.id where r.updated_at is distinct from u.updated_at \gset
select pg_temp.chk('INFO updated_at changed on ' || :'upd_changed' || ' registration rows (non-zero means a trigger touches it)', true);

-- control: the PAY-WH-1 guard trigger is installed and enabled while the claim updated ORDER-BACKED rows (the definer runs as the table owner, which the
-- guard deliberately lets through; client roles have no UPDATE policy on their own rows, so a buyer cannot reach the guarded columns either way)
select pg_temp.chk('PAY-WH-1 guard trigger is enabled and the claimed rows (11, 12, 16) are order-backed',
  exists (select 1 from pg_trigger where tgrelid = 'public.event_registrations'::regclass and tgname = 'trg_paywh1_guard_order_registration_writes' and tgenabled = 'O')
  and (select count(*) from public.event_registrations where id in ('00000000-0000-0000-0000-00c1a0000511', '00000000-0000-0000-0000-00c1a0000512', '00000000-0000-0000-0000-00c1a0000516')
       and order_id is not null and user_id = '00000000-0000-0000-0000-00c1a0001001') = 3);

do $$
declare v_orders integer; v_clients integer; v_pay integer;
begin
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-00c1a0001001', '00000000-0000-0000-0000-00c1a000a01b');
  select count(*) into v_orders from public.event_orders where buyer_email <> 'cl-a@example.test';
  select count(*) into v_clients from public.clients;
  select count(*) into v_pay from public.payments;
  reset role;
  perform set_config('test.vis', v_orders || '/' || v_clients || '/' || v_pay, true);
end $$;
select pg_temp.chk('claimed user cannot read other purchasers orders, studio clients/leads or payments (visible orders/clients/payments)',
  current_setting('test.vis') = '0/0/0', current_setting('test.vis'));

do $$
declare v_total integer; v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok) into v_total, v_failures from t_results;
  if v_failures is null then raise exception 'CLAIM SQL SUITE PASS (% checks)', v_total; end if;
  raise exception 'CLAIM SQL SUITE FAIL: %', v_failures;
end $$;

rollback;

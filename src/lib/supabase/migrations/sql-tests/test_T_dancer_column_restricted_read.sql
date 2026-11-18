-- Dancer column-restricted read: public.my_event_registrations / public.my_event_registration_attendees (20270222092000) and the
-- direct-policy cutover (20270222093000). Proves: a dancer who owns a claimed public_event_page row sees ONLY the safe columns, only through
-- the views; direct table reads and the attendee self-insert are gone; no cross-user read; anon and no-JWT see nothing; staff access is
-- unchanged (full columns, update, insert); studio-sold rows stay unclaimed; the PAY-WH-1 / Stripe guards are untouched.
-- Needs 1C-A (20261008090000), 20270221090000, 20270222090000, 20270222091000, 20270222092000 and 20270222093000.
-- One transaction, synthetic fixtures (UUID block 00000000-0000-0000-0000-00c01bXXXXXX). The final block ALWAYS raises
-- "COLUMN-RESTRICTED READ SQL SUITE PASS (<n> checks)" or "... FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlerrm; end $$;

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00c01b000101', 'Col Studio A', 't-colq-a'),
  ('00000000-0000-0000-0000-00c01b000102', 'Col Studio B', 't-colq-b');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00c01b001001', 'colq-a@example.test'),    -- dancer A: verified + bound
  ('00000000-0000-0000-0000-00c01b001002', 'colq-x@example.test'),    -- dancer X: owns another row, never claims
  ('00000000-0000-0000-0000-00c01b001003', 'colq-staff@example.test'),-- studio A staff
  ('00000000-0000-0000-0000-00c01b001004', 'colq-staffb@example.test');-- studio B staff (other studio)
insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-00c01b001001', 'colq-a@example.test', 'Colq A'),
  ('00000000-0000-0000-0000-00c01b001002', 'colq-x@example.test', 'Colq X'),
  ('00000000-0000-0000-0000-00c01b001003', 'colq-staff@example.test', 'Colq Staff'),
  ('00000000-0000-0000-0000-00c01b001004', 'colq-staffb@example.test', 'Colq Staff B')
on conflict (id) do nothing;
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-00c01b001003', '00000000-0000-0000-0000-00c01b000101', 'studio_owner', true),
  ('00000000-0000-0000-0000-00c01b001004', '00000000-0000-0000-0000-00c01b000102', 'studio_owner', true);

insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('00000000-0000-0000-0000-00c01b00a01a', '00000000-0000-0000-0000-00c01b001001', now() - interval '1 minute', now()),
  ('00000000-0000-0000-0000-00c01b00a01b', '00000000-0000-0000-0000-00c01b001001', now(), now());
insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values
  (gen_random_uuid(), '00000000-0000-0000-0000-00c01b00a01a', now(), now(), 'otp'),
  (gen_random_uuid(), '00000000-0000-0000-0000-00c01b00a01b', now(), now(), 'password');

create function pg_temp.as_user(p_sub text, p_sid text default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated', 'session_id', p_sid)::text, true);
end $$;

do $$
declare r text;
begin
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-00c01b001001', '00000000-0000-0000-0000-00c01b00a01a');
  r := public.record_email_proof_web();
  if r <> 'binding_required' then raise exception 'FIXTURE a proof: %', r; end if;
  reset role;
  if not public.complete_email_binding('00000000-0000-0000-0000-00c01b001001', '00000000-0000-0000-0000-00c01b00a01a') then
    raise exception 'FIXTURE binding failed';
  end if;
end $$;

insert into public.clients (id, studio_id, first_name, last_name, email) values
  ('00000000-0000-0000-0000-00c01b000401', '00000000-0000-0000-0000-00c01b000101', 'Studio', 'Crm', 'crm@example.test');
insert into public.events (id, studio_id, name, slug, event_type, status, visibility, start_date, end_date, timezone) values
  ('00000000-0000-0000-0000-00c01b000201', '00000000-0000-0000-0000-00c01b000101', 'Colq Event', 'colq-event', 'special_event', 'published', 'public', '2027-06-05', '2027-06-05', 'America/Chicago');
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, status, payment_status, stripe_payment_intent_id, stripe_checkout_session_id) values
  ('00000000-0000-0000-0000-00c01b000501', '00000000-0000-0000-0000-00c01b000201', '00000000-0000-0000-0000-00c01b000101', 'Pat', 'colq-a@example.test', 'confirmed', 'paid', 'pi_secret_1', 'cs_secret_1');

-- 01: public_event_page, A's email, with CRM link + stripe ids + notes + hold (claimable);  02: studio-sold 'admin' with A's email (NOT claimable)
-- 03: dancer X's own row (user_id preset);  04: someone else's email (unowned, stays unowned)
insert into public.event_registrations (id, event_id, studio_id, user_id, client_id, order_id, status, payment_status, quantity, unit_price, total_price, currency, registration_source,
    attendee_first_name, attendee_last_name, attendee_email, notes, stripe_payment_intent_id, stripe_checkout_session_id, terminal_hold_until, portal_user_id) values
  ('00000000-0000-0000-0000-00c01b000301', '00000000-0000-0000-0000-00c01b000201', '00000000-0000-0000-0000-00c01b000101', null,
   '00000000-0000-0000-0000-00c01b000401', '00000000-0000-0000-0000-00c01b000501', 'confirmed', 'paid', 2, 10, 20, 'USD', 'public_event_page', 'Pat', 'Buyer', 'colq-a@example.test',
   'INTERNAL: studio note', 'pi_secret_1', 'cs_secret_1', now() + interval '1 hour', null),
  ('00000000-0000-0000-0000-00c01b000302', '00000000-0000-0000-0000-00c01b000201', '00000000-0000-0000-0000-00c01b000101', null,
   '00000000-0000-0000-0000-00c01b000401', null, 'confirmed', 'paid', 1, 10, 10, 'USD', 'admin', 'Pat', 'Buyer', 'colq-a@example.test',
   'INTERNAL: sold at the desk', null, null, null, null),
  ('00000000-0000-0000-0000-00c01b000303', '00000000-0000-0000-0000-00c01b000201', '00000000-0000-0000-0000-00c01b000101', '00000000-0000-0000-0000-00c01b001002',
   null, null, 'confirmed', 'paid', 1, 10, 10, 'USD', 'public_event_page', 'Other', 'Person', 'colq-x@example.test', 'X own note', null, null, null, null),
  ('00000000-0000-0000-0000-00c01b000304', '00000000-0000-0000-0000-00c01b000201', '00000000-0000-0000-0000-00c01b000101', null,
   null, null, 'confirmed', 'paid', 1, 10, 10, 'USD', 'public_event_page', 'Else', 'Body', 'someone-else@example.test', null, null, null, null, null);
insert into public.event_registration_attendees (id, registration_id, event_id, first_name, last_name, email, sort_order, checked_in_by, ticket_token, ticket_code) values
  ('00000000-0000-0000-0000-00c01b000601', '00000000-0000-0000-0000-00c01b000301', '00000000-0000-0000-0000-00c01b000201', 'Pat', 'Buyer', 'colq-a@example.test', 1, '00000000-0000-0000-0000-00c01b001003', 'tok_secret_1', 'CODE1'),
  ('00000000-0000-0000-0000-00c01b000602', '00000000-0000-0000-0000-00c01b000303', '00000000-0000-0000-0000-00c01b000201', 'Other', 'Person', 'colq-x@example.test', 1, null, 'tok_secret_x', 'CODEX');

create or replace function pg_temp.as_role(p_role text, p_sub text) returns void language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  if p_sub is null then perform set_config('request.jwt.claims', '', true);
  else perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role)::text, true); end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Claim (existing contract) then the dancer's reads
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare n integer;
begin
  set local role authenticated;
  perform pg_temp.as_user('00000000-0000-0000-0000-00c01b001001', '00000000-0000-0000-0000-00c01b00a01a');
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00c01b001001', 'role', 'authenticated', 'session_id', '00000000-0000-0000-0000-00c01b00a01b')::text, true);
  n := public.claim_my_event_registrations();
  reset role;
  insert into t_results values ('claim: only the public_event_page row is claimed (studio-sold stays unowned)',
    n = 1 and (select user_id from public.event_registrations where id = '00000000-0000-0000-0000-00c01b000301') = '00000000-0000-0000-0000-00c01b001001'
          and (select user_id from public.event_registrations where id = '00000000-0000-0000-0000-00c01b000302') is null, n::text);
end $$;

-- policy shape after cutover: the three dancer-self policies are gone, nothing else changed
select pg_temp.chk('cutover: dancer-self policies removed from both tables',
  not exists (select 1 from pg_policies where schemaname = 'public' and policyname in ('event_registrations_self_select', 'event_registration_attendees_self_select', 'event_registration_attendees_self_insert')));
select pg_temp.chk('cutover: staff and organizer policies still present',
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'event_registrations'
     and policyname in ('event_registrations_select', 'event_registrations_staff_select', 'event_registrations_update', 'event_registrations_staff_update',
                        'event_registrations_insert', 'event_registrations_staff_insert', 'Organizer users can view event registrations', 'Organizer users can manage event registrations')) = 8
  and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'event_registration_attendees'
     and policyname in ('event_registration_attendees_staff_select', 'event_registration_attendees_staff_update', 'event_registration_attendees_staff_insert',
                        'event_registration_attendees_studio_member_manage', 'event_registration_attendees_studio_member_select', 'event_registration_attendees_service_role_all',
                        'Organizer users can view event registration attendees', 'Organizer users can manage event registration attendees')) = 8);

-- view shape
select pg_temp.chk('view my_event_registrations: exact safe column list',
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'my_event_registrations')
  = array['id','event_id','ticket_type_id','studio_id','user_id','status','payment_status','attendee_first_name','attendee_last_name','attendee_email','attendee_phone',
          'quantity','unit_price','total_price','total_amount','currency','checked_in_at','cancelled_at','created_at','updated_at']);
select pg_temp.chk('view my_event_registration_attendees: exact safe column list',
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'my_event_registration_attendees')
  = array['id','registration_id','event_id','ticket_type_id','first_name','last_name','email','phone','attendee_role','sort_order','waiver_signed_at','checked_in_at','ticket_code','ticket_issued_at','created_at']);
select pg_temp.chk('views carry none of the studio-only / secret columns',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name in ('my_event_registrations', 'my_event_registration_attendees')
    and column_name in ('client_id','organizer_contact_id','stripe_checkout_session_id','stripe_payment_intent_id','terminal_hold_until','portal_user_id','source','registration_source',
                        'notes','order_id','promoted_from_waitlist_at','waitlist_notified_at','checked_in_by','ticket_token')));
select pg_temp.chk('views: grants are select to authenticated only (no anon/public, no write)',
  has_table_privilege('authenticated', 'public.my_event_registrations', 'select') and has_table_privilege('authenticated', 'public.my_event_registration_attendees', 'select')
  and not has_table_privilege('anon', 'public.my_event_registrations', 'select') and not has_table_privilege('anon', 'public.my_event_registration_attendees', 'select')
  and not has_table_privilege('authenticated', 'public.my_event_registrations', 'insert') and not has_table_privilege('authenticated', 'public.my_event_registrations', 'update')
  and not has_table_privilege('authenticated', 'public.my_event_registrations', 'delete') and not has_table_privilege('authenticated', 'public.my_event_registration_attendees', 'insert')
  and not has_table_privilege('authenticated', 'public.my_event_registration_attendees', 'update') and not has_table_privilege('authenticated', 'public.my_event_registration_attendees', 'delete'));

-- ---------------------------------------------------------------------------------------------------------------
-- Dancer A
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_role('authenticated', '00000000-0000-0000-0000-00c01b001001');
select (select count(*) from public.my_event_registrations) as a_view_n,
       (select id::text from public.my_event_registrations limit 1) as a_view_id,
       (select quantity::text from public.my_event_registrations limit 1) as a_view_vals,
       (select count(*) from public.my_event_registration_attendees) as a_att_n,
       (select ticket_code from public.my_event_registration_attendees limit 1) as a_att_code,
       (select count(*) from public.event_registrations) as a_direct_regs,
       (select count(*) from public.event_registration_attendees) as a_direct_atts,
       (select count(*) from public.event_orders) as a_orders,
       (select count(*) from public.clients) as a_clients \gset
select pg_temp.try($q$ insert into public.event_registration_attendees (registration_id, event_id, first_name, last_name, sort_order, ticket_code, ticket_token, checked_in_at)
  values ('00000000-0000-0000-0000-00c01b000301', '00000000-0000-0000-0000-00c01b000201', 'Forged', 'Guest', 3, 'FORGED', 'forged-token', now()) $q$) as a_forge \gset
select pg_temp.try($q$ insert into public.my_event_registration_attendees (registration_id, event_id, first_name, last_name, sort_order) values ('00000000-0000-0000-0000-00c01b000301', '00000000-0000-0000-0000-00c01b000201', 'X', 'Y', 4) $q$) as a_vins \gset
select pg_temp.try($q$ update public.my_event_registrations set status = 'cancelled' $q$) as a_vupd \gset
select pg_temp.try($q$ delete from public.my_event_registrations $q$) as a_vdel \gset
reset role;

select pg_temp.chk('dancer A: view returns exactly the one claimed public_event_page row (not the studio-sold row, not X, not the unowned row)',
  :a_view_n = 1 and :'a_view_id' = '00000000-0000-0000-0000-00c01b000301' and :'a_view_vals' = '2', :'a_view_n' || ' ' || :'a_view_id' || ' ' || :'a_view_vals');
select pg_temp.chk('dancer A: attendee view returns only the ticket of the own registration', :a_att_n = 1 and :'a_att_code' = 'CODE1', :'a_att_n' || ' ' || :'a_att_code');
select pg_temp.chk('dancer A: direct select on event_registrations / event_registration_attendees returns nothing', :a_direct_regs = 0 and :a_direct_atts = 0, :'a_direct_regs' || '/' || :'a_direct_atts');
select pg_temp.chk('dancer A: event_orders and clients unreadable', :a_orders = 0 and :a_clients = 0, :'a_orders' || '/' || :'a_clients');
select pg_temp.chk('dancer A: attendee self-insert (forged code/token/check-in) is denied by RLS', :'a_forge' like '%row-level security%', :'a_forge');
select pg_temp.chk('dancer A: the views accept no insert/update/delete', :'a_vins' like '%permission denied%' and :'a_vupd' like '%permission denied%' and :'a_vdel' like '%permission denied%',
  :'a_vins' || ' | ' || :'a_vupd' || ' | ' || :'a_vdel');

-- Dancer X: own row only, no cross-user read
select pg_temp.as_role('authenticated', '00000000-0000-0000-0000-00c01b001002');
select (select count(*) from public.my_event_registrations) as x_n, (select id::text from public.my_event_registrations limit 1) as x_id,
       (select count(*) from public.my_event_registration_attendees) as x_att, (select ticket_code from public.my_event_registration_attendees limit 1) as x_code \gset
reset role;
select pg_temp.chk('dancer X: sees only X own row and ticket (no cross-user read in either direction)',
  :x_n = 1 and :'x_id' = '00000000-0000-0000-0000-00c01b000303' and :x_att = 1 and :'x_code' = 'CODEX', :x_n || ' ' || :'x_id' || ' ' || :x_att || ' ' || :'x_code');

-- anon / no JWT
select pg_temp.as_role('anon', null);
select pg_temp.try($q$ select count(*) from public.my_event_registrations $q$) as anon_view, pg_temp.try($q$ select count(*) from public.my_event_registration_attendees $q$) as anon_view2 \gset
select (select count(*) from public.event_registrations) as anon_direct, (select count(*) from public.event_registration_attendees) as anon_direct_att \gset
reset role;
select pg_temp.chk('anon: both views denied; direct tables return nothing', :'anon_view' like '%permission denied%' and :'anon_view2' like '%permission denied%' and :anon_direct = 0 and :anon_direct_att = 0,
  :'anon_view' || ' | ' || :anon_direct);
select pg_temp.as_role('authenticated', null);
select (select count(*) from public.my_event_registrations) as nojwt_view, (select count(*) from public.my_event_registration_attendees) as nojwt_att,
       (select count(*) from public.event_registrations) as nojwt_direct \gset
reset role;
select pg_temp.chk('authenticated without a user id (no sub): views and tables return nothing', :nojwt_view = 0 and :nojwt_att = 0 and :nojwt_direct = 0, :nojwt_view || '/' || :nojwt_att || '/' || :nojwt_direct);

-- ---------------------------------------------------------------------------------------------------------------
-- Studio staff: unchanged (full columns, update, insert, attendee update); other studio staff see nothing
-- ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_role('authenticated', '00000000-0000-0000-0000-00c01b001003');
select (select count(*) from public.event_registrations where event_id = '00000000-0000-0000-0000-00c01b000201') as s_regs,
       (select client_id::text from public.event_registrations where id = '00000000-0000-0000-0000-00c01b000301') as s_client,
       (select notes from public.event_registrations where id = '00000000-0000-0000-0000-00c01b000302') as s_notes,
       (select stripe_payment_intent_id from public.event_registrations where id = '00000000-0000-0000-0000-00c01b000301') as s_pi,
       (select ticket_token from public.event_registration_attendees where id = '00000000-0000-0000-0000-00c01b000601') as s_tok,
       (select checked_in_by::text from public.event_registration_attendees where id = '00000000-0000-0000-0000-00c01b000601') as s_cib,
       (select count(*) from public.event_orders) as s_orders \gset
select pg_temp.try($q$ update public.event_registrations set notes = 'staff edit' where id = '00000000-0000-0000-0000-00c01b000304' $q$) as s_upd \gset
select (select notes from public.event_registrations where id = '00000000-0000-0000-0000-00c01b000304') as s_upd_val \gset
select pg_temp.try($q$ update public.event_registration_attendees set checked_in_at = now() where id = '00000000-0000-0000-0000-00c01b000601' $q$) as s_aupd \gset
select pg_temp.try($q$ insert into public.event_registrations (event_id, studio_id, status, payment_status, quantity, unit_price, total_price, currency, registration_source, attendee_first_name, attendee_last_name, attendee_email)
  values ('00000000-0000-0000-0000-00c01b000201', '00000000-0000-0000-0000-00c01b000101', 'confirmed', 'paid', 1, 10, 10, 'USD', 'admin', 'New', 'Guest', 'new-guest@example.test') $q$) as s_ins \gset
reset role;
select pg_temp.chk('staff: reads every registration of the studio with all internal columns (client_id, notes, stripe ids) and attendee secrets',
  :s_regs = 4 and :'s_client' = '00000000-0000-0000-0000-00c01b000401' and :'s_notes' = 'INTERNAL: sold at the desk' and :'s_pi' = 'pi_secret_1'
  and :'s_tok' = 'tok_secret_1' and :'s_cib' = '00000000-0000-0000-0000-00c01b001003' and :s_orders = 1,
  :s_regs || ' ' || :'s_client' || ' ' || :'s_notes' || ' ' || :'s_pi' || ' ' || :'s_tok' || ' ' || :s_orders);
select pg_temp.chk('staff: update and insert unchanged', :'s_upd' = 'ok' and :'s_upd_val' = 'staff edit' and :'s_aupd' = 'ok' and :'s_ins' = 'ok', :'s_upd' || ' ' || :'s_aupd' || ' ' || :'s_ins');
select pg_temp.as_role('authenticated', '00000000-0000-0000-0000-00c01b001004');
select (select count(*) from public.event_registrations) as sb_regs, (select count(*) from public.event_registration_attendees) as sb_atts, (select count(*) from public.my_event_registrations) as sb_view \gset
reset role;
select pg_temp.chk('other-studio staff: no registrations, attendees or dancer-view rows of studio A', :sb_regs = 0 and :sb_atts = 0 and :sb_view = 0, :sb_regs || '/' || :sb_atts || '/' || :sb_view);

-- service role keeps full access
select pg_temp.as_role('service_role', null);
select (select count(*) from public.event_registrations) as sr_regs, (select count(*) from public.event_registration_attendees) as sr_atts \gset
reset role;
select pg_temp.chk('service_role: unchanged full access', :sr_regs >= 5 and :sr_atts = 2, :sr_regs || '/' || :sr_atts);

-- Payment-integrity guards untouched
select pg_temp.chk('PAY-WH-1 and Stripe identity guards still present and enabled on event_registrations',
  (select count(*) from pg_trigger where tgrelid = 'public.event_registrations'::regclass and not tgisinternal and tgenabled = 'O'
     and tgname in ('trg_event_registrations_stripe_identity_guard', 'trg_paywh1_guard_order_registration_writes', 'trg_enforce_event_ticket_capacity_holds')) = 3);
select pg_temp.chk('claim function and index objects intact (definer, allowlist, partial index)',
  (select prosecdef from pg_proc where oid = to_regprocedure('public.claim_my_event_registrations()'))
  and position('registration_source in (''public_event_page'')' in pg_get_functiondef(to_regprocedure('public.claim_my_event_registrations()'))) > 0
  and exists (select 1 from pg_index i where i.indexrelid = to_regclass('public.event_registrations_unclaimed_email_idx') and i.indisvalid));

do $$
declare
  v_fail text;
  v_total integer;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then
    raise exception 'COLUMN-RESTRICTED READ SQL SUITE PASS (% checks)', v_total;
  else
    raise exception 'COLUMN-RESTRICTED READ SQL SUITE FAIL: %', v_fail;
  end if;
end $$;

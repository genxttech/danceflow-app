-- G-02 -- event registration lead capture follows the per-ticket-type creates_prospect_lead setting (migration 20270219090000).
--
-- Needs the PAY-WH-1 chain (20261116090000..20261116094000) plus 20270219090000. One transaction, synthetic fixtures only
-- (UUID block 00000000-0000-0000-0000-00a2f0XXXXXX). The final block ALWAYS raises, so nothing persists; its message is
-- the verdict: "G-02 SQL SUITE PASS (<n> checks)" or "G-02 SQL SUITE FAIL: <failures>".
--
-- Settlement-driven: orders are settled through settle_event_cart_order exactly like production, then the settlement
-- outbox's studio_lead rows are drained through capture_event_registration_lead (what the TypeScript worker does).

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

create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlerrm; end $$;

create or replace function pg_temp.try_jsonb(p_sql text) returns jsonb
language plpgsql as $$
declare r jsonb;
begin
  execute p_sql into r;
  return r;
exception when others then
  return jsonb_build_object('outcome', 'error', 'error', sqlstate || ' ' || sqlerrm);
end $$;

create or replace function pg_temp.kv(p_k text) returns text language sql as $$ select v from t_kv where k = p_k $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Fixtures: two studios; event A (studio 1) with one ticket type per kind; event B (studio 2) with a GA ticket type.
-- ---------------------------------------------------------------------------------------------------------------
insert into public.studios (id, name, slug, stripe_connected_account_id) values
  ('00000000-0000-0000-0000-00a2f0000101', 'G02 Studio', 'g02-sql-studio', 'acct_g02studio'),
  ('00000000-0000-0000-0000-00a2f0000102', 'G02 Other', 'g02-sql-other', 'acct_g02other');
insert into public.events (id, studio_id, name, slug, event_type, status, visibility, start_date, end_date, timezone) values
  ('00000000-0000-0000-0000-00a2f0000201', '00000000-0000-0000-0000-00a2f0000101', 'G02 Event', 'g02-sql-event', 'special_event', 'published', 'public', '2027-06-05', '2027-06-05', 'America/Chicago'),
  ('00000000-0000-0000-0000-00a2f0000202', '00000000-0000-0000-0000-00a2f0000102', 'G02 Other Event', 'g02-sql-event-b', 'special_event', 'published', 'public', '2027-06-05', '2027-06-05', 'America/Chicago');

do $$
declare
  v_kind text;
  v_i integer := 0;
  v_id uuid;
begin
  foreach v_kind in array array['general_admission', 'vip', 'competitor', 'spectator', 'staff', 'vendor', 'table', 'pass', 'other'] loop
    v_i := v_i + 1;
    v_id := ('00000000-0000-0000-0000-00a2f00003' || lpad(v_i::text, 2, '0'))::uuid;
    insert into public.event_ticket_types (id, event_id, name, price, currency, capacity, active, attendees_per_ticket, ticket_kind)
    values (v_id, '00000000-0000-0000-0000-00a2f0000201', 'T ' || v_kind, 30, 'USD', null, true, 1, v_kind);
    insert into t_kv values ('tt:' || v_kind, v_id::text);
  end loop;
end $$;
insert into public.event_ticket_types (id, event_id, name, price, currency, capacity, active, attendees_per_ticket, ticket_kind, creates_prospect_lead) values
  ('00000000-0000-0000-0000-00a2f0000391', '00000000-0000-0000-0000-00a2f0000201', 'T ga_flagged', 30, 'USD', null, true, 1, 'general_admission', true);
insert into t_kv values ('tt:ga_flagged', '00000000-0000-0000-0000-00a2f0000391');
insert into public.event_ticket_types (id, event_id, name, price, currency, capacity, active, attendees_per_ticket, ticket_kind, creates_prospect_lead) values
  ('00000000-0000-0000-0000-00a2f0000390', '00000000-0000-0000-0000-00a2f0000202', 'Other GA', 30, 'USD', null, true, 1, 'general_admission', true);

create or replace function pg_temp.mk_order(p_key text, p_ticket uuid, p_expires interval default interval '30 minutes')
returns uuid
language plpgsql as $$
declare
  v_order uuid := gen_random_uuid();
  v_reg uuid := gen_random_uuid();
begin
  insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, currency,
                                   status, payment_status, expires_at, metadata)
  values (v_order, '00000000-0000-0000-0000-00a2f0000201', '00000000-0000-0000-0000-00a2f0000101', 'Pat Buyer',
          'g02-' || p_key || '@example.com', 30, 30, 'USD', 'pending', 'pending', now() + p_expires, '{"source":"event_cart_v1"}'::jsonb);
  insert into public.event_registrations (id, order_id, event_id, ticket_type_id, studio_id, status, payment_status, quantity,
                                          unit_price, total_price, currency, registration_source, attendee_first_name,
                                          attendee_last_name, attendee_email)
  values (v_reg, v_order, '00000000-0000-0000-0000-00a2f0000201', p_ticket, '00000000-0000-0000-0000-00a2f0000101', 'pending',
          'pending', 1, 30, 30, 'USD', 'public_event_page', 'Pat', 'Buyer', 'g02-' || p_key || '@example.com');
  insert into public.event_registration_attendees (registration_id, event_id, ticket_type_id, first_name, last_name, sort_order)
  values (v_reg, '00000000-0000-0000-0000-00a2f0000201', p_ticket, 'Guest', '1', 1);
  perform public.record_event_cart_payment_attempt(v_order, 'acct_g02studio', 'checkout_session', 'cs_test_' || p_key, null,
    3000::bigint, 'usd', 'web', null);
  insert into t_kv values ('order:' || p_key, v_order::text), ('reg:' || p_key, v_reg::text);
  return v_order;
end $$;

create or replace function pg_temp.settle(p_key text, p_cents bigint default 3000)
returns jsonb language sql as $$
  select pg_temp.try_jsonb(format('select public.settle_event_cart_order(%L, null, null, %L, %L, %L, %s, %L)',
    'reconcile', 'acct_g02studio', 'cs_test_' || p_key, 'pi_test_' || p_key, p_cents, 'usd'));
$$;

-- Drain the order's studio_lead outbox rows the way the TypeScript worker does; returns the capture outcomes.
create or replace function pg_temp.drain_leads(p_key text) returns jsonb
language plpgsql as $$
declare
  r record;
  v_out jsonb := '[]'::jsonb;
begin
  for r in select subject_id from public.event_settlement_outbox
           where order_id = pg_temp.kv('order:' || p_key)::uuid and effect = 'studio_lead' order by created_at loop
    v_out := v_out || jsonb_build_array(public.capture_event_registration_lead(r.subject_id));
  end loop;
  return v_out;
end $$;

-- Side effects must run in their OWN statement: inside one boolean expression Postgres may evaluate the other
-- conjuncts before the capture call. run_* stores the outcome(s); o() reads them.
create or replace function pg_temp.run_reg(p_label text, p_reg uuid) returns void
language plpgsql as $$
begin
  insert into t_kv values ('o:' || p_label, public.capture_event_registration_lead(p_reg)::text)
  on conflict (k) do update set v = excluded.v;
end $$;
create or replace function pg_temp.run_order(p_label text, p_key text) returns void
language plpgsql as $$
begin
  insert into t_kv values ('o:' || p_label, pg_temp.drain_leads(p_key)::text)
  on conflict (k) do update set v = excluded.v;
end $$;
create or replace function pg_temp.put(p_label text, p_v jsonb) returns void language sql as $$ insert into t_kv values ('o:' || p_label, p_v::text) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.o(p_label text) returns jsonb language sql as $$ select v::jsonb from t_kv where k = 'o:' || p_label $$;

create or replace function pg_temp.leads(p_studio uuid, p_email text) returns integer language sql as $$
  select count(*)::integer from public.clients where studio_id = p_studio and lower(email) = lower(p_email) $$;
create or replace function pg_temp.notices(p_reg text, p_prefix text) returns integer language sql as $$
  select count(*)::integer from public.notifications where dedupe_key = p_prefix || ':' || pg_temp.kv('reg:' || p_reg) $$;

-- ===============================================================================================================
-- Policy function
-- ===============================================================================================================
select pg_temp.chk('column: creates_prospect_lead exists, boolean, NOT NULL, default false; existing-style ticket types are OFF',
  (select data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false' from information_schema.columns
   where table_schema = 'public' and table_name = 'event_ticket_types' and column_name = 'creates_prospect_lead')
  and (select count(*) from public.event_ticket_types where id <> '00000000-0000-0000-0000-00a2f0000391' and id <> '00000000-0000-0000-0000-00a2f0000390' and creates_prospect_lead) = 0);
insert into public.event_ticket_types (id, event_id, name, price, currency, active, ticket_kind) values
  ('00000000-0000-0000-0000-00a2f0000392', '00000000-0000-0000-0000-00a2f0000201', 'dflt', 1, 'USD', true, 'general_admission');
select pg_temp.chk('a ticket type inserted without the setting is OFF (default A2)',
  (select creates_prospect_lead = false from public.event_ticket_types where id = '00000000-0000-0000-0000-00a2f0000392'));
update public.event_ticket_types set creates_prospect_lead = true where id = '00000000-0000-0000-0000-00a2f0000392';
select pg_temp.chk('CHECK: the flag can be set on general_admission',
  (select creates_prospect_lead from public.event_ticket_types where id = '00000000-0000-0000-0000-00a2f0000392'));
select pg_temp.chk('CHECK: every excluded kind (vip, competitor, spectator, staff, vendor, table, pass, other) can never be flagged',
  (select bool_and(pg_temp.try(format($q$update public.event_ticket_types set creates_prospect_lead = true where id = %L$q$, pg_temp.kv('tt:' || k))) like '%event_ticket_types_prospect_lead_kind_check%')
   from unnest(array['vip', 'competitor', 'spectator', 'staff', 'vendor', 'table', 'pass', 'other']) k));
select pg_temp.try($q$update public.event_ticket_types set ticket_kind = 'spectator' where id = '00000000-0000-0000-0000-00a2f0000392'$q$) as switch_msg \gset
select pg_temp.chk('CHECK: a flagged ticket cannot be switched to an excluded kind while flagged',
  :'switch_msg' like '%event_ticket_types_prospect_lead_kind_check%'
  and (select ticket_kind = 'general_admission' and creates_prospect_lead from public.event_ticket_types where id = '00000000-0000-0000-0000-00a2f0000392'));
update public.event_ticket_types set creates_prospect_lead = false, ticket_kind = 'spectator' where id = '00000000-0000-0000-0000-00a2f0000392';
select pg_temp.chk('CHECK: unflag and switch to an excluded kind in one statement is allowed',
  (select ticket_kind = 'spectator' and not creates_prospect_lead from public.event_ticket_types where id = '00000000-0000-0000-0000-00a2f0000392'));

-- ===============================================================================================================
-- Each real ticket kind, through settlement -> outbox -> capture
-- ===============================================================================================================
do $$
declare
  v_kind text;
  v_settled jsonb;
  v_outcomes jsonb;
  v_email text;
  v_eligible boolean;
begin
  foreach v_kind in array array['general_admission', 'ga_flagged', 'vip', 'competitor', 'spectator', 'staff', 'vendor', 'table', 'pass', 'other'] loop
    perform pg_temp.mk_order('k_' || v_kind, pg_temp.kv('tt:' || v_kind)::uuid);
    v_settled := pg_temp.settle('k_' || v_kind);
    v_outcomes := pg_temp.drain_leads('k_' || v_kind);
    v_email := 'g02-k_' || v_kind || '@example.com';
    v_eligible := v_kind = 'ga_flagged';

    perform pg_temp.chk('kind ' || v_kind || ': settlement committed and queued exactly one studio_lead effect',
      (v_settled ->> 'outcome') = 'settled'
      and (select count(*) from public.event_settlement_outbox where order_id = pg_temp.kv('order:k_' || v_kind)::uuid and effect = 'studio_lead') = 1,
      v_settled::text);

    if v_eligible then
      perform pg_temp.chk('kind ' || v_kind || ': creates exactly one lead, links the registration, notifies as a new lead',
        (v_outcomes -> 0 ->> 'outcome') = 'captured'
        and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', v_email) = 1
        and (select status from public.clients where studio_id = '00000000-0000-0000-0000-00a2f0000101' and lower(email) = v_email) = 'lead'
        and (select client_id is not null from public.event_registrations where id = pg_temp.kv('reg:k_' || v_kind)::uuid)
        and pg_temp.notices('k_' || v_kind, 'event_registration_lead') = 1
        and pg_temp.notices('k_' || v_kind, 'event_registration_notice') = 0,
        v_outcomes::text);
    else
      perform pg_temp.chk('kind ' || v_kind || ': NO lead, registration not linked, studio still notified with a clear label',
        (v_outcomes -> 0 ->> 'outcome') = 'skipped'
        and (v_outcomes -> 0 ->> 'reason') = 'ticket_not_flagged_for_leads'
        and (v_outcomes -> 0 ->> 'notified')::boolean
        and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', v_email) = 0
        and (select client_id is null from public.event_registrations where id = pg_temp.kv('reg:k_' || v_kind)::uuid)
        and pg_temp.notices('k_' || v_kind, 'event_registration_lead') = 0
        and pg_temp.notices('k_' || v_kind, 'event_registration_notice') = 1
        and (select title like '%not added as a lead%' and studio_id = '00000000-0000-0000-0000-00a2f0000101' and type = 'event_registration'
             from public.notifications where dedupe_key = 'event_registration_notice:' || pg_temp.kv('reg:k_' || v_kind)),
        v_outcomes::text);
    end if;
  end loop;
end $$;

-- ===============================================================================================================
-- Replay / duplicate settlement / duplicate capture
-- ===============================================================================================================
-- Settlement replay: the same Stripe settlement delivered again returns the settled order, never a second outbox effect.
select pg_temp.chk('replay: settling again does not queue a second studio_lead effect',
  (pg_temp.settle('k_ga_flagged') ->> 'outcome') in ('already_settled', 'settled')
  and (select count(*) from public.event_settlement_outbox where order_id = pg_temp.kv('order:k_ga_flagged')::uuid and effect = 'studio_lead') = 1);
select pg_temp.run_order('r_ga', 'k_ga_flagged');
select pg_temp.chk('replay: draining/capturing again is idempotent for a lead (one client, one notification)',
  (pg_temp.o('r_ga') -> 0 ->> 'outcome') = 'captured'
  and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-k_ga_flagged@example.com') = 1
  and pg_temp.notices('k_ga_flagged', 'event_registration_lead') = 1);
select pg_temp.run_order('r_sp1', 'k_spectator');
select pg_temp.run_order('r_sp2', 'k_spectator');
select pg_temp.chk('replay: draining/capturing again is idempotent for a non-lead (still one notice, still no client)',
  (pg_temp.o('r_sp1') -> 0 ->> 'outcome') = 'skipped'
  and (pg_temp.o('r_sp2') -> 0 ->> 'outcome') = 'skipped'
  and pg_temp.notices('k_spectator', 'event_registration_notice') = 1
  and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-k_spectator@example.com') = 0);

-- ===============================================================================================================
-- Failed, pending, expired / abandoned settlement: no successful-purchase behavior
-- ===============================================================================================================
select pg_temp.mk_order('f1', pg_temp.kv('tt:ga_flagged')::uuid);
select pg_temp.put('f1s', pg_temp.settle('f1', 100));
select pg_temp.run_reg('f1c', pg_temp.kv('reg:f1')::uuid);
select pg_temp.chk('failed: an amount-mismatched settlement is not settled, queues nothing and creates no lead',
  (pg_temp.o('f1s') ->> 'outcome') is distinct from 'settled'
  and not exists (select 1 from public.event_settlement_outbox where order_id = pg_temp.kv('order:f1')::uuid and effect = 'studio_lead')
  and (pg_temp.o('f1c') ->> 'reason') = 'registration_not_paid'
  and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-f1@example.com') = 0
  and pg_temp.notices('f1', 'event_registration_lead') = 0 and pg_temp.notices('f1', 'event_registration_notice') = 0);

select pg_temp.mk_order('p1', pg_temp.kv('tt:spectator')::uuid);
select pg_temp.mk_order('p2', pg_temp.kv('tt:ga_flagged')::uuid);
select pg_temp.run_reg('p1c', pg_temp.kv('reg:p1')::uuid);
select pg_temp.run_reg('p2c', pg_temp.kv('reg:p2')::uuid);
select pg_temp.chk('pending: an unpaid registration produces neither a lead nor a notice (any kind)',
  (pg_temp.o('p1c') ->> 'reason') = 'registration_not_paid'
  and (pg_temp.o('p2c') ->> 'reason') = 'registration_not_paid'
  and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-p2@example.com') = 0
  and pg_temp.notices('p1', 'event_registration_notice') = 0 and pg_temp.notices('p2', 'event_registration_lead') = 0);

select pg_temp.mk_order('x1', pg_temp.kv('tt:ga_flagged')::uuid);
select public._paywh1_release_order(pg_temp.kv('order:x1')::uuid, 'released');
select pg_temp.run_reg('x1c', pg_temp.kv('reg:x1')::uuid);
select pg_temp.chk('expired/abandoned: a released order produces no lead and no notice',
  (pg_temp.o('x1c') ->> 'reason') = 'registration_not_paid'
  and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-x1@example.com') = 0
  and pg_temp.notices('x1', 'event_registration_lead') = 0 and pg_temp.notices('x1', 'event_registration_notice') = 0);

-- ===============================================================================================================
-- Existing clients and leads: never modified by a non-qualifying purchase; the qualifying path keeps its behavior
-- ===============================================================================================================
insert into public.clients (id, studio_id, first_name, last_name, email, status, referral_source, source_system) values
  ('00000000-0000-0000-0000-00a2f0000c01', '00000000-0000-0000-0000-00a2f0000101', 'Ex', 'Client', 'g02-ec_spectator@example.com', 'active', null, null),
  ('00000000-0000-0000-0000-00a2f0000c02', '00000000-0000-0000-0000-00a2f0000101', 'Ex', 'Lead', 'g02-ec_ga@example.com', 'lead', null, null),
  ('00000000-0000-0000-0000-00a2f0000c03', '00000000-0000-0000-0000-00a2f0000102', 'Other', 'Studio', 'g02-ec_ga@example.com', 'lead', null, null),
  ('00000000-0000-0000-0000-00a2f0000c04', '00000000-0000-0000-0000-00a2f0000102', 'Other', 'Studio', 'g02-ec_spectator@example.com', 'lead', null, null);
insert into t_kv select 'snap:' || id::text, to_jsonb(c)::text from public.clients c where id in
  ('00000000-0000-0000-0000-00a2f0000c01', '00000000-0000-0000-0000-00a2f0000c02', '00000000-0000-0000-0000-00a2f0000c03', '00000000-0000-0000-0000-00a2f0000c04');
create or replace function pg_temp.unchanged(p_id uuid) returns boolean language sql as $$
  select (select to_jsonb(c)::text from public.clients c where c.id = p_id) = pg_temp.kv('snap:' || p_id::text) $$;

-- Existing client buys a spectator ticket (same studio): untouched, not linked to the registration, studio notified.
select pg_temp.mk_order('ec_spectator', pg_temp.kv('tt:spectator')::uuid);
select pg_temp.settle('ec_spectator');
select pg_temp.run_order('ecs', 'ec_spectator');
select pg_temp.chk('existing client + spectator: client row byte-identical, no new client, registration not linked, notice written',
  (pg_temp.o('ecs') -> 0 ->> 'reason') = 'ticket_not_flagged_for_leads'
  and pg_temp.unchanged('00000000-0000-0000-0000-00a2f0000c01')
  and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-ec_spectator@example.com') = 1
  and (select client_id is null from public.event_registrations where id = pg_temp.kv('reg:ec_spectator')::uuid)
  and pg_temp.notices('ec_spectator', 'event_registration_notice') = 1);

-- Existing lead buys general admission: the previous (preserved) behavior -- reuse the client, fill empty source fields only.
select pg_temp.mk_order('ec_ga', pg_temp.kv('tt:ga_flagged')::uuid);
select pg_temp.settle('ec_ga');
select pg_temp.run_order('ecg', 'ec_ga');
select pg_temp.chk('existing lead + general admission: reused (no duplicate), linked, source filled only where empty',
  (pg_temp.o('ecg') -> 0 ->> 'outcome') = 'captured'
  and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-ec_ga@example.com') = 1
  and (select client_id from public.event_registrations where id = pg_temp.kv('reg:ec_ga')::uuid) = '00000000-0000-0000-0000-00a2f0000c02'
  and (select status || '/' || referral_source from public.clients where id = '00000000-0000-0000-0000-00a2f0000c02') = 'lead/Event Registration');

-- A registration that already carries a client (e.g. linked by staff): a non-qualifying kind keeps that link untouched and the notice references it.
select pg_temp.mk_order('pre_client', pg_temp.kv('tt:vendor')::uuid);
update public.event_registrations set client_id = '00000000-0000-0000-0000-00a2f0000c01' where id = pg_temp.kv('reg:pre_client')::uuid;
select pg_temp.settle('pre_client');
select pg_temp.run_order('prc', 'pre_client');
select pg_temp.chk('registration already linked to a client + vendor: link kept, client unchanged, notice carries the client',
  (pg_temp.o('prc') -> 0 ->> 'outcome') = 'skipped'
  and pg_temp.unchanged('00000000-0000-0000-0000-00a2f0000c01')
  and (select client_id from public.notifications where dedupe_key = 'event_registration_notice:' || pg_temp.kv('reg:pre_client')) = '00000000-0000-0000-0000-00a2f0000c01');

-- ===============================================================================================================
-- Tenant isolation
-- ===============================================================================================================
select pg_temp.chk('tenant: other-studio same-email clients are never touched or created, and it receives no notifications',
  pg_temp.unchanged('00000000-0000-0000-0000-00a2f0000c03')
  and pg_temp.unchanged('00000000-0000-0000-0000-00a2f0000c04')
  and pg_temp.leads('00000000-0000-0000-0000-00a2f0000102', 'g02-ec_ga@example.com') = 1
  and pg_temp.leads('00000000-0000-0000-0000-00a2f0000102', 'g02-ec_spectator@example.com') = 1
  and not exists (select 1 from public.notifications where studio_id = '00000000-0000-0000-0000-00a2f0000102' and dedupe_key like 'event_registration_%'));

-- A registration that points at another event's (other studio's) general-admission ticket type cannot be classified as a lead.
insert into public.event_registrations (id, event_id, ticket_type_id, studio_id, status, payment_status, quantity, unit_price, total_price,
                                        currency, registration_source, attendee_first_name, attendee_last_name, attendee_email)
values ('00000000-0000-0000-0000-00a2f0000f01', '00000000-0000-0000-0000-00a2f0000201', '00000000-0000-0000-0000-00a2f0000390',
        '00000000-0000-0000-0000-00a2f0000101', 'confirmed', 'paid', 1, 30, 30, 'USD', 'public_event_page', 'Foreign', 'Ticket', 'g02-foreign@example.com');
select pg_temp.run_reg('f01c', '00000000-0000-0000-0000-00a2f0000f01');
select pg_temp.chk('tenant: a foreign (cross-event) ticket type grants no lead classification',
  (pg_temp.o('f01c') ->> 'reason') = 'ticket_not_flagged_for_leads'
  and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-foreign@example.com') = 0);

-- Orderless paid registration (box office / legacy) with no ticket type: cannot be classified, so no lead (fail closed), notice kept.
insert into public.event_registrations (id, event_id, studio_id, status, payment_status, quantity, unit_price, total_price,
                                        currency, registration_source, attendee_first_name, attendee_last_name, attendee_email)
values ('00000000-0000-0000-0000-00a2f0000f02', '00000000-0000-0000-0000-00a2f0000201', '00000000-0000-0000-0000-00a2f0000101',
        'confirmed', 'paid', 1, 30, 30, 'USD', 'public_event_page', 'No', 'Ticket', 'g02-noticket@example.com');
select pg_temp.run_reg('f02c', '00000000-0000-0000-0000-00a2f0000f02');
select pg_temp.chk('no ticket type: fail closed (no lead), studio notified',
  (pg_temp.o('f02c') ->> 'reason') = 'ticket_not_flagged_for_leads'
  and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-noticket@example.com') = 0
  and exists (select 1 from public.notifications where dedupe_key = 'event_registration_notice:00000000-0000-0000-0000-00a2f0000f02'));

-- Free sign-up (orderless, price 0, paid): follows the flag like any other ticket (A4 conservative default).
insert into public.event_registrations (id, event_id, ticket_type_id, studio_id, status, payment_status, quantity, unit_price, total_price,
                                        currency, registration_source, attendee_first_name, attendee_last_name, attendee_email) values
  ('00000000-0000-0000-0000-00a2f0000f03', '00000000-0000-0000-0000-00a2f0000201', '00000000-0000-0000-0000-00a2f0000391',
   '00000000-0000-0000-0000-00a2f0000101', 'confirmed', 'paid', 1, 0, 0, 'USD', 'public_event_page', 'Free', 'Flagged', 'g02-free-flagged@example.com'),
  ('00000000-0000-0000-0000-00a2f0000f04', '00000000-0000-0000-0000-00a2f0000201', pg_temp.kv('tt:general_admission')::uuid,
   '00000000-0000-0000-0000-00a2f0000101', 'confirmed', 'paid', 1, 0, 0, 'USD', 'public_event_page', 'Free', 'Unflagged', 'g02-free-unflagged@example.com');
select pg_temp.run_reg('f03', '00000000-0000-0000-0000-00a2f0000f03');
select pg_temp.run_reg('f04', '00000000-0000-0000-0000-00a2f0000f04');
select pg_temp.chk('free sign-up: flagged ticket creates a lead; unflagged ticket does not (notice only)',
  (pg_temp.o('f03') ->> 'outcome') = 'captured' and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-free-flagged@example.com') = 1
  and (pg_temp.o('f04') ->> 'reason') = 'ticket_not_flagged_for_leads' and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-free-unflagged@example.com') = 0
  and exists (select 1 from public.notifications where dedupe_key = 'event_registration_notice:00000000-0000-0000-0000-00a2f0000f04'));

-- Refund before capture: a refunded registration is not paid, so no lead and no notice. A refund AFTER a lead exists never deletes it.
insert into public.event_registrations (id, event_id, ticket_type_id, studio_id, status, payment_status, quantity, unit_price, total_price,
                                        currency, registration_source, attendee_first_name, attendee_last_name, attendee_email) values
  ('00000000-0000-0000-0000-00a2f0000f05', '00000000-0000-0000-0000-00a2f0000201', '00000000-0000-0000-0000-00a2f0000391',
   '00000000-0000-0000-0000-00a2f0000101', 'cancelled', 'refunded', 1, 30, 30, 'USD', 'public_event_page', 'Re', 'Funded', 'g02-refunded@example.com');
select pg_temp.run_reg('f05', '00000000-0000-0000-0000-00a2f0000f05');
select pg_temp.chk('refund: a refunded registration creates no lead and no notice',
  (pg_temp.o('f05') ->> 'reason') = 'registration_not_paid' and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-refunded@example.com') = 0
  and not exists (select 1 from public.notifications where dedupe_key like '%00000000-0000-0000-0000-00a2f0000f05'));
update public.event_registrations set payment_status = 'refunded', status = 'cancelled' where id = pg_temp.kv('reg:k_ga_flagged')::uuid;
select pg_temp.chk('refund after capture: the existing lead and its notification are left untouched',
  pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-k_ga_flagged@example.com') = 1 and pg_temp.notices('k_ga_flagged', 'event_registration_lead') = 1);

-- Un-flagging a ticket never touches existing leads (no cleanup, decided at settlement time only).
update public.event_ticket_types set creates_prospect_lead = false where id = '00000000-0000-0000-0000-00a2f0000391';
select pg_temp.chk('turning the setting off later leaves every existing lead as it is',
  pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-k_ga_flagged@example.com') = 1 and pg_temp.leads('00000000-0000-0000-0000-00a2f0000101', 'g02-free-flagged@example.com') = 1);

-- Missing registration is unchanged behavior.
select pg_temp.run_reg('unk', gen_random_uuid());
select pg_temp.chk('unknown registration id is skipped, not an error',
  (pg_temp.o('unk') ->> 'reason') = 'registration_not_found');

-- ===============================================================================================================
-- Privileges: unchanged contract (service role only)
-- ===============================================================================================================
select pg_temp.chk('privilege: lead capture is service_role only',
  has_function_privilege('service_role', 'public.capture_event_registration_lead(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.capture_event_registration_lead(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.capture_event_registration_lead(uuid)', 'execute'));

-- ===============================================================================================================
-- Verdict (always raises: nothing persists)
-- ===============================================================================================================
do $$
declare
  v_total integer;
  v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok)
  into v_total, v_failures
  from t_results;
  if v_failures is null then
    raise exception 'G-02 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'G-02 SQL SUITE FAIL: %', v_failures;
end $$;

rollback;

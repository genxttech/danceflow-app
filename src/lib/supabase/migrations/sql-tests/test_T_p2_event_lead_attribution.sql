-- P2 -- event ticket checkout preserves existing lead attribution (migration 20270226090000).
--
-- Calls capture_event_registration_lead directly on paid registrations (no payment settlement). Needs the PAY-WH-1 chain,
-- 20270219100000 and 20270226090000. One transaction, synthetic fixtures only (UUID block 00000000-0000-0000-0000-00a5f0XXXXXX).
-- The final block ALWAYS raises, so nothing persists: "P2 SQL SUITE PASS (<n> checks)" or "P2 SQL SUITE FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
create temp table t_snap (id uuid primary key, row_json jsonb) on commit drop;
create temp table t_out (k text primary key, v jsonb) on commit drop;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-00a5f0000101', 'P2 Studio', 'p2-sql-studio'),
  ('00000000-0000-0000-0000-00a5f0000102', 'P2 Other', 'p2-sql-other');
insert into public.events (id, studio_id, name, slug, event_type, status, visibility, start_date, end_date, timezone) values
  ('00000000-0000-0000-0000-00a5f0000201', '00000000-0000-0000-0000-00a5f0000101', 'P2 Event', 'p2-sql-event', 'special_event', 'published', 'public', '2027-06-05', '2027-06-05', 'America/Chicago');
insert into public.event_ticket_types (id, event_id, name, price, currency, capacity, active, attendees_per_ticket, ticket_kind, creates_prospect_lead) values
  ('00000000-0000-0000-0000-00a5f0000391', '00000000-0000-0000-0000-00a5f0000201', 'GA', 30, 'USD', null, true, 1, 'general_admission', true);

insert into public.clients (id, studio_id, first_name, last_name, email, status, referral_source, source_system) values
  ('00000000-0000-0000-0000-00a5f0000c01', '00000000-0000-0000-0000-00a5f0000101', 'Blank', 'Lead', 'p2-blank@example.test', 'lead', null, null),
  ('00000000-0000-0000-0000-00a5f0000c02', '00000000-0000-0000-0000-00a5f0000101', 'Web', 'Lead', 'p2-web@example.test', 'lead', 'Website', null),
  ('00000000-0000-0000-0000-00a5f0000c03', '00000000-0000-0000-0000-00a5f0000101', 'Old', 'Student', 'p2-old@example.test', 'active', null, 'import'),
  ('00000000-0000-0000-0000-00a5f0000c04', '00000000-0000-0000-0000-00a5f0000102', 'Other', 'Studio', 'p2-new@example.test', 'lead', null, null);
insert into t_snap select id, to_jsonb(c) from public.clients c where c.id::text like '00000000-0000-0000-0000-00a5f0000c%';

create or replace function pg_temp.buy(p_key text, p_reg uuid, p_email text) returns void language plpgsql as $$
begin
  insert into public.event_registrations (id, event_id, ticket_type_id, studio_id, status, payment_status, quantity, unit_price, total_price, currency,
                                          registration_source, attendee_first_name, attendee_last_name, attendee_email)
  values (p_reg, '00000000-0000-0000-0000-00a5f0000201', '00000000-0000-0000-0000-00a5f0000391', '00000000-0000-0000-0000-00a5f0000101',
          'confirmed', 'paid', 1, 30, 30, 'USD', 'public_event_page', 'P2', 'Buyer', p_email);
  insert into t_out values (p_key, public.capture_event_registration_lead(p_reg));
end $$;
create or replace function pg_temp.linked(p_reg uuid) returns uuid language sql as $$
  select client_id from public.event_registrations where id = p_reg $$;
create or replace function pg_temp.unchanged(p_id uuid) returns boolean language sql as $$
  select (select to_jsonb(c) from public.clients c where c.id = p_id) = (select row_json from t_snap where id = p_id) $$;

select pg_temp.buy('blank', '00000000-0000-0000-0000-00a5f0000f01', 'p2-blank@example.test');
select pg_temp.buy('web', '00000000-0000-0000-0000-00a5f0000f02', 'P2-Web@Example.test');
select pg_temp.buy('old', '00000000-0000-0000-0000-00a5f0000f03', 'p2-old@example.test');
select pg_temp.buy('new', '00000000-0000-0000-0000-00a5f0000f04', 'p2-new@example.test');
select pg_temp.buy('newagain', '00000000-0000-0000-0000-00a5f0000f05', 'p2-new@example.test');

select pg_temp.chk('existing lead with blank attribution: captured, linked, row byte-identical',
  (select v ->> 'outcome' = 'captured' from t_out where k = 'blank')
  and pg_temp.linked('00000000-0000-0000-0000-00a5f0000f01') = '00000000-0000-0000-0000-00a5f0000c01'
  and pg_temp.unchanged('00000000-0000-0000-0000-00a5f0000c01'), (select v::text from t_out where k = 'blank'));
select pg_temp.chk('existing website lead (email case differs): linked, row byte-identical',
  pg_temp.linked('00000000-0000-0000-0000-00a5f0000f02') = '00000000-0000-0000-0000-00a5f0000c02'
  and pg_temp.unchanged('00000000-0000-0000-0000-00a5f0000c02'));
select pg_temp.chk('existing imported student: linked, row byte-identical',
  pg_temp.linked('00000000-0000-0000-0000-00a5f0000f03') = '00000000-0000-0000-0000-00a5f0000c03'
  and pg_temp.unchanged('00000000-0000-0000-0000-00a5f0000c03'));
select pg_temp.chk('new buyer: one lead created in this studio with the event origin, reused by the second purchase',
  (select count(*) = 1 and min(status::text) = 'lead' and min(referral_source) = 'Event Registration' and min(source_system) = 'event_registration'
   from public.clients where studio_id = '00000000-0000-0000-0000-00a5f0000101' and lower(email) = 'p2-new@example.test')
  and pg_temp.linked('00000000-0000-0000-0000-00a5f0000f04') = pg_temp.linked('00000000-0000-0000-0000-00a5f0000f05')
  and pg_temp.linked('00000000-0000-0000-0000-00a5f0000f04') is not null);
select pg_temp.chk('tenant: the other studio''s same-email client is untouched', pg_temp.unchanged('00000000-0000-0000-0000-00a5f0000c04'));
select pg_temp.chk('only service_role may execute the capture function',
  has_function_privilege('service_role', 'public.capture_event_registration_lead(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.capture_event_registration_lead(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.capture_event_registration_lead(uuid)', 'execute'));

do $$
declare
  v_total integer;
  v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok)
  into v_total, v_failures
  from t_results;
  if v_failures is null then
    raise exception 'P2 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'P2 SQL SUITE FAIL: %', v_failures;
end $$;

rollback;

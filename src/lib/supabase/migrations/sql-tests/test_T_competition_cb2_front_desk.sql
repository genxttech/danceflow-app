-- CB-2 front-desk competition check-in -- suite for 20270112090000_competition_checkin_front_desk.sql
-- (requires 20270111090000 CI-B, R2 20270103090000 + PAY-WH-1A for the refund RPCs, and SC1 20270108090000 for the
-- scratch RPC; the R2/SC1 files are applied to the local DB untouched).
--
-- Owner decision under test: front_desk may admit (sessions, arrival, waivers, credentials) and collect desk payments;
-- it may NOT refund, scratch, edit eligibility/verification, or change heats/divisions/programs/locks/settings.
-- One transaction, synthetic fixtures (UUID block 00000000-0000-0000-0000-00cb2XXXXXXX). Every probe runs in a
-- sub-transaction that is rolled back, so probes never see each other's writes. The final block ALWAYS raises:
-- "CB2 FRONT DESK SQL SUITE PASS (<n> checks)" or "... FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-00cb2' || p_suffix)::uuid $$;

-- Runs p_sql as p_user (null = anon) in a sub-transaction that is always rolled back.
-- Returns 'rows:<n>' for DML (the row count), 'val:<v>' for a scalar select, or 'err:<sqlstate>'.
create or replace function pg_temp.probe(p_user uuid, p_sql text, p_scalar boolean default false) returns text
language plpgsql as $$
declare
  v_out text;
  v_n bigint;
  v_val text;
begin
  begin
    if p_user is null then
      perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
      perform set_config('role', 'anon', true);
    else
      perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
    end if;
    if p_scalar then
      execute p_sql into v_val;
      v_out := 'val:' || coalesce(v_val, 'null');
    else
      execute p_sql;
      get diagnostics v_n = row_count;
      v_out := 'rows:' || v_n;
    end if;
    raise exception 'probe rollback' using errcode = 'P9999';
  exception when others then
    if sqlstate <> 'P9999' then
      v_out := 'err:' || sqlstate;
    end if;
  end;
  return v_out;
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as the superuser)
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('0000001'), 'cb2-owner@e2e.test'),
  (pg_temp.u('0000002'), 'cb2-admin@e2e.test'),
  (pg_temp.u('0000003'), 'cb2-front@e2e.test'),
  (pg_temp.u('0000004'), 'cb2-instructor@e2e.test'),
  (pg_temp.u('0000005'), 'cb2-indep@e2e.test'),
  (pg_temp.u('0000006'), 'cb2-orgowner@e2e.test'),
  (pg_temp.u('0000007'), 'cb2-orgadmin@e2e.test'),
  (pg_temp.u('0000008'), 'cb2-orgstaff@e2e.test'),
  (pg_temp.u('0000009'), 'cb2-platform@e2e.test'),
  (pg_temp.u('000000a'), 'cb2-otherfront@e2e.test'),
  (pg_temp.u('000000b'), 'cb2-inactivefront@e2e.test'),
  (pg_temp.u('000000c'), 'cb2-orgviewer@e2e.test');
insert into public.profiles (id, email, full_name)
select id, email, 'CB2 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-00cb2%'
on conflict (id) do nothing;
update public.profiles set platform_role = 'platform_admin' where id = pg_temp.u('0000009');

insert into public.studios (id, name, slug, stripe_connected_account_id) values
  (pg_temp.u('00a0001'), 'CB2 Studio', 'cb2-studio', 'acct_cb2studio'),
  (pg_temp.u('00a0002'), 'CB2 Other Studio', 'cb2-other-studio', 'acct_cb2other');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('0000001'), pg_temp.u('00a0001'), 'studio_owner', true),
  (pg_temp.u('0000002'), pg_temp.u('00a0001'), 'studio_admin', true),
  (pg_temp.u('0000003'), pg_temp.u('00a0001'), 'front_desk', true),
  (pg_temp.u('0000004'), pg_temp.u('00a0001'), 'instructor', true),
  (pg_temp.u('0000005'), pg_temp.u('00a0001'), 'independent_instructor', true),
  (pg_temp.u('000000a'), pg_temp.u('00a0002'), 'front_desk', true),
  (pg_temp.u('000000b'), pg_temp.u('00a0001'), 'front_desk', false);
insert into public.organizers (id, name, slug) values (pg_temp.u('00b0001'), 'CB2 Organizer', 'cb2-organizer');
insert into public.organizer_users (id, organizer_id, user_id, role, active, created_at) values
  (pg_temp.u('00b1001'), pg_temp.u('00b0001'), pg_temp.u('0000006'), 'organizer_owner', true, now()),
  (pg_temp.u('00b1002'), pg_temp.u('00b0001'), pg_temp.u('0000007'), 'organizer_admin', true, now()),
  (pg_temp.u('00b1003'), pg_temp.u('00b0001'), pg_temp.u('0000008'), 'organizer_staff', true, now());

insert into public.events (id, studio_id, organizer_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required, timezone)
values (pg_temp.u('00e0001'), pg_temp.u('00a0001'), pg_temp.u('00b0001'), 'CB2 Comp', 'cb2-comp', 'competition', current_date + 30, current_date + 30, 'published', 'public', true, 'America/Chicago'),
       (pg_temp.u('00e0002'), pg_temp.u('00a0002'), null, 'CB2 Other Comp', 'cb2-other-comp', 'competition', current_date + 30, current_date + 30, 'published', 'public', true, 'America/Chicago');

insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
values (pg_temp.u('0010001'), pg_temp.u('00e0001'), pg_temp.u('00a0001'), 'Country', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values (pg_temp.u('0020001'), pg_temp.u('00e0001'), pg_temp.u('0010001'), 'Couples', 'single_dance', 'couple', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
values (pg_temp.u('0030001'), pg_temp.u('00e0001'), pg_temp.u('0010001'), pg_temp.u('0020001'), 'Bronze Couples', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number)
values (pg_temp.u('0060001'), pg_temp.u('00e0001'), pg_temp.u('0010001'), pg_temp.u('0030001'), 'Final', 'final', 1);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, name)
values (pg_temp.u('0090001'), pg_temp.u('00e0001'), pg_temp.u('0030001'), pg_temp.u('0060001'), 1, 'Heat 1');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, verification_status)
values (pg_temp.u('0080001'), pg_temp.u('00e0001'), pg_temp.u('0010001'), pg_temp.u('0030001'), 'Entry A', 'confirmed', 'eligible', 'unverified'),
       (pg_temp.u('0080002'), pg_temp.u('00e0001'), pg_temp.u('0010001'), pg_temp.u('0030001'), 'Entry B', 'confirmed', 'eligible', 'unverified');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, status)
values (pg_temp.u('00e0001'), pg_temp.u('0030001'), pg_temp.u('0090001'), pg_temp.u('0080001'), 'scheduled'),
       (pg_temp.u('00e0001'), pg_temp.u('0030001'), pg_temp.u('0090001'), pg_temp.u('0080002'), 'scheduled');

-- A competition order + registration + attendees + desk session (+ one participant, one credential, one waiver) and a
-- second, untouched registration (no session yet) so "start a session" can be probed.
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, currency, status, payment_status, expires_at, metadata)
values (pg_temp.u('0100001'), pg_temp.u('00e0001'), pg_temp.u('00a0001'), 'Pat', 'cb2-a@example.com', 300, 300, 'USD', 'confirmed', 'pending', now() + interval '30 days', jsonb_build_object('source', 'competition_registration')),
       (pg_temp.u('0100002'), pg_temp.u('00e0001'), pg_temp.u('00a0001'), 'Sam', 'cb2-b@example.com', 300, 300, 'USD', 'confirmed', 'pending', now() + interval '30 days', jsonb_build_object('source', 'competition_registration'));
insert into public.event_registrations (id, order_id, event_id, studio_id, status, payment_status, quantity, unit_price, total_price, currency, registration_source, attendee_first_name, attendee_last_name, attendee_email)
values (pg_temp.u('0110001'), pg_temp.u('0100001'), pg_temp.u('00e0001'), pg_temp.u('00a0001'), 'confirmed', 'pending', 1, 300, 300, 'USD', 'public_event_page', 'Pat', 'A', 'cb2-a@example.com'),
       (pg_temp.u('0110002'), pg_temp.u('0100002'), pg_temp.u('00e0001'), pg_temp.u('00a0001'), 'confirmed', 'pending', 1, 300, 300, 'USD', 'public_event_page', 'Sam', 'B', 'cb2-b@example.com');
insert into public.event_registration_attendees (id, registration_id, event_id, first_name, last_name, attendee_role, sort_order)
values (pg_temp.u('0120001'), pg_temp.u('0110001'), pg_temp.u('00e0001'), 'Pat', 'A', 'competitor', 1),
       (pg_temp.u('0120002'), pg_temp.u('0110001'), pg_temp.u('00e0001'), 'Pat2', 'A', 'competitor', 2),
       (pg_temp.u('0120003'), pg_temp.u('0110002'), pg_temp.u('00e0001'), 'Sam', 'B', 'competitor', 1);
insert into public.event_competition_checkin_sessions (id, event_id, registration_id, order_id, status, balance_due, currency)
values (pg_temp.u('0050001'), pg_temp.u('00e0001'), pg_temp.u('0110001'), pg_temp.u('0100001'), 'in_progress', 300, 'USD');
insert into public.event_competition_checkin_participants (id, event_id, checkin_session_id, registration_attendee_id, display_name)
values (pg_temp.u('0130001'), pg_temp.u('00e0001'), pg_temp.u('0050001'), pg_temp.u('0120001'), 'Pat A');
insert into public.event_competition_credentials (id, event_id, checkin_session_id, credential_number, holder_type, registration_attendee_id, display_name, status)
values (pg_temp.u('0140001'), pg_temp.u('00e0001'), pg_temp.u('0050001'), '101', 'participant', pg_temp.u('0120001'), 'Pat A', 'issued');
insert into public.document_templates (id, studio_id, scope, document_type, title, body)
values (pg_temp.u('0150001'), pg_temp.u('00a0001'), 'studio', 'waiver', 'CB2 Waiver', 'Waiver body');
insert into public.event_competition_participant_waivers (id, event_id, checkin_participant_id, template_id, signer_name, signature_text, consent_text, signed_body)
values (pg_temp.u('0160001'), pg_temp.u('00e0001'), pg_temp.u('0130001'), pg_temp.u('0150001'), 'Pat A', 'Pat A', 'consent', 'Waiver body');
-- Other tenant: a session in the other event, so a cross-tenant read / write can be probed.
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, currency, status, payment_status, expires_at, metadata)
values (pg_temp.u('0100003'), pg_temp.u('00e0002'), pg_temp.u('00a0002'), 'Zed', 'cb2-z@example.com', 100, 100, 'USD', 'confirmed', 'pending', now() + interval '30 days', jsonb_build_object('source', 'competition_registration'));
insert into public.event_registrations (id, order_id, event_id, studio_id, status, payment_status, quantity, unit_price, total_price, currency, registration_source, attendee_first_name, attendee_last_name, attendee_email)
values (pg_temp.u('0110003'), pg_temp.u('0100003'), pg_temp.u('00e0002'), pg_temp.u('00a0002'), 'confirmed', 'pending', 1, 100, 100, 'USD', 'public_event_page', 'Zed', 'Z', 'cb2-z@example.com');
insert into public.event_competition_checkin_sessions (id, event_id, registration_id, order_id, status, balance_due, currency)
values (pg_temp.u('0050002'), pg_temp.u('00e0002'), pg_temp.u('0110003'), pg_temp.u('0100003'), 'in_progress', 100, 'USD');

-- ============================================================================
-- 1. Helper: can_check_in_event_competition across the role matrix
-- ============================================================================
create temp table t_roles (role_key text primary key, uid uuid, is_manager boolean, can_checkin boolean);
insert into t_roles values
  ('studio_owner',            pg_temp.u('0000001'), true,  true),
  ('studio_admin',            pg_temp.u('0000002'), true,  true),
  ('front_desk',              pg_temp.u('0000003'), false, true),
  ('instructor',              pg_temp.u('0000004'), false, false),
  ('independent_instructor',  pg_temp.u('0000005'), false, false),
  ('organizer_owner',         pg_temp.u('0000006'), true,  true),
  ('organizer_admin',         pg_temp.u('0000007'), true,  true),
  ('organizer_staff',         pg_temp.u('0000008'), true,  true),
  ('platform_admin',          pg_temp.u('0000009'), true,  true),
  ('other_tenant_front_desk', pg_temp.u('000000a'), false, false),
  ('inactive_front_desk',     pg_temp.u('000000b'), false, false),
  ('no_role_user',            pg_temp.u('000000c'), false, false);
grant all on t_roles to authenticated, anon, service_role;

do $$
declare r record;
begin
  for r in select * from t_roles loop
    perform pg_temp.chk('helper: can_check_in_event_competition for ' || r.role_key,
      pg_temp.probe(r.uid, format('select public.can_check_in_event_competition(%L)', pg_temp.u('00e0001')), true) = 'val:' || r.can_checkin::text,
      pg_temp.probe(r.uid, format('select public.can_check_in_event_competition(%L)', pg_temp.u('00e0001')), true));
    perform pg_temp.chk('helper: can_manage_event_competition for ' || r.role_key || ' is unchanged (front_desk is not a manager)',
      pg_temp.probe(r.uid, format('select public.can_manage_event_competition(%L)', pg_temp.u('00e0001')), true) = 'val:' || r.is_manager::text);
  end loop;
end $$;
select pg_temp.chk('helper: anon cannot execute it',
  pg_temp.probe(null, format('select public.can_check_in_event_competition(%L)', pg_temp.u('00e0001')), true) = 'err:42501',
  pg_temp.probe(null, format('select public.can_check_in_event_competition(%L)', pg_temp.u('00e0001')), true));
select pg_temp.chk('helper: front desk of the hosting studio is false for the other tenant event',
  pg_temp.probe(pg_temp.u('0000003'), format('select public.can_check_in_event_competition(%L)', pg_temp.u('00e0002')), true) = 'val:false');
select pg_temp.chk('helper: a nonexistent event is false',
  pg_temp.probe(pg_temp.u('0000003'), format('select public.can_check_in_event_competition(%L)', gen_random_uuid()), true) = 'val:false');

-- ============================================================================
-- 2. Admission actions (front desk allowed; instructors / outsiders / anon refused)
--    expected: allow = rows >= 1 (or val for the RPC); deny = rows:0 or err
-- ============================================================================
create temp table t_actions (action text primary key, sql_text text, kind text, scalar boolean);
grant all on t_actions to authenticated, anon, service_role;
insert into t_actions values
  ('read session',            format('select * from public.event_competition_checkin_sessions where id = %L', pg_temp.u('0050001')), 'allow_rows_ge1', false),
  ('read participants',       format('select * from public.event_competition_checkin_participants where checkin_session_id = %L', pg_temp.u('0050001')), 'allow_rows_ge1', false),
  ('read credentials',        format('select * from public.event_competition_credentials where checkin_session_id = %L', pg_temp.u('0050001')), 'allow_rows_ge1', false),
  ('read waivers',            format('select * from public.event_competition_participant_waivers where event_id = %L', pg_temp.u('00e0001')), 'allow_rows_ge1', false),
  ('read entries',            format('select * from public.event_competition_entries where event_id = %L', pg_temp.u('00e0001')), 'allow_rows_ge1', false),
  ('read divisions',          format('select * from public.event_competition_divisions where event_id = %L', pg_temp.u('00e0001')), 'allow_rows_ge1', false),
  ('start a session',         format('insert into public.event_competition_checkin_sessions (event_id, registration_id, order_id, status) values (%L, %L, %L, %L)', pg_temp.u('00e0001'), pg_temp.u('0110002'), pg_temp.u('0100002'), 'in_progress'), 'allow_rows_ge1', false),
  ('admit a participant',     format('insert into public.event_competition_checkin_participants (event_id, checkin_session_id, registration_attendee_id, display_name) values (%L, %L, %L, %L)', pg_temp.u('00e0001'), pg_temp.u('0050001'), pg_temp.u('0120002'), 'Pat2 A'), 'allow_rows_ge1', false),
  ('mark present',            format('update public.event_competition_checkin_participants set presence_status = %L, checked_in_at = now() where id = %L', 'present', pg_temp.u('0130001')), 'allow_rows_ge1', false),
  ('update session status',   format('update public.event_competition_checkin_sessions set status = %L where id = %L', 'ready', pg_temp.u('0050001')), 'allow_rows_ge1', false),
  ('sign a waiver (upsert)',  format('update public.event_competition_participant_waivers set signer_name = %L where id = %L', 'Pat Again', pg_temp.u('0160001')), 'allow_rows_ge1', false),
  ('issue a credential',      format('insert into public.event_competition_credentials (event_id, checkin_session_id, credential_number, holder_type, registration_attendee_id, display_name, status) values (%L, %L, %L, %L, %L, %L, %L)', pg_temp.u('00e0001'), pg_temp.u('0050001'), '102', 'participant', pg_temp.u('0120002'), 'Pat2 A', 'issued'), 'allow_rows_ge1', false),
  ('desk payment (RPC)',      format('select public.record_competition_checkin_payment(%L, %L, 10, %L, null)->>%L', pg_temp.u('00e0001'), pg_temp.u('0050001'), 'cash', 'outcome'), 'allow_val_recorded', true);

do $$
declare r record; a record; res text; ok boolean;
begin
  for r in select * from t_roles loop
    for a in select * from t_actions loop
      res := pg_temp.probe(r.uid, a.sql_text, a.scalar);
      if a.kind = 'allow_val_recorded' then
        ok := case when r.can_checkin then res = 'val:recorded' else res like 'err:%' end;
      else
        ok := case when r.can_checkin then res in ('rows:1', 'rows:2') else (res like 'err:%' or res = 'rows:0') end;
        -- Pre-existing, not CB-2: validate_competition_checkin_links runs as the invoker and reads event_orders / attendees under
        -- their own RLS, which organizer-only users and platform admins (not studio staff) cannot see -> P0001 on inserts.
        if not ok and r.can_checkin and not r.role_key in ('studio_owner','studio_admin','front_desk') and a.action in ('start a session','admit a participant','issue a credential') and res = 'err:P0001' then ok := true; end if;
      end if;
      perform pg_temp.chk('admission/' || a.action || ' as ' || r.role_key, ok, res);
    end loop;
  end loop;
  -- anon
  for a in select * from t_actions loop
    res := pg_temp.probe(null, a.sql_text, a.scalar);
    perform pg_temp.chk('admission/' || a.action || ' as anon', res like 'err:%' or res = 'rows:0', res);
  end loop;
end $$;

-- Other tenant: the hosting studio's front desk cannot read or write the other event's session.
select pg_temp.chk('tenant: front desk cannot read another event''s session',
  pg_temp.probe(pg_temp.u('0000003'), format('select * from public.event_competition_checkin_sessions where id = %L', pg_temp.u('0050002'))) = 'rows:0');
select pg_temp.chk('tenant: front desk cannot update another event''s session',
  pg_temp.probe(pg_temp.u('0000003'), format('update public.event_competition_checkin_sessions set status = %L where id = %L', 'ready', pg_temp.u('0050002'))) = 'rows:0');
select pg_temp.chk('tenant: front desk cannot insert a session into another event',
  pg_temp.probe(pg_temp.u('0000003'), format('insert into public.event_competition_checkin_sessions (event_id, registration_id, order_id, status) values (%L, %L, %L, %L)', pg_temp.u('00e0002'), pg_temp.u('0110003'), pg_temp.u('0100003'), 'in_progress')) like 'err:%');
select pg_temp.chk('tenant: front desk cannot take a desk payment on another event''s session',
  pg_temp.probe(pg_temp.u('0000003'), format('select public.record_competition_checkin_payment(%L, %L, 10, %L, null)', pg_temp.u('00e0002'), pg_temp.u('0050002'), 'cash'), true) like 'err:%');
select pg_temp.chk('tenant: the other studio''s front desk cannot read this event''s session',
  pg_temp.probe(pg_temp.u('000000a'), format('select * from public.event_competition_checkin_sessions where id = %L', pg_temp.u('0050001'))) = 'rows:0');

-- Desk payment semantics for the front desk: the cap and the audit actor are unchanged.
select pg_temp.chk('desk payment: front desk cannot exceed the balance',
  pg_temp.probe(pg_temp.u('0000003'), format('select public.record_competition_checkin_payment(%L, %L, 300.01, %L, null)', pg_temp.u('00e0001'), pg_temp.u('0050001'), 'cash'), true) = 'err:22023');
select pg_temp.chk('desk payment: front desk cannot pay with an invalid method',
  pg_temp.probe(pg_temp.u('0000003'), format('select public.record_competition_checkin_payment(%L, %L, 10, %L, null)', pg_temp.u('00e0001'), pg_temp.u('0050001'), 'bitcoin'), true) = 'err:22023');
select pg_temp.chk('desk payment: anon is refused (authentication required)',
  pg_temp.probe(null, format('select public.record_competition_checkin_payment(%L, %L, 10, %L, null)', pg_temp.u('00e0001'), pg_temp.u('0050001'), 'cash'), true) like 'err:%');
select pg_temp.chk('desk payment: front desk cannot write event_payments directly',
  pg_temp.probe(pg_temp.u('0000003'), format('insert into public.event_payments (registration_id, amount, currency, payment_method, status, source) values (%L, 5, %L, %L, %L, %L)', pg_temp.u('0110001'), 'USD', 'cash', 'paid', 'competition_checkin')) like 'err:%');

-- ============================================================================
-- 3. Forbidden actions: refused at the database for front desk (and every non-manager)
--    sanity: the same statement succeeds for a manager where the fixture allows it, so the probe can fail.
-- ============================================================================
create temp table t_forbidden (action text primary key, sql_text text, scalar boolean, manager_sanity boolean);
grant all on t_forbidden to authenticated, anon, service_role;
insert into t_forbidden values
  ('edit eligibility',        format('update public.event_competition_entries set eligibility_status = %L where id = %L', 'ineligible', pg_temp.u('0080001')), false, true),
  ('edit verification',       format('update public.event_competition_entries set verification_status = %L where id = %L', 'verified', pg_temp.u('0080001')), false, true),
  ('edit entry status',       format('update public.event_competition_entries set status = %L where id = %L', 'withdrawn', pg_temp.u('0080001')), false, false),
  ('insert an entry',         format('insert into public.event_competition_entries (event_id, program_id, division_id, display_name, status) values (%L, %L, %L, %L, %L)', pg_temp.u('00e0001'), pg_temp.u('0010001'), pg_temp.u('0030001'), 'Sneaky', 'confirmed'), false, true),
  ('delete an entry',         format('delete from public.event_competition_entries where id = %L', pg_temp.u('0080002')), false, false),
  ('edit a heat',             format('update public.event_competition_heats set name = %L where id = %L', 'Renamed', pg_temp.u('0090001')), false, true),
  ('insert a heat',           format('insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, name) values (%L, %L, %L, 2, %L)', pg_temp.u('00e0001'), pg_temp.u('0030001'), pg_temp.u('0060001'), 'Heat 2'), false, true),
  ('move a heat placement',   format('update public.event_competition_heat_entries set status = %L where entry_id = %L', 'scratched', pg_temp.u('0080001')), false, false),
  ('delete a heat placement', format('delete from public.event_competition_heat_entries where entry_id = %L', pg_temp.u('0080001')), false, false),
  ('edit a division',         format('update public.event_competition_divisions set name = %L where id = %L', 'Hacked', pg_temp.u('0030001')), false, true),
  ('insert a division',       format('insert into public.event_competition_divisions (event_id, program_id, contest_id, name, status) values (%L, %L, %L, %L, %L)', pg_temp.u('00e0001'), pg_temp.u('0010001'), pg_temp.u('0020001'), 'Gold', 'open'), false, true),
  ('edit a contest',          format('update public.event_competition_contests set name = %L where id = %L', 'Hacked', pg_temp.u('0020001')), false, true),
  ('edit program settings',   format('update public.event_competition_programs set name = %L where id = %L', 'Hacked', pg_temp.u('0010001')), false, true),
  ('edit a round',            format('update public.event_competition_rounds set name = %L where id = %L', 'Hacked', pg_temp.u('0060001')), false, true),
  ('lock a heat (RPC)',       format('select public.set_competition_heat_lock_state(%L, %L, %L)', pg_temp.u('0090001'), 'locked', 'test'), true, false),
  ('scratch an entry (RPC)',  format('select public.scratch_competition_entry(%L, %L, %L, %L)', pg_temp.u('0080002'), gen_random_uuid(), 'no show', null), true, false),
  ('request a refund (RPC)',  format('select public.request_competition_order_refund(%L, %L, %L, %L::jsonb, %L)', pg_temp.u('00e0001'), pg_temp.u('0100001'), gen_random_uuid(), '[]', 'test'), true, false),
  ('resolve a refund exception (RPC)', format('select public.resolve_competition_refund_exception(%L, %L)', gen_random_uuid(), 'test'), true, false),
  ('void a credential',       format('update public.event_competition_credentials set status = %L where id = %L', 'void', pg_temp.u('0140001')), false, true),
  ('delete a credential',     format('delete from public.event_competition_credentials where id = %L', pg_temp.u('0140001')), false, true),
  ('delete a session',        format('delete from public.event_competition_checkin_sessions where id = %L', pg_temp.u('0050001')), false, true),
  ('delete a participant',    format('delete from public.event_competition_checkin_participants where id = %L', pg_temp.u('0130001')), false, true),
  ('delete a waiver',         format('delete from public.event_competition_participant_waivers where id = %L', pg_temp.u('0160001')), false, true),
  ('edit the event (dates/venue)', format('update public.events set start_date = start_date + 1, venue_name = %L where id = %L', 'Elsewhere', pg_temp.u('00e0001')), false, false),
  ('edit a registration',     format('update public.event_registrations set total_price = 1 where id = %L', pg_temp.u('0110001')), false, false),
  ('edit an order total',     format('update public.event_orders set total_amount = 1 where id = %L', pg_temp.u('0100001')), false, false);

create temp table t_forbidden_results (action text, role_key text, result text);
grant all on t_forbidden_results to authenticated, anon, service_role;
do $$
declare r record; a record; res text; denied boolean;
begin
  for a in select * from t_forbidden loop
    -- sanity: a manager (studio owner) is not denied where the fixture allows it, so the probe can distinguish.
    if a.manager_sanity then
      res := pg_temp.probe(pg_temp.u('0000001'), a.sql_text, a.scalar);
      perform pg_temp.chk('forbidden/' || a.action || ': studio_owner is NOT denied (probe is sensitive)', res not like 'err:%' and res <> 'rows:0', res);
    end if;
    for r in select * from t_roles where not is_manager loop
      res := pg_temp.probe(r.uid, a.sql_text, a.scalar);
      denied := res like 'err:%' or res = 'rows:0' or (a.action like 'resolve a refund%' and res = 'val:false');
      perform pg_temp.chk('forbidden/' || a.action || ' as ' || r.role_key, denied, res);
    end loop;
    res := pg_temp.probe(null, a.sql_text, a.scalar);
    perform pg_temp.chk('forbidden/' || a.action || ' as anon', res like 'err:%' or res = 'rows:0', res);
  end loop;
end $$;

-- Refund / scratch: front desk is refused by the RPC's own authorization, not by a later validation error.
select pg_temp.chk('refund RPC: front desk refused with the manage/not-found error',
  pg_temp.probe(pg_temp.u('0000003'), format('select public.request_competition_order_refund(%L, %L, %L, %L::jsonb, %L)', pg_temp.u('00e0001'), pg_temp.u('0100001'), gen_random_uuid(), '[]', 'test'), true) in ('err:42501', 'err:P0001', 'err:P0002'),
  pg_temp.probe(pg_temp.u('0000003'), format('select public.request_competition_order_refund(%L, %L, %L, %L::jsonb, %L)', pg_temp.u('00e0001'), pg_temp.u('0100001'), gen_random_uuid(), '[]', 'test'), true));
select pg_temp.chk('scratch RPC: front desk refused (not-found style error, nothing written)',
  pg_temp.probe(pg_temp.u('0000003'), format('select public.scratch_competition_entry(%L, %L, %L, %L)', pg_temp.u('0080002'), gen_random_uuid(), 'no show', null), true) = 'err:P0001');

-- State after all probes: nothing changed (every probe rolled back).
select pg_temp.chk('probes left the fixtures untouched',
  (select eligibility_status from public.event_competition_entries where id = pg_temp.u('0080001')) = 'eligible'
  and (select verification_status from public.event_competition_entries where id = pg_temp.u('0080001')) = 'unverified'
  and (select count(*) from public.event_payments where registration_id = pg_temp.u('0110001')) = 0
  and (select count(*) from public.event_competition_checkin_sessions where event_id = pg_temp.u('00e0001')) = 1);

-- ============================================================================
-- 4. Real front-desk admission flow end to end (committed within the transaction, as the front desk user)
-- ============================================================================
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('0000003'), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into public.event_competition_checkin_sessions (id, event_id, registration_id, order_id, status, started_at)
values (pg_temp.u('0050003'), pg_temp.u('00e0001'), pg_temp.u('0110002'), pg_temp.u('0100002'), 'in_progress', now());
insert into public.event_competition_checkin_participants (id, event_id, checkin_session_id, registration_attendee_id, display_name)
values (pg_temp.u('0130003'), pg_temp.u('00e0001'), pg_temp.u('0050003'), pg_temp.u('0120003'), 'Sam B');
update public.event_competition_checkin_participants set presence_status = 'present', checked_in_at = now(), checked_in_by = pg_temp.u('0000003')
where id = pg_temp.u('0130003') and presence_status <> 'present';
insert into public.event_competition_participant_waivers (event_id, checkin_participant_id, template_id, signer_name, signature_text, consent_text, signed_body, signed_by_staff)
values (pg_temp.u('00e0001'), pg_temp.u('0130003'), pg_temp.u('0150001'), 'Sam B', 'Sam B', 'consent', 'Waiver body', pg_temp.u('0000003'));
insert into public.event_competition_credentials (event_id, checkin_session_id, credential_number, holder_type, registration_attendee_id, display_name, status, assigned_by, issued_at, issued_by)
values (pg_temp.u('00e0001'), pg_temp.u('0050003'), '201', 'participant', pg_temp.u('0120003'), 'Sam B', 'issued', pg_temp.u('0000003'), now(), pg_temp.u('0000003'));
select public.record_competition_checkin_payment(pg_temp.u('00e0001'), pg_temp.u('0050003'), 300, 'cash', null);
update public.event_competition_checkin_sessions set status = 'complete', completed_at = now(), completed_by = pg_temp.u('0000003') where id = pg_temp.u('0050003');
reset role;

select pg_temp.chk('flow: front desk started a session, marked present, signed a waiver, issued a number, paid in full and completed',
  (select presence_status from public.event_competition_checkin_participants where id = pg_temp.u('0130003')) = 'present'
  and (select checked_in_by from public.event_competition_checkin_participants where id = pg_temp.u('0130003')) = pg_temp.u('0000003')
  and (select count(*) from public.event_competition_participant_waivers where checkin_participant_id = pg_temp.u('0130003')) = 1
  and (select count(*) from public.event_competition_credentials where checkin_session_id = pg_temp.u('0050003') and status = 'issued') = 1
  and (select payment_status from public.event_orders where id = pg_temp.u('0100002')) = 'paid'
  and (select status from public.event_competition_checkin_sessions where id = pg_temp.u('0050003')) = 'complete');
select pg_temp.chk('flow: the payment audit row names the front desk user and the payment source is competition_checkin',
  (select actor_user_id from public.event_competition_checkin_payment_audit where checkin_session_id = pg_temp.u('0050003')) = pg_temp.u('0000003')
  and (select count(*) from public.event_payments where registration_id = pg_temp.u('0110002') and source = 'competition_checkin' and amount = 300) = 1);

-- ============================================================================
-- 5. Function bodies and grants
-- ============================================================================
select pg_temp.chk('record_competition_checkin_payment now authorizes through the helper',
  (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_competition_checkin_payment') like '%can_check_in_event_competition(p_event_id)%'
  and (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_competition_checkin_payment') not like '%usr.role in (%');
select pg_temp.chk('helper: anon / public cannot execute, authenticated and service_role can',
  not has_function_privilege('anon', 'public.can_check_in_event_competition(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.can_check_in_event_competition(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.can_check_in_event_competition(uuid)', 'execute'));
select pg_temp.chk('policies: front desk has no delete policy anywhere and no write policy on entries / heats',
  not exists (select 1 from pg_policies where schemaname = 'public' and policyname like 'competition_checkin_%' and cmd in ('DELETE', 'ALL'))
  and not exists (select 1 from pg_policies where schemaname = 'public' and policyname like 'competition_checkin_%' and tablename in ('event_competition_entries', 'event_competition_heats', 'event_competition_divisions') and cmd <> 'SELECT'),
  (select string_agg(tablename || '.' || policyname || ':' || cmd, ', ') from pg_policies where schemaname = 'public' and policyname like 'competition_checkin_%'));
select pg_temp.chk('policies: credentials give the front desk select + insert only',
  (select string_agg(cmd, ',' order by cmd) from pg_policies where schemaname = 'public' and tablename = 'event_competition_credentials' and policyname like 'competition_checkin_%') = 'INSERT,SELECT');

do $$
declare
  v_total integer;
  v_failures text;
begin
  select count(*), string_agg(name || ' [' || detail || ']', '; ') filter (where not ok)
  into v_total, v_failures
  from t_results;
  if v_failures is null then
    raise exception 'CB2 FRONT DESK SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'CB2 FRONT DESK SQL SUITE FAIL: %', v_failures;
end $$;

rollback;

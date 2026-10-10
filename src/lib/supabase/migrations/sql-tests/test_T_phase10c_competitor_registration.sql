-- Phase 10C -- competitors + transactional registration regression suite.
--
-- Covers 20261109090000_phase10c_competitor_registration.sql on top of 10A + 10B.
-- One transaction, synthetic fixtures only (UUID block 00000000-0000-0000-0000-0c10c0XXXXXX).
-- now() is constant inside one transaction, so price-window transitions are exercised by passing
-- explicit timestamps to _comp10c_quote and by moving fee-rule windows between START calls.
-- Tenant behaviour is simulated with `set local role` + request.jwt.claims. The final block ALWAYS
-- raises, so nothing persists; its message is the verdict:
--   "PHASE 10C SQL SUITE PASS (<n> checks)"  or  "PHASE 10C SQL SUITE FAIL: <failures>".

begin;

-- ============================================================================
-- Harness
-- ============================================================================
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_kv (k text primary key, v jsonb) on commit drop;
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
    insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
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

-- Runs a statement that returns jsonb; an error becomes {"error": ...} so a regression fails a named
-- check instead of aborting the suite.
create or replace function pg_temp.try_jsonb(p_sql text) returns jsonb
language plpgsql as $$
declare r jsonb;
begin
  execute p_sql into r;
  return r;
exception when others then
  return jsonb_build_object('error', sqlstate || ' ' || sqlerrm);
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-' || p_suffix)::uuid $$;

-- Catalog ids: kind digit 1 program, 2 contest, 3 division, 4 dance, 5 offering, 7 fee rule.
create or replace function pg_temp.cid(p_kind int, p_event int, p_k int default 0) returns uuid
language sql immutable as $$
  select case when p_kind = 1 then ('00000000-0000-0000-0000-0c10c000100' || p_event)::uuid
              else ('00000000-0000-0000-0000-0c10c000' || p_kind || p_event || '0' || p_k)::uuid end
$$;

create or replace function pg_temp.ev(p_n int) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-0c10c000e00' || p_n)::uuid $$;

create or replace function pg_temp.req(p_n int) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-0c10c00f' || lpad(p_n::text, 4, '0'))::uuid $$;

create or replace function pg_temp.person(p_id text, p_first text, p_last text, p_extra jsonb default '{}') returns jsonb
language sql immutable as $$
  select jsonb_build_object('clientId', p_id, 'firstName', p_first, 'lastName', p_last, 'personType', 'dancer') || p_extra
$$;

create or replace function pg_temp.entry(p_id text, p_event int, p_contest int, p_division int, p_people jsonb, p_roles jsonb,
                                         p_offerings jsonb default '[]', p_extra jsonb default '{}') returns jsonb
language sql immutable as $$
  select jsonb_build_object('clientId', p_id, 'programId', pg_temp.cid(1, p_event), 'contestId', pg_temp.cid(2, p_event, p_contest),
    'divisionId', pg_temp.cid(3, p_event, p_division), 'participantIds', p_people, 'participantRoles', p_roles,
    'selectedOfferingIds', p_offerings) || p_extra
$$;

create or replace function pg_temp.draft(p_people jsonb, p_entries jsonb, p_email text default 'buyer@example.test',
                                         p_extra jsonb default '{}') returns jsonb
language sql immutable as $$
  select jsonb_build_object('registrationMode', 'individual', 'buyerName', 'Bea Buyer', 'buyerEmail', p_email,
    'people', p_people, 'entries', p_entries) || p_extra
$$;

create or replace function pg_temp.start(p_event uuid, p_req uuid, p_draft jsonb, p_actor uuid default null) returns jsonb
language sql as $$ select public.start_competition_registration(p_event, p_req, p_draft, p_actor) $$;

create or replace function pg_temp.n(p_sql text) returns bigint
language plpgsql as $$
declare r bigint;
begin
  execute p_sql into r;
  return r;
end $$;

create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('0c10c0000001'), 't-p10c-owner-a@example.test'),
  (pg_temp.u('0c10c0000002'), 't-p10c-verified@example.test'),
  (pg_temp.u('0c10c0000003'), 't-p10c-unverified@example.test'),
  (pg_temp.u('0c10c0000004'), 't-p10c-owner-b@example.test'),
  (pg_temp.u('0c10c0000005'), 't-p10c-nobody@example.test'),
  (pg_temp.u('0c10c0000006'), 't-p10c-verified-2@example.test');
insert into public.profiles (id, email, full_name) values
  (pg_temp.u('0c10c0000001'), 't-p10c-owner-a@example.test', 'Owner A'),
  (pg_temp.u('0c10c0000002'), 't-p10c-verified@example.test', 'Sam Self'),
  (pg_temp.u('0c10c0000003'), 't-p10c-unverified@example.test', 'Una Verified'),
  (pg_temp.u('0c10c0000004'), 't-p10c-owner-b@example.test', 'Owner B'),
  (pg_temp.u('0c10c0000005'), 't-p10c-nobody@example.test', 'Nobody'),
  (pg_temp.u('0c10c0000006'), 't-p10c-verified-2@example.test', 'Vera Two');
insert into public.verified_email_identities (user_id, email, method, source, credential_status, bound_at) values
  (pg_temp.u('0c10c0000002'), 't-p10c-verified@example.test', 'otp', 'web_callback', 'bound', now() - interval '1 day'),
  (pg_temp.u('0c10c0000006'), 't-p10c-verified-2@example.test', 'otp', 'web_callback', 'bound', now() - interval '1 day');

insert into public.studios (id, name, slug, stripe_connected_account_id, stripe_connect_onboarding_complete,
                            stripe_connect_charges_enabled, stripe_connect_payouts_enabled) values
  (pg_temp.u('0c10c000a001'), 'P10C Studio A', 't-p10c-studio-a', 'acct_p10cStudioA', true, true, true),
  (pg_temp.u('0c10c000b001'), 'P10C Studio B', 't-p10c-studio-b', 'acct_p10cStudioB', true, true, true);
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('0c10c0000001'), pg_temp.u('0c10c000a001'), 'studio_owner', true),
  (pg_temp.u('0c10c0000004'), pg_temp.u('0c10c000b001'), 'studio_owner', true);

insert into public.clients (id, studio_id, first_name, last_name, email) values
  (pg_temp.u('0c10c000c001'), pg_temp.u('0c10c000a001'), 'Sam', 'Self', 't-p10c-verified@example.test'),
  (pg_temp.u('0c10c000c002'), pg_temp.u('0c10c000a001'), 'Jane', 'Doe', 'jane.doe@example.test'),
  (pg_temp.u('0c10c000c003'), pg_temp.u('0c10c000b001'), 'Bob', 'Other', 'bob@example.test');
insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type, initiated_by, linked_at) values
  (pg_temp.u('0c10c000a001'), pg_temp.u('0c10c000c001'), pg_temp.u('0c10c0000002'), 'linked', 'self', 'studio', now());
insert into public.instructors (id, studio_id, first_name, last_name, active) values
  (pg_temp.u('0c10c000d001'), pg_temp.u('0c10c000a001'), 'Pat', 'Pro', true),
  (pg_temp.u('0c10c000d002'), pg_temp.u('0c10c000b001'), 'Olga', 'Other', true);

-- e1 main, e2 second event same studio, e3 studio B, e4 draft, e5 window closed, e6 window future, e7 private.
do $$
declare
  n int;
  e uuid;
  s uuid;
begin
  for n in 1..7 loop
    e := pg_temp.ev(n);
    s := case when n = 3 then pg_temp.u('0c10c000b001') else pg_temp.u('0c10c000a001') end;
    insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility,
                               registration_required, registration_opens_at, registration_closes_at, account_required_for_registration)
    values (e, s, 'P10C Event ' || n, 't-p10c-e' || n, 'competition', current_date + 30, current_date + 30,
            case when n = 4 then 'draft' else 'published' end,
            case when n = 7 then 'private' else 'public' end, true,
            case when n = 6 then now() + interval '1 day' else now() - interval '1 day' end,
            case when n = 5 then now() - interval '1 hour' else now() + interval '30 days' end, false);
    insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
    values (pg_temp.cid(1, n), e, s, 'Program ' || n, 'ballroom', 'relative', 'skating', 'configured');
    insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
      (pg_temp.cid(2, n, 1), e, pg_temp.cid(1, n), 'ProAm Smooth', 'multi_dance', 'pro_am', 'draft'),
      (pg_temp.cid(2, n, 2), e, pg_temp.cid(1, n), 'Solo Showcase', 'single_dance', 'solo', 'draft'),
      (pg_temp.cid(2, n, 3), e, pg_temp.cid(1, n), 'Jack and Jill', 'jack_and_jill', 'random_partner', 'draft'),
      (pg_temp.cid(2, n, 4), e, pg_temp.cid(1, n), 'Team Formation', 'team', 'team', 'draft'),
      (pg_temp.cid(2, n, 5), e, pg_temp.cid(1, n), 'Empty Category', 'single_dance', 'solo', 'draft'),
      (pg_temp.cid(2, n, 6), e, pg_temp.cid(1, n), 'Closed Rule Category', 'single_dance', 'solo', 'draft');
    insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
      (pg_temp.cid(3, n, 1), e, pg_temp.cid(1, n), pg_temp.cid(2, n, 1), 'ProAm Bronze', 'draft'),
      (pg_temp.cid(3, n, 2), e, pg_temp.cid(1, n), pg_temp.cid(2, n, 2), 'Solo Open', 'draft'),
      (pg_temp.cid(3, n, 3), e, pg_temp.cid(1, n), pg_temp.cid(2, n, 3), 'J&J Novice', 'draft'),
      (pg_temp.cid(3, n, 4), e, pg_temp.cid(1, n), pg_temp.cid(2, n, 4), 'Team Open', 'draft'),
      (pg_temp.cid(3, n, 6), e, pg_temp.cid(1, n), pg_temp.cid(2, n, 6), 'Closed Rule Division', 'draft'),
      (pg_temp.cid(3, n, 7), e, pg_temp.cid(1, n), pg_temp.cid(2, n, 1), 'ProAm Closed Division', 'closed');
    insert into public.event_competition_dances (id, event_id, program_id, dance_key, name, active) values
      (pg_temp.cid(4, n, 1), e, pg_temp.cid(1, n), 'smooth_waltz', 'Waltz', true),
      (pg_temp.cid(4, n, 2), e, pg_temp.cid(1, n), 'smooth_foxtrot', 'Foxtrot', true),
      (pg_temp.cid(4, n, 3), e, pg_temp.cid(1, n), 'smooth_tango', 'Tango', true);
    insert into public.event_competition_division_dances (id, event_id, program_id, division_id, dance_id, entry_fee, currency, required, active) values
      (pg_temp.cid(5, n, 1), e, pg_temp.cid(1, n), pg_temp.cid(3, n, 1), pg_temp.cid(4, n, 1), 25.00, 'USD', false, true),
      (pg_temp.cid(5, n, 2), e, pg_temp.cid(1, n), pg_temp.cid(3, n, 1), pg_temp.cid(4, n, 2), 30.00, 'USD', false, true),
      (pg_temp.cid(5, n, 3), e, pg_temp.cid(1, n), pg_temp.cid(3, n, 7), pg_temp.cid(4, n, 1), 99.00, 'USD', false, true),
      (pg_temp.cid(5, n, 4), e, pg_temp.cid(1, n), pg_temp.cid(3, n, 1), pg_temp.cid(4, n, 3), 77.00, 'USD', false, false);
    update public.event_competition_contest_registration_rules set dance_selection_mode = 'individual', pricing_method = 'per_dance',
      base_entry_fee = 0, minimum_participants = 2, maximum_participants = 2, minimum_dances = 1, maximum_dances = null
    where contest_id = pg_temp.cid(2, n, 1);
    update public.event_competition_contest_registration_rules set dance_selection_mode = 'none', pricing_method = 'flat_entry',
      base_entry_fee = 40, minimum_participants = 1, maximum_participants = 1
    where contest_id in (pg_temp.cid(2, n, 2), pg_temp.cid(2, n, 5), pg_temp.cid(2, n, 6));
    update public.event_competition_contest_registration_rules set dance_selection_mode = 'none', pricing_method = 'flat_entry',
      base_entry_fee = 15, minimum_participants = 1, maximum_participants = 1
    where contest_id = pg_temp.cid(2, n, 3);
    update public.event_competition_contest_registration_rules set dance_selection_mode = 'none', pricing_method = 'flat_entry',
      base_entry_fee = 100, minimum_participants = 2, maximum_participants = 10
    where contest_id = pg_temp.cid(2, n, 4);
  end loop;
end $$;

-- e1 fee rules: early-bird discount (active now), late fee (starts in 1 hour), 3% service fee (always).
insert into public.event_competition_fee_rules (id, event_id, name, calculation_type, registration_mode, amount, percentage, currency,
                                                starts_at, ends_at, active, priority) values
  (pg_temp.cid(7, 1, 1), pg_temp.ev(1), 'Early bird', 'discount_flat', 'both', 10, null, 'USD', now() - interval '1 day', now() + interval '1 hour', true, 0),
  (pg_temp.cid(7, 1, 2), pg_temp.ev(1), 'Late fee', 'flat_per_entry', 'both', 5, null, 'USD', now() + interval '1 hour', null, true, 0),
  (pg_temp.cid(7, 1, 3), pg_temp.ev(1), 'Service fee', 'percentage', 'both', 0, 3, 'USD', null, null, true, 10);

-- ============================================================================
-- RLS / LIFECYCLE GATE (before open)
-- ============================================================================
set local role anon;
select pg_temp.chk('rls: published+configured but NOT opened -> programs hidden',
  (select count(*) from public.event_competition_programs where event_id = pg_temp.ev(1)) = 0);
select pg_temp.chk('rls: before open -> no contests/divisions/dances/offerings/rules/fees visible',
  (select count(*) from public.event_competition_contests where event_id = pg_temp.ev(1))
  + (select count(*) from public.event_competition_divisions where event_id = pg_temp.ev(1))
  + (select count(*) from public.event_competition_dances where event_id = pg_temp.ev(1))
  + (select count(*) from public.event_competition_division_dances where event_id = pg_temp.ev(1))
  + (select count(*) from public.event_competition_contest_registration_rules where event_id = pg_temp.ev(1))
  + (select count(*) from public.event_competition_fee_rules where event_id = pg_temp.ev(1)) = 0);
reset role;

select pg_temp.expect_msg('start: before open -> COMP10C_CLOSED',
  $q$select pg_temp.start(pg_temp.ev(1), pg_temp.req(9001), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A')),
     jsonb_build_array(pg_temp.entry('x', 1, 2, 2, '["a"]', '{"a":"dancer"}'))))$q$, 'COMP10C_CLOSED');

-- Non-manager / other-studio manager cannot open; manager can.
select pg_temp.as_user(pg_temp.u('0c10c0000005'));
select pg_temp.expect_msg('open: non-manager forbidden', $q$select public.open_competition_registration(pg_temp.cid(1, 1))$q$, 'COMP10C_FORBIDDEN');
reset role;
select pg_temp.as_user(pg_temp.u('0c10c0000004'));
select pg_temp.expect_msg('open: other studio owner forbidden', $q$select public.open_competition_registration(pg_temp.cid(1, 1))$q$, 'COMP10C_FORBIDDEN');
select pg_temp.expect_msg('rls: authenticated cannot write registration_status directly',
  $q$update public.event_competition_programs set registration_status = 'open' where id = pg_temp.cid(1, 3)$q$, 'permission denied');
select pg_temp.expect_ok('open: studio B owner opens e3', $q$select public.open_competition_registration(pg_temp.cid(1, 3))$q$);
reset role;

select pg_temp.as_user(pg_temp.u('0c10c0000001'));
select pg_temp.expect_ok('open: manager opens e1', $q$insert into t_kv values ('open_e1', public.open_competition_registration(pg_temp.cid(1, 1)))$q$);
select pg_temp.expect_ok('open: manager opens e2', $q$select public.open_competition_registration(pg_temp.cid(1, 2))$q$);
select pg_temp.expect_ok('open: e4 (draft event) program opens but stays hidden', $q$select public.open_competition_registration(pg_temp.cid(1, 4))$q$);
select pg_temp.expect_ok('open: e5 (window closed)', $q$select public.open_competition_registration(pg_temp.cid(1, 5))$q$);
select pg_temp.expect_ok('open: e6 (window future)', $q$select public.open_competition_registration(pg_temp.cid(1, 6))$q$);
select pg_temp.expect_ok('open: e7 (private)', $q$select public.open_competition_registration(pg_temp.cid(1, 7))$q$);
reset role;

select pg_temp.chk('open: transitions draft contests/divisions to open and opens their rules',
  (select count(*) from public.event_competition_contests where event_id = pg_temp.ev(1) and status = 'open') = 5
  and (select count(*) from public.event_competition_divisions where event_id = pg_temp.ev(1) and status = 'open') = 5
  and (select count(*) from public.event_competition_contest_registration_rules where event_id = pg_temp.ev(1) and registration_open) = 5
  and (select registration_status from public.event_competition_programs where id = pg_temp.cid(1, 1)) = 'open',
  (select v::text from t_kv where k = 'open_e1'));
select pg_temp.chk('open: category without divisions stays draft',
  (select status from public.event_competition_contests where id = pg_temp.cid(2, 1, 5)) = 'draft');
select pg_temp.chk('open: closed division is not reopened',
  (select status from public.event_competition_divisions where id = pg_temp.cid(3, 1, 7)) = 'closed');
-- Category 6: open category whose rule the organizer then closes (fine-grained toggle).
update public.event_competition_contest_registration_rules set registration_open = false
where contest_id in (pg_temp.cid(2, 1, 6), pg_temp.cid(2, 2, 6));

set local role anon;
select pg_temp.chk('rls: open window -> program visible', (select count(*) from public.event_competition_programs where event_id = pg_temp.ev(1)) = 1);
select pg_temp.chk('rls: open -> 4 registrable contests visible (rule-closed + empty hidden)',
  (select count(*) from public.event_competition_contests where event_id = pg_temp.ev(1)) = 4);
select pg_temp.chk('rls: open -> 4 registrable divisions visible (closed + rule-closed hidden)',
  (select count(*) from public.event_competition_divisions where event_id = pg_temp.ev(1)) = 4);
select pg_temp.chk('rls: open -> only active offerings of open divisions visible',
  (select count(*) from public.event_competition_division_dances where event_id = pg_temp.ev(1)) = 2);
select pg_temp.chk('rls: fee rules outside their window hidden (late fee not yet visible)',
  (select count(*) from public.event_competition_fee_rules where event_id = pg_temp.ev(1)) = 2
  and not exists (select 1 from public.event_competition_fee_rules where id = pg_temp.cid(7, 1, 2)));
select pg_temp.chk('rls: e5 closed window hidden', (select count(*) from public.event_competition_programs where event_id = pg_temp.ev(5)) = 0
  and (select count(*) from public.event_competition_divisions where event_id = pg_temp.ev(5)) = 0);
select pg_temp.chk('rls: e6 future window hidden', (select count(*) from public.event_competition_contests where event_id = pg_temp.ev(6)) = 0);
select pg_temp.chk('rls: e4 draft event hidden', (select count(*) from public.event_competition_programs where event_id = pg_temp.ev(4)) = 0);
select pg_temp.chk('rls: e7 private event hidden', (select count(*) from public.event_competition_division_dances where event_id = pg_temp.ev(7)) = 0);
select pg_temp.expect_msg('rls: anon has no privilege on competitors', $q$select count(*) from public.event_competition_competitors$q$, 'permission denied');
reset role;

select pg_temp.expect_msg('start: closed window e5 -> COMP10C_CLOSED',
  $q$select pg_temp.start(pg_temp.ev(5), pg_temp.req(9002), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A')),
     jsonb_build_array(pg_temp.entry('x', 5, 2, 2, '["a"]', '{"a":"dancer"}'))))$q$, 'COMP10C_CLOSED');
select pg_temp.expect_msg('start: future window e6 -> COMP10C_CLOSED',
  $q$select pg_temp.start(pg_temp.ev(6), pg_temp.req(9003), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A')),
     jsonb_build_array(pg_temp.entry('x', 6, 2, 2, '["a"]', '{"a":"dancer"}'))))$q$, 'COMP10C_CLOSED');
select pg_temp.expect_msg('start: draft event e4 -> COMP10C_CLOSED',
  $q$select pg_temp.start(pg_temp.ev(4), pg_temp.req(9004), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A')),
     jsonb_build_array(pg_temp.entry('x', 4, 2, 2, '["a"]', '{"a":"dancer"}'))))$q$, 'COMP10C_CLOSED');
select pg_temp.expect_msg('start: private event e7 -> COMP10C_CLOSED',
  $q$select pg_temp.start(pg_temp.ev(7), pg_temp.req(9005), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A')),
     jsonb_build_array(pg_temp.entry('x', 7, 2, 2, '["a"]', '{"a":"dancer"}'))))$q$, 'COMP10C_CLOSED');

-- Server catalog == public catalog: for EVERY division of e1, "anon can see it" equals "the
-- authoritative quote accepts an entry in it".
do $$
declare
  d record;
  v_visible boolean;
  v_accepts boolean;
  v_bad text := '';
  v_contest int;
  v_q jsonb;
begin
  for d in select dv.id, dv.contest_id, c.entry_format from public.event_competition_divisions dv
           join public.event_competition_contests c on c.id = dv.contest_id where dv.event_id = pg_temp.ev(1) loop
    set local role anon;
    v_visible := exists (select 1 from public.event_competition_divisions where id = d.id);
    reset role;
    v_q := public._comp10c_quote(pg_temp.ev(1), jsonb_build_object('registrationMode', 'individual', 'buyerName', 'X', 'buyerEmail', 'x@example.test',
      'people', jsonb_build_array(pg_temp.person('a','Al','A'), pg_temp.person('b','Bo','B')),
      'entries', jsonb_build_array(jsonb_build_object('clientId', 'x', 'programId', pg_temp.cid(1, 1), 'contestId', d.contest_id,
        'divisionId', d.id, 'participantIds', '["a"]'::jsonb, 'participantRoles', '{"a":"dancer"}'::jsonb, 'selectedOfferingIds', '[]'::jsonb))), now());
    v_accepts := not (v_q->'errors' ? 'One entry references a competition option that is no longer available.');
    if v_visible is distinct from v_accepts then v_bad := v_bad || d.id::text || ' '; end if;
  end loop;
  perform pg_temp.chk('catalog parity: anon-visible divisions == divisions the authoritative quote accepts', v_bad = '', v_bad);
end $$;

-- ============================================================================
-- PRICING (authoritative SQL quote)
-- ============================================================================
insert into t_kv values ('main_draft', pg_temp.draft(
  jsonb_build_array(pg_temp.person('me', 'Sam', 'Self', '{"isSelf": true, "personType": "student"}'),
                    pg_temp.person('pro', 'Pat', 'Guestpro', '{"personType": "professional"}'),
                    pg_temp.person('jane', 'Jane', 'Doe', '{"email": "jane.doe@example.test"}')),
  jsonb_build_array(
    pg_temp.entry('proam', 1, 1, 1, '["me","pro"]', '{"me":"student","pro":"professional"}',
                  jsonb_build_array(pg_temp.cid(5, 1, 1), pg_temp.cid(5, 1, 2)), '{"participantDanceRoles":{"me":"follower","pro":"leader"}}'),
    pg_temp.entry('solo', 1, 2, 2, '["me"]', '{"me":"dancer"}'),
    pg_temp.entry('jj', 1, 3, 3, '["me"]', '{"me":"dancer"}', '[]', '{"participantDanceRoles":{"me":"leader"}}')),
  't-p10c-verified@example.test'));

select pg_temp.chk('pricing: per-dance + per-entry + 3% fee - early bird = 103.30 now',
  (public._comp10c_quote(pg_temp.ev(1), (select v from t_kv where k = 'main_draft'), now())->>'total_cents')::bigint = 10330,
  public._comp10c_quote(pg_temp.ev(1), (select v from t_kv where k = 'main_draft'), now())::text);
select pg_temp.chk('pricing: per-dance lines are the offering fees (25 + 30)',
  (select sum((l->>'lineCents')::bigint) from jsonb_array_elements(public._comp10c_quote(pg_temp.ev(1), (select v from t_kv where k = 'main_draft'), now())->'lines') l
   where l->>'lineType' = 'dance') = 5500);
select pg_temp.chk('pricing: window transition -> after early bird ends the late fee applies (128.75)',
  (public._comp10c_quote(pg_temp.ev(1), (select v from t_kv where k = 'main_draft'), now() + interval '2 hours')->>'total_cents')::bigint = 12875);
select pg_temp.chk('pricing: before every window only the service fee applies (113.30)',
  (public._comp10c_quote(pg_temp.ev(1), (select v from t_kv where k = 'main_draft'), now() - interval '2 days')->>'total_cents')::bigint = 11330);
select pg_temp.chk('pricing: client-submitted totals/lines/prices are ignored',
  (public._comp10c_quote(pg_temp.ev(1), (select v from t_kv where k = 'main_draft')
     || '{"total": 1, "quote": {"total": 0.01}, "lines": [{"lineCents": 1}]}'::jsonb, now())->>'total_cents')::bigint = 10330);
select pg_temp.chk('pricing: offering from a closed division is not accepted',
  not (public._comp10c_quote(pg_temp.ev(1), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A'), pg_temp.person('b','Bo','B')),
       jsonb_build_array(pg_temp.entry('x', 1, 1, 1, '["a","b"]', '{"a":"student","b":"professional"}', jsonb_build_array(pg_temp.cid(5, 1, 3)), '{"participantDanceRoles":{"a":"follower","b":"leader"}}'))), now())->>'valid')::boolean);
select pg_temp.chk('pricing: inactive offering is not priced',
  (public._comp10c_quote(pg_temp.ev(1), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A'), pg_temp.person('b','Bo','B')),
       jsonb_build_array(pg_temp.entry('x', 1, 1, 1, '["a","b"]', '{"a":"student","b":"professional"}',
         jsonb_build_array(pg_temp.cid(5, 1, 1), pg_temp.cid(5, 1, 4)), '{"participantDanceRoles":{"a":"follower","b":"leader"}}'))), now())->>'subtotal_cents')::bigint = 2575);
select pg_temp.chk('pricing: other event''s division is rejected',
  public._comp10c_quote(pg_temp.ev(1), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A')),
    jsonb_build_array(pg_temp.entry('x', 2, 2, 2, '["a"]', '{"a":"dancer"}'))), now())->'errors' ? 'One entry references a competition option that is no longer available.');
select pg_temp.chk('pricing: ProAm role validation rejects leader/follower',
  not (public._comp10c_quote(pg_temp.ev(1), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A'), pg_temp.person('b','Bo','B')),
    jsonb_build_array(pg_temp.entry('x', 1, 1, 1, '["a","b"]', '{"a":"leader","b":"follower"}', jsonb_build_array(pg_temp.cid(5, 1, 1))))), now())->>'valid')::boolean);
select pg_temp.chk('pricing: J&J requires a declared leader/follower role',
  not (public._comp10c_quote(pg_temp.ev(1), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A')),
    jsonb_build_array(pg_temp.entry('x', 1, 3, 3, '["a"]', '{"a":"dancer"}'))), now())->>'valid')::boolean);
select pg_temp.chk('pricing: team requires a team name',
  not (public._comp10c_quote(pg_temp.ev(1), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A'), pg_temp.person('b','Bo','B')),
    jsonb_build_array(pg_temp.entry('x', 1, 4, 4, '["a","b"]', '{"a":"team_member","b":"team_member"}'))), now())->>'valid')::boolean);

-- ============================================================================
-- START: identity, idempotency, transaction
-- ============================================================================
select pg_temp.expect_msg('identity: unverified account cannot bind "this is me"',
  $q$select pg_temp.start(pg_temp.ev(1), pg_temp.req(10), (select v from t_kv where k = 'main_draft'), pg_temp.u('0c10c0000003'))$q$,
  'COMP10C_IDENTITY_UNVERIFIED');
update public.events set account_required_for_registration = true where id = pg_temp.ev(1);
select pg_temp.expect_msg('identity: account-required event refuses an anonymous registration',
  $q$select pg_temp.start(pg_temp.ev(1), pg_temp.req(13), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A')),
     jsonb_build_array(pg_temp.entry('x', 1, 2, 2, '["a"]', '{"a":"dancer"}'))))$q$, 'COMP10C_SIGN_IN_REQUIRED: sign in before');
update public.events set account_required_for_registration = false where id = pg_temp.ev(1);
select pg_temp.expect_msg('identity: anonymous cannot bind "this is me"',
  $q$select pg_temp.start(pg_temp.ev(1), pg_temp.req(11), (select v from t_kv where k = 'main_draft'), null)$q$,
  'COMP10C_SIGN_IN_REQUIRED');
select pg_temp.chk('transaction: failed START left no cart/order/competitor/entry',
  pg_temp.n($q$select count(*) from public.event_competition_registration_carts where event_id = pg_temp.ev(1)$q$) = 0
  and pg_temp.n($q$select count(*) from public.event_orders where event_id = pg_temp.ev(1)$q$) = 0
  and pg_temp.n($q$select count(*) from public.event_competition_competitors where event_id = pg_temp.ev(1)$q$) = 0
  and pg_temp.n($q$select count(*) from public.event_competition_entries where event_id = pg_temp.ev(1)$q$) = 0);

select pg_temp.expect_ok('start: verified buyer registers 3 entries',
  $q$insert into t_kv values ('r1', pg_temp.start(pg_temp.ev(1), pg_temp.req(1), (select v from t_kv where k = 'main_draft'), pg_temp.u('0c10c0000002')))$q$);
select pg_temp.chk('start: pending order with the authoritative total and no session',
  (select (v->>'total_cents')::bigint = 10330 and v->>'order_status' = 'pending' and not (v->>'replay')::boolean
          and (v->>'entry_count')::int = 3 and v->>'checkout_session_id' is null from t_kv where k = 'r1'),
  (select v::text from t_kv where k = 'r1'));
select pg_temp.chk('identity: self competitor anchored to verified user + linked client',
  exists (select 1 from public.event_competition_competitors where event_id = pg_temp.ev(1)
          and user_id = pg_temp.u('0c10c0000002') and client_id = pg_temp.u('0c10c000c001') and email = 't-p10c-verified@example.test'));
select pg_temp.chk('identity: buyer association kept on registration (user_id + linked client_id)',
  exists (select 1 from public.event_registrations where id = ((select v from t_kv where k = 'r1')->>'registration_id')::uuid
          and user_id = pg_temp.u('0c10c0000002') and client_id = pg_temp.u('0c10c000c001')));
select pg_temp.chk('identity: guest with a client''s email is NOT linked to that client',
  exists (select 1 from public.event_competition_competitors where event_id = pg_temp.ev(1) and first_name = 'Jane'
          and client_id is null and user_id is null));
select pg_temp.chk('competitor: one competitor for "me" across ProAm + Solo + J&J (3 participant rows)',
  pg_temp.n($q$select count(*) from public.event_competition_entry_participants p join public.event_competition_competitors c on c.id = p.competitor_id
               where c.user_id = '00000000-0000-0000-0000-0c10c0000002' and c.event_id = pg_temp.ev(1)$q$) = 3
  and pg_temp.n($q$select count(*) from public.event_competition_competitors where event_id = pg_temp.ev(1)$q$) = 3);
select pg_temp.chk('participants: participant client_id mirrors the competitor anchor',
  not exists (select 1 from public.event_competition_entry_participants p join public.event_competition_competitors c on c.id = p.competitor_id
              where p.event_id = pg_temp.ev(1) and p.client_id is distinct from c.client_id));
select pg_temp.chk('roles: ProAm student/professional, J&J lead stored as dance_role (10C.4)',
  exists (select 1 from public.event_competition_entry_participants where event_id = pg_temp.ev(1) and participant_role = 'professional')
  and exists (select 1 from public.event_competition_entry_participants where event_id = pg_temp.ev(1) and participant_role = 'dancer' and dance_role = 'leader'));
select pg_temp.chk('roles: ProAm student follows / pro leads stored as dance_role; cart rows carry the same split (10C.4)',
  exists (select 1 from public.event_competition_entry_participants where event_id = pg_temp.ev(1) and participant_role = 'student' and dance_role = 'follower')
  and exists (select 1 from public.event_competition_entry_participants where event_id = pg_temp.ev(1) and participant_role = 'professional' and dance_role = 'leader')
  and exists (select 1 from public.event_competition_registration_cart_entry_people where event_id = pg_temp.ev(1) and participant_role = 'dancer' and dance_role = 'leader')
  and not exists (select 1 from public.event_competition_entry_participants where event_id = pg_temp.ev(1) and participant_role in ('leader', 'follower')));
select pg_temp.chk('dances: entry dances carry the real offering key/label/fee (no placeholders)',
  not exists (select 1 from public.event_competition_entry_dances d join public.event_competition_entries e on e.id = d.entry_id
              where e.event_id = pg_temp.ev(1) and (d.dance_key in ('offering', 'pending') or d.dance_label in ('Offering', 'Pending')))
  and pg_temp.n($q$select count(*) from public.event_competition_entry_dances d join public.event_competition_entries e on e.id = d.entry_id
                 where e.event_id = pg_temp.ev(1) and d.dance_key = 'smooth_foxtrot' and d.fee_amount = 30$q$) = 1);
select pg_temp.chk('mapping: one order, one registration, one competition_entry item per entry linked both ways',
  pg_temp.n($q$select count(*) from public.event_order_items where order_id = ((select v from t_kv where k='r1')->>'order_id')::uuid and item_type = 'competition_entry'$q$) = 3
  and not exists (select 1 from public.event_competition_entries e join public.event_order_items oi on oi.id = e.order_item_id
                  where e.order_id = ((select v from t_kv where k='r1')->>'order_id')::uuid and oi.reference_id <> e.id)
  and pg_temp.n($q$select count(*) from public.event_competition_entries where order_id = ((select v from t_kv where k='r1')->>'order_id')::uuid and order_item_id is not null$q$) = 3
  and pg_temp.n($q$select count(*) from public.event_registrations where order_id = ((select v from t_kv where k='r1')->>'order_id')::uuid$q$) = 1);
select pg_temp.chk('mapping: one admission attendee per competitor (role competitor), separate from competitor identity',
  pg_temp.n($q$select count(*) from public.event_registration_attendees where registration_id = ((select v from t_kv where k='r1')->>'registration_id')::uuid and attendee_role = 'competitor'$q$) = 3);
select pg_temp.chk('snapshot: price lines persisted with window metadata; items reconcile to total',
  pg_temp.n($q$select count(*) from public.event_competition_registration_cart_price_lines where cart_id = ((select v from t_kv where k='r1')->>'cart_id')::uuid$q$) = 6
  and exists (select 1 from public.event_competition_registration_cart_price_lines where cart_id = ((select v from t_kv where k='r1')->>'cart_id')::uuid
              and line_type = 'discount' and metadata->>'endsAt' is not null)
  and (select round(sum(total_price) * 100) - 1000 from public.event_order_items where order_id = ((select v from t_kv where k='r1')->>'order_id')::uuid) = 10330
  and (select (metadata->'price_snapshot'->>'total_cents')::bigint from public.event_orders where id = ((select v from t_kv where k='r1')->>'order_id')::uuid) = 10330);
select pg_temp.chk('accounting: nothing posted before payment',
  pg_temp.n($q$select count(*) from public.accounting_entries where event_id = pg_temp.ev(1)$q$) = 0);

-- Replay
select pg_temp.expect_ok('idempotency: same key + same payload replays',
  $q$insert into t_kv values ('r1b', pg_temp.start(pg_temp.ev(1), pg_temp.req(1), (select v from t_kv where k = 'main_draft'), pg_temp.u('0c10c0000002')))$q$);
select pg_temp.chk('idempotency: replay returns the same order and creates nothing',
  (select (v->>'replay')::boolean and v->>'order_id' = (select v->>'order_id' from t_kv where k = 'r1') from t_kv where k = 'r1b')
  and pg_temp.n($q$select count(*) from public.event_orders where event_id = pg_temp.ev(1)$q$) = 1
  and pg_temp.n($q$select count(*) from public.event_competition_registration_carts where event_id = pg_temp.ev(1)$q$) = 1
  and pg_temp.n($q$select count(*) from public.event_registrations where event_id = pg_temp.ev(1)$q$) = 1
  and pg_temp.n($q$select count(*) from public.event_competition_competitors where event_id = pg_temp.ev(1)$q$) = 3
  and pg_temp.n($q$select count(*) from public.event_competition_entries where event_id = pg_temp.ev(1)$q$) = 3
  and pg_temp.n($q$select count(*) from public.event_registration_attendees where event_id = pg_temp.ev(1)$q$) = 3);
select pg_temp.expect_msg('idempotency: same key + different payload rejected',
  $q$select pg_temp.start(pg_temp.ev(1), pg_temp.req(1), (select v from t_kv where k = 'main_draft') || '{"buyerName": "Someone Else"}', pg_temp.u('0c10c0000002'))$q$,
  'COMP10C_IDEMPOTENCY_CONFLICT');
select pg_temp.expect_msg('idempotency: same key + different actor rejected',
  $q$select pg_temp.start(pg_temp.ev(1), pg_temp.req(1), (select v from t_kv where k = 'main_draft'), pg_temp.u('0c10c0000006'))$q$,
  'COMP10C_IDEMPOTENCY_CONFLICT');
select pg_temp.expect_msg('idempotency: database refuses a second cart with the same (event, request)',
  $q$insert into public.event_competition_registration_carts (event_id, registration_mode, client_request_id, request_fingerprint)
     values (pg_temp.ev(1), 'individual', pg_temp.req(1), 'x')$q$, 'duplicate key');

-- Stale quote / window moved: the replay keeps its snapshot, a NEW request uses the current price.
update public.event_competition_fee_rules set starts_at = now() - interval '3 days', ends_at = now() - interval '2 days' where id = pg_temp.cid(7, 1, 1);
update public.event_competition_fee_rules set starts_at = now() - interval '2 days' where id = pg_temp.cid(7, 1, 2);
select pg_temp.expect_ok('stale: replay after the early-bird window closed',
  $q$insert into t_kv values ('r1c', pg_temp.start(pg_temp.ev(1), pg_temp.req(1), (select v from t_kv where k = 'main_draft'), pg_temp.u('0c10c0000002')))$q$);
select pg_temp.chk('stale: replay keeps the ORIGINAL snapshot price (103.30)',
  (select (v->>'total_cents')::bigint from t_kv where k = 'r1c') = 10330);
select pg_temp.expect_ok('stale: a new request after the window change',
  $q$insert into t_kv values ('r2', pg_temp.start(pg_temp.ev(1), pg_temp.req(2), (select v from t_kv where k = 'main_draft'), pg_temp.u('0c10c0000002')))$q$);
select pg_temp.chk('stale: the new request is priced with the CURRENT window (late fee, no early bird = 128.75)',
  (select (v->>'total_cents')::bigint from t_kv where k = 'r2') = 12875, (select v::text from t_kv where k = 'r2'));
select pg_temp.chk('identity: second order by the same verified person reuses the same competitor',
  pg_temp.n($q$select count(*) from public.event_competition_competitors where event_id = pg_temp.ev(1) and user_id = '00000000-0000-0000-0000-0c10c0000002'$q$) = 1);
select pg_temp.chk('identity: guests are never merged (same name+email in two orders = two competitors)',
  pg_temp.n($q$select count(*) from public.event_competition_competitors where event_id = pg_temp.ev(1) and first_name = 'Jane' and last_name = 'Doe'$q$) = 2);
-- restore early-bird window for later checks
update public.event_competition_fee_rules set starts_at = now() - interval '1 day', ends_at = now() + interval '1 hour' where id = pg_temp.cid(7, 1, 1);
update public.event_competition_fee_rules set starts_at = now() + interval '1 hour' where id = pg_temp.cid(7, 1, 2);

select pg_temp.expect_msg('identity: same guest twice in ONE roster is two people unless anchored (duplicate anchored person rejected)',
  $q$select pg_temp.start(pg_temp.ev(1), pg_temp.req(3), pg_temp.draft(
       jsonb_build_array(pg_temp.person('a', 'Pat', 'Pro', '{"anchorInstructorId": "00000000-0000-0000-0000-0c10c000d001"}'),
                         pg_temp.person('b', 'Pat', 'Pro', '{"anchorInstructorId": "00000000-0000-0000-0000-0c10c000d001"}')),
       jsonb_build_array(pg_temp.entry('x', 1, 2, 2, '["a"]', '{"a":"dancer"}'))), pg_temp.u('0c10c0000001'))$q$,
  'COMP10C_DUPLICATE_PERSON');
select pg_temp.expect_ok('identity: same name/email guests in one roster -> two competitors',
  $q$insert into t_kv values ('r4', pg_temp.start(pg_temp.ev(1), pg_temp.req(4), pg_temp.draft(
       jsonb_build_array(pg_temp.person('a', 'Twin', 'Same', '{"email": "twin@example.test"}'),
                         pg_temp.person('b', 'Twin', 'Same', '{"email": "twin@example.test"}')),
       jsonb_build_array(pg_temp.entry('x', 1, 2, 2, '["a"]', '{"a":"dancer"}'), pg_temp.entry('y', 1, 2, 2, '["b"]', '{"b":"dancer"}')))))$q$);
select pg_temp.chk('identity: twins not merged', pg_temp.n($q$select count(*) from public.event_competition_competitors where event_id = pg_temp.ev(1) and first_name = 'Twin'$q$) = 2);

-- Studio-side registration: manager anchors the studio's own instructor (ProAm professional)
select pg_temp.expect_ok('proam: manager registers two students with the studio professional',
  $q$insert into t_kv values ('r5', pg_temp.start(pg_temp.ev(1), pg_temp.req(5), pg_temp.draft(
       jsonb_build_array(pg_temp.person('pro', 'Pat', 'Pro', '{"anchorInstructorId": "00000000-0000-0000-0000-0c10c000d001", "personType": "professional"}'),
                         pg_temp.person('s1', 'Stu', 'One', '{"anchorClientId": "00000000-0000-0000-0000-0c10c000c002", "personType": "student"}'),
                         pg_temp.person('s2', 'Stu', 'Two', '{"personType": "student"}')),
       jsonb_build_array(
         pg_temp.entry('e1', 1, 1, 1, '["s1","pro"]', '{"s1":"student","pro":"professional"}', jsonb_build_array(pg_temp.cid(5, 1, 1)), '{"participantDanceRoles":{"s1":"follower","pro":"leader"}}'),
         pg_temp.entry('e2', 1, 1, 1, '["s2","pro"]', '{"s2":"student","pro":"professional"}', jsonb_build_array(pg_temp.cid(5, 1, 2)), '{"participantDanceRoles":{"s2":"follower","pro":"leader"}}')),
       'owner-a@example.test', '{"registrationMode": "studio", "registeringStudioName": "P10C Studio A"}'), pg_temp.u('0c10c0000001')))$q$);
select pg_temp.expect_ok('proam: a later order with the same professional',
  $q$insert into t_kv values ('r6', pg_temp.start(pg_temp.ev(1), pg_temp.req(6), pg_temp.draft(
       jsonb_build_array(pg_temp.person('pro', 'Pat', 'Pro', '{"anchorInstructorId": "00000000-0000-0000-0000-0c10c000d001"}'),
                         pg_temp.person('s3', 'Stu', 'Three')),
       jsonb_build_array(pg_temp.entry('e1', 1, 1, 1, '["s3","pro"]', '{"s3":"student","pro":"professional"}', jsonb_build_array(pg_temp.cid(5, 1, 1)), '{"participantDanceRoles":{"s3":"follower","pro":"leader"}}'))),
       pg_temp.u('0c10c0000001')))$q$);
select pg_temp.chk('proam: the professional is ONE competitor referenced by 3 entries across 2 orders',
  pg_temp.n($q$select count(*) from public.event_competition_competitors where event_id = pg_temp.ev(1) and instructor_id = '00000000-0000-0000-0000-0c10c000d001'$q$) = 1
  and pg_temp.n($q$select count(distinct p.entry_id) from public.event_competition_entry_participants p join public.event_competition_competitors c on c.id = p.competitor_id
                 where c.instructor_id = '00000000-0000-0000-0000-0c10c000d001' and c.event_id = pg_temp.ev(1)$q$) = 3);
select pg_temp.expect_msg('identity: non-manager cannot anchor a studio client',
  $q$select pg_temp.start(pg_temp.ev(1), pg_temp.req(7), pg_temp.draft(
       jsonb_build_array(pg_temp.person('a', 'Jane', 'Doe', '{"anchorClientId": "00000000-0000-0000-0000-0c10c000c002"}')),
       jsonb_build_array(pg_temp.entry('x', 1, 2, 2, '["a"]', '{"a":"dancer"}'))), pg_temp.u('0c10c0000006'))$q$,
  'COMP10C_FORBIDDEN');
select pg_temp.expect_msg('identity: cross-studio client anchor rejected',
  $q$select pg_temp.start(pg_temp.ev(1), pg_temp.req(8), pg_temp.draft(
       jsonb_build_array(pg_temp.person('a', 'Bob', 'Other', '{"anchorClientId": "00000000-0000-0000-0000-0c10c000c003"}')),
       jsonb_build_array(pg_temp.entry('x', 1, 2, 2, '["a"]', '{"a":"dancer"}'))), pg_temp.u('0c10c0000001'))$q$,
  'COMP10C_ANCHOR_CROSS_STUDIO');
select pg_temp.expect_msg('identity: cross-studio instructor anchor rejected',
  $q$select pg_temp.start(pg_temp.ev(1), pg_temp.req(12), pg_temp.draft(
       jsonb_build_array(pg_temp.person('a', 'Olga', 'Other', '{"anchorInstructorId": "00000000-0000-0000-0000-0c10c000d002"}')),
       jsonb_build_array(pg_temp.entry('x', 1, 2, 2, '["a"]', '{"a":"dancer"}'))), pg_temp.u('0c10c0000001'))$q$,
  'COMP10C_ANCHOR_CROSS_STUDIO');
select pg_temp.chk('transaction: the cross-studio failures created nothing',
  pg_temp.n($q$select count(*) from public.event_competition_registration_carts where event_id = pg_temp.ev(1) and client_request_id in (pg_temp.req(7), pg_temp.req(8), pg_temp.req(12))$q$) = 0
  and pg_temp.n($q$select count(*) from public.event_competition_competitors where first_name in ('Bob', 'Olga')$q$) = 0);

-- Separate event: separate competitor
select pg_temp.expect_ok('identity: same verified person at e2',
  $q$insert into t_kv values ('r20', pg_temp.start(pg_temp.ev(2), pg_temp.req(20), pg_temp.draft(
       jsonb_build_array(pg_temp.person('me', 'Sam', 'Self', '{"isSelf": true}')),
       jsonb_build_array(pg_temp.entry('x', 2, 2, 2, '["me"]', '{"me":"dancer"}'))), pg_temp.u('0c10c0000002')))$q$);
select pg_temp.chk('identity: separate event -> separate competitor for the same user',
  pg_temp.n($q$select count(*) from public.event_competition_competitors where user_id = '00000000-0000-0000-0000-0c10c0000002'$q$) = 2
  and pg_temp.n($q$select count(distinct event_id) from public.event_competition_competitors where user_id = '00000000-0000-0000-0000-0c10c0000002'$q$) = 2);
select pg_temp.expect_msg('fk: participant cannot reference a competitor of another event',
  $q$insert into public.event_competition_entry_participants (event_id, entry_id, competitor_id, participant_role, display_name)
     select pg_temp.ev(1), e.id, (select id from public.event_competition_competitors where event_id = pg_temp.ev(2) limit 1), 'dancer', 'X'
     from public.event_competition_entries e where e.event_id = pg_temp.ev(1) limit 1$q$, 'COMP10C_COMPETITOR_EVENT_MISMATCH');
select pg_temp.expect_msg('fk: competitor cannot move events',
  $q$update public.event_competition_competitors set event_id = pg_temp.ev(2) where event_id = pg_temp.ev(1) and user_id is not null$q$,
  'COMP10C_COMPETITOR_EVENT_IMMUTABLE');
select pg_temp.expect_msg('identity: anchors are immutable once set',
  $q$update public.event_competition_competitors set client_id = '00000000-0000-0000-0000-0c10c000c002' where event_id = pg_temp.ev(1) and user_id is not null$q$,
  'COMP10C_ANCHOR_IMMUTABLE');
select pg_temp.expect_msg('identity: user anchor is immutable once set',
  $q$update public.event_competition_competitors set user_id = '00000000-0000-0000-0000-0c10c0000006' where event_id = pg_temp.ev(1) and user_id is not null$q$,
  'COMP10C_ANCHOR_IMMUTABLE');
select pg_temp.expect_msg('identity: instructor anchor is immutable once set',
  $q$update public.event_competition_competitors set instructor_id = null where event_id = pg_temp.ev(1) and instructor_id is not null$q$,
  'COMP10C_ANCHOR_IMMUTABLE');
select pg_temp.expect_msg('identity: direct competitor with a cross-studio client rejected',
  $q$insert into public.event_competition_competitors (event_id, studio_id, client_id, first_name) values
     (pg_temp.ev(1), '00000000-0000-0000-0000-0c10c000a001', '00000000-0000-0000-0000-0c10c000c003', 'Bob')$q$,
  'COMP10C_ANCHOR_CROSS_STUDIO');

-- Legacy/staff participant inserts resolve to the canonical competitor.
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status)
values (pg_temp.u('0c10c0009001'), pg_temp.ev(1), pg_temp.cid(1, 1), pg_temp.cid(3, 1, 2), 'Staff entry 1', 'pending'),
       (pg_temp.u('0c10c0009002'), pg_temp.ev(1), pg_temp.cid(1, 1), pg_temp.cid(3, 1, 2), 'Staff entry 2', 'pending');
select pg_temp.as_user(pg_temp.u('0c10c0000001'));
select pg_temp.expect_ok('staff: manager inserts participants by client anchor (no competitor id)',
  $q$insert into public.event_competition_entry_participants (event_id, entry_id, client_id, participant_role, display_name) values
     (pg_temp.ev(1), '00000000-0000-0000-0000-0c10c0009001', '00000000-0000-0000-0000-0c10c000c002', 'dancer', 'Jane Doe'),
     (pg_temp.ev(1), '00000000-0000-0000-0000-0c10c0009002', '00000000-0000-0000-0000-0c10c000c002', 'dancer', 'Jane Doe')$q$);
select pg_temp.chk('staff: manager can read own event competitors', (select count(*) from public.event_competition_competitors where event_id = pg_temp.ev(1)) > 0);
select pg_temp.expect_ok('staff: manager may set a bib number', $q$update public.event_competition_competitors set bib_number = '101' where event_id = pg_temp.ev(1) and user_id is not null$q$);
select pg_temp.expect_msg('staff: manager cannot rewrite competitor anchors directly',
  $q$update public.event_competition_competitors set user_id = null where event_id = pg_temp.ev(1)$q$, 'permission denied');
reset role;
select pg_temp.chk('staff: both legacy rows resolved to the same anchored competitor (the r5 student)',
  pg_temp.n($q$select count(distinct competitor_id) from public.event_competition_entry_participants where entry_id in ('00000000-0000-0000-0000-0c10c0009001', '00000000-0000-0000-0000-0c10c0009002')$q$) = 1
  and pg_temp.n($q$select count(*) from public.event_competition_competitors where event_id = pg_temp.ev(1) and client_id = '00000000-0000-0000-0000-0c10c000c002'$q$) = 1);
select pg_temp.as_user(pg_temp.u('0c10c0000004'));
select pg_temp.chk('rls: other studio owner cannot read e1 competitors', (select count(*) from public.event_competition_competitors where event_id = pg_temp.ev(1)) = 0);
reset role;
select pg_temp.as_user(pg_temp.u('0c10c0000005'));
select pg_temp.chk('rls: unrelated user cannot read competitors/carts', (select count(*) from public.event_competition_competitors) = 0
  and (select count(*) from public.event_competition_registration_carts) = 0);
reset role;

-- ============================================================================
-- PAYMENT: prepare / attach / finalize / release
-- ============================================================================
insert into t_kv select 'o1', jsonb_build_object('id', v->>'order_id', 'reg', v->>'registration_id') from t_kv where k = 'r1';
select pg_temp.expect_ok('prepare: payable order', $q$insert into t_kv values ('p1', public.prepare_competition_registration_payment(((select v from t_kv where k='o1')->>'id')::uuid))$q$);
select pg_temp.chk('prepare: returns snapshot amount and >= 31 minute window', (select (v->>'amount_cents')::bigint = 10330 and v->>'state' = 'payable'
  and (v->>'expires_at')::timestamptz >= now() + interval '31 minutes' from t_kv where k = 'p1'));
select pg_temp.expect_msg('attach: wrong connected account rejected',
  $q$select public.attach_competition_registration_checkout(((select v from t_kv where k='o1')->>'id')::uuid, 'acct_p10cStudioB', 'cs_test_p10c_1', now() + interval '35 minutes')$q$,
  'COMP10C_BINDING_INVALID');
select pg_temp.expect_msg('attach: checkout expiry beyond the hold rejected',
  $q$select public.attach_competition_registration_checkout(((select v from t_kv where k='o1')->>'id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_1', now() + interval '3 hours')$q$,
  'COMP10C_BINDING_INVALID');
select pg_temp.expect_ok('attach: studio account + session bound',
  $q$select public.attach_competition_registration_checkout(((select v from t_kv where k='o1')->>'id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_1', now() + interval '35 minutes')$q$);
select pg_temp.chk('attach: same binding replays', (pg_temp.try_jsonb($w$select public.attach_competition_registration_checkout(((select v from t_kv where k='o1')->>'id')::uuid,
  'acct_p10cStudioA', 'cs_test_p10c_1', now() + interval '35 minutes')$w$)->>'replay')::boolean);
select pg_temp.expect_msg('attach: a different session cannot replace the bound one',
  $q$select public.attach_competition_registration_checkout(((select v from t_kv where k='o1')->>'id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_other', now() + interval '35 minutes')$q$,
  'COMP10C_BINDING_CONFLICT');
select pg_temp.expect_msg('attach: a session bound to another order cannot be attached',
  $q$select public.attach_competition_registration_checkout(((select v from t_kv where k='r2')->>'order_id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_1', now() + interval '35 minutes')$q$,
  'COMP10C_BINDING_CONFLICT');
select pg_temp.chk('browser success alone: order still pending/unpaid, entries pending',
  (select status = 'pending' and payment_status = 'pending' from public.event_orders where id = ((select v from t_kv where k='o1')->>'id')::uuid)
  and not exists (select 1 from public.event_competition_entries where order_id = ((select v from t_kv where k='o1')->>'id')::uuid and status <> 'pending'));
select pg_temp.expect_msg('finalize: unrelated session rejected',
  $q$select public.finalize_competition_registration(((select v from t_kv where k='o1')->>'id')::uuid, 'acct_p10cStudioA', 'cs_test_forged', 'pi_test_p10c_1', 10330, 'usd')$q$,
  'COMP10C_BINDING_MISMATCH');
select pg_temp.expect_msg('finalize: wrong connected account rejected',
  $q$select public.finalize_competition_registration(((select v from t_kv where k='o1')->>'id')::uuid, 'acct_p10cStudioB', 'cs_test_p10c_1', 'pi_test_p10c_1', 10330, 'usd')$q$,
  'COMP10C_BINDING_MISMATCH');
select pg_temp.expect_msg('finalize: manipulated amount rejected',
  $q$select public.finalize_competition_registration(((select v from t_kv where k='o1')->>'id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_1', 'pi_test_p10c_1', 1, 'usd')$q$,
  'COMP10C_AMOUNT_MISMATCH');
select pg_temp.expect_msg('finalize: free-path call on a paid order rejected (no settlement evidence)',
  $q$select public.finalize_competition_registration(((select v from t_kv where k='o1')->>'id')::uuid, null, null, null, null, null)$q$,
  'COMP10C_SETTLEMENT_REQUIRED');
select pg_temp.chk('finalize: correct evidence finalizes',
  pg_temp.try_jsonb($w$select public.finalize_competition_registration(((select v from t_kv where k='o1')->>'id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_1', 'pi_test_p10c_1', 10330, 'usd')$w$)->>'outcome' = 'finalized');
select pg_temp.chk('finalize: order/registration confirmed+paid, entries + dances confirmed, cart submitted',
  (select status = 'confirmed' and payment_status = 'paid' from public.event_orders where id = ((select v from t_kv where k='o1')->>'id')::uuid)
  and (select status = 'confirmed' and payment_status = 'paid' from public.event_registrations where id = ((select v from t_kv where k='o1')->>'reg')::uuid)
  and not exists (select 1 from public.event_competition_entries where order_id = ((select v from t_kv where k='o1')->>'id')::uuid and status <> 'confirmed')
  and not exists (select 1 from public.event_competition_entry_dances d join public.event_competition_entries e on e.id = d.entry_id
                  where e.order_id = ((select v from t_kv where k='o1')->>'id')::uuid and d.status <> 'confirmed')
  and (select status from public.event_competition_registration_carts where order_id = ((select v from t_kv where k='o1')->>'id')::uuid) = 'submitted');
select pg_temp.chk('finalize: replay is idempotent',
  pg_temp.try_jsonb($w$select public.finalize_competition_registration(((select v from t_kv where k='o1')->>'id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_1', 'pi_test_p10c_1', 10330, 'usd')$w$)->>'outcome' = 'already_finalized');
select pg_temp.chk('payment: exactly one event_payment row with provider ids and account',
  pg_temp.n($q$select count(*) from public.event_payments where registration_id = ((select v from t_kv where k='o1')->>'reg')::uuid$q$) = 1
  and exists (select 1 from public.event_payments where registration_id = ((select v from t_kv where k='o1')->>'reg')::uuid
              and amount = 103.30 and stripe_account_id = 'acct_p10cStudioA' and stripe_payment_intent_id = 'pi_test_p10c_1'));
select pg_temp.expect_msg('payment: database refuses a duplicate (registration, session) payment row',
  $q$insert into public.event_payments (registration_id, amount, currency, payment_method, status, source, stripe_checkout_session_id)
     values (((select v from t_kv where k='o1')->>'reg')::uuid, 103.30, 'USD', 'stripe_checkout', 'paid', 'stripe', 'cs_test_p10c_1')$q$, 'duplicate key');
select pg_temp.expect_msg('payment: database refuses a duplicate (registration, payment intent) row',
  $q$insert into public.event_payments (registration_id, amount, currency, payment_method, status, source, stripe_payment_intent_id)
     values (((select v from t_kv where k='o1')->>'reg')::uuid, 103.30, 'USD', 'stripe_checkout', 'paid', 'stripe', 'pi_test_p10c_1')$q$, 'duplicate key');
select pg_temp.chk('release: a paid order is never released',
  pg_temp.try_jsonb($w$select public.release_competition_registration(((select v from t_kv where k='o1')->>'id')::uuid, 'expired')$w$)->>'outcome' = 'already_paid'
  and (select status from public.event_orders where id = ((select v from t_kv where k='o1')->>'id')::uuid) = 'confirmed');

-- accounting
select pg_temp.chk('accounting: competition payment posts competition_entry_revenue for the full amount',
  exists (select 1 from public.accounting_entries where source_table = 'event_payments' and category = 'competition_entry_revenue'
          and entry_status = 'active' and gross_amount = 103.30
          and source_id in (select id from public.event_payments where registration_id = ((select v from t_kv where k='o1')->>'reg')::uuid))
  and not exists (select 1 from public.accounting_entries where source_table = 'event_payments' and category = 'event_ticket_revenue'
          and source_id in (select id from public.event_payments where registration_id = ((select v from t_kv where k='o1')->>'reg')::uuid)));

-- Expiry: r2 order expires (webhook checkout.session.expired after attach)
select pg_temp.expect_ok('attach r2', $q$select public.attach_competition_registration_checkout(((select v from t_kv where k='r2')->>'order_id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_2', now() + interval '35 minutes')$q$);
select pg_temp.expect_msg('release: wrong session cannot release another order',
  $q$select public.release_competition_registration(((select v from t_kv where k='r2')->>'order_id')::uuid, 'expired', 'cs_test_p10c_1')$q$, 'COMP10C_BINDING_MISMATCH');
select pg_temp.expect_msg('release: wrong account cannot release',
  $q$select public.release_competition_registration(((select v from t_kv where k='r2')->>'order_id')::uuid, 'expired', 'cs_test_p10c_2', 'acct_p10cStudioB')$q$, 'COMP10C_BINDING_MISMATCH');
select pg_temp.chk('release: expired session releases the hold',
  pg_temp.try_jsonb($w$select public.release_competition_registration(((select v from t_kv where k='r2')->>'order_id')::uuid, 'expired', 'cs_test_p10c_2', 'acct_p10cStudioA')$w$)->>'outcome' = 'released');
select pg_temp.chk('release: order expired/unpaid, registration cancelled, entries withdrawn, dances scratched, cart expired',
  (select status = 'expired' and payment_status = 'unpaid' from public.event_orders where id = ((select v from t_kv where k='r2')->>'order_id')::uuid)
  and (select status from public.event_registrations where id = ((select v from t_kv where k='r2')->>'registration_id')::uuid) = 'cancelled'
  and not exists (select 1 from public.event_competition_entries where order_id = ((select v from t_kv where k='r2')->>'order_id')::uuid and status <> 'withdrawn')
  and not exists (select 1 from public.event_competition_entry_dances d join public.event_competition_entries e on e.id = d.entry_id
                  where e.order_id = ((select v from t_kv where k='r2')->>'order_id')::uuid and d.status <> 'scratched')
  and (select status from public.event_competition_registration_carts where order_id = ((select v from t_kv where k='r2')->>'order_id')::uuid) = 'expired');
select pg_temp.chk('release: replay is idempotent',
  pg_temp.try_jsonb($w$select public.release_competition_registration(((select v from t_kv where k='r2')->>'order_id')::uuid, 'expired', 'cs_test_p10c_2', 'acct_p10cStudioA')$w$)->>'outcome' = 'already_released');
select pg_temp.expect_msg('prepare: released order cannot start payment again',
  $q$select public.prepare_competition_registration_payment(((select v from t_kv where k='r2')->>'order_id')::uuid)$q$, 'COMP10C_ORDER_NOT_PAYABLE');
insert into t_kv values ('late', pg_temp.try_jsonb($w$select public.finalize_competition_registration(((select v from t_kv where k='r2')->>'order_id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_2', 'pi_test_p10c_2', 12875, 'USD')$w$));
select pg_temp.chk('late payment after release is recorded as evidence but never re-activates entries',
  (select v->>'outcome' from t_kv where k = 'late') = 'late_payment_after_release'
  and (select status = 'expired' and payment_status = 'paid' and metadata->>'needs_review' = 'late_payment_after_release'
       from public.event_orders where id = ((select v from t_kv where k='r2')->>'order_id')::uuid)
  and not exists (select 1 from public.event_competition_entries where order_id = ((select v from t_kv where k='r2')->>'order_id')::uuid and status <> 'withdrawn')
  and pg_temp.n($q$select count(*) from public.event_payments where registration_id = ((select v from t_kv where k='r2')->>'registration_id')::uuid$q$) = 1);

-- Failure: r4 (async payment failed after attach)
select pg_temp.expect_ok('attach r4', $q$select public.attach_competition_registration_checkout(((select v from t_kv where k='r4')->>'order_id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_4', now() + interval '35 minutes')$q$);
insert into t_kv values ('rel4', pg_temp.try_jsonb($w$select public.release_competition_registration(((select v from t_kv where k='r4')->>'order_id')::uuid, 'failed', 'cs_test_p10c_4', 'acct_p10cStudioA')$w$));
select pg_temp.chk('release: failed payment cancels with payment_status failed',
  (select v->>'outcome' from t_kv where k = 'rel4') = 'released'
  and (select status = 'cancelled' and payment_status = 'failed' from public.event_orders where id = ((select v from t_kv where k='r4')->>'order_id')::uuid)
  and (select payment_status from public.event_registrations where id = ((select v from t_kv where k='r4')->>'registration_id')::uuid) = 'failed'
  and not exists (select 1 from public.event_competition_entries where order_id = ((select v from t_kv where k='r4')->>'order_id')::uuid and status <> 'withdrawn'));
-- Abandoned before any session: r6
insert into t_kv values ('rel6', pg_temp.try_jsonb($w$select public.release_competition_registration(((select v from t_kv where k='r6')->>'order_id')::uuid, 'abandoned')$w$));
select pg_temp.chk('release: abandoned (no session) cancels', (select v->>'outcome' from t_kv where k = 'rel6') = 'released'
  and (select status from public.event_orders where id = ((select v from t_kv where k='r6')->>'order_id')::uuid) = 'cancelled');
select pg_temp.expect_msg('attach: released order cannot be attached', $q$select public.attach_competition_registration_checkout(((select v from t_kv where k='r6')->>'order_id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_6', now() + interval '35 minutes')$q$,
  'COMP10C_ORDER_NOT_PAYABLE');
select pg_temp.chk('accounting: released/unpaid orders posted nothing',
  pg_temp.n($q$select count(*) from public.accounting_entries a join public.event_payments p on p.id = a.source_id
             join public.event_registrations r on r.id = p.registration_id where r.order_id in (((select v from t_kv where k='r4')->>'order_id')::uuid, ((select v from t_kv where k='r6')->>'order_id')::uuid)$q$) = 0);

-- Free order without documents confirms inside START.
update public.event_competition_contest_registration_rules set base_entry_fee = 0 where contest_id = pg_temp.cid(2, 2, 2);
insert into t_kv values ('free', pg_temp.try_jsonb($w$select pg_temp.start(pg_temp.ev(2), pg_temp.req(21), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Free','Dancer')), jsonb_build_array(pg_temp.entry('x', 2, 2, 2, '["a"]', '{"a":"dancer"}'))))$w$));
select pg_temp.chk('free: zero-total registration confirms immediately with no payment row',
  (select v->>'order_status' from t_kv where k = 'free') = 'confirmed'
  and exists (select 1 from public.event_competition_entries e join public.event_competition_registration_carts c on c.order_id = e.order_id
              where c.client_request_id = pg_temp.req(21) and e.status = 'confirmed')
  and not exists (select 1 from public.event_payments p join public.event_registrations r on r.id = p.registration_id
                  join public.event_competition_registration_carts c on c.order_id = r.order_id where c.client_request_id = pg_temp.req(21)));

-- ============================================================================
-- SIGNING (Phase 8 checkpoint)
-- ============================================================================
insert into public.document_templates (id, studio_id, scope, title, body) values
  (pg_temp.u('0c10c0008001'), pg_temp.u('0c10c000a001'), 'studio', 'P10C Waiver', 'Waiver body');
insert into public.event_document_requirements (id, event_id, template_id, studio_id, is_required, active) values
  (pg_temp.u('0c10c0008101'), pg_temp.ev(2), pg_temp.u('0c10c0008001'), pg_temp.u('0c10c000a001'), true, true);
select pg_temp.expect_ok('signing: start on an event with a required waiver',
  $q$insert into t_kv values ('s1', pg_temp.start(pg_temp.ev(2), pg_temp.req(22), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Wai','Ver')),
     jsonb_build_array(pg_temp.entry('x', 2, 3, 3, '["a"]', '{"a":"dancer"}', '[]', '{"participantDanceRoles":{"a":"follower"}}')))))$q$);
select pg_temp.expect_ok('signing: second order on the same event',
  $q$insert into t_kv values ('s2', pg_temp.start(pg_temp.ev(2), pg_temp.req(23), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Oth','Er')),
     jsonb_build_array(pg_temp.entry('x', 2, 3, 3, '["a"]', '{"a":"dancer"}', '[]', '{"participantDanceRoles":{"a":"leader"}}')))))$q$);
select pg_temp.chk('signing: START marks requires_signing, stays pending, writes NO signatures/assignments',
  (select (v->>'requires_signing')::boolean and v->>'order_status' = 'pending' from t_kv where k = 's1')
  and pg_temp.n($q$select count(*) from public.document_signatures where event_id = pg_temp.ev(2)$q$) = 0
  and pg_temp.n($q$select count(*) from public.document_assignments where event_id = pg_temp.ev(2)$q$) = 0);
select pg_temp.expect_msg('signing: prepare refuses before documents are signed',
  $q$select public.prepare_competition_registration_payment(((select v from t_kv where k='s1')->>'order_id')::uuid)$q$, 'COMP10C_SIGNING_INCOMPLETE');
select pg_temp.expect_msg('signing: attach refuses before documents are signed',
  $q$select public.attach_competition_registration_checkout(((select v from t_kv where k='s1')->>'order_id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_s1', now() + interval '35 minutes')$q$,
  'COMP10C_SIGNING_INCOMPLETE');
-- Phase 8 checkpoint for s1, at ready_for_payment but the assignment is still pending.
insert into public.event_signing_checkpoints (id, order_id, event_id, studio_id, buyer_email, surface, payment_mode, status,
  requirement_ids, registration_ids, current_position, total_required, expires_at)
select pg_temp.u('0c10c0008201'), (v->>'order_id')::uuid, pg_temp.ev(2), pg_temp.u('0c10c000a001'), 'buyer@example.test', 'web', 'checkout',
  'ready_for_payment', array[pg_temp.u('0c10c0008101')], array[(v->>'registration_id')::uuid], 1, 1, now() + interval '30 minutes'
from t_kv where k = 's1';
insert into public.document_assignments (id, template_id, studio_id, event_id, event_registration_id, event_order_id,
  event_document_requirement_id, event_signing_checkpoint_id, assigned_to_email, status)
select pg_temp.u('0c10c0008301'), pg_temp.u('0c10c0008001'), pg_temp.u('0c10c000a001'), pg_temp.ev(2), (v->>'registration_id')::uuid,
  (v->>'order_id')::uuid, pg_temp.u('0c10c0008101'), pg_temp.u('0c10c0008201'), 'buyer@example.test', 'pending'
from t_kv where k = 's1';
select pg_temp.expect_msg('signing: checkpoint "ready" with an UNSIGNED assignment still blocks payment',
  $q$select public.prepare_competition_registration_payment(((select v from t_kv where k='s1')->>'order_id')::uuid)$q$, 'COMP10C_SIGNING_INCOMPLETE');
update public.document_assignments set status = 'signed', signed_at = now() where id = pg_temp.u('0c10c0008301');
select pg_temp.expect_msg('signing: a signed assignment WITHOUT a completed envelope still blocks payment',
  $q$select public.prepare_competition_registration_payment(((select v from t_kv where k='s1')->>'order_id')::uuid)$q$, 'COMP10C_SIGNING_INCOMPLETE');
insert into public.document_sign_envelopes (id, assignment_id, studio_id, title, signer_name, signer_email, status, source_path,
  source_sha256, page_count, expires_at, context_type, context_id, event_signing_checkpoint_id, event_document_requirement_id, event_order_id)
select pg_temp.u('0c10c0008401'), pg_temp.u('0c10c0008301'), pg_temp.u('0c10c000a001'), 'P10C Waiver', 'Wai Ver', 'buyer@example.test',
  'completed', 'p10c/test.pdf', repeat('a', 64), 1, now() + interval '30 minutes', 'event_checkout', pg_temp.u('0c10c0008201'),
  pg_temp.u('0c10c0008201'), pg_temp.u('0c10c0008101'), (v->>'order_id')::uuid
from t_kv where k = 's1';
select pg_temp.chk('signing: completed envelope + signed assignment permits payment',
  (pg_temp.try_jsonb($w$select public.prepare_competition_registration_payment(((select v from t_kv where k='s1')->>'order_id')::uuid)$w$)->>'state') = 'payable');
select pg_temp.expect_msg('signing: s1''s completed checkpoint does NOT satisfy order s2',
  $q$select public.prepare_competition_registration_payment(((select v from t_kv where k='s2')->>'order_id')::uuid)$q$, 'COMP10C_SIGNING_INCOMPLETE');
select pg_temp.expect_ok('signing: attach after signing', $q$select public.attach_competition_registration_checkout(((select v from t_kv where k='s1')->>'order_id')::uuid,
  'acct_p10cStudioA', 'cs_test_p10c_s1', (select (v->>'expires_at')::timestamptz from t_kv where k = 's1') )$q$);
select pg_temp.chk('signing: attach moved checkpoint to payment_started', (select status from public.event_signing_checkpoints where id = pg_temp.u('0c10c0008201')) = 'payment_started');
insert into t_kv values ('fin_s1', pg_temp.try_jsonb($w$select public.finalize_competition_registration(((select v from t_kv where k='s1')->>'order_id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_s1', 'pi_test_p10c_s1', 1500, 'USD')$w$));
select pg_temp.chk('signing: finalize after signing confirms and completes the checkpoint',
  (select v->>'outcome' from t_kv where k = 'fin_s1') = 'finalized'
  and (select status from public.event_signing_checkpoints where id = pg_temp.u('0c10c0008201')) = 'completed'
  and not exists (select 1 from public.event_competition_entries where order_id = ((select v from t_kv where k='s1')->>'order_id')::uuid and status <> 'confirmed'));
-- s2: force a bound session WITHOUT signing (simulates a bypass attempt) -> paid evidence recorded, entries NOT activated.
update public.event_orders set stripe_checkout_session_id = 'cs_test_p10c_s2', metadata = metadata || '{"stripe_account_id": "acct_p10cStudioA"}'
where id = ((select v from t_kv where k='s2')->>'order_id')::uuid;
insert into t_kv values ('fin_s2', pg_temp.try_jsonb($w$select public.finalize_competition_registration(((select v from t_kv where k='s2')->>'order_id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_s2', 'pi_test_p10c_s2', 1500, 'USD')$w$));
select pg_temp.chk('signing: payment without completed signing is recorded but does NOT finalize',
  (select v->>'outcome' from t_kv where k = 'fin_s2') = 'signing_incomplete_payment_recorded'
  and not exists (select 1 from public.event_competition_entries where order_id = ((select v from t_kv where k='s2')->>'order_id')::uuid and status <> 'pending')
  and (select status = 'pending' and payment_status = 'paid' and metadata->>'needs_review' = 'signing_incomplete_payment_recorded' from public.event_orders where id = ((select v from t_kv where k='s2')->>'order_id')::uuid));
select pg_temp.as_user(pg_temp.u('0c10c0000002'));
select pg_temp.expect_msg('signing: clients cannot write document_signatures directly',
  $q$insert into public.document_signatures (assignment_id, template_id, studio_id, event_id, signer_name, signer_email, signed_body, signature_text, consent_text)
     values ('00000000-0000-0000-0000-0c10c0008301', '00000000-0000-0000-0000-0c10c0008001', '00000000-0000-0000-0000-0c10c000a001', pg_temp.ev(2), 'X', 'x@example.test', 'b', 'X', 'c')$q$,
  'row-level security');
reset role;
-- Free + documents: confirm only after signing, via finalize(null session)
update public.event_competition_contest_registration_rules set base_entry_fee = 0 where contest_id = pg_temp.cid(2, 2, 3);
select pg_temp.expect_ok('signing: free order with documents',
  $q$insert into t_kv values ('s3', pg_temp.start(pg_temp.ev(2), pg_temp.req(24), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Free','Signer')),
     jsonb_build_array(pg_temp.entry('x', 2, 3, 3, '["a"]', '{"a":"dancer"}', '[]', '{"participantDanceRoles":{"a":"leader"}}')))))$q$);
select pg_temp.chk('signing: free order with documents stays pending until signed', (select v->>'order_status' from t_kv where k = 's3') = 'pending');
select pg_temp.expect_msg('signing: free finalize before signing refused',
  $q$select public.finalize_competition_registration(((select v from t_kv where k='s3')->>'order_id')::uuid, null, null, null, null, null)$q$, 'COMP10C_SIGNING_INCOMPLETE');

-- ============================================================================
-- REVIEW FIXES: duplicate entry ids, self + staff anchor, bound session past the hold
-- ============================================================================
select pg_temp.chk('pricing: duplicate entry ids are refused',
  public._comp10c_quote(pg_temp.ev(1), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A'), pg_temp.person('b','Bo','B')),
    jsonb_build_array(pg_temp.entry('x', 1, 2, 2, '["a"]', '{"a":"dancer"}'), pg_temp.entry('x', 1, 2, 2, '["b"]', '{"b":"dancer"}'))), now())->'errors' ? 'Each entry needs a unique id.');
select pg_temp.expect_msg('identity: "this is me" cannot be combined with a staff anchor',
  $q$select pg_temp.start(pg_temp.ev(1), pg_temp.req(51), pg_temp.draft(
       jsonb_build_array(pg_temp.person('a', 'Owner', 'A', '{"isSelf": true, "anchorClientId": "00000000-0000-0000-0000-0c10c000c002"}')),
       jsonb_build_array(pg_temp.entry('x', 1, 2, 2, '["a"]', '{"a":"dancer"}'))), pg_temp.u('0c10c0000001'))$q$,
  'cannot be both you and a linked studio record');
select pg_temp.expect_ok('hold: order with a bound session',
  $q$insert into t_kv values ('h1', pg_temp.start(pg_temp.ev(1), pg_temp.req(52), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Hold','Bound')),
     jsonb_build_array(pg_temp.entry('x', 1, 2, 2, '["a"]', '{"a":"dancer"}')))))$q$);
select pg_temp.expect_ok('hold: order without a session',
  $q$insert into t_kv values ('h2', pg_temp.start(pg_temp.ev(1), pg_temp.req(53), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Hold','Unbound')),
     jsonb_build_array(pg_temp.entry('x', 1, 2, 2, '["a"]', '{"a":"dancer"}')))))$q$);
select pg_temp.expect_ok('hold: attach h1', $q$select public.attach_competition_registration_checkout(((select v from t_kv where k='h1')->>'order_id')::uuid, 'acct_p10cStudioA', 'cs_test_p10c_h1', now() + interval '35 minutes')$q$);
update public.event_orders set expires_at = now() - interval '1 minute'
where id in (((select v from t_kv where k='h1')->>'order_id')::uuid, ((select v from t_kv where k='h2')->>'order_id')::uuid);
select pg_temp.chk('hold: past the hold, a bound session is returned (Stripe decides), never declared expired',
  (select v->>'checkout_session_id' = 'cs_test_p10c_h1' and v->>'state' = 'payable'
   from (select pg_temp.try_jsonb($w$select public.prepare_competition_registration_payment(((select v from t_kv where k='h1')->>'order_id')::uuid)$w$) v) x));
select pg_temp.expect_msg('hold: past the hold with no session -> COMP10C_EXPIRED',
  $q$select public.prepare_competition_registration_payment(((select v from t_kv where k='h2')->>'order_id')::uuid)$q$, 'COMP10C_EXPIRED');

-- ============================================================================
-- ACCOUNTING: ordinary ticket orders and order homogeneity
-- ============================================================================
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, status, payment_status)
values (pg_temp.u('0c10c000f101'), pg_temp.ev(2), pg_temp.u('0c10c000a001'), 'Tix', 'tix@example.test', 50, 50, 'confirmed', 'paid');
insert into public.event_order_items (order_id, event_id, item_type, description, quantity, unit_price, total_price) values
  (pg_temp.u('0c10c000f101'), pg_temp.ev(2), 'ticket', 'GA', 1, 50, 50),
  (pg_temp.u('0c10c000f101'), pg_temp.ev(2), 'add_on', 'Parking', 1, 0, 0);
insert into public.event_registrations (id, studio_id, event_id, order_id, status, payment_status, attendee_first_name, attendee_last_name, attendee_email, total_price, total_amount)
values (pg_temp.u('0c10c000f201'), pg_temp.u('0c10c000a001'), pg_temp.ev(2), pg_temp.u('0c10c000f101'), 'confirmed', 'paid', 'T', 'X', 'tix@example.test', 50, 50);
insert into public.event_payments (id, registration_id, amount, currency, payment_method, status, source, platform_fee_amount)
values (pg_temp.u('0c10c000f301'), pg_temp.u('0c10c000f201'), 50, 'USD', 'stripe_checkout', 'paid', 'stripe', 1.50);
select pg_temp.chk('accounting: ordinary ticket payment stays event_ticket_revenue',
  exists (select 1 from public.accounting_entries where source_id = pg_temp.u('0c10c000f301') and category = 'event_ticket_revenue'
          and entry_status = 'active' and gross_amount = 50 and net_amount = 48.50)
  and not exists (select 1 from public.accounting_entries where source_id = pg_temp.u('0c10c000f301') and category = 'competition_entry_revenue'));
select pg_temp.expect_msg('accounting: a competition entry cannot join an ordinary ticket order',
  $q$insert into public.event_order_items (order_id, event_id, item_type, description, quantity, unit_price, total_price)
     values ('00000000-0000-0000-0000-0c10c000f101', pg_temp.ev(2), 'competition_entry', 'Entry', 1, 10, 10)$q$, 'COMP10C_MIXED_ORDER');
select pg_temp.expect_msg('accounting: an ordinary ticket cannot join a competition order',
  $q$insert into public.event_order_items (order_id, event_id, item_type, description, quantity, unit_price, total_price)
     values (((select v from t_kv where k='o1')->>'id')::uuid, pg_temp.ev(1), 'ticket', 'GA', 1, 10, 10)$q$, 'COMP10C_MIXED_ORDER');
select pg_temp.expect_msg('accounting: an item cannot be re-labelled into the other class',
  $q$update public.event_order_items set metadata = metadata - 'revenue_class' where order_id = ((select v from t_kv where k='o1')->>'id')::uuid and item_type = 'add_on'$q$,
  'COMP10C_MIXED_ORDER');
select pg_temp.expect_ok('accounting: re-sync of an ordinary payment succeeds', $q$update public.event_payments set amount = 50.01 where id = pg_temp.u('0c10c000f301')$q$);
select pg_temp.chk('accounting: re-sync updates the single ledger row in place',
  pg_temp.n($q$select count(*) from public.accounting_entries where source_id = '00000000-0000-0000-0000-0c10c000f301'$q$) = 1
  and (select gross_amount from public.accounting_entries where source_id = pg_temp.u('0c10c000f301')) = 50.01);
select pg_temp.expect_ok('accounting: refund status update succeeds', $q$update public.event_payments set status = 'refunded' where id = pg_temp.u('0c10c000f301')$q$);
select pg_temp.chk('accounting: non-paid status still voids the entry (existing refund behaviour preserved)',
  pg_temp.n($q$select count(*) from public.accounting_entries where source_id = '00000000-0000-0000-0000-0c10c000f301' and entry_status = 'active'$q$) = 0);
select pg_temp.chk('accounting: payment total == active accounting total for every paid payment in this suite, one row each',
  not exists (
    select 1 from public.event_payments p join public.event_registrations r on r.id = p.registration_id
    where r.event_id in (pg_temp.ev(1), pg_temp.ev(2)) and p.status = 'paid'
      and (p.amount is distinct from (select sum(a.gross_amount) from public.accounting_entries a where a.source_id = p.id and a.entry_status = 'active')
        or (select count(*) from public.accounting_entries a where a.source_id = p.id) <> 1)));
select pg_temp.chk('accounting: every competition payment is competition_entry_revenue',
  not exists (
    select 1 from public.event_payments p join public.event_registrations r on r.id = p.registration_id
    join public.event_orders o on o.id = r.order_id
    join public.accounting_entries a on a.source_id = p.id
    where o.metadata->>'source' = 'competition_registration' and a.category <> 'competition_entry_revenue'));

-- ============================================================================
-- CLOSE + PRIVILEGES
-- ============================================================================
select pg_temp.as_user(pg_temp.u('0c10c0000001'));
select pg_temp.expect_ok('close: manager closes e1', $q$select public.close_competition_registration(pg_temp.cid(1, 1))$q$);
reset role;
set local role anon;
select pg_temp.chk('close: catalog hidden again after close', (select count(*) from public.event_competition_divisions where event_id = pg_temp.ev(1)) = 0);
reset role;
select pg_temp.expect_msg('close: START after close -> COMP10C_CLOSED',
  $q$select pg_temp.start(pg_temp.ev(1), pg_temp.req(30), pg_temp.draft(jsonb_build_array(pg_temp.person('a','Al','A')),
     jsonb_build_array(pg_temp.entry('x', 1, 2, 2, '["a"]', '{"a":"dancer"}'))))$q$, 'COMP10C_CLOSED');
select pg_temp.chk('close: replay of an earlier request still returns its stored result after close',
  (pg_temp.try_jsonb($w$select pg_temp.start(pg_temp.ev(1), pg_temp.req(1), (select v from t_kv where k = 'main_draft'), pg_temp.u('0c10c0000002'))$w$)->>'replay')::boolean);

select pg_temp.chk('grants: START/PREPARE/ATTACH/FINALIZE/RELEASE/QUOTE are service-role only',
  not has_function_privilege('anon', 'public.start_competition_registration(uuid, uuid, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.start_competition_registration(uuid, uuid, jsonb, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.finalize_competition_registration(uuid, text, text, text, bigint, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.attach_competition_registration_checkout(uuid, text, text, timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.release_competition_registration(uuid, text, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.prepare_competition_registration_payment(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.quote_competition_registration(uuid, jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.finalize_competition_registration(uuid, text, text, text, bigint, text)', 'EXECUTE'));
select pg_temp.chk('grants: internal helpers are not callable by clients',
  not has_function_privilege('authenticated', 'public._comp10c_quote(uuid, jsonb, timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public._comp10c_resolve_competitor(uuid, uuid, uuid, uuid, text, text, text, date, text, jsonb, text, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public._comp10c_signing_complete(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.open_competition_registration(uuid)', 'EXECUTE'));
select pg_temp.as_user(pg_temp.u('0c10c0000002'));
select pg_temp.expect_msg('grants: an authenticated buyer cannot call START directly',
  $q$select public.start_competition_registration(pg_temp.ev(2), pg_temp.req(40), '{}'::jsonb, null)$q$, 'permission denied');
select pg_temp.expect_msg('grants: an authenticated buyer cannot finalize their own order',
  $q$select public.finalize_competition_registration(((select v from t_kv where k='s2')->>'order_id')::uuid, null, null, null, null, null)$q$, 'permission denied');
reset role;

-- ============================================================================
-- STRUCTURE (redundant guards must each stay in place)
-- ============================================================================
select pg_temp.chk('structure: participant -> competitor composite event FK',
  exists (select 1 from pg_constraint where conname = 'event_competition_entry_participants_competitor_fk'
          and pg_get_constraintdef(oid) = 'FOREIGN KEY (competitor_id, event_id) REFERENCES event_competition_competitors(id, event_id) ON DELETE RESTRICT'));
select pg_temp.chk('structure: participant competitor_id NOT NULL + one competitor per entry',
  (select attnotnull from pg_attribute where attrelid = 'public.event_competition_entry_participants'::regclass and attname = 'competitor_id')
  and exists (select 1 from pg_constraint where conname = 'event_competition_entry_participants_entry_competitor_key'));
select pg_temp.chk('structure: anchored uniqueness per event (user, client, instructor)',
  (select count(*) from pg_indexes where tablename = 'event_competition_competitors' and indexname in
     ('event_competition_competitors_event_user_uidx', 'event_competition_competitors_event_client_uidx', 'event_competition_competitors_event_instructor_uidx')
     and indexdef like 'CREATE UNIQUE INDEX%') = 3);
select pg_temp.chk('structure: idempotency + payment uniqueness indexes',
  exists (select 1 from pg_indexes where indexname = 'event_competition_registration_carts_request_uidx' and indexdef like 'CREATE UNIQUE INDEX%(event_id, client_request_id)%')
  and exists (select 1 from pg_indexes where indexname = 'event_payments_registration_checkout_session_uidx' and indexdef like 'CREATE UNIQUE INDEX%')
  and exists (select 1 from pg_indexes where indexname = 'event_payments_registration_payment_intent_uidx' and indexdef like 'CREATE UNIQUE INDEX%'));

-- ============================================================================
-- Verdict
-- ============================================================================
do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'PHASE 10C SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'PHASE 10C SQL SUITE FAIL: %', v_failures;
end $$;

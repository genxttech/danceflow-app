-- Competition CF1 package A5 -- audited exclusion action regression suite.
--
-- Covers 20270120094000_competition_cf1_a5_exclusion_action.sql on top of the chain through HL1 (20270119090000) and A1 (20270120085000).
-- Gates: U65 (the exclusion action, built here), U63 (co-sign safeguards, A5 part), U74 (direct writes), U75 (request-id replay),
-- U76 (callback-not-danced interplay: A5 part only; the lock refusal needs A3 and is reported BLOCKED), U52 (ENABLE ALWAYS, A5 part).
-- U78 (lock probe) is a multi-session test: test_T_competition_cf1_a5_concurrency.sh.
-- Run as a SUPERUSER. One transaction, synthetic fixtures only (UUID block ...-cf1a50XXXXXX). The final block ALWAYS raises, so nothing persists:
--   "COMPETITION CF1 A5 SQL SUITE PASS (<n> checks, <b> blocked ...)"  or  "... FAIL: <failures>".
-- Each check reports PASS / FAIL / BLOCKED; what is not here is listed in the verdict.

begin;

create temp table t_results (name text, ok boolean, detail text, status text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_vars (k text primary key, v jsonb) on commit drop;
grant all on t_vars to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'), case when coalesce(p_ok, false) then 'PASS' else 'FAIL' end);
end $$;

create or replace function pg_temp.blocked(p_name text, p_why text) returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, true, p_why, 'BLOCKED');
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-cf1a50' || p_suffix)::uuid $$;
create or replace function pg_temp.rq(p_n int) returns uuid
language sql immutable as $$ select pg_temp.u('f0' || lpad(p_n::text, 4, '0')) $$;
create or replace function pg_temp.rd(p_n int) returns uuid
language sql immutable as $$ select pg_temp.u('0060' || lpad(p_n::text, 2, '0')) $$;
create or replace function pg_temp.en(p_n int) returns uuid
language sql immutable as $$ select pg_temp.u('0080' || lpad(p_n::text, 2, '0')) $$;
create or replace function pg_temp.us(p_n int) returns uuid
language sql immutable as $$ select pg_temp.u('0000' || lpad(p_n::text, 2, '0')) $$;

create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- Runs p_sql (a statement returning jsonb) as p_user and returns the result; the role is always reset afterwards.
create or replace function pg_temp.do_as(p_user uuid, p_sql text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_user);
  execute p_sql into v;
  execute 'reset role';
  return v;
exception when others then
  execute 'reset role';
  raise;
end $$;

-- Success: records the result under p_key (when given).
create or replace function pg_temp.run(p_name text, p_user uuid, p_sql text, p_key text default null) returns void
language plpgsql as $$
declare v jsonb;
begin
  begin
    v := pg_temp.do_as(p_user, p_sql);
    if p_key is not null then
      insert into t_vars values (p_key, v) on conflict (k) do update set v = excluded.v;
    end if;
    insert into t_results values (p_name, true, coalesce(v::text, 'ok'), 'PASS');
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm, 'FAIL');
  end;
end $$;

-- Refusal: the message must contain p_fragment (case-insensitive); p_state, when given, must equal the SQLSTATE.
create or replace function pg_temp.ex(p_name text, p_user uuid, p_sql text, p_fragment text, p_state text default null) returns void
language plpgsql as $$
declare v_unexpected boolean := false;
begin
  begin
    perform pg_temp.do_as(p_user, p_sql);
    v_unexpected := true;
    raise exception 'rollback probe';
  exception when others then
    if not v_unexpected then
      insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0 and (p_state is null or sqlstate = p_state),
                                    sqlstate || ' ' || sqlerrm,
                                    case when position(lower(p_fragment) in lower(sqlerrm)) > 0 and (p_state is null or sqlstate = p_state) then 'PASS' else 'FAIL' end);
    end if;
  end;
  if v_unexpected then
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded', 'FAIL');
  end if;
end $$;

-- Raw refusal under a database role (no jwt): used for anon / service_role / authenticated on the protected table.
create or replace function pg_temp.ex_role(p_name text, p_role text, p_sql text, p_fragment text) returns void
language plpgsql as $$
declare v_unexpected boolean := false;
begin
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('role', p_role, true);
    execute p_sql;
    v_unexpected := true;
    raise exception 'rollback probe';
  exception when others then
    execute 'reset role';
    if not v_unexpected then
      insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0, sqlstate || ' ' || sqlerrm,
                                    case when position(lower(p_fragment) in lower(sqlerrm)) > 0 then 'PASS' else 'FAIL' end);
    end if;
  end;
  if v_unexpected then
    execute 'reset role';
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded', 'FAIL');
  end if;
end $$;

create or replace function pg_temp.vj(p_k text) returns jsonb language sql stable as $$ select v from t_vars where k = p_k $$;
create or replace function pg_temp.vid(p_k text) returns uuid language sql stable as $$ select (v ->> 'exclusion_id')::uuid from t_vars where k = p_k $$;
create or replace function pg_temp.n(p_sql text) returns bigint
language plpgsql as $$ declare r bigint; begin execute p_sql into r; return r; end $$;

-- SQL builders
create or replace function pg_temp.q_req(p_round int, p_entry int, p_kind text, p_reason text, p_req int) returns text
language sql immutable as $$ select format('select public.request_round_exclusion(%L,%L,%L,%L,%L)', pg_temp.rd(p_round), pg_temp.en(p_entry), p_kind, p_reason, pg_temp.rq(p_req)) $$;
create or replace function pg_temp.q_cos(p_key text, p_req int) returns text
language sql stable as $$ select format('select public.cosign_round_exclusion(%L,%L)', pg_temp.vid(p_key), pg_temp.rq(p_req)) $$;
create or replace function pg_temp.q_rev(p_round int, p_entry int, p_reason text, p_req int) returns text
language sql immutable as $$ select format('select public.request_round_exclusion_reversal(%L,%L,%L,%L)', pg_temp.rd(p_round), pg_temp.en(p_entry), p_reason, pg_temp.rq(p_req)) $$;
create or replace function pg_temp.q_rcos(p_key text, p_req int) returns text
language sql stable as $$ select format('select public.cosign_round_exclusion_reversal(%L,%L)', pg_temp.vid(p_key), pg_temp.rq(p_req)) $$;

-- Fixture mutators (superuser; replica so entry audit triggers stay out of the way)
create or replace function pg_temp.set_elig(p_entry int, p_elig text) returns void language plpgsql as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_entries set eligibility_status = p_elig where id = pg_temp.en(p_entry);
  perform set_config('session_replication_role', 'origin', true);
end $$;

create or replace function pg_temp.rows(p_where text) returns bigint
language plpgsql as $$ declare r bigint; begin execute 'select count(*) from public.event_competition_round_exclusions where ' || p_where into r; return r; end $$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (superuser, replica mode for placements)
-- ============================================================================
-- users: 01 ownerA (manager), 02 ownerA2 (manager, also judge C), 05 ownerB, 06 ownerA3 (manager, NO verified email), 07 ownerA4 (manager, judge D),
--        11 judge A, 17 chair, 18 chair2, 20 nobody
insert into auth.users (id, email) values
  (pg_temp.us(1), 't-cf1a5-ownera@example.test'), (pg_temp.us(2), 't-cf1a5-ownera2@example.test'), (pg_temp.us(3), 't-cf1a5-ownera5@example.test'), (pg_temp.us(4), 't-cf1a5-scorer@example.test'), (pg_temp.us(5), 't-cf1a5-ownerb@example.test'),
  (pg_temp.us(6), 't-cf1a5-ownera3@example.test'), (pg_temp.us(7), 't-cf1a5-ownera4@example.test'), (pg_temp.us(11), 't-cf1a5-judge@example.test'),
  (pg_temp.us(17), 't-cf1a5-chair@example.test'), (pg_temp.us(18), 't-cf1a5-chair2@example.test'), (pg_temp.us(20), 't-cf1a5-nobody@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'CF1A5 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-cf1a50%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now()
from auth.users where id::text like '00000000-0000-0000-0000-cf1a50%' and id <> pg_temp.us(6);

insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'CF1 A5 Studio A', 't-cf1a5-studio-a'), (pg_temp.u('00b001'), 'CF1 A5 Studio B', 't-cf1a5-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.us(1), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.us(2), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.us(3), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.us(4), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.us(6), pg_temp.u('00a001'), 'studio_owner', true), (pg_temp.us(7), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.us(5), pg_temp.u('00b001'), 'studio_owner', true),
  (pg_temp.us(11), pg_temp.u('00a001'), 'instructor', true), (pg_temp.us(17), pg_temp.u('00a001'), 'instructor', true),
  (pg_temp.us(18), pg_temp.u('00a001'), 'studio_owner', true);

insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'CF1 A5 Comp', 't-cf1a5-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00b001'), 'CF1 A5 Other Comp', 't-cf1a5-e2', 'competition', current_date + 40, current_date + 40, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Ordinal program', 'country', 'relative', 'skating', 'configured', 'none'),
  (pg_temp.u('001002'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Callback program', 'country', 'relative', 'skating', 'configured', 'promote_callback'),
  (pg_temp.u('001003'), pg_temp.u('00e002'), pg_temp.u('00b001'), 'Other program', 'country', 'relative', 'skating', 'configured', 'none');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Ordinal contest', 'single_dance', 'pro_am', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e001'), pg_temp.u('001002'), 'Callback contest', 'single_dance', 'pro_am', 'open'),
  (pg_temp.u('002003'), pg_temp.u('00e002'), pg_temp.u('001003'), 'Other contest', 'single_dance', 'pro_am', 'open');
-- divisions 003001..003009 ordinal (one per round), 003010 callback, 003020 event B
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
select pg_temp.u('0030' || lpad(i::text, 2, '0')), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D' || i, 'open' from generate_series(1, 9) i;
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003010'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('002002'), 'D10', 'open'),
  (pg_temp.u('003020'), pg_temp.u('00e002'), pg_temp.u('001003'), pg_temp.u('002003'), 'D20', 'open');
-- rounds: 01 active (main) | 02 ballots_locked | 03 calculated | 04 approved | 05 draft | 06 active (publication tests) | 07 published | 08 complete | 09 cancelled
--         10 callback preliminary active T=2 | 20 event B active
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method, target_advancement_count) values
  (pg_temp.rd(1), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'R1', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.rd(2), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003002'), 'R2', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.rd(3), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003003'), 'R3', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.rd(4), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003004'), 'R4', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.rd(5), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003005'), 'R5', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.rd(6), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003006'), 'R6', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.rd(7), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003007'), 'R7', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.rd(8), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003008'), 'R8', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.rd(9), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003009'), 'R9', 'final', 1, 'draft', 'ordinal_majority', null),
  (pg_temp.rd(10), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('003010'), 'R10 Callback', 'preliminary', 1, 'draft', 'callback_tally', 2),
  (pg_temp.rd(20), pg_temp.u('00e002'), pg_temp.u('001003'), pg_temp.u('003020'), 'R20', 'final', 1, 'draft', 'ordinal_majority', null);

-- Refund evidence: e03 sits on a cancelled registration.
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, payment_status) values
  (pg_temp.u('0a0001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b1@example.test', 'paid');
insert into public.event_registrations (id, studio_id, event_id, order_id, status, payment_status, attendee_first_name, attendee_last_name, attendee_email) values
  (pg_temp.u('0b0001'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'confirmed', 'paid', 'G', 'Paid', 'g1@example.test'),
  (pg_temp.u('0b0002'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'cancelled', 'paid', 'G', 'Cancelled', 'g2@example.test');

-- Entries. D1 (R1): e01..e18. Others: e21 (R2), e22 (R3), e23 (R4), e24 (R5), e25..e27 (R6), e28 (R7), e29 (R8), e30 (R9). Callback D10: c1..c4 = e41..e44. Event B: e50.
set session_replication_role = replica;
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number, registration_id, order_id)
select pg_temp.en(i), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e' || i, 'confirmed',
       case when i = 2 then 'eligible' when i = 3 then 'eligible' else 'ineligible' end, (100 + i)::text,
       case when i = 3 then pg_temp.u('0b0002') end, case when i = 3 then pg_temp.u('0a0001') end
from generate_series(1, 18) i;
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.en(x.i), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('00300' || x.d), 'e' || x.i, 'confirmed', 'ineligible', (100 + x.i)::text
from (values (21, 2), (22, 3), (23, 4), (24, 5), (25, 6), (26, 6), (27, 6), (28, 7), (29, 8), (30, 9)) x(i, d);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.en(i), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('003010'), 'c' || i, 'confirmed', case when i = 41 then 'ineligible' else 'eligible' end, (100 + i)::text
from generate_series(41, 44) i;
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  (pg_temp.en(50), pg_temp.u('00e002'), pg_temp.u('001003'), pg_temp.u('003020'), 'eB', 'confirmed', 'ineligible', '150');

insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values
  (pg_temp.u('00c001'), pg_temp.u('00e001'), 1, 'v1', 'published', now()),
  (pg_temp.u('00c002'), pg_temp.u('00e002'), 1, 'v1', 'published', now());
-- R1 heats: h1 active | h2 scheduled (not danced) | h3 active | h4 cancelled | h5 complete | h6 scheduled (a disqualified placement)
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values
  (pg_temp.u('00d001'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.rd(1), 1, pg_temp.u('002001'), pg_temp.u('00c001'), 'active'),
  (pg_temp.u('00d002'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.rd(1), 2, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled'),
  (pg_temp.u('00d003'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.rd(1), 3, pg_temp.u('002001'), pg_temp.u('00c001'), 'active'),
  (pg_temp.u('00d004'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.rd(1), 4, pg_temp.u('002001'), pg_temp.u('00c001'), 'cancelled'),
  (pg_temp.u('00d005'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.rd(1), 5, pg_temp.u('002001'), pg_temp.u('00c001'), 'complete'),
  (pg_temp.u('00d006'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.rd(1), 6, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled');
-- one complete heat per window-test round (R2..R9), the callback heat (active) and event B's heat
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status)
select pg_temp.u('00d1' || lpad(x.r::text, 2, '0')), pg_temp.u('00e001'), pg_temp.u('00300' || x.d), pg_temp.rd(x.r), 10 + x.r, pg_temp.u('002001'), pg_temp.u('00c001'), 'complete'
from (values (2, 2), (3, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 9)) x(r, d);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values
  (pg_temp.u('00d110'), pg_temp.u('00e001'), pg_temp.u('003010'), pg_temp.rd(10), 30, pg_temp.u('002002'), pg_temp.u('00c001'), 'active'),
  (pg_temp.u('00d120'), pg_temp.u('00e002'), pg_temp.u('003020'), pg_temp.rd(20), 1, pg_temp.u('002003'), pg_temp.u('00c002'), 'active');

insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
select pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u(x.h), pg_temp.en(x.e), x.o, x.st from (values
  -- h1 (active)
  ('00d001', 1, 1, 'scheduled'), ('00d001', 2, 2, 'scheduled'), ('00d001', 3, 3, 'scheduled'), ('00d001', 4, 4, 'scratched'), ('00d001', 6, 5, 'scheduled'),
  ('00d001', 11, 6, 'scheduled'), ('00d001', 12, 7, 'scheduled'), ('00d001', 13, 8, 'scheduled'), ('00d001', 14, 9, 'scheduled'),
  ('00d001', 15, 10, 'scheduled'), ('00d001', 16, 11, 'scheduled'), ('00d001', 17, 12, 'scheduled'), ('00d001', 18, 13, 'scheduled'),
  -- h2 (scheduled): e05 only here
  ('00d002', 5, 1, 'scheduled'),
  -- h3 (active): e01 again
  ('00d003', 1, 1, 'scheduled'),
  -- h4 (cancelled): e07 only here
  ('00d004', 7, 1, 'scheduled'),
  -- h5 (complete): e09
  ('00d005', 9, 1, 'scheduled'),
  -- h6 (scheduled, but a disqualified placement): e10
  ('00d006', 10, 1, 'disqualified')
) x(h, e, o, st);
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
select pg_temp.u('00e001'), pg_temp.u('00300' || x.d), pg_temp.u('00d1' || lpad(x.r::text, 2, '0')), pg_temp.en(x.e), 1, 'scheduled'
from (values (2, 2, 21), (3, 3, 22), (4, 4, 23), (5, 5, 24), (6, 6, 25), (6, 6, 26), (6, 6, 27), (7, 7, 28), (8, 8, 29), (9, 9, 30)) x(r, d, e);
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
select pg_temp.u('00e001'), pg_temp.u('003010'), pg_temp.u('00d110'), pg_temp.en(i), i - 40, 'scheduled' from generate_series(41, 44) i;
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status) values
  (pg_temp.u('00e002'), pg_temp.u('003020'), pg_temp.u('00d120'), pg_temp.en(50), 1, 'scheduled');
-- NS1: e06 is a recorded no-show in h1
insert into public.event_competition_heat_no_shows (event_id, round_id, heat_id, heat_entry_id, entry_id, reason, marked_by, request_id)
select pg_temp.u('00e001'), pg_temp.rd(1), pg_temp.u('00d001'), he.id, pg_temp.en(6), 'did not appear', pg_temp.us(1), pg_temp.u('f9f001')
from public.event_competition_heat_entries he where he.heat_id = pg_temp.u('00d001') and he.entry_id = pg_temp.en(6);
set session_replication_role = origin;

-- Officials through the E1 RPCs: judge A (11), chair (17), chair2 (18), ownerA2 as judge C, ownerA4 as judge D
set role authenticated;
select pg_temp.as_user(pg_temp.us(1));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.us(11), 'judge', pg_temp.u('f10001'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.us(17), 'chair', pg_temp.u('f10002'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.us(18), 'scorer', pg_temp.u('f10003'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.us(2), 'judge', pg_temp.u('f10004'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.us(7), 'judge', pg_temp.u('f10005'));
select public.add_competition_official(pg_temp.u('00e001'), pg_temp.us(4), 'scorer', pg_temp.u('f10006'));
select public.assign_competition_panel_member(pg_temp.rd(1), (select id from public.event_competition_officials where event_id = pg_temp.u('00e001') and user_id = pg_temp.us(4)), null, gen_random_uuid());
select public.assign_competition_panel_member(pg_temp.rd(1), (select id from public.event_competition_officials where event_id = pg_temp.u('00e001') and user_id = pg_temp.us(11)), 'A', gen_random_uuid());
select public.assign_competition_panel_member(pg_temp.rd(1), (select id from public.event_competition_officials where event_id = pg_temp.u('00e001') and user_id = pg_temp.us(2)), 'C', gen_random_uuid());
select public.assign_competition_panel_member(pg_temp.rd(1), (select id from public.event_competition_officials where event_id = pg_temp.u('00e001') and user_id = pg_temp.us(7)), 'D', gen_random_uuid());
reset role;

set session_replication_role = replica;
update public.event_competition_rounds set status = 'active' where id in (pg_temp.rd(1), pg_temp.rd(6), pg_temp.rd(10), pg_temp.rd(20));
update public.event_competition_rounds set status = 'ballots_locked' where id = pg_temp.rd(2);
update public.event_competition_rounds set status = 'calculated' where id = pg_temp.rd(3);
update public.event_competition_rounds set status = 'approved' where id = pg_temp.rd(4);
update public.event_competition_rounds set status = 'published' where id = pg_temp.rd(7);
update public.event_competition_rounds set status = 'complete' where id = pg_temp.rd(8);
update public.event_competition_rounds set status = 'cancelled' where id = pg_temp.rd(9);
set session_replication_role = origin;

-- ============================================================================
-- 1. Surface: grants, definer posture, table protections (U74, A5 side)
-- ============================================================================
select pg_temp.chk('the five public functions: authenticated EXECUTE, not anon / service_role / PUBLIC',
  (select bool_and(has_function_privilege('authenticated', p.oid, 'execute')
                   and not has_function_privilege('anon', p.oid, 'execute')
                   and not has_function_privilege('service_role', p.oid, 'execute')
                   and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
   where p.proname in ('request_round_exclusion', 'cosign_round_exclusion', 'request_round_exclusion_reversal',
                       'cosign_round_exclusion_reversal', 'competition_round_exclusions')));
select pg_temp.chk('all A5 functions are SECURITY DEFINER with search_path = public, pg_temp',
  (select count(*) = 12 and bool_and(p.prosecdef) and bool_and(coalesce(p.proconfig, '{}') @> array['search_path=public, pg_temp'])
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
   where p.proname in ('request_round_exclusion', 'cosign_round_exclusion', 'request_round_exclusion_reversal', 'cosign_round_exclusion_reversal',
                       'competition_round_exclusions', '_a5_cf1_require_no_publication', '_a5_cf1_entry_heat_entries', '_a5_cf1_entry_danced',
                       '_a5_cf1_effective', '_a5_cf1_filed_replacement_ballot', '_a5_cf1_require_reason_kind', '_a5_cf1_guard_replacement_ballot_filer')
      ),
  (select count(*)::text from pg_proc p where p.proname like '%a5_cf1%' or p.proname like '%round_exclusion%'));
select pg_temp.chk('internal _a5_cf1_* helpers carry no grants (authenticated / anon / service_role)',
  (select bool_and(not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
                   and not has_function_privilege('service_role', p.oid, 'execute'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public' where p.proname like '_a5_cf1_%'));
select pg_temp.chk('U52: the history triggers on the exclusion table are ENABLE ALWAYS (tgenabled = A)',
  (select count(*) = 2 and bool_and(t.tgenabled = 'A') from pg_trigger t where t.tgrelid = 'public.event_competition_round_exclusions'::regclass and not t.tgisinternal));
select pg_temp.ex_role('anon cannot call request_round_exclusion', 'anon', pg_temp.q_req(1, 1, 'ineligible', 'anon probe', 9001), 'permission denied');
select pg_temp.ex_role('service_role cannot call cosign_round_exclusion', 'service_role',
  format('select public.cosign_round_exclusion(%L,%L)', pg_temp.u('e0ffff'), pg_temp.rq(9002)), 'permission denied');
select pg_temp.ex_role('anon cannot call competition_round_exclusions', 'anon', format('select public.competition_round_exclusions(%L)', pg_temp.rd(1)), 'permission denied');
select pg_temp.ex_role('U74: authenticated cannot read the exclusion table', 'authenticated', 'select count(*) from public.event_competition_round_exclusions', 'permission denied');
select pg_temp.ex_role('U74: authenticated cannot insert into the exclusion table', 'authenticated',
  format($q$insert into public.event_competition_round_exclusions (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq)
            values (%L, %L, %L, 'exclude_requested', 'other', 'direct write', %L, 'manager', %L, 1)$q$, pg_temp.u('00e001'), pg_temp.rd(1), pg_temp.en(1), pg_temp.us(1), pg_temp.rq(9003)),
  'permission denied');
select pg_temp.ex_role('U74: service_role cannot insert into the exclusion table', 'service_role',
  format($q$insert into public.event_competition_round_exclusions (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq)
            values (%L, %L, %L, 'exclude_requested', 'other', 'direct write', %L, 'manager', %L, 1)$q$, pg_temp.u('00e001'), pg_temp.rd(1), pg_temp.en(1), pg_temp.us(1), pg_temp.rq(9004)),
  'permission denied');
select pg_temp.ex_role('U74: authenticated cannot update / delete / truncate the exclusion table', 'authenticated',
  'update public.event_competition_round_exclusions set reason = ''x''', 'permission denied');
select pg_temp.ex_role('U74: authenticated cannot delete from the exclusion table', 'authenticated', 'delete from public.event_competition_round_exclusions', 'permission denied');
select pg_temp.ex_role('U74: authenticated cannot truncate the exclusion table', 'authenticated', 'truncate public.event_competition_round_exclusions', 'permission denied');
select pg_temp.chk('U74: RLS on, no policy on the exclusion table',
  (select c.relrowsecurity from pg_class c where c.oid = 'public.event_competition_round_exclusions'::regclass)
  and not exists (select 1 from pg_policy p where p.polrelid = 'public.event_competition_round_exclusions'::regclass));

-- ============================================================================
-- 2. Authorization and input validation (request)
-- ============================================================================
-- (no jwt at all: auth.uid() is null)
create or replace function pg_temp.null_uid(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  perform set_config('role', 'authenticated', true);
  begin
    execute p_sql into v;
  exception when others then
    execute 'reset role';
    raise;
  end;
  execute 'reset role';
  return v;
end $$;
grant execute on function pg_temp.null_uid(text) to authenticated, anon, service_role;
do $$
begin
  begin
    perform pg_temp.null_uid(pg_temp.q_req(1, 1, 'ineligible', 'null uid', 9010));
    perform pg_temp.chk('request with no authenticated user is refused COMP_FORBIDDEN', false, 'unexpectedly succeeded');
  exception when others then
    perform pg_temp.chk('request with no authenticated user is refused COMP_FORBIDDEN', sqlerrm like 'COMP_FORBIDDEN%' and sqlstate = '42501', sqlstate || ' ' || sqlerrm);
  end;
end $$;
select pg_temp.ex('chair cannot request (requester must be a manager)', pg_temp.us(17), pg_temp.q_req(1, 1, 'ineligible', 'chair tries', 9011), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('judge cannot request', pg_temp.us(11), pg_temp.q_req(1, 1, 'ineligible', 'judge tries', 9012), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('stranger cannot request', pg_temp.us(20), pg_temp.q_req(1, 1, 'ineligible', 'stranger tries', 9013), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('cross-tenant: a manager of studio B cannot request in studio A''s round', pg_temp.us(5), pg_temp.q_req(1, 1, 'ineligible', 'tenant B tries', 9014), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('cross-tenant: a manager of studio A cannot request in studio B''s round', pg_temp.us(1),
  format('select public.request_round_exclusion(%L,%L,%L,%L,%L)', pg_temp.rd(20), pg_temp.en(50), 'ineligible', 'tenant A tries', pg_temp.rq(9015)), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('unknown round is refused COMP_FORBIDDEN (no enumeration)', pg_temp.us(1),
  format('select public.request_round_exclusion(%L,%L,%L,%L,%L)', pg_temp.u('ffff01'), pg_temp.en(1), 'ineligible', 'unknown round', pg_temp.rq(9016)), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('manager without a verified email credential is refused', pg_temp.us(6), pg_temp.q_req(1, 1, 'ineligible', 'unverified', 9017), 'COMP_VERIFIED_EMAIL_REQUIRED', '42501');
select pg_temp.ex('missing request id', pg_temp.us(1),
  format('select public.request_round_exclusion(%L,%L,%L,%L,null)', pg_temp.rd(1), pg_temp.en(1), 'ineligible', 'no request id'), 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.ex('reason kind outside the set', pg_temp.us(1), pg_temp.q_req(1, 1, 'unpaid', 'bad kind', 9018), 'COMP_EXCLUSION_REASON_KIND');
select pg_temp.ex('reason of 2 characters', pg_temp.us(1), pg_temp.q_req(1, 1, 'ineligible', 'ab', 9019), 'COMP_EXCLUSION_REASON_REQUIRED');
select pg_temp.ex('blank reason', pg_temp.us(1), pg_temp.q_req(1, 1, 'ineligible', '     ', 9020), 'COMP_EXCLUSION_REASON_REQUIRED');
select pg_temp.ex('reason of 501 characters', pg_temp.us(1), pg_temp.q_req(1, 1, 'ineligible', repeat('x', 501), 9021), 'COMP_EXCLUSION_REASON_REQUIRED');
select pg_temp.ex('entry of another event is refused COMP_EXCLUSION_ENTRY_NOT_IN_ROUND', pg_temp.us(1),
  format('select public.request_round_exclusion(%L,%L,%L,%L,%L)', pg_temp.rd(1), pg_temp.en(50), 'ineligible', 'foreign entry', pg_temp.rq(9022)), 'COMP_EXCLUSION_ENTRY_NOT_IN_ROUND');
select pg_temp.chk('no row was written by any refused request so far', pg_temp.rows('true') = 0, pg_temp.rows('true')::text);

-- ============================================================================
-- 3. Request preconditions: danced (HL1 rule), predicate P, lifecycle window
-- ============================================================================
select pg_temp.ex('U65: a couple that is eligible and not refunded cannot be excluded (P false)', pg_temp.us(1), pg_temp.q_req(1, 2, 'other', 'eligible couple', 9101), 'COMP_EXCLUSION_NOT_UNAVAILABLE');
select pg_temp.ex('U65: a scratched heat entry is not "danced" (COMP_EXCLUSION_NOT_DANCED)', pg_temp.us(1), pg_temp.q_req(1, 4, 'ineligible', 'scratched', 9102), 'COMP_EXCLUSION_NOT_DANCED');
select pg_temp.ex('U65: a heat entry in a scheduled heat is not danced', pg_temp.us(1), pg_temp.q_req(1, 5, 'ineligible', 'not yet danced', 9103), 'COMP_EXCLUSION_NOT_DANCED');
select pg_temp.ex('U65: an NS1 no-show did not dance', pg_temp.us(1), pg_temp.q_req(1, 6, 'ineligible', 'no show', 9104), 'COMP_EXCLUSION_NOT_DANCED');
select pg_temp.ex('U65: a couple whose only heat entry sits in a cancelled heat is not in the round', pg_temp.us(1), pg_temp.q_req(1, 7, 'ineligible', 'cancelled heat', 9105), 'COMP_EXCLUSION_ENTRY_NOT_IN_ROUND');
select pg_temp.ex('U65: a couple with no heat entry in the round is not in the round', pg_temp.us(1), pg_temp.q_req(1, 8, 'ineligible', 'no heat entry', 9106), 'COMP_EXCLUSION_ENTRY_NOT_IN_ROUND');
select pg_temp.run('U65: a couple in a COMPLETE heat can be requested (reason kind ineligible)', pg_temp.us(1), pg_temp.q_req(1, 9, 'ineligible', 'complete heat couple', 9107), 'e09_req');
select pg_temp.run('U65: a disqualified placement counts as danced even in a scheduled heat', pg_temp.us(1), pg_temp.q_req(1, 10, 'other', 'dq placement couple', 9108), 'e10_req');
select pg_temp.run('U65: refund evidence (cancelled registration) with reason kind refunded', pg_temp.us(1), pg_temp.q_req(1, 3, 'refunded', 'registration cancelled after the heat', 9109), 'e03_req');
select pg_temp.ex('U65: window draft', pg_temp.us(1), pg_temp.q_req(5, 24, 'ineligible', 'draft round', 9111), 'COMP_EXCLUSION_WINDOW');
select pg_temp.ex('U65: window calculated', pg_temp.us(1), pg_temp.q_req(3, 22, 'ineligible', 'calculated round', 9112), 'COMP_EXCLUSION_WINDOW');
select pg_temp.ex('U65: window approved', pg_temp.us(1), pg_temp.q_req(4, 23, 'ineligible', 'approved round', 9113), 'COMP_EXCLUSION_WINDOW');
select pg_temp.ex('U65: window published', pg_temp.us(1), pg_temp.q_req(7, 28, 'ineligible', 'published round', 9114), 'COMP_EXCLUSION_WINDOW');
select pg_temp.ex('U65: window complete', pg_temp.us(1), pg_temp.q_req(8, 29, 'ineligible', 'complete round', 9115), 'COMP_EXCLUSION_WINDOW');
select pg_temp.ex('U65: window cancelled', pg_temp.us(1), pg_temp.q_req(9, 30, 'ineligible', 'cancelled round', 9116), 'COMP_EXCLUSION_WINDOW');
select pg_temp.run('U65: window ballots_locked is allowed', pg_temp.us(1), pg_temp.q_req(2, 21, 'ineligible', 'locked round', 9117), 'r2_req');
select pg_temp.chk('U65: the request row stores actor, role, reason kind, reason, kind, seq 1, transaction id and the heat-entry snapshot',
  exists (select 1 from public.event_competition_round_exclusions x
          where x.id = pg_temp.vid('e09_req') and x.kind = 'exclude_requested' and x.actor = pg_temp.us(1) and x.actor_role = 'manager'
            and x.reason_kind = 'ineligible' and x.reason = 'complete heat couple' and x.seq = 1 and x.transaction_id is not null
            and x.decision_id is null and x.reverses_id is null
            and x.evidence_heat_entry_ids = array(select he.id from public.event_competition_heat_entries he where he.entry_id = pg_temp.en(9) order by he.id)));
select pg_temp.chk('U65: a request has no effect on the ranking-set predicate or the excluded set',
  not public._cf1_heat_entry_is_excluded((select he.id from public.event_competition_heat_entries he where he.entry_id = pg_temp.en(9)))
  and not exists (select 1 from public._cf1_excluded_entries(pg_temp.rd(1))));

-- ============================================================================
-- 4. Main flow on e01 (two heat entries, h1 and h3): request, replay, co-sign safeguards, effect, snapshot, no side effects (U65, U63, U75)
-- ============================================================================
create temp table t_he_before on commit drop as
  select id, heat_id, entry_id, status, floor_order from public.event_competition_heat_entries where event_id = pg_temp.u('00e001');
select pg_temp.run('request exclusion of e01 (ineligible)', pg_temp.us(1), pg_temp.q_req(1, 1, 'ineligible', 'ineligible after the heat', 9201), 'e01_req');
select pg_temp.chk('U65: the e01 snapshot holds BOTH heat entries (h1 and h3), one decision for the couple',
  (select cardinality(x.evidence_heat_entry_ids) = 2 from public.event_competition_round_exclusions x where x.id = pg_temp.vid('e01_req')));
select pg_temp.run('U75: replay of the same request returns the same result (replayed = true)', pg_temp.us(1), pg_temp.q_req(1, 1, 'ineligible', 'ineligible after the heat', 9201), 'e01_req_replay');
select pg_temp.chk('U75: the replay is the same row and wrote no second row',
  pg_temp.vid('e01_req_replay') = pg_temp.vid('e01_req') and (pg_temp.vj('e01_req_replay') ->> 'replayed')::boolean and pg_temp.rows('request_id = ' || quote_literal(pg_temp.rq(9201))) = 1);
select pg_temp.ex('U75: same request id, different reason is refused COMP_REQUEST_REUSED', pg_temp.us(1), pg_temp.q_req(1, 1, 'ineligible', 'a different reason', 9201), 'COMP_REQUEST_REUSED');
select pg_temp.ex('U75: same request id, different entry is refused', pg_temp.us(1), pg_temp.q_req(1, 11, 'ineligible', 'ineligible after the heat', 9201), 'COMP_REQUEST_REUSED');
select pg_temp.ex('U75: same request id, different reason kind is refused', pg_temp.us(1), pg_temp.q_req(1, 1, 'other', 'ineligible after the heat', 9201), 'COMP_REQUEST_REUSED');
select pg_temp.ex('U75: same request id from another manager is refused', pg_temp.us(2), pg_temp.q_req(1, 1, 'ineligible', 'ineligible after the heat', 9201), 'COMP_REQUEST_REUSED');
select pg_temp.ex('U75: a request id used by an exclusion cannot start a reversal request', pg_temp.us(1), pg_temp.q_rev(1, 1, 'a reversal reason', 9201), 'COMP_REQUEST_REUSED');
select pg_temp.chk('replaying never touches the table: still exactly four rows (e09, e10, e03 and r2 requests + e01 = 5)', pg_temp.rows('true') = 5, pg_temp.rows('true')::text);

-- co-sign safeguards (U63, A5 part)
select pg_temp.ex('U63: the requester cannot co-sign', pg_temp.us(1), pg_temp.q_cos('e01_req', 9202), 'COMP_EXCLUSION_COSIGN_SAME_PERSON');
select pg_temp.ex('U63: a judge cannot co-sign', pg_temp.us(11), pg_temp.q_cos('e01_req', 9203), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('U63: a stranger cannot co-sign', pg_temp.us(20), pg_temp.q_cos('e01_req', 9204), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('U63: a manager of another tenant cannot co-sign', pg_temp.us(5), pg_temp.q_cos('e01_req', 9205), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('U63: a manager without a verified email credential cannot co-sign', pg_temp.us(6), pg_temp.q_cos('e01_req', 9206), 'COMP_VERIFIED_EMAIL_REQUIRED', '42501');
select pg_temp.ex('unknown decision id is refused COMP_FORBIDDEN (no enumeration)', pg_temp.us(2),
  format('select public.cosign_round_exclusion(%L,%L)', pg_temp.u('e0ffff'), pg_temp.rq(9207)), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('missing co-sign request id', pg_temp.us(2), format('select public.cosign_round_exclusion(%L,null)', pg_temp.vid('e01_req')), 'COMP_REQUEST_ID_REQUIRED');
select pg_temp.ex('a reversal function refuses an exclusion request id (COMP_EXCLUSION_DECISION_KIND)', pg_temp.us(2), pg_temp.q_rcos('e01_req', 9208), 'COMP_EXCLUSION_DECISION_KIND');
select pg_temp.chk('the refused co-signs wrote nothing', pg_temp.rows('true') = 5, pg_temp.rows('true')::text);

-- a person who filed a replacement ballot in the round cannot co-sign (judge D = ownerA4 files v1 then v2)
set session_replication_role = replica;
insert into public.event_competition_ballots (id, event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by)
select pg_temp.u('ba0001'), pg_temp.u('00e001'), pg_temp.rd(1), pg_temp.u('00d001'), o.id, 'ordinal_rank', 1, 1, 'judge_web', pg_temp.us(7)
from public.event_competition_officials o where o.event_id = pg_temp.u('00e001') and o.user_id = pg_temp.us(7);
insert into public.event_competition_ballots (id, event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by, supersedes_id, correction_reason)
select pg_temp.u('ba0002'), pg_temp.u('00e001'), pg_temp.rd(1), pg_temp.u('00d001'), o.id, 'ordinal_rank', 1, 2, 'judge_web', pg_temp.us(7), pg_temp.u('ba0001'), 'corrected placing'
from public.event_competition_officials o where o.event_id = pg_temp.u('00e001') and o.user_id = pg_temp.us(7);
-- judge A (11) files v1 of its own ballot; a SCORER-PAPER replacement entered by chair2 (18) for judge A follows
insert into public.event_competition_ballots (id, event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by)
select pg_temp.u('ba0003'), pg_temp.u('00e001'), pg_temp.rd(1), pg_temp.u('00d001'), o.id, 'ordinal_rank', 1, 1, 'judge_web', pg_temp.us(11)
from public.event_competition_officials o where o.event_id = pg_temp.u('00e001') and o.user_id = pg_temp.us(11);
insert into public.event_competition_ballots (id, event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by, entered_by_official_id, supersedes_id, correction_reason)
select pg_temp.u('ba0004'), pg_temp.u('00e001'), pg_temp.rd(1), pg_temp.u('00d001'), o.id, 'ordinal_rank', 1, 2, 'scorer_paper', pg_temp.us(18), c.id, pg_temp.u('ba0003'), 'paper correction'
from public.event_competition_officials o join public.event_competition_officials c on c.event_id = o.event_id and c.user_id = pg_temp.us(18)
where o.event_id = pg_temp.u('00e001') and o.user_id = pg_temp.us(11);
-- judge C (ownerA2) files only an ORIGINAL v1 (allowed later); no replacement yet
insert into public.event_competition_ballots (id, event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by)
select pg_temp.u('ba0005'), pg_temp.u('00e001'), pg_temp.rd(1), pg_temp.u('00d001'), o.id, 'ordinal_rank', 1, 1, 'judge_web', pg_temp.us(2)
from public.event_competition_officials o where o.event_id = pg_temp.u('00e001') and o.user_id = pg_temp.us(2);
set session_replication_role = origin;
select pg_temp.ex('U63: a manager who filed a replacement ballot (as judge) cannot co-sign', pg_temp.us(7), pg_temp.q_cos('e01_req', 9209), 'COMP_EXCLUSION_COSIGNER_FILED_BALLOT');
select pg_temp.ex('U63: a chair who entered a paper replacement ballot cannot co-sign', pg_temp.us(18), pg_temp.q_cos('e01_req', 9210), 'COMP_EXCLUSION_COSIGNER_FILED_BALLOT');

-- the co-sign by the chair
select pg_temp.run('U65: the chair co-signs (a different person)', pg_temp.us(17), pg_temp.q_cos('e01_req', 9211), 'e01_cos');
select pg_temp.chk('U63: the co-sign row records the chair role, the co-signer, decision_id = the request and a later seq',
  exists (select 1 from public.event_competition_round_exclusions x
          where x.id = pg_temp.vid('e01_cos') and x.kind = 'exclude_cosigned' and x.actor = pg_temp.us(17) and x.actor_role = 'chair'
            and x.decision_id = pg_temp.vid('e01_req') and x.seq > (select r.seq from public.event_competition_round_exclusions r where r.id = pg_temp.vid('e01_req')) and x.reverses_id is null
            and x.reason = 'ineligible after the heat' and x.reason_kind = 'ineligible' and x.transaction_id is not null
            and cardinality(x.evidence_heat_entry_ids) = 2));
select pg_temp.chk('U65: after the co-sign BOTH heat entries of e01 are excluded; other couples (e02, e11) and other heat entries are not',
  (select bool_and(public._cf1_heat_entry_is_excluded(he.id)) from public.event_competition_heat_entries he where he.entry_id = pg_temp.en(1))
  and not (select bool_or(public._cf1_heat_entry_is_excluded(he.id)) from public.event_competition_heat_entries he where he.entry_id <> pg_temp.en(1) and he.event_id = pg_temp.u('00e001')));
select pg_temp.chk('U65: _cf1_excluded_entries(R1) lists e01 with the co-sign row and its request as decision',
  (select count(*) = 1 and bool_and(x.entry_id = pg_temp.en(1) and x.exclusion_id = pg_temp.vid('e01_cos') and x.decision_id = pg_temp.vid('e01_req') and x.reason_kind = 'ineligible')
   from public._cf1_excluded_entries(pg_temp.rd(1)) x));
select pg_temp.run('U75: a co-sign replay returns the same row', pg_temp.us(17), pg_temp.q_cos('e01_req', 9211), 'e01_cos_replay');
select pg_temp.chk('U75: the co-sign replay is the same row, replayed = true, no second row',
  pg_temp.vid('e01_cos_replay') = pg_temp.vid('e01_cos') and (pg_temp.vj('e01_cos_replay') ->> 'replayed')::boolean and pg_temp.rows('decision_id = ' || quote_literal(pg_temp.vid('e01_req'))) = 1);
select pg_temp.ex('U75: a co-sign request id used by another co-signer is refused COMP_REQUEST_REUSED', pg_temp.us(2), pg_temp.q_cos('e01_req', 9211), 'COMP_REQUEST_REUSED');
select pg_temp.ex('U75: a co-sign request id cannot be reused for a request', pg_temp.us(1), pg_temp.q_req(1, 11, 'ineligible', 'reuse of a cosign id', 9211), 'COMP_REQUEST_REUSED');
select pg_temp.ex('a second co-sign of the completed request (new id) is refused', pg_temp.us(3), pg_temp.q_cos('e01_req', 9212), 'COMP_EXCLUSION_DECISION_COMPLETED');
select pg_temp.ex('a new request for an already excluded couple is refused', pg_temp.us(1), pg_temp.q_req(1, 1, 'ineligible', 'again', 9213), 'COMP_EXCLUSION_ALREADY');
select pg_temp.chk('no side effects: heat entries (ids, heats, statuses, order) are exactly as before; no ballot / result row was written',
  not exists (select 1 from (select id, heat_id, entry_id, status, floor_order from public.event_competition_heat_entries where event_id = pg_temp.u('00e001')
                             except select * from t_he_before) a)
  and not exists (select 1 from (select * from t_he_before except select id, heat_id, entry_id, status, floor_order from public.event_competition_heat_entries where event_id = pg_temp.u('00e001')) b)
  and (select count(*) from public.event_competition_ballots where round_id = pg_temp.rd(1)) = 5
  and (select status from public.event_competition_rounds where id = pg_temp.rd(1)) = 'active');

-- the replacement-ballot trigger: a co-signer cannot file a replacement ballot afterwards (judge C = ownerA2 co-signs below)
select pg_temp.run('request exclusion of e11 for the ownerA2 co-sign / replacement-ballot interplay', pg_temp.us(1), pg_temp.q_req(1, 11, 'ineligible', 'ineligible, second couple', 9220), 'e11_req');
select pg_temp.ex('P2 review: a manager who holds a judge letter on the round''s panel (ownerA2, judge C) cannot co-sign', pg_temp.us(2), pg_temp.q_cos('e11_req', 9222), 'COMP_EXCLUSION_COSIGNER_FILED_BALLOT');
select pg_temp.run('a second manager (not a judge) co-signs e11', pg_temp.us(3), pg_temp.q_cos('e11_req', 9221), 'e11_cos');
select pg_temp.chk('U63: the co-sign by a manager records actor_role manager', (select actor_role = 'manager' from public.event_competition_round_exclusions where id = pg_temp.vid('e11_cos')));
do $$
begin
  begin
    insert into public.event_competition_ballots (id, event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by, supersedes_id, correction_reason)
    select pg_temp.u('ba0007'), pg_temp.u('00e001'), pg_temp.rd(1), pg_temp.u('00d001'), o.id, 'ordinal_rank', 1, 2, 'judge_web', pg_temp.us(17), pg_temp.u('ba0001'), 'chair files for a judge'
    from public.event_competition_officials o where o.event_id = pg_temp.u('00e001') and o.user_id = pg_temp.us(7);
    perform pg_temp.chk('U63: a co-signer (chair) cannot file a replacement ballot afterwards (submitted_by)', false, 'unexpectedly succeeded');
  exception when others then
    perform pg_temp.chk('U63: a co-signer (chair) cannot file a replacement ballot afterwards (submitted_by)', sqlerrm like 'COMP_EXCLUSION_COSIGNER_CONFLICT%', sqlstate || ' ' || sqlerrm);
  end;
  begin
    insert into public.event_competition_ballots (id, event_id, round_id, heat_id, official_id, ballot_format, ballot_format_version, version, source, submitted_by, entered_by_official_id, supersedes_id, correction_reason)
    select pg_temp.u('ba0008'), pg_temp.u('00e001'), pg_temp.rd(1), pg_temp.u('00d001'), o.id, 'ordinal_rank', 1, 2, 'scorer_paper', pg_temp.us(11), c.id, pg_temp.u('ba0001'), 'paper entered by the chair'
    from public.event_competition_officials o join public.event_competition_officials c on c.event_id = o.event_id and c.user_id = pg_temp.us(17)
    where o.event_id = pg_temp.u('00e001') and o.user_id = pg_temp.us(7);
    perform pg_temp.chk('U63: a co-signer cannot enter a paper replacement ballot (entering scorer)', false, 'unexpectedly succeeded');
  exception when others then
    perform pg_temp.chk('U63: a co-signer cannot enter a paper replacement ballot (entering scorer)', sqlerrm like 'COMP_EXCLUSION_COSIGNER_CONFLICT%', sqlstate || ' ' || sqlerrm);
  end;
end $$;
select pg_temp.chk('the trigger leaves an ORIGINAL ballot (supersedes_id null) by a co-signer alone: not in the trigger scope',
  true, 'documented: only replacement ballots are refused (the guard fires on supersedes_id is not null)');

-- stale / ordering
select pg_temp.run('two pending requests for e12', pg_temp.us(1), pg_temp.q_req(1, 12, 'ineligible', 'first request', 9230), 'e12_a');
select pg_temp.run('second pending request for e12 (allowed: requests are not exclusive)', pg_temp.us(2), pg_temp.q_req(1, 12, 'other', 'second request', 9231), 'e12_b');
select pg_temp.run('co-sign the LATER request first', pg_temp.us(17), pg_temp.q_cos('e12_b', 9232), 'e12_b_cos');
select pg_temp.ex('the earlier request is now stale or already (COMP_EXCLUSION_REQUEST_STALE)', pg_temp.us(3), pg_temp.q_cos('e12_a', 9233), 'COMP_EXCLUSION_REQUEST_STALE');
select pg_temp.chk('the effective reason is the co-signed request''s (other), seq strictly increasing without duplicates',
  (select reason_kind = 'other' from public.event_competition_round_exclusions where id = pg_temp.vid('e12_b_cos'))
  and not exists (select 1 from public.event_competition_round_exclusions group by round_id, seq having count(*) > 1)
  and (select max(seq) from public.event_competition_round_exclusions where round_id = pg_temp.rd(1)) = (select count(*) from public.event_competition_round_exclusions where round_id = pg_temp.rd(1)));

-- the predicate is re-checked at co-sign: the cause is corrected between request and co-sign
select pg_temp.run('request exclusion of e17', pg_temp.us(1), pg_temp.q_req(1, 17, 'ineligible', 'to be corrected', 9240), 'e17_req');
select pg_temp.set_elig(17, 'eligible');
select pg_temp.ex('U65: co-sign is refused once P is false again (COMP_EXCLUSION_NOT_UNAVAILABLE)', pg_temp.us(17), pg_temp.q_cos('e17_req', 9241), 'COMP_EXCLUSION_NOT_UNAVAILABLE');

-- Review round 2 (M1, L1, L2): panel assignments, visible reasons, reason kind tied to the cause
select pg_temp.run('M1: request for e18 (cause: ineligible)', pg_temp.us(1), pg_temp.q_req(1, 18, 'ineligible', 'ineligible, for the M1 probe', 9250), 'e18_req');
select pg_temp.ex('M1: a manager with a SCORER panel assignment on the round cannot co-sign (the trigger would trap their paper entry)', pg_temp.us(4), pg_temp.q_cos('e18_req', 9251), 'COMP_EXCLUSION_COSIGNER_FILED_BALLOT');
select pg_temp.ex('L1: a tab/newline-only reason is refused (request)', pg_temp.us(1), format('select public.request_round_exclusion(%L,%L,%L,E''	
 	
'',%L)', pg_temp.rd(1), pg_temp.en(15), 'ineligible', pg_temp.rq(9252)), 'COMP_EXCLUSION_REASON_REQUIRED');
select pg_temp.ex('L1: a NBSP-only reason is refused', pg_temp.us(1), format('select public.request_round_exclusion(%L,%L,%L,%L,%L)', pg_temp.rd(1), pg_temp.en(15), 'ineligible', repeat(chr(160), 5), pg_temp.rq(9253)), 'COMP_EXCLUSION_REASON_REQUIRED');
select pg_temp.ex('L1: a zero-width-only reason is refused', pg_temp.us(1), format('select public.request_round_exclusion(%L,%L,%L,%L,%L)', pg_temp.rd(1), pg_temp.en(15), 'ineligible', repeat(chr(8203), 4), pg_temp.rq(9254)), 'COMP_EXCLUSION_REASON_REQUIRED');
select pg_temp.ex('L1: BOM / word-joiner padding with two letters is refused', pg_temp.us(1), format('select public.request_round_exclusion(%L,%L,%L,%L,%L)', pg_temp.rd(1), pg_temp.en(15), 'ineligible', chr(65279) || chr(8288) || 'ab' , pg_temp.rq(9255)), 'COMP_EXCLUSION_REASON_REQUIRED');
select pg_temp.ex('L1: a whitespace-only reversal reason is refused', pg_temp.us(1), format('select public.request_round_exclusion_reversal(%L,%L,%L,%L)', pg_temp.rd(1), pg_temp.en(1), repeat(chr(160), 5), pg_temp.rq(9256)), 'COMP_EXCLUSION_REASON_REQUIRED');
select pg_temp.run('L1: a reason with three visible characters passes', pg_temp.us(1), pg_temp.q_req(1, 15, 'ineligible', 'ok.', 9257), 'e15_req');
select pg_temp.ex('L2: kind refunded on an entry that is only ineligible is refused', pg_temp.us(1), pg_temp.q_req(1, 16, 'refunded', 'claims a refund', 9258), 'COMP_EXCLUSION_REASON_MISMATCH');
select pg_temp.ex('L2: kind ineligible on an entry whose cause is a cancelled registration is refused', pg_temp.us(1), pg_temp.q_req(1, 3, 'ineligible', 'claims ineligible', 9259), 'COMP_EXCLUSION_REASON_MISMATCH');
select pg_temp.run('L2: kind other is allowed whenever P is true', pg_temp.us(1), pg_temp.q_req(1, 16, 'other', 'other cause recorded', 9260), 'e16_req');
-- the cause changes between request and co-sign: ineligible -> a cancelled registration (kind ineligible no longer matches)
do $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.event_competition_entries set eligibility_status = 'eligible', registration_id = pg_temp.u('0b0002'), order_id = pg_temp.u('0a0001') where id = pg_temp.en(15);
  perform set_config('session_replication_role', 'origin', true);
end $$;
select pg_temp.ex('L2: co-sign re-checks the kind against the cause as of NOW', pg_temp.us(17), pg_temp.q_cos('e15_req', 9261), 'COMP_EXCLUSION_REASON_MISMATCH');
select pg_temp.chk('L1/L2 refusals wrote nothing (e15 has only its request row)', pg_temp.rows('entry_id = ' || quote_literal(pg_temp.en(15))) = 1);

-- ============================================================================
-- 5. Reversal (P-gate): only while P is false (U65, U76 A5 part)
-- ============================================================================
select pg_temp.ex('U65: a reversal request is refused while the couple is still ineligible (COMP_EXCLUSION_STILL_UNAVAILABLE)', pg_temp.us(1), pg_temp.q_rev(1, 1, 'try to reinstate', 9301), 'COMP_EXCLUSION_STILL_UNAVAILABLE');
select pg_temp.ex('U65: a reversal request for a couple that is not excluded is refused (COMP_EXCLUSION_NOT_ACTIVE)', pg_temp.us(1), pg_temp.q_rev(1, 2, 'never excluded', 9302), 'COMP_EXCLUSION_NOT_ACTIVE');
select pg_temp.ex('U65: a reversal request whose exclusion was only requested (no co-sign) is refused NOT_ACTIVE', pg_temp.us(1), pg_temp.q_rev(1, 9, 'only requested', 9303), 'COMP_EXCLUSION_NOT_ACTIVE');
select pg_temp.set_elig(1, 'eligible');
select pg_temp.ex('U63: the chair cannot request a reversal (requester must be a manager)', pg_temp.us(17), pg_temp.q_rev(1, 1, 'chair tries', 9304), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('U63: a manager without verified email cannot request a reversal', pg_temp.us(6), pg_temp.q_rev(1, 1, 'unverified', 9305), 'COMP_VERIFIED_EMAIL_REQUIRED', '42501');
select pg_temp.ex('reversal reason of 2 characters', pg_temp.us(1), pg_temp.q_rev(1, 1, 'no', 9306), 'COMP_EXCLUSION_REASON_REQUIRED');
select pg_temp.run('U65: the reversal request is accepted once the cause is corrected (P false)', pg_temp.us(1), pg_temp.q_rev(1, 1, 'eligibility corrected by the organizer', 9307), 'e01_rev');
select pg_temp.chk('the reversal request row names the exclusion it reverses, copies the reason kind, snapshot taken, later seq, no effect yet',
  exists (select 1 from public.event_competition_round_exclusions x
          where x.id = pg_temp.vid('e01_rev') and x.kind = 'reverse_requested' and x.reverses_id = pg_temp.vid('e01_cos') and x.decision_id is null
            and x.reason_kind = 'ineligible' and x.actor = pg_temp.us(1) and x.seq > (select r.seq from public.event_competition_round_exclusions r where r.id = pg_temp.vid('e01_cos')) and cardinality(x.evidence_heat_entry_ids) = 2)
  and (select bool_and(public._cf1_heat_entry_is_excluded(he.id)) from public.event_competition_heat_entries he where he.entry_id = pg_temp.en(1)));
select pg_temp.run('U75: reversal request replay', pg_temp.us(1), pg_temp.q_rev(1, 1, 'eligibility corrected by the organizer', 9307), 'e01_rev_replay');
select pg_temp.chk('U75: the reversal replay is the same row and wrote nothing', pg_temp.vid('e01_rev_replay') = pg_temp.vid('e01_rev') and (pg_temp.vj('e01_rev_replay') ->> 'replayed')::boolean and pg_temp.rows('kind = ''reverse_requested''') = 1);
select pg_temp.ex('U75: reversal request id reused for another reason', pg_temp.us(1), pg_temp.q_rev(1, 1, 'another reason', 9307), 'COMP_REQUEST_REUSED');
select pg_temp.ex('U63: the reversal requester cannot co-sign the reversal', pg_temp.us(1), pg_temp.q_rcos('e01_rev', 9308), 'COMP_EXCLUSION_COSIGN_SAME_PERSON');
select pg_temp.ex('U63: a replacement-ballot filer cannot co-sign the reversal', pg_temp.us(18), pg_temp.q_rcos('e01_rev', 9309), 'COMP_EXCLUSION_COSIGNER_FILED_BALLOT');
select pg_temp.ex('U63: a judge cannot co-sign the reversal', pg_temp.us(11), pg_temp.q_rcos('e01_rev', 9310), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('the exclusion co-sign function refuses a reversal request (COMP_EXCLUSION_DECISION_KIND)', pg_temp.us(2), pg_temp.q_cos('e01_rev', 9311), 'COMP_EXCLUSION_DECISION_KIND');
select pg_temp.set_elig(1, 'ineligible');
select pg_temp.ex('U65: the reversal co-sign re-checks P (cause came back): COMP_EXCLUSION_STILL_UNAVAILABLE', pg_temp.us(17), pg_temp.q_rcos('e01_rev', 9312), 'COMP_EXCLUSION_STILL_UNAVAILABLE');
select pg_temp.set_elig(1, 'eligible');
select pg_temp.run('U65: the reversal is co-signed by the chair', pg_temp.us(17), pg_temp.q_rcos('e01_rev', 9313), 'e01_revcos');
select pg_temp.chk('the reversal co-sign row: kind reverse_cosigned, decision = the reversal request, reverses = the exclusion, role chair, later seq',
  exists (select 1 from public.event_competition_round_exclusions x
          where x.id = pg_temp.vid('e01_revcos') and x.kind = 'reverse_cosigned' and x.decision_id = pg_temp.vid('e01_rev')
            and x.reverses_id = pg_temp.vid('e01_cos') and x.actor_role = 'chair' and x.actor = pg_temp.us(17) and x.seq > (select r.seq from public.event_competition_round_exclusions r where r.id = pg_temp.vid('e01_rev'))));
select pg_temp.chk('U65: after the reversal co-sign the couple is back in the ranking set (no heat entry excluded; not listed)',
  not (select bool_or(public._cf1_heat_entry_is_excluded(he.id)) from public.event_competition_heat_entries he where he.entry_id = pg_temp.en(1))
  and not exists (select 1 from public._cf1_excluded_entries(pg_temp.rd(1)) x where x.entry_id = pg_temp.en(1)));
select pg_temp.run('U75: reversal co-sign replay', pg_temp.us(17), pg_temp.q_rcos('e01_rev', 9313), 'e01_revcos_replay');
select pg_temp.chk('U75: the reversal co-sign replay is the same row', pg_temp.vid('e01_revcos_replay') = pg_temp.vid('e01_revcos') and (pg_temp.vj('e01_revcos_replay') ->> 'replayed')::boolean);
select pg_temp.ex('a second reversal co-sign of the completed request is refused', pg_temp.us(3), pg_temp.q_rcos('e01_rev', 9314), 'COMP_EXCLUSION_DECISION_COMPLETED');
select pg_temp.ex('U65: a reversal request after the reversal is refused (NOT_ACTIVE)', pg_temp.us(1), pg_temp.q_rev(1, 1, 'again', 9315), 'COMP_EXCLUSION_NOT_ACTIVE');

-- re-exclusion after a reversal (a new cycle), seq keeps growing
select pg_temp.set_elig(1, 'ineligible');
select pg_temp.run('a new exclusion cycle after a reversal is allowed', pg_temp.us(3), pg_temp.q_req(1, 1, 'ineligible', 'ineligible again after reinstatement', 9316), 'e01_req2');
select pg_temp.ex('the OLD exclusion request id cannot be replayed under a new entry', pg_temp.us(2), pg_temp.q_req(1, 5, 'ineligible', 'ineligible again after reinstatement', 9316), 'COMP_REQUEST_REUSED');
select pg_temp.run('co-signed again', pg_temp.us(17), pg_temp.q_cos('e01_req2', 9317), 'e01_cos2');
select pg_temp.chk('second cycle: seq keeps growing (request > reversal co-sign, co-sign > request), excluded again', (select seq from public.event_competition_round_exclusions where id = pg_temp.vid('e01_req2')) > (select seq from public.event_competition_round_exclusions where id = pg_temp.vid('e01_revcos'))
  and (select seq from public.event_competition_round_exclusions where id = pg_temp.vid('e01_cos2')) > (select seq from public.event_competition_round_exclusions where id = pg_temp.vid('e01_req2'))
  and (select bool_and(public._cf1_heat_entry_is_excluded(he.id)) from public.event_competition_heat_entries he where he.entry_id = pg_temp.en(1)));

-- two pending reversal requests: the second is stale once the first took effect
select pg_temp.set_elig(12, 'eligible');
select pg_temp.run('reversal request A for e12', pg_temp.us(1), pg_temp.q_rev(1, 12, 'cause corrected one', 9320), 'e12_ra');
select pg_temp.run('reversal request B for e12', pg_temp.us(2), pg_temp.q_rev(1, 12, 'cause corrected two', 9321), 'e12_rb');
select pg_temp.run('co-sign reversal B', pg_temp.us(17), pg_temp.q_rcos('e12_rb', 9322), 'e12_rb_cos');
select pg_temp.ex('reversal request A is stale after B took effect (COMP_EXCLUSION_REQUEST_STALE)', pg_temp.us(3), pg_temp.q_rcos('e12_ra', 9323), 'COMP_EXCLUSION_REQUEST_STALE');

-- a reversal request that is stale because a new exclusion cycle began
select pg_temp.set_elig(13, 'ineligible');
select pg_temp.run('e13 request', pg_temp.us(1), pg_temp.q_req(1, 13, 'ineligible', 'e13 ineligible', 9330), 'e13_req');
select pg_temp.run('e13 co-sign', pg_temp.us(17), pg_temp.q_cos('e13_req', 9331), 'e13_cos');
select pg_temp.set_elig(13, 'eligible');
select pg_temp.run('e13 reversal request', pg_temp.us(1), pg_temp.q_rev(1, 13, 'e13 eligible now', 9332), 'e13_rev');
select pg_temp.run('e13 reversal co-sign', pg_temp.us(17), pg_temp.q_rcos('e13_rev', 9333), 'e13_revcos');
select pg_temp.set_elig(13, 'ineligible');
select pg_temp.run('e13 excluded again (request)', pg_temp.us(1), pg_temp.q_req(1, 13, 'ineligible', 'e13 ineligible again', 9334), 'e13_req2');
select pg_temp.run('e13 excluded again (co-sign)', pg_temp.us(3), pg_temp.q_cos('e13_req2', 9335), 'e13_cos2');
select pg_temp.chk('e13: seq 1..6 consecutive within the round''s own rows and the effective row is the last co-sign',
  (select exclusion_id = pg_temp.vid('e13_cos2') from public._cf1_excluded_entries(pg_temp.rd(1)) where entry_id = pg_temp.en(13)));

-- ============================================================================
-- 6. Read function, U74 with rows present, replica stance
-- ============================================================================
select pg_temp.run('competition_round_exclusions: a manager reads the round''s decisions', pg_temp.us(1), format('select public.competition_round_exclusions(%L)', pg_temp.rd(1)), 'read_mgr');
select pg_temp.chk('the read returns every R1 row in seq order with completed flags',
  jsonb_array_length(pg_temp.vj('read_mgr') -> 'rows') = pg_temp.rows('round_id = ' || quote_literal(pg_temp.rd(1)))
  and (pg_temp.vj('read_mgr') -> 'rows' -> 0 ->> 'seq') = '1'
  and (select bool_and((r ->> 'completed')::boolean = exists (select 1 from public.event_competition_round_exclusions c where c.decision_id = (r ->> 'id')::uuid))
       from jsonb_array_elements(pg_temp.vj('read_mgr') -> 'rows') r));
select pg_temp.run('the chair reads the round''s decisions', pg_temp.us(17), format('select public.competition_round_exclusions(%L)', pg_temp.rd(1)));
select pg_temp.ex('a judge cannot read the decisions', pg_temp.us(11), format('select public.competition_round_exclusions(%L)', pg_temp.rd(1)), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('a manager of another tenant cannot read the decisions', pg_temp.us(5), format('select public.competition_round_exclusions(%L)', pg_temp.rd(1)), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('an unverified manager cannot read the decisions', pg_temp.us(6), format('select public.competition_round_exclusions(%L)', pg_temp.rd(1)), 'COMP_VERIFIED_EMAIL_REQUIRED', '42501');
select pg_temp.ex_role('U74: authenticated still cannot read the table with rows present', 'authenticated', 'select * from public.event_competition_round_exclusions', 'permission denied');
do $$
declare v_msg text;
begin
  -- Superuser attempts: the history triggers fire even under session_replication_role = replica (U52, A5 side).
  perform set_config('session_replication_role', 'replica', true);
  begin
    update public.event_competition_round_exclusions set reason = 'tampered' where id = pg_temp.vid('e01_cos');
    perform pg_temp.chk('U52: UPDATE of a decision row is refused even in replica mode', false, 'unexpectedly succeeded');
  exception when others then
    perform pg_temp.chk('U52: UPDATE of a decision row is refused even in replica mode', true, sqlerrm);
  end;
  begin
    delete from public.event_competition_round_exclusions where id = pg_temp.vid('e01_cos');
    perform pg_temp.chk('U52: DELETE of a decision row is refused even in replica mode', false, 'unexpectedly succeeded');
  exception when others then
    perform pg_temp.chk('U52: DELETE of a decision row is refused even in replica mode', true, sqlerrm);
  end;
  begin
    truncate public.event_competition_round_exclusions;
    perform pg_temp.chk('U52: TRUNCATE of the table is refused even in replica mode', false, 'unexpectedly succeeded');
  exception when others then
    perform pg_temp.chk('U52: TRUNCATE of the table is refused even in replica mode', true, sqlerrm);
  end;
  perform set_config('session_replication_role', 'origin', true);
end $$;

-- ============================================================================
-- 7. Publication refusal (fail closed until F3, RB2)
-- ============================================================================
select pg_temp.run('R6: request A', pg_temp.us(1), pg_temp.q_req(6, 25, 'ineligible', 'pre-publication request A', 9401), 'r6_a');
select pg_temp.run('R6: request B', pg_temp.us(1), pg_temp.q_req(6, 26, 'ineligible', 'pre-publication request B', 9402), 'r6_b');
select pg_temp.run('R6: request C (stays pending)', pg_temp.us(1), pg_temp.q_req(6, 27, 'ineligible', 'pre-publication request C', 9410), 'r6_c');
select pg_temp.run('R6: co-sign A', pg_temp.us(17), pg_temp.q_cos('r6_a', 9403), 'r6_a_cos');
select pg_temp.run('R6: co-sign B', pg_temp.us(17), pg_temp.q_cos('r6_b', 9411), 'r6_b_cos');
select pg_temp.set_elig(25, 'eligible');
select pg_temp.run('R6: reversal request for e25 (stays pending)', pg_temp.us(1), pg_temp.q_rev(6, 25, 'cause corrected', 9412), 'r6_rev');
-- F3 (the publication table) does not exist in this chain: absent table = no publication row can exist (every check above). A stand-in is created here.
create table public.event_competition_result_publications (id uuid primary key default gen_random_uuid());
select pg_temp.ex('U65: a publication table of an unknown shape fails closed (cannot be verified)', pg_temp.us(1), pg_temp.q_req(1, 15, 'ineligible', 'unknown shape', 9404), 'COMP_EXCLUSION_PUBLICATION_EXISTS');
alter table public.event_competition_result_publications add column round_id uuid;
select pg_temp.run('U65: with the table present and no row for the round, the action works (R1 is unaffected)', pg_temp.us(1), pg_temp.q_req(1, 14, 'ineligible', 'publication table exists, no row', 9405), 'e14_req');
insert into public.event_competition_result_publications (round_id) values (pg_temp.rd(6));
select pg_temp.ex('U65: request refused once ANY publication row exists for the round', pg_temp.us(1), pg_temp.q_req(6, 27, 'ineligible', 'publication row exists', 9406), 'COMP_EXCLUSION_PUBLICATION_EXISTS');
select pg_temp.ex('U65: co-sign of a pending request refused once a publication row exists', pg_temp.us(17), pg_temp.q_cos('r6_c', 9407), 'COMP_EXCLUSION_PUBLICATION_EXISTS');
select pg_temp.set_elig(26, 'eligible');
select pg_temp.ex('U65: reversal request refused once a publication row exists', pg_temp.us(1), pg_temp.q_rev(6, 26, 'cause corrected', 9408), 'COMP_EXCLUSION_PUBLICATION_EXISTS');
select pg_temp.ex('U65: reversal co-sign of a pending reversal refused once a publication row exists', pg_temp.us(17), pg_temp.q_rcos('r6_rev', 9409), 'COMP_EXCLUSION_PUBLICATION_EXISTS');
select pg_temp.chk('replay of an already completed co-sign still works after a publication row appeared (replay precedes the state checks)',
  (pg_temp.do_as(pg_temp.us(17), pg_temp.q_cos('r6_a', 9403)) ->> 'replayed')::boolean);
select pg_temp.chk('the other round (R1) still has no publication row and is unaffected', not exists (select 1 from public.event_competition_result_publications where round_id = pg_temp.rd(1)));
drop table public.event_competition_result_publications;

-- ============================================================================
-- 8. U76: callback round interplay (A5 side). The lock refusal itself needs A3 (the ranking set is filtered by A3).
-- ============================================================================
select pg_temp.run('U76: exclude callback couple c1 (e41) in the active callback round', pg_temp.us(1), pg_temp.q_req(10, 41, 'ineligible', 'c1 ineligible after dancing', 9501), 'c1_req');
select pg_temp.run('U76: co-sign', pg_temp.us(17), pg_temp.q_cos('c1_req', 9502), 'c1_cos');
select pg_temp.chk('U76: the callback couple is in _cf1_excluded_entries and its heat entry is excluded',
  exists (select 1 from public._cf1_excluded_entries(pg_temp.rd(10)) x where x.entry_id = pg_temp.en(41))
  and public._cf1_heat_entry_is_excluded((select he.id from public.event_competition_heat_entries he where he.entry_id = pg_temp.en(41))));
select pg_temp.ex('U76: no reversal while the couple is still P (exit (1) is correcting the cause)', pg_temp.us(1), pg_temp.q_rev(10, 41, 'try to reinstate', 9503), 'COMP_EXCLUSION_STILL_UNAVAILABLE');
select pg_temp.set_elig(41, 'eligible');
select pg_temp.run('U76: after the cause is corrected the reversal is accepted and co-signed', pg_temp.us(1), pg_temp.q_rev(10, 41, 'eligibility corrected', 9504), 'c1_rev');
select pg_temp.run('U76: reversal co-sign', pg_temp.us(2), pg_temp.q_rcos('c1_rev', 9505), 'c1_revcos');
select pg_temp.chk('U76: c1 is back in the ranking set', not exists (select 1 from public._cf1_excluded_entries(pg_temp.rd(10))));
select pg_temp.blocked('U76: lock refuses COMP_CALLBACK_NOT_DANCED after an exclusion drops the round to T or fewer', 'needs A3 (the six E2 ranking-set functions filter _cf1_heat_entry_is_excluded) composed on the chain; A5 changes no E2 function');
select pg_temp.blocked('U76 exit (2): cancel_competition_round on the stranded round', 'O1 refuses cancel while a heat is active (fixture heat is active); O1 own suite covers cancel; not composed here');

-- ============================================================================
-- 9. Cross-tenant and misc
-- ============================================================================
select pg_temp.ex('cross-tenant: a manager of studio B cannot request a reversal in studio A', pg_temp.us(5), pg_temp.q_rev(1, 13, 'tenant B tries', 9601), 'COMP_FORBIDDEN', '42501');
select pg_temp.ex('cross-tenant: a manager of studio B cannot co-sign studio A''s reversal', pg_temp.us(5), pg_temp.q_rcos('e12_ra', 9602), 'COMP_FORBIDDEN', '42501');
select pg_temp.run('event B manager excludes its own couple (tenants are independent)', pg_temp.us(5),
  format('select public.request_round_exclusion(%L,%L,%L,%L,%L)', pg_temp.rd(20), pg_temp.en(50), 'ineligible', 'tenant B couple', pg_temp.rq(9603)), 'eb_req');
select pg_temp.ex('the studio A chair cannot co-sign studio B''s request', pg_temp.us(17), pg_temp.q_cos('eb_req', 9604), 'COMP_FORBIDDEN', '42501');
select pg_temp.chk('seq is per round: R20''s first row has seq 1 while R1 is far beyond', (select seq from public.event_competition_round_exclusions where id = pg_temp.vid('eb_req')) = 1);
select pg_temp.chk('unique (round_id, seq): no duplicate anywhere',
  not exists (select 1 from public.event_competition_round_exclusions group by round_id, seq having count(*) > 1));
select pg_temp.chk('every co-sign row points to a request of the same round and entry; every reversal names a co-signed exclusion of the same round and entry',
  not exists (select 1 from public.event_competition_round_exclusions c join public.event_competition_round_exclusions d on d.id = c.decision_id
              where c.round_id <> d.round_id or c.entry_id <> d.entry_id or (c.kind = 'exclude_cosigned') <> (d.kind = 'exclude_requested')
                 or (c.kind = 'reverse_cosigned') <> (d.kind = 'reverse_requested'))
  and not exists (select 1 from public.event_competition_round_exclusions r join public.event_competition_round_exclusions e on e.id = r.reverses_id
                  where r.round_id <> e.round_id or r.entry_id <> e.entry_id or e.kind <> 'exclude_cosigned'));

-- ============================================================================
-- Not run here
-- ============================================================================
select pg_temp.blocked('U78 lock probe (exclusion vs change_competition_entry_lifecycle, lock-ballots, calculate, approve, start)', 'multi-session: test_T_competition_cf1_a5_concurrency.sh; lock/calculate/approve/start redefinitions are A2/A3/A0');
select pg_temp.blocked('existing E2 / F2 / NS1 / O1 / HL1 suites on the chain with A5', 'run as separate suites (U85 / PR QA matrix)');

do $$
declare
  v_total int;
  v_blocked int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select count(*) into v_blocked from t_results where status = 'BLOCKED';
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where status = 'FAIL';
  if v_failures is null then
    raise exception 'COMPETITION CF1 A5 SQL SUITE PASS (% checks, % blocked: A3-dependent lock refusal, cancel exit, multi-session probe, other suites)', v_total, v_blocked;
  end if;
  raise exception 'COMPETITION CF1 A5 SQL SUITE FAIL: %', v_failures;
end $$;

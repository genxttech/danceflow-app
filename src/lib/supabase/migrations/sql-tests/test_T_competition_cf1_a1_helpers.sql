-- Competition CF1 package A1 -- eligibility helper, exclusion table and error codes regression suite.
--
-- Covers 20270120085000_competition_cf1_a1_eligibility_helpers.sql on top of the clean chain through HL1 (20270119090000).
-- Gates: U57 (predicate P and the refund join, incl. the real registration-sync path), U64 (predicate part only; the apply and
-- Final-start parts belong to A0 and are reported BLOCKED), U70 (helper privileges), U74 (exclusion table protections).
-- Run as a SUPERUSER (fixture rows are placed with session_replication_role = replica, like the E2/HL1 suites). One transaction,
-- synthetic fixtures only (UUID block ...-cf1a10XXXXXX). The final block ALWAYS raises, so nothing persists:
--   "COMPETITION CF1 A1 SQL SUITE PASS (<n> checks, <b> blocked ...)"  or  "... FAIL: <failures>".
-- Each check reports PASS / FAIL / BLOCKED; there is no NOT RUN inside this file (what is not here is listed in the verdict).

begin;

create temp table t_results (name text, ok boolean, detail text, status text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

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

create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    perform pg_temp.chk(p_name, true, 'ok');
  exception when others then
    perform pg_temp.chk(p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

-- The statement must fail, with a message containing p_fragment (case-insensitive); p_state, when given, must equal the SQLSTATE.
create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text, p_state text default null) returns void
language plpgsql as $$
declare
  v_unexpected boolean := false;
begin
  begin
    execute p_sql;
    v_unexpected := true;
    raise exception 'rollback probe';
  exception when others then
    if not v_unexpected then
      perform pg_temp.chk(p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0 and (p_state is null or sqlstate = p_state), sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then
    perform pg_temp.chk(p_name, false, 'statement unexpectedly succeeded');
  end if;
end $$;

-- The eleven functions A1 owns (later CF1 packages add more _cf1_* functions with their own grants).
create or replace function pg_temp.a1_fns() returns text[] language sql immutable as $$ select array['_cf1_entry_unavailable_reason', '_cf1_entry_unavailable', '_cf1_round_roster_problems', '_cf1_is_callback_final', '_cf1_count_available_entries', '_cf1_eligible_roster_count', '_cf1_final_minimum_ok', '_cf1_heat_entry_is_excluded', '_cf1_excluded_entries', '_cf1_error_codes', '_cf1_require_roster_eligible'] $$;

-- true when an exclusion row with this reason can be inserted (the insert is rolled back)
create or replace function pg_temp.try_reason(p_reason text, p_seq integer, p_rid text) returns boolean
language plpgsql as $$
begin
  begin
    insert into public.event_competition_round_exclusions (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq)
    values (pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), 'exclude_requested', 'other', p_reason, pg_temp.u('000001'), 'manager', pg_temp.u(p_rid), 900 + p_seq);
    raise exception 'rollback probe';
  exception when others then
    return sqlerrm = 'rollback probe';
  end;
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-cf1a10' || p_suffix)::uuid $$;

-- The reason _cf1_round_roster_problems reports for an entry in a round, or null.
create or replace function pg_temp.rsn(p_round text, p_entry text) returns text
language sql stable as $$
  select reason from public._cf1_round_roster_problems(pg_temp.u(p_round)) where entry_id = pg_temp.u(p_entry)
$$;

-- Runs the statement and returns the PG_EXCEPTION_DETAIL of the error it raises (null when it does not raise).
create or replace function pg_temp.catch_detail(p_sql text) returns text
language plpgsql as $$
declare v_detail text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return v_detail;
  end;
  return null;
end $$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (superuser, replica mode for placements)
-- ============================================================================
-- A0 compatibility: once A0 (20270120090000) is applied its ENABLE ALWAYS guards refuse the hand-built Final heat rows below (the suite
-- places heats and heat entries directly, like the E2/HL1 suites). Inside this rolled-back transaction the CF1 guards on the four fixture
-- tables are switched off so the A1 predicate and readers are tested on the same fixtures with or without A0. A1's own triggers are untouched.
do $$
declare r record;
begin
  for r in select t.tgname, t.tgrelid::regclass as rel from pg_trigger t
           where not t.tgisinternal and t.tgname like 'cf1_%'
             and t.tgrelid in ('public.event_competition_heats'::regclass, 'public.event_competition_heat_entries'::regclass,
                               'public.event_competition_rounds'::regclass, 'public.event_competition_entries'::regclass) loop
    execute format('alter table %s disable trigger %I', r.rel, r.tgname);
  end loop;
end $$;

insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-cf1a1-actor@example.test'), (pg_temp.u('000002'), 't-cf1a1-cosign@example.test');
insert into public.profiles (id, email, full_name)
select id, email, 'CF1A1 ' || split_part(email, '@', 1) from auth.users where id::text like '00000000-0000-0000-0000-cf1a10%';

insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'CF1 A1 Studio', 't-cf1a1-studio');
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'CF1 A1 Comp', 't-cf1a1-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true),
  (pg_temp.u('00e002'), pg_temp.u('00a001'), 'CF1 A1 Cascade Comp', 't-cf1a1-e2', 'competition', current_date + 40, current_date + 40, 'published', 'public', true);

insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status, advancement_method) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Callback program', 'country', 'relative', 'skating', 'configured', 'promote_callback'),
  (pg_temp.u('001002'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Plain program', 'country', 'relative', 'skating', 'configured', 'none'),
  (pg_temp.u('001003'), pg_temp.u('00e002'), pg_temp.u('00a001'), 'Cascade program', 'country', 'relative', 'skating', 'configured', 'promote_callback');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Callback contest', 'single_dance', 'pro_am', 'open'),
  (pg_temp.u('002002'), pg_temp.u('00e001'), pg_temp.u('001002'), 'Plain contest', 'single_dance', 'pro_am', 'open'),
  (pg_temp.u('002003'), pg_temp.u('00e002'), pg_temp.u('001003'), 'Cascade contest', 'single_dance', 'pro_am', 'open');
-- D1 callback roster under test; D2 Final-only (plain program); D3 prelim+final in a NON-callback program; D4 qualifying+final in a
-- callback program; D5 callback 3 entries / 2 unavailable; D6 callback 2 eligible; D7 callback 1 eligible; D8 Final-only 1 entry; D9 cascade.
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D1', 'open'),
  (pg_temp.u('003002'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('002002'), 'D2', 'open'),
  (pg_temp.u('003003'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('002002'), 'D3', 'open'),
  (pg_temp.u('003004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D4', 'open'),
  (pg_temp.u('003005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D5', 'open'),
  (pg_temp.u('003006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D6', 'open'),
  (pg_temp.u('003007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'D7', 'open'),
  (pg_temp.u('003008'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('002002'), 'D8', 'open'),
  (pg_temp.u('003009'), pg_temp.u('00e002'), pg_temp.u('001003'), pg_temp.u('002003'), 'D9', 'open');

-- Rounds: 006001 D1 prelim, 006002 D1 final, 006003 D2 final-only, 006004 D3 prelim, 006005 D3 final, 006006 D4 qualifying, 006007 D4 final,
-- 006008/009 D5, 006010/011 D6, 006012/013 D7, 006014 D8 final-only, 006015/016 D9 (cascade).
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'D1 Callback', 'preliminary', 1, 'draft', 'callback_tally'),
  (pg_temp.u('006002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'D1 Final', 'final', 2, 'draft', 'ordinal_majority'),
  (pg_temp.u('006003'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('003002'), 'D2 Final only', 'final', 1, 'draft', 'ordinal_majority'),
  (pg_temp.u('006004'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('003003'), 'D3 Prelim', 'preliminary', 1, 'draft', 'callback_tally'),
  (pg_temp.u('006005'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('003003'), 'D3 Final', 'final', 2, 'draft', 'ordinal_majority'),
  (pg_temp.u('006006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003004'), 'D4 Qualifying', 'qualifying', 1, 'draft', 'callback_tally'),
  (pg_temp.u('006007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003004'), 'D4 Final', 'final', 2, 'draft', 'ordinal_majority'),
  (pg_temp.u('006008'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003005'), 'D5 Callback', 'preliminary', 1, 'draft', 'callback_tally'),
  (pg_temp.u('006009'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003005'), 'D5 Final', 'final', 2, 'draft', 'ordinal_majority'),
  (pg_temp.u('006010'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003006'), 'D6 Callback', 'preliminary', 1, 'draft', 'callback_tally'),
  (pg_temp.u('006011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003006'), 'D6 Final', 'final', 2, 'draft', 'ordinal_majority'),
  (pg_temp.u('006012'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003007'), 'D7 Callback', 'preliminary', 1, 'draft', 'callback_tally'),
  (pg_temp.u('006013'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003007'), 'D7 Final', 'final', 2, 'draft', 'ordinal_majority'),
  (pg_temp.u('006014'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('003008'), 'D8 Final only', 'final', 1, 'draft', 'ordinal_majority'),
  (pg_temp.u('006015'), pg_temp.u('00e002'), pg_temp.u('001003'), pg_temp.u('003009'), 'D9 Callback', 'preliminary', 1, 'draft', 'callback_tally'),
  (pg_temp.u('006016'), pg_temp.u('00e002'), pg_temp.u('001003'), pg_temp.u('003009'), 'D9 Final', 'final', 2, 'draft', 'ordinal_majority');

-- Orders and registrations (refund / cancellation evidence)
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, payment_status) values
  (pg_temp.u('0a0001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b1@example.test', 'paid'),
  (pg_temp.u('0a0002'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b2@example.test', 'refunded'),
  (pg_temp.u('0a0003'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b3@example.test', 'partially_refunded'),
  (pg_temp.u('0a0004'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b4@example.test', 'failed'),
  (pg_temp.u('0a0005'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b5@example.test', 'pending'),
  (pg_temp.u('0a0006'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b6@example.test', 'paid');
insert into public.event_registrations (id, studio_id, event_id, order_id, status, payment_status, attendee_first_name, attendee_last_name, attendee_email) values
  (pg_temp.u('0b0001'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'confirmed', 'paid', 'G', 'Paid', 'g1@example.test'),
  (pg_temp.u('0b0002'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'cancelled', 'paid', 'G', 'Cancelled', 'g2@example.test'),
  (pg_temp.u('0b0003'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'refunded', 'paid', 'G', 'RefStatus', 'g3@example.test'),
  (pg_temp.u('0b0004'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'confirmed', 'refunded', 'G', 'PayRef', 'g4@example.test'),
  (pg_temp.u('0b0005'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'confirmed', 'failed', 'G', 'PayFail', 'g5@example.test'),
  (pg_temp.u('0b0006'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), 'confirmed', 'paid', 'G', 'PaidB', 'g6@example.test'),
  (pg_temp.u('0b0007'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0005'), 'pending', 'pending', 'G', 'Pending', 'g7@example.test'),
  (pg_temp.u('0b0008'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0006'), 'confirmed', 'paid', 'G', 'SyncLocked', 'g8@example.test'),
  (pg_temp.u('0b0009'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0006'), 'confirmed', 'paid', 'G', 'SyncOpen', 'g9@example.test'),
  (pg_temp.u('0b000a'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0006'), 'checked_in', 'partial', 'G', 'CheckedIn', 'ga@example.test'),
  (pg_temp.u('0b000b'), pg_temp.u('00a001'), pg_temp.u('00e001'), pg_temp.u('0a0002'), 'confirmed', 'paid', 'G', 'PaidInRefundedOrder', 'gb@example.test');

-- Entries (inserts bypass the link-validation trigger: replica). D1 roster under test:
--  e01 no links | e02 pending | e03 withdrawn | e04 ineligible | e05 needs_review | e06 waived | e07 reg cancelled | e08 reg status refunded
--  e09 reg payment refunded | e10 reg payment failed | e11 reg paid + order paid | e12 order refunded (no reg) | e13 order failed (no reg)
--  e14 order partially_refunded (no reg) | e15 order pending | e16,e17 SAME cancelled reg (multi-entry) in a paid order | e18 other reg, same paid order
--  e19 reg pending | e20 ineligible but its heat entry is scratched | e21 ineligible, only in a cancelled heat | e22 ineligible, only in a draft version
--  e23 reg paid but its order refunded (order-level evidence wins) | e24 reg checked_in/partial | es sync target on a LOCKED heat | eu sync target on an open heat
set session_replication_role = replica;
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number, registration_id, order_id) values
  (pg_temp.u('008001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e01', 'confirmed', 'eligible', '1', null, null),
  (pg_temp.u('008002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e02', 'pending', 'eligible', '2', null, null),
  (pg_temp.u('008003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e03', 'withdrawn', 'eligible', '3', null, null),
  (pg_temp.u('008004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e04', 'confirmed', 'ineligible', '4', null, null),
  (pg_temp.u('008005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e05', 'confirmed', 'needs_review', '5', null, null),
  (pg_temp.u('008006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e06', 'confirmed', 'waived', '6', null, null),
  (pg_temp.u('008007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e07', 'confirmed', 'eligible', '7', pg_temp.u('0b0002'), pg_temp.u('0a0001')),
  (pg_temp.u('008008'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e08', 'confirmed', 'eligible', '8', pg_temp.u('0b0003'), pg_temp.u('0a0001')),
  (pg_temp.u('008009'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e09', 'confirmed', 'eligible', '9', pg_temp.u('0b0004'), pg_temp.u('0a0001')),
  (pg_temp.u('008010'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e10', 'confirmed', 'eligible', '10', pg_temp.u('0b0005'), pg_temp.u('0a0001')),
  (pg_temp.u('008011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e11', 'confirmed', 'eligible', '11', pg_temp.u('0b0001'), pg_temp.u('0a0001')),
  (pg_temp.u('008012'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e12', 'confirmed', 'eligible', '12', null, pg_temp.u('0a0002')),
  (pg_temp.u('008013'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e13', 'confirmed', 'eligible', '13', null, pg_temp.u('0a0004')),
  (pg_temp.u('008014'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e14', 'confirmed', 'eligible', '14', null, pg_temp.u('0a0003')),
  (pg_temp.u('008015'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e15', 'confirmed', 'eligible', '15', null, pg_temp.u('0a0005')),
  (pg_temp.u('008016'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e16', 'confirmed', 'eligible', '16', pg_temp.u('0b0002'), pg_temp.u('0a0001')),
  (pg_temp.u('008017'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e17', 'confirmed', 'eligible', '17', pg_temp.u('0b0002'), pg_temp.u('0a0001')),
  (pg_temp.u('008018'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e18', 'confirmed', 'eligible', '18', pg_temp.u('0b0006'), pg_temp.u('0a0001')),
  (pg_temp.u('008019'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e19', 'confirmed', 'eligible', '19', pg_temp.u('0b0007'), pg_temp.u('0a0005')),
  (pg_temp.u('008020'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e20', 'confirmed', 'ineligible', '20', null, null),
  (pg_temp.u('008021'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e21', 'confirmed', 'ineligible', '21', null, null),
  (pg_temp.u('008022'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e22', 'confirmed', 'ineligible', '22', null, null),
  (pg_temp.u('008023'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e23', 'confirmed', 'eligible', '23', pg_temp.u('0b000b'), pg_temp.u('0a0002')),
  (pg_temp.u('008024'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'e24', 'confirmed', 'eligible', '24', pg_temp.u('0b000a'), pg_temp.u('0a0001')),
  (pg_temp.u('0080a1'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'es', 'confirmed', 'eligible', '31', pg_temp.u('0b0008'), pg_temp.u('0a0006')),
  (pg_temp.u('0080a2'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'eu', 'confirmed', 'eligible', '32', pg_temp.u('0b0009'), pg_temp.u('0a0006')),
  -- other divisions
  (pg_temp.u('008201'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('003002'), 'd2-1', 'confirmed', 'eligible', '41', null, null),
  (pg_temp.u('008301'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('003003'), 'd3-1', 'confirmed', 'eligible', '51', null, null),
  (pg_temp.u('008401'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003004'), 'd4-1', 'confirmed', 'eligible', '61', null, null),
  (pg_temp.u('008501'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003005'), 'd5-1', 'confirmed', 'eligible', '71', null, null),
  (pg_temp.u('008502'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003005'), 'd5-2', 'confirmed', 'ineligible', '72', null, null),
  (pg_temp.u('008503'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003005'), 'd5-3', 'withdrawn', 'eligible', '73', null, null),
  (pg_temp.u('008601'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003006'), 'd6-1', 'confirmed', 'eligible', '81', null, null),
  (pg_temp.u('008602'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003006'), 'd6-2', 'confirmed', 'eligible', '82', null, null),
  (pg_temp.u('008701'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003007'), 'd7-1', 'confirmed', 'eligible', '91', null, null),
  (pg_temp.u('008801'), pg_temp.u('00e001'), pg_temp.u('001002'), pg_temp.u('003008'), 'd8-1', 'confirmed', 'eligible', '95', null, null),
  (pg_temp.u('008901'), pg_temp.u('00e002'), pg_temp.u('001003'), pg_temp.u('003009'), 'd9-1', 'confirmed', 'eligible', '99', null, null);

insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values
  (pg_temp.u('00c001'), pg_temp.u('00e001'), 1, 'v1', 'published', now()),
  (pg_temp.u('00c002'), pg_temp.u('00e001'), 2, 'v2 draft', 'draft', null);
-- heats: 00d201 D1 final open | 00d202 D1 final LOCKED | 00d203 D1 final open (second heat of the same round) | 00d204 D1 final CANCELLED
--        00d205 D1 final in the DRAFT version | 00d101 D1 callback round heat (a different round)
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status, lock_state) values
  (pg_temp.u('00d101'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 1, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled', 'open'),
  (pg_temp.u('00d201'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006002'), 2, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled', 'open'),
  (pg_temp.u('00d202'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006002'), 3, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled', 'locked'),
  (pg_temp.u('00d203'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006002'), 4, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled', 'open'),
  (pg_temp.u('00d204'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006002'), 5, pg_temp.u('002001'), pg_temp.u('00c001'), 'cancelled', 'open'),
  (pg_temp.u('00d205'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006002'), 6, pg_temp.u('002001'), pg_temp.u('00c002'), 'scheduled', 'open'),
  (pg_temp.u('00d301'), pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('006003'), 7, pg_temp.u('002002'), pg_temp.u('00c001'), 'scheduled', 'open'),
  (pg_temp.u('00d302'), pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.u('006005'), 8, pg_temp.u('002002'), pg_temp.u('00c001'), 'scheduled', 'open'),
  (pg_temp.u('00d303'), pg_temp.u('00e001'), pg_temp.u('003004'), pg_temp.u('006007'), 9, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled', 'open'),
  (pg_temp.u('00d304'), pg_temp.u('00e001'), pg_temp.u('003005'), pg_temp.u('006009'), 10, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled', 'open'),
  (pg_temp.u('00d305'), pg_temp.u('00e001'), pg_temp.u('003006'), pg_temp.u('006011'), 11, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled', 'open'),
  (pg_temp.u('00d306'), pg_temp.u('00e001'), pg_temp.u('003007'), pg_temp.u('006013'), 12, pg_temp.u('002001'), pg_temp.u('00c001'), 'scheduled', 'open'),
  (pg_temp.u('00d307'), pg_temp.u('00e001'), pg_temp.u('003008'), pg_temp.u('006014'), 13, pg_temp.u('002002'), pg_temp.u('00c001'), 'scheduled', 'open');

-- D1 Final heat entries. Open heat 00d201: e01..e15 and eu; LOCKED heat 00d202: e16, e17, e18, es; second open heat 00d203: e01 (again), e19, e20(scratched), e23, e24.
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status)
select pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d201'), pg_temp.u('0080' || lpad(n::text, 2, '0')), n, 'scheduled'
from generate_series(1, 15) n;
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order, status) values
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d201'), pg_temp.u('0080a2'), 16, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d202'), pg_temp.u('008016'), 1, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d202'), pg_temp.u('008017'), 2, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d202'), pg_temp.u('008018'), 3, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d202'), pg_temp.u('0080a1'), 4, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d203'), pg_temp.u('008001'), 1, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d203'), pg_temp.u('008019'), 2, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d203'), pg_temp.u('008020'), 3, 'scratched'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d203'), pg_temp.u('008023'), 4, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d203'), pg_temp.u('008024'), 5, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d204'), pg_temp.u('008021'), 1, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d205'), pg_temp.u('008022'), 1, 'scheduled'),
  -- e01 also sits in a heat of a DIFFERENT round (the D1 callback round)
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d101'), pg_temp.u('008001'), 1, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('00d101'), pg_temp.u('008002'), 2, 'scheduled'),
  -- other divisions
  (pg_temp.u('00e001'), pg_temp.u('003002'), pg_temp.u('00d301'), pg_temp.u('008201'), 1, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003003'), pg_temp.u('00d302'), pg_temp.u('008301'), 1, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003004'), pg_temp.u('00d303'), pg_temp.u('008401'), 1, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003005'), pg_temp.u('00d304'), pg_temp.u('008501'), 1, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003005'), pg_temp.u('00d304'), pg_temp.u('008502'), 2, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003005'), pg_temp.u('00d304'), pg_temp.u('008503'), 3, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003006'), pg_temp.u('00d305'), pg_temp.u('008601'), 1, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003006'), pg_temp.u('00d305'), pg_temp.u('008602'), 2, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003007'), pg_temp.u('00d306'), pg_temp.u('008701'), 1, 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003008'), pg_temp.u('00d307'), pg_temp.u('008801'), 1, 'scheduled');
set session_replication_role = origin;

-- ============================================================================
-- 0. Surface
-- ============================================================================
select pg_temp.chk('all eleven A1 functions exist',
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (
     '_cf1_entry_unavailable_reason', '_cf1_entry_unavailable', '_cf1_round_roster_problems', '_cf1_is_callback_final',
     '_cf1_count_available_entries', '_cf1_eligible_roster_count', '_cf1_final_minimum_ok', '_cf1_heat_entry_is_excluded',
     '_cf1_excluded_entries', '_cf1_error_codes', '_cf1_require_roster_eligible')) = 11);
select pg_temp.chk('the exclusion table exists with RLS on and no policy',
  (select relrowsecurity from pg_class where oid = 'public.event_competition_round_exclusions'::regclass)
  and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'event_competition_round_exclusions'));
-- A1 itself redefines neither function (its migration contains no create-or-replace of either; checked by grep in review). Later CF1
-- packages do: A2 redefines the lock function (md5 c4ba327d...), A3 the ranking-set functions. So accept the post-HL1 text or the later one.
select pg_temp.chk('lock_competition_round_ballots is the post-HL1 text or the A2 text (A1 redefines nothing)',
  md5(replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r', ''))
    in ('6e4175342d51ffe274d70ce413bae8c3', 'c4ba327df7943d559ab52ccd07d20ea0'));
select pg_temp.chk('_compe2_round_entries keeps the NS1 no-show condition (A3 may add the exclusion filter; A1 adds nothing)',
  pg_get_functiondef('public._compe2_round_entries(uuid)'::regprocedure) like '%competition_heat_entry_is_no_show%');
select pg_temp.chk('the roster-problems function reuses _compe2_round_entries (does not re-derive the ranking set)',
  (select prosrc from pg_proc where oid = 'public._cf1_round_roster_problems(uuid)'::regprocedure) like '%_compe2_round_entries(p_round_id)%'
  and (select prosrc from pg_proc where oid = 'public._cf1_round_roster_problems(uuid)'::regprocedure) not like '%event_competition_heat_entries%');

-- ============================================================================
-- 1. U57: predicate P, one entry at a time (per-entry semantics, no false positives)
-- ============================================================================
select pg_temp.chk('U57 P: confirmed + eligible + no links is available (e01)', not public._cf1_entry_unavailable(pg_temp.u('008001')));
select pg_temp.chk('U57 P (i): status pending is unavailable (e02)', public._cf1_entry_unavailable_reason(pg_temp.u('008002')) = 'entry_not_confirmed');
select pg_temp.chk('U57 P (i): status withdrawn is unavailable (e03)', public._cf1_entry_unavailable_reason(pg_temp.u('008003')) = 'entry_not_confirmed');
select pg_temp.chk('U57 P (ii): eligibility ineligible is unavailable (e04)', public._cf1_entry_unavailable_reason(pg_temp.u('008004')) = 'entry_ineligible');
select pg_temp.chk('U57 P (ii): needs_review / waived are NOT unavailable (e05, e06)',
  not public._cf1_entry_unavailable(pg_temp.u('008005')) and not public._cf1_entry_unavailable(pg_temp.u('008006')));
select pg_temp.chk('U57 P (iii-a): registration status cancelled (e07)', public._cf1_entry_unavailable_reason(pg_temp.u('008007')) = 'registration_cancelled');
select pg_temp.chk('U57 P (iii-a): registration status refunded with payment_status paid (e08)', public._cf1_entry_unavailable_reason(pg_temp.u('008008')) = 'registration_refunded');
select pg_temp.chk('U57 P (iii-a): registration payment_status refunded (e09)', public._cf1_entry_unavailable_reason(pg_temp.u('008009')) = 'registration_payment_refunded');
select pg_temp.chk('U57 P (iii-a): registration payment_status failed (e10)', public._cf1_entry_unavailable_reason(pg_temp.u('008010')) = 'registration_payment_failed');
select pg_temp.chk('P: paid registration in a paid order is available (e11; a refund of just this entry is not visible in the data: documented false negative)', not public._cf1_entry_unavailable(pg_temp.u('008011')));
select pg_temp.chk('U57 P (iii-b): fully refunded order (e12)', public._cf1_entry_unavailable_reason(pg_temp.u('008012')) = 'order_payment_refunded');
select pg_temp.chk('U57 P (iii-b): failed order (e13)', public._cf1_entry_unavailable_reason(pg_temp.u('008013')) = 'order_payment_failed');
select pg_temp.chk('U57 P: partially_refunded order excludes nobody (e14)', not public._cf1_entry_unavailable(pg_temp.u('008014')));
select pg_temp.chk('U57 P: pending order / pending registration are available (e15, e19)',
  not public._cf1_entry_unavailable(pg_temp.u('008015')) and not public._cf1_entry_unavailable(pg_temp.u('008019')));
select pg_temp.chk('U57 P multi-entry registration: every entry that references the cancelled registration is unavailable (e16, e17)',
  public._cf1_entry_unavailable(pg_temp.u('008016')) and public._cf1_entry_unavailable(pg_temp.u('008017')));
select pg_temp.chk('U57 P multi-entry order: a sibling entry on ANOTHER registration of the same order is not unavailable (e18, e11)',
  not public._cf1_entry_unavailable(pg_temp.u('008018')) and not public._cf1_entry_unavailable(pg_temp.u('008011')));
select pg_temp.chk('U57 P (iii-b): a paid registration inside a refunded order is unavailable (e23)',
  public._cf1_entry_unavailable_reason(pg_temp.u('008023')) = 'order_payment_refunded');
select pg_temp.chk('U57 P: checked_in / partial registration is available (e24)', not public._cf1_entry_unavailable(pg_temp.u('008024')));
select pg_temp.chk('P: an unknown entry id is unavailable (entry_missing); null is unavailable',
  public._cf1_entry_unavailable_reason(pg_temp.u('0ffff1')) = 'entry_missing' and public._cf1_entry_unavailable(null));
select pg_temp.chk('P is a pure reader: same answer twice, entry row unchanged',
  public._cf1_entry_unavailable(pg_temp.u('008007')) = public._cf1_entry_unavailable(pg_temp.u('008007'))
  and (select count(*) from public.event_competition_entries where id = pg_temp.u('008007') and status = 'confirmed') = 1);

-- ============================================================================
-- 1b. U57: the refunded-but-confirmed state through the REAL registration-sync path (the entry sits on a locked heat)
-- ============================================================================
select pg_temp.chk('U57 sync fixture: es is confirmed and available before the refund; es heat is locked',
  not public._cf1_entry_unavailable(pg_temp.u('0080a1'))
  and (select lock_state from public.event_competition_heats where id = pg_temp.u('00d202')) = 'locked');
update public.event_registrations set payment_status = 'refunded' where id = pg_temp.u('0b0008');   -- real sync trigger (origin mode)
update public.event_registrations set payment_status = 'refunded' where id = pg_temp.u('0b0009');
select pg_temp.chk('U57 sync path: the entry on the LOCKED heat stays confirmed (the sync skips it)',
  (select status from public.event_competition_entries where id = pg_temp.u('0080a1')) = 'confirmed');
select pg_temp.chk('U57 sync path: the entry on the open heat was withdrawn by the sync',
  (select status from public.event_competition_entries where id = pg_temp.u('0080a2')) = 'withdrawn');
select pg_temp.chk('U57 sync path: refunded-but-confirmed es is unavailable by registration_payment_refunded',
  public._cf1_entry_unavailable_reason(pg_temp.u('0080a1')) = 'registration_payment_refunded');
select pg_temp.chk('U57 sync path: the withdrawn entry is unavailable by entry_not_confirmed',
  public._cf1_entry_unavailable_reason(pg_temp.u('0080a2')) = 'entry_not_confirmed');
select pg_temp.chk('U57 sync path: the refunded-but-confirmed entry is reported in the D1 Final roster problems',
  pg_temp.rsn('006002', '0080a1') = 'registration_payment_refunded');

-- ============================================================================
-- 2. U57: the set function (ranking set from _compe2_round_entries only)
-- ============================================================================
select pg_temp.chk('U57 roster problems: exactly the expected entries of the D1 Final, with reasons',
  (select jsonb_object_agg(entry_id, reason) from public._cf1_round_roster_problems(pg_temp.u('006002'))) =
  (select jsonb_object_agg(k, v) from (values
     (pg_temp.u('008003'), 'entry_not_confirmed'), (pg_temp.u('008004'), 'entry_ineligible'),
     (pg_temp.u('008007'), 'registration_cancelled'), (pg_temp.u('008008'), 'registration_refunded'),
     (pg_temp.u('008009'), 'registration_payment_refunded'), (pg_temp.u('008010'), 'registration_payment_failed'),
     (pg_temp.u('008012'), 'order_payment_refunded'), (pg_temp.u('008013'), 'order_payment_failed'),
     (pg_temp.u('008016'), 'registration_cancelled'), (pg_temp.u('008017'), 'registration_cancelled'),
     (pg_temp.u('0080a1'), 'registration_payment_refunded'), (pg_temp.u('0080a2'), 'entry_not_confirmed'), (pg_temp.u('008023'), 'order_payment_refunded'),
     (pg_temp.u('008002'), 'entry_not_confirmed')) as t(k, v)));
select pg_temp.chk('U57 roster problems: a scratched heat entry (e20) is NOT in the ranking set, so it is not reported', pg_temp.rsn('006002', '008020') is null);
select pg_temp.chk('U57 roster problems: entries only in a cancelled heat (e21) or a draft-version heat (e22) are not reported',
  pg_temp.rsn('006002', '008021') is null and pg_temp.rsn('006002', '008022') is null);
select pg_temp.chk('U57 roster problems: ordered by entry id and unique per entry (e01 sits in two heats, available)',
  (select array_agg(entry_id order by entry_id) from public._cf1_round_roster_problems(pg_temp.u('006002')))
   = (select array_agg(entry_id order by entry_id) from (select distinct entry_id from public._cf1_round_roster_problems(pg_temp.u('006002'))) d)
  and (select count(*) from public._cf1_round_roster_problems(pg_temp.u('006002'))) = (select count(distinct entry_id) from public._cf1_round_roster_problems(pg_temp.u('006002'))));
select pg_temp.chk('U57 roster problems: an unknown round reports nothing, and its problems stay within the ranking set',
  not exists (select 1 from public._cf1_round_roster_problems(pg_temp.u('006001')) where entry_id not in (select unnest(public._compe2_round_entries(pg_temp.u('006001')))))
  and not exists (select 1 from public._cf1_round_roster_problems(pg_temp.u('0fffff'))));
select pg_temp.chk('U57 roster problems are a subset of E2''s ranking set',
  not exists (select 1 from public._cf1_round_roster_problems(pg_temp.u('006002')) p
              where p.entry_id <> all (public._compe2_round_entries(pg_temp.u('006002')))));

-- ============================================================================
-- 3. Callback-Final detection, eligible count, minimum of two (callback Finals ONLY)
-- ============================================================================
select pg_temp.chk('callback Final: D1 Final (final after a preliminary of a promote_callback program)', public._cf1_is_callback_final(pg_temp.u('006002')));
select pg_temp.chk('callback Final: the preliminary itself is not one', not public._cf1_is_callback_final(pg_temp.u('006001')));
select pg_temp.chk('callback Final: a Final-only division is not one (D2, D8)',
  not public._cf1_is_callback_final(pg_temp.u('006003')) and not public._cf1_is_callback_final(pg_temp.u('006014')));
select pg_temp.chk('callback Final: preliminary + final in a program WITHOUT promote_callback is not one (D3)', not public._cf1_is_callback_final(pg_temp.u('006005')));
select pg_temp.chk('callback Final: final after a qualifying (not preliminary) round is not one (D4)', not public._cf1_is_callback_final(pg_temp.u('006007')));
select pg_temp.chk('callback Final: unknown / null round is not one', not public._cf1_is_callback_final(pg_temp.u('0fffff')) and not public._cf1_is_callback_final(null));
select pg_temp.chk('callback Final: D5, D6, D7 finals are',
  public._cf1_is_callback_final(pg_temp.u('006009')) and public._cf1_is_callback_final(pg_temp.u('006011')) and public._cf1_is_callback_final(pg_temp.u('006013')));

select pg_temp.chk('count helper: counts distinct available entries, ignores duplicates, nulls and unavailable',
  public._cf1_count_available_entries(array[pg_temp.u('008001'), pg_temp.u('008001'), pg_temp.u('008002'), null, pg_temp.u('008011')]::uuid[]) = 2
  and public._cf1_count_available_entries(null) = 0 and public._cf1_count_available_entries('{}'::uuid[]) = 0);
select pg_temp.chk('eligible roster count: D1 Final = ranking set minus P (e01, e05, e06, e11, e14, e15, e18, e19, e24 = 9)',
  public._cf1_eligible_roster_count(pg_temp.u('006002')) = 9);
select pg_temp.chk('eligible roster count: D5 (3 entries, 2 unavailable) = 1; D6 = 2; D7 = 1; unknown round = 0',
  public._cf1_eligible_roster_count(pg_temp.u('006009')) = 1 and public._cf1_eligible_roster_count(pg_temp.u('006011')) = 2
  and public._cf1_eligible_roster_count(pg_temp.u('006013')) = 1 and public._cf1_eligible_roster_count(pg_temp.u('0fffff')) = 0);
select pg_temp.chk('minimum: D1 Final (9 eligible) ok; D5 (1) NOT ok; D6 (2) ok; D7 (1) NOT ok',
  public._cf1_final_minimum_ok(pg_temp.u('006002')) and not public._cf1_final_minimum_ok(pg_temp.u('006009'))
  and public._cf1_final_minimum_ok(pg_temp.u('006011')) and not public._cf1_final_minimum_ok(pg_temp.u('006013')));
select pg_temp.chk('minimum NEVER applies to a Final-only division, even with one couple (D2, D8), nor to a non-callback prelim+final (D3) or a qualifying+final (D4)',
  public._cf1_final_minimum_ok(pg_temp.u('006003')) and public._cf1_final_minimum_ok(pg_temp.u('006014'))
  and public._cf1_final_minimum_ok(pg_temp.u('006005')) and public._cf1_final_minimum_ok(pg_temp.u('006007'))
  and public._cf1_eligible_roster_count(pg_temp.u('006014')) = 1);
select pg_temp.chk('minimum: a non-callback round and an unknown round are ok (rule does not apply)',
  public._cf1_final_minimum_ok(pg_temp.u('006001')) and public._cf1_final_minimum_ok(pg_temp.u('0fffff')));

-- ============================================================================
-- 4. The shared raiser (OD-17 D errors) and the catalogue
-- ============================================================================
select pg_temp.expect_msg('raiser: D1 Final stage lock -> COMP_ROSTER_ENTRY_UNAVAILABLE (P0001)',
  format($q$select public._cf1_require_roster_eligible(%L, 'lock')$q$, pg_temp.u('006002')), 'COMP_ROSTER_ENTRY_UNAVAILABLE', 'P0001');
select pg_temp.expect_msg('raiser: stage calculate', format($q$select public._cf1_require_roster_eligible(%L, 'calculate')$q$, pg_temp.u('006002')), 'COMP_ROSTER_ENTRY_UNAVAILABLE', 'P0001');
select pg_temp.expect_msg('raiser: stage approve', format($q$select public._cf1_require_roster_eligible(%L, 'approve')$q$, pg_temp.u('006002')), 'COMP_ROSTER_ENTRY_UNAVAILABLE', 'P0001');
select pg_temp.expect_msg('raiser: an unknown stage is refused', format($q$select public._cf1_require_roster_eligible(%L, 'start')$q$, pg_temp.u('006011')), 'unknown roster stage', 'P0001');
select pg_temp.expect_msg('raiser: a null stage is refused', format($q$select public._cf1_require_roster_eligible(%L, null)$q$, pg_temp.u('006011')), 'unknown roster stage', 'P0001');
select pg_temp.chk('raiser detail carries the stage, round and every unavailable entry with its reason',
  (select (detail::jsonb ->> 'stage') = 'approve' and jsonb_array_length(detail::jsonb -> 'entries') = 14
          and (detail::jsonb -> 'entries') @> jsonb_build_array(jsonb_build_object('entry_id', pg_temp.u('0080a1'), 'reason', 'registration_payment_refunded'))
   from (select pg_temp.catch_detail(format($q$select public._cf1_require_roster_eligible(%L, 'approve')$q$, pg_temp.u('006002'))) as detail) x));
select pg_temp.expect_ok('raiser: D6 (two eligible, none unavailable) passes', format($q$select public._cf1_require_roster_eligible(%L, 'lock')$q$, pg_temp.u('006011')));
select pg_temp.expect_msg('raiser: D7 callback Final with ONE eligible couple -> COMP_ROSTER_BELOW_MINIMUM (P0001)',
  format($q$select public._cf1_require_roster_eligible(%L, 'lock')$q$, pg_temp.u('006013')), 'COMP_ROSTER_BELOW_MINIMUM', 'P0001');
select pg_temp.expect_msg('raiser: D5 with unavailable couples reports the unavailable entries first',
  format($q$select public._cf1_require_roster_eligible(%L, 'calculate')$q$, pg_temp.u('006009')), 'COMP_ROSTER_ENTRY_UNAVAILABLE', 'P0001');
select pg_temp.expect_ok('raiser: a Final-only division with ONE eligible couple passes (D8, D2)',
  format($q$select public._cf1_require_roster_eligible(%L, 'approve'); select public._cf1_require_roster_eligible(%L, 'lock')$q$, pg_temp.u('006014'), pg_temp.u('006003')));
select pg_temp.expect_ok('raiser: a round with no ranking set passes (preliminary D4 qualifying)', format($q$select public._cf1_require_roster_eligible(%L, 'lock')$q$, pg_temp.u('006006')));

select pg_temp.chk('catalogue: the seven codes (six A1 codes + COMP_CALLBACK_TARGET_BELOW_MINIMUM from A4a), all P0001, none retryable',
  (select count(*) from public._cf1_error_codes()) = 7 and (select bool_and(sqlstate_code = 'P0001' and not retryable) from public._cf1_error_codes())
  and (select array_agg(code order by code) from public._cf1_error_codes()) = array[
    'COMP_ADVANCEMENT_BELOW_MINIMUM', 'COMP_ADVANCEMENT_ROSTER_INCOMPLETE', 'COMP_ADVANCEMENT_ROSTER_STALE',
    'COMP_CALLBACK_TARGET_BELOW_MINIMUM', 'COMP_EXCLUSION_NOT_DANCED', 'COMP_ROSTER_BELOW_MINIMUM', 'COMP_ROSTER_ENTRY_UNAVAILABLE']);

-- ============================================================================
-- 5. U70: helper privileges. No grants to PUBLIC, anon, authenticated or service_role; definer, pinned search_path.
-- ============================================================================
select pg_temp.chk('U70: no role among public/anon/authenticated/service_role may execute any A1 function',
  not exists (
    select 1 from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r
    where p.pronamespace = 'public'::regnamespace and p.proname = any (pg_temp.a1_fns())
      and has_function_privilege(r, p.oid, 'execute'))
  and not exists (
    select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.pronamespace = 'public'::regnamespace and p.proname = any (pg_temp.a1_fns()) and a.grantee = 0));
select pg_temp.chk('U70: every A1 function is SECURITY DEFINER with search_path = public, pg_temp',
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']) from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = any (pg_temp.a1_fns())));
select pg_temp.chk('U70: volatility: the raiser is VOLATILE, readers are STABLE, the catalogue is IMMUTABLE',
  (select provolatile from pg_proc where oid = 'public._cf1_require_roster_eligible(uuid,text)'::regprocedure) = 'v'
  and (select provolatile from pg_proc where oid = 'public._cf1_error_codes()'::regprocedure) = 'i'
  and (select bool_and(provolatile = 's') from pg_proc where pronamespace = 'public'::regnamespace and proname = any (pg_temp.a1_fns())
         and proname not in ('_cf1_require_roster_eligible', '_cf1_error_codes')));
set role authenticated;
select pg_temp.expect_msg('U70: authenticated cannot call _cf1_entry_unavailable', format($q$select public._cf1_entry_unavailable(%L)$q$, pg_temp.u('008001')), 'permission denied', '42501');
select pg_temp.expect_msg('U70: authenticated cannot call _cf1_round_roster_problems', format($q$select * from public._cf1_round_roster_problems(%L)$q$, pg_temp.u('006002')), 'permission denied', '42501');
select pg_temp.expect_msg('U70: authenticated cannot call _cf1_heat_entry_is_excluded', format($q$select public._cf1_heat_entry_is_excluded(%L)$q$, pg_temp.u('0fffff')), 'permission denied', '42501');
select pg_temp.expect_msg('U70: authenticated cannot call the raiser', format($q$select public._cf1_require_roster_eligible(%L, 'lock')$q$, pg_temp.u('006002')), 'permission denied', '42501');
reset role;
set role anon;
select pg_temp.expect_msg('U70: anon cannot call _cf1_entry_unavailable', format($q$select public._cf1_entry_unavailable(%L)$q$, pg_temp.u('008001')), 'permission denied', '42501');
select pg_temp.expect_msg('U70: anon cannot call _cf1_excluded_entries', format($q$select * from public._cf1_excluded_entries(%L)$q$, pg_temp.u('006002')), 'permission denied', '42501');
reset role;
set role service_role;
select pg_temp.expect_msg('U70: service_role cannot call _cf1_entry_unavailable', format($q$select public._cf1_entry_unavailable(%L)$q$, pg_temp.u('008001')), 'permission denied', '42501');
select pg_temp.expect_msg('U70: service_role cannot call _cf1_round_roster_problems', format($q$select * from public._cf1_round_roster_problems(%L)$q$, pg_temp.u('006002')), 'permission denied', '42501');
select pg_temp.expect_msg('U70: service_role cannot call _cf1_heat_entry_is_excluded', format($q$select public._cf1_heat_entry_is_excluded(%L)$q$, pg_temp.u('0fffff')), 'permission denied', '42501');
reset role;

-- ============================================================================
-- 6. U74: exclusion table protections
-- ============================================================================
select pg_temp.chk('U74: no grants on the table for public/anon/authenticated/service_role (any privilege)',
  not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) pr
              where has_table_privilege(r, 'public.event_competition_round_exclusions', pr))
  and not exists (select 1 from pg_class c, lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                  where c.oid = 'public.event_competition_round_exclusions'::regclass and a.grantee = 0));
select pg_temp.chk('U74: both history triggers exist and are ENABLE ALWAYS (tgenabled = A)',
  -- by name, no total count: later CF1 packages add their own triggers on this table (A7: cf1_a7_guard_exclusion_during_correction)
  (select count(*) from pg_trigger where tgrelid = 'public.event_competition_round_exclusions'::regclass and not tgisinternal and tgenabled = 'A'
     and tgname in ('protect_event_competition_round_exclusions_history', 'protect_event_competition_round_exclusions_history_truncate')) = 2);
select pg_temp.chk('U74: the update/delete trigger is row level, the truncate trigger statement level',
  exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_round_exclusions'::regclass and tgname = 'protect_event_competition_round_exclusions_history'
          and (tgtype & 1) = 1 and (tgtype & 8) = 8 and (tgtype & 16) = 16 and (tgtype & 2) = 2)
  and exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_round_exclusions'::regclass and tgname = 'protect_event_competition_round_exclusions_history_truncate'
          and (tgtype & 1) = 0 and (tgtype & 32) = 32));

-- Valid rows (superuser stands in for the A5 definer functions). Round 006002, entry e01 (two heat entries in the round, one in another round).
insert into public.event_competition_round_exclusions
  (id, event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id, reverses_id) values
  (pg_temp.u('0e0001'), pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008001'), array[]::uuid[], 'exclude_requested', 'refunded', 'Refunded after dancing', pg_temp.u('000001'), 'manager', pg_temp.u('0f0001'), 1, null, null);
select pg_temp.chk('exclusion: a request alone has NO effect (e01 not excluded, excluded set empty)',
  not exists (select 1 from public.event_competition_heat_entries he where he.entry_id = pg_temp.u('008001') and public._cf1_heat_entry_is_excluded(he.id))
  and not exists (select 1 from public._cf1_excluded_entries(pg_temp.u('006002'))));
insert into public.event_competition_round_exclusions
  (id, event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id, reverses_id) values
  (pg_temp.u('0e0002'), pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008001'), array[]::uuid[], 'exclude_cosigned', 'refunded', 'Refunded after dancing', pg_temp.u('000002'), 'chair', pg_temp.u('0f0002'), 2, pg_temp.u('0e0001'), null);
select pg_temp.chk('exclusion: the co-signed decision excludes EVERY heat entry of e01 in that round',
  (select count(*) from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
   where he.entry_id = pg_temp.u('008001') and h.round_id = pg_temp.u('006002') and public._cf1_heat_entry_is_excluded(he.id)) = 2
  and (select count(*) from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
       where he.entry_id = pg_temp.u('008001') and h.round_id = pg_temp.u('006002')) = 2);
select pg_temp.chk('exclusion: BOTH heat entries of e01 in the round are excluded; its heat entry in ANOTHER round is not; other entries are not',
  (select count(*) from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
   where he.entry_id = pg_temp.u('008001') and h.round_id = pg_temp.u('006002') and public._cf1_heat_entry_is_excluded(he.id)) = 2
  and not public._cf1_heat_entry_is_excluded((select he.id from public.event_competition_heat_entries he where he.heat_id = pg_temp.u('00d101') and he.entry_id = pg_temp.u('008001')))
  and not exists (select 1 from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
                  where h.round_id = pg_temp.u('006002') and he.entry_id <> pg_temp.u('008001') and public._cf1_heat_entry_is_excluded(he.id)));
select pg_temp.chk('exclusion: _cf1_excluded_entries returns the effective co-signed row',
  (select count(*) from public._cf1_excluded_entries(pg_temp.u('006002'))) = 1
  and (select exclusion_id = pg_temp.u('0e0002') and decision_id = pg_temp.u('0e0001') and reason_kind = 'refunded' and seq = 2 and entry_id = pg_temp.u('008001')
       from public._cf1_excluded_entries(pg_temp.u('006002'))));
select pg_temp.chk('exclusion: unknown heat entry and null are not excluded',
  not public._cf1_heat_entry_is_excluded(pg_temp.u('0fffff')) and not public._cf1_heat_entry_is_excluded(null));
insert into public.event_competition_round_exclusions
  (id, event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id, reverses_id) values
  (pg_temp.u('0e0003'), pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008001'), array[]::uuid[], 'reverse_requested', 'other', 'Refund resolved', pg_temp.u('000001'), 'manager', pg_temp.u('0f0003'), 3, null, pg_temp.u('0e0002'));
select pg_temp.chk('exclusion: a reversal REQUEST alone does not restore the couple', exists (select 1 from public._cf1_excluded_entries(pg_temp.u('006002'))));
insert into public.event_competition_round_exclusions
  (id, event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id, reverses_id) values
  (pg_temp.u('0e0004'), pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008001'), array[]::uuid[], 'reverse_cosigned', 'other', 'Refund resolved', pg_temp.u('000002'), 'chair', pg_temp.u('0f0004'), 4, pg_temp.u('0e0003'), null);
select pg_temp.chk('exclusion: the co-signed reversal restores the couple', not exists (select 1 from public._cf1_excluded_entries(pg_temp.u('006002')))
  and not exists (select 1 from public.event_competition_heat_entries he where he.entry_id = pg_temp.u('008001') and public._cf1_heat_entry_is_excluded(he.id)));
insert into public.event_competition_round_exclusions
  (id, event_id, round_id, entry_id, evidence_heat_entry_ids, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id, reverses_id) values
  (pg_temp.u('0e0005'), pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008001'), array[]::uuid[], 'exclude_requested', 'other', 'Second request', pg_temp.u('000001'), 'manager', pg_temp.u('0f0005'), 5, null, null),
  (pg_temp.u('0e0006'), pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008002'), array[]::uuid[], 'exclude_requested', 'ineligible', 'Other couple', pg_temp.u('000001'), 'manager', pg_temp.u('0f0006'), 6, null, null),
  (pg_temp.u('0e0007'), pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008002'), array[]::uuid[], 'exclude_cosigned', 'ineligible', 'Other couple', pg_temp.u('000002'), 'chair', pg_temp.u('0f0007'), 7, pg_temp.u('0e0006'), null);
select pg_temp.chk('exclusion: a later request after a reversal does not exclude e01; e02 is excluded independently (per entry, highest seq)',
  (select array_agg(entry_id) from public._cf1_excluded_entries(pg_temp.u('006002'))) = array[pg_temp.u('008002')]);

-- Constraints
select pg_temp.expect_msg('constraint: duplicate request id', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other','abc',%L,'manager',%L,20)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0001')), 'duplicate key', '23505');
select pg_temp.expect_msg('constraint: duplicate (round, seq)', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other','abc',%L,'manager',%L,5)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0099')), 'duplicate key', '23505');
select pg_temp.expect_msg('constraint: unknown kind', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id) values (%L,%L,%L,'excluded','other','abc',%L,'manager',%L,21,%L)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0021'), pg_temp.u('0e0001')), 'round_exclusions_kind_check', '23514');
select pg_temp.expect_msg('constraint: unknown reason_kind', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','noshow','abc',%L,'manager',%L,22)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0022')), 'reason_kind_check', '23514');
select pg_temp.expect_msg('constraint: reason shorter than 3 characters', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other','ab ',%L,'manager',%L,23)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0023')), 'round_exclusions_reason_check', '23514');
select pg_temp.expect_msg('constraint: whitespace-only reason (spaces, tab, newline, CR) refused', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other',chr(32)||chr(9)||chr(10)||chr(13)||chr(32),%L,'manager',%L,50)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0050')), 'round_exclusions_reason_check', '23514');
select pg_temp.expect_msg('constraint: NBSP-only reason refused', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other',chr(160)||chr(160)||chr(160)||chr(160),%L,'manager',%L,51)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0051')), 'round_exclusions_reason_check', '23514');
select pg_temp.expect_msg('constraint: zero-width / BOM / LRM / RLM / soft-hyphen-only reason refused', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other',chr(8203)||chr(8204)||chr(8205)||chr(65279)||chr(8206)||chr(8207)||chr(173),%L,'manager',%L,52)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0052')), 'round_exclusions_reason_check', '23514');
select pg_temp.expect_msg('constraint: one visible character among invisibles refused', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other',chr(160)||'a'||chr(8203)||chr(32)||chr(173),%L,'manager',%L,53)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0053')), 'round_exclusions_reason_check', '23514');
select pg_temp.expect_msg('constraint: two visible characters refused', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other',' a'||chr(160)||'b ',%L,'manager',%L,54)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0054')), 'round_exclusions_reason_check', '23514');
select pg_temp.chk('constraint: a valid reason with inner spaces and invisibles around it is accepted (3 visible characters)',
  pg_temp.try_reason(chr(160)||'a b c'||chr(8203), 0, '0f0060'));
select pg_temp.chk('constraint: a plain valid reason is accepted', pg_temp.try_reason('Refunded after dancing', 0, '0f0061'));
select pg_temp.expect_msg('constraint: reason longer than 500 characters', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other',repeat('x',501),%L,'manager',%L,24)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0024')), 'round_exclusions_reason_check', '23514');
select pg_temp.expect_msg('constraint: actor_role must be chair or manager', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other','abc',%L,'scorer',%L,25)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0025')), 'actor_role_check', '23514');
select pg_temp.expect_msg('constraint: a request row must not carry decision_id', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq, decision_id) values (%L,%L,%L,'exclude_requested','other','abc',%L,'manager',%L,26,%L)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0026'), pg_temp.u('0e0001')), 'decision_check', '23514');
select pg_temp.expect_msg('constraint: a co-sign row must carry decision_id', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_cosigned','other','abc',%L,'chair',%L,27)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0027')), 'decision_check', '23514');
select pg_temp.expect_msg('constraint: a reversal request must name the exclusion it reverses', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'reverse_requested','other','abc',%L,'manager',%L,28)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0028')), 'reverses_check', '23514');
select pg_temp.expect_msg('constraint: an exclude row must not name a reversed row', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq, reverses_id) values (%L,%L,%L,'exclude_requested','other','abc',%L,'manager',%L,29,%L)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0029'), pg_temp.u('0e0001')), 'reverses_check', '23514');
select pg_temp.expect_msg('constraint: seq must be >= 1', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other','abc',%L,'manager',%L,0)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0030')), 'seq_check', '23514');
select pg_temp.expect_msg('constraint: the round must belong to the event (composite FK)', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other','abc',%L,'manager',%L,31)$q$,
  pg_temp.u('00e002'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0031')), 'foreign key', '23503');
select pg_temp.expect_msg('constraint: the entry must belong to the event (composite FK)', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other','abc',%L,'manager',%L,32)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008901'), pg_temp.u('000001'), pg_temp.u('0f0032')), 'foreign key', '23503');

-- Direct writes
select pg_temp.expect_msg('U74: UPDATE refused even for a superuser (append-only evidence)',
  format($q$update public.event_competition_round_exclusions set reason = 'tampered ok' where id = %L$q$, pg_temp.u('0e0001')), 'append-only evidence', '42501');
select pg_temp.expect_msg('U74: DELETE refused even for a superuser',
  format($q$delete from public.event_competition_round_exclusions where id = %L$q$, pg_temp.u('0e0001')), 'append-only evidence', '42501');
select pg_temp.expect_msg('U74: TRUNCATE refused', 'truncate public.event_competition_round_exclusions', 'cannot be truncated', '42501');
set session_replication_role = replica;
select pg_temp.expect_msg('U74 replica stance: UPDATE still refused under session_replication_role = replica (ENABLE ALWAYS)',
  format($q$update public.event_competition_round_exclusions set reason = 'tampered ok' where id = %L$q$, pg_temp.u('0e0001')), 'append-only evidence', '42501');
select pg_temp.expect_msg('U74 replica stance: DELETE still refused under replica',
  format($q$delete from public.event_competition_round_exclusions where id = %L$q$, pg_temp.u('0e0001')), 'append-only evidence', '42501');
select pg_temp.expect_msg('U74 replica stance: TRUNCATE still refused under replica', 'truncate public.event_competition_round_exclusions', 'cannot be truncated', '42501');
set session_replication_role = origin;
select pg_temp.chk('U74: all seven rows are intact after the refused writes',
  (select count(*) from public.event_competition_round_exclusions) = 7
  and (select reason from public.event_competition_round_exclusions where id = pg_temp.u('0e0001')) = 'Refunded after dancing');

set role authenticated;
select pg_temp.expect_msg('U74: authenticated INSERT refused', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other','abc',%L,'manager',%L,40)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0040')), 'permission denied', '42501');
select pg_temp.expect_msg('U74: authenticated SELECT refused', 'select count(*) from public.event_competition_round_exclusions', 'permission denied', '42501');
select pg_temp.expect_msg('U74: authenticated UPDATE refused', 'update public.event_competition_round_exclusions set reason = ''xyz''', 'permission denied', '42501');
select pg_temp.expect_msg('U74: authenticated DELETE refused', 'delete from public.event_competition_round_exclusions', 'permission denied', '42501');
select pg_temp.expect_msg('U74: authenticated TRUNCATE refused', 'truncate public.event_competition_round_exclusions', 'permission denied', '42501');
reset role;
set role service_role;
select pg_temp.expect_msg('U74: service_role INSERT refused', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other','abc',%L,'manager',%L,41)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0041')), 'permission denied', '42501');
select pg_temp.expect_msg('U74: service_role SELECT refused', 'select count(*) from public.event_competition_round_exclusions', 'permission denied', '42501');
select pg_temp.expect_msg('U74: service_role UPDATE refused', 'update public.event_competition_round_exclusions set reason = ''xyz''', 'permission denied', '42501');
select pg_temp.expect_msg('U74: service_role DELETE refused', 'delete from public.event_competition_round_exclusions', 'permission denied', '42501');
select pg_temp.expect_msg('U74: service_role TRUNCATE refused', 'truncate public.event_competition_round_exclusions', 'permission denied', '42501');
reset role;
set role anon;
select pg_temp.expect_msg('U74: anon SELECT refused', 'select count(*) from public.event_competition_round_exclusions', 'permission denied', '42501');
select pg_temp.expect_msg('U74: anon INSERT refused', format($q$insert into public.event_competition_round_exclusions
  (event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values (%L,%L,%L,'exclude_requested','other','abc',%L,'manager',%L,42)$q$,
  pg_temp.u('00e001'), pg_temp.u('006002'), pg_temp.u('008003'), pg_temp.u('000001'), pg_temp.u('0f0042')), 'permission denied', '42501');
reset role;

-- The deletion of an event is the one permitted removal (cascade); the throwaway event 00e002 carries a row.
insert into public.event_competition_round_exclusions
  (id, event_id, round_id, entry_id, kind, reason_kind, reason, actor, actor_role, request_id, seq) values
  (pg_temp.u('0e0099'), pg_temp.u('00e002'), pg_temp.u('006016'), pg_temp.u('008901'), 'exclude_requested', 'other', 'cascade probe', pg_temp.u('000001'), 'manager', pg_temp.u('0f0099'), 1);
select pg_temp.expect_ok('U74: deleting the event cascades through the protected table (the one permitted removal)',
  format($q$delete from public.events where id = %L$q$, pg_temp.u('00e002')));
select pg_temp.chk('U74: the cascaded exclusion row is gone with its event, the event-1 rows remain',
  not exists (select 1 from public.event_competition_round_exclusions where id = pg_temp.u('0e0099'))
  and (select count(*) from public.event_competition_round_exclusions) = 7);

-- ============================================================================
-- 7. Rollback guard (the rollback file is exercised by the harness; here: the refusal logic is documented, not executed)
-- ============================================================================
select pg_temp.blocked('U57 per-entry refund inside a still-paid order (documented false negative)', 'no per-entry refund state exists in the data before R2, so the non-detection cannot be demonstrated; the design accepts it; check e11 only shows a paid link stays available');
select pg_temp.blocked('U64 callback apply refuses a refunded-but-confirmed advanced couple, then withdrawal exit, then apply again', 'apply_competition_round_advancement and the withdrawal are A0 / A6; A1 delivers and tests the predicate and the roster set they call (checks in sections 1b, 2, 3)');
select pg_temp.blocked('U64 Final-start guard (cf1_guard_final_start) refuses COMP_ADVANCEMENT_ROSTER_STALE', 'the start guard is A0; A1 supplies _cf1_entry_unavailable / _cf1_count_available_entries');
select pg_temp.blocked('lock / calculate / approve insertions (A2, A3) call _cf1_require_roster_eligible and the six E2 ranking-set functions filter _cf1_heat_entry_is_excluded', 'redefinitions belong to A2 and A3; A1 changes none of them');
select pg_temp.blocked('exclusion functions request/cosign/reverse (U65, U75, U76, U78)', 'A5 owns the four functions; A1 delivers the table and readers');

-- ============================================================================
-- Verdict
-- ============================================================================
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
    raise exception 'COMPETITION CF1 A1 SQL SUITE PASS (% checks, % blocked: apply/start guards, A2/A3 insertions, A5 functions are other packages)', v_total, v_blocked;
  end if;
  raise exception 'COMPETITION CF1 A1 SQL SUITE FAIL: %', v_failures;
end $$;

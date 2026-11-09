-- Competition CF1 RB3 -- per-entry refund evidence for predicate P (20270120102000_competition_cf1_rb3_refund_evidence.sql).
-- Lines after this header up to the RB3 fixtures are the A1 suite fixture block (copied unchanged). Requires R2 (20270103090000) applied.
-- The R2-absent mode is checked in this suite (R2 tables dropped inside the rolled-back transaction) and by run_cf1_rb3.sh (unchanged A1 suite on a DB without R2).
-- EVERY REFUND ROW IS A FIXTURE (stripe ids FIXTURE_*): not Stripe settlement evidence; no Stripe call exists here.
-- One transaction; the final block always raises: COMPETITION CF1 RB3 SQL SUITE PASS (<n> checks, <b> blocked) or FAIL: <failures>.
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
-- RB3 fixtures: R2 ledger rows (FIXTURES, not Stripe settlement)
-- ============================================================================
select pg_temp.chk('RB3 mode: R2 ledger present -> r2_ledger', public._cf1_refund_evidence_mode() = 'r2_ledger');
select pg_temp.chk('RB3 gate: r2_ledger mode passes the OD-17 refund gate', public._cf1_od17_refund_gate() = 'r2_ledger');

-- A1 body copy (verbatim from 20270120085000) to compare R2-absent / shape-mismatch behaviour with. Reads the same tables.
create or replace function pg_temp.a1_reason(p_entry_id uuid) returns text language sql stable as $$
  select case
    when e.id is null then 'entry_missing'
    when e.status is distinct from 'confirmed' then 'entry_not_confirmed'
    when e.eligibility_status = 'ineligible' then 'entry_ineligible'
    when r.status = 'cancelled' then 'registration_cancelled'
    when r.status = 'refunded' then 'registration_refunded'
    when r.payment_status = 'failed' then 'registration_payment_failed'
    when r.payment_status = 'refunded' then 'registration_payment_refunded'
    when o.payment_status = 'failed' then 'order_payment_failed'
    when o.payment_status = 'refunded' then 'order_payment_refunded'
    else null
  end
  from (select 1) one
  left join public.event_competition_entries e on e.id = p_entry_id
  left join public.event_registrations r on r.id = e.registration_id
  left join public.event_orders o on o.id = e.order_id;
$$;
grant execute on function pg_temp.a1_reason(uuid) to authenticated, anon, service_role;

set session_replication_role = replica;
-- extra orders for the G5 (unattributed dashboard refund) cases; entries below are on them
insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, payment_status) values
  (pg_temp.u('0a0007'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b7@example.test', 'partially_refunded'),
  (pg_temp.u('0a0008'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b8@example.test', 'paid'),
  (pg_temp.u('0a0009'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'b9@example.test', 'partially_refunded'),
  (pg_temp.u('0a000a'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'ba@example.test', 'paid'),
  (pg_temp.u('0a000b'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'bb@example.test', 'partially_refunded'),
  (pg_temp.u('0a000c'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'B', 'bc@example.test', 'paid');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number, registration_id, order_id) values
  (pg_temp.u('009001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g3a', 'confirmed', 'eligible', 'r01', null, pg_temp.u('0a0001')),
  (pg_temp.u('009002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g3b', 'confirmed', 'eligible', 'r02', null, pg_temp.u('0a0001')),
  (pg_temp.u('009003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g3c', 'confirmed', 'eligible', 'r03', null, pg_temp.u('0a0001')),
  (pg_temp.u('009004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g4b', 'confirmed', 'eligible', 'r04', null, pg_temp.u('0a0001')),
  (pg_temp.u('009005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g4c', 'confirmed', 'eligible', 'r05', null, pg_temp.u('0a0001')),
  (pg_temp.u('009006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g4d', 'confirmed', 'eligible', 'r06', null, pg_temp.u('0a0001')),
  (pg_temp.u('009007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'mix1', 'confirmed', 'eligible', 'r07', null, pg_temp.u('0a0001')),
  (pg_temp.u('009008'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'mix2', 'confirmed', 'eligible', 'r08', null, pg_temp.u('0a0001')),
  (pg_temp.u('009009'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'fee1', 'confirmed', 'eligible', 'r09', null, pg_temp.u('0a0001')),
  (pg_temp.u('00900a'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g5a', 'confirmed', 'eligible', 'r10', null, pg_temp.u('0a0007')),
  (pg_temp.u('00900b'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g5b', 'confirmed', 'eligible', 'r11', null, pg_temp.u('0a0007')),
  (pg_temp.u('00900c'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g5c', 'confirmed', 'eligible', 'r12', null, pg_temp.u('0a0008')),
  (pg_temp.u('00900d'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g5d', 'confirmed', 'eligible', 'r13', null, pg_temp.u('0a0009')),
  (pg_temp.u('00900e'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g5e', 'confirmed', 'eligible', 'r14', null, pg_temp.u('0a000a')),
  (pg_temp.u('00900f'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g5f', 'confirmed', 'eligible', 'r15', null, pg_temp.u('0a000b')),
  (pg_temp.u('009010'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'g5clean', 'confirmed', 'eligible', 'r16', null, pg_temp.u('0a000c')),
  (pg_temp.u('009011'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'noorder', 'confirmed', 'eligible', 'r17', null, null);

insert into public.event_order_items (id, order_id, event_id, item_type, description, quantity, unit_price, total_price)
select pg_temp.u('0d' || lpad(to_hex(n), 4, '0')), pg_temp.u('0a0001'), pg_temp.u('00e001'), 'competition_entry', 'item ' || n, 1, 100, 100
from generate_series(4097, 4106) n;   -- 0d1001..0d100a (S1..S10)
insert into public.event_order_items (id, order_id, event_id, item_type, description, quantity, unit_price, total_price) values
  (pg_temp.u('0d2001'), pg_temp.u('0a0001'), pg_temp.u('00e001'), 'competition_entry', 'G3a', 1, 100, 100),
  (pg_temp.u('0d2002'), pg_temp.u('0a0001'), pg_temp.u('00e001'), 'competition_entry', 'G3b', 1, 100, 100),
  (pg_temp.u('0d2003'), pg_temp.u('0a0001'), pg_temp.u('00e001'), 'competition_entry', 'G3c', 1, 100, 100),
  (pg_temp.u('0d2004'), pg_temp.u('0a0001'), pg_temp.u('00e001'), 'competition_entry', 'G4b', 1, 100, 100),
  (pg_temp.u('0d2005'), pg_temp.u('0a0001'), pg_temp.u('00e001'), 'competition_entry', 'G4c', 1, 100, 100),
  (pg_temp.u('0d2006'), pg_temp.u('0a0001'), pg_temp.u('00e001'), 'competition_entry', 'G4d', 1, 100, 100),
  (pg_temp.u('0d2007'), pg_temp.u('0a0001'), pg_temp.u('00e001'), 'competition_entry', 'mix1a', 1, 100, 100),
  (pg_temp.u('0d2008'), pg_temp.u('0a0001'), pg_temp.u('00e001'), 'competition_entry', 'mix1b', 1, 100, 100),
  (pg_temp.u('0d2009'), pg_temp.u('0a0001'), pg_temp.u('00e001'), 'competition_entry', 'mix2a', 1, 100, 100),
  (pg_temp.u('0d200a'), pg_temp.u('0a0001'), pg_temp.u('00e001'), 'competition_entry', 'mix2b', 1, 100, 100),
  (pg_temp.u('0d200b'), pg_temp.u('0a0001'), pg_temp.u('00e001'), 'add_on', 'fee line', 1, 20, 20),
  (pg_temp.u('0d2101'), pg_temp.u('0a0009'), pg_temp.u('00e001'), 'add_on', 'fee line g5d', 1, 20, 20),
  (pg_temp.u('0d2102'), pg_temp.u('0a000b'), pg_temp.u('00e001'), 'competition_entry', 'g5f line', 1, 100, 100);

-- refunds: staff refunds S1..S10 as before; r-ids 0f1011.. are the new RB3 cases
insert into public.event_order_refunds (id, event_id, order_id, registration_id, refund_request_id, stripe_refund_id, stripe_account_id, stripe_payment_intent_id,
                                        amount_cents, currency, status, source, succeeded_at) values
  (pg_temp.u('0f1001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2001'), 'FIXTURE_re_1', 'acct_FIXTURE', 'FIXTURE_pi_1', 10000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f1002'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2002'), 'FIXTURE_re_2', 'acct_FIXTURE', 'FIXTURE_pi_1', 10000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f1003'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2003'), 'FIXTURE_re_3', 'acct_FIXTURE', 'FIXTURE_pi_1', 10000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f1004'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2004'), 'FIXTURE_re_4', 'acct_FIXTURE', 'FIXTURE_pi_1', 10000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f1005'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2005'), 'FIXTURE_re_5', 'acct_FIXTURE', 'FIXTURE_pi_1', 10000, 'usd', 'pending', 'staff', null),
  (pg_temp.u('0f1006'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2006'), 'FIXTURE_re_6', 'acct_FIXTURE', 'FIXTURE_pi_1', 10000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f1007'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2007'), 'FIXTURE_re_7', 'acct_FIXTURE', 'FIXTURE_pi_1', 10000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f1008'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2008'), 'FIXTURE_re_8', 'acct_FIXTURE', 'FIXTURE_pi_1', 10000, 'usd', 'failed', 'staff', null),
  (pg_temp.u('0f1009'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2009'), 'FIXTURE_re_9', 'acct_FIXTURE', 'FIXTURE_pi_1', 10000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f100a'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f200a'), 'FIXTURE_re_10', 'acct_FIXTURE', 'FIXTURE_pi_1', 10000, 'usd', 'succeeded', 'staff', now()),
  -- G3a partial 3000 keep | G3b partial withdrawn outcome | G3c partial blocked + keep_entry | G4b requires_action | G4c requested | G4d canceled
  (pg_temp.u('0f1011'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2011'), 'FIXTURE_re_11', 'acct_FIXTURE', 'FIXTURE_pi_1', 3000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f1012'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2012'), 'FIXTURE_re_12', 'acct_FIXTURE', 'FIXTURE_pi_1', 3000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f1013'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2013'), 'FIXTURE_re_13', 'acct_FIXTURE', 'FIXTURE_pi_1', 3000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f1014'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2014'), 'FIXTURE_re_14', 'acct_FIXTURE', 'FIXTURE_pi_1', 3000, 'usd', 'requires_action', 'staff', null),
  (pg_temp.u('0f1015'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2015'), null, 'acct_FIXTURE', 'FIXTURE_pi_1', 3000, 'usd', 'requested', 'staff', null),
  (pg_temp.u('0f1016'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2016'), 'FIXTURE_re_16', 'acct_FIXTURE', 'FIXTURE_pi_1', 3000, 'usd', 'canceled', 'staff', null),
  -- mix1: resolved keep refund + pending refund | mix2: blocked refund + recorded refund | fee line allocation (no entry named)
  (pg_temp.u('0f1017'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2017'), 'FIXTURE_re_17', 'acct_FIXTURE', 'FIXTURE_pi_1', 3000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f1018'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2018'), 'FIXTURE_re_18', 'acct_FIXTURE', 'FIXTURE_pi_1', 3000, 'usd', 'pending', 'staff', null),
  (pg_temp.u('0f1019'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f2019'), 'FIXTURE_re_19', 'acct_FIXTURE', 'FIXTURE_pi_1', 3000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f101a'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f201a'), 'FIXTURE_re_1a', 'acct_FIXTURE', 'FIXTURE_pi_1', 3000, 'usd', 'succeeded', 'staff', now()),
  (pg_temp.u('0f101b'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0b0001'), pg_temp.u('0f201b'), 'FIXTURE_re_1b', 'acct_FIXTURE', 'FIXTURE_pi_1', 2000, 'usd', 'succeeded', 'staff', now()),
  -- G5 dashboard (externally initiated) refunds, no refund_request_id, stripe id mandatory
  (pg_temp.u('0f1021'), pg_temp.u('00e001'), pg_temp.u('0a0007'), null, null, 'FIXTURE_re_21', 'acct_FIXTURE', 'FIXTURE_pi_7', 2500, 'usd', 'succeeded', 'stripe_dashboard', now()),
  (pg_temp.u('0f1022'), pg_temp.u('00e001'), pg_temp.u('0a0008'), null, null, 'FIXTURE_re_22', 'acct_FIXTURE', 'FIXTURE_pi_8', 2500, 'usd', 'pending', 'stripe_dashboard', null),
  (pg_temp.u('0f1023'), pg_temp.u('00e001'), pg_temp.u('0a0009'), null, null, 'FIXTURE_re_23', 'acct_FIXTURE', 'FIXTURE_pi_9', 2000, 'usd', 'succeeded', 'stripe_dashboard', now()),
  (pg_temp.u('0f1024'), pg_temp.u('00e001'), pg_temp.u('0a000a'), null, null, 'FIXTURE_re_24', 'acct_FIXTURE', 'FIXTURE_pi_a', 2500, 'usd', 'failed', 'stripe_dashboard', null),
  (pg_temp.u('0f1025'), pg_temp.u('00e001'), pg_temp.u('0a000b'), null, null, 'FIXTURE_re_25', 'acct_FIXTURE', 'FIXTURE_pi_b', 2500, 'usd', 'succeeded', 'stripe_dashboard', now());

-- scenario -> entry: S1 e11 (unresolved locked scope) | S2 es 0080a1 (keep_entry) | S3 e18 (result_stands, certified kind) | S4 e05 (withdrawn_after_unlock
-- resolution but entry still confirmed) | S5 e06 (refund pending) | S6 e14 (withdraw_entry = false: "refund, keep") | S7 e15 (outcome withdrawn)
-- S8 e01 (refund failed / reversed) | S9 e24 (succeeded, withdraw requested, outcome null, no scope: fail closed) | S10 e19 (k0_correction resolution)
insert into public.event_order_refund_allocations (refund_id, event_id, order_id, order_item_id, entry_id, line_kind, amount_cents, withdraw_entry, participation_outcome) values
  (pg_temp.u('0f1001'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d1001'), pg_temp.u('008011'), 'entry', 10000, true,  'exception_open'),
  (pg_temp.u('0f1002'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d1002'), pg_temp.u('0080a1'), 'entry', 10000, true,  'exception_open'),
  (pg_temp.u('0f1003'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d1003'), pg_temp.u('008018'), 'entry', 10000, true,  'exception_open'),
  (pg_temp.u('0f1004'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d1004'), pg_temp.u('008005'), 'entry', 10000, true,  'exception_open'),
  (pg_temp.u('0f1005'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d1005'), pg_temp.u('008006'), 'entry', 10000, true,  null),
  (pg_temp.u('0f1006'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d1006'), pg_temp.u('008014'), 'entry', 10000, false, 'not_requested'),
  (pg_temp.u('0f1007'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d1007'), pg_temp.u('008015'), 'entry', 10000, true,  'withdrawn'),
  (pg_temp.u('0f1008'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d1008'), pg_temp.u('008001'), 'entry', 10000, true,  'exception_open'),
  (pg_temp.u('0f1009'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d1009'), pg_temp.u('008024'), 'entry', 10000, true,  null),
  (pg_temp.u('0f100a'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d100a'), pg_temp.u('008019'), 'entry', 10000, true,  'exception_open'),
  (pg_temp.u('0f1011'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d2001'), pg_temp.u('009001'), 'entry', 3000, false, 'not_requested'),
  (pg_temp.u('0f1012'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d2002'), pg_temp.u('009002'), 'entry', 3000, true,  'withdrawn'),
  (pg_temp.u('0f1013'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d2003'), pg_temp.u('009003'), 'entry', 3000, true,  'exception_open'),
  (pg_temp.u('0f1014'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d2004'), pg_temp.u('009004'), 'entry', 3000, false, null),
  (pg_temp.u('0f1015'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d2005'), pg_temp.u('009005'), 'entry', 3000, false, null),
  (pg_temp.u('0f1016'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d2006'), pg_temp.u('009006'), 'entry', 3000, false, null),
  (pg_temp.u('0f1017'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d2007'), pg_temp.u('009007'), 'entry', 3000, true,  'exception_open'),
  (pg_temp.u('0f1018'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d2008'), pg_temp.u('009007'), 'entry', 3000, false, null),
  (pg_temp.u('0f1019'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d2009'), pg_temp.u('009008'), 'entry', 3000, true,  'exception_open'),
  (pg_temp.u('0f101a'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d200a'), pg_temp.u('009008'), 'entry', 3000, false, 'not_requested'),
  (pg_temp.u('0f101b'), pg_temp.u('00e001'), pg_temp.u('0a0001'), pg_temp.u('0d200b'), null,                'fee',   2000, false, 'not_applicable'),
  (pg_temp.u('0f1023'), pg_temp.u('00e001'), pg_temp.u('0a0009'), pg_temp.u('0d2101'), null,                'fee',   2000, false, 'not_applicable');
-- 0f101b is a staff refund allocated to a fee line of order 0a0001 only (entry 009009 on that order: no entry named, no dashboard refund on it)

insert into public.event_order_settlement_exceptions (id, order_id, studio_id, event_id, kind, details) values
  (pg_temp.u('0e1001'), pg_temp.u('0a0001'), pg_temp.u('00a001'), pg_temp.u('00e001'), 'competition_refund_entry_locked_heat', '{"fixture": true}'),
  (pg_temp.u('0e1002'), pg_temp.u('0a0001'), pg_temp.u('00a001'), pg_temp.u('00e001'), 'competition_refund_entry_certified_heat', '{"fixture": true}');
-- resolved rows need resolved_at (check: resolved_at null <=> resolution null)
insert into public.event_competition_refund_exception_scopes (exception_id, kind, event_id, refund_id, entry_id, heat_id, round_id, competitive_effect, resolved_at, resolution, resolution_note) values
  (pg_temp.u('0e1001'), 'competition_refund_entry_locked_heat',    pg_temp.u('00e001'), pg_temp.u('0f1001'), pg_temp.u('008011'), pg_temp.u('00d202'), pg_temp.u('006002'), true, null, null, null),
  (pg_temp.u('0e1001'), 'competition_refund_entry_locked_heat',    pg_temp.u('00e001'), pg_temp.u('0f1002'), pg_temp.u('0080a1'), pg_temp.u('00d202'), pg_temp.u('006002'), true, now(), 'keep_entry', 'fixture: staff keep'),
  (pg_temp.u('0e1002'), 'competition_refund_entry_certified_heat', pg_temp.u('00e001'), pg_temp.u('0f1003'), pg_temp.u('008018'), pg_temp.u('00d202'), pg_temp.u('006002'), true, now(), 'result_stands', 'fixture: result stands'),
  (pg_temp.u('0e1001'), 'competition_refund_entry_locked_heat',    pg_temp.u('00e001'), pg_temp.u('0f1004'), pg_temp.u('008005'), pg_temp.u('00d202'), pg_temp.u('006002'), true, now(), 'withdrawn_after_unlock', 'fixture: withdrawn'),
  (pg_temp.u('0e1002'), 'competition_refund_entry_certified_heat', pg_temp.u('00e001'), pg_temp.u('0f100a'), pg_temp.u('008019'), pg_temp.u('00d202'), pg_temp.u('006002'), true, now(), 'k0_correction', 'fixture: k0'),
  (pg_temp.u('0e1001'), 'competition_refund_entry_locked_heat',    pg_temp.u('00e001'), pg_temp.u('0f1008'), pg_temp.u('008001'), pg_temp.u('00d202'), pg_temp.u('006002'), true, null, null, null),
  -- G3c partial, blocked, keep_entry | mix1 resolved keep | mix2 blocked unresolved
  (pg_temp.u('0e1001'), 'competition_refund_entry_locked_heat',    pg_temp.u('00e001'), pg_temp.u('0f1013'), pg_temp.u('009003'), pg_temp.u('00d202'), pg_temp.u('006002'), true, now(), 'keep_entry', 'fixture: keep after partial'),
  (pg_temp.u('0e1001'), 'competition_refund_entry_locked_heat',    pg_temp.u('00e001'), pg_temp.u('0f1017'), pg_temp.u('009007'), pg_temp.u('00d202'), pg_temp.u('006002'), true, now(), 'keep_entry', 'fixture: keep'),
  (pg_temp.u('0e1001'), 'competition_refund_entry_locked_heat',    pg_temp.u('00e001'), pg_temp.u('0f1019'), pg_temp.u('009008'), pg_temp.u('00d202'), pg_temp.u('006002'), true, null, null, null);
set session_replication_role = origin;

-- ============================================================================
-- RB3 checks: S1..S10 (the previous suite, with the G2/G4 and S7 flips) then G2..G5
-- ============================================================================
select pg_temp.chk('RB3 S1: succeeded refund, withdrawal blocked (locked heat), scope unresolved -> unavailable (entry_refund_withdrawal_blocked)',
  public._cf1_entry_unavailable_reason(pg_temp.u('008011')) = 'entry_refund_withdrawal_blocked');
select pg_temp.chk('RB3 S2: same, scope resolved keep_entry -> available', not public._cf1_entry_unavailable(pg_temp.u('0080a1')));
select pg_temp.chk('RB3 S3: certified scope resolved result_stands -> available', not public._cf1_entry_unavailable(pg_temp.u('008018')));
select pg_temp.chk('RB3 S4: scope resolved withdrawn_after_unlock but entry still confirmed (inconsistent) -> unavailable, fail closed',
  public._cf1_entry_unavailable_reason(pg_temp.u('008005')) = 'entry_refund_withdrawal_blocked');
select pg_temp.chk('RB3 S5 = G4: refund pending (withdraw requested, outcome null) -> unavailable entry_refund_pending (was available before the G4 fix)',
  public._cf1_entry_unavailable_reason(pg_temp.u('008006')) = 'entry_refund_pending');
select pg_temp.chk('RB3 S6 = G2: succeeded refund with withdraw_entry = false -> unavailable entry_refund_recorded (was available before the G2 fix)',
  public._cf1_entry_unavailable_reason(pg_temp.u('008014')) = 'entry_refund_recorded');
select pg_temp.chk('RB3 S7: outcome withdrawn on a still-confirmed entry -> unavailable entry_refund_recorded (fail closed)',
  public._cf1_entry_unavailable_reason(pg_temp.u('008015')) = 'entry_refund_recorded');
select pg_temp.chk('RB3 S8: refund failed/reversed -> available even with an open scope row', not public._cf1_entry_unavailable(pg_temp.u('008001')));
select pg_temp.chk('RB3 S9: succeeded + withdrawal requested + outcome null + no scope -> unavailable (fail closed)',
  public._cf1_entry_unavailable_reason(pg_temp.u('008024')) = 'entry_refund_withdrawal_blocked');
select pg_temp.chk('RB3 S10: scope resolved k0_correction -> available', not public._cf1_entry_unavailable(pg_temp.u('008019')));

-- G3 partial amounts
select pg_temp.chk('RB3 G3a: partial (3000 of 10000) succeeded refund, withdraw_entry = false -> unavailable entry_refund_recorded',
  public._cf1_entry_unavailable_reason(pg_temp.u('009001')) = 'entry_refund_recorded');
select pg_temp.chk('RB3 G3b: partial succeeded refund, outcome withdrawn on a still-confirmed entry -> unavailable entry_refund_recorded',
  public._cf1_entry_unavailable_reason(pg_temp.u('009002')) = 'entry_refund_recorded');
select pg_temp.chk('RB3 G3c: partial succeeded refund, withdrawal blocked, scope resolved keep_entry -> available (audited resolution)',
  not public._cf1_entry_unavailable(pg_temp.u('009003')));
-- G4 pending-like states
select pg_temp.chk('RB3 G4b: requires_action refund allocated to the entry -> unavailable entry_refund_pending',
  public._cf1_entry_unavailable_reason(pg_temp.u('009004')) = 'entry_refund_pending');
select pg_temp.chk('RB3 G4c: requested (not yet at Stripe) refund allocated to the entry -> unavailable entry_refund_pending',
  public._cf1_entry_unavailable_reason(pg_temp.u('009005')) = 'entry_refund_pending');
select pg_temp.chk('RB3 G4d: canceled refund -> available', not public._cf1_entry_unavailable(pg_temp.u('009006')));
-- mixed
select pg_temp.chk('RB3 mix1: one refund resolved keep_entry, a second one pending -> unavailable entry_refund_pending (a resolution never hides another refund)',
  public._cf1_entry_unavailable_reason(pg_temp.u('009007')) = 'entry_refund_pending');
select pg_temp.chk('RB3 mix2: one refund blocked + unresolved, one recorded -> entry_refund_withdrawal_blocked (blocked wins)',
  public._cf1_entry_unavailable_reason(pg_temp.u('009008')) = 'entry_refund_withdrawal_blocked');
select pg_temp.chk('RB3 fee line: a refund allocated to a fee line only (no entry named, no dashboard refund on the order) -> entry available',
  not public._cf1_entry_unavailable(pg_temp.u('009009')));
-- G5 unattributed dashboard refunds
select pg_temp.chk('RB3 G5a: succeeded stripe_dashboard refund without allocation -> entry on that order unavailable entry_refund_unattributed_order',
  public._cf1_entry_unavailable_reason(pg_temp.u('00900a')) = 'entry_refund_unattributed_order');
select pg_temp.chk('RB3 G5b: ... and EVERY other entry of that order too (the entry is not guessed)',
  public._cf1_entry_unavailable_reason(pg_temp.u('00900b')) = 'entry_refund_unattributed_order');
select pg_temp.chk('RB3 G5c: pending dashboard refund without allocation -> entry_refund_pending',
  public._cf1_entry_unavailable_reason(pg_temp.u('00900c')) = 'entry_refund_pending');
select pg_temp.chk('RB3 G5d: dashboard refund attributed to a fee line (allocation exists) -> entry available',
  not public._cf1_entry_unavailable(pg_temp.u('00900d')));
select pg_temp.chk('RB3 G5e: failed dashboard refund without allocation -> entry available', not public._cf1_entry_unavailable(pg_temp.u('00900e')));
select pg_temp.chk('RB3 G5f: unattributed refund of ANOTHER order does not affect an entry on a clean order', not public._cf1_entry_unavailable(pg_temp.u('009010')));
select pg_temp.chk('RB3 G5g: an entry without an order is not affected by any unattributed refund', not public._cf1_entry_unavailable(pg_temp.u('009011')));

-- G5 clearing: staff attribute the refund (insert the allocation, as attribute_competition_refund does)
set session_replication_role = replica;
insert into public.event_order_refund_allocations (refund_id, event_id, order_id, order_item_id, entry_id, line_kind, amount_cents, withdraw_entry, participation_outcome) values
  (pg_temp.u('0f1025'), pg_temp.u('00e001'), pg_temp.u('0a000b'), pg_temp.u('0d2102'), pg_temp.u('00900f'), 'entry', 2500, false, 'not_requested');
set session_replication_role = origin;
select pg_temp.chk('RB3 G5i: unattributed refund then attributed to that entry (withdraw false) -> unavailable entry_refund_recorded (no longer order-level; R2 has no keep path)',
  public._cf1_entry_unavailable_reason(pg_temp.u('00900f')) = 'entry_refund_recorded');
-- an attribution to a fee line releases the order's entries
set session_replication_role = replica;
insert into public.event_order_refund_allocations (refund_id, event_id, order_id, order_item_id, entry_id, line_kind, amount_cents, withdraw_entry, participation_outcome) values
  (pg_temp.u('0f1021'), pg_temp.u('00e001'), pg_temp.u('0a0007'), pg_temp.u('0d2101'), null, 'fee', 2500, false, 'not_applicable');
set session_replication_role = origin;
select pg_temp.chk('RB3 G5j: unattributed refund attributed to a fee line -> both entries of order 0a0007 available again',
  not public._cf1_entry_unavailable(pg_temp.u('00900a')) and not public._cf1_entry_unavailable(pg_temp.u('00900b')));
set session_replication_role = replica;
delete from public.event_order_refund_allocations where refund_id = pg_temp.u('0f1021');  -- undo the fee attribution fixture (ledger triggers are replica-disabled here)
set session_replication_role = origin;

-- reversals and state transitions
update public.event_order_refunds set status = 'failed' where id = pg_temp.u('0f1001');
select pg_temp.chk('RB3 reversal: S1 refund reported failed afterwards -> available again', not public._cf1_entry_unavailable(pg_temp.u('008011')));
update public.event_order_refunds set status = 'succeeded' where id = pg_temp.u('0f1001');
select pg_temp.chk('RB3 reversal undone: unavailable again', public._cf1_entry_unavailable(pg_temp.u('008011')));
update public.event_order_refunds set status = 'failed' where id = pg_temp.u('0f1014');
select pg_temp.chk('RB3 G4 transition: pending refund fails at Stripe -> entry available again', not public._cf1_entry_unavailable(pg_temp.u('009004')));
update public.event_order_refunds set status = 'succeeded', succeeded_at = now() where id = pg_temp.u('0f1014');
select pg_temp.chk('RB3 G4 transition: that refund succeeds instead -> entry_refund_recorded',
  public._cf1_entry_unavailable_reason(pg_temp.u('009004')) = 'entry_refund_recorded');
update public.event_order_refunds set status = 'failed' where id = pg_temp.u('0f1021');
-- R2 recomputes the order status from the succeeded refunds when a refund is reversed (RB3R fails closed while the order still says partially_refunded with no succeeded ledger refund)
update public.event_orders set payment_status = 'paid' where id = pg_temp.u('0a0007');
select pg_temp.chk('RB3 G5 transition: unattributed dashboard refund reported failed -> entries available again',
  not public._cf1_entry_unavailable(pg_temp.u('00900a')) and not public._cf1_entry_unavailable(pg_temp.u('00900b')));
update public.event_order_refunds set status = 'succeeded' where id = pg_temp.u('0f1021');
update public.event_orders set payment_status = 'partially_refunded' where id = pg_temp.u('0a0007');
select pg_temp.chk('RB3 G5 transition: back to succeeded -> unavailable again', public._cf1_entry_unavailable_reason(pg_temp.u('00900a')) = 'entry_refund_unattributed_order');
update public.event_orders set payment_status = 'refunded' where id = pg_temp.u('0a0007');
select pg_temp.chk('RB3 precedence: order fully refunded -> the A1 reason order_payment_refunded wins over the unattributed rule',
  public._cf1_entry_unavailable_reason(pg_temp.u('00900a')) = 'order_payment_refunded');
update public.event_orders set payment_status = 'partially_refunded' where id = pg_temp.u('0a0007');

-- precedence: A1 reasons win over the new one
select pg_temp.chk('RB3 precedence: A1 reasons are unchanged for every A1 fixture entry that has no ledger rows (e02..e04, e07..e10, e12, e13, e23)',
  (select bool_and(public._cf1_entry_unavailable_reason(pg_temp.u(x.s)) = x.r)
   from (values ('008002','entry_not_confirmed'),('008003','entry_not_confirmed'),('008004','entry_ineligible'),('008007','registration_cancelled'),
                ('008008','registration_refunded'),('008009','registration_payment_refunded'),('008010','registration_payment_failed'),
                ('008012','order_payment_refunded'),('008013','order_payment_failed'),('008023','order_payment_refunded')) x(s, r)));
select pg_temp.chk('RB3: ineligible entry e04-style reason unchanged (e20)', public._cf1_entry_unavailable_reason(pg_temp.u('008020')) is not distinct from 'entry_ineligible');

-- roster level: round 006002 ranking set now reports the evidence reason
select pg_temp.chk('RB3 roster: the Final roster problems list S1 (e11) with the evidence reason',
  exists (select 1 from public._cf1_round_roster_problems(pg_temp.u('006002')) p where p.entry_id = pg_temp.u('008011') and p.reason = 'entry_refund_withdrawal_blocked'));
select pg_temp.chk('RB3 helpers: no grants to anon / authenticated / service_role / public on the new functions and the override table',
  not exists (select 1 from pg_proc p, unnest(array['anon','authenticated','service_role']) r
              where p.proname in ('_cf1_entry_refund_evidence_reason', '_cf1_refund_evidence_mode', '_cf1_od17_refund_gate', '_cf1_rb3_record_gate_override',
                                  '_cf1_rb3_revoke_gate_override', '_cf1_entry_unavailable_reason') and p.pronamespace = 'public'::regnamespace
                and has_function_privilege(r, p.oid, 'execute'))
  and not exists (select 1 from unnest(array['anon','authenticated','service_role']) r where has_table_privilege(r, 'public.competition_cf1_rb3_gate_overrides', 'select,insert,update,delete'))
  and (select count(*) from pg_proc where proname in ('_cf1_entry_refund_evidence_reason', '_cf1_refund_evidence_mode', '_cf1_od17_refund_gate') and prosecdef) = 3);
select pg_temp.chk('RB3: reason function null for an entry whose ledger evidence is resolved (result_stands, e18)',
  public._cf1_entry_unavailable_reason(pg_temp.u('008018')) is null);
select pg_temp.chk('RB3 reasons are non-secret: only the five documented reason strings come out of the new clause',
  (select bool_and(r in ('entry_refund_withdrawal_blocked', 'entry_refund_recorded', 'entry_refund_pending', 'entry_refund_unattributed_order'))
   from (select public._cf1_entry_refund_evidence_reason(id) r from public.event_competition_entries) q where r is not null));

-- ---------------------------------------------------------------------------------------------------------------------------------
-- P2-1 postflight conditions (as the migration checks them) and P2-3 static SQL
-- ---------------------------------------------------------------------------------------------------------------------------------
select pg_temp.chk('RB3 postflight: the three R2 tables are selectable by the owner of the predicate functions',
  (select bool_and(has_table_privilege((select proowner from pg_proc where oid = 'public._cf1_entry_unavailable_reason(uuid)'::regprocedure), 'public.' || t, 'select'))
   from unnest(array['event_order_refunds', 'event_order_refund_allocations', 'event_competition_refund_exception_scopes']) t));
select pg_temp.chk('RB3 postflight: both predicate functions have the same owner',
  (select count(distinct proowner) = 1 from pg_proc where proname in ('_cf1_entry_unavailable_reason', '_cf1_entry_refund_evidence_reason') and pronamespace = 'public'::regnamespace));
select pg_temp.chk('RB3 postflight: the evidence query runs with a random uuid and returns null', public._cf1_entry_refund_evidence_reason(gen_random_uuid()) is null);
select pg_temp.chk('RB3 static SQL: the evidence function is plpgsql without dynamic EXECUTE',
  (select lower(prosrc) !~ '\mexecute\M' and prolang = (select oid from pg_language where lanname = 'plpgsql') from pg_proc where proname = '_cf1_entry_refund_evidence_reason'));
select pg_temp.chk('RB3 static SQL: no pg_depend dependency from the evidence function onto the R2 tables (R2 can be rolled back independently)',
  not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = 'public._cf1_entry_refund_evidence_reason(uuid)'::regprocedure
                and d.refobjid in ('public.event_order_refunds'::regclass, 'public.event_order_refund_allocations'::regclass, 'public.event_competition_refund_exception_scopes'::regclass)));

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Gate: override table protections
-- ---------------------------------------------------------------------------------------------------------------------------------
select pg_temp.expect_msg('RB3 override: note shorter than 20 chars refused', $q$select public._cf1_rb3_record_gate_override('absent', 'owner', 'short')$q$, 'competition_cf1_rb3_gate_overrides_note_check');
select pg_temp.expect_msg('RB3 override: mode r2_ledger refused (nothing to accept)', $q$select public._cf1_rb3_record_gate_override('r2_ledger', 'owner', 'accepting something that needs no acceptance')$q$, 'gate_overrides_mode_check');
select pg_temp.expect_msg('RB3 override: blank accepted_by refused', $q$select public._cf1_rb3_record_gate_override('absent', '  ', 'accepting the false negative in writing')$q$, 'accepted_by_check');

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Shape mismatch (column renamed in this rolled-back transaction)
-- ---------------------------------------------------------------------------------------------------------------------------------
alter table public.event_order_refunds rename column source to source_renamed;
select pg_temp.chk('RB3 shape: a used column missing -> r2_shape_mismatch', public._cf1_refund_evidence_mode() = 'r2_shape_mismatch');
select pg_temp.chk('RB3 shape: in r2_shape_mismatch the evidence clause returns null (false negative) ...', public._cf1_entry_refund_evidence_reason(pg_temp.u('008011')) is null);
select pg_temp.expect_msg('RB3 gate: ... so the OD-17 refund gate refuses', $q$select public._cf1_od17_refund_gate()$q$, 'CF1_RB3_REFUND_EVIDENCE_GATE');
alter table public.event_order_refunds rename column source_renamed to source;
select pg_temp.chk('RB3 shape: column restored -> r2_ledger again', public._cf1_refund_evidence_mode() = 'r2_ledger' and public._cf1_od17_refund_gate() = 'r2_ledger');

-- a function owner that cannot read the ledger must make the gate refuse in r2_ledger mode (never fail open)
do $$
declare
  v_owner name := (select pg_get_userbyid(proowner) from pg_proc where oid = 'public._cf1_entry_refund_evidence_reason(uuid)'::regprocedure);
  v_msg text;
begin
  if (select rolsuper from pg_roles where rolname = v_owner) then
    perform pg_temp.blocked('RB3 gate probe: owner without SELECT on the ledger makes the probe fail', 'function owner ' || v_owner || ' is a superuser here (privileges are bypassed)');
    return;
  end if;
  execute format('revoke select on public.event_order_refund_allocations from %I', v_owner);
  if has_table_privilege(v_owner, 'public.event_order_refund_allocations', 'select') then
    execute format('grant select on public.event_order_refund_allocations to %I', v_owner);
    perform pg_temp.blocked('RB3 gate probe: owner without SELECT on the ledger makes the probe fail', 'function owner ' || v_owner || ' keeps SELECT through a role membership here; the probe path is covered by the postflight negative test in run_cf1_rb3.sh');
    return;
  end if;
  begin
    perform public._cf1_od17_refund_gate();
    perform pg_temp.chk('RB3 gate probe: owner without SELECT on the ledger makes the probe fail', false, 'gate passed');
  exception when others then
    v_msg := sqlerrm;
    perform pg_temp.chk('RB3 gate probe: owner without SELECT on the ledger makes the probe fail', position('evidence query failed' in v_msg) > 0, v_msg);
  end;
  execute format('grant select on public.event_order_refund_allocations to %I', v_owner);
end $$;

-- a partial R2 (scopes table dropped) is also a mismatch, never 'absent'
drop table public.event_competition_refund_exception_scopes cascade;
select pg_temp.chk('RB3 shape: only two of the three R2 tables -> r2_shape_mismatch (not absent)', public._cf1_refund_evidence_mode() = 'r2_shape_mismatch');
select pg_temp.expect_msg('RB3 gate: partial R2 refused without an override', $q$select public._cf1_od17_refund_gate()$q$, 'refund-evidence mode is r2_shape_mismatch');
select pg_temp.chk('RB3 gate: record an override for r2_shape_mismatch -> gate passes as override:r2_shape_mismatch',
  (select public._cf1_rb3_record_gate_override('r2_shape_mismatch', 'owner (fixture)', 'fixture acceptance of the shape mismatch false negative') is not null)
  and public._cf1_od17_refund_gate() = 'override:r2_shape_mismatch');

-- ---------------------------------------------------------------------------------------------------------------------------------
-- R2 absent: drop the whole ledger in this rolled-back transaction
-- ---------------------------------------------------------------------------------------------------------------------------------
drop table public.event_order_refund_allocations cascade;
drop table public.event_order_refunds cascade;
select pg_temp.chk('RB3 absent: no R2 table -> mode absent', public._cf1_refund_evidence_mode() = 'absent');
select pg_temp.chk('RB3 absent: the reason function is byte-for-byte the A1 behaviour for EVERY entry (fixtures with former ledger evidence included)',
  (select bool_and(public._cf1_entry_unavailable_reason(id) is not distinct from pg_temp.a1_reason(id)) from public.event_competition_entries)
  and (select count(*) from public.event_competition_entries) > 40);
select pg_temp.chk('RB3 absent: S1 entry (blocked-withdrawal evidence gone with the ledger) is available as in A1', not public._cf1_entry_unavailable(pg_temp.u('008011')));
select pg_temp.chk('RB3 absent: the roster reader runs', (select count(*) >= 0 from public._cf1_round_roster_problems(pg_temp.u('006002'))));
select pg_temp.expect_msg('RB3 gate: absent without an override refuses', $q$select public._cf1_od17_refund_gate()$q$, 'refund-evidence mode is absent');
select pg_temp.expect_msg('RB3 gate: an override for ANOTHER mode (r2_shape_mismatch, recorded above) does not pass absent', $q$select public._cf1_od17_refund_gate()$q$, 'mode is absent');
select pg_temp.chk('RB3 gate: record an override for absent -> gate passes as override:absent',
  (select public._cf1_rb3_record_gate_override('absent', 'owner (fixture)', 'fixture acceptance of the absent R2 false negative') is not null)
  and public._cf1_od17_refund_gate() = 'override:absent');
select pg_temp.chk('RB3 gate: revoke the absent override (returns true)',
  (select public._cf1_rb3_revoke_gate_override(id, 'owner (fixture)') from public.competition_cf1_rb3_gate_overrides where mode = 'absent' and revoked_at is null limit 1));
select pg_temp.chk('RB3 gate: no active absent override remains',
  not exists (select 1 from public.competition_cf1_rb3_gate_overrides where mode = 'absent' and revoked_at is null));
select pg_temp.expect_msg('RB3 gate: refuses after revoke', $q$select public._cf1_od17_refund_gate()$q$, 'CF1_RB3_REFUND_EVIDENCE_GATE');
select pg_temp.expect_msg('RB3 override rows are append-only: delete refused', $q$delete from public.competition_cf1_rb3_gate_overrides$q$, 'append-only');
select pg_temp.expect_msg('RB3 override rows are append-only: update of the note refused', $q$update public.competition_cf1_rb3_gate_overrides set note = 'rewritten note rewritten note'$q$, 'append-only');
select pg_temp.expect_msg('RB3 override rows are append-only: truncate refused', $q$truncate public.competition_cf1_rb3_gate_overrides$q$, 'append-only');
select pg_temp.expect_msg('RB3 override: a revoked row cannot be revoked again by update', $q$update public.competition_cf1_rb3_gate_overrides set revoked_by = 'x'$q$, 'append-only');

select pg_temp.blocked('RB3 rollback restores the A1 body exactly (md5), re-apply, negative postflights (shape / privilege / owner)', 'run by sql-tests/run_cf1_rb3.sh (needs separate transactions and a second apply); counts reported there');
select pg_temp.blocked('RB3 real R2 write path (request_competition_order_refund / observe_competition_stripe_refund / attribute_competition_refund / resolve_competition_refund_scope)', 'needs Stripe test mode + app + auth sessions; rows here are fixtures, NOT Stripe settlement');
select pg_temp.blocked('RB3 release of an entry after a refund with withdraw_entry = false, a partial refund or a pending refund', 'R2 has no audited resolution for it (OWNER DECISION): the entry stays unavailable; nothing is invented here');

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
    raise exception 'COMPETITION CF1 RB3 SQL SUITE PASS (% checks, % blocked)', v_total, v_blocked;
  end if;
  raise exception 'COMPETITION CF1 RB3 SQL SUITE FAIL: %', v_failures;
end $$;

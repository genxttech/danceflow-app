-- SC1 -- competition scratch workflow regression suite.
--
-- Covers 20270108090000_competition_sc1_scratch.sql. One transaction; the final block ALWAYS raises, so
-- nothing persists:  "SC1 SQL SUITE PASS (<n> checks)"  or  "SC1 SQL SUITE FAIL: <failures>".
--
-- Actors: studio owner (official), organizer staff (event manager, not an official), another studio's owner.

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_ids (k text primary key, v uuid) on commit drop;
grant all on t_ids to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    set constraints all immediate;
    set constraints all deferred;
    insert into t_results values (p_name, true, 'ok');
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

create or replace function pg_temp.expect_msg(p_name text, p_sql text, p_fragment text) returns void
language plpgsql as $$
declare
  v_unexpected boolean := false;
begin
  begin
    execute p_sql;
    set constraints all immediate;
    v_unexpected := true;
    raise exception 'rollback probe';
  exception when others then
    if not v_unexpected then
      insert into t_results values (p_name, position(lower(p_fragment) in lower(sqlerrm)) > 0, sqlstate || ' ' || sqlerrm);
    end if;
  end;
  if v_unexpected then
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  end if;
  set constraints all deferred;
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-00005c' || p_suffix)::uuid $$;
create or replace function pg_temp.n(p_sql text) returns bigint
language plpgsql as $$ declare r bigint; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.scratch(p_entry text, p_request text, p_reason text default null, p_resolution text default null) returns text
language sql as $$
  select format('select public.scratch_competition_entry(%L, %L, %L, %L)', pg_temp.u(p_entry), pg_temp.u(p_request), p_reason, p_resolution);
$$;
create or replace function pg_temp.entry_status(p_entry text) returns text
language sql as $$ select status from public.event_competition_entries where id = pg_temp.u(p_entry) $$;
create or replace function pg_temp.placement_status(p_entry text) returns text
language sql as $$ select string_agg(status, ',' order by status) from public.event_competition_heat_entries where entry_id = pg_temp.u(p_entry) $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-sc1-owner@example.test'),
  (pg_temp.u('000002'), 't-sc1-staff@example.test'),
  (pg_temp.u('000003'), 't-sc1-other@example.test');
insert into public.profiles (id, email, full_name) values
  (pg_temp.u('000001'), 't-sc1-owner@example.test', 'Owner'),
  (pg_temp.u('000002'), 't-sc1-staff@example.test', 'Staff'),
  (pg_temp.u('000003'), 't-sc1-other@example.test', 'Other');
insert into public.studios (id, name, slug) values
  (pg_temp.u('00a001'), 'SC1 Studio', 't-sc1-studio'),
  (pg_temp.u('00a002'), 'SC1 Other Studio', 't-sc1-other-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true),
  (pg_temp.u('000003'), pg_temp.u('00a002'), 'studio_owner', true);
insert into public.organizers (id, name, slug) values (pg_temp.u('00b001'), 'SC1 Organizer', 't-sc1-organizer');
insert into auth.users (id, email) values (pg_temp.u('000004'), 't-sc1-orgadmin@example.test');
insert into public.profiles (id, email, full_name) values (pg_temp.u('000004'), 't-sc1-orgadmin@example.test', 'Org Admin');
insert into public.organizer_users (id, organizer_id, user_id, role, active, created_at) values
  (pg_temp.u('00b101'), pg_temp.u('00b001'), pg_temp.u('000002'), 'organizer_staff', true, now()),
  (pg_temp.u('00b102'), pg_temp.u('00b001'), pg_temp.u('000004'), 'organizer_admin', true, now());
insert into public.events (id, studio_id, organizer_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
values (pg_temp.u('00e001'), pg_temp.u('00a001'), pg_temp.u('00b001'), 'SC1 Comp', 't-sc1-e1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
values (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values
  (pg_temp.u('002001'), pg_temp.u('00e001'), pg_temp.u('001001'), 'Couples', 'single_dance', 'couple', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values
  (pg_temp.u('003001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('002001'), 'Bronze Couples', 'open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number) values
  (pg_temp.u('006001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Final', 'final', 1);
-- Heats: open, to-be-locked, to-be-certified, plus one open heat whose placement already danced.
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, name) values
  (pg_temp.u('009001'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 1, 'Open heat'),
  (pg_temp.u('009002'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 2, 'Locked heat'),
  (pg_temp.u('009003'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 3, 'Certified heat'),
  (pg_temp.u('009004'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 4, 'Danced heat');

insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status) values
  (pg_temp.u('008001'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Open Entry', 'confirmed', 'eligible'),
  (pg_temp.u('008002'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Locked Entry', 'confirmed', 'eligible'),
  (pg_temp.u('008003'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Certified Entry', 'confirmed', 'eligible'),
  (pg_temp.u('008004'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Danced Entry', 'confirmed', 'eligible'),
  (pg_temp.u('008005'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Unplaced Entry', 'confirmed', 'eligible'),
  (pg_temp.u('008006'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Policy Entry', 'confirmed', 'eligible'),
  (pg_temp.u('008007'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Exception Entry', 'pending', 'unverified'),
  (pg_temp.u('008008'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Complete Entry', 'complete', 'eligible'),
  (pg_temp.u('008009'), pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('003001'), 'Locked Second', 'confirmed', 'eligible');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, status) values
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('009001'), pg_temp.u('008001'), 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('009002'), pg_temp.u('008002'), 'checked_in'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('009002'), pg_temp.u('008009'), 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('009003'), pg_temp.u('008003'), 'scheduled'),
  (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('009004'), pg_temp.u('008004'), 'danced');

-- Flush the fixture placements' deferred 10D integrity checks while the entries are still confirmed.
set constraints all immediate;
set constraints all deferred;

-- Lock and certify heats through the audited RPC, as the owner.
select pg_temp.as_user(pg_temp.u('000001'));
select public.set_competition_heat_lock_state(pg_temp.u('009002'), 'locked', 'Final check-in done');
select public.set_competition_heat_lock_state(pg_temp.u('009003'), 'locked', 'Final check-in done');
select public.set_competition_heat_lock_state(pg_temp.u('009003'), 'certified', 'Results certified');
reset role;

-- No-money baselines (R2 tables may or may not exist on this database).
insert into t_ids values ('nil', null);
select pg_temp.chk('fixture: four heats in open / locked / certified / open+danced states',
  (select string_agg(lock_state, ',' order by heat_number) from public.event_competition_heats where event_id = pg_temp.u('00e001'))
  = 'open,locked,certified,open');

-- ============================================================================
-- Normal scratch (organizer staff: event manager, not an official)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.chk('staff is an event manager but not an official',
  public.can_manage_event_competition(pg_temp.u('00e001')) and not public._paywh1_actor_can_manage_event(pg_temp.u('00e001')));
select pg_temp.chk('effective policy defaults to no_refund', public.competition_scratch_effective_policy(pg_temp.u('001001')) = 'no_refund');

select pg_temp.expect_ok('staff scratches an entry in an open heat with no reason', pg_temp.scratch('008001', 'f00001'));
select pg_temp.chk('the entry is scratched', pg_temp.entry_status('008001') = 'scratched');
select pg_temp.chk('its open-heat placement is scratched', pg_temp.placement_status('008001') = 'scratched');
select pg_temp.chk('one normal scratch row recorded with the policy resolution and no exception',
  (select count(*) = 1 and bool_and(path = 'normal' and requested_resolution = 'no_refund' and policy_resolution = 'no_refund'
          and not is_exception and previous_status = 'confirmed' and performed_by = pg_temp.u('000002'))
   from public.event_competition_scratches where entry_id = pg_temp.u('008001')));
select pg_temp.chk('the entry change audit records a scratch with fee_handling retain (no money)',
  exists (select 1 from public.event_competition_entry_changes
          where entry_id = pg_temp.u('008001') and change_type = 'scratch' and fee_handling = 'retain'));

select pg_temp.expect_ok('replaying the same request returns the same scratch (idempotent)', pg_temp.scratch('008001', 'f00001'));
select pg_temp.chk('the replay added no second scratch row',
  pg_temp.n($q$select count(*) from public.event_competition_scratches where entry_id = pg_temp.u('008001')$q$) = 1);
select pg_temp.expect_msg('a new request on an already scratched entry is refused', pg_temp.scratch('008001', 'f00002'), 'COMP_SC1_ALREADY_SCRATCHED');
select pg_temp.expect_msg('a request id reused for another entry is refused', pg_temp.scratch('008005', 'f00001'), 'COMP_SC1_REQUEST_REUSED');
select pg_temp.expect_msg('a complete entry cannot be scratched', pg_temp.scratch('008008', 'f00003'), 'COMP_SC1_NOT_SCRATCHABLE');

-- Locked heat: staff refused, official allowed with a reason (S-D2).
select pg_temp.expect_msg('staff cannot scratch an entry in a locked heat', pg_temp.scratch('008002', 'f00010', 'No show'), 'COMP_SC1_OFFICIAL_REQUIRED');
select pg_temp.chk('the refused locked-heat entry is untouched', pg_temp.entry_status('008002') = 'confirmed' and pg_temp.placement_status('008002') = 'checked_in');
-- Exception: a non-default resolution needs an official.
select pg_temp.expect_msg('staff cannot override the policy (refund instead of no_refund)',
  pg_temp.scratch('008005', 'f00011', 'Injury', 'refund'), 'COMP_SC1_OFFICIAL_REQUIRED');
select pg_temp.expect_msg('competition credit is not available yet', pg_temp.scratch('008005', 'f00012', 'x', 'credit'), 'COMP_SC1_CREDIT_NOT_AVAILABLE');
select pg_temp.expect_msg('an unknown resolution is refused', pg_temp.scratch('008005', 'f00013', 'x', 'cash'), 'COMP_SC1_RESOLUTION');
select pg_temp.expect_msg('staff cannot set the scratch policy',
  $q$select public.set_competition_scratch_policy(pg_temp.u('001001'), 'refund')$q$, 'COMP_SC1_NOT_FOUND');

-- Direct writes stay closed.
select pg_temp.expect_msg('the scratch audit cannot be written directly',
  $q$insert into public.event_competition_scratches (event_id, program_id, entry_id, request_id, path, policy_resolution, requested_resolution, is_exception, previous_status, performed_by)
     values (pg_temp.u('00e001'), pg_temp.u('001001'), pg_temp.u('008005'), gen_random_uuid(), 'normal', 'no_refund', 'no_refund', false, 'confirmed', pg_temp.u('000002'))$q$,
  'permission denied');
select pg_temp.expect_msg('a direct scratch of a locked-heat placement is still refused',
  $q$update public.event_competition_heat_entries set status = 'scratched' where entry_id = pg_temp.u('008002')$q$,
  'authorized correction workflow');
reset role;

-- ============================================================================
-- Official (studio owner)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('an official still needs a reason for a locked-heat scratch', pg_temp.scratch('008002', 'f00020'), 'COMP_SC1_REASON_REQUIRED');
select pg_temp.expect_ok('an official scratches an entry in a locked heat with a reason, without reopening it',
  pg_temp.scratch('008002', 'f00021', 'No show at on-deck'));
select pg_temp.chk('the locked-heat entry and placement are scratched',
  pg_temp.entry_status('008002') = 'scratched' and pg_temp.placement_status('008002') = 'scratched');
select pg_temp.chk('the heat stays locked (not reopened) and no lock event was written',
  (select lock_state from public.event_competition_heats where id = pg_temp.u('009002')) = 'locked'
  and pg_temp.n($q$select count(*) from public.event_competition_heat_lock_events where heat_id = pg_temp.u('009002')$q$) = 1);
select pg_temp.chk('the official scratch is audited with path, heat, reason and actor',
  exists (select 1 from public.event_competition_scratches
          where entry_id = pg_temp.u('008002') and path = 'official_locked' and locked_heat_ids = array[pg_temp.u('009002')]
            and reason = 'No show at on-deck' and performed_by = pg_temp.u('000001')));
select pg_temp.chk('the other placement in the locked heat is untouched', pg_temp.placement_status('008009') = 'scheduled');
select pg_temp.expect_msg('the official authorization does not extend to other placements in that heat',
  $q$update public.event_competition_heat_entries set status = 'scratched' where entry_id = pg_temp.u('008009')$q$,
  'authorized correction workflow');

select pg_temp.expect_msg('a certified-heat entry cannot be scratched, even by an official',
  pg_temp.scratch('008003', 'f00022', 'Late withdrawal'), 'COMP_SC1_CERTIFIED');
select pg_temp.chk('the certified-heat entry is untouched', pg_temp.entry_status('008003') = 'confirmed' and pg_temp.placement_status('008003') = 'scheduled');
select pg_temp.expect_msg('an entry that already danced cannot be scratched, even in an open heat',
  pg_temp.scratch('008004', 'f00023', 'Left early'), 'COMP_SC1_DANCED');
select pg_temp.chk('the danced placement is untouched', pg_temp.placement_status('008004') = 'danced');

-- Policy and exceptions.
select pg_temp.expect_msg('a policy default of credit is refused for now',
  $q$select public.set_competition_scratch_policy(pg_temp.u('001001'), 'credit')$q$, 'COMP_SC1_RESOLUTION');
select pg_temp.expect_msg('a studio owner cannot set the organizer''s standard policy',
  $q$select public.set_competition_scratch_policy_default(pg_temp.u('00e001'), 'refund')$q$, 'COMP_SC1_NOT_FOUND');
reset role;
select pg_temp.as_user(pg_temp.u('000004'));
select pg_temp.expect_ok('an organizer admin sets the organizer standard policy to refund',
  $q$select public.set_competition_scratch_policy_default(pg_temp.u('00e001'), 'refund')$q$);
select pg_temp.chk('the organizer admin reads the organizer default it set',
  exists (select 1 from public.competition_scratch_policy_defaults where organizer_id = pg_temp.u('00b001') and default_resolution = 'refund'));
reset role;
select pg_temp.chk('the organizer default (not the studio) holds it',
  exists (select 1 from public.competition_scratch_policy_defaults where organizer_id = pg_temp.u('00b001') and default_resolution = 'refund')
  and not exists (select 1 from public.competition_scratch_policy_defaults where studio_id = pg_temp.u('00a001')));
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.chk('the effective policy follows the organizer default', public.competition_scratch_effective_policy(pg_temp.u('001001')) = 'refund');
select pg_temp.expect_ok('an official sets a program override back to no_refund',
  $q$select public.set_competition_scratch_policy(pg_temp.u('001001'), 'no_refund')$q$);
select pg_temp.chk('the program override wins', public.competition_scratch_effective_policy(pg_temp.u('001001')) = 'no_refund');

select pg_temp.expect_ok('a scratch with no resolution uses the policy default', pg_temp.scratch('008006', 'f00030'));
select pg_temp.chk('it is recorded as no_refund, not an exception',
  exists (select 1 from public.event_competition_scratches where entry_id = pg_temp.u('008006') and requested_resolution = 'no_refund' and not is_exception));
select pg_temp.expect_msg('an exception needs a reason even for an official', pg_temp.scratch('008007', 'f00031', null, 'refund'), 'COMP_SC1_REASON_REQUIRED');
select pg_temp.expect_ok('an official records a refund exception with a reason', pg_temp.scratch('008007', 'f00032', 'Medical note provided', 'refund'));
select pg_temp.chk('the exception is audited (policy no_refund, requested refund, reason)',
  exists (select 1 from public.event_competition_scratches where entry_id = pg_temp.u('008007')
          and policy_resolution = 'no_refund' and requested_resolution = 'refund' and is_exception and reason = 'Medical note provided'));
select pg_temp.chk('a refund-requested scratch still moves no money (fee_handling retain)',
  exists (select 1 from public.event_competition_entry_changes where entry_id = pg_temp.u('008007') and change_type = 'scratch' and fee_handling = 'retain')
  and not exists (select 1 from public.event_competition_entry_changes where entry_id = pg_temp.u('008007') and fee_handling in ('refund', 'partial_refund')));
reset role;

-- No scratch path touches money: no payment, order, registration or refund rows changed.
select pg_temp.chk('scratching created no refund ledger rows (R2) on this database',
  to_regclass('public.event_order_refunds') is null
  or pg_temp.n('select count(*) from public.event_order_refunds where event_id = ''' || pg_temp.u('00e001') || '''') = 0);
select pg_temp.chk('the scratch RPC body calls no payment, refund or Stripe code',
  position('refund' in lower(regexp_replace(pg_get_functiondef('public.scratch_competition_entry(uuid, uuid, text, text)'::regprocedure),
    '''(no_refund|refund|credit)''|refund instead|Refund\.|or Refund|No refund|refund_|requested_resolution', '', 'gi'))) = 0
  and position('event_payments' in pg_get_functiondef('public.scratch_competition_entry(uuid, uuid, text, text)'::regprocedure)) = 0
  and position('event_orders' in pg_get_functiondef('public.scratch_competition_entry(uuid, uuid, text, text)'::regprocedure)) = 0);

-- ============================================================================
-- Tenant isolation
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('another studio owner cannot scratch this event''s entries', pg_temp.scratch('008005', 'f00040', 'x'), 'COMP_SC1_NOT_FOUND');
select pg_temp.chk('another studio owner reads no scratch rows',
  pg_temp.n($q$select count(*) from public.event_competition_scratches where event_id = pg_temp.u('00e001')$q$) = 0);
select pg_temp.chk('another studio owner reads no program policy',
  pg_temp.n($q$select count(*) from public.event_competition_scratch_policies where event_id = pg_temp.u('00e001')$q$) = 0);
select pg_temp.chk('another studio owner reads no organizer default',
  pg_temp.n($q$select count(*) from public.competition_scratch_policy_defaults where organizer_id = pg_temp.u('00b001')$q$) = 0);
select pg_temp.expect_msg('another studio owner cannot set this event''s policy',
  $q$select public.set_competition_scratch_policy_default(pg_temp.u('00e001'), 'no_refund')$q$, 'COMP_SC1_NOT_FOUND');
reset role;

set role anon;
select pg_temp.expect_msg('anon cannot call the scratch RPC', pg_temp.scratch('008005', 'f00041'), 'permission denied');
reset role;

-- ============================================================================
-- Append-only audit and grants
-- ============================================================================
select pg_temp.expect_msg('the scratch audit cannot be updated, even by the owner role',
  $q$update public.event_competition_scratches set reason = 'edited'$q$, 'append-only');
select pg_temp.expect_msg('the scratch audit cannot be deleted, even by the owner role',
  $q$delete from public.event_competition_scratches$q$, 'append-only');
select pg_temp.chk('API roles have no write grant on SC1 tables',
  not has_table_privilege('authenticated', 'public.event_competition_scratches', 'INSERT')
  and not has_table_privilege('authenticated', 'public.event_competition_scratch_policies', 'INSERT')
  and not has_table_privilege('authenticated', 'public.competition_scratch_policy_defaults', 'UPDATE')
  and not has_table_privilege('anon', 'public.event_competition_scratches', 'SELECT'));
select pg_temp.chk('anon cannot execute the scratch or policy RPCs',
  not has_function_privilege('anon', 'public.scratch_competition_entry(uuid, uuid, text, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_competition_scratch_policy(uuid, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_competition_scratch_policy_default(uuid, text)', 'EXECUTE'));

-- Regression: the June lifecycle RPC still refuses locked heats, and the guard still blocks other child writes.
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('change_competition_entry_lifecycle still refuses an entry in a locked heat',
  $q$select public.change_competition_entry_lifecycle(pg_temp.u('008009'), 'withdrawn', 'x', 'retain')$q$, 'locked or certified heat');
select pg_temp.expect_msg('a placement cannot be added to a locked heat',
  $q$insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id) values (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('009002'), pg_temp.u('008005'))$q$,
  'authorized correction workflow');
reset role;

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
    raise exception 'SC1 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'SC1 SQL SUITE FAIL: %', v_failures;
end $$;

-- Competition OD-04 -- event delete guard regression suite.
--
-- Covers 20270301080000_competition_od04_event_delete_guard.sql on top of the composed Competition chain (through 20270218090000).
-- Run as a SUPERUSER (supabase_admin) on a LOCAL QA database only, after loading fixtures/od04_seed.sql in the same psql session:
--   cat sql-tests/fixtures/od04_seed.sql sql-tests/test_T_competition_od04_event_delete_guard.sql | psql -U supabase_admin ...
-- One transaction, synthetic rows only. The final block ALWAYS raises, so nothing persists:
--   "COMPETITION OD-04 SQL SUITE PASS (<n> checks)"  or  "COMPETITION OD-04 SQL SUITE FAIL: <failures>".
-- Races (delete vs concurrent evidence insert) live in concurrency/run_od04_race.sh.
--
-- Every protected table gets its own event and ONE synthetic evidence row (placed with session_replication_role = replica; the guard is
-- ENABLE ALWAYS and is exercised with the setting back at origin). The same row is re-checked after each refused delete.
begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;

-- trigger modes before anything runs: the seed helper switches other packages' triggers off for single inserts and must restore them (S11)
create temp table t_trg_before on commit drop as select tgrelid, tgname, tgenabled from pg_trigger where not tgisinternal;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

-- Runs p_sql inside a savepoint; records pass when it raises an error whose message contains p_fragment (and, when given, sqlstate p_state).
create or replace function pg_temp.expect_error(p_name text, p_sql text, p_fragment text, p_state text default null) returns void
language plpgsql as $$
declare
  v_raised boolean := false;
begin
  begin
    execute p_sql;
    raise exception 'od04 probe: statement succeeded';
  exception when others then
    if sqlerrm = 'od04 probe: statement succeeded' then
      insert into t_results values (p_name, false, 'statement succeeded but an error was expected');
    else
      insert into t_results values (p_name,
        position(lower(p_fragment) in lower(sqlerrm)) > 0 and (p_state is null or sqlstate = p_state),
        sqlstate || ' ' || left(sqlerrm, 300));
    end if;
  end;
end $$;

create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, true, 'ok');
  exception when others then
    insert into t_results values (p_name, false, sqlstate || ' ' || left(sqlerrm, 300));
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Expected decision (kept here a second time on purpose: a change to the migration's list must change this file too)
-- ---------------------------------------------------------------------------
create temp table t_expected (tbl text primary key, protected boolean not null) on commit drop;
insert into t_expected(tbl, protected)
select t, true from unnest(array[
  'event_competition_ballots', 'event_competition_marks', 'event_competition_ballot_events', 'event_competition_ballot_corrections',
  'event_competition_judge_attendance',
  'event_competition_result_versions', 'event_competition_result_rows', 'event_competition_result_events',
  'event_competition_result_approvals', 'event_competition_result_publications',
  'event_competition_round_advancements', 'event_competition_round_advancement_entries', 'event_competition_round_advancement_heats',
  'event_competition_round_advancement_revocations', 'event_competition_round_capacity_events',
  'event_competition_round_exclusions', 'event_competition_correction_causes', 'event_competition_correction_cosigns',
  'event_competition_final_withdrawals', 'event_competition_final_withdrawal_requests',
  'event_competition_final_withdrawal_request_cancellations'
]) t;

-- Per-table overrides for CHECK constraints (filled from the schema dump; see the suite output for any table that still cannot be seeded).
create temp table t_overrides (tbl text primary key, ov jsonb not null) on commit drop;
insert into t_overrides(tbl, ov) values
  ('event_competition_ballot_corrections', '{"diff": "{\"removed\":[],\"added\":[],\"unchanged\":[]}"}'),
  ('event_competition_ballots', '{"ballot_format": "callback_yes", "ballot_format_version": "1"}'),
  ('event_competition_correction_causes', '{"id": "00000000-0000-0000-0000-0000000c0001", "cause": "judge_entry_error"}'),
  ('event_competition_correction_cosigns', '{"cause_id": "00000000-0000-0000-0000-0000000c0002"}'),
  ('event_competition_final_withdrawal_request_cancellations', '{"reason": "a cancellation reason of enough length"}'),
  ('event_competition_final_withdrawal_requests', '{"reason": "withdrawal reason"}'),
  ('event_competition_final_withdrawals', '{"reason": "withdrawal reason"}'),
  ('event_competition_judge_attendance', '{"status": "present", "reason": null}'),
  ('event_competition_marks', '{"mark": "1"}'),
  ('event_competition_result_versions', '{"engine_key": "studio_ordinal_majority", "engine_version": "1", "trace": "[]", "warnings": "[]", "input_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "trace_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'),
  ('event_competition_round_advancement_revocations', '{"cause": "source_correction_opened"}'),
  ('event_competition_round_exclusions', '{"reason": "exclusion reason"}'),
  ('competition_cf1_od17_audit', '{"reason": "a reason that is long enough"}'),
  ('event_competition_credentials', '{"holder_type": "participant", "registration_attendee_id": "00000000-0000-0000-0000-0000000a0001"}'),
  ('event_competition_schedule_blocks', '{"starts_at": "2030-01-01 10:00:00+00", "ends_at": "2030-01-01 11:00:00+00"}'),
  ('event_competition_schedule_sessions', '{"starts_at": "2030-01-01 10:00:00+00", "ends_at": "2030-01-01 11:00:00+00"}'),
  ('event_competition_scoring_pins', '{"resolution": "unmapped"}'),
  ('event_competition_eligibility_determinations', '{"fingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}');

-- ---------------------------------------------------------------------------
-- 1. Structure
-- ---------------------------------------------------------------------------
do $$
declare
  v_listed text[];
  v_expected text[];
begin
  v_listed := public._compod04_evidence_tables();
  select array_agg(tbl order by tbl) into v_expected from t_expected where protected;
  perform pg_temp.chk('S1 evidence list equals the decision recorded in this suite',
    (select array_agg(x order by x) from unnest(v_listed) x) = v_expected,
    'listed=' || coalesce(array_to_string(v_listed, ','), '') );
  perform pg_temp.chk('S2 evidence list has no duplicates', cardinality(v_listed) = (select count(distinct x) from unnest(v_listed) x), '');
end $$;

-- every protected table exists, carries event_id NOT NULL with a cascading FK to events (so the cascade path this guard closes is real)
select pg_temp.chk('S3 ' || e.tbl || ': event_id not null + FK to events',
  exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || e.tbl) and a.attname = 'event_id' and a.attnotnull)
  and exists (select 1 from pg_constraint c where c.contype = 'f' and c.conrelid = to_regclass('public.' || e.tbl) and c.confrelid = 'public.events'::regclass),
  coalesce((select string_agg(c.confdeltype::text, ',') from pg_constraint c where c.contype = 'f' and c.conrelid = to_regclass('public.' || e.tbl) and c.confrelid = 'public.events'::regclass), 'no fk'))
from t_expected e where e.protected order by e.tbl;

-- completeness: every table that references events (directly) or carries an event_id column is classified, protected or explicitly not protected
create temp table t_classified (tbl text primary key, protected boolean not null, reason text not null) on commit drop;
insert into t_classified(tbl, protected, reason)
select t, false, r from (values
  ('event_competition_ballot_drafts', 'working copies; never enter hashes or results'),
  ('event_competition_programs', 'setup'), ('event_competition_contests', 'setup'), ('event_competition_dances', 'setup'),
  ('event_competition_division_dances', 'setup'), ('event_competition_divisions', 'setup'), ('event_competition_rounds', 'setup/lifecycle (rounds with evidence are covered through the evidence tables)'),
  ('event_competition_wsdc_division_rules', 'setup'), ('event_competition_wsdc_petitions', 'registration petition'), ('event_competition_wsdc_program_profiles', 'setup'),
  ('event_competition_program_locks', 'setup lock'), ('event_competition_scoring_pins', 'engine pin (no FK to events; removed with its program/round)'), ('event_competition_setup_resets', 'setup history'),
  ('event_competition_entries', 'registration'), ('event_competition_entry_dances', 'registration'), ('event_competition_entry_participants', 'registration'),
  ('event_competition_competitors', 'registration'), ('event_competition_fee_rules', 'pricing setup'), ('event_competition_contest_registration_rules', 'setup'),
  ('event_competition_registration_carts', 'registration'), ('event_competition_registration_cart_entries', 'registration'), ('event_competition_registration_cart_entry_dances', 'registration'),
  ('event_competition_registration_cart_entry_people', 'registration'), ('event_competition_registration_cart_people', 'registration'), ('event_competition_registration_cart_price_lines', 'registration'),
  ('event_competition_checkin_sessions', 'check-in'), ('event_competition_checkin_participants', 'check-in'), ('event_competition_credentials', 'check-in'),
  ('event_competition_participant_waivers', 'check-in'), ('event_competition_checkin_payment_audit', 'check-in money audit (no FK to events)'),
  ('event_competition_schedule_versions', 'schedule'), ('event_competition_schedule_floors', 'schedule'), ('event_competition_schedule_sessions', 'schedule'),
  ('event_competition_schedule_blocks', 'schedule'), ('event_competition_schedule_block_contests', 'schedule'), ('event_competition_schedule_publications', 'schedule publication (not results)'),
  ('event_competition_floor_heats', 'schedule'), ('event_competition_heats', 'heats'), ('event_competition_heat_dances', 'heats'), ('event_competition_heat_entries', 'heats'),
  ('event_competition_generation_runs', 'heat generation'), ('event_competition_generation_conflicts', 'heat generation'), ('event_competition_generation_constraints', 'heat generation'), ('event_competition_generation_proposals', 'heat generation'),
  ('event_competition_officials', 'panel setup (deactivation, not deletion, once a ballot references one)'), ('event_competition_panel_assignments', 'panel setup'),
  ('event_competition_entry_changes', 'operational audit of entries'), ('event_competition_heat_lock_events', 'operational audit of heat locks'),
  ('event_competition_official_events', 'operational audit of officials/panels'), ('event_competition_round_transition_events', 'operational audit of round start/cancel'),
  ('event_competition_heat_no_shows', 'day-of attendance'), ('event_competition_heat_no_show_voids', 'day-of attendance'),
  ('competition_cf1_od17_enforcement', 'control switch'), ('competition_cf1_od17_audit', 'audit of the control switch'),
  -- added by later competition packages (present only on the composed chain). Neither is a ballot or a result, so an event holding only these stays
  -- deletable (owner OD-04 scope: block once ballots or results exist); whether to extend the block to them is an open owner question.
  ('event_competition_eligibility_determinations', 'registration eligibility decision (R-15); append-only, leaves only with its event'),
  ('event_competition_panel_recovery_cases', 'panel-break case (R-10); an attendance-driven case also has a protected attendance row'),
  ('event_competition_refund_exception_scopes', 'money; ON DELETE RESTRICT already blocks'), ('competition_cf1_rb3_reconciliations', 'money; ON DELETE RESTRICT already blocks')
) v(t, r);

select pg_temp.chk('S4 unclassified table reachable from events: ' || u.tbl, false,
  'add it to _compod04_evidence_tables() or to this suite''s not-protected list with a reason')
from (
  select k.relname as tbl from pg_class k
  where k.relnamespace = 'public'::regnamespace and k.relkind in ('r', 'p') and k.relname ~ 'competition'
    and (exists (select 1 from pg_attribute a where a.attrelid = k.oid and a.attname = 'event_id' and not a.attisdropped)
         or exists (select 1 from pg_constraint c where c.contype = 'f' and c.conrelid = k.oid and c.confrelid = 'public.events'::regclass))
    and k.relname <> 'events'
) u
where u.tbl not in (select tbl from t_expected) and u.tbl not in (select tbl from t_classified);
select pg_temp.chk('S4 completeness check ran (classified tables: ' || (select count(*) from t_classified) || ')', true, '');

-- triggers and privileges
select pg_temp.chk('S5 delete guard installed, ENABLE ALWAYS, before delete, row level',
  exists (select 1 from pg_trigger t where t.tgrelid = 'public.events'::regclass and t.tgname = 'a00_compod04_events_delete_guard'
          and t.tgenabled = 'A' and (t.tgtype & 2) = 2 and (t.tgtype & 8) = 8 and (t.tgtype & 1) = 1), '');
select pg_temp.chk('S6 truncate guard installed, ENABLE ALWAYS, before truncate, statement level',
  exists (select 1 from pg_trigger t where t.tgrelid = 'public.events'::regclass and t.tgname = 'a00_compod04_events_truncate_guard'
          and t.tgenabled = 'A' and (t.tgtype & 2) = 2 and (t.tgtype & 32) = 32 and (t.tgtype & 1) = 0), '');
select pg_temp.chk('S7 delete guard sorts first among BEFORE DELETE triggers on events',
  (select tgname from pg_trigger t where t.tgrelid = 'public.events'::regclass and not t.tgisinternal and (t.tgtype & 2) = 2 and (t.tgtype & 8) = 8 order by tgname limit 1) = 'a00_compod04_events_delete_guard',
  (select string_agg(tgname, ',' order by tgname) from pg_trigger t where t.tgrelid = 'public.events'::regclass and not t.tgisinternal and (t.tgtype & 2) = 2 and (t.tgtype & 8) = 8));
select pg_temp.chk('S8 functions are SECURITY DEFINER with a pinned search_path',
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('_compod04_event_evidence', '_compod04_any_evidence', 'compod04_guard_event_delete', 'compod04_guard_event_truncate')
     and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) = 4, '');
select pg_temp.chk('S9 no EXECUTE for public, anon or authenticated on any OD-04 function',
  not exists (select 1 from pg_proc p, unnest(array['anon', 'authenticated']) r
              where p.pronamespace = 'public'::regnamespace and p.proname like '%compod04%'
                and has_function_privilege(r, p.oid, 'execute')), '');

-- ---------------------------------------------------------------------------
-- 2. Fixtures: one studio, one ordinary event, one competition event per protected table
-- ---------------------------------------------------------------------------
create temp table t_ev (tbl text primary key, event_id uuid not null, row_id uuid) on commit drop;
create temp table t_ctx (studio uuid not null, ordinary uuid not null, empty_comp uuid not null) on commit drop;

do $$
declare
  v_studio uuid := gen_random_uuid();
  v_ord uuid := gen_random_uuid();
  v_empty uuid := gen_random_uuid();
  r record;
  v_ev uuid;
  v_row uuid;
  v_ov jsonb;
begin
  insert into public.studios (id, name, slug) values (v_studio, 'OD04 Studio', 't-od04-' || substr(v_studio::text, 1, 8));
  insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
    (v_ord, v_studio, 'OD04 ordinary', 't-od04-o-' || substr(v_ord::text, 1, 8), 'workshop', current_date + 30, current_date + 30, 'published', 'public', false),
    (v_empty, v_studio, 'OD04 competition without evidence', 't-od04-e-' || substr(v_empty::text, 1, 8), 'competition', current_date + 30, current_date + 30, 'draft', 'private', true);
  insert into t_ctx values (v_studio, v_ord, v_empty);

  for r in select tbl from t_expected where protected order by tbl loop
    v_ev := gen_random_uuid();
    insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
      values (v_ev, v_studio, 'OD04 ' || r.tbl, 't-od04-' || substr(v_ev::text, 1, 12), 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
    select ov into v_ov from t_overrides where tbl = r.tbl;
    begin
      if r.tbl = 'event_competition_correction_cosigns' then
        perform pg_temp.od04_seed('event_competition_correction_causes', v_ev, (select ov from t_overrides where tbl = 'event_competition_correction_causes') || '{"id": "00000000-0000-0000-0000-0000000c0002"}'::jsonb);
      end if;
      v_row := pg_temp.od04_seed(r.tbl, v_ev, coalesce(v_ov, '{}'::jsonb));
      insert into t_ev values (r.tbl, v_ev, v_row);
    exception when others then
      perform pg_temp.chk('F1 seed one evidence row into ' || r.tbl, false, sqlstate || ' ' || left(sqlerrm, 300));
    end;
  end loop;
  perform pg_temp.chk('F1 all protected tables seeded', (select count(*) from t_ev) = (select count(*) from t_expected where protected),
    (select count(*) from t_ev)::text || ' of ' || (select count(*) from t_expected where protected)::text);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Per protected table: the delete is refused with the documented error and NOTHING is removed
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_state text;
  v_msg text;
  v_left_event boolean;
  v_left_row boolean;
begin
  for r in select tbl, event_id from t_ev order by tbl loop
    begin
      execute format('delete from public.events where id = %L', r.event_id);
      perform pg_temp.chk('D1 ' || r.tbl || ': delete of the event is refused', false, 'delete succeeded');
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_state := sqlstate;
      perform pg_temp.chk('D1 ' || r.tbl || ': delete of the event is refused with 23503 COMP_EVENT_HAS_SCORING_EVIDENCE naming the table',
        v_state = '23503' and v_msg like 'COMP_EVENT_HAS_SCORING_EVIDENCE:%' and v_msg like '%' || r.tbl || '%', v_state || ' ' || left(v_msg, 200));
    end;
    select exists (select 1 from public.events where id = r.event_id) into v_left_event;
    execute format('select exists (select 1 from public.%I where event_id = %L)', r.tbl, r.event_id) into v_left_row;
    perform pg_temp.chk('D2 ' || r.tbl || ': event and evidence row are both still present', v_left_event and v_left_row, v_left_event::text || '/' || v_left_row::text);
  end loop;
end $$;

-- a single bulk delete that includes one protected event is refused as a whole (no partial deletion)
select pg_temp.expect_error('D3 bulk delete containing protected events is refused', 'delete from public.events where id in (select event_id from t_ev) or id = (select ordinary from t_ctx)', 'COMP_EVENT_HAS_SCORING_EVIDENCE', '23503');
select pg_temp.chk('D3b the ordinary event in that bulk delete was not removed either (statement is atomic)', exists (select 1 from public.events where id = (select ordinary from t_ctx)), '');

-- cascade from a parent: events.organizer_id is ON DELETE CASCADE (events.studio_id is NO ACTION, so a studio delete cannot cascade to events);
-- deleting the organizer must not take protected events (or their evidence) with it
create temp table t_org (id uuid) on commit drop;
do $$
declare
  v_org uuid;
  v_ev uuid := (select event_id from t_ev order by tbl limit 1);
begin
  v_org := pg_temp.od04_seed('organizers', v_ev, '{}'::jsonb);
  insert into t_org values (v_org);
  perform set_config('session_replication_role', 'replica', true);
  update public.events set organizer_id = v_org where id = v_ev;
  perform set_config('session_replication_role', 'origin', true);
exception when others then
  perform pg_temp.chk('D4 setup: organizer attached to a protected event', false, sqlstate || ' ' || left(sqlerrm, 200));
end $$;
select pg_temp.chk('S10 events.organizer_id cascades; events.studio_id does not (the two parent paths)',
  (select confdeltype from pg_constraint where conname = 'events_organizer_id_fkey') = 'c' and (select confdeltype from pg_constraint where conname = 'events_studio_id_fkey') <> 'c', '');
select pg_temp.expect_error('D4 organizer delete (cascade to events) is refused while the event holds evidence',
  format('delete from public.organizers where id = %L', (select id from t_org)), 'COMP_EVENT_HAS_SCORING_EVIDENCE')
where exists (select 1 from t_org);
select pg_temp.chk('D4b organizer and the protected event survived the refused cascade',
  exists (select 1 from public.organizers where id = (select id from t_org)) and (select count(*) from public.events where id in (select event_id from t_ev)) = (select count(*) from t_ev), '')
where exists (select 1 from t_org);
-- TRUNCATE
set constraints all immediate;
select pg_temp.expect_error('D5 truncate events cascade is refused while evidence exists', 'truncate table public.events cascade', 'COMP_EVENT_HAS_SCORING_EVIDENCE', '23503');
select pg_temp.chk('D5b events survived the refused truncate', (select count(*) from public.events where id in (select event_id from t_ev)) = (select count(*) from t_ev), '');

-- the guard is not bypassed by session_replication_role = replica (ENABLE ALWAYS)
do $$
declare
  v_ev uuid := (select event_id from t_ev order by tbl limit 1);
  v_msg text;
begin
  perform set_config('session_replication_role', 'replica', true);
  begin
    delete from public.events where id = v_ev;
    perform pg_temp.chk('D6 replica role does not bypass the guard', false, 'delete succeeded');
  exception when others then
    get stacked diagnostics v_msg = message_text;
    perform pg_temp.chk('D6 replica role does not bypass the guard', v_msg like 'COMP_EVENT_HAS_SCORING_EVIDENCE:%', left(v_msg, 120));
  end;
  perform set_config('session_replication_role', 'origin', true);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Child-level paths: a protected evidence row cannot be removed on its own either while the event exists
--    (cascades from rounds / programs / heats / officials fire these same row triggers). Reported per table: a table that allows it is a finding.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_n bigint;
begin
  for r in select tbl, event_id from t_ev order by tbl loop
    begin
      execute format('delete from public.%I where event_id = %L', r.tbl, r.event_id);
      get diagnostics v_n = row_count;
      perform pg_temp.chk('C1 ' || r.tbl || ': evidence row cannot be deleted directly while the event exists', false, 'deleted ' || v_n || ' row(s) (no row-level protection: finding)');
      -- put the row back so later checks still see the evidence
      perform pg_temp.od04_seed(r.tbl, r.event_id, coalesce((select ov from t_overrides where tbl = r.tbl), '{}'::jsonb));
    exception when others then
      perform pg_temp.chk('C1 ' || r.tbl || ': evidence row cannot be deleted directly while the event exists', true, sqlstate || ' ' || left(sqlerrm, 160));
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Events WITHOUT scoring evidence are deleted exactly as before
-- ---------------------------------------------------------------------------
-- 5a. every table that is classified "not protected" gets one synthetic row on the competition event that has no evidence
create temp table t_np_seeded (tbl text primary key, ok boolean not null, detail text) on commit drop;
do $$
declare
  r record;
  v_empty uuid := (select empty_comp from t_ctx);
begin
  for r in select tbl from t_classified where not protected and tbl not in ('event_competition_programs', 'event_competition_refund_exception_scopes', 'competition_cf1_rb3_reconciliations',
    -- no foreign key to events (event_id is a plain value; scoring_pins / program_locks cascade from their program): nothing to cascade, so nothing to assert here
    'event_competition_checkin_payment_audit', 'event_competition_program_locks', 'event_competition_scoring_pins')
    and to_regclass('public.' || tbl) is not null order by tbl loop
    begin
      perform pg_temp.od04_seed(r.tbl, v_empty, coalesce((select ov from t_overrides where tbl = r.tbl), '{}'::jsonb));
      insert into t_np_seeded values (r.tbl, true, 'seeded');
    exception when others then
      insert into t_np_seeded values (r.tbl, false, sqlstate || ' ' || left(sqlerrm, 200));
    end;
  end loop;
end $$;
select pg_temp.chk('N0 not-protected table seeded: ' || tbl, ok, detail) from t_np_seeded order by tbl;

select pg_temp.expect_ok('N1 competition event without scoring evidence (setup rows present) is deletable', format('delete from public.events where id = %L', (select empty_comp from t_ctx)));
do $$
declare
  s record;
  v_n bigint;
  v_left text := '';
begin
  for s in select tbl from t_np_seeded where ok order by tbl loop
    execute format('select count(*) from public.%I where event_id = %L', s.tbl, (select empty_comp from t_ctx)) into v_n;
    if v_n > 0 then v_left := v_left || s.tbl || '(' || v_n || ') '; end if;
  end loop;
  perform pg_temp.chk('N2 that event and every seeded not-protected row are gone',
    not exists (select 1 from public.events where id = (select empty_comp from t_ctx)) and v_left = '', v_left);
end $$;

select pg_temp.expect_ok('N3 ordinary (non-competition) event is deletable', format('delete from public.events where id = %L', (select ordinary from t_ctx)));
select pg_temp.chk('N4 ordinary event is gone', not exists (select 1 from public.events where id = (select ordinary from t_ctx)), '');

-- 5b. an event whose only "evidence" is a ballot DRAFT (a working copy, not evidence) is deletable
do $$
declare
  v_ev uuid := gen_random_uuid();
begin
  insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
    values (v_ev, (select studio from t_ctx), 'OD04 drafts only', 't-od04-d-' || substr(v_ev::text, 1, 8), 'competition', current_date + 30, current_date + 30, 'draft', 'private', true);
  begin
    perform pg_temp.od04_seed('event_competition_ballot_drafts', v_ev, coalesce((select ov from t_overrides where tbl = 'event_competition_ballot_drafts'), '{}'::jsonb));
    delete from public.events where id = v_ev;
    perform pg_temp.chk('N5 event whose only rows are ballot drafts is deletable', not exists (select 1 from public.events where id = v_ev)
      and not exists (select 1 from public.event_competition_ballot_drafts where event_id = v_ev), '');
  exception when others then
    perform pg_temp.chk('N5 event whose only rows are ballot drafts is deletable', false, sqlstate || ' ' || left(sqlerrm, 200));
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 6. The archive / hide path stays open for an event that holds evidence
-- ---------------------------------------------------------------------------
do $$
declare
  v_ev uuid := (select event_id from t_ev order by tbl limit 1);
begin
  begin
    update public.events set status = 'cancelled', visibility = 'private' where id = v_ev;
    perform pg_temp.chk('A1 an event with evidence can be set cancelled + private', (select status = 'cancelled' and visibility = 'private' from public.events where id = v_ev), '');
    update public.events set status = 'completed' where id = v_ev;
    perform pg_temp.chk('A2 an event with evidence can be set completed', (select status = 'completed' from public.events where id = v_ev), '');
  exception when others then
    perform pg_temp.chk('A1/A2 archive path (status / visibility update)', false, sqlstate || ' ' || left(sqlerrm, 200));
  end;
end $$;

-- ---------------------------------------------------------------------------
select pg_temp.chk('S11 every trigger is in the same mode as before the suite (the seed helper restored what it switched off)',
  not exists (select tgrelid, tgname, tgenabled from t_trg_before except select tgrelid, tgname, tgenabled from pg_trigger where not tgisinternal), '');

do $$
declare
  v_fail text;
  v_total integer;
  v_pass integer;
begin
  select count(*), count(*) filter (where ok) into v_total, v_pass from t_results;
  select string_agg(name || ' [' || detail || ']', E'\n  ' order by name) into v_fail from t_results where not ok;
  if v_fail is null then
    raise exception 'COMPETITION OD-04 SQL SUITE PASS (% checks)', v_total;
  else
    raise exception E'COMPETITION OD-04 SQL SUITE FAIL: % of % checks failed\n  %', v_total - v_pass, v_total, v_fail;
  end if;
end $$;

-- Competition Option D -- published running order direct-write guard regression suite.
--
-- Covers 20270301170000_competition_d_published_order_write_guard.sql. NOT RUN IN CI. Run as a SUPERUSER on a LOCAL QA DATABASE ONLY. One
-- transaction, synthetic fixtures only (UUID block ...-d0d0ff4XXXXX). The final block ALWAYS raises, so nothing persists:
--   "COMPETITION D SQL SUITE PASS (<n> checks)"  or  "COMPETITION D SQL SUITE FAIL: <failures>".
-- Every write under test is made as authenticated manager A1 in its own subtransaction that is rolled back whether it succeeds or not, so the cases
-- are independent. "D:" checks are writes the base accepts: before the migration they must fail. "base:" checks are already refused by earlier guards and
-- must pass before and after. "keep:" checks are legitimate work.
begin;
create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

create or replace function pg_temp.u(p text) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-d0d0ff' || p)::uuid $$;
create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- Runs p_sql as A1 and rolls it back. Returns 'rows N' when it was accepted, otherwise the error text.
create or replace function pg_temp.attempt(p_sql text) returns text
language plpgsql as $$
declare v text; v_n bigint;
begin
  begin
    perform pg_temp.as_user(pg_temp.u('000001'));
    execute p_sql;
    get diagnostics v_n = row_count;
    raise exception 'ACCEPTED rows %', v_n;
  exception when others then
    v := sqlerrm;
  end;
  execute 'reset role';
  return v;
end $$;
-- Refused: the error holds one of the fragments (a 0-row "acceptance" is NOT a refusal).
create or replace function pg_temp.refused(p_name text, p_sql text, p_f1 text, p_f2 text default null) returns void
language plpgsql as $$
declare v text := pg_temp.attempt(p_sql);
begin
  perform pg_temp.chk(p_name, v not like 'ACCEPTED %' and (position(lower(p_f1) in lower(v)) > 0 or (p_f2 is not null and position(lower(p_f2) in lower(v)) > 0)), v);
end $$;
-- Allowed: accepted AND touched at least one row.
create or replace function pg_temp.allowed(p_name text, p_sql text) returns void
language plpgsql as $$
declare v text := pg_temp.attempt(p_sql);
begin
  perform pg_temp.chk(p_name, v like 'ACCEPTED rows %' and v <> 'ACCEPTED rows 0', v);
end $$;

grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (superuser). Event 1: published v1 (floor heats 1, 2; heats h1 round r1, h2 round r2, never run), draft v2 (floor heat 21, heat h21),
-- an unversioned heat h31, superseded v3. Event 2 (same studio): published v4 with floor heat 41. Event 3: a fresh publishable draft v5.
-- ============================================================================
insert into auth.users (id, email) values (pg_temp.u('000001'), 't-d-a1@example.test');
insert into public.profiles (id, email, full_name) values (pg_temp.u('000001'), 't-d-a1@example.test', 'D A1');
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
values (pg_temp.u('000001'), 't-d-a1@example.test', now(), now(), 'otp', 'web_callback', 'bound', now());
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'D Studio', 't-d-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
select pg_temp.u('00e00' || n), pg_temp.u('00a001'), 'D Comp ' || n, 't-d-e' || n, 'competition', current_date + 30, current_date + 30, 'published', 'public', true from generate_series(1, 3) n;
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
select pg_temp.u('00100' || n), pg_temp.u('00e00' || n), pg_temp.u('00a001'), 'Country', 'country', 'relative', 'skating', 'configured' from generate_series(1, 3) n;
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
select pg_temp.u('00200' || n), pg_temp.u('00e00' || n), pg_temp.u('00100' || n), 'ProAm', 'single_dance', 'pro_am', 'open' from generate_series(1, 3) n;
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
select pg_temp.u('00300' || n), pg_temp.u('00e00' || n), pg_temp.u('00100' || n), pg_temp.u('00200' || n), 'D' || n, 'open' from generate_series(1, 3) n;
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
select pg_temp.u('0060' || lpad(x.r::text, 2, '0')), pg_temp.u('00e00' || x.e), pg_temp.u('00100' || x.e), pg_temp.u('00300' || x.e), 'R' || x.r, 'final', x.s, 'draft', 'ordinal_majority'
from (values (1, 1, 1), (2, 1, 2), (3, 1, 3), (5, 3, 1)) x(r, e, s);
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number)
select pg_temp.u('0080' || lpad(i::text, 2, '0')), pg_temp.u('00e003'), pg_temp.u('001003'), pg_temp.u('003003'), 'E' || i, 'confirmed', 'eligible', i::text from generate_series(1, 2) i;
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values
  (pg_temp.u('00c001'), pg_temp.u('00e001'), 1, 'v1', 'published', now()),
  (pg_temp.u('00c002'), pg_temp.u('00e001'), 2, 'v2', 'draft', null),
  (pg_temp.u('00c003'), pg_temp.u('00e001'), 3, 'v3', 'superseded', now()),
  (pg_temp.u('00c004'), pg_temp.u('00e002'), 1, 'v4', 'published', now()),
  (pg_temp.u('00c005'), pg_temp.u('00e003'), 1, 'v5', 'draft', null),
  (pg_temp.u('00c007'), pg_temp.u('00e003'), 2, 'v7', 'draft', null);
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values
  (pg_temp.u('00f001'), pg_temp.u('00e001'), pg_temp.u('00c001'), 1), (pg_temp.u('00f002'), pg_temp.u('00e001'), pg_temp.u('00c001'), 2),
  (pg_temp.u('00f021'), pg_temp.u('00e001'), pg_temp.u('00c002'), 1), (pg_temp.u('00f041'), pg_temp.u('00e002'), pg_temp.u('00c004'), 1),
  (pg_temp.u('00f051'), pg_temp.u('00e003'), pg_temp.u('00c005'), 1), (pg_temp.u('00f071'), pg_temp.u('00e003'), pg_temp.u('00c007'), 1);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status, name) values
  (pg_temp.u('00d001'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 1, pg_temp.u('002001'), pg_temp.u('00c001'), pg_temp.u('00f001'), 'scheduled', 'h1'),
  (pg_temp.u('00d002'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006002'), 2, pg_temp.u('002001'), pg_temp.u('00c001'), pg_temp.u('00f002'), 'scheduled', 'h2'),
  (pg_temp.u('00d021'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006001'), 21, pg_temp.u('002001'), pg_temp.u('00c002'), pg_temp.u('00f021'), 'scheduled', 'h21'),
  (pg_temp.u('00d031'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006003'), 31, pg_temp.u('002001'), null, null, 'scheduled', 'h31'),
  (pg_temp.u('00d051'), pg_temp.u('00e003'), pg_temp.u('003003'), pg_temp.u('006005'), 1, pg_temp.u('002003'), pg_temp.u('00c005'), pg_temp.u('00f051'), 'scheduled', 'h51'),
  (pg_temp.u('00d071'), pg_temp.u('00e003'), pg_temp.u('003003'), pg_temp.u('006005'), 2, pg_temp.u('002003'), pg_temp.u('00c007'), pg_temp.u('00f071'), 'scheduled', 'h71'),
  (pg_temp.u('00d032'), pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006003'), 33, pg_temp.u('002001'), null, pg_temp.u('00f001'), 'scheduled', 'h32');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order)
select pg_temp.u('00e003'), pg_temp.u('003003'), pg_temp.u('00d051'), pg_temp.u('0080' || lpad(i::text, 2, '0')), i from generate_series(1, 2) i;
insert into public.event_competition_heat_dances (event_id, heat_id, dance_key, dance_label, sequence_number)
select pg_temp.u('00e003'), pg_temp.u('00d051'), 'waltz', 'Waltz', 1;
-- a draft order (event 3) that already holds a planted heat, and a draft schedule block (event 1)
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status) values (pg_temp.u('00c008'), pg_temp.u('00e003'), 3, 'v8bad', 'draft');
insert into public.event_competition_floor_heats (id, event_id, schedule_version_id, heat_number) values (pg_temp.u('00f081'), pg_temp.u('00e003'), pg_temp.u('00c008'), 1);
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status, name) values
  (pg_temp.u('00d081'), pg_temp.u('00e003'), pg_temp.u('003003'), pg_temp.u('006005'), 1, pg_temp.u('002003'), pg_temp.u('00c008'), pg_temp.u('00f081'), 'scheduled', 'h81'),
  (pg_temp.u('00d082'), pg_temp.u('00e003'), pg_temp.u('003003'), pg_temp.u('006005'), 3, pg_temp.u('002003'), null, pg_temp.u('00f081'), 'scheduled', 'h82');
insert into public.event_competition_schedule_sessions (id, event_id, schedule_version_id, name, session_date, starts_at, ends_at)
values (pg_temp.u('005e02'), pg_temp.u('00e001'), pg_temp.u('00c002'), 'S', current_date + 30, now() + interval '30 days', now() + interval '30 days 4 hours');
insert into public.event_competition_schedule_blocks (id, event_id, schedule_version_id, session_id, name, block_type, starts_at, ends_at)
values (pg_temp.u('00b002'), pg_temp.u('00e001'), pg_temp.u('00c002'), pg_temp.u('005e02'), 'B', 'competition', now() + interval '30 days', now() + interval '30 days 1 hour');
set session_replication_role = origin;

select pg_temp.chk('S: both guards installed, ENABLE ALWAYS, security invoker; publication is security definer',
  (select count(*) = 2 from pg_trigger where tgname in ('zz_compd_guard_published_heat', 'zz_compd_guard_published_version') and tgenabled = 'A' and not tgisinternal)
  and (select count(*) = 2 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('compd_guard_published_heat', 'compd_guard_published_version') and not p.prosecdef)
  and (select p.prosecdef from pg_proc p where p.oid = 'public.publish_competition_schedule_version(uuid)'::regprocedure));

-- ============================================================================
-- Published heats: every direct re-pointing write is refused
-- ============================================================================
select pg_temp.refused('D: move a never-run published heat to another round', $q$update public.event_competition_heats set round_id = pg_temp.u('006003') where id = pg_temp.u('00d001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: renumber a published heat', $q$update public.event_competition_heats set heat_number = 99 where id = pg_temp.u('00d001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: detach a published heat from its version and floor heat', $q$update public.event_competition_heats set schedule_version_id = null, floor_heat_id = null where id = pg_temp.u('00d001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: detach only the version (floor heat kept)', $q$update public.event_competition_heats set schedule_version_id = null where id = pg_temp.u('00d001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: move a published heat into a draft version', $q$update public.event_competition_heats set schedule_version_id = pg_temp.u('00c002'), floor_heat_id = pg_temp.u('00f021') where id = pg_temp.u('00d001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('base: move to another published numbered floor heat', $q$update public.event_competition_heats set floor_heat_id = pg_temp.u('00f002') where id = pg_temp.u('00d001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED', 'editable draft schedule');
select pg_temp.refused('base: remove from its numbered floor heat', $q$update public.event_competition_heats set floor_heat_id = null where id = pg_temp.u('00d001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED', 'editable draft schedule');
select pg_temp.refused('D: remove a published heat by a status write', $q$update public.event_competition_heats set status = 'cancelled' where id = pg_temp.u('00d001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('base: re-time a published heat', $q$update public.event_competition_heats set scheduled_at = now() where id = pg_temp.u('00d001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED', 'editable draft schedule');
select pg_temp.refused('D: change the floor label of a published heat', $q$update public.event_competition_heats set floor_label = 'B' where id = pg_temp.u('00d001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: change the duration of a published heat', $q$update public.event_competition_heats set duration_seconds = 999 where id = pg_temp.u('00d001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('base: delete a published heat', $q$delete from public.event_competition_heats where id = pg_temp.u('00d001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED', 'COMP10D_SCHEDULE_PUBLISHED');
select pg_temp.refused('base: insert a heat into a published version', $q$insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, floor_heat_id, status) values (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006003'), 61, pg_temp.u('002001'), pg_temp.u('00c001'), pg_temp.u('00f002'), 'scheduled')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED', 'editable draft schedule');
select pg_temp.refused('D: insert an unversioned heat under a published floor heat', $q$insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, contest_id, floor_heat_id, status) values (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006003'), 62, pg_temp.u('002001'), pg_temp.u('00f002'), 'scheduled')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: attach an unversioned heat to a published floor heat', $q$update public.event_competition_heats set floor_heat_id = pg_temp.u('00f002') where id = pg_temp.u('00d031')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: renumber an unversioned heat that already sits under a published floor heat', $q$update public.event_competition_heats set heat_number = 34 where id = pg_temp.u('00d032')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('base: attach an unversioned heat to the published version', $q$update public.event_competition_heats set schedule_version_id = pg_temp.u('00c001'), floor_heat_id = pg_temp.u('00f002') where id = pg_temp.u('00d031')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED', 'editable draft schedule');
select pg_temp.refused('D: attach to another event''s published floor heat', $q$update public.event_competition_heats set floor_heat_id = pg_temp.u('00f041') where id = pg_temp.u('00d031')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('base: move a draft heat into the published version', $q$update public.event_competition_heats set schedule_version_id = pg_temp.u('00c001'), floor_heat_id = pg_temp.u('00f002') where id = pg_temp.u('00d021')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED', 'editable draft schedule');

-- ============================================================================
-- Planted heats: a floor heat or block reference always needs the version, in a draft too
-- ============================================================================
select pg_temp.refused('D: insert an unversioned heat under a DRAFT floor heat', $q$insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, contest_id, floor_heat_id, status) values (pg_temp.u('00e003'), pg_temp.u('003003'), pg_temp.u('006005'), 63, pg_temp.u('002003'), pg_temp.u('00f051'), 'scheduled')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: detach a draft heat from its version, keeping the floor heat', $q$update public.event_competition_heats set schedule_version_id = null where id = pg_temp.u('00d051')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: attach an unversioned heat to a DRAFT floor heat', $q$update public.event_competition_heats set floor_heat_id = pg_temp.u('00f021') where id = pg_temp.u('00d031')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: insert an unversioned heat under a draft schedule block', $q$insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, contest_id, schedule_block_id, status) values (pg_temp.u('00e001'), pg_temp.u('003001'), pg_temp.u('006003'), 64, pg_temp.u('002001'), pg_temp.u('00b002'), 'scheduled')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: publication refuses an order holding a planted heat', $q$select public.publish_competition_schedule_version(pg_temp.u('00c008'))$q$, 'COMPD_ORDER_HEAT_VERSION_MISMATCH');
select pg_temp.allowed('keep: a manager repairs the planted draft heat by giving it the version', $q$update public.event_competition_heats set schedule_version_id = pg_temp.u('00c008') where id = pg_temp.u('00d082')$q$);

-- ============================================================================
-- Published versions
-- ============================================================================
select pg_temp.refused('D: return a published version to draft (no heat has run)', $q$update public.event_competition_schedule_versions set status = 'draft' where id = pg_temp.u('00c001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: return a published version to review', $q$update public.event_competition_schedule_versions set status = 'review' where id = pg_temp.u('00c001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: archive a published version', $q$update public.event_competition_schedule_versions set status = 'archived' where id = pg_temp.u('00c001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: unpublish by marking it superseded', $q$update public.event_competition_schedule_versions set status = 'superseded' where id = pg_temp.u('00c001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: re-date a published version', $q$update public.event_competition_schedule_versions set published_at = now() - interval '1 day' where id = pg_temp.u('00c001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: renumber a published version', $q$update public.event_competition_schedule_versions set version_number = 50 where id = pg_temp.u('00c001')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: publish a draft by a direct status write', $q$update public.event_competition_schedule_versions set status = 'published', published_at = now() where id = pg_temp.u('00c002')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: reopen a superseded version', $q$update public.event_competition_schedule_versions set status = 'draft' where id = pg_temp.u('00c003')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: re-publish a superseded version', $q$update public.event_competition_schedule_versions set status = 'published' where id = pg_temp.u('00c003')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: delete a past version', $q$delete from public.event_competition_schedule_versions where id = pg_temp.u('00c003')$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');
select pg_temp.refused('D: insert a version that is already published', $q$insert into public.event_competition_schedule_versions (event_id, version_number, name, status, published_at) values (pg_temp.u('00e001'), 9, 'v9', 'published', now())$q$, 'COMPD_PUBLISHED_ORDER_WRITE_REFUSED');

-- ============================================================================
-- Legitimate work keeps working
-- ============================================================================
select pg_temp.allowed('keep: edit a draft heat (round)', $q$update public.event_competition_heats set round_id = pg_temp.u('006002') where id = pg_temp.u('00d021')$q$);
select pg_temp.allowed('keep: renumber a draft heat', $q$update public.event_competition_heats set heat_number = 22 where id = pg_temp.u('00d021')$q$);
select pg_temp.allowed('keep: delete a draft heat', $q$delete from public.event_competition_heats where id = pg_temp.u('00d021')$q$);
select pg_temp.allowed('keep: edit an unversioned heat', $q$update public.event_competition_heats set heat_number = 32 where id = pg_temp.u('00d031')$q$);
select pg_temp.allowed('keep: rename a published heat (not a placement column)', $q$update public.event_competition_heats set name = 'renamed' where id = pg_temp.u('00d001')$q$);
select pg_temp.allowed('keep: insert a draft version', $q$insert into public.event_competition_schedule_versions (event_id, version_number, name, status) values (pg_temp.u('00e001'), 8, 'v8', 'draft')$q$);
select pg_temp.allowed('keep: rename a published version', $q$update public.event_competition_schedule_versions set name = 'renamed' where id = pg_temp.u('00c001')$q$);
select pg_temp.allowed('keep: publication of a fresh draft through publish_competition_schedule_version', $q$select public.publish_competition_schedule_version(pg_temp.u('00c005'))$q$);
select pg_temp.allowed('keep: a second publication supersedes the first (both through the function)', $q$select public.publish_competition_schedule_version(x.v) from unnest(array[pg_temp.u('00c005'), pg_temp.u('00c007')]) with ordinality x(v, o) order by x.o$q$);
select pg_temp.allowed('keep: create_competition_schedule_version (security invoker)', $q$select public.create_competition_schedule_version(pg_temp.u('00e001'), 'copy')$q$);
select pg_temp.allowed('keep: cancel_competition_round (security definer) still removes a never-run published heat', $q$select public.cancel_competition_round(pg_temp.u('006001'), 'cancelled by the organizer', gen_random_uuid())$q$);
select pg_temp.allowed('keep: set_competition_heat_lock_state (security definer) on a published heat', $q$select public.set_competition_heat_lock_state(pg_temp.u('00d001'), 'locked', 'fixture lock')$q$);
-- owner-role writes (migrations, definer functions, fixtures) are not restricted
update public.event_competition_heats set heat_number = 3 where id = pg_temp.u('00d001');
select pg_temp.chk('keep: the owner role can still write a published heat', (select heat_number = 3 from public.event_competition_heats where id = pg_temp.u('00d001')));
select pg_temp.chk('nothing under test persisted', (select count(*) = 1 from public.event_competition_heats where id = pg_temp.u('00d021') and heat_number = 21 and schedule_version_id = pg_temp.u('00c002'))
  and (select status = 'published' from public.event_competition_schedule_versions where id = pg_temp.u('00c001')));

do $$
declare v_total int; v_failures text;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'COMPETITION D SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION D SQL SUITE FAIL: %', v_failures;
end $$;

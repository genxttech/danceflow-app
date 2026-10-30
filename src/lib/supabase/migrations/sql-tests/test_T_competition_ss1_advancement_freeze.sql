-- Competition SS1 -- advancement_method freeze regression suite.
--
-- Covers 20270118090000_competition_ss1_advancement_freeze.sql on top of 10B. One transaction; the final block ALWAYS raises, so
-- nothing persists:
--   "COMPETITION SS1 ADVANCEMENT FREEZE SQL SUITE PASS (<n> checks)"  or  "... FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;

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

-- An unexpected success is rolled back AND recorded (written after the subtransaction is undone).
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
language sql immutable as $$ select ('00000000-0000-0000-0000-0c0e62' || p_suffix)::uuid $$;
create or replace function pg_temp.n(p_sql text) returns bigint
language plpgsql as $$ declare r bigint; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.s(p_sql text) returns text
language plpgsql as $$ declare r text; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.as_postgres() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;


-- ============================================================================
-- Fixtures (as postgres): one studio, one competition, a program that gets locked and a program that stays draft
-- ============================================================================
insert into auth.users (id, email) values (pg_temp.u('000001'), 't-ss1a-owner@example.test');
insert into public.profiles (id, email, full_name) values (pg_temp.u('000001'), 't-ss1a-owner@example.test', 'Owner');
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'SS1A Studio', 't-ss1a-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required) values
  (pg_temp.u('00e001'), pg_temp.u('00a001'), 'SS1A Comp', 't-ss1a-1', 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, advancement_method, status, rules_profile_key, rules_profile_version) values
  (pg_temp.u('001001'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Locked later', 'showcase', 'relative', 'ordinal_majority', 'none', 'draft', 'studio_simple', 3),
  (pg_temp.u('001002'), pg_temp.u('00e001'), pg_temp.u('00a001'), 'Stays draft', 'showcase', 'relative', 'ordinal_majority', 'none', 'draft', 'studio_simple', 3);

select pg_temp.chk('the guard trigger exists on programs',
  exists (select 1 from pg_trigger where tgname = 'guard_competition_program_advancement_frozen' and tgrelid = 'public.event_competition_programs'::regclass and not tgisinternal));
select pg_temp.chk('the guard function is not callable by any API role',
  not has_function_privilege('authenticated', 'public.guard_competition_program_advancement_frozen()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.guard_competition_program_advancement_frozen()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.guard_competition_program_advancement_frozen()', 'EXECUTE'));

-- Draft, unlocked: allowed (this is what the SS1 configure action does)
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('draft: the studio owner sets promote_callback (SS1 apply path, as the app does it)',
  $q$update public.event_competition_programs set advancement_method = 'promote_callback'
     where id = pg_temp.u('001001') and event_id = pg_temp.u('00e001') and status = 'draft' and profile_locked_at is null$q$);
select pg_temp.as_postgres();
select pg_temp.chk('draft: the value changed', (select advancement_method from public.event_competition_programs where id = pg_temp.u('001001')) = 'promote_callback');
select pg_temp.expect_ok('draft: another value is allowed too', $q$update public.event_competition_programs set advancement_method = 'none' where id = pg_temp.u('001002')$q$);

-- Lock program 1 as publish does
update public.event_competition_programs set advancement_method = 'promote_callback' where id = pg_temp.u('001001');
insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at)
values (pg_temp.u('001001'), pg_temp.u('00e001'), 'studio_simple', 3,
        jsonb_build_object('profile', jsonb_build_object('key', 'studio_simple', 'version', 3)), now());
update public.event_competition_programs
set status = 'configured', profile_locked_at = (select locked_at from public.event_competition_program_locks where program_id = pg_temp.u('001001'))
where id = pg_temp.u('001001');

-- Locked: refused for every role and path
select pg_temp.expect_msg('locked: advancement_method change refused (table owner)', $q$update public.event_competition_programs set advancement_method = 'none' where id = pg_temp.u('001001')$q$, 'COMP_PROGRAM_ADVANCEMENT_FROZEN');
select pg_temp.expect_msg('locked: a null advancement_method is refused', $q$update public.event_competition_programs set advancement_method = null where id = pg_temp.u('001001')$q$, 'COMP_PROGRAM_ADVANCEMENT_FROZEN');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('locked: the studio owner is refused', $q$update public.event_competition_programs set advancement_method = 'retire_callback' where id = pg_temp.u('001001')$q$, 'COMP_PROGRAM_ADVANCEMENT_FROZEN');
select pg_temp.as_postgres();
create or replace function pg_temp.secdef_rewrite() returns void language plpgsql security definer as $$
begin update public.event_competition_programs set advancement_method = 'none' where id = pg_temp.u('001001'); end $$;
select pg_temp.expect_msg('locked: a function writer is refused too (no allowed writer)', $q$select pg_temp.secdef_rewrite()$q$, 'COMP_PROGRAM_ADVANCEMENT_FROZEN');
select pg_temp.chk('locked: nothing changed', (select advancement_method from public.event_competition_programs where id = pg_temp.u('001001')) = 'promote_callback');

-- Locked: unchanged value and other columns still work (narrow guard)
select pg_temp.expect_ok('locked: writing the same value back is a no-op', $q$update public.event_competition_programs set advancement_method = 'promote_callback' where id = pg_temp.u('001001')$q$);
select pg_temp.expect_ok('locked: status and unrelated columns still update (registration/lifecycle writers)', $q$update public.event_competition_programs set status = 'active', name = 'Renamed', updated_at = now() where id = pg_temp.u('001001')$q$);

-- The other program is unaffected
select pg_temp.expect_ok('other draft program: advancement_method still editable', $q$update public.event_competition_programs set advancement_method = 'promote_callback' where id = pg_temp.u('001002')$q$);

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
    raise exception 'COMPETITION SS1 ADVANCEMENT FREEZE SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'COMPETITION SS1 ADVANCEMENT FREEZE SQL SUITE FAIL: %', v_failures;
end $$;

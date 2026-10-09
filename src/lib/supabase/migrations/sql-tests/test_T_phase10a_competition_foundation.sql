-- Phase 10A -- Competition Foundation Reconciliation regression suite.
--
-- Covers 20261107090000_phase10a_competition_foundation_reconcile.sql plus the pre-existing
-- Competition OS foundation it protects (schedule versions, heat planning/apply, templates,
-- setup restart, registration catalog). One transaction, synthetic fixtures only (UUID
-- block 00000000-0000-0000-0000-0a10a0XXXXXX). Tenant behaviour is simulated with
-- `set local role` + request.jwt.claims. Assumes the forward migration has been applied.
-- The final block ALWAYS raises, so the whole transaction aborts and nothing persists;
-- its message is the verdict:
--   "PHASE 10A SQL SUITE PASS (<n> checks)"  or  "PHASE 10A SQL SUITE FAIL: <failures>".

begin;

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0a10a0000001', 't-p10a-owner-a@example.test'),
  ('00000000-0000-0000-0000-0a10a0000002', 't-p10a-admin-a@example.test'),
  ('00000000-0000-0000-0000-0a10a0000003', 't-p10a-front-a@example.test'),
  ('00000000-0000-0000-0000-0a10a0000004', 't-p10a-owner-b@example.test'),
  ('00000000-0000-0000-0000-0a10a0000005', 't-p10a-platform@example.test'),
  ('00000000-0000-0000-0000-0a10a0000006', 't-p10a-org-staff@example.test'),
  ('00000000-0000-0000-0000-0a10a0000007', 't-p10a-nobody@example.test');

insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-0a10a0000001', 't-p10a-owner-a@example.test', 'Owner A'),
  ('00000000-0000-0000-0000-0a10a0000002', 't-p10a-admin-a@example.test', 'Admin A'),
  ('00000000-0000-0000-0000-0a10a0000003', 't-p10a-front-a@example.test', 'Front A'),
  ('00000000-0000-0000-0000-0a10a0000004', 't-p10a-owner-b@example.test', 'Owner B'),
  ('00000000-0000-0000-0000-0a10a0000006', 't-p10a-org-staff@example.test', 'Org Staff'),
  ('00000000-0000-0000-0000-0a10a0000007', 't-p10a-nobody@example.test', 'Nobody');
insert into public.profiles (id, email, full_name, platform_role) values
  ('00000000-0000-0000-0000-0a10a0000005', 't-p10a-platform@example.test', 'Platform', 'platform_admin');

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0a10a000a001', 'P10A Studio A', 't-p10a-studio-a'),
  ('00000000-0000-0000-0000-0a10a000b001', 'P10A Studio B', 't-p10a-studio-b');

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0a10a0000001', '00000000-0000-0000-0000-0a10a000a001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0a10a0000002', '00000000-0000-0000-0000-0a10a000a001', 'studio_admin', true),
  ('00000000-0000-0000-0000-0a10a0000003', '00000000-0000-0000-0000-0a10a000a001', 'front_desk', true),
  ('00000000-0000-0000-0000-0a10a0000004', '00000000-0000-0000-0000-0a10a000b001', 'studio_owner', true);

insert into public.organizers (id, name, slug) values
  ('00000000-0000-0000-0000-0a10a000d001', 'P10A Organizer', 't-p10a-organizer');
insert into public.organizer_users (organizer_id, user_id, role, active) values
  ('00000000-0000-0000-0000-0a10a000d001', '00000000-0000-0000-0000-0a10a0000006', 'organizer_staff', true);

-- E1 published/public/registration (created by the front-desk user), E2 draft, E3 other
-- studio published, E4 published but private, E5 published (template + restart).
insert into public.events (id, studio_id, organizer_id, created_by, name, slug, event_type, start_date, end_date,
                           status, visibility, registration_required) values
  ('00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a000a001', '00000000-0000-0000-0000-0a10a000d001',
   '00000000-0000-0000-0000-0a10a0000003', 'P10A Comp One', 't-p10a-e1', 'competition', current_date + 30, current_date + 30,
   'published', 'public', true),
  ('00000000-0000-0000-0000-0a10a000e002', '00000000-0000-0000-0000-0a10a000a001', null,
   '00000000-0000-0000-0000-0a10a0000001', 'P10A Draft', 't-p10a-e2', 'competition', current_date + 30, current_date + 30,
   'draft', 'public', true),
  ('00000000-0000-0000-0000-0a10a000e003', '00000000-0000-0000-0000-0a10a000b001', null,
   '00000000-0000-0000-0000-0a10a0000004', 'P10A Other Studio', 't-p10a-e3', 'competition', current_date + 30, current_date + 30,
   'published', 'public', true),
  ('00000000-0000-0000-0000-0a10a000e004', '00000000-0000-0000-0000-0a10a000a001', null,
   '00000000-0000-0000-0000-0a10a0000001', 'P10A Private', 't-p10a-e4', 'competition', current_date + 30, current_date + 30,
   'published', 'private', true),
  ('00000000-0000-0000-0000-0a10a000e005', '00000000-0000-0000-0000-0a10a000a001', null,
   '00000000-0000-0000-0000-0a10a0000001', 'P10A Template', 't-p10a-e5', 'showcase', current_date + 30, current_date + 30,
   'published', 'public', true);

-- One configured program / open contest / open division / dance / offering / final round per E1..E4.
do $$
declare
  n int;
  e uuid;
  s uuid;
begin
  for n in 1..4 loop
    e := ('00000000-0000-0000-0000-0a10a000e00' || n)::uuid;
    select studio_id into s from public.events where id = e;
    insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
    values (('00000000-0000-0000-0000-0a10a000100' || n)::uuid, e, s, 'Program ' || n, 'ballroom', 'relative', 'skating', 'configured');
    insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
    values (('00000000-0000-0000-0000-0a10a000200' || n)::uuid, e, ('00000000-0000-0000-0000-0a10a000100' || n)::uuid,
            'Contest ' || n, 'single_dance', 'pro_am', 'open');
    update public.event_competition_contest_registration_rules set registration_open = true
    where contest_id = ('00000000-0000-0000-0000-0a10a000200' || n)::uuid;
    insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
    values (('00000000-0000-0000-0000-0a10a000300' || n)::uuid, e, ('00000000-0000-0000-0000-0a10a000100' || n)::uuid,
            ('00000000-0000-0000-0000-0a10a000200' || n)::uuid, 'Division ' || n, 'open');
    insert into public.event_competition_dances (id, event_id, program_id, dance_key, name)
    values (('00000000-0000-0000-0000-0a10a000400' || n)::uuid, e, ('00000000-0000-0000-0000-0a10a000100' || n)::uuid,
            'smooth_waltz', 'Waltz');
    insert into public.event_competition_division_dances (id, event_id, program_id, division_id, dance_id)
    values (('00000000-0000-0000-0000-0a10a000500' || n)::uuid, e, ('00000000-0000-0000-0000-0a10a000100' || n)::uuid,
            ('00000000-0000-0000-0000-0a10a000300' || n)::uuid, ('00000000-0000-0000-0000-0a10a000400' || n)::uuid);
    insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type)
    values (('00000000-0000-0000-0000-0a10a000600' || n)::uuid, e, ('00000000-0000-0000-0000-0a10a000100' || n)::uuid,
            ('00000000-0000-0000-0000-0a10a000300' || n)::uuid, 'Final', 'final');
  end loop;
end $$;

-- E1 also has an open contest whose registration rule is CLOSED, with an open division.
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
values ('00000000-0000-0000-0000-0a10a0002011', '00000000-0000-0000-0000-0a10a000e001',
        '00000000-0000-0000-0000-0a10a0001001', 'Closed Contest', 'single_dance', 'pro_am', 'open');
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status)
values ('00000000-0000-0000-0000-0a10a0003011', '00000000-0000-0000-0000-0a10a000e001',
        '00000000-0000-0000-0000-0a10a0001001', '00000000-0000-0000-0000-0a10a0002011', 'Closed Division', 'open');

-- Entries and an unscheduled heat in E1.
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status) values
  ('00000000-0000-0000-0000-0a10a0007001', '00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a0001001',
   '00000000-0000-0000-0000-0a10a0003001', 'Generation Entry', 'confirmed', 'eligible'),
  ('00000000-0000-0000-0000-0a10a0007002', '00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a0001001',
   '00000000-0000-0000-0000-0a10a0003001', 'History Entry', 'confirmed', 'eligible'),
  ('00000000-0000-0000-0000-0a10a0007003', '00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a0001001',
   '00000000-0000-0000-0000-0a10a0003001', 'Delete Entry', 'pending', 'unverified');
insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, name) values
  ('00000000-0000-0000-0000-0a10a0008001', '00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a0003001',
   '00000000-0000-0000-0000-0a10a0006001', 99, 'Lock Heat'),
  ('00000000-0000-0000-0000-0a10a0008002', '00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a0003001',
   '00000000-0000-0000-0000-0a10a0006001', 98, 'Second Lock Heat'),
  ('00000000-0000-0000-0000-0a10a0008003', '00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a0003001',
   '00000000-0000-0000-0000-0a10a0006001', 97, 'Open Heat');

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_ids (k text primary key, v uuid) on commit drop;
grant all on t_ids to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.expect_fail(p_name text, p_sql text, p_state text default null) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results values (p_name, false, 'statement unexpectedly succeeded');
  exception when others then
    insert into t_results values (p_name, p_state is null or sqlstate = p_state, sqlstate || ' ' || sqlerrm);
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

-- The public registration catalog exactly as src/lib/competition/registrationServer.ts filters it.
create or replace function pg_temp.catalog(p_event uuid) returns jsonb
language sql as $$
  with programs as (
    select id from public.event_competition_programs where event_id = p_event and status in ('configured', 'active')
  ), rules as (
    select id, contest_id from public.event_competition_contest_registration_rules
    where event_id = p_event and registration_open and program_id in (select id from programs)
  ), contests as (
    select id from public.event_competition_contests
    where event_id = p_event and status = 'open' and program_id in (select id from programs)
      and id in (select contest_id from rules)
  ), divisions as (
    select id from public.event_competition_divisions
    where event_id = p_event and status = 'open' and contest_id in (select id from contests)
  ), offerings as (
    select dd.id, d.dance_key from public.event_competition_division_dances dd
    left join public.event_competition_dances d on d.id = dd.dance_id
    where dd.event_id = p_event and dd.active and dd.division_id in (select id from divisions)
  )
  select jsonb_build_object(
    'programs', (select coalesce(jsonb_agg(id order by id), '[]') from programs),
    'rules', (select coalesce(jsonb_agg(id order by id), '[]') from rules),
    'contests', (select coalesce(jsonb_agg(id order by id), '[]') from contests),
    'divisions', (select coalesce(jsonb_agg(id order by id), '[]') from divisions),
    'offerings', (select coalesce(jsonb_agg(id order by id), '[]') from offerings),
    'offering_dances', (select coalesce(jsonb_agg(dance_key order by id), '[]') from offerings))
$$;

grant execute on function pg_temp.chk(text, boolean, text), pg_temp.expect_fail(text, text, text),
  pg_temp.expect_ok(text, text), pg_temp.catalog(uuid) to authenticated, anon, service_role;

-- ============================================================================
-- B1. Public registration catalog RLS
-- ============================================================================
set local role service_role;
insert into t_ids select 'catalog_service', null;
create temp table t_catalog_service as select pg_temp.catalog('00000000-0000-0000-0000-0a10a000e001') as c;
grant select on t_catalog_service to anon, authenticated;
reset role;

set local role anon;
select pg_temp.chk('anon sees only published public/unlisted registration contests',
  (select coalesce(array_agg(id order by id), '{}') from public.event_competition_contests where id::text like '00000000-0000-0000-0000-0a10a0002%')
    = array['00000000-0000-0000-0000-0a10a0002001', '00000000-0000-0000-0000-0a10a0002003']::uuid[],
  (select string_agg(id::text, ',') from public.event_competition_contests where id::text like '00000000-0000-0000-0000-0a10a0002%'));
select pg_temp.chk('anon cannot see draft/private/closed-rule divisions (no cross-event leak)',
  (select coalesce(array_agg(id order by id), '{}') from public.event_competition_divisions where id::text like '00000000-0000-0000-0000-0a10a0003%')
    = array['00000000-0000-0000-0000-0a10a0003001', '00000000-0000-0000-0000-0a10a0003003']::uuid[],
  (select string_agg(id::text, ',') from public.event_competition_divisions where id::text like '00000000-0000-0000-0000-0a10a0003%'));
select pg_temp.chk('anon sees dances of registrable events only',
  (select coalesce(array_agg(id order by id), '{}') from public.event_competition_dances where id::text like '00000000-0000-0000-0000-0a10a0004%')
    = array['00000000-0000-0000-0000-0a10a0004001', '00000000-0000-0000-0000-0a10a0004003']::uuid[]);
select pg_temp.chk('anon sees offerings of registrable events only',
  (select coalesce(array_agg(id order by id), '{}') from public.event_competition_division_dances where id::text like '00000000-0000-0000-0000-0a10a0005%')
    = array['00000000-0000-0000-0000-0a10a0005001', '00000000-0000-0000-0000-0a10a0005003']::uuid[]);
select pg_temp.chk('anon cannot read draft event (E2) catalog at all',
  pg_temp.catalog('00000000-0000-0000-0000-0a10a000e002') = '{"rules": [], "contests": [], "programs": [], "divisions": [], "offerings": [], "offering_dances": []}'::jsonb,
  pg_temp.catalog('00000000-0000-0000-0000-0a10a000e002')::text);
select pg_temp.chk('anon cannot read private event (E4) catalog at all',
  (pg_temp.catalog('00000000-0000-0000-0000-0a10a000e004')->'divisions') = '[]'::jsonb);
select pg_temp.chk('anon catalog for E1 equals the service-role checkout catalog',
  pg_temp.catalog('00000000-0000-0000-0000-0a10a000e001') = (select c from t_catalog_service),
  pg_temp.catalog('00000000-0000-0000-0000-0a10a000e001')::text || ' vs ' || (select c::text from t_catalog_service));
select pg_temp.chk('service catalog for E1 is non-trivial (1 contest, 1 division, 1 offering)',
  (select jsonb_array_length(c->'contests') = 1 and jsonb_array_length(c->'divisions') = 1
          and jsonb_array_length(c->'offerings') = 1 and c->'offering_dances' = '["smooth_waltz"]'::jsonb
   from t_catalog_service),
  (select c::text from t_catalog_service));
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0a10a0000004","role":"authenticated"}', true);
select pg_temp.chk('other-studio owner sees the same public E1 catalog as checkout',
  pg_temp.catalog('00000000-0000-0000-0000-0a10a000e001') = (select c from t_catalog_service));
select pg_temp.chk('other-studio owner cannot read E2 draft divisions',
  not exists (select 1 from public.event_competition_divisions where id = '00000000-0000-0000-0000-0a10a0003002'));
reset role;

-- ============================================================================
-- B4/B5. Authority helper and grant posture
-- ============================================================================
select pg_temp.chk('anon cannot execute can_manage_event_competition',
  not has_function_privilege('anon', 'public.can_manage_event_competition(uuid)', 'EXECUTE'));
select pg_temp.chk('authenticated can execute can_manage_event_competition',
  has_function_privilege('authenticated', 'public.can_manage_event_competition(uuid)', 'EXECUTE'));
select pg_temp.chk('anon cannot execute apply_competition_configuration_template',
  not has_function_privilege('anon', 'public.apply_competition_configuration_template(uuid, text)', 'EXECUTE'));
select pg_temp.chk('anon cannot execute restart_event_competition_setup',
  not has_function_privilege('anon', 'public.restart_event_competition_setup(uuid, text)', 'EXECUTE'));
select pg_temp.chk('authenticated can execute template + restart',
  has_function_privilege('authenticated', 'public.apply_competition_configuration_template(uuid, text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.restart_event_competition_setup(uuid, text)', 'EXECUTE'));
select pg_temp.chk('default_competition_registration_rule not executable by anon/authenticated',
  not has_function_privilege('anon', 'public.default_competition_registration_rule(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.default_competition_registration_rule(uuid)', 'EXECUTE'));
select pg_temp.chk('restart_event_competition_setup pins search_path incl. pg_temp',
  (select proconfig from pg_proc where oid = 'public.restart_event_competition_setup(uuid, text)'::regprocedure)
    = array['search_path=public, pg_temp']);
select pg_temp.chk('anon cannot execute set_competition_heat_lock_state',
  not has_function_privilege('anon', 'public.set_competition_heat_lock_state(uuid, text, text)', 'EXECUTE'));
select pg_temp.chk('no competition function still references the heat override GUC',
  not exists (select 1 from pg_proc where prosrc ilike '%competition_heat_override%'));

set local role anon;
select pg_temp.expect_fail('anon cannot call default_competition_registration_rule',
  $q$select public.default_competition_registration_rule('00000000-0000-0000-0000-0a10a0002011')$q$, '42501');
select pg_temp.expect_fail('anon cannot call can_manage_event_competition',
  $q$select public.can_manage_event_competition('00000000-0000-0000-0000-0a10a000e001')$q$, '42501');
reset role;

do $$
declare
  r record;
  v boolean;
begin
  for r in select * from (values
    ('00000000-0000-0000-0000-0a10a0000001', true,  'studio owner'),
    ('00000000-0000-0000-0000-0a10a0000002', true,  'studio admin'),
    ('00000000-0000-0000-0000-0a10a0000003', false, 'front desk who created the event (creator-only authority removed)'),
    ('00000000-0000-0000-0000-0a10a0000004', false, 'other-studio owner'),
    ('00000000-0000-0000-0000-0a10a0000005', true,  'platform admin'),
    ('00000000-0000-0000-0000-0a10a0000006', true,  'organizer staff (unchanged; Phase 10E/12 carry-forward)'),
    ('00000000-0000-0000-0000-0a10a0000007', false, 'authenticated user with no role')
  ) as t(uid, expected, label) loop
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', r.uid, 'role', 'authenticated')::text, true);
    v := public.can_manage_event_competition('00000000-0000-0000-0000-0a10a000e001');
    execute 'reset role';
    perform pg_temp.chk('can_manage E1: ' || r.label, v = r.expected, 'got ' || v);
  end loop;
end $$;

-- Revoked EXECUTE on definer trigger functions must not stop their triggers firing.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0a10a0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('manager creates a contest (default-rule trigger still fires)',
  $q$insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status)
     values ('00000000-0000-0000-0000-0a10a0002021', '00000000-0000-0000-0000-0a10a000e001',
             '00000000-0000-0000-0000-0a10a0001001', 'Manager Contest', 'single_dance', 'solo', 'draft')$q$);
select pg_temp.chk('default registration rule created for the manager''s contest',
  exists (select 1 from public.event_competition_contest_registration_rules
          where contest_id = '00000000-0000-0000-0000-0a10a0002021' and not registration_open));
reset role;

-- ============================================================================
-- B2. Append-only entry history
-- ============================================================================
select pg_temp.chk('history: no write privilege for anon/authenticated/service_role',
  not has_table_privilege('anon', 'public.event_competition_entry_changes', 'INSERT')
  and not has_table_privilege('authenticated', 'public.event_competition_entry_changes', 'INSERT')
  and not has_table_privilege('service_role', 'public.event_competition_entry_changes', 'INSERT')
  and not has_table_privilege('authenticated', 'public.event_competition_entry_changes', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.event_competition_entry_changes', 'DELETE')
  and not has_table_privilege('authenticated', 'public.event_competition_entry_changes', 'TRUNCATE'));
select pg_temp.chk('history: no write policy remains',
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'event_competition_entry_changes' and cmd <> 'SELECT'));

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0a10a0000001","role":"authenticated"}', true);
select pg_temp.expect_fail('manager cannot forge a history row directly',
  $q$insert into public.event_competition_entry_changes (event_id, entry_id, change_type, reason)
     values ('00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a0007002', 'scratch', 'forged')$q$, '42501');
select pg_temp.expect_ok('manager scratches an entry through the lifecycle RPC',
  $q$select public.change_competition_entry_lifecycle('00000000-0000-0000-0000-0a10a0007002', 'scratched', 'Injury', 'retain')$q$);
select pg_temp.chk('lifecycle RPC wrote attributed scratch history',
  (select count(*) from public.event_competition_entry_changes
   where entry_id = '00000000-0000-0000-0000-0a10a0007002' and change_type = 'scratch' and reason = 'Injury'
     and fee_handling = 'retain' and performed_by = '00000000-0000-0000-0000-0a10a0000001') = 1);
-- Each PostgREST request is its own transaction; clear the RPC's transaction-local labels.
select set_config('app.competition_entry_change_type', '', true),
       set_config('app.competition_entry_change_reason', '', true),
       set_config('app.competition_entry_fee_handling', '', true);
select pg_temp.expect_ok('manager direct entry update still audits',
  $q$update public.event_competition_entries set eligibility_status = 'needs_review' where id = '00000000-0000-0000-0000-0a10a0007003'$q$);
select pg_temp.chk('direct entry update produced eligibility history',
  (select count(*) from public.event_competition_entry_changes
   where entry_id = '00000000-0000-0000-0000-0a10a0007003' and change_type = 'eligibility_change') = 1);
select pg_temp.expect_ok('manager can delete an erroneous entry (deployed FK defect fixed)',
  $q$delete from public.event_competition_entries where id = '00000000-0000-0000-0000-0a10a0007003'$q$);
select pg_temp.chk('deletion history keeps the deleted entry id',
  (select count(*) from public.event_competition_entry_changes
   where entry_id = '00000000-0000-0000-0000-0a10a0007003' and change_type = 'delete_error') = 1);
select pg_temp.expect_fail('manager cannot update history',
  $q$update public.event_competition_entry_changes set reason = 'edited' where entry_id = '00000000-0000-0000-0000-0a10a0007002'$q$, '42501');
select pg_temp.expect_fail('manager cannot delete history',
  $q$delete from public.event_competition_entry_changes where entry_id = '00000000-0000-0000-0000-0a10a0007002'$q$, '42501');
reset role;

set local role service_role;
select pg_temp.expect_fail('service_role cannot forge a history row',
  $q$insert into public.event_competition_entry_changes (event_id, change_type) values ('00000000-0000-0000-0000-0a10a000e001', 'edit')$q$, '42501');
reset role;

select pg_temp.expect_fail('postgres cannot update history (trigger)',
  $q$update public.event_competition_entry_changes set reason = 'edited' where entry_id = '00000000-0000-0000-0000-0a10a0007002'$q$, '42501');
select pg_temp.expect_fail('postgres cannot delete history (trigger)',
  $q$delete from public.event_competition_entry_changes where entry_id = '00000000-0000-0000-0000-0a10a0007002'$q$, '42501');
select pg_temp.expect_fail('postgres cannot truncate history (trigger)',
  $q$truncate public.event_competition_entry_changes$q$, '42501');
select pg_temp.chk('history FKs that rewrote evidence are gone (event cascade kept)',
  (select array_agg(conname order by conname) from pg_constraint
   where conrelid = 'public.event_competition_entry_changes'::regclass and contype = 'f')
    = array['event_competition_entry_changes_event_id_fkey']::name[]);

-- ============================================================================
-- B3. Heat lock: role-checked, audited override
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0a10a0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('manager locks a heat',
  $q$select public.set_competition_heat_lock_state('00000000-0000-0000-0000-0a10a0008001', 'locked')$q$);
select pg_temp.chk('lock recorded with actor',
  (select count(*) from public.event_competition_heat_lock_events
   where heat_id = '00000000-0000-0000-0000-0a10a0008001' and from_state = 'open' and to_state = 'locked'
     and performed_by = '00000000-0000-0000-0000-0a10a0000001') = 1);
select pg_temp.expect_ok('manager locks a second heat',
  $q$select public.set_competition_heat_lock_state('00000000-0000-0000-0000-0a10a0008002', 'locked')$q$);
select pg_temp.expect_fail('manager cannot lock an open heat directly (no ledger row)',
  $q$update public.event_competition_heats set lock_state = 'locked' where id = '00000000-0000-0000-0000-0a10a0008003'$q$);
select pg_temp.expect_fail('manager cannot certify an open heat directly',
  $q$update public.event_competition_heats set lock_state = 'certified', certified_at = now() where id = '00000000-0000-0000-0000-0a10a0008003'$q$);
select pg_temp.expect_fail('manager cannot stamp certification fields on an open heat',
  $q$update public.event_competition_heats set certified_by = '00000000-0000-0000-0000-0a10a0000001' where id = '00000000-0000-0000-0000-0a10a0008003'$q$);
select pg_temp.expect_fail('manager cannot insert a pre-certified heat',
  $q$insert into public.event_competition_heats (event_id, division_id, round_id, heat_number, lock_state, certified_at)
     values ('00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a0003001',
             '00000000-0000-0000-0000-0a10a0006001', 96, 'certified', now())$q$);
select pg_temp.expect_ok('manager can still edit an open heat',
  $q$update public.event_competition_heats set name = 'Open Heat (renamed)' where id = '00000000-0000-0000-0000-0a10a0008003'$q$);
select pg_temp.expect_fail('manager cannot edit a locked heat directly',
  $q$update public.event_competition_heats set name = 'edited' where id = '00000000-0000-0000-0000-0a10a0008001'$q$);
select pg_temp.expect_fail('manager cannot bypass the lock with the old session GUC',
  $q$do $b$ begin
       perform set_config('app.competition_heat_override', 'on', true);
       update public.event_competition_heats set name = 'edited' where id = '00000000-0000-0000-0000-0a10a0008001';
     end $b$$q$);
select pg_temp.expect_fail('manager cannot unlock by writing lock_state directly',
  $q$update public.event_competition_heats set lock_state = 'open' where id = '00000000-0000-0000-0000-0a10a0008001'$q$);
select pg_temp.expect_fail('manager cannot add entries to a locked heat (even with the GUC)',
  $q$do $b$ begin
       perform set_config('app.competition_heat_override', 'on', true);
       insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id)
       values ('00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a0003001',
               '00000000-0000-0000-0000-0a10a0008001', '00000000-0000-0000-0000-0a10a0007001');
     end $b$$q$);
select pg_temp.expect_fail('manager cannot forge a lock event',
  $q$insert into public.event_competition_heat_lock_events (event_id, heat_id, from_state, to_state)
     values ('00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a0008001', 'locked', 'open')$q$, '42501');
select pg_temp.expect_fail('reopening a locked heat requires a reason',
  $q$select public.set_competition_heat_lock_state('00000000-0000-0000-0000-0a10a0008001', 'open')$q$);
reset role;

do $$
declare r record;
begin
  for r in select * from (values
    ('00000000-0000-0000-0000-0a10a0000003', 'front desk event creator'),
    ('00000000-0000-0000-0000-0a10a0000004', 'other-studio owner'),
    ('00000000-0000-0000-0000-0a10a0000007', 'authenticated user with no role')
  ) as t(uid, label) loop
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', r.uid, 'role', 'authenticated')::text, true);
    perform pg_temp.expect_fail('unauthorized override refused: ' || r.label,
      $q$select public.set_competition_heat_lock_state('00000000-0000-0000-0000-0a10a0008001', 'open', 'hijack')$q$);
    execute 'reset role';
  end loop;
end $$;

set local role anon;
select pg_temp.expect_fail('anon cannot call the lock RPC',
  $q$select public.set_competition_heat_lock_state('00000000-0000-0000-0000-0a10a0008001', 'open', 'x')$q$, '42501');
reset role;
set local role service_role;
select pg_temp.expect_fail('service_role cannot forge a lock event',
  $q$insert into public.event_competition_heat_lock_events (event_id, heat_id, from_state, to_state)
     values ('00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a0008001', 'locked', 'open')$q$, '42501');
select pg_temp.expect_fail('service_role (no actor) cannot use the lock RPC',
  $q$select public.set_competition_heat_lock_state('00000000-0000-0000-0000-0a10a0008001', 'open', 'x')$q$);
reset role;

select pg_temp.chk('heat still locked after refused attempts',
  (select lock_state = 'locked' and name = 'Lock Heat' from public.event_competition_heats where id = '00000000-0000-0000-0000-0a10a0008001'));

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0a10a0000002","role":"authenticated"}', true);
select pg_temp.expect_ok('studio admin reopens with a reason',
  $q$select public.set_competition_heat_lock_state('00000000-0000-0000-0000-0a10a0008001', 'open', 'Wrong couple placed')$q$);
select pg_temp.chk('reopen recorded with reason and actor',
  (select count(*) from public.event_competition_heat_lock_events
   where heat_id = '00000000-0000-0000-0000-0a10a0008001' and from_state = 'locked' and to_state = 'open'
     and reason = 'Wrong couple placed' and performed_by = '00000000-0000-0000-0000-0a10a0000002') = 1);
select pg_temp.expect_fail('a reopen authorization cannot be reused for another heat',
  $q$update public.event_competition_heats set lock_state = 'open', locked_at = null, locked_by = null where id = '00000000-0000-0000-0000-0a10a0008002'$q$);
select pg_temp.expect_ok('open heat is editable again',
  $q$update public.event_competition_heats set name = 'Lock Heat' where id = '00000000-0000-0000-0000-0a10a0008001'$q$);
select pg_temp.expect_ok('studio admin certifies the heat',
  $q$select public.set_competition_heat_lock_state('00000000-0000-0000-0000-0a10a0008001', 'certified')$q$);
select pg_temp.expect_fail('certified heat cannot be reopened',
  $q$select public.set_competition_heat_lock_state('00000000-0000-0000-0000-0a10a0008001', 'open', 'please')$q$);
select pg_temp.expect_fail('certified heat cannot be deleted',
  $q$delete from public.event_competition_heats where id = '00000000-0000-0000-0000-0a10a0008001'$q$);
select pg_temp.expect_fail('manager cannot update lock events',
  $q$update public.event_competition_heat_lock_events set reason = 'x' where heat_id = '00000000-0000-0000-0000-0a10a0008001'$q$, '42501');
select pg_temp.chk('managers can read lock history',
  (select count(*) from public.event_competition_heat_lock_events where heat_id = '00000000-0000-0000-0000-0a10a0008001') = 3);
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0a10a0000004","role":"authenticated"}', true);
select pg_temp.chk('other-studio owner cannot read lock history',
  not exists (select 1 from public.event_competition_heat_lock_events where heat_id = '00000000-0000-0000-0000-0a10a0008001'));
reset role;

select pg_temp.expect_fail('postgres cannot delete lock events (trigger)',
  $q$delete from public.event_competition_heat_lock_events where heat_id = '00000000-0000-0000-0000-0a10a0008001'$q$, '42501');
select pg_temp.expect_fail('postgres cannot truncate lock events (trigger)',
  $q$truncate public.event_competition_heat_lock_events$q$, '42501');

-- ============================================================================
-- Schedule versions (captured objects + B6) and generation -> proposal -> apply
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0a10a0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('manager creates schedule version v1',
  $q$insert into t_ids values ('v1', public.create_competition_schedule_version('00000000-0000-0000-0000-0a10a000e001', 'v1', null))$q$);
select pg_temp.expect_ok('manager adds a schedule session (B6 fix)',
  $q$insert into public.event_competition_schedule_sessions (id, event_id, schedule_version_id, name, session_date, starts_at, ends_at)
     select '00000000-0000-0000-0000-0a10a0009001', '00000000-0000-0000-0000-0a10a000e001', v, 'Day 1',
            current_date + 30, (current_date + 30) + time '09:00', (current_date + 30) + time '17:00'
     from t_ids where k = 'v1'$q$);
select pg_temp.expect_ok('manager adds a schedule block',
  $q$insert into public.event_competition_schedule_blocks (id, event_id, schedule_version_id, session_id, name, block_type, starts_at, ends_at)
     select '00000000-0000-0000-0000-0a10a0009002', '00000000-0000-0000-0000-0a10a000e001', v,
            '00000000-0000-0000-0000-0a10a0009001', 'Morning', 'competition',
            (current_date + 30) + time '10:00', (current_date + 30) + time '12:00'
     from t_ids where k = 'v1'$q$);
select pg_temp.expect_ok('manager assigns a contest to the block (B6 fix)',
  $q$insert into public.event_competition_schedule_block_contests (event_id, schedule_version_id, block_id, contest_id)
     select '00000000-0000-0000-0000-0a10a000e001', v, '00000000-0000-0000-0000-0a10a0009002', '00000000-0000-0000-0000-0a10a0002001'
     from t_ids where k = 'v1'$q$);
select pg_temp.expect_fail('block outside its session is refused',
  $q$insert into public.event_competition_schedule_blocks (event_id, schedule_version_id, session_id, name, block_type, starts_at, ends_at)
     select '00000000-0000-0000-0000-0a10a000e001', v, '00000000-0000-0000-0000-0a10a0009001', 'Late', 'competition',
            (current_date + 30) + time '16:00', (current_date + 30) + time '18:00'
     from t_ids where k = 'v1'$q$);
select pg_temp.expect_ok('manager copies v1 into v2',
  $q$insert into t_ids select 'v2', public.create_competition_schedule_version('00000000-0000-0000-0000-0a10a000e001', 'v2', v) from t_ids where k = 'v1'$q$);
select pg_temp.chk('v2 copied session, block and contest assignment',
  (select count(*) from public.event_competition_schedule_sessions where schedule_version_id = (select v from t_ids where k = 'v2')) = 1
  and (select count(*) from public.event_competition_schedule_blocks where schedule_version_id = (select v from t_ids where k = 'v2')) = 1
  and (select count(*) from public.event_competition_schedule_block_contests where schedule_version_id = (select v from t_ids where k = 'v2')) = 1
  and (select version_number from public.event_competition_schedule_versions where id = (select v from t_ids where k = 'v2')) = 2);

select pg_temp.expect_ok('manager creates a heat plan run',
  $q$insert into t_ids select 'run', public.create_competition_heat_plan_run('00000000-0000-0000-0000-0a10a000e001', v, 'p10a-test', 'seed-1', '{"source":"p10a"}'::jsonb) from t_ids where k = 'v1'$q$);
select pg_temp.expect_ok('manager saves the heat plan',
  $q$select public.save_competition_heat_plan(
       (select v from t_ids where k = 'run'),
       jsonb_build_array(jsonb_build_object(
         'action_type', 'create', 'entity_type', 'heat', 'sort_order', 1,
         'proposed_state', jsonb_build_object(
           'division_id', '00000000-0000-0000-0000-0a10a0003001', 'round_id', '00000000-0000-0000-0000-0a10a0006001',
           'contest_id', '00000000-0000-0000-0000-0a10a0002001', 'schedule_block_id', '00000000-0000-0000-0000-0a10a0009002',
           'floor_id', '', 'heat_number', 1, 'name', 'Heat 1',
           'scheduled_at', ((current_date + 30) + time '10:00')::timestamptz,
           'estimated_ends_at', ((current_date + 30) + time '10:02')::timestamptz,
           'duration_seconds', 120, 'schedule_sequence', 1, 'expected_entry_count', 1,
           'entry_ids', jsonb_build_array('00000000-0000-0000-0000-0a10a0007001')))),
       '[]'::jsonb, '{"heats":1}'::jsonb)$q$);
select pg_temp.expect_ok('manager reviews the heat plan',
  $q$select public.review_competition_heat_plan((select v from t_ids where k = 'run'), 'reviewed')$q$);
select pg_temp.expect_ok('manager applies the heat plan',
  $q$insert into t_ids select 'applied', case when public.apply_competition_heat_plan((select v from t_ids where k = 'run')) = 1
       then '00000000-0000-0000-0000-000000000001'::uuid end$q$);
select pg_temp.chk('apply created one scheduled heat with its entry',
  (select count(*) from public.event_competition_heats h
   join public.event_competition_heat_entries he on he.heat_id = h.id
   where h.generation_run_id = (select v from t_ids where k = 'run') and he.entry_id = '00000000-0000-0000-0000-0a10a0007001') = 1
  and (select v from t_ids where k = 'applied') is not null);
select pg_temp.expect_ok('manager publishes v1',
  $q$select public.publish_competition_schedule_version((select v from t_ids where k = 'v1'))$q$);
select pg_temp.expect_fail('published schedule sessions are no longer editable',
  $q$update public.event_competition_schedule_sessions set name = 'edited' where id = '00000000-0000-0000-0000-0a10a0009001'$q$);
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0a10a0000004","role":"authenticated"}', true);
select pg_temp.expect_fail('other-studio owner cannot create a schedule version for E1',
  $q$select public.create_competition_schedule_version('00000000-0000-0000-0000-0a10a000e001', 'x', null)$q$);
select pg_temp.chk('other-studio owner cannot see E1 schedule versions',
  not exists (select 1 from public.event_competition_schedule_versions where event_id = '00000000-0000-0000-0000-0a10a000e001'));
reset role;

-- ============================================================================
-- Configuration template + setup restart (with a draft schedule session)
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0a10a0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('manager applies the ballroom starter template',
  $q$select public.apply_competition_configuration_template('00000000-0000-0000-0000-0a10a000e005', 'ballroom_starter')$q$);
select pg_temp.chk('template created program, contests and divisions',
  (select count(*) from public.event_competition_programs where event_id = '00000000-0000-0000-0000-0a10a000e005') >= 1
  and (select count(*) from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0a10a000e005') >= 1
  and (select count(*) from public.event_competition_contest_registration_rules where event_id = '00000000-0000-0000-0000-0a10a000e005')
      = (select count(*) from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0a10a000e005'));
select pg_temp.expect_ok('manager drafts a schedule for E5',
  $q$insert into public.event_competition_schedule_sessions (event_id, schedule_version_id, name, session_date, starts_at, ends_at)
     values ('00000000-0000-0000-0000-0a10a000e005',
             public.create_competition_schedule_version('00000000-0000-0000-0000-0a10a000e005', 'draft', null),
             'Day', current_date + 30, (current_date + 30) + time '09:00', (current_date + 30) + time '12:00')$q$);
select pg_temp.expect_fail('restart requires the confirmation text',
  $q$select public.restart_event_competition_setup('00000000-0000-0000-0000-0a10a000e005', 'restart')$q$);
select pg_temp.expect_ok('manager restarts setup (cascades draft schedule sessions)',
  $q$select public.restart_event_competition_setup('00000000-0000-0000-0000-0a10a000e005', 'RESTART COMPETITION')$q$);
select pg_temp.chk('restart cleared programs and schedule versions',
  not exists (select 1 from public.event_competition_programs where event_id = '00000000-0000-0000-0000-0a10a000e005')
  and not exists (select 1 from public.event_competition_schedule_versions where event_id = '00000000-0000-0000-0000-0a10a000e005'));
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0a10a0000003","role":"authenticated"}', true);
select pg_temp.expect_fail('front desk event creator cannot apply a template',
  $q$select public.apply_competition_configuration_template('00000000-0000-0000-0000-0a10a000e001', 'ballroom_starter')$q$);
select pg_temp.chk('front desk event creator cannot read E1 management rows',
  not exists (select 1 from public.event_competition_entries where event_id = '00000000-0000-0000-0000-0a10a000e001'));
reset role;

-- ============================================================================
-- Canonical registration -> entry sync (deployed body; the older same-day body scratched)
-- ============================================================================
insert into public.event_registrations (id, event_id, studio_id, attendee_first_name, attendee_last_name, attendee_email,
                                        status, payment_status)
values ('00000000-0000-0000-0000-0a10a000f001', '00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a000a001',
        'Sync', 'Dancer', 't-p10a-sync@example.test', 'confirmed', 'paid');
insert into public.event_competition_entries (id, event_id, program_id, division_id, registration_id, display_name, status, eligibility_status)
values ('00000000-0000-0000-0000-0a10a0007004', '00000000-0000-0000-0000-0a10a000e001', '00000000-0000-0000-0000-0a10a0001001',
        '00000000-0000-0000-0000-0a10a0003001', '00000000-0000-0000-0000-0a10a000f001', 'Sync Entry', 'confirmed', 'eligible');
select set_config('app.competition_entry_change_type', '', true),
       set_config('app.competition_entry_change_reason', '', true),
       set_config('app.competition_entry_fee_handling', '', true);
set local role service_role;
select pg_temp.expect_ok('service-role refund of the source registration',
  $q$update public.event_registrations set payment_status = 'refunded', status = 'refunded'
     where id = '00000000-0000-0000-0000-0a10a000f001'$q$);
reset role;
select pg_temp.chk('refund withdrew the entry (canonical body)',
  (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-0a10a0007004') = 'withdrawn',
  (select status from public.event_competition_entries where id = '00000000-0000-0000-0000-0a10a0007004'));
select pg_temp.chk('refund recorded withdraw/refund history',
  exists (select 1 from public.event_competition_entry_changes
          where entry_id = '00000000-0000-0000-0000-0a10a0007004' and change_type = 'withdraw'
            and fee_handling = 'refund' and reason = 'Source registration was refunded.'));

-- ============================================================================
-- Event deletion still cascades through append-only evidence
-- ============================================================================
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name) values
  ('00000000-0000-0000-0000-0a10a0007031', '00000000-0000-0000-0000-0a10a000e003', '00000000-0000-0000-0000-0a10a0001003',
   '00000000-0000-0000-0000-0a10a0003003', 'Cascade Entry');
update public.event_competition_entries set status = 'withdrawn' where id = '00000000-0000-0000-0000-0a10a0007031';
select pg_temp.chk('cascade fixture has history',
  exists (select 1 from public.event_competition_entry_changes where event_id = '00000000-0000-0000-0000-0a10a000e003'));
select pg_temp.expect_ok('deleting a competition event cascades its history',
  $q$delete from public.events where id = '00000000-0000-0000-0000-0a10a000e003'$q$);
select pg_temp.chk('event cascade removed only that event''s history',
  not exists (select 1 from public.event_competition_entry_changes where event_id = '00000000-0000-0000-0000-0a10a000e003')
  and exists (select 1 from public.event_competition_entry_changes where event_id = '00000000-0000-0000-0000-0a10a000e001'));

-- ============================================================================
-- Verdict (always aborts the transaction)
-- ============================================================================
do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*), string_agg(name || ' => ' || detail, '; ') filter (where not ok)
  into v_total, v_failures from t_results;

  if v_failures is null then
    raise exception 'PHASE 10A SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'PHASE 10A SQL SUITE FAIL: %', v_failures;
end $$;

rollback;

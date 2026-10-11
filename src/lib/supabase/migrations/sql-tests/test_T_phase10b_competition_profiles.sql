-- Phase 10B -- rules profile, simple creation and publish lock regression suite.
--
-- Covers 20261108090000_phase10b_competition_profiles.sql on top of the Phase 10A foundation.
-- One transaction, synthetic fixtures only (UUID block 00000000-0000-0000-0000-0b10b0XXXXXX).
-- Tenant behaviour is simulated with `set local role` + request.jwt.claims. Assumes both the 10A
-- and 10B migrations have been applied. The final block ALWAYS raises, so the whole transaction
-- aborts and nothing persists; its message is the verdict:
--   "PHASE 10B SQL SUITE PASS (<n> checks)"  or  "PHASE 10B SQL SUITE FAIL: <failures>".

begin;

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0b10b0000001', 't-p10b-owner-a@example.test'),
  ('00000000-0000-0000-0000-0b10b0000002', 't-p10b-admin-a@example.test'),
  ('00000000-0000-0000-0000-0b10b0000003', 't-p10b-front-a@example.test'),
  ('00000000-0000-0000-0000-0b10b0000004', 't-p10b-owner-b@example.test'),
  ('00000000-0000-0000-0000-0b10b0000005', 't-p10b-platform@example.test'),
  ('00000000-0000-0000-0000-0b10b0000007', 't-p10b-nobody@example.test');
insert into public.profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-0b10b0000001', 't-p10b-owner-a@example.test', 'Owner A'),
  ('00000000-0000-0000-0000-0b10b0000002', 't-p10b-admin-a@example.test', 'Admin A'),
  ('00000000-0000-0000-0000-0b10b0000003', 't-p10b-front-a@example.test', 'Front A'),
  ('00000000-0000-0000-0000-0b10b0000004', 't-p10b-owner-b@example.test', 'Owner B'),
  ('00000000-0000-0000-0000-0b10b0000007', 't-p10b-nobody@example.test', 'Nobody');
insert into public.profiles (id, email, full_name, platform_role) values
  ('00000000-0000-0000-0000-0b10b0000005', 't-p10b-platform@example.test', 'Platform', 'platform_admin');
insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-0b10b000a001', 'P10B Studio A', 't-p10b-studio-a'),
  ('00000000-0000-0000-0000-0b10b000b001', 'P10B Studio B', 't-p10b-studio-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-0b10b0000001', '00000000-0000-0000-0000-0b10b000a001', 'studio_owner', true),
  ('00000000-0000-0000-0000-0b10b0000002', '00000000-0000-0000-0000-0b10b000a001', 'studio_admin', true),
  ('00000000-0000-0000-0000-0b10b0000003', '00000000-0000-0000-0000-0b10b000a001', 'front_desk', true),
  ('00000000-0000-0000-0000-0b10b0000004', '00000000-0000-0000-0000-0b10b000b001', 'studio_owner', true);

-- E1 main simple flow, E2 ratings, E3 callbacks, E4 West Coast Swing, E5 advanced/legacy,
-- E6 restart, E7 other studio, E8 profile versions, E9 panel edits.
do $$
declare n int;
begin
  for n in 1..9 loop
    insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
    values (('00000000-0000-0000-0000-0b10b000e00' || n)::uuid,
            case when n = 7 then '00000000-0000-0000-0000-0b10b000b001'::uuid else '00000000-0000-0000-0000-0b10b000a001'::uuid end,
            'P10B Event ' || n, 't-p10b-e' || n, 'competition', current_date + 30, current_date + 30, 'published', 'public', true);
  end loop;
end $$;

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

create or replace function pg_temp.spec(p_preset text, p_judging text, p_request text, p_categories jsonb, p_divisions jsonb,
                                        p_version int default 1) returns jsonb
language sql as $$
  select jsonb_build_object('profile_key', 'studio_simple', 'profile_version', p_version, 'request_key', p_request,
    'preset', p_preset, 'judging', p_judging, 'name', 'Test Competition', 'division_preset', 'levels_newcomer_gold',
    'categories', p_categories, 'divisions', p_divisions)
$$;

grant execute on function pg_temp.chk(text, boolean, text), pg_temp.expect_fail(text, text, text), pg_temp.expect_msg(text, text, text),
  pg_temp.expect_ok(text, text), pg_temp.spec(text, text, text, jsonb, jsonb, int) to authenticated, anon, service_role;

-- Reusable specs --------------------------------------------------------------
-- two categories (ProAm per dance + Solo flat), two divisions
create temp table t_specs (k text primary key, spec jsonb) on commit drop;
grant all on t_specs to authenticated, anon, service_role;
insert into t_specs values
 ('main', pg_temp.spec('studio_competition', 'placements', 'req-main-0001',
    '[{"type":"pro_am","price":25,"dances":["waltz","foxtrot"]},{"type":"solo","price":40}]'::jsonb,
    '[{"name":"Bronze","skill_label":"Bronze"},{"name":"Silver","skill_label":"Silver"}]'::jsonb)),
 ('ratings', pg_temp.spec('showcase', 'ratings', 'req-ratings-01',
    '[{"type":"showcase","price":30}]'::jsonb, '[{"name":"Open","skill_label":"Open"}]'::jsonb)),
 ('callbacks', pg_temp.spec('ballroom', 'callbacks', 'req-callback-01',
    '[{"type":"couples","price":20,"dances":["smooth_waltz"]}]'::jsonb, '[{"name":"Gold","skill_label":"Gold"}]'::jsonb)),
 ('wcs', pg_temp.spec('west_coast_swing', 'placements', 'req-wcs-00001',
    '[{"type":"jack_and_jill","price":15,"dances":["west_coast_swing"]}]'::jsonb,
    '[{"name":"Beginner","skill_label":"Beginner"},{"name":"Advanced","skill_label":"Advanced"}]'::jsonb)),
 ('panel', pg_temp.spec('country', 'placements', 'req-panel-0001',
    '[{"type":"couples","price":10,"dances":["two_step","waltz"]}]'::jsonb, '[{"name":"Beginner"},{"name":"Advanced"}]'::jsonb)),
 ('restart', pg_temp.spec('custom', 'placements', 'req-restart-01',
    '[{"type":"solo","price":5}]'::jsonb, '[{"name":"Open"}]'::jsonb));

-- Helper: count rows per event
create or replace function pg_temp.n(p_table text, p_event uuid) returns int
language plpgsql as $$
declare r int;
begin
  execute format('select count(*) from public.%I where event_id = $1', p_table) into r using p_event;
  return r;
end $$;
grant execute on function pg_temp.n(text, uuid) to authenticated, anon, service_role;

-- ============================================================================
-- PROFILE
-- ============================================================================
select pg_temp.chk('studio_simple@1 exists and is active',
  exists (select 1 from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 1 and status = 'active'));
select pg_temp.chk('studio_simple@1 declares no sanction and cannot claim one',
  (select defaults #>> '{sanction,status}' = 'none' and (defaults #>> '{sanction,claimable}')::boolean = false
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 1));
select pg_temp.chk('studio_simple@1 default structure is final only with the three studio engines',
  (select defaults->>'roundsDefault' = 'final_only'
      and defaults #>> '{judging,placements,engine,key}' = 'ordinal_majority'
      and defaults #>> '{judging,ratings,engine,key}' = 'proficiency_rating'
      and defaults #>> '{judging,callbacks,engine,key}' = 'callback_tally'
      and defaults #> '{judging,ratings,bands}' = '["Gold","Silver","Bronze"]'::jsonb
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 1));
select pg_temp.chk('anon cannot read profiles; authenticated and service_role can',
  not has_table_privilege('anon', 'public.competition_rules_profiles', 'SELECT')
  and has_table_privilege('authenticated', 'public.competition_rules_profiles', 'SELECT')
  and not has_table_privilege('authenticated', 'public.competition_rules_profiles', 'INSERT')
  and not has_table_privilege('service_role', 'public.competition_rules_profiles', 'INSERT'));
select pg_temp.expect_fail('postgres cannot rewrite profile defaults (versions are immutable)',
  $q$update public.competition_rules_profiles set defaults = '{"schema":1}'::jsonb where profile_key = 'studio_simple' and version = 1$q$, '42501');
select pg_temp.expect_fail('profile versions cannot be deleted',
  $q$delete from public.competition_rules_profiles where profile_key = 'studio_simple'$q$, '42501');
select pg_temp.expect_fail('profile table cannot be truncated',
  $q$truncate public.competition_rules_profiles cascade$q$, '42501');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.chk('authenticated users can read the profile', (select count(*) from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 1) = 1);
select pg_temp.expect_fail('authenticated cannot insert a profile',
  $q$insert into public.competition_rules_profiles (profile_key, version, name, defaults) values ('rogue', 1, 'Rogue', '{}'::jsonb)$q$, '42501');
reset role;

-- unsupported profile/version
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_msg('unsupported profile version is rejected',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e001', pg_temp.spec('studio_competition', 'placements', 'req-badver-001',
     '[{"type":"solo","price":5}]'::jsonb, '[{"name":"Open"}]'::jsonb, 99))$q$, 'unsupported competition profile');
select pg_temp.expect_msg('unknown profile key is rejected',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e001',
     (pg_temp.spec('studio_competition', 'placements', 'req-badkey-001', '[{"type":"solo","price":5}]'::jsonb, '[{"name":"Open"}]'::jsonb) || '{"profile_key":"ndca"}'::jsonb))$q$, 'unsupported competition profile');
reset role;
select pg_temp.expect_fail('programs FK rejects an unknown profile version',
  $q$insert into public.event_competition_programs (event_id, studio_id, name, discipline_family, competition_mode, scoring_method, rules_profile_key, rules_profile_version)
     values ('00000000-0000-0000-0000-0b10b000e005', '00000000-0000-0000-0000-0b10b000a001', 'Bad', 'custom', 'relative', 'none', 'studio_simple', 99)$q$, '23503');
select pg_temp.expect_fail('programs reject a profile key without a version',
  $q$insert into public.event_competition_programs (event_id, studio_id, name, discipline_family, competition_mode, scoring_method, rules_profile_key)
     values ('00000000-0000-0000-0000-0b10b000e005', '00000000-0000-0000-0000-0b10b000a001', 'Bad', 'custom', 'relative', 'none', 'studio_simple')$q$, '23514');

-- ============================================================================
-- AUTHORIZATION
-- ============================================================================
select pg_temp.chk('anon cannot execute any 10B function',
  not has_function_privilege('anon', 'public.create_simple_competition(uuid, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.publish_competition_program(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.add_competition_division(uuid, text, text, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.remove_competition_division(uuid)', 'EXECUTE'));
select pg_temp.chk('authenticated can execute the 10B functions',
  has_function_privilege('authenticated', 'public.create_simple_competition(uuid, jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.publish_competition_program(uuid)', 'EXECUTE'));

do $$
declare r record;
begin
  for r in select * from (values
    ('00000000-0000-0000-0000-0b10b0000003', 'front desk'),
    ('00000000-0000-0000-0000-0b10b0000004', 'other-studio owner'),
    ('00000000-0000-0000-0000-0b10b0000007', 'user with no role')
  ) as t(uid, label) loop
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', r.uid, 'role', 'authenticated')::text, true);
    perform pg_temp.expect_msg('create refused for ' || r.label,
      $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e001', (select spec from t_specs where k = 'main'))$q$, 'cannot be managed');
    execute 'reset role';
  end loop;
end $$;
select pg_temp.chk('refused callers created nothing', pg_temp.n('event_competition_programs', '00000000-0000-0000-0000-0b10b000e001') = 0);

-- ============================================================================
-- CREATE (presets resolve into canonical entities)
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('manager creates the main simple competition',
  $q$insert into t_ids select 'main', public.create_simple_competition('00000000-0000-0000-0000-0b10b000e001', (select spec from t_specs where k = 'main'))$q$);
reset role;

select pg_temp.chk('one program carrying studio_simple@1 as a draft',
  (select count(*) = 1 and bool_and(rules_profile_key = 'studio_simple' and rules_profile_version = 1 and status = 'draft'
                                    and profile_locked_at is null)
   and not exists (select 1 from public.event_competition_program_locks where event_id = '00000000-0000-0000-0000-0b10b000e001')
   from public.event_competition_programs where event_id = '00000000-0000-0000-0000-0b10b000e001'));
select pg_temp.chk('placements map to the ordinal_majority engine in the canonical columns',
  (select scoring_method = 'ordinal_majority' and competition_mode = 'relative' and advancement_method = 'none'
          and discipline_family = 'custom' and configuration #>> '{simple,preset}' = 'studio_competition'
   from public.event_competition_programs where id = (select v from t_ids where k = 'main')));
select pg_temp.chk('two categories became canonical contests (ProAm, Solo)',
  (select array_agg(name order by sort_order) = array['ProAm', 'Solo'] and array_agg(entry_format order by sort_order) = array['pro_am', 'solo']
   from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e001'));
select pg_temp.chk('divisions are canonical rows under every category (2 x 2)',
  pg_temp.n('event_competition_divisions', '00000000-0000-0000-0000-0b10b000e001') = 4
  and (select count(distinct contest_id) from public.event_competition_divisions where event_id = '00000000-0000-0000-0000-0b10b000e001') = 2);
select pg_temp.chk('every division got exactly one Final round using the placements engine',
  (select count(*) = 4 and bool_and(round_type = 'final' and name = 'Final' and sequence_number = 1 and scoring_method = 'ordinal_majority')
   from public.event_competition_rounds where event_id = '00000000-0000-0000-0000-0b10b000e001'));
select pg_temp.chk('round pairing follows the category (solo individual, proam fixed)',
  (select bool_and(case when c.entry_format = 'solo' then r.pairing_mode = 'individual' else r.pairing_mode = 'fixed' end)
   from public.event_competition_rounds r join public.event_competition_divisions d on d.id = r.division_id
   join public.event_competition_contests c on c.id = d.contest_id where r.event_id = '00000000-0000-0000-0000-0b10b000e001'));
select pg_temp.chk('only dance-based categories got dances and offerings',
  pg_temp.n('event_competition_dances', '00000000-0000-0000-0000-0b10b000e001') = 2
  and pg_temp.n('event_competition_division_dances', '00000000-0000-0000-0000-0b10b000e001') = 4
  and not exists (select 1 from public.event_competition_division_dances dd join public.event_competition_divisions d on d.id = dd.division_id
                  join public.event_competition_contests c on c.id = d.contest_id where dd.event_id = '00000000-0000-0000-0000-0b10b000e001' and c.entry_format = 'solo'));
select pg_temp.chk('ProAm is priced per dance on the offerings; Solo is a flat entry fee',
  (select bool_and(pricing_method = 'per_dance' and base_entry_fee = 0 and dance_selection_mode = 'individual' and minimum_dances = 1
                   and minimum_participants = 2 and maximum_participants = 2)
   from public.event_competition_contest_registration_rules r join public.event_competition_contests c on c.id = r.contest_id
   where c.event_id = '00000000-0000-0000-0000-0b10b000e001' and c.entry_format = 'pro_am')
  and (select bool_and(pricing_method = 'flat_entry' and base_entry_fee = 40 and dance_selection_mode = 'routine'
                       and minimum_participants = 1 and maximum_participants = 1)
       from public.event_competition_contest_registration_rules r join public.event_competition_contests c on c.id = r.contest_id
       where c.event_id = '00000000-0000-0000-0000-0b10b000e001' and c.entry_format = 'solo')
  and (select bool_and(entry_fee = 25 and not required) from public.event_competition_division_dances where event_id = '00000000-0000-0000-0000-0b10b000e001'));
select pg_temp.chk('registration stays closed and categories/divisions stay drafts (10B does not open registration)',
  not exists (select 1 from public.event_competition_contest_registration_rules where event_id = '00000000-0000-0000-0000-0b10b000e001' and registration_open)
  and not exists (select 1 from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e001' and status <> 'draft')
  and not exists (select 1 from public.event_competition_divisions where event_id = '00000000-0000-0000-0000-0b10b000e001' and status <> 'draft'));
select pg_temp.chk('simple registration rules use generic terminology, not an organization''s',
  not exists (select 1 from public.event_competition_contest_registration_rules where event_id = '00000000-0000-0000-0000-0b10b000e001'
              and (terminology ? 'registry_id_label' or terminology->>'division_label' <> 'Division')));
select pg_temp.chk('no parallel simple tables exist',
  not exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname ~ '(^|_)simple_(competition|division|round|scoring)'));

-- retry does not duplicate
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('retrying the same request returns the same competition',
  $q$insert into t_ids select 'main_retry', public.create_simple_competition('00000000-0000-0000-0000-0b10b000e001', (select spec from t_specs where k = 'main'))$q$);
reset role;
select pg_temp.chk('retry returned the original program id and created nothing more',
  (select v from t_ids where k = 'main_retry') = (select v from t_ids where k = 'main')
  and pg_temp.n('event_competition_programs', '00000000-0000-0000-0000-0b10b000e001') = 1
  and pg_temp.n('event_competition_contests', '00000000-0000-0000-0000-0b10b000e001') = 2
  and pg_temp.n('event_competition_divisions', '00000000-0000-0000-0000-0b10b000e001') = 4
  and pg_temp.n('event_competition_rounds', '00000000-0000-0000-0000-0b10b000e001') = 4
  and pg_temp.n('event_competition_division_dances', '00000000-0000-0000-0000-0b10b000e001') = 4);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_msg('a different request cannot create a second setup on the same event',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e001', (select spec || '{"request_key":"req-other-0001"}'::jsonb from t_specs where k = 'main'))$q$, 'already has competition setup');

-- validation
select pg_temp.expect_msg('category not offered for the competition type is rejected',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e004', pg_temp.spec('west_coast_swing', 'placements', 'req-val-00001',
     '[{"type":"team","price":5}]'::jsonb, '[{"name":"Open"}]'::jsonb))$q$, 'not available for this competition type');
select pg_temp.expect_msg('a dance-based category needs dances',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e004', pg_temp.spec('studio_competition', 'placements', 'req-val-00002',
     '[{"type":"pro_am","price":5,"dances":[]}]'::jsonb, '[{"name":"Open"}]'::jsonb))$q$, 'at least one dance');
select pg_temp.expect_msg('a dance outside the preset pool is rejected',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e004', pg_temp.spec('country', 'placements', 'req-val-00003',
     '[{"type":"couples","price":5,"dances":["smooth_waltz"]}]'::jsonb, '[{"name":"Open"}]'::jsonb))$q$, 'not available for this competition type');
select pg_temp.expect_msg('an invalid price is rejected',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e004', pg_temp.spec('studio_competition', 'placements', 'req-val-00004',
     '[{"type":"solo","price":-5}]'::jsonb, '[{"name":"Open"}]'::jsonb))$q$, 'valid price');
select pg_temp.expect_msg('duplicate division names are rejected',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e004', pg_temp.spec('studio_competition', 'placements', 'req-val-00005',
     '[{"type":"solo","price":5}]'::jsonb, '[{"name":"Open"},{"name":" open "}]'::jsonb))$q$, 'unique');
select pg_temp.expect_msg('zero divisions are rejected',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e004', pg_temp.spec('studio_competition', 'placements', 'req-val-00006',
     '[{"type":"solo","price":5}]'::jsonb, '[]'::jsonb))$q$, 'divisions');
select pg_temp.expect_msg('zero categories are rejected',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e004', pg_temp.spec('studio_competition', 'placements', 'req-val-00007',
     '[]'::jsonb, '[{"name":"Open"}]'::jsonb))$q$, 'categories');
select pg_temp.expect_msg('an unknown judging choice is rejected',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e004', pg_temp.spec('studio_competition', 'wsdc_relative_placement', 'req-val-00008',
     '[{"type":"solo","price":5}]'::jsonb, '[{"name":"Open"}]'::jsonb))$q$, 'unknown judging');
select pg_temp.expect_msg('an unknown competition type is rejected',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e004', pg_temp.spec('ndca_championship', 'placements', 'req-val-00009',
     '[{"type":"solo","price":5}]'::jsonb, '[{"name":"Open"}]'::jsonb))$q$, 'unknown competition type');
select pg_temp.expect_msg('a missing request key is rejected',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e004', pg_temp.spec('studio_competition', 'placements', 'x',
     '[{"type":"solo","price":5}]'::jsonb, '[{"name":"Open"}]'::jsonb))$q$, 'request key');
reset role;
select pg_temp.chk('a refused second setup left exactly one program and two categories on the event',
  pg_temp.n('event_competition_programs', '00000000-0000-0000-0000-0b10b000e001') = 1
  and pg_temp.n('event_competition_contests', '00000000-0000-0000-0000-0b10b000e001') = 2);
select pg_temp.chk('rejected specs created nothing on the validation event',
  pg_temp.n('event_competition_programs', '00000000-0000-0000-0000-0b10b000e004') = 0);

-- other judging models and the WCS preset
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000002","role":"authenticated"}', true);
select pg_temp.expect_ok('studio admin creates a ratings showcase',
  $q$insert into t_ids select 'ratings', public.create_simple_competition('00000000-0000-0000-0000-0b10b000e002', (select spec from t_specs where k = 'ratings'))$q$);
select pg_temp.expect_ok('studio admin creates a callbacks competition',
  $q$insert into t_ids select 'callbacks', public.create_simple_competition('00000000-0000-0000-0000-0b10b000e003', (select spec from t_specs where k = 'callbacks'))$q$);
select pg_temp.expect_ok('studio admin creates a West Coast Swing Jack & Jill',
  $q$insert into t_ids select 'wcs', public.create_simple_competition('00000000-0000-0000-0000-0b10b000e004', (select spec from t_specs where k = 'wcs'))$q$);
reset role;
select pg_temp.chk('ratings use proficiency_rating and a single Final round',
  (select scoring_method = 'proficiency_rating' and competition_mode = 'proficiency' from public.event_competition_programs where id = (select v from t_ids where k = 'ratings'))
  and (select count(*) = 1 and bool_and(scoring_method = 'proficiency_rating' and round_type = 'final') from public.event_competition_rounds where event_id = '00000000-0000-0000-0000-0b10b000e002'));
select pg_temp.chk('callbacks create a callback round then a Final',
  (select scoring_method = 'callback_tally' and advancement_method = 'promote_callback' from public.event_competition_programs where id = (select v from t_ids where k = 'callbacks'))
  and (select array_agg(round_type || ':' || scoring_method order by sequence_number) = array['preliminary:callback_tally', 'final:ordinal_majority']
       from public.event_competition_rounds where event_id = '00000000-0000-0000-0000-0b10b000e003'));
select pg_temp.chk('West Coast Swing preset does not create a WSDC program profile (rules profile is not sanction)',
  not exists (select 1 from public.event_competition_wsdc_program_profiles where event_id = '00000000-0000-0000-0000-0b10b000e004')
  and (select discipline_family = 'west_coast_swing' and rules_profile_key = 'studio_simple' from public.event_competition_programs where id = (select v from t_ids where k = 'wcs'))
  and (select bool_and(pairing_mode = 'random_final_pair') from public.event_competition_rounds where event_id = '00000000-0000-0000-0000-0b10b000e004'));

-- registration closed => the public catalog stays empty for a simple, unpublished competition
set local role anon;
select pg_temp.chk('anonymous visitors see no simple competition categories or divisions',
  not exists (select 1 from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e001')
  and not exists (select 1 from public.event_competition_divisions where event_id = '00000000-0000-0000-0000-0b10b000e001'));
reset role;

-- ============================================================================
-- CLIENTS CANNOT WRITE THE PROFILE COLUMNS
-- ============================================================================
select pg_temp.chk('column privileges: clients cannot insert or update the three profile columns',
  not exists (
    select 1 from unnest(array['rules_profile_key', 'rules_profile_version', 'profile_locked_at']) c,
                  unnest(array['anon', 'authenticated']) r,
                  unnest(array['INSERT', 'UPDATE']) p
    where has_column_privilege(r, 'public.event_competition_programs', c, p)));
select pg_temp.chk('column privileges: clients keep the ordinary program columns',
  has_column_privilege('authenticated', 'public.event_competition_programs', 'name', 'UPDATE')
  and has_column_privilege('authenticated', 'public.event_competition_programs', 'status', 'UPDATE')
  and has_column_privilege('authenticated', 'public.event_competition_programs', 'event_id', 'INSERT')
  and has_column_privilege('authenticated', 'public.event_competition_programs', 'configuration', 'UPDATE')
  and not has_column_privilege('anon', 'public.event_competition_programs', 'name', 'UPDATE'));
select pg_temp.chk('the lock table accepts no client writes at all',
  not has_table_privilege('authenticated', 'public.event_competition_program_locks', 'INSERT')
  and not has_table_privilege('authenticated', 'public.event_competition_program_locks', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.event_competition_program_locks', 'DELETE')
  and not has_table_privilege('service_role', 'public.event_competition_program_locks', 'INSERT')
  and not has_table_privilege('anon', 'public.event_competition_program_locks', 'SELECT'));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_fail('manager cannot forge a profile lock timestamp',
  $q$update public.event_competition_programs set profile_locked_at = now() where id = (select v from t_ids where k = 'main')$q$, '42501');
select pg_temp.expect_fail('manager cannot forge a lock snapshot row',
  $q$insert into public.event_competition_program_locks (program_id, event_id, rules_profile_key, rules_profile_version, snapshot, locked_at)
     values ((select v from t_ids where k = 'main'), '00000000-0000-0000-0000-0b10b000e001', 'studio_simple', 1,
             '{"profile":{"key":"studio_simple","version":1}}'::jsonb, now())$q$, '42501');
select pg_temp.expect_fail('manager cannot change the profile version of a draft directly',
  $q$update public.event_competition_programs set rules_profile_version = 1, rules_profile_key = 'studio_simple' where id = (select v from t_ids where k = 'main')$q$, '42501');
select pg_temp.expect_fail('manager cannot insert a program with a profile directly',
  $q$insert into public.event_competition_programs (event_id, studio_id, name, discipline_family, competition_mode, scoring_method, rules_profile_key, rules_profile_version)
     values ('00000000-0000-0000-0000-0b10b000e005', '00000000-0000-0000-0000-0b10b000a001', 'Forged', 'custom', 'relative', 'none', 'studio_simple', 1)$q$, '42501');
select pg_temp.expect_ok('manager can still edit ordinary program fields',
  $q$update public.event_competition_programs set name = 'Spring Showcase 2027' where id = (select v from t_ids where k = 'main')$q$);
select pg_temp.expect_msg('manager cannot flip a profiled draft to configured without publishing',
  $q$update public.event_competition_programs set status = 'configured' where id = (select v from t_ids where k = 'main')$q$, 'publish');
reset role;

-- ============================================================================
-- PUBLISH: structure validation
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
-- Panel RPCs are exercised on the main competition before publishing.
select pg_temp.expect_ok('manager adds a division through the panel RPC (copies Final + dances)',
  $q$insert into t_ids select 'gold', public.add_competition_division((select id from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e001' and entry_format = 'pro_am' order by sort_order limit 1), 'Gold', 'Gold', null)$q$);
reset role;
select pg_temp.chk('the added division has the category''s Final round and dance offerings',
  (select count(*) = 1 and bool_and(round_type = 'final' and scoring_method = 'ordinal_majority') from public.event_competition_rounds where division_id = (select v from t_ids where k = 'gold'))
  and (select count(*) = 2 and bool_and(entry_fee = 25) from public.event_competition_division_dances where division_id = (select v from t_ids where k = 'gold')));
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_msg('adding a duplicate division name is refused',
  $q$select public.add_competition_division((select id from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e001' and entry_format = 'pro_am' order by sort_order limit 1), 'gold', null, null)$q$, 'already has a division');
select pg_temp.expect_ok('manager removes the added division again',
  $q$select public.remove_competition_division((select v from t_ids where k = 'gold'))$q$);
reset role;
select pg_temp.chk('removal cascaded the division''s rounds and offerings',
  not exists (select 1 from public.event_competition_rounds where division_id = (select v from t_ids where k = 'gold'))
  and not exists (select 1 from public.event_competition_division_dances where division_id = (select v from t_ids where k = 'gold')));

-- break the structure three ways and prove publish refuses each, then repair
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('manager (advanced edit) deletes one division''s round',
  $q$delete from public.event_competition_rounds where division_id = (select id from public.event_competition_divisions where event_id = '00000000-0000-0000-0000-0b10b000e001' and name = 'Silver' order by sort_order limit 1)$q$);
select pg_temp.expect_msg('publish refuses a division without a round',
  $q$select public.publish_competition_program((select v from t_ids where k = 'main'))$q$, 'needs a round');
reset role;
insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, scoring_method)
select d.event_id, d.program_id, d.id, 'Final', 'final', 1, 'ordinal_majority'
from public.event_competition_divisions d
where d.event_id = '00000000-0000-0000-0000-0b10b000e001' and not exists (select 1 from public.event_competition_rounds r where r.division_id = d.id);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('manager removes all offerings from one ProAm division',
  $q$delete from public.event_competition_division_dances where division_id = (select d.id from public.event_competition_divisions d join public.event_competition_contests c on c.id = d.contest_id where d.event_id = '00000000-0000-0000-0000-0b10b000e001' and c.entry_format = 'pro_am' order by d.sort_order limit 1)$q$);
select pg_temp.expect_msg('publish refuses a dance-based division without dances',
  $q$select public.publish_competition_program((select v from t_ids where k = 'main'))$q$, 'needs at least one dance');
reset role;
insert into public.event_competition_division_dances (event_id, program_id, division_id, dance_id, entry_fee, currency, required, sort_order)
select d.event_id, d.program_id, d.id, (select id from public.event_competition_dances where program_id = d.program_id and dance_key = 'waltz'), 25, 'USD', false, 10
from public.event_competition_divisions d join public.event_competition_contests c on c.id = d.contest_id
where d.event_id = '00000000-0000-0000-0000-0b10b000e001' and c.entry_format = 'pro_am'
  and not exists (select 1 from public.event_competition_division_dances dd where dd.division_id = d.id);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('manager removes every division of the Solo category',
  $q$select public.remove_competition_division(id) from public.event_competition_divisions where contest_id = (select id from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e001' and entry_format = 'solo' order by sort_order limit 1)$q$);
select pg_temp.expect_msg('publish refuses a category without divisions',
  $q$select public.publish_competition_program((select v from t_ids where k = 'main'))$q$, 'at least one division');
reset role;
do $$
declare r record;
begin
  for r in select * from (values
    ('00000000-0000-0000-0000-0b10b0000003', 'front desk'),
    ('00000000-0000-0000-0000-0b10b0000004', 'other-studio owner'),
    ('00000000-0000-0000-0000-0b10b0000007', 'user with no role')
  ) as t(uid, label) loop
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', r.uid, 'role', 'authenticated')::text, true);
    perform pg_temp.expect_msg('publish refused for ' || r.label,
      $q$select public.publish_competition_program((select v from t_ids where k = 'main'))$q$, 'cannot be managed');
    execute 'reset role';
  end loop;
end $$;
select pg_temp.chk('refused publishes changed nothing',
  (select status = 'draft' and profile_locked_at is null from public.event_competition_programs where id = (select v from t_ids where k = 'main'))
  and not exists (select 1 from public.event_competition_program_locks where program_id = (select v from t_ids where k = 'main')));

-- repair: re-add Solo divisions through the panel RPC (no template division exists -> default Final)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('manager re-adds Solo divisions (default Final round when the category is empty)',
  $q$select public.add_competition_division((select id from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e001' and entry_format = 'solo' order by sort_order limit 1), n, null, null)
     from unnest(array['Bronze', 'Silver']) n$q$);
reset role;
select pg_temp.chk('re-added Solo divisions have a Final round with the placements engine',
  (select count(*) = 2 and bool_and(scoring_method = 'ordinal_majority')
   from public.event_competition_rounds where division_id in (select id from public.event_competition_divisions where contest_id = (select id from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e001' and entry_format = 'solo' order by sort_order limit 1))));

-- an advanced-mode edit made before publishing survives and is captured
insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, scoring_method)
select d.event_id, d.program_id, d.id, 'Semi-final', 'semifinal', 2, 'none'
from public.event_competition_divisions d join public.event_competition_contests c on c.id = d.contest_id
where d.event_id = '00000000-0000-0000-0000-0b10b000e001' and c.entry_format = 'pro_am' and d.name = 'Bronze';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('retrying creation after advanced edits changes nothing',
  $q$insert into t_ids select 'main_retry2', public.create_simple_competition('00000000-0000-0000-0000-0b10b000e001', (select spec from t_specs where k = 'main'))$q$);
reset role;
select pg_temp.chk('advanced edits survive a simple-mode retry',
  (select v from t_ids where k = 'main_retry2') = (select v from t_ids where k = 'main')
  and exists (select 1 from public.event_competition_rounds where event_id = '00000000-0000-0000-0000-0b10b000e001' and name = 'Semi-final'));

-- ============================================================================
-- PUBLISH: lock + snapshot
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('manager publishes the competition',
  $q$insert into t_ids select 'pub_probe', (public.publish_competition_program((select v from t_ids where k = 'main')) #>> '{program,id}')::uuid$q$);
reset role;
select pg_temp.chk('publish locked the profile and froze a snapshot',
  (select p.status = 'configured' and p.profile_locked_at is not null and l.locked_by = '00000000-0000-0000-0000-0b10b0000001'
          and l.locked_at = p.profile_locked_at
          and p.rules_profile_key = 'studio_simple' and p.rules_profile_version = 1
          and l.snapshot #>> '{profile,key}' = 'studio_simple' and (l.snapshot #>> '{profile,version}')::int = 1
          and l.snapshot #>> '{judging,mode}' = 'placements'
          and l.snapshot #>> '{profile,sanction,status}' = 'none'
   from public.event_competition_programs p join public.event_competition_program_locks l on l.program_id = p.id
   where p.id = (select v from t_ids where k = 'main')));
select pg_temp.chk('the snapshot stores the profile defaults and the published structure',
  (select snapshot->'defaults' = (select defaults from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 1)
          and jsonb_array_length(snapshot #> '{structure,categories}') = 2
          and (select sum(jsonb_array_length(c->'divisions')) from jsonb_array_elements(snapshot #> '{structure,categories}') c) = 4
          and exists (select 1 from jsonb_array_elements(snapshot #> '{structure,categories}') c, jsonb_array_elements(c->'divisions') d,
                      jsonb_array_elements(d->'rounds') r where r->>'name' = 'Semi-final')
   from public.event_competition_program_locks where program_id = (select v from t_ids where k = 'main')));
select pg_temp.chk('publishing did not open registration or change category/division status',
  not exists (select 1 from public.event_competition_contest_registration_rules where event_id = '00000000-0000-0000-0000-0b10b000e001' and registration_open)
  and not exists (select 1 from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e001' and status <> 'draft'));

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_msg('publishing twice is refused',
  $q$select public.publish_competition_program((select v from t_ids where k = 'main'))$q$, 'already published');
select pg_temp.expect_fail('manager cannot change the profile version after publish',
  $q$update public.event_competition_programs set rules_profile_version = 2 where id = (select v from t_ids where k = 'main')$q$, '42501');
select pg_temp.expect_fail('manager cannot rewrite the snapshot after publish',
  $q$update public.event_competition_program_locks set snapshot = '{}'::jsonb where program_id = (select v from t_ids where k = 'main')$q$, '42501');
select pg_temp.expect_fail('manager cannot delete the lock row after publish',
  $q$delete from public.event_competition_program_locks where program_id = (select v from t_ids where k = 'main')$q$, '42501');
select pg_temp.expect_fail('manager cannot return a published competition to draft',
  $q$update public.event_competition_programs set status = 'draft' where id = (select v from t_ids where k = 'main')$q$, '42501');
select pg_temp.expect_ok('manager can still rename a published competition',
  $q$update public.event_competition_programs set name = 'Spring Showcase (final)' where id = (select v from t_ids where k = 'main')$q$);
reset role;
select pg_temp.expect_fail('even postgres cannot change the locked profile (trigger)',
  $q$update public.event_competition_programs set rules_profile_key = null, rules_profile_version = null where id = (select v from t_ids where k = 'main')$q$, '42501');
select pg_temp.expect_fail('even postgres cannot clear the lock (trigger)',
  $q$update public.event_competition_programs set profile_locked_at = null where id = (select v from t_ids where k = 'main')$q$, '42501');
select pg_temp.expect_fail('even postgres cannot rewrite the lock snapshot (trigger)',
  $q$update public.event_competition_program_locks set snapshot = '{}'::jsonb where program_id = (select v from t_ids where k = 'main')$q$, '42501');
select pg_temp.expect_fail('even postgres cannot truncate the lock table (trigger)',
  $q$truncate public.event_competition_program_locks$q$, '42501');

create temp table t_snapshot_before as
  select l.snapshot as snap, p.rules_profile_version as ver
  from public.event_competition_programs p join public.event_competition_program_locks l on l.program_id = p.id
  where p.id = (select v from t_ids where k = 'main');

-- structure edits after publish do not rewrite the point-in-time snapshot
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('divisions can still be added to a published (configured) competition',
  $q$select public.add_competition_division((select id from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e001' and entry_format = 'pro_am' order by sort_order limit 1), 'Platinum', null, null)$q$);
reset role;
select pg_temp.chk('the published snapshot did not change when a division was added later',
  (select snapshot = (select snap from t_snapshot_before) from public.event_competition_program_locks where program_id = (select v from t_ids where k = 'main')));

-- running competitions are closed to panel edits
update public.event_competition_programs set status = 'active' where id = (select v from t_ids where k = 'main');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_msg('divisions cannot be added once the competition is running',
  $q$select public.add_competition_division((select id from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e001' and entry_format = 'pro_am' order by sort_order limit 1), 'Late', null, null)$q$, 'running');
reset role;
update public.event_competition_programs set status = 'configured' where id = (select v from t_ids where k = 'main');

-- ============================================================================
-- PANEL RPCs: authorization + entry protection (separate event E9)
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('manager creates the panel-test competition',
  $q$insert into t_ids select 'panel', public.create_simple_competition('00000000-0000-0000-0000-0b10b000e009', (select spec from t_specs where k = 'panel'))$q$);
reset role;
select pg_temp.expect_fail('even postgres cannot set a profile lock without its lock-evidence row (trigger)',
  $q$update public.event_competition_programs set status = 'configured', profile_locked_at = now() where id = (select v from t_ids where k = 'panel')$q$, '42501');
select pg_temp.chk('the refused lock attempt left the panel competition a draft',
  (select status = 'draft' and profile_locked_at is null from public.event_competition_programs where id = (select v from t_ids where k = 'panel')));
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name)
select '00000000-0000-0000-0000-0b10b0007001', d.event_id, d.program_id, d.id, 'Entered Couple'
from public.event_competition_divisions d where d.event_id = '00000000-0000-0000-0000-0b10b000e009' and d.name = 'Beginner';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_msg('a division with entries cannot be removed',
  $q$select public.remove_competition_division((select id from public.event_competition_divisions where event_id = '00000000-0000-0000-0000-0b10b000e009' and name = 'Beginner'))$q$, 'entries or heats');
select pg_temp.expect_ok('an empty division can be removed',
  $q$select public.remove_competition_division((select id from public.event_competition_divisions where event_id = '00000000-0000-0000-0000-0b10b000e009' and name = 'Advanced'))$q$);
reset role;

do $$
declare r record;
begin
  for r in select * from (values
    ('00000000-0000-0000-0000-0b10b0000003', 'front desk'),
    ('00000000-0000-0000-0000-0b10b0000004', 'other-studio owner'),
    ('00000000-0000-0000-0000-0b10b0000007', 'user with no role')
  ) as t(uid, label) loop
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', r.uid, 'role', 'authenticated')::text, true);
    perform pg_temp.expect_msg('add division refused for ' || r.label,
      $q$select public.add_competition_division((select id from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e009'), 'Intruder', null, null)$q$, 'cannot be managed');
    perform pg_temp.expect_msg('remove division refused for ' || r.label,
      $q$select public.remove_competition_division((select id from public.event_competition_divisions where event_id = '00000000-0000-0000-0000-0b10b000e009' and name = 'Beginner'))$q$, 'cannot be managed');
    execute 'reset role';
  end loop;
end $$;

-- ============================================================================
-- ADVANCED / LEGACY: unprofiled competitions are untouched
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('an unprofiled (advanced/legacy) program can still be created by a manager',
  $q$insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method)
     values ('00000000-0000-0000-0000-0b10b0005001', '00000000-0000-0000-0000-0b10b000e005', '00000000-0000-0000-0000-0b10b000a001', 'Legacy Program', 'custom', 'relative', 'skating')$q$);
select pg_temp.expect_ok('an unprofiled program can still change status directly (advanced path unchanged)',
  $q$update public.event_competition_programs set status = 'configured' where id = '00000000-0000-0000-0000-0b10b0005001'$q$);
select pg_temp.expect_msg('the simple publish refuses an unprofiled program',
  $q$select public.publish_competition_program('00000000-0000-0000-0000-0b10b0005001')$q$, 'rules profile');
select pg_temp.expect_msg('simple creation refuses an event that already has advanced setup',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e005', pg_temp.spec('studio_competition', 'placements', 'req-adv-00001',
     '[{"type":"solo","price":5}]'::jsonb, '[{"name":"Open"}]'::jsonb))$q$, 'already has competition setup');
reset role;
select pg_temp.chk('legacy programs carry no profile (not backfilled)',
  (select rules_profile_key is null and rules_profile_version is null and profile_locked_at is null
   from public.event_competition_programs where id = '00000000-0000-0000-0000-0b10b0005001')
  and not exists (select 1 from public.event_competition_program_locks where program_id = '00000000-0000-0000-0000-0b10b0005001'));

-- existing templates still work and stay unprofiled
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
insert into t_ids select 'tpl_event', '00000000-0000-0000-0000-0b10b000e006';
select pg_temp.expect_ok('the ballroom starter template still applies',
  $q$select public.apply_competition_configuration_template('00000000-0000-0000-0000-0b10b000e006', 'ballroom_starter')$q$);
reset role;
select pg_temp.chk('template programs are unprofiled',
  exists (select 1 from public.event_competition_programs where event_id = '00000000-0000-0000-0000-0b10b000e006')
  and not exists (select 1 from public.event_competition_programs where event_id = '00000000-0000-0000-0000-0b10b000e006' and rules_profile_key is not null));

-- restart still clears a draft simple setup (E7 belongs to studio B; use a fresh simple setup on E6 after restart)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_ok('restart clears the template setup',
  $q$select public.restart_event_competition_setup('00000000-0000-0000-0000-0b10b000e006', 'RESTART COMPETITION')$q$);
select pg_temp.expect_ok('simple creation works after a restart',
  $q$insert into t_ids select 'restart', public.create_simple_competition('00000000-0000-0000-0000-0b10b000e006', (select spec from t_specs where k = 'restart'))$q$);
select pg_temp.expect_ok('restart clears a draft simple setup (profile columns do not block deletion)',
  $q$select public.restart_event_competition_setup('00000000-0000-0000-0000-0b10b000e006', 'RESTART COMPETITION')$q$);
reset role;
select pg_temp.chk('restart left no program, category, division or round on that event',
  pg_temp.n('event_competition_programs', '00000000-0000-0000-0000-0b10b000e006') = 0
  and pg_temp.n('event_competition_contests', '00000000-0000-0000-0000-0b10b000e006') = 0
  and pg_temp.n('event_competition_divisions', '00000000-0000-0000-0000-0b10b000e006') = 0
  and pg_temp.n('event_competition_rounds', '00000000-0000-0000-0000-0b10b000e006') = 0);

-- ============================================================================
-- PROFILE VERSIONS (run last: retiring v1 stops new v1 competitions)
-- ============================================================================
-- later changes to the profile never reach a published competition. The hypothetical next version is the
-- next free one (studio_simple@2 is the real 10C.5 Studio / Custom profile).
select set_config('p10b.next_version', (select (max(version) + 1)::text from public.competition_rules_profiles where profile_key = 'studio_simple'), true);
insert into public.competition_rules_profiles (profile_key, version, name, status, defaults)
select profile_key, current_setting('p10b.next_version')::integer, 'Studio Competition v2', 'active',
       jsonb_set(jsonb_set(defaults, '{judging,ratings,bands}', '["Platinum","Gold"]'::jsonb), '{label}', '"Studio Competition v2"'::jsonb)
from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 1;
update public.competition_rules_profiles set status = 'retired' where profile_key = 'studio_simple' and version = 1;
select pg_temp.chk('a new profile version and retiring v1 leave the published snapshot and version untouched',
  (select l.snapshot = (select snap from t_snapshot_before) and p.rules_profile_version = (select ver from t_snapshot_before) and p.rules_profile_version = 1
   from public.event_competition_programs p join public.event_competition_program_locks l on l.program_id = p.id
   where p.id = (select v from t_ids where k = 'main'))
  and (select l.snapshot #> '{defaults,judging,ratings,bands}' = '["Gold","Silver","Bronze"]'::jsonb
       from public.event_competition_program_locks l where l.program_id = (select v from t_ids where k = 'main')));
select pg_temp.expect_fail('a retired profile version cannot be reactivated',
  $q$update public.competition_rules_profiles set status = 'active' where profile_key = 'studio_simple' and version = 1$q$, '42501');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000001","role":"authenticated"}', true);
select pg_temp.expect_msg('new competitions can no longer be created on a retired version',
  $q$select public.create_simple_competition('00000000-0000-0000-0000-0b10b000e008', pg_temp.spec('studio_competition', 'placements', 'req-v1-retired',
     '[{"type":"solo","price":5}]'::jsonb, '[{"name":"Open"}]'::jsonb, 1))$q$, 'unsupported competition profile');
select pg_temp.expect_ok('new competitions record the new version explicitly',
  $q$insert into t_ids select 'v2', public.create_simple_competition('00000000-0000-0000-0000-0b10b000e008', pg_temp.spec('studio_competition', 'placements', 'req-v2-active',
     '[{"type":"solo","price":5}]'::jsonb, '[{"name":"Open"}]'::jsonb, current_setting('p10b.next_version')::integer))$q$);
reset role;
select pg_temp.chk('the new competition carries the new version while the published one stays @1',
  (select rules_profile_version from public.event_competition_programs where id = (select v from t_ids where k = 'v2')) = current_setting('p10b.next_version')::integer
  and (select rules_profile_version from public.event_competition_programs where id = (select v from t_ids where k = 'main')) = 1);

-- ============================================================================
-- Other tenants and the 10A foundation
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0b10b0000004","role":"authenticated"}', true);
select pg_temp.chk('another studio sees no categories, divisions or lock snapshots of this studio''s competition',
  not exists (select 1 from public.event_competition_contests where event_id = '00000000-0000-0000-0000-0b10b000e001')
  and not exists (select 1 from public.event_competition_divisions where event_id = '00000000-0000-0000-0000-0b10b000e001')
  and not exists (select 1 from public.event_competition_program_locks where event_id = '00000000-0000-0000-0000-0b10b000e001'));
select pg_temp.chk('anonymous visitors have no access to lock snapshots',
  not has_table_privilege('anon', 'public.event_competition_program_locks', 'SELECT'));
select pg_temp.expect_msg('another studio cannot publish this studio''s competition',
  $q$select public.publish_competition_program((select v from t_ids where k = 'callbacks'))$q$, 'cannot be managed');
reset role;

select pg_temp.chk('10A foundation intact: no creator-only authority, no anon helper execute, lock ledger present',
  not has_function_privilege('anon', 'public.can_manage_event_competition(uuid)', 'EXECUTE')
  and to_regclass('public.event_competition_heat_lock_events') is not null
  and not exists (select 1 from pg_proc where proname = 'can_manage_event_competition' and prosrc like '%created_by%'));
select pg_temp.chk('the public registration feature flag is not touched by the database (no registration opened anywhere in this suite)',
  not exists (select 1 from public.event_competition_contest_registration_rules where event_id::text like '00000000-0000-0000-0000-0b10b000e%' and registration_open));

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
    raise exception 'PHASE 10B SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'PHASE 10B SQL SUITE FAIL: %', v_failures;
end $$;

rollback;

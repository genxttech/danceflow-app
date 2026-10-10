-- Phase 10C.5 -- Competition Setup Wizard draft generator regression suite.
--
-- Covers 20261113090000_phase10c5_competition_draft.sql: studio_simple@2, create_competition_draft,
-- set_competition_category_pricing and the pricing-pending guard in open_competition_registration.
-- Calls run as the authenticated studio owner (or an outsider) through the real RPCs. One transaction;
-- the final block ALWAYS raises, so nothing persists:
--   "PHASE 10C.5 SQL SUITE PASS (<n> checks)"  or  "PHASE 10C.5 SQL SUITE FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_ids (k text primary key, v uuid) on commit drop;
grant all on t_ids to authenticated, anon, service_role;
create temp table t_out (k text primary key, v jsonb) on commit drop;
grant all on t_out to authenticated, anon, service_role;

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
end $$;

create or replace function pg_temp.u(p_suffix text) returns uuid
language sql immutable as $$ select ('00000000-0000-0000-0000-0c10c5' || p_suffix)::uuid $$;
create or replace function pg_temp.id(p_k text) returns uuid
language sql stable as $$ select v from t_ids where k = p_k $$;
create or replace function pg_temp.n(p_sql text) returns bigint
language plpgsql as $$ declare r bigint; begin execute p_sql into r; return r; end $$;
create or replace function pg_temp.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- The reviewed full request: Competition + Showcase, adjudicated (placements). Country uses every pricing
-- model (per dance, per entry, included in a registration fee, configure later) and a custom dance.
create or replace function pg_temp.spec(p_key text) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'request_key', p_key, 'profile_key', 'studio_simple', 'profile_version', 2,
    'purpose', 'competition_showcase', 'adjudication', 'adjudicated',
    'answers', '{"version": 1, "purpose": "competition_showcase", "styles": ["country"]}'::jsonb,
    'registration', '{"opens_at": "2026-01-01T00:00:00Z", "closes_at": "2030-01-01T00:00:00Z", "account_required": false}'::jsonb,
    'programs', $j$[
      {"key": "country", "name": "P10C5 Comp — Country", "judging": "placements", "registration_fee": 40,
       "dances": [{"key": "two_step", "name": "Two Step", "category": "Country"},
                  {"key": "waltz", "name": "Waltz", "category": "Country"},
                  {"key": "custom_line_polka", "name": "Line Polka", "category": "Custom"}],
       "categories": [
         {"type": "pro_am", "divisions": [{"name": "Newcomer", "skill_label": "Newcomer"}, {"name": "Bronze", "skill_label": "Bronze"}],
          "dances": ["two_step", "waltz"], "pricing": {"model": "per_dance", "amount": 25}},
         {"type": "pro_pro", "divisions": [{"name": "Open", "skill_label": "Open"}], "dances": ["two_step"],
          "pricing": {"model": "per_entry", "amount": 60}},
         {"type": "couples", "divisions": [{"name": "Newcomer · Adult", "skill_label": "Newcomer", "age_label": "Adult"}],
          "dances": ["custom_line_polka"], "pricing": {"model": "included", "amount": null}},
         {"type": "team", "divisions": [{"name": "Open", "skill_label": "Open"}], "dances": [],
          "pricing": {"model": "later", "amount": null}}]},
      {"key": "showcase", "name": "P10C5 Comp — Showcase", "judging": "non_adjudicated", "registration_fee": null, "dances": [],
       "categories": [{"type": "showcase", "divisions": [{"name": "Open", "skill_label": "Open"}], "dances": [],
                       "pricing": {"model": "free", "amount": null}}]}
    ]$j$::jsonb);
$$;

create or replace function pg_temp.draft(p_event text, p_spec jsonb) returns text
language sql as $$ select format('select public.create_competition_draft(%L, %L::jsonb)', pg_temp.u(p_event), p_spec) $$;
create or replace function pg_temp.bad(p_key text, p_path text[], p_value jsonb) returns jsonb
language sql as $$ select jsonb_set(pg_temp.spec(p_key), p_path, p_value) $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- ============================================================================
-- Fixtures (as postgres)
-- ============================================================================
insert into auth.users (id, email) values
  (pg_temp.u('000001'), 't-p10c5-owner@example.test'), (pg_temp.u('000002'), 't-p10c5-outsider@example.test');
insert into public.profiles (id, email, full_name) values
  (pg_temp.u('000001'), 't-p10c5-owner@example.test', 'Owner'), (pg_temp.u('000002'), 't-p10c5-outsider@example.test', 'Outsider');
insert into public.studios (id, name, slug) values (pg_temp.u('00a001'), 'P10C5 Studio', 't-p10c5-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('000001'), pg_temp.u('00a001'), 'studio_owner', true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility,
                           registration_required, account_required_for_registration)
select pg_temp.u('00e00' || n), pg_temp.u('00a001'), 'P10C5 Event ' || n, 't-p10c5-e' || n, 'competition',
       current_date + 30, current_date + 30, 'published', 'public', false, true
from generate_series(1, 7) n;

select pg_temp.chk('v1 profile is untouched and v2 is the active Studio / Custom profile (schema 2)',
  (select md5(defaults::text) from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 1) = '6e4b7ef21ca994c863f5d2de15f1c935'
  and (select status = 'active' and name = 'Studio / Custom Rules' and defaults->>'schema' = '2' and defaults #>> '{sanction,claimable}' = 'false'
       from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 2));
select pg_temp.chk('v2 entry formats are profile-derived per discipline',
  (select defaults #> '{programs,country,formats}' = '["pro_am","pro_pro","couples","solo","team"]'::jsonb
      and not (defaults #> '{programs,country,formats}' ? 'professional')
      and defaults #> '{programs,ballroom,formats}' ? 'professional'
      and not (defaults #> '{programs,west_coast_swing,formats}' ? 'professional')
      and defaults #> '{programs,west_coast_swing,formats}' ? 'jack_and_jill'
      and defaults #> '{programs,custom,formats}' ? 'professional'
      and defaults #>> '{programs,showcase,adjudication}' = 'non_adjudicated'
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 2));
select pg_temp.expect_msg('v2 is append-only (defaults cannot change)',
  $q$update public.competition_rules_profiles set defaults = defaults || '{"x": 1}' where profile_key = 'studio_simple' and version = 2$q$,
  'append-only');

-- ============================================================================
-- Authorization
-- ============================================================================
select pg_temp.chk('anon cannot execute the 10C.5 functions',
  not has_function_privilege('anon', 'public.create_competition_draft(uuid, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_competition_category_pricing(uuid, text, numeric)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.create_competition_draft(uuid, jsonb)', 'EXECUTE'));
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('an outsider cannot create a draft', pg_temp.draft('00e001', pg_temp.spec('outsider-key-1')), 'cannot be managed');
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_msg('no session cannot create a draft', pg_temp.draft('00e001', pg_temp.spec('nosession-key')), 'cannot be managed');

-- ============================================================================
-- Rejections on an empty event (nothing written)
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('v1 profile is refused by the draft generator',
  pg_temp.draft('00e002', pg_temp.spec('reject-v1-key') || '{"profile_version": 1}'), 'Unsupported competition profile');
select pg_temp.expect_msg('unknown profile version is refused',
  pg_temp.draft('00e002', pg_temp.spec('reject-v9-key') || '{"profile_version": 9}'), 'Unsupported competition profile');
select pg_temp.expect_msg('a request key is required', pg_temp.draft('00e002', pg_temp.spec('bad key!')), 'request key');
select pg_temp.expect_msg('unknown purpose is refused', pg_temp.draft('00e002', pg_temp.spec('reject-purpose') || '{"purpose": "gala"}'), 'Choose what you are creating');
select pg_temp.expect_msg('unknown adjudication is refused', pg_temp.draft('00e002', pg_temp.spec('reject-adjud') || '{"adjudication": "sanctioned"}'), 'Adjudicated or Non-Adjudicated');
select pg_temp.expect_msg('Professional is not a Country format',
  pg_temp.draft('00e002', pg_temp.bad('reject-pro-country', '{programs,0,categories,1,type}', '"professional"')), 'not available for Country');
select pg_temp.expect_msg('unknown program key is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-program', '{programs,0,key}', '"ucwdc_country"')), 'not available');
select pg_temp.expect_msg('per-dance pricing is refused for a routine format',
  pg_temp.draft('00e002', pg_temp.bad('reject-routine-pd', '{programs,1,categories,0,pricing}', '{"model": "per_dance", "amount": 10}')), 'Choose how Showcase routine is priced');
select pg_temp.expect_msg('per-dance pricing needs a price',
  pg_temp.draft('00e002', pg_temp.bad('reject-noprice', '{programs,0,categories,0,pricing}', '{"model": "per_dance", "amount": null}')), 'Enter a price');
select pg_temp.expect_msg('a zero per-entry price is refused (choose Free instead)',
  pg_temp.draft('00e002', pg_temp.bad('reject-zeroprice', '{programs,0,categories,1,pricing}', '{"model": "per_entry", "amount": 0}')), 'valid price');
select pg_temp.expect_msg('sub-cent prices are refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-subcent', '{programs,0,categories,1,pricing}', '{"model": "per_entry", "amount": 1.234}')), 'valid price');
select pg_temp.expect_msg('a free category cannot carry a price',
  pg_temp.draft('00e002', pg_temp.bad('reject-freeprice', '{programs,1,categories,0,pricing}', '{"model": "free", "amount": 5}')), 'only entered');
select pg_temp.expect_msg('included pricing needs a registration fee',
  pg_temp.draft('00e002', pg_temp.bad('reject-nofee', '{programs,0,registration_fee}', 'null')), 'registration fee');
select pg_temp.expect_msg('a registration fee without included entries is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-strayfee', '{programs,1,registration_fee}', '15')), 'only used when entries are included');
select pg_temp.expect_msg('a dance outside the pool is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-pooldance', '{programs,0,dances,0,key}', '"smooth_tango"')), 'not available for Country');
select pg_temp.expect_msg('a category dance must be one of the program dances',
  pg_temp.draft('00e002', pg_temp.bad('reject-catdance', '{programs,0,categories,0,dances}', '["two_step", "polka"]')), 'not part of Country');
select pg_temp.expect_msg('unused program dances are refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-unused', '{programs,0,dances}',
    '[{"key": "two_step"}, {"key": "waltz"}, {"key": "custom_line_polka", "name": "Line Polka"}, {"key": "polka"}]')), 'no entry format');
select pg_temp.expect_msg('a routine format cannot list dances',
  pg_temp.draft('00e002', pg_temp.bad('reject-teamdance', '{programs,0,categories,3,dances}', '["two_step"]')), 'does not use individual dances');
select pg_temp.expect_msg('duplicate division names are refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-dupdiv', '{programs,0,categories,0,divisions}', '[{"name": "Bronze"}, {"name": "bronze"}]')), 'unique');
select pg_temp.expect_msg('more than the per-format division limit is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-manydiv', '{programs,0,categories,1,divisions}',
    (select jsonb_agg(jsonb_build_object('name', 'Level ' || n)) from generate_series(1, 31) n))), 'between 1 and 30 divisions');
select pg_temp.expect_msg('duplicate entry formats are refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-dupfmt', '{programs,0,categories,1,type}', '"pro_am"')), 'once per program');
select pg_temp.expect_msg('Competition purpose cannot include a showcase program',
  pg_temp.draft('00e002', pg_temp.spec('reject-purpose-mix') || '{"purpose": "competition"}'), 'do not match');
select pg_temp.expect_msg('Competition + Showcase needs the showcase program',
  pg_temp.draft('00e002', pg_temp.spec('reject-noshowcase') || jsonb_build_object('programs', jsonb_build_array(pg_temp.spec('x') #> '{programs,0}'))), 'do not match');
select pg_temp.expect_msg('adjudicated programs cannot use Non-Adjudicated judging',
  pg_temp.draft('00e002', pg_temp.bad('reject-judging', '{programs,0,judging}', '"non_adjudicated"')), 'Choose how Country is judged');
select pg_temp.expect_msg('the showcase program is always Non-Adjudicated',
  pg_temp.draft('00e002', pg_temp.bad('reject-showjudging', '{programs,1,judging}', '"placements"')), 'Choose how Showcase / Performance is judged');
select pg_temp.expect_msg('custom dances are refused where the program does not allow them',
  pg_temp.draft('00e002', jsonb_build_object('request_key', 'reject-wcs-custom', 'profile_key', 'studio_simple', 'profile_version', 2,
    'purpose', 'competition', 'adjudication', 'adjudicated', 'registration', '{"opens_at": null, "closes_at": null, "account_required": true}'::jsonb,
    'programs', '[{"key": "west_coast_swing", "name": "WCS", "judging": "placements", "registration_fee": null,
                   "dances": [{"key": "custom_slow_swing", "name": "Slow Swing"}],
                   "categories": [{"type": "jack_and_jill", "divisions": [{"name": "Novice"}], "dances": ["custom_slow_swing"],
                                   "pricing": {"model": "per_entry", "amount": 15}}]}]'::jsonb)), 'not available for West Coast Swing');
select pg_temp.expect_msg('registration cannot close before it opens',
  pg_temp.draft('00e002', pg_temp.bad('reject-window', '{registration,closes_at}', '"2025-01-01T00:00:00Z"')), 'close before it opens');
select pg_temp.expect_msg('invalid registration dates are refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-date', '{registration,opens_at}', '"2026-13-45T00:00:00Z"')), 'valid dates');
select pg_temp.chk('rejected requests wrote nothing (no programs; event registration unchanged)',
  pg_temp.n($q$select count(*) from public.event_competition_programs where event_id = pg_temp.u('00e002')$q$) = 0
  and (select not registration_required and account_required_for_registration and registration_opens_at is null
       from public.events where id = pg_temp.u('00e002')));

-- ============================================================================
-- The reviewed request: one transaction, one program per discipline + a showcase program
-- ============================================================================
select pg_temp.expect_ok('the full Competition + Showcase draft is created',
  $q$insert into t_out select 'first', public.create_competition_draft(pg_temp.u('00e001'), pg_temp.spec('p10c5-request-0001'))$q$);
reset role;
insert into t_ids select 'country', p.id from public.event_competition_programs p where p.event_id = pg_temp.u('00e001') and p.configuration #>> '{setup,program_key}' = 'country';
insert into t_ids select 'showcase', p.id from public.event_competition_programs p where p.event_id = pg_temp.u('00e001') and p.configuration #>> '{setup,program_key}' = 'showcase';
insert into t_ids select 'c_' || (c.configuration #>> '{simple,category_type}'), c.id from public.event_competition_contests c where c.event_id = pg_temp.u('00e001');
insert into t_ids select 'd_couples', d.id from public.event_competition_divisions d where d.contest_id = pg_temp.id('c_couples') order by d.sort_order limit 1;
insert into t_ids select 'o_couples', dd.id from public.event_competition_division_dances dd where dd.division_id = pg_temp.id('d_couples') order by dd.sort_order limit 1;

select pg_temp.chk('result lists both programs in order, not replayed, pricing pending',
  (select v->'program_ids' = jsonb_build_array(pg_temp.id('country'), pg_temp.id('showcase'))
          and v->>'replayed' = 'false' and v->>'pricing_pending' = 'true' from t_out where k = 'first'),
  (select v::text from t_out where k = 'first'));
select pg_temp.chk('programs are unpublished drafts with registration CLOSED on profile v2',
  pg_temp.n($q$select count(*) from public.event_competition_programs where event_id = pg_temp.u('00e001')
               and status = 'draft' and registration_status = 'closed' and profile_locked_at is null
               and rules_profile_key = 'studio_simple' and rules_profile_version = 2$q$) = 2);
select pg_temp.chk('Country program: adjudicated placements (relative / ordinal_majority)',
  (select name = 'P10C5 Comp — Country' and discipline_family = 'country' and competition_mode = 'relative'
          and scoring_method = 'ordinal_majority' and sort_order = 10
   from public.event_competition_programs where id = pg_temp.id('country')));
select pg_temp.chk('Showcase program: Non-Adjudicated maps to exhibition with no scoring',
  (select discipline_family = 'showcase' and competition_mode = 'exhibition' and scoring_method = 'none'
          and advancement_method = 'none' and sort_order = 20 and configuration #>> '{setup,adjudication}' = 'non_adjudicated'
   from public.event_competition_programs where id = pg_temp.id('showcase')));
select pg_temp.chk('program configuration stores the request, judging and answers snapshot',
  (select configuration #>> '{simple,request_key}' = 'p10c5-request-0001' and configuration #>> '{simple,judging}' = 'placements'
          and configuration #>> '{simple,created_with}' = 'setup_wizard'
          and configuration #>> '{setup,request_hash}' = md5(pg_temp.spec('p10c5-request-0001')::text)
          and configuration #> '{setup,answers}' = pg_temp.spec('x')->'answers'
          and configuration #>> '{setup,purpose}' = 'competition_showcase' and configuration #>> '{setup,registration_fee}' = '40'
   from public.event_competition_programs where id = pg_temp.id('country')));
select pg_temp.chk('categories carry the profile entry formats and participant / lead-follow rules',
  (select string_agg(entry_format || ':' || name, ',' order by sort_order) from public.event_competition_contests where program_id = pg_temp.id('country'))
    = 'pro_am:ProAm,pro_pro:ProPro,couple:Couples,team:Team'
  and (select configuration #> '{setup,participant_roles}' = '["instructor","professional"]'::jsonb and configuration #>> '{setup,dance_roles}' = 'pair'
       from public.event_competition_contests where id = pg_temp.id('c_pro_pro'))
  and (select entry_format from public.event_competition_contests where id = pg_temp.id('c_showcase')) = 'custom');
select pg_temp.chk('registration rules: per dance / per entry / included / later / free',
  (select string_agg(c.configuration #>> '{simple,category_type}' || ':' || r.pricing_method || ':' || r.base_entry_fee::text || ':' || r.registration_open::text, ',' order by p.sort_order, c.sort_order)
   from public.event_competition_contests c join public.event_competition_programs p on p.id = c.program_id
   join public.event_competition_contest_registration_rules r on r.contest_id = c.id where c.event_id = pg_temp.u('00e001'))
    = 'pro_am:per_dance:0.00:false,pro_pro:flat_entry:60.00:false,couples:flat_entry:0.00:false,team:flat_entry:0.00:false,showcase:flat_entry:0.00:false',
  (select string_agg(c.configuration #>> '{simple,category_type}' || ':' || r.pricing_method || ':' || r.base_entry_fee::text, ',')
   from public.event_competition_contests c join public.event_competition_contest_registration_rules r on r.contest_id = c.id where c.event_id = pg_temp.u('00e001')));
select pg_temp.chk('per-dance offerings carry the price; other offerings are 0',
  (select string_agg(c.configuration #>> '{simple,category_type}' || ':' || dd.entry_fee::text, ',' order by c.sort_order, d.sort_order, dd.sort_order)
   from public.event_competition_division_dances dd join public.event_competition_divisions d on d.id = dd.division_id
   join public.event_competition_contests c on c.id = d.contest_id where dd.event_id = pg_temp.u('00e001'))
    = 'pro_am:25.00,pro_am:25.00,pro_am:25.00,pro_am:25.00,pro_pro:0.00,couples:0.00');
select pg_temp.chk('dances: pool names and categories (client labels ignored) plus the custom dance',
  (select string_agg(dance_key || '=' || name || '/' || coalesce(category_label, ''), ',' order by sort_order)
   from public.event_competition_dances where program_id = pg_temp.id('country'))
    = 'two_step=Two Step/Partner,waltz=Waltz/Partner,custom_line_polka=Line Polka/Custom'
  and pg_temp.n($q$select count(*) from public.event_competition_dances where program_id = pg_temp.id('showcase')$q$) = 0);
select pg_temp.chk('divisions per entry format with level and age labels',
  (select string_agg(c.configuration #>> '{simple,category_type}' || ':' || d.name || ':' || coalesce(d.skill_label, '-') || ':' || coalesce(d.age_label, '-'), ',' order by p.sort_order, c.sort_order, d.sort_order)
   from public.event_competition_divisions d join public.event_competition_contests c on c.id = d.contest_id
   join public.event_competition_programs p on p.id = d.program_id where d.event_id = pg_temp.u('00e001'))
    = 'pro_am:Newcomer:Newcomer:-,pro_am:Bronze:Bronze:-,pro_pro:Open:Open:-,couples:Newcomer · Adult:Newcomer:Adult,team:Open:Open:-,showcase:Open:Open:-');
select pg_temp.chk('Final only: one Final per adjudicated division, one Performance per showcase division',
  (select string_agg(p.configuration #>> '{setup,program_key}' || ':' || r.name || ':' || r.round_type || ':' || r.scoring_method || ':' || r.sequence_number, ',' order by p.sort_order, r.round_type)
   from (select distinct on (r.program_id) r.* from public.event_competition_rounds r where r.event_id = pg_temp.u('00e001') order by r.program_id) r
   join public.event_competition_programs p on p.id = r.program_id)
    = 'country:Final:final:ordinal_majority:1,showcase:Performance:exhibition:none:1'
  and pg_temp.n($q$select count(*) from public.event_competition_rounds where event_id = pg_temp.u('00e001')$q$) = 6
  and pg_temp.n($q$select count(*) from public.event_competition_divisions d where d.event_id = pg_temp.u('00e001')
                   and (select count(*) from public.event_competition_rounds r where r.division_id = d.id) <> 1$q$) = 0);
select pg_temp.chk('included pricing creates one program-scoped per-person registration fee rule',
  (select count(*) = 1 and min(calculation_type) = 'flat_per_person' and min(amount) = 40 and bool_and(program_id = pg_temp.id('country'))
          and bool_and(contest_id is null) and bool_and(active)
   from public.event_competition_fee_rules where event_id = pg_temp.u('00e001')));
select pg_temp.chk('Configure later marks only that category pricing-pending',
  (select string_agg(configuration #>> '{simple,category_type}' || ':' || (configuration #>> '{setup,pricing_pending}'), ',' order by program_id = pg_temp.id('showcase'), sort_order)
   from public.event_competition_contests where event_id = pg_temp.u('00e001'))
    = 'pro_am:false,pro_pro:false,couples:false,team:true,showcase:false');
select pg_temp.chk('registration basics are saved on the event',
  (select registration_required and not account_required_for_registration
          and registration_opens_at = '2026-01-01T00:00:00Z' and registration_closes_at = '2030-01-01T00:00:00Z'
   from public.events where id = pg_temp.u('00e001')));

-- ============================================================================
-- Idempotency and the per-event setup lock
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('replaying the same request succeeds',
  $q$insert into t_out select 'replay', public.create_competition_draft(pg_temp.u('00e001'), pg_temp.spec('p10c5-request-0001'))$q$);
select pg_temp.chk('replay returns the same programs and creates nothing',
  (select v->'program_ids' = (select v->'program_ids' from t_out where k = 'first') and v->>'replayed' = 'true' from t_out where k = 'replay')
  and pg_temp.n($q$select count(*) from public.event_competition_programs where event_id = pg_temp.u('00e001')$q$) = 2
  and pg_temp.n($q$select count(*) from public.event_competition_divisions where event_id = pg_temp.u('00e001')$q$) = 6);
select pg_temp.expect_msg('the same request key with different choices fails safely',
  pg_temp.draft('00e001', pg_temp.bad('p10c5-request-0001', '{programs,0,categories,1,pricing,amount}', '65')), 'different choices');
select pg_temp.expect_msg('a new request cannot add a second setup to the event',
  pg_temp.draft('00e001', pg_temp.spec('p10c5-request-0002')), 'already has competition setup');
select pg_temp.chk('the generator shares the 10B per-event advisory lock',
  position($s$hashtext(p_event_id::text || ':simple_competition')$s$ in pg_get_functiondef('public.create_competition_draft(uuid,jsonb)'::regprocedure)) > 0
  and position($s$hashtext(target_event_id::text || ':simple_competition')$s$ in pg_get_functiondef('public.create_simple_competition(uuid,jsonb)'::regprocedure)) > 0);

-- ============================================================================
-- Publish, pricing-pending guard, pricing completion, open, quote
-- ============================================================================
select pg_temp.expect_ok('the Country draft publishes with the existing publish authority',
  $q$select public.publish_competition_program(pg_temp.id('country'))$q$);
select pg_temp.expect_msg('open registration is refused while pricing is pending',
  $q$select public.open_competition_registration(pg_temp.id('country'))$q$, 'Pricing requires completion before registration can open.');
select pg_temp.chk('the refused open changed nothing',
  (select registration_status = 'closed' from public.event_competition_programs where id = pg_temp.id('country'))
  and pg_temp.n($q$select count(*) from public.event_competition_contests where program_id = pg_temp.id('country') and status <> 'draft'$q$) = 0);
select pg_temp.expect_msg('pricing completion refuses Configure later',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_team'), 'later', null)$q$, 'pricing option available');
select pg_temp.expect_msg('pricing completion refuses a model the format does not allow',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_team'), 'per_dance', 10)$q$, 'pricing option available');
select pg_temp.expect_msg('pricing completion refuses a zero price',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_team'), 'per_entry', 0)$q$, 'valid price');
select pg_temp.expect_msg('pricing completion refuses sub-cent prices',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_team'), 'per_entry', 30.001)$q$, 'valid price');
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('an outsider cannot complete pricing',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_team'), 'per_entry', 30)$q$, 'cannot be managed');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('pricing completion sets the Team price',
  $q$insert into t_out select 'priced', public.set_competition_category_pricing(pg_temp.id('c_team'), 'per_entry', 30)$q$);
select pg_temp.chk('pricing completion clears the flag and writes the rule',
  (select v->>'pricing_pending' = 'false' from t_out where k = 'priced')
  and (select configuration #>> '{setup,pricing_pending}' = 'false' and configuration #>> '{setup,pricing_model}' = 'per_entry'
       from public.event_competition_contests where id = pg_temp.id('c_team'))
  and (select pricing_method = 'flat_entry' and base_entry_fee = 30 from public.event_competition_contest_registration_rules where contest_id = pg_temp.id('c_team')));
select pg_temp.expect_ok('pricing completion can switch ProAm to per-entry on a published draft',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_pro_am'), 'per_entry', 45)$q$);
select pg_temp.chk('switching to per-entry zeroes the per-dance offerings',
  (select pricing_method = 'flat_entry' and base_entry_fee = 45 from public.event_competition_contest_registration_rules where contest_id = pg_temp.id('c_pro_am'))
  and pg_temp.n($q$select count(*) from public.event_competition_division_dances dd join public.event_competition_divisions d on d.id = dd.division_id
                   where d.contest_id = pg_temp.id('c_pro_am') and dd.entry_fee <> 0$q$) = 0);
select pg_temp.expect_ok('switching back to per-dance restores offering prices',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_pro_am'), 'per_dance', 25)$q$);
select pg_temp.chk('per-dance completion prices every offering and zeroes the base fee',
  (select pricing_method = 'per_dance' and base_entry_fee = 0 from public.event_competition_contest_registration_rules where contest_id = pg_temp.id('c_pro_am'))
  and pg_temp.n($q$select count(*) from public.event_competition_division_dances dd join public.event_competition_divisions d on d.id = dd.division_id
                   where d.contest_id = pg_temp.id('c_pro_am') and dd.entry_fee = 25$q$) = 4);
select pg_temp.expect_ok('open registration succeeds once pricing is complete',
  $q$select public.open_competition_registration(pg_temp.id('country'))$q$);
select pg_temp.chk('registration is open for every Country category',
  (select registration_status = 'open' from public.event_competition_programs where id = pg_temp.id('country'))
  and pg_temp.n($q$select count(*) from public.event_competition_contest_registration_rules where program_id = pg_temp.id('country') and registration_open$q$) = 4);
select pg_temp.expect_msg('pricing cannot change while registration is open',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_team'), 'free', null)$q$, 'Close registration');
reset role;
select pg_temp.chk('the included registration fee is charged once per competitor in the quote',
  (select (q->>'valid')::boolean and (q->>'total_cents')::bigint = 8000
          and exists (select 1 from jsonb_array_elements(q->'lines') l where l->>'lineType' = 'fee' and (l->>'unitCents')::bigint = 4000
                      and (l->>'quantity')::int = 2 and (l->>'lineCents')::bigint = 8000)
   from (select public._comp10c_quote(pg_temp.u('00e001'), jsonb_build_object(
           'registrationMode', 'individual', 'buyerName', 'Quote Buyer', 'buyerEmail', 'quote@example.test',
           'people', '[{"clientId": "x", "firstName": "Xi", "lastName": "Lead", "personType": "dancer"},
                       {"clientId": "y", "firstName": "Yo", "lastName": "Follow", "personType": "dancer"}]'::jsonb,
           'entries', jsonb_build_array(jsonb_build_object('clientId', 'e1', 'programId', pg_temp.id('country'), 'contestId', pg_temp.id('c_couples'),
             'divisionId', pg_temp.id('d_couples'), 'participantIds', '["x", "y"]'::jsonb,
             'participantRoles', '{"x": "dancer", "y": "dancer"}'::jsonb, 'participantDanceRoles', '{"x": "leader", "y": "follower"}'::jsonb,
             'selectedOfferingIds', jsonb_build_array(pg_temp.id('o_couples'))))), now()) as q) s),
  (select q::text from (select public._comp10c_quote(pg_temp.u('00e001'), jsonb_build_object(
           'registrationMode', 'individual', 'buyerName', 'Quote Buyer', 'buyerEmail', 'quote@example.test',
           'people', '[{"clientId": "x", "firstName": "Xi", "lastName": "Lead", "personType": "dancer"},
                       {"clientId": "y", "firstName": "Yo", "lastName": "Follow", "personType": "dancer"}]'::jsonb,
           'entries', jsonb_build_array(jsonb_build_object('clientId', 'e1', 'programId', pg_temp.id('country'), 'contestId', pg_temp.id('c_couples'),
             'divisionId', pg_temp.id('d_couples'), 'participantIds', '["x", "y"]'::jsonb,
             'participantRoles', '{"x": "dancer", "y": "dancer"}'::jsonb, 'participantDanceRoles', '{"x": "leader", "y": "follower"}'::jsonb,
             'selectedOfferingIds', jsonb_build_array(pg_temp.id('o_couples'))))), now()) as q) s));
select pg_temp.chk('the guard applies only to pricing-pending categories (open path untouched otherwise)',
  position('COMP10C_PRICING_PENDING' in pg_get_functiondef('public.open_competition_registration(uuid)'::regprocedure)) > 0
  and position('COMP10C_NOT_PUBLISHED' in pg_get_functiondef('public.open_competition_registration(uuid)'::regprocedure)) > 0);

-- A category flagged pending by any path (e.g. an Advanced edit) still blocks opening.
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('the showcase program publishes', $q$select public.publish_competition_program(pg_temp.id('showcase'))$q$);
reset role;
update public.event_competition_contests set configuration = jsonb_set(configuration, '{setup,pricing_pending}', 'true') where id = pg_temp.id('c_showcase');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a pending flag set outside the wizard also blocks opening',
  $q$select public.open_competition_registration(pg_temp.id('showcase'))$q$, 'Pricing requires completion');
select pg_temp.expect_ok('Free completes the showcase pricing', $q$select public.set_competition_category_pricing(pg_temp.id('c_showcase'), 'free', null)$q$);
select pg_temp.expect_ok('the showcase program then opens', $q$select public.open_competition_registration(pg_temp.id('showcase'))$q$);

-- ============================================================================
-- Other purposes and disciplines
-- ============================================================================
select pg_temp.expect_ok('Showcase-only creates one Non-Adjudicated showcase program',
  pg_temp.draft('00e003', jsonb_build_object('request_key', 'p10c5-showcase-only', 'profile_key', 'studio_simple', 'profile_version', 2,
    'purpose', 'showcase', 'adjudication', 'non_adjudicated', 'answers', '{}'::jsonb,
    'registration', '{"opens_at": null, "closes_at": null, "account_required": true}'::jsonb,
    'programs', jsonb_build_array(pg_temp.spec('x') #> '{programs,1}'))));
select pg_temp.chk('Showcase-only program shape',
  (select count(*) = 1 and min(competition_mode) = 'exhibition' and min(discipline_family) = 'showcase'
   from public.event_competition_programs where event_id = pg_temp.u('00e003'))
  and (select account_required_for_registration and registration_opens_at is null from public.events where id = pg_temp.u('00e003')));
select pg_temp.expect_ok('a Non-Adjudicated WCS competition keeps Jack & Jill',
  pg_temp.draft('00e004', jsonb_build_object('request_key', 'p10c5-wcs-nonadj', 'profile_key', 'studio_simple', 'profile_version', 2,
    'purpose', 'competition', 'adjudication', 'non_adjudicated', 'answers', '{}'::jsonb,
    'registration', '{"opens_at": null, "closes_at": null, "account_required": false}'::jsonb,
    'programs', '[{"key": "west_coast_swing", "name": "WCS Social", "judging": "non_adjudicated", "registration_fee": null,
                   "dances": [{"key": "west_coast_swing"}],
                   "categories": [{"type": "jack_and_jill", "divisions": [{"name": "Novice", "skill_label": "Novice"}],
                                   "dances": ["west_coast_swing"], "pricing": {"model": "per_entry", "amount": 15}}]}]'::jsonb)));
select pg_temp.chk('Non-Adjudicated competition: exhibition mode, Performance round, prescribed dance',
  (select p.competition_mode = 'exhibition' and p.scoring_method = 'none' and c.entry_format = 'random_partner'
          and r.dance_selection_mode = 'prescribed_set' and r.base_entry_fee = 15
          and (select string_agg(name || ':' || round_type, ',') from public.event_competition_rounds where program_id = p.id) = 'Performance:exhibition'
          and (select bool_and(required) from public.event_competition_division_dances where program_id = p.id)
   from public.event_competition_programs p join public.event_competition_contests c on c.program_id = p.id
   join public.event_competition_contest_registration_rules r on r.contest_id = c.id where p.event_id = pg_temp.u('00e004')));
select pg_temp.expect_ok('Ballroom may include Professional (ratings judging)',
  pg_temp.draft('00e005', jsonb_build_object('request_key', 'p10c5-ballroom-pro', 'profile_key', 'studio_simple', 'profile_version', 2,
    'purpose', 'competition', 'adjudication', 'adjudicated', 'answers', '{}'::jsonb,
    'registration', '{"opens_at": null, "closes_at": null, "account_required": true}'::jsonb,
    'programs', '[{"key": "ballroom", "name": "Ballroom", "judging": "ratings", "registration_fee": null,
                   "dances": [{"key": "smooth_waltz"}],
                   "categories": [{"type": "professional", "divisions": [{"name": "Open"}], "dances": ["smooth_waltz"],
                                   "pricing": {"model": "free", "amount": null}}]}]'::jsonb)));
select pg_temp.chk('Ballroom Professional shape',
  (select p.competition_mode = 'proficiency' and p.scoring_method = 'proficiency_rating' and c.entry_format = 'professional'
          and c.configuration #> '{setup,participant_roles}' = '["professional"]'::jsonb
   from public.event_competition_programs p join public.event_competition_contests c on c.program_id = p.id where p.event_id = pg_temp.u('00e005')));
select pg_temp.expect_ok('multiple disciplines create one program each',
  pg_temp.draft('00e006', jsonb_build_object('request_key', 'p10c5-multi-style', 'profile_key', 'studio_simple', 'profile_version', 2,
    'purpose', 'competition', 'adjudication', 'adjudicated', 'answers', '{}'::jsonb,
    'registration', '{"opens_at": null, "closes_at": null, "account_required": true}'::jsonb,
    'programs', '[{"key": "country", "name": "Multi — Country", "judging": "placements", "registration_fee": null, "dances": [{"key": "two_step"}],
                   "categories": [{"type": "couples", "divisions": [{"name": "Open"}], "dances": ["two_step"], "pricing": {"model": "free", "amount": null}}]},
                  {"key": "west_coast_swing", "name": "Multi — West Coast Swing", "judging": "placements", "registration_fee": null, "dances": [{"key": "west_coast_swing"}],
                   "categories": [{"type": "couples", "divisions": [{"name": "Open"}], "dances": ["west_coast_swing"], "pricing": {"model": "free", "amount": null}}]}]'::jsonb)));
select pg_temp.chk('two discipline programs, both adjudicated, no showcase',
  (select count(*) = 2 and bool_and(competition_mode = 'relative') and string_agg(discipline_family, ',' order by sort_order) = 'country,west_coast_swing'
   from public.event_competition_programs where event_id = pg_temp.u('00e006')));

-- ============================================================================
-- 10B path unchanged
-- ============================================================================
select pg_temp.expect_ok('create_simple_competition still works with studio_simple@1',
  $q$select public.create_simple_competition(pg_temp.u('00e007'), '{"profile_key": "studio_simple", "profile_version": 1,
      "request_key": "p10c5-legacy-0001", "preset": "country", "judging": "placements", "name": "Legacy", "division_preset": "levels_basic",
      "categories": [{"type": "couples", "price": 10, "dances": ["two_step"]}], "divisions": [{"name": "Open"}]}'::jsonb)$q$);
select pg_temp.chk('the legacy program has no setup configuration (no pricing guard impact)',
  (select configuration->'setup' is null and rules_profile_version = 1 from public.event_competition_programs where event_id = pg_temp.u('00e007')));
select pg_temp.expect_msg('create_simple_competition cannot use the schema-2 profile',
  $q$select public.create_simple_competition(pg_temp.u('00e002'), '{"profile_key": "studio_simple", "profile_version": 2,
      "request_key": "p10c5-legacy-0002", "preset": "country", "judging": "placements", "name": "Legacy",
      "categories": [{"type": "couples", "price": 10, "dances": ["two_step"]}], "divisions": [{"name": "Open"}]}'::jsonb)$q$,
  'Unknown competition type');
select pg_temp.expect_msg('pricing completion is not offered for legacy categories',
  format('select public.set_competition_category_pricing(%L, %L, 10)',
    (select c.id from public.event_competition_contests c where c.event_id = pg_temp.u('00e007') limit 1), 'per_dance'), 'Advanced settings');

-- ============================================================================
-- Verdict
-- ============================================================================
reset role;
do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'PHASE 10C.5 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'PHASE 10C.5 SQL SUITE FAIL: %', v_failures;
end $$;

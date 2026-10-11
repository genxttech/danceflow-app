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

-- The reviewed full request: Competition + Showcase / Performance in two styles.
--   Country (adjudicated, Medal Marks): every pricing model, a custom dance, a Showcase judged
--   Non-Adjudicated by override, and a Spotlight that inherits the style's adjudication.
--   Ballroom (adjudicated, Placements): NDCA Pro/Am entered in two dance styles (one category per style,
--   each holding only its style's dances) plus a Cabaret performance that inherits.
create or replace function pg_temp.spec(p_key text) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'request_key', p_key, 'profile_key', 'studio_simple', 'profile_version', 2, 'purpose', 'competition_showcase',
    'answers', '{"version": 4, "purpose": "competition_showcase", "styles": ["country", "ballroom"]}'::jsonb,
    'registration', '{"opens_at": "2026-01-01T00:00:00Z", "closes_at": "2030-01-01T00:00:00Z", "account_required": false}'::jsonb,
    'programs', $j$[
      {"key": "country", "name": "P10C5 Comp — Country", "adjudication": "adjudicated", "judging": "medal_marks", "registration_fee": 40,
       "dances": [{"key": "two_step", "name": "Two Step", "category": "Country"},
                  {"key": "waltz", "name": "Waltz", "category": "Country"},
                  {"key": "custom_line_polka", "name": "Line Polka", "category": "Custom"}],
       "categories": [
         {"type": "pro_am", "adjudication": "inherit", "divisions": [{"name": "Newcomer", "skill_label": "Newcomer"}, {"name": "Bronze", "skill_label": "Bronze"}],
          "dances": ["two_step", "waltz"], "pricing": {"model": "per_dance", "amount": 25}},
         {"type": "pro_pro", "adjudication": "inherit", "divisions": [{"name": "Open", "skill_label": "Open"}], "dances": ["two_step"],
          "pricing": {"model": "per_entry", "amount": 60}},
         {"type": "couples", "adjudication": "inherit", "divisions": [{"name": "Newcomer · Adult", "skill_label": "Newcomer", "age_label": "Adult", "axes": {"skill_level": "Newcomer", "age_group": "Adult"}}],
          "dances": ["custom_line_polka"], "pricing": {"model": "included", "amount": null}},
         {"type": "team", "adjudication": "inherit", "divisions": [{"name": "Open", "skill_label": "Open"}], "dances": [],
          "pricing": {"model": "later", "amount": null}},
         {"type": "showcase", "adjudication": "non_adjudicated", "divisions": [{"name": "Open", "skill_label": "Open"}], "dances": ["waltz"],
          "pricing": {"model": "free", "amount": null}},
         {"type": "spotlight", "adjudication": "inherit", "divisions": [{"name": "Open", "skill_label": "Open"}], "dances": [],
          "pricing": {"model": "per_entry", "amount": 35}}]},
      {"key": "ballroom", "name": "P10C5 Comp — Ballroom", "adjudication": "adjudicated", "judging": "placements", "registration_fee": null,
       "dances": [{"key": "smooth_waltz", "name": "Waltz", "category": "Smooth"}, {"key": "latin_cha_cha"}],
       "categories": [
         {"type": "ndca_pro_am", "style": "american_smooth", "adjudication": "inherit", "divisions": [{"name": "Bronze", "skill_label": "Bronze", "axes": {"skill_level": "Bronze"}}],
          "dances": ["smooth_waltz"], "pricing": {"model": "per_dance", "amount": 20}},
         {"type": "ndca_cabaret", "adjudication": "inherit", "divisions": [{"name": "Open", "skill_label": "Open"}], "dances": [],
          "pricing": {"model": "free", "amount": null}},
         {"type": "ndca_pro_am", "style": "international_latin", "adjudication": "inherit", "divisions": [{"name": "Bronze", "skill_label": "Bronze", "axes": {"skill_level": "Bronze"}}],
          "dances": ["latin_cha_cha"], "pricing": {"model": "per_dance", "amount": 20}}]}
    ]$j$::jsonb);
$$;

-- A one-style request (for the other purposes / styles).
create or replace function pg_temp.one(p_key text, p_purpose text, p_program jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('request_key', p_key, 'profile_key', 'studio_simple', 'profile_version', 2, 'purpose', p_purpose,
    'answers', '{}'::jsonb, 'registration', '{"opens_at": null, "closes_at": null, "account_required": true}'::jsonb,
    'programs', jsonb_build_array(p_program));
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
from generate_series(1, 8) n;

-- ============================================================================
-- Profile v2
-- ============================================================================
select pg_temp.chk('v1 profile is untouched and v2 is the active Studio / Custom profile (schema 2)',
  (select md5(defaults::text) from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 1) = '6e4b7ef21ca994c863f5d2de15f1c935'
  and (select status = 'active' and name = 'Studio / Custom Rules' and defaults->>'schema' = '2' and defaults #>> '{sanction,claimable}' = 'false'
       from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 2));
select pg_temp.chk('v2 entry formats are profile-derived per style; Showcase-type offerings live inside the style',
  (select defaults #> '{programs,country,formats}' = '["pro_am","pro_pro","couples","showcase","spotlight","solo","team"]'::jsonb
      and defaults #> '{programs,west_coast_swing,formats}' = '["jack_and_jill","wcs_couples","wcs_pro_am","routine"]'::jsonb
      and defaults #> '{programs,custom,formats}' ? 'studio_professional'
      and not (defaults->'programs' ? 'showcase')
      and not exists (select 1 from jsonb_each(defaults->'programs') p where p.value ?| array['recommended_formats', 'recommended_special', 'recommended_dances'])
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 2));
select pg_temp.chk('Ballroom offers NDCA classifications (no generic Couples) in dance styles; no offering is shared across styles',
  (select defaults #> '{programs,ballroom,formats}' ?& array['ndca_pro_am', 'ndca_amateur', 'ndca_mixed_amateur', 'ndca_student_student', 'ndca_professional', 'ndca_mixed_professional']
      and not (defaults #> '{programs,ballroom,formats}' ?| array['couples', 'pro_am', 'professional', 'showcase'])
      and (select string_agg(st->>'key', ',') from jsonb_array_elements(defaults #> '{programs,ballroom,styles}') st)
          = 'international_standard,international_latin,american_smooth,american_rhythm,american_additional'
      and (select count(*) = count(distinct f.value) from jsonb_each(defaults->'programs') p, jsonb_array_elements_text(p.value->'formats') f)
      and defaults #>> '{categoryTypes,couples,origin}' = 'ucwdc' and defaults #>> '{categoryTypes,jack_and_jill,origin}' = 'wsdc'
      and defaults #>> '{categoryTypes,wcs_couples,origin}' = 'studio' and defaults #>> '{categoryTypes,solo,label}' = 'Solo routine (Studio)'
      and (select string_agg(c->>'key' || ':' || (c->>'status'), ',') from jsonb_array_elements(defaults->'source_conflicts') c)
          = 'ndca_student_student_youth:unresolved,ndca_formation_scoring:unresolved'
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 2));
select pg_temp.chk('Country Showcase = set music per dance; Spotlight = competitor-selected music (UCWDC-grounded); floor count not asserted',
  (select defaults #>> '{categoryTypes,showcase,music_source,value}' = 'profile_defined'
      and defaults #>> '{categoryTypes,showcase,music_source,basis}' = 'source_grounded'
      and defaults #>> '{categoryTypes,spotlight,music_source,value}' = 'entry_selected'
      and defaults #>> '{categoryTypes,spotlight,music_source,basis}' = 'source_grounded'
      and defaults #>> '{categoryTypes,showcase,floor_mode,value}' = 'not_specified'
      and defaults #>> '{categoryTypes,spotlight,floor_mode,value}' = 'not_specified'
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 2));
select pg_temp.chk('adjudicated result options are per style (Country Medal Marks, Ballroom/WCS Placements, Other may rate)',
  (select defaults #> '{programs,country,judging_options}' = '["medal_marks"]'::jsonb
      and defaults #> '{programs,ballroom,judging_options}' = '["placements"]'::jsonb
      and defaults #> '{programs,west_coast_swing,judging_options}' = '["placements"]'::jsonb
      and defaults #> '{programs,custom,judging_options}' = '["placements","ratings"]'::jsonb
      and defaults #>> '{judging,medal_marks,input_label}' = 'Medal Marks' and defaults #>> '{judging,medal_marks,result_label}' = 'Placement'
      and defaults #>> '{judging,medal_marks,engine,key}' = 'custom'
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 2));
select pg_temp.chk('feedback is independent of adjudication: Non-Adjudicated has no official result but may carry feedback',
  (select defaults #>> '{judging,non_adjudicated,official_result}' = 'false'
      and defaults #> '{judging,non_adjudicated,feedback_modes}' = '["none","written","written_plus_grade","written_plus_score"]'::jsonb
      and defaults #>> '{judging,medal_marks,official_result}' = 'true'
      and defaults #> '{judging,placements,feedback_modes}' ? 'written'
      and defaults #>> '{feedback,default}' = 'none'
      and (select string_agg(o->>'key', ',') from jsonb_array_elements(defaults #> '{feedback,options}') o) = 'none,written,written_plus_grade,written_plus_score'
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
select pg_temp.expect_msg('style adjudication is required',
  pg_temp.draft('00e002', pg_temp.bad('reject-adjud', '{programs,0,adjudication}', '"sanctioned"')), 'Adjudicated or Non-Adjudicated for Country');
select pg_temp.expect_msg('Country adjudication uses Medal Marks, not Placements',
  pg_temp.draft('00e002', pg_temp.bad('reject-country-placements', '{programs,0,judging}', '"placements"')), 'Choose how Country is judged');
select pg_temp.expect_msg('Ballroom has no generic Gold / Silver / Bronze mode',
  pg_temp.draft('00e002', pg_temp.bad('reject-ballroom-ratings', '{programs,1,judging}', '"ratings"')), 'Choose how Ballroom is judged');
select pg_temp.expect_msg('an adjudicated style cannot use the Non-Adjudicated judging',
  pg_temp.draft('00e002', pg_temp.bad('reject-judging', '{programs,0,judging}', '"non_adjudicated"')), 'Choose how Country is judged');
select pg_temp.expect_msg('an ordinary format cannot override its style adjudication',
  pg_temp.draft('00e002', pg_temp.bad('reject-override', '{programs,0,categories,0,adjudication}', '"non_adjudicated"')), 'follows the style');
select pg_temp.expect_msg('an NDCA offering is not available in Country',
  pg_temp.draft('00e002', pg_temp.bad('reject-ndca-country', '{programs,0,categories,1,type}', '"ndca_amateur"')), 'not available for Country');
select pg_temp.expect_msg('a UCWDC offering is not available in Ballroom',
  pg_temp.draft('00e002', pg_temp.bad('reject-ucwdc-ballroom', '{programs,1,categories,1,type}', '"couples"')), 'not available for Ballroom');
select pg_temp.expect_msg('a styled offering needs a style',
  pg_temp.draft('00e002', pg_temp.bad('reject-nostyle', '{programs,1,categories,0,style}', 'null')), 'Choose an available style for Pro/Am');
select pg_temp.expect_msg('an unknown style is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-badstyle', '{programs,1,categories,0,style}', '"country_western"')), 'Choose an available style for Pro/Am');
select pg_temp.expect_msg('an offering that is not styled cannot carry a style',
  pg_temp.draft('00e002', pg_temp.bad('reject-straystyle', '{programs,1,categories,1,style}', '"american_smooth"')), 'Cabaret is not entered per style');
select pg_temp.expect_msg('a dance outside the category''s style is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-styledance', '{programs,1,categories,0,dances}', '["latin_cha_cha"]')), 'not part of the American Smooth style');
select pg_temp.expect_msg('the same offering cannot be added twice in one style',
  pg_temp.draft('00e002', pg_temp.bad('reject-dupstyle', '{programs,1,categories,2,style}', '"american_smooth"')), 'once per style');
select pg_temp.expect_msg('Showdance is not offered in Additional American Style Dances',
  pg_temp.draft('00e002', pg_temp.one('reject-showdance-additional', 'competition',
    '{"key": "ballroom", "name": "Ballroom", "adjudication": "adjudicated", "judging": "placements", "registration_fee": null,
      "dances": [{"key": "custom_peabody", "name": "Peabody"}],
      "categories": [{"type": "ndca_showdance", "style": "american_additional", "divisions": [{"name": "Open"}], "dances": ["custom_peabody"],
                      "pricing": {"model": "free", "amount": null}}]}'::jsonb)), 'Choose an available style for Showdance');
select pg_temp.expect_msg('organizer-added Ballroom dances belong only to Additional American Style Dances',
  pg_temp.draft('00e002', pg_temp.one('reject-custom-smooth', 'competition',
    '{"key": "ballroom", "name": "Ballroom", "adjudication": "adjudicated", "judging": "placements", "registration_fee": null,
      "dances": [{"key": "custom_peabody", "name": "Peabody"}],
      "categories": [{"type": "ndca_pro_am", "style": "american_smooth", "divisions": [{"name": "Bronze"}], "dances": ["custom_peabody"],
                      "pricing": {"model": "free", "amount": null}}]}'::jsonb)), 'not part of the American Smooth style');
select pg_temp.expect_msg('unknown style key is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-program', '{programs,0,key}', '"ucwdc_country"')), 'not available');
select pg_temp.expect_msg('per-dance pricing is refused for a routine format',
  pg_temp.draft('00e002', pg_temp.bad('reject-routine-pd', '{programs,1,categories,1,pricing}', '{"model": "per_dance", "amount": 10}')), 'Choose how Cabaret is priced');
select pg_temp.expect_msg('per-dance pricing needs a price',
  pg_temp.draft('00e002', pg_temp.bad('reject-noprice', '{programs,0,categories,0,pricing}', '{"model": "per_dance", "amount": null}')), 'Enter a price');
select pg_temp.expect_msg('a zero per-entry price is refused (choose Free instead)',
  pg_temp.draft('00e002', pg_temp.bad('reject-zeroprice', '{programs,0,categories,1,pricing}', '{"model": "per_entry", "amount": 0}')), 'valid price');
select pg_temp.expect_msg('sub-cent prices are refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-subcent', '{programs,0,categories,1,pricing}', '{"model": "per_entry", "amount": 1.234}')), 'valid price');
select pg_temp.expect_msg('a free category cannot carry a price',
  pg_temp.draft('00e002', pg_temp.bad('reject-freeprice', '{programs,1,categories,1,pricing}', '{"model": "free", "amount": 5}')), 'only entered');
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
select pg_temp.expect_msg('unknown division axes are refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-axis', '{programs,0,categories,0,divisions}', '[{"name": "Novice", "axes": {"shoe_size": "9"}}]')), 'invalid division details');
select pg_temp.expect_msg('division axis values must be text',
  pg_temp.draft('00e002', pg_temp.bad('reject-axis-value', '{programs,0,categories,0,divisions}', '[{"name": "Novice", "axes": {"skill_level": 5}}]')), 'invalid division details');
select pg_temp.expect_msg('duplicate division names are refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-dupdiv', '{programs,0,categories,0,divisions}', '[{"name": "Bronze"}, {"name": "bronze"}]')), 'unique');
select pg_temp.expect_msg('more than the per-format division limit is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-manydiv', '{programs,0,categories,1,divisions}',
    (select jsonb_agg(jsonb_build_object('name', 'Level ' || n)) from generate_series(1, 81) n))), 'between 1 and 80 divisions');
select pg_temp.expect_msg('duplicate entry formats are refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-dupfmt', '{programs,0,categories,1,type}', '"pro_am"')), 'once per style in a program');
select pg_temp.expect_msg('Showcase / Performance purpose offers only performance formats',
  pg_temp.draft('00e002', pg_temp.spec('reject-perf-regular') || '{"purpose": "showcase"}'), 'not a Showcase / Performance offering');
select pg_temp.expect_msg('Competition + Showcase needs a Showcase-type offering',
  pg_temp.draft('00e002', pg_temp.one('reject-noshowcase', 'competition_showcase',
    jsonb_set(pg_temp.spec('x') #> '{programs,1}', '{categories}', (pg_temp.spec('x') #> '{programs,1,categories}') - 1))), 'needs a competition entry format and a showcase or performance offering');
select pg_temp.expect_msg('custom dances are refused where the style does not allow them',
  pg_temp.draft('00e002', pg_temp.one('reject-wcs-custom', 'competition',
    '{"key": "west_coast_swing", "name": "WCS", "adjudication": "adjudicated", "judging": "placements", "registration_fee": null,
      "dances": [{"key": "custom_slow_swing", "name": "Slow Swing"}],
      "categories": [{"type": "jack_and_jill", "divisions": [{"name": "Novice"}], "dances": ["custom_slow_swing"],
                      "pricing": {"model": "per_entry", "amount": 15}}]}'::jsonb)), 'not available for West Coast Swing');
select pg_temp.expect_msg('registration cannot close before it opens',
  pg_temp.draft('00e002', pg_temp.bad('reject-window', '{registration,closes_at}', '"2025-01-01T00:00:00Z"')), 'close before it opens');
select pg_temp.expect_msg('invalid registration dates are refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-date', '{registration,opens_at}', '"2026-13-45T00:00:00Z"')), 'valid dates');
select pg_temp.chk('rejected requests wrote nothing (no programs; event registration unchanged)',
  pg_temp.n($q$select count(*) from public.event_competition_programs where event_id = pg_temp.u('00e002')$q$) = 0
  and (select not registration_required and account_required_for_registration and registration_opens_at is null
       from public.events where id = pg_temp.u('00e002')));

-- ============================================================================
-- The reviewed request: one transaction, one program per style
-- ============================================================================
select pg_temp.expect_ok('the full Competition + Showcase / Performance draft is created',
  $q$insert into t_out select 'first', public.create_competition_draft(pg_temp.u('00e001'), pg_temp.spec('p10c5-request-0001'))$q$);
reset role;
insert into t_ids select p.configuration #>> '{setup,program_key}', p.id from public.event_competition_programs p where p.event_id = pg_temp.u('00e001');
insert into t_ids select 'c_' || (p.configuration #>> '{setup,program_key}') || '_' || (c.configuration #>> '{simple,category_type}')
                         || coalesce('_' || (c.configuration #>> '{setup,style}'), ''), c.id
  from public.event_competition_contests c join public.event_competition_programs p on p.id = c.program_id where c.event_id = pg_temp.u('00e001')
  on conflict do nothing;  -- a missing style must fail an assertion below, not the fixture
insert into t_ids select 'd_couples', d.id from public.event_competition_divisions d where d.contest_id = pg_temp.id('c_country_couples') order by d.sort_order limit 1;
insert into t_ids select 'o_couples', dd.id from public.event_competition_division_dances dd where dd.division_id = pg_temp.id('d_couples') order by dd.sort_order limit 1;

select pg_temp.chk('result lists both style programs in order, not replayed, pricing pending',
  (select v->'program_ids' = jsonb_build_array(pg_temp.id('country'), pg_temp.id('ballroom'))
          and v->>'replayed' = 'false' and v->>'pricing_pending' = 'true' from t_out where k = 'first'),
  (select v::text from t_out where k = 'first'));
select pg_temp.chk('no separate showcase program: exactly one program per style',
  pg_temp.n($q$select count(*) from public.event_competition_programs where event_id = pg_temp.u('00e001')$q$) = 2
  and pg_temp.n($q$select count(*) from public.event_competition_programs where event_id = pg_temp.u('00e001') and discipline_family = 'showcase'$q$) = 0);
select pg_temp.chk('programs are unpublished drafts with registration CLOSED on profile v2',
  pg_temp.n($q$select count(*) from public.event_competition_programs where event_id = pg_temp.u('00e001')
               and status = 'draft' and registration_status = 'closed' and profile_locked_at is null
               and rules_profile_key = 'studio_simple' and rules_profile_version = 2$q$) = 2);
select pg_temp.chk('Country program: adjudicated Medal Marks (placement result; generic storage binding)',
  (select name = 'P10C5 Comp — Country' and discipline_family = 'country' and competition_mode = 'relative' and scoring_method = 'custom' and sort_order = 10
          and configuration #>> '{simple,judging}' = 'medal_marks' and configuration #>> '{setup,adjudication}' = 'adjudicated'
   from public.event_competition_programs where id = pg_temp.id('country')));
select pg_temp.chk('Ballroom program: adjudicated Placements, style context retained',
  (select discipline_family = 'ballroom' and competition_mode = 'relative' and scoring_method = 'ordinal_majority' and sort_order = 20
          and configuration #>> '{simple,judging}' = 'placements'
   from public.event_competition_programs where id = pg_temp.id('ballroom')));
select pg_temp.chk('program configuration stores the request, judging, programming metadata and answers snapshot',
  (select configuration #>> '{simple,request_key}' = 'p10c5-request-0001' and configuration #>> '{simple,created_with}' = 'setup_wizard'
          and configuration #>> '{setup,request_hash}' = md5(pg_temp.spec('p10c5-request-0001')::text)
          and configuration #> '{setup,answers}' = pg_temp.spec('x')->'answers'
          and configuration #> '{setup,programming,hierarchy,value}' = '["level","age","dance"]'::jsonb
          and configuration #>> '{setup,programming,hierarchy,basis}' = 'owner_operational'
          and configuration #>> '{setup,programming,dance_sequence,basis}' = 'source_grounded'
          and configuration #>> '{setup,purpose}' = 'competition_showcase' and configuration #>> '{setup,registration_fee}' = '40'
   from public.event_competition_programs where id = pg_temp.id('country')));
select pg_temp.chk('categories carry the profile entry formats and participant / lead-follow rules',
  (select string_agg(entry_format || ':' || contest_type || ':' || name, ',' order by sort_order) from public.event_competition_contests where program_id = pg_temp.id('country'))
    = 'pro_am:single_dance:ProAm,pro_pro:single_dance:ProPro,couple:single_dance:Couples,team:team:Team,custom:custom:Showcase,custom:spotlight:Spotlight'
  and (select configuration #> '{setup,participant_roles}' = '["instructor","professional"]'::jsonb and configuration #>> '{setup,dance_roles}' = 'pair'
       from public.event_competition_contests where id = pg_temp.id('c_country_pro_pro'))
  and (select string_agg(entry_format || ':' || name || ':' || coalesce(configuration #>> '{setup,style}', '-'), ',' order by sort_order)
       from public.event_competition_contests where program_id = pg_temp.id('ballroom'))
      = 'pro_am:Pro/Am — American Smooth:american_smooth,custom:Cabaret:-,pro_am:Pro/Am — International Latin:international_latin',
  (select string_agg(entry_format || ':' || contest_type || ':' || name, ',' order by sort_order) from public.event_competition_contests where program_id = pg_temp.id('country')));
select pg_temp.chk('Showcase override: Non-Adjudicated inside an adjudicated style; Spotlight and Showdance inherit',
  (select configuration #>> '{setup,adjudication}' = 'non_adjudicated' and configuration #>> '{setup,adjudication_source}' = 'override'
          and configuration #>> '{setup,judging}' = 'non_adjudicated' and configuration #>> '{setup,music_source,value}' = 'profile_defined'
          and configuration #>> '{setup,kind}' = 'special'
   from public.event_competition_contests where id = pg_temp.id('c_country_showcase'))
  and (select configuration #>> '{setup,adjudication}' = 'adjudicated' and configuration #>> '{setup,adjudication_source}' = 'style'
          and configuration #>> '{setup,judging}' = 'medal_marks' and configuration #>> '{setup,music_source,value}' = 'entry_selected'
          and configuration #>> '{setup,floor_mode,value}' = 'not_specified'
       from public.event_competition_contests where id = pg_temp.id('c_country_spotlight'))
  and (select configuration #>> '{setup,adjudication}' = 'adjudicated' and configuration #>> '{setup,judging}' = 'placements'
       from public.event_competition_contests where id = pg_temp.id('c_ballroom_ndca_cabaret')));
select pg_temp.chk('registration rules: per dance / per entry / included / later / free',
  (select string_agg((p.configuration #>> '{setup,program_key}') || '.' || (c.configuration #>> '{simple,category_type}') || ':' || r.pricing_method || ':' || r.base_entry_fee::text || ':' || r.registration_open::text, ',' order by p.sort_order, c.sort_order)
   from public.event_competition_contests c join public.event_competition_programs p on p.id = c.program_id
   join public.event_competition_contest_registration_rules r on r.contest_id = c.id where c.event_id = pg_temp.u('00e001'))
    = 'country.pro_am:per_dance:0.00:false,country.pro_pro:flat_entry:60.00:false,country.couples:flat_entry:0.00:false,country.team:flat_entry:0.00:false,'
      'country.showcase:flat_entry:0.00:false,country.spotlight:flat_entry:35.00:false,ballroom.ndca_pro_am:per_dance:0.00:false,ballroom.ndca_cabaret:flat_entry:0.00:false,ballroom.ndca_pro_am:per_dance:0.00:false');
select pg_temp.chk('per-dance offerings carry the price; other offerings are 0 (Showcase is danced per dance)',
  (select string_agg(c.configuration #>> '{simple,category_type}' || ':' || dd.entry_fee::text, ',' order by p.sort_order, c.sort_order, d.sort_order, dd.sort_order)
   from public.event_competition_division_dances dd join public.event_competition_divisions d on d.id = dd.division_id
   join public.event_competition_contests c on c.id = d.contest_id join public.event_competition_programs p on p.id = c.program_id where dd.event_id = pg_temp.u('00e001'))
    = 'pro_am:25.00,pro_am:25.00,pro_am:25.00,pro_am:25.00,pro_pro:0.00,couples:0.00,showcase:0.00,ndca_pro_am:20.00,ndca_pro_am:20.00');
select pg_temp.chk('dances: pool names and categories (client labels ignored) plus the custom dance',
  (select string_agg(dance_key || '=' || name || '/' || coalesce(category_label, ''), ',' order by sort_order)
   from public.event_competition_dances where program_id = pg_temp.id('country'))
    = 'two_step=Two Step/Partner,waltz=Waltz/Partner,custom_line_polka=Line Polka/Custom'
  and (select string_agg(dance_key || '=' || name || '/' || coalesce(category_label, ''), ',' order by sort_order)
       from public.event_competition_dances where program_id = pg_temp.id('ballroom')) = 'smooth_waltz=Waltz/American Smooth,latin_cha_cha=Cha Cha/International Latin'
  and (select string_agg(d.dance_key, ',') from public.event_competition_division_dances dd
       join public.event_competition_dances d on d.id = dd.dance_id join public.event_competition_divisions v on v.id = dd.division_id
       where v.contest_id = pg_temp.id('c_ballroom_ndca_pro_am_international_latin')) = 'latin_cha_cha');
select pg_temp.chk('each division records the selected axis values it was built from',
  (select count(*) = 1 and bool_and(configuration #> '{setup,axes}' = '{"skill_level": "Newcomer", "age_group": "Adult"}'::jsonb)
   from public.event_competition_divisions where contest_id = pg_temp.id('c_country_couples'))
  and (select count(*) = 1 and bool_and(configuration #> '{setup,axes}' = '{}'::jsonb) from public.event_competition_divisions where contest_id = pg_temp.id('c_country_team')));
select pg_temp.chk('divisions per entry format with level and age labels (no shared division list)',
  (select string_agg(c.configuration #>> '{simple,category_type}' || ':' || d.name || ':' || coalesce(d.skill_label, '-') || ':' || coalesce(d.age_label, '-'), ',' order by p.sort_order, c.sort_order, d.sort_order)
   from public.event_competition_divisions d join public.event_competition_contests c on c.id = d.contest_id
   join public.event_competition_programs p on p.id = d.program_id where d.event_id = pg_temp.u('00e001'))
    = 'pro_am:Newcomer:Newcomer:-,pro_am:Bronze:Bronze:-,pro_pro:Open:Open:-,couples:Newcomer · Adult:Newcomer:Adult,team:Open:Open:-,showcase:Open:Open:-,spotlight:Open:Open:-,ndca_pro_am:Bronze:Bronze:-,ndca_cabaret:Open:Open:-,ndca_pro_am:Bronze:Bronze:-');
select pg_temp.chk('rounds follow each format''s judging: Final for adjudicated, Performance for the Non-Adjudicated Showcase',
  (select string_agg((p.configuration #>> '{setup,program_key}') || '.' || (c.configuration #>> '{simple,category_type}') || ':' || r.name || ':' || r.round_type || ':' || r.scoring_method, ',' order by p.sort_order, c.sort_order)
   from (select distinct on (d.contest_id) d.contest_id, r.* from public.event_competition_rounds r join public.event_competition_divisions d on d.id = r.division_id
         where r.event_id = pg_temp.u('00e001') order by d.contest_id, r.sequence_number) r
   join public.event_competition_contests c on c.id = r.contest_id join public.event_competition_programs p on p.id = c.program_id)
    = 'country.pro_am:Final:final:custom,country.pro_pro:Final:final:custom,country.couples:Final:final:custom,country.team:Final:final:custom,'
      'country.showcase:Performance:exhibition:none,country.spotlight:Final:final:custom,ballroom.ndca_pro_am:Final:final:ordinal_majority,ballroom.ndca_cabaret:Final:final:ordinal_majority,ballroom.ndca_pro_am:Final:final:ordinal_majority'
  and pg_temp.n($q$select count(*) from public.event_competition_divisions d where d.event_id = pg_temp.u('00e001')
                   and (select count(*) from public.event_competition_rounds r where r.division_id = d.id) <> 1$q$) = 0);
select pg_temp.chk('included pricing creates one program-scoped per-person registration fee rule',
  (select count(*) = 1 and min(calculation_type) = 'flat_per_person' and min(amount) = 40 and bool_and(program_id = pg_temp.id('country'))
          and bool_and(contest_id is null) and bool_and(active)
   from public.event_competition_fee_rules where event_id = pg_temp.u('00e001')));
select pg_temp.chk('Configure later marks only that category pricing-pending',
  (select string_agg(configuration #>> '{simple,category_type}', ',') from public.event_competition_contests
   where event_id = pg_temp.u('00e001') and configuration #>> '{setup,pricing_pending}' = 'true') = 'team');
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
  and pg_temp.n($q$select count(*) from public.event_competition_divisions where event_id = pg_temp.u('00e001')$q$) = 10);
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
  $q$select public.set_competition_category_pricing(pg_temp.id('c_country_team'), 'later', null)$q$, 'pricing option available');
select pg_temp.expect_msg('pricing completion refuses a model the format does not allow',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_country_team'), 'per_dance', 10)$q$, 'pricing option available');
select pg_temp.expect_msg('pricing completion refuses a zero price',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_country_team'), 'per_entry', 0)$q$, 'valid price');
select pg_temp.expect_msg('pricing completion refuses sub-cent prices',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_country_team'), 'per_entry', 30.001)$q$, 'valid price');
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('an outsider cannot complete pricing',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_country_team'), 'per_entry', 30)$q$, 'cannot be managed');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('pricing completion sets the Team price',
  $q$insert into t_out select 'priced', public.set_competition_category_pricing(pg_temp.id('c_country_team'), 'per_entry', 30)$q$);
select pg_temp.chk('pricing completion clears the flag and writes the rule',
  (select v->>'pricing_pending' = 'false' from t_out where k = 'priced')
  and (select configuration #>> '{setup,pricing_pending}' = 'false' and configuration #>> '{setup,pricing_model}' = 'per_entry'
       from public.event_competition_contests where id = pg_temp.id('c_country_team'))
  and (select pricing_method = 'flat_entry' and base_entry_fee = 30 from public.event_competition_contest_registration_rules where contest_id = pg_temp.id('c_country_team')));
select pg_temp.expect_ok('pricing completion can switch ProAm to per-entry on a published draft',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_country_pro_am'), 'per_entry', 45)$q$);
select pg_temp.chk('switching to per-entry zeroes the per-dance offerings',
  (select pricing_method = 'flat_entry' and base_entry_fee = 45 from public.event_competition_contest_registration_rules where contest_id = pg_temp.id('c_country_pro_am'))
  and pg_temp.n($q$select count(*) from public.event_competition_division_dances dd join public.event_competition_divisions d on d.id = dd.division_id
                   where d.contest_id = pg_temp.id('c_country_pro_am') and dd.entry_fee <> 0$q$) = 0);
select pg_temp.expect_ok('switching back to per-dance restores offering prices',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_country_pro_am'), 'per_dance', 25)$q$);
select pg_temp.chk('per-dance completion prices every offering and zeroes the base fee',
  (select pricing_method = 'per_dance' and base_entry_fee = 0 from public.event_competition_contest_registration_rules where contest_id = pg_temp.id('c_country_pro_am'))
  and pg_temp.n($q$select count(*) from public.event_competition_division_dances dd join public.event_competition_divisions d on d.id = dd.division_id
                   where d.contest_id = pg_temp.id('c_country_pro_am') and dd.entry_fee = 25$q$) = 4);
select pg_temp.expect_ok('open registration succeeds once pricing is complete',
  $q$select public.open_competition_registration(pg_temp.id('country'))$q$);
select pg_temp.chk('registration is open for every Country category',
  (select registration_status = 'open' from public.event_competition_programs where id = pg_temp.id('country'))
  and pg_temp.n($q$select count(*) from public.event_competition_contest_registration_rules where program_id = pg_temp.id('country') and registration_open$q$) = 6);
select pg_temp.expect_msg('pricing cannot change while registration is open',
  $q$select public.set_competition_category_pricing(pg_temp.id('c_country_team'), 'free', null)$q$, 'Close registration');
reset role;
insert into t_out select 'quote', public._comp10c_quote(pg_temp.u('00e001'), jsonb_build_object(
  'registrationMode', 'individual', 'buyerName', 'Quote Buyer', 'buyerEmail', 'quote@example.test',
  'people', '[{"clientId": "x", "firstName": "Xi", "lastName": "Lead", "personType": "dancer"},
              {"clientId": "y", "firstName": "Yo", "lastName": "Follow", "personType": "dancer"}]'::jsonb,
  'entries', jsonb_build_array(jsonb_build_object('clientId', 'e1', 'programId', pg_temp.id('country'), 'contestId', pg_temp.id('c_country_couples'),
    'divisionId', pg_temp.id('d_couples'), 'participantIds', '["x", "y"]'::jsonb,
    'participantRoles', '{"x": "dancer", "y": "dancer"}'::jsonb, 'participantDanceRoles', '{"x": "leader", "y": "follower"}'::jsonb,
    'selectedOfferingIds', jsonb_build_array(pg_temp.id('o_couples'))))), now());
select pg_temp.chk('the included registration fee is charged once per competitor in the quote',
  (select (v->>'valid')::boolean and (v->>'total_cents')::bigint = 8000
          and exists (select 1 from jsonb_array_elements(v->'lines') l where l->>'lineType' = 'fee' and (l->>'unitCents')::bigint = 4000
                      and (l->>'quantity')::int = 2 and (l->>'lineCents')::bigint = 8000)
   from t_out where k = 'quote'),
  (select v::text from t_out where k = 'quote'));
select pg_temp.chk('the guard applies only to pricing-pending categories (open path untouched otherwise)',
  position('COMP10C_PRICING_PENDING' in pg_get_functiondef('public.open_competition_registration(uuid)'::regprocedure)) > 0
  and position('COMP10C_NOT_PUBLISHED' in pg_get_functiondef('public.open_competition_registration(uuid)'::regprocedure)) > 0);

-- A category flagged pending by any path (e.g. an Advanced edit) still blocks opening.
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('the Ballroom program publishes', $q$select public.publish_competition_program(pg_temp.id('ballroom'))$q$);
reset role;
update public.event_competition_contests set configuration = jsonb_set(configuration, '{setup,pricing_pending}', 'true') where id = pg_temp.id('c_ballroom_ndca_cabaret');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a pending flag set outside the wizard also blocks opening',
  $q$select public.open_competition_registration(pg_temp.id('ballroom'))$q$, 'Pricing requires completion');
select pg_temp.expect_ok('Free completes the Cabaret pricing', $q$select public.set_competition_category_pricing(pg_temp.id('c_ballroom_ndca_cabaret'), 'free', null)$q$);
select pg_temp.expect_ok('the Ballroom program then opens', $q$select public.open_competition_registration(pg_temp.id('ballroom'))$q$);

-- ============================================================================
-- Other purposes and styles
-- ============================================================================
select pg_temp.expect_ok('Showcase / Performance keeps its style and can be adjudicated',
  pg_temp.draft('00e003', pg_temp.one('p10c5-showcase-only', 'showcase',
    '{"key": "country", "name": "Country Showcase Night", "adjudication": "adjudicated", "judging": "medal_marks", "registration_fee": null,
      "dances": [{"key": "two_step"}],
      "categories": [{"type": "showcase", "adjudication": "inherit", "divisions": [{"name": "Open"}], "dances": ["two_step"], "pricing": {"model": "per_dance", "amount": 30}},
                     {"type": "spotlight", "adjudication": "inherit", "divisions": [{"name": "Open"}], "dances": [], "pricing": {"model": "per_entry", "amount": 40}}]}'::jsonb)));
select pg_temp.chk('adjudicated Showcase / Performance: Country program, Medal Marks Finals, no exhibition forcing',
  (select count(*) = 1 and min(discipline_family) = 'country' and min(competition_mode) = 'relative'
   from public.event_competition_programs where event_id = pg_temp.u('00e003'))
  and (select string_agg(r.name || ':' || r.round_type || ':' || r.scoring_method, ',') from public.event_competition_rounds r where r.event_id = pg_temp.u('00e003'))
      = 'Final:final:custom,Final:final:custom'
  and (select account_required_for_registration and registration_opens_at is null from public.events where id = pg_temp.u('00e003')));
select pg_temp.expect_ok('a Non-Adjudicated style can still adjudicate its Showcase (override)',
  pg_temp.draft('00e008', pg_temp.one('p10c5-nonadj-adj-showcase', 'competition_showcase',
    '{"key": "country", "name": "Country Social", "adjudication": "non_adjudicated", "judging": "non_adjudicated", "registration_fee": null,
      "dances": [{"key": "two_step"}],
      "categories": [{"type": "couples", "adjudication": "inherit", "divisions": [{"name": "Open"}], "dances": ["two_step"], "pricing": {"model": "free", "amount": null}},
                     {"type": "showcase", "adjudication": "adjudicated", "divisions": [{"name": "Open"}], "dances": ["two_step"], "pricing": {"model": "free", "amount": null}}]}'::jsonb)));
select pg_temp.chk('override to Adjudicated uses the style''s result option (Medal Marks Final); the rest stays Performance',
  (select string_agg((c.configuration #>> '{simple,category_type}') || ':' || (c.configuration #>> '{setup,judging}') || ':' || r.name || ':' || r.scoring_method, ',' order by c.sort_order)
   from public.event_competition_contests c join public.event_competition_divisions d on d.contest_id = c.id
   join public.event_competition_rounds r on r.division_id = d.id where c.event_id = pg_temp.u('00e008'))
    = 'couples:non_adjudicated:Performance:none,showcase:medal_marks:Final:custom'
  and (select competition_mode = 'exhibition' from public.event_competition_programs where event_id = pg_temp.u('00e008')));
select pg_temp.expect_ok('a Non-Adjudicated WCS competition keeps Jack & Jill',
  pg_temp.draft('00e004', pg_temp.one('p10c5-wcs-nonadj', 'competition',
    '{"key": "west_coast_swing", "name": "WCS Social", "adjudication": "non_adjudicated", "judging": "non_adjudicated", "registration_fee": null,
      "dances": [{"key": "west_coast_swing"}],
      "categories": [{"type": "jack_and_jill", "divisions": [{"name": "Novice", "skill_label": "Novice"}],
                      "dances": ["west_coast_swing"], "pricing": {"model": "per_entry", "amount": 15}}]}'::jsonb)));
select pg_temp.chk('Non-Adjudicated competition: exhibition mode, Performance round, prescribed dance',
  (select p.competition_mode = 'exhibition' and p.scoring_method = 'none' and c.entry_format = 'random_partner'
          and r.dance_selection_mode = 'prescribed_set' and r.base_entry_fee = 15
          and (select string_agg(name || ':' || round_type, ',') from public.event_competition_rounds where program_id = p.id) = 'Performance:exhibition'
          and (select bool_and(required) from public.event_competition_division_dances where program_id = p.id)
   from public.event_competition_programs p join public.event_competition_contests c on c.program_id = p.id
   join public.event_competition_contest_registration_rules r on r.contest_id = c.id where p.event_id = pg_temp.u('00e004')));
select pg_temp.expect_ok('Ballroom Professional (Placements) with Open Professional and Rising Star, plus an Additional American dance',
  pg_temp.draft('00e005', pg_temp.one('p10c5-ballroom-pro', 'competition',
    '{"key": "ballroom", "name": "Ballroom", "adjudication": "adjudicated", "judging": "placements", "registration_fee": null,
      "dances": [{"key": "std_waltz"}, {"key": "custom_peabody", "name": "Peabody"}],
      "categories": [{"type": "ndca_professional", "style": "international_standard",
                      "divisions": [{"name": "Open Professional", "axes": {"contest_type": "Open Professional"}}, {"name": "Rising Star", "axes": {"contest_type": "Rising Star"}}],
                      "dances": ["std_waltz"], "pricing": {"model": "free", "amount": null}},
                     {"type": "ndca_pro_am", "style": "american_additional", "divisions": [{"name": "Bronze"}], "dances": ["custom_peabody"],
                      "pricing": {"model": "free", "amount": null}}]}'::jsonb)));
select pg_temp.chk('Ballroom Professional shape: per-style contest, contest-type divisions, professional roles',
  (select p.competition_mode = 'relative' and p.scoring_method = 'ordinal_majority' and c.entry_format = 'professional'
          and c.name = 'Professional — International Standard' and c.configuration #>> '{setup,style}' = 'international_standard'
          and c.configuration #> '{setup,participant_roles}' = '["professional"]'::jsonb
          and (select string_agg(d.name || ':' || (d.configuration #>> '{setup,axes,contest_type}'), ',' order by d.sort_order)
               from public.event_competition_divisions d where d.contest_id = c.id) = 'Open Professional:Open Professional,Rising Star:Rising Star'
   from public.event_competition_programs p join public.event_competition_contests c on c.program_id = p.id
   where p.event_id = pg_temp.u('00e005') and c.entry_format = 'professional')
  and (select name = 'Pro/Am — Additional American Style Dances' from public.event_competition_contests
       where event_id = pg_temp.u('00e005') and configuration #>> '{setup,style}' = 'american_additional'));
select pg_temp.expect_ok('multiple styles create one program each; Other may use Gold / Silver / Bronze',
  pg_temp.draft('00e006', jsonb_build_object('request_key', 'p10c5-multi-style', 'profile_key', 'studio_simple', 'profile_version', 2,
    'purpose', 'competition', 'answers', '{}'::jsonb,
    'registration', '{"opens_at": null, "closes_at": null, "account_required": true}'::jsonb,
    'programs', '[{"key": "country", "name": "Multi — Country", "adjudication": "adjudicated", "judging": "medal_marks", "registration_fee": null, "dances": [{"key": "two_step"}],
                   "categories": [{"type": "couples", "divisions": [{"name": "Open"}], "dances": ["two_step"], "pricing": {"model": "free", "amount": null}}]},
                  {"key": "custom", "name": "Multi — Other", "adjudication": "adjudicated", "judging": "ratings", "registration_fee": null, "dances": [],
                   "categories": [{"type": "custom_routine", "divisions": [{"name": "Open"}], "dances": [], "pricing": {"model": "free", "amount": null}}]}]'::jsonb)));
select pg_temp.chk('two style programs: Country Medal Marks and Other ratings',
  (select count(*) = 2 and string_agg(discipline_family || ':' || competition_mode || ':' || scoring_method, ',' order by sort_order) = 'country:relative:custom,custom:proficiency:proficiency_rating'
   from public.event_competition_programs where event_id = pg_temp.u('00e006'))
  and (select name from public.event_competition_contests where event_id = pg_temp.u('00e006') and entry_format = 'custom') = 'Choreographed Routine');

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

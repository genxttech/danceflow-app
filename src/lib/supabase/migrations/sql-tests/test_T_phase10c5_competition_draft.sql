-- Phase 10C.5 -- Competition Setup Wizard draft generator regression suite.
--
-- Covers 20261113090000_phase10c5_competition_draft.sql, 20261114090000_phase10c5_profile_v3.sql and
-- 20261115090000_phase10c5_registration_isolation.sql: studio_simple@3, create_competition_draft,
-- set_competition_category_pricing, the pricing-pending guard in open_competition_registration, and the isolation of
-- competition registration from the event's ordinary ticket registration.
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
    'request_key', p_key, 'profile_key', 'studio_simple', 'profile_version', 3, 'purpose', 'competition_showcase',
    'answers', '{"version": 4, "purpose": "competition_showcase", "styles": ["country", "ballroom"]}'::jsonb,
    'registration', '{"opens_at": "2026-01-01T00:00:00Z", "closes_at": "2030-01-01T00:00:00Z", "account_required": false}'::jsonb,
    'event', jsonb_build_object(
      'summary', 'A friendly studio competition.',
      'cover_image_url', 'https://dev.example.supabase.co/storage/v1/object/public/event-media/' || pg_temp.u('00a001') || '/p10c5/cover.jpg',
      'highlights', '["Live band", "  Pro/Am scholarship "]'::jsonb,
      'registration_info', 'Entries close two weeks before the event.'),
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
  select jsonb_build_object('request_key', p_key, 'profile_key', 'studio_simple', 'profile_version', 3, 'purpose', p_purpose,
    'answers', '{}'::jsonb, 'registration', '{"opens_at": null, "closes_at": null, "account_required": true}'::jsonb,
    'programs', jsonb_build_array(p_program));
$$;

-- A minimal Country request carrying an event-page change (for the Event Details checks).
create or replace function pg_temp.page(p_key text, p_event jsonb) returns jsonb
language sql immutable as $$
  select pg_temp.one(p_key, 'competition',
    '{"key": "country", "name": "Ops", "adjudication": "adjudicated", "judging": "medal_marks", "registration_fee": null, "dances": [{"key": "two_step"}],
      "categories": [{"type": "couples", "divisions": [{"name": "Open"}], "dances": ["two_step"], "pricing": {"model": "free", "amount": null}}]}'::jsonb)
    || jsonb_build_object('event', p_event);
$$;
create or replace function pg_temp.ops(p_event text, p_spec jsonb) returns text
language sql as $$ select format('select public.create_competition_draft(%L, %L::jsonb)', pg_temp.u(p_event), p_spec) $$;

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
from generate_series(1, 9) n;

-- 10C.5 Event Details fixtures: an instructor (any studio role may update events under the existing policies), an
-- organizer with staff and admin users, competition events owned by that organizer, and one non-competition event.
insert into auth.users (id, email) values
  (pg_temp.u('000003'), 't-p10c5-instructor@example.test'), (pg_temp.u('000004'), 't-p10c5-orgstaff@example.test'),
  (pg_temp.u('000005'), 't-p10c5-orgadmin@example.test');
insert into public.profiles (id, email, full_name) values
  (pg_temp.u('000003'), 't-p10c5-instructor@example.test', 'Instructor'), (pg_temp.u('000004'), 't-p10c5-orgstaff@example.test', 'Org Staff'),
  (pg_temp.u('000005'), 't-p10c5-orgadmin@example.test', 'Org Admin');
insert into public.user_studio_roles (user_id, studio_id, role, active) values (pg_temp.u('000003'), pg_temp.u('00a001'), 'instructor', true);
insert into public.organizers (id, name, slug) values (pg_temp.u('00b001'), 'P10C5 Organizer', 't-p10c5-organizer');
insert into public.organizer_users (organizer_id, user_id, role, active) values
  (pg_temp.u('00b001'), pg_temp.u('000004'), 'organizer_staff', true), (pg_temp.u('00b001'), pg_temp.u('000005'), 'organizer_admin', true);
insert into public.events (id, studio_id, organizer_id, name, slug, event_type, start_date, end_date, start_time, end_time, timezone,
                           venue_name, city, state, status, visibility, registration_required, account_required_for_registration)
select pg_temp.u('00f0' || lpad(n::text, 2, '0')), pg_temp.u('00a001'), pg_temp.u('00b001'), 'P10C5 Ops Event ' || n, 't-p10c5-ops' || n,
       case when n = 9 then 'social_dance' else 'competition' end, date '2027-03-06', date '2027-03-07', time '18:00', time '22:00', 'America/Chicago',
       'Main Studio', 'Austin', 'TX', 'published', 'public', false, true
from generate_series(1, 9) n;
-- Dependent records: an active registration (ops 5), an additional location (ops 6), a schedule item (ops 7).
insert into public.event_registrations (event_id, studio_id, status, attendee_first_name, attendee_last_name, attendee_email)
values (pg_temp.u('00f005'), pg_temp.u('00a001'), 'confirmed', 'Reg', 'Istrant', 't-p10c5-reg@example.test');
insert into public.event_locations (event_id, studio_id, location_name) values (pg_temp.u('00f006'), pg_temp.u('00a001'), 'Second Hall');
insert into public.event_schedule_items (event_id, studio_id, schedule_date, start_time, title)
values (pg_temp.u('00f007'), pg_temp.u('00a001'), date '2027-03-06', time '19:00', 'Opening social');

-- ============================================================================
-- Profile v2
-- ============================================================================
select pg_temp.chk('v1 profile is untouched and v3 is the active Studio / Custom profile (schema 2)',
  (select md5(defaults::text) from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 1) = '6e4b7ef21ca994c863f5d2de15f1c935'
  and (select status = 'active' and name = 'Studio / Custom Rules' and defaults->>'schema' = '2' and defaults #>> '{sanction,claimable}' = 'false'
       from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 3));
select pg_temp.chk('v3 entry formats are profile-derived per style; Showcase-type offerings live inside the style',
  (select defaults #> '{programs,country,formats}' = '["pro_am","pro_pro","couples","showcase","spotlight","solo","team"]'::jsonb
      and defaults #> '{programs,west_coast_swing,formats}' = '["jack_and_jill","wcs_couples","wcs_pro_am","routine"]'::jsonb
      and defaults #> '{programs,custom,formats}' ? 'studio_professional'
      and not (defaults->'programs' ? 'showcase')
      and not exists (select 1 from jsonb_each(defaults->'programs') p where p.value ?| array['recommended_formats', 'recommended_special', 'recommended_dances'])
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 3));
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
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 3));
select pg_temp.chk('Additional American Style Dances carry the NDCA IX.A.1.e examples; Nightclub is presentation only',
  (select st->'dances' = '["addl_bachata","addl_cumbia","addl_hustle","addl_jitterbug","addl_lindy_hop","addl_merengue","addl_night_club_two_step","addl_paso_doble","addl_peabody","addl_polka","addl_salsa","addl_samba","addl_west_coast_swing","addl_argentine_tango","addl_argentine_vals","addl_milonga"]'::jsonb
          and st->>'label' = 'Additional American Style Dances' and st #>> '{presentation,label}' = 'Nightclub / Specialty Dances'
          and st #>> '{presentation,basis}' = 'owner_operational' and (st->>'allow_custom_dances')::boolean
          and defaults #>> '{limits,programDances}' = '60' and defaults #>> '{limits,dances}' = '20'
   from public.competition_rules_profiles, jsonb_array_elements(defaults #> '{programs,ballroom,styles}') st
   where profile_key = 'studio_simple' and version = 3 and st->>'key' = 'american_additional'));
select pg_temp.chk('NDCA Multi-Dance offerings: prescribed set, primary styles, registration hold; A–S4 only for Multi-Dance',
  (select defaults #>> '{categoryTypes,ndca_pro_am_multi,contest_type}' = 'multi_dance'
      and defaults #>> '{categoryTypes,ndca_pro_am_multi,dance_selection_mode}' = 'prescribed_set'
      and defaults #>> '{categoryTypes,ndca_amateur_multi,event_form}' = 'multi_dance'
      and defaults #>> '{categoryTypes,ndca_pro_am,event_form}' = 'single_dance'
      and defaults #>> '{categoryTypes,ndca_pro_am_multi,registration_hold,key}' = 'multi_dance_results_not_operational'
      and defaults #> '{categoryTypes,ndca_pro_am_multi,style_keys}' = '["international_standard","international_latin","american_smooth","american_rhythm"]'::jsonb
      and not exists (select 1 from jsonb_array_elements(defaults #> '{divisionSchemes,ballroom_proam,axes}') a, jsonb_array_elements(a->'values') v where v->>'label' in ('A', 'B', 'S4'))
      and (select count(*) from jsonb_array_elements(defaults #> '{divisionSchemes,ballroom_proam_multi,axes}') a, jsonb_array_elements(a->'values') v where v->>'label' in ('A', 'B', 'C', 'S1', 'S2', 'S3', 'S4')) = 7
      and not exists (select 1 from jsonb_array_elements(defaults #> '{divisionSchemes,ballroom_amateur,axes}') a, jsonb_array_elements(a->'values') v where v->>'label' = 'Open Amateur')
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 3));
select pg_temp.chk('Nightclub presentation cites NDCA III.D.15 (Night Club events and sessions) and IX.B.5.c (tempi)',
  (select string_agg(src->>'section' || '@' || (src->>'page'), ',') = 'III.D.15@21,IX.B.5.c@41'
          and st #>> '{presentation,note}' like '%Night Club is not an NDCA competition classification%'
   from public.competition_rules_profiles, jsonb_array_elements(defaults #> '{programs,ballroom,styles}') st, jsonb_array_elements(st #> '{presentation,sources}') src
   where profile_key = 'studio_simple' and version = 3 and st->>'key' = 'american_additional'
   group by st));
select pg_temp.chk('the event page columns exist with their limits and are readable wherever event names are',
  (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'events'
     and column_name in ('public_highlights', 'public_registration_info'))
  and has_column_privilege('anon', 'public.events', 'public_highlights', 'SELECT') = has_column_privilege('anon', 'public.events', 'name', 'SELECT')
  and has_column_privilege('authenticated', 'public.events', 'public_registration_info', 'SELECT') = has_column_privilege('authenticated', 'public.events', 'name', 'SELECT'));
select pg_temp.expect_msg('the highlights column refuses more than six items',
  $q$update public.events set public_highlights = array['1','2','3','4','5','6','7'] where id = pg_temp.u('00e002')$q$, 'events_public_highlights_check');
select pg_temp.chk('Country Showcase = set music per dance; Spotlight = competitor-selected music (UCWDC-grounded); floor count not asserted',
  (select defaults #>> '{categoryTypes,showcase,music_source,value}' = 'profile_defined'
      and defaults #>> '{categoryTypes,showcase,music_source,basis}' = 'source_grounded'
      and defaults #>> '{categoryTypes,spotlight,music_source,value}' = 'entry_selected'
      and defaults #>> '{categoryTypes,spotlight,music_source,basis}' = 'source_grounded'
      and defaults #>> '{categoryTypes,showcase,floor_mode,value}' = 'not_specified'
      and defaults #>> '{categoryTypes,spotlight,floor_mode,value}' = 'not_specified'
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 3));
select pg_temp.chk('adjudicated result options are per style (Country Medal Marks, Ballroom/WCS Placements, Other may rate)',
  (select defaults #> '{programs,country,judging_options}' = '["medal_marks"]'::jsonb
      and defaults #> '{programs,ballroom,judging_options}' = '["placements"]'::jsonb
      and defaults #> '{programs,west_coast_swing,judging_options}' = '["placements"]'::jsonb
      and defaults #> '{programs,custom,judging_options}' = '["placements","ratings"]'::jsonb
      and defaults #>> '{judging,medal_marks,input_label}' = 'Medal Marks' and defaults #>> '{judging,medal_marks,result_label}' = 'Placement'
      and defaults #>> '{judging,medal_marks,engine,key}' = 'custom'
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 3));
select pg_temp.chk('feedback is independent of adjudication: Non-Adjudicated has no official result but may carry feedback',
  (select defaults #>> '{judging,non_adjudicated,official_result}' = 'false'
      and defaults #> '{judging,non_adjudicated,feedback_modes}' = '["none","written","written_plus_grade","written_plus_score"]'::jsonb
      and defaults #>> '{judging,medal_marks,official_result}' = 'true'
      and defaults #> '{judging,placements,feedback_modes}' ? 'written'
      and defaults #>> '{feedback,default}' = 'none'
      and (select string_agg(o->>'key', ',') from jsonb_array_elements(defaults #> '{feedback,options}') o) = 'none,written,written_plus_grade,written_plus_score'
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 3));
select pg_temp.expect_msg('v3 is append-only (defaults cannot change)',
  $q$update public.competition_rules_profiles set defaults = defaults || '{"x": 1}' where profile_key = 'studio_simple' and version = 3$q$,
  'append-only');
select pg_temp.chk('studio_simple@2 (seeded by 20261113090000) is kept exactly as it was: same content, still active',
  (select md5(defaults::text) = '0ba037fe8c3024c93b841909d1a4e832' and status = 'active' and name = 'Studio / Custom Rules'
   from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 2)
  and (select md5(defaults::text) <> '0ba037fe8c3024c93b841909d1a4e832' from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 3));
select pg_temp.expect_msg('v2 is append-only too (referenced profiles are immutable)',
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
select pg_temp.expect_msg('new setups cannot use the superseded studio_simple@2 (existing v2 programs keep it)',
  pg_temp.draft('00e002', pg_temp.spec('reject-v2-key') || '{"profile_version": 2}'), 'have been replaced');
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
select pg_temp.expect_msg('the event page refuses fields it does not own (visibility, status, slug)',
  pg_temp.draft('00e002', pg_temp.bad('reject-page-visibility', '{event,visibility}', '"private"')), 'event page details are not valid');
select pg_temp.expect_msg('the event page must be an object',
  pg_temp.draft('00e002', pg_temp.bad('reject-page-shape', '{event}', '"x"')), 'event page details are not valid');
select pg_temp.expect_msg('an empty event title is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-page-name', '{event,name}', '"   "')), 'Enter an event title');
select pg_temp.expect_msg('an over-long summary is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-page-summary', '{event,summary}', to_jsonb(repeat('x', 301)))), 'too long');
select pg_temp.expect_msg('a cover image from another studio is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-page-cover-studio', '{event,cover_image_url}',
    to_jsonb('https://dev.example.supabase.co/storage/v1/object/public/event-media/' || gen_random_uuid() || '/x/cover.jpg'))), 'Upload the cover image again');
select pg_temp.expect_msg('an external cover image URL is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-page-cover-external', '{event,cover_image_url}',
    to_jsonb('https://evil.example/storage/v1/object/public/event-media/' || pg_temp.u('00a001') || '/../x.jpg?' || ' x'))), 'Upload the cover image again');
select pg_temp.expect_msg('more than six highlights are refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-page-many', '{event,highlights}', '["1","2","3","4","5","6","7"]')), 'up to 6 highlights');
select pg_temp.expect_msg('an empty highlight is refused',
  pg_temp.draft('00e002', pg_temp.bad('reject-page-blank', '{event,highlights}', '["Live band", "   "]')), 'up to 6 highlights');
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
select pg_temp.chk('programs are unpublished drafts with registration CLOSED on profile v3',
  pg_temp.n($q$select count(*) from public.event_competition_programs where event_id = pg_temp.u('00e001')
               and status = 'draft' and registration_status = 'closed' and profile_locked_at is null
               and rules_profile_key = 'studio_simple' and rules_profile_version = 3$q$) = 2);
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
      = 'pro_am:Pro/Am Single-Dance — American Smooth:american_smooth,custom:Cabaret:-,pro_am:Pro/Am Single-Dance — International Latin:international_latin',
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
select pg_temp.chk('the event page changes are saved; title, venue, dates and slug are untouched',
  (select name = 'P10C5 Event 1' and slug = 't-p10c5-e1' and start_date = current_date + 30 and end_date = current_date + 30
          and short_description = 'A friendly studio competition.' and public_summary = short_description
          and public_highlights = array['Live band', 'Pro/Am scholarship'] and public_registration_info = 'Entries close two weeks before the event.'
          and cover_image_url = 'https://dev.example.supabase.co/storage/v1/object/public/event-media/' || pg_temp.u('00a001') || '/p10c5/cover.jpg'
          and public_cover_image_url = cover_image_url
   from public.events where id = pg_temp.u('00e001')),
  (select row_to_json(e)::text from (select name, slug, short_description, public_highlights, public_registration_info, cover_image_url from public.events where id = pg_temp.u('00e001')) e));
select pg_temp.chk('registration basics are saved on each program, not on the event (ordinary registration untouched)',
  (select count(*) = 2 and bool_and(configuration #> '{setup,registration}' = jsonb_build_object(
            'opens_at', '2026-01-01T00:00:00Z'::timestamptz, 'closes_at', '2030-01-01T00:00:00Z'::timestamptz, 'account_required', false))
   from public.event_competition_programs where event_id = pg_temp.u('00e001'))
  and (select not registration_required and account_required_for_registration
              and registration_opens_at is null and registration_closes_at is null
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
select pg_temp.chk('a request without event page changes leaves the event page alone',
  (select short_description is null and cardinality(public_highlights) = 0 and public_registration_info is null and cover_image_url is null
   from public.events where id = pg_temp.u('00e003')));
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
  and (select name = 'Pro/Am Single-Dance — Additional American Style Dances' from public.event_competition_contests
       where event_id = pg_temp.u('00e005') and configuration #>> '{setup,style}' = 'american_additional'));
select pg_temp.expect_ok('a program may use more than 20 dances across its categories (the 20 cap is per category)',
  pg_temp.draft('00e009', pg_temp.one('p10c5-many-dances', 'competition', jsonb_build_object(
    'key', 'ballroom', 'name', 'Ballroom', 'adjudication', 'adjudicated', 'judging', 'placements', 'registration_fee', null,
    'dances', (select jsonb_agg(jsonb_build_object('key', d)) from jsonb_array_elements_text('["std_waltz","std_tango","std_viennese_waltz","std_slow_foxtrot","std_quickstep","latin_cha_cha","latin_samba","latin_rumba","latin_paso_doble","latin_jive","smooth_waltz","smooth_tango","smooth_foxtrot","smooth_viennese_waltz","rhythm_cha_cha","rhythm_rumba","rhythm_swing","rhythm_bolero","rhythm_mambo","addl_salsa","addl_hustle"]'::jsonb) d),
    'categories', (select jsonb_agg(jsonb_build_object('type', 'ndca_pro_am', 'style', st, 'divisions', '[{"name": "Bronze"}]'::jsonb,
                         'dances', (select jsonb_agg(d) from jsonb_array_elements_text('["std_waltz","std_tango","std_viennese_waltz","std_slow_foxtrot","std_quickstep","latin_cha_cha","latin_samba","latin_rumba","latin_paso_doble","latin_jive","smooth_waltz","smooth_tango","smooth_foxtrot","smooth_viennese_waltz","rhythm_cha_cha","rhythm_rumba","rhythm_swing","rhythm_bolero","rhythm_mambo","addl_salsa","addl_hustle"]'::jsonb) d
                                    where d like (case st when 'international_standard' then 'std_%' when 'international_latin' then 'latin_%'
                                                          when 'american_smooth' then 'smooth_%' when 'american_rhythm' then 'rhythm_%' else 'addl_%' end)),
                         'pricing', '{"model": "free", "amount": null}'::jsonb))
                    from unnest(array['international_standard', 'international_latin', 'american_smooth', 'american_rhythm', 'american_additional']) st)))));
select pg_temp.chk('the 21-dance Ballroom program has five style categories',
  pg_temp.n($q$select count(*) from public.event_competition_dances where event_id = pg_temp.u('00e009')$q$) = 21
  and pg_temp.n($q$select count(*) from public.event_competition_contests where event_id = pg_temp.u('00e009')$q$) = 5);
select pg_temp.expect_ok('multiple styles create one program each; Other may use Gold / Silver / Bronze',
  pg_temp.draft('00e006', jsonb_build_object('request_key', 'p10c5-multi-style', 'profile_key', 'studio_simple', 'profile_version', 3,
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
-- Event Details: venue, address, dates, times and time zone (owner/admin roles only)
-- ============================================================================
select pg_temp.chk('the operations guard is installed: role function (no anon) and the events trigger',
  to_regprocedure('public.can_edit_competition_event_operations(uuid)') is not null
  and not has_function_privilege('anon', 'public.can_edit_competition_event_operations(uuid)', 'EXECUTE')
  and exists (select 1 from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'protect_competition_event_operations' and tgenabled = 'O'));

select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('an instructor cannot change a competition event venue directly (forged table update)',
  $q$update public.events set venue_name = 'Elsewhere' where id = pg_temp.u('00f001')$q$, 'Only studio owners and admins');
select pg_temp.expect_msg('an instructor cannot change competition event dates or time zone directly',
  $q$update public.events set start_date = date '2027-05-01', timezone = 'America/Denver' where id = pg_temp.u('00f001')$q$, 'Only studio owners and admins');
select pg_temp.expect_msg('an instructor cannot turn a competition event into another type to bypass the guard',
  $q$update public.events set event_type = 'social' where id = pg_temp.u('00f001')$q$, 'Only studio owners and admins');
select pg_temp.expect_ok('an instructor keeps every other existing event permission (description)',
  $q$update public.events set description = 'Instructor note' where id = pg_temp.u('00f001')$q$);
select pg_temp.expect_ok('ordinary (non-competition) events keep their existing behaviour',
  $q$update public.events set start_date = date '2027-04-01', end_date = date '2027-04-02' where id = pg_temp.u('00f009')$q$);

select pg_temp.as_user(pg_temp.u('000004'));
select pg_temp.expect_msg('organizer staff cannot change venue or dates through the draft generator',
  pg_temp.ops('00f002', pg_temp.page('p10c5-ops-staff', '{"venue_name": "Grand Ballroom"}')), 'can change the venue, dates, times or time zone.');
select pg_temp.expect_msg('organizer staff cannot change venue directly either',
  $q$update public.events set city = 'Dallas' where id = pg_temp.u('00f002')$q$, 'Only studio owners and admins');
select pg_temp.expect_ok('organizer staff keep competition setup with presentation-only changes',
  pg_temp.ops('00f002', pg_temp.page('p10c5-ops-staff-ok', '{"summary": "Staff summary"}')));

select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_ok('an organizer admin changes venue, address, dates, times and time zone inline',
  pg_temp.ops('00f003', pg_temp.page('p10c5-ops-admin', '{"venue_name": "Grand Ballroom", "address_line_1": "1 Main St", "city": "Dallas",
    "state": "TX", "postal_code": "75201", "start_date": "2027-04-10", "end_date": "2027-04-11", "start_time": "09:30", "end_time": null,
    "timezone": "America/Denver"}')));
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.chk('only the changed fields were written; slug, status, visibility and other details kept',
  (select venue_name = 'Grand Ballroom' and address_line_1 = '1 Main St' and city = 'Dallas' and state = 'TX' and postal_code = '75201'
          and start_date = date '2027-04-10' and end_date = date '2027-04-11' and start_time = time '09:30' and end_time is null
          and timezone = 'America/Denver' and slug = 't-p10c5-ops3' and status = 'published' and visibility = 'public'
          and name = 'P10C5 Ops Event 3' and event_type = 'competition' and account_required_for_registration
   from public.events where id = pg_temp.u('00f003')),
  (select row_to_json(e)::text from (select venue_name, start_date, end_date, start_time, end_time, timezone, slug from public.events where id = pg_temp.u('00f003')) e));
select pg_temp.chk('a request without venue or date changes leaves them alone',
  (select venue_name = 'Main Studio' and start_date = date '2027-03-06' and timezone = 'America/Chicago' and short_description = 'Staff summary'
   from public.events where id = pg_temp.u('00f002')));
select pg_temp.expect_ok('writes without a user session (service role, migrations) are not affected by the guard',
  $q$update public.events set city = 'Austin' where id = pg_temp.u('00f002')$q$);

select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('an unknown time zone is refused',
  pg_temp.ops('00f004', pg_temp.page('p10c5-ops-tz', '{"timezone": "Mars/Base"}')), 'valid dates, times and a time zone');
select pg_temp.expect_msg('an impossible date is refused',
  pg_temp.ops('00f004', pg_temp.page('p10c5-ops-date', '{"start_date": "2027-02-30"}')), 'valid dates, times and a time zone');
select pg_temp.expect_msg('the end date cannot precede the start date',
  pg_temp.ops('00f004', pg_temp.page('p10c5-ops-order', '{"start_date": "2027-03-10"}')), 'cannot be before the start date');
select pg_temp.expect_msg('on a one-day event the end time must follow the start time',
  pg_temp.ops('00f004', pg_temp.page('p10c5-ops-time', '{"end_date": "2027-03-06", "end_time": "17:00"}')), 'end time must be after the start time');
select pg_temp.expect_msg('a start date and a time zone cannot be cleared',
  pg_temp.ops('00f004', pg_temp.page('p10c5-ops-clear', '{"start_date": null}')), 'not valid');
select pg_temp.expect_msg('the state must be a two-letter code',
  pg_temp.ops('00f004', pg_temp.page('p10c5-ops-state', '{"state": "Texas"}')), 'venue or address is not valid');
select pg_temp.expect_msg('slug, status and visibility cannot be changed here',
  pg_temp.ops('00f004', pg_temp.page('p10c5-ops-slug', '{"slug": "taken"}')), 'event page details are not valid');
select pg_temp.expect_msg('active registrations block venue and date changes (registrants are notified only by Edit event)',
  pg_temp.ops('00f005', pg_temp.page('p10c5-ops-reg', '{"venue_name": "Elsewhere"}')), 'already has registrations');
select pg_temp.expect_msg('additional event locations block venue changes',
  pg_temp.ops('00f006', pg_temp.page('p10c5-ops-loc', '{"venue_name": "Elsewhere"}')), 'additional locations');
select pg_temp.expect_msg('dated schedule items block date and time zone changes',
  pg_temp.ops('00f007', pg_temp.page('p10c5-ops-sched', '{"timezone": "America/New_York"}')), 'dated schedule items or sessions');
select pg_temp.expect_ok('a venue change is still allowed when only dated schedule items exist',
  pg_temp.ops('00f007', pg_temp.page('p10c5-ops-sched-venue', '{"venue_name": "Annex"}')));
select pg_temp.chk('rejected requests changed nothing on the event',
  (select venue_name = 'Main Studio' and timezone = 'America/Chicago' and start_date = date '2027-03-06'
   from public.events where id = pg_temp.u('00f004'))
  and pg_temp.n($q$select count(*) from public.event_competition_programs where event_id in (pg_temp.u('00f004'), pg_temp.u('00f005'), pg_temp.u('00f006'))$q$) = 0);

-- ============================================================================
-- NDCA Multi-Dance: one entry, a prescribed set in the style's order, registration held
-- ============================================================================
select pg_temp.expect_msg('a Multi-Dance set must follow the style order',
  pg_temp.ops('00f008', pg_temp.one('p10c5-multi-order', 'competition',
    '{"key": "ballroom", "name": "Ballroom", "adjudication": "adjudicated", "judging": "placements", "registration_fee": null,
      "dances": [{"key": "smooth_waltz"}, {"key": "smooth_foxtrot"}],
      "categories": [{"type": "ndca_pro_am_multi", "style": "american_smooth", "divisions": [{"name": "Bronze · B"}],
                      "dances": ["smooth_foxtrot", "smooth_waltz"], "pricing": {"model": "per_entry", "amount": 60}}]}'::jsonb)), 'American Smooth order');
select pg_temp.expect_msg('a Multi-Dance set needs at least two dances',
  pg_temp.ops('00f008', pg_temp.one('p10c5-multi-one', 'competition',
    '{"key": "ballroom", "name": "Ballroom", "adjudication": "adjudicated", "judging": "placements", "registration_fee": null,
      "dances": [{"key": "smooth_waltz"}],
      "categories": [{"type": "ndca_pro_am_multi", "style": "american_smooth", "divisions": [{"name": "Bronze · B"}],
                      "dances": ["smooth_waltz"], "pricing": {"model": "per_entry", "amount": 60}}]}'::jsonb)), 'at least 2 dances');
select pg_temp.expect_msg('Open Amateur dances every dance of the style (NDCA X.B.4)',
  pg_temp.ops('00f008', pg_temp.one('p10c5-multi-open', 'competition',
    '{"key": "ballroom", "name": "Ballroom", "adjudication": "adjudicated", "judging": "placements", "registration_fee": null,
      "dances": [{"key": "latin_cha_cha"}, {"key": "latin_rumba"}],
      "categories": [{"type": "ndca_amateur_multi", "style": "international_latin",
                      "divisions": [{"name": "Open Amateur · Adult", "axes": {"skill_level": "Open Amateur", "age_group": "Adult"}}],
                      "dances": ["latin_cha_cha", "latin_rumba"], "pricing": {"model": "per_entry", "amount": 60}}]}'::jsonb)), 'Open Amateur dances every International Latin dance');
select pg_temp.expect_msg('Multi-Dance is not offered in Additional American Style Dances',
  pg_temp.ops('00f008', pg_temp.one('p10c5-multi-addl', 'competition',
    '{"key": "ballroom", "name": "Ballroom", "adjudication": "adjudicated", "judging": "placements", "registration_fee": null,
      "dances": [{"key": "addl_salsa"}, {"key": "addl_hustle"}],
      "categories": [{"type": "ndca_pro_am_multi", "style": "american_additional", "divisions": [{"name": "Bronze · B"}],
                      "dances": ["addl_hustle", "addl_salsa"], "pricing": {"model": "per_entry", "amount": 60}}]}'::jsonb)), 'Choose an available style');
select pg_temp.expect_ok('a Pro/Am Multi-Dance and a full-set Open Amateur Multi-Dance are created',
  pg_temp.ops('00f008', pg_temp.one('p10c5-multi-ok', 'competition',
    '{"key": "ballroom", "name": "Ballroom", "adjudication": "adjudicated", "judging": "placements", "registration_fee": null,
      "dances": [{"key": "smooth_waltz"}, {"key": "smooth_foxtrot"}, {"key": "latin_cha_cha"}, {"key": "latin_samba"}, {"key": "latin_rumba"},
                 {"key": "latin_paso_doble"}, {"key": "latin_jive"}],
      "categories": [{"type": "ndca_pro_am_multi", "style": "american_smooth",
                      "divisions": [{"name": "Bronze · B", "skill_label": "Bronze", "age_label": "B", "axes": {"skill_level": "Bronze", "age_group": "B"}}],
                      "dances": ["smooth_waltz", "smooth_foxtrot"], "pricing": {"model": "per_entry", "amount": 60}},
                     {"type": "ndca_amateur_multi", "style": "international_latin",
                      "divisions": [{"name": "Open Amateur · Adult", "axes": {"skill_level": "Open Amateur", "age_group": "Adult"}}],
                      "dances": ["latin_cha_cha", "latin_samba", "latin_rumba", "latin_paso_doble", "latin_jive"], "pricing": {"model": "free", "amount": null}}]}'::jsonb)));
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.chk('one Multi-Dance contest per set: multi_dance, prescribed set, every dance required, in style order, hold recorded',
  (select c.contest_type = 'multi_dance' and c.entry_format = 'pro_am' and c.name = 'Pro/Am Multi-Dance — American Smooth'
          and c.configuration #>> '{setup,event_form}' = 'multi_dance'
          and c.configuration #>> '{setup,registration_hold}' = 'multi_dance_results_not_operational'
          and r.dance_selection_mode = 'prescribed_set' and r.pricing_method = 'flat_entry' and r.base_entry_fee = 60
          and (select string_agg(d.dance_key || ':' || dd.required::text, ',' order by dd.sort_order)
               from public.event_competition_division_dances dd join public.event_competition_dances d on d.id = dd.dance_id
               join public.event_competition_divisions v on v.id = dd.division_id where v.contest_id = c.id) = 'smooth_waltz:true,smooth_foxtrot:true'
   from public.event_competition_contests c join public.event_competition_contest_registration_rules r on r.contest_id = c.id
   where c.event_id = pg_temp.u('00f008') and c.entry_format = 'pro_am')
  and pg_temp.n($q$select count(*) from public.event_competition_contests where event_id = pg_temp.u('00f008')$q$) = 2
  and pg_temp.n($q$select count(*) from public.event_competition_contests where event_id = pg_temp.u('00f008') and contest_type = 'single_dance'$q$) = 0);
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('the Multi-Dance draft publishes', format('select public.publish_competition_program(%L)',
  (select id from public.event_competition_programs where event_id = pg_temp.u('00f008'))));
select pg_temp.expect_msg('Multi-Dance blocks opening registration (combined results are not operational)',
  format('select public.open_competition_registration(%L)', (select id from public.event_competition_programs where event_id = pg_temp.u('00f008'))),
  'COMP10C_REGISTRATION_HOLD');
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.chk('the refused open left registration closed',
  (select registration_status = 'closed' from public.event_competition_programs where event_id = pg_temp.u('00f008')));

-- ============================================================================
-- 10B path unchanged
-- ============================================================================
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('create_simple_competition still works with studio_simple@1',
  $q$select public.create_simple_competition(pg_temp.u('00e007'), '{"profile_key": "studio_simple", "profile_version": 1,
      "request_key": "p10c5-legacy-0001", "preset": "country", "judging": "placements", "name": "Legacy", "division_preset": "levels_basic",
      "categories": [{"type": "couples", "price": 10, "dances": ["two_step"]}], "divisions": [{"name": "Open"}]}'::jsonb)$q$);
select pg_temp.chk('the legacy program has no setup configuration (no pricing guard impact)',
  (select configuration->'setup' is null and rules_profile_version = 1 from public.event_competition_programs where event_id = pg_temp.u('00e007')));
select pg_temp.expect_msg('create_simple_competition cannot use the schema-2 profile',
  $q$select public.create_simple_competition(pg_temp.u('00e002'), '{"profile_key": "studio_simple", "profile_version": 3,
      "request_key": "p10c5-legacy-0002", "preset": "country", "judging": "placements", "name": "Legacy",
      "categories": [{"type": "couples", "price": 10, "dances": ["two_step"]}], "divisions": [{"name": "Open"}]}'::jsonb)$q$,
  'Unknown competition type');
select pg_temp.expect_msg('pricing completion is not offered for legacy categories',
  format('select public.set_competition_category_pricing(%L, %L, 10)',
    (select c.id from public.event_competition_contests c where c.event_id = pg_temp.u('00e007') limit 1), 'per_dance'), 'Advanced settings');

-- ============================================================================
-- Registration isolation (20261115090000): competition setup, publish, open and close never change the event's
-- ordinary ticket registration (registration_required, account requirement, registration window), and
-- competition registration follows the program's own settings.
-- ============================================================================
reset role;
select set_config('request.jwt.claims', '', true);
-- Studio events (00e101 ordinary registration ON with a window, 00e102 OFF) and organizer events (00f101 ON, 00f102
-- OFF), each with a spectator ticket type; 00e103 is a studio event whose ordinary registration is ON and open.
insert into public.events (id, studio_id, organizer_id, name, slug, event_type, start_date, end_date, status, visibility,
                           registration_required, account_required_for_registration, registration_opens_at, registration_closes_at)
values
  (pg_temp.u('00e101'), pg_temp.u('00a001'), null, 'P10C5 Iso Studio On', 't-p10c5-iso-e101', 'competition', current_date + 40, current_date + 41,
   'published', 'public', true, false, '2026-01-01T00:00:00Z', '2031-01-01T00:00:00Z'),
  (pg_temp.u('00e102'), pg_temp.u('00a001'), null, 'P10C5 Iso Studio Off', 't-p10c5-iso-e102', 'competition', current_date + 40, current_date + 41,
   'published', 'public', false, true, null, null),
  (pg_temp.u('00e103'), pg_temp.u('00a001'), null, 'P10C5 Iso Studio Window', 't-p10c5-iso-e103', 'competition', current_date + 40, current_date + 41,
   'published', 'public', true, false, '2026-01-01T00:00:00Z', '2031-01-01T00:00:00Z'),
  (pg_temp.u('00f101'), pg_temp.u('00a001'), pg_temp.u('00b001'), 'P10C5 Iso Org On', 't-p10c5-iso-f101', 'competition', current_date + 40, current_date + 41,
   'published', 'public', true, true, '2026-02-01T00:00:00Z', '2031-02-01T00:00:00Z'),
  (pg_temp.u('00f102'), pg_temp.u('00a001'), pg_temp.u('00b001'), 'P10C5 Iso Org Off', 't-p10c5-iso-f102', 'competition', current_date + 40, current_date + 41,
   'published', 'public', false, false, null, null);
insert into public.event_ticket_types (event_id, name, price, capacity, sale_starts_at, sale_ends_at)
select e, 'Spectator', 25, 100, '2026-01-01T00:00:00Z', '2031-01-01T00:00:00Z'
from unnest(array[pg_temp.u('00e101'), pg_temp.u('00e102'), pg_temp.u('00e103'), pg_temp.u('00f101'), pg_temp.u('00f102')]) e;
insert into t_out
select 'iso_before', jsonb_object_agg(e.id::text, jsonb_build_object(
  'row', md5((to_jsonb(e) - 'updated_at')::text), 'updated_at', e.updated_at, 'ctid', e.ctid::text,
  'tickets', (select md5(string_agg(row_to_json(t)::text, ',' order by t.id)) from public.event_ticket_types t where t.event_id = e.id)))
from public.events e where e.id in (pg_temp.u('00e101'), pg_temp.u('00e102'), pg_temp.u('00e103'), pg_temp.u('00f101'), pg_temp.u('00f102'));
insert into t_out select 'iso_people', jsonb_build_object(
  'clients', (select count(*) from public.clients where studio_id = pg_temp.u('00a001')),
  'leads', (select count(*) from public.lead_activities where studio_id = pg_temp.u('00a001')));
-- Whether an event's row and ticket types are exactly as captured before the section, and the row was never
-- updated at all (its physical row version is unchanged; updated_at alone cannot show this inside one transaction).
create or replace function pg_temp.iso_same(p_event text) returns boolean
language sql stable as $$
  select (select md5((to_jsonb(e) - 'updated_at')::text) from public.events e where e.id = pg_temp.u(p_event))
           = (select v #>> array[pg_temp.u(p_event)::text, 'row'] from t_out where k = 'iso_before')
     and (select e.ctid::text from public.events e where e.id = pg_temp.u(p_event))
           = (select v #>> array[pg_temp.u(p_event)::text, 'ctid'] from t_out where k = 'iso_before')
     and (select (v #>> array[pg_temp.u(p_event)::text, 'updated_at'])::timestamptz from t_out where k = 'iso_before')
           = (select updated_at from public.events where id = pg_temp.u(p_event))
     and (select md5(string_agg(row_to_json(t)::text, ',' order by t.id)) from public.event_ticket_types t where t.event_id = pg_temp.u(p_event))
           = (select v #>> array[pg_temp.u(p_event)::text, 'tickets'] from t_out where k = 'iso_before')
$$;
-- A one-category Country request with its own competition registration settings.
create or replace function pg_temp.iso(p_key text, p_registration jsonb) returns jsonb
language sql immutable as $$
  select pg_temp.one(p_key, 'competition',
    '{"key": "country", "name": "Iso", "adjudication": "adjudicated", "judging": "medal_marks", "registration_fee": null, "dances": [{"key": "two_step"}],
      "categories": [{"type": "couples", "divisions": [{"name": "Open"}], "dances": ["two_step"], "pricing": {"model": "per_entry", "amount": 30}}]}'::jsonb)
    || jsonb_build_object('registration', p_registration);
$$;
create or replace function pg_temp.prog(p_event text) returns uuid
language sql stable as $$ select id from public.event_competition_programs where event_id = pg_temp.u(p_event) $$;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

-- Draft creation (studio owner on studio events; organizer admin on organizer events).
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('studio: draft on an event with ordinary registration ON',
  pg_temp.draft('00e101', pg_temp.iso('p10c5-iso-e101', '{"opens_at": "2026-03-01T00:00:00Z", "closes_at": "2029-03-01T00:00:00Z", "account_required": true}')));
select pg_temp.expect_ok('studio: draft on an event with ordinary registration OFF',
  pg_temp.draft('00e102', pg_temp.iso('p10c5-iso-e102', '{"opens_at": null, "closes_at": null, "account_required": false}')));
select pg_temp.expect_ok('studio: draft with a competition window that has not opened yet',
  pg_temp.draft('00e103', pg_temp.iso('p10c5-iso-e103', '{"opens_at": "2035-01-01T00:00:00Z", "closes_at": "2036-01-01T00:00:00Z", "account_required": false}')));
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_ok('organizer: draft on an event with ordinary registration ON',
  pg_temp.draft('00f101', pg_temp.iso('p10c5-iso-f101', '{"opens_at": null, "closes_at": null, "account_required": false}')));
select pg_temp.expect_ok('organizer: draft on an event with ordinary registration OFF',
  pg_temp.draft('00f102', pg_temp.iso('p10c5-iso-f102', '{"opens_at": "2026-03-01T00:00:00Z", "closes_at": null, "account_required": true}')));
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.chk('studio draft preserves registration_required = true, its account setting, window and tickets', pg_temp.iso_same('00e101'));
select pg_temp.chk('studio draft preserves registration_required = false (ordinary ticketing stays off)', pg_temp.iso_same('00e102')
  and (select not registration_required from public.events where id = pg_temp.u('00e102')));
select pg_temp.chk('organizer draft preserves registration_required = true', pg_temp.iso_same('00f101'));
select pg_temp.chk('organizer draft preserves registration_required = false', pg_temp.iso_same('00f102')
  and (select not registration_required from public.events where id = pg_temp.u('00f102')));
select pg_temp.chk('the competition registration settings are stored on the program',
  (select configuration #> '{setup,registration}' = jsonb_build_object('opens_at', '2026-03-01T00:00:00+00:00'::timestamptz,
            'closes_at', '2029-03-01T00:00:00+00:00'::timestamptz, 'account_required', true)
   from public.event_competition_programs where id = pg_temp.prog('00e101'))
  and (select configuration #> '{setup,registration}' = '{"opens_at": null, "closes_at": null, "account_required": false}'::jsonb
       from public.event_competition_programs where id = pg_temp.prog('00e102')),
  (select (configuration #> '{setup,registration}')::text from public.event_competition_programs where id = pg_temp.prog('00e101')));
select pg_temp.chk('an earlier draft (reviewed request) left the ordinary registration fields as they were',
  (select not registration_required and account_required_for_registration and registration_opens_at is null and registration_closes_at is null
   from public.events where id = pg_temp.u('00e001')));
select pg_temp.chk('a draft with an event page change updates only that page field',
  (select short_description = 'Staff summary' and not registration_required and account_required_for_registration
          and registration_opens_at is null and registration_closes_at is null
   from public.events where id = pg_temp.u('00f002')));

-- Publish: competition drafts are not public and ordinary registration is unchanged.
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('studio: publish (ordinary ON)', format('select public.publish_competition_program(%L)', pg_temp.prog('00e101')));
select pg_temp.expect_ok('studio: publish (ordinary OFF)', format('select public.publish_competition_program(%L)', pg_temp.prog('00e102')));
select pg_temp.expect_ok('studio: publish (future window)', format('select public.publish_competition_program(%L)', pg_temp.prog('00e103')));
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_ok('organizer: publish (ordinary ON)', format('select public.publish_competition_program(%L)', pg_temp.prog('00f101')));
select pg_temp.expect_ok('organizer: publish (ordinary OFF)', format('select public.publish_competition_program(%L)', pg_temp.prog('00f102')));
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.chk('publish does not change ordinary registration on any event',
  pg_temp.iso_same('00e101') and pg_temp.iso_same('00e102') and pg_temp.iso_same('00e103') and pg_temp.iso_same('00f101') and pg_temp.iso_same('00f102'));
select pg_temp.chk('published but unopened competitions are not public',
  not public.competition_registration_event_open(pg_temp.u('00e101')) and not public.competition_registration_event_open(pg_temp.u('00e102'))
  and not public.competition_registration_event_open(pg_temp.u('00f101')) and not public.competition_registration_event_open(pg_temp.u('00f102')));

-- Explicit open: authorization, competition-only prerequisites, ordinary registration untouched.
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('an outsider cannot open competition registration',
  format('select public.open_competition_registration(%L)', pg_temp.prog('00e102')), 'COMP10C_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000003'));
select pg_temp.expect_msg('a studio instructor cannot open competition registration',
  format('select public.open_competition_registration(%L)', pg_temp.prog('00e102')), 'COMP10C_FORBIDDEN');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('studio: open succeeds while ordinary ticket registration is OFF',
  format('select public.open_competition_registration(%L)', pg_temp.prog('00e102')));
select pg_temp.expect_ok('studio: open on the event with ordinary registration ON',
  format('select public.open_competition_registration(%L)', pg_temp.prog('00e101')));
select pg_temp.expect_ok('studio: open with a competition window that has not started',
  format('select public.open_competition_registration(%L)', pg_temp.prog('00e103')));
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_ok('organizer: open while ordinary registration is OFF',
  format('select public.open_competition_registration(%L)', pg_temp.prog('00f102')));
select pg_temp.expect_ok('organizer: open while ordinary registration is ON',
  format('select public.open_competition_registration(%L)', pg_temp.prog('00f101')));
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.chk('open does not turn on, extend or otherwise change ordinary registration or tickets',
  pg_temp.iso_same('00e101') and pg_temp.iso_same('00e102') and pg_temp.iso_same('00e103') and pg_temp.iso_same('00f101') and pg_temp.iso_same('00f102')
  and (select bool_and(not registration_required) from public.events where id in (pg_temp.u('00e102'), pg_temp.u('00f102'))));
select pg_temp.chk('competition registration follows the competition state, not the ordinary flag',
  public.competition_registration_event_open(pg_temp.u('00e102')) and public.competition_registration_event_open(pg_temp.u('00f102'))
  and public.competition_registration_event_open(pg_temp.u('00e101')) and public.competition_registration_event_open(pg_temp.u('00f101')));
select pg_temp.chk('the competition window is enforced: a window that has not started stays closed although the ordinary window is open',
  not public.competition_registration_event_open(pg_temp.u('00e103'))
  and (select registration_required and registration_opens_at <= now() and registration_closes_at >= now() from public.events where id = pg_temp.u('00e103')));
select pg_temp.chk('the account requirement comes from the competition settings',
  public.competition_registration_account_required(pg_temp.u('00e101'))       -- competition: required; event: not required
  and not public.competition_registration_account_required(pg_temp.u('00f101'))  -- competition: not required; event: required
  and not public.competition_registration_account_required(pg_temp.u('00e102'))
  and public.competition_registration_account_required(pg_temp.u('00e103')));    -- nothing open (its own setting is "not required"): defaults to required
select pg_temp.expect_msg('a guest cannot start a registration where the competition requires an account (event does not)',
  format('select public.start_competition_registration(%L, %L, %L::jsonb, null)', pg_temp.u('00e101'), gen_random_uuid(), '{}'), 'COMP10C_SIGN_IN_REQUIRED');
select pg_temp.expect_msg('a closed competition window refuses registration although ordinary registration is open',
  format('select public.start_competition_registration(%L, %L, %L::jsonb, null)', pg_temp.u('00e103'), gen_random_uuid(), '{}'), 'COMP10C_CLOSED');
set local role anon;
select pg_temp.chk('anon sees the open competition catalog on an event without ordinary registration',
  pg_temp.n(format('select count(*) from public.event_competition_programs where event_id = %L', pg_temp.u('00e102'))) = 1
  and pg_temp.n(format('select count(*) from public.event_competition_programs where event_id = %L', pg_temp.u('00e103'))) = 0);
reset role;

-- Forged requests and direct writes.
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_msg('a manager cannot rewrite the competition window directly',
  format($q$update public.event_competition_programs set configuration = jsonb_set(configuration, '{setup,registration,opens_at}', '"2020-01-01T00:00:00Z"') where id = %L$q$, pg_temp.prog('00e103')),
  'set only by competition setup');
select pg_temp.expect_msg('a manager cannot drop the competition settings to fall back to the event settings',
  format($q$update public.event_competition_programs set configuration = configuration #- '{setup,registration}' where id = %L$q$, pg_temp.prog('00e103')),
  'set only by competition setup');
select pg_temp.expect_msg('a manager cannot insert a program carrying competition settings',
  format($q$insert into public.event_competition_programs (event_id, name, configuration) values (%L, 'Forged', '{"setup": {"registration": {"opens_at": null, "closes_at": null, "account_required": false}}}')$q$, pg_temp.u('00e102')),
  'set only by competition setup');
select pg_temp.expect_ok('other program fields stay editable by managers',
  format($q$update public.event_competition_programs set name = 'Iso renamed' where id = %L$q$, pg_temp.prog('00e103')));
select pg_temp.expect_msg('registration status cannot be written directly',
  format($q$update public.event_competition_programs set registration_status = 'open' where id = %L$q$, pg_temp.prog('00e103')), 'permission denied');
select pg_temp.as_user(pg_temp.u('000004'));
select pg_temp.expect_msg('organizer staff cannot rewrite the competition window directly',
  format($q$update public.event_competition_programs set configuration = jsonb_set(configuration, '{setup,registration,account_required}', 'false') where id = %L$q$, pg_temp.prog('00f102')),
  'set only by competition setup');
select pg_temp.as_user(pg_temp.u('000002'));
select pg_temp.expect_msg('an outsider cannot close competition registration',
  format('select public.close_competition_registration(%L)', pg_temp.prog('00e102')), 'COMP10C_FORBIDDEN');
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.chk('forged writes changed nothing',
  (select configuration #>> '{setup,registration,opens_at}' = '2035-01-01T00:00:00+00:00' from public.event_competition_programs where id = pg_temp.prog('00e103'))
  and (select configuration #>> '{setup,registration,account_required}' = 'true' from public.event_competition_programs where id = pg_temp.prog('00f102'))
  and pg_temp.n(format($q$select count(*) from public.event_competition_programs where event_id = %L$q$, pg_temp.u('00e102'))) = 1
  and (select registration_status = 'open' from public.event_competition_programs where id = pg_temp.prog('00e102')),
  (select (configuration #> '{setup,registration}')::text from public.event_competition_programs where id = pg_temp.prog('00e103')));
select pg_temp.chk('anon cannot call the draft generator or open/close registration',
  not has_function_privilege('anon', 'public.create_competition_draft(uuid, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.open_competition_registration(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.close_competition_registration(uuid)', 'EXECUTE'));

-- Explicit close: ordinary registration stays as it was (ON stays ON, OFF stays OFF).
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('studio: close (ordinary ON)', format('select public.close_competition_registration(%L)', pg_temp.prog('00e101')));
select pg_temp.expect_ok('studio: close (ordinary OFF)', format('select public.close_competition_registration(%L)', pg_temp.prog('00e102')));
select pg_temp.as_user(pg_temp.u('000005'));
select pg_temp.expect_ok('organizer: close (ordinary ON)', format('select public.close_competition_registration(%L)', pg_temp.prog('00f101')));
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.chk('close leaves ordinary registration, its window and tickets unchanged',
  pg_temp.iso_same('00e101') and pg_temp.iso_same('00e102') and pg_temp.iso_same('00f101') and pg_temp.iso_same('00f102')
  and (select bool_and(registration_required) from public.events where id in (pg_temp.u('00e101'), pg_temp.u('00f101'))));
select pg_temp.chk('closed competitions are no longer public; the other open one still is',
  not public.competition_registration_event_open(pg_temp.u('00e101')) and not public.competition_registration_event_open(pg_temp.u('00e102'))
  and not public.competition_registration_event_open(pg_temp.u('00f101')) and public.competition_registration_event_open(pg_temp.u('00f102')));
select pg_temp.chk('no clients or leads were created for the host studio',
  (select v = jsonb_build_object(
     'clients', (select count(*) from public.clients where studio_id = pg_temp.u('00a001')),
     'leads', (select count(*) from public.lead_activities where studio_id = pg_temp.u('00a001')))
   from t_out where k = 'iso_people'));

-- Legacy programs (no setup registration settings) keep the exact 10C rule.
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('the legacy program publishes', format('select public.publish_competition_program(%L)', pg_temp.prog('00e007')));
select pg_temp.expect_msg('a legacy program still needs the event registration flag to open',
  format('select public.open_competition_registration(%L)', pg_temp.prog('00e007')), 'COMP10C_EVENT_REGISTRATION_OFF');
reset role;
update public.events set registration_required = true where id = pg_temp.u('00e007');
select pg_temp.as_user(pg_temp.u('000001'));
select pg_temp.expect_ok('the legacy program opens once the event flag is on',
  format('select public.open_competition_registration(%L)', pg_temp.prog('00e007')));
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.chk('legacy gate: open while the event flag is on', public.competition_registration_event_open(pg_temp.u('00e007'))
  and public.competition_registration_account_required(pg_temp.u('00e007')) = (select account_required_for_registration from public.events where id = pg_temp.u('00e007')));
update public.events set registration_required = false where id = pg_temp.u('00e007');
select pg_temp.chk('legacy gate: closed when the event flag is off (unchanged 10C behaviour)', not public.competition_registration_event_open(pg_temp.u('00e007')));
select pg_temp.chk('the gate keeps its legacy predicate and the setup-program branch',
  position('e.registration_required' in pg_get_functiondef('public.competition_registration_program_open(uuid,uuid)'::regprocedure)) > 0
  and position($s$p.configuration #> '{setup,registration}' is not null$s$ in pg_get_functiondef('public.competition_registration_program_open(uuid,uuid)'::regprocedure)) > 0
  and pg_get_functiondef('public.create_competition_draft(uuid,jsonb)'::regprocedure)
        !~ '(registration_required|account_required_for_registration|registration_opens_at|registration_closes_at)\s*=');
select pg_temp.chk('Multi-Dance stays held without any event registration prerequisite',
  (select registration_status = 'closed' from public.event_competition_programs where event_id = pg_temp.u('00f008'))
  and (select not registration_required from public.events where id = pg_temp.u('00f008')));

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

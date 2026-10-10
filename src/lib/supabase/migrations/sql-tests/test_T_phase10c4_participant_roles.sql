-- Phase 10C.4 -- competition participant role integrity regression suite.
--
-- Covers 20261110090000_phase10c4_participant_role_integrity.sql on top of 10A/10B/10C. Quote-level
-- combinations for every entry format are pinned by the generated parity suite
-- (test_T_phase10c_pricing_parity.sql, 10C.4 "roles:" scenarios) and end-to-end persistence by
-- test_T_phase10c_competitor_registration.sql. This suite pins the schema, the shape rules and the
-- authority boundaries. One transaction; the final block ALWAYS raises, so nothing persists:
--   "PHASE 10C.4 SQL SUITE PASS (<n> checks)"  or  "PHASE 10C.4 SQL SUITE FAIL: <failures>".

begin;

create temp table t_results (name text, ok boolean, detail text) on commit drop;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$
begin
  insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null'));
end $$;

create or replace function pg_temp.shape(p_format text, p_type text, p_roles text[], p_dance text[]) returns text[]
language sql as $$ select public._comp10c4_participant_shape_errors(p_format, p_type, p_roles, p_dance) $$;

-- ----------------------------------------------------------------------------
-- Schema
-- ----------------------------------------------------------------------------
select pg_temp.chk('schema: dance_role on entry participants',
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_competition_entry_participants' and column_name = 'dance_role' and is_nullable = 'YES'));
select pg_temp.chk('schema: dance_role on cart entry people',
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_competition_registration_cart_entry_people' and column_name = 'dance_role' and is_nullable = 'YES'));
select pg_temp.chk('schema: dance_role only leader/follower/null (participants)',
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'event_competition_entry_participants_dance_role_check')
  = $c$CHECK (((dance_role IS NULL) OR (dance_role = ANY (ARRAY['leader'::text, 'follower'::text]))))$c$);
select pg_temp.chk('schema: dance_role only leader/follower/null (cart)',
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'event_competition_registration_cart_entry_people_dance_role_check')
  = $c$CHECK (((dance_role IS NULL) OR (dance_role = ANY (ARRAY['leader'::text, 'follower'::text]))))$c$);
select pg_temp.chk('schema: participant_role is relationship only (participants)',
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'event_competition_entry_participants_role_check')
  = $c$CHECK ((participant_role = ANY (ARRAY['dancer'::text, 'student'::text, 'professional'::text, 'instructor'::text, 'team_member'::text, 'alternate'::text, 'other'::text])))$c$);
select pg_temp.chk('schema: participant_role is relationship only (cart)',
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'event_competition_registration_cart_entry_people_role_check')
  = $c$CHECK ((participant_role = ANY (ARRAY['dancer'::text, 'student'::text, 'professional'::text, 'instructor'::text, 'team_member'::text, 'alternate'::text, 'other'::text])))$c$);
select pg_temp.chk('schema: no legacy leader/follower relationship rows remain',
  not exists (select 1 from public.event_competition_entry_participants where participant_role in ('leader', 'follower'))
  and not exists (select 1 from public.event_competition_registration_cart_entry_people where participant_role in ('leader', 'follower')));
select pg_temp.chk('schema: no second person/partnership model was added',
  not exists (select 1 from information_schema.tables where table_schema = 'public'
              and table_name ~ '(partnership|competition_pair|competition_couple)'));

-- ----------------------------------------------------------------------------
-- Authority: the helper is not callable by API roles; the quote still is not either
-- ----------------------------------------------------------------------------
select pg_temp.chk('authority: shape helper not executable by anon/authenticated',
  not has_function_privilege('anon', 'public._comp10c4_participant_shape_errors(text,text,text[],text[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public._comp10c4_participant_shape_errors(text,text,text[],text[])', 'EXECUTE'));
select pg_temp.chk('authority: _comp10c_quote / _comp10c_allowed_roles still not executable by anon/authenticated',
  not has_function_privilege('anon', 'public._comp10c_quote(uuid,jsonb,timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public._comp10c_quote(uuid,jsonb,timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public._comp10c_allowed_roles(text)', 'EXECUTE'));
select pg_temp.chk('authority: start_competition_registration remains service-role only',
  not has_function_privilege('anon', 'public.start_competition_registration(uuid,uuid,jsonb,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.start_competition_registration(uuid,uuid,jsonb,uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.start_competition_registration(uuid,uuid,jsonb,uuid)', 'EXECUTE'));
select pg_temp.chk('authority: start writes dance_role to cart and canonical participant rows',
  position('participant_role, dance_role, sort_order' in pg_get_functiondef('public.start_competition_registration(uuid,uuid,jsonb,uuid)'::regprocedure)) > 0
  and position('participant_role, dance_role, display_name' in pg_get_functiondef('public.start_competition_registration(uuid,uuid,jsonb,uuid)'::regprocedure)) > 0);
select pg_temp.chk('authority: quote validates combinations through the shape rules',
  position('_comp10c4_participant_shape_errors' in pg_get_functiondef('public._comp10c_quote(uuid,jsonb,timestamptz)'::regprocedure)) > 0);

-- ----------------------------------------------------------------------------
-- Relationship roles per format
-- ----------------------------------------------------------------------------
select pg_temp.chk('roles: pro_am', public._comp10c_allowed_roles('pro_am') = array['student', 'professional']);
select pg_temp.chk('roles: pro_pro', public._comp10c_allowed_roles('pro_pro') = array['instructor', 'professional']);
select pg_temp.chk('roles: couple / mixed / J&J dancer',
  public._comp10c_allowed_roles('couple') = array['dancer'] and public._comp10c_allowed_roles('mixed_amateur') = array['dancer']
  and public._comp10c_allowed_roles('random_partner') = array['dancer']);
select pg_temp.chk('roles: professional couple', public._comp10c_allowed_roles('professional') = array['professional']);
select pg_temp.chk('roles: team', public._comp10c_allowed_roles('team') = array['team_member']);
select pg_temp.chk('roles: no format accepts leader/follower as relationship',
  not exists (select 1 from unnest(array['solo','couple','pro_am','pro_pro','mixed_amateur','professional','team','random_partner','custom']) f
              where 'leader' = any(public._comp10c_allowed_roles(f)) or 'follower' = any(public._comp10c_allowed_roles(f))));

-- ----------------------------------------------------------------------------
-- Shape rules
-- ----------------------------------------------------------------------------
select pg_temp.chk('proam valid: student leads', pg_temp.shape('pro_am', 'single_dance', array['student','professional'], array['leader','follower']) = '{}');
select pg_temp.chk('proam valid: professional leads', pg_temp.shape('pro_am', 'single_dance', array['student','professional'], array['follower','leader']) = '{}');
select pg_temp.chk('proam invalid: two students', 'a ProAm entry needs one student and one professional.' = any(pg_temp.shape('pro_am', 'single_dance', array['student','student'], array['leader','follower'])));
select pg_temp.chk('proam invalid: two professionals', 'a ProAm entry needs one student and one professional.' = any(pg_temp.shape('pro_am', 'single_dance', array['professional','professional'], array['leader','follower'])));
select pg_temp.chk('proam invalid: same dance role', 'choose one leader and one follower.' = any(pg_temp.shape('pro_am', 'single_dance', array['student','professional'], array['leader','leader'])));
select pg_temp.chk('proam invalid: missing dance role', 'choose one leader and one follower.' = any(pg_temp.shape('pro_am', 'single_dance', array['student','professional'], array['',''])));
select pg_temp.chk('proam invalid: extra participant', 'this entry needs exactly two people.' = any(pg_temp.shape('pro_am', 'single_dance', array['student','professional','student'], array['leader','follower',''])));

select pg_temp.chk('propro valid: instructor leads', pg_temp.shape('pro_pro', 'multi_dance', array['instructor','professional'], array['leader','follower']) = '{}');
select pg_temp.chk('propro valid: competing pro leads', pg_temp.shape('pro_pro', 'multi_dance', array['instructor','professional'], array['follower','leader']) = '{}');
select pg_temp.chk('propro invalid: two professionals, no instructor', 'a ProPro entry needs one instructing professional and one competing professional.' = any(pg_temp.shape('pro_pro', 'multi_dance', array['professional','professional'], array['leader','follower'])));
select pg_temp.chk('propro invalid: two instructors', 'a ProPro entry needs one instructing professional and one competing professional.' = any(pg_temp.shape('pro_pro', 'multi_dance', array['instructor','instructor'], array['leader','follower'])));
select pg_temp.chk('propro invalid: same dance role', 'choose one leader and one follower.' = any(pg_temp.shape('pro_pro', 'multi_dance', array['instructor','professional'], array['follower','follower'])));
select pg_temp.chk('propro invalid: missing dance role', 'choose one leader and one follower.' = any(pg_temp.shape('pro_pro', 'multi_dance', array['instructor','professional'], array['leader',''])));
select pg_temp.chk('propro invalid: extra participant', 'this entry needs exactly two people.' = any(pg_temp.shape('pro_pro', 'multi_dance', array['instructor','professional','professional'], array['leader','follower',''])));

select pg_temp.chk('couple valid', pg_temp.shape('couple', 'single_dance', array['dancer','dancer'], array['leader','follower']) = '{}');
select pg_temp.chk('couple invalid: two leaders', pg_temp.shape('couple', 'single_dance', array['dancer','dancer'], array['leader','leader']) = array['choose one leader and one follower.']);
select pg_temp.chk('couple invalid: two followers', pg_temp.shape('couple', 'single_dance', array['dancer','dancer'], array['follower','follower']) = array['choose one leader and one follower.']);
select pg_temp.chk('couple invalid: one participant', 'this entry needs exactly two people.' = any(pg_temp.shape('couple', 'single_dance', array['dancer'], array['leader'])));
select pg_temp.chk('couple invalid: three participants', 'this entry needs exactly two people.' = any(pg_temp.shape('couple', 'single_dance', array['dancer','dancer','dancer'], array['leader','follower',''])));
select pg_temp.chk('mixed amateur / professional need one leader + one follower',
  pg_temp.shape('mixed_amateur', 'single_dance', array['dancer','dancer'], array['follower','leader']) = '{}'
  and pg_temp.shape('professional', 'single_dance', array['professional','professional'], array['leader','follower']) = '{}'
  and pg_temp.shape('professional', 'single_dance', array['professional','professional'], array['leader','leader']) = array['choose one leader and one follower.']);

select pg_temp.chk('jj valid: leader', pg_temp.shape('random_partner', 'jack_and_jill', array['dancer'], array['leader']) = '{}');
select pg_temp.chk('jj valid: follower', pg_temp.shape('random_partner', 'jack_and_jill', array['dancer'], array['follower']) = '{}');
select pg_temp.chk('jj invalid: two participants', pg_temp.shape('random_partner', 'jack_and_jill', array['dancer','dancer'], array['leader','follower']) = array['enter exactly one person; partners are paired during the competition.']);
select pg_temp.chk('jj invalid: missing dance role', pg_temp.shape('random_partner', 'jack_and_jill', array['dancer'], array['']) = array['select Leader or Follower for this entry.']);

select pg_temp.chk('solo valid without lead/follow', pg_temp.shape('solo', 'single_dance', array['dancer'], array['']) = '{}');
select pg_temp.chk('solo lead/follow optional', pg_temp.shape('solo', 'single_dance', array['dancer'], array['follower']) = '{}');
select pg_temp.chk('custom keeps its flexibility', pg_temp.shape('custom', 'showdance', array['dancer','dancer'], array['','']) = '{}'
  and pg_temp.shape('custom', 'showdance', array['dancer','dancer'], array['leader','leader']) = '{}');
select pg_temp.chk('team valid', pg_temp.shape('team', 'team', array['team_member','team_member','team_member'], array['','','']) = '{}');
select pg_temp.chk('team takes no lead/follow', pg_temp.shape('team', 'team', array['team_member','team_member'], array['leader','']) = array['team entries do not use lead or follow.']);
select pg_temp.chk('line: lead/follow optional for a ProAm Line pair', pg_temp.shape('pro_am', 'line_dance', array['student','professional'], array['','']) = '{}');
select pg_temp.chk('line: if given it must be a full pair', pg_temp.shape('pro_am', 'line_dance', array['student','professional'], array['leader','']) = array['choose one leader and one follower.']);
select pg_temp.chk('invalid lead/follow value refused', 'choose Lead or Follow for each participant.' = any(pg_temp.shape('couple', 'single_dance', array['dancer','dancer'], array['lead','follower'])));
-- Each relationship count is checked on its own, not only through the two-person rule.
select pg_temp.chk('proam: three people with two students reports both problems',
  pg_temp.shape('pro_am', 'single_dance', array['student','professional','student'], array['leader','follower',''])
  = array['this entry needs exactly two people.', 'a ProAm entry needs one student and one professional.']);
select pg_temp.chk('propro: a professional without an instructing partner is refused by the shape rules alone',
  pg_temp.shape('pro_pro', 'multi_dance', array['professional','dancer'], array['leader','follower'])
  = array['a ProPro entry needs one instructing professional and one competing professional.']);
select pg_temp.chk('proam: a student without a professional is refused by the shape rules alone',
  pg_temp.shape('pro_am', 'single_dance', array['student','dancer'], array['leader','follower'])
  = array['a ProAm entry needs one student and one professional.']);
select pg_temp.chk('shape is order independent',
  pg_temp.shape('pro_am', 'single_dance', array['professional','student'], array['follower','leader']) = '{}');

-- ----------------------------------------------------------------------------
-- Verdict
-- ----------------------------------------------------------------------------
do $$
declare
  v_total int;
  v_failures text;
begin
  select count(*) into v_total from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;
  if v_failures is null then
    raise exception 'PHASE 10C.4 SQL SUITE PASS (% checks)', v_total;
  end if;
  raise exception 'PHASE 10C.4 SQL SUITE FAIL: %', v_failures;
end $$;

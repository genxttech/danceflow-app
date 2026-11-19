select jsonb_build_object(
  'fn_exists', exists (select 1 from pg_proc where proname='_compe2_is_absent' and pronamespace='public'::regnamespace),
  'fn_md5', (select md5(replace(prosrc, E'\r','')) from pg_proc where proname='_compe2_is_absent' and pronamespace='public'::regnamespace),
  'fn_owner', (select pg_get_userbyid(proowner) from pg_proc where proname='_compe2_is_absent' and pronamespace='public'::regnamespace),
  'fn_secdef', (select prosecdef from pg_proc where proname='_compe2_is_absent' and pronamespace='public'::regnamespace),
  'client_exec', (select jsonb_object_agg(r, has_function_privilege(r, 'public._compe2_is_absent(uuid,uuid)', 'EXECUTE')) from unnest(array['anon','authenticated','service_role']) r),
  'jc1_marker_present', (select prosrc ilike '%status = ''inactive''%' from pg_proc where proname='_compe2_is_absent' and pronamespace='public'::regnamespace),
  'officials_total', (select count(*) from public.event_competition_officials),
  'officials_inactive', (select count(*) from public.event_competition_officials where status='inactive'),
  'ballots_total', (select count(*) from public.event_competition_ballots),
  'rounds_active', (select count(*) from public.event_competition_rounds where status='active')
);

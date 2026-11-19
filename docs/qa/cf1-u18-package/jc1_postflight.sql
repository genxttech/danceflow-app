select jsonb_build_object(
  'ok', (select md5(replace(prosrc, E'\r','')) from pg_proc where proname='_compe2_is_absent' and pronamespace='public'::regnamespace) = '22be37b7aa70fb934d49fba71ecc4f31'
    and (select pg_get_userbyid(proowner) from pg_proc where proname='_compe2_is_absent' and pronamespace='public'::regnamespace) = 'postgres'
    and (select prosecdef from pg_proc where proname='_compe2_is_absent' and pronamespace='public'::regnamespace)
    and not has_function_privilege('anon','public._compe2_is_absent(uuid,uuid)','EXECUTE')
    and not has_function_privilege('authenticated','public._compe2_is_absent(uuid,uuid)','EXECUTE'),
  'fn_md5', (select md5(replace(prosrc, E'\r','')) from pg_proc where proname='_compe2_is_absent' and pronamespace='public'::regnamespace)
);

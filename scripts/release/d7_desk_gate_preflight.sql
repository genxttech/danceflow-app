-- D7 desk gate: READ-ONLY drift check for public.record_competition_checkin_payment (SELECT on catalogs only).
-- Run against hosted DEV or PROD BEFORE applying 20270205100000_competition_desk_suite_gate.sql:
--   DEV:  cd C:/Dev/studioapp && supabase db query --linked -f scripts/release/d7_desk_gate_preflight.sql -o json
--   PROD: cd <prod workdir> && supabase db query --linked --workdir . -f <this file> -o json
-- It writes nothing and calls nothing.
--
-- The migration replaces the function wholesale, so it must only be applied where the live definition IS the repo's
-- 20261116094000 definition. Compare the returned `def_md5` and `src_md5` with the line below. Any difference = DRIFT:
-- do not apply; diff the live definition against 20261116094000 first.
-- (src_md5 hashes the function body text only and is independent of the Postgres version; def_md5 hashes pg_get_functiondef
--  and can legitimately differ across Postgres major versions. A src_md5 match with a def_md5 mismatch is a formatting
--  difference, not drift.)
--
-- EXPECTED_REPO_FINGERPRINT (def_md5 src_md5): 8fd8184a82861cbc43cb3d33ea88e54b 387aacac2effd055340e27211b8f7e4f
-- (derived by d7_desk_gate_sql.sh: the 20261116094000 definition applied on a disposable postgres:17.)
-- Expected ACL on a hosted Supabase project: authenticated=X (+ postgres owner, and service_role=X from default privileges);
-- anon and PUBLIC must NOT hold EXECUTE. Expected owner: postgres. Expected security definer: true.
-- After the new migration is applied the same query must show def_md5 70285eaf8c11f4cb34cb487fa1d3f47a / src_md5 de5f23f0a9363e0c24a2ad8a8d178aba
-- on postgres:17 (see the runner), helper_present true.
select
  p.oid::regprocedure::text as fn,
  md5(pg_get_functiondef(p.oid)) as def_md5,
  md5(p.prosrc) as src_md5,
  pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,
  p.proconfig as config,
  p.proacl::text as acl,
  has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
  exists (select 1 from aclexplode(p.proacl) x where x.grantee = 0) as public_can_execute,
  to_regprocedure('public._d7_competition_desk_suite_allows(uuid,timestamptz)') is not null as helper_present,
  to_regprocedure('public.usage_addon_entitlement_is_current(text,date,date,text,timestamptz)') is not null as is_current_present,
  current_setting('server_version') as server_version
from pg_proc p
where p.oid = 'public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)'::regprocedure;

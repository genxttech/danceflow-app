-- D4-1 / D4-2 / #391 HOSTED PREFLIGHT for SMS price authorization. READ-ONLY: it changes nothing (a DO block that only reads catalogs and the protected tables, then raises an
-- error if any check fails). It is committed and tested against local disposable databases ONLY; it has NOT been run on any hosted database.
--
-- Run it (psql, as the migration owner) BEFORE applying 20270210090000 / 20270210100000 / 20270210110000 for the checks marked [pre], and again AFTER applying and bootstrapping,
-- before price authorization is activated, for the checks marked [post]. Each line prints PASS, FAIL or INFO; any FAIL stops the script with an error (use ON_ERROR_STOP).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/hosted/tw4f/preflight_price_authorization.sql
--
-- [pre]  the function owner (the owner of the session-actor function, or the role that will own it) can read auth.sessions; public.tw4_local_qa_only does not exist (that marker table relaxes
--        the uuid-session requirement for local QA claims only); anon, authenticated, service_role and PUBLIC have no CREATE on schema public.
-- [post] the session-actor function: owner is not an API role, SECURITY DEFINER, search_path pinned, not executable by API roles; the configuration (monitoring_expected = true, a configured
--        relying party and origins, backup-eligible credentials refused, fresh-MFA age within bounds); exactly one active recovery credential and at least one active primary; every active
--        credential carries an enrolment proof; the monitoring events table exists; the migrations are applied in order (090000 before 100000 before 110000).
do $$
declare
  v_fail text[] := '{}';
  v_owner oid;
  v_ownername text;
  v_cfg record;
  v_n int;
  v_role text;
  v_has_cfg boolean := to_regclass('public.studio_sms_price_auth_config') is not null;
  v_has_actor boolean := to_regprocedure('public._tw4price_session_actor(text)') is not null;
  v_has_hist boolean := to_regclass('supabase_migrations.schema_migrations') is not null;
  v_versions text[] := '{}';
begin
  -- [pre] auth.sessions readable by the function owner
  if to_regclass('auth.sessions') is null then
    v_fail := array_append(v_fail, ('auth.sessions does not exist')::text);
    raise notice 'FAIL [pre] auth.sessions exists: no';
  else
    raise notice 'PASS [pre] auth.sessions exists';
    select p.proowner into v_owner from pg_proc p where p.oid = to_regprocedure('public._tw4price_session_actor(text)');
    if v_owner is null then
      v_owner := (select oid from pg_roles where rolname = current_user);
      raise notice 'INFO [pre] the session-actor function is not installed yet: checking the current role (%) as the future owner', current_user;
    end if;
    select rolname into v_ownername from pg_roles where oid = v_owner;
    if has_table_privilege(v_owner, 'auth.sessions', 'select') then
      raise notice 'PASS [pre] the function owner (%) can read auth.sessions', v_ownername;
    else
      v_fail := array_append(v_fail, ('the function owner cannot read auth.sessions')::text);
      raise notice 'FAIL [pre] the function owner (%) cannot read auth.sessions', v_ownername;
    end if;
    if v_ownername in ('anon', 'authenticated', 'service_role', 'authenticator') then
      v_fail := array_append(v_fail, ('the function owner is an API role')::text);
      raise notice 'FAIL [pre] the function owner is an API role (%)', v_ownername;
    end if;
  end if;

  -- [pre] the local-QA marker must not exist on a hosted database
  if to_regclass('public.tw4_local_qa_only') is not null then
    v_fail := array_append(v_fail, ('public.tw4_local_qa_only exists')::text);
    raise notice 'FAIL [pre] public.tw4_local_qa_only exists (it relaxes the uuid session rule: drop it)';
  else
    raise notice 'PASS [pre] public.tw4_local_qa_only is absent';
  end if;

  -- [pre] no CREATE on schema public for API roles or PUBLIC
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      if has_schema_privilege(v_role, 'public', 'CREATE') then
        v_fail := array_append(v_fail, ((v_role || ' can CREATE in schema public'))::text);
        raise notice 'FAIL [pre] % has CREATE on schema public', v_role;
      else
        raise notice 'PASS [pre] % has no CREATE on schema public', v_role;
      end if;
    end if;
  end loop;
  if exists (select 1 from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'CREATE') then
    v_fail := array_append(v_fail, ('PUBLIC can CREATE in schema public')::text);
    raise notice 'FAIL [pre] PUBLIC has CREATE on schema public';
  else
    raise notice 'PASS [pre] PUBLIC has no CREATE on schema public';
  end if;

  -- [post] the session-actor function
  if not v_has_actor then
    raise notice 'INFO [post] the session-actor function is not installed yet: [post] checks are skipped';
  else
    select p.proowner::regrole::text, p.prosecdef, p.proconfig into v_cfg from pg_proc p where p.oid = to_regprocedure('public._tw4price_session_actor(text)');
    if not v_cfg.prosecdef then
      v_fail := array_append(v_fail, ('the session-actor function is not SECURITY DEFINER')::text);
      raise notice 'FAIL [post] the session-actor function is not SECURITY DEFINER';
    else
      raise notice 'PASS [post] the session-actor function is SECURITY DEFINER, owner %', v_cfg.proowner;
    end if;
    if v_cfg.proconfig is null or not exists (select 1 from unnest(v_cfg.proconfig) c where c like 'search_path=%pg_temp') then
      v_fail := array_append(v_fail, ('the session-actor search_path is not pinned')::text);
      raise notice 'FAIL [post] the session-actor search_path is not pinned (pg_catalog, public, pg_temp)';
    else
      raise notice 'PASS [post] the session-actor search_path is pinned';
    end if;
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = v_role) and has_function_privilege(v_role, 'public._tw4price_session_actor(text)', 'execute') then
        v_fail := array_append(v_fail, ((v_role || ' can execute the session-actor function'))::text);
        raise notice 'FAIL [post] % can execute _tw4price_session_actor', v_role;
      end if;
    end loop;
    if has_function_privilege('public', 'public._tw4price_session_actor(text)', 'execute') then
      v_fail := array_append(v_fail, ('PUBLIC can execute the session-actor function')::text);
      raise notice 'FAIL [post] PUBLIC can execute _tw4price_session_actor';
    else
      raise notice 'PASS [post] no API role or PUBLIC can execute _tw4price_session_actor';
    end if;
  end if;

  -- [post] configuration, credentials, monitoring
  if not v_has_cfg then
    raise notice 'INFO [post] the owner-authorization migration is not applied: configuration checks are skipped';
  else
    select * into v_cfg from public.studio_sms_price_auth_config;
    raise notice 'INFO [post] monitoring_expected = %', v_cfg.monitoring_expected;
    if v_cfg.monitoring_expected is not true then
      v_fail := array_append(v_fail, ('monitoring_expected is not true')::text);
      raise notice 'FAIL [post] monitoring_expected must be true in production (set it with the owner-level activation step)';
    else
      raise notice 'PASS [post] monitoring_expected is true';
    end if;
    if to_regclass('public.studio_sms_price_security_events') is null then
      v_fail := array_append(v_fail, ('the monitoring events table is missing')::text);
      raise notice 'FAIL [post] public.studio_sms_price_security_events is missing (apply 20270210110000)';
    else
      raise notice 'PASS [post] the monitoring events table exists';
    end if;
    raise notice 'INFO [post] fresh_mfa_max_age_seconds = % (bounds 60..3600, default 600)', v_cfg.fresh_mfa_max_age_seconds;
    if v_cfg.fresh_mfa_max_age_seconds not between 60 and 3600 then
      v_fail := array_append(v_fail, ('fresh_mfa_max_age_seconds out of bounds')::text);
      raise notice 'FAIL [post] fresh_mfa_max_age_seconds is out of bounds';
    end if;
    if v_cfg.rp_id is null or v_cfg.rp_origins is null or cardinality(v_cfg.rp_origins) < 1 then
      v_fail := array_append(v_fail, ('the relying party is not configured')::text);
      raise notice 'FAIL [post] the relying party id and origins are not configured (run the bootstrap)';
    else
      raise notice 'PASS [post] the relying party is configured (% / % origin(s))', v_cfg.rp_id, cardinality(v_cfg.rp_origins);
    end if;
    if v_cfg.allow_backup_eligible then
      v_fail := array_append(v_fail, ('allow_backup_eligible is true')::text);
      raise notice 'FAIL [post] allow_backup_eligible is true: synced passkeys would be accepted';
    else
      raise notice 'PASS [post] backup-eligible (synced) credentials are refused';
    end if;
    select count(*) into v_n from public.studio_sms_price_credentials where status = 'active' and role = 'recovery';
    raise notice 'INFO [post] active recovery credentials = %', v_n;
    -- Single-owner policy (owner decision 2026-11-10): a separate recovery key is OPTIONAL. Zero is accepted (recovery is the documented owner-level reset with a waiting period and a freeze, see
    -- docs/twilio/TW-4F_Price_Publication_Runbook.md); more than one is never valid.
    if v_n > 1 then
      v_fail := array_append(v_fail, ('more than one active recovery credential')::text);
      raise notice 'FAIL [post] at most one active recovery credential is allowed (found %)', v_n;
    elsif v_n = 1 then
      raise notice 'PASS [post] one active recovery credential';
    else
      raise notice 'INFO [post] no separate recovery credential (accepted for the single-owner design; recovery is the documented owner-level reset)';
    end if;
    select count(*) into v_n from public.studio_sms_price_credentials where status = 'active' and role = 'primary';
    raise notice 'INFO [post] active primary credentials = %', v_n;
    if v_n <> 1 then
      v_fail := array_append(v_fail, ('there is not exactly one active primary credential')::text);
      raise notice 'FAIL [post] exactly one active primary credential is required (found %)', v_n;
    end if;
    -- A credential whose signature counter is still 0 after use either has not signed yet or belongs to an authenticator that does not count (clone detection by counter is then unavailable; the
    -- database still refuses any regression once a counter has moved). Informational: the owner accepts this for a device-bound, non-exportable key.
    select count(*) into v_n from public.studio_sms_price_credentials where status = 'active' and sign_count = 0;
    raise notice 'INFO [post] active credentials with signature counter 0 (no clone detection by counter) = %', v_n;
    select count(*) into v_n from public.studio_sms_price_credentials where status = 'active' and proof_verified_at is null;
    if v_n > 0 then
      v_fail := array_append(v_fail, ('an active credential has no enrolment proof')::text);
      raise notice 'FAIL [post] % active credential(s) have no enrolment proof (run _tw4price_attest_begin / _tw4price_attest_finish with that key)', v_n;
    else
      raise notice 'PASS [post] every active credential carries an enrolment proof';
    end if;
  end if;

  -- [post] migration order, when the migration history is visible
  if v_has_hist then
    select coalesce(array_agg(version order by version), '{}') into v_versions from supabase_migrations.schema_migrations where version in ('20270210090000', '20270210100000', '20270210110000');
    raise notice 'INFO migration history: %', v_versions;
    if ('20270210100000' = any (v_versions) and not '20270210090000' = any (v_versions)) or ('20270210110000' = any (v_versions) and not '20270210100000' = any (v_versions)) then
      v_fail := array_append(v_fail, ('the migrations are not applied in order')::text);
      raise notice 'FAIL migration order: 20270210090000, then 20270210100000, then 20270210110000';
    end if;
  else
    raise notice 'INFO the migration history table is not visible: confirm the order 20270210090000, 20270210100000, 20270210110000 by hand';
  end if;

  if cardinality(v_fail) > 0 then
    raise exception 'price authorization preflight FAILED (% check(s)): %', cardinality(v_fail), array_to_string(v_fail, '; ');
  end if;
  raise notice 'price authorization preflight passed';
end $$;

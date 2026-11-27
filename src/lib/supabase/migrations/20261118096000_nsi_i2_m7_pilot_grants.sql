-- New Student Intake (NSI) I2 -- M7: studio-scoped pilot grants (platform-admin authority) and database-side entitlement.
--
-- Creates   table public.intake_feature_grants (RLS on, no API privilege), trigger function feature_grants_guard,
--           intake_private.feature_granted(), public.intake_grant_feature / intake_revoke_feature (platform admin only),
--           public.intake_feature_status (owner/admin of the studio).
-- Replaces  intake_private.assert_staff (capabilities 'feature_grant' [platform admin], 'disable' [owner/admin, no grant];
--           'configure' now needs an active config_preview grant), intake_private.new_obligation_allowed (Gate B now needs
--           an active live_collection grant), public.intake_update_settings (OFF needs 'disable' only; ON needs live_collection;
--           default template must be active), intake_private.assert_catalog (verbatim M6 copy + M7 inventory, loop 1..7),
--           and widens intake_audit_events_event_type_check by 'feature_granted', 'feature_revoked'.
-- Not touched: Gate A (retention_gate_open), any billing plan, appointments, outbound_deliveries. No grant exists after
--   this migration: every studio stays OFF until a platform admin issues one.
-- Lapse behaviour: an expired or revoked grant blocks configuration writes and new obligations; read-only visibility
--   (configure_read), turning intake OFF, history and already issued requests are unaffected.
-- Depends on: M1-M6. Version note: replaying M1 after M7 fails closed (M1's assert_catalog does not know M6/M7).
-- Rollback: rollback/20261118096000_nsi_i2_m7_pilot_grants_rollback.sql (refused once any grant or grant audit event exists).
-- NOT APPLIED to any shared environment.

begin;

set local lock_timeout = '5s';

create or replace function intake_private.assert_catalog()
returns void language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_errors text[] := '{}';
  r record;
  v_role text;
  v_priv text;
  v_m int;
  v_present int;
  v_total int;
  v_complete int[] := '{}';
  v_expected text[];
  v_actual text[];
  v_roles constant text[] := array['anon', 'authenticated', 'service_role', 'intake_destructive'];
  v_table_privs text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  c_live constant text[] := array['intake_requests', 'intake_request_appointments', 'intake_respondents',
    'intake_responses', 'intake_response_revisions', 'intake_minor_determinations', 'intake_completions',
    'intake_client_relationship_state', 'intake_guardian_designations'];
  c_config constant text[] := array['intake_templates', 'intake_template_versions', 'intake_service_assignments',
    'intake_studio_retention_choices', 'intake_settings'];
  c_config_qual constant text := '(public.intake_has_staff_role(studio_id) OR public.intake_is_platform_admin())';
  -- relations: name | migration | direct grants (grantee:PRIVILEGE, comma separated, sorted)
  c_rel constant text[] := array[
    'intake_templates|1|authenticated:SELECT',
    'intake_template_versions|1|authenticated:SELECT',
    'intake_service_assignments|1|authenticated:SELECT',
    'intake_studio_retention_choices|1|authenticated:SELECT',
    'intake_settings|1|authenticated:SELECT',
    'intake_legal_holds|2|',
    'intake_audit_events|2|',
    'intake_requests|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_request_appointments|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_respondents|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_responses|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_response_revisions|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_minor_determinations|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_completions|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_client_relationship_state|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_guardian_designations|3|intake_destructive:DELETE,intake_destructive:SELECT',
    'intake_consent_evidence|4|',
    'intake_consent_evidence_identity|4|',
    'intake_feature_grants|7|'];
  -- functions: schema.name | migration | EXECUTE grantees other than the owner (sorted) | security definer (t/f)
  c_fn constant text[] := array[
    'public.intake_platform_policy|1|authenticated,service_role|f',
    'public.intake_is_platform_admin|1|authenticated|t',
    'public.intake_has_staff_role|1|authenticated|t',
    'intake_private.touch_updated_at|1||f',
    'intake_private.refuse_truncate|1||f',
    'intake_private.config_append_only|1||f',
    'intake_private.studio_role|1||t',
    'intake_private.assert_staff|1||t',
    'intake_private.retention_gate_open|1||f',
    'intake_private.new_obligation_allowed|1||t',
    'intake_private.assert_client_in_studio|1||t',
    'intake_private.assert_link_for_client|1||t',
    'intake_private.link_is_verified_guardian|1||t',
    'intake_private.link_is_verified_self|1||t',
    'intake_private.assert_document_version|1||t',
    'intake_private.assert_envelope|1||t',
    'intake_private.template_version_guard|1||f',
    'intake_private.template_floor_guard|1||f',
    'intake_private.assert_catalog|1||f',
    'intake_private.is_held|2|intake_destructive|t',
    'intake_private.client_has_active_hold|2|intake_destructive|t',
    'intake_private.audit_write|2|intake_destructive|t',
    'intake_private.erasure_barrier_active|2|intake_destructive|t',
    'intake_private.legal_hold_guard|2||f',
    'intake_private.audit_guard|2||f',
    'intake_private.subject_of|3|intake_destructive|t',
    'intake_private.collection_gate|3||f',
    'intake_private.delete_guard|3||f',
    'intake_private.tenant_guard|3||f',
    'intake_private.requests_guard|3||f',
    'intake_private.request_appointments_guard|3||f',
    'intake_private.respondents_guard|3||f',
    'intake_private.responses_guard|3||f',
    'intake_private.append_only_guard|3||f',
    'intake_private.relationship_state_guard|3||f',
    'intake_private.designations_guard|3||f',
    'intake_private.assurance_rank|3||f',
    'intake_private.fulfillment_state|3|intake_destructive|t',
    'intake_private.evidence_insert_guard|4||f',
    'intake_private.evidence_identity_insert_guard|4||f',
    'intake_private.evidence_guard|4||f',
    'intake_private.lock_client|5||f',
    'intake_private.schema_max_answer_bytes|5||f',
    'intake_private.validate_answers|5||f',
    'intake_private.appointment_snapshot|5||t',
    'intake_private.compute_draft_retention|5||t',
    'intake_private.has_intake_records|5||t',
    'intake_private.drift_detected|5||t',
    'intake_private.assert_drift_free|5||t',
    'public.intake_save_template_draft|5|authenticated|t',
    'public.intake_publish_template_version|5|authenticated|t',
    'public.intake_set_reintake_floor|5|authenticated|t',
    'public.intake_set_service_assignment|5|authenticated|t',
    'public.intake_update_settings|5|authenticated|t',
    'public.intake_set_retention_choice|5|authenticated|t',
    'public.intake_get_status|5|authenticated|t',
    'public.intake_get_answers|5|authenticated|t',
    'public.intake_designate_guardian|5|authenticated|t',
    'public.intake_select_guardian_recipient|5|authenticated|t',
    'public.intake_record_minor_determination|5|authenticated|t',
    'public.intake_drift_report|5|authenticated|t',
    'public.intake_extend_draft_retention|5|authenticated|t',
    'public.intake_ensure_request|5|service_role|t',
    'public.intake_save_draft|5|service_role|t',
    'public.intake_submit_response|5|service_role|t',
    'intake_private.erase_client_impl|5|postgres|t',
    'public.intake_erase_client|5|authenticated|t',
    'public.intake_release_erasure_barrier|5|authenticated|t',
    'public.intake_create_legal_hold|5|authenticated|t',
    'public.intake_release_legal_hold|5|authenticated|t',
    'intake_private.evaluate_appointment_eligibility|6||t',
    'public.intake_reconcile_preview|6|service_role|t',
    'public.intake_reconcile_status|6|service_role|t',
    'intake_private.feature_granted|7||t',
    'intake_private.feature_grants_guard|7||f',
    'public.intake_grant_feature|7|authenticated|t',
    'public.intake_revoke_feature|7|authenticated|t',
    'public.intake_feature_status|7|authenticated|t'];
  -- triggers: table | trigger | function | migration | timing and events | level | arguments  (full definition is
  -- compared; the four generic M3 triggers per live table are added below)
  c_trg text[] := array[
    'intake_template_versions|intake_template_versions_guard|template_version_guard|1|BEFORE INSERT OR DELETE OR UPDATE|ROW|',
    'intake_template_versions|intake_template_versions_no_truncate|refuse_truncate|1|BEFORE TRUNCATE|STATEMENT|',
    'intake_templates|intake_templates_floor_guard|template_floor_guard|1|BEFORE UPDATE|ROW|',
    'intake_templates|intake_templates_touch|touch_updated_at|1|BEFORE UPDATE|ROW|',
    'intake_service_assignments|intake_service_assignments_touch|touch_updated_at|1|BEFORE UPDATE|ROW|',
    'intake_settings|intake_settings_touch|touch_updated_at|1|BEFORE UPDATE|ROW|',
    'intake_studio_retention_choices|intake_studio_retention_choices_append_only|config_append_only|1|BEFORE DELETE OR UPDATE|ROW|',
    'intake_studio_retention_choices|intake_studio_retention_choices_no_truncate|refuse_truncate|1|BEFORE TRUNCATE|STATEMENT|',
    'intake_legal_holds|intake_legal_holds_guard|legal_hold_guard|2|BEFORE DELETE OR UPDATE|ROW|',
    'intake_legal_holds|intake_legal_holds_no_truncate|refuse_truncate|2|BEFORE TRUNCATE|STATEMENT|',
    'intake_audit_events|intake_audit_events_guard|audit_guard|2|BEFORE DELETE OR UPDATE|ROW|',
    'intake_audit_events|intake_audit_events_no_truncate|refuse_truncate|2|BEFORE TRUNCATE|STATEMENT|',
    'intake_requests|intake_requests_30_guard|requests_guard|3|BEFORE UPDATE|ROW|',
    'intake_requests|intake_requests_40_touch|touch_updated_at|3|BEFORE UPDATE|ROW|',
    'intake_request_appointments|intake_request_appointments_30_guard|request_appointments_guard|3|BEFORE UPDATE|ROW|',
    'intake_respondents|intake_respondents_30_guard|respondents_guard|3|BEFORE UPDATE|ROW|',
    'intake_responses|intake_responses_30_guard|responses_guard|3|BEFORE INSERT OR UPDATE|ROW|',
    'intake_response_revisions|intake_response_revisions_30_guard|append_only_guard|3|BEFORE UPDATE|ROW|',
    'intake_minor_determinations|intake_minor_determinations_30_guard|append_only_guard|3|BEFORE UPDATE|ROW|',
    'intake_completions|intake_completions_30_guard|append_only_guard|3|BEFORE UPDATE|ROW|',
    'intake_client_relationship_state|intake_client_relationship_state_30_guard|relationship_state_guard|3|BEFORE UPDATE|ROW|',
    'intake_client_relationship_state|intake_client_relationship_state_40_touch|touch_updated_at|3|BEFORE UPDATE|ROW|',
    'intake_guardian_designations|intake_guardian_designations_30_guard|designations_guard|3|BEFORE UPDATE|ROW|',
    'intake_consent_evidence|intake_consent_evidence_10_gate|collection_gate|4|BEFORE INSERT|ROW|''continuing''',
    'intake_consent_evidence|intake_consent_evidence_20_validate|evidence_insert_guard|4|BEFORE INSERT|ROW|',
    'intake_consent_evidence|intake_consent_evidence_30_guard|evidence_guard|4|BEFORE DELETE OR UPDATE|ROW|',
    'intake_consent_evidence|intake_consent_evidence_no_truncate|refuse_truncate|4|BEFORE TRUNCATE|STATEMENT|',
    'intake_consent_evidence_identity|intake_consent_evidence_identity_10_gate|collection_gate|4|BEFORE INSERT|ROW|''continuing''',
    'intake_consent_evidence_identity|intake_consent_evidence_identity_20_validate|evidence_identity_insert_guard|4|BEFORE INSERT|ROW|',
    'intake_consent_evidence_identity|intake_consent_evidence_identity_30_guard|evidence_guard|4|BEFORE DELETE OR UPDATE|ROW|',
    'intake_consent_evidence_identity|intake_consent_evidence_identity_no_truncate|refuse_truncate|4|BEFORE TRUNCATE|STATEMENT|',
    'intake_feature_grants|intake_feature_grants_30_guard|feature_grants_guard|7|BEFORE DELETE OR UPDATE|ROW|',
    'intake_feature_grants|intake_feature_grants_no_truncate|refuse_truncate|7|BEFORE TRUNCATE|STATEMENT|'];
  -- policies: table | policy | cmd | permissive | roles | qual | with check | migration   (built below)
  -- version tripwire: functions replaced by a later migration must still carry that migration's marker comment, so replaying an
  -- OLDER migration (which would silently restore an older body) fails closed.  name | marker | migration
  c_guard constant text[] := array[
    'intake_private.assert_staff|nsi-body:m7|7',
    'intake_private.new_obligation_allowed|nsi-body:m7|7',
    'public.intake_update_settings|nsi-body:m7|7'
  ]; -- guard-end
  c_pol text[] := '{}';
  v_t text;
begin
  -- ----- inventory expansion --------------------------------------------------------------------------------------
  foreach v_t in array c_live loop
    c_trg := c_trg || array[
      v_t || '|' || v_t || '_10_gate|collection_gate|3|BEFORE INSERT|ROW|'
          || case when v_t in ('intake_requests', 'intake_request_appointments') then '''new_obligation''' else '''continuing''' end,
      v_t || '|' || v_t || '_20_tenant|tenant_guard|3|BEFORE INSERT|ROW|',
      v_t || '|' || v_t || '_90_delete|delete_guard|3|BEFORE DELETE|ROW|',
      v_t || '|' || v_t || '_no_truncate|refuse_truncate|3|BEFORE TRUNCATE|STATEMENT|'];
    c_pol := c_pol || array[v_t || '|' || v_t || '_destructive_select|r|t|intake_destructive|true||3',
                            v_t || '|' || v_t || '_destructive_delete|d|t|intake_destructive|true||3'];
  end loop;
  foreach v_t in array c_config loop
    c_pol := c_pol || (v_t || '|' || v_t || '_staff_read|r|t|authenticated|' || c_config_qual || '||1');
  end loop;
  if current_setting('server_version_num')::int >= 170000 then
    v_table_privs := v_table_privs || 'MAINTAIN'::text;
  end if;

  -- ----- which migrations are present (each must be complete; present migrations must be M1..Mk) -------------------
  for v_m in 1 .. 7 loop
    select count(*) filter (where to_regclass('public.' || split_part(x, '|', 1)) is not null), count(*)
    into v_present, v_total from unnest(c_rel) x where split_part(x, '|', 2)::int = v_m;
    select v_present + count(*) filter (where exists (
             select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = split_part(split_part(x, '|', 1), '.', 1) and p.proname = split_part(split_part(x, '|', 1), '.', 2))),
           v_total + count(*)
    into v_present, v_total from unnest(c_fn) x where split_part(x, '|', 2)::int = v_m;
    if v_present = v_total then
      v_complete := v_complete || v_m;
    elsif v_present > 0 then
      v_errors := v_errors || format('M%s is partially deployed (%s of %s objects)', v_m, v_present, v_total);
    end if;
  end loop;
  if not (1 = any (v_complete)) then
    v_errors := v_errors || 'M1 is not completely deployed'::text;
  end if;
  if v_complete <> (select coalesce(array_agg(g order by g), '{}') from generate_series(1, coalesce(cardinality(v_complete), 0)) g) then
    v_errors := v_errors || format('present migrations are not a prefix M1..Mk: %s', v_complete);
  end if;

  -- ----- restricted role, memberships, schema, default ACLs, session ---------------------------------------------
  if not exists (select 1 from pg_roles where rolname = 'intake_destructive' and not rolcanlogin and not rolinherit
                   and not rolbypassrls and not rolsuper and not rolcreaterole and not rolcreatedb and not rolreplication) then
    v_errors := v_errors || 'role intake_destructive missing or has elevated attributes'::text;
  else
    -- postgres needs SET (never INHERIT); hosted creation may add an implicit admin-only row for the creator.
    if not exists (select 1 from pg_auth_members am where am.roleid = 'intake_destructive'::regrole
                     and am.member = 'postgres'::regrole and am.set_option and not am.inherit_option) then
      v_errors := v_errors || 'postgres lacks SET membership in intake_destructive'::text;
    end if;
    if exists (select 1 from pg_auth_members am where am.roleid = 'intake_destructive'::regrole
                 and (am.member <> 'postgres'::regrole or am.inherit_option)) then
      v_errors := v_errors || 'intake_destructive has an unexpected or INHERIT membership'::text;
    end if;
    if exists (select 1 from pg_auth_members am where am.member = 'intake_destructive'::regrole) then
      v_errors := v_errors || 'intake_destructive is a member of another role'::text;
    end if;
    if has_schema_privilege('intake_destructive', 'public', 'CREATE') then
      v_errors := v_errors || 'intake_destructive can CREATE in schema public'::text;
    end if;
    if exists (select 1 from pg_default_acl d where d.defaclrole = 'intake_destructive'::regrole) then
      v_errors := v_errors || 'default privileges are defined by intake_destructive'::text;
    end if;
  end if;
  select array(select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type
               from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
               where n.nspname = 'intake_private' and a.grantee <> n.nspowner order by 1)
  into v_actual;
  if v_actual is distinct from array['intake_destructive:USAGE'] then
    v_errors := v_errors || format('intake_private privileges are %s (expected intake_destructive:USAGE)', v_actual);
  end if;
  if (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'intake_private') is distinct from 'postgres' then
    v_errors := v_errors || 'intake_private is not owned by postgres'::text;
  end if;
  if exists (select 1 from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname = 'intake_private') then
    v_errors := v_errors || 'default privileges exist for schema intake_private'::text;
  end if;
  if current_setting('session_replication_role') <> 'origin' then
    v_errors := v_errors || 'session_replication_role is not origin (guard triggers would not fire)'::text;
  end if;

  -- ----- relations ------------------------------------------------------------------------------------------------
  for r in select c.oid, c.relname, n.nspname, c.relkind, c.relacl, c.relrowsecurity, pg_get_userbyid(c.relowner) as owner, c.relowner,
                  (select x from unnest(c_rel) x where split_part(x, '|', 1) = c.relname and n.nspname = 'public') as inv
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where ((n.nspname = 'public' and c.relname like 'intake\_%') or n.nspname = 'intake_private')
             and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c') loop
    if r.inv is null or r.relkind <> 'r' then
      v_errors := v_errors || format('unexpected relation %s.%s (kind %s)', r.nspname, r.relname, r.relkind);
      continue;
    end if;
    if r.owner <> 'postgres' then v_errors := v_errors || format('relation %s owned by %s', r.relname, r.owner); end if;
    if not r.relrowsecurity then v_errors := v_errors || format('relation %s has RLS disabled', r.relname); end if;
    if r.relacl is null then
      v_errors := v_errors || format('relation %s has a default (NULL) ACL', r.relname);
    end if;
    select array(select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type
                 from aclexplode(coalesce(r.relacl, acldefault('r', r.relowner))) a where a.grantee <> r.relowner order by 1)
    into v_actual;
    v_expected := coalesce(array(select x from unnest(string_to_array(nullif(split_part(r.inv, '|', 3), ''), ',')) x order by 1), '{}');
    if v_actual <> v_expected then
      v_errors := v_errors || format('relation %s grants %s (expected %s)', r.relname, v_actual, v_expected);
    end if;
    if exists (select 1 from pg_attribute a where a.attrelid = r.oid and a.attnum > 0 and a.attacl is not null) then
      v_errors := v_errors || format('relation %s has column-level grants', r.relname);
    end if;
    foreach v_role in array v_roles loop
      foreach v_priv in array v_table_privs loop
        if has_table_privilege(v_role, r.oid, v_priv) <> ((v_role || ':' || v_priv) = any (v_expected)) then
          v_errors := v_errors || format('relation %s: %s %s %s', r.relname, v_role,
            case when has_table_privilege(v_role, r.oid, v_priv) then 'unexpectedly holds' else 'lacks' end, v_priv);
        end if;
      end loop;
      if has_any_column_privilege(v_role, r.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
         and not exists (select 1 from unnest(v_expected) e where e like v_role || ':%' and split_part(e, ':', 2) in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')) then
        v_errors := v_errors || format('relation %s: %s holds a column privilege', r.relname, v_role);
      end if;
    end loop;
  end loop;

  -- ----- functions ------------------------------------------------------------------------------------------------
  for r in select n.nspname || '.' || p.proname as qname, count(*) as n
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private'
           group by 1 having count(*) > 1 loop
    v_errors := v_errors || format('function %s has %s overloads', r.qname, r.n);
  end loop;
  for r in select p.oid, n.nspname || '.' || p.proname as qname, p.proacl, p.prosecdef, p.proconfig, p.proowner,
                  pg_get_userbyid(p.proowner) as owner,
                  (select x from unnest(c_fn) x where split_part(x, '|', 1) = n.nspname || '.' || p.proname) as inv
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private' loop
    if r.inv is null then
      v_errors := v_errors || format('unexpected function %s', r.qname);
      continue;
    end if;
    if r.qname = 'intake_private.erase_client_impl' then
      if r.owner <> 'intake_destructive' then
        v_errors := v_errors || format('function %s must be owned by intake_destructive (is %s)', r.qname, r.owner);
      end if;
    elsif r.owner <> 'postgres' then
      v_errors := v_errors || format('function %s owned by %s', r.qname, r.owner);
    end if;
    if r.proacl is null then
      v_errors := v_errors || format('function %s has a default (NULL) ACL (PUBLIC execute)', r.qname);
    end if;
    if r.proconfig is null or not ('search_path=pg_catalog, pg_temp' = any (r.proconfig)) then
      v_errors := v_errors || format('function %s has no pinned search_path', r.qname);
    end if;
    if r.prosecdef <> (split_part(r.inv, '|', 4) = 't') then
      v_errors := v_errors || format('function %s SECURITY DEFINER is %s', r.qname, r.prosecdef);
    end if;
    select array(select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
                 from aclexplode(coalesce(r.proacl, acldefault('f', r.proowner))) a where a.grantee <> r.proowner order by 1)
    into v_actual;
    v_expected := coalesce(array(select x from unnest(string_to_array(nullif(split_part(r.inv, '|', 3), ''), ',')) x order by 1), '{}');
    if v_actual <> v_expected then
      v_errors := v_errors || format('function %s executable by %s (expected %s)', r.qname, v_actual, v_expected);
    end if;
    foreach v_role in array v_roles loop
      if has_function_privilege(v_role, r.oid, 'EXECUTE') <> (v_role = r.owner or v_role = any (v_expected)) then
        v_errors := v_errors || format('function %s: effective EXECUTE for %s is %s', r.qname, v_role,
          has_function_privilege(v_role, r.oid, 'EXECUTE'));
      end if;
    end loop;
  end loop;

  -- ----- triggers (exact full definitions for the present migrations: timing, events, level, WHEN condition,
  --       function schema and arguments; all enabled) ---------------------------------------------------------------
  select array(select split_part(x, '|', 1) || ' :: ' || format('CREATE TRIGGER %s %s ON public.%s FOR EACH %s EXECUTE FUNCTION intake_private.%s(%s)',
                        split_part(x, '|', 2), split_part(x, '|', 5), split_part(x, '|', 1), split_part(x, '|', 6),
                        split_part(x, '|', 3), split_part(x, '|', 7))
               from unnest(c_trg) x where split_part(x, '|', 4)::int = any (v_complete) order by 1)
  into v_expected;
  select array(select c.relname || ' :: ' || pg_get_triggerdef(t.oid)
               from pg_trigger t join pg_class c on c.oid = t.tgrelid
               where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and not t.tgisinternal order by 1)
  into v_actual;
  if v_actual <> v_expected then
    v_errors := v_errors || format('trigger drift: missing %s, unexpected %s',
      array(select unnest(v_expected) except select unnest(v_actual)), array(select unnest(v_actual) except select unnest(v_expected)));
  end if;
  for r in select c.relname, t.tgname, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' and t.tgenabled <> 'O' loop
    v_errors := v_errors || format('trigger %s.%s is not enabled in origin mode (tgenabled=%s)', r.relname, r.tgname, r.tgenabled);
  end loop;

  -- ----- RLS policies (exact set for the present migrations) ------------------------------------------------------
  select array(select split_part(x, '|', 1) || '|' || split_part(x, '|', 2) || '|' || split_part(x, '|', 3) || '|' || split_part(x, '|', 4)
                      || '|' || split_part(x, '|', 5) || '|' || split_part(x, '|', 6) || '|' || split_part(x, '|', 7)
               from unnest(c_pol) x where split_part(x, '|', 8)::int = any (v_complete) order by 1)
  into v_expected;
  select array(select c.relname || '|' || pl.polname || '|' || pl.polcmd::text || '|' || case when pl.polpermissive then 't' else 'f' end
                      || '|' || array_to_string(array(select case when o = 0 then 'PUBLIC' else pg_get_userbyid(o) end from unnest(pl.polroles) o order by 1), ',')
                      || '|' || coalesce(pg_get_expr(pl.polqual, pl.polrelid), '') || '|' || coalesce(pg_get_expr(pl.polwithcheck, pl.polrelid), '')
               from pg_policy pl join pg_class c on c.oid = pl.polrelid
               where c.relnamespace = 'public'::regnamespace and c.relname like 'intake\_%' order by 1)
  into v_actual;
  if v_actual <> v_expected then
    v_errors := v_errors || format('policy drift: missing %s, unexpected %s',
      array(select unnest(v_expected) except select unnest(v_actual)), array(select unnest(v_actual) except select unnest(v_expected)));
  end if;

  foreach v_t in array c_guard loop
    if split_part(v_t, '|', 3)::int = any (v_complete) and not exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname || '.' || p.proname = split_part(v_t, '|', 1) and position(split_part(v_t, '|', 2) in p.prosrc) > 0) then
      v_errors := v_errors || format('function %s does not carry the %s marker (an older body was restored?)', split_part(v_t, '|', 1), split_part(v_t, '|', 2));
    end if;
  end loop;

  -- ----- hot table untouched --------------------------------------------------------------------------------------
  if exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace n on n.oid = p.pronamespace
             where t.tgrelid = 'public.appointments'::regclass and (n.nspname = 'intake_private' or p.proname like 'intake\_%')) then
    v_errors := v_errors || 'an intake trigger exists on public.appointments'::text;
  end if;
  if exists (select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
             where c.contype = 'f' and c.confrelid = 'public.appointments'::regclass and t.relname like 'intake\_%') then
    v_errors := v_errors || 'an intake foreign key references public.appointments'::text;
  end if;

  if cardinality(v_errors) > 0 then
    raise exception 'nsi catalog self-check failed: %', array_to_string(v_errors, '; ') using errcode = '42501';
  end if;
end $$;


-- ---------------------------------------------------------------------------------------------------------------
-- Pilot grants. One row per issued grant; revocation sets revoked_*; nothing else ever changes and nothing is deleted
-- (except together with a deleted studio). No API role has any privilege on the table: grants are issued and revoked
-- only through the platform-admin RPCs below and read only through the definer helpers.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.intake_feature_grants (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  capability text not null check (capability in ('config_preview', 'live_collection')),
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  granted_by uuid not null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz null,
  revoked_by uuid null,
  revoke_reason text null check (revoke_reason is null or char_length(btrim(revoke_reason)) between 3 and 500),
  constraint intake_feature_grants_studio_id_key unique (studio_id, id),
  -- absolute hours, not calendar days: calendar-day arithmetic depends on the session TimeZone (DST) and made a valid grant fail its own check
  constraint intake_feature_grants_window check (expires_at > granted_at and expires_at <= granted_at + interval '2160 hours'),
  constraint intake_feature_grants_revocation check ((revoked_at is null) = (revoked_by is null) and (revoked_at is null) = (revoke_reason is null))
);
create unique index if not exists intake_feature_grants_one_active
  on public.intake_feature_grants (studio_id, capability) where revoked_at is null;

revoke all on public.intake_feature_grants from public, anon, authenticated, service_role;
alter table public.intake_feature_grants enable row level security;

create or replace function intake_private.feature_grants_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.studios s where s.id = old.studio_id) then
      raise exception 'nsi: feature grants are append-only' using errcode = '42501';
    end if;
    return old;
  end if;
  -- the only permitted change: revoke an unrevoked grant, touching nothing but the revocation columns
  if old.revoked_at is not null or new.revoked_at is null
     or (to_jsonb(new) - 'revoked_at' - 'revoked_by' - 'revoke_reason') is distinct from (to_jsonb(old) - 'revoked_at' - 'revoked_by' - 'revoke_reason') then
    raise exception 'nsi: feature grants can only be revoked' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists intake_feature_grants_30_guard on public.intake_feature_grants;
create trigger intake_feature_grants_30_guard before update or delete on public.intake_feature_grants
  for each row execute function intake_private.feature_grants_guard();
drop trigger if exists intake_feature_grants_no_truncate on public.intake_feature_grants;
create trigger intake_feature_grants_no_truncate before truncate on public.intake_feature_grants
  for each statement execute function intake_private.refuse_truncate();

-- Active = not revoked and not expired. Expiry is evaluated at call time, so a lapse takes effect without any job.
create or replace function intake_private.feature_granted(p_studio_id uuid, p_capability text)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from public.intake_feature_grants g
                 where g.studio_id = p_studio_id and g.capability = p_capability
                   and g.revoked_at is null and g.expires_at > now());
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Gate B now includes the live_collection grant (spec 16.5 / N2): the database refuses new obligations for a studio
-- without an active live grant even when a service-role caller skips every application check. Already issued
-- requests are unaffected (continuing paths check Gate A and the erasure barrier only).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function intake_private.new_obligation_allowed(p_studio_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m7
  select coalesce((select s.enabled from public.intake_settings s where s.studio_id = p_studio_id), false)
     and intake_private.feature_granted(p_studio_id, 'live_collection');
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Capability matrix (M1 body plus): 'feature_grant' is platform-admin only; 'disable' (turn intake off) is owner and
-- admin without a grant; 'configure' now also needs an active config_preview grant. Read capabilities are unchanged
-- (configure_read needs no grant), so an expired pilot keeps read-only visibility.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function intake_private.assert_staff(p_studio_id uuid, p_capability text)
returns text language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m7
declare
  v_role text;
  v_settings public.intake_settings;
  v_ok text;
begin
  if auth.uid() is null then
    raise exception 'nsi: not authorized' using errcode = '42501';
  end if;
  if p_capability in ('hold_admin', 'erasure', 'barrier_release', 'feature_grant') then
    if public.intake_is_platform_admin() then return 'platform_admin'; end if;
    raise exception 'nsi: not authorized' using errcode = '42501';
  end if;
  if p_studio_id is null then
    raise exception 'nsi: studio required' using errcode = '22023';
  end if;
  v_role := intake_private.studio_role(p_studio_id);
  select * into v_settings from public.intake_settings s where s.studio_id = p_studio_id;
  if v_role = 'studio_owner' and p_capability in
       ('configure', 'configure_read', 'disable', 'view_status', 'send', 'view_all_answers', 'view_operational',
        'designate_guardian', 'attest', 'minor_override', 'extend_draft', 'retention_choice', 'drift_report') then
    v_ok := v_role;
  elsif v_role = 'studio_admin' and (p_capability in
       ('configure', 'configure_read', 'disable', 'view_status', 'send', 'view_all_answers', 'view_operational',
        'designate_guardian', 'attest', 'minor_override', 'retention_choice', 'drift_report')
       or (p_capability = 'extend_draft' and coalesce(v_settings.draft_extension_admins_enabled, false))) then
    v_ok := v_role;
  elsif v_role = 'front_desk' and (p_capability in ('view_status', 'send', 'view_operational', 'attest')
       or (p_capability = 'designate_guardian' and coalesce(v_settings.front_desk_guardian_selection, false))) then
    v_ok := v_role;
  elsif p_capability in ('view_status', 'configure_read', 'drift_report') and public.intake_is_platform_admin() then
    return 'platform_admin';
  end if;
  if v_ok is null then
    raise exception 'nsi: not authorized' using errcode = '42501';
  end if;
  if p_capability = 'configure' and not intake_private.feature_granted(p_studio_id, 'config_preview') then
    raise exception 'nsi: Student Intake is not available for this studio' using errcode = '42501';
  end if;
  return v_ok;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Audit: two new event types.
-- ---------------------------------------------------------------------------------------------------------------
alter table public.intake_audit_events drop constraint intake_audit_events_event_type_check;
alter table public.intake_audit_events add constraint intake_audit_events_event_type_check check (event_type = any (array[
  'environment_first_personal_use', 'template_draft_saved', 'template_version_published', 'reintake_floor_set',
  'service_assignment_set', 'settings_updated', 'retention_choice_set', 'request_created', 'appointment_attached',
  'draft_saved', 'response_submitted', 'completion_recorded', 'minor_determination_recorded', 'guardian_designated',
  'guardian_recipient_selected', 'draft_retention_extended', 'staff_viewed_answers', 'drift_report_run',
  'tenant_drift_detected', 'legal_hold_created', 'legal_hold_released', 'erasure_record', 'erasure_barrier_released',
  'erasure_refused_hold', 'gate_refused', 'feature_granted', 'feature_revoked']::text[]));

-- ---------------------------------------------------------------------------------------------------------------
-- Settings patch (M5 body plus): turning intake OFF needs the 'disable' capability only; turning it ON needs an active
-- live_collection grant; a default template must be an active template of this studio. Nothing here opens Gate A.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.intake_update_settings(p_studio_id uuid, p_changes jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
-- nsi-body:m7
declare
  v_role text := intake_private.assert_staff(p_studio_id,
    case when p_changes = jsonb_build_object('enabled', false) then 'disable' else 'configure' end);
  c_allowed constant text[] := array['enabled', 'minor_age_threshold', 'default_template_id', 'front_desk_guardian_selection',
    'draft_extension_admins_enabled', 'min_guardian_assurance', 'surge_threshold_per_run', 'surge_threshold_24h',
    'invite_max_lifetime_days'];
  s public.intake_settings;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_changes) k where not (k = any (c_allowed))) then
    raise exception 'nsi: unsupported settings change' using errcode = '22023';
  end if;
  if (p_changes ->> 'enabled')::boolean is true and not intake_private.feature_granted(p_studio_id, 'live_collection') then
    raise exception 'nsi: live Student Intake is not available for this studio' using errcode = '42501';
  end if;
  if (p_changes ? 'front_desk_guardian_selection' or p_changes ? 'draft_extension_admins_enabled') and v_role <> 'studio_owner' then
    raise exception 'nsi: only the studio owner can change intake permission flags' using errcode = '42501';
  end if;
  if p_changes ? 'default_template_id' and p_changes ->> 'default_template_id' is not null then
    -- FOR SHARE: waits for a concurrent archive (which holds the row FOR UPDATE) and re-reads its committed status
    perform 1 from public.intake_templates t
    where t.id = (p_changes ->> 'default_template_id')::uuid and t.studio_id = p_studio_id and t.status = 'active' for share;
    if not found then
      raise exception 'nsi: the default template must be an active template of this studio' using errcode = '22023';
    end if;
  end if;
  insert into public.intake_settings (studio_id) values (p_studio_id) on conflict (studio_id) do nothing;
  select * into s from public.intake_settings x where x.studio_id = p_studio_id for update;
  update public.intake_settings set
    enabled = coalesce((p_changes ->> 'enabled')::boolean, s.enabled),
    enabled_at = case when coalesce((p_changes ->> 'enabled')::boolean, s.enabled) and not s.enabled then now() else s.enabled_at end,
    minor_age_threshold = coalesce((p_changes ->> 'minor_age_threshold')::smallint, s.minor_age_threshold),
    default_template_id = case when p_changes ? 'default_template_id' then (p_changes ->> 'default_template_id')::uuid else s.default_template_id end,
    front_desk_guardian_selection = coalesce((p_changes ->> 'front_desk_guardian_selection')::boolean, s.front_desk_guardian_selection),
    draft_extension_admins_enabled = coalesce((p_changes ->> 'draft_extension_admins_enabled')::boolean, s.draft_extension_admins_enabled),
    min_guardian_assurance = coalesce(p_changes ->> 'min_guardian_assurance', s.min_guardian_assurance),
    surge_threshold_per_run = coalesce((p_changes ->> 'surge_threshold_per_run')::int, s.surge_threshold_per_run),
    surge_threshold_24h = case when p_changes ? 'surge_threshold_24h' then (p_changes ->> 'surge_threshold_24h')::int else s.surge_threshold_24h end,
    invite_max_lifetime_days = case when p_changes ? 'invite_max_lifetime_days' then (p_changes ->> 'invite_max_lifetime_days')::int else s.invite_max_lifetime_days end,
    updated_by = auth.uid()
  where studio_id = p_studio_id;
  perform intake_private.audit_write(p_studio_id, 'settings_updated', 'staff', auth.uid(), v_role, null, null, null, null, null,
    case when p_changes ? 'enabled' then jsonb_build_object('enabled', (p_changes ->> 'enabled')::boolean) else '{}'::jsonb end, 'operational');
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Platform-admin grant authority. The actor is always auth.uid(); the studio must exist; a grant lasts 1-90 days and
-- needs a reason; a new grant supersedes (revokes) any unrevoked grant of the same studio and capability.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.intake_grant_feature(p_studio_id uuid, p_capability text, p_reason text, p_days int)
returns uuid language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := intake_private.assert_staff(p_studio_id, 'feature_grant');
  v_id uuid;
begin
  if p_capability is null or p_capability not in ('config_preview', 'live_collection') then
    raise exception 'nsi: unsupported capability' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'nsi: a reason of 3-500 characters is required' using errcode = '22023';
  end if;
  if p_days is null or p_days not between 1 and 90 then
    raise exception 'nsi: a grant lasts 1-90 days' using errcode = '22023';
  end if;
  if not exists (select 1 from public.studios s where s.id = p_studio_id) then
    raise exception 'nsi: unknown studio' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('intake:grant:' || p_studio_id::text || ':' || p_capability, 0));
  update public.intake_feature_grants set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'superseded by a new grant'
  where studio_id = p_studio_id and capability = p_capability and revoked_at is null;
  insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at)
  values (p_studio_id, p_capability, btrim(p_reason), auth.uid(), now() + make_interval(hours => 24 * p_days))
  returning id into v_id;
  perform intake_private.audit_write(p_studio_id, 'feature_granted', 'platform_admin', auth.uid(), v_role, null, null,
    'intake_feature_grant', v_id, null, jsonb_build_object('capability', p_capability), 'security');
  return v_id;
end $$;

create or replace function public.intake_revoke_feature(p_grant_id uuid, p_reason text)
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text := intake_private.assert_staff(null, 'feature_grant');
  g public.intake_feature_grants;
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'nsi: a reason of 3-500 characters is required' using errcode = '22023';
  end if;
  select * into g from public.intake_feature_grants x where x.id = p_grant_id for update;
  if g.id is null then raise exception 'nsi: grant not found' using errcode = '22023'; end if;
  if g.revoked_at is not null then raise exception 'nsi: grant is already revoked' using errcode = '22023'; end if;
  update public.intake_feature_grants set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = btrim(p_reason) where id = g.id;
  perform intake_private.audit_write(g.studio_id, 'feature_revoked', 'platform_admin', auth.uid(), v_role, null, null,
    'intake_feature_grant', g.id, null, jsonb_build_object('capability', g.capability), 'security');
end $$;

-- What the studio's own owner/admin may see about their access (no reasons, no other studios).
create or replace function public.intake_feature_status(p_studio_id uuid)
returns table (config_preview boolean, live_collection boolean, config_preview_expires_at timestamptz, live_collection_expires_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
begin
  perform intake_private.assert_staff(p_studio_id, 'configure_read');
  return query
  select exists (select 1 from public.intake_feature_grants g where g.studio_id = p_studio_id and g.capability = 'config_preview' and g.revoked_at is null and g.expires_at > now()),
         exists (select 1 from public.intake_feature_grants g where g.studio_id = p_studio_id and g.capability = 'live_collection' and g.revoked_at is null and g.expires_at > now()),
         (select max(g.expires_at) from public.intake_feature_grants g where g.studio_id = p_studio_id and g.capability = 'config_preview' and g.revoked_at is null and g.expires_at > now()),
         (select max(g.expires_at) from public.intake_feature_grants g where g.studio_id = p_studio_id and g.capability = 'live_collection' and g.revoked_at is null and g.expires_at > now());
end $$;

-- R25 for the new functions; replaced functions keep their ACLs (create or replace).
revoke all on function intake_private.feature_grants_guard() from public, anon, authenticated, service_role, intake_destructive;
revoke all on function intake_private.feature_granted(uuid, text) from public, anon, authenticated, service_role, intake_destructive;
revoke all on function public.intake_grant_feature(uuid, text, text, int) from public, anon, authenticated, service_role, intake_destructive;
revoke all on function public.intake_revoke_feature(uuid, text) from public, anon, authenticated, service_role, intake_destructive;
revoke all on function public.intake_feature_status(uuid) from public, anon, authenticated, service_role, intake_destructive;
grant execute on function public.intake_grant_feature(uuid, text, text, int) to authenticated;
grant execute on function public.intake_revoke_feature(uuid, text) to authenticated;
grant execute on function public.intake_feature_status(uuid) to authenticated;

select intake_private.assert_catalog();

commit;

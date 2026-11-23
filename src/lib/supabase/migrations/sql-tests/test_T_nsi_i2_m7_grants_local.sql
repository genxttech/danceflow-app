-- NSI I2 M7 boundary tests: pilot grants and database-side authorization. Valid from M7 onward (uses no M8/M9 object).
-- Run through run_i2_m7_m9_local.sh (prepends nsi_i2_fixtures_local.sql).

-- ===== G: grant authority =========================================================================================
select pg_temp.chk('G01a platform admin issues a config_preview grant',
  pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''config_preview'', ''pilot studio'', 30)', pg_temp.kv('sa'))) = 'ok');
select pg_temp.chk('G01b only the platform admin can issue grants (owner, admin, front desk, instructor, client, other studio owner, nobody); anon holds no EXECUTE (G07)',
  (select bool_and(pg_temp.run_as('authenticated', pg_temp.u(who), format('select public.intake_grant_feature(%L, ''live_collection'', ''self service'', 30)', pg_temp.kv('sa'))) like '42501%')
   from unnest(array['owner_a', 'admin_a', 'fd_a', 'instr_a', 'plain_a', 'owner_b', 'nobody']) who));
select pg_temp.chk('G01c a studio owner cannot grant a different studio either',
  pg_temp.run_as('authenticated', pg_temp.u('owner_b'), format('select public.intake_grant_feature(%L, ''config_preview'', ''lateral'', 30)', pg_temp.kv('sa'))) like '42501%');
select pg_temp.chk('G02a unsupported capability, bad duration, missing reason and unknown studio are refused (22023)',
  pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''everything'', ''x reason'', 30)', pg_temp.kv('sa'))) like '22023%'
  and pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''live_collection'', ''long'', 91)', pg_temp.kv('sa'))) like '22023%'
  and pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''live_collection'', ''zero'', 0)', pg_temp.kv('sa'))) like '22023%'
  and pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''live_collection'', ''nul'', null)', pg_temp.kv('sa'))) like '22023%'
  and pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''live_collection'', ''  '', 30)', pg_temp.kv('sa'))) like '22023%'
  and pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''live_collection'', null, 30)', pg_temp.kv('sa'))) like '22023%'
  and pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''live_collection'', ''ghost studio'', 30)', gen_random_uuid())) like '22023%');
select pg_temp.chk('G03a the stored grant is bounded to 90 days, attributed to the platform admin, and the reason is kept in the grant row only',
  exists (select 1 from public.intake_feature_grants g where g.studio_id = pg_temp.u('sa') and g.capability = 'config_preview'
          and g.reason = 'pilot studio' and g.granted_by = pg_temp.u('padmin') and g.expires_at <= g.granted_at + interval '90 days' and g.revoked_at is null));
select pg_temp.chk('G03b the audit event names the capability and never the reason',
  exists (select 1 from public.intake_audit_events e where e.studio_id = pg_temp.u('sa') and e.event_type = 'feature_granted'
          and e.metadata = '{"capability": "config_preview"}'::jsonb and e.retention_class = 'security' and e.actor_type = 'platform_admin')
  and not exists (select 1 from public.intake_audit_events e where e.metadata::text ilike '%pilot studio%'));
select pg_temp.setkv('g04', pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''config_preview'', ''renewed'', 60)', pg_temp.kv('sa'))));
select pg_temp.chk('G04 a new grant supersedes the active one: exactly one unrevoked row remains',
  pg_temp.kv('g04') = 'ok'
  and (select count(*) = 1 from public.intake_feature_grants where studio_id = pg_temp.u('sa') and capability = 'config_preview' and revoked_at is null)
  and (select count(*) = 1 from public.intake_feature_grants where studio_id = pg_temp.u('sa') and capability = 'config_preview' and revoke_reason like 'superseded%'));
select pg_temp.setkv('g_live', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''live_collection'', ''pilot go-live'', 7)', pg_temp.kv('sa'))));
select pg_temp.chk('G05a only the platform admin can revoke; unknown id refused',
  (select bool_and(pg_temp.run_as('authenticated', pg_temp.u(who), format('select public.intake_revoke_feature(%L, ''nope nope'')', pg_temp.kv('g_live'))) like '42501%')
   from unnest(array['owner_a', 'admin_a', 'fd_a', 'owner_b', 'nobody']) who)
  and pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_revoke_feature(%L, ''unknown'')', gen_random_uuid())) like '22023%');
select pg_temp.setkv('g05b1', pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_revoke_feature(%L, ''x'')', pg_temp.kv('g_live'))));
select pg_temp.setkv('g05b2', pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_revoke_feature(%L, ''pilot ended'')', pg_temp.kv('g_live'))));
select pg_temp.setkv('g05b3', pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_revoke_feature(%L, ''again'')', pg_temp.kv('g_live'))));
select pg_temp.chk('G05b revoke needs a reason, works once, and is recorded with an audit event',
  pg_temp.kv('g05b1') like '22023%' and pg_temp.kv('g05b2') = 'ok' and pg_temp.kv('g05b3') like '22023%'
  and exists (select 1 from public.intake_audit_events e where e.event_type = 'feature_revoked' and e.studio_id = pg_temp.u('sa')));

-- ===== table guard and privileges ==================================================================================
select pg_temp.chk('G06a grants cannot be edited, re-revoked, deleted or truncated (even by the table owner)',
  pg_temp.try(format('update public.intake_feature_grants set expires_at = expires_at + interval ''1 day'' where studio_id = %L and revoked_at is null', pg_temp.kv('sa'))) like '42501%'
  and pg_temp.try(format('update public.intake_feature_grants set revoke_reason = ''edited'' where id = %L', pg_temp.kv('g_live'))) like '42501%'
  and pg_temp.try(format('delete from public.intake_feature_grants where id = %L', pg_temp.kv('g_live'))) like '42501%'
  and pg_temp.try('truncate public.intake_feature_grants') like '42501%');
select pg_temp.chk('G06b a direct insert cannot exceed 90 days, expire before it starts, or duplicate an active grant',
  pg_temp.try(format('insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at) values (%L, ''live_collection'', ''long'', %L, now() + interval ''120 days'')', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like '23514%'
  and pg_temp.try(format('insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at) values (%L, ''config_preview'', ''dup'', %L, now() + interval ''5 days'')', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like '23505%'
  and pg_temp.try(format('insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at) values (%L, ''live_collection'', ''ok reason'', %L, now() - interval ''1 day'')', pg_temp.kv('sa'), pg_temp.kv('padmin'))) like '23514%');
select pg_temp.chk('G07 no API role holds any privilege on the grants table; RLS on; helper functions are not callable by API roles',
  (select relrowsecurity and not (has_table_privilege('anon', oid, 'SELECT') or has_table_privilege('authenticated', oid, 'SELECT') or has_table_privilege('service_role', oid, 'SELECT')
          or has_table_privilege('authenticated', oid, 'INSERT') or has_table_privilege('authenticated', oid, 'UPDATE') or has_table_privilege('authenticated', oid, 'DELETE')
          or has_table_privilege('service_role', oid, 'INSERT') or has_table_privilege('service_role', oid, 'UPDATE') or has_table_privilege('service_role', oid, 'DELETE'))
   from pg_class where relname = 'intake_feature_grants' and relnamespace = 'public'::regnamespace)
  and not has_function_privilege('authenticated', 'intake_private.feature_granted(uuid,text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'intake_private.feature_granted(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.intake_grant_feature(uuid,text,text,integer)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.intake_grant_feature(uuid,text,text,integer)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.intake_grant_feature(uuid,text,text,integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.intake_feature_status(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.intake_feature_status(uuid)', 'EXECUTE'));

-- ===== configuration writes need an active config_preview grant ====================================================
-- studio A currently has an active config_preview grant; studio B has none.
select pg_temp.setkv('g08a', pg_temp.run_as('authenticated', pg_temp.u('owner_b'), format('select public.intake_save_template_draft(%L, null, ''B try'', %L::jsonb)', pg_temp.kv('sb'), pg_temp.kv('schema'))));
select pg_temp.chk('G08a an owner of an ungranted studio cannot save a template draft (42501), nothing is written',
  pg_temp.kv('g08a') like '42501%Student Intake is not available%'
  and not exists (select 1 from public.intake_templates where studio_id = pg_temp.u('sb') and name = 'B try'));
select pg_temp.chk('G08b with an active config_preview grant owner and admin save drafts; front desk and instructor still cannot',
  pg_temp.run_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_save_template_draft(%L, null, ''A owner'', %L::jsonb)', pg_temp.kv('sa'), pg_temp.kv('schema'))) = 'ok'
  and pg_temp.run_as('authenticated', pg_temp.u('admin_a'), format('select public.intake_save_template_draft(%L, null, ''A admin'', %L::jsonb)', pg_temp.kv('sa'), pg_temp.kv('schema'))) = 'ok'
  and pg_temp.run_as('authenticated', pg_temp.u('fd_a'), format('select public.intake_save_template_draft(%L, null, ''A fd'', %L::jsonb)', pg_temp.kv('sa'), pg_temp.kv('schema'))) like '42501%'
  and pg_temp.run_as('authenticated', pg_temp.u('instr_a'), format('select public.intake_save_template_draft(%L, null, ''A in'', %L::jsonb)', pg_temp.kv('sa'), pg_temp.kv('schema'))) like '42501%');
select pg_temp.chk('G08c the platform admin cannot configure a studio, with or without a grant',
  pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_save_template_draft(%L, null, ''P'', %L::jsonb)', pg_temp.kv('sa'), pg_temp.kv('schema'))) like '42501%');
select pg_temp.chk('G08d a config grant of studio A never lets studio A staff configure studio B, nor studio B staff configure A',
  pg_temp.run_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_save_template_draft(%L, null, ''x'', %L::jsonb)', pg_temp.kv('sb'), pg_temp.kv('schema'))) like '42501%'
  and pg_temp.run_as('authenticated', pg_temp.u('owner_b'), format('select public.intake_save_template_draft(%L, null, ''x'', %L::jsonb)', pg_temp.kv('sa'), pg_temp.kv('schema'))) like '42501%');
-- expired / revoked
select pg_temp.fx_grant('sb', 'config_preview', -2);
select pg_temp.chk('G09a an EXPIRED grant blocks configuration writes',
  pg_temp.run_as('authenticated', pg_temp.u('owner_b'), format('select public.intake_save_template_draft(%L, null, ''expired'', %L::jsonb)', pg_temp.kv('sb'), pg_temp.kv('schema'))) like '42501%Student Intake is not available%');
select pg_temp.chk('G09b a REVOKED grant blocks configuration writes (studio A after revocation)',
  pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_revoke_feature(%L, ''end of pilot'')',
        (select id::text from public.intake_feature_grants where studio_id = pg_temp.u('sa') and capability = 'config_preview' and revoked_at is null))) = 'ok'
  and pg_temp.run_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_save_template_draft(%L, null, ''revoked'', %L::jsonb)', pg_temp.kv('sa'), pg_temp.kv('schema'))) like '42501%');

-- ===== read-only visibility and turning OFF survive a lapse =========================================================
select pg_temp.chk('G10a owners and admins keep read-only visibility without grants: config tables readable (RLS) and feature status callable',
  pg_temp.val_as('authenticated', pg_temp.u('owner_a'), 'select count(*) from public.intake_templates')::int >= 3
  and pg_temp.val_as('authenticated', pg_temp.u('admin_a'), format('select (select config_preview from public.intake_feature_status(%L))::text || (select live_collection from public.intake_feature_status(%L))::text', pg_temp.kv('sa'), pg_temp.kv('sa'))) = 'falsefalse'
  and pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select count(*) from public.intake_feature_status(%L)', pg_temp.kv('sb'))) like 'ERR 42501%');
select pg_temp.chk('G10b feature status is limited to owner/admin/platform admin of that studio',
  pg_temp.val_as('authenticated', pg_temp.u('fd_a'), format('select count(*) from public.intake_feature_status(%L)', pg_temp.kv('sa'))) like 'ERR 42501%'
  and pg_temp.val_as('authenticated', pg_temp.u('plain_a'), format('select count(*) from public.intake_feature_status(%L)', pg_temp.kv('sa'))) like 'ERR 42501%'
  and pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select count(*) from public.intake_feature_status(%L)', pg_temp.kv('sa'))) = '1');
-- settings: enabling needs live_collection; turning off never needs a grant
select pg_temp.fx_grant('sa', 'config_preview', 30);
select pg_temp.setkv('g11a1', pg_temp.run_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_update_settings(%L, jsonb_build_object(''default_template_id'', %L))', pg_temp.kv('sa'), pg_temp.kv('ta'))));
select pg_temp.setkv('g11a2', pg_temp.run_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_update_settings(%L, ''{"enabled": true}'')', pg_temp.kv('sa'))));
select pg_temp.setkv('g11a3', pg_temp.run_as('authenticated', pg_temp.u('admin_a'), format('select public.intake_update_settings(%L, ''{"enabled": true}'')', pg_temp.kv('sa'))));
select pg_temp.chk('G11a with only config_preview the studio can set a default template but NOT turn live intake on',
  pg_temp.kv('g11a1') = 'ok' and pg_temp.kv('g11a2') like '42501%live Student Intake%' and pg_temp.kv('g11a3') like '42501%'
  and (select not enabled and enabled_at is null from public.intake_settings where studio_id = pg_temp.u('sa')));
select pg_temp.chk('G11b the default template must be an active template of the same studio',
  pg_temp.run_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_update_settings(%L, jsonb_build_object(''default_template_id'', %L))', pg_temp.kv('sa'), pg_temp.kv('tb'))) like '22023%'
  and pg_temp.run_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_update_settings(%L, jsonb_build_object(''default_template_id'', %L))', pg_temp.kv('sa'), gen_random_uuid())) like '22023%');
select pg_temp.fx_grant('sa', 'live_collection', 30);
select pg_temp.setkv('g11c1', pg_temp.run_as('authenticated', pg_temp.u('fd_a'), format('select public.intake_update_settings(%L, ''{"enabled": true}'')', pg_temp.kv('sa'))));
select pg_temp.setkv('g11c2', pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_update_settings(%L, ''{"enabled": true}'')', pg_temp.kv('sa'))));
select pg_temp.setkv('g11c3', pg_temp.run_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_update_settings(%L, ''{"enabled": true}'')', pg_temp.kv('sa'))));
select pg_temp.chk('G11c with a live_collection grant the owner can turn intake on (enabled_at is stamped); front desk and the platform admin cannot',
  pg_temp.kv('g11c1') like '42501%' and pg_temp.kv('g11c2') like '42501%' and pg_temp.kv('g11c3') = 'ok'
  and (select enabled and enabled_at is not null from public.intake_settings where studio_id = pg_temp.u('sa')));
-- lapse every grant, then: OFF still works for owner and admin; mixed patches and everything else do not
set local session_replication_role = replica;
update public.intake_feature_grants set granted_at = now() - interval '40 days', expires_at = now() - interval '1 day' where studio_id = pg_temp.u('sa') and revoked_at is null;
set local session_replication_role = origin;
select pg_temp.setkv('g12a1', pg_temp.run_as('authenticated', pg_temp.u('fd_a'), format('select public.intake_update_settings(%L, ''{"enabled": false}'')', pg_temp.kv('sa'))));
select pg_temp.setkv('g12a2', pg_temp.run_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_update_settings(%L, ''{"enabled": false}'')', pg_temp.kv('sa'))));
select pg_temp.chk('G12a after every grant lapsed the owner can still turn intake OFF (and the admin too); front desk cannot',
  pg_temp.kv('g12a1') like '42501%' and pg_temp.kv('g12a2') = 'ok'
  and (select not enabled from public.intake_settings where studio_id = pg_temp.u('sa')));
select pg_temp.chk('G12b a lapsed studio cannot piggy-back other changes on the OFF switch or re-enable',
  pg_temp.run_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_update_settings(%L, jsonb_build_object(''enabled'', false, ''default_template_id'', %L))', pg_temp.kv('sa'), pg_temp.kv('ta2'))) like '42501%'
  and pg_temp.run_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_update_settings(%L, ''{"enabled": true}'')', pg_temp.kv('sa'))) like '42501%'
  and (select default_template_id = pg_temp.u('ta') from public.intake_settings where studio_id = pg_temp.u('sa')));

-- ===== Gate B (database-side entitlement, N2) =====================================================================
select pg_temp.chk('G13a new_obligation_allowed needs enabled AND an active live_collection grant; config_preview never satisfies it',
  not intake_private.new_obligation_allowed(pg_temp.u('sa')));
update public.intake_settings set enabled = true, enabled_at = now() - interval '2 days' where studio_id = pg_temp.u('sa');
select pg_temp.chk('G13b enabled but only expired grants -> still refused',
  not intake_private.new_obligation_allowed(pg_temp.u('sa')));
select pg_temp.fx_grant('sa', 'config_preview', 10);
select pg_temp.chk('G13c enabled + active config_preview (no live grant) -> refused',
  not intake_private.new_obligation_allowed(pg_temp.u('sa')));
select pg_temp.fx_grant('sa', 'live_collection', 10);
select pg_temp.chk('G13d enabled + active live_collection -> allowed; another studio unaffected',
  intake_private.new_obligation_allowed(pg_temp.u('sa')) and not intake_private.new_obligation_allowed(pg_temp.u('sb')));

-- Gate A is untouched: even with every grant, nothing can collect while retention periods are unapproved
select pg_temp.chk('G14 Gate A stays closed and is independent of grants; service ensure_request is refused by Gate A even with both grants',
  not intake_private.retention_gate_open()
  and pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.mk_client('sa'),
        pg_temp.mk_appt('sa', (select id from public.clients where studio_id = pg_temp.u('sa') order by created_at desc limit 1), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour'))) like 'ERR %');

-- Gate-open section (policy replaced inside this rolled-back transaction only)
create or replace function public.intake_platform_policy()
returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
  post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
  audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
language sql stable set search_path = pg_catalog, pg_temp
as $$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text $$;

-- M7-level qualification fixture: the pre-M8 ensure_request needs the type to qualify; from M8 a selection row is required
do $$ begin
  if exists (select 1 from pg_proc where proname = 'service_type_template') then
    insert into public.intake_service_assignments (studio_id, appointment_type, template_id) values (pg_temp.u('sa'), 'private_lesson', null)
    on conflict (studio_id, appointment_type) do nothing;
  end if;
end $$;
select pg_temp.setkv('g_client', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('g_appt', pg_temp.mk_appt('sa', pg_temp.u('g_client'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('g15a', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('g_client'), pg_temp.kv('g_appt'))));
select pg_temp.chk('G15a [gate open in test only] with a live grant the service role can create the obligation',
  pg_temp.kv('g15a') ~ '^[0-9a-f-]{36}$'
  and (select count(*) = 1 from public.intake_requests where client_id = pg_temp.u('g_client')));
select pg_temp.setkv('g_client2', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('g_appt2', pg_temp.mk_appt('sa', pg_temp.u('g_client2'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
set local session_replication_role = replica;
update public.intake_feature_grants set granted_at = now() - interval '40 days', expires_at = now() - interval '1 day' where studio_id = pg_temp.u('sa') and capability = 'live_collection' and revoked_at is null;
set local session_replication_role = origin;
select pg_temp.setkv('g15b', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('g_client2'), pg_temp.kv('g_appt2'))));
select pg_temp.chk('G15b a service-role caller that skips every application check is refused by the DATABASE once the live grant lapsed (new_obligation_not_allowed)',
  pg_temp.kv('g15b') like 'ERR 42501%new_obligation_not_allowed%'
  and not exists (select 1 from public.intake_requests where client_id = pg_temp.u('g_client2') and template_id = pg_temp.u('ta') and status = 'pending'));
-- previously issued request: invited + pinned, no grants of any kind -> draft save still works
select pg_temp.setkv('g_req', gen_random_uuid()::text);
set local session_replication_role = replica;
insert into public.intake_requests (id, studio_id, client_id, template_id, status, source, pinned_version_id, issued_at)
values (pg_temp.u('g_req'), pg_temp.u('sa'), pg_temp.u('g_client2'), pg_temp.u('ta'), 'invited', 'auto', pg_temp.u('ta_v1'), now());
set local session_replication_role = origin;
select pg_temp.chk('G15c previously issued requests stay completable after every grant lapsed (continuing path checks Gate A and the barrier only)',
  pg_temp.val_as('service_role', null, format('select public.intake_save_draft(%L, %L, ''student'', ''{"display_name":"S"}''::jsonb, ''{"a":"x"}''::jsonb, 0)', pg_temp.kv('sa'), pg_temp.kv('g_req'))) = '1');
select pg_temp.chk('G16 nothing here queued outbound mail, completed anything, wrote more than the one draft answer, or changed appointments',
  (select count(*) = 0 from public.outbound_deliveries where template_key like 'intake%')
  and (select count(*) = 0 from public.intake_completions) and (select count(*) = 1 from public.intake_responses)
  and nullif(current_setting('nsi.appointments_fp', true), '') is not null
  and current_setting('nsi.appointments_fp', true) = (select md5(
        (select string_agg(tgname || pg_get_triggerdef(oid), '|' order by tgname) from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal)
     || (select string_agg(conname || pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid = 'public.appointments'::regclass)
     || (select string_agg(indexdef, '|' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'appointments')
     || (select coalesce(string_agg(conrelid::regclass::text || conname, '|' order by conname), '') from pg_constraint where confrelid = 'public.appointments'::regclass))));

-- ===== timezone independence of the 90-day window (review P1-1) ===================================================
-- A grant issued in a DST-crossing session must be exactly 2160 hours and must remain revocable / supersedable from any session.
set local timezone to 'America/New_York';
select pg_temp.setkv('tz1', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''live_collection'', ''tz new york'', 90)', pg_temp.kv('sb'))));
set local timezone to 'UTC';
select pg_temp.setkv('tz2', pg_temp.run_as('authenticated', pg_temp.u('padmin'), format('select public.intake_revoke_feature(%L, ''revoked from utc'')', pg_temp.kv('tz1'))));
set local timezone to 'Pacific/Auckland';
select pg_temp.setkv('tz3', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''live_collection'', ''tz auckland'', 90)', pg_temp.kv('sb'))));
set local timezone to 'America/Los_Angeles';
select pg_temp.setkv('tz4', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_grant_feature(%L, ''live_collection'', ''tz los angeles supersede'', 90)', pg_temp.kv('sb'))));
reset timezone;
select pg_temp.chk('G17 grants issued under America/New_York, Pacific/Auckland and America/Los_Angeles are exactly 2160 hours and can be revoked/superseded from a UTC or other session',
  pg_temp.kv('tz1') ~ '^[0-9a-f-]{36}$' and pg_temp.kv('tz2') = 'ok' and pg_temp.kv('tz3') ~ '^[0-9a-f-]{36}$' and pg_temp.kv('tz4') ~ '^[0-9a-f-]{36}$'
  and (select count(*) = 3 and bool_and(expires_at - granted_at = interval '2160 hours') from public.intake_feature_grants where studio_id = pg_temp.u('sb') and capability = 'live_collection')
  and (select count(*) = 1 from public.intake_feature_grants where studio_id = pg_temp.u('sb') and capability = 'live_collection' and revoked_at is null),
  pg_temp.kv('tz1') || ' ' || pg_temp.kv('tz2') || ' ' || pg_temp.kv('tz3') || ' ' || pg_temp.kv('tz4'));
select pg_temp.chk('G17b the stored window is absolute: a 91-day (2184 hour) row is refused whatever the session timezone',
  pg_temp.try(format('insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at) values (%L, ''config_preview'', ''too long'', %L, now() + interval ''2161 hours'')', pg_temp.kv('sb'), pg_temp.kv('padmin'))) like '23514%');

-- ===== result ======================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 200) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I2 M7 SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I2 M7 SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

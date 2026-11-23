-- NSI I2 M9 boundary tests: template archiving lifecycle. Valid on M9.
-- Run through run_i2_m7_m9_local.sh (prepends nsi_i2_fixtures_local.sql).

select pg_temp.fx_grant('sa', 'config_preview');
select pg_temp.fx_grant('sa', 'live_collection');
insert into public.intake_settings (studio_id, enabled, enabled_at, default_template_id)
values (pg_temp.u('sa'), false, null, pg_temp.u('ta'));
create or replace function pg_temp.owner_a(p_sql text) returns text language sql as $$ select pg_temp.run_as('authenticated', pg_temp.u('owner_a'), p_sql) $$;
-- extra templates in studio A: one free, one assigned, one used by an issued request, one with an unissued request
select pg_temp.setkv('tfree', 'a5300000-0000-0000-0000-000000000c11');
select pg_temp.setkv('tasg', 'a5300000-0000-0000-0000-000000000c12');
select pg_temp.setkv('tpin', 'a5300000-0000-0000-0000-000000000c13');
select pg_temp.setkv('tunp', 'a5300000-0000-0000-0000-000000000c14');
insert into public.intake_templates (id, studio_id, name) values
  (pg_temp.u('tfree'), pg_temp.u('sa'), 'Free'), (pg_temp.u('tasg'), pg_temp.u('sa'), 'Assigned'),
  (pg_temp.u('tpin'), pg_temp.u('sa'), 'Pinned'), (pg_temp.u('tunp'), pg_temp.u('sa'), 'Unissued');
insert into public.intake_template_versions (studio_id, template_id, version_number, status, schema, schema_sha256, max_answer_bytes, published_at)
select pg_temp.u('sa'), pg_temp.u(t), 1, 'published', pg_temp.kv('schema')::jsonb, 'x', 2000, now() from unnest(array['tfree', 'tasg', 'tpin', 'tunp']) t;
select pg_temp.setkv('tpin_v1', (select id::text from public.intake_template_versions where template_id = pg_temp.u('tpin')));
insert into public.intake_service_assignments (studio_id, appointment_type, template_id) values (pg_temp.u('sa'), 'coaching', pg_temp.u('tasg'));
select pg_temp.setkv('rc1', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('rc2', pg_temp.mk_client('sa')::text);
set local session_replication_role = replica;
insert into public.intake_requests (studio_id, client_id, template_id, status, source, pinned_version_id, issued_at)
values (pg_temp.u('sa'), pg_temp.u('rc1'), pg_temp.u('tpin'), 'invited', 'auto', pg_temp.u('tpin_v1'), now());
insert into public.intake_requests (studio_id, client_id, template_id, status, source)
values (pg_temp.u('sa'), pg_temp.u('rc2'), pg_temp.u('tunp'), 'pending', 'auto');
set local session_replication_role = origin;
select pg_temp.setkv('before_versions', (select count(*)::text || ':' || string_agg(id::text || status || version_number || schema_sha256, ',' order by id) from public.intake_template_versions where studio_id = pg_temp.u('sa') and status = 'published'));
select pg_temp.setkv('before_rows', pg_temp.intake_rows());

-- ===== archive rules (trigger-enforced) ===============================================================================
select pg_temp.setkv('r1', pg_temp.owner_a(format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('tfree'))));
select pg_temp.chk('R01 a template that is not default, assigned or waiting on an unissued request can be archived; versions are untouched',
  pg_temp.kv('r1') = 'ok' and (select status = 'archived' from public.intake_templates where id = pg_temp.u('tfree'))
  and (select status = 'published' and published_at is not null from public.intake_template_versions where template_id = pg_temp.u('tfree'))
  and exists (select 1 from public.intake_audit_events where event_type = 'template_archived' and object_ref = pg_temp.u('tfree') and studio_id = pg_temp.u('sa')));
select pg_temp.setkv('r2a', pg_temp.owner_a(format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('ta'))));
select pg_temp.setkv('r2b', pg_temp.owner_a(format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('tasg'))));
select pg_temp.setkv('r2c', pg_temp.owner_a(format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('tunp'))));
select pg_temp.chk('R02 refused (22023): the studio default, a template used by a selected lesson type, a template with an unissued open request',
  pg_temp.kv('r2a') like '22023%default%' and pg_temp.kv('r2b') like '22023%lesson type%' and pg_temp.kv('r2c') like '22023%open requests%'
  and (select bool_and(status = 'active') from public.intake_templates where id in (pg_temp.u('ta'), pg_temp.u('tasg'), pg_temp.u('tunp'))));
select pg_temp.setkv('r3', pg_temp.owner_a(format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('tpin'))));
select pg_temp.chk('R03 a template whose open request was already issued (pinned) can be archived; the pinned reference and request are untouched',
  pg_temp.kv('r3') = 'ok'
  and (select status = 'invited' and pinned_version_id = pg_temp.u('tpin_v1') from public.intake_requests where template_id = pg_temp.u('tpin')));
select pg_temp.chk('R04 the invariant holds for every writer: direct table-owner updates are refused too',
  pg_temp.try(format('update public.intake_templates set status = ''archived'' where id = %L', pg_temp.kv('ta'))) like '22023%'
  and pg_temp.try(format('update public.intake_templates set status = ''archived'' where id = %L', pg_temp.kv('tasg'))) like '22023%'
  and pg_temp.try(format('update public.intake_templates set status = ''archived'' where id = %L', pg_temp.kv('tunp'))) like '22023%');
-- default with an explicit "use default" selection: changing the default frees it
select pg_temp.setkv('r5a', pg_temp.owner_a(format('select public.intake_update_settings(%L, jsonb_build_object(''default_template_id'', %L))', pg_temp.kv('sa'), pg_temp.kv('ta2'))));
select pg_temp.setkv('r5b', pg_temp.owner_a(format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('ta'))));
select pg_temp.chk('R05 once another default is chosen the old default can be archived', pg_temp.kv('r5a') = 'ok' and pg_temp.kv('r5b') = 'ok');
select pg_temp.setkv('r5c', pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''coaching'', false)', pg_temp.kv('sa'))));
select pg_temp.setkv('r5d', pg_temp.owner_a(format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('tasg'))));
select pg_temp.chk('R05b ...and a template becomes archivable once the lesson type that used it is deselected', pg_temp.kv('r5c') = 'ok' and pg_temp.kv('r5d') = 'ok');

-- ===== archived templates are closed to edits, defaults and selections ==============================================
select pg_temp.chk('R06 an archived template cannot be edited, published, made default or selected for a lesson type',
  pg_temp.owner_a(format('select public.intake_save_template_draft(%L, %L, ''edit'', %L::jsonb)', pg_temp.kv('sa'), pg_temp.kv('ta'), pg_temp.kv('schema'))) like '22023%archived%'
  and pg_temp.owner_a(format('select public.intake_update_settings(%L, jsonb_build_object(''default_template_id'', %L))', pg_temp.kv('sa'), pg_temp.kv('ta'))) like '22023%'
  and pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''coaching'', true, %L)', pg_temp.kv('sa'), pg_temp.kv('ta'))) like '22023%'
  and pg_temp.owner_a(format('select public.intake_set_service_assignment(%L, ''coaching'', %L)', pg_temp.kv('sa'), pg_temp.kv('ta'))) like '22023%');
-- a draft saved before archiving cannot be published afterwards
select pg_temp.setkv('d1', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_save_template_draft(%L, null, ''Draft only'', %L::jsonb)', pg_temp.kv('sa'), pg_temp.kv('schema'))));
select pg_temp.setkv('d1t', (select template_id::text from public.intake_template_versions where id = pg_temp.u('d1')));
select pg_temp.setkv('d1p', pg_temp.owner_a(format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('d1t'))));
select pg_temp.setkv('d1q', pg_temp.owner_a(format('select public.intake_publish_template_version(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('d1'))));
select pg_temp.chk('R07 a template with only a draft can be archived, and its draft can then no longer be published', pg_temp.kv('d1') ~ '^[0-9a-f-]{36}$' and pg_temp.kv('d1p') = 'ok' and pg_temp.kv('d1q') like '22023%archived%'
  and (select status = 'draft' from public.intake_template_versions where id = pg_temp.u('d1')));
-- restore
select pg_temp.setkv('res1', pg_temp.owner_a(format('select public.intake_restore_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('ta'))));
select pg_temp.setkv('res2', pg_temp.owner_a(format('select public.intake_save_template_draft(%L, %L, ''Back'', %L::jsonb)', pg_temp.kv('sa'), pg_temp.kv('ta'), pg_temp.kv('schema'))));
select pg_temp.chk('R08 restore reactivates the template and editing works again; restoring or archiving twice is a no-op',
  pg_temp.kv('res1') = 'ok' and pg_temp.kv('res2') = 'ok' and (select status = 'active' from public.intake_templates where id = pg_temp.u('ta'))
  and pg_temp.owner_a(format('select public.intake_restore_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('ta'))) = 'ok'
  and pg_temp.owner_a(format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('tfree'))) = 'ok'
  and exists (select 1 from public.intake_audit_events where event_type = 'template_restored' and object_ref = pg_temp.u('ta')));

-- ===== history preserved ================================================================================================
select pg_temp.chk('R09 archiving never rewrites or deletes history: every published version (id, status, hash) and every request/completion/response row is exactly as before',
  pg_temp.kv('before_versions') = (select count(*)::text || ':' || string_agg(id::text || status || version_number || schema_sha256, ',' order by id) from public.intake_template_versions where studio_id = pg_temp.u('sa') and status = 'published')
  and pg_temp.kv('before_rows') = pg_temp.intake_rows());
select pg_temp.chk('R09b published versions of archived templates are still published and immutable',
  (select bool_and(status = 'published') from public.intake_template_versions where template_id in (pg_temp.u('tfree'), pg_temp.u('tpin'), pg_temp.u('tasg')))
  and pg_temp.try(format('update public.intake_template_versions set schema = ''{"sections":[]}''::jsonb where template_id = %L', pg_temp.kv('tpin'))) like '42501%');
-- an issued request on an archived template still completes (continuing path); gate opened inside this transaction only
create or replace function public.intake_platform_policy()
returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
  post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
  audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
language sql stable set search_path = pg_catalog, pg_temp
as $$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text $$;
select pg_temp.chk('R10 [gate open in test only] a request issued before archiving still accepts answers on its pinned version of the archived template',
  pg_temp.val_as('service_role', null, format('select public.intake_save_draft(%L, %L, ''student'', ''{"display_name":"S"}''::jsonb, ''{"a":"x"}''::jsonb, 0)',
      pg_temp.kv('sa'), (select id::text from public.intake_requests where template_id = pg_temp.u('tpin')))) = '1');

-- ===== authorization ======================================================================================================
select pg_temp.chk('R11 front desk, instructor, client, platform admin, a foreign owner and nobody cannot archive or restore',
  (select bool_and(pg_temp.run_as('authenticated', pg_temp.u(who), format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('tfree'))) like '42501%'
              and pg_temp.run_as('authenticated', pg_temp.u(who), format('select public.intake_restore_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('tfree'))) like '42501%')
   from unnest(array['fd_a', 'instr_a', 'plain_a', 'padmin', 'owner_b', 'nobody']) who));
select pg_temp.setkv('r12a', pg_temp.owner_a(format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('tb'))));
select pg_temp.setkv('r12b', pg_temp.owner_a(format('select public.intake_restore_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('tb'))));
select pg_temp.setkv('r12c', pg_temp.owner_a(format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sb'), pg_temp.kv('tb'))));
select pg_temp.chk('R12 a template of another studio is "not found" (42501) for archive and restore, and nothing changes there',
  pg_temp.kv('r12a') like '42501%not found%' and pg_temp.kv('r12b') like '42501%not found%' and pg_temp.kv('r12c') like '42501%'
  and (select status = 'active' from public.intake_templates where id = pg_temp.u('tb')));
select pg_temp.fx_grant('sa', 'config_preview', -1);
select pg_temp.chk('R13 a lapsed config grant blocks archive and restore (configuration writes)',
  pg_temp.owner_a(format('select public.intake_restore_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('tfree'))) like '42501%Student Intake is not available%'
  and pg_temp.owner_a(format('select public.intake_archive_template(%L, %L)', pg_temp.kv('sa'), pg_temp.kv('ta2'))) like '42501%');
select pg_temp.fx_grant('sa', 'config_preview', 30);
select pg_temp.chk('R14 privileges: archive/restore for authenticated only; guard function for nobody; catalog self-check passes with the trigger',
  has_function_privilege('authenticated', 'public.intake_archive_template(uuid,uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.intake_restore_template(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.intake_archive_template(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.intake_restore_template(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'intake_private.template_archive_guard()', 'EXECUTE')
  and exists (select 1 from pg_trigger where tgname = 'intake_templates_30_archive_guard' and tgenabled = 'O')
  and pg_temp.try('select intake_private.assert_catalog()') = 'ok');
select pg_temp.chk('R15 drift probe: dropping the archive guard trigger is detected by the catalog self-check',
  pg_temp.try('drop trigger intake_templates_30_archive_guard on public.intake_templates; select intake_private.assert_catalog()') like '42501%archive_guard%');

-- ===== result =======================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I2 M9 SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I2 M9 SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

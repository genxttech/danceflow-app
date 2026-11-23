-- NSI I2 M8 boundary tests: explicit lesson-type selection, evaluator semantics, pre-activation simulation. Valid from M8 onward.
-- Run through run_i2_m7_m9_local.sh (prepends nsi_i2_fixtures_local.sql).

-- studio A: both grants, enabled since 5 days ago, default template TA, NO lesson type selected yet
select pg_temp.fx_grant('sa', 'config_preview');
select pg_temp.fx_grant('sa', 'live_collection');
insert into public.intake_settings (studio_id, enabled, enabled_at, default_template_id)
values (pg_temp.u('sa'), true, now() - interval '5 days', pg_temp.u('ta')),
       (pg_temp.u('sb'), true, now() - interval '5 days', pg_temp.u('tb'));
create or replace function pg_temp.owner_a(p_sql text) returns text language sql as $$ select pg_temp.run_as('authenticated', pg_temp.u('owner_a'), p_sql) $$;

-- ===== T: default template alone never qualifies a type ============================================================
select pg_temp.setkv('c1', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('c2', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('c3', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('a_priv', pg_temp.mk_appt('sa', pg_temp.u('c1'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('a_intro', pg_temp.mk_appt('sa', pg_temp.u('c2'), 'intro_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('a_coach', pg_temp.mk_appt('sa', pg_temp.u('c3'), 'coaching', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.chk('T01a with a default template but no selected type, none of the three supported types qualify',
  pg_temp.ev('sa', pg_temp.u('c1'), pg_temp.u('a_priv')) = 'type_not_selected'
  and pg_temp.ev('sa', pg_temp.u('c2'), pg_temp.u('a_intro')) = 'type_not_selected'
  and pg_temp.ev('sa', pg_temp.u('c3'), pg_temp.u('a_coach')) = 'type_not_selected');
select pg_temp.chk('T01b the service-role preview lists them as type_not_selected, never would_create',
  (select count(*) filter (where outcome = 'type_not_selected') >= 3 and count(*) filter (where outcome like 'would_%') = 0
   from public.intake_reconcile_preview(pg_temp.u('sa'), 200)));
-- the write path (gate opened inside this rolled-back transaction only)
create or replace function public.intake_platform_policy()
returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
  post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
  audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
language sql stable set search_path = pg_catalog, pg_temp
as $$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text $$;
select pg_temp.setkv('e1', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('c1'), pg_temp.kv('a_priv'))));
select pg_temp.setkv('e2', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('c2'), pg_temp.kv('a_intro'))));
select pg_temp.setkv('e3', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('c3'), pg_temp.kv('a_coach'))));
select pg_temp.chk('T01c intake_ensure_request refuses every unselected type (no alternate qualification path), nothing is created',
  pg_temp.kv('e1') like 'ERR 22023%not selected%' and pg_temp.kv('e2') like 'ERR 22023%not selected%' and pg_temp.kv('e3') like 'ERR 22023%not selected%'
  and (select count(*) = 0 from public.intake_requests where client_id in (pg_temp.u('c1'), pg_temp.u('c2'), pg_temp.u('c3'))));

-- ===== new RPC: select with the default template, with an explicit template, and deselect ==========================
select pg_temp.setkv('s1', pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''private_lesson'', true)', pg_temp.kv('sa'))));
select pg_temp.chk('T02a selecting a type without a template means "use the default template"',
  pg_temp.kv('s1') = 'ok'
  and (select template_id is null from public.intake_service_assignments where studio_id = pg_temp.u('sa') and appointment_type = 'private_lesson')
  and (select o_outcome = 'would_create' and o_template_id = pg_temp.u('ta') from intake_private.evaluate_appointment_eligibility(pg_temp.u('sa'), pg_temp.u('c1'), pg_temp.u('a_priv'), now(), null))
  and pg_temp.ev('sa', pg_temp.u('c2'), pg_temp.u('a_intro')) = 'type_not_selected');
select pg_temp.setkv('s2', pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''coaching'', true, %L)', pg_temp.kv('sa'), pg_temp.kv('ta2'))));
select pg_temp.chk('T02b an explicit template overrides the default for that type only',
  pg_temp.kv('s2') = 'ok'
  and (select o_template_id = pg_temp.u('ta2') from intake_private.evaluate_appointment_eligibility(pg_temp.u('sa'), pg_temp.u('c3'), pg_temp.u('a_coach'), now(), null))
  and (select o_template_id = pg_temp.u('ta') from intake_private.evaluate_appointment_eligibility(pg_temp.u('sa'), pg_temp.u('c1'), pg_temp.u('a_priv'), now(), null)));
select pg_temp.setkv('e4', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('c1'), pg_temp.kv('a_priv'))));
select pg_temp.chk('T02c intake_ensure_request now accepts the selected type and uses the same template as the evaluator',
  pg_temp.kv('e4') ~ '^[0-9a-f-]{36}$' and (select template_id = pg_temp.u('ta') from public.intake_requests where id = pg_temp.kv('e4')::uuid));
select pg_temp.setkv('e5', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('c2'), pg_temp.kv('a_intro'))));
select pg_temp.chk('T02d ...while an unselected sibling type is still refused', pg_temp.kv('e5') like 'ERR 22023%not selected%');
-- legacy RPC
select pg_temp.setkv('l1', pg_temp.owner_a(format('select public.intake_set_service_assignment(%L, ''intro_lesson'', %L)', pg_temp.kv('sa'), pg_temp.kv('ta2'))));
select pg_temp.chk('T03a legacy intake_set_service_assignment with a template selects the type with that template',
  pg_temp.kv('l1') = 'ok' and (select o_template_id = pg_temp.u('ta2') and o_outcome = 'would_create' from intake_private.evaluate_appointment_eligibility(pg_temp.u('sa'), pg_temp.u('c2'), pg_temp.u('a_intro'), now(), null)));
select pg_temp.setkv('l2', pg_temp.owner_a(format('select public.intake_set_service_assignment(%L, ''intro_lesson'', null)', pg_temp.kv('sa'))));
select pg_temp.chk('T03b legacy NULL deselects the type (it no longer means "fall back to the default")',
  pg_temp.kv('l2') = 'ok'
  and not exists (select 1 from public.intake_service_assignments where studio_id = pg_temp.u('sa') and appointment_type = 'intro_lesson')
  and pg_temp.ev('sa', pg_temp.u('c2'), pg_temp.u('a_intro')) = 'type_not_selected');
select pg_temp.setkv('l3', pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''coaching'', false)', pg_temp.kv('sa'))));
select pg_temp.chk('T03c deselecting through the new RPC removes the row; the coaching appointment no longer qualifies',
  pg_temp.kv('l3') = 'ok' and pg_temp.ev('sa', pg_temp.u('c3'), pg_temp.u('a_coach')) = 'type_not_selected');
select pg_temp.setkv('t04a', pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''group_class'', true)', pg_temp.kv('sa'))));
select pg_temp.setkv('t04b', pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''event'', true)', pg_temp.kv('sa'))));
select pg_temp.setkv('t04c', pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''coaching'', null)', pg_temp.kv('sa'))));
select pg_temp.setkv('t04d', pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''coaching'', true, %L)', pg_temp.kv('sa'), pg_temp.kv('tb'))));
select pg_temp.setkv('t04e', pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''coaching'', true, %L)', pg_temp.kv('sa'), gen_random_uuid())));
select pg_temp.setkv('t04f', pg_temp.owner_a(format('select public.intake_set_service_assignment(%L, ''group_class'', %L)', pg_temp.kv('sa'), pg_temp.kv('ta'))));
select pg_temp.chk('T04 refusals: unsupported type, missing flag, archived/foreign/unknown template (22023); each left the selection unchanged (private_lesson only)',
  pg_temp.kv('t04a') like '22023%' and pg_temp.kv('t04b') like '22023%' and pg_temp.kv('t04c') like '22023%'
  and pg_temp.kv('t04d') like '22023%' and pg_temp.kv('t04e') like '22023%' and pg_temp.kv('t04f') like '22023%'
  and (select count(*) = 1 and bool_and(appointment_type = 'private_lesson') from public.intake_service_assignments where studio_id = pg_temp.u('sa')));
-- archived template cannot be selected (fixture archive through the table owner; M9 adds the RPC)
update public.intake_templates set status = 'archived' where id = pg_temp.u('ta2');
select pg_temp.chk('T04b an archived template cannot be selected through either RPC',
  pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''coaching'', true, %L)', pg_temp.kv('sa'), pg_temp.kv('ta2'))) like '22023%'
  and pg_temp.owner_a(format('select public.intake_set_service_assignment(%L, ''coaching'', %L)', pg_temp.kv('sa'), pg_temp.kv('ta2'))) like '22023%');
update public.intake_templates set status = 'active' where id = pg_temp.u('ta2');

-- ===== authorization of the selection RPCs ===========================================================================
select pg_temp.chk('T05a front desk, instructor, client, platform admin and a foreign owner cannot select types',
  (select bool_and(pg_temp.run_as('authenticated', pg_temp.u(who), format('select public.intake_set_service_type(%L, ''coaching'', true)', pg_temp.kv('sa'))) like '42501%')
   from unnest(array['fd_a', 'instr_a', 'plain_a', 'padmin', 'owner_b', 'nobody']) who)
  and pg_temp.run_as('authenticated', pg_temp.u('admin_a'), format('select public.intake_set_service_type(%L, ''coaching'', true)', pg_temp.kv('sa'))) = 'ok');
select pg_temp.fx_grant('sa', 'config_preview', -1);
select pg_temp.setkv('t05b1', pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''coaching'', false)', pg_temp.kv('sa'))));
select pg_temp.setkv('t05b2', pg_temp.owner_a(format('select public.intake_set_service_assignment(%L, ''coaching'', %L)', pg_temp.kv('sa'), pg_temp.kv('ta'))));
select pg_temp.chk('T05b a lapsed config grant blocks selection writes (private_lesson and coaching rows both unchanged); reads and the evaluator are unaffected',
  pg_temp.kv('t05b1') like '42501%' and pg_temp.kv('t05b2') like '42501%'
  and (select count(*) = 2 and bool_and(template_id is null) and array_agg(appointment_type::text order by appointment_type::text) = array['coaching', 'private_lesson']
       from public.intake_service_assignments where studio_id = pg_temp.u('sa')));
select pg_temp.fx_grant('sa', 'config_preview', 30);

-- ===== single qualification path (static) ===========================================================================
select pg_temp.chk('T06a exactly one function writes intake_service_assignments (write_service_type); no RPC edits it directly',
  (select array_agg(p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'intake_private') and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?intake_service_assignments')
  = array['write_service_type']::name[]);
select pg_temp.chk('T06b only the selection reader, the writer, the status counter, the catalog inventory and (M9) the archive guard read the table; the evaluator and ensure_request go through service_type_template',
  (select array_agg(p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'intake_private') and p.prosrc ilike '%intake_service_assignments%')
  <@ array['service_type_template', 'write_service_type', 'template_archive_guard', 'intake_reconcile_status', 'assert_catalog']::name[]
  and (select count(*) = 2 from pg_proc where proname in ('evaluate_appointment_eligibility', 'intake_ensure_request') and prosrc ilike '%service_type_template%'));
select pg_temp.chk('T06c template_id is nullable but a non-null value still has to belong to the same studio (composite FK)',
  pg_temp.try(format('insert into public.intake_service_assignments (studio_id, appointment_type, template_id) values (%L, ''coaching'', %L)', pg_temp.kv('sb'), pg_temp.kv('ta'))) like '23503%');

-- ===== history (D3): primary and partner participation across all supported types, regardless of selection ===========
-- current selection in studio A: private_lesson (default template) and coaching (default); intro_lesson NOT selected
create or replace function pg_temp.prior(p_client uuid, p_type text, p_status text, p_start interval, p_created interval, p_partner uuid default null)
returns uuid language plpgsql as $$
declare v uuid;
begin
  v := pg_temp.mk_appt('sa', p_client, p_type, p_status, p_start, p_created);
  if p_partner is not null then update public.appointments set partner_client_id = p_partner where id = v; end if;
  return v;
end $$;
do $$
declare x uuid; y uuid; a uuid;
begin
  -- prior lesson of an UNSELECTED supported type (intro_lesson) still makes a client existing
  x := pg_temp.mk_client('sa'); perform pg_temp.prior(x, 'intro_lesson', 'attended', interval '-30 days', interval '-31 days');
  a := pg_temp.mk_appt('sa', x, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  perform pg_temp.chk('H01 prior attended lesson of an unselected supported type -> existing_student', pg_temp.ev('sa', x, a) = 'existing_student');
  -- partner participation
  x := pg_temp.mk_client('sa'); y := pg_temp.mk_client('sa'); perform pg_temp.prior(x, 'coaching', 'attended', interval '-30 days', interval '-31 days', y);
  a := pg_temp.mk_appt('sa', y, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  perform pg_temp.chk('H02 partner participation in a prior lesson -> existing_student', pg_temp.ev('sa', y, a) = 'existing_student');
  -- cancelled prior does not count
  x := pg_temp.mk_client('sa'); y := pg_temp.mk_client('sa'); perform pg_temp.prior(x, 'private_lesson', 'cancelled', interval '-30 days', interval '-31 days', y);
  perform pg_temp.prior(y, 'private_lesson', 'cancelled', interval '-20 days', interval '-21 days');
  a := pg_temp.mk_appt('sa', y, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  perform pg_temp.chk('H03 cancelled prior bookings (as client or as partner) do not establish participation -> would_create', pg_temp.ev('sa', y, a) = 'would_create');
  -- unsupported types do not count
  x := pg_temp.mk_client('sa'); perform pg_temp.prior(x, 'practice_party', 'attended', interval '-30 days', interval '-31 days');
  perform pg_temp.prior(x, 'event', 'attended', interval '-25 days', interval '-26 days');
  a := pg_temp.mk_appt('sa', x, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  perform pg_temp.chk('H04 prior non-lesson appointments do not count -> would_create', pg_temp.ev('sa', x, a) = 'would_create');
  -- another studio's history never counts
  x := pg_temp.mk_client('sa'); y := pg_temp.mk_client('sb');
  insert into public.appointments (studio_id, client_id, partner_client_id, appointment_type, status, starts_at, ends_at, created_at)
  values (pg_temp.u('sb'), y, x, 'private_lesson', 'attended', now() - interval '30 days', now() - interval '30 days' + interval '1 hour', now() - interval '31 days');
  a := pg_temp.mk_appt('sa', x, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  perform pg_temp.chk('H05 history in another studio (even naming this client as partner) never counts -> would_create', pg_temp.ev('sa', x, a) = 'would_create');
  -- future earlier booking of an unselected type defers the later one
  x := pg_temp.mk_client('sa'); perform pg_temp.prior(x, 'intro_lesson', 'scheduled', interval '4 days', interval '-1 hour');
  a := pg_temp.mk_appt('sa', x, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  perform pg_temp.chk('H06 earlier upcoming booking of an unselected supported type -> earlier_appointment_pending', pg_temp.ev('sa', x, a) = 'earlier_appointment_pending');
  -- no_show counts, scheduled-in-the-past counts
  x := pg_temp.mk_client('sa'); perform pg_temp.prior(x, 'private_lesson', 'no_show', interval '-10 days', interval '-11 days');
  a := pg_temp.mk_appt('sa', x, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  perform pg_temp.chk('H07 prior no_show lesson -> existing_student (participation was booked and confirmed in the studio)', pg_temp.ev('sa', x, a) = 'existing_student');
end $$;

-- ===== evaluator entitlement =====================================================================================
select pg_temp.chk('T07a outside simulation a studio without an active live grant gets studio_not_entitled (the evaluator and the service preview)',
  (select count(*) = 0 from public.intake_feature_grants where studio_id = pg_temp.u('sb') and capability = 'live_collection')
  and pg_temp.ev('sb', pg_temp.mk_client('sb'), gen_random_uuid()) = 'studio_not_entitled');
select pg_temp.chk('T07b NULL p_now is refused', pg_temp.try(format('select * from intake_private.evaluate_appointment_eligibility(%L, %L, %L, null)', pg_temp.kv('sa'), gen_random_uuid(), gen_random_uuid())) like '22023%');

-- ===== simulation ====================================================================================================
-- fixtures: studio A turned OFF (never enabled) so the simulation is the only thing that can see the appointments
update public.intake_settings set enabled = false, enabled_at = null where studio_id = pg_temp.u('sa');
select pg_temp.setkv('sim_before_settings', (select enabled::text || coalesce(enabled_at::text, 'null') || updated_at::text from public.intake_settings where studio_id = pg_temp.u('sa')));
select pg_temp.setkv('sim_before_rows', pg_temp.intake_rows());
select pg_temp.setkv('sim_before_aud', (select count(*)::text from public.intake_audit_events));
select pg_temp.setkv('x_in', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('x_old', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('x_imp', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('x_can', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('x_b', pg_temp.mk_client('sb')::text);
select pg_temp.setkv('sa_in', pg_temp.mk_appt('sa', pg_temp.u('x_in'), 'private_lesson', 'scheduled', interval '11 days', interval '-10 days')::text);
select pg_temp.setkv('sa_old', pg_temp.mk_appt('sa', pg_temp.u('x_old'), 'private_lesson', 'scheduled', interval '11 days', interval '-20 days')::text);
select pg_temp.setkv('sa_imp', pg_temp.mk_appt('sa', pg_temp.u('x_imp'), 'private_lesson', 'scheduled', interval '11 days', interval '-5 days')::text);
update public.appointments set source_system = 'csv_import' where id = pg_temp.u('sa_imp');
select pg_temp.setkv('sa_can', pg_temp.mk_appt('sa', pg_temp.u('x_can'), 'private_lesson', 'cancelled', interval '11 days', interval '-5 days')::text);
select pg_temp.setkv('sb_in', pg_temp.mk_appt('sb', pg_temp.u('x_b'), 'private_lesson', 'scheduled', interval '11 days', interval '-5 days')::text);
select pg_temp.setkv('sim14', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select string_agg(appointment_id::text || '':'' || outcome || '':'' || simulated::text, '','' order by appointment_id) from public.intake_simulate_eligibility(%L)', pg_temp.kv('sa'))));
select pg_temp.chk('S01a default lookback 14 days: the 10-day-old booking is simulated as would_create (simulated = true); older, imported, cancelled and foreign bookings are absent',
  pg_temp.kv('sim14') like '%' || pg_temp.kv('sa_in') || ':would_create:true%'
  and pg_temp.kv('sim14') not like '%' || pg_temp.kv('sa_old') || '%' and pg_temp.kv('sim14') not like '%' || pg_temp.kv('sa_imp') || '%'
  and pg_temp.kv('sim14') not like '%' || pg_temp.kv('sa_can') || '%' and pg_temp.kv('sim14') not like '%' || pg_temp.kv('sb_in') || '%', pg_temp.kv('sim14'));
select pg_temp.setkv('sim30', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select string_agg(appointment_id::text || '':'' || outcome, '','' order by appointment_id) from public.intake_simulate_eligibility(%L, 30)', pg_temp.kv('sa'))));
select pg_temp.chk('S01b a 30-day lookback also includes the 20-day-old booking', pg_temp.kv('sim30') like '%' || pg_temp.kv('sa_old') || ':would_create%');
update public.intake_feature_grants set revoked_at = now(), revoked_by = pg_temp.u('padmin'), revoke_reason = 'test: no live grant'
  where studio_id = pg_temp.u('sa') and capability = 'live_collection' and revoked_at is null;
select pg_temp.setkv('s02', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select count(*) from public.intake_simulate_eligibility(%L)', pg_temp.kv('sa'))));
select pg_temp.chk('S02 the simulation works while intake is OFF and with NO live_collection grant (config_preview only), and leaves the settings untouched',
  (select count(*) = 0 from public.intake_feature_grants where studio_id = pg_temp.u('sa') and capability = 'live_collection' and revoked_at is null)
  and pg_temp.kv('s02') ~ '^[1-9][0-9]*$'
  and (select not enabled and enabled_at is null from public.intake_settings where studio_id = pg_temp.u('sa')), pg_temp.kv('s02'));
select pg_temp.fx_grant('sa', 'live_collection', 30);
select pg_temp.chk('S03 read-only: settings (enabled_at, updated_at), every intake data table, audit events and requests are byte-for-byte unchanged by two simulations',
  pg_temp.kv('sim_before_settings') = (select enabled::text || coalesce(enabled_at::text, 'null') || updated_at::text from public.intake_settings where studio_id = pg_temp.u('sa'))
  and pg_temp.kv('sim_before_rows') = pg_temp.intake_rows()
  and pg_temp.kv('sim_before_aud') = (select count(*)::text from public.intake_audit_events)
  and (select provolatile = 's' and prosecdef from pg_proc where proname = 'intake_simulate_eligibility'));
select pg_temp.chk('S04a authorization: front desk, instructor, client, platform admin, nobody and a foreign owner are refused (42501)',
  (select bool_and(pg_temp.val_as('authenticated', pg_temp.u(who), format('select count(*) from public.intake_simulate_eligibility(%L)', pg_temp.kv('sa'))) like 'ERR 42501%')
   from unnest(array['fd_a', 'instr_a', 'plain_a', 'padmin', 'owner_b', 'nobody']) who));
select pg_temp.chk('S04b the admin is allowed; asking for another studio is refused even for an owner of an ungranted studio',
  pg_temp.val_as('authenticated', pg_temp.u('admin_a'), format('select count(*) from public.intake_simulate_eligibility(%L)', pg_temp.kv('sa'))) ~ '^[0-9]+$'
  and pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select count(*) from public.intake_simulate_eligibility(%L)', pg_temp.kv('sb'))) like 'ERR 42501%'
  and pg_temp.val_as('authenticated', pg_temp.u('owner_b'), format('select count(*) from public.intake_simulate_eligibility(%L)', pg_temp.kv('sb'))) like 'ERR 42501%');
select pg_temp.fx_grant('sa', 'config_preview', -1);
select pg_temp.chk('S04c a lapsed config grant blocks the simulation', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select count(*) from public.intake_simulate_eligibility(%L)', pg_temp.kv('sa'))) like 'ERR 42501%');
select pg_temp.fx_grant('sa', 'config_preview', 30);
select pg_temp.chk('S05 lookback outside 1-30 days, NULL, and one-sided cursors are refused (22023); limits are clamped',
  (select bool_and(pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select count(*) from public.intake_simulate_eligibility(%L, %s)', pg_temp.kv('sa'), d)) like 'ERR 22023%')
   from unnest(array['0', '31', 'null', '-5']) d)
  and pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select count(*) from public.intake_simulate_eligibility(%L, 14, 10, now(), null)', pg_temp.kv('sa'))) like 'ERR 22023%'
  and pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select count(*) from public.intake_simulate_eligibility(%L, 14, 10, null, %L)', pg_temp.kv('sa'), gen_random_uuid())) like 'ERR 22023%'
  and pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select count(*) from public.intake_simulate_eligibility(%L, 14, 0)', pg_temp.kv('sa'))) = '1'
  and pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select count(*) from public.intake_simulate_eligibility(%L, 30, 100000)', pg_temp.kv('sa')))::int <= 200);
select pg_temp.chk('S06 the simulation honors the current type selection: after deselecting private lessons the same booking is type_not_selected',
  pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''private_lesson'', false)', pg_temp.kv('sa'))) = 'ok'
  and pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select outcome from public.intake_simulate_eligibility(%L) where appointment_id = %L', pg_temp.kv('sa'), pg_temp.kv('sa_in'))) = 'type_not_selected');

-- ===== privileges, catalog, hot table ================================================================================
select pg_temp.chk('P01 privileges: staff RPCs for authenticated only; evaluator and helpers for nobody; service surface unchanged',
  has_function_privilege('authenticated', 'public.intake_set_service_type(uuid,text,boolean,uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.intake_simulate_eligibility(uuid,integer,integer,timestamptz,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.intake_set_service_type(uuid,text,boolean,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.intake_simulate_eligibility(uuid,integer,integer,timestamptz,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.intake_simulate_eligibility(uuid,integer,integer,timestamptz,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.intake_set_service_type(uuid,text,boolean,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'intake_private.evaluate_appointment_eligibility(uuid,uuid,uuid,timestamptz,timestamptz)', 'EXECUTE')
  and not has_function_privilege('service_role', 'intake_private.service_type_template(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'intake_private.write_service_type(uuid,text,boolean,uuid,text)', 'EXECUTE')
  and (select array_agg(distinct p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private') and has_function_privilege('service_role', p.oid, 'EXECUTE'))
      = array['intake_ensure_request', 'intake_platform_policy', 'intake_reconcile_preview', 'intake_reconcile_status', 'intake_save_draft', 'intake_submit_response']::name[]);
select pg_temp.chk('P02 exactly one evaluator exists (the M6 four-argument form is gone) and the catalog self-check passes',
  (select count(*) = 1 from pg_proc where proname = 'evaluate_appointment_eligibility')
  and pg_temp.try('select intake_private.assert_catalog()') = 'ok');
select pg_temp.chk('P03 appointments fingerprint unchanged; no intake trigger, FK or index on appointments',
  nullif(current_setting('nsi.appointments_fp', true), '') is not null
  and current_setting('nsi.appointments_fp', true) = (select md5(
        (select string_agg(tgname || pg_get_triggerdef(oid), '|' order by tgname) from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal)
     || (select string_agg(conname || pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid = 'public.appointments'::regclass)
     || (select string_agg(indexdef, '|' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'appointments')
     || (select coalesce(string_agg(conrelid::regclass::text || conname, '|' order by conname), '') from pg_constraint where confrelid = 'public.appointments'::regclass)))
  and not exists (select 1 from pg_indexes where tablename = 'appointments' and indexname like '%intake%'));
select pg_temp.chk('P04 no M8 function mentions the retention gate or the platform policy (Gate A is neither read nor changed), and nothing was queued for delivery',
  not exists (select 1 from pg_proc where proname in ('service_type_template', 'write_service_type', 'intake_set_service_type', 'intake_simulate_eligibility', 'evaluate_appointment_eligibility', 'intake_reconcile_preview')
              and prosrc ~* '(retention_gate_open|intake_platform_policy)')
  and (select count(*) = 0 from public.outbound_deliveries where template_key like 'intake%'));

-- ===== P1 blocker remains (documented divergence, NOT fixed by M8) =================================================
select pg_temp.owner_a(format('select public.intake_set_service_type(%L, ''private_lesson'', true)', pg_temp.kv('sa')));
select pg_temp.setkv('xc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('xa', pg_temp.mk_appt('sa', pg_temp.u('xc'), 'private_lesson', 'attended', interval '-30 days', interval '-31 days')::text);
select pg_temp.setkv('xn', pg_temp.mk_appt('sa', pg_temp.u('xc'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
update public.intake_settings set enabled = true, enabled_at = now() - interval '5 days' where studio_id = pg_temp.u('sa');
select pg_temp.setkv('p1_eval', pg_temp.ev('sa', pg_temp.u('xc'), pg_temp.u('xn')));
select pg_temp.setkv('p1_ens', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('xc'), pg_temp.kv('xn'))));
select pg_temp.chk('P1-BLOCKER-1 (documented, still open) the evaluator says existing_student but intake_ensure_request still creates a request: the first-appointment rule is NOT applied by the write path',
  pg_temp.kv('p1_eval') = 'existing_student' and pg_temp.kv('p1_ens') ~ '^[0-9a-f-]{36}$', pg_temp.kv('p1_eval') || ' / ' || pg_temp.kv('p1_ens'));
select pg_temp.setkv('wc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('wa', pg_temp.mk_appt('sa', pg_temp.u('wc'), 'private_lesson', 'scheduled', interval '9 days', interval '-6 days')::text);
select pg_temp.setkv('p1b_eval', pg_temp.ev('sa', pg_temp.u('wc'), pg_temp.u('wa')));
select pg_temp.setkv('p1b_ens', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('wc'), pg_temp.kv('wa'))));
select pg_temp.chk('P1-BLOCKER-2 (documented, still open) the enabled_at watermark is NOT applied by the write path (pre-enablement booking)',
  pg_temp.kv('p1b_eval') = 'before_enablement' and pg_temp.kv('p1b_ens') ~ '^[0-9a-f-]{36}$');
select pg_temp.setkv('sc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('sa2', pg_temp.mk_appt('sa', pg_temp.u('sc'), 'private_lesson', 'scheduled', interval '9 days', interval '0 minutes')::text);
select pg_temp.setkv('p1c_eval', pg_temp.ev('sa', pg_temp.u('sc'), pg_temp.u('sa2')));
select pg_temp.setkv('p1c_ens', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('sc'), pg_temp.kv('sa2'))));
select pg_temp.chk('P1-BLOCKER-3 (documented, still open) the settle delay is NOT applied by the write path',
  pg_temp.kv('p1c_eval') = 'settling' and pg_temp.kv('p1c_ens') ~ '^[0-9a-f-]{36}$');
-- the erasure barrier IS enforced at table level for every writer (collection_gate trigger), including ensure_request
select pg_temp.setkv('ec', pg_temp.mk_client('sa')::text);
set local session_replication_role = replica;
insert into public.intake_audit_events (studio_id, event_type, actor_type, retention_class, client_ref)
values (pg_temp.u('sa'), 'erasure_record', 'system', 'erasure_record', pg_temp.u('ec'));
set local session_replication_role = origin;
select pg_temp.setkv('ea', pg_temp.mk_appt('sa', pg_temp.u('ec'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('p1d_ens', pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('ec'), pg_temp.kv('ea'))));
select pg_temp.chk('P1-NOTE the erasure barrier is already enforced by the table-level gate for ensure_request (erased client refused), unlike the three protections above',
  pg_temp.kv('p1d_ens') like 'ERR 42501%erasure_barrier_active%', pg_temp.kv('p1d_ens'));

-- ===== result ======================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I2 M8 SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I2 M8 SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

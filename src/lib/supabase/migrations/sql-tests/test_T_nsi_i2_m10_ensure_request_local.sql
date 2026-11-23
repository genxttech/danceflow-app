-- NSI I2 M10 boundary tests: intake_ensure_request applies the eligibility evaluator for automatic requests. Valid on M10 only
-- (the M8 suite documents the OPEN P1 behaviour and is expected to fail here: that is the point of M10).
-- Run through run_i2_m7_m9_local.sh (prepends nsi_i2_fixtures_local.sql).

select pg_temp.fx_grant('sa', 'config_preview');
select pg_temp.fx_grant('sa', 'live_collection');
insert into public.intake_settings (studio_id, enabled, enabled_at, default_template_id)
values (pg_temp.u('sa'), true, now() - interval '5 days', pg_temp.u('ta')),
       (pg_temp.u('sb'), true, now() - interval '5 days', pg_temp.u('tb'));  -- studio B has no live_collection grant
-- the write path (gate opened inside this rolled-back transaction only)
create or replace function public.intake_platform_policy()
returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
  post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
  audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
language sql stable set search_path = pg_catalog, pg_temp
as $$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text $$;
create or replace function pg_temp.owner_a(p_sql text) returns text language sql as $$ select pg_temp.run_as('authenticated', pg_temp.u('owner_a'), p_sql) $$;
create or replace function pg_temp.ens(p_studio text, p_client uuid, p_appt uuid, p_source text default 'auto') returns text language sql as $$
  select pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L, %L)', pg_temp.kv(p_studio), p_client, p_appt, p_source)) $$;
create or replace function pg_temp.reqs(p_client uuid) returns int language sql as $$ select count(*)::int from public.intake_requests where client_id = p_client $$;
create or replace function pg_temp.is_uuid(p text) returns boolean language sql as $$ select p ~ '^[0-9a-f-]{36}$' $$;

select pg_temp.owner_a(format('select public.intake_set_service_type(%L, %L, true)', pg_temp.kv('sa'), t)) from unnest(array['private_lesson', 'intro_lesson']) t;

-- ===== E01 new student: evaluator says would_create -> a request is written and the appointment attached ============
select pg_temp.setkv('c1', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('a1', pg_temp.mk_appt('sa', pg_temp.u('c1'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('e1_ev', pg_temp.ev('sa', pg_temp.u('c1'), pg_temp.u('a1')));
select pg_temp.setkv('e1', pg_temp.ens('sa', pg_temp.u('c1'), pg_temp.u('a1')));
select pg_temp.chk('E01 a new student first appointment (evaluator would_create) gets one auto request attached to that appointment',
  pg_temp.kv('e1_ev') = 'would_create' and pg_temp.is_uuid(pg_temp.kv('e1'))
  and (select count(*) = 1 and bool_and(source = 'auto' and template_id = pg_temp.u('ta')) from public.intake_requests where client_id = pg_temp.u('c1'))
  and exists (select 1 from public.intake_request_appointments where request_id = pg_temp.kv('e1')::uuid and appointment_id = pg_temp.u('a1')),
  pg_temp.kv('e1_ev') || ' / ' || coalesce(pg_temp.kv('e1'), 'null'));

-- ===== E02 idempotent ===============================================================================================
select pg_temp.setkv('e2_ev', pg_temp.ev('sa', pg_temp.u('c1'), pg_temp.u('a1')));
select pg_temp.setkv('e2', pg_temp.ens('sa', pg_temp.u('c1'), pg_temp.u('a1')));
select pg_temp.chk('E02 a second call returns the same request, creates nothing and attaches nothing new (evaluator already_attached)',
  pg_temp.kv('e2_ev') = 'already_attached' and pg_temp.kv('e2') = pg_temp.kv('e1')
  and pg_temp.reqs(pg_temp.u('c1')) = 1
  and (select count(*) = 1 from public.intake_request_appointments where request_id = pg_temp.kv('e1')::uuid));

-- ===== E03 P1-BLOCKER-1 closed: existing student (first-appointment rule) ============================================
select pg_temp.setkv('xc', pg_temp.mk_client('sa')::text);
select pg_temp.mk_appt('sa', pg_temp.u('xc'), 'private_lesson', 'attended', interval '-30 days', interval '-31 days');
select pg_temp.setkv('xn', pg_temp.mk_appt('sa', pg_temp.u('xc'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('e3_ev', pg_temp.ev('sa', pg_temp.u('xc'), pg_temp.u('xn')));
select pg_temp.setkv('e3', coalesce(pg_temp.ens('sa', pg_temp.u('xc'), pg_temp.u('xn')), 'NULL'));
select pg_temp.chk('E03 an existing student (earlier attended lesson) gets NO request: ensure_request returns NULL and writes nothing',
  pg_temp.kv('e3_ev') = 'existing_student' and pg_temp.kv('e3') = 'NULL' and pg_temp.reqs(pg_temp.u('xc')) = 0,
  pg_temp.kv('e3_ev') || ' / ' || pg_temp.kv('e3'));

-- ===== E04 P1-BLOCKER-2 closed: enabled_at watermark ================================================================
select pg_temp.setkv('wc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('wa', pg_temp.mk_appt('sa', pg_temp.u('wc'), 'private_lesson', 'scheduled', interval '9 days', interval '-6 days')::text);
select pg_temp.setkv('e4_ev', pg_temp.ev('sa', pg_temp.u('wc'), pg_temp.u('wa')));
select pg_temp.setkv('e4', coalesce(pg_temp.ens('sa', pg_temp.u('wc'), pg_temp.u('wa')), 'NULL'));
select pg_temp.chk('E04 a booking made before the studio enabled intake (enabled_at watermark) gets NO request',
  pg_temp.kv('e4_ev') = 'before_enablement' and pg_temp.kv('e4') = 'NULL' and pg_temp.reqs(pg_temp.u('wc')) = 0,
  pg_temp.kv('e4_ev') || ' / ' || pg_temp.kv('e4'));

-- ===== E05 P1-BLOCKER-3 closed: settle delay ========================================================================
select pg_temp.setkv('sc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('sap', pg_temp.mk_appt('sa', pg_temp.u('sc'), 'private_lesson', 'scheduled', interval '9 days', interval '0 minutes')::text);
select pg_temp.setkv('e5_ev', pg_temp.ev('sa', pg_temp.u('sc'), pg_temp.u('sap')));
select pg_temp.setkv('e5', coalesce(pg_temp.ens('sa', pg_temp.u('sc'), pg_temp.u('sap')), 'NULL'));
select pg_temp.chk('E05 a booking inside the 10-minute settle window gets NO request yet',
  pg_temp.kv('e5_ev') = 'settling' and pg_temp.kv('e5') = 'NULL' and pg_temp.reqs(pg_temp.u('sc')) = 0,
  pg_temp.kv('e5_ev') || ' / ' || pg_temp.kv('e5'));

-- ===== E06 earlier appointment pending: only the first appointment creates; later ones attach ======================
select pg_temp.setkv('pc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('p_first', pg_temp.mk_appt('sa', pg_temp.u('pc'), 'private_lesson', 'scheduled', interval '5 days', interval '-1 hour')::text);
select pg_temp.setkv('p_later', pg_temp.mk_appt('sa', pg_temp.u('pc'), 'private_lesson', 'scheduled', interval '12 days', interval '-1 hour')::text);
select pg_temp.setkv('e6_ev', pg_temp.ev('sa', pg_temp.u('pc'), pg_temp.u('p_later')));
select pg_temp.setkv('e6_later', coalesce(pg_temp.ens('sa', pg_temp.u('pc'), pg_temp.u('p_later')), 'NULL'));
select pg_temp.chk('E06a the later of two new bookings, called first, is not the first appointment: NULL, nothing written',
  pg_temp.kv('e6_ev') = 'earlier_appointment_pending' and pg_temp.kv('e6_later') = 'NULL' and pg_temp.reqs(pg_temp.u('pc')) = 0,
  pg_temp.kv('e6_ev') || ' / ' || pg_temp.kv('e6_later'));
select pg_temp.setkv('e6_first', pg_temp.ens('sa', pg_temp.u('pc'), pg_temp.u('p_first')));
select pg_temp.setkv('e6_ev2', pg_temp.ev('sa', pg_temp.u('pc'), pg_temp.u('p_later')));
select pg_temp.setkv('e6_later2', pg_temp.ens('sa', pg_temp.u('pc'), pg_temp.u('p_later')));
select pg_temp.chk('E06b the first appointment creates the request; the later one then attaches to the same request',
  pg_temp.is_uuid(pg_temp.kv('e6_first')) and pg_temp.kv('e6_ev2') = 'would_attach' and pg_temp.kv('e6_later2') = pg_temp.kv('e6_first')
  and pg_temp.reqs(pg_temp.u('pc')) = 1
  and (select count(*) = 2 from public.intake_request_appointments where request_id = pg_temp.kv('e6_first')::uuid and detached_at is null));

-- ===== E07 already completed ========================================================================================
select pg_temp.setkv('dc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('d_req', gen_random_uuid()::text);
set local session_replication_role = replica;
insert into public.intake_requests (id, studio_id, client_id, template_id, status, source)
values (pg_temp.kv('d_req')::uuid, pg_temp.u('sa'), pg_temp.u('dc'), pg_temp.u('ta'), 'submitted', 'auto');
insert into public.intake_completions (studio_id, request_id, client_id, template_id, template_version_id, version_number, student_response_id)
values (pg_temp.u('sa'), pg_temp.kv('d_req')::uuid, pg_temp.u('dc'), pg_temp.u('ta'), gen_random_uuid(), 1, gen_random_uuid());
set local session_replication_role = origin;
select pg_temp.setkv('da', pg_temp.mk_appt('sa', pg_temp.u('dc'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('e7_ev', pg_temp.ev('sa', pg_temp.u('dc'), pg_temp.u('da')));
select pg_temp.setkv('e7', coalesce(pg_temp.ens('sa', pg_temp.u('dc'), pg_temp.u('da')), 'NULL'));
select pg_temp.chk('E07 a client with a valid completion gets the completed request back and no new request',
  pg_temp.kv('e7_ev') = 'already_completed' and pg_temp.kv('e7') = pg_temp.kv('d_req') and pg_temp.reqs(pg_temp.u('dc')) = 1,
  pg_temp.kv('e7_ev') || ' / ' || pg_temp.kv('e7'));

-- ===== E08 not entitled / not enabled ===============================================================================
select pg_temp.setkv('bc', pg_temp.mk_client('sb')::text);
select pg_temp.setkv('ba', pg_temp.mk_appt('sb', pg_temp.u('bc'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('e8_ev', pg_temp.ev('sb', pg_temp.u('bc'), pg_temp.u('ba')));
select pg_temp.setkv('e8', coalesce(pg_temp.ens('sb', pg_temp.u('bc'), pg_temp.u('ba')), 'NULL'));
update public.intake_settings set enabled = false where studio_id = pg_temp.u('sa');
select pg_temp.setkv('nc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('na', pg_temp.mk_appt('sa', pg_temp.u('nc'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('e8b_ev', pg_temp.ev('sa', pg_temp.u('nc'), pg_temp.u('na')));
select pg_temp.setkv('e8b', coalesce(pg_temp.ens('sa', pg_temp.u('nc'), pg_temp.u('na')), 'NULL'));
update public.intake_settings set enabled = true where studio_id = pg_temp.u('sa');
select pg_temp.chk('E08 a studio without the live_collection grant, and a studio that switched intake off, get NO automatic request',
  pg_temp.kv('e8_ev') = 'studio_not_entitled' and pg_temp.kv('e8') = 'NULL' and pg_temp.reqs(pg_temp.u('bc')) = 0
  and pg_temp.kv('e8b_ev') = 'studio_not_enabled' and pg_temp.kv('e8b') = 'NULL' and pg_temp.reqs(pg_temp.u('nc')) = 0,
  pg_temp.kv('e8_ev') || ' / ' || pg_temp.kv('e8b_ev'));

-- ===== E09 imported appointment, erasure barrier ====================================================================
select pg_temp.setkv('ic', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('ia', pg_temp.mk_appt('sa', pg_temp.u('ic'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
update public.appointments set source_system = 'import-x' where id = pg_temp.u('ia');
select pg_temp.setkv('e9_ev', pg_temp.ev('sa', pg_temp.u('ic'), pg_temp.u('ia')));
select pg_temp.setkv('e9', coalesce(pg_temp.ens('sa', pg_temp.u('ic'), pg_temp.u('ia')), 'NULL'));
select pg_temp.setkv('ec', pg_temp.mk_client('sa')::text);
set local session_replication_role = replica;
insert into public.intake_audit_events (studio_id, event_type, actor_type, retention_class, client_ref)
values (pg_temp.u('sa'), 'erasure_record', 'system', 'erasure_record', pg_temp.u('ec'));
set local session_replication_role = origin;
select pg_temp.setkv('ea', pg_temp.mk_appt('sa', pg_temp.u('ec'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('e9b_ev', pg_temp.ev('sa', pg_temp.u('ec'), pg_temp.u('ea')));
select pg_temp.setkv('e9b', coalesce(pg_temp.ens('sa', pg_temp.u('ec'), pg_temp.u('ea')), 'NULL'));
select pg_temp.chk('E09 an imported appointment and an erased client get NO automatic request (evaluator outcomes imported_source / erasure_barrier)',
  pg_temp.kv('e9_ev') = 'imported_source' and pg_temp.kv('e9') = 'NULL' and pg_temp.reqs(pg_temp.u('ic')) = 0
  and pg_temp.kv('e9b_ev') = 'erasure_barrier' and pg_temp.kv('e9b') = 'NULL' and pg_temp.reqs(pg_temp.u('ec')) = 0,
  pg_temp.kv('e9_ev') || ' / ' || pg_temp.kv('e9b_ev'));

-- ===== E10 refusals that stay errors ================================================================================
select pg_temp.setkv('tc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('ta_coach', pg_temp.mk_appt('sa', pg_temp.u('tc'), 'coaching', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('e10a', pg_temp.ens('sa', pg_temp.u('tc'), pg_temp.u('ta_coach')));
select pg_temp.setkv('e10b', pg_temp.ens('sa', pg_temp.u('tc'), null));
select pg_temp.setkv('e10c', pg_temp.ens('sa', pg_temp.u('tc'), pg_temp.u('ta_coach'), 'bogus'));
select pg_temp.chk('E10 an unselected lesson type, an automatic request without an appointment and an invalid source still raise 22023',
  pg_temp.kv('e10a') like 'ERR 22023%not selected%' and pg_temp.kv('e10b') like 'ERR 22023%need a qualifying appointment%'
  and pg_temp.kv('e10c') like 'ERR 22023%invalid source%' and pg_temp.reqs(pg_temp.u('tc')) = 0,
  pg_temp.kv('e10a') || ' / ' || pg_temp.kv('e10b') || ' / ' || pg_temp.kv('e10c'));

-- ===== E11 manual (staff) requests are unchanged: explicit choice overrides timing =====================================
select pg_temp.setkv('e11', pg_temp.ens('sa', pg_temp.u('xc'), pg_temp.u('xn'), 'manual'));
select pg_temp.chk('E11 a staff-initiated (manual) request for the existing student of E03 is still created, source manual',
  pg_temp.is_uuid(pg_temp.kv('e11')) and (select source = 'manual' from public.intake_requests where id = pg_temp.kv('e11')::uuid),
  pg_temp.kv('e11'));

-- ===== E12 simulation and write path agree ==========================================================================
select pg_temp.chk('E12 for every scenario above the evaluator outcome predicts exactly whether the write path created or attached (would_*/already_* <=> non-NULL)',
  (select bool_and((o in ('would_create', 'would_attach', 'would_create_reintake', 'already_attached', 'already_completed')) = (r <> 'NULL'))
   from (values (pg_temp.kv('e1_ev'), pg_temp.kv('e1')), (pg_temp.kv('e3_ev'), pg_temp.kv('e3')), (pg_temp.kv('e4_ev'), pg_temp.kv('e4')),
                (pg_temp.kv('e5_ev'), pg_temp.kv('e5')), (pg_temp.kv('e6_ev'), pg_temp.kv('e6_later')), (pg_temp.kv('e7_ev'), pg_temp.kv('e7')),
                (pg_temp.kv('e8_ev'), pg_temp.kv('e8')), (pg_temp.kv('e8b_ev'), pg_temp.kv('e8b')), (pg_temp.kv('e9_ev'), pg_temp.kv('e9')),
                (pg_temp.kv('e9b_ev'), pg_temp.kv('e9b'))) s(o, r)));

-- ===== E13 catalog, privileges, no delivery side effect ===============================================================
select pg_temp.chk('E13a the body carries the m10 marker and no longer the m8 marker; assert_catalog passes',
  (select prosrc ~ 'nsi-body:m1[01]' and position('nsi-body:m8' in prosrc) = 0 from pg_proc where proname = 'intake_ensure_request' and pronamespace = 'public'::regnamespace)
  and pg_temp.try('select intake_private.assert_catalog()') = 'ok');
select pg_temp.chk('E13b execute is still service_role only (not anon, authenticated or PUBLIC), security definer, fixed search_path',
  has_function_privilege('service_role', 'public.intake_ensure_request(uuid,uuid,uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.intake_ensure_request(uuid,uuid,uuid,text)', 'execute')
  and not has_function_privilege('anon', 'public.intake_ensure_request(uuid,uuid,uuid,text)', 'execute')
  and (select prosecdef and proconfig = array['search_path=pg_catalog, pg_temp'] from pg_proc where proname = 'intake_ensure_request' and pronamespace = 'public'::regnamespace));
select pg_temp.chk('E13c nothing was queued for delivery',
  (select count(*) = 0 from public.outbound_deliveries where template_key like 'intake%'));
select pg_temp.chk('E13d the new evaluator-driven body never opens or tests Gate A or the platform policy itself (the table gate stays the single enforcement point)',
  (select position('retention_gate_open' in prosrc) = 0 and position('intake_platform_policy' in prosrc) = 0 from pg_proc where proname = 'intake_ensure_request' and pronamespace = 'public'::regnamespace));

-- ===== result ======================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I2 M10 SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I2 M10 SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

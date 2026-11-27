-- NSI I2 M11 boundary tests: detached links, anchor recompute, history and timing boundaries, re-intake. Valid on M11 only.
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


-- ===== H01 P2-2: a detached link is staff's decision; nothing churns ================================================
select pg_temp.setkv('dc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('da1', pg_temp.mk_appt('sa', pg_temp.u('dc'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('dr', pg_temp.ens('sa', pg_temp.u('dc'), pg_temp.u('da1')));
update public.intake_request_appointments set detached_at = now() where request_id = pg_temp.kv('dr')::uuid and appointment_id = pg_temp.u('da1');
select pg_temp.setkv('h1_ev', pg_temp.ev('sa', pg_temp.u('dc'), pg_temp.u('da1')));
select pg_temp.setkv('h1_a', coalesce(pg_temp.ens('sa', pg_temp.u('dc'), pg_temp.u('da1')), 'NULL'));
select pg_temp.setkv('h1_b', coalesce(pg_temp.ens('sa', pg_temp.u('dc'), pg_temp.u('da1')), 'NULL'));
select pg_temp.chk('H01a a detached appointment is reported as detached_from_request and ensure_request returns NULL every time; the link stays detached, nothing is re-attached or written',
  pg_temp.is_uuid(pg_temp.kv('dr')) and pg_temp.kv('h1_ev') = 'detached_from_request' and pg_temp.kv('h1_a') = 'NULL' and pg_temp.kv('h1_b') = 'NULL'
  and (select count(*) = 1 and bool_and(detached_at is not null) from public.intake_request_appointments where request_id = pg_temp.kv('dr')::uuid)
  and pg_temp.reqs(pg_temp.u('dc')) = 1, pg_temp.kv('h1_ev'));
select pg_temp.setkv('pos_c', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('pos_a', pg_temp.mk_appt('sa', pg_temp.u('pos_c'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.chk('H01c the reconcile preview no longer lists an appointment that has a detached link (positive control: an unlinked appointment of the same kind IS listed)',
  not exists (select 1 from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid, 200) p where p.appointment_id = pg_temp.u('da1'))
  and exists (select 1 from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid, 200) p where p.appointment_id = pg_temp.u('pos_a')));
select pg_temp.setkv('da2', pg_temp.mk_appt('sa', pg_temp.u('dc'), 'private_lesson', 'scheduled', interval '12 days', interval '-1 hour')::text);
select pg_temp.setkv('h1_c', pg_temp.ens('sa', pg_temp.u('dc'), pg_temp.u('da2')));
select pg_temp.chk('H01b a different appointment of the same client still joins the open request',
  pg_temp.kv('h1_c') = pg_temp.kv('dr') and (select count(*) = 2 from public.intake_request_appointments where request_id = pg_temp.kv('dr')::uuid));

-- ===== H02 P2-3: anchor = earliest live attached appointment =========================================================
select pg_temp.setkv('kc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('k_late', pg_temp.mk_appt('sa', pg_temp.u('kc'), 'private_lesson', 'scheduled', interval '12 days', interval '-1 hour')::text);
select pg_temp.setkv('k_req', pg_temp.ens('sa', pg_temp.u('kc'), pg_temp.u('k_late')));
select pg_temp.setkv('k_anchor1', (select anchor_appointment_id::text from public.intake_requests where id = pg_temp.kv('k_req')::uuid));
select pg_temp.setkv('k_early', pg_temp.mk_appt('sa', pg_temp.u('kc'), 'private_lesson', 'scheduled', interval '5 days', interval '-1 hour')::text);
select pg_temp.setkv('k_ev', pg_temp.ev('sa', pg_temp.u('kc'), pg_temp.u('k_early')));
select pg_temp.setkv('k_req2', pg_temp.ens('sa', pg_temp.u('kc'), pg_temp.u('k_early')));
select pg_temp.setkv('k_anchor2', (select anchor_appointment_id::text from public.intake_requests where id = pg_temp.kv('k_req')::uuid));
select pg_temp.setkv('k_far', pg_temp.mk_appt('sa', pg_temp.u('kc'), 'private_lesson', 'scheduled', interval '20 days', interval '-1 hour')::text);
select pg_temp.ens('sa', pg_temp.u('kc'), pg_temp.u('k_far'));
select pg_temp.chk('H02 the anchor starts at the first booking and moves to an earlier one that attaches later; a later booking attaching does not move it',
  pg_temp.kv('k_anchor1') = pg_temp.kv('k_late') and pg_temp.kv('k_ev') = 'would_attach' and pg_temp.kv('k_req2') = pg_temp.kv('k_req')
  and pg_temp.kv('k_anchor2') = pg_temp.kv('k_early')
  and (select anchor_appointment_id = pg_temp.u('k_early') from public.intake_requests where id = pg_temp.kv('k_req')::uuid),
  pg_temp.kv('k_anchor1') || ' / ' || pg_temp.kv('k_anchor2'));

-- ===== H03/H04 history rules (P2-4 gaps) =============================================================================
-- a client who only ever appeared as a PARTNER on someone else's attended lesson is an existing student
select pg_temp.setkv('pq', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('pp', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('p_old', pg_temp.mk_appt('sa', pg_temp.u('pq'), 'private_lesson', 'attended', interval '-30 days', interval '-31 days')::text);
update public.appointments set partner_client_id = pg_temp.u('pp') where id = pg_temp.u('p_old');
select pg_temp.setkv('p_new', pg_temp.mk_appt('sa', pg_temp.u('pp'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('h3_ev', pg_temp.ev('sa', pg_temp.u('pp'), pg_temp.u('p_new')));
select pg_temp.setkv('h3', coalesce(pg_temp.ens('sa', pg_temp.u('pp'), pg_temp.u('p_new')), 'NULL'));
-- a cancelled earlier appointment never counts; a no_show earlier appointment does
select pg_temp.setkv('xc1', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('xc2', pg_temp.mk_client('sa')::text);
select pg_temp.mk_appt('sa', pg_temp.u('xc1'), 'private_lesson', 'cancelled', interval '-30 days', interval '-31 days');
select pg_temp.mk_appt('sa', pg_temp.u('xc2'), 'private_lesson', 'no_show', interval '-30 days', interval '-31 days');
select pg_temp.setkv('x1', pg_temp.mk_appt('sa', pg_temp.u('xc1'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('x2', pg_temp.mk_appt('sa', pg_temp.u('xc2'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('h4a_ev', pg_temp.ev('sa', pg_temp.u('xc1'), pg_temp.u('x1')));
select pg_temp.setkv('h4a', coalesce(pg_temp.ens('sa', pg_temp.u('xc1'), pg_temp.u('x1')), 'NULL'));
select pg_temp.setkv('h4b_ev', pg_temp.ev('sa', pg_temp.u('xc2'), pg_temp.u('x2')));
select pg_temp.setkv('h4b', coalesce(pg_temp.ens('sa', pg_temp.u('xc2'), pg_temp.u('x2')), 'NULL'));
select pg_temp.chk('H03 a client who was only the PARTNER on another client''s attended lesson is an existing student: no request',
  pg_temp.kv('h3_ev') = 'existing_student' and pg_temp.kv('h3') = 'NULL' and pg_temp.reqs(pg_temp.u('pp')) = 0, pg_temp.kv('h3_ev'));
select pg_temp.chk('H04 a cancelled earlier appointment does not make a student existing (request created); a no_show earlier appointment does (none)',
  pg_temp.kv('h4a_ev') = 'would_create' and pg_temp.is_uuid(pg_temp.kv('h4a'))
  and pg_temp.kv('h4b_ev') = 'existing_student' and pg_temp.kv('h4b') = 'NULL' and pg_temp.reqs(pg_temp.u('xc2')) = 0,
  pg_temp.kv('h4a_ev') || ' / ' || pg_temp.kv('h4b_ev'));

-- ===== H05 exact boundaries: settle delay (10 minutes) and the enabled_at watermark (5 days before now in this fixture) ======
select pg_temp.setkv('bc1', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('bc2', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('bc3', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('bc4', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('b1', pg_temp.mk_appt('sa', pg_temp.u('bc1'), 'private_lesson', 'scheduled', interval '9 days', interval '-10 minutes')::text);
select pg_temp.setkv('b2', pg_temp.mk_appt('sa', pg_temp.u('bc2'), 'private_lesson', 'scheduled', interval '9 days', interval '-9 minutes -59 seconds')::text);
select pg_temp.setkv('b3', pg_temp.mk_appt('sa', pg_temp.u('bc3'), 'private_lesson', 'scheduled', interval '9 days', interval '-5 days')::text);
select pg_temp.setkv('b4', pg_temp.mk_appt('sa', pg_temp.u('bc4'), 'private_lesson', 'scheduled', interval '9 days', interval '-5 days -1 second')::text);
select pg_temp.setkv('b1_ev', pg_temp.ev('sa', pg_temp.u('bc1'), pg_temp.u('b1')));
select pg_temp.setkv('b2_ev', pg_temp.ev('sa', pg_temp.u('bc2'), pg_temp.u('b2')));
select pg_temp.setkv('b3_ev', pg_temp.ev('sa', pg_temp.u('bc3'), pg_temp.u('b3')));
select pg_temp.setkv('b4_ev', pg_temp.ev('sa', pg_temp.u('bc4'), pg_temp.u('b4')));
select pg_temp.setkv('b1', coalesce(pg_temp.ens('sa', pg_temp.u('bc1'), pg_temp.u('b1')), 'NULL'));
select pg_temp.setkv('b2', coalesce(pg_temp.ens('sa', pg_temp.u('bc2'), pg_temp.u('b2')), 'NULL'));
select pg_temp.setkv('b3', coalesce(pg_temp.ens('sa', pg_temp.u('bc3'), pg_temp.u('b3')), 'NULL'));
select pg_temp.setkv('b4', coalesce(pg_temp.ens('sa', pg_temp.u('bc4'), pg_temp.u('b4')), 'NULL'));
select pg_temp.chk('H05 exactly 10 minutes old is eligible, one second younger is settling; created exactly at enabled_at is eligible, one second earlier is before_enablement; the write path agrees at every edge',
  pg_temp.kv('b1_ev') = 'would_create' and pg_temp.is_uuid(pg_temp.kv('b1'))
  and pg_temp.kv('b2_ev') = 'settling' and pg_temp.kv('b2') = 'NULL'
  and pg_temp.kv('b3_ev') = 'would_create' and pg_temp.is_uuid(pg_temp.kv('b3'))
  and pg_temp.kv('b4_ev') = 'before_enablement' and pg_temp.kv('b4') = 'NULL',
  pg_temp.kv('b1_ev') || '/' || pg_temp.kv('b2_ev') || '/' || pg_temp.kv('b3_ev') || '/' || pg_temp.kv('b4_ev'));

-- ===== H06 re-intake: a completion below the floor, floor effective 2 days ago ======================================
select pg_temp.setkv('rc1', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('rc2', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('r_req1', gen_random_uuid()::text);
select pg_temp.setkv('r_req2', gen_random_uuid()::text);
set local session_replication_role = replica;
insert into public.intake_requests (id, studio_id, client_id, template_id, status, source) values
  (pg_temp.kv('r_req1')::uuid, pg_temp.u('sa'), pg_temp.u('rc1'), pg_temp.u('ta'), 'submitted', 'auto'),
  (pg_temp.kv('r_req2')::uuid, pg_temp.u('sa'), pg_temp.u('rc2'), pg_temp.u('ta'), 'submitted', 'auto');
insert into public.intake_completions (studio_id, request_id, client_id, template_id, template_version_id, version_number, student_response_id)
select pg_temp.u('sa'), pg_temp.kv(r)::uuid, pg_temp.u(c), pg_temp.u('ta'), gen_random_uuid(), 1, gen_random_uuid() from (values ('r_req1', 'rc1'), ('r_req2', 'rc2')) v(r, c);
update public.intake_templates set reintake_floor_version = 2, floor_effective_at = now() - interval '2 days' where id = pg_temp.u('ta');
set local session_replication_role = origin;
select pg_temp.setkv('ra1', pg_temp.mk_appt('sa', pg_temp.u('rc1'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('ra2', pg_temp.mk_appt('sa', pg_temp.u('rc2'), 'private_lesson', 'scheduled', interval '9 days', interval '-3 days')::text);
select pg_temp.setkv('h6a_ev', pg_temp.ev('sa', pg_temp.u('rc1'), pg_temp.u('ra1')));
select pg_temp.setkv('h6b_ev', pg_temp.ev('sa', pg_temp.u('rc2'), pg_temp.u('ra2')));
select pg_temp.setkv('h6a', coalesce(pg_temp.ens('sa', pg_temp.u('rc1'), pg_temp.u('ra1')), 'NULL'));
select pg_temp.setkv('h6b', coalesce(pg_temp.ens('sa', pg_temp.u('rc2'), pg_temp.u('ra2')), 'NULL'));
select pg_temp.chk('H06 re-intake: a booking made after the floor became effective gets a new request (would_create_reintake); one made before it does not (predates_reintake_floor)',
  pg_temp.kv('h6a_ev') = 'would_create_reintake' and pg_temp.is_uuid(pg_temp.kv('h6a'))
  and pg_temp.kv('h6b_ev') = 'predates_reintake_floor' and pg_temp.kv('h6b') = 'NULL' and pg_temp.reqs(pg_temp.u('rc2')) = 1,
  pg_temp.kv('h6a_ev') || ' / ' || pg_temp.kv('h6b_ev'));


-- ===== H08 P2-A: the anchor leaves an anchor appointment that is no longer live =====================================
create or replace function pg_temp.anchor_case(p_status text) returns text language plpgsql as $f$
declare c uuid := pg_temp.mk_client('sa'); a1 uuid; a2 uuid; r text;
begin
  a1 := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '5 days', interval '-1 hour');
  a2 := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '12 days', interval '-1 hour');
  r := pg_temp.ens('sa', c, a1);
  perform pg_temp.ens('sa', c, a2);
  update public.appointments set status = p_status::public.appointment_status where id = a1;
  perform pg_temp.ens('sa', c, a2);
  return (select (anchor_appointment_id = a2)::text from public.intake_requests where id = r::uuid);
end $f$;
select pg_temp.setkv('h8_cancelled', pg_temp.anchor_case('cancelled'));
select pg_temp.setkv('h8_no_show', pg_temp.anchor_case('no_show'));
select pg_temp.setkv('h8_attended', pg_temp.anchor_case('attended'));
select pg_temp.chk('H08 when the anchor appointment is cancelled, no-show or attended, the next recompute moves the anchor to the earliest remaining live appointment',
  pg_temp.kv('h8_cancelled') = 'true' and pg_temp.kv('h8_no_show') = 'true' and pg_temp.kv('h8_attended') = 'true',
  pg_temp.kv('h8_cancelled') || '/' || pg_temp.kv('h8_no_show') || '/' || pg_temp.kv('h8_attended'));

-- ===== H09 tie on starts_at: the lower appointment id wins, deterministically ========================================
select pg_temp.setkv('tc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('t1', pg_temp.mk_appt('sa', pg_temp.u('tc'), 'private_lesson', 'scheduled', interval '8 days', interval '-1 hour')::text);
select pg_temp.setkv('t2', pg_temp.mk_appt('sa', pg_temp.u('tc'), 'private_lesson', 'scheduled', interval '8 days', interval '-1 hour')::text);
select pg_temp.ens('sa', pg_temp.u('tc'), pg_temp.u('t1'));
select pg_temp.ens('sa', pg_temp.u('tc'), pg_temp.u('t2'));
select pg_temp.ens('sa', pg_temp.u('tc'), pg_temp.u('t1'));
select pg_temp.ens('sa', pg_temp.u('tc'), pg_temp.u('t2'));
select pg_temp.chk('H09 two attached appointments with the same start: the anchor is the one with the lower id, whichever was attached first',
  (select count(*) = 2 from public.intake_request_appointments ra join public.intake_requests q on q.id = ra.request_id where q.client_id = pg_temp.u('tc'))
  and (select anchor_appointment_id = least(pg_temp.u('t1'), pg_temp.u('t2')) from public.intake_requests where client_id = pg_temp.u('tc')));

-- ===== H10 the manual (staff) path recomputes too =====================================================================
select pg_temp.setkv('mc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('m_late', pg_temp.mk_appt('sa', pg_temp.u('mc'), 'private_lesson', 'scheduled', interval '12 days', interval '-1 hour')::text);
select pg_temp.setkv('m_req', pg_temp.ens('sa', pg_temp.u('mc'), pg_temp.u('m_late')));
select pg_temp.setkv('m_early', pg_temp.mk_appt('sa', pg_temp.u('mc'), 'private_lesson', 'scheduled', interval '5 days', interval '-1 hour')::text);
select pg_temp.setkv('m_manual', pg_temp.ens('sa', pg_temp.u('mc'), pg_temp.u('m_early'), 'manual'));
select pg_temp.chk('H10 a staff-initiated attach of an earlier appointment moves the anchor too, on the same open request',
  pg_temp.kv('m_manual') = pg_temp.kv('m_req')
  and (select anchor_appointment_id = pg_temp.u('m_early') from public.intake_requests where id = pg_temp.kv('m_req')::uuid));

-- ===== H11 an appointment reassigned to another client no longer anchors =============================================
select pg_temp.setkv('rcl', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('rother', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('ra_1', pg_temp.mk_appt('sa', pg_temp.u('rcl'), 'private_lesson', 'scheduled', interval '5 days', interval '-1 hour')::text);
select pg_temp.setkv('ra_2', pg_temp.mk_appt('sa', pg_temp.u('rcl'), 'private_lesson', 'scheduled', interval '12 days', interval '-1 hour')::text);
select pg_temp.setkv('r_req', pg_temp.ens('sa', pg_temp.u('rcl'), pg_temp.u('ra_1')));
select pg_temp.ens('sa', pg_temp.u('rcl'), pg_temp.u('ra_2'));
update public.appointments set client_id = pg_temp.u('rother') where id = pg_temp.u('ra_1');
select pg_temp.ens('sa', pg_temp.u('rcl'), pg_temp.u('ra_2'));
select pg_temp.chk('H11 an attached appointment that was reassigned to a different client no longer anchors the request',
  (select anchor_appointment_id = pg_temp.u('ra_2') from public.intake_requests where id = pg_temp.kv('r_req')::uuid));

-- ===== H12 an ended-but-unmarked lesson never takes the anchor; an ongoing one may =====================================
select pg_temp.setkv('pcl', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('p_future', pg_temp.mk_appt('sa', pg_temp.u('pcl'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('p_req', pg_temp.ens('sa', pg_temp.u('pcl'), pg_temp.u('p_future')));
select pg_temp.setkv('p_past', pg_temp.mk_appt('sa', pg_temp.u('pcl'), 'private_lesson', 'scheduled', interval '-3 hours', interval '-1 day')::text);
insert into public.intake_request_appointments (studio_id, request_id, appointment_id, attached_by)
values (pg_temp.u('sa'), pg_temp.kv('p_req')::uuid, pg_temp.u('p_past'), 'staff');
select pg_temp.ens('sa', pg_temp.u('pcl'), pg_temp.u('p_future'));
select pg_temp.chk('H12a an attached lesson that ended hours ago but was never marked does NOT take the anchor',
  (select anchor_appointment_id = pg_temp.u('p_future') from public.intake_requests where id = pg_temp.kv('p_req')::uuid));
select pg_temp.setkv('p_now', pg_temp.mk_appt('sa', pg_temp.u('pcl'), 'private_lesson', 'scheduled', interval '-30 minutes', interval '-1 day')::text);
insert into public.intake_request_appointments (studio_id, request_id, appointment_id, attached_by)
values (pg_temp.u('sa'), pg_temp.kv('p_req')::uuid, pg_temp.u('p_now'), 'staff');
select pg_temp.ens('sa', pg_temp.u('pcl'), pg_temp.u('p_future'));
select pg_temp.chk('H12b a lesson that is under way (started, not ended) is live and does take the anchor',
  (select anchor_appointment_id = pg_temp.u('p_now') from public.intake_requests where id = pg_temp.kv('p_req')::uuid));

-- ===== H13 no write when the anchor is unchanged ======================================================================
select pg_temp.setkv('nwc', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('nwa', pg_temp.mk_appt('sa', pg_temp.u('nwc'), 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')::text);
select pg_temp.setkv('nw_req', pg_temp.ens('sa', pg_temp.u('nwc'), pg_temp.u('nwa')));
select pg_temp.setkv('nw_ctid1', (select ctid::text from public.intake_requests where id = pg_temp.kv('nw_req')::uuid));
select pg_temp.ens('sa', pg_temp.u('nwc'), pg_temp.u('nwa'));
select pg_temp.setkv('nw_ctid2', (select ctid::text from public.intake_requests where id = pg_temp.kv('nw_req')::uuid));
select pg_temp.setkv('nw_early', pg_temp.mk_appt('sa', pg_temp.u('nwc'), 'private_lesson', 'scheduled', interval '4 days', interval '-1 hour')::text);
select pg_temp.ens('sa', pg_temp.u('nwc'), pg_temp.u('nw_early'));
select pg_temp.setkv('nw_ctid3', (select ctid::text from public.intake_requests where id = pg_temp.kv('nw_req')::uuid));
select pg_temp.chk('H13 repeating a call with an unchanged anchor does not rewrite the request row (same tuple); a real change does',
  pg_temp.kv('nw_ctid1') = pg_temp.kv('nw_ctid2') and pg_temp.kv('nw_ctid2') <> pg_temp.kv('nw_ctid3'),
  pg_temp.kv('nw_ctid1') || ' / ' || pg_temp.kv('nw_ctid2') || ' / ' || pg_temp.kv('nw_ctid3'));

-- ===== H14 draft retention: the anchor matters only until the first draft save ========================================
select pg_temp.setkv('dcl', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('d_late', pg_temp.mk_appt('sa', pg_temp.u('dcl'), 'private_lesson', 'scheduled', interval '12 days', interval '-1 hour')::text);
select pg_temp.setkv('d_req', pg_temp.ens('sa', pg_temp.u('dcl'), pg_temp.u('d_late')));
select pg_temp.setkv('d_early', pg_temp.mk_appt('sa', pg_temp.u('dcl'), 'private_lesson', 'scheduled', interval '5 days', interval '-1 hour')::text);
select pg_temp.setkv('d_null_before', (select (draft_anchor_appointment_id is null)::text from public.intake_requests where id = pg_temp.kv('d_req')::uuid));
select intake_private.compute_draft_retention(pg_temp.kv('d_req')::uuid);
select pg_temp.setkv('d_snap', (select draft_anchor_appointment_id::text || '|' || draft_max_at::text from public.intake_requests where id = pg_temp.kv('d_req')::uuid));
select pg_temp.ens('sa', pg_temp.u('dcl'), pg_temp.u('d_early'));
select pg_temp.chk('H14 before the first draft save draft_anchor is NULL; the first save freezes the then-current anchor and draft_max_at; a later anchor move changes neither',
  pg_temp.kv('d_null_before') = 'true'
  and split_part(pg_temp.kv('d_snap'), '|', 1) = pg_temp.kv('d_late')
  and (select anchor_appointment_id = pg_temp.u('d_early')
              and draft_anchor_appointment_id = pg_temp.u('d_late')
              and draft_anchor_appointment_id::text || '|' || draft_max_at::text = pg_temp.kv('d_snap')
       from public.intake_requests where id = pg_temp.kv('d_req')::uuid));

-- ===== H07 side effects and catalog ===================================================================================
select pg_temp.chk('H07a nothing was queued for delivery; the body carries only the m11 marker; assert_catalog passes',
  (select count(*) = 0 from public.outbound_deliveries where template_key like 'intake%')
  and (select position('nsi-body:m11' in prosrc) > 0 and position('nsi-body:m10' in prosrc) = 0 and position('nsi-body:m8' in prosrc) = 0
       from pg_proc where proname = 'intake_ensure_request' and pronamespace = 'public'::regnamespace)
  and (select position('nsi-body:m11' in prosrc) > 0 and position('nsi-body:m8' in prosrc) = 0
       from pg_proc where proname = 'evaluate_appointment_eligibility' and pronargs = 5)
  and (select position('nsi-body:m11' in prosrc) > 0 and position('nsi-body:m8' in prosrc) = 0
       from pg_proc where proname = 'intake_reconcile_preview' and pronamespace = 'public'::regnamespace)
  and pg_temp.try('select intake_private.assert_catalog()') = 'ok');
select pg_temp.chk('H07b execute is still service_role only on ensure_request; the evaluator is still not executable by any API role',
  has_function_privilege('service_role', 'public.intake_ensure_request(uuid,uuid,uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.intake_ensure_request(uuid,uuid,uuid,text)', 'execute')
  and not has_function_privilege('anon', 'public.intake_ensure_request(uuid,uuid,uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'intake_private.evaluate_appointment_eligibility(uuid,uuid,uuid,timestamptz,timestamptz)', 'execute')
  and not has_function_privilege('service_role', 'intake_private.evaluate_appointment_eligibility(uuid,uuid,uuid,timestamptz,timestamptz)', 'execute'));

-- ===== result ======================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I2 M11 SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I2 M11 SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

-- NSI I3-2 (M16a) boundary tests: staff attestation of a guardian, evidence-based respondent guard, erase of the new table. Valid on M16a.
-- Run through run_i2_m7_m9_local.sh (prepends nsi_i2_fixtures_local.sql). Every fixture lives inside this rolled-back transaction.

select pg_temp.fx_grant('sa', 'config_preview');
select pg_temp.fx_grant('sa', 'live_collection');
insert into public.intake_settings (studio_id, enabled, enabled_at, default_template_id)
values (pg_temp.u('sa'), true, now() - interval '5 days', pg_temp.u('ta')), (pg_temp.u('sb'), true, now() - interval '5 days', pg_temp.u('tb'));

-- gate control (the shipped policy is dark; tests open it inside this transaction only)
create or replace function pg_temp.set_gate(p_open boolean) returns void language plpgsql as $f$
begin
  if p_open then
    execute $q$create or replace function public.intake_platform_policy()
      returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
        post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
        audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
      language sql stable set search_path = pg_catalog, pg_temp
      as $$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text $$$q$;
  else
    execute $q$create or replace function public.intake_platform_policy()
      returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
        post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
        audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
      language sql stable set search_path = pg_catalog, pg_temp
      as $$ select null::int, null::int, null::int, null::int, null::int, null::int, null::int, null::int, null::int, null::int, null::text $$$q$;
  end if;
end $f$;
select pg_temp.set_gate(true);

create or replace function pg_temp.owner_a(p_sql text) returns text language sql as $$ select pg_temp.run_as('authenticated', pg_temp.u('owner_a'), p_sql) $$;
create or replace function pg_temp.ens(p_client uuid, p_appt uuid) returns text language sql as $$
  select pg_temp.val_as('service_role', null, format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), p_client, p_appt)) $$;
create or replace function pg_temp.hx(p_s text) returns text language sql as $$ select encode(sha256(convert_to(p_s, 'UTF8')), 'hex') $$;
create or replace function pg_temp.is_uuid(p text) returns boolean language sql as $$ select p ~ '^[0-9a-f-]{36}$' $$;
select pg_temp.owner_a(format('select public.intake_set_service_type(%L, %L, true)', pg_temp.kv('sa'), 'private_lesson'));

create or replace function pg_temp.issue_as(p_user text, p_req uuid, p_inv uuid, p_hash text, p_exp text default '7 days') returns text language sql as $$
  select pg_temp.val_as('authenticated', pg_temp.u(p_user), format('select public.intake_issue_invitation(%L, %L, %L, %s, %L, decode(%L, ''hex''), decode(%L, ''hex''), now() + %L::interval)',
    pg_temp.kv('sa'), p_req, p_inv, (select coalesce(max(generation), 0) + 1 from public.intake_invitations where request_id = p_req and audience = 'student'), 'kid00001', repeat('ab', 16), p_hash, p_exp)) $$;
create or replace function pg_temp.fresh(p_issue boolean default true) returns text language plpgsql as $f$
declare c uuid; a uuid; r text; inv uuid := gen_random_uuid(); h text;
begin
  c := pg_temp.mk_client('sa');
  a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  r := pg_temp.ens(c, a);
  h := pg_temp.hx(inv::text);
  if p_issue then perform pg_temp.issue_as('owner_a', r::uuid, inv, h); end if;
  return r || '|' || inv || '|' || h || '|' || c || '|' || a;
end $f$;
create or replace function pg_temp.part(p text, n int) returns text language sql as $$ select split_part(p, '|', n) $$;
create or replace function pg_temp.exch(p_hash text, p_sess text, p_idle int default 1800, p_abs int default 14400) returns text language sql as $$
  select coalesce(pg_temp.val_as('service_role', null, format('select session_id::text from public.intake_exchange_invitation(decode(%L, ''hex''), decode(%L, ''hex''), %s, %s)',
    p_hash, pg_temp.hx(p_sess), p_idle, p_abs)), 'NONE') $$;
create or replace function pg_temp.ctx(p_sess text) returns text language sql as $$
  select coalesce(pg_temp.val_as('service_role', null, format('select request_id::text from public.intake_session_context(decode(%L, ''hex''))', pg_temp.hx(p_sess))), 'NONE') $$;
-- session established for a fresh issued request: returns 'req|inv|hash|client|appt|sessiontoken'
create or replace function pg_temp.live() returns text language plpgsql as $f$
declare f text := pg_temp.fresh(true); s text := 'sess-' || gen_random_uuid()::text;
begin
  perform pg_temp.exch(pg_temp.part(f, 3), s);
  return f || '|' || s;
end $f$;



-- ===== M16a helpers ===================================================================================================
-- a request with a guardian respondent (declared_unverified), inserted as the migration owner (the app path is intake_save_draft)
create or replace function pg_temp.mkg(p_role text default 'guardian', p_assurance text default 'declared_unverified') returns text language plpgsql as $f$
declare f text := pg_temp.fresh(false); v_p uuid := gen_random_uuid();
begin
  insert into public.intake_respondents (id, studio_id, request_id, client_id, role, display_name, declared_relationship, assurance)
  values (v_p, pg_temp.u('sa'), pg_temp.part(f, 1)::uuid, pg_temp.part(f, 4)::uuid, p_role, 'Synthetic G', case when p_role = 'guardian' then 'parent' end, p_assurance);
  return f || '|' || v_p;     -- req | inv | hash | client | appt | respondent
end $f$;
create or replace function pg_temp.att(p_user text, p_g text, p_method text default 'in_person', p_rel text default 'parent', p_reason text default 'seen in the studio') returns text language sql as $$
  select pg_temp.val_as('authenticated', pg_temp.u(p_user), format('select public.intake_attest_guardian(%L, %L, %L, %L, %L, %L)',
    pg_temp.kv('sa'), pg_temp.part(p_g, 1), pg_temp.part(p_g, 6), p_method, p_rel, p_reason)) $$;
create or replace function pg_temp.assur(p_g text) returns text language sql as $$ select assurance from public.intake_respondents where id = pg_temp.part(p_g, 6)::uuid $$;

-- ===== A01 role matrix =================================================================================================
select pg_temp.setkv('g1', pg_temp.mkg()); select pg_temp.setkv('g2', pg_temp.mkg()); select pg_temp.setkv('g3', pg_temp.mkg()); select pg_temp.setkv('g4', pg_temp.mkg());
select pg_temp.setkv('a1_owner', pg_temp.att('owner_a', pg_temp.kv('g1')));
select pg_temp.setkv('a1_admin', pg_temp.att('admin_a', pg_temp.kv('g2')));
select pg_temp.setkv('a1_fd', pg_temp.att('fd_a', pg_temp.kv('g3')));
select pg_temp.setkv('a1_instr', pg_temp.att('instr_a', pg_temp.kv('g4')));
select pg_temp.setkv('a1_plain', pg_temp.att('plain_a', pg_temp.kv('g4')));
select pg_temp.setkv('a1_nobody', pg_temp.att('nobody', pg_temp.kv('g4')));
select pg_temp.setkv('a1_other', pg_temp.att('owner_b', pg_temp.kv('g4')));
select pg_temp.chk('A01 owner, admin and front desk may attest; instructor, plain member, outsider and another studio''s owner are refused (42501) and nothing is written',
  pg_temp.kv('a1_owner') = 'attested' and pg_temp.kv('a1_admin') = 'attested' and pg_temp.kv('a1_fd') = 'attested'
  and pg_temp.kv('a1_instr') like 'ERR 42501%' and pg_temp.kv('a1_plain') like 'ERR 42501%' and pg_temp.kv('a1_nobody') like 'ERR 42501%' and pg_temp.kv('a1_other') like 'ERR 42501%'
  and pg_temp.assur(pg_temp.kv('g4')) = 'declared_unverified'
  and (select count(*) = 3 from public.intake_guardian_attestations),
  pg_temp.kv('a1_owner') || ' ' || pg_temp.kv('a1_instr') || ' ' || pg_temp.kv('a1_other'));

-- ===== A02 validation and outcome words ================================================================================
select pg_temp.setkv('g5', pg_temp.mkg());
select pg_temp.setkv('g_student', pg_temp.mkg('student'));
select pg_temp.setkv('g_sup', pg_temp.mkg());
update public.intake_respondents set superseded_at = now() where id = pg_temp.part(pg_temp.kv('g_sup'), 6)::uuid;
select pg_temp.setkv('g_cx', pg_temp.mkg());
update public.intake_requests set status = 'cancelled_by_staff' where id = pg_temp.part(pg_temp.kv('g_cx'), 1)::uuid;
select pg_temp.setkv('a2_method', pg_temp.att('owner_a', pg_temp.kv('g5'), 'carrier_pigeon'));
select pg_temp.setkv('a2_rel', pg_temp.att('owner_a', pg_temp.kv('g5'), 'in_person', 'cousin'));
select pg_temp.setkv('a2_reason', pg_temp.att('owner_a', pg_temp.kv('g5'), 'in_person', 'parent', '   '));
select pg_temp.setkv('a2_unknown', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_attest_guardian(%L, %L, %L, ''in_person'', ''parent'', ''x'')', pg_temp.kv('sa'), gen_random_uuid(), gen_random_uuid())));
select pg_temp.setkv('a2_student', pg_temp.att('owner_a', pg_temp.kv('g_student')));
select pg_temp.setkv('a2_sup', pg_temp.att('owner_a', pg_temp.kv('g_sup')));
select pg_temp.setkv('a2_cx', pg_temp.att('owner_a', pg_temp.kv('g_cx')));
select pg_temp.setkv('a2_wrong', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_attest_guardian(%L, %L, %L, ''in_person'', ''parent'', ''x'')', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('g5'), 1), gen_random_uuid())));
select pg_temp.setkv('a2_again', pg_temp.att('owner_a', pg_temp.kv('g1')));
select pg_temp.set_gate(false);
select pg_temp.setkv('a2_gate', pg_temp.att('owner_a', pg_temp.kv('g5')));
select pg_temp.set_gate(true);
select pg_temp.chk('A02 a bad method, relationship or empty reason is refused (22023); an unknown request is refused (42501); a student respondent, a superseded respondent and an unknown respondent give no_respondent; a cancelled request gives not_open; a second attestation gives already_done; Gate A closed gives gate_closed; none of these writes anything',
  pg_temp.kv('a2_method') like 'ERR 22023%' and pg_temp.kv('a2_rel') like 'ERR 22023%' and pg_temp.kv('a2_reason') like 'ERR 22023%' and pg_temp.kv('a2_unknown') like 'ERR 42501%'
  and pg_temp.kv('a2_student') = 'no_respondent' and pg_temp.kv('a2_sup') = 'no_respondent' and pg_temp.kv('a2_wrong') = 'no_respondent'
  and pg_temp.kv('a2_cx') = 'not_open' and pg_temp.kv('a2_again') = 'already_done' and pg_temp.kv('a2_gate') = 'gate_closed'
  and pg_temp.assur(pg_temp.kv('g5')) = 'declared_unverified' and (select count(*) = 3 from public.intake_guardian_attestations),
  pg_temp.kv('a2_method') || ' | ' || pg_temp.kv('a2_student') || ' | ' || pg_temp.kv('a2_cx') || ' | ' || pg_temp.kv('a2_again') || ' | ' || pg_temp.kv('a2_gate'));

-- ===== A03 effects, provenance, audit ====================================================================================
select pg_temp.chk('A03 an attestation stores method, relationship word, reason and the staff user (no name, no address column); the respondent becomes staff_attested; the audit row carries client_ref, request_ref, the method and nothing personal',
  exists (select 1 from public.intake_guardian_attestations a where a.respondent_id = pg_temp.part(pg_temp.kv('g1'), 6)::uuid and a.method = 'in_person' and a.relationship = 'parent'
            and a.attested_by = pg_temp.u('owner_a') and a.client_id = pg_temp.part(pg_temp.kv('g1'), 4)::uuid and a.reason = 'seen in the studio')
  and pg_temp.assur(pg_temp.kv('g1')) = 'staff_attested'
  and (select assurance_at > now() - interval '1 minute' from public.intake_respondents where id = pg_temp.part(pg_temp.kv('g1'), 6)::uuid)
  and exists (select 1 from public.intake_audit_events e where e.event_type = 'guardian_attested' and e.actor_type = 'staff' and e.actor_user_id = pg_temp.u('owner_a')
              and e.request_ref = pg_temp.part(pg_temp.kv('g1'), 1)::uuid and e.client_ref = pg_temp.part(pg_temp.kv('g1'), 4)::uuid
              and e.object_type = 'intake_respondent' and e.object_ref = pg_temp.part(pg_temp.kv('g1'), 6)::uuid and e.metadata = '{"method": "in_person"}'::jsonb and e.retention_state = 'scheduled')
  and (select array_agg(column_name::text order by column_name) = array['attested_at', 'attested_by', 'client_id', 'id', 'method', 'reason', 'relationship', 'request_id', 'respondent_id', 'studio_id']
         from information_schema.columns where table_schema = 'public' and table_name = 'intake_guardian_attestations'));

-- ===== A04 the evidence-based respondent guard ============================================================================
select pg_temp.setkv('g6', pg_temp.mkg()); select pg_temp.setkv('g7', pg_temp.mkg());
select pg_temp.setkv('a4_noevid', pg_temp.try(format('update public.intake_respondents set assurance = ''staff_attested'', assurance_at = now() where id = %L', pg_temp.part(pg_temp.kv('g6'), 6))));
select pg_temp.setkv('a4_email', pg_temp.try(format('update public.intake_respondents set assurance = ''email_code_verified'', assurance_at = now() where id = %L', pg_temp.part(pg_temp.kv('g6'), 6))));
select pg_temp.setkv('a4_link', pg_temp.try(format('update public.intake_respondents set assurance = ''link_verified'' where id = %L', pg_temp.part(pg_temp.kv('g6'), 6))));
select pg_temp.setkv('a4_at', pg_temp.try(format('update public.intake_respondents set assurance_at = now() + interval ''1 day'' where id = %L', pg_temp.part(pg_temp.kv('g6'), 6))));
select pg_temp.setkv('a4_name', pg_temp.try(format('update public.intake_respondents set display_name = ''Other'' where id = %L', pg_temp.part(pg_temp.kv('g6'), 6))));
insert into public.intake_guardian_attestations (studio_id, request_id, client_id, respondent_id, method, relationship, reason, attested_by)
  values (pg_temp.u('sa'), pg_temp.part(pg_temp.kv('g7'), 1)::uuid, pg_temp.part(pg_temp.kv('g7'), 4)::uuid, pg_temp.part(pg_temp.kv('g7'), 6)::uuid, 'phone_verified', 'parent', 'fixture', pg_temp.u('owner_a'));
select pg_temp.setkv('a4_ok', pg_temp.try(format('update public.intake_respondents set assurance = ''staff_attested'', assurance_at = now() where id = %L', pg_temp.part(pg_temp.kv('g7'), 6))));
select pg_temp.setkv('a4_email_even', pg_temp.try(format('update public.intake_respondents set assurance = ''email_code_verified'' where id = %L and assurance = ''declared_unverified''', pg_temp.part(pg_temp.kv('g6'), 6))));
select pg_temp.chk('A04 a definer-level update without evidence is refused (staff_attested, email_code_verified, link_verified, assurance_at alone, other attribution); with an attestation row the declared_unverified to staff_attested change is allowed',
  pg_temp.kv('a4_noevid') like '42501%' and pg_temp.kv('a4_email') like '42501%' and pg_temp.kv('a4_link') like '42501%' and pg_temp.kv('a4_at') like '42501%' and pg_temp.kv('a4_name') like '42501%'
  and pg_temp.kv('a4_ok') = 'ok' and pg_temp.assur(pg_temp.kv('g7')) = 'staff_attested' and pg_temp.assur(pg_temp.kv('g6')) = 'declared_unverified' and pg_temp.kv('a4_email_even') like '42501%',
  pg_temp.kv('a4_noevid') || ' | ' || pg_temp.kv('a4_ok') || ' | ' || pg_temp.kv('a4_email_even'));

-- ===== A05 immutability and insert guard ====================================================================================
select pg_temp.setkv('a5_upd', pg_temp.try(format('update public.intake_guardian_attestations set reason = ''changed'' where respondent_id = %L', pg_temp.part(pg_temp.kv('g1'), 6))));
select pg_temp.setkv('a5_del', pg_temp.try(format('delete from public.intake_guardian_attestations where respondent_id = %L', pg_temp.part(pg_temp.kv('g1'), 6))));
select pg_temp.setkv('a5_student', pg_temp.try(format('insert into public.intake_guardian_attestations (studio_id, request_id, client_id, respondent_id, method, relationship, reason, attested_by) values (%L, %L, %L, %L, ''in_person'', ''parent'', ''x'', %L)',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('g_student'), 1), pg_temp.part(pg_temp.kv('g_student'), 4), pg_temp.part(pg_temp.kv('g_student'), 6), pg_temp.u('owner_a'))));
select pg_temp.setkv('a5_sup', pg_temp.try(format('insert into public.intake_guardian_attestations (studio_id, request_id, client_id, respondent_id, method, relationship, reason, attested_by) values (%L, %L, %L, %L, ''in_person'', ''parent'', ''x'', %L)',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('g_sup'), 1), pg_temp.part(pg_temp.kv('g_sup'), 4), pg_temp.part(pg_temp.kv('g_sup'), 6), pg_temp.u('owner_a'))));
select pg_temp.setkv('a5_xclient', pg_temp.try(format('insert into public.intake_guardian_attestations (studio_id, request_id, client_id, respondent_id, method, relationship, reason, attested_by) values (%L, %L, %L, %L, ''in_person'', ''parent'', ''x'', %L)',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('g5'), 1), pg_temp.part(pg_temp.kv('g4'), 4), pg_temp.part(pg_temp.kv('g5'), 6), pg_temp.u('owner_a'))));
select pg_temp.setkv('a5_dup', pg_temp.try(format('insert into public.intake_guardian_attestations (studio_id, request_id, client_id, respondent_id, method, relationship, reason, attested_by) values (%L, %L, %L, %L, ''in_person'', ''parent'', ''x'', %L)',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('g1'), 1), pg_temp.part(pg_temp.kv('g1'), 4), pg_temp.part(pg_temp.kv('g1'), 6), pg_temp.u('owner_a'))));
select pg_temp.chk('A05 an attestation cannot be updated, deleted outside the restricted role, or inserted for a student, a superseded or a foreign respondent, or twice',
  pg_temp.kv('a5_upd') like '42501%' and pg_temp.kv('a5_del') like '42501%' and pg_temp.kv('a5_student') like '42501%' and pg_temp.kv('a5_sup') like '42501%'
  and pg_temp.kv('a5_xclient') like '42501%' and pg_temp.kv('a5_dup') like '23505%',
  pg_temp.kv('a5_upd') || ' | ' || pg_temp.kv('a5_del') || ' | ' || pg_temp.kv('a5_student') || ' | ' || pg_temp.kv('a5_xclient') || ' | ' || pg_temp.kv('a5_dup'));

-- ===== A06 erase removes the attestation (no foreign-key failure); a hold keeps it =============================================
select pg_temp.setkv('a6_erase', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_erase_client(%L, %L, ''data_subject_request'')::text', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('g2'), 4))));
select pg_temp.setkv('g8', pg_temp.mkg());
select pg_temp.setkv('a6_att', pg_temp.att('owner_a', pg_temp.kv('g8')));
select pg_temp.setkv('a6_hold', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_create_legal_hold(%L, ''client'', %L, ''m16a'', ''m16a'', now() + interval ''30 days'')::text', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('g8'), 4))));
select pg_temp.setkv('a6_erase_held', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_erase_client(%L, %L, ''data_subject_request'')::text', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('g8'), 4))));
select pg_temp.chk('A06 erase of a client with an attestation succeeds and removes the attestation, the respondent and the request (counts include attestations); a client under a hold is not erased and keeps the attestation; the attestation audit rows survive erasure (append-only)',
  pg_temp.kv('a6_erase') like '%"outcome": "erased"%' and pg_temp.kv('a6_erase') like '%"attestations": 1%'
  and not exists (select 1 from public.intake_guardian_attestations where respondent_id = pg_temp.part(pg_temp.kv('g2'), 6)::uuid)
  and not exists (select 1 from public.intake_respondents where id = pg_temp.part(pg_temp.kv('g2'), 6)::uuid)
  and exists (select 1 from public.intake_audit_events where event_type = 'guardian_attested' and request_ref = pg_temp.part(pg_temp.kv('g2'), 1)::uuid)
  and pg_temp.kv('a6_att') = 'attested' and pg_temp.is_uuid(pg_temp.kv('a6_hold')) and pg_temp.kv('a6_erase_held') like '%legal_hold%'
  and exists (select 1 from public.intake_guardian_attestations where respondent_id = pg_temp.part(pg_temp.kv('g8'), 6)::uuid),
  pg_temp.kv('a6_erase') || ' | ' || pg_temp.kv('a6_erase_held'));

-- ===== A07 a submitted request whose guardian consent is outstanding may still be attested ======================================
select pg_temp.setkv('g9', pg_temp.mkg());
update public.intake_requests set status = 'invited' where id = pg_temp.part(pg_temp.kv('g9'), 1)::uuid;
update public.intake_requests set status = 'submitted' where id = pg_temp.part(pg_temp.kv('g9'), 1)::uuid;
insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold)
  values (pg_temp.u('sa'), pg_temp.part(pg_temp.kv('g9'), 1)::uuid, true, 'birthday', current_date, 18);
do $f$ declare q record; begin
  select * into q from public.intake_requests where id = pg_temp.part(pg_temp.kv('g9'), 1)::uuid;
  set local session_replication_role = replica;
  insert into public.intake_completions (studio_id, request_id, client_id, template_id, template_version_id, version_number, student_response_id)
  values (q.studio_id, q.id, q.client_id, q.template_id, gen_random_uuid(), 1, gen_random_uuid());
  set local session_replication_role = origin;
end $f$;
select pg_temp.setkv('a7_state', intake_private.fulfillment_state(pg_temp.part(pg_temp.kv('g9'), 1)::uuid));
select pg_temp.setkv('a7_att', pg_temp.att('owner_a', pg_temp.kv('g9')));
select pg_temp.chk('A07 a submitted request that still needs guardian consent can be attested', pg_temp.kv('a7_state') = 'guardian_consent_outstanding' and pg_temp.kv('a7_att') = 'attested', pg_temp.kv('a7_state') || ' ' || pg_temp.kv('a7_att'));

-- ===== A08 markers, ACLs, catalog ==========================================================================================
select pg_temp.chk('A08 every M16a body carries the m16a marker; the function inventory is 113; the table has no API privileges and the restricted role has only SELECT and DELETE; the new functions have the expected grants; the catalog self-check passes',
  (select count(*) = 6 and bool_and(position('nsi-body:m16a' in prosrc) > 0)
     from pg_proc where proname in ('respondents_guard', 'audit_write', 'erase_client_impl', 'attestations_insert_guard', 'attestations_update_guard', 'intake_attest_guardian'))
  and (select count(*) = 113 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
  and not has_table_privilege('anon', 'public.intake_guardian_attestations', 'select') and not has_table_privilege('authenticated', 'public.intake_guardian_attestations', 'select')
  and not has_table_privilege('service_role', 'public.intake_guardian_attestations', 'select') and not has_table_privilege('service_role', 'public.intake_guardian_attestations', 'insert')
  and has_table_privilege('intake_destructive', 'public.intake_guardian_attestations', 'select') and has_table_privilege('intake_destructive', 'public.intake_guardian_attestations', 'delete')
  and not has_table_privilege('intake_destructive', 'public.intake_guardian_attestations', 'insert') and not has_table_privilege('intake_destructive', 'public.intake_guardian_attestations', 'update')
  and has_function_privilege('authenticated', 'public.intake_attest_guardian(uuid,uuid,uuid,text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.intake_attest_guardian(uuid,uuid,uuid,text,text,text)', 'execute')
  and not has_function_privilege('service_role', 'public.intake_attest_guardian(uuid,uuid,uuid,text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'intake_private.attestations_insert_guard()', 'execute')
  and (select pg_get_userbyid(proowner) = 'intake_destructive' from pg_proc where proname = 'erase_client_impl')
  and (select count(*) = 5 from pg_trigger where tgrelid = 'public.intake_guardian_attestations'::regclass and not tgisinternal)
  and pg_temp.try('select intake_private.assert_catalog()') = 'ok');

-- ===== result =========================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I3-2 M16a SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I3-2 M16a SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

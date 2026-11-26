-- NSI I3-2 (M16b) boundary tests: two-party guardian invitation, recipient-bound email challenge, erase and purge. Valid on M16b.
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

-- ===== M16b helpers ===================================================================================================
create or replace function pg_temp.svc(p_sql text) returns text language sql as $$ select coalesce(pg_temp.val_as('service_role', null, p_sql), 'NULL') $$;
create or replace function pg_temp.own(p_sql text) returns void language plpgsql as $f$
begin
  set local session_replication_role = replica;
  execute p_sql;
  set local session_replication_role = origin;
end $f$;
create or replace function pg_temp.clear_limits() returns void language sql as $$ select pg_temp.own('delete from public.intake_rate_limits') $$;
create or replace function pg_temp.determine(p_req text, p_minor boolean, p_offset text default '0 seconds') returns void language sql as $$
  insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold, created_at)
  values (pg_temp.u('sa'), p_req::uuid, p_minor, 'birthday', current_date, 18, now() + p_offset::interval) $$;
-- an invited request of a minor: 'req|studentinv|studenthash|client|appt'
create or replace function pg_temp.minor(p_issue boolean default true) returns text language plpgsql as $f$
declare f text := pg_temp.fresh(p_issue);
begin
  perform pg_temp.determine(pg_temp.part(f, 1), true);
  return f;
end $f$;
create or replace function pg_temp.greq(p_user text, p_req text, p_hmac text, p_kid text default '1') returns text language sql as $$
  select pg_temp.val_as('authenticated', pg_temp.u(p_user), format('select public.intake_guardian_request_invitation(%L, %L, %L, %s::smallint)', pg_temp.kv('sa'), p_req, p_hmac, coalesce(p_kid, 'null'))) $$;
create or replace function pg_temp.fin(p_pending text, p_inv text, p_gen int, p_hash text, p_exp text default '7 days') returns text language sql as $$
  select pg_temp.svc(format('select public.intake_guardian_finalize_invitation(%L, %L, %s, %L, decode(%L, ''hex''), decode(%L, ''hex''), now() + %L::interval)',
    p_pending, p_inv, p_gen, 'kid00001', repeat('cd', 16), p_hash, p_exp)) $$;
create or replace function pg_temp.resp(p_req text, p_hmac text, p_kid int default 1, p_email text default 'guardian@nsi-m16b.invalid', p_assurance text default 'declared_unverified') returns text language plpgsql as $f$
declare v uuid := gen_random_uuid();
begin
  insert into public.intake_respondents (id, studio_id, request_id, client_id, role, display_name, email, email_hmac, email_hmac_kid, declared_relationship, assurance)
  select v, q.studio_id, q.id, q.client_id, 'guardian', 'Synthetic G', p_email, p_hmac, case when p_hmac is not null then p_kid end, 'parent', p_assurance
  from public.intake_requests q where q.id = p_req::uuid;
  return v::text;
end $f$;
-- full guardian path: 'req|studentinv|studenthash|client|appt|hmac|ginv|gsess|resp|pending|gtokenhash'
create or replace function pg_temp.gset(p_resp boolean default true) returns text language plpgsql as $f$
declare f text := pg_temp.minor(true); h text := 'hm-' || gen_random_uuid()::text; r text; pend text; inv uuid := gen_random_uuid(); th text; s text := 'gsess-' || gen_random_uuid()::text; p text := '-';
begin
  r := pg_temp.greq('owner_a', pg_temp.part(f, 1), h);
  pend := split_part(r, ':', 2);
  th := pg_temp.hx(inv::text);
  perform pg_temp.fin(pend, inv::text, split_part(r, ':', 3)::int, th);
  perform pg_temp.exch(th, s);
  if p_resp then p := pg_temp.resp(pg_temp.part(f, 1), h); end if;
  return f || '|' || h || '|' || inv || '|' || s || '|' || p || '|' || pend || '|' || th;
end $f$;
create or replace function pg_temp.iss(p_g text, p_ch uuid, p_code text, p_send text default null, p_kid int default 1, p_ip text default null, p_em text default null) returns text language sql as $$
  select pg_temp.svc(format('select public.intake_issue_email_challenge(decode(%L, ''hex''), %L, decode(%L, ''hex''), decode(%L, ''hex''), decode(%L, ''hex''), %L, %s::smallint)',
    pg_temp.hx(pg_temp.part(p_g, 8)), p_ch, pg_temp.hx(p_code), coalesce(p_ip, pg_temp.hx(gen_random_uuid()::text)),
    coalesce(p_em, pg_temp.hx(gen_random_uuid()::text)), coalesce(p_send, pg_temp.part(p_g, 6)), p_kid)) $$;
create or replace function pg_temp.ver(p_g text, p_ch uuid, p_code text) returns text language sql as $$
  select pg_temp.svc(format('select public.intake_verify_email_challenge(decode(%L, ''hex''), %L, decode(%L, ''hex''))',
    pg_temp.hx(pg_temp.part(p_g, 8)), p_ch, pg_temp.hx(p_code))) $$;
create or replace function pg_temp.tgt(p_g text) returns text language sql as $$
  select pg_temp.svc(format('select coalesce((select email || '':'' || email_hmac_kid::text from public.intake_guardian_challenge_target(decode(%L, ''hex''))), ''NONE'')',
    pg_temp.hx(pg_temp.part(p_g, 8)))) $$;
-- a challenge row written directly (owner, all guards on), then superseded unless p_open
create or replace function pg_temp.mkch(p_g text, p_age text, p_open boolean default false) returns uuid language plpgsql as $f$
declare v uuid := gen_random_uuid();
begin
  insert into public.intake_email_challenges (id, studio_id, request_id, client_id, respondent_id, invitation_id, email_hmac, email_hmac_kid, code_hash, expires_at, created_at)
  select v, q.studio_id, q.id, q.client_id, pg_temp.part(p_g, 9)::uuid, pg_temp.part(p_g, 7)::uuid, pg_temp.part(p_g, 6), 1,
         decode(pg_temp.hx('code'), 'hex'), now() + interval '10 minutes', now() - p_age::interval
  from public.intake_requests q where q.id = pg_temp.part(p_g, 1)::uuid;
  if not p_open then update public.intake_email_challenges set superseded_at = now() where id = v; end if;
  return v;
end $f$;
create or replace function pg_temp.chv(p_ch uuid, p_col text) returns text language plpgsql as $f$
declare v text; begin execute format('select coalesce(%I::text, ''null'') from public.intake_email_challenges where id = $1', p_col) into v using p_ch; return coalesce(v, 'gone'); end $f$;
create or replace function pg_temp.asr(p_resp text) returns text language sql as $$ select assurance from public.intake_respondents where id = p_resp::uuid $$;

-- ===== B01 role matrix on the staff request ============================================================================
select pg_temp.setkv('m1', pg_temp.minor()); select pg_temp.setkv('m2', pg_temp.minor()); select pg_temp.setkv('m3', pg_temp.minor()); select pg_temp.setkv('m4', pg_temp.minor());
select pg_temp.setkv('b1_owner', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('m1'), 1), 'h1'));
select pg_temp.setkv('b1_admin', pg_temp.greq('admin_a', pg_temp.part(pg_temp.kv('m2'), 1), 'h2'));
select pg_temp.setkv('b1_fd', pg_temp.greq('fd_a', pg_temp.part(pg_temp.kv('m3'), 1), 'h3'));
select pg_temp.setkv('b1_instr', pg_temp.greq('instr_a', pg_temp.part(pg_temp.kv('m4'), 1), 'h4'));
select pg_temp.setkv('b1_plain', pg_temp.greq('plain_a', pg_temp.part(pg_temp.kv('m4'), 1), 'h4'));
select pg_temp.setkv('b1_nobody', pg_temp.greq('nobody', pg_temp.part(pg_temp.kv('m4'), 1), 'h4'));
select pg_temp.setkv('b1_other', pg_temp.greq('owner_b', pg_temp.part(pg_temp.kv('m4'), 1), 'h4'));
select pg_temp.chk('B01 owner, admin and front desk may request a guardian invitation; instructor, plain member, outsider and another studio''s owner are refused (42501) and nothing is written',
  pg_temp.kv('b1_owner') like 'requested:%:1' and pg_temp.kv('b1_admin') like 'requested:%:1' and pg_temp.kv('b1_fd') like 'requested:%:1'
  and pg_temp.kv('b1_instr') like 'ERR 42501%' and pg_temp.kv('b1_plain') like 'ERR 42501%' and pg_temp.kv('b1_nobody') like 'ERR 42501%' and pg_temp.kv('b1_other') like 'ERR 42501%'
  and not exists (select 1 from public.intake_guardian_invitation_requests where request_id = pg_temp.part(pg_temp.kv('m4'), 1)::uuid),
  pg_temp.kv('b1_owner') || ' | ' || pg_temp.kv('b1_fd') || ' | ' || pg_temp.kv('b1_instr'));

-- ===== B02 request preconditions and outcome words =====================================================================
select pg_temp.setkv('p_pending', pg_temp.minor(false));
select pg_temp.setkv('p_nodet', pg_temp.fresh(true));
select pg_temp.setkv('p_adult', pg_temp.minor()); select pg_temp.determine(pg_temp.part(pg_temp.kv('p_adult'), 1), false, '1 second');
select pg_temp.setkv('p_link', pg_temp.minor());
select pg_temp.own(format('update public.intake_requests set guardian_recipient_link_id = %L, guardian_recipient_basis = ''staff_selected'' where id = %L', gen_random_uuid(), pg_temp.part(pg_temp.kv('p_link'), 1)));
select pg_temp.setkv('p_sub', pg_temp.minor()); select pg_temp.setkv('p_sub_r', pg_temp.resp(pg_temp.part(pg_temp.kv('p_sub'), 1), 'hs'));
select pg_temp.own(format('insert into public.intake_responses (studio_id, request_id, client_id, audience, respondent_id, template_version_id, status, answers, submitted_at) select studio_id, id, client_id, ''guardian'', %L, pinned_version_id, ''submitted'', ''{}''::jsonb, now() from public.intake_requests where id = %L', pg_temp.kv('p_sub_r'), pg_temp.part(pg_temp.kv('p_sub'), 1)));
select pg_temp.setkv('p_dead', pg_temp.minor()); update public.appointments set status = 'cancelled' where id = pg_temp.part(pg_temp.kv('p_dead'), 5)::uuid;
select pg_temp.setkv('p_bar', pg_temp.minor());
select pg_temp.own(format('insert into public.intake_audit_events (studio_id, event_type, actor_type, client_ref, retention_class, retention_state) values (%L, ''erasure_record'', ''platform_admin'', %L, ''erasure_record'', ''pending_policy'')', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('p_bar'), 4)));
select pg_temp.setkv('b2_pending', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('p_pending'), 1), 'h'));
select pg_temp.setkv('b2_nodet', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('p_nodet'), 1), 'h'));
select pg_temp.setkv('b2_adult', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('p_adult'), 1), 'h'));
select pg_temp.setkv('b2_link', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('p_link'), 1), 'h'));
select pg_temp.setkv('b2_sub', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('p_sub'), 1), 'h'));
select pg_temp.setkv('b2_dead', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('p_dead'), 1), 'h'));
select pg_temp.setkv('b2_bar', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('p_bar'), 1), 'h'));
select pg_temp.setkv('b2_nohmac', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('m4'), 1), ''));
select pg_temp.setkv('b2_nokid', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('m4'), 1), 'h', null));
select pg_temp.setkv('b2_long', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('m4'), 1), repeat('a', 129)));
select pg_temp.setkv('b2_unknown', pg_temp.greq('owner_a', gen_random_uuid()::text, 'h'));
select pg_temp.set_gate(false);
select pg_temp.setkv('b2_gate', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('m4'), 1), 'h'));
select pg_temp.set_gate(true);
select pg_temp.chk('B02 the request refuses with an outcome word and writes nothing: gate_closed, not_open (never invited), not_minor (none or latest adult), recipient_link_set, already_submitted, no_live_target, erasure_barrier; bad hash or key id 22023; unknown request 42501',
  pg_temp.kv('b2_pending') = 'not_open' and pg_temp.kv('b2_nodet') = 'not_minor' and pg_temp.kv('b2_adult') = 'not_minor' and pg_temp.kv('b2_link') = 'recipient_link_set'
  and pg_temp.kv('b2_sub') = 'already_submitted' and pg_temp.kv('b2_dead') = 'no_live_target' and pg_temp.kv('b2_bar') = 'erasure_barrier' and pg_temp.kv('b2_gate') = 'gate_closed'
  and pg_temp.kv('b2_nohmac') like 'ERR 22023%' and pg_temp.kv('b2_nokid') like 'ERR 22023%' and pg_temp.kv('b2_long') like 'ERR 22023%' and pg_temp.kv('b2_unknown') like 'ERR 42501%'
  and not exists (select 1 from public.intake_guardian_invitation_requests g where g.request_id in (
        select pg_temp.part(pg_temp.kv(k), 1)::uuid from unnest(array['p_pending', 'p_nodet', 'p_adult', 'p_link', 'p_sub', 'p_dead', 'p_bar', 'm4']) k)),
  concat_ws(' | ', pg_temp.kv('b2_pending'), pg_temp.kv('b2_nodet'), pg_temp.kv('b2_adult'), pg_temp.kv('b2_link'), pg_temp.kv('b2_sub'), pg_temp.kv('b2_dead'), pg_temp.kv('b2_bar'), pg_temp.kv('b2_gate'), pg_temp.kv('b2_nohmac')));

-- ===== B03 re-request effects ==========================================================================================
select pg_temp.clear_limits();
select pg_temp.setkv('g3', pg_temp.gset());
insert into public.intake_responses (studio_id, request_id, client_id, audience, respondent_id, template_version_id, answers)
  select q.studio_id, q.id, q.client_id, 'guardian', pg_temp.part(pg_temp.kv('g3'), 9)::uuid, q.pinned_version_id, '{}'::jsonb from public.intake_requests q where q.id = pg_temp.part(pg_temp.kv('g3'), 1)::uuid;
select pg_temp.setkv('c3', pg_temp.mkch(pg_temp.kv('g3'), '1 minute', true)::text);
select pg_temp.setkv('s3', 'stud-' || gen_random_uuid()::text); select pg_temp.exch(pg_temp.part(pg_temp.kv('g3'), 3), pg_temp.kv('s3'));
select pg_temp.setkv('b3_r2', pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('g3'), 1), 'h3new'));
select pg_temp.setkv('b3_old_ctx', pg_temp.ctx(pg_temp.part(pg_temp.kv('g3'), 8)));
select pg_temp.setkv('b3_stu_ctx', pg_temp.ctx(pg_temp.kv('s3')));
select pg_temp.setkv('b3_r3', pg_temp.greq('admin_a', pg_temp.part(pg_temp.kv('g3'), 1), 'h3newer'));
select pg_temp.chk('B03 a re-request stops the old guardian link at once (invitation resent, session, challenge, draft, respondent superseded), keeps one open pending row, returns the next generation, leaves the student link alone and audits the superseded respondent count',
  pg_temp.kv('b3_r2') like 'requested:%:2' and pg_temp.kv('b3_r3') like 'requested:%:2' and pg_temp.kv('b3_old_ctx') = 'NONE' and pg_temp.kv('b3_stu_ctx') = pg_temp.part(pg_temp.kv('g3'), 1)
  and (select revoked_reason = 'resent' from public.intake_invitations where id = pg_temp.part(pg_temp.kv('g3'), 7)::uuid)
  and (select bool_and(revoked_at is not null) from public.intake_sessions where invitation_id = pg_temp.part(pg_temp.kv('g3'), 7)::uuid)
  and (select revoked_at is null from public.intake_invitations where id = pg_temp.part(pg_temp.kv('g3'), 2)::uuid)
  and pg_temp.chv(pg_temp.kv('c3')::uuid, 'superseded_at') <> 'null'
  and (select bool_and(status = 'superseded') from public.intake_responses where request_id = pg_temp.part(pg_temp.kv('g3'), 1)::uuid and audience = 'guardian')
  and (select superseded_at is not null from public.intake_respondents where id = pg_temp.part(pg_temp.kv('g3'), 9)::uuid)
  and (select count(*) = 1 from public.intake_guardian_invitation_requests where request_id = pg_temp.part(pg_temp.kv('g3'), 1)::uuid and finalized_at is null and superseded_at is null)
  and (select superseded_at is not null from public.intake_guardian_invitation_requests where id = split_part(pg_temp.kv('b3_r2'), ':', 2)::uuid)
  and exists (select 1 from public.intake_audit_events e where e.event_type = 'guardian_invitation_requested' and e.object_ref = split_part(pg_temp.kv('b3_r2'), ':', 2)::uuid
        and e.actor_type = 'staff' and e.metadata = '{"audience": "guardian", "generation": 2, "count": 1}'::jsonb),
  pg_temp.kv('b3_r2') || ' ' || pg_temp.kv('b3_old_ctx') || ' ' || pg_temp.kv('b3_stu_ctx'));

-- ===== B04 finalize =====================================================================================================
select pg_temp.setkv('f1', pg_temp.minor()); select pg_temp.setkv('f1_p', split_part(pg_temp.greq('fd_a', pg_temp.part(pg_temp.kv('f1'), 1), 'hf1'), ':', 2));
select pg_temp.setkv('f1_inv', gen_random_uuid()::text);
select pg_temp.setkv('b4_gen', pg_temp.fin(pg_temp.kv('f1_p'), pg_temp.kv('f1_inv'), 2, pg_temp.hx('f1x')));
select pg_temp.setkv('b4_kid', pg_temp.svc(format('select public.intake_guardian_finalize_invitation(%L, %L, 1, ''bad'', decode(%L, ''hex''), decode(%L, ''hex''), now() + interval ''7 days'')', pg_temp.kv('f1_p'), gen_random_uuid(), repeat('cd', 16), pg_temp.hx('k'))));
select pg_temp.setkv('b4_exp', pg_temp.fin(pg_temp.kv('f1_p'), gen_random_uuid()::text, 1, pg_temp.hx('f1e'), '31 days'));
select pg_temp.set_gate(false);
select pg_temp.setkv('b4_gate', pg_temp.fin(pg_temp.kv('f1_p'), gen_random_uuid()::text, 1, pg_temp.hx('f1g')));
select pg_temp.set_gate(true);
select pg_temp.setkv('b4_ok', pg_temp.fin(pg_temp.kv('f1_p'), pg_temp.kv('f1_inv'), 1, pg_temp.hx('f1ok')));
select pg_temp.setkv('b4_again', pg_temp.fin(pg_temp.kv('f1_p'), gen_random_uuid()::text, 2, pg_temp.hx('f1again')));
select pg_temp.setkv('b4_unknown', pg_temp.fin(gen_random_uuid()::text, gen_random_uuid()::text, 1, pg_temp.hx('f1u')));
select pg_temp.chk('B04a finalize copies the recipient hash onto a two_party guardian invitation issued in the requester''s name, for the pinned version; the student invitation is untouched; wrong generation, key id or expiry raise 22023; gate_closed, already_finalized and invalid are outcome words',
  pg_temp.kv('b4_ok') = 'issued:1' and pg_temp.kv('b4_gen') like 'ERR 22023%' and pg_temp.kv('b4_kid') like 'ERR 22023%' and pg_temp.kv('b4_exp') like 'ERR 22023%'
  and pg_temp.kv('b4_gate') = 'gate_closed' and pg_temp.kv('b4_again') = 'already_finalized' and pg_temp.kv('b4_unknown') = 'invalid'
  and exists (select 1 from public.intake_invitations i join public.intake_requests q on q.id = i.request_id where i.id = pg_temp.kv('f1_inv')::uuid and i.audience = 'guardian' and i.generation = 1
        and i.issued_by = 'two_party' and i.issued_by_user = pg_temp.u('fd_a') and i.recipient_email_hmac = 'hf1' and i.recipient_email_hmac_kid = 1 and i.pinned_version_id = q.pinned_version_id)
  and (select finalized_invitation_id = pg_temp.kv('f1_inv')::uuid and finalized_at is not null and superseded_at is null from public.intake_guardian_invitation_requests where id = pg_temp.kv('f1_p')::uuid)
  and (select revoked_at is null from public.intake_invitations where id = pg_temp.part(pg_temp.kv('f1'), 2)::uuid)
  and exists (select 1 from public.intake_audit_events e where e.event_type = 'guardian_invitation_issued' and e.object_ref = pg_temp.kv('f1_inv')::uuid and e.actor_type = 'system' and e.metadata = '{"audience": "guardian", "generation": 1}'::jsonb),
  concat_ws(' | ', pg_temp.kv('b4_ok'), pg_temp.kv('b4_gen'), pg_temp.kv('b4_gate'), pg_temp.kv('b4_again'), pg_temp.kv('b4_unknown')));

create or replace function pg_temp.pend(p_tag text) returns text language plpgsql as $f$
declare f text := pg_temp.minor(); p text;
begin
  p := split_part(pg_temp.greq('owner_a', pg_temp.part(f, 1), 'hp-' || p_tag), ':', 2);
  return f || '|' || p;     -- req | sinv | shash | client | appt | pending
end $f$;
select pg_temp.setkv(k, pg_temp.pend(k)) from unnest(array['x_exp', 'x_sup', 'x_adult', 'x_closed', 'x_link', 'x_dead', 'x_sub', 'x_rev', 'x_late', 'x_between', 'x_bar']) k;
select pg_temp.own(format('update public.intake_guardian_invitation_requests set requested_at = now() - interval ''1 hour'', expires_at = now() - interval ''1 minute'' where id = %L', pg_temp.part(pg_temp.kv('x_exp'), 6)));
update public.intake_guardian_invitation_requests set superseded_at = now() where id = pg_temp.part(pg_temp.kv('x_sup'), 6)::uuid;
select pg_temp.determine(pg_temp.part(pg_temp.kv('x_adult'), 1), false, '1 second');
update public.intake_requests set status = 'cancelled_by_staff' where id = pg_temp.part(pg_temp.kv('x_closed'), 1)::uuid;
select pg_temp.own(format('update public.intake_requests set guardian_recipient_link_id = %L, guardian_recipient_basis = ''staff_selected'' where id = %L', gen_random_uuid(), pg_temp.part(pg_temp.kv('x_link'), 1)));
update public.appointments set status = 'cancelled' where id = pg_temp.part(pg_temp.kv('x_dead'), 5)::uuid;
select pg_temp.setkv('x_sub_r', pg_temp.resp(pg_temp.part(pg_temp.kv('x_sub'), 1), 'hs'));
select pg_temp.own(format('insert into public.intake_responses (studio_id, request_id, client_id, audience, respondent_id, template_version_id, status, answers, submitted_at) select studio_id, id, client_id, ''guardian'', %L, pinned_version_id, ''submitted'', ''{}''::jsonb, now() from public.intake_requests where id = %L', pg_temp.kv('x_sub_r'), pg_temp.part(pg_temp.kv('x_sub'), 1)));
-- staff revoke-all through the RPC supersedes the open request
select pg_temp.setkv('b4_revn', pg_temp.owner_a(format('select public.intake_revoke_invitations(%L, %L)', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('x_rev'), 1))));
-- a later staff_revoked row alone (the pending row left open) also refuses
select pg_temp.own(format('update public.intake_invitations set revoked_at = now() + interval ''1 second'', revoked_reason = ''staff_revoked'' where id = %L', pg_temp.part(pg_temp.kv('x_late'), 2)));
-- something appears between the request and the finalize
select pg_temp.setkv('x_between_r', pg_temp.resp(pg_temp.part(pg_temp.kv('x_between'), 1), 'between'));
insert into public.intake_responses (studio_id, request_id, client_id, audience, respondent_id, template_version_id, answers)
  select q.studio_id, q.id, q.client_id, 'guardian', pg_temp.kv('x_between_r')::uuid, q.pinned_version_id, '{}'::jsonb from public.intake_requests q where q.id = pg_temp.part(pg_temp.kv('x_between'), 1)::uuid;
select pg_temp.own(format('insert into public.intake_audit_events (studio_id, event_type, actor_type, client_ref, retention_class, retention_state) values (%L, ''erasure_record'', ''platform_admin'', %L, ''erasure_record'', ''pending_policy'')', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('x_bar'), 4)));
select pg_temp.setkv('r_' || k, pg_temp.fin(pg_temp.part(pg_temp.kv(k), 6), gen_random_uuid()::text, 1, pg_temp.hx(k)))
  from unnest(array['x_exp', 'x_sup', 'x_adult', 'x_closed', 'x_link', 'x_dead', 'x_sub', 'x_rev', 'x_late', 'x_between', 'x_bar']) k;
select pg_temp.chk('B04b finalize re-checks everything: expired, superseded, determination no longer minor, request closed, linked recipient, no live appointment, guardian consent submitted, staff revoke-all (both ways) and erasure barrier each refuse without issuing',
  pg_temp.kv('r_x_exp') = 'expired' and pg_temp.kv('r_x_sup') = 'superseded' and pg_temp.kv('r_x_adult') = 'not_minor' and pg_temp.kv('r_x_closed') = 'not_open'
  and pg_temp.kv('r_x_link') = 'recipient_link_set' and pg_temp.kv('r_x_dead') = 'no_live_target' and pg_temp.kv('r_x_sub') = 'already_submitted'
  and pg_temp.kv('b4_revn') = 'ok' and pg_temp.kv('r_x_rev') = 'superseded' and pg_temp.kv('r_x_late') = 'superseded' and pg_temp.kv('r_x_bar') = 'erasure_barrier'
  and (select superseded_at is not null from public.intake_guardian_invitation_requests where id = pg_temp.part(pg_temp.kv('x_rev'), 6)::uuid)
  and not exists (select 1 from public.intake_invitations i where i.audience = 'guardian' and i.request_id in (
        select pg_temp.part(pg_temp.kv(k), 1)::uuid from unnest(array['x_exp', 'x_sup', 'x_adult', 'x_closed', 'x_link', 'x_dead', 'x_sub', 'x_rev', 'x_late', 'x_bar']) k)),
  concat_ws(' | ', pg_temp.kv('r_x_exp'), pg_temp.kv('r_x_sup'), pg_temp.kv('r_x_adult'), pg_temp.kv('r_x_closed'), pg_temp.kv('r_x_link'), pg_temp.kv('r_x_dead'), pg_temp.kv('r_x_sub'), pg_temp.kv('r_x_rev'), pg_temp.kv('r_x_late'), pg_temp.kv('r_x_bar')));
select pg_temp.chk('B04c a respondent and draft that appeared after the request are superseded by finalize and audited with the count',
  pg_temp.kv('r_x_between') = 'issued:1'
  and (select superseded_at is not null from public.intake_respondents where id = pg_temp.kv('x_between_r')::uuid)
  and (select bool_and(status = 'superseded') from public.intake_responses where respondent_id = pg_temp.kv('x_between_r')::uuid)
  and exists (select 1 from public.intake_audit_events e where e.event_type = 'guardian_invitation_requested' and e.actor_type = 'system'
        and e.object_ref = pg_temp.part(pg_temp.kv('x_between'), 6)::uuid and e.metadata = '{"audience": "guardian", "generation": 1, "count": 1}'::jsonb),
  pg_temp.kv('r_x_between'));

-- ===== B05 constraints and guards ======================================================================================
select pg_temp.clear_limits();
select pg_temp.setkv('g5', pg_temp.gset()); select pg_temp.setkv('c5', pg_temp.mkch(pg_temp.kv('g5'), '1 minute', true)::text);
create or replace function pg_temp.insinv(p_aud text, p_by text, p_hmac text, p_kid text) returns text language sql as $$
  select pg_temp.try(format('insert into public.intake_invitations (id, studio_id, request_id, audience, generation, kid, token_salt, token_hash, issued_by, pinned_version_id, expires_at, recipient_email_hmac, recipient_email_hmac_kid) select %L, studio_id, id, %L, 40 + (random() * 1000)::int, ''kid00001'', decode(%L, ''hex''), decode(%L, ''hex''), %L, pinned_version_id, now() + interval ''1 day'', %L, %s from public.intake_requests where id = %L',
    gen_random_uuid(), p_aud, repeat('ab', 16), pg_temp.hx(gen_random_uuid()::text), p_by, p_hmac, coalesce(p_kid, 'null'), pg_temp.part(pg_temp.kv('g5'), 1))) $$;
select pg_temp.setkv('b5_stu_rec', pg_temp.insinv('student', 'staff', 'h', '1'));
select pg_temp.setkv('b5_stu_kid', pg_temp.insinv('student', 'staff', null, '1'));
select pg_temp.setkv('b5_stu_two', pg_temp.insinv('student', 'two_party', null, null));
select pg_temp.setkv('b5_g_norec', pg_temp.insinv('guardian', 'two_party', null, null));
select pg_temp.setkv('b5_g_staff', pg_temp.insinv('guardian', 'staff', 'h', '1'));
select pg_temp.setkv('b5_g_empty', pg_temp.insinv('guardian', 'two_party', '', '1'));
select pg_temp.setkv('b5_rec', pg_temp.try(format('update public.intake_invitations set recipient_email_hmac = ''other'' where id = %L', pg_temp.part(pg_temp.kv('g5'), 7))));
select pg_temp.setkv('b5_reckid', pg_temp.try(format('update public.intake_invitations set recipient_email_hmac_kid = 2 where id = %L', pg_temp.part(pg_temp.kv('g5'), 7))));
select pg_temp.setkv('b5_p_hmac', pg_temp.try(format('update public.intake_guardian_invitation_requests set recipient_email_hmac = ''other'' where id = %L', pg_temp.part(pg_temp.kv('g5'), 10))));
select pg_temp.setkv('b5_p_unfin', pg_temp.try(format('update public.intake_guardian_invitation_requests set finalized_at = null, finalized_invitation_id = null where id = %L', pg_temp.part(pg_temp.kv('g5'), 10))));
select pg_temp.setkv('b5_p_both', pg_temp.try(format('update public.intake_guardian_invitation_requests set superseded_at = now() where id = %L', pg_temp.part(pg_temp.kv('g5'), 10))));
select pg_temp.setkv('b5_c_jump', pg_temp.try(format('update public.intake_email_challenges set attempts = 2 where id = %L', pg_temp.kv('c5'))));
select pg_temp.setkv('b5_c_code', pg_temp.try(format('update public.intake_email_challenges set code_hash = decode(%L, ''hex'') where id = %L', pg_temp.hx('x'), pg_temp.kv('c5'))));
select pg_temp.setkv('b5_c_one', pg_temp.try(format('update public.intake_email_challenges set attempts = 1 where id = %L', pg_temp.kv('c5'))));
select pg_temp.setkv('b5_c_down', pg_temp.try(format('update public.intake_email_challenges set attempts = 0 where id = %L', pg_temp.kv('c5'))));
select pg_temp.setkv('b5_c_dup', pg_temp.try(format('insert into public.intake_email_challenges (id, studio_id, request_id, client_id, respondent_id, invitation_id, email_hmac, email_hmac_kid, code_hash, expires_at) select %L, studio_id, request_id, client_id, respondent_id, invitation_id, email_hmac, email_hmac_kid, code_hash, expires_at from public.intake_email_challenges where id = %L', gen_random_uuid(), pg_temp.kv('c5'))));
select pg_temp.setkv('b5_c_wrong', pg_temp.try(format('insert into public.intake_email_challenges (id, studio_id, request_id, client_id, respondent_id, invitation_id, email_hmac, email_hmac_kid, code_hash, expires_at, superseded_at) select %L, studio_id, request_id, client_id, respondent_id, invitation_id, ''other'', email_hmac_kid, code_hash, expires_at, null from public.intake_email_challenges where id = %L', gen_random_uuid(), pg_temp.kv('c5'))));
select pg_temp.setkv('b5_c_stud', pg_temp.try(format('insert into public.intake_email_challenges (id, studio_id, request_id, client_id, respondent_id, invitation_id, email_hmac, email_hmac_kid, code_hash, expires_at) select %L, studio_id, request_id, client_id, respondent_id, %L, email_hmac, email_hmac_kid, code_hash, expires_at from public.intake_email_challenges where id = %L', gen_random_uuid(), pg_temp.part(pg_temp.kv('g5'), 2), pg_temp.kv('c5'))));
update public.intake_email_challenges set superseded_at = now() where id = pg_temp.kv('c5')::uuid;
select pg_temp.setkv('b5_c_afters', pg_temp.try(format('update public.intake_email_challenges set attempts = 2 where id = %L', pg_temp.kv('c5'))));
select pg_temp.setkv('b5_c_resup', pg_temp.try(format('update public.intake_email_challenges set superseded_at = null where id = %L', pg_temp.kv('c5'))));
select pg_temp.setkv('b5_c_del', pg_temp.try(format('delete from public.intake_email_challenges where id = %L', pg_temp.kv('c5'))));
select pg_temp.setkv('b5_p_del', pg_temp.try(format('delete from public.intake_guardian_invitation_requests where id = %L', pg_temp.part(pg_temp.kv('g5'), 10))));
select pg_temp.setkv('b5_two_open', pg_temp.try(format('select pg_temp.resp(%L, ''second'')', pg_temp.part(pg_temp.kv('g5'), 1))));
select pg_temp.setkv('g5b', pg_temp.gset(false));
select pg_temp.setkv('g5br', pg_temp.resp(pg_temp.part(pg_temp.kv('g5b'), 1), 'differs'));
select pg_temp.setkv('b5_c_resp', pg_temp.try(format('select pg_temp.mkch(%L, ''0 seconds'', true)',
  array_to_string((string_to_array(pg_temp.kv('g5b'), '|'))[1:8], '|') || '|' || pg_temp.kv('g5br'))));
select pg_temp.chk('B05a invitation checks: a student link never carries a recipient or two_party; a guardian link needs a non-empty recipient and two_party; the recipient is immutable; only one current guardian respondent per request',
  pg_temp.kv('b5_stu_rec') like '23514%' and pg_temp.kv('b5_stu_kid') like '23514%' and pg_temp.kv('b5_stu_two') like '23514%' and pg_temp.kv('b5_g_norec') like '23514%'
  and pg_temp.kv('b5_g_staff') like '23514%' and pg_temp.kv('b5_g_empty') like '23514%' and pg_temp.kv('b5_rec') like '42501%' and pg_temp.kv('b5_reckid') like '42501%'
  and pg_temp.kv('b5_two_open') like '23505%',
  concat_ws(' | ', pg_temp.kv('b5_stu_rec'), pg_temp.kv('b5_stu_two'), pg_temp.kv('b5_g_staff'), pg_temp.kv('b5_rec'), pg_temp.kv('b5_two_open')));
select pg_temp.chk('B05b guards: the pending row is immutable except one finalize or supersede; a challenge only counts up by one while open, supersedes once, needs the current respondent hash and the live bound guardian invitation, one open per respondent; no delete outside the restricted role',
  pg_temp.kv('b5_p_hmac') like '42501%' and pg_temp.kv('b5_p_unfin') like '42501%' and pg_temp.kv('b5_p_both') like '23514%'
  and pg_temp.kv('b5_c_jump') like '42501%' and pg_temp.kv('b5_c_code') like '42501%' and pg_temp.kv('b5_c_one') = 'ok' and pg_temp.kv('b5_c_down') like '42501%'
  and pg_temp.kv('b5_c_dup') like '23505%' and pg_temp.kv('b5_c_wrong') like '42501%' and pg_temp.kv('b5_c_stud') like '42501%' and pg_temp.kv('b5_c_resp') like '42501%'
  and pg_temp.kv('b5_c_afters') like '42501%' and pg_temp.kv('b5_c_resup') like '42501%' and pg_temp.kv('b5_c_del') like '42501%' and pg_temp.kv('b5_p_del') like '42501%',
  concat_ws(' | ', pg_temp.kv('b5_p_hmac'), pg_temp.kv('b5_p_both'), pg_temp.kv('b5_c_jump'), pg_temp.kv('b5_c_one'), pg_temp.kv('b5_c_dup'), pg_temp.kv('b5_c_wrong'), pg_temp.kv('b5_c_stud'), pg_temp.kv('b5_c_afters')));

-- ===== B06 the guardian link ===========================================================================================
select pg_temp.clear_limits();
select pg_temp.setkv('g6a', pg_temp.gset()); select pg_temp.setkv('g6l', pg_temp.gset()); select pg_temp.setkv('g6s', pg_temp.gset()); select pg_temp.setkv('g6r', pg_temp.gset());
select pg_temp.setkv('b6_ctx', pg_temp.ctx(pg_temp.part(pg_temp.kv('g6a'), 8)));
select pg_temp.setkv('b6_aud', (select audience || ':' || coalesce(issued_by_user::text, 'null') from public.intake_sessions where invitation_id = pg_temp.part(pg_temp.kv('g6a'), 7)::uuid));
select pg_temp.determine(pg_temp.part(pg_temp.kv('g6a'), 1), false, '1 second');
select pg_temp.setkv('b6_adult_ctx', pg_temp.ctx(pg_temp.part(pg_temp.kv('g6a'), 8)));
select pg_temp.setkv('b6_adult_iss', pg_temp.iss(pg_temp.kv('g6a'), gen_random_uuid(), 'c'));
select pg_temp.setkv('b6_adult_tgt', pg_temp.tgt(pg_temp.kv('g6a')));
select pg_temp.own(format('update public.intake_requests set guardian_recipient_link_id = %L, guardian_recipient_basis = ''staff_selected'' where id = %L', gen_random_uuid(), pg_temp.part(pg_temp.kv('g6l'), 1)));
select pg_temp.setkv('b6_link_ctx', pg_temp.ctx(pg_temp.part(pg_temp.kv('g6l'), 8)));
select pg_temp.setkv('s6', 'stud-' || gen_random_uuid()::text); select pg_temp.exch(pg_temp.part(pg_temp.kv('g6s'), 3), pg_temp.kv('s6'));
select pg_temp.setkv('s6n', gen_random_uuid()::text);
select pg_temp.issue_as('owner_a', pg_temp.part(pg_temp.kv('g6s'), 1)::uuid, pg_temp.kv('s6n')::uuid, pg_temp.hx(pg_temp.kv('s6n')));
select pg_temp.setkv('b6_reissue_g', pg_temp.ctx(pg_temp.part(pg_temp.kv('g6s'), 8)));
select pg_temp.setkv('b6_reissue_s', pg_temp.ctx(pg_temp.kv('s6')));
select pg_temp.setkv('b6_pendr', split_part(pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('g6r'), 1), 'again'), ':', 2));
select pg_temp.setkv('b6_pendr_inv', gen_random_uuid()::text);
select pg_temp.fin(pg_temp.kv('b6_pendr'), pg_temp.kv('b6_pendr_inv'), 2, pg_temp.hx('g6r2'));
select pg_temp.setkv('g6r2s', 'gs-' || gen_random_uuid()::text); select pg_temp.exch(pg_temp.hx('g6r2'), pg_temp.kv('g6r2s'));
select pg_temp.setkv('b6_pre_ctx', pg_temp.ctx(pg_temp.kv('g6r2s')));
select pg_temp.setkv('b6_open', split_part(pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('g6s'), 1), 'open'), ':', 2));
select pg_temp.owner_a(format('select public.intake_revoke_invitations(%L, %L)', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('g6r'), 1)));
select pg_temp.setkv('b6_rev_ctx', pg_temp.ctx(pg_temp.kv('g6r2s')));
select pg_temp.setkv('p6only', pg_temp.pend('p6only'));
select pg_temp.setkv('b6_rev0', pg_temp.owner_a(format('select public.intake_revoke_invitations(%L, %L)', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('p6only'), 1))));
select pg_temp.chk('B06 a guardian link opens a guardian session in the requester''s name; it stops when the latest determination is adult or a linked recipient is chosen; a student re-issue ends only student sessions; staff revoke-all ends guardian sessions and open requests',
  pg_temp.kv('b6_ctx') = pg_temp.part(pg_temp.kv('g6a'), 1) and pg_temp.kv('b6_aud') = 'guardian:' || pg_temp.u('owner_a')::text
  and pg_temp.kv('b6_adult_ctx') = 'NONE' and pg_temp.kv('b6_adult_iss') = 'invalid' and pg_temp.kv('b6_adult_tgt') = 'NONE' and pg_temp.kv('b6_link_ctx') = 'NONE'
  and pg_temp.kv('b6_reissue_g') = pg_temp.part(pg_temp.kv('g6s'), 1) and pg_temp.kv('b6_reissue_s') = 'NONE'
  and pg_temp.kv('b6_pre_ctx') = pg_temp.part(pg_temp.kv('g6r'), 1) and pg_temp.kv('b6_rev_ctx') = 'NONE' and pg_temp.kv('b6_rev0') = 'ok'
  and (select superseded_at is not null from public.intake_guardian_invitation_requests where id = pg_temp.part(pg_temp.kv('p6only'), 6)::uuid),
  concat_ws(' | ', pg_temp.kv('b6_ctx'), pg_temp.kv('b6_aud'), pg_temp.kv('b6_adult_ctx'), pg_temp.kv('b6_adult_iss'), pg_temp.kv('b6_link_ctx'), pg_temp.kv('b6_reissue_g'), pg_temp.kv('b6_reissue_s'), pg_temp.kv('b6_rev_ctx')));

-- ===== B07 issue and the address read ==================================================================================
select pg_temp.clear_limits();
select pg_temp.setkv('g7', pg_temp.gset()); select pg_temp.setkv('g7none', pg_temp.gset(false)); select pg_temp.setkv('g7h', pg_temp.gset(false)); select pg_temp.setkv('g7k', pg_temp.gset(false));
select pg_temp.setkv('g7a', pg_temp.gset()); select pg_temp.setkv('g7e', pg_temp.gset(false));
select pg_temp.resp(pg_temp.part(pg_temp.kv('g7h'), 1), 'not-the-bound-hash');
select pg_temp.resp(pg_temp.part(pg_temp.kv('g7k'), 1), pg_temp.part(pg_temp.kv('g7k'), 6), 2);
select pg_temp.resp(pg_temp.part(pg_temp.kv('g7e'), 1), pg_temp.part(pg_temp.kv('g7e'), 6), 1, null);
select pg_temp.own(format('update public.intake_respondents set assurance = ''staff_attested'' where id = %L', pg_temp.part(pg_temp.kv('g7a'), 9)));
select pg_temp.setkv('t_ok', pg_temp.tgt(pg_temp.kv('g7')));
select pg_temp.setkv('t_none', pg_temp.tgt(pg_temp.kv('g7none')));
select pg_temp.setkv('t_h', pg_temp.tgt(pg_temp.kv('g7h')));
select pg_temp.setkv('t_k', pg_temp.tgt(pg_temp.kv('g7k')));
select pg_temp.setkv('t_a', pg_temp.tgt(pg_temp.kv('g7a')));
select pg_temp.setkv('t_e', pg_temp.tgt(pg_temp.kv('g7e')));
-- a student session of the same request
select pg_temp.setkv('s7', 'stud-' || gen_random_uuid()::text); select pg_temp.exch(pg_temp.part(pg_temp.kv('g7'), 3), pg_temp.kv('s7'));
select pg_temp.setkv('g7stud', pg_temp.kv('g7'));
select pg_temp.setkv('g7stud', array_to_string((string_to_array(pg_temp.kv('g7'), '|'))[1:7], '|') || '|' || pg_temp.kv('s7') || '|' || pg_temp.part(pg_temp.kv('g7'), 9));
select pg_temp.setkv('t_stud', pg_temp.tgt(pg_temp.kv('g7stud')));
select pg_temp.set_gate(false);
select pg_temp.setkv('t_gate', pg_temp.tgt(pg_temp.kv('g7')));
select pg_temp.setkv('i_gate', pg_temp.iss(pg_temp.kv('g7'), gen_random_uuid(), 'c'));
select pg_temp.setkv('v_gate', pg_temp.ver(pg_temp.kv('g7'), gen_random_uuid(), 'c'));
select pg_temp.set_gate(true);
select pg_temp.setkv('i_stud', pg_temp.iss(pg_temp.kv('g7stud'), gen_random_uuid(), 'c'));
select pg_temp.setkv('i_none', pg_temp.iss(pg_temp.kv('g7none'), gen_random_uuid(), 'c'));
select pg_temp.setkv('i_h', pg_temp.iss(pg_temp.kv('g7h'), gen_random_uuid(), 'c'));
select pg_temp.setkv('i_hsend', pg_temp.iss(pg_temp.kv('g7h'), gen_random_uuid(), 'c', 'not-the-bound-hash'));
select pg_temp.setkv('i_k', pg_temp.iss(pg_temp.kv('g7k'), gen_random_uuid(), 'c'));
select pg_temp.setkv('i_send', pg_temp.iss(pg_temp.kv('g7'), gen_random_uuid(), 'c', 'someone-else'));
select pg_temp.setkv('i_sendkid', pg_temp.iss(pg_temp.kv('g7'), gen_random_uuid(), 'c', null, 2));
select pg_temp.setkv('i_a', pg_temp.iss(pg_temp.kv('g7a'), gen_random_uuid(), 'c'));
select pg_temp.setkv('c7', gen_random_uuid()::text);
select pg_temp.setkv('i_ok', pg_temp.iss(pg_temp.kv('g7'), pg_temp.kv('c7')::uuid, 'right'));
select pg_temp.setkv('i_dup', pg_temp.iss(pg_temp.kv('g7'), pg_temp.kv('c7')::uuid, 'right'));
select pg_temp.chk('B07a the address read returns the stored address and key id only to a valid guardian session whose current respondent matches the bound recipient; zero rows for no respondent, other hash or key, verified, no address, student session or closed gate',
  pg_temp.kv('t_ok') = 'guardian@nsi-m16b.invalid:1' and pg_temp.kv('t_none') = 'NONE' and pg_temp.kv('t_h') = 'NONE' and pg_temp.kv('t_k') = 'NONE'
  and pg_temp.kv('t_a') = 'NONE' and pg_temp.kv('t_e') = 'NONE' and pg_temp.kv('t_stud') = 'NONE' and pg_temp.kv('t_gate') = 'NONE',
  concat_ws(' | ', pg_temp.kv('t_ok'), pg_temp.kv('t_none'), pg_temp.kv('t_h'), pg_temp.kv('t_k'), pg_temp.kv('t_a'), pg_temp.kv('t_e'), pg_temp.kv('t_stud'), pg_temp.kv('t_gate')));
select pg_temp.chk('B07b a challenge needs respondent hash, send-to hash and bound recipient all equal (one word, invalid, otherwise); student session invalid; verified respondent already_done; gate_closed first; a repeated id is invalid; the stored row copies the bound hash and expires in ten minutes',
  pg_temp.kv('i_gate') = 'gate_closed' and pg_temp.kv('v_gate') = 'gate_closed' and pg_temp.kv('i_stud') = 'invalid' and pg_temp.kv('i_none') = 'invalid' and pg_temp.kv('i_h') = 'invalid'
  and pg_temp.kv('i_hsend') = 'invalid' and pg_temp.kv('i_k') = 'invalid' and pg_temp.kv('i_send') = 'invalid' and pg_temp.kv('i_sendkid') = 'invalid' and pg_temp.kv('i_a') = 'already_done'
  and pg_temp.kv('i_ok') = 'ok' and pg_temp.kv('i_dup') = 'invalid'
  and (select count(*) = 1 from public.intake_email_challenges where request_id = pg_temp.part(pg_temp.kv('g7'), 1)::uuid)
  and exists (select 1 from public.intake_email_challenges c where c.id = pg_temp.kv('c7')::uuid and c.email_hmac = pg_temp.part(pg_temp.kv('g7'), 6) and c.email_hmac_kid = 1
        and c.invitation_id = pg_temp.part(pg_temp.kv('g7'), 7)::uuid and c.respondent_id = pg_temp.part(pg_temp.kv('g7'), 9)::uuid
        and c.code_hash = decode(pg_temp.hx('right'), 'hex') and c.expires_at = now() + interval '10 minutes' and c.attempts = 0)
  and not exists (select 1 from public.intake_email_challenges c where c.request_id in (select pg_temp.part(pg_temp.kv(k), 1)::uuid from unnest(array['g7none', 'g7h', 'g7k', 'g7a']) k)),
  concat_ws(' | ', pg_temp.kv('i_gate'), pg_temp.kv('i_stud'), pg_temp.kv('i_none'), pg_temp.kv('i_h'), pg_temp.kv('i_hsend'), pg_temp.kv('i_send'), pg_temp.kv('i_a'), pg_temp.kv('i_ok'), pg_temp.kv('i_dup')));

-- ===== B08 limits ======================================================================================================
select pg_temp.clear_limits();
select pg_temp.setkv('g8a', pg_temp.gset());
select pg_temp.setkv('l_a_' || n, pg_temp.iss(pg_temp.kv('g8a'), gen_random_uuid(), 'c', 'wrong')) from generate_series(1, 5) n;
select pg_temp.setkv('l_a_6', pg_temp.iss(pg_temp.kv('g8a'), gen_random_uuid(), 'c'));
select pg_temp.clear_limits();
select pg_temp.setkv('l_a_7', pg_temp.iss(pg_temp.kv('g8a'), gen_random_uuid(), 'c'));
select pg_temp.clear_limits();
select pg_temp.setkv('g8d', pg_temp.gset());
select pg_temp.svc(format('select public.intake_rate_limit_hit(sha256(convert_to(%L, ''UTF8'')), 20, 86400)', 'intake/challenge-issue/v1|' || pg_temp.part(pg_temp.kv('g8d'), 9))) from generate_series(1, 20);
select pg_temp.setkv('l_day', pg_temp.iss(pg_temp.kv('g8d'), gen_random_uuid(), 'c'));
select pg_temp.clear_limits();
select pg_temp.setkv('g8ip', pg_temp.gset());
select pg_temp.svc(format('select public.intake_rate_limit_hit(decode(%L, ''hex''), 30, 3600)', pg_temp.hx('ip-x'))) from generate_series(1, 30);
select pg_temp.setkv('l_ip', pg_temp.iss(pg_temp.kv('g8ip'), gen_random_uuid(), 'c', null, 1, pg_temp.hx('ip-x')));
select pg_temp.svc(format('select public.intake_rate_limit_hit(decode(%L, ''hex''), 10, 3600)', pg_temp.hx('em-x'))) from generate_series(1, 10);
select pg_temp.setkv('l_em', pg_temp.iss(pg_temp.kv('g8ip'), gen_random_uuid(), 'c', null, 1, null, pg_temp.hx('em-x')));
select pg_temp.clear_limits();
select pg_temp.setkv('g8h', pg_temp.gset()); select pg_temp.mkch(pg_temp.kv('g8h'), '30 minutes') from generate_series(1, 4);
select pg_temp.setkv('l_h4', pg_temp.iss(pg_temp.kv('g8h'), gen_random_uuid(), 'c'));
select pg_temp.clear_limits();
select pg_temp.setkv('l_h5', pg_temp.iss(pg_temp.kv('g8h'), gen_random_uuid(), 'c'));
select pg_temp.clear_limits();
select pg_temp.setkv('g8t', pg_temp.gset()); select pg_temp.mkch(pg_temp.kv('g8t'), '2 hours') from generate_series(1, 9);
select pg_temp.setkv('l_t9', pg_temp.iss(pg_temp.kv('g8t'), gen_random_uuid(), 'c'));
select pg_temp.clear_limits();
select pg_temp.setkv('l_t10', pg_temp.iss(pg_temp.kv('g8t'), gen_random_uuid(), 'c'));
select pg_temp.clear_limits();
select pg_temp.setkv('g8f', pg_temp.gset()); select pg_temp.mkch(pg_temp.kv('g8f'), '20 days') from generate_series(1, 49);
select pg_temp.setkv('l_f49', pg_temp.iss(pg_temp.kv('g8f'), gen_random_uuid(), 'c'));
select pg_temp.clear_limits();
select pg_temp.setkv('l_f50', pg_temp.iss(pg_temp.kv('g8f'), gen_random_uuid(), 'c'));
select pg_temp.clear_limits();
select pg_temp.setkv('g8s', pg_temp.gset()); select pg_temp.setkv('c8a', gen_random_uuid()::text); select pg_temp.setkv('c8b', gen_random_uuid()::text);
select pg_temp.iss(pg_temp.kv('g8s'), pg_temp.kv('c8a')::uuid, 'a'); select pg_temp.iss(pg_temp.kv('g8s'), pg_temp.kv('c8b')::uuid, 'b');
select pg_temp.setkv('v8old', pg_temp.ver(pg_temp.kv('g8s'), pg_temp.kv('c8a')::uuid, 'a'));
select pg_temp.chk('B08a every issue attempt is counted before anything is compared: five wrong ones leave the sixth correct one limited; the daily, network and address buckets limit too',
  (select count(*) = 5 from generate_series(1, 5) n where pg_temp.kv('l_a_' || n) = 'invalid') and pg_temp.kv('l_a_6') = 'limited' and pg_temp.kv('l_a_7') = 'ok'
  and pg_temp.kv('l_day') = 'limited' and pg_temp.kv('l_ip') = 'limited' and pg_temp.kv('l_em') = 'limited',
  concat_ws(' | ', pg_temp.kv('l_a_1'), pg_temp.kv('l_a_6'), pg_temp.kv('l_a_7'), pg_temp.kv('l_day'), pg_temp.kv('l_ip'), pg_temp.kv('l_em')));
select pg_temp.chk('B08b caps counted from challenge rows: 5 per hour, 10 per day, 50 per invitation; a new challenge supersedes the open one, which then answers superseded without counting',
  pg_temp.kv('l_h4') = 'ok' and pg_temp.kv('l_h5') = 'limited' and pg_temp.kv('l_t9') = 'ok' and pg_temp.kv('l_t10') = 'limited' and pg_temp.kv('l_f49') = 'ok' and pg_temp.kv('l_f50') = 'limited'
  and pg_temp.kv('v8old') = 'superseded' and pg_temp.chv(pg_temp.kv('c8a')::uuid, 'attempts') = '0' and pg_temp.chv(pg_temp.kv('c8a')::uuid, 'superseded_at') <> 'null' and pg_temp.chv(pg_temp.kv('c8b')::uuid, 'superseded_at') = 'null',
  concat_ws(' | ', pg_temp.kv('l_h4'), pg_temp.kv('l_h5'), pg_temp.kv('l_t9'), pg_temp.kv('l_t10'), pg_temp.kv('l_f49'), pg_temp.kv('l_f50'), pg_temp.kv('v8old')));

-- ===== B09 verify ======================================================================================================
select pg_temp.clear_limits();
select pg_temp.setkv('g9', pg_temp.gset()); select pg_temp.setkv('c9', gen_random_uuid()::text); select pg_temp.iss(pg_temp.kv('g9'), pg_temp.kv('c9')::uuid, 'right');
select pg_temp.setkv('g9o', pg_temp.gset()); select pg_temp.setkv('c9o', gen_random_uuid()::text); select pg_temp.iss(pg_temp.kv('g9o'), pg_temp.kv('c9o')::uuid, 'right');
select pg_temp.setkv('v_foreign', pg_temp.ver(pg_temp.kv('g9'), pg_temp.kv('c9o')::uuid, 'right'));
select pg_temp.setkv('v_unknown', pg_temp.ver(pg_temp.kv('g9'), gen_random_uuid(), 'right'));
select pg_temp.setkv('v_w1', pg_temp.ver(pg_temp.kv('g9'), pg_temp.kv('c9')::uuid, 'wrong'));
select pg_temp.setkv('v_w1n', pg_temp.chv(pg_temp.kv('c9')::uuid, 'attempts'));
select pg_temp.setkv('v_ok', pg_temp.ver(pg_temp.kv('g9'), pg_temp.kv('c9')::uuid, 'right'));
select pg_temp.setkv('v_reuse', pg_temp.ver(pg_temp.kv('g9'), pg_temp.kv('c9')::uuid, 'right'));
select pg_temp.setkv('v_after_iss', pg_temp.iss(pg_temp.kv('g9'), gen_random_uuid(), 'x'));
select pg_temp.setkv('g9l', pg_temp.gset()); select pg_temp.setkv('c9l', gen_random_uuid()::text); select pg_temp.iss(pg_temp.kv('g9l'), pg_temp.kv('c9l')::uuid, 'right');
select pg_temp.setkv('v_l_' || n, pg_temp.ver(pg_temp.kv('g9l'), pg_temp.kv('c9l')::uuid, 'wrong')) from generate_series(1, 5) n;
select pg_temp.setkv('v_locked', pg_temp.ver(pg_temp.kv('g9l'), pg_temp.kv('c9l')::uuid, 'right'));
select pg_temp.setkv('g9e', pg_temp.gset()); select pg_temp.setkv('c9e', gen_random_uuid()::text); select pg_temp.iss(pg_temp.kv('g9e'), pg_temp.kv('c9e')::uuid, 'right');
select pg_temp.own(format('update public.intake_email_challenges set expires_at = now() - interval ''1 second'' where id = %L', pg_temp.kv('c9e')));
select pg_temp.setkv('v_exp', pg_temp.ver(pg_temp.kv('g9e'), pg_temp.kv('c9e')::uuid, 'right'));
select pg_temp.setkv('g9a', pg_temp.gset()); select pg_temp.setkv('c9a', gen_random_uuid()::text); select pg_temp.iss(pg_temp.kv('g9a'), pg_temp.kv('c9a')::uuid, 'right');
select pg_temp.own(format('update public.intake_respondents set assurance = ''staff_attested'' where id = %L', pg_temp.part(pg_temp.kv('g9a'), 9)));
select pg_temp.setkv('v_att', pg_temp.ver(pg_temp.kv('g9a'), pg_temp.kv('c9a')::uuid, 'right'));
select pg_temp.setkv('g9n', pg_temp.gset()); select pg_temp.setkv('c9n', gen_random_uuid()::text); select pg_temp.iss(pg_temp.kv('g9n'), pg_temp.kv('c9n')::uuid, 'right');
update public.intake_respondents set email_hmac = null, email_hmac_kid = null where id = pg_temp.part(pg_temp.kv('g9n'), 9)::uuid;
select pg_temp.setkv('v_null', pg_temp.ver(pg_temp.kv('g9n'), pg_temp.kv('c9n')::uuid, 'right'));
select pg_temp.setkv('g9i', pg_temp.gset()); select pg_temp.setkv('c9i', gen_random_uuid()::text); select pg_temp.iss(pg_temp.kv('g9i'), pg_temp.kv('c9i')::uuid, 'right');
select pg_temp.own(format('update public.intake_email_challenges set invitation_id = %L where id = %L', pg_temp.part(pg_temp.kv('g9i'), 2), pg_temp.kv('c9i')));
select pg_temp.setkv('v_inv', pg_temp.ver(pg_temp.kv('g9i'), pg_temp.kv('c9i')::uuid, 'right'));
select pg_temp.setkv('g9r', pg_temp.gset()); select pg_temp.setkv('c9r', gen_random_uuid()::text); select pg_temp.iss(pg_temp.kv('g9r'), pg_temp.kv('c9r')::uuid, 'right');
select pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('g9r'), 1), 'fresh');
select pg_temp.setkv('v_rereq', pg_temp.ver(pg_temp.kv('g9r'), pg_temp.kv('c9r')::uuid, 'right'));
select pg_temp.chk('B09a a wrong code is counted and returns invalid; the fifth leaves the sixth (correct) locked; a foreign or unknown id costs nobody an attempt',
  pg_temp.kv('v_w1') = 'invalid' and pg_temp.kv('v_w1n') = '1' and (select count(*) = 5 from generate_series(1, 5) n where pg_temp.kv('v_l_' || n) = 'invalid')
  and pg_temp.kv('v_locked') = 'locked' and pg_temp.chv(pg_temp.kv('c9l')::uuid, 'attempts') = '5' and pg_temp.asr(pg_temp.part(pg_temp.kv('g9l'), 9)) = 'declared_unverified'
  and pg_temp.kv('v_foreign') = 'invalid' and pg_temp.kv('v_unknown') = 'invalid' and pg_temp.chv(pg_temp.kv('c9o')::uuid, 'attempts') = '0',
  concat_ws(' | ', pg_temp.kv('v_w1'), pg_temp.kv('v_w1n'), pg_temp.kv('v_locked'), pg_temp.kv('v_foreign')));
select pg_temp.chk('B09b the right code consumes the challenge and verifies the respondent once; reuse is invalid and a new issue already_done; expired, attested, redacted hash, other invitation and re-requested link never count an attempt or verify',
  pg_temp.kv('v_ok') = 'ok' and pg_temp.asr(pg_temp.part(pg_temp.kv('g9'), 9)) = 'email_code_verified' and pg_temp.chv(pg_temp.kv('c9')::uuid, 'consumed_at') <> 'null' and pg_temp.chv(pg_temp.kv('c9')::uuid, 'attempts') = '2'
  and pg_temp.kv('v_reuse') = 'invalid' and pg_temp.kv('v_after_iss') = 'already_done'
  and pg_temp.kv('v_exp') = 'expired' and pg_temp.kv('v_att') = 'already_done' and pg_temp.kv('v_null') = 'invalid' and pg_temp.kv('v_inv') = 'invalid' and pg_temp.kv('v_rereq') = 'invalid'
  and (select bool_and(pg_temp.chv(pg_temp.kv(k)::uuid, 'attempts') = '0') from unnest(array['c9e', 'c9a', 'c9n', 'c9i', 'c9r']) k),
  concat_ws(' | ', pg_temp.kv('v_ok'), pg_temp.kv('v_reuse'), pg_temp.kv('v_after_iss'), pg_temp.kv('v_exp'), pg_temp.kv('v_att'), pg_temp.kv('v_null'), pg_temp.kv('v_inv'), pg_temp.kv('v_rereq')));

-- ===== B10 the evidence-based respondent guard =========================================================================
select pg_temp.clear_limits();
create or replace function pg_temp.promote(p_resp text, p_set text default '') returns text language sql as $$
  select pg_temp.try(format('update public.intake_respondents set assurance = ''email_code_verified'', assurance_at = now()%s where id = %L', p_set, p_resp)) $$;
select pg_temp.setkv(k, pg_temp.gset()) from unnest(array['q_none', 'q_open', 'q_ok', 'q_rev', 'q_old', 'q_hash', 'q_null', 'q_red']) k;
select pg_temp.setkv('ch_' || k, pg_temp.mkch(pg_temp.kv(k), '1 minute', true)::text) from unnest(array['q_open', 'q_ok', 'q_rev', 'q_old', 'q_hash', 'q_null']) k;
update public.intake_email_challenges set consumed_at = now() where id in (select pg_temp.kv('ch_' || k)::uuid from unnest(array['q_ok', 'q_rev', 'q_old', 'q_hash', 'q_null']) k);
update public.intake_invitations set revoked_at = now(), revoked_reason = 'resent' where id = pg_temp.part(pg_temp.kv('q_rev'), 7)::uuid;
select pg_temp.own(format('insert into public.intake_invitations (id, studio_id, request_id, audience, generation, kid, token_salt, token_hash, issued_by, pinned_version_id, expires_at, recipient_email_hmac, recipient_email_hmac_kid) select %L, studio_id, request_id, audience, generation + 1, kid, token_salt, decode(%L, ''hex''), issued_by, pinned_version_id, expires_at, recipient_email_hmac, recipient_email_hmac_kid from public.intake_invitations where id = %L', gen_random_uuid(), pg_temp.hx('q_old_next'), pg_temp.part(pg_temp.kv('q_old'), 7)));
select pg_temp.own(format('update public.intake_email_challenges set email_hmac = ''different'' where id = %L', pg_temp.kv('ch_q_hash')));
select pg_temp.setkv('p_' || k, pg_temp.promote(pg_temp.part(pg_temp.kv(k), 9))) from unnest(array['q_none', 'q_open', 'q_ok', 'q_rev', 'q_old', 'q_hash']) k;
select pg_temp.setkv('p_q_null', pg_temp.promote(pg_temp.part(pg_temp.kv('q_null'), 9), ', email_hmac = null, email_hmac_kid = null'));
select pg_temp.setkv('p_back', pg_temp.try(format('update public.intake_respondents set assurance = ''declared_unverified'' where id = %L', pg_temp.part(pg_temp.kv('q_ok'), 9))));
select pg_temp.setkv('p_red', pg_temp.try(format('update public.intake_respondents set email_hmac = null, email_hmac_kid = null where id = %L', pg_temp.part(pg_temp.kv('q_red'), 9))));
select pg_temp.setkv('p_reset', pg_temp.try(format('update public.intake_respondents set email_hmac = ''z'', email_hmac_kid = 1 where id = %L', pg_temp.part(pg_temp.kv('q_red'), 9))));
select pg_temp.chk('B10 email_code_verified needs a consumed challenge of the latest unrevoked guardian invitation for exactly the stored non-null hash; nothing else, and no way back; value-to-null redaction stays allowed and null-to-value stays refused',
  pg_temp.kv('p_q_ok') = 'ok' and pg_temp.kv('p_q_none') like '42501%' and pg_temp.kv('p_q_open') like '42501%' and pg_temp.kv('p_q_rev') like '42501%' and pg_temp.kv('p_q_old') like '42501%'
  and pg_temp.kv('p_q_hash') like '42501%' and pg_temp.kv('p_q_null') like '42501%' and pg_temp.kv('p_back') like '42501%' and pg_temp.kv('p_red') = 'ok' and pg_temp.kv('p_reset') like '42501%',
  concat_ws(' | ', pg_temp.kv('p_q_ok'), pg_temp.kv('p_q_none'), pg_temp.kv('p_q_open'), pg_temp.kv('p_q_rev'), pg_temp.kv('p_q_old'), pg_temp.kv('p_q_hash'), pg_temp.kv('p_q_null')));

-- ===== B11 erase and holds =============================================================================================
select pg_temp.clear_limits();
create or replace function pg_temp.loaded() returns text language plpgsql as $f$
declare g text := pg_temp.gset(); c uuid;
begin
  c := pg_temp.mkch(g, '2 minutes', true);
  update public.intake_email_challenges set consumed_at = now() where id = c;
  perform pg_temp.mkch(g, '1 minute', true);
  return g;
end $f$;
select pg_temp.setkv('e1', pg_temp.loaded()); select pg_temp.setkv('e2', pg_temp.loaded());
select pg_temp.greq('owner_a', pg_temp.part(pg_temp.kv('e1'), 1), 'still-open');
select pg_temp.setkv('e_hold', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_create_legal_hold(%L, ''client'', %L, ''m16b'', ''m16b'', now() + interval ''30 days'')::text', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('e2'), 4))));
select pg_temp.setkv('e_erase', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_erase_client(%L, %L, ''data_subject_request'')::text', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('e1'), 4))));
select pg_temp.setkv('e_held', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_erase_client(%L, %L, ''data_subject_request'')::text', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('e2'), 4))));
select pg_temp.chk('B11 erase removes challenges and pending requests with the rest (counts reported) without a foreign-key failure; a held client keeps everything',
  pg_temp.kv('e_erase') like '%"outcome": "erased"%' and pg_temp.kv('e_erase') like '%"email_challenges": 2%' and pg_temp.kv('e_erase') like '%"invitation_requests": 2%'
  and not exists (select 1 from public.intake_email_challenges where client_id = pg_temp.part(pg_temp.kv('e1'), 4)::uuid)
  and not exists (select 1 from public.intake_guardian_invitation_requests where client_id = pg_temp.part(pg_temp.kv('e1'), 4)::uuid)
  and not exists (select 1 from public.intake_requests where id = pg_temp.part(pg_temp.kv('e1'), 1)::uuid)
  and pg_temp.is_uuid(pg_temp.kv('e_hold')) and pg_temp.kv('e_held') like '%legal_hold%'
  and (select count(*) = 2 from public.intake_email_challenges where client_id = pg_temp.part(pg_temp.kv('e2'), 4)::uuid)
  and (select count(*) = 1 from public.intake_guardian_invitation_requests where client_id = pg_temp.part(pg_temp.kv('e2'), 4)::uuid),
  pg_temp.kv('e_erase') || ' | ' || pg_temp.kv('e_held'));

-- ===== B12 purge =======================================================================================================
select pg_temp.clear_limits();
-- move a whole guardian path into the past: invitation expired p_inv ago, challenges expired p_ch ago, sessions long expired
create or replace function pg_temp.age(p_g text, p_inv text, p_ch text) returns void language plpgsql as $f$
declare r uuid := pg_temp.part(p_g, 1)::uuid;
begin
  perform pg_temp.own(format('update public.intake_invitations set expires_at = now() - %L::interval where request_id = %L and audience = ''guardian''', p_inv, r));
  perform pg_temp.own(format('update public.intake_email_challenges set expires_at = now() - %L::interval where request_id = %L', p_ch, r));
  perform pg_temp.own(format('update public.intake_sessions set created_at = now() - interval ''200 days'', absolute_expires_at = now() - interval ''150 days'', idle_expires_at = now() - interval ''150 days'' where request_id = %L', r));
end $f$;
select pg_temp.setkv(k, pg_temp.gset()) from unnest(array['u_all', 'u_cons', 'u_live', 'u_held', 'u_fresh', 'u_rev', 'u_young']) k;
select pg_temp.setkv('uc_' || k, pg_temp.mkch(pg_temp.kv(k), '120 days', true)::text) from unnest(array['u_all', 'u_cons', 'u_live', 'u_held', 'u_fresh', 'u_rev', 'u_young']) k;
update public.intake_email_challenges set consumed_at = now() where id = pg_temp.kv('uc_u_cons')::uuid;
select pg_temp.age(pg_temp.kv('u_all'), '100 days', '100 days');
select pg_temp.age(pg_temp.kv('u_cons'), '100 days', '100 days');
select pg_temp.age(pg_temp.kv('u_held'), '100 days', '100 days');
select pg_temp.age(pg_temp.kv('u_fresh'), '100 days', '1 hour');
select pg_temp.age(pg_temp.kv('u_young'), '2 days', '2 days');
-- live invitation (not expired, not revoked) with an old challenge; a revoked-long-ago invitation with an old challenge
select pg_temp.own(format('update public.intake_email_challenges set expires_at = now() - interval ''100 days'' where id in (%L, %L)', pg_temp.kv('uc_u_live'), pg_temp.kv('uc_u_rev')));
select pg_temp.own(format('update public.intake_invitations set revoked_at = now() - interval ''3 days'', revoked_reason = ''resent'' where id = %L', pg_temp.part(pg_temp.kv('u_rev'), 7)));
select pg_temp.setkv('u_hold', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_create_legal_hold(%L, ''client'', %L, ''m16b'', ''m16b'', now() + interval ''30 days'')::text', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('u_held'), 4))));
-- pending rows: open and past expiry, superseded and past expiry, superseded and not yet expired
select pg_temp.setkv('w_exp', pg_temp.pend('w_exp')); select pg_temp.setkv('w_sup', pg_temp.pend('w_sup')); select pg_temp.setkv('w_new', pg_temp.pend('w_new'));
update public.intake_guardian_invitation_requests set superseded_at = now() where id in (pg_temp.part(pg_temp.kv('w_sup'), 6)::uuid, pg_temp.part(pg_temp.kv('w_new'), 6)::uuid);
select pg_temp.own(format('update public.intake_guardian_invitation_requests set requested_at = now() - interval ''1 hour'', expires_at = now() - interval ''1 minute'' where id in (%L, %L)', pg_temp.part(pg_temp.kv('w_exp'), 6), pg_temp.part(pg_temp.kv('w_sup'), 6)));
select pg_temp.exch(pg_temp.part(pg_temp.kv('w_new'), 3), 'w-new-session');
select pg_temp.own(format('update public.intake_sessions set created_at = now() - interval ''200 days'', absolute_expires_at = now() - interval ''150 days'', idle_expires_at = now() - interval ''150 days'' where request_id in (%L, %L)',
  pg_temp.part(pg_temp.kv('w_new'), 1), pg_temp.part(pg_temp.kv('u_live'), 1)));
select pg_temp.setkv('purge', pg_temp.svc('select public.intake_purge_expired(500)::text'));
create or replace function pg_temp.has(p_g text) returns text language sql as $$
  select (select count(*) from public.intake_email_challenges where request_id = pg_temp.part(p_g, 1)::uuid)::text || '/'
      || (select count(*) from public.intake_guardian_invitation_requests where request_id = pg_temp.part(p_g, 1)::uuid)::text || '/'
      || (select count(*) from public.intake_invitations where request_id = pg_temp.part(p_g, 1)::uuid and audience = 'guardian')::text $$;
select pg_temp.chk('B12a purge removes an old guardian path in order (challenge, pending request, sessions, invitation) in one run and never aborts on a reference; challenges/pending/invitations left: 0/0/0',
  pg_temp.kv('purge') not like 'ERR%' and pg_temp.kv('purge') like '%"challenges"%' and pg_temp.kv('purge') like '%"invitation_requests"%' and pg_temp.has(pg_temp.kv('u_all')) = '0/0/0',
  pg_temp.kv('purge') || ' | ' || pg_temp.has(pg_temp.kv('u_all')));
select pg_temp.chk('B12b purge keeps consumed challenges with their invitation and finalized request; keeps an unconsumed challenge until both it and its invitation are a day past; a held client keeps everything; a young invitation keeps its finalized request',
  pg_temp.has(pg_temp.kv('u_cons')) = '1/1/1' and pg_temp.has(pg_temp.kv('u_live')) = '1/1/1' and pg_temp.has(pg_temp.kv('u_held')) = '1/1/1'
  and pg_temp.has(pg_temp.kv('u_fresh')) = '1/1/1' and pg_temp.has(pg_temp.kv('u_rev')) = '0/1/1' and pg_temp.has(pg_temp.kv('u_young')) = '0/1/1' and pg_temp.is_uuid(pg_temp.kv('u_hold')),
  concat_ws(' | ', pg_temp.has(pg_temp.kv('u_cons')), pg_temp.has(pg_temp.kv('u_live')), pg_temp.has(pg_temp.kv('u_held')), pg_temp.has(pg_temp.kv('u_fresh')), pg_temp.has(pg_temp.kv('u_rev')), pg_temp.has(pg_temp.kv('u_young'))));
select pg_temp.chk('B12c unfinalized and superseded requests are purged after expiry only',
  not exists (select 1 from public.intake_guardian_invitation_requests where id in (pg_temp.part(pg_temp.kv('w_exp'), 6)::uuid, pg_temp.part(pg_temp.kv('w_sup'), 6)::uuid))
  and exists (select 1 from public.intake_guardian_invitation_requests where id = pg_temp.part(pg_temp.kv('w_new'), 6)::uuid), '');

-- ===== B13 audit shape =================================================================================================
select pg_temp.chk('B13 every new event carries request and client references, only the audience, generation and count keys, and no hash, address or code',
  (select count(distinct event_type) = 4 and bool_and(request_ref is not null and client_ref is not null
          and (metadata - array['audience', 'generation', 'count']) = '{}'::jsonb and metadata ->> 'audience' = 'guardian'
          and metadata::text !~ 'hm-|@|right|hp-')
     from public.intake_audit_events where event_type in ('guardian_invitation_requested', 'guardian_invitation_issued', 'guardian_email_challenge_issued', 'guardian_email_verified'))
  and exists (select 1 from public.intake_audit_events where event_type = 'guardian_email_challenge_issued' and actor_type = 'guardian' and object_ref = pg_temp.kv('c9')::uuid)
  and exists (select 1 from public.intake_audit_events where event_type = 'guardian_email_verified' and actor_type = 'guardian' and object_ref = pg_temp.part(pg_temp.kv('g9'), 9)::uuid),
  '');

-- ===== B14 markers, ACLs, catalog ======================================================================================
select pg_temp.chk('B14a every M16b body carries the m16b marker and the function inventory is 122; the catalog self-check passes',
  (select count(*) = 16 and bool_and(position('nsi-body:m16b' in prosrc) > 0)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'intake_private') and proname in (
       'guardian_requests_insert_guard', 'guardian_requests_update_guard', 'challenges_insert_guard', 'challenges_update_guard',
       'intake_guardian_request_invitation', 'intake_guardian_finalize_invitation', 'intake_guardian_challenge_target', 'intake_issue_email_challenge',
       'intake_verify_email_challenge', 'respondents_guard', 'link_valid', 'invitations_update_guard', 'intake_issue_invitation', 'intake_revoke_invitations',
       'erase_client_impl', 'purge_expired_impl'))
  and (select count(*) = 122 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
  and pg_temp.try('select intake_private.assert_catalog()') = 'ok');
select pg_temp.chk('B14b privileges: request for authenticated only; the four server functions for service_role only; guards for nobody; the tables have no API privileges and the restricted role only SELECT and DELETE; erase and purge stay owned by the restricted role',
  (select bool_and(has_function_privilege(r, f, 'execute') = (r = want))
     from (values ('public.intake_guardian_request_invitation(uuid,uuid,text,smallint)', 'authenticated'),
                  ('public.intake_guardian_finalize_invitation(uuid,uuid,integer,text,bytea,bytea,timestamptz)', 'service_role'),
                  ('public.intake_guardian_challenge_target(bytea)', 'service_role'),
                  ('public.intake_issue_email_challenge(bytea,uuid,bytea,bytea,bytea,text,smallint)', 'service_role'),
                  ('public.intake_verify_email_challenge(bytea,uuid,bytea)', 'service_role'),
                  ('intake_private.guardian_requests_insert_guard()', 'none'), ('intake_private.guardian_requests_update_guard()', 'none'),
                  ('intake_private.challenges_insert_guard()', 'none'), ('intake_private.challenges_update_guard()', 'none')) v(f, want),
          unnest(array['anon', 'authenticated', 'service_role', 'intake_destructive']) r)
  and (select bool_and(not has_table_privilege(r, t, p)) from unnest(array['anon', 'authenticated', 'service_role']) r,
          unnest(array['public.intake_guardian_invitation_requests', 'public.intake_email_challenges']) t, unnest(array['select', 'insert', 'update', 'delete']) p)
  and (select bool_and(has_table_privilege('intake_destructive', t, 'select') and has_table_privilege('intake_destructive', t, 'delete')
          and not has_table_privilege('intake_destructive', t, 'insert') and not has_table_privilege('intake_destructive', t, 'update'))
         from unnest(array['public.intake_guardian_invitation_requests', 'public.intake_email_challenges']) t)
  and (select count(*) = 2 and bool_and(pg_get_userbyid(proowner) = 'intake_destructive') from pg_proc where proname in ('erase_client_impl', 'purge_expired_impl'))
  and (select count(*) = 10 from pg_trigger where tgrelid in ('public.intake_guardian_invitation_requests'::regclass, 'public.intake_email_challenges'::regclass) and not tgisinternal));

-- ===== result =========================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I3-2 M16b SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I3-2 M16b SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

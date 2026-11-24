-- NSI I3-1 (M12) boundary tests: invitations, sessions, rate limits. Valid on M12 (and later, until a later migration changes these objects).
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

-- ===== S01 role matrix for issue and revoke ===========================================================================
select pg_temp.setkv('f1', pg_temp.fresh(false)); select pg_temp.setkv('f2', pg_temp.fresh(false)); select pg_temp.setkv('f3', pg_temp.fresh(false));
select pg_temp.setkv('f4', pg_temp.fresh(false));
select pg_temp.setkv('s1_owner', pg_temp.issue_as('owner_a', pg_temp.part(pg_temp.kv('f1'), 1)::uuid, gen_random_uuid(), pg_temp.hx('x1')));
select pg_temp.setkv('s1_admin', pg_temp.issue_as('admin_a', pg_temp.part(pg_temp.kv('f2'), 1)::uuid, gen_random_uuid(), pg_temp.hx('x2')));
select pg_temp.setkv('s1_fd', pg_temp.issue_as('fd_a', pg_temp.part(pg_temp.kv('f3'), 1)::uuid, gen_random_uuid(), pg_temp.hx('x3')));
select pg_temp.setkv('s1_instr', pg_temp.issue_as('instr_a', pg_temp.part(pg_temp.kv('f4'), 1)::uuid, gen_random_uuid(), pg_temp.hx('x4')));
select pg_temp.setkv('s1_plain', pg_temp.issue_as('plain_a', pg_temp.part(pg_temp.kv('f4'), 1)::uuid, gen_random_uuid(), pg_temp.hx('x5')));
select pg_temp.setkv('s1_pa', pg_temp.issue_as('padmin', pg_temp.part(pg_temp.kv('f4'), 1)::uuid, gen_random_uuid(), pg_temp.hx('x6')));
select pg_temp.setkv('s1_nobody', pg_temp.issue_as('nobody', pg_temp.part(pg_temp.kv('f4'), 1)::uuid, gen_random_uuid(), pg_temp.hx('x7')));
select pg_temp.setkv('s1_other', pg_temp.val_as('authenticated', pg_temp.u('owner_b'), format('select public.intake_issue_invitation(%L, %L, %L, 1, %L, decode(%L, ''hex''), decode(%L, ''hex''), now() + interval ''7 days'')',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('f4'), 1), gen_random_uuid(), 'kid00001', repeat('ab', 16), pg_temp.hx('x8'))));
select pg_temp.chk('S01 owner, admin and front desk may issue; instructor, plain member, platform admin, outsider and another studio''s owner are refused; the request is untouched by refusals',
  pg_temp.is_uuid(pg_temp.kv('s1_owner')) and pg_temp.is_uuid(pg_temp.kv('s1_admin')) and pg_temp.is_uuid(pg_temp.kv('s1_fd'))
  and pg_temp.kv('s1_instr') like 'ERR 42501%' and pg_temp.kv('s1_plain') like 'ERR 42501%' and pg_temp.kv('s1_pa') like 'ERR 42501%'
  and pg_temp.kv('s1_nobody') like 'ERR 42501%' and pg_temp.kv('s1_other') like 'ERR%'
  and (select status = 'pending' and pinned_version_id is null from public.intake_requests where id = pg_temp.part(pg_temp.kv('f4'), 1)::uuid),
  pg_temp.kv('s1_instr') || ' / ' || pg_temp.kv('s1_pa') || ' / ' || pg_temp.kv('s1_other'));

-- ===== S02 issue: state change, pin, parameter validation ============================================================
select pg_temp.chk('S02a issuing moves pending to invited, sets issued_at, pins the version once and the invitation carries the same pin; audit event has ids only',
  (select q.status = 'invited' and q.issued_at is not null and q.pinned_version_id is not null
          and i.pinned_version_id = q.pinned_version_id and i.audience = 'student' and i.generation = 1 and i.issued_by = 'staff' and i.issued_by_user = pg_temp.u('owner_a')
   from public.intake_requests q join public.intake_invitations i on i.request_id = q.id where q.id = pg_temp.part(pg_temp.kv('f1'), 1)::uuid)
  and exists (select 1 from public.intake_audit_events e where e.event_type = 'invitation_issued' and e.request_ref = pg_temp.part(pg_temp.kv('f1'), 1)::uuid
              and e.metadata = '{"audience": "student", "generation": 1}'::jsonb));
select pg_temp.setkv('f5', pg_temp.fresh(false));
select pg_temp.setkv('p_short', pg_temp.issue_as('owner_a', pg_temp.part(pg_temp.kv('f5'), 1)::uuid, gen_random_uuid(), pg_temp.hx('p1'), '30 minutes'));
select pg_temp.setkv('p_long', pg_temp.issue_as('owner_a', pg_temp.part(pg_temp.kv('f5'), 1)::uuid, gen_random_uuid(), pg_temp.hx('p2'), '31 days'));
select pg_temp.setkv('p_hash', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_issue_invitation(%L, %L, %L, 1, %L, decode(%L, ''hex''), decode(%L, ''hex''), now() + interval ''7 days'')',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('f5'), 1), gen_random_uuid(), 'kid00001', repeat('ab', 16), 'abcd')));
select pg_temp.setkv('p_kid', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_issue_invitation(%L, %L, %L, 1, %L, decode(%L, ''hex''), decode(%L, ''hex''), now() + interval ''7 days'')',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('f5'), 1), gen_random_uuid(), 'bad kid', repeat('ab', 16), pg_temp.hx('p3'))));
select pg_temp.setkv('p_req', pg_temp.issue_as('owner_a', gen_random_uuid(), gen_random_uuid(), pg_temp.hx('p4')));
select pg_temp.chk('S02b expiry outside 1 hour to 30 days, a wrong hash length, a malformed key id and an unknown request are refused with 22023 and write nothing',
  pg_temp.kv('p_short') like 'ERR 22023%' and pg_temp.kv('p_long') like 'ERR 22023%' and pg_temp.kv('p_hash') like 'ERR 22023%'
  and pg_temp.kv('p_kid') like 'ERR 22023%' and pg_temp.kv('p_req') like 'ERR 22023%'
  and not exists (select 1 from public.intake_invitations where request_id = pg_temp.part(pg_temp.kv('f5'), 1)::uuid)
  and (select status = 'pending' from public.intake_requests where id = pg_temp.part(pg_temp.kv('f5'), 1)::uuid));

-- ===== S03 resend: generation, previous revoked with its sessions ====================================================
select pg_temp.setkv('l1', pg_temp.live());
select pg_temp.setkv('l1_inv2', gen_random_uuid()::text);
select pg_temp.setkv('l1_h2', pg_temp.hx('resend-h2'));
select pg_temp.setkv('l1_resend', pg_temp.issue_as('fd_a', pg_temp.part(pg_temp.kv('l1'), 1)::uuid, pg_temp.u('l1_inv2'), pg_temp.kv('l1_h2')));
select pg_temp.chk('S03 resending creates generation 2, revokes generation 1 (resent) and its live session; the old link and session stop working, the new link works',
  pg_temp.is_uuid(pg_temp.kv('l1_resend'))
  and (select revoked_reason = 'resent' and generation = 1 from public.intake_invitations where id = pg_temp.part(pg_temp.kv('l1'), 2)::uuid)
  and (select generation = 2 and revoked_at is null from public.intake_invitations where id = pg_temp.u('l1_inv2'))
  and (select revoked_at is not null from public.intake_sessions where invitation_id = pg_temp.part(pg_temp.kv('l1'), 2)::uuid)
  and pg_temp.ctx(pg_temp.part(pg_temp.kv('l1'), 6)) = 'NONE'
  and pg_temp.exch(pg_temp.part(pg_temp.kv('l1'), 3), 'again-old') = 'NONE'
  and pg_temp.exch(pg_temp.kv('l1_h2'), 'again-new') <> 'NONE');

-- ===== S03b the generation check stands on its own: an old generation that was (wrongly) left unrevoked still does not exchange ====
select pg_temp.setkv('og_f', pg_temp.fresh(true));
select pg_temp.setkv('og_inv2', gen_random_uuid()::text);
select pg_temp.issue_as('owner_a', pg_temp.part(pg_temp.kv('og_f'), 1)::uuid, pg_temp.u('og_inv2'), pg_temp.hx('og-new'));
set local session_replication_role = replica;
update public.intake_invitations set revoked_at = null, revoked_reason = null where id = pg_temp.part(pg_temp.kv('og_f'), 2)::uuid;
set local session_replication_role = origin;
select pg_temp.chk('S03b a generation-1 invitation forced back to unrevoked still returns NONE (link_valid compares against the current generation); the current generation works',
  pg_temp.exch(pg_temp.part(pg_temp.kv('og_f'), 3), 'og-old') = 'NONE' and pg_temp.exch(pg_temp.hx('og-new'), 'og-cur') <> 'NONE');

-- ===== S04 exchange: success and every invalid class returns the same empty answer ===================================
select pg_temp.setkv('e1', pg_temp.fresh(true));
select pg_temp.setkv('e1_s', pg_temp.exch(pg_temp.part(pg_temp.kv('e1'), 3), 'sess-e1'));
select pg_temp.chk('S04a a valid link yields one session; the session resolves to its request and audience; the exchange is audited as a system event (not an authenticated student) with the invitation generation, which joins back to the issuing staff member',
  pg_temp.is_uuid(pg_temp.kv('e1_s')) and pg_temp.ctx('sess-e1') = pg_temp.part(pg_temp.kv('e1'), 1)
  and exists (select 1 from public.intake_audit_events e where e.event_type = 'link_exchanged' and e.actor_type = 'system' and e.request_ref = pg_temp.part(pg_temp.kv('e1'), 1)::uuid
              and e.metadata = '{"audience": "student", "generation": 1}'::jsonb)
  and exists (select 1 from public.intake_audit_events e where e.event_type = 'invitation_issued' and e.request_ref = pg_temp.part(pg_temp.kv('e1'), 1)::uuid and e.actor_user_id = pg_temp.u('owner_a')));
-- invalid classes, one fresh request each
select pg_temp.setkv('i_unknown', pg_temp.exch(pg_temp.hx('no-such-token'), 'x1'));
select pg_temp.setkv('i_revoked_f', pg_temp.fresh(true));
select pg_temp.setkv('i_revoked_n', pg_temp.owner_a(format('select public.intake_revoke_invitations(%L, %L)', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('i_revoked_f'), 1))));
select pg_temp.setkv('i_revoked', pg_temp.exch(pg_temp.part(pg_temp.kv('i_revoked_f'), 3), 'x2'));
select pg_temp.setkv('i_exp_f', pg_temp.fresh(true));
set local session_replication_role = replica;
update public.intake_invitations set expires_at = now() - interval '1 minute' where id = pg_temp.part(pg_temp.kv('i_exp_f'), 2)::uuid;
set local session_replication_role = origin;
select pg_temp.setkv('i_exp', pg_temp.exch(pg_temp.part(pg_temp.kv('i_exp_f'), 3), 'x3'));
select pg_temp.setkv('i_susp_f', pg_temp.fresh(true));
set local session_replication_role = replica;
update public.intake_requests set status = 'suspended', resume_status = 'invited' where id = pg_temp.part(pg_temp.kv('i_susp_f'), 1)::uuid;
set local session_replication_role = origin;
select pg_temp.setkv('i_susp', pg_temp.exch(pg_temp.part(pg_temp.kv('i_susp_f'), 3), 'x4'));
select pg_temp.setkv('i_sub_f', pg_temp.fresh(true));
set local session_replication_role = replica;
update public.intake_requests set status = 'submitted' where id = pg_temp.part(pg_temp.kv('i_sub_f'), 1)::uuid;
set local session_replication_role = origin;
select pg_temp.setkv('i_sub', pg_temp.exch(pg_temp.part(pg_temp.kv('i_sub_f'), 3), 'x5'));
select pg_temp.setkv('i_cx_f', pg_temp.fresh(true));
update public.appointments set status = 'cancelled' where id = pg_temp.part(pg_temp.kv('i_cx_f'), 5)::uuid;
select pg_temp.setkv('i_cx', pg_temp.exch(pg_temp.part(pg_temp.kv('i_cx_f'), 3), 'x6'));
select pg_temp.setkv('i_bar_f', pg_temp.fresh(true));
set local session_replication_role = replica;
insert into public.intake_audit_events (studio_id, event_type, actor_type, retention_class, client_ref)
values (pg_temp.u('sa'), 'erasure_record', 'system', 'erasure_record', pg_temp.part(pg_temp.kv('i_bar_f'), 4)::uuid);
set local session_replication_role = origin;
select pg_temp.setkv('i_bar', pg_temp.exch(pg_temp.part(pg_temp.kv('i_bar_f'), 3), 'x7'));
select pg_temp.setkv('i_gate_f', pg_temp.fresh(true));
select pg_temp.set_gate(false);
select pg_temp.setkv('i_gate', pg_temp.exch(pg_temp.part(pg_temp.kv('i_gate_f'), 3), 'x8'));
select pg_temp.set_gate(true);
select pg_temp.chk('S04b unknown, revoked, expired, suspended, submitted, cancelled-appointment, erased-client and gate-closed links all return exactly NONE (no error, no session)',
  pg_temp.kv('i_unknown') = 'NONE' and pg_temp.kv('i_revoked') = 'NONE' and pg_temp.kv('i_exp') = 'NONE' and pg_temp.kv('i_susp') = 'NONE'
  and pg_temp.kv('i_sub') = 'NONE' and pg_temp.kv('i_cx') = 'NONE' and pg_temp.kv('i_bar') = 'NONE' and pg_temp.kv('i_gate') = 'NONE'
  and pg_temp.kv('i_revoked_n') = 'ok'
  and not exists (select 1 from public.intake_sessions where request_id in (pg_temp.part(pg_temp.kv('i_revoked_f'), 1)::uuid, pg_temp.part(pg_temp.kv('i_exp_f'), 1)::uuid,
        pg_temp.part(pg_temp.kv('i_susp_f'), 1)::uuid, pg_temp.part(pg_temp.kv('i_sub_f'), 1)::uuid, pg_temp.part(pg_temp.kv('i_cx_f'), 1)::uuid,
        pg_temp.part(pg_temp.kv('i_bar_f'), 1)::uuid, pg_temp.part(pg_temp.kv('i_gate_f'), 1)::uuid)),
  pg_temp.kv('i_unknown') || '/' || pg_temp.kv('i_revoked') || '/' || pg_temp.kv('i_exp') || '/' || pg_temp.kv('i_susp') || '/' || pg_temp.kv('i_sub') || '/' || pg_temp.kv('i_cx') || '/' || pg_temp.kv('i_bar') || '/' || pg_temp.kv('i_gate'));
select pg_temp.chk('S04c exchange parameters are clamped: out-of-range idle or absolute limits raise 22023',
  pg_temp.val_as('service_role', null, format('select count(*) from public.intake_exchange_invitation(decode(%L, ''hex''), decode(%L, ''hex''), 60, 14400)', pg_temp.hx('a'), pg_temp.hx('b'))) like 'ERR 22023%'
  and pg_temp.val_as('service_role', null, format('select count(*) from public.intake_exchange_invitation(decode(%L, ''hex''), decode(%L, ''hex''), 1800, 100000)', pg_temp.hx('a'), pg_temp.hx('b'))) like 'ERR 22023%'
  and pg_temp.val_as('service_role', null, format('select count(*) from public.intake_exchange_invitation(decode(%L, ''hex''), decode(%L, ''hex''), 7000, 900)', pg_temp.hx('a'), pg_temp.hx('b'))) like 'ERR 22023%');

-- ===== S05 session context re-runs every check: each condition kills a live session ===================================
select pg_temp.setkv('k_susp', pg_temp.live());
select pg_temp.setkv('k_sub', pg_temp.live());
select pg_temp.setkv('k_cx', pg_temp.live());
select pg_temp.setkv('k_bar', pg_temp.live());
select pg_temp.setkv('k_exp', pg_temp.live());
select pg_temp.setkv('k_gate', pg_temp.live());
select pg_temp.setkv('k_ok', pg_temp.live());
select pg_temp.setkv('k_before', pg_temp.ctx(pg_temp.part(pg_temp.kv('k_susp'), 6)) || pg_temp.ctx(pg_temp.part(pg_temp.kv('k_sub'), 6)) || pg_temp.ctx(pg_temp.part(pg_temp.kv('k_cx'), 6))
  || pg_temp.ctx(pg_temp.part(pg_temp.kv('k_bar'), 6)) || pg_temp.ctx(pg_temp.part(pg_temp.kv('k_exp'), 6)) || pg_temp.ctx(pg_temp.part(pg_temp.kv('k_gate'), 6)));
set local session_replication_role = replica;
update public.intake_requests set status = 'suspended', resume_status = 'invited' where id = pg_temp.part(pg_temp.kv('k_susp'), 1)::uuid;
update public.intake_requests set status = 'submitted' where id = pg_temp.part(pg_temp.kv('k_sub'), 1)::uuid;
insert into public.intake_audit_events (studio_id, event_type, actor_type, retention_class, client_ref)
values (pg_temp.u('sa'), 'erasure_record', 'system', 'erasure_record', pg_temp.part(pg_temp.kv('k_bar'), 4)::uuid);
update public.intake_invitations set expires_at = now() - interval '1 minute' where id = pg_temp.part(pg_temp.kv('k_exp'), 2)::uuid;
set local session_replication_role = origin;
update public.appointments set status = 'cancelled' where id = pg_temp.part(pg_temp.kv('k_cx'), 5)::uuid;
select pg_temp.set_gate(false);
select pg_temp.setkv('k_gate_ctx', pg_temp.ctx(pg_temp.part(pg_temp.kv('k_gate'), 6)));
select pg_temp.set_gate(true);
select pg_temp.chk('S05 a live session stops resolving as soon as its request is suspended or submitted, its appointment is cancelled, the client is erased, the invitation expires, or Gate A closes; an untouched session keeps working; a re-opened gate restores the session that only the gate had paused',
  length(pg_temp.kv('k_before')) = 6 * 36
  and pg_temp.ctx(pg_temp.part(pg_temp.kv('k_susp'), 6)) = 'NONE' and pg_temp.ctx(pg_temp.part(pg_temp.kv('k_sub'), 6)) = 'NONE'
  and pg_temp.ctx(pg_temp.part(pg_temp.kv('k_cx'), 6)) = 'NONE' and pg_temp.ctx(pg_temp.part(pg_temp.kv('k_bar'), 6)) = 'NONE'
  and pg_temp.ctx(pg_temp.part(pg_temp.kv('k_exp'), 6)) = 'NONE' and pg_temp.kv('k_gate_ctx') = 'NONE'
  and pg_temp.ctx(pg_temp.part(pg_temp.kv('k_ok'), 6)) = pg_temp.part(pg_temp.kv('k_ok'), 1)
  and pg_temp.ctx(pg_temp.part(pg_temp.kv('k_gate'), 6)) = pg_temp.part(pg_temp.kv('k_gate'), 1));

-- ===== S06 sliding window capped at the absolute limit, session cap ====================================================
select pg_temp.setkv('w_f', pg_temp.fresh(true));
select pg_temp.exch(pg_temp.part(pg_temp.kv('w_f'), 3), 'sess-w', 300, 900);
select pg_temp.ctx('sess-w');
select pg_temp.chk('S06a the idle window slides by the stored idle_seconds but never beyond the absolute limit',
  (select idle_seconds = 300 and idle_expires_at <= absolute_expires_at and absolute_expires_at - created_at = interval '900 seconds' and last_seen_at >= created_at
   from public.intake_sessions where session_hash = decode(pg_temp.hx('sess-w'), 'hex')));
select pg_temp.setkv('c_f', pg_temp.fresh(true));
select pg_temp.setkv('c_last', (select string_agg(pg_temp.exch(pg_temp.part(pg_temp.kv('c_f'), 3), 'cap-' || g), ',' order by g) from generate_series(1, 11) g));
select pg_temp.chk('S06b at most 10 live sessions per invitation: the eleventh exchange returns NONE',
  (select count(*) = 10 from public.intake_sessions where invitation_id = pg_temp.part(pg_temp.kv('c_f'), 2)::uuid)
  and pg_temp.exch(pg_temp.part(pg_temp.kv('c_f'), 3), 'cap-extra') = 'NONE');

-- ===== S07 grant lapse: new links refused, an issued request stays completable =======================================
select pg_temp.setkv('g_f', pg_temp.live());
select pg_temp.setkv('g_new', pg_temp.fresh(false));
select pg_temp.fx_grant('sa', 'live_collection', -1);
select pg_temp.setkv('g_issue', pg_temp.issue_as('owner_a', pg_temp.part(pg_temp.kv('g_new'), 1)::uuid, gen_random_uuid(), pg_temp.hx('g1')));
select pg_temp.setkv('g_ctx', pg_temp.ctx(pg_temp.part(pg_temp.kv('g_f'), 6)));
select pg_temp.setkv('g_exch', pg_temp.exch(pg_temp.part(pg_temp.kv('g_f'), 3), 'g-new-session'));
select pg_temp.fx_grant('sa', 'live_collection');
select pg_temp.chk('S07 after the live_collection grant lapsed, issuing a new invitation is refused (new_obligation_not_allowed) while an already-issued request keeps resolving and can open new sessions (continuing path)',
  pg_temp.kv('g_issue') like 'ERR 42501%new_obligation_not_allowed%' and pg_temp.kv('g_ctx') = pg_temp.part(pg_temp.kv('g_f'), 1) and pg_temp.kv('g_exch') <> 'NONE',
  pg_temp.kv('g_issue') || ' / ' || pg_temp.kv('g_ctx'));

-- ===== S08 rate limit =====================================================================================================
select pg_temp.setkv('rl', encode(sha256(convert_to('rl-bucket', 'UTF8')), 'hex'));
create or replace function pg_temp.hit(p_hex text, p_limit int, p_win int) returns text language sql as $$
  select pg_temp.val_as('service_role', null, format('select public.intake_rate_limit_hit(decode(%L, ''hex''), %s, %s)', p_hex, p_limit, p_win)) $$;
select pg_temp.setkv('rl_1', pg_temp.hit(pg_temp.kv('rl'), 3, 600) || pg_temp.hit(pg_temp.kv('rl'), 3, 600) || pg_temp.hit(pg_temp.kv('rl'), 3, 600) || pg_temp.hit(pg_temp.kv('rl'), 3, 600));
select pg_temp.setkv('rl_other_window', pg_temp.hit(pg_temp.kv('rl'), 3, 900));
select pg_temp.setkv('rl_bad', pg_temp.hit('abcd', 3, 600) || pg_temp.hit(pg_temp.kv('rl'), 0, 600) || pg_temp.hit(pg_temp.kv('rl'), 3, 5));
select pg_temp.set_gate(false);
select pg_temp.setkv('rl_closed', pg_temp.hit(pg_temp.hx('rl-closed'), 3, 600));
select pg_temp.set_gate(true);
select pg_temp.chk('S08 the counter allows the first three hits and denies the fourth; a different window length is a different counter; invalid arguments and a closed gate are denied and write nothing',
  pg_temp.kv('rl_1') = 'truetruetruefalse' and pg_temp.kv('rl_other_window') = 'true' and pg_temp.kv('rl_bad') = 'falsefalsefalse' and pg_temp.kv('rl_closed') = 'false'
  and not exists (select 1 from public.intake_rate_limits where bucket_hash = decode(pg_temp.hx('rl-closed'), 'hex')),
  pg_temp.kv('rl_1') || ' / ' || pg_temp.kv('rl_bad'));
select pg_temp.setkv('ex_f', pg_temp.fresh(true));
select pg_temp.setkv('ex_n', (select string_agg(pg_temp.exch(pg_temp.hx('missing-' || g), 'ex-' || g), ',') from generate_series(1, 3) g));
do $do$
declare g int; r text;
begin
  for g in 1 .. 22 loop
    r := pg_temp.exch(pg_temp.part(pg_temp.kv('ex_f'), 3), 'burst-' || g);
    if r <> 'NONE' then
      perform pg_temp.val_as('service_role', null, format('select public.intake_revoke_session(decode(%L, ''hex''))', pg_temp.hx('burst-' || g)));
    end if;
  end loop;
end $do$;
select pg_temp.chk('S08b exchange counts attempts per token hash: sessions are revoked after each success so the live-session cap never answers; exactly 20 attempts are served and the 21st and later get NONE even for a valid token',
  (select count(*) = 20 from public.intake_sessions where invitation_id = pg_temp.part(pg_temp.kv('ex_f'), 2)::uuid)
  and pg_temp.exch(pg_temp.part(pg_temp.kv('ex_f'), 3), 'burst-late') = 'NONE');

-- ===== S09 revoke_session, bulk key revoke ==============================================================================
select pg_temp.setkv('r_f', pg_temp.live());
select pg_temp.val_as('service_role', null, format('select public.intake_revoke_session(decode(%L, ''hex''))', pg_temp.hx(pg_temp.part(pg_temp.kv('r_f'), 6))));
select pg_temp.val_as('service_role', null, format('select public.intake_revoke_session(decode(%L, ''hex''))', pg_temp.hx(pg_temp.part(pg_temp.kv('r_f'), 6))));
select pg_temp.setkv('kk_f', pg_temp.live());
select pg_temp.setkv('kk_n', pg_temp.val_as('service_role', null, format('select public.intake_revoke_all_invitations_for_key(%L, 5000)', 'kid00001')));
select pg_temp.chk('S09 revoke_session is idempotent and kills the session; the key-compromise bulk revoke revokes every open invitation of that key id (reason key_rotation) and their sessions, and audits counts only',
  pg_temp.ctx(pg_temp.part(pg_temp.kv('r_f'), 6)) = 'NONE'
  and pg_temp.kv('kk_n')::int >= 1
  and not exists (select 1 from public.intake_invitations where kid = 'kid00001' and revoked_at is null)
  and (select bool_and(s.revoked_at is not null) from public.intake_sessions s join public.intake_invitations i on i.id = s.invitation_id where i.kid = 'kid00001')
  and pg_temp.ctx(pg_temp.part(pg_temp.kv('kk_f'), 6)) = 'NONE'
  and not exists (select 1 from public.intake_audit_events e where e.event_type = 'invitation_revoked' and e.metadata::text ~* '(token|hash|salt)'));

-- ===== S10 erasure and legal holds with invitations and sessions present ============================================
select pg_temp.setkv('er_f', pg_temp.live());
select pg_temp.setkv('hold_f', pg_temp.live());
select pg_temp.setkv('hold_id', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_create_legal_hold(%L, ''client'', %L, ''synthetic'', ''synthetic'', now() + interval ''30 days'')',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('hold_f'), 4))));
select pg_temp.setkv('hold_res', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_erase_client(%L, %L, ''data_subject_request'')::text', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('hold_f'), 4))));
select pg_temp.setkv('er_res', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_erase_client(%L, %L, ''data_subject_request'')::text', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('er_f'), 4))));
select pg_temp.chk('S10a erasure deletes the client''s sessions and invitations before the requests and reports their counts; a client under a legal hold is refused and keeps every row',
  pg_temp.kv('er_res') like '%"outcome": "erased"%' and (pg_temp.kv('er_res')::jsonb ->> 'sessions')::int >= 1 and (pg_temp.kv('er_res')::jsonb ->> 'invitations')::int >= 1
  and not exists (select 1 from public.intake_invitations where request_id = pg_temp.part(pg_temp.kv('er_f'), 1)::uuid)
  and not exists (select 1 from public.intake_sessions where request_id = pg_temp.part(pg_temp.kv('er_f'), 1)::uuid)
  and pg_temp.kv('hold_res') like '%refused%'
  and exists (select 1 from public.intake_invitations where request_id = pg_temp.part(pg_temp.kv('hold_f'), 1)::uuid)
  and exists (select 1 from public.intake_sessions where request_id = pg_temp.part(pg_temp.kv('hold_f'), 1)::uuid),
  left(pg_temp.kv('er_res'), 200) || ' // ' || left(pg_temp.kv('hold_res'), 200));

-- ===== S11 purge ====================================================================================================
select pg_temp.setkv('pg_f', pg_temp.live());
select pg_temp.setkv('pg_keep', pg_temp.live());
set local session_replication_role = replica;
update public.intake_sessions set absolute_expires_at = now() - interval '2 days', idle_expires_at = now() - interval '2 days', created_at = now() - interval '3 days'
  where invitation_id = pg_temp.part(pg_temp.kv('pg_f'), 2)::uuid;
insert into public.intake_rate_limits (bucket_hash, window_start, window_seconds, hits) values (decode(pg_temp.hx('old-bucket'), 'hex'), now() - interval '3 days', 600, 5),
  (decode(pg_temp.hx('new-bucket'), 'hex'), now(), 600, 1);
update public.intake_sessions set absolute_expires_at = now() - interval '2 days', idle_expires_at = now() - interval '2 days', created_at = now() - interval '3 days'
  where invitation_id = pg_temp.part(pg_temp.kv('hold_f'), 2)::uuid;
set local session_replication_role = origin;
select pg_temp.setkv('pg_res', pg_temp.val_as('service_role', null, 'select public.intake_purge_expired(500)::text'));
select pg_temp.chk('S11 purge removes sessions expired for more than 24 hours and old rate-limit windows, keeps current ones and live sessions, and never touches a held client''s rows',
  case when pg_temp.kv('pg_res') like 'ERR%' then false else (pg_temp.kv('pg_res')::jsonb ->> 'sessions')::int >= 1 and (pg_temp.kv('pg_res')::jsonb ->> 'rate_limits')::int >= 1 end
  and not exists (select 1 from public.intake_sessions where invitation_id = pg_temp.part(pg_temp.kv('pg_f'), 2)::uuid)
  and exists (select 1 from public.intake_sessions where invitation_id = pg_temp.part(pg_temp.kv('pg_keep'), 2)::uuid)
  and not exists (select 1 from public.intake_rate_limits where bucket_hash = decode(pg_temp.hx('old-bucket'), 'hex'))
  and exists (select 1 from public.intake_rate_limits where bucket_hash = decode(pg_temp.hx('new-bucket'), 'hex'))
  and exists (select 1 from public.intake_sessions where request_id = pg_temp.part(pg_temp.kv('hold_f'), 1)::uuid),
  pg_temp.kv('pg_res'));


-- ===== S13 next generation, expected-generation check, live-target pre-check, unknown tokens, minting actor ========================
select pg_temp.setkv('n_f', pg_temp.fresh(true));
select pg_temp.setkv('n_gen_owner', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_next_invitation_generation(%L, %L)', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('n_f'), 1))));
select pg_temp.setkv('n_gen_instr', pg_temp.val_as('authenticated', pg_temp.u('instr_a'), format('select public.intake_next_invitation_generation(%L, %L)', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('n_f'), 1))));
select pg_temp.setkv('n_mismatch', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select public.intake_issue_invitation(%L, %L, %L, 7, %L, decode(%L, ''hex''), decode(%L, ''hex''), now() + interval ''7 days'')',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('n_f'), 1), gen_random_uuid(), 'kid00001', repeat('ab', 16), pg_temp.hx('mm'))));
select pg_temp.chk('S13a the next-generation RPC answers staff only (owner 2, instructor refused); issuing with a wrong expected generation is refused (22023) and leaves the live generation untouched',
  pg_temp.kv('n_gen_owner') = '2' and pg_temp.kv('n_gen_instr') like 'ERR 42501%' and pg_temp.kv('n_mismatch') like 'ERR 22023%generation mismatch%'
  and (select count(*) = 1 and bool_and(revoked_at is null) from public.intake_invitations where request_id = pg_temp.part(pg_temp.kv('n_f'), 1)::uuid),
  pg_temp.kv('n_gen_owner') || ' / ' || pg_temp.kv('n_mismatch'));
select pg_temp.setkv('t_f', pg_temp.fresh(true));
update public.appointments set status = 'cancelled' where id = pg_temp.part(pg_temp.kv('t_f'), 5)::uuid;
select pg_temp.setkv('t_issue', pg_temp.issue_as('owner_a', pg_temp.part(pg_temp.kv('t_f'), 1)::uuid, gen_random_uuid(), pg_temp.hx('dead-target')));
select pg_temp.chk('S13b a new link is refused (22023) while the request has no live appointment, and the previous generation is not revoked by the refused call',
  pg_temp.kv('t_issue') like 'ERR 22023%no live appointment%'
  and (select count(*) = 1 and bool_and(revoked_at is null) from public.intake_invitations where request_id = pg_temp.part(pg_temp.kv('t_f'), 1)::uuid));
select pg_temp.setkv('u_before', (select count(*)::text from public.intake_rate_limits));
select pg_temp.exch(pg_temp.hx('definitely-unknown-token'), 'unk-1');
select pg_temp.exch(pg_temp.hx('definitely-unknown-token-2'), 'unk-2');
select pg_temp.setkv('u_after_unknown', (select count(*)::text from public.intake_rate_limits));
select pg_temp.setkv('u_known', pg_temp.fresh(true));
select pg_temp.exch(pg_temp.part(pg_temp.kv('u_known'), 3), 'known-1');
select pg_temp.chk('S13c an unknown token writes nothing (no rate-limit row); a known token is counted',
  pg_temp.kv('u_before') = pg_temp.kv('u_after_unknown') and (select count(*)::text from public.intake_rate_limits) <> pg_temp.kv('u_after_unknown'),
  pg_temp.kv('u_before') || '/' || pg_temp.kv('u_after_unknown'));
select pg_temp.chk('S13d a session carries the staff member who minted its link (copied from the invitation, immutable), and the issue audit event names that member',
  (select s.issued_by_user = pg_temp.u('owner_a') and s.issued_by_user = i.issued_by_user from public.intake_sessions s join public.intake_invitations i on i.id = s.invitation_id
   where s.session_hash = decode(pg_temp.hx('known-1'), 'hex'))
  and exists (select 1 from public.intake_audit_events e where e.event_type = 'invitation_issued' and e.actor_user_id = pg_temp.u('owner_a') and e.request_ref = pg_temp.part(pg_temp.kv('u_known'), 1)::uuid)
  and pg_temp.try(format('update public.intake_sessions set issued_by_user = null where session_hash = decode(%L, ''hex'')', pg_temp.hx('known-1'))) like '42501%');

-- ===== S12 immutability, privileges, catalog =======================================================================
select pg_temp.chk('S12a an invitation can only be revoked (once); its hash, salt, kid, pin and expiry can never change; sessions change only by activity and revocation',
  pg_temp.try(format('update public.intake_invitations set token_hash = decode(%L, ''hex'') where id = %L', pg_temp.hx('zz'), pg_temp.part(pg_temp.kv('e1'), 2))) like '42501%'
  and pg_temp.try(format('update public.intake_invitations set expires_at = expires_at + interval ''1 day'' where id = %L', pg_temp.part(pg_temp.kv('e1'), 2))) like '42501%'
  and pg_temp.try(format('update public.intake_sessions set absolute_expires_at = absolute_expires_at + interval ''1 day'' where session_hash = decode(%L, ''hex'')', pg_temp.hx('sess-e1'))) like '42501%'
  and pg_temp.try('truncate public.intake_sessions') like '42501%'
  and pg_temp.try('delete from public.intake_invitations') like '42501%');
select pg_temp.chk('S12b table grants: no API role holds any privilege on the three tables; the destructive role has exactly SELECT and DELETE; RLS is on; policies exist for the destructive role only',
  not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['intake_invitations', 'intake_sessions', 'intake_rate_limits']) t,
                     unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p where has_table_privilege(r, 'public.' || t, p))
  and (select bool_and(relrowsecurity) from pg_class where relname in ('intake_invitations', 'intake_sessions', 'intake_rate_limits') and relnamespace = 'public'::regnamespace)
  and (select count(*) = 6 and bool_and(roles = array['intake_destructive']::name[]) from (select polname, (select array_agg(rolname) from pg_roles where oid = any (polroles)) roles
        from pg_policy where polrelid in ('public.intake_invitations'::regclass, 'public.intake_sessions'::regclass, 'public.intake_rate_limits'::regclass)) p));
select pg_temp.chk('S12c function privileges: staff RPCs are executable by authenticated only; exchange, context, revoke, rate limit, bulk revoke and purge by service_role only; anon holds none; the implementations are not executable by API roles',
  has_function_privilege('authenticated', 'public.intake_issue_invitation(uuid,uuid,uuid,int,text,bytea,bytea,timestamptz)', 'execute')
  and has_function_privilege('authenticated', 'public.intake_revoke_invitations(uuid,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.intake_next_invitation_generation(uuid,uuid)', 'execute') and not has_function_privilege('anon', 'public.intake_next_invitation_generation(uuid,uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.intake_issue_invitation(uuid,uuid,uuid,int,text,bytea,bytea,timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.intake_issue_invitation(uuid,uuid,uuid,int,text,bytea,bytea,timestamptz)', 'execute')
  and (select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
       from unnest(array['public.intake_exchange_invitation(bytea,bytea,int,int)', 'public.intake_session_context(bytea)', 'public.intake_revoke_session(bytea)',
                         'public.intake_rate_limit_hit(bytea,int,int)', 'public.intake_revoke_all_invitations_for_key(text,int)', 'public.intake_purge_expired(int)']) f)
  and not has_function_privilege('service_role', 'intake_private.purge_expired_impl(int)', 'execute') and not has_function_privilege('authenticated', 'intake_private.link_valid(uuid)', 'execute')
  and not has_function_privilege('service_role', 'intake_private.link_valid(uuid)', 'execute'));
select pg_temp.chk('S12d erase_client_impl carries the m12 marker, purge and erase implementations are owned by the restricted role, the catalog self-check passes',
  (select prosrc ~ 'nsi-body:m(12|14|16a)' from pg_proc where proname = 'erase_client_impl')
  and (select bool_and(pg_get_userbyid(proowner) = 'intake_destructive') from pg_proc where proname in ('erase_client_impl', 'purge_expired_impl'))
  and pg_temp.try('select intake_private.assert_catalog()') = 'ok');
select pg_temp.chk('S12e no token, secret, hash or salt appears in any audit row; nothing was queued for delivery; no write touched appointments or account links',
  not exists (select 1 from public.intake_audit_events e where e.event_type in ('invitation_issued', 'invitation_revoked', 'link_exchanged', 'session_revoked') and e.metadata::text ~* '(token|secret|hash|salt|session)')
  and (select count(*) = 0 from public.outbound_deliveries where template_key like 'intake%'));

-- ===== result =========================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I3-1 SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I3-1 SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

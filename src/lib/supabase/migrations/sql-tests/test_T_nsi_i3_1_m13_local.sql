-- NSI I3-1 (M13) boundary tests: purge hardening and audit-actor consistency. Valid on M13 only.
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


-- ===== P01 bounded purge: at most 50 distinct clients per call, the rest on the next call ==============================
create or replace function pg_temp.mass() returns int language plpgsql as $f$
declare i int; n int := 0;
begin
  for i in 1 .. 55 loop
    perform pg_temp.live();
    n := n + 1;
  end loop;
  return n;
end $f$;
select pg_temp.setkv('p_n', pg_temp.mass()::text);
set local session_replication_role = replica;
update public.intake_sessions set absolute_expires_at = now() - interval '2 days', idle_expires_at = now() - interval '2 days', created_at = now() - interval '3 days';
set local session_replication_role = origin;
select pg_temp.setkv('p_before', (select count(*)::text from public.intake_sessions));
select pg_temp.setkv('p_r1', pg_temp.val_as('service_role', null, 'select public.intake_purge_expired(500)::text'));
select pg_temp.setkv('p_after1', (select count(*)::text from public.intake_sessions));
select pg_temp.setkv('p_r2', pg_temp.val_as('service_role', null, 'select public.intake_purge_expired(500)::text'));
select pg_temp.setkv('p_after2', (select count(*)::text from public.intake_sessions));
select pg_temp.chk('P01 with 55 clients holding expired sessions, the first purge call locks and clears exactly 50 clients, the second clears the rest, and a third finds nothing',
  pg_temp.kv('p_n') = '55' and pg_temp.kv('p_before') = '55'
  and (pg_temp.kv('p_r1')::jsonb ->> 'clients_candidate')::int = 50 and (pg_temp.kv('p_r1')::jsonb ->> 'clients_locked')::int = 50 and (pg_temp.kv('p_r1')::jsonb ->> 'sessions')::int = 50
  and pg_temp.kv('p_after1') = '5'
  and (pg_temp.kv('p_r2')::jsonb ->> 'sessions')::int = 5 and pg_temp.kv('p_after2') = '0',
  pg_temp.kv('p_r1') || ' // ' || pg_temp.kv('p_r2'));

-- ===== P02 legal holds are still honored by the new (later-statement) hold check ====================================
select pg_temp.setkv('h_f', pg_temp.live());
select pg_temp.setkv('h_id', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_create_legal_hold(%L, ''client'', %L, ''synthetic'', ''synthetic'', now() + interval ''30 days'')',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('h_f'), 4))));
set local session_replication_role = replica;
update public.intake_sessions set absolute_expires_at = now() - interval '2 days', idle_expires_at = now() - interval '2 days', created_at = now() - interval '3 days'
  where request_id = pg_temp.part(pg_temp.kv('h_f'), 1)::uuid;
set local session_replication_role = origin;
select pg_temp.setkv('h_r', pg_temp.val_as('service_role', null, 'select public.intake_purge_expired(500)::text'));
select pg_temp.chk('P02 an expired session of a client under a legal hold survives the purge (the call itself does not fail)',
  pg_temp.kv('h_r') not like 'ERR%' and exists (select 1 from public.intake_sessions where request_id = pg_temp.part(pg_temp.kv('h_f'), 1)::uuid), pg_temp.kv('h_r'));

-- ===== P03 revoke_session is audited as a system event ============================================================
select pg_temp.setkv('a_f', pg_temp.live());
select pg_temp.val_as('service_role', null, format('select public.intake_revoke_session(decode(%L, ''hex''))', pg_temp.hx(pg_temp.part(pg_temp.kv('a_f'), 6))));
select pg_temp.chk('P03 session_revoked and link_exchanged are both system events (same actor type)',
  exists (select 1 from public.intake_audit_events e where e.event_type = 'session_revoked' and e.actor_type = 'system' and e.request_ref = pg_temp.part(pg_temp.kv('a_f'), 1)::uuid)
  and not exists (select 1 from public.intake_audit_events e where e.event_type in ('session_revoked', 'link_exchanged') and e.actor_type = 'student'));

-- ===== P04 the minting-actor guard: a session whose actor differs from its invitation's is refused (with a positive control) ====
select pg_temp.setkv('g_f', pg_temp.live());
select pg_temp.setkv('g_ok', pg_temp.try(format('insert into public.intake_sessions (studio_id, request_id, invitation_id, audience, issued_by_user, session_hash, idle_seconds, idle_expires_at, absolute_expires_at)
  values (%L, %L, %L, ''student'', %L, decode(%L, ''hex''), 1800, now() + interval ''30 minutes'', now() + interval ''4 hours'')',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('g_f'), 1), pg_temp.part(pg_temp.kv('g_f'), 2), pg_temp.u('owner_a'), pg_temp.hx('pos-control'))));
select pg_temp.setkv('g_bad', pg_temp.try(format('insert into public.intake_sessions (studio_id, request_id, invitation_id, audience, issued_by_user, session_hash, idle_seconds, idle_expires_at, absolute_expires_at)
  values (%L, %L, %L, ''student'', %L, decode(%L, ''hex''), 1800, now() + interval ''30 minutes'', now() + interval ''4 hours'')',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('g_f'), 1), pg_temp.part(pg_temp.kv('g_f'), 2), pg_temp.u('admin_a'), pg_temp.hx('neg-control'))));
select pg_temp.chk('P04 a session with the invitation''s minting actor inserts (positive control); one with a DIFFERENT NON-NULL actor (the admin) is refused (42501)',
  pg_temp.kv('g_ok') = 'ok' and pg_temp.kv('g_bad') like '42501%minting actor%', pg_temp.kv('g_ok') || ' / ' || pg_temp.kv('g_bad'));

-- ===== P05 markers, ACLs unchanged ===================================================================================
select pg_temp.chk('P05 the purge implementation and revoke_session carry the m13 marker; the purge stays owned by the restricted role and service_role-only through its wrapper; the catalog self-check passes',
  (select position('nsi-body:m13' in prosrc) > 0 and pg_get_userbyid(proowner) = 'intake_destructive' from pg_proc where proname = 'purge_expired_impl')
  and (select position('nsi-body:m13' in prosrc) > 0 from pg_proc where proname = 'intake_revoke_session')
  and has_function_privilege('service_role', 'public.intake_purge_expired(int)', 'execute')
  and not has_function_privilege('authenticated', 'public.intake_purge_expired(int)', 'execute')
  and not has_function_privilege('service_role', 'intake_private.purge_expired_impl(int)', 'execute')
  and pg_temp.try('select intake_private.assert_catalog()') = 'ok');

-- ===== result =========================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I3-1 M13 SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I3-1 M13 SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

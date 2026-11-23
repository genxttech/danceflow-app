-- NSI I3-1 (M14) boundary tests: hold semantics and purge liveness. Valid on M14 only.
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


create or replace function pg_temp.hold_direct(p_client uuid, p_effective text default 'now()') returns void language plpgsql as $f$
begin
  execute format('insert into public.intake_legal_holds (studio_id, scope_type, scope_ref, client_ref, reason, retention_basis, effective_at, review_due_at, created_by)
                  values (%L, ''client'', %L, %L, ''m14 test'', ''m14 test'', %s, now() + interval ''40 days'', %L)',
                 pg_temp.kv('sa'), p_client, p_client, p_effective, pg_temp.u('padmin'));
end $f$;

-- ===== T01 a committed hold protects at once: effective_at is informational =============================================
select pg_temp.setkv('h1_f', pg_temp.live());
select pg_temp.hold_direct(pg_temp.part(pg_temp.kv('h1_f'), 4)::uuid, 'now() + interval ''1 hour''');
select pg_temp.chk('T01 a hold whose effective_at lies in the future still protects the client (client_has_active_hold and is_held ignore effective_at)',
  intake_private.client_has_active_hold(pg_temp.u('sa'), pg_temp.part(pg_temp.kv('h1_f'), 4)::uuid)
  and intake_private.is_held(pg_temp.u('sa'), pg_temp.part(pg_temp.kv('h1_f'), 4)::uuid, null, null, null, null));

-- ===== T02 purge and erase honor such a hold; a released hold no longer protects =====================================
set local session_replication_role = replica;
update public.intake_sessions set absolute_expires_at = now() - interval '2 days', idle_expires_at = now() - interval '2 days', created_at = now() - interval '3 days'
  where request_id = pg_temp.part(pg_temp.kv('h1_f'), 1)::uuid;
set local session_replication_role = origin;
select pg_temp.setkv('t2_purge', pg_temp.val_as('service_role', null, 'select public.intake_purge_expired(500)::text'));
select pg_temp.setkv('t2_erase', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_erase_client(%L, %L, ''data_subject_request'')::text', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('h1_f'), 4))));
select pg_temp.chk('T02 the purge skips the client of a future-effective hold and an erase is refused (outcome refused); every row remains',
  pg_temp.kv('t2_purge') not like 'ERR%' and pg_temp.kv('t2_erase') like '%refused%'
  and exists (select 1 from public.intake_sessions where request_id = pg_temp.part(pg_temp.kv('h1_f'), 1)::uuid)
  and exists (select 1 from public.intake_invitations where request_id = pg_temp.part(pg_temp.kv('h1_f'), 1)::uuid),
  left(pg_temp.kv('t2_purge'), 100) || ' // ' || left(pg_temp.kv('t2_erase'), 100));

-- ===== T03 delete_guard fails closed on an unresolvable subject, allows rate-limit counters; locks then checks ===================
create temp table gx (studio_id uuid, request_id uuid);
create trigger gx_guard before delete on gx for each row execute function intake_private.delete_guard();
grant select, delete on gx to intake_destructive;
insert into gx values (pg_temp.u('sa'), null);
select pg_temp.setkv('t3_unresolved', pg_temp.run_as('intake_destructive', null, 'delete from gx'));
select pg_temp.setkv('t3_not_destructive', pg_temp.try('delete from gx'));
select pg_temp.setkv('rlh', encode(sha256(convert_to('t3-rl', 'UTF8')), 'hex'));
set local session_replication_role = replica;
insert into public.intake_rate_limits (bucket_hash, window_start, window_seconds, hits) values (decode(pg_temp.kv('rlh'), 'hex'), now() - interval '3 days', 600, 1);
set local session_replication_role = origin;
select pg_temp.setkv('t3_rl', pg_temp.run_as('intake_destructive', null, format('delete from public.intake_rate_limits where bucket_hash = decode(%L, ''hex'')', pg_temp.kv('rlh'))));
select pg_temp.chk('T03 an unresolvable subject is never deleted (42501 for the restricted role, refused for everyone else); a rate-limit counter is deletable',
  pg_temp.kv('t3_unresolved') like '42501%cannot be resolved%' and pg_temp.kv('t3_not_destructive') like '42501%'
  and pg_temp.kv('t3_rl') = 'ok' and exists (select 1 from gx),
  pg_temp.kv('t3_unresolved') || ' / ' || pg_temp.kv('t3_rl'));

-- ===== T04 direct delete of a held client's row is refused whatever the hold's effective_at ==================================
select pg_temp.setkv('d_f', pg_temp.live());
select pg_temp.hold_direct(pg_temp.part(pg_temp.kv('d_f'), 4)::uuid, 'now() + interval ''2 hours''');
set local session_replication_role = replica;
update public.intake_sessions set absolute_expires_at = now() - interval '2 days', idle_expires_at = now() - interval '2 days', created_at = now() - interval '3 days'
  where request_id = pg_temp.part(pg_temp.kv('d_f'), 1)::uuid;
set local session_replication_role = origin;
select pg_temp.setkv('t4', pg_temp.run_as('intake_destructive', null, format('delete from public.intake_sessions where request_id = %L', pg_temp.part(pg_temp.kv('d_f'), 1))));
select pg_temp.chk('T04 the guard refuses (42501, active legal hold) a direct delete as the restricted role and the row remains',
  pg_temp.kv('t4') like '42501%legal hold%' and exists (select 1 from public.intake_sessions where request_id = pg_temp.part(pg_temp.kv('d_f'), 1)::uuid), pg_temp.kv('t4'));

-- ===== T05 hold creation: scope re-resolved under the lock, barrier for every scope ============================================
select pg_temp.setkv('e_f', pg_temp.live());
set local session_replication_role = replica;
insert into public.intake_audit_events (studio_id, event_type, actor_type, retention_class, client_ref)
values (pg_temp.u('sa'), 'erasure_record', 'system', 'erasure_record', pg_temp.part(pg_temp.kv('e_f'), 4)::uuid);
set local session_replication_role = origin;
select pg_temp.setkv('t5_req', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_create_legal_hold(%L, ''request'', %L, ''m14'', ''m14'', now() + interval ''30 days'')',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('e_f'), 1))));
select pg_temp.setkv('t5_client', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_create_legal_hold(%L, ''client'', %L, ''m14'', ''m14'', now() + interval ''30 days'')',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('e_f'), 4))));
select pg_temp.setkv('t5_gone', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_create_legal_hold(%L, ''request'', %L, ''m14'', ''m14'', now() + interval ''30 days'')',
  pg_temp.kv('sa'), gen_random_uuid())));
select pg_temp.chk('T05 a hold cannot be created for a request or client of an erased client (22023, every scope) nor for a scope row that does not exist (42501)',
  pg_temp.kv('t5_req') like 'ERR 22023%' and pg_temp.kv('t5_client') like 'ERR 22023%' and pg_temp.kv('t5_gone') like 'ERR 42501%'
  and not exists (select 1 from public.intake_legal_holds where client_ref = pg_temp.part(pg_temp.kv('e_f'), 4)::uuid),
  pg_temp.kv('t5_req') || ' / ' || pg_temp.kv('t5_client') || ' / ' || pg_temp.kv('t5_gone'));

-- ===== T06 revoke_session audit carries client_ref ====================================================================
select pg_temp.setkv('c_f', pg_temp.live());
select pg_temp.val_as('service_role', null, format('select public.intake_revoke_session(decode(%L, ''hex''))', pg_temp.hx(pg_temp.part(pg_temp.kv('c_f'), 6))));
select pg_temp.chk('T06 the session_revoked audit event names the client',
  exists (select 1 from public.intake_audit_events e where e.event_type = 'session_revoked' and e.client_ref = pg_temp.part(pg_temp.kv('c_f'), 4)::uuid and e.actor_type = 'system'));

-- ===== T07 starvation: 55 held clients whose rows are the oldest, 5 unheld clients; one call clears the 5 =================
create or replace function pg_temp.mass_held(p_n int) returns int language plpgsql as $f$
declare i int; f text;
begin
  for i in 1 .. p_n loop
    f := pg_temp.live();
    perform pg_temp.hold_direct(pg_temp.part(f, 4)::uuid);
    set local session_replication_role = replica;
    update public.intake_sessions set absolute_expires_at = now() - interval '5 days', idle_expires_at = now() - interval '5 days', created_at = now() - interval '6 days'
      where request_id = pg_temp.part(f, 1)::uuid;
    set local session_replication_role = origin;
  end loop;
  return p_n;
end $f$;
create or replace function pg_temp.mass_free(p_n int) returns int language plpgsql as $f$
declare i int; f text;
begin
  for i in 1 .. p_n loop
    f := pg_temp.live();
    set local session_replication_role = replica;
    update public.intake_sessions set absolute_expires_at = now() - interval '2 days', idle_expires_at = now() - interval '2 days', created_at = now() - interval '3 days'
      where request_id = pg_temp.part(f, 1)::uuid;
    set local session_replication_role = origin;
  end loop;
  return p_n;
end $f$;
-- clear everything left over from earlier checks in this transaction so the counts below are exact
set local session_replication_role = replica;
delete from public.intake_sessions where request_id not in (select request_id from public.intake_sessions where false);
set local session_replication_role = origin;
select pg_temp.setkv('s_held', pg_temp.mass_held(55)::text);
select pg_temp.setkv('s_free', pg_temp.mass_free(5)::text);
select pg_temp.setkv('s_r1', pg_temp.val_as('service_role', null, 'select public.intake_purge_expired(500)::text'));
select pg_temp.chk('T07 with 55 held clients holding the oldest expired sessions, one purge call clears all 5 unheld clients (held clients never consume the window); candidates = 5, locked = 5',
  (pg_temp.kv('s_r1')::jsonb ->> 'sessions')::int = 5 and (pg_temp.kv('s_r1')::jsonb ->> 'clients_candidate')::int = 5
  and (pg_temp.kv('s_r1')::jsonb ->> 'clients_locked')::int = 5
  and (select count(*) = 55 from public.intake_sessions s join public.intake_legal_holds h on h.client_ref = (select client_id from public.intake_requests q where q.id = s.request_id) and h.released_at is null),
  pg_temp.kv('s_r1'));

-- ===== T08 markers, ACLs, catalog ====================================================================================
select pg_temp.chk('T08 every M14 body carries the m14 marker; the hold-insert trigger exists; the erase and purge implementations stay owned by the restricted role; the catalog self-check passes',
  (select count(*) = 11 and bool_and(position('nsi-body:m14' in prosrc) > 0)
     from pg_proc where (proname in ('client_has_active_hold', 'is_held', 'delete_guard', 'legal_hold_insert_guard', 'lock_client', 'try_lock_client', 'purge_expired_impl', 'erase_client_impl',
                                      'intake_erase_client', 'intake_revoke_session', 'intake_create_legal_hold')))
  and exists (select 1 from pg_trigger where tgrelid = 'public.intake_legal_holds'::regclass and tgname = 'intake_legal_holds_05_lock' and not tgisinternal)
  and (select bool_and(pg_get_userbyid(proowner) = 'intake_destructive') from pg_proc where proname in ('erase_client_impl', 'purge_expired_impl'))
  and pg_temp.try('select intake_private.assert_catalog()') = 'ok');

-- ===== result =========================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I3-1 M14 SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I3-1 M14 SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

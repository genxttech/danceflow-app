-- NSI I3-3 (M15) boundary tests: minor determination service path, fulfillment_state (B2, O11). Valid on M15 only.
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


-- ===== M15 helpers ====================================================================================================
create or replace function pg_temp.today_a() returns date language sql as $$ select intake_private.studio_local_date(pg_temp.u('sa')) $$;
create or replace function pg_temp.set_bd(p_client text, p_bd date) returns void language sql as $$ update public.clients set birthday = p_bd where id = p_client::uuid $$;
create or replace function pg_temp.set_bd(p_client text, p_bd timestamp) returns void language sql as $$ update public.clients set birthday = p_bd::date where id = p_client::uuid $$;
create or replace function pg_temp.det(p_req text) returns text language sql as $$
  select coalesce(pg_temp.val_as('service_role', null, format('select public.intake_determine_minor_from_birthday(%L, %L)', pg_temp.kv('sa'), p_req)), 'NULL') $$;
create or replace function pg_temp.decl(p_sess text, p_class text) returns text language sql as $$
  select coalesce(pg_temp.val_as('service_role', null, format('select public.intake_declare_minor_status(decode(%L, ''hex''), %L)', pg_temp.hx(p_sess), p_class)), 'NULL') $$;
create or replace function pg_temp.mstate(p_sess text) returns text language sql as $$
  select coalesce(pg_temp.val_as('service_role', null, format('select public.intake_session_minor_state(decode(%L, ''hex''))', pg_temp.hx(p_sess))), 'NULL') $$;
create or replace function pg_temp.nrows(p_req text) returns int language sql as $$ select count(*)::int from public.intake_minor_determinations where request_id = p_req::uuid $$;
create or replace function pg_temp.latest(p_req text) returns text language sql as $$
  select source || '/' || is_minor::text || '/' || threshold::text from public.intake_minor_determinations where request_id = p_req::uuid order by created_at desc, id desc limit 1 $$;

-- ===== N01 gate closed, unknown request, roles ========================================================================
select pg_temp.setkv('n1', pg_temp.fresh(false));
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n1'), 4), pg_temp.today_a() - interval '30 years');
select pg_temp.set_gate(false);
select pg_temp.setkv('n1_closed', pg_temp.det(pg_temp.part(pg_temp.kv('n1'), 1)));
select pg_temp.set_gate(true);
select pg_temp.setkv('n1_unknown', pg_temp.det(gen_random_uuid()::text));
select pg_temp.setkv('n1_foreign', pg_temp.val_as('service_role', null, format('select public.intake_determine_minor_from_birthday(%L, %L)', pg_temp.kv('sb'), pg_temp.part(pg_temp.kv('n1'), 1))));
select pg_temp.chk('N01 Gate A closed returns gate_closed and writes nothing; an unknown request and another studio''s request are refused with 22023',
  pg_temp.kv('n1_closed') = 'gate_closed' and pg_temp.nrows(pg_temp.part(pg_temp.kv('n1'), 1)) = 0
  and pg_temp.kv('n1_unknown') like 'ERR 22023%' and pg_temp.kv('n1_foreign') like 'ERR 22023%',
  pg_temp.kv('n1_closed') || ' / ' || pg_temp.kv('n1_unknown') || ' / ' || pg_temp.kv('n1_foreign'));

-- (privileges are checked in the catalog: calling a function the role may not execute crashes the local QA image, see the TW-4F notes)
select pg_temp.chk('N02 privileges: determine, declare and session state are executable by service_role only; the staff read by authenticated only; the helpers by nobody; the restricted role by none of them',
  (select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('intake_destructive', f, 'execute'))
     from unnest(array['public.intake_determine_minor_from_birthday(uuid,uuid)', 'public.intake_declare_minor_status(bytea,text)', 'public.intake_session_minor_state(bytea)']) f)
  and has_function_privilege('authenticated', 'public.intake_minor_basis(uuid,uuid)', 'execute') and not has_function_privilege('service_role', 'public.intake_minor_basis(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.intake_minor_basis(uuid,uuid)', 'execute') and not has_function_privilege('intake_destructive', 'public.intake_minor_basis(uuid,uuid)', 'execute')
  and (select bool_and(not has_function_privilege(r, f, 'execute'))
         from unnest(array['intake_private.studio_local_date(uuid)', 'intake_private.age_in_years(date,date)']) f, unnest(array['anon', 'authenticated', 'service_role', 'intake_destructive']) r));

-- ===== N03 age edges (the day of the 18th birthday is adult, the day before is a minor), thresholds, bounds ===========
select pg_temp.setkv('n3a', pg_temp.fresh(false)); select pg_temp.setkv('n3b', pg_temp.fresh(false)); select pg_temp.setkv('n3c', pg_temp.fresh(false));
select pg_temp.setkv('n3d', pg_temp.fresh(false)); select pg_temp.setkv('n3e', pg_temp.fresh(false)); select pg_temp.setkv('n3f', pg_temp.fresh(false));
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n3a'), 4), (pg_temp.today_a() - interval '18 years')::date);       -- turns 18 today
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n3b'), 4), (pg_temp.today_a() - interval '18 years')::date + 1);   -- turns 18 tomorrow
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n3c'), 4), (pg_temp.today_a() - interval '121 years')::date);      -- untrusted (too old)
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n3d'), 4), pg_temp.today_a() + 1);                                  -- untrusted (future)
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n3e'), 4), (pg_temp.today_a() - interval '15 years')::date);       -- minor at 18, 'adult' under a (bogus) threshold of 13 only if not clamped
select pg_temp.setkv('n3a_r', pg_temp.det(pg_temp.part(pg_temp.kv('n3a'), 1)));
select pg_temp.setkv('n3b_r', pg_temp.det(pg_temp.part(pg_temp.kv('n3b'), 1)));
select pg_temp.setkv('n3c_r', pg_temp.det(pg_temp.part(pg_temp.kv('n3c'), 1)));
select pg_temp.setkv('n3d_r', pg_temp.det(pg_temp.part(pg_temp.kv('n3d'), 1)));
select pg_temp.setkv('n3f_r', pg_temp.det(pg_temp.part(pg_temp.kv('n3f'), 1)));   -- no birthday at all
update public.intake_settings set minor_age_threshold = 13 where studio_id = pg_temp.u('sa');
select pg_temp.setkv('n3e_r', pg_temp.det(pg_temp.part(pg_temp.kv('n3e'), 1)));   -- threshold 13 is clamped to 18, so a 15-year-old is a minor
update public.intake_settings set minor_age_threshold = 18 where studio_id = pg_temp.u('sa');
select pg_temp.chk('N03 the day of the 18th birthday is an adult, the day before a minor; a birthday more than 120 years back, in the future, or missing is not trusted; threshold 13 is clamped to 18',
  pg_temp.kv('n3a_r') = 'determined_adult' and pg_temp.latest(pg_temp.part(pg_temp.kv('n3a'), 1)) = 'birthday/false/18'
  and pg_temp.kv('n3b_r') = 'determined_minor' and pg_temp.latest(pg_temp.part(pg_temp.kv('n3b'), 1)) = 'birthday/true/18'
  and pg_temp.kv('n3c_r') = 'no_birthday' and pg_temp.kv('n3d_r') = 'no_birthday' and pg_temp.kv('n3f_r') = 'no_birthday'
  and pg_temp.kv('n3e_r') = 'determined_minor' and pg_temp.latest(pg_temp.part(pg_temp.kv('n3e'), 1)) = 'birthday/true/18'
  and pg_temp.nrows(pg_temp.part(pg_temp.kv('n3c'), 1)) = 0 and pg_temp.nrows(pg_temp.part(pg_temp.kv('n3d'), 1)) = 0 and pg_temp.nrows(pg_temp.part(pg_temp.kv('n3f'), 1)) = 0,
  pg_temp.kv('n3a_r') || ' ' || pg_temp.kv('n3b_r') || ' ' || pg_temp.kv('n3c_r') || ' ' || pg_temp.kv('n3d_r') || ' ' || pg_temp.kv('n3e_r') || ' ' || pg_temp.kv('n3f_r'));

select pg_temp.chk('N04 29 February: a person born on 2000-02-29 is 17 on 2018-02-28 and 18 on 2018-03-01; 20 on 2020-02-29; leap and non-leap handled by the timestamp overload',
  intake_private.age_in_years(date '2000-02-29', date '2018-02-28') = 17 and intake_private.age_in_years(date '2000-02-29', date '2018-03-01') = 18
  and intake_private.age_in_years(date '2000-02-29', date '2020-02-29') = 20 and intake_private.age_in_years(date '2001-03-01', date '2019-02-28') = 17);

-- a threshold of 21 applies when the studio raises it
select pg_temp.setkv('n5a', pg_temp.fresh(false));
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n5a'), 4), (pg_temp.today_a() - interval '19 years')::date);
update public.intake_settings set minor_age_threshold = 21 where studio_id = pg_temp.u('sa');
select pg_temp.setkv('n5a_r', pg_temp.det(pg_temp.part(pg_temp.kv('n5a'), 1)));
update public.intake_settings set minor_age_threshold = 18 where studio_id = pg_temp.u('sa');
select pg_temp.chk('N05 a studio threshold of 21 makes a 19-year-old a minor and the effective threshold is recorded',
  pg_temp.kv('n5a_r') = 'determined_minor' and pg_temp.latest(pg_temp.part(pg_temp.kv('n5a'), 1)) = 'birthday/true/21');

-- ===== N06 time zone precedence ========================================================================================
insert into public.studio_settings (studio_id, timezone) values (pg_temp.u('sa'), 'Pacific/Kiritimati') on conflict (studio_id) do update set timezone = excluded.timezone;
select pg_temp.setkv('n6_a', (intake_private.studio_local_date(pg_temp.u('sa')) = timezone('Pacific/Kiritimati', now())::date)::text);
update public.studio_settings set timezone = 'Mars/Phobos' where studio_id = pg_temp.u('sa');
update public.studios set timezone = 'Asia/Tokyo' where id = pg_temp.u('sa');
select pg_temp.setkv('n6_b', (intake_private.studio_local_date(pg_temp.u('sa')) = timezone('Asia/Tokyo', now())::date)::text);
update public.studios set timezone = 'Bad/Zone' where id = pg_temp.u('sa');
select pg_temp.setkv('n6_c', (intake_private.studio_local_date(pg_temp.u('sa')) = timezone('Etc/GMT+12', now())::date)::text);
update public.studio_settings set timezone = null where studio_id = pg_temp.u('sa');
select pg_temp.setkv('n6_d', (intake_private.studio_local_date(pg_temp.u('sa')) = timezone('Etc/GMT+12', now())::date)::text);
update public.studios set timezone = 'America/New_York' where id = pg_temp.u('sa');
update public.studio_settings set timezone = 'America/New_York' where studio_id = pg_temp.u('sa');
select pg_temp.chk('N06 the local date follows studio_settings.timezone, then studios.timezone, and falls back to Etc/GMT+12 when both are invalid or missing',
  pg_temp.kv('n6_a') = 'true' and pg_temp.kv('n6_b') = 'true' and pg_temp.kv('n6_c') = 'true' and pg_temp.kv('n6_d') = 'true',
  pg_temp.kv('n6_a') || pg_temp.kv('n6_b') || pg_temp.kv('n6_c') || pg_temp.kv('n6_d'));

-- ===== N07 monotone, no daily growth, staff override =================================================================
select pg_temp.setkv('n7', pg_temp.fresh(false));
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n7'), 4), (pg_temp.today_a() - interval '16 years')::date);
select pg_temp.setkv('n7_a', pg_temp.det(pg_temp.part(pg_temp.kv('n7'), 1)));
select pg_temp.setkv('n7_b', pg_temp.det(pg_temp.part(pg_temp.kv('n7'), 1)));
select pg_temp.setkv('n7_rows', pg_temp.nrows(pg_temp.part(pg_temp.kv('n7'), 1))::text);
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n7'), 4), (pg_temp.today_a() - interval '30 years')::date);   -- the birthday is corrected to an adult one
select pg_temp.setkv('n7_c', pg_temp.det(pg_temp.part(pg_temp.kv('n7'), 1)));
select pg_temp.setkv('n7_rows2', pg_temp.nrows(pg_temp.part(pg_temp.kv('n7'), 1))::text);
select pg_temp.setkv('n7_ov', pg_temp.owner_a(format('select public.intake_record_minor_determination(%L, %L, false, ''birthday corrected after review'')', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('n7'), 1))));
select pg_temp.setkv('n7_d', pg_temp.det(pg_temp.part(pg_temp.kv('n7'), 1)));
select pg_temp.setkv('n7_rows3', pg_temp.nrows(pg_temp.part(pg_temp.kv('n7'), 1))::text);
select pg_temp.chk('N07 a second call changes nothing (already_current); an automatic adult never replaces a minor (kept_minor); after a staff override every automatic call stops (staff_override_exists)',
  pg_temp.kv('n7_a') = 'determined_minor' and pg_temp.kv('n7_b') = 'already_current' and pg_temp.kv('n7_rows') = '1'
  and pg_temp.kv('n7_c') = 'kept_minor' and pg_temp.kv('n7_rows2') = '1'
  and pg_temp.kv('n7_ov') = 'ok' and pg_temp.kv('n7_d') = 'staff_override_exists' and pg_temp.kv('n7_rows3') = '2',
  pg_temp.kv('n7_a') || ' ' || pg_temp.kv('n7_b') || ' ' || pg_temp.kv('n7_c') || ' ' || pg_temp.kv('n7_ov') || ' ' || pg_temp.kv('n7_d'));

-- ===== N08 closed request, erasure barrier ============================================================================
select pg_temp.setkv('n8', pg_temp.fresh(false));
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n8'), 4), (pg_temp.today_a() - interval '40 years')::date);
select pg_temp.setkv('n8b', pg_temp.fresh(false));
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n8b'), 4), (pg_temp.today_a() - interval '40 years')::date);
update public.intake_requests set status = 'cancelled_by_staff' where id = pg_temp.part(pg_temp.kv('n8'), 1)::uuid;
update public.intake_requests set status = 'expired' where id = pg_temp.part(pg_temp.kv('n8b'), 1)::uuid;
select pg_temp.setkv('n8_r', pg_temp.det(pg_temp.part(pg_temp.kv('n8'), 1)));
select pg_temp.setkv('n8_r2', pg_temp.det(pg_temp.part(pg_temp.kv('n8b'), 1)));
select pg_temp.chk('N08 a request that is not open (cancelled, expired) is refused with request_not_open and nothing is written',
  pg_temp.kv('n8_r') = 'request_not_open' and pg_temp.kv('n8_r2') = 'request_not_open'
  and pg_temp.nrows(pg_temp.part(pg_temp.kv('n8'), 1)) = 0 and pg_temp.nrows(pg_temp.part(pg_temp.kv('n8b'), 1)) = 0);

-- ===== N09 declaration: birthday first, provenance, one declaration, invalid sessions ==================================
select pg_temp.setkv('l1', pg_temp.live());   -- no birthday: the declaration path
select pg_temp.setkv('l2', pg_temp.live());   -- a trusted birthday exists: the declaration is ignored
select pg_temp.setkv('l3', pg_temp.live());   -- under 13
select pg_temp.setkv('l4', pg_temp.live());   -- will be revoked
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('l2'), 4), (pg_temp.today_a() - interval '10 years')::date);
select pg_temp.setkv('n9_bad', pg_temp.decl(pg_temp.part(pg_temp.kv('l1'), 6), 'maybe'));
select pg_temp.setkv('n9_a', pg_temp.decl(pg_temp.part(pg_temp.kv('l1'), 6), 'adult'));
select pg_temp.setkv('n9_a2', pg_temp.decl(pg_temp.part(pg_temp.kv('l1'), 6), 'minor'));
select pg_temp.setkv('n9_b', pg_temp.decl(pg_temp.part(pg_temp.kv('l2'), 6), 'adult'));   -- a declaration cannot override a trusted birthday-minor
select pg_temp.setkv('n9_c', pg_temp.decl(pg_temp.part(pg_temp.kv('l3'), 6), 'under_13'));
select pg_temp.setkv('n9_inv', pg_temp.decl('no-such-session', 'adult'));
select pg_temp.val_as('service_role', null, format('select public.intake_revoke_session(decode(%L, ''hex''))', pg_temp.hx(pg_temp.part(pg_temp.kv('l4'), 6))));
select pg_temp.setkv('n9_rev', pg_temp.decl(pg_temp.part(pg_temp.kv('l4'), 6), 'adult'));
select pg_temp.chk('N09 declaration: a bad class is refused (22023); the first declaration records one row; a second is already_determined; a trusted birthday wins (birthday_used, no declared row); under_13 routes as a minor; unknown and revoked sessions are invalid',
  pg_temp.kv('n9_bad') like 'ERR 22023%' and pg_temp.kv('n9_a') = 'declared_adult' and pg_temp.kv('n9_a2') = 'already_determined' and pg_temp.nrows(pg_temp.part(pg_temp.kv('l1'), 1)) = 1
  and pg_temp.kv('n9_b') = 'birthday_used' and pg_temp.latest(pg_temp.part(pg_temp.kv('l2'), 1)) = 'birthday/true/18'
  and exists (select 1 from public.intake_minor_determinations where request_id = pg_temp.part(pg_temp.kv('l3'), 1)::uuid and source = 'declared' and is_minor and declared_value_class = 'under_13')
  and pg_temp.kv('n9_c') = 'declared_under_13' and pg_temp.kv('n9_inv') = 'invalid' and pg_temp.kv('n9_rev') = 'invalid' and pg_temp.nrows(pg_temp.part(pg_temp.kv('l4'), 1)) = 0,
  pg_temp.kv('n9_a') || ' ' || pg_temp.kv('n9_a2') || ' ' || pg_temp.kv('n9_b') || ' ' || pg_temp.kv('n9_c') || ' ' || pg_temp.kv('n9_inv') || ' ' || pg_temp.kv('n9_rev'));

-- provenance: the links in this suite are staff-minted (issued by owner_a), so the declared row carries the staff member and the audit basis says so
select pg_temp.chk('N10 provenance: a declaration through a staff-minted link stores the minting staff member on the row and the audit basis declared_via_staff_link, with the generation, client_ref and request_ref',
  exists (select 1 from public.intake_minor_determinations d where d.request_id = pg_temp.part(pg_temp.kv('l1'), 1)::uuid and d.source = 'declared' and d.actor_user_id = pg_temp.u('owner_a'))
  and exists (select 1 from public.intake_audit_events a where a.request_ref = pg_temp.part(pg_temp.kv('l1'), 1)::uuid and a.event_type = 'minor_determination_recorded'
              and a.actor_type = 'student' and a.client_ref = pg_temp.part(pg_temp.kv('l1'), 4)::uuid and a.metadata ->> 'basis' = 'declared_via_staff_link'
              and (a.metadata ->> 'generation')::int >= 1 and a.object_type = 'intake_session' and a.retention_state = 'scheduled')
  and exists (select 1 from public.intake_audit_events a where a.request_ref = pg_temp.part(pg_temp.kv('n3a'), 1)::uuid and a.event_type = 'minor_determination_recorded'
              and a.actor_type = 'system' and a.client_ref = pg_temp.part(pg_temp.kv('n3a'), 4)::uuid and a.metadata ->> 'basis' = 'birthday'));

-- ===== N11 session state is routing only ================================================================================
select pg_temp.setkv('l5', pg_temp.live());
select pg_temp.setkv('n11_unknown', pg_temp.mstate(pg_temp.part(pg_temp.kv('l5'), 6)));
select pg_temp.setkv('n11_minor', pg_temp.mstate(pg_temp.part(pg_temp.kv('l3'), 6)));
select pg_temp.setkv('n11_adult', pg_temp.mstate(pg_temp.part(pg_temp.kv('l1'), 6)));
select pg_temp.setkv('n11_revoked', pg_temp.mstate(pg_temp.part(pg_temp.kv('l4'), 6)));
select pg_temp.setkv('n11_none', pg_temp.mstate('no-such-session'));
update public.intake_sessions set idle_expires_at = now() - interval '1 second' where request_id = pg_temp.part(pg_temp.kv('l5'), 1)::uuid;
select pg_temp.setkv('n11_idle', pg_temp.mstate(pg_temp.part(pg_temp.kv('l5'), 6)));
select pg_temp.setkv('l6', pg_temp.live());
update public.intake_requests set status = 'submitted' where id = pg_temp.part(pg_temp.kv('l6'), 1)::uuid;
select pg_temp.setkv('n11_closed', pg_temp.mstate(pg_temp.part(pg_temp.kv('l6'), 6)));
select pg_temp.chk('N11 session minor state: unknown, minor and adult for valid sessions; nothing (NULL) for revoked, unknown, idle-expired and closed-request sessions; no source, date or threshold in the answer',
  pg_temp.kv('n11_unknown') = 'unknown' and pg_temp.kv('n11_minor') = 'minor' and pg_temp.kv('n11_adult') = 'adult'
  and pg_temp.kv('n11_revoked') = 'NULL' and pg_temp.kv('n11_none') = 'NULL' and pg_temp.kv('n11_idle') = 'NULL' and pg_temp.kv('n11_closed') = 'NULL',
  pg_temp.kv('n11_unknown') || ' ' || pg_temp.kv('n11_minor') || ' ' || pg_temp.kv('n11_adult') || ' ' || pg_temp.kv('n11_revoked') || ' ' || pg_temp.kv('n11_idle') || ' ' || pg_temp.kv('n11_closed'));

-- ===== N12 the staff read of the basis ==================================================================================
select pg_temp.setkv('n12_owner', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select (select row_to_json(b)::text from public.intake_minor_basis(%L, %L) b)', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('l1'), 1))));
select pg_temp.setkv('n12_fd', pg_temp.run_as('authenticated', pg_temp.u('fd_a'), format('select * from public.intake_minor_basis(%L, %L)', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('l1'), 1))));
select pg_temp.setkv('n12_instr', pg_temp.run_as('authenticated', pg_temp.u('instr_a'), format('select * from public.intake_minor_basis(%L, %L)', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('l1'), 1))));
select pg_temp.setkv('n12_other', pg_temp.run_as('authenticated', pg_temp.u('owner_b'), format('select * from public.intake_minor_basis(%L, %L)', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('l1'), 1))));
select pg_temp.setkv('n12_ov', pg_temp.val_as('authenticated', pg_temp.u('owner_a'), format('select (select row_to_json(b)::text from public.intake_minor_basis(%L, %L) b)', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('n7'), 1))));
select pg_temp.chk('N12 the staff read shows source, via_staff_link, threshold and local date (never the birthday); the staff-override row reports a null threshold; front desk may read, instructor and another studio''s owner may not',
  pg_temp.kv('n12_owner') like '%"source":"declared"%' and pg_temp.kv('n12_owner') like '%"via_staff_link":true%' and pg_temp.kv('n12_owner') like '%"threshold":18%'
  and pg_temp.kv('n12_owner') not like '%birth%' and pg_temp.kv('n12_ov') like '%"source":"staff_override"%' and pg_temp.kv('n12_ov') like '%"threshold":null%'
  and pg_temp.kv('n12_fd') = 'ok' and pg_temp.kv('n12_instr') like '42501%' and pg_temp.kv('n12_other') like '42501%',
  pg_temp.kv('n12_owner') || ' | ' || pg_temp.kv('n12_ov') || ' | ' || pg_temp.kv('n12_fd') || ' | ' || pg_temp.kv('n12_instr'));

-- ===== N13 holds do not block a determination; a hold marks the audit row held; erase is refused and the row survives ==========
select pg_temp.setkv('n13', pg_temp.fresh(false));
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n13'), 4), (pg_temp.today_a() - interval '25 years')::date);
select pg_temp.setkv('n13_hold', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_create_legal_hold(%L, ''client'', %L, ''m15'', ''m15'', now() + interval ''30 days'')::text',
  pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('n13'), 4))));
select pg_temp.setkv('n13_r', pg_temp.det(pg_temp.part(pg_temp.kv('n13'), 1)));
select pg_temp.setkv('n13_erase', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_erase_client(%L, %L, ''data_subject_request'')::text', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('n13'), 4))));
select pg_temp.chk('N13 a held client still receives a determination; its audit row is held; an erase is refused by the hold and the determination row survives',
  pg_temp.is_uuid(pg_temp.kv('n13_hold')) and pg_temp.kv('n13_r') = 'determined_adult'
  and exists (select 1 from public.intake_audit_events a where a.request_ref = pg_temp.part(pg_temp.kv('n13'), 1)::uuid and a.event_type = 'minor_determination_recorded' and a.retention_state = 'held')
  and pg_temp.kv('n13_erase') like '%legal_hold%' and pg_temp.nrows(pg_temp.part(pg_temp.kv('n13'), 1)) = 1, pg_temp.kv('n13_erase'));

-- ===== N14 erase removes determinations; afterwards a determination is refused ===========================================
select pg_temp.setkv('n14', pg_temp.fresh(false));
select pg_temp.set_bd(pg_temp.part(pg_temp.kv('n14'), 4), (pg_temp.today_a() - interval '12 years')::date);
select pg_temp.setkv('n14_r', pg_temp.det(pg_temp.part(pg_temp.kv('n14'), 1)));
select pg_temp.setkv('n14_erase', pg_temp.val_as('authenticated', pg_temp.u('padmin'), format('select public.intake_erase_client(%L, %L, ''data_subject_request'')::text', pg_temp.kv('sa'), pg_temp.part(pg_temp.kv('n14'), 4))));
select pg_temp.setkv('n14_after', pg_temp.det(pg_temp.part(pg_temp.kv('n14'), 1)));
select pg_temp.chk('N14 an erase removes the client''s determinations (the M14 guard resolves them through the request); a determination for the erased request is then refused (22023, the request is gone)',
  pg_temp.kv('n14_r') = 'determined_minor' and pg_temp.kv('n14_erase') like '%erased%'
  and (select count(*) = 0 from public.intake_minor_determinations where request_id = pg_temp.part(pg_temp.kv('n14'), 1)::uuid)
  and pg_temp.kv('n14_after') like 'ERR 22023%', pg_temp.kv('n14_erase') || ' / ' || pg_temp.kv('n14_after'));

-- ===== N15 fulfillment_state: determination_outstanding (B2), staff_confirmation_outstanding (O11), never hides incomplete =========
create or replace function pg_temp.mk_completion(p_req text) returns void language plpgsql as $f$
declare q record;
begin
  select * into q from public.intake_requests where id = p_req::uuid;
  set local session_replication_role = replica;
  insert into public.intake_completions (studio_id, request_id, client_id, template_id, template_version_id, version_number, student_response_id)
  values (q.studio_id, q.id, q.client_id, q.template_id, gen_random_uuid(), 1, gen_random_uuid());
  set local session_replication_role = origin;
end $f$;
select pg_temp.setkv('f1', pg_temp.fresh(false)); select pg_temp.setkv('f2', pg_temp.fresh(false)); select pg_temp.setkv('f3', pg_temp.fresh(false)); select pg_temp.setkv('f4', pg_temp.fresh(false));
select pg_temp.setkv('f_incomplete', intake_private.fulfillment_state(pg_temp.part(pg_temp.kv('f1'), 1)::uuid));
select pg_temp.mk_completion(pg_temp.part(pg_temp.kv('f1'), 1));
select pg_temp.setkv('f_outstanding', intake_private.fulfillment_state(pg_temp.part(pg_temp.kv('f1'), 1)::uuid));
insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold, declared_value_class)
  values (pg_temp.u('sa'), pg_temp.part(pg_temp.kv('f2'), 1)::uuid, false, 'declared', current_date, 18, 'adult');
select pg_temp.mk_completion(pg_temp.part(pg_temp.kv('f2'), 1));
select pg_temp.setkv('f_declared', intake_private.fulfillment_state(pg_temp.part(pg_temp.kv('f2'), 1)::uuid));
insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold)
  values (pg_temp.u('sa'), pg_temp.part(pg_temp.kv('f3'), 1)::uuid, false, 'birthday', current_date, 18);
select pg_temp.mk_completion(pg_temp.part(pg_temp.kv('f3'), 1));
select pg_temp.setkv('f_birthday', intake_private.fulfillment_state(pg_temp.part(pg_temp.kv('f3'), 1)::uuid));
insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold)
  values (pg_temp.u('sa'), pg_temp.part(pg_temp.kv('f4'), 1)::uuid, true, 'birthday', current_date, 18);
select pg_temp.mk_completion(pg_temp.part(pg_temp.kv('f4'), 1));
select pg_temp.setkv('f_minor', intake_private.fulfillment_state(pg_temp.part(pg_temp.kv('f4'), 1)::uuid));
select pg_temp.chk('N15 fulfillment_state: no completion is incomplete (never hidden); a completion with no determination is determination_outstanding; a declared adult is staff_confirmation_outstanding; a birthday adult is complete; a minor still needs guardian consent',
  pg_temp.kv('f_incomplete') = 'incomplete' and pg_temp.kv('f_outstanding') = 'determination_outstanding' and pg_temp.kv('f_declared') = 'staff_confirmation_outstanding'
  and pg_temp.kv('f_birthday') = 'complete' and pg_temp.kv('f_minor') = 'guardian_consent_outstanding',
  pg_temp.kv('f_incomplete') || ' ' || pg_temp.kv('f_outstanding') || ' ' || pg_temp.kv('f_declared') || ' ' || pg_temp.kv('f_birthday') || ' ' || pg_temp.kv('f_minor'));

-- ===== N16 markers, ACLs, catalog =====================================================================================
select pg_temp.chk('N16 every M15 body carries the m15 marker; the function inventory is 110; the new functions are owned by the migration owner with the expected grants; the catalog self-check passes',
  (select count(*) = 7 and bool_and(position('nsi-body:m15' in prosrc) > 0)
     from pg_proc where proname in ('studio_local_date', 'age_in_years', 'intake_determine_minor_from_birthday', 'intake_declare_minor_status', 'intake_session_minor_state', 'intake_minor_basis', 'fulfillment_state'))
  and (select count(*) = 110 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
  and (select bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE') and not has_function_privilege('intake_destructive', p.oid, 'EXECUTE'))
         from pg_proc p where p.proname in ('intake_determine_minor_from_birthday', 'intake_declare_minor_status', 'intake_session_minor_state', 'intake_minor_basis', 'studio_local_date', 'age_in_years'))
  and has_function_privilege('intake_destructive', 'intake_private.fulfillment_state(uuid)', 'EXECUTE')
  and pg_temp.try('select intake_private.assert_catalog()') = 'ok');

-- ===== result =========================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || left(detail, 300) || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I3-3 M15 SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I3-3 M15 SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

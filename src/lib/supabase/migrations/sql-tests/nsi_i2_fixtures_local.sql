-- NSI I2 (M7-M9) shared helpers and synthetic fixtures. LOCAL / DISPOSABLE ENVIRONMENTS ONLY.
-- Not a test by itself: the runner (run_i2_m7_m9_local.sh) concatenates this file with ONE test file, which ends with the
-- always-raising result block. Everything runs in one transaction and nothing persists.
-- Requires nsi.test_local = 'on' (synthetic auth users) and nsi.appointments_fp (pre-migration appointments fingerprint).

begin;

do $$ begin
  if coalesce(current_setting('nsi.test_local', true), '') <> 'on' then
    raise exception 'NSI I2 M7-M9 local suite refused: set nsi.test_local = ''on'' only on a disposable local stack';
  end if;
end $$;

create temp table t_results (name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
create temp table t_kv (k text primary key, v text) on commit drop;
grant all on t_kv to authenticated, anon, service_role;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail text default '') returns void
language plpgsql as $$ begin insert into t_results values (p_name, coalesce(p_ok, false), coalesce(p_detail, 'null')); end $$;
create or replace function pg_temp.kv(p_k text) returns text language sql as $$ select v from t_kv where k = p_k $$;
create or replace function pg_temp.setkv(p_k text, p_v text) returns void language sql as $$
  insert into t_kv values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin begin execute p_sql; return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end; end $$;
-- run as role (with JWT sub): returns 'ok' or 'SQLSTATE message'
create or replace function pg_temp.run_as(p_role text, p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', case when p_user is null then '' else json_build_object('sub', p_user, 'role', p_role)::text end, true);
  begin execute format('set local role %I', p_role); execute p_sql; v := 'ok';
  exception when others then v := sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
-- same, returning the first column of the first row (or 'ERR <SQLSTATE> <message>')
create or replace function pg_temp.val_as(p_role text, p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', case when p_user is null then '' else json_build_object('sub', p_user, 'role', p_role)::text end, true);
  begin execute format('set local role %I', p_role); execute p_sql into v;
  exception when others then v := 'ERR ' || sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
create or replace function pg_temp.u(p_k text) returns uuid language sql as $$ select pg_temp.kv(p_k)::uuid $$;

-- ids ------------------------------------------------------------------------------------------------------------
select pg_temp.setkv('sa', 'a5300000-0000-0000-0000-00000000000a');
select pg_temp.setkv('sb', 'a5300000-0000-0000-0000-00000000000b');
select pg_temp.setkv('owner_a', 'a5300000-0000-0000-0000-000000000101');
select pg_temp.setkv('admin_a', 'a5300000-0000-0000-0000-000000000102');
select pg_temp.setkv('fd_a', 'a5300000-0000-0000-0000-000000000103');
select pg_temp.setkv('instr_a', 'a5300000-0000-0000-0000-000000000104');
select pg_temp.setkv('plain_a', 'a5300000-0000-0000-0000-000000000105');
select pg_temp.setkv('owner_b', 'a5300000-0000-0000-0000-000000000201');
select pg_temp.setkv('padmin', 'a5300000-0000-0000-0000-000000000401');
select pg_temp.setkv('nobody', 'a5300000-0000-0000-0000-000000000999');
select pg_temp.setkv('ta', 'a5300000-0000-0000-0000-000000000c01');   -- studio A published template (v1 published)
select pg_temp.setkv('ta2', 'a5300000-0000-0000-0000-000000000c02');  -- studio A second published template
select pg_temp.setkv('tb', 'a5300000-0000-0000-0000-000000000c0b');   -- studio B published template

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select pg_temp.kv(k)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', k || '@nsi-i2-test.invalid', now(), now()
from unnest(array['owner_a', 'admin_a', 'fd_a', 'instr_a', 'plain_a', 'owner_b', 'padmin', 'nobody']) k;
insert into public.profiles (id, platform_role)
select pg_temp.kv(k)::uuid, case when k = 'padmin' then 'platform_admin' end
from unnest(array['owner_a', 'admin_a', 'fd_a', 'instr_a', 'plain_a', 'owner_b', 'padmin', 'nobody']) k
on conflict (id) do update set platform_role = excluded.platform_role;
insert into public.studios (id, name, slug) values
  (pg_temp.u('sa'), 'I2 M7-9 A', 'nsi-i2-m79-a'), (pg_temp.u('sb'), 'I2 M7-9 B', 'nsi-i2-m79-b');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  (pg_temp.u('owner_a'), pg_temp.u('sa'), 'studio_owner', true), (pg_temp.u('admin_a'), pg_temp.u('sa'), 'studio_admin', true),
  (pg_temp.u('fd_a'), pg_temp.u('sa'), 'front_desk', true), (pg_temp.u('instr_a'), pg_temp.u('sa'), 'instructor', true),
  (pg_temp.u('plain_a'), pg_temp.u('sa'), 'client', true), (pg_temp.u('owner_b'), pg_temp.u('sb'), 'studio_owner', true);

create or replace function pg_temp.mk_client(p_studio text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin insert into public.clients (id, studio_id, first_name, last_name) values (v, pg_temp.u(p_studio), 'Synthetic', 'I2'); return v; end $$;
-- offsets from now(); returns the appointment id
create or replace function pg_temp.mk_appt(p_studio text, p_client uuid, p_type text, p_status text, p_start interval, p_created interval)
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into public.appointments (id, studio_id, client_id, appointment_type, status, starts_at, ends_at, created_at)
  values (v, pg_temp.u(p_studio), p_client, p_type::public.appointment_type, p_status::public.appointment_status,
          now() + p_start, now() + p_start + interval '1 hour', now() + p_created);
  return v;
end $$;
-- direct (owner) grant fixture; p_active_days < 0 builds an already expired grant
create or replace function pg_temp.fx_grant(p_studio text, p_cap text, p_days int default 30) returns void language plpgsql as $$
begin
  update public.intake_feature_grants set revoked_at = now(), revoked_by = pg_temp.u('padmin'), revoke_reason = 'fixture superseded'
  where studio_id = pg_temp.u(p_studio) and capability = p_cap and revoked_at is null;
  if p_days >= 0 then
    insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at)
    values (pg_temp.u(p_studio), p_cap, 'fixture', pg_temp.u('padmin'), now() + make_interval(days => p_days));
  else
    set local session_replication_role = replica;
    insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, granted_at, expires_at)
    values (pg_temp.u(p_studio), p_cap, 'fixture', pg_temp.u('padmin'), now() - interval '40 days', now() - make_interval(days => -p_days));
    set local session_replication_role = origin;
  end if;
end $$;
-- evaluator outcome for (studio key, client, appointment) as of now (non-simulated unless p_assume given)
create or replace function pg_temp.ev(p_studio text, p_client uuid, p_appt uuid, p_assume timestamptz default null) returns text
language plpgsql as $$
declare v text;
begin
  -- 5-argument form exists from M8; before M8 only the 4-argument form exists
  if exists (select 1 from pg_proc where proname = 'evaluate_appointment_eligibility' and pronargs = 5) then
    execute 'select o_outcome from intake_private.evaluate_appointment_eligibility($1, $2, $3, now(), $4)' into v using pg_temp.u(p_studio), p_client, p_appt, p_assume;
  else
    execute 'select o_outcome from intake_private.evaluate_appointment_eligibility($1, $2, $3, now())' into v using pg_temp.u(p_studio), p_client, p_appt;
  end if;
  return v;
end $$;

-- templates (direct owner SQL: fixtures, not behavior under test). The schema has one student field "a".
select pg_temp.setkv('schema', '{"sections":[{"key":"s","title":"S","audience":"student","fields":[{"key":"a","type":"short_text","label":"A","required":false,"visibility":"staff_only","subject_scope":"about_student"}]}]}');
insert into public.intake_templates (id, studio_id, name) values
  (pg_temp.u('ta'), pg_temp.u('sa'), 'A main'), (pg_temp.u('ta2'), pg_temp.u('sa'), 'A second'), (pg_temp.u('tb'), pg_temp.u('sb'), 'B main');
insert into public.intake_template_versions (studio_id, template_id, version_number, status, schema, schema_sha256, max_answer_bytes, published_at)
select s, t, 1, 'published', pg_temp.kv('schema')::jsonb, 'x', 2000, now()
from (values (pg_temp.u('sa'), pg_temp.u('ta')), (pg_temp.u('sa'), pg_temp.u('ta2')), (pg_temp.u('sb'), pg_temp.u('tb'))) v(s, t);
select pg_temp.setkv('ta_v1', (select id::text from public.intake_template_versions where template_id = pg_temp.u('ta')));

-- row counts of every intake data table (read-only proof)
create or replace function pg_temp.intake_rows() returns text language plpgsql as $$
declare r record; out text := ''; v text;
begin
  for r in select relname from pg_class where relnamespace = 'public'::regnamespace and relname like 'intake\_%' and relkind = 'r'
             and relname not in ('intake_feature_grants', 'intake_audit_events', 'intake_templates', 'intake_template_versions',
                                 'intake_service_assignments', 'intake_settings', 'intake_studio_retention_choices') order by 1 loop
    execute format('select %L || '':'' || count(*) || '';'' from public.%I', r.relname, r.relname) into v using r.relname;
    out := out || v;
  end loop;
  return out;
end $$;


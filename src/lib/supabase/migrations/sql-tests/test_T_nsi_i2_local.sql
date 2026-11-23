-- NSI I2 (M6 20261118095000) eligibility evaluation and reconciliation preview -- LOCAL / DISPOSABLE ENVIRONMENTS ONLY.
-- Refuses unless nsi.test_local = 'on'. Mandatory: nsi.appointments_fp = pre-migration appointments fingerprint.
-- One transaction, synthetic fixtures only (UUID block a52xxxxx-...). The final block ALWAYS raises, so nothing persists:
-- "NSI I2 SUITE PASS (<n> checks)" or "NSI I2 SUITE FAIL: <failures>".
-- Fixture shortcut: completions/requests/audit rows are inserted under session_replication_role = replica (guard
-- triggers and FKs skipped, Gate A closed) and then evaluated under origin mode. Section G opens Gate A by replacing
-- intake_platform_policy() inside this rolled-back transaction, only to compare preview predictions with the deployed
-- intake_ensure_request.

begin;

do $$ begin
  if coalesce(current_setting('nsi.test_local', true), '') <> 'on' then
    raise exception 'NSI I2 local suite refused: set nsi.test_local = ''on'' only on a disposable local stack';
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
create or replace function pg_temp.val_as(p_role text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', '', true);
  begin execute format('set local role %I', p_role); execute p_sql into v;
  exception when others then v := 'ERR ' || sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  return v;
end $$;

-- fixtures -------------------------------------------------------------------------------------------------------
select pg_temp.setkv('sa', 'a5200000-0000-0000-0000-00000000000a');   -- enabled studio
select pg_temp.setkv('sb', 'a5200000-0000-0000-0000-00000000000b');   -- second enabled studio (multi-studio)
select pg_temp.setkv('sd', 'a5200000-0000-0000-0000-00000000000d');   -- settings exist, disabled
select pg_temp.setkv('sn', 'a5200000-0000-0000-0000-00000000000e');   -- no settings row
insert into public.studios (id, name, slug) values
  (pg_temp.kv('sa')::uuid, 'I2 A', 'nsi-i2-a'), (pg_temp.kv('sb')::uuid, 'I2 B', 'nsi-i2-b'),
  (pg_temp.kv('sd')::uuid, 'I2 D', 'nsi-i2-d'), (pg_temp.kv('sn')::uuid, 'I2 N', 'nsi-i2-n');

create or replace function pg_temp.mk_client(p_studio text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into public.clients (id, studio_id, first_name, last_name) values (v, pg_temp.kv(p_studio)::uuid, 'Synthetic', 'I2');
  return v;
end $$;
-- p_start / p_created are offsets from now(); returns the appointment id
create or replace function pg_temp.mk_appt(p_studio text, p_client uuid, p_type text, p_status text, p_start interval, p_created interval)
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into public.appointments (id, studio_id, client_id, appointment_type, status, starts_at, ends_at, created_at)
  values (v, pg_temp.kv(p_studio)::uuid, p_client, p_type::public.appointment_type, p_status::public.appointment_status,
          now() + p_start, now() + p_start + interval '1 hour', now() + p_created);
  return v;
end $$;
create or replace function pg_temp.ev(p_studio text, p_client uuid, p_appt uuid, p_now timestamptz default now()) returns text
language sql as $$ select o_outcome from intake_private.evaluate_appointment_eligibility(pg_temp.kv(p_studio)::uuid, p_client, p_appt, p_now) $$;

-- templates: default (v1, v2 published, v3 draft), coaching template, archived template, template without published version
select pg_temp.setkv('t_def', 'a5200000-0000-0000-0000-000000000c01');
select pg_temp.setkv('t_coach', 'a5200000-0000-0000-0000-000000000c02');
select pg_temp.setkv('t_arch', 'a5200000-0000-0000-0000-000000000c03');
select pg_temp.setkv('t_nov', 'a5200000-0000-0000-0000-000000000c04');
select pg_temp.setkv('t_b', 'a5200000-0000-0000-0000-000000000c05');
insert into public.intake_templates (id, studio_id, name, status) values
  (pg_temp.kv('t_def')::uuid, pg_temp.kv('sa')::uuid, 'Default', 'active'),
  (pg_temp.kv('t_coach')::uuid, pg_temp.kv('sa')::uuid, 'Coaching', 'active'),
  (pg_temp.kv('t_arch')::uuid, pg_temp.kv('sa')::uuid, 'Archived', 'archived'),
  (pg_temp.kv('t_nov')::uuid, pg_temp.kv('sa')::uuid, 'NoPublished', 'active'),
  (pg_temp.kv('t_b')::uuid, pg_temp.kv('sb')::uuid, 'B default', 'active');
insert into public.intake_template_versions (id, studio_id, template_id, version_number, status, schema, schema_sha256, max_answer_bytes, published_at)
select gen_random_uuid(), pg_temp.kv(s)::uuid, pg_temp.kv(t)::uuid, n, 'published', '{"sections":[]}', 'x', 10, now()
from (values ('sa','t_def',1), ('sa','t_def',2), ('sa','t_coach',1), ('sa','t_arch',1), ('sb','t_b',1)) v(s, t, n);
insert into public.intake_template_versions (studio_id, template_id, version_number, status, schema)
values (pg_temp.kv('sa')::uuid, pg_temp.kv('t_def')::uuid, 3, 'draft', '{"sections":[]}'),
       (pg_temp.kv('sa')::uuid, pg_temp.kv('t_nov')::uuid, 1, 'draft', '{"sections":[]}');
insert into public.intake_settings (studio_id, enabled, enabled_at, default_template_id) values
  (pg_temp.kv('sa')::uuid, true, now() - interval '2 days', pg_temp.kv('t_def')::uuid),
  (pg_temp.kv('sb')::uuid, true, now() - interval '2 days', pg_temp.kv('t_b')::uuid),
  (pg_temp.kv('sd')::uuid, false, null, null);
insert into public.intake_service_assignments (studio_id, appointment_type, template_id)
values (pg_temp.kv('sa')::uuid, 'coaching', pg_temp.kv('t_coach')::uuid);
-- M8 semantics: a row = the type is selected; NULL template = the studio default template
insert into public.intake_service_assignments (studio_id, appointment_type, template_id) values
  (pg_temp.kv('sa')::uuid, 'private_lesson', null), (pg_temp.kv('sa')::uuid, 'intro_lesson', null),
  (pg_temp.kv('sb')::uuid, 'private_lesson', null);
-- M7: live grants (the evaluator needs live_collection outside simulation)
insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at)
select pg_temp.kv(st)::uuid, 'live_collection', 'I2 suite fixture', gen_random_uuid(), now() + interval '30 days' from unnest(array['sa', 'sb', 'sd']) st;

-- baseline counts for the read-only proof
create temp table t_base as
select (select count(*) from public.intake_requests) req, (select count(*) from public.intake_request_appointments) ra,
       (select count(*) from public.intake_completions) comp, (select count(*) from public.intake_audit_events) aud,
       (select count(*) from public.outbound_deliveries) outb;

-- ===== E: evaluator outcomes ==========================================================================================
do $$
declare c uuid; c2 uuid; a uuid; a2 uuid; a3 uuid;
begin
  c := pg_temp.mk_client('sa');
  a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  perform pg_temp.chk('E01 qualifying first appointment -> would_create', pg_temp.ev('sa', c, a) = 'would_create', pg_temp.ev('sa', c, a));
  perform pg_temp.chk('E01b deterministic template/version: default template, highest PUBLISHED version (2, not draft 3)',
    (select o_template_id = pg_temp.kv('t_def')::uuid and o_version_number = 2
     from intake_private.evaluate_appointment_eligibility(pg_temp.kv('sa')::uuid, c, a, now())));
  perform pg_temp.chk('E01c evaluation is repeatable', pg_temp.ev('sa', c, a) = pg_temp.ev('sa', c, a));
  perform pg_temp.setkv('c_first', c::text); perform pg_temp.setkv('a_first', a::text);

  for c, a in select x.cc, pg_temp.mk_appt('sa', x.cc, x.ty, 'scheduled', interval '10 days', interval '-1 hour')
              from (select pg_temp.mk_client('sa') cc, ty from unnest(array['event','practice_party','floor_space_rental','room_unavailable']) ty) x loop
    perform pg_temp.chk('E02 non-qualifying type ' || (select appointment_type::text from public.appointments where id = a) || ' -> type_not_qualifying',
      pg_temp.ev('sa', c, a) = 'type_not_qualifying');
  end loop;

  for c, a in select x.cc, pg_temp.mk_appt('sa', x.cc, 'private_lesson', x.st, interval '10 days', interval '-1 hour')
              from (select pg_temp.mk_client('sa') cc, st from unnest(array['cancelled','attended','no_show']) st) x loop
    perform pg_temp.chk('E03 status ' || (select status::text from public.appointments where id = a) || ' -> appointment_not_live',
      pg_temp.ev('sa', c, a) = 'appointment_not_live');
  end loop;
  c := pg_temp.mk_client('sa');
  perform pg_temp.chk('E04 started appointment -> appointment_started',
    pg_temp.ev('sa', c, pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '-1 hour', interval '-1 hour')) = 'appointment_started');
  c := pg_temp.mk_client('sa');
  perform pg_temp.chk('E05 booked before enablement (no backfill) -> before_enablement',
    pg_temp.ev('sa', c, pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-3 days')) = 'before_enablement');
  c := pg_temp.mk_client('sa'); a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-2 minutes');
  perform pg_temp.chk('E06 inside the settle delay -> settling', pg_temp.ev('sa', c, a) = 'settling');
  perform pg_temp.chk('E06b same appointment after the settle delay -> would_create', pg_temp.ev('sa', c, a, now() + interval '9 minutes') = 'would_create');
  c := pg_temp.mk_client('sd'); a := pg_temp.mk_appt('sd', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  perform pg_temp.chk('E07 disabled studio -> studio_not_enabled', pg_temp.ev('sd', c, a) = 'studio_not_enabled');
  c := pg_temp.mk_client('sn'); a := pg_temp.mk_appt('sn', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  perform pg_temp.chk('E07b studio without settings (entitlement-less default) -> studio_not_enabled', pg_temp.ev('sn', c, a) = 'studio_not_enabled');
  update public.intake_settings set enabled = false, enabled_at = null where studio_id = pg_temp.kv('sd')::uuid;

  -- coaching assignment, archived assignment, template without published version, no template at all
  c := pg_temp.mk_client('sa'); a := pg_temp.mk_appt('sa', c, 'coaching', 'scheduled', interval '10 days', interval '-1 hour');
  perform pg_temp.chk('E08 assigned type uses its own template and version',
    (select o_outcome = 'would_create' and o_template_id = pg_temp.kv('t_coach')::uuid and o_version_number = 1
     from intake_private.evaluate_appointment_eligibility(pg_temp.kv('sa')::uuid, c, a, now())));
  set local session_replication_role = replica;
  update public.intake_service_assignments set template_id = pg_temp.kv('t_arch')::uuid where studio_id = pg_temp.kv('sa')::uuid and appointment_type = 'coaching';
  perform pg_temp.chk('E09 assigned template archived -> no_template', pg_temp.ev('sa', c, a) = 'no_template');
  update public.intake_service_assignments set template_id = pg_temp.kv('t_nov')::uuid where studio_id = pg_temp.kv('sa')::uuid and appointment_type = 'coaching';
  perform pg_temp.chk('E10 template with only a draft -> no_published_version', pg_temp.ev('sa', c, a) = 'no_published_version');
  update public.intake_service_assignments set template_id = pg_temp.kv('t_coach')::uuid where studio_id = pg_temp.kv('sa')::uuid and appointment_type = 'coaching';
  set local session_replication_role = origin;
  update public.intake_settings set default_template_id = null where studio_id = pg_temp.kv('sa')::uuid;
  c := pg_temp.mk_client('sa'); a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  perform pg_temp.chk('E11 no assignment and no default template -> no_template', pg_temp.ev('sa', c, a) = 'no_template');
  update public.intake_settings set default_template_id = pg_temp.kv('t_def')::uuid where studio_id = pg_temp.kv('sa')::uuid;

  -- existing / prior appointments
  c := pg_temp.mk_client('sa');
  a2 := pg_temp.mk_appt('sa', c, 'private_lesson', 'attended', interval '-30 days', interval '-31 days');
  a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  perform pg_temp.chk('E12 prior attended qualifying appointment -> existing_student', pg_temp.ev('sa', c, a) = 'existing_student');
  c := pg_temp.mk_client('sa');
  perform pg_temp.mk_appt('sa', c, 'practice_party', 'attended', interval '-30 days', interval '-31 days');
  a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  perform pg_temp.chk('E13 prior non-qualifying appointment does not make a student existing -> would_create', pg_temp.ev('sa', c, a) = 'would_create');
  c := pg_temp.mk_client('sa');
  perform pg_temp.mk_appt('sa', c, 'private_lesson', 'cancelled', interval '-30 days', interval '-31 days');
  a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  perform pg_temp.chk('E14 prior CANCELLED appointment ignored -> would_create', pg_temp.ev('sa', c, a) = 'would_create');
  c := pg_temp.mk_client('sa');
  a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  a2 := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '20 days', interval '-1 hour');
  perform pg_temp.chk('E15 two future appointments: earlier one -> would_create', pg_temp.ev('sa', c, a) = 'would_create');
  perform pg_temp.chk('E15b later one -> earlier_appointment_pending', pg_temp.ev('sa', c, a2) = 'earlier_appointment_pending');
  c := pg_temp.mk_client('sa');
  a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-3 days');
  a2 := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '20 days', interval '-1 hour');
  perform pg_temp.chk('E16 earlier future appointment booked before enablement -> later one is existing_student', pg_temp.ev('sa', c, a2) = 'existing_student');
  c := pg_temp.mk_client('sa');
  a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  update public.appointments set status = 'cancelled' where id = a;
  a2 := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '20 days', interval '-1 hour');
  perform pg_temp.chk('E17 earlier appointment cancelled: the later one becomes the first -> would_create', pg_temp.ev('sa', c, a2) = 'would_create');
  update public.appointments set status = 'scheduled', cancelled_at = null where id = a;
  perform pg_temp.chk('E17b earlier appointment reactivated: later one defers again', pg_temp.ev('sa', c, a2) = 'earlier_appointment_pending');
  -- reschedule keeps the same row: moving the earlier appointment after the later one swaps the roles
  update public.appointments set starts_at = now() + interval '30 days', ends_at = now() + interval '30 days 1 hour', status = 'rescheduled' where id = a;
  perform pg_temp.chk('E18 reschedule swaps first/later deterministically', pg_temp.ev('sa', c, a2) = 'would_create' and pg_temp.ev('sa', c, a) = 'earlier_appointment_pending');

  -- multi-studio: the same person is two client rows; ids never cross tenants
  c := pg_temp.mk_client('sa'); c2 := pg_temp.mk_client('sb');
  a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  a2 := pg_temp.mk_appt('sb', c2, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  perform pg_temp.chk('E19 studio A appointment evaluated in studio A', pg_temp.ev('sa', c, a) = 'would_create');
  perform pg_temp.chk('E19b studio B appointment evaluated in studio B uses studio B template',
    (select o_outcome = 'would_create' and o_template_id = pg_temp.kv('t_b')::uuid from intake_private.evaluate_appointment_eligibility(pg_temp.kv('sb')::uuid, c2, a2, now())));
  perform pg_temp.chk('E19c studio B appointment through studio A -> appointment_not_found', pg_temp.ev('sa', c2, a2) = 'appointment_not_found');
  perform pg_temp.chk('E19d studio A client with studio B appointment -> appointment_not_found', pg_temp.ev('sb', c, a2) = 'appointment_not_found');
  perform pg_temp.chk('E19e wrong client for a real appointment -> appointment_not_found', pg_temp.ev('sa', c2, a) = 'appointment_not_found');
  perform pg_temp.chk('E19f unknown appointment -> appointment_not_found', pg_temp.ev('sa', c, gen_random_uuid()) = 'appointment_not_found');
  perform pg_temp.mk_appt('sb', c2, 'private_lesson', 'attended', interval '-9 days', interval '-10 days');
  perform pg_temp.chk('E19g a prior appointment in studio B does not make the studio A client existing', pg_temp.ev('sa', c, a) = 'would_create');
end $$;

-- ===== R: completions, floors, open requests, erasure barrier (fixture rows via replica mode) =========================
select pg_temp.setkv('c_done', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('c_floor_new', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('c_floor_old', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('c_open', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('c_open2', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('c_erased', pg_temp.mk_client('sa')::text);
select pg_temp.setkv('c_other', pg_temp.mk_client('sb')::text);
select pg_temp.setkv('r_done', gen_random_uuid()::text);
select pg_temp.setkv('r_floor_new', gen_random_uuid()::text);
select pg_temp.setkv('r_floor_old', gen_random_uuid()::text);
select pg_temp.setkv('r_open', gen_random_uuid()::text);
select pg_temp.setkv('r_open2', gen_random_uuid()::text);
select pg_temp.setkv('r_other', gen_random_uuid()::text);

set local session_replication_role = replica;
insert into public.intake_requests (id, studio_id, client_id, template_id, status, source) values
  (pg_temp.kv('r_done')::uuid, pg_temp.kv('sa')::uuid, pg_temp.kv('c_done')::uuid, pg_temp.kv('t_def')::uuid, 'submitted', 'auto'),
  (pg_temp.kv('r_floor_new')::uuid, pg_temp.kv('sa')::uuid, pg_temp.kv('c_floor_new')::uuid, pg_temp.kv('t_def')::uuid, 'submitted', 'auto'),
  (pg_temp.kv('r_floor_old')::uuid, pg_temp.kv('sa')::uuid, pg_temp.kv('c_floor_old')::uuid, pg_temp.kv('t_def')::uuid, 'submitted', 'auto'),
  (pg_temp.kv('r_open')::uuid, pg_temp.kv('sa')::uuid, pg_temp.kv('c_open')::uuid, pg_temp.kv('t_def')::uuid, 'pending', 'auto'),
  (pg_temp.kv('r_open2')::uuid, pg_temp.kv('sa')::uuid, pg_temp.kv('c_open2')::uuid, pg_temp.kv('t_def')::uuid, 'invited', 'auto'),
  (pg_temp.kv('r_other')::uuid, pg_temp.kv('sb')::uuid, pg_temp.kv('c_other')::uuid, pg_temp.kv('t_b')::uuid, 'submitted', 'auto');
insert into public.intake_completions (studio_id, request_id, client_id, template_id, template_version_id, version_number, student_response_id)
values (pg_temp.kv('sb')::uuid, pg_temp.kv('r_other')::uuid, pg_temp.kv('c_other')::uuid, pg_temp.kv('t_b')::uuid, gen_random_uuid(), 1, gen_random_uuid());
insert into public.intake_completions (studio_id, request_id, client_id, template_id, template_version_id, version_number, student_response_id)
select pg_temp.kv('sa')::uuid, pg_temp.kv(r)::uuid, pg_temp.kv(c)::uuid, pg_temp.kv('t_def')::uuid, gen_random_uuid(), n, gen_random_uuid()
from (values ('r_done', 'c_done', 2), ('r_floor_new', 'c_floor_new', 1), ('r_floor_old', 'c_floor_old', 1)) v(r, c, n);
insert into public.intake_audit_events (studio_id, event_type, actor_type, retention_class, client_ref)
values (pg_temp.kv('sa')::uuid, 'erasure_record', 'system', 'erasure_record', pg_temp.kv('c_erased')::uuid);
set local session_replication_role = origin;
-- a completion in studio B for the person's studio B record
-- (cross-studio completions must not leak into studio A)
set local session_replication_role = replica;
update public.intake_template_versions set reintake_required = true where template_id = pg_temp.kv('t_def')::uuid and version_number = 2;
set local session_replication_role = origin;
update public.intake_templates set reintake_floor_version = 2, floor_effective_at = now() - interval '1 day'
where id = pg_temp.kv('t_def')::uuid;   -- floor v2 effective yesterday: c_done (v2) valid; the v1 completions are below it

do $$
declare a uuid; c uuid;
begin
  c := pg_temp.kv('c_done')::uuid;
  perform pg_temp.chk('R01 valid completion (version at/above floor) -> already_completed',
    pg_temp.ev('sa', c, pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour')) = 'already_completed');
  c := pg_temp.kv('c_floor_new')::uuid;
  perform pg_temp.chk('R02 completion below the floor, appointment created after the floor -> would_create_reintake',
    pg_temp.ev('sa', c, pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour')) = 'would_create_reintake');
  c := pg_temp.kv('c_floor_old')::uuid;
  perform pg_temp.chk('R03 completion below the floor, appointment created BEFORE floor_effective_at -> predates_reintake_floor',
    pg_temp.ev('sa', c, pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-30 hours')) = 'predates_reintake_floor');
  c := pg_temp.kv('c_open')::uuid; a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  perform pg_temp.chk('R04 open request, appointment not attached -> would_attach', pg_temp.ev('sa', c, a) = 'would_attach');
  perform pg_temp.setkv('a_open', a::text);
  set local session_replication_role = replica;
  insert into public.intake_request_appointments (studio_id, request_id, appointment_id, attached_by)
  values (pg_temp.kv('sa')::uuid, pg_temp.kv('r_open')::uuid, a, 'reconciler');
  set local session_replication_role = origin;
  perform pg_temp.chk('R05 open request, appointment attached -> already_attached', pg_temp.ev('sa', c, a) = 'already_attached');
  c := pg_temp.kv('c_open2')::uuid;
  perform pg_temp.chk('R06 open request wins over the first-appointment rule (second appointment attaches)',
    pg_temp.ev('sa', c, pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '5 days', interval '-1 hour')) = 'would_attach'
    and pg_temp.ev('sa', c, pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '15 days', interval '-1 hour')) = 'would_attach');
  c := pg_temp.kv('c_erased')::uuid;
  perform pg_temp.chk('R07 erasure barrier active -> erasure_barrier (no new obligation for an erased client)',
    pg_temp.ev('sa', c, pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour')) = 'erasure_barrier');
  c := pg_temp.kv('c_other')::uuid;
  perform pg_temp.chk('R08 studio B completion invisible to studio A and vice versa',
    not exists (select 1 from public.intake_completions where studio_id = pg_temp.kv('sa')::uuid and client_id = c)
    and pg_temp.ev('sb', c, pg_temp.mk_appt('sb', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour')) = 'already_completed');
end $$;

-- ===== P: preview (service_role surface) ==============================================================================
select pg_temp.setkv('p_all', pg_temp.val_as('service_role',
  format('select count(*) from public.intake_reconcile_preview(%L)', pg_temp.kv('sa'))));
select pg_temp.chk('P01 preview returns rows for studio A only', pg_temp.kv('p_all') ~ '^[0-9]+$' and pg_temp.kv('p_all')::int > 0, pg_temp.kv('p_all'));
select pg_temp.chk('P02 preview contains no appointment of another studio or of another studio''s client',
  (select count(*) = 0 from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid) p
   join public.appointments a on a.id = p.appointment_id where a.studio_id <> pg_temp.kv('sa')::uuid));
select pg_temp.chk('P03 preview never lists past, cancelled, pre-enablement or already-attached appointments',
  (select count(*) = 0 from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid) p join public.appointments a on a.id = p.appointment_id
   where a.starts_at <= now() or a.status::text not in ('scheduled', 'rescheduled', 'confirmed')
      or a.created_at < now() - interval '2 days' or a.id = pg_temp.kv('a_open')::uuid));
select pg_temp.chk('P04 preview is ordered oldest-first by (created_at, id)',
  (select array_agg(appointment_id order by ord) = array_agg(appointment_id order by appt_created_at, appointment_id)
   from (select p.*, row_number() over () ord from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid) p) x));
select pg_temp.chk('P05 disabled / unknown / no-settings studio -> empty preview',
  not exists (select 1 from public.intake_reconcile_preview(pg_temp.kv('sd')::uuid))
  and not exists (select 1 from public.intake_reconcile_preview(pg_temp.kv('sn')::uuid))
  and not exists (select 1 from public.intake_reconcile_preview(gen_random_uuid()))
  and not exists (select 1 from public.intake_reconcile_preview(null)));
select pg_temp.chk('P06 repeated preview is identical (no hidden state)',
  (select array_agg(appointment_id::text || outcome order by appointment_id) from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid))
  is not distinct from
  (select array_agg(appointment_id::text || outcome order by appointment_id) from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid)));
select pg_temp.chk('P07 limit clamps: 0 and negative -> 1 row, 1 -> 1 row',
  (select count(*) = 1 from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid, 0))
  and (select count(*) = 1 from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid, -5))
  and (select count(*) = 1 from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid, 1)));
-- keyset paging covers exactly the unpaged set with no overlap
do $$
declare v_c timestamptz; v_id uuid; v_n int; v_seen uuid[] := '{}'; v_total int; v_pages int := 0; r record;
begin
  loop
    v_n := 0;
    for r in select * from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid, 3, v_c, v_id) loop
      v_n := v_n + 1; v_seen := v_seen || r.appointment_id; v_c := r.appt_created_at; v_id := r.appointment_id;
    end loop;
    v_pages := v_pages + 1;
    exit when v_n < 3 or v_pages > 100;
  end loop;
  select count(*) into v_total from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid, 200);
  perform pg_temp.chk('P08 keyset paging (page size 3) visits every candidate exactly once',
    cardinality(v_seen) = v_total and (select count(distinct x) from unnest(v_seen) x) = v_total, format('seen=%s total=%s pages=%s', cardinality(v_seen), v_total, v_pages));
end $$;
-- hard cap of 200
do $$
declare c uuid := pg_temp.mk_client('sb'); n int;
begin
  insert into public.appointments (studio_id, client_id, appointment_type, status, starts_at, ends_at, created_at)
  select pg_temp.kv('sb')::uuid, c, 'private_lesson', 'scheduled', now() + interval '40 days' + g * interval '1 hour', now() + interval '41 days' + g * interval '1 hour', now() - interval '1 hour'
  from generate_series(1, 230) g;
  select count(*) into n from public.intake_reconcile_preview(pg_temp.kv('sb')::uuid, 100000);
  perform pg_temp.chk('P09 absurd limit is capped at 200 rows', n = 200, n::text);
end $$;
select pg_temp.chk('P10 status function reflects enablement and the closed gate',
  (select enabled and gate_a_open = false and new_obligation_allowed and default_template_configured and assignment_count = 3
   from public.intake_reconcile_status(pg_temp.kv('sa')::uuid))
  and (select not enabled and not new_obligation_allowed from public.intake_reconcile_status(pg_temp.kv('sd')::uuid))
  and (select not enabled and not new_obligation_allowed and not default_template_configured from public.intake_reconcile_status(pg_temp.kv('sn')::uuid)));
select pg_temp.chk('P11 preview wrote nothing: requests, attachments, completions, audit, outbound_deliveries unchanged (only fixture rows counted)',
  (select count(*) from public.intake_requests) = (select req + 6 from t_base)
  and (select count(*) from public.intake_request_appointments) = (select ra + 1 from t_base)
  and (select count(*) from public.intake_completions) = (select comp + 4 from t_base)
  and (select count(*) from public.intake_audit_events) = (select aud + 1 from t_base)
  and (select count(*) from public.outbound_deliveries) = (select outb from t_base));

-- ===== review follow-ups ====================================================================================
select pg_temp.chk('P12 one-sided cursor refused (both-or-neither)',
  pg_temp.try(format('select * from public.intake_reconcile_preview(%L, 10, now(), null)', pg_temp.kv('sa'))) like '22023%'
  and pg_temp.try(format('select * from public.intake_reconcile_preview(%L, 10, null, gen_random_uuid())', pg_temp.kv('sa'))) like '22023%');
select pg_temp.chk('P13 NULL p_now refused by the evaluator',
  pg_temp.try(format('select * from intake_private.evaluate_appointment_eligibility(%L, %L, %L, null)', pg_temp.kv('sa'), gen_random_uuid(), gen_random_uuid())) like '22023%');
do $$
declare c uuid := pg_temp.mk_client('sa'); a uuid; a2 uuid; r uuid := gen_random_uuid();
begin
  -- confirmed appointment and intro_lesson qualify
  a := pg_temp.mk_appt('sa', c, 'intro_lesson', 'confirmed', interval '9 days', interval '-1 hour');
  perform pg_temp.chk('E20 confirmed intro_lesson -> would_create', pg_temp.ev('sa', c, a) = 'would_create');
  -- prior no_show counts as a prior appointment
  c := pg_temp.mk_client('sa');
  perform pg_temp.mk_appt('sa', c, 'private_lesson', 'no_show', interval '-20 days', interval '-21 days');
  perform pg_temp.chk('E21 prior no_show -> existing_student', pg_temp.ev('sa', c, pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')) = 'existing_student');
  -- same starts_at: deterministic by id
  c := pg_temp.mk_client('sa');
  a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  update public.appointments set starts_at = date_trunc('second', now() + interval '9 days'), ends_at = date_trunc('second', now() + interval '9 days 1 hour') where id = a;
  a2 := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  update public.appointments set starts_at = (select starts_at from public.appointments where id = a), ends_at = (select ends_at from public.appointments where id = a) where id = a2;
  perform pg_temp.chk('E22 identical starts_at: exactly one of the pair is would_create, the other earlier_appointment_pending',
    array[pg_temp.ev('sa', c, a), pg_temp.ev('sa', c, a2)] @> array['would_create', 'earlier_appointment_pending']);
  -- detached attachment is not 'already_attached'
  c := pg_temp.mk_client('sa'); a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  set local session_replication_role = replica;
  insert into public.intake_requests (id, studio_id, client_id, template_id, status, source) values (r, pg_temp.kv('sa')::uuid, c, pg_temp.kv('t_def')::uuid, 'pending', 'auto');
  insert into public.intake_request_appointments (studio_id, request_id, appointment_id, attached_by, detached_at) values (pg_temp.kv('sa')::uuid, r, a, 'reconciler', now());
  set local session_replication_role = origin;
  perform pg_temp.chk('E23 detached attachment -> would_attach through M10 (never already_attached); from M11 detached_from_request (no re-attach churn)', pg_temp.ev('sa', c, a) = case when exists (select 1 from pg_proc where proname = 'evaluate_appointment_eligibility' and pronargs = 5 and position('nsi-body:m11' in prosrc) > 0) then 'detached_from_request' else 'would_attach' end);
  -- open request but appointment predates the floor: no attach (matches intake_ensure_request)
  c := pg_temp.kv('c_floor_old')::uuid;
  set local session_replication_role = replica;
  insert into public.intake_requests (studio_id, client_id, template_id, status, source) values (pg_temp.kv('sa')::uuid, c, pg_temp.kv('t_def')::uuid, 'pending', 'manual');
  set local session_replication_role = origin;
  perform pg_temp.chk('E24 open request + appointment predating the floor -> predates_reintake_floor',
    pg_temp.ev('sa', c, pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '11 days', interval '-30 hours')) = 'predates_reintake_floor');
end $$;

-- ===== owner decisions (couple-lesson partners, imported bookings) =================================================
do $$
declare x uuid; p uuid; pb uuid; xb uuid; a uuid; ap uuid; ai uuid;
begin
  -- partner participation counts as prior history (historical, same studio)
  x := pg_temp.mk_client('sa'); p := pg_temp.mk_client('sa');
  ap := pg_temp.mk_appt('sa', x, 'private_lesson', 'attended', interval '-30 days', interval '-31 days');
  update public.appointments set partner_client_id = p where id = ap;
  a := pg_temp.mk_appt('sa', p, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  perform pg_temp.chk('Q01 partner on an earlier attended private lesson -> existing_student', pg_temp.ev('sa', p, a) = 'existing_student');
  perform pg_temp.chk('Q01b the primary client of that lesson is existing too (client_id path unchanged)',
    pg_temp.ev('sa', x, pg_temp.mk_appt('sa', x, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')) = 'existing_student');
  -- partner on an earlier FUTURE appointment created after enablement -> the later own booking defers
  x := pg_temp.mk_client('sa'); p := pg_temp.mk_client('sa');
  ap := pg_temp.mk_appt('sa', x, 'private_lesson', 'scheduled', interval '5 days', interval '-1 hour');
  update public.appointments set partner_client_id = p where id = ap;
  a := pg_temp.mk_appt('sa', p, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  perform pg_temp.chk('Q02 partner on an earlier future appointment -> own later booking earlier_appointment_pending', pg_temp.ev('sa', p, a) = 'earlier_appointment_pending');
  -- cancelled / non-qualifying partner appointments do not count
  x := pg_temp.mk_client('sa'); p := pg_temp.mk_client('sa');
  ap := pg_temp.mk_appt('sa', x, 'private_lesson', 'cancelled', interval '-30 days', interval '-31 days');
  update public.appointments set partner_client_id = p where id = ap;
  ap := pg_temp.mk_appt('sa', x, 'practice_party', 'attended', interval '-20 days', interval '-21 days');
  update public.appointments set partner_client_id = p where id = ap;
  perform pg_temp.chk('Q03 partner on a cancelled or non-qualifying appointment -> would_create',
    pg_temp.ev('sa', p, pg_temp.mk_appt('sa', p, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')) = 'would_create');
  -- multi-studio isolation: studio-B history never reaches studio A, in either direction
  xb := pg_temp.mk_client('sb'); p := pg_temp.mk_client('sa');
  ap := pg_temp.mk_appt('sb', xb, 'private_lesson', 'attended', interval '-30 days', interval '-31 days');
  update public.appointments set partner_client_id = p where id = ap;   -- cross-studio partner reference (FK allows it)
  perform pg_temp.chk('Q04 partner reference inside a studio-B appointment does not make the studio-A client existing',
    pg_temp.ev('sa', p, pg_temp.mk_appt('sa', p, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')) = 'would_create');
  x := pg_temp.mk_client('sa'); pb := pg_temp.mk_client('sb');
  ap := pg_temp.mk_appt('sa', x, 'private_lesson', 'attended', interval '-30 days', interval '-31 days');
  update public.appointments set partner_client_id = pb where id = ap;
  perform pg_temp.chk('Q05 studio-A appointment naming a studio-B partner does not make the studio-B client existing',
    pg_temp.ev('sb', pb, pg_temp.mk_appt('sb', pb, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')) = 'would_create');
  -- imported (source_system) bookings are never automatic candidates
  x := pg_temp.mk_client('sa'); a := pg_temp.mk_appt('sa', x, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  update public.appointments set source_system = 'csv_import' where id = a;
  perform pg_temp.chk('Q06 populated source_system created after enablement -> imported_source', pg_temp.ev('sa', x, a) = 'imported_source');
  update public.appointments set source_system = '   ' where id = a;
  perform pg_temp.chk('Q07 blank/whitespace source_system is not an import marker -> would_create', pg_temp.ev('sa', x, a) = 'would_create');
  update public.appointments set source_system = null where id = a;
  perform pg_temp.chk('Q07b NULL source_system -> would_create', pg_temp.ev('sa', x, a) = 'would_create');
  update public.appointments set source_system = 'csv_import' where id = a;
  perform pg_temp.setkv('q_import_appt', a::text);
  -- an imported HISTORICAL appointment still proves the client is existing
  x := pg_temp.mk_client('sa');
  ai := pg_temp.mk_appt('sa', x, 'private_lesson', 'attended', interval '-30 days', interval '-31 days');
  update public.appointments set source_system = 'csv_import' where id = ai;
  perform pg_temp.chk('Q08 imported historical appointment still counts as prior history -> existing_student',
    pg_temp.ev('sa', x, pg_temp.mk_appt('sa', x, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour')) = 'existing_student');
  -- studio scoping of the import check
  x := pg_temp.mk_client('sb'); a := pg_temp.mk_appt('sb', x, 'private_lesson', 'scheduled', interval '9 days', interval '-1 hour');
  update public.appointments set source_system = 'csv_import' where id = a;
  perform pg_temp.chk('Q09 studio-B import is not visible through studio A (appointment_not_found)', pg_temp.ev('sa', x, a) = 'appointment_not_found');
end $$;
select pg_temp.chk('Q10 preview omits imported appointments and still lists native ones',
  not exists (select 1 from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid, 200) where appointment_id = pg_temp.kv('q_import_appt')::uuid)
  and (select count(*) > 0 from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid, 200) where outcome = 'would_create'));
select pg_temp.chk('Q11 no imported appointment appears anywhere in the preview',
  not exists (select 1 from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid, 200) p join public.appointments a on a.id = p.appointment_id
              where nullif(btrim(a.source_system), '') is not null));

-- ===== A: authorization / privileges ==================================================================================
-- (live 'permission denied' probes under a switched role crash the local 17.6 image; privileges are proven through the catalog)
select pg_temp.chk('A01 anon and authenticated hold no EXECUTE on preview/status/evaluator',
  (select bool_and(not has_function_privilege(r, p.oid, 'EXECUTE')) from pg_proc p, unnest(array['anon', 'authenticated']) r
   where p.proname in ('evaluate_appointment_eligibility', 'intake_reconcile_preview', 'intake_reconcile_status')));
select pg_temp.chk('A02 service_role cannot reach the internal evaluator, the intake_private schema or intake tables',
  not has_function_privilege('service_role', 'intake_private.evaluate_appointment_eligibility(uuid,uuid,uuid,timestamptz,timestamptz)', 'EXECUTE')
  and not has_schema_privilege('service_role', 'intake_private', 'USAGE')
  and not has_table_privilege('service_role', 'public.intake_requests', 'SELECT')
  and not has_table_privilege('service_role', 'public.intake_settings', 'SELECT')
  and not has_table_privilege('service_role', 'public.intake_completions', 'SELECT'));
select pg_temp.chk('A03 service_role executes exactly the documented service surface',
  (select array_agg(distinct p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private') and has_function_privilege('service_role', p.oid, 'EXECUTE'))
  = (select array_agg(x order by x) from unnest(array['intake_ensure_request', 'intake_platform_policy', 'intake_reconcile_preview', 'intake_reconcile_status', 'intake_save_draft', 'intake_submit_response']::name[] || case when to_regclass('public.intake_sessions') is not null then array['intake_exchange_invitation', 'intake_purge_expired', 'intake_rate_limit_hit', 'intake_revoke_all_invitations_for_key', 'intake_revoke_session', 'intake_session_context']::name[] else '{}'::name[] end) x));
select pg_temp.chk('A04 M6 functions: postgres-owned, SECURITY DEFINER, pinned search_path, no PUBLIC/anon/authenticated execute',
  (select count(*) = 3 and bool_and(pg_get_userbyid(proowner) = 'postgres' and prosecdef and 'search_path=pg_catalog, pg_temp' = any (proconfig)
     and not has_function_privilege('anon', oid, 'EXECUTE') and not has_function_privilege('authenticated', oid, 'EXECUTE')
     and not has_function_privilege('intake_destructive', oid, 'EXECUTE'))
   from pg_proc where proname in ('evaluate_appointment_eligibility', 'intake_reconcile_preview', 'intake_reconcile_status')));
select pg_temp.chk('A05 catalog self-check passes with M6', pg_temp.try('select intake_private.assert_catalog()') = 'ok', pg_temp.try('select intake_private.assert_catalog()'));
select pg_temp.chk('A06 exactly 19 tables and 85 functions (70 + 3 + 12; 22 and 103 from M12), collection gate closed',
  (select count(*) = case when to_regclass('public.intake_sessions') is not null then 22 else 19 end from pg_class where relnamespace = 'public'::regnamespace and relname like 'intake\_%' and relkind = 'r')
  and (select count(*) = case when to_regclass('public.intake_sessions') is not null then (case when to_regprocedure('public.intake_determine_minor_from_birthday(uuid,uuid)') is not null then 110 when to_regprocedure('intake_private.legal_hold_insert_guard()') is not null then 104 else 103 end) else 85 end from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'public' and p.proname like 'intake\_%') or n.nspname = 'intake_private')
  and not intake_private.retention_gate_open());
select pg_temp.chk('A07 appointments fingerprint equals the pre-migration baseline (no appointment schema change)',
  nullif(current_setting('nsi.appointments_fp', true), '') is not null
  and current_setting('nsi.appointments_fp', true) = (select md5(
        (select string_agg(tgname || pg_get_triggerdef(oid), '|' order by tgname) from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal)
     || (select string_agg(conname || pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid = 'public.appointments'::regclass)
     || (select string_agg(indexdef, '|' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'appointments')
     || (select coalesce(string_agg(conrelid::regclass::text || conname, '|' order by conname), '') from pg_constraint where confrelid = 'public.appointments'::regclass))),
  'supplied=' || coalesce(nullif(current_setting('nsi.appointments_fp', true), ''), '<missing>'));
select pg_temp.chk('A08 M6 objects are functions only: no table, trigger or outbound_deliveries writer',
  not exists (select 1 from pg_proc where proname in ('evaluate_appointment_eligibility', 'intake_reconcile_preview', 'intake_reconcile_status')
              and (prosrc ~* '\m(insert|update|delete)\s+(into|from)?\s*(public\.)?(intake_|outbound_)' or prosrc ~* 'outbound_deliveries'))
  and (select bool_and(provolatile = 's') from pg_proc where proname in ('evaluate_appointment_eligibility', 'intake_reconcile_preview', 'intake_reconcile_status')));

-- ===== G: gate closed refuses persistence; divergence between preview and deployed ensure_request ====================
select pg_temp.setkv('g1', pg_temp.val_as('service_role', format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('c_first'), pg_temp.kv('a_first'))));
select pg_temp.chk('G01 Gate A closed: persistent request creation refused (preview says would_create, nothing bypassed)',
  pg_temp.kv('g1') like 'ERR 42501%retention_policy_incomplete%'
  and not exists (select 1 from public.intake_requests where client_id = pg_temp.kv('c_first')::uuid), pg_temp.kv('g1'));

create or replace function public.intake_platform_policy()
returns table (policy_version int, draft_retention_days int, draft_max_days int, draft_protected_window_days int,
  post_relationship_max_days int, evidence_core_days int, evidence_identity_days int, audit_operational_days int,
  audit_security_days int, hold_record_days_after_release int, approved_basis_ref text)
language sql stable set search_path = pg_catalog, pg_temp
as $$ select 999, 90, 180, 90, 365, 3650, 365, 730, 1825, 365, 'TEST ONLY'::text $$;

select pg_temp.setkv('g2', pg_temp.val_as('service_role', format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('c_first'), pg_temp.kv('a_first'))));
select pg_temp.setkv('g3', pg_temp.val_as('service_role', format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), pg_temp.kv('c_first'), pg_temp.kv('a_first'))));
select pg_temp.chk('G02 [gate open in test only] would_create -> exactly one request; repeated runs return the same id (idempotent)',
  pg_temp.kv('g2') ~ '^[0-9a-f-]{36}$' and pg_temp.kv('g2') = pg_temp.kv('g3')
  and (select count(*) = 1 from public.intake_requests where client_id = pg_temp.kv('c_first')::uuid), pg_temp.kv('g2') || ' / ' || pg_temp.kv('g3'));
select pg_temp.chk('G03 after creation the evaluator reports already_attached and the preview omits the appointment',
  pg_temp.ev('sa', pg_temp.kv('c_first')::uuid, pg_temp.kv('a_first')::uuid) = 'already_attached'
  and not exists (select 1 from public.intake_reconcile_preview(pg_temp.kv('sa')::uuid, 200) where appointment_id = pg_temp.kv('a_first')::uuid));
select pg_temp.chk('G04 no outbound_deliveries row was queued by request creation', (select count(*) from public.outbound_deliveries) = (select outb from t_base));
-- DISC-1: existing student
do $$
declare c uuid := pg_temp.mk_client('sa'); a uuid; r text; e text;
begin
  perform pg_temp.mk_appt('sa', c, 'private_lesson', 'attended', interval '-30 days', interval '-31 days');
  a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  e := pg_temp.ev('sa', c, a);
  r := pg_temp.val_as('service_role', format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), c, a));
  perform pg_temp.chk('G05 DISC-1 (M1-M9: documented divergence, ensure_request would still create a request; from M10 CLOSED: existing_student creates nothing)',
    e = 'existing_student' and (case when exists (select 1 from pg_proc where proname = 'intake_ensure_request' and prosrc ~ 'nsi-body:m1[01]') then r is null else r ~ '^[0-9a-f-]{36}$' end), r);
  -- DISC-2: watermark and settle delay
  c := pg_temp.mk_client('sa'); a := pg_temp.mk_appt('sa', c, 'private_lesson', 'scheduled', interval '10 days', interval '-3 days');
  e := pg_temp.ev('sa', c, a);
  r := pg_temp.val_as('service_role', format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), c, a));
  perform pg_temp.chk('G06 DISC-2 (M1-M9: documented divergence, ensure_request would backfill; from M10 CLOSED: before_enablement creates nothing)',
    e = 'before_enablement' and (case when exists (select 1 from pg_proc where proname = 'intake_ensure_request' and prosrc ~ 'nsi-body:m1[01]') then r is null else r ~ '^[0-9a-f-]{36}$' end), r);
  -- DISC-3: group class stays refused by both
  c := pg_temp.mk_client('sa'); a := pg_temp.mk_appt('sa', c, 'practice_party', 'scheduled', interval '10 days', interval '-1 hour');
  r := pg_temp.val_as('service_role', format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), c, a));
  perform pg_temp.chk('G07 non-qualifying type: preview type_not_qualifying and ensure_request refuses (agreement)', pg_temp.ev('sa', c, a) = 'type_not_qualifying' and r like 'ERR 22023%', r);
  -- cross-tenant: studio B client through studio A refused by ensure_request
  c := pg_temp.mk_client('sb'); a := pg_temp.mk_appt('sb', c, 'private_lesson', 'scheduled', interval '10 days', interval '-1 hour');
  r := pg_temp.val_as('service_role', format('select public.intake_ensure_request(%L, %L, %L)', pg_temp.kv('sa'), c, a));
  perform pg_temp.chk('G08 cross-tenant ensure_request refused', r like 'ERR 42501%', r);
end $$;
-- cancellation of the anchor after creation: preview/evaluator stop treating it as live; request stays (suspension is I3/I4)
update public.appointments set status = 'cancelled' where id = pg_temp.kv('a_first')::uuid;
select pg_temp.chk('G09 cancelled anchor appointment -> appointment_not_live, the request row is untouched',
  pg_temp.ev('sa', pg_temp.kv('c_first')::uuid, pg_temp.kv('a_first')::uuid) = 'appointment_not_live'
  and (select status = 'pending' from public.intake_requests where id = pg_temp.kv('g2')::uuid));

-- ===== result =========================================================================================================
do $$
declare v_fail text; v_n int; v_ok int;
begin
  select count(*), count(*) filter (where ok) into v_n, v_ok from t_results;
  select string_agg(name || ' [' || detail || ']', '; ') into v_fail from t_results where not ok;
  if v_fail is null then raise exception 'NSI I2 SUITE PASS (% checks)', v_n;
  else raise exception 'NSI I2 SUITE FAIL: % of % failed: %', v_n - v_ok, v_n, v_fail; end if;
end $$;

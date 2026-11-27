-- LOCAL DISPOSABLE STACK ONLY. M1+M2 governance behaviour probe; always rolls back (final raise).
begin;
create temp table r (name text, ok boolean, detail text) on commit drop;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin begin execute p_sql; return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end; end $$;
create or replace function pg_temp.try_as(p_role text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  begin execute format('set local role %I', p_role); execute p_sql; v := 'ok';
  exception when others then v := sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  return v;
end $$;
create or replace function pg_temp.chk(n text, ok boolean, d text default '') returns void language sql as $$ insert into r values (n, coalesce(ok, false), d) $$;

insert into public.studios (id, name, slug) values ('a5600000-0000-0000-0000-00000000000a', 'NSI D2 local probe', 'nsi-d2-local-a56');
insert into public.clients (id, studio_id, first_name, last_name) values ('a5600000-0000-0000-0000-0000000000a1', 'a5600000-0000-0000-0000-00000000000a', 'Synthetic', 'D2');
select intake_private.audit_write('a5600000-0000-0000-0000-00000000000a', 'settings_updated', 'staff', null, 'studio_owner', null, null, null, null, null, '{}'::jsonb, 'operational');
select pg_temp.chk('B01 audit rows are append-only (owner update refused)',
  pg_temp.try('update public.intake_audit_events set metadata = ''{}''') like '42501%append-only%');
select pg_temp.chk('B02 audit rows cannot be deleted by the owner',
  pg_temp.try('delete from public.intake_audit_events') like '42501%append-only%');
select pg_temp.chk('B03 TRUNCATE refused on audit events and legal holds',
  pg_temp.try('truncate public.intake_audit_events') like '42501%TRUNCATE%' and pg_temp.try('truncate public.intake_legal_holds') like '42501%TRUNCATE%');
select pg_temp.chk('B04 audit metadata outside the allowlist refused',
  pg_temp.try($q$select intake_private.audit_write('a5600000-0000-0000-0000-00000000000a', 'settings_updated', 'staff', null, null, null, null, null, null, null, '{"name":"Jane"}'::jsonb, 'operational')$q$) like '22023%allowlist%');
select pg_temp.chk('B05 dark audit rows get no retention date (pending_policy)',
  (select bool_and(retention_state = 'pending_policy' and retain_until is null) from public.intake_audit_events));
insert into public.intake_legal_holds (studio_id, scope_type, scope_ref, client_ref, reason, retention_basis, review_due_at, created_by)
values ('a5600000-0000-0000-0000-00000000000a', 'client', 'a5600000-0000-0000-0000-0000000000a1', 'a5600000-0000-0000-0000-0000000000a1', 'probe', 'probe', now() + interval '1 day', 'a5600000-0000-0000-0000-0000000000a1');
select pg_temp.chk('B06 legal hold facts immutable and holds undeletable',
  pg_temp.try('update public.intake_legal_holds set scope_ref = gen_random_uuid()') like '42501%immutable%'
  and pg_temp.try('delete from public.intake_legal_holds') like '42501%cannot be deleted%');
select pg_temp.chk('B07 client_has_active_hold / is_held see the hold',
  intake_private.client_has_active_hold('a5600000-0000-0000-0000-00000000000a', 'a5600000-0000-0000-0000-0000000000a1')
  and intake_private.is_held('a5600000-0000-0000-0000-00000000000a', 'a5600000-0000-0000-0000-0000000000a1', null, null, null, null));
select intake_private.audit_write('a5600000-0000-0000-0000-00000000000a', 'erasure_record', 'platform_admin', null, 'platform_admin', null, 'a5600000-0000-0000-0000-0000000000a1', null, null, null, '{}'::jsonb, 'erasure_record');
-- (separate statements: erasure_barrier_active is STABLE and sees the statement-start snapshot)
select pg_temp.chk('B08a erasure barrier active after an erasure record',
  intake_private.erasure_barrier_active('a5600000-0000-0000-0000-00000000000a', 'a5600000-0000-0000-0000-0000000000a1'));
select intake_private.audit_write('a5600000-0000-0000-0000-00000000000a', 'erasure_barrier_released', 'platform_admin', null, null, null, 'a5600000-0000-0000-0000-0000000000a1', null, null, null, '{}'::jsonb, 'erasure_record');
select pg_temp.chk('B08b barrier released by an appended release event; the erasure record is unchanged',
  not intake_private.erasure_barrier_active('a5600000-0000-0000-0000-00000000000a', 'a5600000-0000-0000-0000-0000000000a1')
  and (select count(*) = 1 from public.intake_audit_events where event_type = 'erasure_record'));
select intake_private.audit_write(null, null, null, null, null, null, null, null, null, null, null, 'environment_marker');
select intake_private.audit_write(null, null, null, null, null, null, null, null, null, null, null, 'environment_marker');
select pg_temp.chk('B09 first-use marker: exactly one, studio-less, and permanent',
  (select count(*) = 1 and bool_and(studio_id is null) from public.intake_audit_events where retention_class = 'environment_marker')
  and pg_temp.try('delete from public.intake_audit_events where retention_class = ''environment_marker''') like '42501%permanent%');
select pg_temp.chk(format('B10 %s has no access to %s', ro, t),
  pg_temp.try_as(ro, format('select 1 from public.%I limit 1', t)) like '42501%permission denied%')
from unnest(array['anon', 'authenticated', 'service_role']) ro, unnest(array['intake_audit_events', 'intake_legal_holds']) t;
select pg_temp.chk('B11 restricted role may not delete holds or audit rows (no privilege)',
  pg_temp.try_as('intake_destructive', 'delete from public.intake_legal_holds') like '42501%permission denied%'
  and pg_temp.try_as('intake_destructive', 'delete from public.intake_audit_events') like '42501%permission denied%');
do $$ declare n int; f text; begin
  select count(*), string_agg(name || ' -> ' || detail, ' | ') filter (where not ok) into n, f from r;
  if f is null then raise exception 'NSI D2 LOCAL BEHAVIOUR PASS (% checks)', n; else raise exception 'NSI D2 LOCAL BEHAVIOUR FAIL: %', f; end if;
end $$;

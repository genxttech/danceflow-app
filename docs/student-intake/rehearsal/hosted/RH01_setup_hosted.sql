-- RH01 — NSI I1 G7/G8/G10 feasibility rehearsal setup (synthetic only; idempotent).
-- Target: disposable local stack "nsi-g7-rehearsal" ONLY. Not an I1 migration.
begin;

-- G7: restricted role
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'intake_destructive') then
    create role intake_destructive nologin noinherit nobypassrls;
  end if;
end $$;

-- private, non-exposed schema
create schema if not exists intake_private;
revoke all on schema intake_private from public, anon, authenticated, service_role;
grant usage, create on schema intake_private to intake_destructive;

-- synthetic tables
create table if not exists public.nsi_rh_profiles (
  id uuid primary key,
  platform_role text
);
create table if not exists public.nsi_rh_requests (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null,
  client_id uuid not null,
  answers jsonb
);
create table if not exists public.nsi_rh_audit (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid,
  client_ref uuid,
  event_type text not null,
  actor_user_id uuid,
  exec_role text,
  retention_class text not null default 'operational',
  created_at timestamptz not null default clock_timestamp(),
  constraint nsi_rh_audit_marker_scope check ((retention_class = 'environment_marker') = (studio_id is null))
);
create unique index if not exists nsi_rh_audit_one_marker on public.nsi_rh_audit ((true)) where retention_class = 'environment_marker';

revoke all on public.nsi_rh_profiles, public.nsi_rh_requests, public.nsi_rh_audit from public, anon, authenticated, service_role;
alter table public.nsi_rh_profiles enable row level security;
alter table public.nsi_rh_requests enable row level security;
alter table public.nsi_rh_audit enable row level security;

grant select, delete on public.nsi_rh_requests to intake_destructive;
drop policy if exists nsi_rh_requests_destructive_select on public.nsi_rh_requests;
drop policy if exists nsi_rh_requests_destructive_delete on public.nsi_rh_requests;
create policy nsi_rh_requests_destructive_select on public.nsi_rh_requests for select to intake_destructive using (true);
create policy nsi_rh_requests_destructive_delete on public.nsi_rh_requests for delete to intake_destructive using (true);

-- helpers (owner postgres)
create or replace function public.nsi_rh_is_platform_admin()
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (select 1 from public.nsi_rh_profiles p
                 where p.id = auth.uid() and p.platform_role = 'platform_admin');
$$;

create or replace function public.nsi_rh_audit_write(p_studio uuid, p_client uuid, p_event text, p_actor uuid, p_exec_role text, p_class text default 'operational')
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_class = 'environment_marker' then
    insert into public.nsi_rh_audit (studio_id, client_ref, event_type, actor_user_id, exec_role, retention_class)
    values (null, null, p_event, null, p_exec_role, p_class)
    on conflict ((true)) where retention_class = 'environment_marker' do nothing;
  else
    insert into public.nsi_rh_audit (studio_id, client_ref, event_type, actor_user_id, exec_role, retention_class)
    values (p_studio, p_client, p_event, p_actor, p_exec_role, p_class);
  end if;
end $$;

create or replace function public.nsi_rh_barrier_active(p_studio uuid, p_client uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce((
    select a.event_type = 'erasure_record'
    from public.nsi_rh_audit a
    where a.studio_id = p_studio and a.client_ref = p_client
      and a.event_type in ('erasure_record', 'erasure_barrier_released')
    order by a.created_at desc, a.id desc
    limit 1), false);
$$;

-- protected-change trigger (invoker; pinned path)
create or replace function public.nsi_rh_requests_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if public.nsi_rh_barrier_active(new.studio_id, new.client_id) then
      raise exception 'nsi_rh: erasure barrier active' using errcode = '42501';
    end if;
    return new;
  end if;
  if current_user <> 'intake_destructive' then
    raise exception 'nsi_rh: protected change refused for %', current_user using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create or replace function public.nsi_rh_refuse_truncate()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'nsi_rh: truncate refused' using errcode = '42501';
end $$;

create or replace function public.nsi_rh_audit_append_only()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'nsi_rh: audit is append-only' using errcode = '42501';
end $$;

drop trigger if exists nsi_rh_requests_guard on public.nsi_rh_requests;
create trigger nsi_rh_requests_guard before insert or update or delete on public.nsi_rh_requests
  for each row execute function public.nsi_rh_requests_guard();
drop trigger if exists nsi_rh_requests_no_truncate on public.nsi_rh_requests;
create trigger nsi_rh_requests_no_truncate before truncate on public.nsi_rh_requests
  for each statement execute function public.nsi_rh_refuse_truncate();
drop trigger if exists nsi_rh_audit_append_only on public.nsi_rh_audit;
create trigger nsi_rh_audit_append_only before update or delete on public.nsi_rh_audit
  for each row execute function public.nsi_rh_audit_append_only();
drop trigger if exists nsi_rh_audit_no_truncate on public.nsi_rh_audit;
create trigger nsi_rh_audit_no_truncate before truncate on public.nsi_rh_audit
  for each statement execute function public.nsi_rh_refuse_truncate();

-- destructive implementation (private schema)
-- G7 finding: on PG17 the creating role gets ADMIN but not SET/INHERIT on the new role, and once the role owns
-- the function `postgres` can neither CREATE OR REPLACE it nor GRANT on it. Deterministic pattern: obtain SET
-- membership, then create and grant AS the role (no ALTER OWNER needed; re-runnable).
grant intake_destructive to postgres with set true, inherit false;
set local role intake_destructive;
create or replace function intake_private.erase_client_impl(p_studio uuid, p_client uuid, p_actor uuid, p_reason text)
returns integer language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare n integer;
begin
  delete from public.nsi_rh_requests where studio_id = p_studio and client_id = p_client;
  get diagnostics n = row_count;
  perform public.nsi_rh_audit_write(p_studio, p_client, 'erasure_record', p_actor, current_user::text);
  return n;
end $$;
revoke all on function intake_private.erase_client_impl(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function intake_private.erase_client_impl(uuid, uuid, uuid, text) to postgres;
reset role;

-- public wrapper (owner postgres)
create or replace function public.intake_erase_client(p_studio uuid, p_client uuid, p_reason text)
returns integer language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not public.nsi_rh_is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'reason required' using errcode = '22023';
  end if;
  return intake_private.erase_client_impl(p_studio, p_client, v_actor, p_reason);
end $$;

-- release (owner postgres; audited, append-only)
create or replace function public.intake_release_erasure_barrier(p_studio uuid, p_client uuid, p_reason text)
returns void language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not public.nsi_rh_is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'reason required' using errcode = '22023';
  end if;
  perform public.nsi_rh_audit_write(p_studio, p_client, 'erasure_barrier_released', v_actor, current_user::text);
end $$;

-- function grants: revoke from every API role, then class grants
revoke all on function public.nsi_rh_is_platform_admin() from public, anon, authenticated, service_role;
revoke all on function public.nsi_rh_audit_write(uuid, uuid, text, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.nsi_rh_barrier_active(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.nsi_rh_requests_guard() from public, anon, authenticated, service_role;
revoke all on function public.nsi_rh_refuse_truncate() from public, anon, authenticated, service_role;
revoke all on function public.nsi_rh_audit_append_only() from public, anon, authenticated, service_role;
revoke all on function public.intake_erase_client(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.intake_release_erasure_barrier(uuid, uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.intake_erase_client(uuid, uuid, text) to authenticated;
grant execute on function public.intake_release_erasure_barrier(uuid, uuid, text) to authenticated;
grant execute on function public.nsi_rh_audit_write(uuid, uuid, text, uuid, text, text) to intake_destructive;
grant execute on function public.nsi_rh_barrier_active(uuid, uuid) to intake_destructive;

commit;

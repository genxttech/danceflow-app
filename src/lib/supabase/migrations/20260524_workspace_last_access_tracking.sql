-- 20260524_workspace_last_access_tracking.sql
-- Tracks the latest successful /app workspace access per studio/workspace
-- and keeps a lightweight access log for later platform-admin review.
-- This version does not depend on a platform_admins table.

begin;

alter table public.studios
  add column if not exists last_workspace_access_at timestamptz,
  add column if not exists last_workspace_access_user_id uuid references auth.users(id) on delete set null;

create table if not exists public.workspace_access_logs (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  accessed_at timestamptz not null default now(),
  route text,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default now()
);

create index if not exists idx_workspace_access_logs_studio_accessed
  on public.workspace_access_logs (studio_id, accessed_at desc);

create index if not exists idx_workspace_access_logs_user_accessed
  on public.workspace_access_logs (user_id, accessed_at desc);

alter table public.workspace_access_logs enable row level security;

drop policy if exists "Workspace users can insert own access logs"
  on public.workspace_access_logs;

create policy "Workspace users can insert own access logs"
  on public.workspace_access_logs
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = workspace_access_logs.studio_id
        and usr.active = true
    )
  );

drop policy if exists "Organizer users can insert linked workspace access logs"
  on public.workspace_access_logs;

create policy "Organizer users can insert linked workspace access logs"
  on public.workspace_access_logs
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.organizer_users ou
      join public.organizers o on o.id = ou.organizer_id
      where ou.user_id = auth.uid()
        and ou.active = true
        and o.studio_id = workspace_access_logs.studio_id
    )
  );

drop policy if exists "Workspace users can view own access logs"
  on public.workspace_access_logs;

create policy "Workspace users can view own access logs"
  on public.workspace_access_logs
  for select
  to authenticated
  using (
    user_id = auth.uid()
  );

create or replace function public.record_workspace_access(
  p_studio_id uuid,
  p_route text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_allowed boolean := false;
begin
  if v_user_id is null or p_studio_id is null then
    return;
  end if;

  select exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = v_user_id
      and usr.studio_id = p_studio_id
      and usr.active = true
  )
  or exists (
    select 1
    from public.organizer_users ou
    join public.organizers o on o.id = ou.organizer_id
    where ou.user_id = v_user_id
      and ou.active = true
      and o.studio_id = p_studio_id
  )
  into v_allowed;

  if not v_allowed then
    return;
  end if;

  -- Avoid writing a new access row on every server render/page navigation.
  if exists (
    select 1
    from public.studios s
    where s.id = p_studio_id
      and s.last_workspace_access_user_id = v_user_id
      and s.last_workspace_access_at > now() - interval '30 minutes'
  ) then
    return;
  end if;

  update public.studios
  set
    last_workspace_access_at = now(),
    last_workspace_access_user_id = v_user_id
  where id = p_studio_id;

  insert into public.workspace_access_logs (studio_id, user_id, route)
  values (p_studio_id, v_user_id, p_route);
end;
$$;

grant execute on function public.record_workspace_access(uuid, text) to authenticated;

commit;

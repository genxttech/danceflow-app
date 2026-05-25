begin;

create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

alter table public.platform_admins enable row level security;

create or replace function public.is_platform_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
      and pa.active = true
  );
$$;

grant execute on function public.is_platform_admin() to authenticated;

drop policy if exists "Platform admins can view platform admins"
on public.platform_admins;

drop policy if exists "Platform admins can manage platform admins"
on public.platform_admins;

drop policy if exists "Platform admins can view own platform admin row"
on public.platform_admins;

create policy "Platform admins can view own platform admin row"
on public.platform_admins
for select
to authenticated
using (
  user_id = auth.uid()
);

drop policy if exists "Platform admins can view platform invites"
on public.platform_invites;

create policy "Platform admins can view platform invites"
on public.platform_invites
for select
to authenticated
using (
  public.is_platform_admin()
);

drop policy if exists "Platform admins can create platform invites"
on public.platform_invites;

create policy "Platform admins can create platform invites"
on public.platform_invites
for insert
to authenticated
with check (
  public.is_platform_admin()
);

drop policy if exists "Platform admins can update platform invites"
on public.platform_invites;

create policy "Platform admins can update platform invites"
on public.platform_invites
for update
to authenticated
using (
  public.is_platform_admin()
)
with check (
  public.is_platform_admin()
);

notify pgrst, 'reload schema';

commit;
-- Student mobile wallet package visibility policies
-- Run in development first, then production after verification.
-- Purpose: allow an authenticated portal user to read their own package balances
-- through the native student app without exposing other clients' package records.

alter table if exists public.client_packages enable row level security;
alter table if exists public.client_package_items enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'client_packages'
      and policyname = 'student_portal_can_read_own_client_packages'
  ) then
    create policy student_portal_can_read_own_client_packages
      on public.client_packages
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.clients c
          where c.id = client_packages.client_id
            and c.studio_id = client_packages.studio_id
            and c.portal_user_id = auth.uid()
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'client_package_items'
      and policyname = 'student_portal_can_read_own_client_package_items'
  ) then
    create policy student_portal_can_read_own_client_package_items
      on public.client_package_items
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.client_packages cp
          join public.clients c
            on c.id = cp.client_id
           and c.studio_id = cp.studio_id
          where cp.id = client_package_items.client_package_id
            and c.portal_user_id = auth.uid()
        )
      );
  end if;
end $$;

-- Student mobile profile read/update policy for linked portal users.
-- Run in development first. Run in production before releasing mobile profile editing.

alter table public.clients enable row level security;

drop policy if exists "portal users can read own student profile" on public.clients;
create policy "portal users can read own student profile"
  on public.clients
  for select
  to authenticated
  using (portal_user_id = auth.uid());

drop policy if exists "portal users can update own student profile" on public.clients;
create policy "portal users can update own student profile"
  on public.clients
  for update
  to authenticated
  using (portal_user_id = auth.uid())
  with check (portal_user_id = auth.uid());

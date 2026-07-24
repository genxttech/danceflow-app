-- Restore authenticated read access for commerce playback reporting.
-- Apply after 20260723003000_commerce_security_hardening_slice1.sql.
-- Apply before deploying the matching Commerce Intelligence fallback.

begin;

alter table public.commerce_playback_progress enable row level security;

grant select
  on public.commerce_playback_progress
  to authenticated;

drop policy if exists "commerce playback progress workspace read"
  on public.commerce_playback_progress;

create policy "commerce playback progress workspace read"
  on public.commerce_playback_progress
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = commerce_playback_progress.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
  );

drop policy if exists "commerce playback progress owner read"
  on public.commerce_playback_progress;

create policy "commerce playback progress owner read"
  on public.commerce_playback_progress
  for select
  to authenticated
  using (user_id = auth.uid());

commit;

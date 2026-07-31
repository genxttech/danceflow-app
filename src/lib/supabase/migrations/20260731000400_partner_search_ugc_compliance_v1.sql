-- Partner Search UGC compliance hardening.
-- Requires existing Partner Search / Partner Messages migrations.
--
-- Adds global user blocking, listing reports, server-enforced messaging blocks,
-- and discovery filtering for authenticated blocked relationships.

begin;

create table if not exists public.partner_user_blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_user_id uuid not null references auth.users(id) on delete cascade,
  blocked_user_id uuid not null references auth.users(id) on delete cascade,
  source_thread_id uuid references public.partner_conversation_threads(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint partner_user_blocks_not_self check (blocker_user_id <> blocked_user_id),
  unique (blocker_user_id, blocked_user_id)
);

create index if not exists partner_user_blocks_blocked_idx
  on public.partner_user_blocks (blocked_user_id, blocker_user_id);

create table if not exists public.partner_profile_reports (
  id uuid primary key default gen_random_uuid(),
  partner_profile_id uuid not null references public.dancer_partner_profiles(id) on delete cascade,
  reporter_user_id uuid not null references auth.users(id) on delete cascade,
  reason text not null default 'Reported from Partner Search',
  status text not null default 'open'
    check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now()
);

create index if not exists partner_profile_reports_profile_idx
  on public.partner_profile_reports (partner_profile_id, created_at desc);

alter table public.partner_user_blocks enable row level security;
alter table public.partner_profile_reports enable row level security;

drop policy if exists "Users can read their partner blocks" on public.partner_user_blocks;
create policy "Users can read their partner blocks"
on public.partner_user_blocks
for select to authenticated
using (
  auth.uid() = blocker_user_id
  or auth.uid() = blocked_user_id
);

drop policy if exists "Users can create partner blocks" on public.partner_user_blocks;
create policy "Users can create partner blocks"
on public.partner_user_blocks
for insert to authenticated
with check (
  auth.uid() = blocker_user_id
  and blocker_user_id <> blocked_user_id
);

drop policy if exists "Users can remove their partner blocks" on public.partner_user_blocks;
create policy "Users can remove their partner blocks"
on public.partner_user_blocks
for delete to authenticated
using (auth.uid() = blocker_user_id);

drop policy if exists "Users can submit partner profile reports" on public.partner_profile_reports;
create policy "Users can submit partner profile reports"
on public.partner_profile_reports
for insert to authenticated
with check (
  auth.uid() = reporter_user_id
  and exists (
    select 1
    from public.dancer_partner_profiles dpp
    where dpp.id = partner_profile_id
      and dpp.user_id <> auth.uid()
  )
);

drop policy if exists "Users can read their partner profile reports" on public.partner_profile_reports;
create policy "Users can read their partner profile reports"
on public.partner_profile_reports
for select to authenticated
using (auth.uid() = reporter_user_id);

create or replace function public.report_partner_profile(
  target_partner_profile_id uuid,
  report_reason text default 'Reported from Partner Search'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_id uuid;
  report_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  select user_id
    into target_user_id
  from public.dancer_partner_profiles
  where id = target_partner_profile_id;

  if target_user_id is null then
    raise exception 'Partner profile not found.';
  end if;

  if target_user_id = auth.uid() then
    raise exception 'You cannot report your own listing.';
  end if;

  insert into public.partner_profile_reports (
    partner_profile_id,
    reporter_user_id,
    reason
  )
  values (
    target_partner_profile_id,
    auth.uid(),
    coalesce(nullif(trim(report_reason), ''), 'Reported from Partner Search')
  )
  returning id into report_id;

  update public.dancer_partner_profiles
  set reported_count = coalesce(reported_count, 0) + 1,
      last_reported_at = now()
  where id = target_partner_profile_id;

  return report_id;
end;
$$;

revoke all on function public.report_partner_profile(uuid, text) from public;
grant execute on function public.report_partner_profile(uuid, text) to authenticated;

create or replace function public.block_partner_profile(
  target_partner_profile_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  select user_id
    into target_user_id
  from public.dancer_partner_profiles
  where id = target_partner_profile_id;

  if target_user_id is null then
    raise exception 'Partner profile not found.';
  end if;

  if target_user_id = auth.uid() then
    raise exception 'You cannot block yourself.';
  end if;

  insert into public.partner_user_blocks (
    blocker_user_id,
    blocked_user_id
  )
  values (
    auth.uid(),
    target_user_id
  )
  on conflict (blocker_user_id, blocked_user_id) do nothing;

  update public.partner_conversation_threads
  set status = 'blocked',
      updated_at = now()
  where
    (requester_user_id = auth.uid() and partner_user_id = target_user_id)
    or
    (requester_user_id = target_user_id and partner_user_id = auth.uid());

  return true;
end;
$$;

revoke all on function public.block_partner_profile(uuid) from public;
grant execute on function public.block_partner_profile(uuid) to authenticated;

create or replace function public.block_partner_user(
  target_user_id uuid,
  target_thread_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  if target_user_id is null or target_user_id = auth.uid() then
    raise exception 'Invalid blocked user.';
  end if;

  if target_thread_id is not null and not exists (
    select 1
    from public.partner_conversation_threads pct
    where pct.id = target_thread_id
      and (
        (pct.requester_user_id = auth.uid() and pct.partner_user_id = target_user_id)
        or
        (pct.partner_user_id = auth.uid() and pct.requester_user_id = target_user_id)
      )
  ) then
    raise exception 'Conversation does not match this user.';
  end if;

  insert into public.partner_user_blocks (
    blocker_user_id,
    blocked_user_id,
    source_thread_id
  )
  values (
    auth.uid(),
    target_user_id,
    target_thread_id
  )
  on conflict (blocker_user_id, blocked_user_id)
  do update set source_thread_id = coalesce(excluded.source_thread_id, public.partner_user_blocks.source_thread_id);

  update public.partner_conversation_threads
  set status = 'blocked',
      updated_at = now()
  where
    (requester_user_id = auth.uid() and partner_user_id = target_user_id)
    or
    (requester_user_id = target_user_id and partner_user_id = auth.uid());

  return true;
end;
$$;

revoke all on function public.block_partner_user(uuid, uuid) from public;
grant execute on function public.block_partner_user(uuid, uuid) to authenticated;

-- Blocked relationships cannot create new direct connection requests.
drop policy if exists "Authenticated dancers can create partner connection requests"
  on public.partner_connection_requests;

create policy "Authenticated dancers can create partner connection requests"
on public.partner_connection_requests
for insert to authenticated
with check (
  auth.uid() = requester_user_id
  and exists (
    select 1
    from public.dancer_partner_profiles dpp
    where dpp.id = partner_profile_id
      and dpp.user_id <> auth.uid()
      and not exists (
        select 1
        from public.partner_user_blocks pub
        where
          (pub.blocker_user_id = auth.uid() and pub.blocked_user_id = dpp.user_id)
          or
          (pub.blocker_user_id = dpp.user_id and pub.blocked_user_id = auth.uid())
      )
  )
);

-- Thread messages are also prevented for a globally blocked relationship.
drop policy if exists "Partner thread members can create messages"
  on public.partner_conversation_messages;

create policy "Partner thread members can create messages"
on public.partner_conversation_messages
for insert
with check (
  auth.uid() = sender_user_id
  and exists (
    select 1
    from public.partner_conversation_threads pct
    where pct.id = thread_id
      and pct.status = 'active'
      and (pct.requester_user_id = auth.uid() or pct.partner_user_id = auth.uid())
      and not exists (
        select 1
        from public.partner_user_blocks pub
        where
          (
            pub.blocker_user_id = pct.requester_user_id
            and pub.blocked_user_id = pct.partner_user_id
          )
          or
          (
            pub.blocker_user_id = pct.partner_user_id
            and pub.blocked_user_id = pct.requester_user_id
          )
      )
  )
);

-- Replace the public-profile read policy so authenticated users do not see
-- listings belonging to users they blocked or who blocked them.
drop policy if exists "Public can view published partner profiles"
  on public.dancer_partner_profiles;

create policy "Public can view published partner profiles"
on public.dancer_partner_profiles
for select
using (
  visibility = 'published'
  and moderation_status = 'approved'
  and (expires_at is null or expires_at >= now())
  and (
    auth.uid() is null
    or user_id = auth.uid()
    or not exists (
      select 1
      from public.partner_user_blocks pub
      where
        (pub.blocker_user_id = auth.uid() and pub.blocked_user_id = dancer_partner_profiles.user_id)
        or
        (pub.blocker_user_id = dancer_partner_profiles.user_id and pub.blocked_user_id = auth.uid())
    )
  )
);

commit;

create table if not exists public.partner_conversation_threads (
  id uuid primary key default gen_random_uuid(),
  partner_profile_id uuid not null references public.dancer_partner_profiles(id) on delete cascade,
  connection_request_id uuid references public.partner_connection_requests(id) on delete set null,
  requester_user_id uuid not null references auth.users(id) on delete cascade,
  partner_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'blocked', 'closed')),
  last_message_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint partner_conversation_threads_not_self check (requester_user_id <> partner_user_id)
);

create unique index if not exists partner_conversation_threads_unique_pair_idx
  on public.partner_conversation_threads (partner_profile_id, requester_user_id, partner_user_id);

create index if not exists partner_conversation_threads_requester_idx
  on public.partner_conversation_threads (requester_user_id, last_message_at desc);

create index if not exists partner_conversation_threads_partner_idx
  on public.partner_conversation_threads (partner_user_id, last_message_at desc);

create table if not exists public.partner_conversation_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.partner_conversation_threads(id) on delete cascade,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 2000),
  moderation_status text not null default 'visible' check (moderation_status in ('visible', 'hidden', 'flagged')),
  created_at timestamp with time zone not null default now()
);

create index if not exists partner_conversation_messages_thread_idx
  on public.partner_conversation_messages (thread_id, created_at);

create table if not exists public.partner_conversation_reports (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.partner_conversation_threads(id) on delete cascade,
  reporter_user_id uuid not null references auth.users(id) on delete cascade,
  reason text not null default 'Reported from mobile app',
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamp with time zone not null default now()
);

create index if not exists partner_conversation_reports_thread_idx
  on public.partner_conversation_reports (thread_id, created_at desc);

create table if not exists public.partner_conversation_blocks (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.partner_conversation_threads(id) on delete cascade,
  blocker_user_id uuid not null references auth.users(id) on delete cascade,
  blocked_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamp with time zone not null default now(),
  constraint partner_conversation_blocks_not_self check (blocker_user_id <> blocked_user_id)
);

create unique index if not exists partner_conversation_blocks_unique_idx
  on public.partner_conversation_blocks (thread_id, blocker_user_id, blocked_user_id);

alter table public.partner_conversation_threads enable row level security;
alter table public.partner_conversation_messages enable row level security;
alter table public.partner_conversation_reports enable row level security;
alter table public.partner_conversation_blocks enable row level security;

drop policy if exists "Partner thread members can read threads" on public.partner_conversation_threads;
create policy "Partner thread members can read threads"
  on public.partner_conversation_threads
  for select
  using (auth.uid() = requester_user_id or auth.uid() = partner_user_id);

drop policy if exists "Partner requesters can create threads" on public.partner_conversation_threads;
create policy "Partner requesters can create threads"
  on public.partner_conversation_threads
  for insert
  with check (
    auth.uid() = requester_user_id
    and exists (
      select 1
      from public.dancer_partner_profiles dpp
      where dpp.id = partner_profile_id
        and dpp.user_id = partner_user_id
    )
  );

drop policy if exists "Partner thread members can update thread state" on public.partner_conversation_threads;
create policy "Partner thread members can update thread state"
  on public.partner_conversation_threads
  for update
  using (auth.uid() = requester_user_id or auth.uid() = partner_user_id)
  with check (auth.uid() = requester_user_id or auth.uid() = partner_user_id);

drop policy if exists "Partner thread members can read messages" on public.partner_conversation_messages;
create policy "Partner thread members can read messages"
  on public.partner_conversation_messages
  for select
  using (
    exists (
      select 1
      from public.partner_conversation_threads pct
      where pct.id = thread_id
        and (pct.requester_user_id = auth.uid() or pct.partner_user_id = auth.uid())
    )
  );

drop policy if exists "Partner thread members can create messages" on public.partner_conversation_messages;
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
    )
    and not exists (
      select 1
      from public.partner_conversation_blocks pcb
      where pcb.thread_id = thread_id
        and (pcb.blocker_user_id = auth.uid() or pcb.blocked_user_id = auth.uid())
    )
  );

drop policy if exists "Partner thread members can create reports" on public.partner_conversation_reports;
create policy "Partner thread members can create reports"
  on public.partner_conversation_reports
  for insert
  with check (
    auth.uid() = reporter_user_id
    and exists (
      select 1
      from public.partner_conversation_threads pct
      where pct.id = thread_id
        and (pct.requester_user_id = auth.uid() or pct.partner_user_id = auth.uid())
    )
  );

drop policy if exists "Reporters can read their reports" on public.partner_conversation_reports;
create policy "Reporters can read their reports"
  on public.partner_conversation_reports
  for select
  using (auth.uid() = reporter_user_id);

drop policy if exists "Partner thread members can create blocks" on public.partner_conversation_blocks;
create policy "Partner thread members can create blocks"
  on public.partner_conversation_blocks
  for insert
  with check (
    auth.uid() = blocker_user_id
    and exists (
      select 1
      from public.partner_conversation_threads pct
      where pct.id = thread_id
        and (
          (pct.requester_user_id = auth.uid() and pct.partner_user_id = blocked_user_id)
          or (pct.partner_user_id = auth.uid() and pct.requester_user_id = blocked_user_id)
        )
    )
  );

drop policy if exists "Partner thread members can read blocks" on public.partner_conversation_blocks;
create policy "Partner thread members can read blocks"
  on public.partner_conversation_blocks
  for select
  using (auth.uid() = blocker_user_id or auth.uid() = blocked_user_id);

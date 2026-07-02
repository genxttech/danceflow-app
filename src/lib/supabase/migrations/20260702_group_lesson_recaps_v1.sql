-- Group Lesson Recaps V1
-- Run in development first, then production before deploying the web recap UI.

create table if not exists public.group_lesson_recaps (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  title text not null,
  summary text,
  technique_notes text,
  safety_notes text,
  practice_assignment text,
  media_links text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'published', 'unpublished')),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint group_lesson_recaps_one_per_appointment unique (appointment_id)
);

create table if not exists public.group_lesson_recap_recipients (
  id uuid primary key default gen_random_uuid(),
  recap_id uuid not null references public.group_lesson_recaps(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  guest_email text,
  guest_name text,
  source text not null default 'checked_in' check (source in ('checked_in', 'attended', 'registered', 'manual', 'guest')),
  delivery_status text not null default 'available' check (delivery_status in ('available', 'emailed', 'claimed', 'revoked')),
  secure_token uuid not null default gen_random_uuid(),
  viewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint group_lesson_recap_recipient_identity check (
    client_id is not null
    or user_id is not null
    or guest_email is not null
  )
);

create unique index if not exists group_lesson_recap_recipients_unique_client
  on public.group_lesson_recap_recipients (recap_id, client_id)
  where client_id is not null;

create unique index if not exists group_lesson_recap_recipients_unique_user
  on public.group_lesson_recap_recipients (recap_id, user_id)
  where user_id is not null;

create unique index if not exists group_lesson_recap_recipients_unique_guest_email
  on public.group_lesson_recap_recipients (recap_id, lower(guest_email))
  where guest_email is not null;

create index if not exists group_lesson_recaps_studio_appointment_idx
  on public.group_lesson_recaps (studio_id, appointment_id);

create index if not exists group_lesson_recap_recipients_studio_client_idx
  on public.group_lesson_recap_recipients (studio_id, client_id);

create index if not exists group_lesson_recap_recipients_token_idx
  on public.group_lesson_recap_recipients (secure_token);

alter table public.group_lesson_recaps enable row level security;
alter table public.group_lesson_recap_recipients enable row level security;

drop policy if exists "Studio staff can manage group lesson recaps" on public.group_lesson_recaps;
create policy "Studio staff can manage group lesson recaps"
  on public.group_lesson_recaps
  for all
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = group_lesson_recaps.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = group_lesson_recaps.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
  );

drop policy if exists "Linked students can read published group lesson recaps" on public.group_lesson_recaps;
create policy "Linked students can read published group lesson recaps"
  on public.group_lesson_recaps
  for select
  using (
    status = 'published'
    and exists (
      select 1
      from public.group_lesson_recap_recipients glrr
      left join public.clients c on c.id = glrr.client_id
      where glrr.recap_id = group_lesson_recaps.id
        and (
          glrr.user_id = auth.uid()
          or c.portal_user_id = auth.uid()
        )
    )
  );

drop policy if exists "Studio staff can manage group lesson recap recipients" on public.group_lesson_recap_recipients;
create policy "Studio staff can manage group lesson recap recipients"
  on public.group_lesson_recap_recipients
  for all
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = group_lesson_recap_recipients.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = group_lesson_recap_recipients.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
    )
  );

drop policy if exists "Linked students can read own group lesson recap recipients" on public.group_lesson_recap_recipients;
create policy "Linked students can read own group lesson recap recipients"
  on public.group_lesson_recap_recipients
  for select
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.clients c
      where c.id = group_lesson_recap_recipients.client_id
        and c.portal_user_id = auth.uid()
    )
  );

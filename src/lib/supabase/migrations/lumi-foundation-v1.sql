-- LUMI Foundation V1
-- Run in both development and production.

alter table public.studio_settings
  add column if not exists lumi_enabled boolean not null default false;

create table if not exists public.student_dance_goals (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  title text not null,
  category text not null default 'general',
  notes text,
  target_date date,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_dance_goals_title_length
    check (char_length(btrim(title)) between 1 and 160),
  constraint student_dance_goals_category_check
    check (category in ('general', 'social', 'syllabus', 'showcase', 'competition', 'confidence', 'fitness')),
  constraint student_dance_goals_status_check
    check (status in ('active', 'completed', 'archived'))
);

create index if not exists idx_student_dance_goals_client_status
  on public.student_dance_goals (client_id, status, created_at desc);

create index if not exists idx_student_dance_goals_studio
  on public.student_dance_goals (studio_id, created_at desc);

alter table public.student_dance_goals enable row level security;

drop policy if exists "Portal students can view own dance goals"
  on public.student_dance_goals;
create policy "Portal students can view own dance goals"
  on public.student_dance_goals
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.clients c
      where c.id = student_dance_goals.client_id
        and c.studio_id = student_dance_goals.studio_id
        and c.portal_user_id = auth.uid()
    )
    or exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = student_dance_goals.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role in ('studio_owner', 'studio_admin', 'front_desk', 'instructor')
    )
  );

drop policy if exists "Portal students can create own dance goals"
  on public.student_dance_goals;
create policy "Portal students can create own dance goals"
  on public.student_dance_goals
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.clients c
      where c.id = student_dance_goals.client_id
        and c.studio_id = student_dance_goals.studio_id
        and c.portal_user_id = auth.uid()
    )
  );

drop policy if exists "Portal students can update own dance goals"
  on public.student_dance_goals;
create policy "Portal students can update own dance goals"
  on public.student_dance_goals
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.clients c
      where c.id = student_dance_goals.client_id
        and c.studio_id = student_dance_goals.studio_id
        and c.portal_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.clients c
      where c.id = student_dance_goals.client_id
        and c.studio_id = student_dance_goals.studio_id
        and c.portal_user_id = auth.uid()
    )
  );

drop policy if exists "Studio staff can manage dance goals"
  on public.student_dance_goals;
create policy "Studio staff can manage dance goals"
  on public.student_dance_goals
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = student_dance_goals.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role in ('studio_owner', 'studio_admin', 'instructor')
    )
  )
  with check (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = student_dance_goals.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role in ('studio_owner', 'studio_admin', 'instructor')
    )
  );

grant select, insert, update on public.student_dance_goals to authenticated;

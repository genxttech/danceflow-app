-- DanceFlow Instructor Schedule Blocks
-- One-time and recurring instructor blocks for lunch, practice, meetings, travel, and personal time.

create table if not exists public.instructor_schedule_blocks (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete set null,
  reason text not null default 'other'
    check (reason in ('lunch','practice','meeting','travel','personal','other')),
  title text not null,
  notes text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  recurrence_series_id uuid,
  recurrence_frequency text check (recurrence_frequency is null or recurrence_frequency = 'weekly'),
  recurrence_count integer,
  recurrence_ends_on date,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instructor_schedule_blocks_time_check check (ends_at > starts_at)
);

create index if not exists instructor_schedule_blocks_overlap_idx
  on public.instructor_schedule_blocks(studio_id, instructor_id, starts_at, ends_at);
create index if not exists instructor_schedule_blocks_room_overlap_idx
  on public.instructor_schedule_blocks(studio_id, room_id, starts_at, ends_at)
  where room_id is not null;

alter table public.instructor_schedule_blocks enable row level security;

drop policy if exists "Studio members can view instructor schedule blocks"
  on public.instructor_schedule_blocks;
create policy "Studio members can view instructor schedule blocks"
on public.instructor_schedule_blocks for select
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = instructor_schedule_blocks.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Schedulers can manage instructor schedule blocks"
  on public.instructor_schedule_blocks;
create policy "Schedulers can manage instructor schedule blocks"
on public.instructor_schedule_blocks for all
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = instructor_schedule_blocks.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner','studio_admin','front_desk','instructor','independent_instructor')
  )
)
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = instructor_schedule_blocks.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner','studio_admin','front_desk','instructor','independent_instructor')
  )
);

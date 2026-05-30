-- Syllabus V1
-- Reusable studio syllabus templates, assigned student syllabi, and per-figure progress.

create table if not exists public.syllabus_templates (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  name text not null,
  dance_style text,
  level text,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.syllabus_template_items (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  template_id uuid not null references public.syllabus_templates(id) on delete cascade,
  title text not null,
  category text,
  description text,
  sort_order integer,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_syllabus_assignments (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  template_id uuid not null references public.syllabus_templates(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'archived')),
  show_in_portal boolean not null default false,
  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, template_id)
);

create table if not exists public.client_syllabus_progress (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  assignment_id uuid not null references public.client_syllabus_assignments(id) on delete cascade,
  template_item_id uuid not null references public.syllabus_template_items(id) on delete cascade,
  status text not null default 'not_started'
    check (status in ('not_started', 'introduced', 'practicing', 'comfortable', 'mastered')),
  instructor_notes text,
  show_notes_in_portal boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assignment_id, template_item_id)
);

create index if not exists idx_syllabus_templates_studio_id
  on public.syllabus_templates(studio_id);

create index if not exists idx_syllabus_template_items_template_id
  on public.syllabus_template_items(template_id);

create index if not exists idx_client_syllabus_assignments_client_id
  on public.client_syllabus_assignments(client_id);

create index if not exists idx_client_syllabus_progress_assignment_id
  on public.client_syllabus_progress(assignment_id);

alter table public.syllabus_templates enable row level security;
alter table public.syllabus_template_items enable row level security;
alter table public.client_syllabus_assignments enable row level security;
alter table public.client_syllabus_progress enable row level security;

drop policy if exists "Studio members can view syllabus templates" on public.syllabus_templates;
create policy "Studio members can view syllabus templates"
on public.syllabus_templates
for select
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = syllabus_templates.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage syllabus templates" on public.syllabus_templates;
create policy "Studio members can manage syllabus templates"
on public.syllabus_templates
for all
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = syllabus_templates.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk', 'instructor', 'independent_instructor')
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = syllabus_templates.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk', 'instructor', 'independent_instructor')
  )
);

drop policy if exists "Studio members can view syllabus template items" on public.syllabus_template_items;
create policy "Studio members can view syllabus template items"
on public.syllabus_template_items
for select
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = syllabus_template_items.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage syllabus template items" on public.syllabus_template_items;
create policy "Studio members can manage syllabus template items"
on public.syllabus_template_items
for all
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = syllabus_template_items.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk', 'instructor', 'independent_instructor')
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = syllabus_template_items.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk', 'instructor', 'independent_instructor')
  )
);

drop policy if exists "Studio members can view client syllabus assignments" on public.client_syllabus_assignments;
create policy "Studio members can view client syllabus assignments"
on public.client_syllabus_assignments
for select
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = client_syllabus_assignments.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage client syllabus assignments" on public.client_syllabus_assignments;
create policy "Studio members can manage client syllabus assignments"
on public.client_syllabus_assignments
for all
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = client_syllabus_assignments.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk', 'instructor', 'independent_instructor')
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = client_syllabus_assignments.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk', 'instructor', 'independent_instructor')
  )
);

drop policy if exists "Studio members can view client syllabus progress" on public.client_syllabus_progress;
create policy "Studio members can view client syllabus progress"
on public.client_syllabus_progress
for select
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = client_syllabus_progress.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage client syllabus progress" on public.client_syllabus_progress;
create policy "Studio members can manage client syllabus progress"
on public.client_syllabus_progress
for all
using (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = client_syllabus_progress.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk', 'instructor', 'independent_instructor')
  )
)
with check (
  exists (
    select 1
    from public.user_studio_roles usr
    where usr.studio_id = client_syllabus_progress.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin', 'front_desk', 'instructor', 'independent_instructor')
  )
);

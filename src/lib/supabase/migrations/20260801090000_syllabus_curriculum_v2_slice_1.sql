-- DanceFlow Studio Curriculum & Syllabus Platform V2 - Slice 1
-- Adds a canonical Style -> Dance -> Level -> Step hierarchy while preserving
-- existing syllabus templates, assignments, progress, portal access, and mobile behavior.
-- Run in development first, then production before deploying the matching application files.

create table if not exists public.syllabus_styles (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  name text not null,
  description text,
  sort_order integer not null default 0,
  status text not null default 'active'
    check (status in ('draft', 'active', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (studio_id, name)
);

create table if not exists public.syllabus_dances (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  style_id uuid not null references public.syllabus_styles(id) on delete cascade,
  name text not null,
  description text,
  sort_order integer not null default 0,
  status text not null default 'active'
    check (status in ('draft', 'active', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (style_id, name)
);

create table if not exists public.syllabus_levels (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  dance_id uuid not null references public.syllabus_dances(id) on delete cascade,
  name text not null,
  description text,
  sort_order integer not null default 0,
  status text not null default 'active'
    check (status in ('draft', 'active', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (dance_id, name)
);

create table if not exists public.syllabus_steps (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  dance_id uuid not null references public.syllabus_dances(id) on delete cascade,
  level_id uuid references public.syllabus_levels(id) on delete set null,
  name text not null,
  alternate_name text,
  summary text,
  prerequisite_notes text,
  timing text,
  counts text,
  starting_position text,
  ending_position text,
  technique_notes text,
  instructor_notes text,
  student_notes text,
  sort_order integer not null default 0,
  status text not null default 'active'
    check (status in ('draft', 'active', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (dance_id, level_id, name)
);

alter table public.syllabus_templates
  add column if not exists dance_id uuid references public.syllabus_dances(id) on delete set null;

alter table public.syllabus_templates
  add column if not exists level_id uuid references public.syllabus_levels(id) on delete set null;

alter table public.syllabus_template_items
  add column if not exists syllabus_step_id uuid references public.syllabus_steps(id) on delete set null;

create index if not exists idx_syllabus_styles_studio_order
  on public.syllabus_styles(studio_id, sort_order, name);

create index if not exists idx_syllabus_dances_style_order
  on public.syllabus_dances(style_id, sort_order, name);

create index if not exists idx_syllabus_levels_dance_order
  on public.syllabus_levels(dance_id, sort_order, name);

create index if not exists idx_syllabus_steps_level_order
  on public.syllabus_steps(level_id, sort_order, name);

create index if not exists idx_syllabus_templates_dance_id
  on public.syllabus_templates(dance_id);

create index if not exists idx_syllabus_template_items_step_id
  on public.syllabus_template_items(syllabus_step_id);

-- Infer a broad style for legacy template dance names. Studios can rename or
-- reorganize these after migration.
with legacy_styles as (
  select distinct
    studio_id,
    case
      when lower(coalesce(dance_style, '')) in (
        'country two step', 'triple two step', 'polka', 'country waltz',
        'nightclub two step', 'line dance'
      ) then 'Country'
      when lower(coalesce(dance_style, '')) in (
        'west coast swing', 'east coast swing', 'hustle', 'jive'
      ) then 'Swing'
      when lower(coalesce(dance_style, '')) in (
        'waltz', 'foxtrot', 'tango', 'viennese waltz', 'quickstep',
        'rumba', 'cha cha', 'bolero', 'mambo', 'samba'
      ) then 'Ballroom'
      else 'Social / Latin'
    end as style_name
  from public.syllabus_templates
  where nullif(trim(dance_style), '') is not null
)
insert into public.syllabus_styles (studio_id, name, status)
select studio_id, style_name, 'active'
from legacy_styles
on conflict (studio_id, name) do nothing;

insert into public.syllabus_dances (studio_id, style_id, name, status)
select distinct
  template.studio_id,
  style.id,
  trim(template.dance_style),
  'active'
from public.syllabus_templates template
join public.syllabus_styles style
  on style.studio_id = template.studio_id
 and style.name = case
      when lower(coalesce(template.dance_style, '')) in (
        'country two step', 'triple two step', 'polka', 'country waltz',
        'nightclub two step', 'line dance'
      ) then 'Country'
      when lower(coalesce(template.dance_style, '')) in (
        'west coast swing', 'east coast swing', 'hustle', 'jive'
      ) then 'Swing'
      when lower(coalesce(template.dance_style, '')) in (
        'waltz', 'foxtrot', 'tango', 'viennese waltz', 'quickstep',
        'rumba', 'cha cha', 'bolero', 'mambo', 'samba'
      ) then 'Ballroom'
      else 'Social / Latin'
    end
where nullif(trim(template.dance_style), '') is not null
on conflict (style_id, name) do nothing;

update public.syllabus_templates template
set dance_id = dance.id
from public.syllabus_dances dance
where template.dance_id is null
  and dance.studio_id = template.studio_id
  and lower(dance.name) = lower(trim(template.dance_style));

insert into public.syllabus_levels (studio_id, dance_id, name, status)
select distinct
  template.studio_id,
  template.dance_id,
  coalesce(nullif(trim(template.level), ''), 'All Levels'),
  'active'
from public.syllabus_templates template
where template.dance_id is not null
on conflict (dance_id, name) do nothing;

update public.syllabus_templates template
set level_id = level.id
from public.syllabus_levels level
where template.level_id is null
  and level.dance_id = template.dance_id
  and lower(level.name) = lower(coalesce(nullif(trim(template.level), ''), 'All Levels'));

insert into public.syllabus_steps (
  studio_id,
  dance_id,
  level_id,
  name,
  summary,
  sort_order,
  status
)
select
  item.studio_id,
  template.dance_id,
  template.level_id,
  item.title,
  item.description,
  coalesce(item.sort_order, 0),
  case when item.active is false then 'archived' else 'active' end
from public.syllabus_template_items item
join public.syllabus_templates template on template.id = item.template_id
where template.dance_id is not null
on conflict (dance_id, level_id, name) do nothing;

update public.syllabus_template_items item
set syllabus_step_id = step.id
from public.syllabus_templates template,
     public.syllabus_steps step
where item.template_id = template.id
  and item.syllabus_step_id is null
  and step.dance_id = template.dance_id
  and step.level_id is not distinct from template.level_id
  and lower(step.name) = lower(item.title);

alter table public.syllabus_styles enable row level security;
alter table public.syllabus_dances enable row level security;
alter table public.syllabus_levels enable row level security;
alter table public.syllabus_steps enable row level security;

drop policy if exists "Studio members can view syllabus styles" on public.syllabus_styles;
create policy "Studio members can view syllabus styles"
on public.syllabus_styles for select
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_styles.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage syllabus styles" on public.syllabus_styles;
create policy "Studio members can manage syllabus styles"
on public.syllabus_styles for all
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_styles.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
)
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_styles.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
);

drop policy if exists "Studio members can view syllabus dances" on public.syllabus_dances;
create policy "Studio members can view syllabus dances"
on public.syllabus_dances for select
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_dances.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage syllabus dances" on public.syllabus_dances;
create policy "Studio members can manage syllabus dances"
on public.syllabus_dances for all
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_dances.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
)
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_dances.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
);

drop policy if exists "Studio members can view syllabus levels" on public.syllabus_levels;
create policy "Studio members can view syllabus levels"
on public.syllabus_levels for select
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_levels.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage syllabus levels" on public.syllabus_levels;
create policy "Studio members can manage syllabus levels"
on public.syllabus_levels for all
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_levels.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
)
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_levels.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
);

drop policy if exists "Studio members can view syllabus steps" on public.syllabus_steps;
create policy "Studio members can view syllabus steps"
on public.syllabus_steps for select
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_steps.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

drop policy if exists "Studio members can manage syllabus steps" on public.syllabus_steps;
create policy "Studio members can manage syllabus steps"
on public.syllabus_steps for all
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_steps.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
)
with check (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = syllabus_steps.studio_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role in (
        'studio_owner', 'studio_admin', 'front_desk',
        'instructor', 'independent_instructor'
      )
  )
);

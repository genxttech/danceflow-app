-- Student mobile syllabus visibility
-- Run in dev and production.
-- Allows a signed-in student to read syllabus assignments/progress for client
-- records connected to their DanceFlow account.

alter table public.syllabus_templates enable row level security;
alter table public.syllabus_template_items enable row level security;
alter table public.client_syllabus_assignments enable row level security;
alter table public.client_syllabus_progress enable row level security;

drop policy if exists "Connected students can view assigned syllabus templates" on public.syllabus_templates;
create policy "Connected students can view assigned syllabus templates"
on public.syllabus_templates
for select
using (
  exists (
    select 1
    from public.client_syllabus_assignments assignment
    join public.clients client
      on client.id = assignment.client_id
     and client.studio_id = assignment.studio_id
    where assignment.syllabus_template_id = syllabus_templates.id
      and assignment.studio_id = syllabus_templates.studio_id
      and assignment.archived_at is null
      and client.portal_user_id = auth.uid()
  )
);

drop policy if exists "Connected students can view assigned syllabus template items" on public.syllabus_template_items;
create policy "Connected students can view assigned syllabus template items"
on public.syllabus_template_items
for select
using (
  active is not false
  and exists (
    select 1
    from public.client_syllabus_assignments assignment
    join public.clients client
      on client.id = assignment.client_id
     and client.studio_id = assignment.studio_id
    where assignment.syllabus_template_id = syllabus_template_items.template_id
      and assignment.studio_id = syllabus_template_items.studio_id
      and assignment.archived_at is null
      and client.portal_user_id = auth.uid()
  )
);

drop policy if exists "Connected students can view their syllabus assignments" on public.client_syllabus_assignments;
create policy "Connected students can view their syllabus assignments"
on public.client_syllabus_assignments
for select
using (
  archived_at is null
  and exists (
    select 1
    from public.clients client
    where client.id = client_syllabus_assignments.client_id
      and client.studio_id = client_syllabus_assignments.studio_id
      and client.portal_user_id = auth.uid()
  )
);

drop policy if exists "Connected students can view their syllabus progress" on public.client_syllabus_progress;
create policy "Connected students can view their syllabus progress"
on public.client_syllabus_progress
for select
using (
  exists (
    select 1
    from public.client_syllabus_assignments assignment
    join public.clients client
      on client.id = assignment.client_id
     and client.studio_id = assignment.studio_id
    where assignment.id = client_syllabus_progress.assignment_id
      and assignment.archived_at is null
      and client.portal_user_id = auth.uid()
  )
);

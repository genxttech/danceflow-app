alter table public.event_public_styles enable row level security;

drop policy if exists "Studio members can view event public styles" on public.event_public_styles;
drop policy if exists "Studio members can insert event public styles" on public.event_public_styles;
drop policy if exists "Studio members can update event public styles" on public.event_public_styles;
drop policy if exists "Studio members can delete event public styles" on public.event_public_styles;

create policy "Studio members can view event public styles"
on public.event_public_styles
for select
to authenticated
using (
  exists (
    select 1
    from public.events e
    join public.user_studio_roles usr
      on usr.studio_id = e.studio_id
    where e.id = event_public_styles.event_id
      and usr.user_id = auth.uid()
      and usr.active = true
  )
);

create policy "Studio members can insert event public styles"
on public.event_public_styles
for insert
to authenticated
with check (
  exists (
    select 1
    from public.events e
    join public.user_studio_roles usr
      on usr.studio_id = e.studio_id
    where e.id = event_public_styles.event_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role::text in (
        'studio_owner',
        'studio_admin',
        'front_desk',
        'staff_instructor',
        'instructor'
      )
  )
);

create policy "Studio members can update event public styles"
on public.event_public_styles
for update
to authenticated
using (
  exists (
    select 1
    from public.events e
    join public.user_studio_roles usr
      on usr.studio_id = e.studio_id
    where e.id = event_public_styles.event_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role::text in (
        'studio_owner',
        'studio_admin',
        'front_desk',
        'staff_instructor',
        'instructor'
      )
  )
)
with check (
  exists (
    select 1
    from public.events e
    join public.user_studio_roles usr
      on usr.studio_id = e.studio_id
    where e.id = event_public_styles.event_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role::text in (
        'studio_owner',
        'studio_admin',
        'front_desk',
        'staff_instructor',
        'instructor'
      )
  )
);

create policy "Studio members can delete event public styles"
on public.event_public_styles
for delete
to authenticated
using (
  exists (
    select 1
    from public.events e
    join public.user_studio_roles usr
      on usr.studio_id = e.studio_id
    where e.id = event_public_styles.event_id
      and usr.user_id = auth.uid()
      and usr.active = true
      and usr.role::text in (
        'studio_owner',
        'studio_admin'
      )
  )
);
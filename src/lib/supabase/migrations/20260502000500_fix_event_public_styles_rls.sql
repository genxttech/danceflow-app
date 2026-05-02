alter table public.event_public_styles enable row level security;

drop policy if exists "Studio users can view event public styles" on public.event_public_styles;
drop policy if exists "Studio users can manage event public styles" on public.event_public_styles;
drop policy if exists "Studio users can insert event public styles" on public.event_public_styles;
drop policy if exists "Studio users can update event public styles" on public.event_public_styles;
drop policy if exists "Studio users can delete event public styles" on public.event_public_styles;

create policy "Studio users can view event public styles"
on public.event_public_styles
for select
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

create policy "Studio users can insert event public styles"
on public.event_public_styles
for insert
with check (
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

create policy "Studio users can update event public styles"
on public.event_public_styles
for update
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
  )
);

create policy "Studio users can delete event public styles"
on public.event_public_styles
for delete
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

notify pgrst, 'reload schema';
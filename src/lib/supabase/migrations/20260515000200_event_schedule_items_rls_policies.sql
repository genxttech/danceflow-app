alter table public.event_schedule_items enable row level security;

drop policy if exists "Public can read active schedule items for public events"
on public.event_schedule_items;

create policy "Public can read active schedule items for public events"
on public.event_schedule_items
for select
using (
  active = true
  and exists (
    select 1
    from public.events e
    where e.id = event_schedule_items.event_id
      and e.status = 'published'
      and (
        e.visibility = 'public'
        or e.public_directory_enabled = true
      )
  )
);

drop policy if exists "Event creators can read schedule items"
on public.event_schedule_items;

create policy "Event creators can read schedule items"
on public.event_schedule_items
for select
to authenticated
using (
  exists (
    select 1
    from public.events e
    where e.id = event_schedule_items.event_id
      and e.created_by = auth.uid()
  )
);

drop policy if exists "Event creators can insert schedule items"
on public.event_schedule_items;

create policy "Event creators can insert schedule items"
on public.event_schedule_items
for insert
to authenticated
with check (
  exists (
    select 1
    from public.events e
    where e.id = event_schedule_items.event_id
      and e.created_by = auth.uid()
      and (
        event_schedule_items.studio_id is null
        or event_schedule_items.studio_id = e.studio_id
      )
      and (
        event_schedule_items.organizer_id is null
        or event_schedule_items.organizer_id = e.organizer_id
      )
  )
);

drop policy if exists "Event creators can update schedule items"
on public.event_schedule_items;

create policy "Event creators can update schedule items"
on public.event_schedule_items
for update
to authenticated
using (
  exists (
    select 1
    from public.events e
    where e.id = event_schedule_items.event_id
      and e.created_by = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.events e
    where e.id = event_schedule_items.event_id
      and e.created_by = auth.uid()
      and (
        event_schedule_items.studio_id is null
        or event_schedule_items.studio_id = e.studio_id
      )
      and (
        event_schedule_items.organizer_id is null
        or event_schedule_items.organizer_id = e.organizer_id
      )
  )
);

drop policy if exists "Event creators can delete schedule items"
on public.event_schedule_items;

create policy "Event creators can delete schedule items"
on public.event_schedule_items
for delete
to authenticated
using (
  exists (
    select 1
    from public.events e
    where e.id = event_schedule_items.event_id
      and e.created_by = auth.uid()
  )
);
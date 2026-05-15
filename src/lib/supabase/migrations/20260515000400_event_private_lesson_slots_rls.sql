drop policy if exists "Public can read active guest coaches for public events"
on public.event_guest_coaches;

create policy "Public can read active guest coaches for public events"
on public.event_guest_coaches
for select
using (
  active = true
  and exists (
    select 1
    from public.events e
    join public.studios s on s.id = e.studio_id
    where e.id = event_guest_coaches.event_id
      and e.status = 'published'
      and (
        e.visibility = 'public'
        or e.public_directory_enabled = true
      )
      and s.subscription_status in ('active', 'trialing')
  )
);

drop policy if exists "Event creators can manage guest coaches"
on public.event_guest_coaches;

create policy "Event creators can manage guest coaches"
on public.event_guest_coaches
for all
to authenticated
using (
  exists (
    select 1
    from public.events e
    where e.id = event_guest_coaches.event_id
      and e.created_by = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.events e
    where e.id = event_guest_coaches.event_id
      and e.created_by = auth.uid()
      and (
        event_guest_coaches.studio_id is null
        or event_guest_coaches.studio_id = e.studio_id
      )
      and (
        event_guest_coaches.organizer_id is null
        or event_guest_coaches.organizer_id = e.organizer_id
      )
  )
);


drop policy if exists "Public can read active private lesson blocks for public events"
on public.event_private_lesson_blocks;

create policy "Public can read active private lesson blocks for public events"
on public.event_private_lesson_blocks
for select
using (
  active = true
  and exists (
    select 1
    from public.events e
    join public.studios s on s.id = e.studio_id
    where e.id = event_private_lesson_blocks.event_id
      and e.status = 'published'
      and (
        e.visibility = 'public'
        or e.public_directory_enabled = true
      )
      and s.subscription_status in ('active', 'trialing')
  )
);

drop policy if exists "Event creators can manage private lesson blocks"
on public.event_private_lesson_blocks;

create policy "Event creators can manage private lesson blocks"
on public.event_private_lesson_blocks
for all
to authenticated
using (
  exists (
    select 1
    from public.events e
    where e.id = event_private_lesson_blocks.event_id
      and e.created_by = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.events e
    where e.id = event_private_lesson_blocks.event_id
      and e.created_by = auth.uid()
      and (
        event_private_lesson_blocks.studio_id is null
        or event_private_lesson_blocks.studio_id = e.studio_id
      )
      and (
        event_private_lesson_blocks.organizer_id is null
        or event_private_lesson_blocks.organizer_id = e.organizer_id
      )
  )
);


drop policy if exists "Public can read available private lesson slots for public events"
on public.event_private_lesson_slots;

create policy "Public can read available private lesson slots for public events"
on public.event_private_lesson_slots
for select
using (
  status in ('available', 'held', 'booked')
  and exists (
    select 1
    from public.events e
    join public.studios s on s.id = e.studio_id
    where e.id = event_private_lesson_slots.event_id
      and e.status = 'published'
      and (
        e.visibility = 'public'
        or e.public_directory_enabled = true
      )
      and s.subscription_status in ('active', 'trialing')
  )
);

drop policy if exists "Event creators can manage private lesson slots"
on public.event_private_lesson_slots;

create policy "Event creators can manage private lesson slots"
on public.event_private_lesson_slots
for all
to authenticated
using (
  exists (
    select 1
    from public.events e
    where e.id = event_private_lesson_slots.event_id
      and e.created_by = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.events e
    where e.id = event_private_lesson_slots.event_id
      and e.created_by = auth.uid()
      and (
        event_private_lesson_slots.studio_id is null
        or event_private_lesson_slots.studio_id = e.studio_id
      )
      and (
        event_private_lesson_slots.organizer_id is null
        or event_private_lesson_slots.organizer_id = e.organizer_id
      )
  )
);
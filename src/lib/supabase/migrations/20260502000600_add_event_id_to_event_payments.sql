alter table public.event_payments
add column if not exists event_id uuid references public.events(id) on delete cascade;

create index if not exists event_payments_event_id_idx
on public.event_payments(event_id);

update public.event_payments ep
set event_id = er.event_id
from public.event_registrations er
where ep.registration_id = er.id
  and ep.event_id is null;

notify pgrst, 'reload schema';
alter table public.appointments
  add column if not exists location_name text;

comment on column public.appointments.location_name is
  'Optional appointment-level location label for lessons taught at different studio locations, rented spaces, or partner venues.';

-- Rollback for 20260913090800_gc3a_group_class_roster_capacity.sql
--
-- IMPORTANT PRECONDITION: only run this together with reverting any
-- application code that depends on appointments.roster_capacity existing.
-- Running it while such code is still live will break on "column does not
-- exist" / "function does not exist" errors.
--
-- Guarded: aborts if any row already has a non-null roster_capacity, since
-- dropping the column would silently discard that data rather than
-- surfacing the conflict. Restores enforce_group_class_canonical_shape to
-- its exact pre-GC-3.1 (GC-1.4A) definition via CREATE OR REPLACE -- the
-- trigger itself (appointments_enforce_group_class_shape) is untouched,
-- since only the function body being extended is affected. Drops the two
-- purely-new GC-3.1 objects (_group_class_roster_reserved_count,
-- enforce_group_class_roster_capacity + its trigger) outright.

begin;

do $$
begin
  if exists (
    select 1 from public.appointments where roster_capacity is not null
  ) then
    raise exception 'Cannot roll back appointments.roster_capacity: rows with a non-null roster_capacity already exist. Clear or reconcile them before rolling back, or skip this revert and keep the column in place.';
  end if;
end;
$$;

drop trigger if exists appointment_attendees_enforce_roster_capacity on public.appointment_attendees;
drop function if exists public.enforce_group_class_roster_capacity();
drop function if exists public._group_class_roster_reserved_count(uuid);

create or replace function public.enforce_group_class_canonical_shape()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if new.appointment_type = 'group_class'::public.appointment_type then
    if new.client_id is not null
       or new.partner_client_id is not null
       or new.client_package_id is not null
       or new.client_membership_id is not null
       or new.price_amount is not null
    then
      raise exception 'A shared group class cannot carry a singular attendee, package, membership, or price -- use appointment_attendees.';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.appointment_type is distinct from new.appointment_type then
    if old.appointment_type = 'group_class'::public.appointment_type
       or new.appointment_type = 'group_class'::public.appointment_type
    then
      raise exception 'Appointment type cannot be changed to or from group_class -- create a new appointment through the canonical class-creation path instead.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_group_class_canonical_shape() from public;
revoke all on function public.enforce_group_class_canonical_shape() from anon;
revoke all on function public.enforce_group_class_canonical_shape() from authenticated;
revoke all on function public.enforce_group_class_canonical_shape() from service_role;

alter table public.appointments
  drop column roster_capacity;

commit;

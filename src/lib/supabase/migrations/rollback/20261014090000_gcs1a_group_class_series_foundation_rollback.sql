-- Rollback for 20261014090000_gcs1a_group_class_series_foundation.sql
--
-- Preservation-first (matching gc3b's rollback posture): aborts if any series
-- row exists or any appointment already belongs to a series, rather than
-- silently discarding series data. After GC-S1B creates series, roll back the
-- application first, then reconcile or export the series data before using
-- this file, or keep the objects in place.
--
-- Restores the pre-GC-S1A body of enforce_group_class_canonical_shape()
-- exactly (the GC-3.1 body; md5(prosrc) fb846ba2d454d6ce4f1509c96e60dfb2).

begin;

do $$
begin
  if exists (select 1 from public.group_class_series limit 1) then
    raise exception 'Cannot roll back GC-S1A: group_class_series rows exist. Reconcile or export them first, or keep the objects in place.';
  end if;
  if exists (select 1 from public.appointments where group_class_series_id is not null limit 1) then
    raise exception 'Cannot roll back GC-S1A: appointments already belong to a series. Reconcile them first, or keep the objects in place.';
  end if;
end;
$$;

drop trigger if exists appointments_01_guard_group_class_series on public.appointments;
drop function if exists public._guard_appointments_group_class_series_fields();

-- Restore the pre-GC-S1A shape function body BEFORE dropping the column it
-- would otherwise reference.
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
  else
    -- GC-3.1: roster_capacity is a group_class-only concept. Any other
    -- appointment_type must never carry a non-null value -- NULL (the
    -- column default) remains valid everywhere, including here.
    if new.roster_capacity is not null then
      raise exception 'Only a group class may carry a roster capacity.';
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

-- The series SELECT policy references appointments.group_class_series_id, so it goes first.
drop policy if exists "group_class_series_select" on public.group_class_series;

drop index if exists public.idx_appointments_series_starts;
drop index if exists public.uq_appointments_series_occurrence;

alter table public.appointments
  drop constraint if exists appointments_group_class_series_fk,
  drop constraint if exists appointments_series_fields_all_or_none,
  drop constraint if exists appointments_series_overridden_fields_valid,
  drop constraint if exists appointments_series_occurrence_index_positive;

alter table public.appointments
  drop column if exists series_overridden_fields,
  drop column if exists occurrence_original_start,
  drop column if exists series_occurrence_index,
  drop column if exists group_class_series_id;

drop trigger if exists set_group_class_series_updated_at on public.group_class_series;
drop trigger if exists group_class_series_enforce_shape on public.group_class_series;
drop function if exists public.enforce_group_class_series_shape();
drop table if exists public.group_class_series;

commit;

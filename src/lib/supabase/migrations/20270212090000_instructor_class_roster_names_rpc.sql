-- Instructor class roster names.
--
-- An assigned instructor can read their own group class and its appointment_attendees rows, but not the attendees' names: FC-1B5D Phase B removed instructors from
-- `clients` RLS, and get_teaching_clients_for_instructor joins only appointments.client_id, which is null for a group class. So the web class roster panel showed
-- "Unnamed dancer", the instructor attendance page dropped those attendees, and the staff API returned name: null.
--
-- This function answers one question: "the names of the people enrolled in THIS class, which I am currently assigned to teach". It does not change any RLS policy.
--
-- Scope, all derived inside the function:
--   - identity comes from auth.uid(); there is no instructor or studio parameter to point at someone else;
--   - the appointment must be a group_class whose CURRENT instructor_id is the caller's own active instructors row at that studio (is_own_instructor_appointment,
--     the same predicate appointments_select uses), and the caller must hold an active user_studio_roles row at that studio;
--   - only that appointment's attendee rows, booked or cancelled (the roster panel lists both), with attendee and client studio pinned to the appointment's studio;
--   - only id, first_name, last_name and the enrollment status: no contact details, notes, referral source, billing or funding fields.
-- A caller who fails any check gets zero rows, the same as a class with no attendees, so the function is not an oracle for which appointment ids exist.
-- Reassignment is immediate: the check reads the live instructor_id. No platform_admin bypass: platform admins read through broad RLS.
--
-- No time window: the instructor can already read their own class row and its attendee rows for any date under existing RLS, and the attendance page lets them
-- record past classes. Owner decision recorded in the PR.

create or replace function public.get_class_roster_names_for_instructor(
  target_appointment_id uuid
)
returns table (
  client_id uuid,
  first_name text,
  last_name text,
  attendee_status text
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select c.id, c.first_name, c.last_name, aa.status
  from public.appointments a
  join public.appointment_attendees aa
    on aa.appointment_id = a.id
   and aa.studio_id = a.studio_id
  join public.clients c
    on c.id = aa.client_id
   and c.studio_id = a.studio_id
  where a.id = target_appointment_id
    and a.appointment_type = 'group_class'::appointment_type
    and a.instructor_id is not null
    and public.is_own_instructor_appointment(a.studio_id, a.instructor_id)
    and exists (
      select 1
      from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = a.studio_id
        and usr.active = true
    )
  order by c.last_name, c.first_name, c.id;
$$;

revoke all on function public.get_class_roster_names_for_instructor(uuid) from public;
revoke all on function public.get_class_roster_names_for_instructor(uuid) from anon;
grant execute on function public.get_class_roster_names_for_instructor(uuid) to authenticated;
grant execute on function public.get_class_roster_names_for_instructor(uuid) to service_role;

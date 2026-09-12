-- Membership Usage-Period Alignment -- P5: recurring self-service
-- availability DB predicate.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\we-are-starting-a-functional-liskov.md, sections T, U, V.
--
-- studio_booking_availability_windows is reclassified A (was B) -- a direct
-- RPC call must not be able to persist an appointment outside a legitimate
-- recurring window. Every windowMatches predicate (active, weekday,
-- effective dates, lesson_type, instructor, room) is factored into one
-- shared `candidates` CTE so the instructor-priority existence check and
-- the final window-selection query can never see different candidate sets
-- (the parity bug a previous draft of this predicate had, before this
-- canonical plan's own correction round).

begin;

create or replace function public._self_service_slot_within_availability(
  p_studio_id uuid, p_instructor_id uuid, p_room_id uuid, p_lesson_type text,
  p_starts_at timestamptz, p_ends_at timestamptz
) returns boolean
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_tz text;
  v_date_key date;
  v_weekday int;
begin
  select coalesce(timezone, 'America/New_York') into v_tz from public.studio_settings where studio_id = p_studio_id;
  v_date_key := (p_starts_at at time zone v_tz)::date;
  v_weekday := extract(dow from (p_starts_at at time zone v_tz));

  return exists (
    with candidates as (
      -- every windowMatches predicate, in exactly one place, room included
      select w.*
      from public.studio_booking_availability_windows w
      where w.studio_id = p_studio_id
        and coalesce(w.active, true)
        and w.weekday = v_weekday
        and (w.effective_start_date is null or w.effective_start_date <= v_date_key)
        and (w.effective_end_date is null or w.effective_end_date >= v_date_key)
        and (p_lesson_type is null or w.lesson_type is null or w.lesson_type = p_lesson_type)
        and (p_instructor_id is null or w.instructor_id is null or w.instructor_id = p_instructor_id)
        and (p_room_id is null or w.room_id is null or w.room_id = p_room_id)
    )
    select 1
    from candidates c
    where (
      -- instructor-priority resolution applies only when a specific
      -- instructor was requested; when none was requested, every
      -- room/date/type-matching candidate is eligible, matching
      -- resolveMatchingWindows's `if (!params.instructorId) return
      -- matchingWindows;` exactly
      p_instructor_id is null
      or (
        exists (select 1 from candidates ci where ci.instructor_id = p_instructor_id)
        and c.instructor_id = p_instructor_id
      )
      or (
        not exists (select 1 from candidates ci where ci.instructor_id = p_instructor_id)
        and c.instructor_id is null
      )
    )
    and (v_date_key || ' ' || c.start_time)::timestamp at time zone v_tz <= p_starts_at
    and p_ends_at <= (v_date_key || ' ' || c.end_time)::timestamp at time zone v_tz
  );
end;
$$;

revoke all on function public._self_service_slot_within_availability(uuid, uuid, uuid, text, timestamptz, timestamptz) from public, anon, authenticated, service_role;

commit;

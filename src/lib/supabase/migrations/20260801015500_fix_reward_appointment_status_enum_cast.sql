-- Fix appointment inserts failing with:
-- invalid input value for enum appointment_status: ""
--
-- The reward trigger used COALESCE directly on the appointment_status enum,
-- which caused PostgreSQL to coerce the empty-string fallback to the enum.
-- Cast enum values to text before applying COALESCE/LOWER.

create or replace function public.reward_on_appointment_attended()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.client_id is null then
    return new;
  end if;

  if lower(coalesce(new.status::text, '')) = 'attended'
     and (
       tg_op = 'INSERT'
       or lower(coalesce(old.status::text, '')) <> 'attended'
     ) then

    perform public.record_reward_event(
      new.studio_id,
      new.client_id,
      'attendance_milestone',
      1,
      'appointments',
      new.id,
      concat('appointment-attendance:', new.id),
      jsonb_build_object('appointment_type', new.appointment_type),
      coalesce(new.starts_at, now())
    );

    perform public.record_reward_event(
      new.studio_id,
      new.client_id,
      'participation_milestone',
      1,
      'appointments',
      new.id,
      concat('appointment-participation:', new.id),
      jsonb_build_object('appointment_type', new.appointment_type),
      coalesce(new.starts_at, now())
    );

    if new.appointment_type = 'intro_lesson' then
      perform public.record_reward_event(
        new.studio_id,
        new.client_id,
        'intro_completed',
        1,
        'appointments',
        new.id,
        concat('intro-completed:', new.id),
        '{}'::jsonb,
        coalesce(new.starts_at, now())
      );
    end if;
  end if;

  return new;
end;
$function$;

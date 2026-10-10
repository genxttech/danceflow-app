-- Rollback for Phase 10C.5 (20261113090000_phase10c5_competition_draft.sql).
--
-- Refuses while any category still has deferred pricing (the guard it removes would otherwise let such a
-- program open registration at $0). Restores the reviewed 10C open_competition_registration byte-for-byte,
-- drops the two 10C.5 functions and RETIRES (never deletes) studio_simple@2: programs created from it keep
-- their profile reference, and v2 can only be reactivated with identical content by re-applying 10C.5.

do $$
begin
  if md5(pg_get_functiondef('public.open_competition_registration(uuid)'::regprocedure)) <> 'abe6b1940de5b96fd931cdddebfd9bed' then
    raise exception 'Phase 10C.5 rollback: open_competition_registration is not the 10C.5 definition.';
  end if;
  if exists (select 1 from public.event_competition_contests c where coalesce(c.configuration #>> '{setup,pricing_pending}', 'false') = 'true') then
    raise exception 'Phase 10C.5 rollback: complete or remove categories with pending pricing first.';
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.open_competition_registration(p_program_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_program record;
  v_event record;
  v_contests int;
  v_divisions int;
begin
  select p.* into v_program from public.event_competition_programs p where p.id = p_program_id for update;
  if v_program.id is null or not public.can_manage_event_competition(v_program.event_id) then
    raise exception 'COMP10C_FORBIDDEN: competition was not found or cannot be managed.' using errcode = '42501';
  end if;
  select e.* into v_event from public.events e where e.id = v_program.event_id;
  if v_program.status not in ('configured', 'active') then
    raise exception 'COMP10C_NOT_PUBLISHED: publish the competition before opening registration.';
  end if;
  if v_program.rules_profile_key is not null and v_program.profile_locked_at is null then
    raise exception 'COMP10C_NOT_PUBLISHED: publish the competition before opening registration.';
  end if;
  if not v_event.registration_required then
    raise exception 'COMP10C_EVENT_REGISTRATION_OFF: turn on event registration before opening competition registration.';
  end if;

  -- Open every category that has at least one division, its draft divisions, and its rule.
  with ready as (
    select c.id from public.event_competition_contests c
    where c.program_id = v_program.id and c.event_id = v_program.event_id
      and c.status in ('draft', 'open')
      and exists (select 1 from public.event_competition_divisions d
                  where d.contest_id = c.id and d.event_id = c.event_id and d.status in ('draft', 'open'))
      and exists (select 1 from public.event_competition_contest_registration_rules r
                  where r.contest_id = c.id and r.event_id = c.event_id)
  ), opened as (
    update public.event_competition_contests c set status = 'open', updated_at = now()
    from ready where c.id = ready.id and c.status = 'draft' returning c.id
  )
  select (select count(*) from ready) into v_contests;
  if v_contests = 0 then
    raise exception 'COMP10C_NOTHING_REGISTRABLE: add a category with at least one division before opening registration.';
  end if;

  update public.event_competition_divisions d set status = 'open', updated_at = now()
  where d.program_id = v_program.id and d.event_id = v_program.event_id and d.status = 'draft'
    and exists (select 1 from public.event_competition_contests c where c.id = d.contest_id and c.status = 'open');
  select count(*) into v_divisions from public.event_competition_divisions d
  where d.program_id = v_program.id and d.status = 'open';

  update public.event_competition_contest_registration_rules r set registration_open = true, updated_at = now()
  where r.program_id = v_program.id and r.event_id = v_program.event_id and not r.registration_open
    and exists (select 1 from public.event_competition_contests c where c.id = r.contest_id and c.status = 'open');

  update public.event_competition_programs
  set registration_status = 'open', registration_opened_at = now(), updated_at = now()
  where id = v_program.id;

  return jsonb_build_object('program_id', v_program.id, 'registration_status', 'open',
    'open_categories', v_contests, 'open_divisions', v_divisions);
end;
$function$
;

drop function public.set_competition_category_pricing(uuid, text, numeric);
drop function public.create_competition_draft(uuid, jsonb);

update public.competition_rules_profiles set status = 'retired'
where profile_key = 'studio_simple' and version = 2 and status = 'active';

do $$
begin
  if md5(pg_get_functiondef('public.open_competition_registration(uuid)'::regprocedure)) <> '3ebe965489271f0c53d7caeba96c8525' then
    raise exception 'Phase 10C.5 rollback: open_competition_registration was not restored exactly.';
  end if;
end $$;

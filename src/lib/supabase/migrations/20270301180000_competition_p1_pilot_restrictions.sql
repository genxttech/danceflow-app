-- 20270301180000_competition_p1_pilot_restrictions.sql
-- ============================================================================================================================================
-- NOT APPLIED ANYWHERE. DRAFT. Applying this migration to ANY hosted environment needs separate owner approval.
-- ============================================================================================================================================
-- P1 restricted Studio/Custom pilot (OWNER-DECISIONS section 21; MVP-RELEASE-ASSESSMENT.md sections 2-3). DanceFlow Studio/Custom pilot policy,
-- not a governing-body rule.
--
-- GLOBAL restriction: it applies to every competition event in the database. There is no per-event flag and no role exemption (every trigger is
-- ENABLE ALWAYS and also binds SECURITY DEFINER lifecycle functions). It redefines no function; the rollback removes it completely.
--
-- Disabled: callbacks and advancement; a second round per division (cancelled ones included, so there is no cancel-and-recreate route); a second
-- heat per round and schedule version; a second dance per heat; after the event has started, new programs, divisions or rounds, running-order
-- replacement, heat insert / delete / move / renumber, dance changes and round or heat cancellation; a second published running order; corrections,
-- including reopening locked ballots; adding a couple to a started heat; paper ballots; ballots for a heat that has not started;
-- approval by the calculator; approval or publication for a declared governing body; approval with fewer than two ranked couples; changes to
-- published names and entry numbers. Backstop: no writer can remove a couple from a started heat.
--
-- "Started" = any heat staging, active or complete, any round active or later, or any ballot, in that event.
--
-- Kept on purpose: a judge may replace their own ballot, with a reason, while the round is still active (a No-show recorded after a ballot makes that
-- ballot stale and only a new version can clear it). 'other' sanctioning stays approvable, as OD-01 decided (only UCWDC, NDCA and WSDC block).
-- Limits: a round cancelled before the start still counts as the division's one round.
--
-- Requires 20270301090000 (R-11, PR 865) and 20270301141000 (S6, PR 877). Order with 20270301170000 (Option D) does not matter.

begin;
set local lock_timeout = '5s';

do $$
declare
  v_dup text;
begin
  if position('COMP_CORRECTION_APPROVER_REQUIRED' in pg_get_functiondef('public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure)) = 0 then
    raise exception 'P1 preflight: apply 20270301090000 (R-11 approval override scope) first.';
  end if;
  if to_regprocedure('public.cf1_s6_guard_started_participation()') is null then
    raise exception 'P1 preflight: apply 20270301140000 and 20270301141000 (S6 entry status guard) first.';
  end if;
  if to_regprocedure('public._compo1_lock_event(uuid)') is null or to_regclass('public.event_competition_result_publications') is null then
    raise exception 'P1 preflight: the day-of (O1) or publication (F3) migrations are missing.';
  end if;
  if exists (select 1 from pg_trigger where tgname like 'zz\_compp1\_%' and not tgisinternal) then
    raise exception 'P1 preflight: P1 triggers already exist.';
  end if;
  -- existing data that the one-per rules cannot hold: refuse with the counts instead of failing inside CREATE INDEX
  select concat_ws('; ',
    (select 'divisions with more than one round: ' || count(*) from (select 1 from public.event_competition_rounds group by event_id, division_id having count(*) > 1) x having count(*) > 0),
    (select 'rounds with more than one live heat in a version: ' || count(*) from (select 1 from public.event_competition_heats where status <> 'cancelled' and round_id is not null
        group by round_id, schedule_version_id having count(*) > 1) x having count(*) > 0),
    (select 'events with more than one published or live running order: ' || count(*) from (select 1 from public.event_competition_schedule_versions where status in ('published', 'live')
        group by event_id having count(*) > 1) x having count(*) > 0),
    (select 'heats with more than one live dance: ' || count(*) from (select 1 from public.event_competition_heat_dances where status <> 'cancelled' group by heat_id having count(*) > 1) x having count(*) > 0))
    into v_dup;
  if coalesce(v_dup, '') <> '' then
    raise exception 'P1 preflight: existing competition data breaks the pilot limits (%). Resolve it with the owner; nothing was changed.', v_dup;
  end if;
end $$;

create unique index compp1_one_round_per_division on public.event_competition_rounds (event_id, division_id);
create unique index compp1_one_heat_per_round on public.event_competition_heats
  (round_id, coalesce(schedule_version_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status <> 'cancelled';
create unique index compp1_one_published_order on public.event_competition_schedule_versions (event_id) where status in ('published', 'live');
create unique index compp1_one_dance_per_heat on public.event_competition_heat_dances (heat_id) where status <> 'cancelled';

-- Serializes a structural change against start / advance (which hold the same event lock) and answers whether the event has started.
-- Never waits: a busy event refuses and the caller retries.
create function public._compp1_started(p_event_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('compo1:' || p_event_id::text, 0)) then
    raise exception 'COMP_P1_BUSY: the event is being changed; try again.' using errcode = '55P03';
  end if;
  return exists (select 1 from public.event_competition_heats h where h.event_id = p_event_id and h.status in ('staging', 'active', 'complete'))
      or exists (select 1 from public.event_competition_rounds r where r.event_id = p_event_id
                 and r.status in ('active', 'ballots_locked', 'calculated', 'approved', 'published', 'complete'))
      or exists (select 1 from public.event_competition_ballots b where b.event_id = p_event_id);
end;
$$;

-- Programs and divisions: none added or removed once the event has started.
create function public._compp1_guard_structure()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid := case when tg_op = 'DELETE' then old.event_id else new.event_id end;
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.events e where e.id = v_event) then
    return old;   -- cascade of a deleted event
  end if;
  if tg_op = 'UPDATE' and new.event_id is not distinct from old.event_id
     and (to_jsonb(new) ->> 'program_id') is not distinct from (to_jsonb(old) ->> 'program_id') then
    return new;
  end if;
  if public._compp1_started(v_event) or (tg_op = 'UPDATE' and public._compp1_started(old.event_id)) then
    raise exception 'COMP_P1_STRUCTURE_FROZEN: programs and divisions cannot be added, moved or removed after the event has started (pilot).' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create function public._compp1_guard_round()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.events e where e.id = old.event_id) and public._compp1_started(old.event_id) then
      raise exception 'COMP_P1_STRUCTURE_FROZEN: a round cannot be removed after the event has started (pilot).' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' or new.round_type is distinct from old.round_type then
    if new.round_type is distinct from 'final' then
      raise exception 'COMP_P1_FINAL_ONLY: the pilot runs one final per division; no other round type (callbacks and advancement are off).' using errcode = 'P0001';
    end if;
  end if;
  if (tg_op = 'INSERT' or (to_jsonb(new) ->> 'scoring_method') is distinct from (to_jsonb(old) ->> 'scoring_method'))
     and (to_jsonb(new) ->> 'scoring_method') = 'callback_tally' then
    raise exception 'COMP_P1_CALLBACKS_OFF: callback scoring is off in the pilot.' using errcode = 'P0001';
  end if;
  if (tg_op = 'INSERT' and new.correction_open) or (tg_op = 'UPDATE' and new.correction_open and not old.correction_open) then
    raise exception 'COMP_P1_CORRECTIONS_OFF: result corrections are off in the pilot.' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    if new.status = 'active' and old.status in ('ballots_locked', 'calculated', 'approved', 'published', 'complete') then
      raise exception 'COMP_P1_CORRECTIONS_OFF: locked ballots cannot be reopened in the pilot.' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'INSERT' then
    if public._compp1_started(new.event_id) then
      raise exception 'COMP_P1_STRUCTURE_FROZEN: a round cannot be added after the event has started (pilot).' using errcode = 'P0001';
    end if;
  elsif (new.event_id, new.program_id, new.division_id, new.round_type, new.sequence_number)
          is distinct from (old.event_id, old.program_id, old.division_id, old.round_type, old.sequence_number)
        or (new.status = 'cancelled' and old.status is distinct from 'cancelled') then
    if public._compp1_started(old.event_id) or public._compp1_started(new.event_id) then
      raise exception 'COMP_P1_STRUCTURE_FROZEN: a round cannot be cancelled, moved or retyped after the event has started (pilot).' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create function public._compp1_guard_heat()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.events e where e.id = old.event_id) and public._compp1_started(old.event_id) then
      raise exception 'COMP_P1_ORDER_FROZEN: a heat cannot be removed after the event has started (pilot).' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if public._compp1_started(new.event_id) then
      raise exception 'COMP_P1_ORDER_FROZEN: a heat cannot be added after the event has started (pilot).' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status in ('active', 'complete') and new.status not in ('active', 'complete') then
    raise exception 'COMP_P1_ORDER_FROZEN: a started heat cannot go back or be cancelled (pilot).' using errcode = 'P0001';
  end if;
  if (new.event_id, new.round_id, new.division_id, new.schedule_version_id, new.floor_heat_id, new.contest_id, new.heat_number)
       is distinct from (old.event_id, old.round_id, old.division_id, old.schedule_version_id, old.floor_heat_id, old.contest_id, old.heat_number)
     or (new.status = 'cancelled' and old.status is distinct from 'cancelled') then
    if public._compp1_started(old.event_id) or public._compp1_started(new.event_id) then
      raise exception 'COMP_P1_ORDER_FROZEN: a heat cannot be cancelled or moved after the event has started (pilot).' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create function public._compp1_guard_heat_dance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.events e where e.id = old.event_id) then
      return old;
    end if;
    v_event := old.event_id;
  else
    v_event := new.event_id;
    if tg_op = 'UPDATE' then
      if (new.event_id, new.heat_id, new.dance_id, new.dance_key, new.sequence_number, new.status)
           is not distinct from (old.event_id, old.heat_id, old.dance_id, old.dance_key, old.sequence_number, old.status) then
        return new;
      end if;
    end if;
  end if;
  if public._compp1_started(v_event) then
    raise exception 'COMP_P1_ORDER_FROZEN: the dances of a heat cannot change after the event has started (pilot).' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Running order: no replacement after the start. published <-> live of the same version stays possible.
create function public._compp1_guard_version()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_was boolean := tg_op <> 'INSERT' and old.status in ('published', 'live');
  v_is boolean := tg_op <> 'DELETE' and new.status in ('published', 'live');
  v_event uuid := case when tg_op = 'DELETE' then old.event_id else new.event_id end;
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.events e where e.id = v_event) then
    return old;
  end if;
  if (v_was is distinct from v_is or (tg_op = 'UPDATE' and new.event_id is distinct from old.event_id)) and public._compp1_started(v_event) then
    raise exception 'COMP_P1_ORDER_FROZEN: the running order cannot be replaced or unpublished after the event has started (pilot).' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    -- the live order is chosen by published_at, then created_at
    if v_was and (new.published_at, new.created_at) is distinct from (old.published_at, old.created_at) and public._compp1_started(v_event) then
      raise exception 'COMP_P1_ORDER_FROZEN: the publication order of a running order cannot change after the event has started (pilot).' using errcode = 'P0001';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Ballots: the judge's own electronic ballot, for a heat that has started. With the S6 started-heat block this means a couple with a ballot can
-- no longer be scratched or withdrawn.
create function public._compp1_guard_ballot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  if new.source is distinct from 'judge_web' then
    raise exception 'COMP_P1_PAPER_BALLOTS_OFF: only judges'' own electronic ballots are accepted in the pilot.' using errcode = 'P0001';
  end if;
  select h.status into v_status from public.event_competition_heats h where h.id = new.heat_id and h.event_id = new.event_id for share;
  if v_status is null or v_status not in ('active', 'complete') then
    raise exception 'COMP_P1_HEAT_NOT_STARTED: ballots are accepted only for a heat that has started (pilot).' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Backstop for every writer (refunds and registration sync included): a couple cannot be removed from a started heat. The heat is locked without
-- waiting, so a removal racing the start refuses and a retry sees the started heat (the refund and sync paths then leave participation alone).
create function public._compp1_guard_placement_removal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_adds boolean := false;
begin
  if tg_op = 'INSERT' then
    v_adds := new.status is distinct from 'scratched';
  elsif tg_op = 'UPDATE' then
    v_adds := new.status is distinct from 'scratched' and (new.heat_id is distinct from old.heat_id or new.entry_id is distinct from old.entry_id or old.status = 'scratched');
  end if;
  if v_adds then
    begin
      select h.status into v_status from public.event_competition_heats h where h.id = new.heat_id for share nowait;
    exception when lock_not_available then
      raise exception 'COMP_P1_BUSY: the heat is being changed; try again.' using errcode = '55P03';
    end;
    if v_status in ('active', 'complete') then
      raise exception 'COMP_P1_STARTED_HEAT: a couple cannot be added to a heat that has started (pilot).' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if old.status = 'scratched' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from 'scratched' and new.heat_id = old.heat_id and new.entry_id = old.entry_id then
    return new;
  end if;
  begin
    select h.status into v_status from public.event_competition_heats h where h.id = old.heat_id for share nowait;
  exception when lock_not_available then
    raise exception 'COMP_P1_BUSY: the heat is being changed; try again.' using errcode = '55P03';
  end;
  if v_status in ('active', 'complete') and exists (select 1 from public.events e where e.id = old.event_id) then
    raise exception 'COMP_P1_STARTED_HEAT: a couple cannot be removed from a heat that has started (pilot).' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create function public._compp1_guard_entry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_h record;
begin
  if tg_op = 'UPDATE' and (new.display_name, new.entry_number) is distinct from (old.display_name, old.entry_number)
     and exists (select 1 from public.event_competition_result_publications p
                 join public.event_competition_heats h on h.round_id = p.round_id and h.event_id = p.event_id
                 join public.event_competition_heat_entries he on he.heat_id = h.id
                 where he.entry_id = old.id) then
    raise exception 'COMP_P1_PUBLISHED_FROZEN: the name and number of a published couple cannot change (pilot).' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.events e where e.id = old.event_id) then
      return old;
    end if;
  elsif not (new.status in ('scratched', 'withdrawn') and old.status is distinct from new.status) then
    return new;
  end if;
  begin
    for v_h in
      select h.status from public.event_competition_heats h
      where h.id in (select he.heat_id from public.event_competition_heat_entries he where he.entry_id = old.id and he.status <> 'scratched')
      order by h.id for share nowait
    loop
      if v_h.status in ('active', 'complete') then
        raise exception 'COMP_P1_STARTED_HEAT: a couple cannot be removed after one of its heats has started (pilot).' using errcode = 'P0001';
      end if;
    end loop;
  exception when lock_not_available then
    raise exception 'COMP_P1_BUSY: a heat of this couple is being changed; try again.' using errcode = '55P03';
  end;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Published round, division and program names are read live by the result pages, so they are frozen once a result was published.
create function public._compp1_guard_published_name()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.name is distinct from old.name and exists (
       select 1 from public.event_competition_result_publications p
       join public.event_competition_rounds r on r.id = p.round_id
       where p.event_id = old.event_id
         and old.id = case tg_argv[0] when 'round' then r.id when 'division' then r.division_id else r.program_id end) then
    raise exception 'COMP_P1_PUBLISHED_FROZEN: a published % name cannot change (pilot).', tg_argv[0] using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create function public._compp1_guard_disabled()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception '%', tg_argv[0] using errcode = 'P0001';
end;
$$;

create function public._compp1_require_studio_scoring(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.events e where e.id = p_event_id and e.competition_sanctioning in ('none', 'other')) then
    raise exception 'COMP_P1_SANCTION_BLOCKED: results of an event that declares a governing body cannot be approved or published (pilot; OD-01).' using errcode = 'P0001';
  end if;
end;
$$;

create function public._compp1_guard_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calculator uuid;
begin
  select v.calculated_by into v_calculator from public.event_competition_result_versions v where v.id = new.result_version_id and v.event_id = new.event_id;
  if v_calculator is null or new.approved_by is null or new.approved_by = v_calculator or new.approved_by = new.calculated_by or new.override_reason is not null then
    raise exception 'COMP_P1_SECOND_APPROVER_REQUIRED: a second person must approve; the calculator cannot approve, with or without a reason (pilot).' using errcode = 'P0001';
  end if;
  perform public._compp1_require_studio_scoring(new.event_id);
  if (select count(distinct rr.entry_id) from public.event_competition_result_rows rr
      where rr.result_version_id = new.result_version_id and rr.event_id = new.event_id) < 2 then
    raise exception 'COMP_P1_MINIMUM_COUPLES: a final needs at least two ranked couples (pilot).' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create function public._compp1_guard_publication()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._compp1_require_studio_scoring(new.event_id);
  return new;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['_compp1_started(uuid)', '_compp1_guard_structure()', '_compp1_guard_round()', '_compp1_guard_heat()', '_compp1_guard_heat_dance()', '_compp1_guard_version()',
    '_compp1_guard_ballot()', '_compp1_guard_placement_removal()', '_compp1_guard_entry()', '_compp1_guard_published_name()', '_compp1_guard_disabled()',
    '_compp1_require_studio_scoring(uuid)', '_compp1_guard_approval()', '_compp1_guard_publication()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated, service_role', f);
  end loop;
end $$;

create trigger zz_compp1_programs before insert or delete or update of event_id on public.event_competition_programs
  for each row execute function public._compp1_guard_structure();
create trigger zz_compp1_divisions before insert or delete or update of event_id, program_id on public.event_competition_divisions
  for each row execute function public._compp1_guard_structure();
create trigger zz_compp1_rounds before insert or update or delete on public.event_competition_rounds
  for each row execute function public._compp1_guard_round();
create trigger zz_compp1_heats before insert or update or delete on public.event_competition_heats
  for each row execute function public._compp1_guard_heat();
create trigger zz_compp1_heat_dances before insert or update or delete on public.event_competition_heat_dances
  for each row execute function public._compp1_guard_heat_dance();
create trigger zz_compp1_versions before insert or delete or update of status, event_id, published_at, created_at on public.event_competition_schedule_versions
  for each row execute function public._compp1_guard_version();
create trigger zz_compp1_ballots before insert on public.event_competition_ballots
  for each row execute function public._compp1_guard_ballot();
create trigger zz_compp1_placements before insert or delete or update of status, heat_id, entry_id on public.event_competition_heat_entries
  for each row execute function public._compp1_guard_placement_removal();
create trigger zz_compp1_entries before delete or update of status, display_name, entry_number on public.event_competition_entries
  for each row execute function public._compp1_guard_entry();
create trigger zz_compp1_round_name before update of name on public.event_competition_rounds
  for each row execute function public._compp1_guard_published_name('round');
create trigger zz_compp1_division_name before update of name on public.event_competition_divisions
  for each row execute function public._compp1_guard_published_name('division');
create trigger zz_compp1_program_name before update of name on public.event_competition_programs
  for each row execute function public._compp1_guard_published_name('program');
create trigger zz_compp1_advancement before insert on public.event_competition_round_advancements
  for each row execute function public._compp1_guard_disabled('COMP_P1_ADVANCEMENT_OFF: advancement between rounds is off in the pilot.');
create trigger zz_compp1_correction before insert on public.event_competition_correction_causes
  for each row execute function public._compp1_guard_disabled('COMP_P1_CORRECTIONS_OFF: result corrections are off in the pilot.');
create trigger zz_compp1_approval before insert on public.event_competition_result_approvals
  for each row execute function public._compp1_guard_approval();
create trigger zz_compp1_publication before insert on public.event_competition_result_publications
  for each row execute function public._compp1_guard_publication();

do $$
declare
  r record;
  n integer := 0;
begin
  for r in select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname like 'zz\_compp1\_%' and not t.tgisinternal loop
    execute format('alter table public.%I enable always trigger %I', r.relname, r.tgname);
    n := n + 1;
  end loop;
  if n <> 16 then
    raise exception 'P1 postflight: expected 16 triggers, found %.', n;
  end if;
end $$;

commit;

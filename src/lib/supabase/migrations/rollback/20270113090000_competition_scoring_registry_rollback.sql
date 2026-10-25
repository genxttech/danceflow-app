-- Rollback for 20270113090000_competition_scoring_registry.sql.
--
-- Refuses while any data would be lost: a division selection, a round override, a scoring pin, or a declared
-- sanctioning. Pins are lock evidence and are never dropped silently; clear selections on unlocked drafts first and
-- keep the migration if any program has been locked since it was applied. Nothing else (no existing column, check or
-- function) was changed by the migration, so nothing else is restored.

begin;

do $$
begin
  if exists (select 1 from public.event_competition_scoring_pins) then
    raise exception 'REG rollback: scoring pins exist (lock evidence); keep the registry.';
  end if;
  if exists (select 1 from public.event_competition_divisions where scoring_method_key is not null)
     or exists (select 1 from public.event_competition_rounds where scoring_override_key is not null) then
    raise exception 'REG rollback: division selections or round overrides exist; clear them first.';
  end if;
  if exists (select 1 from public.events where competition_sanctioning <> 'none') then
    raise exception 'REG rollback: events with a declared sanctioning exist; reset them to none first.';
  end if;
end $$;

drop trigger pin_competition_late_round on public.event_competition_rounds;
drop trigger pin_competition_program_scoring on public.event_competition_programs;
drop trigger guard_competition_scoring_selection on public.event_competition_rounds;
drop trigger guard_competition_scoring_selection on public.event_competition_divisions;
drop trigger protect_competition_sanctioning on public.events;

drop function public.competition_round_scoring_effective(uuid);
drop function public.pin_competition_late_round();
drop function public.pin_competition_program_scoring();
drop function public.pin_competition_round_scoring(uuid);
drop function public.competition_scoring_resolve(uuid);
drop function public.guard_competition_scoring_selection();
drop function public.protect_competition_sanctioning();

alter table public.events
  drop constraint events_competition_sanctioning_type_check,
  drop constraint events_competition_sanctioning_check,
  drop column competition_sanctioning;

alter table public.event_competition_rounds
  drop constraint event_competition_rounds_scoring_override_fk,
  drop constraint event_competition_rounds_scoring_override_pair_check,
  drop column scoring_override_key,
  drop column scoring_override_version;

alter table public.event_competition_divisions
  drop constraint event_competition_divisions_scoring_method_fk,
  drop constraint event_competition_divisions_scoring_pair_check,
  drop column scoring_method_key,
  drop column scoring_method_version;

-- The pins table is empty (checked above); its append-only triggers are dropped with it.
drop table public.event_competition_scoring_pins;

-- The protect triggers refuse deletes by design; they are dropped before the append-only tables.
drop trigger protect_competition_scoring_legacy_map on public.competition_scoring_legacy_map;
drop trigger protect_competition_scoring_legacy_map_truncate on public.competition_scoring_legacy_map;
drop table public.competition_scoring_legacy_map;
drop function public.protect_competition_scoring_legacy_map();

drop trigger protect_competition_scoring_method on public.competition_scoring_methods;
drop trigger protect_competition_scoring_method_truncate on public.competition_scoring_methods;
drop table public.competition_scoring_methods;
drop function public.protect_competition_scoring_method();
drop function public.protect_competition_scoring_pin();

notify pgrst, 'reload schema';

commit;

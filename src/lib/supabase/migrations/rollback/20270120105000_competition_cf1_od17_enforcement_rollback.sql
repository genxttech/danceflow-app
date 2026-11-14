-- Rollback for 20270120105000_competition_cf1_od17_enforcement.sql. App first (hide any switch UI), then this file.
-- Removes ONLY the objects that migration created. Dropping the guards while an event is ON would silently turn the extra enforcement OFF
-- (fail open), so it refuses until every event is disabled through cf1_od17_set_enforcement(..., false, ...). It also refuses once any audit row
-- exists: the enable / disable history is evidence and is rolled forward, never deleted.
begin;

do $$
begin
  if to_regclass('public.competition_cf1_od17_enforcement') is null or to_regprocedure('public.cf1_od17_set_enforcement(uuid,boolean,text,uuid)') is null then
    raise exception 'CF1-OD17 rollback: the OD-17 enforcement migration is not installed.';
  end if;
  if exists (select 1 from public.competition_cf1_od17_enforcement s where s.enabled) then
    raise exception 'CF1-OD17 rollback refused: at least one event has OD-17 enforcement ON; disable it first (cf1_od17_set_enforcement).';
  end if;
  if exists (select 1 from public.competition_cf1_od17_audit) then
    raise exception 'CF1-OD17 rollback refused: audit rows exist (evidence); roll forward instead.';
  end if;
end $$;

drop trigger cf1_od17_guard_advancement on public.event_competition_round_advancements;
drop trigger cf1_od17_guard_heat_entry on public.event_competition_heat_entries;
drop trigger cf1_od17_guard_round_status on public.event_competition_rounds;
drop function public.cf1_od17_enforcement_state(uuid);
drop function public.cf1_od17_set_enforcement(uuid, boolean, text, uuid);
drop function public.cf1_od17_guard_advancement();
drop function public.cf1_od17_guard_heat_entry();
drop function public.cf1_od17_guard_round_status();
drop function public._cf1_od17_runtime_gate();
drop function public._cf1_od17_gates(uuid);
drop function public._cf1_od17_enforced(uuid);
drop table public.competition_cf1_od17_audit;
drop table public.competition_cf1_od17_enforcement;

do $$
begin
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '%od17%' and p.proname not in ('_cf1_od17_refund_gate'))) then
    raise exception 'CF1-OD17 rollback: an OD-17 enforcement function is left.';
  end if;
  if to_regclass('public.competition_cf1_od17_audit') is not null or to_regclass('public.competition_cf1_od17_enforcement') is not null then
    raise exception 'CF1-OD17 rollback: a table is left.';
  end if;
end $$;

commit;

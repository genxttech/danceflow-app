-- Rollback of 20270108090000_competition_sc1_scratch.sql.
--
-- Refuses while any scratch audit row exists (dropping it would erase scratch history). Restores the exact
-- reviewed 10A body of protect_locked_competition_heat_children (md5 7997313d6effc4af94caf5fe4fd055c9).
-- Entries already scratched stay scratched (the entry change audit keeps their history).

begin;

do $$
begin
  if to_regclass('public.event_competition_scratches') is null then
    raise exception 'SC1 rollback: SC1 is not applied.';
  end if;
  if exists (select 1 from public.event_competition_scratches) then
    raise exception 'SC1 rollback: scratch audit rows exist; refusing to drop scratch history.';
  end if;
end $$;

create or replace function public.protect_locked_competition_heat_children()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  selected_heat_id uuid;
  selected_lock_state text;
begin
  selected_heat_id := case when tg_op = 'DELETE' then old.heat_id else new.heat_id end;
  select lock_state into selected_lock_state
  from public.event_competition_heats where id = selected_heat_id;
  if selected_lock_state in ('locked', 'certified') then
    raise exception 'Locked or certified heat details require the authorized correction workflow.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop function public.set_competition_scratch_policy_default(uuid, text);
drop function public.set_competition_scratch_policy(uuid, text);
drop function public.scratch_competition_entry(uuid, uuid, text, text);
drop table public.event_competition_scratches;
drop function public._sc1_protect_scratches();
drop function public.competition_scratch_effective_policy(uuid);
drop table public.event_competition_scratch_policies;
drop table public.competition_scratch_policy_defaults;

do $$
begin
  if (select md5(replace(prosrc, E'\r\n', E'\n')) from pg_proc
      where oid = 'public.protect_locked_competition_heat_children()'::regprocedure) <> '7997313d6effc4af94caf5fe4fd055c9' then
    raise exception 'SC1 rollback: restored guard body does not match the reviewed 10A body.';
  end if;
end $$;

commit;

-- Rollback of 20270108090000_competition_sc1_scratch.sql.
--
-- Always: restores the exact reviewed 10A body of protect_locked_competition_heat_children (md5
-- 7997313d6effc4af94caf5fe4fd055c9), removes the API-role scratch write guards, drops the scratch and policy RPCs
-- and restores EXECUTE on change_competition_entry_lifecycle for authenticated (its pre-SC1 grant).
--
-- Audit data:
--   * no scratch rows and no policy changes: SC1 tables are dropped too (full rollback);
--   * otherwise the tables are KEPT (scratch history is never erased) and become inert: nothing writes them.
-- Entries already scratched stay scratched (the entry change audit keeps their history).
-- After a partial rollback, re-applying SC1 needs the kept tables handled first (its preflight refuses).

begin;

do $$
begin
  if to_regclass('public.event_competition_scratches') is null then
    raise exception 'SC1 rollback: SC1 is not applied.';
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

drop trigger sc1_guard_api_scratch_entries on public.event_competition_entries;
drop trigger sc1_guard_api_scratch_heat_entries on public.event_competition_heat_entries;
drop function public._sc1_guard_api_scratch_writes();
-- Pre-SC1 ACL was {=X, anon=X, authenticated=X, service_role=X} (no explicit grant/revoke before SC1).
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to public, anon, authenticated;

drop function public.set_competition_scratch_policy_default(uuid, text, text);
drop function public.set_competition_scratch_policy(uuid, text, text);
drop function public.scratch_competition_entry(uuid, uuid, text, text);
drop function public.competition_scratch_effective_policy(uuid);
drop function public._sc1_policy_for(uuid);
drop function public._sc1_actor_owns_policy(uuid);

do $$
begin
  if not exists (select 1 from public.event_competition_scratches)
     and not exists (select 1 from public.competition_scratch_policy_changes) then
    drop table public.event_competition_scratches;
    drop function public._sc1_protect_scratches();
    drop table public.competition_scratch_policy_changes;
    drop table public.event_competition_scratch_policies;
    drop table public.competition_scratch_policy_defaults;
    raise notice 'SC1 rollback: full (no SC1 data existed).';
  else
    raise notice 'SC1 rollback: guard and RPCs restored; SC1 audit tables kept (scratch or policy history exists).';
  end if;
end $$;

do $$
begin
  if (select md5(replace(prosrc, E'\r\n', E'\n')) from pg_proc
      where oid = 'public.protect_locked_competition_heat_children()'::regprocedure) <> '7997313d6effc4af94caf5fe4fd055c9' then
    raise exception 'SC1 rollback: restored guard body does not match the reviewed 10A body.';
  end if;
end $$;

commit;

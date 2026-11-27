-- Rollback of 20270301131000_competition_r15_eligibility_write_guard.sql. Drops the guard and grants TRIGGER back to exactly the client roles that held it
-- when the guard was applied (recorded in the guard function's comment). It refuses to guess when that record is missing. Run the rollbacks in reverse
-- of the order the migrations were ACTUALLY applied. If this guard recorded grantees and the S6 entry guard is installed, S6 was applied later and must be
-- rolled back first (re-granting underneath it would reopen what it closed); this file refuses. No data change.
begin;

do $$
declare
  v_note text;
  v_role text;
begin
  if to_regprocedure('public.r15_guard_entry_eligibility_write()') is null then
    raise notice 'R15 write guard rollback: the guard is not installed; nothing to restore.';
    return;
  end if;
  v_note := obj_description(to_regprocedure('public.r15_guard_entry_eligibility_write()'), 'pg_proc');
  if v_note is null or position('R15-PRIOR-TRIGGER-GRANTEES:' in v_note) <> 1 then
    raise exception 'R15 write guard rollback refused: the prior TRIGGER grantees were not recorded. Nothing was changed.';
  end if;
  if length(v_note) > length('R15-PRIOR-TRIGGER-GRANTEES:')
     and exists (select 1 from pg_trigger t where t.tgrelid = 'public.event_competition_entries'::regclass and not t.tgisinternal and t.tgname like 'cf1\_s6\_%') then
    raise exception 'R15 write guard rollback refused: the S6 entry guard was applied after this guard; roll back S6 first. Nothing was changed.';
  end if;
  foreach v_role in array string_to_array(substr(v_note, length('R15-PRIOR-TRIGGER-GRANTEES:') + 1), ',') loop
    if v_role in ('anon', 'authenticated') then
      execute format('grant trigger on public.event_competition_entries to %I', v_role);
    end if;
  end loop;
end $$;

drop trigger if exists r15_guard_entry_eligibility_write on public.event_competition_entries;
drop function if exists public.r15_guard_entry_eligibility_write();

commit;

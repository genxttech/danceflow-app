-- Rollback of 20270301141000: remove the entry guards, restore service_role EXECUTE on the two internal R2 functions, and restore exactly the TRIGGER grantees recorded when the guard was
-- installed (stored as the guard function's comment). If the S4/R15 eligibility write guard is installed now, it owns the revoke from anon and authenticated, so they are not re-granted.
-- Refused if the guard function is not the one 20270301141000 installed. No data to repair. Roll back in this order: 20270301141000 first, then 20270301140000.
begin;
set local lock_timeout = '5s';

do $$
declare v_oid oid := to_regprocedure('public.cf1_s6_guard_entry_status()'); v_note text; v_role text;
begin
  if v_oid is null or (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) is distinct from 'e7ec5a02c94815954d4706a77731eb21' then
    raise exception 'S6 guard rollback refused: the guard is not installed or is not the 20270301141000 version.';
  end if;
  v_note := obj_description(v_oid, 'pg_proc');
  if v_note is null or v_note not like 'S6 prior trigger grantees: %' then
    raise exception 'S6 guard rollback refused: the recorded prior privileges are missing; reconcile by hand.';
  end if;
  drop trigger if exists cf1_s6_guard_entry_delete on public.event_competition_entries;
  drop trigger if exists cf1_s6_guard_entry_links on public.event_competition_entries;
  drop trigger if exists cf1_s6_guard_entry_status on public.event_competition_entries;
  drop function public.cf1_s6_guard_entry_status();
  drop trigger if exists cf1_s6_guard_participation on public.event_competition_heat_entries;
  drop trigger if exists cf1_s6_guard_started_heat_delete on public.event_competition_heats;
  drop function if exists public.cf1_s6_guard_started_participation();
  foreach v_role in array string_to_array(substr(v_note, length('S6 prior trigger grantees: ') + 1), ',') loop
    if v_role not in ('anon', 'authenticated', 'service_role') then
      raise exception 'S6 guard rollback refused: unexpected recorded grantee %.', v_role;
    end if;
    if v_role <> 'service_role' and exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname = 'r15_guard_entry_eligibility_write') then
      continue;
    end if;
    execute format('grant trigger on public.event_competition_entries to %I', v_role);
  end loop;
end $$;

grant execute on function public._r2_withdraw_entry(uuid, text, text) to service_role;
grant execute on function public._r2_apply_participation(uuid) to service_role;
commit;

-- Competition S4 / R-15 -- eligibility write guard (slot 20270301131000). Requires 20270301110000 (core) and runs after S5 (120000) and the gates (130000). Apply ONLY after the app writes eligibility through
-- set_competition_entry_eligibility; before that, every eligibility save from the old app is refused.
--
-- Problem: event_competition_entries is writable by any event manager through the table API (policy competition_manage, FOR ALL). A manager can set
-- eligibility_status to eligible/waived (or INSERT an entry already eligible) with no recorded basis, and edit or remove the OD-03/OD-18 determination kept
-- in entries.metadata with no audit row at all (metadata is not an audited column).
--
-- Fix: an AFTER INSERT OR UPDATE row trigger (AFTER, not column-listed, so it sees the final row even when another trigger changed it) refuses, for any
-- session role other than the owner roles, (a) a change of eligibility_status, (b) a change of metadata -> eligibility_determination, (c) an INSERT with
-- eligibility_status other than 'unverified'. SECURITY DEFINER writers (start_competition_registration, the registration sync trigger, the RPC
-- set_competition_entry_eligibility) run as their owner and are unaffected, exactly as in the U18/U18-S guards. TRIGGER privilege is revoked from the client
-- roles so a client cannot add a competing trigger. No data change.
--
-- Rollback: rollback/20270301131000_competition_r15_eligibility_write_guard_rollback.sql.

begin;

do $$
begin
  if to_regprocedure('public.set_competition_entry_eligibility(uuid,text,text,text[],uuid)') is null then
    raise exception 'R15 write guard preflight: 20270301110000 (core) is not applied.';
  end if;
end $$;

create function public.r15_guard_entry_eligibility_write()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.eligibility_status is distinct from 'unverified' then
      raise exception 'COMP_R15_ELIGIBILITY_WRITE_REFUSED: new entries start unverified; eligibility is decided through set_competition_entry_eligibility.' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.eligibility_status is distinct from old.eligibility_status
     or (new.metadata -> 'eligibility_determination') is distinct from (old.metadata -> 'eligibility_determination') then
    raise exception 'COMP_R15_ELIGIBILITY_WRITE_REFUSED: eligibility is decided through set_competition_entry_eligibility, not by a direct write.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.r15_guard_entry_eligibility_write() from public, anon, authenticated, service_role;

create trigger r15_guard_entry_eligibility_write
  after insert or update on public.event_competition_entries
  for each row execute function public.r15_guard_entry_eligibility_write();

alter table public.event_competition_entries enable always trigger r15_guard_entry_eligibility_write;
revoke trigger on public.event_competition_entries from anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'r15_guard_entry_eligibility_write' and tgrelid = 'public.event_competition_entries'::regclass and tgenabled <> 'D')
     or has_table_privilege('authenticated', 'public.event_competition_entries', 'TRIGGER') then
    raise exception 'R15 write guard postflight failed.';
  end if;
end $$;

commit;

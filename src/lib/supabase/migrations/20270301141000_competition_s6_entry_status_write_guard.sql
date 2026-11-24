-- Competition S6 (2 of 2) -- direct client writes of event_competition_entries.status are refused (slot 20270301141000). NOT APPLIED; apply only with owner approval of this file hash,
-- AFTER 20270301140000 (the lifecycle RPC must already be SECURITY DEFINER, otherwise the one manager-facing scratch/withdraw RPC would be refused too).
--
-- Problem (OD-31 findings F1/F2, owner decision 2026-11-24 option B): event_competition_entries is writable by any event manager through the table API
-- (policy competition_manage, FOR ALL, plus the default table grants). A manager, or any holder of the service key, can set status to ANY value the CHECK allows
-- (pending, confirmed, waitlisted, scratched, withdrawn, disqualified, complete), or move an entry out of any of them. Only the audit trigger runs (audit row, optional reason);
-- nothing is refused, the heat entries are not touched, and downstream readers change behaviour: R2 treats disqualified/complete/withdrawn/scratched as terminal and skips the
-- refund cascade, the registration sync skips such entries, the A5/A6/advancement checks treat any non-confirmed entry as unavailable, and the participant-facing label
-- changes (e.g. "Not eligible" for disqualified). The U18 / U18-S guards cover the HEAT-entry table only.
--
-- Fix (general, fail-closed): an AFTER INSERT OR UPDATE row trigger that, for any session role other than the owner roles (postgres, supabase_admin: an allowlist, the same
-- convention as U18 and S4/R15), refuses
--   * a change of status on UPDATE (every value, every direction), and
--   * an INSERT with any status other than 'pending'.
-- SECURITY DEFINER workflows run as their owner and are unaffected: start_/finalize_/release_competition_registration, the registration sync trigger, the R2 withdrawal cascade,
-- and (after 20270301140000) change_competition_entry_lifecycle. Authorization does NOT depend on any client-settable marker (no GUC, no session flag); the only way through is
-- running as the function owner, which no client role can do. The guard is AFTER (sees the final row even if another trigger rewrites it), ENABLE ALWAYS (fires under
-- session_replication_role = replica) and TRIGGER privilege is revoked from the client roles so a client cannot add a competing trigger (finding F2). No data changes.
-- Existing triggers on the table keep working and fire independently (audit_competition_entry_change, set_event_competition_updated_at, validate_competition_entry_registration_links;
-- S4's r15_guard_entry_eligibility_write watches other columns). A refused statement rolls back, including any audit row an earlier trigger wrote in it.
--
-- Rollback: rollback/20270301141000_competition_s6_entry_status_write_guard_rollback.sql.

begin;

do $$
begin
  if to_regclass('public.event_competition_entries') is null then
    raise exception 'S6 guard preflight failed: event_competition_entries is missing.';
  end if;
  if not coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.change_competition_entry_lifecycle(uuid, text, text, text)')), false) then
    raise exception 'S6 guard preflight failed: 20270301140000 (lifecycle RPC as SECURITY DEFINER) is not applied.';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname = 'cf1_s6_guard_entry_status') then
    raise exception 'S6 guard preflight failed: the guard already exists.';
  end if;
  -- every SECURITY DEFINER function that writes the table must be owned by an exempt role, otherwise it would be refused
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
               and p.prosrc ~* '(update|insert\s+into)\s+(public\.)?event_competition_entries\y'
               and pg_get_userbyid(p.proowner) not in ('postgres', 'supabase_admin')) then
    raise exception 'S6 guard preflight failed: a SECURITY DEFINER writer of event_competition_entries is owned by a non-exempt role.';
  end if;
end $$;

create function public.cf1_s6_guard_entry_status()
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
    if new.status is distinct from 'pending' then
      raise exception 'COMP_S6_ENTRY_STATUS_WRITER: an entry cannot be created as % by a direct table write; entries start pending.', new.status
        using errcode = '42501';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status then
    raise exception 'COMP_S6_ENTRY_STATUS_WRITER: entry status % -> % cannot be changed by a direct table write; use the registration, refund or scratch/withdraw workflow.', old.status, new.status
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_s6_guard_entry_status() from public, anon, authenticated, service_role;

create trigger cf1_s6_guard_entry_status
  after insert or update on public.event_competition_entries
  for each row execute function public.cf1_s6_guard_entry_status();
alter table public.event_competition_entries enable always trigger cf1_s6_guard_entry_status;

revoke trigger on public.event_competition_entries from anon, authenticated, service_role;

do $$
begin
  if (select tgenabled from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname = 'cf1_s6_guard_entry_status') is distinct from 'A'
     or not (select (tgtype & 2) = 0 and (tgtype & 1) = 1 from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname = 'cf1_s6_guard_entry_status')
     or (select prosecdef from pg_proc where oid = 'public.cf1_s6_guard_entry_status()'::regprocedure)
     or has_function_privilege('authenticated', 'public.cf1_s6_guard_entry_status()', 'execute')
     or has_table_privilege('authenticated', 'public.event_competition_entries', 'trigger')
     or has_table_privilege('anon', 'public.event_competition_entries', 'trigger')
     or has_table_privilege('service_role', 'public.event_competition_entries', 'trigger') then
    raise exception 'S6 guard postflight failed.';
  end if;
end $$;

commit;

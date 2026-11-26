-- Competition S6 (2 of 2) -- direct client writes that change a competition entry's status (or lead to a change) are refused (slot 20270301141000). NOT APPLIED; apply only with owner approval of
-- this file hash, AFTER 20270301140000 (the lifecycle RPC must already be the SECURITY DEFINER version).
--
-- Problem (OD-31 findings F1/F2, owner decision 2026-11-24 option B): event_competition_entries is writable by any event manager through the table API (policy competition_manage, FOR ALL,
-- plus the default table grants). A manager, or any holder of the service key, can set status to ANY value the CHECK allows (pending, confirmed, waitlisted, scratched, withdrawn,
-- disqualified, complete) or move an entry out of any of them. Only the audit trigger runs (audit row, optional reason); nothing is refused, heat entries are not touched, and R2 refunds,
-- the registration sync, the A5/A6/advancement checks and the participant-facing label all change behaviour. The same effect is reachable indirectly: (a) re-pointing an entry at a
-- registration the caller controls makes the owner-run registration sync confirm or withdraw it; (b) deleting a disqualified / complete / withdrawn / scratched entry and re-creating it as
-- pending erases the state; (c) service_role could call the internal R2 withdrawal definers directly. The U18 / U18-S guards cover the HEAT-entry table only.
--
-- Fix, fail-closed, for any session role other than the owner roles (postgres, supabase_admin: an allowlist, the same convention as U18 and S4/R15):
--   * AFTER INSERT OR UPDATE: any change of status is refused; an INSERT must be 'pending';
--   * BEFORE INSERT: no registration / order / cart link and no scratch, withdrawal or confirmation evidence;
--   * BEFORE UPDATE: id, event_id, registration_id, order_id, order_item_id, registration_cart_id and the lifecycle evidence (scratched_at, scratch_reason, withdrawn_at, withdrawal_reason,
--     confirmed_at) cannot be changed; lifecycle_version only together with the late-entry flag (mark_competition_entry_late, an invoker function);
--   * BEFORE DELETE: refused unless the entry is pending or confirmed, has no registration / order / cart link, was never confirmed through the product (confirmed_at is null), has no
--     history containing a scratched / withdrawn / disqualified / complete status, and has no heat entry other than 'scheduled'. (Unused pending entries and unlinked, never-confirmed entries
--     can still be deleted: existing behaviour that the 10A and callback-final suites rely on.)
--   * EXECUTE on _r2_withdraw_entry and _r2_apply_participation is revoked from service_role (their only callers are owner-run definers).
-- The link and delete rules are BEFORE triggers on purpose: a foreign-key referential action (ON DELETE SET NULL of registration_id / order_id, cascade deletes) runs as the table owner at
-- BEFORE time, while a queued AFTER trigger would see the client role again.
-- SECURITY DEFINER workflows run as their owner and are unaffected (start_/finalize_/release_competition_registration, the registration sync trigger, the R2 cascade, the 20270301140000
-- lifecycle RPC). No authorization depends on any client-settable marker. The guards are ENABLE ALWAYS and the TRIGGER privilege is revoked from the client roles (finding F2).
-- No data changes.
--
-- Not closed here (owner decisions, see docs/competition/s6-entry-status-guard): a client changing an event_registrations row that is legitimately linked to an entry still drives the sync
-- (confirm / withdraw); parent cascades (deleting a division, program or event) still delete entries; TRUNCATE is still granted.
-- Rollback: rollback/20270301141000_competition_s6_entry_status_write_guard_rollback.sql.

begin;
set local lock_timeout = '5s';

do $$
declare v_oid oid := to_regprocedure('public.change_competition_entry_lifecycle(uuid, text, text, text)');
begin
  if to_regclass('public.event_competition_entries') is null then
    raise exception 'S6 guard preflight failed: event_competition_entries is missing.';
  end if;
  if v_oid is null or not (select prosecdef from pg_proc where oid = v_oid)
     or (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) is distinct from '25fdb16ba0e23069254c249c3a738aac' then
    raise exception 'S6 guard preflight failed: the 20270301140000 lifecycle definition is not the current one.';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname like 'cf1\_s6\_%') then
    raise exception 'S6 guard preflight failed: the guard already exists.';
  end if;
  if to_regprocedure('public._r2_withdraw_entry(uuid, text, text)') is null or to_regprocedure('public._r2_apply_participation(uuid)') is null then
    raise exception 'S6 guard preflight failed: the R2 functions are missing.';
  end if;
  -- the rules rely on the audit trigger writing history that clients cannot rewrite
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname = 'audit_competition_entry_change' and tgenabled <> 'D')
     or has_table_privilege('authenticated', 'public.event_competition_entry_changes', 'update') and exists (select 1 from pg_policy where polrelid = 'public.event_competition_entry_changes'::regclass and polcmd in ('*', 'w', 'd'))
     or (select pg_get_userbyid(relowner) from pg_class where oid = 'public.event_competition_entries'::regclass) not in ('postgres', 'supabase_admin') then
    raise exception 'S6 guard preflight failed: the entry audit trigger, the append-only history or the table owner is not as expected.';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'public.event_competition_entry_changes'::regclass and tgname in ('protect_competition_entry_change_history', 'protect_competition_entry_change_history_truncate') and tgenabled <> 'D') <> 2 then
    raise exception 'S6 guard preflight failed: the append-only history triggers are missing or disabled.';
  end if;
  -- S6 relies on these: U18 / U18-S protect danced, disqualified and scratched placements, and the O1 guard keeps a heat's status from being moved back by a client
  if (select count(*) from pg_trigger where tgenabled <> 'D' and ((tgrelid = 'public.event_competition_heat_entries'::regclass and tgname in ('cf1_u18_guard_heat_entry_status', 'cf1_u18s_guard_heat_entry_scratch'))
        or (tgrelid = 'public.event_competition_heats'::regclass and tgname = 'compo1_guard_heat_status'))) <> 3 then
    raise exception 'S6 guard preflight failed: the U18, U18-S or heat status guard is missing or disabled.';
  end if;
  -- the privileges this migration revokes are recorded for the rollback; refuse a state it was not written for
  if not has_function_privilege('service_role', 'public._r2_withdraw_entry(uuid, text, text)', 'execute')
     or not has_function_privilege('service_role', 'public._r2_apply_participation(uuid)', 'execute')
     or not has_table_privilege('service_role', 'public.event_competition_entries', 'trigger')
     or (not exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname = 'r15_guard_entry_eligibility_write')
         and not (has_table_privilege('anon', 'public.event_competition_entries', 'trigger') and has_table_privilege('authenticated', 'public.event_competition_entries', 'trigger'))) then
    raise exception 'S6 guard preflight failed: the current privileges differ from the recorded prior state; reconcile before applying.';
  end if;
  -- every SECURITY DEFINER function that writes the table must be owned by an exempt role, otherwise it would be refused
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
               and p.prosrc ~* '(update|insert\s+into|delete\s+from)\s+(public\.)?event_competition_entries\y'
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
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status not in ('pending', 'confirmed')
       or old.confirmed_at is not null
       or old.registration_id is not null or old.order_id is not null or old.order_item_id is not null or old.registration_cart_id is not null
       or exists (select 1 from public.event_competition_heat_entries he where he.entry_id = old.id and he.status <> 'scheduled')
       or exists (select 1 from public.event_competition_heat_entries he join public.event_competition_heats h on h.id = he.heat_id
                  where he.entry_id = old.id and h.status in ('active', 'complete'))
       or exists (select 1 from public.event_competition_entry_changes c
                  where c.entry_id = old.id
                    and (c.previous_state ->> 'status' in ('scratched', 'withdrawn', 'disqualified', 'complete')
                         or c.resulting_state ->> 'status' in ('scratched', 'withdrawn', 'disqualified', 'complete'))) then
      raise exception 'COMP_S6_ENTRY_DELETE_WRITER: this entry has a protected status, history or payment link and cannot be deleted by a direct table write.' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_when = 'BEFORE' and tg_op = 'INSERT' then
    if new.registration_id is not null or new.order_id is not null or new.order_item_id is not null or new.registration_cart_id is not null then
      raise exception 'COMP_S6_ENTRY_LINK_WRITER: an entry cannot be linked to a registration or order by a direct table write.' using errcode = '42501';
    end if;
    if new.scratched_at is not null or new.scratch_reason is not null or new.withdrawn_at is not null or new.withdrawal_reason is not null or new.confirmed_at is not null
       or new.lifecycle_version is distinct from 1 then
      raise exception 'COMP_S6_ENTRY_EVIDENCE_WRITER: scratch, withdrawal and confirmation evidence cannot be written by a direct table write.' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_when = 'BEFORE' then
    if new.scratched_at is distinct from old.scratched_at or new.scratch_reason is distinct from old.scratch_reason or new.withdrawn_at is distinct from old.withdrawn_at
       or new.withdrawal_reason is distinct from old.withdrawal_reason or new.confirmed_at is distinct from old.confirmed_at
       or (new.lifecycle_version is distinct from old.lifecycle_version
           and not coalesce(new.late_entry and not old.late_entry and new.lifecycle_version = old.lifecycle_version + 1, false)) then
      raise exception 'COMP_S6_ENTRY_EVIDENCE_WRITER: scratch, withdrawal and confirmation evidence cannot be changed by a direct table write.' using errcode = '42501';
    end if;
    if new.id is distinct from old.id or new.event_id is distinct from old.event_id
       or new.registration_id is distinct from old.registration_id or new.order_id is distinct from old.order_id
       or new.order_item_id is distinct from old.order_item_id or new.registration_cart_id is distinct from old.registration_cart_id then
      raise exception 'COMP_S6_ENTRY_LINK_WRITER: an entry''s identity, event, registration and order links cannot be changed by a direct table write.' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending' then
      raise exception 'COMP_S6_ENTRY_STATUS_WRITER: an entry cannot be created as % by a direct table write; entries start pending.', new.status using errcode = '42501';
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

-- status rules AFTER (sees the final row whatever other triggers did)
create trigger cf1_s6_guard_entry_status
  after insert or update on public.event_competition_entries
  for each row execute function public.cf1_s6_guard_entry_status();
alter table public.event_competition_entries enable always trigger cf1_s6_guard_entry_status;
-- identity / link / evidence rules and delete rules BEFORE (referential actions are visible as the owner here; the link rule fires before foreign-key checks)
create trigger cf1_s6_guard_entry_links
  before insert or update on public.event_competition_entries
  for each row execute function public.cf1_s6_guard_entry_status();
alter table public.event_competition_entries enable always trigger cf1_s6_guard_entry_links;
create trigger cf1_s6_guard_entry_delete
  before delete on public.event_competition_entries
  for each row execute function public.cf1_s6_guard_entry_status();
alter table public.event_competition_entries enable always trigger cf1_s6_guard_entry_delete;

-- participation in a started or completed heat cannot be detached or erased by a client (owner decision 2026-11-26, option A): the parent-entry rules alone would be bypassed by removing or
-- re-pointing the heat entry (or deleting the heat) first. Owner-run workflows and referential cascades are unaffected. A 'staging' heat is not covered.
create function public.cf1_s6_guard_started_participation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare v_status text;
begin
  if current_user in ('postgres', 'supabase_admin') then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_table_name = 'event_competition_heats' then
    if old.status in ('active', 'complete')
       or exists (select 1 from public.event_competition_heat_entries he where he.heat_id = old.id and he.status in ('danced', 'disqualified')) then
      raise exception 'COMP_S6_PARTICIPATION_WRITER: a started or completed heat, or one holding a danced or disqualified placement, cannot be deleted by a direct table write.' using errcode = '42501';
    end if;
    return old;
  end if;
  select h.status into v_status from public.event_competition_heats h where h.id = old.heat_id;
  if coalesce(v_status in ('active', 'complete'), false) or old.status in ('danced', 'disqualified') then
    if tg_op = 'DELETE' then
      raise exception 'COMP_S6_PARTICIPATION_WRITER: a placement in a started or completed heat cannot be removed by a direct table write.' using errcode = '42501';
    end if;
    if new.id is distinct from old.id or new.heat_id is distinct from old.heat_id or new.entry_id is distinct from old.entry_id or new.event_id is distinct from old.event_id
       or (new.status = 'scratched' and old.status is distinct from 'scratched') then
      raise exception 'COMP_S6_PARTICIPATION_WRITER: a placement in a started or completed heat cannot be moved or scratched by a direct table write.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_s6_guard_started_participation() from public, anon, authenticated, service_role;
create trigger cf1_s6_guard_participation
  before update or delete on public.event_competition_heat_entries
  for each row execute function public.cf1_s6_guard_started_participation();
alter table public.event_competition_heat_entries enable always trigger cf1_s6_guard_participation;
create trigger cf1_s6_guard_started_heat_delete
  before delete on public.event_competition_heats
  for each row execute function public.cf1_s6_guard_started_participation();
alter table public.event_competition_heats enable always trigger cf1_s6_guard_started_heat_delete;

-- record the TRIGGER privileges as they are now, so the rollback restores exactly these (service_role's TRIGGER and EXECUTE are required by the preflight)
do $$
begin
  execute format('comment on function public.cf1_s6_guard_entry_status() is %L',
    'S6 prior trigger grantees: ' || concat_ws(',', case when has_table_privilege('anon', 'public.event_competition_entries', 'trigger') then 'anon' end,
      case when has_table_privilege('authenticated', 'public.event_competition_entries', 'trigger') then 'authenticated' end, 'service_role'));
end $$;

revoke trigger on public.event_competition_entries from anon, authenticated, service_role;
revoke execute on function public._r2_withdraw_entry(uuid, text, text) from service_role;
revoke execute on function public._r2_apply_participation(uuid) from service_role;

do $$
begin
  if (select count(*) from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname in ('cf1_s6_guard_entry_status', 'cf1_s6_guard_entry_links', 'cf1_s6_guard_entry_delete') and tgenabled = 'A') <> 3
     or (select count(*) from pg_trigger where tgname in ('cf1_s6_guard_participation', 'cf1_s6_guard_started_heat_delete') and tgenabled = 'A') <> 2
     or has_function_privilege('authenticated', 'public.cf1_s6_guard_started_participation()', 'execute')
     or (select prosecdef from pg_proc where oid = 'public.cf1_s6_guard_entry_status()'::regprocedure)
     or has_function_privilege('authenticated', 'public.cf1_s6_guard_entry_status()', 'execute')
     or has_table_privilege('authenticated', 'public.event_competition_entries', 'trigger')
     or has_table_privilege('anon', 'public.event_competition_entries', 'trigger')
     or has_table_privilege('service_role', 'public.event_competition_entries', 'trigger')
     or has_function_privilege('service_role', 'public._r2_withdraw_entry(uuid, text, text)', 'execute')
     or has_function_privilege('service_role', 'public._r2_apply_participation(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._r2_withdraw_entry(uuid, text, text)', 'execute') then
    raise exception 'S6 guard postflight failed.';
  end if;
end $$;

commit;

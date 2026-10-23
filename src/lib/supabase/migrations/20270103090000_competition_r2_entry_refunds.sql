-- 20270103090000_competition_r2_entry_refunds.sql
--
-- COMMERCE INTEGRITY -- CI-D / Competition R2: competition entry refunds.
-- Design: docs/competition/r2-entry-refunds.md.
--
-- Section 1 (this file today): registration cascade gap.
--   sync_competition_entries_from_registration (10A canonical body, md5 fabd4052...) withdraws the entries of a
--   cancelled / failed / refunded registration but leaves their heat placements 'scheduled' / 'checked_in', so a
--   fully refunded or cancelled order could still appear on the running order. change_competition_entry_lifecycle
--   already scratches placements when it withdraws an entry; the trigger now does the same for exactly the entries
--   it withdraws in that statement. Entries placed in a locked or certified heat are still never touched (the
--   unchanged NOT EXISTS guard), so their placements are never rewritten either. Owner decision Q1 (2026-10-23):
--   an entry with any 'danced' placement is treated as locked and is never withdrawn automatically, even in a heat
--   that is not yet locked. Everything else in the body is byte-identical to 10A. (Recording the operational
--   exception for skipped entries is specified in the design, §4.1, and waits for implementation authorization.)
--
-- The refund ledger, reserve/finalize RPCs and webhook attribution (design §3.1-3.6) are NOT in this file yet:
-- they wait on owner decisions D1-D8.
--
-- Rollback: rollback/20270103090000_competition_r2_entry_refunds_rollback.sql (restores the exact 10A body;
-- placements scratched while this was live stay scratched).

begin;

do $$
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.sync_competition_entries_from_registration()'::regprocedure)
       is distinct from 'fabd4052257f261e300ccc1f191c4cdb' then
    raise exception 'R2 preflight: sync_competition_entries_from_registration is not the reviewed 10A definition.';
  end if;
end $$;

create or replace function public.sync_competition_entries_from_registration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'cancelled' or new.payment_status in ('failed', 'refunded') then
    perform set_config('app.competition_entry_change_type', 'withdraw', true);
    perform set_config(
      'app.competition_entry_change_reason',
      case when new.payment_status = 'refunded' then 'Source registration was refunded.' else 'Source registration was cancelled or payment failed.' end,
      true
    );
    perform set_config(
      'app.competition_entry_fee_handling',
      case when new.payment_status = 'refunded' then 'refund' else 'retain' end,
      true
    );
    -- R2: scratch the open placements of exactly the entries withdrawn here (none of them is in a locked or
    -- certified heat), as change_competition_entry_lifecycle does.
    with withdrawn as (
      update public.event_competition_entries
      set
        status = 'withdrawn',
        withdrawn_at = coalesce(withdrawn_at, now()),
        withdrawal_reason = coalesce(
          withdrawal_reason,
          case when new.payment_status = 'refunded' then 'Source registration was refunded.' else 'Source registration was cancelled or payment failed.' end
        ),
        lifecycle_version = lifecycle_version + 1,
        updated_at = now()
      where registration_id = new.id
        and status not in ('withdrawn', 'disqualified', 'complete')
        and not exists (
          select 1
          from public.event_competition_heat_entries he
          join public.event_competition_heats h on h.id = he.heat_id
          where he.entry_id = event_competition_entries.id and h.lock_state in ('locked', 'certified')
        )
        -- R2 / owner Q1: once the entry has danced, it is never withdrawn automatically, even if the heat is not locked.
        and not exists (
          select 1 from public.event_competition_heat_entries he
          where he.entry_id = event_competition_entries.id and he.status = 'danced'
        )
      returning id
    )
    update public.event_competition_heat_entries he
    set status = 'scratched', updated_at = now()
    from withdrawn w
    where he.entry_id = w.id and he.status in ('scheduled', 'checked_in');
    return new;
  end if;

  if new.status in ('confirmed', 'registered', 'checked_in', 'attended')
    and coalesce(new.payment_status, '') in ('paid', 'partial', 'comped', 'free', 'waived') then
    update public.event_competition_entries
    set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now()), updated_at = now()
    where registration_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;

revoke all on function public.sync_competition_entries_from_registration() from public;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'sync_competition_entries_from_registration'
                 and tgrelid = 'public.event_registrations'::regclass and not tgisinternal) then
    raise exception 'R2 postflight: the registration -> competition entry trigger is missing.';
  end if;
end $$;

commit;

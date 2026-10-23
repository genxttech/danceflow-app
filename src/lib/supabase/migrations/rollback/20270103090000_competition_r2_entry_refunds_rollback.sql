-- rollback/20270103090000_competition_r2_entry_refunds_rollback.sql
--
-- Reverts 20270103090000_competition_r2_entry_refunds.sql (Section 1: registration cascade gap).
-- Restores the exact 10A canonical body of sync_competition_entries_from_registration (md5 fabd4052...),
-- copied verbatim from 20261107090000_phase10a_competition_foundation_reconcile.sql.
--
-- Refuses, changing nothing, unless the live body is the R2 body (md5 5fb50278...): it never overwrites a
-- later redefinition. Data is not reverted: heat placements scratched by the R2 trigger stay scratched (they
-- belong to withdrawn entries, which the 10A body would also have left withdrawn).

begin;

do $$
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.sync_competition_entries_from_registration()'::regprocedure)
       is distinct from '5fb5027897911eb2482efe03ec5cee19' then
    raise exception 'R2 rollback preflight: sync_competition_entries_from_registration is not the R2 definition.';
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
      );
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
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.sync_competition_entries_from_registration()'::regprocedure)
       is distinct from 'fabd4052257f261e300ccc1f191c4cdb' then
    raise exception 'R2 rollback postflight: the restored body is not the 10A definition.';
  end if;
end $$;

commit;

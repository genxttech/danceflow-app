-- 20261231110000_twilio_pilot_burned_ceiling.sql
-- TW-4F KI-1 ceiling protection (dark; Git-only until separately authorized). The cumulative pilot ceiling must not be replenished by a pilot reservation that
-- is RELEASED after the provider may already have billed its month.
--
-- The gap: a pilot reservation made in one business month and released in a LATER one (KI-1 release 20261228, or a slow rejection) stopped counting toward the
-- ceiling, which counts only 'reserved' and 'captured' rows. Twilio may already have charged that month, so the next month's written approval could add a second
-- real fee on top of an unchanged ledger figure: duplicate billing beyond the cumulative ceiling.
--
-- The protection (smallest enforceable): a pilot reservation that was CLOSED RELEASED in a later business month than the one it was made in (the _tw4ml_month_key
-- rule of 20261219/20261228) stays "burned" and keeps counting toward the ceiling permanently. A BEFORE INSERT trigger on studio_sms_credit_reservations refuses ANY
-- new pilot-funded reservation whose amount plus the business's reserved + captured + burned amounts would exceed the pilot exception's ceiling (SQLSTATE TW007,
-- the same code as the existing ceiling refusal). It covers every insert path (campaign, number, monthly cover) without replacing any existing function body.
-- Deliberately conservative: a rejection that lands in a later month also counts as burned, because the provider's billing month is not known (#290 P2-2). A release
-- in the SAME business month (the provider cannot have billed it yet) is not burned. Credit-funded reservations are untouched. No data is changed.
-- Requires 20261122 (reservations, pilot exceptions) and 20261128 (_tw4ml_month_key). Rollback: rollback/20261231110000_twilio_pilot_burned_ceiling_rollback.sql.
-- NOT APPLIED to any shared environment by this file's authoring.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.studio_sms_credit_reservations') is null or to_regclass('public.studio_sms_pilot_exceptions') is null
     or to_regprocedure('public._tw4ml_month_key(uuid,timestamptz)') is null then
    raise exception 'pilot burned ceiling precondition failed: 20261122 .. 20261228 are not all applied';
  end if;
  if to_regprocedure('public._tw4pbc_burned(uuid)') is not null then
    raise exception 'pilot burned ceiling precondition failed: already applied';
  end if;
end $$;

-- everything the pilot ceiling must keep counting: held, captured, and released-after-the-month-closed
create function public._tw4pbc_burned(p_entity uuid)
returns bigint language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(sum(r.amount_cents), 0)::bigint
    from public.studio_sms_credit_reservations r
   where r.legal_entity_id = p_entity and r.funding = 'pilot'
     and (r.status in ('reserved', 'captured')
          or (r.status = 'released' and r.closed_at is not null
              and public._tw4ml_month_key(r.legal_entity_id, r.created_at) <> public._tw4ml_month_key(r.legal_entity_id, r.closed_at)));
$$;

create function public._tw4pbc_reservation_guard()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ceiling int;
begin
  if new.funding is distinct from 'pilot' then
    return new;
  end if;
  -- serialize concurrent pilot reservations of one business until commit (a dedicated advisory lock: no table-lock order is introduced)
  perform pg_advisory_xact_lock(hashtextextended('tw4pbc:' || new.legal_entity_id::text, 0));
  select pe.ceiling_cents into v_ceiling from public.studio_sms_pilot_exceptions pe where pe.legal_entity_id = new.legal_entity_id;
  if v_ceiling is null then
    return new;   -- no pilot exception: the existing funding checks refuse it
  end if;
  if public._tw4pbc_burned(new.legal_entity_id) + new.amount_cents > v_ceiling then
    raise exception 'the pilot ceiling would be exceeded (a pilot reservation released in a later month still counts: the provider may have billed it)' using errcode = 'TW007';
  end if;
  return new;
end $$;

create trigger studio_sms_credit_reservations_pilot_burned_ceiling
  before insert on public.studio_sms_credit_reservations
  for each row execute function public._tw4pbc_reservation_guard();

revoke all on function public._tw4pbc_burned(uuid) from public, anon, authenticated;
revoke all on function public._tw4pbc_reservation_guard() from public, anon, authenticated;

commit;

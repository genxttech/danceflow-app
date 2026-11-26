-- PROPOSAL, NOT APPLIED (owner decision P9, 2026-11-26). Not a migration: it lives under docs/ on purpose. Applying it anywhere hosted is a separate owner gate.
--
-- Problem: the "has this package a credit left?" check runs in the application BEFORE the appointment is marked attended. Several lessons on one package can all pass it
-- at once; the database then deducts only as many credits as exist, and the rest end up 'attended' with no deduction (a lesson delivered beyond what was bought, and an
-- instructor earning staged for it).
--
-- Fix: the same transaction that sets 'attended' takes the package lock first and refuses when no credit is left. A concurrent transaction waits on that lock and then
-- sees the committed balance. The existing AFTER trigger deducts inside the same transaction, so there is no state with one done and not the other.

begin;

create or replace function public.require_package_credit_for_private_lesson()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_item record;
begin
  if new.status::text <> 'attended' or old.status::text = 'attended' then
    return new;
  end if;
  if new.appointment_type::text not in ('private_lesson', 'intro_lesson', 'coaching') then
    return new;
  end if;
  if coalesce(new.billing_type::text, 'package_credit') <> 'package_credit' or new.client_package_id is null or new.client_id is null then
    return new;
  end if;
  -- already paid for (for example a missed-lesson charge recorded earlier): nothing to take
  if exists (
    select 1 from lesson_transactions lt
    where lt.appointment_id = new.id and lt.client_package_id = new.client_package_id
      and lt.transaction_type::text in ('lesson_deduction', 'appointment_attendance')
  ) then
    return new;
  end if;

  -- same lock order as every other package writer: package, then item
  perform 1 from client_packages where id = new.client_package_id and studio_id = new.studio_id for update;

  select cpi.quantity_remaining, cpi.is_unlimited
    into v_item
    from client_package_items cpi
    join client_packages cp on cp.id = cpi.client_package_id
    where cpi.client_package_id = new.client_package_id
      and cpi.usage_type = 'private_lesson'::package_usage_type
      and cp.studio_id = new.studio_id
      and cp.client_id = new.client_id
      and cp.active = true
    limit 1
    for update of cpi;

  if not found or (not coalesce(v_item.is_unlimited, false) and coalesce(v_item.quantity_remaining, 0) <= 0) then
    raise exception 'PKG_NO_CREDIT: The selected package has no remaining credits.';
  end if;

  return new;
end;
$$;

revoke all on function public.require_package_credit_for_private_lesson() from public, anon, authenticated, service_role;

create trigger appointments_require_package_credit
  before update of status on public.appointments
  for each row
  execute function public.require_package_credit_for_private_lesson();

commit;

-- Rollback (byte for byte what this adds, in reverse):
--   drop trigger if exists appointments_require_package_credit on public.appointments;
--   drop function if exists public.require_package_credit_for_private_lesson();

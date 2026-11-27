-- PROPOSAL, NOT APPLIED (owner decision P9, 2026-11-26). Not a migration: it lives under docs/ on purpose. Applying it anywhere hosted is a separate owner gate.
--
-- Problem: the "has this package a credit left?" check runs in the application BEFORE the appointment is marked attended. Several lessons on one package can all pass it
-- at once; the database then deducts only as many credits as exist and silently skips the rest, which end up 'attended' with no deduction (a lesson delivered beyond what
-- was bought, with an instructor earning staged for it). The same happens for a multi-row update, an insert as attended, and any error the deduction trigger swallows.
--
-- Fix: an invariant checked AFTER the existing deduction trigger, in the same statement and transaction: a package-billed private lesson that becomes attended must have
-- its deduction marker, otherwise the whole statement is rolled back. No new locks and no new lock order: the deduction trigger already takes package then item, so a
-- concurrent transaction waits there, sees the committed balance, deducts nothing, and is then refused here.
--
-- Ordering: row triggers fire in name order; this one must sort after appointments_deduct_package_credit_attended.

begin;

create or replace function public.require_package_deduction_for_private_lesson()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if new.status::text <> 'attended' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status::text = 'attended' then
    return null;
  end if;
  if new.appointment_type::text not in ('private_lesson', 'intro_lesson', 'coaching') then
    return null;
  end if;
  if coalesce(new.billing_type::text, 'package_credit') <> 'package_credit' or new.client_package_id is null or new.client_id is null then
    return null;
  end if;
  if not exists (
    select 1 from lesson_transactions lt
    where lt.appointment_id = new.id and lt.client_package_id = new.client_package_id
      and lt.transaction_type::text in ('lesson_deduction', 'appointment_attendance')
  ) then
    raise exception 'PKG_NO_CREDIT: no package credit could be taken for this lesson.';
  end if;
  return null;
end;
$$;

revoke all on function public.require_package_deduction_for_private_lesson() from public, anon, authenticated, service_role;

create trigger appointments_require_package_deduction
  after insert or update of status on public.appointments
  for each row
  execute function public.require_package_deduction_for_private_lesson();

commit;

-- Rollback:
--   drop trigger if exists appointments_require_package_deduction on public.appointments;
--   drop function if exists public.require_package_deduction_for_private_lesson();
--
-- Before this becomes a migration:
--   1. Deploy the application mapping of PKG_NO_CREDIT (in this pull request) first.
--   2. Importing historical attended lessons linked to an empty package would now fail those rows: decide the import behaviour.
--   3. Not covered: changing the package, billing type or appointment type of a lesson that is ALREADY attended.
--   4. A multi-lesson statement that runs short of credit fails as a whole (no partial result).

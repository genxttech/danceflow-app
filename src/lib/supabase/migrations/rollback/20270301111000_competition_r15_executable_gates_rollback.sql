-- Rollback of 20270301111000_competition_r15_executable_gates.sql. Restores the RB3 predicate P body and the OD-17 M2 placement guard. No data change.
-- Roll back 20270301112000 (write guard) independently; it does not depend on this file.
begin;

drop trigger if exists r15_guard_round_start on public.event_competition_rounds;
drop trigger if exists r15_guard_heat_status on public.event_competition_heats;
drop trigger if exists r15_guard_version_publish on public.event_competition_schedule_versions;
drop trigger if exists r15_guard_heat_entry_clearance on public.event_competition_heat_entries;
drop function if exists public.r15_guard_round_start();
drop function if exists public.r15_guard_heat_status();
drop function if exists public.r15_guard_version_publish();
drop function if exists public.r15_guard_heat_entry_clearance();
drop function if exists public.r15_raise_not_cleared(text, uuid[], jsonb);

-- Restore the RB3 body of predicate P (20270120102000).
create or replace function public._cf1_entry_unavailable_reason(p_entry_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when e.id is null then 'entry_missing'
    when e.status is distinct from 'confirmed' then 'entry_not_confirmed'
    when e.eligibility_status = 'ineligible' then 'entry_ineligible'
    when r.status = 'cancelled' then 'registration_cancelled'
    when r.status = 'refunded' then 'registration_refunded'
    when r.payment_status = 'failed' then 'registration_payment_failed'
    when r.payment_status = 'refunded' then 'registration_payment_refunded'
    when o.payment_status = 'failed' then 'order_payment_failed'
    when o.payment_status = 'refunded' then 'order_payment_refunded'
    else public._cf1_entry_refund_evidence_reason(e.id)
  end
  from (select 1) one
  left join public.event_competition_entries e on e.id = p_entry_id
  left join public.event_registrations r on r.id = e.registration_id
  left join public.event_orders o on o.id = e.order_id;
$$;
revoke all on function public._cf1_entry_unavailable_reason(uuid) from public, anon, authenticated, service_role;

do $$
declare
  v_def text;
  v_old constant text := 'public._r15_entry_availability_reason(new.entry_id)';
  v_new constant text := 'public._cf1_entry_unavailable_reason(new.entry_id)';
begin
  v_def := replace(pg_get_functiondef('public.cf1_od17_guard_heat_entry()'::regprocedure), E'\r', '');
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'R15 gates rollback refused: cf1_od17_guard_heat_entry does not contain exactly one %; nothing was changed.', v_old;
  end if;
  execute replace(v_def, v_old, v_new);
end $$;

commit;

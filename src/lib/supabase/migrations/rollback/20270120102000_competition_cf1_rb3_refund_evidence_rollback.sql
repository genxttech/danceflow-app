-- Rollback for 20270120102000_competition_cf1_rb3_refund_evidence.sql. Restores the A1 body of _cf1_entry_unavailable_reason exactly
-- (md5 of pg_proc.prosrc equals the A1 migration's) and drops everything RB3 added, including the override table (its rows are
-- owner-acceptance records: export them first if any exist). Run BEFORE every other CF1 rollback (it is the first).
begin;

do $$
begin
  if to_regclass('public.competition_cf1_rb3_gate_overrides') is not null
     and exists (select 1 from public.competition_cf1_rb3_gate_overrides) then
    raise notice 'CF1-RB3 rollback: dropping % gate override row(s); keep a copy if the acceptance must be retained.',
      (select count(*) from public.competition_cf1_rb3_gate_overrides);
  end if;
end $$;

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
    else null
  end
  from (select 1) one
  left join public.event_competition_entries e on e.id = p_entry_id
  left join public.event_registrations r on r.id = e.registration_id
  left join public.event_orders o on o.id = e.order_id;
$$;
revoke all on function public._cf1_entry_unavailable_reason(uuid) from public, anon, authenticated, service_role;

drop function public._cf1_od17_refund_gate();
drop function public._cf1_rb3_revoke_gate_override(uuid, text);
drop function public._cf1_rb3_record_gate_override(text, text, text);
drop table public.competition_cf1_rb3_gate_overrides;
drop function public._cf1_rb3_protect_gate_overrides();
drop function public._cf1_entry_refund_evidence_reason(uuid);
drop function public._cf1_refund_evidence_mode();

commit;

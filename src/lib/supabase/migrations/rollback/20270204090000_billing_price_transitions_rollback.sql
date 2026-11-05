-- Rollback for 20270204090000_billing_price_transitions.sql. Refuses while any record exists: rows are permanent evidence.
begin;

do $$
begin
  if exists (select 1 from public.price_transitions) or exists (select 1 from public.price_transition_notices) then
    raise exception 'refusing to drop price transition tables while rows exist';
  end if;
end $$;

drop function if exists public.complete_price_transition_reconciliation(uuid, jsonb);
drop table if exists public.price_transitions;
drop table if exists public.price_transition_notices;
drop function if exists public.price_transitions_guard();
drop function if exists public.price_transition_notices_guard();
drop function if exists public.price_transitions_no_truncate();

commit;

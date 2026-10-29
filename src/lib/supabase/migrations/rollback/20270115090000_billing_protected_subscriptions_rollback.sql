-- Rollback of 20270115090000_billing_protected_subscriptions.sql. REFUSES while any row exists (permanent evidence of protected terms).
begin;
set local lock_timeout = '5s';
lock table public.protected_subscriptions in access exclusive mode;
do $$
begin
  if exists (select 1 from public.protected_subscriptions) then
    raise exception 'protected-subscriptions rollback refused: rows exist; release them and keep the evidence, or export first';
  end if;
end $$;
drop trigger if exists protected_subscriptions_guard_trg on public.protected_subscriptions;
drop function if exists public.protected_subscriptions_guard();
drop table public.protected_subscriptions;
commit;

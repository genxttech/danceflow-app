-- rollback/20270103091000_competition_r2_refund_write_gate_rollback.sql
--
-- Reverts 20270103091000_competition_r2_refund_write_gate.sql: drops the two gate triggers and the gate function. Touches no data.
-- The gate is a MANDATORY dependency of R2 (request_competition_order_refund refuses unless it is intact): this rollback is REFUSED while R2 is active (the ledger tables and the
-- request RPC exist). Roll back R2 first (itself refused while ledger rows exist); only with R2 absent can the gate be removed.

begin;
set local lock_timeout = '10s';

do $$
begin
  if to_regprocedure('public._r2g_guard_event_payment_refund()') is null then
    raise exception 'R2 gate rollback: the gate is not installed.';
  end if;
  if to_regclass('public.event_order_refunds') is not null
     and to_regprocedure('public.request_competition_order_refund(uuid,uuid,uuid,jsonb,text)') is not null then
    raise exception 'R2 gate rollback refused: R2 is active (refund ledger and request RPC present); roll back R2 first. The gate is a mandatory dependency of R2.' using errcode = '55000';
  end if;
end $$;

drop trigger if exists r2g_guard_event_payment_refund_upd on public.event_payments;
drop trigger if exists r2g_guard_event_payment_refund_ins on public.event_payments;
drop function public._r2g_guard_event_payment_refund();

do $$
begin
  if to_regprocedure('public._r2g_guard_event_payment_refund()') is not null
     or exists (select 1 from pg_trigger where tgname like 'r2g\_guard\_event\_payment\_refund%' and not tgisinternal) then
    raise exception 'R2 gate rollback postflight: a gate object is left.';
  end if;
end $$;

commit;

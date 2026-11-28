-- Rollback of 20270219090000 (price request sweep). Roll the APP back first (the sweep route answers an error until the function exists again; nothing else calls it).
-- Requests already expired by the sweep stay 'expired' (a decided request is final); only the function is removed.
begin;
drop function if exists public.tw4_price_sweep_expired();
commit;

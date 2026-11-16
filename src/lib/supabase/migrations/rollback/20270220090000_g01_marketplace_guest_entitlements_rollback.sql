-- Rollback of 20270220090000_g01_marketplace_guest_entitlements.sql.
-- Refuses while any client-less (guest marketplace) entitlement exists: those buyers would lose their purchase if the
-- rows were deleted or invented a client for. Resolve them manually (owner decision D6) before rolling back.
-- ROLL BACK THE APP CHANGE FIRST (the old route creates the lead/link that the NOT NULL column requires).

begin;

do $$
begin
  if exists (select 1 from public.commerce_entitlements where client_id is null) then
    raise exception 'g01 rollback refused: client-less marketplace entitlements exist';
  end if;
end $$;

alter table public.commerce_entitlements alter column client_id set not null;
comment on column public.commerce_entitlements.client_id is null;

notify pgrst, 'reload schema';

commit;

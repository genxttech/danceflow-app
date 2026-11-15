-- G-01 -- a marketplace purchase entitlement belongs to the buyer's DanceFlow account, not to a studio CRM record.
--
-- Before: commerce_entitlements.client_id was NOT NULL, so the marketplace checkout route had to create a studio
-- "lead" client (plus a portal link with broad permissions) BEFORE payment settled, for every buyer.
-- After:  client_id is nullable. commerce_finalize_student_digital_order (unchanged) already copies the order's client_id
--         (NULL for a guest order) and the buyer's user_id; user_id stays NOT NULL, so an entitlement always has an owner
--         account. The route no longer creates clients or links (see the PR).
--
-- Nothing else changes: the RLS policies (student read by user_id, studio read by studio role) and the manual-sale
-- insert/update policies (which still require a real client of the studio) are untouched; the unique active
-- (user_id, catalog_item_id) index is unchanged. payments.client_id and commerce_orders.client_id are already nullable.
--
-- RELEASE ORDER: apply this migration BEFORE deploying the matching app change, otherwise settlement of a guest
-- marketplace order would fail at the entitlement insert after the card was charged.
-- Rollback: rollback/20270220090000_g01_marketplace_guest_entitlements_rollback.sql (refuses while any client-less
-- entitlement exists).

begin;

alter table public.commerce_entitlements alter column client_id drop not null;

comment on column public.commerce_entitlements.client_id is
  'Studio CRM client the entitlement is attached to, when one already existed. NULL for a guest marketplace purchase (G-01): the entitlement is owned by user_id.';

notify pgrst, 'reload schema';

commit;

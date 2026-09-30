-- PAY-DC-4A: SaaS billing identity write-lock.
--
-- The DanceFlow SaaS subscription of a studio is identified by
-- studios.stripe_customer_id / studios.stripe_subscription_id and by
-- studio_billing_customers.stripe_customer_id. Server code trusts these values
-- to act on the platform Stripe account: the add-on checkout/remove routes add
-- or remove subscription items (and grant entitlements) on
-- studios.stripe_subscription_id, the billing portal opens a session for the
-- mapped customer, and the webhook attributes SaaS invoices/subscriptions
-- through studio_billing_customers.
--
-- Before this migration ordinary tenant roles could write them directly:
--   * studio owners/admins could UPDATE both studios columns (the entitlement
--     guard only covers plan/status/override columns), and any authenticated
--     user could INSERT a studios row with arbitrary values;
--   * any active studio role could INSERT/UPDATE that studio's
--     studio_billing_customers row.
-- A studio could therefore point its own row at another studio's subscription
-- and have DanceFlow bill that studio for an add-on, or receive its paid
-- entitlements.
--
-- Fix (minimal; no data change, no backfill):
--   1. SECURITY INVOKER guard trigger deciding only on current_user (the DB role
--      PostgREST sets from the verified JWT), exactly like the entitlement and
--      PAY-DC-2D guards. For anon and authenticated:
--        INSERT with either column non-NULL           -> rejected;
--        UPDATE changing either column (incl. clear)  -> rejected.
--      service_role (webhook, billing checkout), postgres/supabase_admin (SQL,
--      migrations) and SECURITY DEFINER owner contexts pass.
--   2. Drop the tenant INSERT/UPDATE policies on studio_billing_customers (the
--      SELECT policy stays). RLS then denies tenant writes; the server writes
--      with the service role, which bypasses RLS.
--
-- The entitlement guard and the PAY-DC-2D guards are left unchanged.

begin;

create or replace function public._guard_studios_saas_billing_identity()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.stripe_customer_id is not null
         or new.stripe_subscription_id is not null then
        raise exception 'studios SaaS billing identity cannot be set by this role.'
          using errcode = '42501';
      end if;
    elsif new.stripe_customer_id is distinct from old.stripe_customer_id
       or new.stripe_subscription_id is distinct from old.stripe_subscription_id then
      raise exception 'studios SaaS billing identity cannot be changed by this role.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public._guard_studios_saas_billing_identity()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_studios_saas_billing_identity on public.studios;
create trigger guard_studios_saas_billing_identity
before insert or update of stripe_customer_id, stripe_subscription_id on public.studios
for each row
execute function public._guard_studios_saas_billing_identity();

drop policy if exists studio_billing_customers_staff_insert on public.studio_billing_customers;
drop policy if exists studio_billing_customers_staff_update on public.studio_billing_customers;

commit;

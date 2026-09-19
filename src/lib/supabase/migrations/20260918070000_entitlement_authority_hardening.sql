-- Landmark 1A Slice 8 -- Migration A: entitlement authority hardening.
--
-- The effective instructor seat limit (_landmark1a_resolve_studio_seat_limit)
-- is derived from:
--   studios: billing_plan, subscription_status, billing_override_enabled,
--            billing_override_expires_at
--   studio_subscriptions: status, subscription_plan_id (-> subscription_plans.code)
-- Before this migration ordinary tenant roles could rewrite those inputs:
--   * studio owners/admins could UPDATE any column of their studios row
--     (billing_plan, subscription_status, billing_override_*), and any
--     authenticated user could INSERT a studios row with arbitrary values;
--   * ANY active user of a studio (instructor, front desk, ...) could INSERT
--     or UPDATE that studio's studio_subscriptions row (plan id and status).
-- A seat-limit trigger is not authoritative while the same user can first
-- raise their own entitlement.
--
-- Fix (minimal, no billing redesign):
--   1. studios: BEFORE INSERT OR UPDATE OF <entitlement columns> guard. It is
--      SECURITY INVOKER and decides only on current_user (the DB role set from
--      the verified JWT), exactly like the platform-role guard: anon /
--      authenticated may not change the protected columns on UPDATE, and on
--      INSERT must leave them at their column defaults. service_role (Stripe
--      webhook, admin-client provisioning), postgres/supabase_admin (SQL,
--      migrations) and SECURITY DEFINER owner contexts (claim_platform_invite)
--      are unaffected. All other studios columns stay tenant-editable.
--      It never consults billing state to authorize a billing change.
--   2. studio_subscriptions: drop the tenant INSERT and UPDATE policies.
--      RLS then denies tenant writes by default; the SELECT policy is kept.
--      The Stripe webhook writes with the service role, which bypasses RLS.
--
-- The whole billing_override_* family is protected (not only the two columns
-- the resolver reads) so override evidence/integrity cannot be edited either.
-- Review rule: a tenant-callable SECURITY DEFINER function that writes these
-- columns would pass the guard and must be code-reviewed accordingly.

begin;

create or replace function public._guard_studios_entitlement_columns()
returns trigger
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      -- A tenant-created studio must start from the protected column
      -- defaults (see the studios column defaults).
      if new.billing_plan is distinct from 'starter'::public.billing_plan
         or new.subscription_status is distinct from 'trialing'
         or new.billing_override_enabled is distinct from false
         or new.billing_override_reason is not null
         or new.billing_override_expires_at is not null
         or new.billing_override_notes is not null
         or new.billing_override_created_at is not null
         or new.billing_override_created_by is not null then
        raise exception 'studios billing/entitlement fields cannot be set by this role.'
          using errcode = '42501';
      end if;
    elsif new.billing_plan is distinct from old.billing_plan
       or new.subscription_status is distinct from old.subscription_status
       or new.billing_override_enabled is distinct from old.billing_override_enabled
       or new.billing_override_reason is distinct from old.billing_override_reason
       or new.billing_override_expires_at is distinct from old.billing_override_expires_at
       or new.billing_override_notes is distinct from old.billing_override_notes
       or new.billing_override_created_at is distinct from old.billing_override_created_at
       or new.billing_override_created_by is distinct from old.billing_override_created_by then
      raise exception 'studios billing/entitlement fields cannot be changed by this role.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public._guard_studios_entitlement_columns()
  from public, anon, authenticated, service_role;

drop trigger if exists guard_studios_entitlement_columns on public.studios;

create trigger guard_studios_entitlement_columns
before insert or update of
  billing_plan, subscription_status,
  billing_override_enabled, billing_override_reason, billing_override_expires_at,
  billing_override_notes, billing_override_created_at, billing_override_created_by
on public.studios
for each row
execute function public._guard_studios_entitlement_columns();

drop policy if exists studio_subscriptions_staff_insert on public.studio_subscriptions;
drop policy if exists studio_subscriptions_staff_update on public.studio_subscriptions;

commit;

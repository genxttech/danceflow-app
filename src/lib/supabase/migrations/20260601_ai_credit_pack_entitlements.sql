-- AI Credit Packs V1 support
-- Adds a unique index so Stripe subscription items can safely upsert monthly AI credit entitlements.

create unique index if not exists usage_addon_entitlements_stripe_subscription_item_unique
  on public.usage_addon_entitlements (stripe_subscription_item_id)
  where stripe_subscription_item_id is not null;

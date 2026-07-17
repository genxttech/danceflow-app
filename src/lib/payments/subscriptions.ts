import { getStripe } from "./stripe";

type EnsureRecurringPriceParams = {
  supabase: any;
  membershipPlanId: string;
  planName: string;
  price: number;
  billingInterval: string;
  stripeProductId?: string | null;
  stripePriceId?: string | null;
};

type CreateMembershipSubscriptionParams = {
  stripeCustomerId: string;
  stripePriceId: string;
  defaultPaymentMethodId: string;
  localMembershipId: string;
  studioId: string;
  clientId: string;
  membershipPlanId: string;
  startsOn: string;
};

type EnsureConnectedRecurringPriceParams = Omit<
  EnsureRecurringPriceParams,
  "stripeProductId" | "stripePriceId"
> & {
  studioId: string;
  stripeAccountId: string;
};

type CreateConnectedMembershipSubscriptionParams = Omit<
  CreateMembershipSubscriptionParams,
  "startsOn" | "studioConnectedAccountId"
> & {
  stripeAccountId: string;
  renewalAnchor: number;
  idempotencyKey: string;
};

function getRecurringConfig(billingInterval: string) {
  if (billingInterval === "monthly") {
    return { interval: "month" as const, intervalCount: 1 };
  }

  if (billingInterval === "quarterly") {
    return { interval: "month" as const, intervalCount: 3 };
  }

  if (billingInterval === "yearly") {
    return { interval: "year" as const, intervalCount: 1 };
  }

  return { interval: "month" as const, intervalCount: 1 };
}

function getFutureBillingCycleAnchor(startsOn: string) {
  const startDate = new Date(`${startsOn}T00:00:00`);

  if (Number.isNaN(startDate.getTime())) {
    throw new Error("Invalid membership start date.");
  }

  const now = new Date();

  if (startDate.getTime() <= now.getTime()) {
    return undefined;
  }

  return Math.floor(startDate.getTime() / 1000);
}

export async function ensureStripeRecurringPrice({
  supabase,
  membershipPlanId,
  planName,
  price,
  billingInterval,
  stripeProductId,
  stripePriceId,
}: EnsureRecurringPriceParams) {
  if (stripePriceId) {
    return {
      stripeProductId: stripeProductId ?? null,
      stripePriceId,
    };
  }

  const stripe = getStripe();
  let resolvedProductId = stripeProductId ?? null;

  if (!resolvedProductId) {
    const product = await stripe.products.create({
      name: planName,
      metadata: {
        membershipPlanId,
      },
    });

    resolvedProductId = product.id;

    const { error: productUpdateError } = await supabase
      .from("membership_plans")
      .update({
        stripe_product_id: resolvedProductId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", membershipPlanId);

    if (productUpdateError) {
      throw new Error(
        `Failed to save Stripe product on membership plan: ${productUpdateError.message}`
      );
    }
  }

  const recurring = getRecurringConfig(billingInterval);

  const stripePrice = await stripe.prices.create({
    product: resolvedProductId,
    currency: "usd",
    unit_amount: Math.round(price * 100),
    recurring: {
      interval: recurring.interval,
      interval_count: recurring.intervalCount,
    },
    metadata: {
      membershipPlanId,
    },
  });

  const { error: priceUpdateError } = await supabase
    .from("membership_plans")
    .update({
      stripe_product_id: resolvedProductId,
      stripe_price_id: stripePrice.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", membershipPlanId);

  if (priceUpdateError) {
    throw new Error(
      `Failed to save Stripe price on membership plan: ${priceUpdateError.message}`
    );
  }

  return {
    stripeProductId: resolvedProductId,
    stripePriceId: stripePrice.id,
  };
}

export async function createStripeMembershipSubscription({
  stripeCustomerId,
  stripePriceId,
  defaultPaymentMethodId,
  localMembershipId,
  studioId,
  clientId,
  membershipPlanId,
  startsOn,
}: CreateMembershipSubscriptionParams) {
  const stripe = getStripe();
  const billingCycleAnchor = getFutureBillingCycleAnchor(startsOn);

  return stripe.subscriptions.create({
    customer: stripeCustomerId,
    items: [
      {
        price: stripePriceId,
      },
    ],
    collection_method: "charge_automatically",
    default_payment_method: defaultPaymentMethodId,
    payment_behavior: "default_incomplete",
    ...(billingCycleAnchor ? { billing_cycle_anchor: billingCycleAnchor } : {}),
    metadata: {
      localMembershipId,
      studioId,
      clientId,
      membershipPlanId,
      source: "membership_sale",
    },
    expand: ["latest_invoice.payment_intent"],
  });
}

export async function ensureConnectedStripeRecurringPrice({
  supabase,
  studioId,
  membershipPlanId,
  planName,
  price,
  billingInterval,
  stripeAccountId,
}: EnsureConnectedRecurringPriceParams) {
  const amountCents = Math.round(price * 100);
  const { data: existing, error: lookupError } = await supabase
    .from("membership_connected_prices")
    .select("stripe_product_id, stripe_price_id, unit_amount_cents, billing_interval")
    .eq("membership_plan_id", membershipPlanId)
    .eq("stripe_account_id", stripeAccountId)
    .maybeSingle();

  if (lookupError) throw new Error(`Connected Stripe price lookup failed: ${lookupError.message}`);

  if (
    existing?.stripe_price_id &&
    Number(existing.unit_amount_cents) === amountCents &&
    existing.billing_interval === billingInterval
  ) {
    return {
      stripeProductId: existing.stripe_product_id as string,
      stripePriceId: existing.stripe_price_id as string,
    };
  }

  const stripe = getStripe();
  const product = await stripe.products.create(
    { name: planName, metadata: { membershipPlanId, studioId } },
    {
      stripeAccount: stripeAccountId,
      idempotencyKey: `membership-product-${membershipPlanId}-${amountCents}-${billingInterval}`,
    }
  );
  const recurring = getRecurringConfig(billingInterval);
  const stripePrice = await stripe.prices.create(
    {
      product: product.id,
      currency: "usd",
      unit_amount: amountCents,
      recurring: { interval: recurring.interval, interval_count: recurring.intervalCount },
      metadata: { membershipPlanId, studioId },
    },
    {
      stripeAccount: stripeAccountId,
      idempotencyKey: `membership-price-${membershipPlanId}-${amountCents}-${billingInterval}`,
    }
  );

  const { error: saveError } = await supabase
    .from("membership_connected_prices")
    .upsert(
      {
        studio_id: studioId,
        membership_plan_id: membershipPlanId,
        stripe_account_id: stripeAccountId,
        stripe_product_id: product.id,
        stripe_price_id: stripePrice.id,
        unit_amount_cents: amountCents,
        billing_interval: billingInterval,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "membership_plan_id,stripe_account_id" }
    );

  if (saveError) throw new Error(`Connected Stripe price save failed: ${saveError.message}`);
  return { stripeProductId: product.id, stripePriceId: stripePrice.id };
}

export async function createConnectedStripeMembershipSubscription({
  stripeCustomerId,
  stripePriceId,
  defaultPaymentMethodId,
  localMembershipId,
  studioId,
  clientId,
  membershipPlanId,
  stripeAccountId,
  renewalAnchor,
  idempotencyKey,
}: CreateConnectedMembershipSubscriptionParams) {
  const stripe = getStripe();
  return stripe.subscriptions.create(
    {
      customer: stripeCustomerId,
      items: [{ price: stripePriceId }],
      collection_method: "charge_automatically",
      default_payment_method: defaultPaymentMethodId,
      billing_cycle_anchor: renewalAnchor,
      proration_behavior: "none",
      metadata: {
        localMembershipId,
        studioId,
        clientId,
        membershipPlanId,
        source: "terminal_membership_sale",
      },
    },
    { stripeAccount: stripeAccountId, idempotencyKey }
  );
}

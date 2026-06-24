import { getStripe } from "./stripe";

type EnsureStripeCustomerParams = {
  supabase: any;
  studioId: string;
  clientId: string;
  email: string | null;
  name: string | null;
};

type EnsureConnectedStripeCustomerParams = EnsureStripeCustomerParams & {
  stripeAccountId: string;
};

export async function ensureStripeCustomer({
  supabase,
  studioId,
  clientId,
  email,
  name,
}: EnsureStripeCustomerParams) {
  const { data: existing, error: existingError } = await supabase
    .from("stripe_customers")
    .select("id, stripe_customer_id")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Stripe customer lookup failed: ${existingError.message}`);
  }

  if (existing?.stripe_customer_id) {
    return existing.stripe_customer_id as string;
  }

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: email || undefined,
    name: name || undefined,
    metadata: {
      studioId,
      clientId,
    },
  });

  const { error: insertError } = await supabase.from("stripe_customers").insert({
    studio_id: studioId,
    client_id: clientId,
    stripe_customer_id: customer.id,
    email_snapshot: email,
  });

  if (insertError) {
    throw new Error(`Stripe customer save failed: ${insertError.message}`);
  }

  return customer.id;
}

export async function ensureConnectedStripeCustomer({
  supabase,
  studioId,
  clientId,
  email,
  name,
  stripeAccountId,
}: EnsureConnectedStripeCustomerParams) {
  const { data: existing, error: existingError } = await supabase
    .from("stripe_connected_customers")
    .select("stripe_customer_id")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("stripe_account_id", stripeAccountId)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Connected Stripe customer lookup failed: ${existingError.message}`);
  }

  if (existing?.stripe_customer_id) {
    return existing.stripe_customer_id as string;
  }

  const stripe = getStripe();
  const customer = await stripe.customers.create(
    {
      email: email || undefined,
      name: name || undefined,
      metadata: { studioId, clientId, source: "danceflow_terminal_membership" },
    },
    { stripeAccount: stripeAccountId }
  );

  const { error: insertError } = await supabase
    .from("stripe_connected_customers")
    .insert({
      studio_id: studioId,
      client_id: clientId,
      stripe_account_id: stripeAccountId,
      stripe_customer_id: customer.id,
      email_snapshot: email,
    });

  if (insertError) {
    throw new Error(`Connected Stripe customer save failed: ${insertError.message}`);
  }

  return customer.id;
}

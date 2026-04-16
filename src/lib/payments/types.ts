export type PaymentSource = "manual" | "stripe";

export type PaymentType =
  | "package_sale"
  | "membership"
  | "event_registration"
  | "floor_rental"
  | "other";

export type StripeSubscriptionStatus =
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid";

export type StripePaymentMethodSummary = {
  stripePaymentMethodId: string;
  type: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
};

export type StripeCustomerRecord = {
  id: string;
  studio_id: string;
  client_id: string;
  stripe_customer_id: string;
  email_snapshot: string | null;
};

export type StripeSubscriptionRecord = {
  id: string;
  studio_id: string;
  client_id: string;
  client_membership_id: string | null;
  membership_plan_id: string | null;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  stripe_price_id: string | null;
  status: StripeSubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  default_payment_method_id: string | null;
  latest_invoice_id: string | null;
};
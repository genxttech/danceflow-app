import type Stripe from "stripe";

/**
 * PAY-DC-2B: Stripe webhook signature verification with secret scope.
 *
 * The secret that verifies the payload determines its scope. The platform
 * destination ("DanceFlow Platform Subscriptions") never carries event.account;
 * the Connect destination ("DanceFlow Connect Direct Charges") always does. A
 * payload that verifies under one scope but has the other scope's shape is
 * rejected before any dedupe or handler work. Nothing here logs secrets, the
 * signature header or the body.
 */

export type WebhookScope = "platform" | "connect";

export type WebhookVerificationResult =
  | { ok: true; event: Stripe.Event; scope: WebhookScope }
  | {
      ok: false;
      reason: "not_configured" | "missing_signature" | "invalid_signature" | "scope_mismatch";
    };

function configured(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function verifyStripeWebhook(input: {
  body: string;
  signature: string | null | undefined;
  platformSecret: string | null | undefined;
  connectSecret: string | null | undefined;
  stripe: Pick<Stripe, "webhooks">;
}): WebhookVerificationResult {
  const candidates: Array<{ scope: WebhookScope; secret: string }> = [];
  const platformSecret = configured(input.platformSecret);
  const connectSecret = configured(input.connectSecret);
  if (platformSecret) candidates.push({ scope: "platform", secret: platformSecret });
  if (connectSecret) candidates.push({ scope: "connect", secret: connectSecret });

  if (candidates.length === 0) return { ok: false, reason: "not_configured" };
  if (!input.signature) return { ok: false, reason: "missing_signature" };

  for (const candidate of candidates) {
    let event: Stripe.Event;
    try {
      event = input.stripe.webhooks.constructEvent(input.body, input.signature, candidate.secret);
    } catch {
      continue;
    }

    const hasAccount = typeof event.account === "string" && event.account.length > 0;
    if (candidate.scope === "platform" ? hasAccount : !hasAccount) {
      return { ok: false, reason: "scope_mismatch" };
    }

    return { ok: true, event, scope: candidate.scope };
  }

  return { ok: false, reason: "invalid_signature" };
}

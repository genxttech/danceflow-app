import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { verifyStripeWebhook } from "@/lib/payments/webhookVerification";

/**
 * PAY-DC-2B: the secret that verifies a webhook determines its scope. Uses real
 * Stripe signatures (generateTestHeaderString) with throwaway test secrets.
 */

const stripe = new Stripe("sk_test_paydc2b_not_a_real_key");
const PLATFORM_SECRET = "whsec_paydc2b_platform_test";
const CONNECT_SECRET = "whsec_paydc2b_connect_test";

function payload(account?: string) {
  return JSON.stringify({
    id: "evt_paydc2b",
    object: "event",
    type: "invoice.paid",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "in_1", object: "invoice" } },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    ...(account ? { account } : {}),
  });
}

type TestHeaderOptions = Parameters<typeof stripe.webhooks.generateTestHeaderString>[0];

function signed(body: string, secret: string) {
  // Stripe fills timestamp/scheme/signature/cryptoProvider defaults at runtime.
  return stripe.webhooks.generateTestHeaderString({ payload: body, secret } as TestHeaderOptions);
}

function verify(body: string, signature: string | null, secrets: { platform?: string; connect?: string } = {}) {
  return verifyStripeWebhook({
    body,
    signature,
    platformSecret: "platform" in secrets ? secrets.platform : PLATFORM_SECRET,
    connectSecret: "connect" in secrets ? secrets.connect : CONNECT_SECRET,
    stripe,
  });
}

describe("verifyStripeWebhook scope", () => {
  it("platform secret + no event.account -> platform", () => {
    const body = payload();
    const result = verify(body, signed(body, PLATFORM_SECRET));
    expect(result).toMatchObject({ ok: true, scope: "platform" });
  });

  it("Connect secret + event.account -> connect", () => {
    const body = payload("acct_studio_1");
    const result = verify(body, signed(body, CONNECT_SECRET));
    expect(result).toMatchObject({ ok: true, scope: "connect" });
    if (result.ok) expect(result.event.account).toBe("acct_studio_1");
  });

  it("platform secret + event.account -> scope mismatch", () => {
    const body = payload("acct_studio_1");
    expect(verify(body, signed(body, PLATFORM_SECRET))).toEqual({ ok: false, reason: "scope_mismatch" });
  });

  it("Connect secret + no event.account -> scope mismatch", () => {
    const body = payload();
    expect(verify(body, signed(body, CONNECT_SECRET))).toEqual({ ok: false, reason: "scope_mismatch" });
  });

  it("wrong secret -> invalid signature", () => {
    const body = payload();
    expect(verify(body, signed(body, "whsec_someone_else"))).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("tampered body -> invalid signature", () => {
    const body = payload();
    const signature = signed(body, PLATFORM_SECRET);
    expect(verify(payload("acct_injected"), signature)).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("only one configured secret still enforces scope", () => {
    const connectOnlyPlatformShape = payload();
    expect(
      verify(connectOnlyPlatformShape, signed(connectOnlyPlatformShape, CONNECT_SECRET), { platform: undefined }),
    ).toEqual({ ok: false, reason: "scope_mismatch" });

    const platformOnlyConnectShape = payload("acct_studio_1");
    expect(
      verify(platformOnlyConnectShape, signed(platformOnlyConnectShape, PLATFORM_SECRET), { connect: "  " }),
    ).toEqual({ ok: false, reason: "scope_mismatch" });

    const connectEvent = payload("acct_studio_1");
    expect(verify(connectEvent, signed(connectEvent, CONNECT_SECRET), { platform: undefined })).toMatchObject({
      ok: true,
      scope: "connect",
    });
  });

  it("no configured secret -> not configured; missing signature -> missing", () => {
    const body = payload();
    expect(verify(body, signed(body, PLATFORM_SECRET), { platform: undefined, connect: "" })).toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(verify(body, null)).toEqual({ ok: false, reason: "missing_signature" });
  });
});

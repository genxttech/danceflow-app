import { describe, expect, it } from "vitest";
import { STRIPE_API_VERSION } from "../config";
import { createGuardedClient, pinned } from "../guarded";
import { runIdentityGate } from "../identity";
import type { ProofRequest, ProofResponse, Transport } from "../types";

// Sixth independent review (narrow): one test per P2. Each must fail if its fix is removed.

const PLATFORM = "acct_PLATFORMTEST1";
const CONNECTED = "acct_CONNECTEDTEST1";
const V = STRIPE_API_VERSION;

function world(handler: (r: ProofRequest) => ProofResponse | Promise<ProofResponse>) {
  const transport: Transport = async (r) => {
    if (r.path === "/v1/account") return { status: 200, json: { id: PLATFORM, object: "account" }, stripeVersion: V };
    if (r.path === `/v1/accounts/${CONNECTED}`) return { status: 200, json: { id: CONNECTED, object: "account", type: "express" }, stripeVersion: V };
    return handler(r);
  };
  return createGuardedClient({ transport, apiKey: "rk_test_FAKEFAKE", connectedAcct: CONNECTED, paceMs: 0 });
}
const ready = async (c: ReturnType<typeof createGuardedClient>) => { await runIdentityGate(c, { platformAcct: PLATFORM, connectedAcct: CONNECTED }); return c; };
const cust = (key: string): Omit<ProofRequest, "stripeVersion"> => ({ method: "POST", path: "/v1/customers", stripeAccount: CONNECTED, idempotencyKey: key, body: { name: "n", email: "d24-proof-abc123-a@example.com" } });

describe("P2-A an unverified delete answer never removes the id from remaining*", () => {
  const run = async (deleteAnswer: ProofResponse) => {
    const c = await ready(
      world((r) =>
        r.method === "POST"
          ? { status: 200, json: { id: "cus_R6A", object: "customer", livemode: false }, stripeVersion: V }
          : deleteAnswer,
      ),
    );
    await pinned(c, cust("d24proof-r6-cus:A"));
    expect(c.seen.customers.has("cus_R6A")).toBe(true);
    await expect(pinned(c, { method: "DELETE", path: "/v1/customers/cus_R6A", stripeAccount: CONNECTED }, { phase: "cleanup" })).rejects.toMatchObject({ code: "version_mismatch" });
    return c;
  };
  it("a 200 deleted:true WITHOUT a Stripe-Version header aborts and the customer stays in seen", async () => {
    const c = await run({ status: 200, json: { id: "cus_R6A", object: "customer", deleted: true } });
    expect(c.seen.customers.has("cus_R6A")).toBe(true);
  });
  it("a 200 deleted:true with a WRONG Stripe-Version aborts and the customer stays in seen", async () => {
    const c = await run({ status: 200, json: { id: "cus_R6A", object: "customer", deleted: true }, stripeVersion: "2020-01-01" });
    expect(c.seen.customers.has("cus_R6A")).toBe(true);
  });
  it("a fully verified delete still removes it", async () => {
    const c = await ready(
      world((r) =>
        r.method === "POST"
          ? { status: 200, json: { id: "cus_R6A", object: "customer", livemode: false }, stripeVersion: V }
          : { status: 200, json: { id: "cus_R6A", object: "customer", deleted: true }, stripeVersion: V },
      ),
    );
    await pinned(c, cust("d24proof-r6-cus:A"));
    await pinned(c, { method: "DELETE", path: "/v1/customers/cus_R6A", stripeAccount: CONNECTED }, { phase: "cleanup" });
    expect(c.seen.customers.has("cus_R6A")).toBe(false);
  });
});

describe("P2-B lost creates are counted per FULL idempotency key, not per masked key", () => {
  it("two lost POST /v1/customers with same-length different keys give uncertain.length === 2", async () => {
    const c = await ready(world(() => { throw new Error("socket hang up"); }));
    const a = "d24proof-r6-0123456-cus:A";
    const b = "d24proof-r6-0123456-cus:B";
    expect(a.length).toBe(b.length);
    await expect(pinned(c, cust(a))).rejects.toThrow(/socket hang up/);
    await expect(pinned(c, cust(b))).rejects.toThrow(/socket hang up/);
    expect(c.uncertain.length).toBe(2);
  });
  it("the SAME key lost twice is still one entry", async () => {
    const c = await ready(world(() => { throw new Error("socket hang up"); }));
    const a = "d24proof-r6-0123456-cus:A";
    await expect(pinned(c, cust(a))).rejects.toThrow();
    await expect(pinned(c, cust(a))).rejects.toThrow();
    expect(c.uncertain.length).toBe(1);
  });
});

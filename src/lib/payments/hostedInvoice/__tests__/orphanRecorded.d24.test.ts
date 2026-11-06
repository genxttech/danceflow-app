import { describe, expect, it, vi } from "vitest";
import { createHostedInvoice, createSupabaseIntentStore, type CreateDeps } from "../create";
import { Clock, FakeStore, FakeStripe, STUDIO_A, USER_A, fakeSupabase, ownedResolver } from "./createFakes";

vi.mock("server-only", () => ({}));

// D24 M3-B: the database may answer d24_intent_mark_provider_created with outcome "orphan_recorded" (a LATE Stripe response for an intent that
// is already failed/abandoned; M3-A records the invoice id as an orphan). The orchestrator must treat that as needs_review, must not register,
// and must never issue a second Stripe create.

const actor = { verified: true as const, studioId: STUDIO_A, userId: USER_A, canManageBilling: true as const };
const request = { actor, businessObjectType: "event_fee", businessObjectId: "bo-1", requestKey: "req-key-0001" };

describe("mark_provider_created outcomes map to the store verdict", () => {
  const storeFor = (data: unknown) =>
    createSupabaseIntentStore({ rpc: vi.fn(async () => ({ data, error: null })), from: vi.fn() } as never);
  const mark = (s: ReturnType<typeof storeFor>) =>
    s.markProviderCreated({ intentId: "i1", studioId: STUDIO_A, stripeInvoiceId: "in_1", livemode: false, keyLivemode: false, stripeAccountId: "acct_AAA111" });

  it("orphan_recorded / recorded_in_review / needs_review => review; provider_created / already_recorded => recorded; anything else => error", async () => {
    expect(await mark(storeFor({ outcome: "orphan_recorded", status: "failed" }))).toBe("review");
    expect(await mark(storeFor({ outcome: "orphan_recorded" }))).toBe("review");
    expect(await mark(storeFor({ outcome: "recorded_in_review" }))).toBe("review");
    expect(await mark(storeFor({ outcome: "needs_review" }))).toBe("review");
    expect(await mark(storeFor({ outcome: "provider_created" }))).toBe("recorded");
    expect(await mark(storeFor({ outcome: "already_recorded" }))).toBe("recorded");
    expect(await mark(storeFor({ outcome: "something_new" }))).toBe("error");
    expect(await mark(storeFor(null))).toBe("error");
  });
});

describe("orchestrator when mark_provider_created reports an orphan", () => {
  it("returns needs_review, never registers, and issues NO second Stripe create (also on retry)", async () => {
    const clock = new Clock();
    const stripe = new FakeStripe(clock);
    const store = new FakeStore(clock);
    // the store answers exactly what createSupabaseIntentStore returns for outcome "orphan_recorded"
    // and, like the database, an orphan only happens for an intent that is already terminal (failed/abandoned), so the row is terminal
    store.markProviderCreated = async (i) => {
      const row = store.rows.get(i.intentId);
      if (row) row.state = "failed";
      return "review";
    };
    const deps: CreateDeps = {
      supabase: fakeSupabase(), stripe, store, expectedLivemode: false, env: { D24_HOSTED_INVOICE_CREATION: "on" },
      resolvers: { event_fee: ownedResolver({ "bo-1": STUDIO_A }) },
    };
    const r = await createHostedInvoice(request, deps);
    expect(r).toMatchObject({ ok: false, code: "needs_review", retryable: false });
    expect(stripe.calls.filter((c) => c.op === "create")).toHaveLength(1);
    expect(store.log).not.toContain("register");
    // retrying with the same request must not create another invoice
    const again = await createHostedInvoice(request, deps);
    expect(again.ok).toBe(false);
    expect(stripe.calls.filter((c) => c.op === "create")).toHaveLength(1);
    expect(store.log).not.toContain("register");
  });
});

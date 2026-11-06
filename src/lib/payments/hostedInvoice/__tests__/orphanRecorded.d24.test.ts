import { describe, expect, it, vi } from "vitest";
import { createHostedInvoice, createSupabaseIntentStore, type CreateDeps } from "../create";
import { Clock, FakeStore, FakeStripe, STUDIO_A, USER_A, fakeSupabase, ownedResolver } from "./createFakes";

vi.mock("server-only", () => ({}));

// D24 M3-B: the database answers d24_intent_mark_provider_created with outcome "orphan_recorded" for a LATE Stripe response to an intent that is
// already failed/abandoned (M3-A records the invoice id in hosted_invoice_creation_orphans). The orchestrator must treat that as needs_review,
// must not register, and must never issue a second Stripe create. These tests compose the REAL createSupabaseIntentStore (over a stubbed rpc)
// with the REAL orchestrator; only the database is replaced.

const actor = { verified: true as const, studioId: STUDIO_A, userId: USER_A, canManageBilling: true as const };
const request = { actor, businessObjectType: "event_fee", businessObjectId: "bo-1", requestKey: "req-key-0001" };
const MARK = { intentId: "i1", studioId: STUDIO_A, stripeInvoiceId: "in_1", livemode: false, keyLivemode: false, stripeAccountId: "acct_AAA111" };

function rpcStub(result: { data?: unknown; error?: { code?: string; message?: string } | null }) {
  const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>>(
    async () => ({ data: result.data ?? null, error: result.error ?? null }),
  );
  return { rpc, store: createSupabaseIntentStore({ rpc, from: vi.fn() } as never) };
}

describe("mark_provider_created outcomes map to the store verdict", () => {
  it("calls the RPC with exactly the six p_ arguments", async () => {
    const { rpc, store } = rpcStub({ data: { outcome: "provider_created" } });
    await store.markProviderCreated(MARK);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("d24_intent_mark_provider_created");
    expect(rpc.mock.calls[0][1]).toEqual({ p_intent_id: "i1", p_studio_id: STUDIO_A, p_stripe_invoice_id: "in_1", p_livemode: false, p_key_livemode: false, p_stripe_account_id: "acct_AAA111" });
  });

  it("orphan_recorded / recorded_in_review / needs_review => review; provider_created / already_recorded => recorded; anything else => error", async () => {
    const verdict = async (data: unknown) => rpcStub({ data }).store.markProviderCreated(MARK);
    expect(await verdict({ outcome: "orphan_recorded", status: "failed" })).toBe("review");
    expect(await verdict({ outcome: "orphan_recorded" })).toBe("review");
    expect(await verdict({ outcome: "recorded_in_review" })).toBe("review");
    expect(await verdict({ outcome: "needs_review" })).toBe("review");
    expect(await verdict({ outcome: "provider_created" })).toBe("recorded");
    expect(await verdict({ outcome: "already_recorded" })).toBe("recorded");
    expect(await verdict({ outcome: "something_new" })).toBe("error");
    expect(await verdict(null)).toBe("error");
  });

  it("a needs_review status wins over a benign outcome, and a registered status does not turn an already_recorded into review", async () => {
    const verdict = async (data: unknown) => rpcStub({ data }).store.markProviderCreated(MARK);
    expect(await verdict({ outcome: "provider_created", status: "needs_review" })).toBe("review");
    expect(await verdict({ outcome: "already_recorded", status: "registered" })).toBe("recorded");
  });

  it("every database refusal (RPC error) maps to error, never to recorded or review", async () => {
    for (const message of ["d24_intent_invoice_conflict", "d24_livemode_mismatch", "d24_account_mismatch", "d24_intent_state"]) {
      const { store } = rpcStub({ error: { code: "P0001", message } });
      expect(await store.markProviderCreated(MARK), message).toBe("error");
    }
    expect(await rpcStub({ error: { code: "22023", message: "bad argument" } }).store.markProviderCreated(MARK)).toBe("error");
  });
});

/** A FakeStore whose markProviderCreated goes through the REAL Supabase store over a stubbed rpc, so the real verdict mapping feeds the orchestrator. */
class RpcBackedStore extends FakeStore {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  constructor(clock: Clock, private readonly answer: { data?: unknown; error?: { code?: string; message?: string } | null }, private readonly terminal: boolean) {
    super(clock);
  }
  async markProviderCreated(i: Parameters<FakeStore["markProviderCreated"]>[0]) {
    this.log.push("mark");
    const { rpc, store } = rpcStub(this.answer);
    const verdict = await store.markProviderCreated(i);
    this.rpcCalls.push({ fn: rpc.mock.calls[0][0], args: rpc.mock.calls[0][1] });
    // like the database: an orphan is only ever recorded for an intent that is already terminal
    const row = this.rows.get(i.intentId);
    if (row && this.terminal) row.state = "failed";
    return verdict;
  }
}

function compose(answer: ConstructorParameters<typeof RpcBackedStore>[1], terminal: boolean) {
  const clock = new Clock();
  const stripe = new FakeStripe(clock);
  const store = new RpcBackedStore(clock, answer, terminal);
  const deps: CreateDeps = {
    supabase: fakeSupabase(), stripe, store, expectedLivemode: false, env: { D24_HOSTED_INVOICE_CREATION: "on" },
    resolvers: { event_fee: ownedResolver({ "bo-1": STUDIO_A }) },
  };
  return { stripe, store, deps };
}

describe("orchestrator when the database reports orphan_recorded", () => {
  it("returns needs_review (not retryable), registers nothing, touches the ledger only via begin + mark, and creates exactly one Stripe invoice", async () => {
    const { stripe, store, deps } = compose({ data: { outcome: "orphan_recorded", status: "failed" } }, true);
    expect(await createHostedInvoice(request, deps)).toMatchObject({ ok: false, code: "needs_review", retryable: false });
    expect(store.rpcCalls).toHaveLength(1);
    expect(store.rpcCalls[0].fn).toBe("d24_intent_mark_provider_created");
    expect(stripe.calls.filter((c) => c.op === "create")).toHaveLength(1);
    // begin, then mark; no register, no fail, no review flag, no outcome write
    expect(store.log).toEqual(["begin", "mark"]);
  });

  it("a retry of the same request is refused as a terminal intent and issues no further Stripe call", async () => {
    const { stripe, store, deps } = compose({ data: { outcome: "orphan_recorded", status: "failed" } }, true);
    await createHostedInvoice(request, deps);
    const calls = stripe.calls.length;
    const again = await createHostedInvoice(request, deps);
    expect(again).toMatchObject({ ok: false, code: "intent_failed" });
    expect(stripe.calls.length).toBe(calls);
    expect(store.log).not.toContain("register");
  });

  it("a database refusal on mark (RPC error) holds the intent for review with the invoice id and does not register", async () => {
    const { stripe, store, deps } = compose({ error: { code: "P0001", message: "d24_intent_invoice_conflict" } }, false);
    const r = await createHostedInvoice(request, deps);
    expect(r.ok).toBe(false);
    expect(stripe.calls.filter((c) => c.op === "create")).toHaveLength(1);
    expect(store.log).not.toContain("register");
    expect(store.log.some((l) => l.startsWith("review:"))).toBe(true);
  });
});

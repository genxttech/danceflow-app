import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_INVOICE_SPEC_RESOLVERS, STRIPE_IDEMPOTENCY_SAFE_WINDOW_MS, createHostedInvoice, deriveIdempotencyKey, isHostedInvoiceCreationEnabled,
  livemodeFromSecretKey, resumeIntent, sweepRecoverableIntents, type AuthorizedBillingActor, type CreateDeps,
} from "../create";
import { ACCT_A, ACCT_B, FakeStore, FakeStripe, SPEC, STUDIO_A, STUDIO_B, USER_A, fakeSupabase, ownedResolver } from "./createFakes";

vi.mock("server-only", () => ({}));

const actorA: AuthorizedBillingActor = { verified: true, studioId: STUDIO_A, userId: USER_A, canManageBilling: true };
const actorB: AuthorizedBillingActor = { verified: true, studioId: STUDIO_B, userId: USER_A, canManageBilling: true };
const ON = { D24_HOSTED_INVOICE_CREATION: "on" };
const SYS = { system: "d24_recovery" } as const;
const req = (actor = actorA, id = "bo-1", requestKey = "req-key-0001") => ({ actor, businessObjectType: "event_fee", businessObjectId: id, requestKey });
const netErr = () => Object.assign(new Error("net"), { type: "StripeConnectionError" });

function setup(over: Partial<CreateDeps> = {}) {
  const stripe = new FakeStripe();
  const store = new FakeStore();
  const deps: CreateDeps = {
    supabase: fakeSupabase(), stripe, store, expectedLivemode: false, env: ON, now: () => 1_000_000,
    resolvers: { event_fee: ownedResolver({ "bo-1": STUDIO_A, "bo-2": STUDIO_A, "bo-3": STUDIO_A, "bo-b": STUDIO_B }) }, ...over,
  };
  return { stripe, store, deps };
}
const firstId = (s: FakeStore) => [...s.rows.keys()][0];

describe("flag and key mode", () => {
  it("is OFF unless exactly 'on'", async () => {
    for (const v of [undefined, "", "true", "1", "ON", " on", "off"]) expect(isHostedInvoiceCreationEnabled({ D24_HOSTED_INVOICE_CREATION: v })).toBe(false);
    const { stripe, store, deps } = setup({ env: {} });
    expect(await createHostedInvoice(req(), deps)).toEqual({ ok: false, code: "creation_disabled", retryable: false });
    expect(await resumeIntent("00000000-0000-0000-0000-000000000001", SYS, deps)).toMatchObject({ code: "creation_disabled" });
    expect(await sweepRecoverableIntents(deps)).toMatchObject({ disabled: true });
    expect(stripe.calls).toEqual([]);
    expect(store.log).toEqual([]);
  });
  it("derives key mode strictly", () => {
    expect(livemodeFromSecretKey("sk_live_x")).toBe(true);
    expect(livemodeFromSecretKey("rk_live_x")).toBe(true);
    expect(livemodeFromSecretKey("sk_test_x")).toBe(false);
    for (const k of [undefined, "", "pk_live_x", "whsec_x", "sk_live", "SK_LIVE_x"]) expect(livemodeFromSecretKey(k)).toBeNull();
  });
  it("refuses when the deployment key mode is unknown", async () => {
    const { stripe, deps } = setup({ expectedLivemode: null });
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "deployment_key_mode_unknown" });
    expect(stripe.calls).toEqual([]);
  });
  it("production resolver list is empty and fails closed before any db / stripe access", async () => {
    expect(Object.keys(PRODUCTION_INVOICE_SPEC_RESOLVERS)).toEqual([]);
    const { stripe, store, deps } = setup({ resolvers: undefined });
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "business_object_type_unsupported" });
    expect(stripe.calls).toEqual([]);
    expect(store.log).toEqual([]);
  });
});

describe("authorization and tenancy", () => {
  it("rejects unverified / forged / partial actors", async () => {
    const { stripe, deps } = setup();
    const bad = [{ ...actorA, verified: false }, { ...actorA, canManageBilling: false }, { ...actorA, studioId: "nope" }, { ...actorA, userId: "x" }, {}, null, "staff"];
    for (const a of bad) expect(await createHostedInvoice(req(a as never), deps)).toMatchObject({ code: "not_authorized" });
    expect(stripe.calls).toEqual([]);
  });
  it("studio A cannot invoice studio B's object (resolver returns null) and nothing is begun", async () => {
    const { stripe, store, deps } = setup();
    expect(await createHostedInvoice(req(actorA, "bo-b"), deps)).toMatchObject({ code: "business_object_not_owned" });
    expect(stripe.calls).toEqual([]);
    expect(store.rows.size).toBe(0);
  });
  it("ignores studio / account fields smuggled into the request", async () => {
    const { stripe, deps } = setup();
    const r = await createHostedInvoice({ ...req(), studioId: STUDIO_B, stripeAccount: ACCT_B, createdBy: "x", livemode: true, customer: "cus_evil", amount: 1 } as never, deps);
    expect(r.ok).toBe(true);
    expect(stripe.calls.every((c) => c.account === ACCT_A)).toBe(true);
    expect((stripe.calls[0].params as { customer: string }).customer).toBe(SPEC.stripeCustomerId);
  });
  it("account comes only from the studio record; missing / malformed / charges-disabled fail closed", async () => {
    for (const acc of [{ acct: null }, { acct: "evil" }, { acct: ACCT_A, charges: false }, { acct: "  " }]) {
      const { stripe, store, deps } = setup({ supabase: fakeSupabase({ [STUDIO_A]: acc }) });
      expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "stripe_account_unavailable" });
      expect(stripe.calls).toEqual([]);
      expect(store.rows.size).toBe(0);
    }
    const { deps } = setup({ supabase: fakeSupabase({}) });
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "stripe_account_unavailable" });
  });
  it("refuses subscription-ish types and malformed input", async () => {
    const { stripe, deps } = setup({ resolvers: { membership_subscription: ownedResolver({ x: STUDIO_A }) } });
    expect(await createHostedInvoice({ ...req(), businessObjectType: "membership_subscription" }, deps)).toMatchObject({ code: "subscription_object_refused" });
    for (const r of [{ ...req(), businessObjectId: "../x" }, { ...req(), requestKey: "short" }, { ...req(), businessObjectType: "Bad Type" }]) {
      expect(await createHostedInvoice(r, deps)).toMatchObject({ code: "invalid_input" });
    }
    expect(stripe.calls).toEqual([]);
  });
  it("rejects an invalid resolver spec", async () => {
    const bads = [{ ...SPEC, stripeCustomerId: "x" }, { ...SPEC, lines: [] }, { ...SPEC, lines: [{ description: "a", amountCents: -5 }] }, { ...SPEC, currency: "USDX" }, { ...SPEC, daysUntilDue: 0 }, { ...SPEC, lines: [{ description: "a", amountCents: 1.5 }] }];
    for (const bad of bads) {
      const { stripe, deps } = setup({ resolvers: { event_fee: ownedResolver({ "bo-1": STUDIO_A }, bad) } });
      expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "invalid_invoice_spec" });
      expect(stripe.calls).toEqual([]);
    }
  });
});

describe("happy path", () => {
  it("creates a draft send_invoice, no finalize/send, registers via the ledger", async () => {
    const { stripe, store, deps } = setup();
    const r = await createHostedInvoice(req(), deps);
    expect(r).toMatchObject({ ok: true, state: "registered", stripeInvoiceId: "in_fake1", livemode: false });
    const c = stripe.calls[0];
    expect(c.account).toBe(ACCT_A);
    expect(c.params).toMatchObject({ collection_method: "send_invoice", auto_advance: false, customer: SPEC.stripeCustomerId });
    expect(c.key).toBe(deriveIdempotencyKey(STUDIO_A, "event_fee", "bo-1", "req-key-0001", SPEC));
    expect(stripe.calls.map((x) => x.op)).toEqual(["create", "lines"]);
    expect(store.log).toEqual(["begin", "mark", "register"]);
  });
  it("different studios never share an idempotency key", () => {
    expect(deriveIdempotencyKey(STUDIO_A, "t", "o", "k", SPEC)).not.toBe(deriveIdempotencyKey(STUDIO_B, "t", "o", "k", SPEC));
  });
});

describe("livemode and response forgery", () => {
  it("refuses a live invoice from a test deployment and the reverse; nothing is marked or registered", async () => {
    for (const [dep, resp] of [[false, true], [true, false]] as const) {
      const { stripe, store, deps } = setup({ expectedLivemode: dep });
      stripe.livemode = resp;
      expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "livemode_mismatch", retryable: false });
      expect(store.log).toEqual(["begin", "fail:livemode_mismatch"]);
      expect([...store.rows.values()][0].state).toBe("failed");
    }
  });
  it("refuses a malformed / non-draft / wrong-customer / subscription / wrong-total response", async () => {
    const mutate: Array<(s: Record<string, unknown>) => void> = [
      (s) => (s.id = "sub_1"), (s) => (s.status = "open"), (s) => (s.collection_method = "charge_automatically"), (s) => (s.customer = "cus_other"),
      (s) => (s.subscription = "sub_9"), (s) => (s.parent = { subscription_details: { subscription: "sub_9" } }), (s) => (s.livemode = "false"),
    ];
    for (const m of mutate) {
      const { stripe, store, deps } = setup();
      const orig = stripe.createDraftInvoice.bind(stripe);
      stripe.createDraftInvoice = async (a) => { const s = (await orig(a)) as unknown as Record<string, unknown>; m(s); return s as never; };
      expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "stripe_response_invalid" });
      expect(store.log).not.toContain("register");
      expect([...store.rows.values()][0].state).toBe("failed");
    }
    const { stripe, store, deps } = setup();
    const orig = stripe.addInvoiceLines.bind(stripe);
    stripe.addInvoiceLines = async (a) => ({ ...(await orig(a)), total: 1 });
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "stripe_response_invalid" });
    expect(store.log).not.toContain("register");
  });
  it("does not trust metadata or any echoed studio / account values in the response", async () => {
    const { stripe, store, deps } = setup();
    const orig = stripe.createDraftInvoice.bind(stripe);
    stripe.createDraftInvoice = async (a) => ({ ...(await orig(a)), metadata: { studio_id: STUDIO_B, account: ACCT_B } }) as never;
    expect((await createHostedInvoice(req(), deps)).ok).toBe(true);
    expect([...store.rows.values()][0].studioId).toBe(STUDIO_A);
  });
});

describe("idempotency and concurrency", () => {
  it("duplicate sequential creates return the same intent and one provider invoice", async () => {
    const { stripe, deps } = setup();
    const a = await createHostedInvoice(req(), deps);
    const b = await createHostedInvoice(req(), deps);
    expect(a.ok && b.ok && a.stripeInvoiceId === b.stripeInvoiceId && a.intentId === b.intentId).toBe(true);
    expect(stripe.createCount).toBe(1);
  });
  it("10 concurrent retries with the same key yield exactly one provider invoice", async () => {
    const { stripe, deps } = setup();
    const rs = await Promise.all(Array.from({ length: 10 }, () => createHostedInvoice(req(), deps)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(new Set(rs.map((r) => r.ok && r.stripeInvoiceId)).size).toBe(1);
    expect(stripe.createCount).toBe(1);
  });
  it("a second invoice for the same object is refused while one is live; a changed spec cannot slip in under the same requestKey", async () => {
    const { stripe, store, deps } = setup();
    await createHostedInvoice(req(), deps);
    expect(await createHostedInvoice(req(actorA, "bo-1", "req-key-0002"), deps)).toMatchObject({ ok: false, code: "intent_payload_conflict" });
    await createHostedInvoice(req(actorA, "bo-2", "req-key-0002"), deps);
    expect(stripe.createCount).toBe(2);
    const changed = { ...SPEC, lines: [{ description: "Entry", amountCents: 9999 }] };
    const r = await createHostedInvoice(req(), { ...deps, resolvers: { event_fee: ownedResolver({ "bo-1": STUDIO_A }, changed) } });
    expect(r).toMatchObject({ ok: false, code: "intent_payload_conflict" });
    expect(stripe.createCount).toBe(2);
    expect(store.rows.size).toBe(2);
  });
  it("fake stripe itself rejects same key with a different payload", async () => {
    const s = new FakeStripe();
    const p = { customer: "cus_1", collection_method: "send_invoice", days_until_due: 1, currency: "usd", auto_advance: false, metadata: {} } as never;
    await s.createDraftInvoice({ stripeAccount: ACCT_A, idempotencyKey: "k", params: p });
    await expect(s.createDraftInvoice({ stripeAccount: ACCT_A, idempotencyKey: "k", params: { ...(p as object), days_until_due: 2 } as never })).rejects.toMatchObject({ type: "StripeIdempotencyError" });
  });
});

describe("crash and failure recovery", () => {
  it("DB success then crash before the Stripe call: resume creates exactly one invoice", async () => {
    const { stripe, store, deps } = setup();
    stripe.failNext = netErr();
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "stripe_unavailable", retryable: true });
    expect(stripe.createCount).toBe(0);
    expect([...store.rows.values()][0].state).toBe("pending");
    expect(await resumeIntent(firstId(store), SYS, deps)).toMatchObject({ ok: true, stripeInvoiceId: "in_fake1" });
    expect(stripe.createCount).toBe(1);
  });
  it("Stripe create succeeded but crash before lines/mark: resume reuses the same invoice via the same key", async () => {
    const { stripe, store, deps } = setup();
    stripe.failAfterCreate = netErr();
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, retryable: true });
    expect(stripe.createCount).toBe(1);
    expect(await resumeIntent(firstId(store), SYS, deps)).toMatchObject({ ok: true, stripeInvoiceId: "in_fake1" });
    expect(stripe.createCount).toBe(1);
  });
  it("Stripe success then DB mark failure: retryable; resume does not create a second invoice", async () => {
    const { stripe, store, deps } = setup();
    store.markFail = true;
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "registration_unavailable", retryable: true });
    store.markFail = false;
    expect((await resumeIntent(firstId(store), SYS, deps)).ok).toBe(true);
    expect(stripe.createCount).toBe(1);
  });
  it("crash after provider_created before registration: resume registers with NO Stripe call", async () => {
    const { stripe, store, deps } = setup();
    store.registerFail = { code: "registration_failed", retryable: true };
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, retryable: true });
    expect([...store.rows.values()][0].state).toBe("provider_created");
    const before = stripe.calls.length;
    store.registerFail = null;
    expect((await resumeIntent(firstId(store), SYS, deps)).ok).toBe(true);
    expect(stripe.calls.length).toBe(before);
  });
  it("permanent Stripe rejection fails the intent; later resume / retry are refused without another call", async () => {
    const { stripe, store, deps } = setup();
    stripe.failNext = Object.assign(new Error("x"), { type: "StripeInvalidRequestError", statusCode: 400 });
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "stripe_rejected", retryable: false });
    const n = stripe.calls.length;
    expect(await resumeIntent(firstId(store), SYS, deps)).toMatchObject({ code: "intent_failed" });
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "intent_failed" });
    expect(stripe.calls.length).toBe(n);
  });
  it("never returns provider or database text", async () => {
    const { stripe, deps } = setup();
    stripe.failNext = Object.assign(new Error("SECRET-PROVIDER-TEXT sk_live_abc"), { type: "StripeAPIError", statusCode: 500 });
    expect(JSON.stringify(await createHostedInvoice(req(), deps))).not.toMatch(/SECRET|sk_live/);
  });
  it("resume of a begun intent refuses once Stripe's idempotency window may have lapsed (no second invoice)", async () => {
    const { stripe, store, deps } = setup();
    stripe.failNext = netErr();
    await createHostedInvoice(req(), deps);
    const r = await resumeIntent(firstId(store), SYS, { ...deps, now: () => 1_000_000 + STRIPE_IDEMPOTENCY_SAFE_WINDOW_MS + 1 });
    expect(r).toMatchObject({ ok: false, code: "idempotency_window_expired", retryable: false });
    expect(stripe.createCount).toBe(0);
  });
  it("resume refuses when the trusted spec changed since begin", async () => {
    const { stripe, store, deps } = setup();
    stripe.failNext = netErr();
    await createHostedInvoice(req(), deps);
    const changed = { ...SPEC, description: "other" };
    const r = await resumeIntent(firstId(store), SYS, { ...deps, resolvers: { event_fee: ownedResolver({ "bo-1": STUDIO_A }, changed) } });
    expect(r).toMatchObject({ code: "payload_changed" });
    expect(stripe.createCount).toBe(0);
  });
  it("resume re-checks livemode of a stored provider_created intent against the deployment", async () => {
    const { stripe, store, deps } = setup();
    store.registerFail = { code: "registration_failed", retryable: true };
    await createHostedInvoice(req(), deps);
    store.registerFail = null;
    expect(await resumeIntent(firstId(store), SYS, { ...deps, expectedLivemode: true })).toMatchObject({ code: "livemode_mismatch" });
    expect(stripe.createCount).toBe(1);
  });
});

describe("ledger account binding", () => {
  it("if the ledger resolved a different account than the studio record, nothing is sent to Stripe", async () => {
    const { stripe, store, deps } = setup();
    store.accounts[STUDIO_A] = ACCT_B;
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "stripe_account_unavailable" });
    expect(stripe.calls).toEqual([]);
  });
  it("resume of a pending intent refuses when the studio's account changed since begin", async () => {
    const { stripe, store, deps } = setup();
    stripe.failNext = netErr();
    await createHostedInvoice(req(), deps);
    const r = await resumeIntent(firstId(store), SYS, { ...deps, supabase: fakeSupabase({ [STUDIO_A]: { acct: "acct_NEW999" } }) });
    expect(r).toMatchObject({ ok: false, code: "stripe_account_unavailable" });
    expect(stripe.createCount).toBe(0);
  });
  it("mark passes the deployment key mode and the account used; the call uses the intent's idempotency key verbatim", async () => {
    const { stripe, store, deps } = setup();
    const spy = vi.spyOn(store, "markProviderCreated");
    await createHostedInvoice(req(), deps);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ keyLivemode: false, stripeAccountId: ACCT_A, studioId: STUDIO_A }));
    expect(stripe.calls[0].key).toBe([...store.rows.values()][0].idempotencyKey);
  });
});

describe("resume authorization", () => {
  it("another studio's actor sees the intent as not found; forged system actors are rejected", async () => {
    const { store, deps } = setup();
    await createHostedInvoice(req(), deps);
    const id = firstId(store);
    expect(await resumeIntent(id, actorB, deps)).toMatchObject({ code: "intent_not_found" });
    expect(await resumeIntent("00000000-0000-0000-0000-0000000000ff", actorA, deps)).toMatchObject({ code: "intent_not_found" });
    expect(await resumeIntent(id, { system: "d24_recovery", extra: 1 } as never, deps)).toMatchObject({ code: "not_authorized" });
    expect(await resumeIntent(id, { system: "other" } as never, deps)).toMatchObject({ code: "not_authorized" });
    expect(await resumeIntent("bad", actorA, deps)).toMatchObject({ code: "invalid_input" });
    expect(await resumeIntent(id, actorA, deps)).toMatchObject({ ok: true });
  });
});

describe("sweep", () => {
  it("is bounded and resumes only recoverable intents", async () => {
    const { stripe, store, deps } = setup();
    for (let i = 0; i < 3; i++) {
      stripe.failNext = netErr();
      await createHostedInvoice(req(actorA, `bo-${i + 1}`, `req-key-000${i}`), deps);
    }
    expect(store.rows.size).toBe(3);
    expect(await sweepRecoverableIntents(deps, { limit: 2 })).toMatchObject({ examined: 2, registered: 2, disabled: false });
    expect(stripe.createCount).toBe(2);
    expect((await sweepRecoverableIntents(deps, { limit: 1000 })).examined).toBe(1);
  });
});

describe("webhook before registration (offline signed fixture)", () => {
  it("a verified signed invoice event for the new id is accepted offline; adoption is reported, no settlement is inferred, metadata is not trusted", async () => {
    const { stripe, store, deps } = setup();
    store.adopted = true;
    const r = await createHostedInvoice(req(), deps);
    expect(r).toMatchObject({ ok: true, adoptedExistingFacts: true });
    if (!r.ok) throw new Error("unreachable");
    const secret = "whsec_d24_m3b_synthetic";
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "invoice.paid", account: ACCT_B, livemode: false, data: { object: { id: r.stripeInvoiceId, object: "invoice", metadata: { studio_id: STUDIO_B }, status: "paid" } } });
    const offline = new Stripe("sk_test_d24_not_a_real_key");
    const header = offline.webhooks.generateTestHeaderString({ payload, secret });
    expect(offline.webhooks.constructEvent(payload, header, secret).type).toBe("invoice.paid");
    expect(() => offline.webhooks.constructEvent(payload, header, "whsec_wrong")).toThrow();
    expect(Object.keys(r)).not.toContain("paid");
    expect([...store.rows.values()][0].studioId).toBe(STUDIO_A);
    expect(stripe.createCount).toBe(1);
  });
});

describe("review follow-ups", () => {
  it("refuses a response whose auto_advance is not false (would auto-finalize and email)", async () => {
    const { stripe, store, deps } = setup();
    const orig = stripe.createDraftInvoice.bind(stripe);
    stripe.createDraftInvoice = async (a) => ({ ...(await orig(a)), auto_advance: true }) as never;
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "stripe_response_invalid" });
    expect(store.log).not.toContain("register");
  });
  it("a permanent failure after the draft exists still records the invoice id on the intent", async () => {
    const { stripe, store, deps } = setup();
    stripe.failAfterCreate = Object.assign(new Error("x"), { type: "StripeInvalidRequestError", statusCode: 400 });
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "stripe_rejected", retryable: false });
    const row = [...store.rows.values()][0];
    expect(row.state).toBe("failed");
    expect(row.stripeInvoiceId).toBe("in_fake1");
  });
  it("an expired pending intent is refused but NOT failed (object stays blocked)", async () => {
    const { stripe, store, deps } = setup();
    stripe.failNext = netErr();
    await createHostedInvoice(req(), deps);
    await resumeIntent(firstId(store), SYS, { ...deps, now: () => 1_000_000 + STRIPE_IDEMPOTENCY_SAFE_WINDOW_MS + 1 });
    expect([...store.rows.values()][0].state).toBe("pending");
  });
  it("a permanent registration refusal terminates the intent", async () => {
    const { store, deps } = setup();
    store.registerFail = { code: "registration_failed", retryable: false };
    await createHostedInvoice(req(), deps);
    expect([...store.rows.values()][0].state).toBe("failed");
  });
});

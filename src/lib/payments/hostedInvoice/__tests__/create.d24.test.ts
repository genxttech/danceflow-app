import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_INVOICE_SPEC_RESOLVERS, createHostedInvoice, deriveIdempotencyKey, deriveRequestFingerprint, isHostedInvoiceCreationEnabled,
  livemodeFromSecretKey, resumeIntent, sweepRecoverableIntents, type AuthorizedBillingActor, type CreateDeps,
} from "../create";
import { ACCT_A, ACCT_B, Clock, FakeStore, FakeStripe, HOUR, SPEC, STUDIO_A, STUDIO_B, USER_A, fakeSupabase, ownedResolver } from "./createFakes";

vi.mock("server-only", () => ({}));

const actorA: AuthorizedBillingActor = { verified: true, studioId: STUDIO_A, userId: USER_A, canManageBilling: true };
const actorB: AuthorizedBillingActor = { verified: true, studioId: STUDIO_B, userId: USER_A, canManageBilling: true };
const ON = { D24_HOSTED_INVOICE_CREATION: "on" };
const SYS = { system: "d24_recovery" } as const;
const req = (actor = actorA, id = "bo-1", requestKey = "req-key-0001") => ({ actor, businessObjectType: "event_fee", businessObjectId: id, requestKey });
const netErr = () => Object.assign(new Error("net"), { type: "StripeConnectionError" });
const permErr = () => Object.assign(new Error("x"), { type: "StripeInvalidRequestError", statusCode: 400 });

function setup(over: Partial<CreateDeps> = {}) {
  const clock = new Clock();
  const stripe = new FakeStripe(clock);
  const store = new FakeStore(clock);
  const deps: CreateDeps = {
    supabase: fakeSupabase(), stripe, store, expectedLivemode: false, env: ON,
    resolvers: { event_fee: ownedResolver({ "bo-1": STUDIO_A, "bo-2": STUDIO_A, "bo-3": STUDIO_A, "bo-b": STUDIO_B }) }, ...over,
  };
  return { clock, stripe, store, deps };
}
const firstId = (s: FakeStore) => [...s.rows.keys()][0];
const first = (s: FakeStore) => [...s.rows.values()][0];

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
    expect(c.key).toBe(deriveIdempotencyKey(STUDIO_A, "event_fee", "bo-1", "req-key-0001"));
    expect(stripe.calls.map((x) => x.op)).toEqual(["create", "lines"]);
    expect(store.log).toEqual(["begin", "mark", "register"]);
  });
  it("different studios never share an idempotency key; the fingerprint is 64 lowercase hex and content-sensitive", () => {
    expect(deriveIdempotencyKey(STUDIO_A, "t", "o", "k")).not.toBe(deriveIdempotencyKey(STUDIO_B, "t", "o", "k"));
    const f = deriveRequestFingerprint(STUDIO_A, "t", "o", SPEC, ACCT_A, false);
    expect(f).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveRequestFingerprint(STUDIO_A, "t", "o", { ...SPEC, description: "x" }, ACCT_A, false)).not.toBe(f);
    expect(deriveRequestFingerprint(STUDIO_B, "t", "o", SPEC, ACCT_A, false)).not.toBe(f);
    expect(deriveRequestFingerprint(STUDIO_A, "t", "o", SPEC, ACCT_B, false)).not.toBe(f); // account is covered
    expect(deriveRequestFingerprint(STUDIO_A, "t", "o", SPEC, ACCT_A, true)).not.toBe(f); // key mode is covered
  });
});

describe("livemode and response forgery -> needs_review, never registered", () => {
  it("a live response in a test deployment (and the reverse) is flagged for review; nothing marked or registered", async () => {
    for (const [dep, resp] of [[false, true], [true, false]] as const) {
      const { stripe, store, deps } = setup({ expectedLivemode: dep });
      stripe.livemode = resp;
      expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "livemode_mismatch", retryable: false });
      expect(store.log).toEqual(["begin", "review:livemode_mismatch"]);
      expect(first(store).state).toBe("needs_review");
    }
  });
  it("a malformed / non-draft / wrong-customer / subscription / hosted-url / auto_advance response is flagged, not registered", async () => {
    const mutate: Array<(s: Record<string, unknown>) => void> = [
      (s) => (s.id = "sub_1"), (s) => (s.status = "open"), (s) => (s.collection_method = "charge_automatically"), (s) => (s.customer = "cus_other"),
      (s) => (s.subscription = "sub_9"), (s) => (s.parent = { subscription_details: { subscription: "sub_9" } }), (s) => (s.livemode = "false"),
      (s) => (s.auto_advance = true), (s) => (s.hosted_invoice_url = "https://invoice.stripe.com/i/x"),
    ];
    for (const m of mutate) {
      const { stripe, store, deps } = setup();
      const orig = stripe.createDraftInvoice.bind(stripe);
      stripe.createDraftInvoice = async (a) => { const s = (await orig(a)) as unknown as Record<string, unknown>; m(s); return s as never; };
      const r = await createHostedInvoice(req(), deps);
      expect(r).toMatchObject({ ok: false, code: "stripe_response_invalid" });
      expect(JSON.stringify(r)).not.toMatch(/https?:/);
      expect(store.log).not.toContain("register");
      expect(first(store).state).toBe("needs_review");
    }
    const { stripe, store, deps } = setup();
    const orig = stripe.addInvoiceLines.bind(stripe);
    stripe.addInvoiceLines = async (a) => ({ ...(await orig(a)), total: 1 });
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "stripe_response_invalid" });
    expect(store.log).not.toContain("register");
    expect(first(store).state).toBe("needs_review");
    expect(first(store).stripeInvoiceId).toBe("in_fake1"); // the orphan draft id is kept for the reviewer
  });
  it("does not trust metadata or any echoed studio / account values in the response", async () => {
    const { stripe, store, deps } = setup();
    const orig = stripe.createDraftInvoice.bind(stripe);
    stripe.createDraftInvoice = async (a) => ({ ...(await orig(a)), metadata: { studio_id: STUDIO_B, account: ACCT_B } }) as never;
    expect((await createHostedInvoice(req(), deps)).ok).toBe(true);
    expect(first(store).studioId).toBe(STUDIO_A);
  });
});

describe("the ten recovery scenarios", () => {
  it("1. crash before the Stripe request (no record at all): recovery claim replays with the ORIGINAL key and creates exactly one invoice", async () => {
    const { stripe, store, deps } = setup();
    // simulate a process death after begin: ledger row exists, Stripe never contacted
    const begun = await store.begin({ studioId: STUDIO_A, createdBy: USER_A, idempotencyKey: deriveIdempotencyKey(STUDIO_A, "event_fee", "bo-1", "req-key-0001"), requestFingerprint: deriveRequestFingerprint(STUDIO_A, "event_fee", "bo-1", SPEC, ACCT_A, false), businessObjectType: "event_fee", businessObjectId: "bo-1" });
    if (!begun.ok) throw new Error("begin");
    expect(stripe.calls).toEqual([]);
    expect(await resumeIntent(begun.intent.id, SYS, deps)).toMatchObject({ ok: true, stripeInvoiceId: "in_fake1" });
    expect(stripe.createCount).toBe(1);
    expect(stripe.calls[0].key).toBe(begun.intent.idempotencyKey);
  });
  it("2. crash after Stripe success before the invoice id is recorded: still pending; recovery replays the SAME key and gets the SAME invoice", async () => {
    const { stripe, store, deps } = setup();
    store.markCrash = true; // the process dies between Stripe's response and the ledger write
    await expect(createHostedInvoice(req(), deps)).rejects.toThrow();
    expect(first(store).state).toBe("pending");
    store.markCrash = false;
    const key = first(store).idempotencyKey;
    expect(await resumeIntent(firstId(store), SYS, deps)).toMatchObject({ ok: true, stripeInvoiceId: "in_fake1" });
    expect(stripe.calls.filter((c) => c.op === "create").map((c) => c.key)).toEqual([key, key]);
    expect(stripe.createCount).toBe(1);
  });
  it("3. retry with the same key while the failure is retryable (rate limit / key in use): same key, one invoice", async () => {
    const { stripe, store, deps } = setup();
    stripe.failNext = Object.assign(new Error("rl"), { type: "StripeRateLimitError", statusCode: 429 });
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "stripe_unavailable", retryable: true });
    expect(first(store).outcomeUnknown).toBe(false);
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: true });
    expect(new Set(stripe.calls.filter((c) => c.op === "create").map((c) => c.key)).size).toBe(1);
    expect(stripe.createCount).toBe(1);
  });
  it("4. same key + changed parameters is refused: no new intent, no Stripe call", async () => {
    const { stripe, store, deps } = setup();
    await createHostedInvoice(req(), deps);
    const calls = stripe.calls.length;
    const changed = { ...SPEC, lines: [{ description: "Entry", amountCents: 9999 }] };
    const r = await createHostedInvoice(req(), { ...deps, resolvers: { event_fee: ownedResolver({ "bo-1": STUDIO_A }, changed) } });
    expect(r).toMatchObject({ ok: false, code: "request_fingerprint_mismatch", retryable: false });
    expect(stripe.calls.length).toBe(calls);
    expect(store.rows.size).toBe(1);
  });
  it("5. concurrent workers recovering one intent: exactly one holds the lease and replays; one provider invoice", async () => {
    const { stripe, store, deps } = setup();
    stripe.failNext = netErr();
    await createHostedInvoice(req(), deps);
    const id = firstId(store);
    const rs = await Promise.all(Array.from({ length: 6 }, () => resumeIntent(id, SYS, deps)));
    expect(rs.filter((r) => r.ok).length).toBe(1);
    expect(rs.filter((r) => !r.ok && r.code === "recovery_in_progress" && r.retryable).length).toBe(5);
    expect(store.claims.granted).toBe(1);
    expect(stripe.createCount).toBe(1);
  });
  it("6. timeout with unknown result: outcome_unknown recorded, nothing else is called, retry/create refuses; only the DB claim can replay", async () => {
    const { stripe, store, deps } = setup();
    stripe.loseResponseAfterCreate = Object.assign(new Error("timeout"), { type: "StripeConnectionError" });
    const r1 = await createHostedInvoice(req(), deps);
    expect(r1).toMatchObject({ ok: false, code: "outcome_unknown", retryable: false });
    expect(first(store).outcomeUnknown).toBe(true);
    expect(stripe.createCount).toBe(1); // the invoice DID get created on Stripe's side
    const calls = stripe.calls.length;
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "outcome_unknown" }); // user retry: no blind replay
    expect(stripe.calls.length).toBe(calls);
    expect(await resumeIntent(firstId(store), SYS, deps)).toMatchObject({ ok: true, stripeInvoiceId: "in_fake1" });
    expect(stripe.createCount).toBe(1); // replay with the original key returned the same invoice
    expect(first(store).outcomeUnknown).toBe(false);
  });
  it("7. recovery after the safe window => needs_review and NO replay (Stripe retention is modeled: a replay past it WOULD duplicate)", async () => {
    // control: prove the hazard exists in the fake
    const hazard = setup();
    hazard.stripe.loseResponseAfterCreate = netErr();
    await createHostedInvoice(req(), hazard.deps);
    hazard.clock.advance(25 * HOUR);
    const key = first(hazard.store).idempotencyKey;
    await hazard.stripe.createDraftInvoice({ stripeAccount: ACCT_A, idempotencyKey: key, params: hazard.stripe.calls[0].params as never });
    expect(hazard.stripe.createCount).toBe(2); // pruned key => duplicate invoice

    const { clock, stripe, store, deps } = setup();
    stripe.loseResponseAfterCreate = netErr();
    await createHostedInvoice(req(), deps);
    clock.advance(13 * HOUR); // > 12h window, < 24h retention
    const calls = stripe.calls.length;
    expect(await resumeIntent(firstId(store), SYS, deps)).toMatchObject({ ok: false, code: "needs_review", retryable: false });
    expect(stripe.calls.length).toBe(calls);
    expect(stripe.createCount).toBe(1);
    expect(first(store).state).toBe("needs_review");
    // and a user retry of the same request can't replay either
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "needs_review" });
    expect(stripe.calls.length).toBe(calls);
    // sweep never touches needs_review
    expect(await sweepRecoverableIntents(deps)).toMatchObject({ examined: 0 });
  });
  it("8. provider invoice found but registration fails: transient stays provider_created and recovers with NO Stripe call; a ledger needs_review outcome is surfaced", async () => {
    const { stripe, store, deps } = setup();
    store.registerFail = { code: "registration_failed", retryable: true };
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, retryable: true });
    expect(first(store).state).toBe("provider_created");
    const calls = stripe.calls.length;
    store.registerFail = null;
    expect((await resumeIntent(firstId(store), SYS, deps)).ok).toBe(true);
    expect(stripe.calls.length).toBe(calls);
    const b = setup();
    b.store.needsReviewOnRegister = true;
    expect(await createHostedInvoice(req(), b.deps)).toMatchObject({ ok: false, code: "needs_review" });
    const c = setup();
    c.store.registerFail = { code: "registration_failed", retryable: false };
    expect(await createHostedInvoice(req(), c.deps)).toMatchObject({ ok: false, code: "registration_failed", retryable: false });
    expect(first(c.store).state).toBe("needs_review");
  });
  it("9. provider invoice account / ownership mismatch => needs_review, never registered", async () => {
    // ledger account differs from the studio record: nothing sent
    const a = setup();
    a.store.accounts[STUDIO_A] = ACCT_B;
    expect(await createHostedInvoice(req(), a.deps)).toMatchObject({ ok: false, code: "stripe_account_unavailable" });
    expect(a.stripe.calls).toEqual([]);
    // the studio reconnected a different account between begin and recovery
    const b = setup();
    b.stripe.failNext = netErr();
    await createHostedInvoice(req(), b.deps);
    b.store.accounts[STUDIO_A] = "acct_NEW999";
    const r = await resumeIntent(firstId(b.store), SYS, { ...b.deps, supabase: fakeSupabase({ [STUDIO_A]: { acct: "acct_NEW999" } }) });
    expect(r).toMatchObject({ ok: false, code: "stripe_account_unavailable" });
    expect(b.stripe.createCount).toBe(0);
    // customer on the returned invoice is not the trusted customer
    const c = setup();
    const orig = c.stripe.createDraftInvoice.bind(c.stripe);
    c.stripe.createDraftInvoice = async (x) => ({ ...(await orig(x)), customer: "cus_someone_else" }) as never;
    expect(await createHostedInvoice(req(), c.deps)).toMatchObject({ code: "stripe_response_invalid" });
    expect(first(c.store).state).toBe("needs_review");
    expect(c.store.log).not.toContain("register");
  });
  it("10. operator path: a flagged-for-review intent is never resumed, replayed or swept", async () => {
    const { stripe, store, deps } = setup();
    stripe.failNext = netErr();
    await createHostedInvoice(req(), deps);
    await store.flagReview({ intentId: firstId(store), studioId: STUDIO_A, reasonCode: "operator_review" });
    expect(first(store).state).toBe("needs_review");
    const calls = stripe.calls.length;
    expect(await resumeIntent(firstId(store), SYS, deps)).toMatchObject({ ok: false, code: "needs_review" });
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "needs_review" });
    expect(await sweepRecoverableIntents(deps)).toMatchObject({ examined: 0 });
    expect(stripe.calls.length).toBe(calls);
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
  it("a second invoice for the same object under a new requestKey is refused while one is live", async () => {
    const { stripe, deps } = setup();
    await createHostedInvoice(req(), deps);
    expect(await createHostedInvoice(req(actorA, "bo-1", "req-key-0002"), deps)).toMatchObject({ ok: false, code: "intent_payload_conflict" });
    await createHostedInvoice(req(actorA, "bo-2", "req-key-0002"), deps);
    expect(stripe.createCount).toBe(2);
  });
  it("fake stripe itself rejects same key with a different payload", async () => {
    const s = new FakeStripe();
    const p = { customer: "cus_1", collection_method: "send_invoice", days_until_due: 1, currency: "usd", auto_advance: false, metadata: {} } as never;
    await s.createDraftInvoice({ stripeAccount: ACCT_A, idempotencyKey: "k", params: p });
    await expect(s.createDraftInvoice({ stripeAccount: ACCT_A, idempotencyKey: "k", params: { ...(p as object), days_until_due: 2 } as never })).rejects.toMatchObject({ type: "StripeIdempotencyError" });
  });
});

describe("failure classification", () => {
  it("permanent rejection fails the intent; later resume / retry are refused without another call", async () => {
    const { stripe, store, deps } = setup();
    stripe.failNext = permErr();
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "stripe_rejected", retryable: false });
    expect(first(store).state).toBe("failed");
    const n = stripe.calls.length;
    expect(await resumeIntent(firstId(store), SYS, deps)).toMatchObject({ code: "intent_failed" });
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "intent_failed" });
    expect(stripe.calls.length).toBe(n);
  });
  it("a permanent failure after the draft exists keeps the invoice id and escalates instead of freeing the object", async () => {
    const { stripe, store, deps } = setup();
    stripe.failAfterCreate = permErr();
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "stripe_rejected", retryable: false });
    expect(first(store).stripeInvoiceId).toBe("in_fake1");
    expect(first(store).state).toBe("needs_review");
  });
  it("never returns provider or database text", async () => {
    const { stripe, deps } = setup();
    stripe.failNext = Object.assign(new Error("SECRET-PROVIDER-TEXT sk_live_abc"), { type: "StripeAPIError", statusCode: 500 });
    expect(JSON.stringify(await createHostedInvoice(req(), deps))).not.toMatch(/SECRET|sk_live/);
  });
  it("resume of a provider_created intent re-checks livemode against the deployment (review, not register)", async () => {
    const { stripe, store, deps } = setup();
    store.registerFail = { code: "registration_failed", retryable: true };
    await createHostedInvoice(req(), deps);
    store.registerFail = null;
    expect(await resumeIntent(firstId(store), SYS, { ...deps, expectedLivemode: true })).toMatchObject({ code: "livemode_mismatch" });
    expect(first(store).state).toBe("needs_review");
    expect(stripe.createCount).toBe(1);
  });
  it("a permanent failure on an intent with an unknown outcome escalates to review instead of failing it", async () => {
    const { store, deps, stripe } = setup();
    stripe.failNext = netErr();
    await createHostedInvoice(req(), deps); // unknown recorded
    stripe.failNext = permErr();
    // recovery replay gets a permanent rejection
    expect(await resumeIntent(firstId(store), SYS, deps)).toMatchObject({ ok: false, code: "stripe_rejected" });
    expect(first(store).state).toBe("needs_review");
  });
  it("a permanent registration refusal escalates", async () => {
    const { store, deps } = setup();
    store.registerFail = { code: "registration_failed", retryable: false };
    await createHostedInvoice(req(), deps);
    expect(first(store).state).toBe("needs_review");
  });
});

describe("M3 decisions: draft-only, customer", () => {
  const profileSpec = { ...SPEC, stripeCustomerId: undefined, customerProfile: { clientRef: "client-1", name: "Pat Dancer", email: "pat@example.com" } };
  const profDeps = () => setup({ resolvers: { event_fee: ownedResolver({ "bo-1": STUDIO_A }, profileSpec as never) } });
  it("creates the Stripe customer in the connected account under the intent key, then the draft for that customer", async () => {
    const { stripe, deps } = profDeps();
    expect((await createHostedInvoice(req(), deps)).ok).toBe(true);
    expect(stripe.calls.map((c) => c.op)).toEqual(["customer", "create", "lines"]);
    expect(stripe.calls[0].account).toBe(ACCT_A);
    expect(stripe.calls[0].key.endsWith(":customer")).toBe(true);
    expect((stripe.calls[1].params as { customer: string }).customer).toBe([...stripe.customers.values()][0].id);
  });
  it("customer creation is idempotent across a crash: recovery yields one customer and one invoice", async () => {
    const { stripe, store, deps } = profDeps();
    stripe.failNext = netErr(); // crash after the customer exists, before the invoice request
    await createHostedInvoice(req(), deps);
    expect(stripe.customers.size).toBe(1);
    expect(await resumeIntent(firstId(store), SYS, deps)).toMatchObject({ ok: true });
    expect(stripe.customers.size).toBe(1);
    expect(stripe.createCount).toBe(1);
  });
  it("customer failures: ambiguous => outcome_unknown (no retry); livemode-forged customer => review", async () => {
    let c = profDeps();
    c.stripe.failCustomer = netErr();
    expect(await createHostedInvoice(req(), c.deps)).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(c.stripe.createCount).toBe(0);
    c = profDeps();
    c.stripe.livemode = true;
    expect(await createHostedInvoice(req(), c.deps)).toMatchObject({ ok: false, code: "stripe_response_invalid" });
    expect(c.stripe.createCount).toBe(0);
    expect(first(c.store).state).toBe("needs_review");
  });
  it("spec must have exactly one of stripeCustomerId / customerProfile, and a valid profile", async () => {
    for (const bad of [{ ...SPEC, customerProfile: { clientRef: "c1", name: "x" } }, { ...profileSpec, customerProfile: { clientRef: "bad ref", name: "x" } }, { ...profileSpec, customerProfile: { clientRef: "c1", name: " " } }, { ...profileSpec, customerProfile: { clientRef: "c1", name: "x", email: "no-at" } }, { ...SPEC, stripeCustomerId: undefined }]) {
      const { stripe, deps } = setup({ resolvers: { event_fee: ownedResolver({ "bo-1": STUDIO_A }, bad as never) } });
      expect(await createHostedInvoice(req(), deps)).toMatchObject({ code: "invalid_invoice_spec" });
      expect(stripe.calls).toEqual([]);
    }
  });
  it("success results never carry a payment link", async () => {
    const { deps } = setup();
    expect(JSON.stringify(await createHostedInvoice(req(), deps))).not.toMatch(/url|https?:/i);
  });
});

describe("resume authorization and sweep", () => {
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
  it("sweep is bounded and resumes only recoverable intents through the DB claim", async () => {
    const { stripe, store, deps } = setup();
    for (let i = 0; i < 3; i++) {
      stripe.failNext = netErr();
      await createHostedInvoice(req(actorA, `bo-${i + 1}`, `req-key-000${i}`), deps);
    }
    expect(store.rows.size).toBe(3);
    expect(await sweepRecoverableIntents(deps, { limit: 2 })).toMatchObject({ examined: 2, registered: 2, disabled: false });
    expect(store.claims.granted).toBe(2);
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
    expect(first(store).studioId).toBe(STUDIO_A);
    expect(stripe.createCount).toBe(1);
  });
});

describe("second review (P1/P2) regressions", () => {
  it("P1-1: review is flagged BEFORE the id is recorded; if the flag cannot be confirmed the invoice is never made registerable", async () => {
    const { stripe, store, deps } = setup();
    store.flagFail = true;
    const orig = stripe.createDraftInvoice.bind(stripe);
    stripe.createDraftInvoice = async (a) => ({ ...(await orig(a)), customer: "cus_other" }) as never;
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "stripe_response_invalid" });
    expect(first(store).state).toBe("pending"); // not provider_created, so a later sweep can never register the mismatched invoice
    expect(store.log).not.toContain("mark");
    expect(store.log).not.toContain("register");
  });
  it("P1-2: an ambiguous or retryable end AFTER the draft id is known keeps the id on a needs_review intent", async () => {
    for (const err of [netErr(), Object.assign(new Error("rl"), { type: "StripeRateLimitError", statusCode: 429 })]) {
      const { stripe, store, deps } = setup();
      stripe.failAfterCreate = err;
      const r = await createHostedInvoice(req(), deps);
      expect(r.ok).toBe(false);
      expect(first(store).state).toBe("needs_review");
      expect(first(store).stripeInvoiceId).toBe("in_fake1");
      expect(store.log).not.toContain("register");
    }
  });
  it("P1-2: if the ledger refuses to record the id on the success path the intent is held for review with the id", async () => {
    const { store, deps } = setup();
    store.markFail = true;
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "registration_unavailable" });
    expect(first(store).state).toBe("needs_review");
  });
  it("P1-3: a 'permanent' answer on a REPLAY never frees the object; idempotency-key reuse always goes to review", async () => {
    const forbidden = Object.assign(new Error("403"), { type: "StripePermissionError", statusCode: 403 });
    const { stripe, store, deps } = setup();
    stripe.failNext = netErr();
    await createHostedInvoice(req(), deps); // unknown recorded
    stripe.failNext = forbidden;
    expect(await resumeIntent(firstId(store), SYS, deps)).toMatchObject({ ok: false, code: "stripe_rejected" });
    expect(first(store).state).toBe("needs_review");
    const b = setup();
    b.stripe.failNext = Object.assign(new Error("idem"), { type: "StripeIdempotencyError", statusCode: 400 });
    await createHostedInvoice(req(), b.deps);
    expect(first(b.store).state).toBe("needs_review");
    expect(b.store.log.some((l) => l.startsWith("fail:"))).toBe(false);
    // replay through begin 'existing' is also a replay
    const c = setup();
    c.stripe.failNext = Object.assign(new Error("rl"), { type: "StripeRateLimitError", statusCode: 429 });
    await createHostedInvoice(req(), c.deps);
    c.stripe.failNext = forbidden;
    await createHostedInvoice(req(), c.deps);
    expect(first(c.store).state).toBe("needs_review");
  });
  it("P2-1: begin's register_only outcome finishes registration without any Stripe call", async () => {
    const { stripe, store, deps } = setup();
    store.registerFail = { code: "registration_failed", retryable: true };
    await createHostedInvoice(req(), deps);
    store.registerFail = null;
    const calls = stripe.calls.length;
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: true });
    expect(stripe.calls.length).toBe(calls);
  });
  it("P2-2: if outcome_unknown cannot be recorded the intent is held for review", async () => {
    const { stripe, store, deps } = setup();
    store.recordFail = true;
    stripe.failNext = netErr();
    expect(await createHostedInvoice(req(), deps)).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(first(store).state).toBe("needs_review");
  });
  it("P2-4: recovery dead ends (account changed, object gone, resolver missing) go to the review queue", async () => {
    const mk = async () => { const x = setup(); x.stripe.failNext = netErr(); await createHostedInvoice(req(), x.deps); return x; };
    let x = await mk();
    await resumeIntent(firstId(x.store), SYS, { ...x.deps, supabase: fakeSupabase({ [STUDIO_A]: { acct: "acct_NEW999" } }) });
    expect(first(x.store).state).toBe("needs_review");
    x = await mk();
    await resumeIntent(firstId(x.store), SYS, { ...x.deps, resolvers: { event_fee: ownedResolver({}) } });
    expect(first(x.store).state).toBe("needs_review");
    x = await mk();
    await resumeIntent(firstId(x.store), SYS, { ...x.deps, resolvers: {} });
    expect(first(x.store).state).toBe("needs_review");
    expect(x.stripe.createCount).toBe(0);
  });
});

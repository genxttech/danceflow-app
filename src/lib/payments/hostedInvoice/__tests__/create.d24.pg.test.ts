// D24 M3-B: the REAL orchestrator + REAL createSupabaseIntentStore against the REAL M1/M2-C/M3-A SQL in a DISPOSABLE Postgres container,
// with an OFFLINE fake Stripe. Skipped unless D24_M3B_PG_CONTAINER names that container; scripts/qa/d24-m3b-orchestrator.sh creates it.
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createHostedInvoice, createSupabaseIntentStore, resumeIntent, type AuthorizedBillingActor, type CreateDeps, type InvoiceSpecResolver } from "../create";
import { FakeStripe, SPEC } from "./createFakes";

vi.mock("server-only", () => ({}));

const CONTAINER = process.env.D24_M3B_PG_CONTAINER;
const A = "00000000-0000-0000-0000-00000000005a";
const B = "00000000-0000-0000-0000-00000000005b";
const NOACCT = "00000000-0000-0000-0000-00000000005c";
const U = "00000000-0000-0000-0000-0000000000a1";
const actor = (studioId: string): AuthorizedBillingActor => ({ verified: true, studioId, userId: U, canManageBilling: true });
const req = (studioId: string, id: string, requestKey = "req-key-pg-0001") => ({ actor: actor(studioId), businessObjectType: "event_fee", businessObjectId: id, requestKey });

type Res = { out: string; code: string | null; msg?: string };
function psql(sql: string, vars: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const args = ["exec", "-i", CONTAINER!, "psql", "-U", "postgres", "-qAt", "-v", "VERBOSITY=verbose"];
    for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
    const p = spawn("docker", args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", () => resolve({ out: out.trim(), code: /ERROR:\s+(\w{5}):/.exec(err)?.[1] ?? null, msg: /ERROR:\s+\w{5}:\s*(.*)/.exec(err)?.[1] ?? "" }));
    p.stdin.end(sql);
  });
}
const num = async (sql: string, vars: Record<string, string> = {}) => Number((await psql(sql, vars)).out);

// PostgREST-shaped adapter over psql. Literals are passed as psql variables, never interpolated into SQL text.
const failRegisterOnce = { on: false };
const supabase = {
  async rpc(name: string, a: Record<string, unknown>) {
    if (!/^d24_intent_[a-z_]+$/.test(name)) throw new Error("unexpected rpc " + name);
    if (name === "d24_intent_register" && failRegisterOnce.on) { failRegisterOnce.on = false; return { data: null, error: { code: "57014" } }; }
    const keys = Object.keys(a);
    const vars: Record<string, string> = {};
    const parts = keys.map((k, i) => {
      const v = a[k];
      if (v == null) return `${k} => null`;
      vars[`v${i}`] = String(v);
      return `${k} => :'v${i}'`;
    });
    const r = await psql(`select coalesce(public.${name}(${parts.join(", ")})::text, 'null');`, vars);
    if (r.code) return { data: null, error: { code: r.code, message: r.msg ?? "" } };
    return { data: JSON.parse(r.out), error: null };
  },
  from(table: string) {
    let col = "";
    let val = "";
    const q = {
      select: () => q,
      eq: (c: string, v: string) => ((col = c), (val = v), q),
      maybeSingle: async () => {
        if (!/^(studios|hosted_invoice_creation_intents)$/.test(table) || !/^(id)$/.test(col)) throw new Error("unsupported " + table + "." + col);
        const r = await psql(`select coalesce((select to_jsonb(t) from public.${table} t where id = :'v'::uuid)::text, '');`, { v: val });
        return { data: r.out ? JSON.parse(r.out) : null, error: r.code ? { code: r.code } : null };
      },
    };
    return q;
  },
} as never;

const rawResolver: InvoiceSpecResolver = async ({ studioId, businessObjectId }) => {
  const r = await psql("select count(*) from public.qa_business_objects where id = :'i' and studio_id = :'s'::uuid;", { i: businessObjectId, s: studioId });
  return r.out === "1" ? SPEC : null;
};
const permissiveResolver: InvoiceSpecResolver = async () => SPEC; // forged TS resolver: SQL must still refuse foreign objects

function deps(over: Partial<CreateDeps> = {}) {
  const stripe = new FakeStripe();
  stripe.prefix = `pg${Math.random().toString(36).slice(2, 10)}x`;
  return { stripe, deps: { supabase, stripe, store: createSupabaseIntentStore(supabase), expectedLivemode: false, env: { D24_HOSTED_INVOICE_CREATION: "on" }, resolvers: { event_fee: rawResolver }, ...over } as CreateDeps };
}
const registryRow = (inv: string) => psql("select studio_id || '/' || stripe_account_id from public.hosted_invoice_registry where stripe_invoice_id = :'i';", { i: inv });

describe.skipIf(!CONTAINER)("orchestrator against real Postgres (M1 + M2-C + M3-A)", { timeout: 300_000 }, () => {
  it("setup fixtures", async () => {
    const r = await psql(`
      insert into public.studios (id, name, stripe_connected_account_id) values ('${A}','A','acct_studioA'),('${B}','B','acct_studioB'),('${NOACCT}','C',null);
      insert into public.qa_business_objects values ${Array.from({ length: 20 }, (_, i) => `('bo-a${i + 1}','${A}')`).join(",")},('bo-b1','${B}'),('bo-n1','${NOACCT}');
      select 'ok';`);
    expect(r.out).toBe("ok");
  });

  it("creates a draft, records provider_created, registers under the studio's own account", async () => {
    const { stripe, deps: d } = deps();
    const r = await createHostedInvoice(req(A, "bo-a1"), d);
    expect(r).toMatchObject({ ok: true, state: "registered" });
    if (!r.ok) return;
    expect((await registryRow(r.stripeInvoiceId)).out).toBe(`${A}/acct_studioA`);
    expect(stripe.calls[0].account).toBe("acct_studioA");
    expect(await num("select count(*) from public.hosted_invoice_creation_intents where studio_id = :'s'::uuid and status = 'registered';", { s: A })).toBeGreaterThanOrEqual(1);
  });

  it("creation infers no settlement: no payments, credit notes or paid facts exist for the new invoice", async () => {
    const { deps: d } = deps();
    const r = await createHostedInvoice(req(A, "bo-a2"), d);
    if (!r.ok) throw new Error("create failed");
    expect(await num("select count(*) from public.hosted_invoice_payments p join public.hosted_invoices i on i.id = p.invoice_row_id where i.stripe_invoice_id = :'i';", { i: r.stripeInvoiceId })).toBe(0);
    expect(await num("select count(*) from public.hosted_invoices where stripe_invoice_id = :'i' and coalesce(paid_cents,0) > 0;", { i: r.stripeInvoiceId }).catch(() => 0)).toBe(0);
  });

  it("8 concurrent identical requests produce exactly one Stripe invoice, one intent, one registry row", async () => {
    const { stripe, deps: d } = deps();
    const rs = await Promise.all(Array.from({ length: 8 }, () => createHostedInvoice(req(A, "bo-a3"), d)));
    const oks = rs.filter((r) => r.ok);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(stripe.createCount).toBe(1);
    expect(new Set(oks.map((r) => (r.ok ? r.stripeInvoiceId : ""))).size).toBe(1);
    expect(await num("select count(*) from public.hosted_invoice_creation_intents where business_object_id = 'bo-a3';")).toBe(1);
    // whatever lost the race can be finished by resume without a second invoice
    for (const r of rs) if (!r.ok && r.intentId) await resumeIntent(r.intentId, { system: "d24_recovery" }, d);
    expect(stripe.createCount).toBe(1);
    expect(await num("select count(*) from public.hosted_invoice_registry r join public.hosted_invoice_creation_intents i on i.registry_id = r.id where i.business_object_id = 'bo-a3';")).toBe(1);
  });

  it("cross-tenant: A cannot invoice B's object, even with a forged permissive TS resolver (SQL ownership refuses); no Stripe call", async () => {
    const { stripe, deps: d } = deps();
    expect(await createHostedInvoice(req(A, "bo-b1"), d)).toMatchObject({ ok: false, code: "business_object_not_owned" });
    const f = deps({ resolvers: { event_fee: permissiveResolver } });
    expect(await createHostedInvoice(req(A, "bo-b1", "req-key-pg-0002"), f.deps)).toMatchObject({ ok: false });
    expect(stripe.calls).toEqual([]);
    expect(f.stripe.calls).toEqual([]);
    expect(await num("select count(*) from public.hosted_invoice_creation_intents where business_object_id = 'bo-b1';")).toBe(0);
  });

  it("studio without a (valid) connected account is refused with no ledger row", async () => {
    const { stripe, deps: d } = deps();
    expect(await createHostedInvoice(req(NOACCT, "bo-n1"), d)).toMatchObject({ ok: false, code: "stripe_account_unavailable" });
    expect(stripe.calls).toEqual([]);
    expect(await num("select count(*) from public.hosted_invoice_creation_intents where business_object_id = 'bo-n1';")).toBe(0);
  });

  it("livemode forgery: a live response in a test deployment is refused; the intent goes to needs_review and nothing is registered", async () => {
    const { stripe, deps: d } = deps();
    stripe.livemode = true;
    expect(await createHostedInvoice(req(A, "bo-a4"), d)).toMatchObject({ ok: false, code: "livemode_mismatch" });
    expect(await num("select count(*) from public.hosted_invoice_creation_intents where business_object_id = 'bo-a4' and status = 'needs_review';")).toBe(1);
    expect(await num("select count(*) from public.hosted_invoice_registry r join public.hosted_invoice_creation_intents i on i.stripe_invoice_id = r.stripe_invoice_id where i.business_object_id = 'bo-a4';")).toBe(0);
  });

  it("the SQL key-mode check also refuses a forged client claim (store level)", async () => {
    const { deps: d } = deps();
    const b = await d.store.begin({ studioId: A, createdBy: U, idempotencyKey: "d24inv_pg_forged_key_0001", requestFingerprint: "a".repeat(64), businessObjectType: "event_fee", businessObjectId: "bo-a5" });
    if (!b.ok) throw new Error("begin failed");
    expect(await d.store.markProviderCreated({ intentId: b.intent.id, studioId: A, stripeInvoiceId: "in_forged1", livemode: true, keyLivemode: false, stripeAccountId: "acct_studioA" })).toBe(false);
    expect(await d.store.markProviderCreated({ intentId: b.intent.id, studioId: A, stripeInvoiceId: "in_forged1", livemode: false, keyLivemode: false, stripeAccountId: "acct_studioB" })).toBe(false);
    expect(await d.store.markProviderCreated({ intentId: b.intent.id, studioId: B, stripeInvoiceId: "in_forged1", livemode: false, keyLivemode: false, stripeAccountId: "acct_studioA" })).toBe(false);
    expect((await d.store.get(b.intent.id))?.state).toBe("pending");
  });

  it("Stripe success then registration failure: provider_created; resume registers with NO second invoice", async () => {
    const { stripe, deps: d } = deps();
    failRegisterOnce.on = true;
    const r1 = await createHostedInvoice(req(A, "bo-a6"), d);
    expect(r1).toMatchObject({ ok: false, retryable: true });
    if (r1.ok || !r1.intentId) throw new Error("expected intent id");
    expect(await num("select count(*) from public.hosted_invoice_creation_intents where id = :'i'::uuid and status = 'provider_created';", { i: r1.intentId })).toBe(1);
    const calls = stripe.calls.length;
    expect(await resumeIntent(r1.intentId, { system: "d24_recovery" }, d)).toMatchObject({ ok: true });
    expect(stripe.calls.length).toBe(calls);
    expect(stripe.createCount).toBe(1);
  });

  it("crash before the Stripe call: resume creates exactly one invoice, and a foreign studio cannot resume it", async () => {
    const { stripe, deps: d } = deps();
    stripe.failNext = Object.assign(new Error("net"), { type: "StripeConnectionError" });
    const r1 = await createHostedInvoice(req(A, "bo-a7"), d);
    expect(r1).toMatchObject({ ok: false, code: "outcome_unknown" });
    if (r1.ok || !r1.intentId) throw new Error("expected intent id");
    expect(await resumeIntent(r1.intentId, actor(B), d)).toMatchObject({ ok: false, code: "intent_not_found" });
    expect(stripe.createCount).toBe(0);
    expect(await resumeIntent(r1.intentId, { system: "d24_recovery" }, d)).toMatchObject({ ok: true });
    expect(stripe.createCount).toBe(1);
  });

  it("webhook before registration: the paid event arrives first (stays unmatched), registration adopts it; creation itself recorded nothing paid", async () => {
    const { stripe, deps: d } = deps();
    failRegisterOnce.on = true;
    const r1 = await createHostedInvoice(req(A, "bo-a8"), d);
    if (r1.ok || !r1.intentId) throw new Error("expected provider_created intent");
    const inv = [...stripe.invoices.keys()][0];
    const payload = JSON.stringify({ invoice_id: inv, object_id: "inpay_pg1", status: "paid", amount_requested: 5500, amount_paid: 5500, currency: "usd" });
    await psql("select public.claim_payment_provider_event('stripe','evt_m3b_1','x','h1','00000000-0000-0000-0000-0000000000c1');");
    const applied = await psql("select public.d24_apply_event('evt_m3b_1','00000000-0000-0000-0000-0000000000c1','invoice_payment.paid',30000,'acct_studioA',false,'h1','invoice_payment',:'p'::jsonb)::text;", { p: payload });
    expect(applied.code).toBeNull();
    const res = await resumeIntent(r1.intentId, { system: "d24_recovery" }, d);
    expect(res).toMatchObject({ ok: true, adoptedExistingFacts: true });
    expect((await registryRow(inv)).out).toBe(`${A}/acct_studioA`);
  });

  it("forged webhook metadata / a foreign-account event cannot attribute a registered invoice to another studio", async () => {
    const { deps: d } = deps();
    const r = await createHostedInvoice(req(A, "bo-a9"), d);
    if (!r.ok) throw new Error("create failed");
    const payload = JSON.stringify({ invoice_id: r.stripeInvoiceId, object_id: "inpay_pg2", status: "paid", amount_requested: 5500, amount_paid: 5500, currency: "usd", metadata: { studio_id: B } });
    await psql("select public.claim_payment_provider_event('stripe','evt_m3b_2','x','h2','00000000-0000-0000-0000-0000000000c1');");
    await psql("select public.d24_apply_event('evt_m3b_2','00000000-0000-0000-0000-0000000000c1','invoice_payment.paid',30000,'acct_studioB',false,'h2','invoice_payment',:'p'::jsonb)::text;", { p: payload });
    expect((await registryRow(r.stripeInvoiceId)).out).toBe(`${A}/acct_studioA`);
    expect(await num("select count(*) from public.hosted_invoices where stripe_invoice_id = :'i' and studio_id = :'b'::uuid;", { i: r.stripeInvoiceId, b: B }).catch(() => 0)).toBe(0);
  });

  const age = (id: string, interval: string) => psql("alter table public.hosted_invoice_creation_intents disable trigger hosted_invoice_intents_guard_trg; update public.hosted_invoice_creation_intents set created_at = now() - interval '" + interval + "' where id = :'i'::uuid; alter table public.hosted_invoice_creation_intents enable trigger hosted_invoice_intents_guard_trg;", { i: id });
  const status = async (id: string) => (await psql("select status || '/' || outcome_unknown::text from public.hosted_invoice_creation_intents where id = :'i'::uuid;", { i: id })).out;
  const lost = () => Object.assign(new Error("timeout"), { type: "StripeConnectionError" });

  it("4. same key, changed parameters: the ledger refuses (fingerprint mismatch); no new intent, no Stripe call", async () => {
    const { stripe, deps: d } = deps();
    await createHostedInvoice(req(A, "bo-a10", "req-key-pg-0010"), d);
    const calls = stripe.calls.length;
    const changed = deps({ resolvers: { event_fee: async ({ studioId, businessObjectId }) => (businessObjectId === "bo-a10" && studioId === A ? { ...SPEC, description: "changed" } : null) } });
    expect(await createHostedInvoice(req(A, "bo-a10", "req-key-pg-0010"), changed.deps)).toMatchObject({ ok: false, code: "request_fingerprint_mismatch" });
    expect(changed.stripe.calls).toEqual([]);
    expect(stripe.calls.length).toBe(calls);
    expect(await num("select count(*) from public.hosted_invoice_creation_intents where business_object_id = 'bo-a10';")).toBe(1);
  });

  it("6. timeout with unknown result: outcome_unknown is recorded, retries do not call Stripe, DB claim replays the ORIGINAL key once", async () => {
    const { stripe, deps: d } = deps();
    stripe.loseResponseAfterCreate = lost();
    const r1 = await createHostedInvoice(req(A, "bo-a11", "req-key-pg-0011"), d);
    expect(r1).toMatchObject({ ok: false, code: "outcome_unknown" });
    if (r1.ok || !r1.intentId) throw new Error("intent");
    expect(await status(r1.intentId)).toBe("pending/true");
    const calls = stripe.calls.length;
    expect(await createHostedInvoice(req(A, "bo-a11", "req-key-pg-0011"), d)).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(stripe.calls.length).toBe(calls);
    expect(await resumeIntent(r1.intentId, { system: "d24_recovery" }, d)).toMatchObject({ ok: true });
    expect(stripe.createCount).toBe(1);
    expect(await status(r1.intentId)).toBe("registered/false");
  });

  it("5. concurrent workers recovering one intent: one lease holder replays, the rest are told to wait; one provider invoice", async () => {
    const { stripe, deps: d } = deps();
    stripe.failNext = lost();
    const r1 = await createHostedInvoice(req(A, "bo-a12", "req-key-pg-0012"), d);
    if (r1.ok || !r1.intentId) throw new Error("intent");
    const rs = await Promise.all(Array.from({ length: 6 }, () => resumeIntent(r1.intentId!, { system: "d24_recovery" }, d)));
    expect(rs.filter((x) => x.ok).length).toBeGreaterThanOrEqual(1);
    expect(rs.filter((x) => !x.ok && x.code === "recovery_in_progress").length + rs.filter((x) => x.ok).length).toBe(6);
    expect(stripe.createCount).toBe(1);
  });

  it("7. recovery after the safe window: needs_review, NO replay, nothing sent to Stripe", async () => {
    const { stripe, deps: d } = deps();
    stripe.loseResponseAfterCreate = lost();
    const r1 = await createHostedInvoice(req(A, "bo-a13", "req-key-pg-0013"), d);
    if (r1.ok || !r1.intentId) throw new Error("intent");
    await age(r1.intentId, "13 hours");
    const calls = stripe.calls.length;
    expect(await resumeIntent(r1.intentId, { system: "d24_recovery" }, d)).toMatchObject({ ok: false, code: "needs_review" });
    expect(stripe.calls.length).toBe(calls);
    expect((await status(r1.intentId)).startsWith("needs_review")).toBe(true);
    expect(await createHostedInvoice(req(A, "bo-a13", "req-key-pg-0013"), d)).toMatchObject({ ok: false, code: "needs_review" });
    expect(stripe.calls.length).toBe(calls);
    expect(await num("select count(*) from public.hosted_invoice_registry where stripe_invoice_id = :'i';", { i: [...stripe.invoices.keys()][0] })).toBe(0);
  });

  it("9. the studio's account changed after begin: recovery is denied by the DB (needs_review), nothing sent", async () => {
    const { stripe, deps: d } = deps();
    stripe.failNext = lost();
    const r1 = await createHostedInvoice(req(A, "bo-a14", "req-key-pg-0014"), d);
    if (r1.ok || !r1.intentId) throw new Error("intent");
    await psql("update public.studios set stripe_connected_account_id = 'acct_studioA2' where id = :'s'::uuid;", { s: A });
    try {
      expect(await resumeIntent(r1.intentId, { system: "d24_recovery" }, d)).toMatchObject({ ok: false });
      expect(stripe.createCount).toBe(0);
    } finally {
      await psql("update public.studios set stripe_connected_account_id = 'acct_studioA' where id = :'s'::uuid;", { s: A });
    }
  });

  it("10. operator/review path: a flagged intent is never resumed or replayed, and is not listed as recoverable", async () => {
    const { stripe, deps: d } = deps();
    stripe.failNext = lost();
    const r1 = await createHostedInvoice(req(A, "bo-a15", "req-key-pg-0015"), d);
    if (r1.ok || !r1.intentId) throw new Error("intent");
    await d.store.flagReview({ intentId: r1.intentId, studioId: A, reasonCode: "operator_review" });
    expect((await status(r1.intentId)).startsWith("needs_review")).toBe(true);
    expect(await resumeIntent(r1.intentId, { system: "d24_recovery" }, d)).toMatchObject({ ok: false, code: "needs_review" });
    expect((await d.store.listRecoverable({ limit: 50, olderThanMinutes: 1 })).some((x) => x.id === r1.intentId)).toBe(false);
    expect(stripe.createCount).toBe(0);
  });
});

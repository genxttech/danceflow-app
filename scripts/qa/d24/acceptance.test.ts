import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { AsyncLocalStorage } from "node:async_hooks";
import { q, rpc, as, stackLayers } from "./pgBridge";

/**
 * D24 M2-D acceptance: the REAL webhook route (real Stripe signature verification, real PAY-WH-1 claim/complete functions) driven
 * with offline signed fixtures against a REAL Postgres holding the D24 migrations (disposable container from scripts/qa/d24-stack.sh).
 * Only the Supabase transport is replaced (rpc -> docker exec psql as role service_role). No network, no Stripe API, no hosted DB.
 * When the stack is not running the whole suite is reported as skipped (BLOCKED), never as passed.
 */

const LAYERS = stackLayers();
const STACK = LAYERS !== null;
const has = (layer: string) => LAYERS?.includes(layer) ?? false;

const PLATFORM_SECRET = "whsec_d24_m2d_platform_synthetic";
const CONNECT_SECRET = "whsec_d24_m2d_connect_synthetic";
const realStripe = new Stripe("sk_test_d24_m2d_not_a_real_key");
const sigStore = new AsyncLocalStorage<{ sig: string | null }>();

vi.mock("next/headers", () => ({ headers: async () => ({ get: (n: string) => (n === "stripe-signature" ? (sigStore.getStore()?.sig ?? null) : null) }) }));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => ({ webhooks: realStripe.webhooks }) }));
vi.mock("@supabase/supabase-js", async () => {
  const bridge = await import("./pgBridge");
  return {
    createClient: () => ({
      rpc: (fn: string, args: Record<string, unknown>) => bridge.rpc(fn, args),
      // every non-D24 table access in the route is answered empty; the D24 path must never use it
      from: () => {
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "is", "neq", "order", "limit", "gte", "lte", "not", "or", "ilike"]) chain[m] = () => chain;
        chain.maybeSingle = chain.single = async () => ({ data: null, error: null });
        chain.insert = chain.update = chain.upsert = chain.delete = () => chain;
        chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
        return chain;
      },
    }),
  };
});

const route = STACK ? await import("@/app/api/payments/webhook/route") : null;
type HeaderOptions = Parameters<typeof realStripe.webhooks.generateTestHeaderString>[0];

// ---------------------------------------------------------------------------------------------------------------------------
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, "x");
let seq = 0;
const nextId = () => `${RUN}${(++seq).toString(36)}`;
const SA = "00000000-0000-0000-0000-0000000d245a";
const SB = "00000000-0000-0000-0000-0000000d245b";
let clock = 1_800_000_000;

const invoiceObj = (id: string, status: "void" | "uncollectible", extra: Record<string, unknown> = {}) => ({
  id, object: "invoice", status, total: 5000, amount_due: 5000, amount_paid: 0, amount_remaining: 5000, currency: "usd", customer_email: "pii-m2d@example.com", ...extra,
});
const payObj = (id: string, invoice: string, amount = 5000, status = "paid") => ({ id, object: "invoice_payment", invoice, status, amount_requested: amount, amount_paid: status === "paid" ? amount : null, currency: "usd" });
const noteObj = (id: string, invoice: string, status = "issued") => ({ id, object: "credit_note", invoice, status, total: 700, currency: "usd", type: "post_payment" });

type Env = { id: string; body: string };
type EnvOpts = { id?: string; account?: string; created?: number; livemode?: boolean };
function envelope(type: string, object: Record<string, unknown>, o: EnvOpts = {}): Env {
  const id = o.id ?? `evt_${nextId()}`;
  const body = JSON.stringify({
    id, object: "event", type, api_version: "2026-03-25.dahlia", created: o.created ?? ++clock, data: { object }, livemode: o.livemode ?? false,
    pending_webhooks: 1, request: { id: null, idempotency_key: null }, ...(o.account ? { account: o.account } : {}),
  });
  return { id, body };
}
const sign = (body: string, secret = PLATFORM_SECRET) => realStripe.webhooks.generateTestHeaderString({ payload: body, secret } as HeaderOptions);
async function post(body: string, secret = PLATFORM_SECRET, sig: string | null = sign(body, secret)) {
  const res = await sigStore.run({ sig }, () => route!.POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body })));
  return { status: res.status, text: await res.text() };
}
const deliver = async (type: string, object: Record<string, unknown>, o: EnvOpts = {}) => {
  const e = envelope(type, object, o);
  const r = await post(e.body, o.account ? CONNECT_SECRET : PLATFORM_SECRET);
  return { ...r, id: e.id };
};
const claimRow = (eventId: string) => q(`select coalesce(status,'-')||'/'||coalesce(outcome,'-') from public.payment_provider_events where provider_event_id='${eventId}'`);

const inv = (invoiceId: string, expr: string, acct = "") => q(`select ${expr} from public.hosted_invoices where stripe_invoice_id='${invoiceId}' and account_key='${acct}'`);
const register = (studio: string, invoiceId: string, acct: string | null = null) =>
  rpc("d24_register_invoice", { p_studio_id: studio, p_stripe_account_id: acct, p_stripe_invoice_id: invoiceId, p_livemode: false, p_business_object_type: "event_fee", p_business_object_id: `bo-${invoiceId}` });
const factTotals = () =>
  q(`select (select count(*) from public.hosted_invoices)||'/'||(select count(*) from public.hosted_invoice_payments)||'/'||(select count(*) from public.hosted_credit_notes)||'/'||(select count(*) from public.hosted_invoice_source_events)||'/'||(select count(*) from public.hosted_invoice_deferred_events)`);
// M2-C revokes service_role execute on d24_drain_deferred (the bounded, singleton d24_run_drain replaces it), so drain through whatever the loaded stack exposes.
const drain = (n: number) => (has("m2c") ? rpc("d24_run_drain", { p_batch_size: n, p_trigger: "manual" }) : rpc("d24_drain_deferred", { p_limit: n }));
const inList = (xs: string[]) => xs.map((x) => `'${x}'`).join(",");

const MODE = (m: string | undefined) => { if (m === undefined) delete process.env.D24_HOSTED_INVOICE_EVENTS; else process.env.D24_HOSTED_INVOICE_EVENTS = m; };
const D24_TYPES: Array<[string, (id: string) => Record<string, unknown>]> = [
  ["invoice.voided", (i) => invoiceObj(i, "void")],
  ["invoice.marked_uncollectible", (i) => invoiceObj(i, "uncollectible")],
  ["invoice_payment.paid", (i) => payObj(`inpay_${nextId()}`, i)],
  ["credit_note.created", (i) => noteObj(`cn_${nextId()}`, i)],
  ["credit_note.updated", (i) => noteObj(`cn_${nextId()}`, i)],
  ["credit_note.voided", (i) => noteObj(`cn_${nextId()}`, i, "void")],
];

beforeAll(async () => {
  if (!STACK) return;
  await q(`insert into public.studios (id, name) values ('${SA}','Studio A'),('${SB}','Studio B') on conflict do nothing`);
});
beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  process.env.STRIPE_SECRET_KEY = "sk_test_d24_m2d_not_a_real_key";
  MODE(undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network is not allowed in D24 acceptance tests"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); MODE(undefined); });

const suite = describe.skipIf(!STACK);

suite("A. stack sanity (the harness itself is real)", () => {
  it("A1 events are claimed through the real PAY-WH-1 functions and finalized in payment_provider_events", async () => {
    MODE("on");
    const r = await deliver("invoice.voided", invoiceObj(`in_${nextId()}`, "void"));
    expect(r.status).toBe(200);
    expect(await claimRow(r.id)).toBe("processed/d24_applied_unmatched");
  });
  it("A2 the route's database role (service_role) cannot write fact tables directly; anon/authenticated cannot read or call", async () => {
    expect(await as("service_role", `insert into public.hosted_invoice_registry (studio_id,stripe_invoice_id,livemode,business_object_type,business_object_id) values ('${SA}','in_direct',false,'a','b')`)).toMatch(/permission denied/);
    expect(await as("anon", "select count(*) from public.hosted_invoices")).toMatch(/permission denied/);
    expect(await as("authenticated", "select public.d24_apply_event('e',gen_random_uuid(),'invoice.voided',1,null,false,'h','invoice','{}'::jsonb)")).toMatch(/permission denied/);
  });
});

suite("B. D24 OFF (default): d24_not_enabled, nothing stored", () => {
  it.each(D24_TYPES)("B1 %s is acknowledged d24_not_enabled with zero D24 database effect", async (type, mk) => {
    const before = await factTotals();
    const r = await deliver(type, mk(`in_${nextId()}`));
    expect(r.status).toBe(200);
    expect(await claimRow(r.id)).toBe("processed/d24_not_enabled");
    expect(await factTotals()).toBe(before);
  });
  it("B2 an OFF-acknowledged event is NOT recoverable: enabling later and redelivering is 'Already processed' and creates no fact (release rule: defer or on in the same release as the SQL)", async () => {
    const invoice = `in_${nextId()}`;
    const e = envelope("invoice.voided", invoiceObj(invoice, "void"));
    expect((await post(e.body)).status).toBe(200);
    MODE("on");
    const again = await post(e.body);
    expect([again.status, again.text]).toEqual([200, "Already processed"]);
    expect(await q(`select count(*) from public.hosted_invoices where stripe_invoice_id='${invoice}'`)).toBe("0");
  });
  it.each(["", "off", "false", "enabled", "1"])("B3 mode value %j is OFF", async (value) => {
    MODE(value);
    const r = await deliver("invoice.voided", invoiceObj(`in_${nextId()}`, "void"));
    expect(await claimRow(r.id)).toBe("processed/d24_not_enabled");
  });
  it("B4 mode 'ON ' (case/space insensitive) is on", async () => {
    MODE("ON ");
    const r = await deliver("invoice.voided", invoiceObj(`in_${nextId()}`, "void"));
    expect(await claimRow(r.id)).toBe("processed/d24_applied_unmatched");
  });
});

suite("C. signature verification and claim preserved", () => {
  beforeEach(() => MODE("on"));
  it("C1 tampered body, wrong secret, missing and malformed signatures are rejected before any claim or fact", async () => {
    const before = await factTotals();
    const claimsBefore = await q("select count(*) from public.payment_provider_events");
    const e = envelope("invoice.voided", invoiceObj(`in_${nextId()}`, "void"));
    expect((await post(e.body + " ", PLATFORM_SECRET, sign(e.body))).status).toBe(400);
    expect((await post(e.body, PLATFORM_SECRET, sign(e.body, "whsec_wrong"))).status).toBe(400);
    expect((await post(e.body, PLATFORM_SECRET, null)).status).toBe(400);
    expect((await post(e.body, PLATFORM_SECRET, "t=1,v1=deadbeef")).status).toBe(400);
    expect(await factTotals()).toBe(before);
    expect(await q("select count(*) from public.payment_provider_events")).toBe(claimsBefore);
  });
  it("C2 a stale timestamp (replayed old signature) is rejected", async () => {
    const e = envelope("invoice.voided", invoiceObj(`in_${nextId()}`, "void"));
    const old = realStripe.webhooks.generateTestHeaderString({ payload: e.body, secret: PLATFORM_SECRET, timestamp: Math.floor(Date.now() / 1000) - 3600 } as HeaderOptions);
    expect((await post(e.body, PLATFORM_SECRET, old)).status).toBe(400);
    expect(await q(`select count(*) from public.payment_provider_events where provider_event_id='${e.id}'`)).toBe("0");
  });
  it("C3 a Connect-scoped event needs the Connect secret; the platform secret is refused", async () => {
    const invoice = `in_${nextId()}`;
    const bad = envelope("invoice.voided", invoiceObj(invoice, "void"), { account: "acct_m2dconn" });
    expect((await post(bad.body, PLATFORM_SECRET)).status).toBe(400);
    const good = envelope("invoice.voided", invoiceObj(invoice, "void"), { account: "acct_m2dconn" });
    expect((await post(good.body, CONNECT_SECRET)).status).toBe(200);
    expect(await inv(invoice, "stripe_account_id", "acct_m2dconn")).toBe("acct_m2dconn");
    expect(await q(`select count(*) from public.payment_provider_events where provider_event_id='${bad.id}'`)).toBe("0");
  });
  it("C4 a live-mode event on a test key is refused before the claim", async () => {
    const e = envelope("invoice.voided", invoiceObj(`in_${nextId()}`, "void"), { livemode: true });
    expect((await post(e.body)).status).toBe(400);
    expect(await q(`select count(*) from public.payment_provider_events where provider_event_id='${e.id}'`)).toBe("0");
  });
  it("C5 a test-mode event arriving on a live-key deployment is acknowledged but never recorded as a fact", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_d24_m2d_not_a_real_key";
    const before = await factTotals();
    const r = await deliver("invoice.voided", invoiceObj(`in_${nextId()}`, "void"));
    expect(r.status).toBe(200);
    expect(await claimRow(r.id)).toBe("processed/d24_test_mode_ignored");
    expect(await factTotals()).toBe(before);
  });
  it("C6 a structurally impossible object is acknowledged without a fact (no retry storm)", async () => {
    const before = await factTotals();
    const r = await deliver("invoice.voided", { id: "in_bad space", status: "paid" });
    expect(r.status).toBe(200);
    expect(await claimRow(r.id)).toBe("processed/d24_malformed_ignored");
    expect(await factTotals()).toBe(before);
  });
  it("C7 customer PII in the event never reaches any D24 table", async () => {
    await deliver("invoice.voided", invoiceObj(`in_${nextId()}`, "void", { customer_name: "Jane Pii", customer: "cus_pii" }));
    await deliver("invoice_payment.paid", { ...payObj(`inpay_${nextId()}`, `in_${nextId()}`), customer_email: "pii-m2d@example.com" });
    const dump = await q(
      `select coalesce((select string_agg(x::text,' ') from public.hosted_invoices x),'')||coalesce((select string_agg(x::text,' ') from public.hosted_invoice_source_events x),'')||coalesce((select string_agg(x::text,' ') from public.hosted_invoice_payments x),'')||coalesce((select string_agg(x::text,' ') from public.hosted_invoice_status_transitions x),'')||coalesce((select string_agg(x::text,' ') from public.hosted_invoice_deferred_events x),'')`,
    );
    expect(dump.length).toBeGreaterThan(100);
    expect(dump).not.toMatch(/pii-m2d@example\.com|Jane Pii|cus_pii/);
  });
});

suite("D. ordering, adoption, duplicates and replays", () => {
  beforeEach(() => MODE("on"));
  it("D1 event BEFORE registration is kept unmatched (studio null), then registration adopts it", async () => {
    const invoice = `in_${nextId()}`;
    const r = await deliver("invoice.voided", invoiceObj(invoice, "void"));
    expect(r.status).toBe(200);
    expect(await inv(invoice, "coalesce(studio_id::text,'NULL')||'/'||reconciliation_state")).toBe("NULL/unmatched");
    const reg = await register(SA, invoice);
    expect(reg.error).toBeNull();
    expect((reg.data as { adopted_existing_facts: boolean }).adopted_existing_facts).toBe(true);
    expect(await inv(invoice, "studio_id::text")).toBe(SA);
    expect(await inv(invoice, "classification")).toBe("registered");
    expect(await q(`select count(*) from public.hosted_invoice_recon_audit a join public.hosted_invoices i on i.id=a.invoice_row_id where i.stripe_invoice_id='${invoice}' and a.trigger_kind='registration'`)).toBe("1");
  });
  it("D2 registration BEFORE the event: the first event is already attributed", async () => {
    const invoice = `in_${nextId()}`;
    await register(SA, invoice);
    await deliver("invoice.marked_uncollectible", invoiceObj(invoice, "uncollectible"));
    expect(await inv(invoice, "studio_id::text||'/'||status")).toBe(`${SA}/uncollectible`);
  });
  it("D3 sequential duplicate delivery of one event id: 'Already processed', one evidence row, one transition", async () => {
    const invoice = `in_${nextId()}`;
    const e = envelope("invoice.voided", invoiceObj(invoice, "void"));
    expect((await post(e.body)).status).toBe(200);
    const again = await post(e.body);
    expect([again.status, again.text]).toEqual([200, "Already processed"]);
    expect(await q(`select count(*) from public.hosted_invoice_source_events where provider_event_id='${e.id}'`)).toBe("1");
    expect(await q(`select count(*) from public.hosted_invoice_status_transitions where source_event_id='${e.id}'`)).toBe("1");
  });
  it("D4 same event id with DIFFERENT content after processing is acknowledged and changes nothing", async () => {
    const invoice = `in_${nextId()}`;
    const id = `evt_${nextId()}`;
    const first = envelope("invoice.voided", invoiceObj(invoice, "void"), { id });
    expect((await post(first.body)).status).toBe(200);
    const forged = envelope("invoice.voided", invoiceObj(invoice, "void", { total: 1, amount_due: 1, amount_remaining: 1 }), { id, created: 1_800_000_999 });
    const r = await post(forged.body);
    expect([r.status, r.text]).toEqual([200, "Already processed"]);
    expect(await inv(invoice, "total::text")).toBe("5000");
  });
  it("D5 eight CONCURRENT identical deliveries: exactly one application; the others are 200 already-processed or 409 in-progress", async () => {
    const invoice = `in_${nextId()}`;
    const e = envelope("invoice.voided", invoiceObj(invoice, "void"));
    const sig = sign(e.body);
    const results = await Promise.all(Array.from({ length: 8 }, () => post(e.body, PLATFORM_SECRET, sig)));
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(await q(`select count(*) from public.hosted_invoice_source_events where provider_event_id='${e.id}'`)).toBe("1");
    expect(await q(`select count(*) from public.hosted_invoices where stripe_invoice_id='${invoice}'`)).toBe("1");
    expect(await claimRow(e.id)).toBe("processed/d24_applied_unmatched");
  });
  it("D6 the same invoice payment delivered under a NEW event id is one payment (keyed by invoice-payment id)", async () => {
    const invoice = `in_${nextId()}`;
    const pay = `inpay_${nextId()}`;
    await register(SA, invoice);
    await deliver("invoice_payment.paid", payObj(pay, invoice, 4000));
    await deliver("invoice_payment.paid", payObj(pay, invoice, 4000));
    expect(await q(`select count(*)||'/'||max(amount_paid) from public.hosted_invoice_payments where stripe_invoice_payment_id='${pay}'`)).toBe("1/4000");
    expect(await q(`select count(*) from public.hosted_invoice_source_events where object_id='${pay}'`)).toBe("2");
  });
  it("D7 out of order: payment, then void, then an OLDER uncollectible; void wins, history kept, nothing reopened", async () => {
    const invoice = `in_${nextId()}`;
    await register(SA, invoice);
    await deliver("invoice_payment.paid", payObj(`inpay_${nextId()}`, invoice, 900), { created: 1_800_100_005 });
    await deliver("invoice.voided", invoiceObj(invoice, "void"), { created: 1_800_100_010 });
    await deliver("invoice.marked_uncollectible", invoiceObj(invoice, "uncollectible"), { created: 1_800_100_001 });
    expect(await inv(invoice, "status")).toBe("void");
    expect(await inv(invoice, "array_to_string(seen_statuses,',')")).toBe("uncollectible,void");
    expect(await q(`select count(*) from public.hosted_invoice_status_transitions t join public.hosted_invoices i on i.id=t.invoice_row_id where i.stripe_invoice_id='${invoice}'`)).toBe("2");
  });
  it("D8 payment arriving first yields an unobserved shell; a later void completes it without losing the payment", async () => {
    const invoice = `in_${nextId()}`;
    const pay = `inpay_${nextId()}`;
    await deliver("invoice_payment.paid", payObj(pay, invoice, 1200));
    expect(await inv(invoice, "coalesce(status,'none')||'/'||reconciliation_state")).toBe("none/unmatched");
    await deliver("invoice.voided", invoiceObj(invoice, "void", { total: 1200, amount_due: 1200, amount_remaining: 1200 }));
    expect(await inv(invoice, "status")).toBe("void");
    expect(await inv(invoice, "anomaly_codes @> array['void_invoice_has_payments']")).toBe("t");
    expect(await q(`select status from public.hosted_invoice_payments where stripe_invoice_payment_id='${pay}'`)).toBe("paid");
  });
  it("D9 conflicting amounts for one payment id keep the first amount and flag a conflict", async () => {
    const invoice = `in_${nextId()}`;
    const pay = `inpay_${nextId()}`;
    await register(SA, invoice);
    await deliver("invoice_payment.paid", payObj(pay, invoice, 100));
    await deliver("invoice_payment.paid", payObj(pay, invoice, 999));
    expect(await q(`select amount_paid||'/'||conflict from public.hosted_invoice_payments where stripe_invoice_payment_id='${pay}'`)).toBe("100/true");
    expect(await inv(invoice, "anomaly_codes @> array['invoice_payment_conflict']")).toBe("t");
  });
  it("D10 credit note voided/created/updated in any order ends voided as one row", async () => {
    const invoice = `in_${nextId()}`;
    const cn = `cn_${nextId()}`;
    await deliver("credit_note.voided", noteObj(cn, invoice, "void"), { created: 1_800_200_020 });
    await deliver("credit_note.created", noteObj(cn, invoice), { created: 1_800_200_001 });
    await deliver("credit_note.updated", noteObj(cn, invoice), { created: 1_800_200_010 });
    expect(await q(`select count(*)||'/'||max(status) from public.hosted_credit_notes where stripe_credit_note_id='${cn}'`)).toBe("1/void");
  });
  it("D11 a transient database failure finalizes the event as failed (500); Stripe's retry then applies it exactly once", async () => {
    const invoice = `in_${nextId()}`;
    const e = envelope("invoice.voided", invoiceObj(invoice, "void"));
    await q(`create or replace function public._m2d_boom() returns trigger language plpgsql as $$ begin raise exception 'm2d injected failure' using errcode='55000'; end $$;
             create trigger m2d_boom before insert on public.hosted_invoice_source_events for each row execute function public._m2d_boom();`);
    try {
      expect((await post(e.body)).status).toBe(500);
      expect((await claimRow(e.id)).startsWith("failed")).toBe(true);
    } finally {
      await q("drop trigger if exists m2d_boom on public.hosted_invoice_source_events; drop function if exists public._m2d_boom();");
    }
    expect(await q(`select count(*) from public.hosted_invoices where stripe_invoice_id='${invoice}'`)).toBe("0");
    expect((await post(e.body)).status).toBe(200);
    expect(await claimRow(e.id)).toBe("processed/d24_applied_unmatched");
    expect(await q(`select count(*) from public.hosted_invoice_source_events where provider_event_id='${e.id}'`)).toBe("1");
  });
});

suite("E. defer then drain (including concurrent drains)", () => {
  beforeEach(() => MODE("defer"));
  it("E1 defer mode stores evidence only: no invoice, payment or source event until drained", async () => {
    const before = await q("select (select count(*) from public.hosted_invoices)||'/'||(select count(*) from public.hosted_invoice_payments)||'/'||(select count(*) from public.hosted_invoice_source_events)");
    const r = await deliver("invoice_payment.paid", payObj(`inpay_${nextId()}`, `in_${nextId()}`));
    expect(r.status).toBe(200);
    expect(await claimRow(r.id)).toBe("processed/d24_deferred");
    expect(await q(`select state from public.hosted_invoice_deferred_events where provider_event_id='${r.id}'`)).toBe("pending");
    expect(await q("select (select count(*) from public.hosted_invoices)||'/'||(select count(*) from public.hosted_invoice_payments)||'/'||(select count(*) from public.hosted_invoice_source_events)")).toBe(before);
  });
  it("E2 drain applies deferred events once; a second drain is a no-op; enabling D24 afterwards creates no duplicate", async () => {
    const invoice = `in_${nextId()}`;
    const pay = `inpay_${nextId()}`;
    await register(SA, invoice);
    const v = await deliver("invoice.voided", invoiceObj(invoice, "void"));
    const p = await deliver("invoice_payment.paid", payObj(pay, invoice, 300));
    await drain(100);
    expect(await q(`select count(*) filter (where state='applied')||'/'||count(*) from public.hosted_invoice_deferred_events where provider_event_id in ('${v.id}','${p.id}')`)).toBe("2/2");
    expect(await inv(invoice, "studio_id::text||'/'||status")).toBe(`${SA}/void`);
    expect(await q(`select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id='${pay}'`)).toBe("1");
    const again = await drain(100);
    expect((again.data as { applied: number }).applied).toBe(0);
    MODE("on");
    await deliver("invoice_payment.paid", payObj(pay, invoice, 300));
    expect(await q(`select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id='${pay}'`)).toBe("1");
  });
  it("E3 deferred-then-drained facts equal directly-applied facts for the same event sequence", async () => {
    const a = `in_${nextId()}`, b = `in_${nextId()}`, pa = `inpay_${nextId()}`, pb = `inpay_${nextId()}`;
    await register(SA, a); await register(SA, b);
    const fixtures = (i: string, p: string, n: string) => [
      ["invoice_payment.paid", payObj(p, i, 400), 1_800_300_001],
      ["invoice.voided", invoiceObj(i, "void", { total: 100, amount_due: 100, amount_remaining: 100 }), 1_800_300_002],
      ["credit_note.created", noteObj(n, i), 1_800_300_003],
    ] as const;
    for (const [t, o, c] of fixtures(a, pa, `cn_${nextId()}`)) await deliver(t, o as Record<string, unknown>, { created: c });
    await drain(100);
    MODE("on");
    for (const [t, o, c] of fixtures(b, pb, `cn_${nextId()}`)) await deliver(t, o as Record<string, unknown>, { created: c });
    const shape = (i: string) => inv(i, "status||'|'||reconciliation_state||'|'||array_to_string(anomaly_codes,',')||'|'||array_to_string(seen_statuses,',')||'|'||classification");
    expect(await shape(a)).toBe(await shape(b));
  });
  it("E4 a duplicate delivery in defer mode leaves a single deferred row", async () => {
    const e = envelope("invoice.voided", invoiceObj(`in_${nextId()}`, "void"));
    await post(e.body); await post(e.body);
    expect(await q(`select count(*) from public.hosted_invoice_deferred_events where provider_event_id='${e.id}'`)).toBe("1");
  });
  it("E5 four CONCURRENT drains over 24 deferred events apply every event exactly once", async () => {
    const invoices = Array.from({ length: 6 }, () => `in_${nextId()}`);
    const ids: string[] = [];
    const pays: string[] = [];
    for (const [n, i] of invoices.entries()) {
      await register(SA, i);
      for (let k = 0; k < 4; k++) {
        if (k === 0) ids.push((await deliver("invoice.voided", invoiceObj(i, "void"), { created: 1_800_400_000 + n * 10 + k })).id);
        else {
          const p = `inpay_${nextId()}`;
          pays.push(p);
          ids.push((await deliver("invoice_payment.paid", payObj(p, i, 100 * k), { created: 1_800_400_000 + n * 10 + k })).id);
        }
      }
    }
    const drains = await Promise.all([10, 10, 10, 10].map(() => drain(10)));
    for (const d of drains) expect(d.error).toBeNull();
    await drain(100);
    expect(await q(`select count(*) filter (where state='applied')||'/'||count(*) from public.hosted_invoice_deferred_events where provider_event_id in (${inList(ids)})`)).toBe("24/24");
    expect(await q(`select count(*) from public.hosted_invoice_source_events where provider_event_id in (${inList(ids)})`)).toBe("24");
    expect(await q(`select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id in (${inList(pays)})`)).toBe("18");
    expect(await q(`select count(*) from public.hosted_invoices where stripe_invoice_id in (${inList(invoices)})`)).toBe("6");
    expect(await q(`select count(*) from public.hosted_invoice_deferred_events where provider_event_id in (${inList(ids)}) and attempts>1`)).toBe("0");
  });
  it("E6 drains racing registration and live-route deliveries still attribute once and lose nothing", async () => {
    const invoice = `in_${nextId()}`;
    const pays = Array.from({ length: 4 }, () => `inpay_${nextId()}`);
    for (const p of pays) await deliver("invoice_payment.paid", payObj(p, invoice, 50));
    MODE("on");
    await Promise.all([
      drain(100),
      register(SA, invoice),
      deliver("invoice.voided", invoiceObj(invoice, "void")),
      drain(100),
    ]);
    await drain(100);
    expect(await inv(invoice, "studio_id::text")).toBe(SA);
    expect(await q(`select count(*) from public.hosted_invoices where stripe_invoice_id='${invoice}'`)).toBe("1");
    expect(await q(`select count(*)||'/'||count(*) filter (where studio_id='${SA}') from public.hosted_invoice_payments where stripe_invoice_payment_id in (${inList(pays)})`)).toBe("4/4");
  });
  it("E7 defer without owning the PAY-WH-1 claim is refused and writes nothing", async () => {
    const id = `evt_${nextId()}`;
    const res = await rpc("d24_defer_event", { p_provider_event_id: id, p_owner: "00000000-0000-0000-0000-00000000dead", p_event_type: "invoice.voided", p_event_created: 1, p_account: null, p_livemode: false, p_payload_hash: "h", p_kind: "invoice", p_object: { invoice_id: "in_x", status: "void", total: 1, amount_due: 1, amount_paid: 0, amount_remaining: 1, currency: "usd" } });
    expect(res.error?.message).toMatch(/paywh1_claim_not_owned/);
    expect(await q(`select count(*) from public.hosted_invoice_deferred_events where provider_event_id='${id}'`)).toBe("0");
  });
});

suite("F. cross-studio attribution and metadata-only ownership attempts", () => {
  beforeEach(() => MODE("on"));
  it("F1 forged metadata naming another studio and its real registry id never re-attributes a registered invoice", async () => {
    const invoice = `in_${nextId()}`, other = `in_${nextId()}`;
    await register(SA, invoice);
    await register(SB, other);
    const bReg = await q(`select id from public.hosted_invoice_registry where stripe_invoice_id='${other}'`);
    await deliver("invoice.voided", invoiceObj(invoice, "void", { metadata: { df_registry_id: bReg, df_studio_id: SB } }));
    expect(await inv(invoice, "studio_id::text")).toBe(SA);
    expect(await inv(invoice, "anomaly_codes @> array['metadata_mismatch']")).toBe("t");
  });
  it("F2 metadata ALONE (no registry row) never attributes: studio stays null, state unmatched", async () => {
    const invoice = `in_${nextId()}`;
    await deliver("invoice.voided", invoiceObj(invoice, "void", { metadata: { df_registry_id: "11111111-1111-4111-8111-111111111111", df_studio_id: SA } }));
    expect(await inv(invoice, "coalesce(studio_id::text,'NULL')||'/'||reconciliation_state")).toBe("NULL/unmatched");
    expect(await q(`select count(*) from public.hosted_invoice_registry where stripe_invoice_id='${invoice}'`)).toBe("0");
  });
  it("F3 metadata pointing at a real registry id of ANOTHER invoice does not attribute an unregistered invoice", async () => {
    const mine = `in_${nextId()}`, target = `in_${nextId()}`;
    await register(SB, target);
    const reg = await q(`select id from public.hosted_invoice_registry where stripe_invoice_id='${target}'`);
    await deliver("invoice.voided", invoiceObj(mine, "void", { metadata: { df_registry_id: reg, df_studio_id: SB } }));
    expect(await inv(mine, "coalesce(studio_id::text,'NULL')")).toBe("NULL");
  });
  it("F4 a different studio cannot register an already-registered invoice (23505), even after facts exist", async () => {
    const invoice = `in_${nextId()}`;
    await register(SA, invoice);
    await deliver("invoice.voided", invoiceObj(invoice, "void"));
    const r = await register(SB, invoice);
    expect(r.error?.code).toBe("23505");
    expect(await inv(invoice, "studio_id::text")).toBe(SA);
  });
  it("F5 the same invoice id seen under ANOTHER Stripe account is not attributed and is flagged; the registered scope stays clean", async () => {
    const invoice = `in_${nextId()}`;
    await register(SA, invoice, "acct_m2dreal");
    await deliver("invoice.voided", invoiceObj(invoice, "void"), { account: "acct_m2dother" });
    expect(await inv(invoice, "coalesce(studio_id::text,'NULL')", "acct_m2dother")).toBe("NULL");
    expect(await inv(invoice, "anomaly_codes @> array['account_scope_mismatch']", "acct_m2dother")).toBe("t");
  });
  it("F6 platform-scope event for a Connect-registered invoice stays unmatched; Connect event for a platform-registered invoice stays unmatched", async () => {
    const c = `in_${nextId()}`, p = `in_${nextId()}`;
    await register(SA, c, "acct_m2dconn2");
    await register(SA, p, null);
    await deliver("invoice.voided", invoiceObj(c, "void"));
    await deliver("invoice.voided", invoiceObj(p, "void"), { account: "acct_m2dconn2" });
    expect(await inv(c, "coalesce(studio_id::text,'NULL')", "")).toBe("NULL");
    expect(await inv(p, "coalesce(studio_id::text,'NULL')", "acct_m2dconn2")).toBe("NULL");
  });
  it("F7 child facts of an unmatched invoice never carry a studio; of a registered invoice always the invoice's studio", async () => {
    const reg = `in_${nextId()}`, unreg = `in_${nextId()}`;
    await register(SA, reg);
    await deliver("invoice_payment.paid", payObj(`inpay_${nextId()}`, reg, 10));
    await deliver("credit_note.created", noteObj(`cn_${nextId()}`, reg));
    await deliver("invoice_payment.paid", payObj(`inpay_${nextId()}`, unreg, 10));
    expect(await q(`select count(*)||'/'||count(*) filter (where p.studio_id is null) from public.hosted_invoice_payments p join public.hosted_invoices i on i.id=p.invoice_row_id where i.stripe_invoice_id='${unreg}'`)).toBe("1/1");
    expect(await q(`select count(*) from (select p.studio_id from public.hosted_invoice_payments p join public.hosted_invoices i on i.id=p.invoice_row_id where i.stripe_invoice_id='${reg}' union all select c.studio_id from public.hosted_credit_notes c join public.hosted_invoices i on i.id=c.invoice_row_id where i.stripe_invoice_id='${reg}') x where studio_id is distinct from '${SA}'`)).toBe("0");
    expect(await q(`select (select count(*) from public.hosted_invoice_payments p join public.hosted_invoices i on i.id=p.invoice_row_id where i.stripe_invoice_id='${reg}')||'/'||(select count(*) from public.hosted_credit_notes c join public.hosted_invoices i on i.id=c.invoice_row_id where i.stripe_invoice_id='${reg}')`)).toBe("1/1");
  });
  it("F8 attribution is permanent: even a privileged writer cannot re-point a fact or registry row at another studio", async () => {
    const invoice = `in_${nextId()}`;
    await register(SA, invoice);
    await deliver("invoice.voided", invoiceObj(invoice, "void"));
    expect(await as("postgres", `select set_config('d24.writer','on',false); update public.hosted_invoices set studio_id='${SB}' where stripe_invoice_id='${invoice}'`)).toMatch(/^ERR.*(permanent|immutable)/i);
    expect(await as("postgres", `select set_config('d24.writer','on',false); update public.hosted_invoice_registry set studio_id='${SB}' where stripe_invoice_id='${invoice}'`)).toMatch(/^ERR/);
    expect(await inv(invoice, "studio_id::text")).toBe(SA);
  });
  it("F9 acknowledging anomalies can never attribute an unmatched invoice into a studio", async () => {
    const invoice = `in_${nextId()}`;
    await deliver("invoice.voided", invoiceObj(invoice, "void"));
    const r = await rpc("d24_acknowledge_anomalies", { p_invoice_row_id: await inv(invoice, "id::text"), p_codes: ["unverified_void_origin"], p_actor: SA, p_reason: "reviewed" });
    // with M2-B loaded the actor-trusting function is closed to service_role altogether (even stronger than the M1 refusal)
    expect(r.error?.message ?? "").toMatch(has("m2b") ? /permission denied/ : /d24_unmatched_invoice_cannot_be_acknowledged/);
    expect(await inv(invoice, "coalesce(studio_id::text,'NULL')")).toBe("NULL");
  });
  it("F10 hostile identifiers are refused or inert (SQL metacharacters in invoice and account ids)", async () => {
    const before = await factTotals();
    const bad = await deliver("invoice.voided", invoiceObj("in_x'; drop table public.hosted_invoices;--", "void"));
    expect(await claimRow(bad.id)).toBe("processed/d24_malformed_ignored");
    const acct = envelope("invoice.voided", invoiceObj(`in_${nextId()}`, "void"), { account: "acct_bad'; --" });
    const r = await post(acct.body, CONNECT_SECRET);
    expect(r.status).toBe(500);
    expect((await claimRow(acct.id)).startsWith("failed")).toBe(true);
    expect(await q(`select error_message from public.payment_provider_events where provider_event_id='${acct.id}'`)).toMatch(/d24 apply failed: 22023/);
    expect(await factTotals()).toBe(before);
    expect(await q("select to_regclass('public.hosted_invoices') is not null")).toBe("t");
  });
});

suite("G. subscription invoices versus hosted invoices", () => {
  beforeEach(() => MODE("on"));
  it("G1 an unregistered void carrying Stripe subscription markers is classified 'subscription' and attributed to no studio", async () => {
    const invoice = `in_${nextId()}`;
    await deliver("invoice.voided", invoiceObj(invoice, "void", { subscription: "sub_m2d", billing_reason: "subscription_cycle" }));
    expect(await inv(invoice, "classification||'/'||coalesce(studio_id::text,'NULL')||'/'||subscription_evidence")).toBe("subscription/NULL/true");
  });
  it("G2 subscription markers never move a REGISTERED invoice: it stays attributed and is flagged subscription_registry_conflict", async () => {
    const invoice = `in_${nextId()}`;
    await register(SA, invoice);
    await deliver("invoice.voided", invoiceObj(invoice, "void", { billing_reason: "subscription_create" }));
    expect(await inv(invoice, "classification||'/'||studio_id::text")).toBe(`registered/${SA}`);
    expect(await inv(invoice, "anomaly_codes @> array['subscription_registry_conflict']")).toBe("t");
  });
  it("G3 tenant-writable studio_invoices rows never attribute a hosted invoice", async () => {
    const invoice = `in_${nextId()}`;
    await q(`insert into public.studio_invoices (stripe_invoice_id, studio_id) values ('${invoice}','${SB}')`);
    await deliver("invoice.voided", invoiceObj(invoice, "void"));
    expect(await inv(invoice, "coalesce(studio_id::text,'NULL')")).toBe("NULL");
  });
  it("G4 subscription lifecycle events (invoice.paid / invoice.payment_failed) are not routed to D24 and create no D24 fact", async () => {
    const before = await factTotals();
    for (const type of ["invoice.paid", "invoice.payment_failed"]) {
      const r = await deliver(type, { id: `in_${nextId()}`, object: "invoice", customer: "cus_x", status: "paid", subscription: "sub_x", billing_reason: "subscription_cycle" });
      // The legacy subscription handlers run against this suite's empty stub for non-D24 tables, so their own HTTP status is not
      // asserted (they may fail on the stub); what matters is that the event is never routed to D24 and leaves no D24 outcome or fact.
      const row = await claimRow(r.id);
      expect(row).toMatch(/^(processed|failed)\//);
      expect(row.includes("d24_")).toBe(false);
    }
    expect(await factTotals()).toBe(before);
  });
});

suite("H. evidence integrity and scope", () => {
  beforeEach(() => MODE("on"));
  it("H1 evidence tables are append-only for every role, including a privileged one", async () => {
    await deliver("invoice.voided", invoiceObj(`in_${nextId()}`, "void"));
    expect(await as("postgres", "update public.hosted_invoice_source_events set livemode=livemode")).toMatch(/append-only/);
    expect(await as("postgres", "delete from public.hosted_invoice_source_events")).toMatch(/append-only/);
    expect(await as("postgres", "truncate public.hosted_invoice_recon_audit")).toMatch(/append-only/);
    expect(await as("postgres", "delete from public.hosted_invoices")).toMatch(/only allowed through the d24 functions|permanent evidence/);
  });
  it("H2 a replay of a deferred event id with a different payload hash keeps the original evidence and records the mismatch", async () => {
    MODE("defer");
    const id = `evt_${nextId()}`;
    const obj = { invoice_id: `in_${nextId()}`, status: "void", total: 5000, amount_due: 5000, amount_paid: 0, amount_remaining: 5000, currency: "usd" };
    const first = envelope("invoice.voided", invoiceObj(obj.invoice_id, "void"), { id });
    expect((await post(first.body)).status).toBe(200);
    const before = await q(`select payload_hash||'/'||payload_mismatch from public.hosted_invoice_deferred_events where provider_event_id='${id}'`);
    const owner = "00000000-0000-0000-0000-00000000beef";
    // a legitimate second delivery attempt: re-claim is impossible (processed), so take the claim row over directly as superuser to model a lease takeover
    await q(`update public.payment_provider_events set status='processing', claim_owner='${owner}', claim_expires_at=now()+interval '5 min' where provider_event_id='${id}'`);
    const r = await rpc("d24_defer_event", { p_provider_event_id: id, p_owner: owner, p_event_type: "invoice.voided", p_event_created: 1_800_000_001, p_account: null, p_livemode: false, p_payload_hash: "different-hash", p_kind: "invoice", p_object: obj });
    expect(r.error).toBeNull();
    expect((r.data as { duplicate: boolean; payload_mismatch: boolean }).duplicate).toBe(true);
    expect((r.data as { payload_mismatch: boolean }).payload_mismatch).toBe(true);
    expect(await q(`select count(*) from public.hosted_invoice_deferred_events where provider_event_id='${id}'`)).toBe("1");
    expect(await q(`select payload_hash from public.hosted_invoice_deferred_events where provider_event_id='${id}'`)).toBe(before.split("/")[0]);
    expect(await q(`select payload_mismatch from public.hosted_invoice_deferred_events where provider_event_id='${id}'`)).toBe("t");
  });
  it("H3 the D24 schema (M1 plus loaded layers) creates only hosted_* tables on top of the reconstructed base: no settlement, ledger, refund or credit table exists to be written", async () => {
    expect(await q("select coalesce(string_agg(table_name, ',' order by table_name),'') from information_schema.tables where table_schema='public' and table_name not like 'hosted\\_%' and table_name not in ('studios','payment_provider_events','studio_invoices','profiles','user_studio_roles')")).toBe("");
  });
});

suite("I. identity replay, scope, livemode and ordering edge cases (review gaps)", () => {
  beforeEach(() => MODE("on"));
  it("I1 an invoice-payment id replayed under a DIFFERENT invoice/studio stays with its first invoice and flags the second invoice", async () => {
    const a = `in_${nextId()}`, b = `in_${nextId()}`, pay = `inpay_${nextId()}`;
    await register(SA, a); await register(SB, b);
    expect((await deliver("invoice_payment.paid", payObj(pay, a, 10))).status).toBe(200);
    expect((await deliver("invoice_payment.paid", payObj(pay, b, 10))).status).toBe(200);
    expect(await q(`select i.stripe_invoice_id||'/'||p.studio_id from public.hosted_invoice_payments p join public.hosted_invoices i on i.id=p.invoice_row_id where p.stripe_invoice_payment_id='${pay}'`)).toBe(`${a}/${SA}`);
    expect(await q(`select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id='${pay}'`)).toBe("1");
    expect(await inv(b, "anomaly_codes @> array['invoice_payment_conflict']")).toBe("t");
    expect(await inv(a, "anomaly_codes @> array['invoice_payment_conflict']")).toBe("f");
  });
  it("I2 a credit-note id replayed under a DIFFERENT invoice/studio stays with its first invoice and flags the second invoice", async () => {
    const a = `in_${nextId()}`, b = `in_${nextId()}`, cn = `cn_${nextId()}`;
    await register(SA, a); await register(SB, b);
    await deliver("credit_note.created", noteObj(cn, a));
    await deliver("credit_note.created", noteObj(cn, b));
    expect(await q(`select i.stripe_invoice_id||'/'||c.studio_id from public.hosted_credit_notes c join public.hosted_invoices i on i.id=c.invoice_row_id where c.stripe_credit_note_id='${cn}'`)).toBe(`${a}/${SA}`);
    expect(await inv(b, "anomaly_codes @> array['credit_note_conflict']")).toBe("t");
  });
  it("I3 an event under Stripe account X, then registration under account Y: the account-X row stays unattributed and is flagged", async () => {
    const invoice = `in_${nextId()}`;
    await deliver("invoice.voided", invoiceObj(invoice, "void"), { account: "acct_m2dx" });
    await register(SA, invoice, "acct_m2dy");
    expect(await inv(invoice, "coalesce(studio_id::text,'NULL')||'/'||(anomaly_codes @> array['account_scope_mismatch'])::text", "acct_m2dx")).toBe("NULL/true");
  });
  it("I4 a registry/event livemode mismatch still attributes by registry but flags livemode_mismatch and needs review", async () => {
    const invoice = `in_${nextId()}`;
    expect((await rpc("d24_register_invoice", { p_studio_id: SA, p_stripe_account_id: null, p_stripe_invoice_id: invoice, p_livemode: true, p_business_object_type: "event_fee", p_business_object_id: `bo-${invoice}` })).error).toBeNull();
    await deliver("invoice.voided", invoiceObj(invoice, "void"));
    expect(await inv(invoice, "(anomaly_codes @> array['livemode_mismatch'])::text||'/'||reconciliation_state")).toBe("true/anomalous");
  });
  it("I5 void and uncollectible converge to void in either arrival order, whatever the event timestamps", async () => {
    const a = `in_${nextId()}`, b = `in_${nextId()}`;
    await deliver("invoice.voided", invoiceObj(a, "void"), { created: 1_801_000_010 });
    await deliver("invoice.marked_uncollectible", invoiceObj(a, "uncollectible"), { created: 1_801_000_020 });
    await deliver("invoice.marked_uncollectible", invoiceObj(b, "uncollectible"), { created: 1_801_000_020 });
    await deliver("invoice.voided", invoiceObj(b, "void"), { created: 1_801_000_010 });
    expect([await inv(a, "status"), await inv(b, "status")]).toEqual(["void", "void"]);
  });
  it("I6 service_role cannot enable the d24.writer flag to write facts: direct DML stays permission-denied and nothing is written", async () => {
    const before = await factTotals();
    expect(await as("service_role", `select set_config('d24.writer','on',false); insert into public.hosted_invoice_registry (studio_id,stripe_invoice_id,livemode,business_object_type,business_object_id) values ('${SA}','in_${nextId()}',false,'a','b')`)).toMatch(/permission denied/);
    expect(await as("service_role", `select set_config('d24.writer','on',false); update public.hosted_invoices set status=status`)).toMatch(/permission denied/);
    expect(await factTotals()).toBe(before);
  });
});

suite("K. composed: a drain holding a key lock versus a live webhook apply (needs M2-C lock_timeout)", () => {
  const T = (name: string, fn: () => Promise<void>) => (has("m2c") ? it(name, fn) : it.skip(`BLOCKED(m2c not loaded) ${name}`, () => undefined));
  T("K1 live apply blocked behind a drain's key lock returns 500 within ~3s with nothing written and the claim failed; redelivery then applies exactly once", async () => {
    const invoice = `in_${nextId()}`;
    await register(SA, invoice);
    // 1. a deferred event for the invoice, and a trigger that makes its apply hold the invoice's key lock for ~8s
    MODE("defer");
    const held = await deliver("invoice_payment.paid", payObj(`inpay_${nextId()}`, invoice, 111));
    expect(await claimRow(held.id)).toBe("processed/d24_deferred");
    await q(`create or replace function public._m2d_hold() returns trigger language plpgsql as $$ begin if new.provider_event_id = '${held.id}' then perform pg_sleep(8); end if; return new; end $$;
             create trigger m2d_hold before insert on public.hosted_invoice_source_events for each row execute function public._m2d_hold();`);
    try {
      // 2. the drain starts (not awaited) and takes the key lock inside d24_apply_core
      const drainP = rpc("d24_run_drain", { p_batch_size: 10, p_trigger: "manual" });
      for (let i = 0; i < 40; i++) {
        if (Number(await q("select count(*) from pg_stat_activity where state='active' and query like '%d24_run_drain%' and pid<>pg_backend_pid()")) > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await new Promise((r) => setTimeout(r, 1000));
      // 3. a live delivery for the same invoice arrives while the lock is held
      MODE("on");
      const pay = `inpay_${nextId()}`;
      const live = envelope("invoice_payment.paid", payObj(pay, invoice, 222));
      const t0 = Date.now();
      const res = await post(live.body);
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(500);
      expect(elapsed).toBeLessThan(6500);
      expect((await claimRow(live.id)).startsWith("failed")).toBe(true);
      expect(await q(`select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id='${pay}'`)).toBe("0");
      expect(await q(`select count(*) from public.hosted_invoice_source_events where provider_event_id='${live.id}'`)).toBe("0");
      const dr = await drainP;
      expect(dr.error).toBeNull();
      // 4. Stripe-style redelivery of the same event after the lock is gone applies exactly once
      const again = await post(live.body);
      expect(again.status).toBe(200);
      expect(await claimRow(live.id)).toBe("processed/d24_applied_matched");
      expect(await q(`select count(*)||'/'||max(amount_paid) from public.hosted_invoice_payments where stripe_invoice_payment_id='${pay}'`)).toBe("1/222");
      expect(await q(`select count(*) from public.hosted_invoice_source_events where provider_event_id='${live.id}'`)).toBe("1");
      expect((await post(live.body)).text).toBe("Already processed");
      expect(await q(`select state from public.hosted_invoice_deferred_events where provider_event_id='${held.id}'`)).toBe("applied");
    } finally {
      await q("drop trigger if exists m2d_hold on public.hosted_invoice_source_events; drop function if exists public._m2d_hold();");
    }
  });
});

// ----------------------------------------------------------------------------------------------------------------------------
// M2-A (registration) is a code-only layer: it adds a server wrapper over d24_register_invoice and no migration. Its own PG test
// (register.d24.pg.test.ts in PR 387) covers the wrapper; here we pin the database contract the wrapper depends on, and keep the
// scenarios that cannot run yet as BLOCKED with the reason, never as passed.
describe("M2A. registration (M2-A database contract)", () => {
  const T = (name: string, fn: () => Promise<void>) => (!STACK ? it.skip(`BLOCKED(no stack) ${name}`, () => undefined) : !has("m2a") ? it.skip(`BLOCKED(m2a not loaded) ${name}`, () => undefined) : it(name, fn));
  T("M2A1 concurrent double-submit of one registration yields exactly one registry row and one outcome 'registered'", async () => {
    const invoice = `in_${nextId()}`;
    const rs = await Promise.all(Array.from({ length: 6 }, () => register(SA, invoice, "acct_m2dreg")));
    for (const r of rs) expect(r.error).toBeNull();
    expect(rs.filter((r) => (r.data as { outcome: string }).outcome === "registered")).toHaveLength(1);
    expect(await q(`select count(*) from public.hosted_invoice_registry where stripe_invoice_id='${invoice}'`)).toBe("1");
  });
  T("M2A2 the wrapper's error mapping inputs: cross-owner is SQLSTATE 23505, null studio is 22023", async () => {
    const invoice = `in_${nextId()}`;
    await register(SA, invoice, "acct_m2dreg");
    expect((await register(SB, invoice, "acct_m2dreg")).error?.code).toBe("23505");
    expect((await rpc("d24_register_invoice", { p_studio_id: null, p_stripe_account_id: null, p_stripe_invoice_id: invoice, p_livemode: false, p_business_object_type: "x", p_business_object_id: "y" })).error?.code).toBe("22023");
  });
  T("M2A3 registration racing a stream of events for the same invoice converges to one attributed invoice", async () => {
    MODE("on");
    const invoice = `in_${nextId()}`;
    await Promise.all([register(SA, invoice, "acct_m2dreg2"), ...Array.from({ length: 4 }, (_, i) => deliver("invoice.voided", invoiceObj(invoice, "void"), { account: "acct_m2dreg2", created: 1_800_900_000 + i }))]);
    expect(await inv(invoice, "studio_id::text", "acct_m2dreg2")).toBe(SA);
    expect(await q(`select count(*) from public.hosted_invoices where stripe_invoice_id='${invoice}'`)).toBe("1");
  });
  it.skip("BLOCKED(no production resolver exists: M2-A fails closed with business_object_type_unsupported) app issues an invoice -> registry row created atomically with the business object", () => undefined);
  it.skip("BLOCKED(no production caller authorizes a studio yet) registration for a studio the caller does not own is refused end to end", () => undefined);
});

describe("Z. stack availability", () => {
  if (!STACK) it.skip("BLOCKED: no D24 Postgres stack is running (start it with scripts/qa/d24-stack.sh up); nothing else in this file ran", () => undefined);
  else it(`stack layers loaded: ${(LAYERS ?? []).join(",")}`, () => expect(has("m1")).toBe(true));
});

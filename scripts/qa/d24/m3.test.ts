import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import Stripe from "stripe";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { as, q, rpc, rpcAsUser, runSql, stackLayers } from "./pgBridge";

/**
 * D24 M3-D composed acceptance. The REAL M3-B orchestrator (create.ts + createSupabaseIntentStore, loaded from the tree or from a draft PR head by
 * scripts/qa/d24-stack.sh) runs against the REAL M1 + M2 + M3-A SQL in the disposable Postgres container, with the OFFLINE fake Stripe shipped with M3-B.
 * Webhook scenarios go through the REAL route with offline signed fixtures (same pattern as acceptance.test.ts). Nothing here can reach the network, a hosted
 * database or a real Stripe client: `fetch` throws, the Stripe SDK is only used to sign fixtures, the transport to Postgres is `docker exec` into the local container.
 * A scenario whose layer is not loaded is reported BLOCKED (skipped) with the missing layer named, never passed.
 */

const LAYERS = stackLayers();
const STACK = LAYERS !== null;
const has = (l: string) => LAYERS?.includes(l) ?? false;

const PLATFORM_SECRET = "whsec_d24_m3d_platform_synthetic";
const CONNECT_SECRET = "whsec_d24_m3d_connect_synthetic";
const realStripe = new Stripe("sk_test_d24_m3d_not_a_real_key");
const sigStore = new AsyncLocalStorage<{ sig: string | null }>();

// M3-C's real server action / authorizer run against the real SQL; only the session (who is signed in) and Next's cache/redirect are replaced.
const sess = vi.hoisted(() => ({ studioId: null as string | null, userId: null as string | null }));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => ({ studioId: sess.studioId, userId: sess.userId }) }));
vi.mock("@/lib/supabase/server", async () => {
  const bridge = await import("./pgBridge");
  return { createClient: async () => ({ rpc: (fn: string, args: Record<string, unknown>) => bridge.rpcAsUser(sess.userId, "aal1", fn, args) }) };
});
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error("NEXT_REDIRECT:" + u); } }));

vi.mock("next/headers", () => ({ headers: async () => ({ get: (n: string) => (n === "stripe-signature" ? (sigStore.getStore()?.sig ?? null) : null) }) }));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => ({ webhooks: realStripe.webhooks }) }));
vi.mock("@supabase/supabase-js", async () => {
  const bridge = await import("./pgBridge");
  return {
    createClient: () => ({
      rpc: (fn: string, args: Record<string, unknown>) => bridge.rpc(fn, args),
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

// ---- the orchestrator and its offline fakes: from the overlay (draft PR head) when present, else from the merged tree ----
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Res = { ok: boolean; code?: string; retryable?: boolean; intentId?: string; stripeInvoiceId?: string; registryId?: string; adoptedExistingFacts?: boolean; state?: string; livemode?: boolean };
type FakeStripeT = {
  invoices: Map<string, Json>; calls: Array<{ op: string; account: string; key: string; params: unknown }>; livemode: boolean; failNext: unknown; failAfterCreate: unknown; loseResponseAfterCreate: unknown; keys: Map<string, unknown>; prefix: string; createCount: number;
  createDraftInvoice(a: Json): Promise<Json>; addInvoiceLines(a: Json): Promise<Json>;
};
type Orch = {
  createHostedInvoice(req: Json, deps: Json): Promise<Res>;
  resumeIntent(id: string, actor: Json, deps: Json): Promise<Res>;
  sweepRecoverableIntents(deps: Json, opts?: Json): Promise<Json>;
  createSupabaseIntentStore(sb: unknown): Json;
  livemodeFromSecretKey(k: string | null): boolean | null;
  deriveIdempotencyKey(studioId: string, type: string, objectId: string, requestKey: string): string;
  deriveRequestFingerprint(studioId: string, type: string, objectId: string, spec: Json, account: string, livemode: boolean): string;
};
type Fakes = { FakeStripe: new () => FakeStripeT; SPEC: Json };
const overlay = process.env.D24_OVERLAY ?? "";
const spec = (rel: string) => (overlay && fs.existsSync(path.join(overlay, "src", rel + ".ts")) ? `@d24overlay/${rel}` : `@/${rel}`);
const orchSpec = spec("lib/payments/hostedInvoice/create");
const fakesSpec = spec("lib/payments/hostedInvoice/__tests__/createFakes");
const orch = STACK && has("m3b") ? ((await import(/* @vite-ignore */ orchSpec)) as Orch) : null;
const fakes = STACK && has("m3b") ? ((await import(/* @vite-ignore */ fakesSpec)) as Fakes) : null;
type C395 = {
  actions: { saveClientInvoiceDraftAction(prev: { error: string }, fd: FormData): Promise<{ error: string; notice?: string }> };
  authorize: { authorizeClientInvoiceActor(p: "draft" | "view"): Promise<Json | null> };
  resolver: { CLIENT_INVOICE_SPEC_RESOLVERS: Record<string, unknown> };
  port: { getClientInvoiceCreationPort(): unknown };
};
// M3-C's REAL server action, authorizer, production resolver and (stub) creation port, from the overlay (PR head) or the merged tree
const c395: C395 | null = STACK && has("m3a") && has("m3b") && has("m3c")
  ? {
      actions: (await import(/* @vite-ignore */ spec("app/app/payments/invoices/actions"))) as unknown as C395["actions"],
      authorize: (await import(/* @vite-ignore */ spec("lib/billing/clientInvoices/authorize"))) as unknown as C395["authorize"],
      resolver: (await import(/* @vite-ignore */ spec("lib/billing/clientInvoices/resolver"))) as unknown as C395["resolver"],
      port: (await import(/* @vite-ignore */ spec("lib/billing/clientInvoices/creationPort"))) as unknown as C395["port"],
    }
  : null;


// ---- ids ----
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, "x");
let seq = 0;
const nextId = () => `${RUN}${(++seq).toString(36)}`;
const SA = "00000000-0000-0000-0000-0000000d3a5a";
const SB = "00000000-0000-0000-0000-0000000d3a5b";
const SN = "00000000-0000-0000-0000-0000000d3a5c"; // no connected account
const SD = "00000000-0000-0000-0000-0000000d3a5d"; // connected account, charges disabled
const USER = "00000000-0000-0000-0000-0000000d3a01";
const ACCT_A = "acct_m3dacctA";
const ACCT_B = "acct_m3dacctB";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let clock = 1_800_000_000;

// ---- gating: BLOCKED (skipped) with the missing layer named ----
function T(need: string[], name: string, fn: () => Promise<void>) {
  if (!STACK) return it.skip(`BLOCKED(no stack) ${name}`, () => undefined);
  const missing = need.filter((l) => !has(l));
  if (missing.length) return it.skip(`BLOCKED(${missing.join("+")} not loaded) ${name}`, () => undefined);
  return it(name, fn);
}
const M3 = ["m3a", "m3b"];
// A scenario that depends on a layer that does not exist yet: ALWAYS skipped (never a vacuous pass), labelled with why.
function PENDING(need: string[], name: string) {
  const missing = need.filter((l) => !has(l));
  return it.skip(missing.length ? `BLOCKED(${missing.join("+")} not loaded) ${name}` : `BLOCKED(${need.join("+")} loaded but this scenario is not written yet) ${name}`, () => undefined);
}

// ---- Supabase-shaped transport over the container (service_role for RPC, like the route; superuser for reads = Supabase service_role BYPASSRLS) ----
type Inject = { rpc: string; mode: "error" | "throw"; code?: string; times: number; after?: boolean };
function makeSupabase(inject: Inject[] = []) {
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      const hit = inject.find((i) => i.rpc === name && i.times > 0);
      if (hit && !hit.after) {
        hit.times--;
        if (hit.mode === "throw") throw new Error("simulated process crash");
        return { data: null, error: { code: hit.code ?? "57014", message: "injected" } };
      }
      const r = await rpc(name, args);
      if (hit && hit.after) {
        hit.times--;
        if (hit.mode === "throw") throw new Error("simulated process crash after the database committed");
        return { data: null, error: { code: hit.code ?? "57014", message: "injected after commit" } };
      }
      return r;
    },
    from(table: string) {
      const conds: Array<[string, string]> = [];
      const qb = {
        select: () => qb,
        eq: (c: string, v: string) => (conds.push([c, v]), qb),
        maybeSingle: async () => {
          if (!/^(studios|hosted_invoice_creation_intents|clients)$/.test(table) || conds.length === 0 || conds.some(([c, v]) => !/^[a-z_]{1,40}$/.test(c) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(v))) throw new Error(`unsupported read ${table}`);
          const where = conds.map(([c, v]) => `t.${c}::text = '${v}'`).join(" and ");
          const r = await runSql(`select coalesce((select to_jsonb(t) from public.${table} t where ${where})::text, '');`, null);
          return { data: r.out ? JSON.parse(r.out) : null, error: r.error };
        },
      };
      return qb;
    },
  };
}
const resolver = async ({ studioId, businessObjectId }: { studioId: string; businessObjectId: string }) => {
  if (!UUID.test(studioId) || !/^[A-Za-z0-9_.:-]{1,255}$/.test(businessObjectId)) return null;
  return (await q(`select count(*) from public.qa_event_fee where id='${businessObjectId}' and studio_id='${studioId}'`)) === "1" ? fakes!.SPEC : null;
};
function ctx(over: Json = {}, inject: Inject[] = []) {
  const stripe = new fakes!.FakeStripe();
  stripe.prefix = `m3d${nextId()}x`;
  const sb = makeSupabase(inject);
  const deps = { supabase: sb, stripe, store: orch!.createSupabaseIntentStore(sb), expectedLivemode: false, env: { D24_HOSTED_INVOICE_CREATION: "on" }, resolvers: { event_fee: resolver }, ...over };
  return { stripe, sb, deps };
}
const actor = (studioId: string) => ({ verified: true, studioId, userId: USER, canManageBilling: true });
const reqOf = (studioId: string, objectId: string, requestKey = `req-${nextId()}-key`) => ({ actor: actor(studioId), businessObjectType: "event_fee", businessObjectId: objectId, requestKey });
const newObject = async (studio: string) => { const id = `bo-${nextId()}`; await q(`insert into public.qa_event_fee (id, studio_id) values ('${id}','${studio}')`); return id; };
const must = (r: Res): Res & { stripeInvoiceId: string; intentId: string } => { if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`); return r as never; };
const FP = "a".repeat(64);   // a syntactically valid request fingerprint for direct ledger calls
// QA-only: backdate created_at (immutable for every API role) by briefly disabling the guard trigger as the superuser; used to cross the safe-retry window without waiting.
const ageIntent = (id: string, interval: string) =>
  runSql(`begin; alter table public.hosted_invoice_creation_intents disable trigger hosted_invoice_intents_guard_trg; update public.hosted_invoice_creation_intents set created_at = now() - interval '${interval}' where id='${id}'; alter table public.hosted_invoice_creation_intents enable trigger hosted_invoice_intents_guard_trg; commit;`, null).then((r) => { if (r.error) throw new Error(r.error.message); });
const crashed = async (p: Promise<unknown>) => { try { await p; return false; } catch { return true; } };

// ---- DB assertions ----
const intentRow = (id: string) => q(`select status||'/'||attempt_count||'/'||coalesce(stripe_invoice_id,'-') from public.hosted_invoice_creation_intents where id='${id}'`);
const intentEvents = (id: string) => q(`select coalesce(string_agg(event_kind, ',' order by id),'') from public.hosted_invoice_creation_intent_events where intent_id='${id}'`);
const intentsForObject = (obj: string) => q(`select count(*) from public.hosted_invoice_creation_intents where business_object_id='${obj}'`);
const registryOf = (inv: string) => q(`select coalesce(string_agg(studio_id||'/'||coalesce(stripe_account_id,'-')||'/'||business_object_type||'/'||business_object_id, ';'),'') from public.hosted_invoice_registry where stripe_invoice_id='${inv}'`);
const regCount = (inv: string) => q(`select count(*) from public.hosted_invoice_registry where stripe_invoice_id='${inv}'`);
const factsOf = (inv: string) =>
  q(`select (select count(*) from public.hosted_invoice_payments where stripe_invoice_id='${inv}')||'/'||(select count(*) from public.hosted_credit_notes where stripe_invoice_id='${inv}')||'/'||(select count(*) from public.hosted_invoice_status_transitions t join public.hosted_invoices i on i.id=t.invoice_row_id where i.stripe_invoice_id='${inv}')||'/'||(select count(*) from public.hosted_invoices where stripe_invoice_id='${inv}')`);
const hostedStudio = (inv: string, acct: string) => q(`select coalesce(studio_id::text,'NULL')||'/'||reconciliation_state||'/'||classification from public.hosted_invoices where stripe_invoice_id='${inv}' and account_key='${acct}'`);
const allFactTotals = () => q(`select (select count(*) from public.hosted_invoices)||'/'||(select count(*) from public.hosted_invoice_payments)||'/'||(select count(*) from public.hosted_credit_notes)||'/'||(select count(*) from public.hosted_invoice_status_transitions)||'/'||(select count(*) from public.hosted_invoice_source_events)`);
const ledgerTotals = () => q(`select (select count(*) from public.hosted_invoice_creation_intents)||'/'||(select count(*) from public.hosted_invoice_creation_intent_events)||'/'||(select count(*) from public.hosted_invoice_registry)`);

// ---- signed offline webhook fixtures (same pattern as acceptance.test.ts) ----
const invoiceObj = (id: string, status: "void" | "uncollectible", extra: Json = {}) => ({ id, object: "invoice", status, total: 5500, amount_due: 5500, amount_paid: 0, amount_remaining: 5500, currency: "usd", ...extra });
const payObj = (id: string, invoice: string, amount = 5500) => ({ id, object: "invoice_payment", invoice, status: "paid", amount_requested: amount, amount_paid: amount, currency: "usd" });
const noteObj = (id: string, invoice: string) => ({ id, object: "credit_note", invoice, status: "issued", total: 700, currency: "usd", type: "post_payment" });
function envelope(type: string, object: Json, o: { account?: string; livemode?: boolean } = {}) {
  const id = `evt_${nextId()}`;
  const body = JSON.stringify({ id, object: "event", type, api_version: "2026-03-25.dahlia", created: ++clock, data: { object }, livemode: o.livemode ?? false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, ...(o.account ? { account: o.account } : {}) });
  return { id, body };
}
const sign = (body: string, secret: string) => realStripe.webhooks.generateTestHeaderString({ payload: body, secret } as HeaderOptions);
async function deliver(type: string, object: Json, account?: string) {
  const e = envelope(type, object, { account });
  const secret = account ? CONNECT_SECRET : PLATFORM_SECRET;
  const res = await sigStore.run({ sig: sign(e.body, secret) }, () => route!.POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body: e.body })));
  return { status: res.status, id: e.id };
}
const claimRow = (id: string) => q(`select coalesce(status,'-')||'/'||coalesce(outcome,'-') from public.payment_provider_events where provider_event_id='${id}'`);
const MODE = (m: string | undefined) => { if (m === undefined) delete process.env.D24_HOSTED_INVOICE_EVENTS; else process.env.D24_HOSTED_INVOICE_EVENTS = m; };

beforeAll(async () => {
  if (overlay && fs.existsSync(path.join(overlay, "src/lib/payments/stripe.ts"))) throw new Error("a loaded layer ships src/lib/payments/stripe.ts: the offline Stripe mock would not cover it; refusing to run");
  if (!STACK || !has("m3a")) return;
  await q(`insert into public.studios (id, name, stripe_connected_account_id, stripe_connect_charges_enabled) values
    ('${SA}','M3D A','${ACCT_A}',true),('${SB}','M3D B','${ACCT_B}',true),('${SN}','M3D none',null,true),('${SD}','M3D no charges','acct_m3dacctD',false) on conflict do nothing`);
  await q(`create table if not exists public.qa_event_fee (id text primary key, studio_id uuid not null);
    create or replace function public.d24_qa_owns_event_fee(p_studio uuid, p_obj text) returns boolean language sql stable set search_path = pg_catalog, public
      as $f$ select exists (select 1 from public.qa_event_fee where id = p_obj and studio_id = p_studio) $f$;
    do $r$ begin
      if not exists (select 1 from public.hosted_invoice_business_object_types where business_object_type = 'event_fee') then
        perform public.d24_register_business_object_type('event_fee', 'public.d24_qa_owns_event_fee(uuid,text)'::regprocedure);
      end if;
    end $r$;`);
});
beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-only";
  process.env.STRIPE_SECRET_KEY = "sk_test_d24_m3d_not_a_real_key";
  MODE("on");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network is not allowed in D24 acceptance tests"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); MODE(undefined); });

// =====================================================================================================================================================
// ---- M3-C composed fixtures (real action / authorizer / resolver / SQL; the signed-in session is the only thing replaced) ----
const C3 = { owner: "00000000-0000-0000-0000-0000000d3c01", admin: "00000000-0000-0000-0000-0000000d3c02", front: "00000000-0000-0000-0000-0000000d3c03", instructor: "00000000-0000-0000-0000-0000000d3c04", otherOwner: "00000000-0000-0000-0000-0000000d3c05", platform: "00000000-0000-0000-0000-0000000d3c06", noRole: "00000000-0000-0000-0000-0000000d3c07" };
const C3_CLIENT = "00000000-0000-0000-0000-0000000d3cc1";
let c3Fixture: Promise<void> | null = null;
const m3cFixture = () => (c3Fixture ??= (async () => {
  // limits ship NULL (fail closed); the owner/migration supplies numbers - QA values only
  await q(`update public.studio_client_invoice_limits set min_total_cents = 50, max_total_cents = 1000000 where singleton`);
  await q(`insert into public.profiles (id, platform_role) values ('${C3.platform}','platform_admin') on conflict do nothing;
    insert into public.user_studio_roles (user_id, studio_id, role, active) values
      ('${C3.owner}','${SA}','studio_owner',true),('${C3.admin}','${SA}','studio_admin',true),('${C3.front}','${SA}','front_desk',true),
      ('${C3.instructor}','${SA}','instructor',true),('${C3.otherOwner}','${SB}','studio_owner',true);
    insert into public.clients (id, studio_id, first_name, last_name, email) values ('${C3_CLIENT}','${SA}','Casey','Dancer','casey@example.test') on conflict do nothing`);
})());
const draftForm = (requestKey: string, clientId = C3_CLIENT) => {
  const fd = new FormData();
  fd.set("requestKey", requestKey); fd.set("clientId", clientId);
  fd.set("line_description_0", "Private lesson"); fd.set("line_quantity_0", "2"); fd.set("line_price_0", "75.00");
  fd.set("line_description_1", "Studio fee"); fd.set("line_quantity_1", "1"); fd.set("line_price_1", "10.00");
  return fd;
};
/** Runs the REAL saveClientInvoiceDraftAction as `userId` with the session studio `studioId`. */
async function saveDraftAs(userId: string | null, studioId: string | null, requestKey: string): Promise<{ redirect?: string; error?: string }> {
  sess.userId = userId; sess.studioId = studioId;
  try {
    const r = await c395!.actions.saveClientInvoiceDraftAction({ error: "" }, draftForm(requestKey));
    return { error: r.error };
  } catch (e) {
    const m = String((e as Error).message);
    if (m.startsWith("NEXT_REDIRECT:")) return { redirect: m.slice("NEXT_REDIRECT:".length) };
    throw e;
  }
}
const invoiceIdFrom = (redirectUrl: string | undefined) => /\/invoices\/([0-9a-f-]{36})\?saved=1/.exec(redirectUrl ?? "")?.[1] ?? "";
const draftCount = (requestKey: string) => q(`select count(*) from public.studio_client_invoices where request_key = '${requestKey}'`);

describe("M3-CREATE. studio-issued draft invoice end to end (M3-A SQL + M3-B orchestrator + offline fake Stripe)", () => {
  T(M3, "C1 creates a DRAFT send_invoice in the studio's own connected account, then registers it atomically with the intent; nothing is finalized, sent or paid", async () => {
    const { stripe, deps } = ctx();
    const obj = await newObject(SA);
    const r = must(await orch!.createHostedInvoice(reqOf(SA, obj), deps));
    expect(r).toMatchObject({ ok: true, state: "registered", livemode: false });
    expect(stripe.calls.map((c) => c.op)).toEqual(["create", "lines"]);
    for (const c of stripe.calls) expect(c.account).toBe(ACCT_A);
    expect(stripe.calls[0].params).toMatchObject({ collection_method: "send_invoice", auto_advance: false });
    expect(await registryOf(r.stripeInvoiceId)).toBe(`${SA}/${ACCT_A}/event_fee/${obj}`);
    expect(await intentRow(r.intentId)).toBe(`registered/1/${r.stripeInvoiceId}`);
    expect(await q(`select (registry_id::text = (select id::text from public.hosted_invoice_registry where stripe_invoice_id='${r.stripeInvoiceId}'))::text from public.hosted_invoice_creation_intents where id='${r.intentId}'`)).toBe("true");
  });
  T(M3, "C2 creation and registration infer NO settlement: no payment, credit note, transition or paid fact exists for the invoice", async () => {
    const { deps } = ctx();
    const before = await allFactTotals();
    const r = must(await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), deps));
    expect(await factsOf(r.stripeInvoiceId)).toBe("0/0/0/0");
    expect(await allFactTotals()).toBe(before);
    expect(await q(`select count(*) from public.hosted_invoices where stripe_invoice_id='${r.stripeInvoiceId}' and (coalesce(amount_paid,0) > 0 or status = 'paid')`)).toBe("0");
  });
  T(M3, "C3 the creation flag is OFF by default: creation_disabled, no Stripe call, no ledger row", async () => {
    const { stripe, deps } = ctx({ env: {} });
    const before = await ledgerTotals();
    expect(await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), deps)).toMatchObject({ ok: false, code: "creation_disabled" });
    expect(stripe.calls).toEqual([]);
    expect(await ledgerTotals()).toBe(before);
    expect(orch!.livemodeFromSecretKey("sk_test_x")).toBe(false);
  });
  T(M3, "C4 an unknown deployment key mode refuses everything before any database or Stripe access", async () => {
    const { stripe, deps } = ctx({ expectedLivemode: orch!.livemodeFromSecretKey("pk_whatever") });
    const before = await ledgerTotals();
    expect(await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), deps)).toMatchObject({ ok: false, code: "deployment_key_mode_unknown" });
    expect(stripe.calls).toEqual([]);
    expect(await ledgerTotals()).toBe(before);
  });
  T(M3, "C5 a forged actor (not verified / not a billing manager / bad ids) is not authorized and touches nothing", async () => {
    const { stripe, deps } = ctx();
    const before = await ledgerTotals();
    const obj = await newObject(SA);
    for (const a of [{ ...actor(SA), verified: false }, { ...actor(SA), canManageBilling: false }, { ...actor(SA), studioId: "not-a-uuid" }, null, {}]) {
      expect(await orch!.createHostedInvoice({ ...reqOf(SA, obj), actor: a }, deps)).toMatchObject({ ok: false, code: "not_authorized" });
    }
    expect(stripe.calls).toEqual([]);
    expect(await ledgerTotals()).toBe(before);
  });
  T(M3, "C6 the same request key twice yields ONE invoice: the second call returns the same registered invoice with no new Stripe call", async () => {
    const { stripe, deps } = ctx();
    const req = reqOf(SA, await newObject(SA));
    const a = must(await orch!.createHostedInvoice(req, deps));
    const calls = stripe.calls.length;
    const b = must(await orch!.createHostedInvoice(req, deps));
    expect(b.stripeInvoiceId).toBe(a.stripeInvoiceId);
    expect(b.intentId).toBe(a.intentId);
    expect(stripe.calls.length).toBe(calls);
    expect(stripe.createCount).toBe(1);
    expect(await regCount(a.stripeInvoiceId)).toBe("1");
  });
  T(M3, "C7 a SECOND request key for an object that already has a live invoice is refused by the ledger (one live intent per object): no second invoice", async () => {
    const { stripe, deps } = ctx();
    const obj = await newObject(SA);
    must(await orch!.createHostedInvoice(reqOf(SA, obj, "req-first-key-0001"), deps));
    expect(await orch!.createHostedInvoice(reqOf(SA, obj, "req-second-key-0002"), deps)).toMatchObject({ ok: false, code: "intent_payload_conflict", retryable: false });
    expect(stripe.createCount).toBe(1);
    expect(await intentsForObject(obj)).toBe("1");
  });
  T(M3, "C8 eight CONCURRENT identical requests produce exactly one Stripe invoice, one intent, one registry row", async () => {
    const { stripe, deps } = ctx();
    const req = reqOf(SA, await newObject(SA));
    const rs = await Promise.all(Array.from({ length: 8 }, () => orch!.createHostedInvoice(req, deps)));
    expect(rs.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    expect(stripe.createCount).toBe(1);
    for (const r of rs) if (!r.ok && r.intentId) await orch!.resumeIntent(r.intentId, { system: "d24_recovery" }, deps);
    expect(stripe.createCount).toBe(1);
    const intents = await q(`select string_agg(id::text, ',') from public.hosted_invoice_creation_intents where business_object_id='${req.businessObjectId}'`);
    expect(intents.split(",")).toHaveLength(1);
    expect(await q(`select count(*) from public.hosted_invoice_registry r join public.hosted_invoice_creation_intents i on i.registry_id = r.id where i.business_object_id='${req.businessObjectId}'`)).toBe("1");
    expect(await q(`select status from public.hosted_invoice_creation_intents where business_object_id='${req.businessObjectId}'`)).toBe("registered");
  });
  T(M3, "C9 concurrent requests for DIFFERENT objects of one studio each get their own invoice (no cross-talk, no lost update)", async () => {
    const { stripe, deps } = ctx();
    const objs = await Promise.all(Array.from({ length: 5 }, () => newObject(SA)));
    const rs = await Promise.all(objs.map((o) => orch!.createHostedInvoice(reqOf(SA, o), deps)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(new Set(rs.map((r) => r.stripeInvoiceId)).size).toBe(5);
    expect(stripe.createCount).toBe(5);
  });
  T(M3, "C10 the same request key in two DIFFERENT studios never collides (each studio gets its own invoice under its own account)", async () => {
    const { stripe, deps } = ctx();
    const key = `req-shared-${nextId()}`;
    const a = must(await orch!.createHostedInvoice(reqOf(SA, await newObject(SA), key), deps));
    const b = must(await orch!.createHostedInvoice(reqOf(SB, await newObject(SB), key), deps));
    expect(a.stripeInvoiceId).not.toBe(b.stripeInvoiceId);
    expect(stripe.calls.filter((c) => c.op === "create").map((c) => c.account).sort()).toEqual([ACCT_A, ACCT_B]);
    expect((await registryOf(a.stripeInvoiceId)).startsWith(SA)).toBe(true);
    expect((await registryOf(b.stripeInvoiceId)).startsWith(SB)).toBe(true);
  });
});

// =====================================================================================================================================================
describe("M3-RECOVERY. crash points and replay (the intent ledger is written BEFORE any provider call)", () => {
  T(M3, "R1 Stripe succeeds, then the database registration fails: intent stays provider_created and resume registers with NO second Stripe call", async () => {
    const { stripe, deps } = ctx({}, [{ rpc: "d24_intent_register", mode: "error", code: "57014", times: 1 }]);
    const r1 = await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), deps);
    expect(r1).toMatchObject({ ok: false, retryable: true });
    expect(await intentRow(r1.intentId!)).toMatch(/^provider_created\/1\/in_/);
    const calls = stripe.calls.length;
    const r2 = must(await orch!.resumeIntent(r1.intentId!, { system: "d24_recovery" }, deps));
    expect(stripe.calls.length).toBe(calls);
    expect(stripe.createCount).toBe(1);
    expect(await regCount(r2.stripeInvoiceId)).toBe("1");
    expect(await intentEvents(r1.intentId!)).toBe("created,provider_created,registered");
  });
  T(M3, "R2 Stripe succeeds, then the provider_created write fails (error): the orchestrator holds the intent in needs_review WITH the invoice id (never silently pending), and a replay of the same key is refused without a Stripe call", async () => {
    const { stripe, deps } = ctx({}, [{ rpc: "d24_intent_mark_provider_created", mode: "error", code: "57014", times: 1 }]);
    const req = reqOf(SA, await newObject(SA));
    const r1 = await orch!.createHostedInvoice(req, deps);
    expect(r1).toMatchObject({ ok: false, retryable: false });
    const inv = [...stripe.invoices.keys()][0];
    expect(await q(`select status||'/'||coalesce(stripe_invoice_id,'-') from public.hosted_invoice_creation_intents where id='${r1.intentId}'`)).toBe(`needs_review/${inv}`);
    const calls = stripe.calls.length;
    expect(await orch!.createHostedInvoice(req, deps)).toMatchObject({ ok: false, code: "needs_review" });
    expect(stripe.calls.length).toBe(calls);
    expect(stripe.createCount).toBe(1);
    expect(await regCount(inv)).toBe("0");
  });
  T(M3, "R3 the process CRASHES after the Stripe call and before provider_created is persisted: intent still pending, replay with the same idempotency key converges to one invoice", async () => {
    const { stripe, deps } = ctx({}, [{ rpc: "d24_intent_mark_provider_created", mode: "throw", times: 1 }]);
    const req = reqOf(SA, await newObject(SA));
    expect(await crashed(orch!.createHostedInvoice(req, deps))).toBe(true);
    expect(stripe.createCount).toBe(1);
    const pending = await q(`select id::text||'/'||status from public.hosted_invoice_creation_intents where business_object_id='${req.businessObjectId}'`);
    expect(pending.endsWith("/pending")).toBe(true);
    const r = must(await orch!.createHostedInvoice(req, deps));   // restart: same request key => same derived idempotency key => Stripe returns the original
    expect(stripe.createCount).toBe(1);
    expect(r.intentId).toBe(pending.split("/")[0]);
    expect(await regCount(r.stripeInvoiceId)).toBe("1");
    expect(new Set(stripe.calls.filter((c) => c.op === "create").map((c) => c.key)).size).toBe(1);
  });
  T(M3, "R4 the process crashes after the database COMMITTED provider_created but before the response was handled: replay registers without a second Stripe call", async () => {
    const { stripe, deps } = ctx({}, [{ rpc: "d24_intent_mark_provider_created", mode: "throw", after: true, times: 1 }]);
    const req = reqOf(SA, await newObject(SA));
    expect(await crashed(orch!.createHostedInvoice(req, deps))).toBe(true);
    expect(await q(`select status from public.hosted_invoice_creation_intents where business_object_id='${req.businessObjectId}'`)).toBe("provider_created");
    const calls = stripe.calls.length;
    const r = must(await orch!.createHostedInvoice(req, deps));
    expect(stripe.calls.length).toBe(calls);
    expect(stripe.createCount).toBe(1);
    expect(await regCount(r.stripeInvoiceId)).toBe("1");
  });
  T(M3, "R5 the database call succeeds (d24_intent_begin committed) and the process dies BEFORE any Stripe call: replay creates exactly one invoice", async () => {
    const { stripe, deps } = ctx();
    const req = reqOf(SA, await newObject(SA));
    // the app got as far as the ledger and died: perform exactly that step with the key the orchestrator derives
    const key = orch!.deriveIdempotencyKey(SA, "event_fee", req.businessObjectId, req.requestKey);
    const begun = await deps.store.begin({ studioId: SA, createdBy: USER, idempotencyKey: key, requestFingerprint: orch!.deriveRequestFingerprint(SA, "event_fee", req.businessObjectId, fakes!.SPEC, ACCT_A, false), businessObjectType: "event_fee", businessObjectId: req.businessObjectId });
    expect(begun.ok).toBe(true);
    expect(stripe.calls).toEqual([]);
    expect(await q(`select status from public.hosted_invoice_creation_intents where business_object_id='${req.businessObjectId}'`)).toBe("pending");
    const r = must(await orch!.createHostedInvoice(req, deps));
    expect(stripe.createCount).toBe(1);
    expect(await regCount(r.stripeInvoiceId)).toBe("1");
    expect(await intentRow(r.intentId)).toBe(`registered/2/${r.stripeInvoiceId}`);
  });
  T(M3, "R6 a connection error is an AMBIGUOUS end (the invoice may exist): outcome_unknown is recorded, an app retry does NOT call Stripe, the DB recovery claim replays the original key once", async () => {
    const { stripe, deps } = ctx();
    stripe.failNext = Object.assign(new Error("net"), { type: "StripeConnectionError" });
    const req = reqOf(SA, await newObject(SA));
    const r1 = await orch!.createHostedInvoice(req, deps);
    expect(r1).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(await q(`select status||'/'||outcome_unknown::text from public.hosted_invoice_creation_intents where id='${r1.intentId}'`)).toBe("pending/true");
    const calls = stripe.calls.length;
    expect(await orch!.createHostedInvoice(req, deps)).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(stripe.calls.length).toBe(calls);
    must(await orch!.resumeIntent(r1.intentId!, { system: "d24_recovery" }, deps));
    expect(stripe.createCount).toBe(1);
  });
  T(M3, "R7 a PERMANENT Stripe rejection fails the intent: no registry row, the object is released for a fresh attempt, error text never leaks", async () => {
    const { stripe, deps } = ctx();
    stripe.failNext = Object.assign(new Error("card_secret_detail_xyz"), { type: "StripeInvalidRequestError", statusCode: 400 });
    const obj = await newObject(SA);
    const r1 = await orch!.createHostedInvoice(reqOf(SA, obj, "req-reject-key-0001"), deps);
    expect(r1).toMatchObject({ ok: false, code: "stripe_rejected", retryable: false });
    expect(JSON.stringify(r1)).not.toContain("card_secret_detail_xyz");
    expect(await intentRow(r1.intentId!)).toBe("failed/1/-");
    expect(await q(`select last_error_code from public.hosted_invoice_creation_intents where id='${r1.intentId}'`)).toBe("stripe_rejected");
    const r2 = must(await orch!.createHostedInvoice(reqOf(SA, obj, "req-reject-key-0002"), deps));
    expect(await regCount(r2.stripeInvoiceId)).toBe("1");
  });
  T(M3, "R8 resume authorization: another studio cannot resume the intent (indistinguishable from unknown); the system actor can", async () => {
    const { stripe, deps } = ctx();
    stripe.failNext = Object.assign(new Error("net"), { type: "StripeConnectionError" });
    const r1 = await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), deps);
    expect(await orch!.resumeIntent(r1.intentId!, actor(SB), deps)).toMatchObject({ ok: false, code: "intent_not_found" });
    expect(await orch!.resumeIntent("00000000-0000-4000-8000-000000000000", actor(SB), deps)).toMatchObject({ ok: false, code: "intent_not_found" });
    expect(stripe.createCount).toBe(0);
    expect(await orch!.resumeIntent(r1.intentId!, { system: "d24_recovery" }, deps)).toMatchObject({ ok: true });
    expect(stripe.createCount).toBe(1);
  });
  T(M3, "R10 recovery after the safe-retry window: the intent goes to needs_review and NOTHING is sent to Stripe, even though the fake has PRUNED its idempotency keys (a replay would visibly create a second invoice)", async () => {
    const { stripe, deps } = ctx();
    stripe.loseResponseAfterCreate = Object.assign(new Error("timeout"), { type: "StripeConnectionError" });
    const req = reqOf(SA, await newObject(SA));
    const r1 = await orch!.createHostedInvoice(req, deps);
    expect(r1).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(stripe.createCount).toBe(1);
    await ageIntent(r1.intentId!, "13 hours");
    stripe.keys.clear();   // Stripe has forgotten the key: a replay would now create a SECOND invoice
    const calls = stripe.calls.length;
    expect(await orch!.resumeIntent(r1.intentId!, { system: "d24_recovery" }, deps)).toMatchObject({ ok: false, code: "needs_review" });
    expect(await orch!.createHostedInvoice(req, deps)).toMatchObject({ ok: false, code: "needs_review" });
    expect(stripe.calls.length).toBe(calls);
    expect(stripe.createCount).toBe(1);
    expect(await q(`select status from public.hosted_invoice_creation_intents where id='${r1.intentId}'`)).toBe("needs_review");
    expect(await regCount([...stripe.invoices.keys()][0])).toBe("0");
  });
});

// =====================================================================================================================================================
describe("M3-WEBHOOK. out-of-order webhooks around creation/registration (REAL route, offline signed fixtures, Connect secret)", () => {
  const stuck = async (studio = SA) => {
    const c = ctx({}, [{ rpc: "d24_intent_register", mode: "error", code: "57014", times: 1 }]);
    const r = await orch!.createHostedInvoice(reqOf(studio, await newObject(studio)), c.deps);
    expect(r.ok).toBe(false);
    const inv = [...c.stripe.invoices.keys()][0];
    return { ...c, intentId: r.intentId!, inv, acct: studio === SA ? ACCT_A : ACCT_B };
  };
  T(M3, "W1 invoice.voided arrives BEFORE registration: kept unmatched (no studio), then registration adopts it into the studio", async () => {
    const s = await stuck();
    const r = await deliver("invoice.voided", invoiceObj(s.inv, "void"), s.acct);
    expect(r.status).toBe(200);
    expect(await hostedStudio(s.inv, s.acct)).toBe("NULL/unmatched/unresolved");
    const done = must(await orch!.resumeIntent(s.intentId, { system: "d24_recovery" }, s.deps));
    expect(done.adoptedExistingFacts).toBe(true);
    expect((await hostedStudio(s.inv, s.acct)).startsWith(`${SA}/`)).toBe(true);
    expect(await q(`select classification from public.hosted_invoices where stripe_invoice_id='${s.inv}' and account_key='${s.acct}'`)).toBe("registered");
  });
  T(M3, "W2 invoice_payment.paid arrives BEFORE registration: the payment is kept unattributed, registration adopts it; the amount comes only from the event", async () => {
    const s = await stuck();
    await deliver("invoice_payment.paid", payObj(`inpay_${nextId()}`, s.inv, 5555), s.acct);
    expect(await q(`select coalesce(studio_id::text,'NULL') from public.hosted_invoice_payments where stripe_invoice_id='${s.inv}'`)).toBe("NULL");
    const done = must(await orch!.resumeIntent(s.intentId, { system: "d24_recovery" }, s.deps));
    expect(done.adoptedExistingFacts).toBe(true);
    expect(await q(`select studio_id::text||'/'||amount_paid from public.hosted_invoice_payments where stripe_invoice_id='${s.inv}'`)).toBe(`${SA}/5555`);
  });
  T(M3, "W3 credit_note.created arrives BEFORE registration: unattributed until registration, then attributed to the issuing studio only", async () => {
    const s = await stuck();
    await deliver("credit_note.created", noteObj(`cn_${nextId()}`, s.inv), s.acct);
    expect(await q(`select coalesce(studio_id::text,'NULL') from public.hosted_credit_notes where stripe_invoice_id='${s.inv}'`)).toBe("NULL");
    must(await orch!.resumeIntent(s.intentId, { system: "d24_recovery" }, s.deps));
    expect(await q(`select studio_id::text from public.hosted_credit_notes where stripe_invoice_id='${s.inv}'`)).toBe(SA);
  });
  T(M3, "W4 a payment, a credit note and a void all before registration, in reverse order: one adopted invoice with each child exactly once", async () => {
    const s = await stuck();
    await deliver("credit_note.created", noteObj(`cn_${nextId()}`, s.inv), s.acct);
    await deliver("invoice_payment.paid", payObj(`inpay_${nextId()}`, s.inv, 5500), s.acct);
    await deliver("invoice.voided", invoiceObj(s.inv, "void"), s.acct);
    must(await orch!.resumeIntent(s.intentId, { system: "d24_recovery" }, s.deps));
    expect(await q(`select count(*) from public.hosted_invoices where stripe_invoice_id='${s.inv}'`)).toBe("1");
    expect(await q(`select (select count(*) from public.hosted_invoice_payments where stripe_invoice_id='${s.inv}' and studio_id='${SA}')||'/'||(select count(*) from public.hosted_credit_notes where stripe_invoice_id='${s.inv}' and studio_id='${SA}')`)).toBe("1/1");
  });
  T(M3, "W5 missing registry: Stripe created the draft but the app never recorded it (crash before mark): its events stay unmatched even though Stripe metadata names the intent and studio", async () => {
    const c = ctx({}, [{ rpc: "d24_intent_mark_provider_created", mode: "throw", times: 1 }]);
    const req = reqOf(SA, await newObject(SA));
    expect(await crashed(orch!.createHostedInvoice(req, c.deps))).toBe(true);
    const inv = [...c.stripe.invoices.keys()][0];
    const intentId = await q(`select id::text from public.hosted_invoice_creation_intents where business_object_id='${req.businessObjectId}'`);
    const r = await deliver("invoice.voided", invoiceObj(inv, "void", { metadata: { d24_intent_id: intentId, df_studio_id: SA, df_registry_id: "11111111-1111-4111-8111-111111111111" } }), ACCT_A);
    expect(r.status).toBe(200);
    expect(await hostedStudio(inv, ACCT_A)).toBe("NULL/unmatched/unresolved");
    expect(await regCount(inv)).toBe("0");
  });
  T(M3, "W6 events AFTER registration are attributed directly; a duplicate delivery of the same event id changes nothing", async () => {
    const { deps } = ctx();
    const r = must(await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), deps));
    const e = envelope("invoice_payment.paid", payObj(`inpay_${nextId()}`, r.stripeInvoiceId, 5500), { account: ACCT_A });
    const post = () => sigStore.run({ sig: sign(e.body, CONNECT_SECRET) }, () => route!.POST(new Request("https://example.test/api/payments/webhook", { method: "POST", body: e.body })));
    expect((await post()).status).toBe(200);
    expect(await q(`select studio_id::text from public.hosted_invoice_payments where stripe_invoice_id='${r.stripeInvoiceId}'`)).toBe(SA);
    const again = await post();
    expect(await again.text()).toBe("Already processed");
    expect(await q(`select count(*) from public.hosted_invoice_payments where stripe_invoice_id='${r.stripeInvoiceId}'`)).toBe("1");
  });
  T(M3, "W7 a payment event for the invoice under ANOTHER Stripe account never attaches to the registered invoice and stays unattributed in its own scope", async () => {
    const { deps } = ctx();
    const r = must(await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), deps));
    await deliver("invoice_payment.paid", payObj(`inpay_${nextId()}`, r.stripeInvoiceId, 5500), ACCT_B);
    expect(await q(`select count(*) from public.hosted_invoice_payments p join public.hosted_invoices i on i.id=p.invoice_row_id where p.stripe_invoice_id='${r.stripeInvoiceId}' and i.account_key='${ACCT_A}'`)).toBe("0");
    expect(await q(`select coalesce(studio_id::text,'NULL') from public.hosted_invoices where stripe_invoice_id='${r.stripeInvoiceId}' and account_key='${ACCT_B}'`)).toBe("NULL");
  });
});

// =====================================================================================================================================================
describe("M3-OWNER. ownership, forgery, subscription exclusion and the permission matrix", () => {
  T(M3, "O1 studio A cannot invoice studio B's object, even with a forged permissive TS resolver (the SQL ownership function refuses); no Stripe call, no ledger row", async () => {
    const objB = await newObject(SB);
    const honest = ctx();
    expect(await orch!.createHostedInvoice(reqOf(SA, objB), honest.deps)).toMatchObject({ ok: false, code: "business_object_not_owned" });
    const forged = ctx({ resolvers: { event_fee: async () => fakes!.SPEC } });
    expect(await orch!.createHostedInvoice(reqOf(SA, objB, "req-forged-key-0002"), forged.deps)).toMatchObject({ ok: false });
    expect(honest.stripe.calls).toEqual([]);
    expect(forged.stripe.calls).toEqual([]);
    expect(await intentsForObject(objB)).toBe("0");
  });
  T(M3, "O2 a studio without a usable connected account (none / charges disabled) is refused with no ledger row and no Stripe call", async () => {
    for (const s of [SN, SD]) {
      const { stripe, deps } = ctx();
      const obj = await newObject(s);
      expect(await orch!.createHostedInvoice(reqOf(s, obj), deps)).toMatchObject({ ok: false, code: "stripe_account_unavailable" });
      expect(stripe.calls).toEqual([]);
      expect(await intentsForObject(obj)).toBe("0");
    }
  });
  T(["m3a"], "O3 SQL level: the studio's account is resolved INSIDE the database; begin for a studio without an account is refused, and a supplied account is only an assertion", async () => {
    const obj = await newObject(SN);
    expect((await rpc("d24_intent_begin", { p_studio_id: SN, p_business_object_type: "event_fee", p_business_object_id: obj, p_idempotency_key: `d24inv_${nextId()}_0001`, p_request_fingerprint: FP, p_created_by: USER })).error?.code).toBe("42501");
    const inv = `in_${nextId()}`;
    const reg = (studio: string, acct: string | null) => rpc("d24_register_invoice", { p_studio_id: studio, p_stripe_account_id: acct, p_stripe_invoice_id: inv, p_livemode: false, p_business_object_type: "event_fee", p_business_object_id: "bo-x" });
    expect((await reg(SA, ACCT_B)).error?.code).toBe("42501");        // forged account for studio A
    expect((await reg(SN, null)).error?.code).toBe("42501");           // platform scope / no account: refused
    expect((await reg(SA, null)).error).toBeNull();                    // account omitted: derived from the studio
    expect(await registryOf(inv)).toBe(`${SA}/${ACCT_A}/event_fee/bo-x`);
  });
  T(["m3a"], "O4 account ownership conflict: studio B registering studio A's invoice id is refused (23505) whatever account it names or omits; A's registration is untouched", async () => {
    const inv = `in_${nextId()}`;
    const reg = (studio: string, acct: string | null) => rpc("d24_register_invoice", { p_studio_id: studio, p_stripe_account_id: acct, p_stripe_invoice_id: inv, p_livemode: false, p_business_object_type: "event_fee", p_business_object_id: "bo-own" });
    expect((await reg(SA, ACCT_A)).error).toBeNull();
    expect((await reg(SB, ACCT_B)).error?.code).toBe("23505");
    expect((await reg(SB, null)).error?.code).toBe("23505");
    expect((await reg(SB, ACCT_A)).error?.code).toBe("42501");
    expect((await reg(SA, ACCT_A)).data).toMatchObject({ outcome: "already_registered" });
    expect(await registryOf(inv)).toBe(`${SA}/${ACCT_A}/event_fee/bo-own`);
  });
  T(M3, "O5 end to end: Stripe answers studio B's creation with studio A's registered invoice id: registration is refused, the intent fails permanently, A's registry row is untouched", async () => {
    const a = ctx();
    const ra = must(await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), a.deps));
    const b = ctx();
    const create = b.stripe.createDraftInvoice.bind(b.stripe);
    b.stripe.createDraftInvoice = async (args: Json) => {
      const snap = await create(args);
      const inv = b.stripe.invoices.get(snap.id)!;
      b.stripe.invoices.delete(snap.id);
      inv.id = ra.stripeInvoiceId;
      b.stripe.invoices.set(ra.stripeInvoiceId, inv);
      return { ...snap, id: ra.stripeInvoiceId };
    };
    const before = await registryOf(ra.stripeInvoiceId);
    const res = await orch!.createHostedInvoice(reqOf(SB, await newObject(SB)), b.deps);
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect(before.startsWith(`${SA}/${ACCT_A}/`)).toBe(true);
    expect(await registryOf(ra.stripeInvoiceId)).toBe(before);
    expect(await regCount(ra.stripeInvoiceId)).toBe("1");
    expect(await q(`select status from public.hosted_invoice_creation_intents where id='${res.intentId}'`)).toBe("needs_review");
  });
  T(M3, "O6 livemode forgery both ways: a live response in a test deployment and a test response in a live deployment are refused; the intent fails and nothing is registered", async () => {
    for (const [expected, responseLive] of [[false, true], [true, false]] as const) {
      const { stripe, deps } = ctx({ expectedLivemode: expected });
      stripe.livemode = responseLive;
      const obj = await newObject(SA);
      const res = await orch!.createHostedInvoice(reqOf(SA, obj), deps);
      expect(res).toMatchObject({ ok: false, code: "livemode_mismatch" });
      expect(await q(`select status from public.hosted_invoice_creation_intents where id='${res.intentId}'`)).toBe("needs_review");
      expect(await q(`select count(*) from public.hosted_invoice_registry r join public.hosted_invoice_creation_intents i on i.stripe_invoice_id=r.stripe_invoice_id where i.id='${res.intentId}'`)).toBe("0");
    }
  });
  T(["m3a"], "O7 SQL level forgery: mark_provider_created refuses a livemode that disagrees with the key mode, a foreign account and a foreign studio; the intent stays pending", async () => {
    const obj = await newObject(SA);
    const key = `d24inv_${nextId()}_forge`;
    const begun = await rpc("d24_intent_begin", { p_studio_id: SA, p_business_object_type: "event_fee", p_business_object_id: obj, p_idempotency_key: key, p_request_fingerprint: FP, p_created_by: USER });
    const id = (begun.data as { intent_id: string }).intent_id;
    const mark = (studio: string, live: boolean, keyLive: boolean, acct: string | null) => rpc("d24_intent_mark_provider_created", { p_intent_id: id, p_studio_id: studio, p_stripe_invoice_id: `in_${nextId()}`, p_livemode: live, p_key_livemode: keyLive, p_stripe_account_id: acct });
    expect((await mark(SA, true, false, ACCT_A)).error?.code).toBe("42501");
    expect((await mark(SA, false, false, ACCT_B)).error?.code).toBe("42501");
    expect((await mark(SB, false, false, ACCT_A)).error?.code).toBe("42501");
    expect(await intentRow(id)).toBe("pending/1/-");
  });
  T(M3, "O8 metadata ALONE never owns an invoice: a Stripe invoice carrying our intent id and studio in metadata but never registered stays unattributed; no registry row is created by any event", async () => {
    const c = ctx({}, [{ rpc: "d24_intent_mark_provider_created", mode: "throw", times: 1 }]);
    const req = reqOf(SA, await newObject(SA));
    await crashed(orch!.createHostedInvoice(req, c.deps));
    const inv = [...c.stripe.invoices.keys()][0];
    const before = await q("select count(*) from public.hosted_invoice_registry");
    await deliver("invoice.voided", invoiceObj(inv, "void", { metadata: { df_studio_id: SA, d24_intent_id: "x" } }), ACCT_A);
    await deliver("invoice_payment.paid", payObj(`inpay_${nextId()}`, inv, 5500), ACCT_A);
    expect(await hostedStudio(inv, ACCT_A)).toBe("NULL/unmatched/unresolved");
    expect(await q(`select count(*) from public.hosted_invoice_payments where stripe_invoice_id='${inv}' and studio_id is not null`)).toBe("0");
    expect(await q("select count(*) from public.hosted_invoice_registry")).toBe(before);
  });
  T(M3, "O9 subscription invoices are never created or registered: subscription object types are refused by the orchestrator and by the database; a Stripe response with subscription markers is rejected", async () => {
    const { stripe, deps } = ctx();
    const before = await ledgerTotals();
    for (const t of ["membership_subscription", "recurring_membership", "membership_billing"]) {
      expect(await orch!.createHostedInvoice({ ...reqOf(SA, "bo-sub-1"), businessObjectType: t }, deps)).toMatchObject({ ok: false, code: "subscription_object_refused" });
    }
    expect(stripe.calls).toEqual([]);
    expect((await rpc("d24_intent_begin", { p_studio_id: SA, p_business_object_type: "event_subscription", p_business_object_id: "bo-sub-2", p_idempotency_key: `d24inv_${nextId()}_sub`, p_request_fingerprint: FP, p_created_by: USER })).error?.code).toBe("22023");
    expect(await ledgerTotals()).toBe(before);
    // a response that carries subscription markers is not a hosted draft: refused, nothing registered
    const mk = ctx();
    const create = mk.stripe.createDraftInvoice.bind(mk.stripe);
    mk.stripe.createDraftInvoice = async (a: Json) => ({ ...(await create(a)), subscription: "sub_forged" });
    const obj = await newObject(SA);
    const res = await orch!.createHostedInvoice(reqOf(SA, obj), mk.deps);
    expect(res).toMatchObject({ ok: false, code: "stripe_response_invalid" });
    expect(await q(`select count(*) from public.hosted_invoice_registry where business_object_id='${obj}'`)).toBe("0");
  });
  T(["m3a"], "O10 a subscription-classified invoice id stays unregistered and unattributed (an event with subscription markers is classified 'subscription', never a studio's)", async () => {
    const inv = `in_${nextId()}`;
    await deliver("invoice.voided", invoiceObj(inv, "void", { subscription: "sub_m3d", billing_reason: "subscription_cycle" }), ACCT_A);
    expect(await hostedStudio(inv, ACCT_A)).toMatch(/^NULL\/.*\/subscription$/);
    expect(await regCount(inv)).toBe("0");
  });
  T(["m3a"], "O11 permission matrix (database): anon and authenticated (even a studio owner JWT) cannot execute any intent function, read or write the ledger tables, or call the helpers; service_role gets no direct DML or helper access", async () => {
    const claims = (sub: string) => `select set_config('request.jwt.claims','{"sub":"${sub}","role":"authenticated","aal":"aal2","exp":${Math.floor(Date.now() / 1000) + 3600}}',false) is not null;`;
    const fns = [
      "d24_intent_begin('" + SA + "','event_fee','x','d24inv_00000000','" + "a".repeat(64) + "',null)",
      "d24_intent_mark_provider_created(gen_random_uuid(),'" + SA + "','in_x',false,false,null)",
      "d24_intent_register(gen_random_uuid(),'" + SA + "')",
      "d24_intent_fail(gen_random_uuid(),'" + SA + "','x',false)",
      "d24_intent_record_outcome(gen_random_uuid(),'" + SA + "','x',false)",
      "d24_intent_claim_recovery(gen_random_uuid(),'" + SA + "','" + "a".repeat(64) + "',120)",
      "d24_intent_flag_review(gen_random_uuid(),'" + SA + "','x')",
      "d24_intent_list_recoverable(1,1,null)",
    ];
    for (const role of ["anon", "authenticated"]) {
      for (const f of fns) expect(await as(role, `select public.${f}`)).toMatch(/permission denied/);
      for (const t of ["hosted_invoice_creation_intents", "hosted_invoice_creation_intent_events", "hosted_invoice_business_object_types", "hosted_invoice_creation_attempts"]) {
        expect(await as(role, `select count(*) from public.${t}`)).toMatch(/permission denied/);
      }
    }
    const ownerJwt = await runSql(`${claims(USER)} select public.d24_intent_list_recoverable(1,1,null);`, "authenticated");
    expect(ownerJwt.error?.message ?? "").toMatch(/permission denied/);
    for (const f of ["_d24_check_owner('" + SA + "','event_fee','x')", "_d24_studio_account('" + SA + "')", "d24_register_business_object_type('x', 'public.d24_qa_owns_event_fee(uuid,text)'::regprocedure)"]) {
      expect(await as("service_role", `select public.${f}`)).toMatch(/permission denied/);
    }
    for (const dml of [
      `insert into public.hosted_invoice_creation_intents (studio_id,business_object_type,business_object_id,idempotency_key,stripe_account_id) values ('${SA}','event_fee','z','d24inv_direct_0001','${ACCT_A}')`,
      "update public.hosted_invoice_creation_intents set status='failed'",
      "delete from public.hosted_invoice_creation_intents",
      "truncate public.hosted_invoice_creation_intents",
      "insert into public.hosted_invoice_business_object_types (business_object_type, owner_function) values ('zz','public.d24_qa_owns_event_fee(uuid,text)'::regprocedure)",
      "delete from public.hosted_invoice_creation_intent_events",
    ]) expect(await as("service_role", dml)).toMatch(/permission denied/);
    expect(await as("service_role", "select count(*) >= 0 from public.hosted_invoice_creation_intents")).toBe("t");
  });
  T(["m3a", "m3b", "m3c"], "O12 app-level permission matrix through M3-C's REAL server action, authorizer and SQL (the signed-in session is the only thing replaced): studio owner and admin save a draft; front desk, instructor, another studio's owner, a platform admin without a studio role, a role-less user and no session are refused and nothing is written; the database refuses the same users directly", async () => {
    await m3cFixture();
    for (const [label, uid] of [["owner", C3.owner], ["admin", C3.admin]] as const) {
      const k = randomUUID();
      const r = await saveDraftAs(uid, SA, k);
      expect(invoiceIdFrom(r.redirect), label).toMatch(UUID);
      expect(await draftCount(k), label).toBe("1");
    }
    const refused: Array<[string, string | null]> = [["front desk", C3.front], ["instructor", C3.instructor], ["owner of another studio", C3.otherOwner], ["platform admin without a studio role", C3.platform], ["signed-in user with no role", C3.noRole], ["no session", null]];
    for (const [label, uid] of refused) {
      const k = randomUUID();
      const r = await saveDraftAs(uid, uid ? SA : null, k);
      expect(r.redirect, label).toBeUndefined();
      expect(r.error, label).toMatch(/Only the studio owner or an admin/);
      expect(await draftCount(k), label).toBe("0");
      if (uid) {
        // second layer: calling the database function directly as that user is refused too (it takes no actor argument)
        const direct = await rpcAsUser(uid, "aal1", "studio_client_invoice_save_draft", { p_studio_id: SA, p_request_key: randomUUID(), p_invoice_id: null, p_expected_version: null, p_client_id: C3_CLIENT, p_reference_type: null, p_reference_id: null, p_reference_note: null, p_lines: [{ description: "x", quantity: 1, unit_price_cents: 1000 }] });
        expect(direct.error?.message ?? "", label).toContain("client_invoice_forbidden");
      }
    }
    sess.userId = C3.owner; sess.studioId = SA;
    expect(await c395!.authorize.authorizeClientInvoiceActor("draft")).toEqual({ verified: true, studioId: SA, userId: C3.owner, canManageBilling: true });
    sess.userId = C3.front;
    expect(await c395!.authorize.authorizeClientInvoiceActor("draft")).toBeNull();
    sess.userId = C3.platform;
    expect(await c395!.authorize.authorizeClientInvoiceActor("view")).toBeNull();
  });
});

// =====================================================================================================================================================
describe("M3-AUDIT. audit integrity and evidence", () => {
  T(M3, "A1 every transition writes exactly one append-only audit event in order; failures record fixed codes only", async () => {
    const { deps } = ctx({}, [{ rpc: "d24_intent_register", mode: "error", code: "57014", times: 1 }]);
    const r = await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), deps);
    expect(await intentEvents(r.intentId!)).toBe("created,provider_created");
    must(await orch!.resumeIntent(r.intentId!, { system: "d24_recovery" }, deps));
    expect(await intentEvents(r.intentId!)).toBe("created,provider_created,registered");
    const rejected = ctx();
    rejected.stripe.failNext = Object.assign(new Error("secret provider text"), { type: "StripeInvalidRequestError", statusCode: 400 });
    const f = await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), rejected.deps);
    expect(await intentEvents(f.intentId!)).toBe("created,failed");
    expect(await q(`select error_code from public.hosted_invoice_creation_intent_events where intent_id='${f.intentId}' and event_kind='failed'`)).toBe("stripe_rejected");
    expect(await q("select count(*) from public.hosted_invoice_creation_intent_events where error_code is not null and error_code !~ '^[a-z][a-z0-9_]{0,63}$'")).toBe("0");
  });
  T(M3, "A2 the intent ledger and its events are append-only evidence even for a privileged session: no delete, no truncate, no identity rewrite, no illegal transition", async () => {
    const c = ctx();
    const req = reqOf(SA, await newObject(SA));
    const r = must(await orch!.createHostedInvoice(req, c.deps));
    const priv = (sql: string) => runSql(`select set_config('d24.writer','on',false); ${sql}`, null).then((x) => x.error?.message ?? "OK");
    expect(await priv(`delete from public.hosted_invoice_creation_intents where id='${r.intentId}'`)).toMatch(/permanent evidence/);
    expect(await priv(`update public.hosted_invoice_creation_intents set studio_id='${SB}' where id='${r.intentId}'`)).toMatch(/immutable|not allowed|foreign key|violates/);
    expect(await priv(`update public.hosted_invoice_creation_intents set stripe_account_id='acct_forged1' where id='${r.intentId}'`)).toMatch(/immutable/);
    expect(await priv(`update public.hosted_invoice_creation_intents set status='pending' where id='${r.intentId}'`)).toMatch(/terminal|illegal/);
    expect(await priv(`update public.hosted_invoice_creation_intent_events set to_status='x' where intent_id='${r.intentId}'`)).toMatch(/append|only/i);
    expect(await priv("delete from public.hosted_invoice_creation_intent_events")).toMatch(/append|only/i);
    expect(await priv("truncate public.hosted_invoice_creation_intent_events")).toMatch(/append|only/i);
    expect(await priv("truncate public.hosted_invoice_creation_intents")).toMatch(/append|only|cannot truncate/i);
    expect(await intentRow(r.intentId)).toBe(`registered/1/${r.stripeInvoiceId}`);
  });
  T(["m3a"], "A3 a refused begin (unowned object, no account, malformed input) leaves no intent and no audit event behind", async () => {
    const before = await ledgerTotals();
    await rpc("d24_intent_begin", { p_studio_id: SA, p_business_object_type: "event_fee", p_business_object_id: "bo-not-mine-" + nextId(), p_idempotency_key: `d24inv_${nextId()}_x1`, p_request_fingerprint: FP, p_created_by: USER });
    await rpc("d24_intent_begin", { p_studio_id: SN, p_business_object_type: "event_fee", p_business_object_id: await newObject(SN), p_idempotency_key: `d24inv_${nextId()}_x2`, p_request_fingerprint: FP, p_created_by: USER });
    await rpc("d24_intent_begin", { p_studio_id: SA, p_business_object_type: "Bad Type", p_business_object_id: "x", p_idempotency_key: "short", p_request_fingerprint: FP, p_created_by: USER });
    await rpc("d24_intent_begin", { p_studio_id: SA, p_business_object_type: "unregistered_type", p_business_object_id: "x", p_idempotency_key: `d24inv_${nextId()}_x3`, p_request_fingerprint: FP, p_created_by: USER });
    expect(await ledgerTotals()).toBe(before);
  });
  T(M3, "A4 registration atomicity: if the business object stops belonging to the studio between provider_created and registration, NO registry row appears and the intent is held in needs_review (never half-registered)", async () => {
    const { stripe, deps } = ctx({}, [{ rpc: "d24_intent_register", mode: "error", code: "57014", times: 1 }]);
    const obj = await newObject(SA);
    const r1 = await orch!.createHostedInvoice(reqOf(SA, obj), deps);
    const inv = [...stripe.invoices.keys()][0];
    await q(`delete from public.qa_event_fee where id='${obj}'`);
    const r2 = await orch!.resumeIntent(r1.intentId!, { system: "d24_recovery" }, deps);
    expect(r2.ok).toBe(false);
    expect(await regCount(inv)).toBe("0");
    expect(await q(`select (status = 'needs_review')::text||'/'||coalesce(registry_id::text,'none') from public.hosted_invoice_creation_intents where id='${r1.intentId}'`)).toBe("true/none");
    expect(await q(`select count(*) from public.hosted_invoice_creation_intent_events where intent_id='${r1.intentId}' and event_kind='registered'`)).toBe("0");
  });
  T(M3, "A5 no settlement is ever inferred by the creation path: after every scenario above the new D24 invoices have no paid fact the route did not deliver", async () => {
    expect(await q(`select count(*) from public.hosted_invoice_payments p where not exists (select 1 from public.hosted_invoice_source_events e where e.provider_event_id = p.first_event_id)`)).toBe("0");
    expect(await q(`select count(*) from public.hosted_invoice_status_transitions t where not exists (select 1 from public.hosted_invoice_source_events e where e.provider_event_id = t.source_event_id)`)).toBe("0");
  });
});

// =====================================================================================================================================================
// Account-bound re-statements of M1/M2 scenarios that acceptance.test.ts reports SUPERSEDED when M3-A is loaded (their setup registered in platform scope or under
// an arbitrary account, which M3-A refuses by design). The behaviour under test is unchanged by M3-A, so it is asserted again here with the studio's own account.
describe("M3-RETAIN. M1/M2 behaviours re-asserted under M3-A's account-bound registration", () => {
  const reg = (studio: string, inv: string, live = false) =>
    rpc("d24_register_invoice", { p_studio_id: studio, p_stripe_account_id: null, p_stripe_invoice_id: inv, p_livemode: live, p_business_object_type: "event_fee", p_business_object_id: `bo-${inv}` });
  const h = (inv: string, acct: string, expr: string) => q(`select ${expr} from public.hosted_invoices where stripe_invoice_id='${inv}' and account_key='${acct}'`);
  T(["m3a"], "F1 forged metadata naming another studio and its real registry id never re-attributes a registered invoice (flagged metadata_mismatch)", async () => {
    const a = `in_${nextId()}`, b = `in_${nextId()}`;
    await reg(SA, a); await reg(SB, b);
    const bReg = await q(`select id from public.hosted_invoice_registry where stripe_invoice_id='${b}'`);
    await deliver("invoice.voided", invoiceObj(a, "void", { metadata: { df_registry_id: bReg, df_studio_id: SB } }), ACCT_A);
    expect(await h(a, ACCT_A, "studio_id::text")).toBe(SA);
    expect(await h(a, ACCT_A, "anomaly_codes @> array['metadata_mismatch']")).toBe("t");
  });
  T(["m3a"], "F8 attribution is permanent: even a privileged writer cannot re-point a fact or registry row at another studio", async () => {
    const a = `in_${nextId()}`;
    await reg(SA, a);
    await deliver("invoice.voided", invoiceObj(a, "void"), ACCT_A);
    expect(await as("postgres", `select set_config('d24.writer','on',false); update public.hosted_invoices set studio_id='${SB}' where stripe_invoice_id='${a}'`)).toMatch(/^ERR.*(permanent|immutable)/i);
    expect(await as("postgres", `select set_config('d24.writer','on',false); update public.hosted_invoice_registry set studio_id='${SB}' where stripe_invoice_id='${a}'`)).toMatch(/^ERR/);
    expect(await h(a, ACCT_A, "studio_id::text")).toBe(SA);
  });
  T(["m3a"], "G2 subscription markers never move a REGISTERED invoice: it stays attributed and is flagged subscription_registry_conflict", async () => {
    const a = `in_${nextId()}`;
    await reg(SA, a);
    await deliver("invoice.voided", invoiceObj(a, "void", { billing_reason: "subscription_create" }), ACCT_A);
    expect(await h(a, ACCT_A, "classification||'/'||studio_id::text")).toBe(`registered/${SA}`);
    expect(await h(a, ACCT_A, "anomaly_codes @> array['subscription_registry_conflict']")).toBe("t");
  });
  T(["m3a"], "I1 an invoice-payment id replayed under a DIFFERENT invoice of the same studio+account stays with its first invoice and flags the second (the same id under another account is a separate row: ids are account-scoped)", async () => {
    const a = `in_${nextId()}`, b = `in_${nextId()}`, pay = `inpay_${nextId()}`;
    await reg(SA, a); await reg(SA, b);
    expect((await deliver("invoice_payment.paid", payObj(pay, a, 10), ACCT_A)).status).toBe(200);
    expect((await deliver("invoice_payment.paid", payObj(pay, b, 10), ACCT_A)).status).toBe(200);
    expect(await q(`select i.stripe_invoice_id||'/'||p.studio_id from public.hosted_invoice_payments p join public.hosted_invoices i on i.id=p.invoice_row_id where p.stripe_invoice_payment_id='${pay}'`)).toBe(`${a}/${SA}`);
    expect(await q(`select count(*) from public.hosted_invoice_payments where stripe_invoice_payment_id='${pay}'`)).toBe("1");
    expect(await h(b, ACCT_A, "anomaly_codes @> array['invoice_payment_conflict']")).toBe("t");
    expect(await h(a, ACCT_A, "anomaly_codes @> array['invoice_payment_conflict']")).toBe("f");
  });
  T(["m3a"], "I2 a credit-note id replayed under a DIFFERENT invoice of the same studio+account stays with its first invoice and flags the second", async () => {
    const a = `in_${nextId()}`, b = `in_${nextId()}`, cn = `cn_${nextId()}`;
    await reg(SA, a); await reg(SA, b);
    await deliver("credit_note.created", noteObj(cn, a), ACCT_A);
    await deliver("credit_note.created", noteObj(cn, b), ACCT_A);
    expect(await q(`select i.stripe_invoice_id||'/'||c.studio_id from public.hosted_credit_notes c join public.hosted_invoices i on i.id=c.invoice_row_id where c.stripe_credit_note_id='${cn}'`)).toBe(`${a}/${SA}`);
    expect(await h(b, ACCT_A, "anomaly_codes @> array['credit_note_conflict']")).toBe("t");
  });
  T(["m3a"], "I4 a registry/event livemode mismatch still attributes by registry but flags livemode_mismatch and needs review", async () => {
    const a = `in_${nextId()}`;
    expect((await reg(SA, a, true)).error).toBeNull();
    await deliver("invoice.voided", invoiceObj(a, "void"), ACCT_A);
    expect(await h(a, ACCT_A, "(anomaly_codes @> array['livemode_mismatch'])::text||'/'||reconciliation_state")).toBe("true/anomalous");
  });
  T(["m3a"], "M2A1 concurrent double-submit of one registration yields exactly one registry row and one outcome 'registered'", async () => {
    const a = `in_${nextId()}`;
    const rs = await Promise.all(Array.from({ length: 6 }, () => reg(SA, a)));
    for (const r of rs) expect(r.error).toBeNull();
    expect(rs.filter((r) => (r.data as { outcome: string }).outcome === "registered")).toHaveLength(1);
    expect(await regCount(a)).toBe("1");
  });
  T(["m3a"], "M2A3 registration racing a stream of events for the same invoice converges to one attributed invoice", async () => {
    const a = `in_${nextId()}`;
    await Promise.all([reg(SA, a), ...Array.from({ length: 4 }, () => deliver("invoice.voided", invoiceObj(a, "void"), ACCT_A))]);
    expect(await h(a, ACCT_A, "studio_id::text")).toBe(SA);
    expect(await q(`select count(*) from public.hosted_invoices where stripe_invoice_id='${a}'`)).toBe("1");
  });
});

// The two M2-A scenarios that were BLOCKED until an integration existed, now real. The business object is the QA fixture type registered above
// (a REAL production resolver/business object arrives with M3-C and stays BLOCKED until that layer is loaded).
describe("M2A-CONV. M2-A scenarios converted by M3 (QA-fixture business object)", () => {
  T(M3, "app issues an invoice -> registry row created atomically with the business object (intent + registry + object binding in one registration transaction; a failure inside it leaves none)", async () => {
    const { stripe, deps } = ctx();
    const obj = await newObject(SA);
    const r = must(await orch!.createHostedInvoice(reqOf(SA, obj), deps));
    expect(await registryOf(r.stripeInvoiceId)).toBe(`${SA}/${ACCT_A}/event_fee/${obj}`);
    expect(await q(`select (i.business_object_id = g.business_object_id and i.business_object_type = g.business_object_type and i.registry_id = g.id and i.status = 'registered')::text from public.hosted_invoice_creation_intents i join public.hosted_invoice_registry g on g.id = i.registry_id where i.id='${r.intentId}'`)).toBe("true");
    expect(stripe.createCount).toBe(1);
    // the failure half is pinned by M3-AUDIT A4 (no registry row, no half-registered intent)
  });
  T(M3, "registration for a studio the caller does not own is refused end to end (orchestrator with a forged resolver, SQL ownership, SQL account binding, cross-studio resume)", async () => {
    const objB = await newObject(SB);
    const forged = ctx({ resolvers: { event_fee: async () => fakes!.SPEC } });
    expect(await orch!.createHostedInvoice(reqOf(SA, objB), forged.deps)).toMatchObject({ ok: false });
    expect(forged.stripe.calls).toEqual([]);
    expect(await q(`select count(*) from public.hosted_invoice_registry where business_object_id='${objB}'`)).toBe("0");
    const inv = `in_${nextId()}`;
    await rpc("d24_register_invoice", { p_studio_id: SB, p_stripe_account_id: ACCT_B, p_stripe_invoice_id: inv, p_livemode: false, p_business_object_type: "event_fee", p_business_object_id: objB });
    expect((await rpc("d24_register_invoice", { p_studio_id: SA, p_stripe_account_id: ACCT_A, p_stripe_invoice_id: inv, p_livemode: false, p_business_object_type: "event_fee", p_business_object_id: objB })).error?.code).toBe("23505");
    expect((await rpc("d24_register_invoice", { p_studio_id: SA, p_stripe_account_id: ACCT_B, p_stripe_invoice_id: `in_${nextId()}`, p_livemode: false, p_business_object_type: "event_fee", p_business_object_id: objB })).error?.code).toBe("42501");
  });
  T(["m3a", "m3b", "m3c"], "app issues an invoice for the REAL M3-C business object (real action saves the draft, real authorizer mints the actor, PRODUCTION resolver + SQL ownership, offline fake Stripe) -> registry row and ledger bound to that object; the provider-draft link is recorded only from a registered intent; the creation port itself is NOT wired in M3-C", async () => {
    await m3cFixture();
    const saved = await saveDraftAs(C3.owner, SA, randomUUID());
    const invoiceId = invoiceIdFrom(saved.redirect);
    expect(invoiceId).toMatch(UUID);
    sess.userId = C3.owner; sess.studioId = SA;
    const actorOk = await c395!.authorize.authorizeClientInvoiceActor("draft");
    expect(actorOk).not.toBeNull();
    const { stripe, deps } = ctx({ resolvers: c395!.resolver.CLIENT_INVOICE_SPEC_RESOLVERS });
    const res = must(await orch!.createHostedInvoice({ actor: actorOk, businessObjectType: "studio_client_invoice", businessObjectId: invoiceId, requestKey: `req-m3c-${nextId()}` }, deps));
    expect(await registryOf(res.stripeInvoiceId)).toBe(`${SA}/${ACCT_A}/studio_client_invoice/${invoiceId}`);
    expect(await q(`select (i.business_object_type = 'studio_client_invoice' and i.business_object_id = '${invoiceId}' and i.status = 'registered' and i.registry_id is not null)::text from public.hosted_invoice_creation_intents i where i.id = '${res.intentId}'`)).toBe("true");
    const lines = stripe.calls.find((c) => c.op === "lines")!.params as Array<{ description: string; amount: number }>;
    expect(lines.map((l) => l.amount)).toEqual([15000, 1000]);
    expect(lines[0].description).toBe("Private lesson (2 x $75.00)");
    expect(stripe.calls.some((c) => c.op === "customer")).toBe(true);
    expect(await factsOf(res.stripeInvoiceId)).toBe("0/0/0/0");
    // the shipped creation port is a stub (returns null): the next steps perform what its documented contract says the future port must
    expect(c395!.port.getClientInvoiceCreationPort()).toBeNull();
    const version = Number(await q(`select version from public.studio_client_invoices where id = '${invoiceId}'`));
    const linked = await rpc("studio_client_invoice_link_registration", { p_invoice_id: invoiceId, p_studio_id: SA, p_intent_id: res.intentId, p_expected_version: version, p_stripe_customer_id: null });
    expect(linked.error).toBeNull();
    expect(await q(`select status||'/'||stripe_invoice_id from public.studio_client_invoices where id = '${invoiceId}'`)).toBe(`provider_draft_created/${res.stripeInvoiceId}`);
    const edit = await rpcAsUser(C3.owner, "aal1", "studio_client_invoice_save_draft", { p_studio_id: SA, p_request_key: randomUUID(), p_invoice_id: invoiceId, p_expected_version: version + 1, p_client_id: C3_CLIENT, p_reference_type: null, p_reference_id: null, p_reference_note: null, p_lines: [{ description: "x", quantity: 1, unit_price_cents: 1000 }] });
    expect(edit.error?.message ?? "").toContain("client_invoice_not_editable");
    // another studio's owner cannot create an invoice for this object, and nothing reaches the fake Stripe
    sess.userId = C3.otherOwner; sess.studioId = SB;
    const actorB = await c395!.authorize.authorizeClientInvoiceActor("draft");
    expect(actorB).not.toBeNull();
    const other = ctx({ resolvers: c395!.resolver.CLIENT_INVOICE_SPEC_RESOLVERS });
    expect(await orch!.createHostedInvoice({ actor: actorB, businessObjectType: "studio_client_invoice", businessObjectId: invoiceId, requestKey: `req-m3c-${nextId()}` }, other.deps)).toMatchObject({ ok: false, code: "business_object_not_owned" });
    expect(other.stripe.calls).toEqual([]);
    // the link is refused for an intent that is not registered (a pending intent cannot freeze the invoice)
    const saved2 = await saveDraftAs(C3.owner, SA, randomUUID());
    const invoice2 = invoiceIdFrom(saved2.redirect);
    const begun = await deps.store.begin({ studioId: SA, createdBy: C3.owner, idempotencyKey: orch!.deriveIdempotencyKey(SA, "studio_client_invoice", invoice2, `req-m3c-${nextId()}`), requestFingerprint: FP, businessObjectType: "studio_client_invoice", businessObjectId: invoice2 });
    expect(begun.ok).toBe(true);
    const bad = await rpc("studio_client_invoice_link_registration", { p_invoice_id: invoice2, p_studio_id: SA, p_intent_id: (begun as { intent: { id: string } }).intent.id, p_expected_version: Number(await q(`select version from public.studio_client_invoices where id = '${invoice2}'`)), p_stripe_customer_id: null });
    expect(bad.error?.message ?? "").toContain("client_invoice_intent_not_registered");
    expect(await q(`select status from public.studio_client_invoices where id = '${invoice2}'`)).toBe("draft");
  });
});

// Owner requirement (recovery matrix 1-10). Offline-fixture based: the fake Stripe models idempotency (same key+params => same invoice; same key + other params => error) and can PRUNE keys;
// NOTHING here proves real Stripe behaviour.
describe("M3-MATRIX. owner recovery matrix (offline fixtures only)", () => {
  T(M3, "Q1 crash before the Stripe request (ledger begun, no provider call), recovery via resumeIntent creates exactly one invoice", async () => {
    const { stripe, deps } = ctx();
    const req = reqOf(SA, await newObject(SA));
    const key = orch!.deriveIdempotencyKey(SA, "event_fee", req.businessObjectId, req.requestKey);
    expect((await deps.store.begin({ studioId: SA, createdBy: USER, idempotencyKey: key, requestFingerprint: orch!.deriveRequestFingerprint(SA, "event_fee", req.businessObjectId, fakes!.SPEC, ACCT_A, false), businessObjectType: "event_fee", businessObjectId: req.businessObjectId })).ok).toBe(true);
    must(await orch!.resumeIntent(await q(`select id::text from public.hosted_invoice_creation_intents where business_object_id='${req.businessObjectId}'`), { system: "d24_recovery" }, deps));
    expect(stripe.createCount).toBe(1);
  });
  T(M3, "Q2 crash after Stripe success, before the invoice id is recorded, recovery via the system actor converges to one registered invoice", async () => {
    const { stripe, deps } = ctx({}, [{ rpc: "d24_intent_mark_provider_created", mode: "throw", times: 1 }]);
    const req = reqOf(SA, await newObject(SA));
    expect(await crashed(orch!.createHostedInvoice(req, deps))).toBe(true);
    const id = await q(`select id::text from public.hosted_invoice_creation_intents where business_object_id='${req.businessObjectId}'`);
    const r = must(await orch!.resumeIntent(id, { system: "d24_recovery" }, deps));
    expect(stripe.createCount).toBe(1);
    expect(await regCount(r.stripeInvoiceId)).toBe("1");
  });
  T(M3, "Q3 retry with the same key while the failure is definitively retryable (429, nothing processed): two in a row still end in one invoice under one key", async () => {
    const { stripe, deps } = ctx();
    const req = reqOf(SA, await newObject(SA));
    for (let i = 0; i < 2; i++) {
      stripe.failNext = Object.assign(new Error("slow down"), { type: "StripeRateLimitError", statusCode: 429 });
      expect(await orch!.createHostedInvoice(req, deps)).toMatchObject({ ok: false, code: "stripe_unavailable", retryable: true });
    }
    must(await orch!.createHostedInvoice(req, deps));
    expect(stripe.createCount).toBe(1);
    expect(new Set(stripe.calls.filter((c) => c.op === "create").map((c) => c.key)).size).toBe(1);
  });
  T(M3, "Q4 same idempotency key with CHANGED parameters: the fake Stripe refuses it; the ledger refuses the key for a different object (23505) and never re-binds it", async () => {
    const { stripe, deps } = ctx();
    const first = must(await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), deps));
    const call = stripe.calls.find((c) => c.op === "create")!;
    await expect(stripe.createDraftInvoice({ stripeAccount: ACCT_A, idempotencyKey: call.key, params: { ...(call.params as Json), description: "changed" } })).rejects.toMatchObject({ type: "StripeIdempotencyError" });
    expect(stripe.createCount).toBe(1);
    const key = await q(`select idempotency_key from public.hosted_invoice_creation_intents where id='${first.intentId}'`);
    const r = await rpc("d24_intent_begin", { p_studio_id: SA, p_business_object_type: "event_fee", p_business_object_id: await newObject(SA), p_idempotency_key: key, p_request_fingerprint: FP, p_created_by: USER });
    expect(r.error?.code).toBe("23505");
  });
  T(M3, "Q5 FIVE concurrent workers recover ONE stuck intent: one lease holder replays, the others are told to wait (recovery_in_progress); one Stripe invoice and one registry row", async () => {
    const { stripe, deps } = ctx();
    stripe.failNext = Object.assign(new Error("net"), { type: "StripeConnectionError" });
    const r1 = await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), deps);
    const rs = await Promise.all(Array.from({ length: 5 }, () => orch!.resumeIntent(r1.intentId!, { system: "d24_recovery" }, deps)));
    expect(rs.some((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.ok).length + rs.filter((r) => !r.ok && r.code === "recovery_in_progress").length).toBe(5);
    expect(stripe.createCount).toBe(1);
    expect(await q(`select count(*) from public.hosted_invoice_registry r join public.hosted_invoice_creation_intents i on i.registry_id=r.id where i.id='${r1.intentId}'`)).toBe("1");
    expect(await intentRow(r1.intentId!)).toMatch(/^registered\//);
  });
  T(M3, "Q6 timeout with UNKNOWN result (the fake created the invoice, the client never saw the response): outcome_unknown, retries do not call Stripe, the DB claim replays the ORIGINAL key and returns the original invoice", async () => {
    const { stripe, deps } = ctx();
    stripe.loseResponseAfterCreate = Object.assign(new Error("timeout"), { type: "StripeConnectionError" });
    const req = reqOf(SA, await newObject(SA));
    const r1 = await orch!.createHostedInvoice(req, deps);
    expect(r1).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(stripe.createCount).toBe(1);
    const calls = stripe.calls.length;
    expect(await orch!.createHostedInvoice(req, deps)).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(stripe.calls.length).toBe(calls);
    const r = must(await orch!.resumeIntent(r1.intentId!, { system: "d24_recovery" }, deps));
    expect(stripe.createCount).toBe(1);
    expect(await regCount(r.stripeInvoiceId)).toBe("1");
  });
  T(M3, "Q7 recovery after the window => needs_review and NO replay, with the fake's keys pruned (same scenario as R10, asserted on the matrix row): the duplicate would be visible", async () => {
    const { stripe, deps } = ctx();
    stripe.loseResponseAfterCreate = Object.assign(new Error("timeout"), { type: "StripeConnectionError" });
    const req = reqOf(SA, await newObject(SA));
    const r1 = await orch!.createHostedInvoice(req, deps);
    await ageIntent(r1.intentId!, "13 hours");
    stripe.keys.clear();
    expect(await orch!.resumeIntent(r1.intentId!, { system: "d24_recovery" }, deps)).toMatchObject({ ok: false, code: "needs_review" });
    expect(stripe.createCount).toBe(1);
  });
  T(M3, "Q8 provider invoice exists but registration is permanently refused: the intent is held in needs_review WITH the invoice id (orphan tracked, never failed/abandoned), no registry row, no second invoice", async () => {
    const { stripe, deps } = ctx({}, [{ rpc: "d24_intent_register", mode: "error", code: "23505", times: 1 }]);
    const res = await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), deps);
    expect(res).toMatchObject({ ok: false, retryable: false });
    const inv = [...stripe.invoices.keys()][0];
    // an intent that recorded a Stripe invoice id can never become failed: it is held for review WITH the id
    expect(await q(`select status||'/'||coalesce(stripe_invoice_id,'-') from public.hosted_invoice_creation_intents where id='${res.intentId}'`)).toBe(`needs_review/${inv}`);
    expect(await regCount(inv)).toBe("0");
    expect(stripe.createCount).toBe(1);
  });
  T(M3, "Q10 operator reconciliation of an unresolved creation (needs_review): studio owner and AAL1 refused, wrong account refused, platform admin at AAL2 with a reason attaches the Stripe-evidenced invoice (registered, audited with the actor); abandon is allowed only for a platform admin when no invoice id is recorded (the operator asserts nothing exists; the ledger cannot know)", async () => {
    const PLAT = "00000000-0000-0000-0000-0000000d3ad1";
    const OWN = "00000000-0000-0000-0000-0000000d3ad2";
    await q(`insert into public.profiles (id, platform_role) values ('${PLAT}','platform_admin'),('${OWN}',null) on conflict do nothing;
             insert into public.user_studio_roles (user_id, studio_id, role, active) select '${OWN}','${SA}','studio_owner',true where not exists (select 1 from public.user_studio_roles where user_id='${OWN}')`);
    const asUser = (uid: string, aal: string, sql: string) =>
      runSql(`select set_config('request.jwt.claims','{"sub":"${uid}","role":"authenticated","aal":"${aal}","exp":${Math.floor(Date.now() / 1000) + 3600}}',false) is not null; ${sql}`, "authenticated").then((r) => (r.error ? `ERR ${r.error.code} ${r.error.message}` : r.out.replace(/^t\n?/, "")));
    expect(await asUser(PLAT, "aal2", "select (public.d24_op_set_enabled(true, 'enable operator actions for QA'))->>'outcome'")).not.toMatch(/^ERR/);
    try {
    // A: unresolved creation WITH a provider invoice (response lost), pushed past the window -> needs_review
    const a = ctx();
    a.stripe.loseResponseAfterCreate = Object.assign(new Error("timeout"), { type: "StripeConnectionError" });
    const ra = await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), a.deps);
    await ageIntent(ra.intentId!, "13 hours");
    expect(await orch!.resumeIntent(ra.intentId!, { system: "d24_recovery" }, a.deps)).toMatchObject({ ok: false, code: "needs_review" });
    const inv = [...a.stripe.invoices.keys()][0];
    const attach = (uid: string, aal: string, acct: string, reason = "reconciled with the Stripe dashboard evidence") =>
      asUser(uid, aal, `select public.d24_op_attach_creation_invoice('${ra.intentId}','${inv}',false,'${acct}','${reason}')::text`);
    expect(await attach(OWN, "aal2", ACCT_A)).toMatch(/^ERR/);          // a studio owner is not a platform admin
    expect(await attach(PLAT, "aal1", ACCT_A)).toMatch(/^ERR/);         // AAL1 refused
    expect(await attach(PLAT, "aal2", ACCT_A, "short")).toMatch(/^ERR/); // reason required
    expect(await attach(PLAT, "aal2", ACCT_B)).toMatch(/^ERR/);         // supplied account must equal the intent's
    expect(await q(`select status from public.hosted_invoice_creation_intents where id='${ra.intentId}'`)).toBe("needs_review");
    expect(await regCount(inv)).toBe("0");
    expect(await attach(PLAT, "aal2", ACCT_A)).not.toMatch(/^ERR/);
    expect(await intentRow(ra.intentId!)).toBe(`registered/${(await q(`select attempt_count from public.hosted_invoice_creation_intents where id='${ra.intentId}'`))}/${inv}`);
    expect(await registryOf(inv)).toMatch(new RegExp(`^${SA}/${ACCT_A}/event_fee/`));
    expect(await q(`select count(*) from public.hosted_invoice_creation_intent_events where intent_id='${ra.intentId}' and event_kind='operator_attached' and actor_user_id='${PLAT}' and from_status='needs_review' and to_status='registered'`)).toBe("1");
    expect(a.stripe.createCount).toBe(1);   // reconciliation never replayed the create
    // B: needs_review with NO provider invoice: abandon allowed for a platform admin at AAL2 only
    const b = ctx();
    b.stripe.failNext = Object.assign(new Error("net"), { type: "StripeConnectionError" });
    const rb = await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), b.deps);
    await ageIntent(rb.intentId!, "13 hours");
    expect(await orch!.resumeIntent(rb.intentId!, { system: "d24_recovery" }, b.deps)).toMatchObject({ ok: false, code: "needs_review" });
    expect(await asUser(OWN, "aal2", `select public.d24_op_abandon_creation('${rb.intentId}','provably nothing exists at Stripe')::text`)).toMatch(/^ERR/);
    expect(await asUser(PLAT, "aal2", `select public.d24_op_abandon_creation('${rb.intentId}','provably nothing exists at Stripe')::text`)).not.toMatch(/^ERR/);
    expect(await q(`select status from public.hosted_invoice_creation_intents where id='${rb.intentId}'`)).toBe("abandoned");
    } finally {   // M2B0 asserts the switch ships OFF: leave it as found
      await asUser(PLAT, "aal2", "select (public.d24_op_set_enabled(false, 'disable operator actions after QA'))->>'outcome'");
    }
  });
});

// The sweep is global (it resumes EVERY recoverable intent), so it runs last: it must not complete intents other scenarios deliberately leave pending.
describe("M3-SWEEP. bounded recovery sweep", () => {
  T(M3, "R9 the bounded recovery sweep finishes stuck intents without a second invoice", async () => {
    const { stripe, deps } = ctx({}, [{ rpc: "d24_intent_register", mode: "error", code: "57014", times: 1 }]);
    const r1 = await orch!.createHostedInvoice(reqOf(SA, await newObject(SA)), deps);
    expect(r1.ok).toBe(false);
    // age the intent past the sweep's minimum (a privileged session with the d24 writer flag, as a migration/operator would)
    const aged = await runSql(`select set_config('d24.writer','on',false); update public.hosted_invoice_creation_intents set updated_at = now() - interval '2 hours' where id='${r1.intentId}'`, null);
    expect(aged.error).toBeNull();
    const summary = await orch!.sweepRecoverableIntents(deps, { limit: 25, olderThanMs: 0 });
    expect(summary.disabled).toBe(false);
    expect(await intentRow(r1.intentId!)).toMatch(/^registered\//);
    expect(stripe.calls.filter((c) => c.op === "create" && (c.params as Json).metadata?.d24_intent_id === r1.intentId)).toHaveLength(1);   // only the original create: its invoice existed already (the sweep is global, so other pending intents may create their own)
  });
});

describe("M3Z. stack availability", () => {
  if (!STACK) it.skip("BLOCKED: no D24 Postgres stack is running; no M3 scenario ran", () => undefined);
  else it(`M3 layers: ${(["m3a", "m3b", "m3c"].filter(has)).join(",") || "none (M3 scenarios BLOCKED)"}`, () => expect(has("m1")).toBe(true));
});

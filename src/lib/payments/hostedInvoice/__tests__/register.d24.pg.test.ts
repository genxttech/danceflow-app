// D24 M2-A: runs the REAL registerHostedInvoice against the REAL d24_register_invoice in a DISPOSABLE Postgres container.
// Skipped unless D24_M2A_PG_CONTAINER names that container; scripts/qa/d24-m2a-wrapper.sh creates and removes it.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { registerHostedInvoice, type BusinessObjectResolver } from "../register";

const CONTAINER = process.env.D24_M2A_PG_CONTAINER;
const A = "00000000-0000-0000-0000-00000000005a";
const B = "00000000-0000-0000-0000-00000000005b";
const NOACCT = "00000000-0000-0000-0000-00000000005c";
const OWNER = "00000000-0000-0000-0000-0000000000a1";

type Res = { out: string; code: string | null };
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
    p.on("close", () => resolve({ out: out.trim(), code: /ERROR:\s+(\w{5}):/.exec(err)?.[1] ?? null }));
    p.stdin.end(sql);
  });
}

// Minimal PostgREST-shaped adapter over psql; the SQL is built from psql variables so no value is interpolated into text.
const supabase = {
  from(table: string) {
    if (table === "hosted_invoice_registry") {
      const rq = {
        select: () => rq,
        eq: async (_c: string, v: string) => {
          const r = await psql("select coalesce((select jsonb_agg(to_jsonb(x)) from (select studio_id, account_key from public.hosted_invoice_registry where stripe_invoice_id = :'i') x)::text, '[]');", { i: v });
          return { data: JSON.parse(r.out), error: r.code ? { code: r.code } : null };
        },
      };
      return rq;
    }
    if (table !== "studios") throw new Error("unsupported table " + table);
    let id = "";
    const q = {
      select: () => q,
      eq: (_c: string, v: string) => ((id = v), q),
      maybeSingle: async () => {
        const r = await psql("select coalesce((select to_jsonb(s) from (select stripe_connected_account_id from public.studios where id = :'id'::uuid) s)::text, '');", { id });
        return { data: r.out ? JSON.parse(r.out) : null, error: r.code ? { code: r.code } : null };
      },
    };
    return q;
  },
  async rpc(name: string, a: Record<string, unknown>) {
    if (name !== "d24_register_invoice") throw new Error("unexpected rpc " + name);
    const v = (k: string) => (a[k] == null ? "" : String(a[k]));
    const r = await psql(
      "select public.d24_register_invoice(:'s'::uuid, nullif(:'acct',''), :'inv', :'live'::boolean, :'t', :'o', nullif(:'by','')::uuid)::text;",
      { s: v("p_studio_id"), acct: v("p_stripe_account_id"), inv: v("p_stripe_invoice_id"), live: v("p_livemode"), t: v("p_business_object_type"), o: v("p_business_object_id"), by: v("p_created_by") },
    );
    if (r.code) return { data: null, error: { code: r.code, message: "redacted" } };
    return { data: JSON.parse(r.out), error: null };
  },
} as never;

// Real ownership check against a real table (the production resolver set is empty; this stands in for a future one).
const resolver: BusinessObjectResolver = async ({ studioId, businessObjectId }) => {
  const r = await psql("select count(*) from public.qa_business_objects where id = :'id' and studio_id = :'s'::uuid;", { id: businessObjectId, s: studioId });
  return r.out === "1";
};
const reg = (over: Record<string, unknown>) =>
  registerHostedInvoice({ supabase, studioId: A, stripeInvoiceId: "in_pg1", livemode: false, businessObjectType: "event_fee", businessObjectId: "bo-a1", resolvers: { event_fee: resolver }, ...over } as never);
const count = async (inv: string) => Number((await psql("select count(*) from public.hosted_invoice_registry where stripe_invoice_id = :'i';", { i: inv })).out);

describe.skipIf(!CONTAINER)("registerHostedInvoice against real Postgres (d24_register_invoice)", { timeout: 180_000 }, () => {
  it("setup fixtures", async () => {
    const r = await psql(`
      insert into public.studios (id, name, stripe_connected_account_id) values ('${A}','A','acct_studioA'),('${B}','B','acct_studioB'),('${NOACCT}','C',null);
      insert into public.qa_business_objects values ('bo-a1','${A}'),('bo-a2','${A}'),('bo-b1','${B}'),('bo-a3','${A}'),('bo-a4','${A}'),('bo-a5','${A}');
      select 'ok';`);
    expect(r.out).toContain("ok");
  });

  it("registers once, then is idempotent (retry => already_registered, one row)", async () => {
    expect(await reg({})).toMatchObject({ ok: true, outcome: "registered" });
    expect(await reg({})).toMatchObject({ ok: true, outcome: "already_registered" });
    expect(await count("in_pg1")).toBe(1);
    const row = (await psql("select studio_id||'/'||stripe_account_id||'/'||business_object_id from public.hosted_invoice_registry where stripe_invoice_id='in_pg1';")).out;
    expect(row).toBe(`${A}/acct_studioA/bo-a1`);
  });

  it("cross-studio takeover of a registered invoice is a safe conflict and changes nothing", async () => {
    const r = await reg({ studioId: B, businessObjectId: "bo-b1" });
    expect(r).toEqual({ ok: false, code: "registration_conflict", retryable: false });
    expect((await psql("select studio_id from public.hosted_invoice_registry where stripe_invoice_id='in_pg1';")).out).toBe(A);
  });

  it("a studio cannot register another studio's business object (nothing written)", async () => {
    expect(await reg({ studioId: B, stripeInvoiceId: "in_pg2", businessObjectId: "bo-a2" })).toMatchObject({ ok: false, code: "business_object_not_owned" });
    expect(await count("in_pg2")).toBe(0);
  });

  it("a studio without a connected account cannot register (nothing written)", async () => {
    expect(await reg({ studioId: NOACCT, stripeInvoiceId: "in_pg3", businessObjectId: "bo-a2" })).toMatchObject({ ok: false });
    expect(await count("in_pg3")).toBe(0);
  });

  it("subscription objects are refused before the database (nothing written)", async () => {
    expect(await reg({ stripeInvoiceId: "in_pg4", businessObjectType: "membership_subscription", resolvers: { membership_subscription: resolver } })).toMatchObject({ code: "subscription_object_refused" });
    expect(await reg({ stripeInvoiceId: "in_pg4", subscriptionEvidence: true })).toMatchObject({ code: "subscription_object_refused" });
    expect(await count("in_pg4")).toBe(0);
  });

  it("an event that arrived BEFORE registration is adopted, and metadata never attributes it", async () => {
    const setup = await psql(`
      select public.claim_payment_provider_event('stripe','evt_early','invoice.voided','h','${OWNER}');
      select (public.d24_apply_event('evt_early','${OWNER}','invoice.voided',1000,'acct_studioA',false,'h','invoice',
        '{"invoice_id":"in_pg5","status":"void","total":100,"amount_due":100,"amount_paid":0,"amount_remaining":100,"currency":"usd","metadata_studio":"${B}"}'::jsonb))->>'reconciliation_state';`);
    expect(setup.out).toContain("unmatched");
    expect((await psql("select studio_id is null from public.hosted_invoices where stripe_invoice_id='in_pg5';")).out).toBe("t");
    expect(await reg({ stripeInvoiceId: "in_pg5", businessObjectId: "bo-a3" })).toMatchObject({ ok: true, outcome: "registered", adoptedExistingFacts: true });
    expect((await psql("select studio_id from public.hosted_invoices where stripe_invoice_id='in_pg5';")).out).toBe(A);
  });

  it("an event arriving AFTER registration matches the registered studio only", async () => {
    expect(await reg({ stripeInvoiceId: "in_pg6", businessObjectId: "bo-a4" })).toMatchObject({ ok: true });
    const r = await psql(`
      select public.claim_payment_provider_event('stripe','evt_late','invoice.voided','h','${OWNER}');
      select public.d24_apply_event('evt_late','${OWNER}','invoice.voided',1000,'acct_studioA',false,'h','invoice',
        '{"invoice_id":"in_pg6","status":"void","total":100,"amount_due":100,"amount_paid":0,"amount_remaining":100,"currency":"usd","metadata_studio":"${B}"}'::jsonb);
      select studio_id from public.hosted_invoices where stripe_invoice_id='in_pg6';`);
    expect(r.out.split("\n").pop()).toBe(A);
  });

  it("concurrency: 12 parallel identical registrations => exactly one registered, the rest already_registered, one row", async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, () => reg({ stripeInvoiceId: "in_pg7", businessObjectId: "bo-a5" })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.ok && r.outcome === "registered")).toHaveLength(1);
    expect(rs.filter((r) => r.ok && r.outcome === "already_registered")).toHaveLength(11);
    expect(await count("in_pg7")).toBe(1);
  });

  it("concurrency: two studios racing for the same invoice id never change the first scope's attribution", async () => {
    const rs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => (i % 2 ? reg({ stripeInvoiceId: "in_pg8", studioId: B, businessObjectId: "bo-b1" }) : reg({ stripeInvoiceId: "in_pg8", businessObjectId: "bo-a1" }))),
    );
    // The cross-scope pre-check is a best-effort read, so in the worst case a racing B holds a row under ITS OWN account scope
    // only (never under A's). That residual is documented in D24-M2A-REGISTRATION.md; the SQL-side guard is a follow-up.
    expect((await psql("select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_pg8' and stripe_account_id='acct_studioA' and studio_id='" + A + "';")).out).toBe("1");
    expect((await psql("select count(*) from public.hosted_invoice_registry where stripe_invoice_id='in_pg8' and stripe_account_id='acct_studioA' and studio_id<>'" + A + "';")).out).toBe("0");
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.code === "registration_conflict")).toBe(true);
  });

  it("a sequential cross-studio attempt after the race is refused deterministically by the pre-check", async () => {
    const before = await count("in_pg8");
    const r = await reg({ stripeInvoiceId: "in_pg8", studioId: B, businessObjectId: "bo-b1" });
    expect(r).toEqual({ ok: false, code: "registration_conflict", retryable: false });
    expect(await count("in_pg8")).toBe(before);
  });
});

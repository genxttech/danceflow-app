import { describe, expect, it, vi } from "vitest";
import { PRODUCTION_BUSINESS_OBJECT_RESOLVERS, registerHostedInvoice, type BusinessObjectResolver } from "../register";

const STUDIO = "00000000-0000-0000-0000-00000000005a";
const OTHER = "00000000-0000-0000-0000-00000000005b";

function fake(opts: { registry?: Array<{ studio_id: string; account_key: string }>; account?: string | null; studioFound?: boolean; studioError?: boolean; rpc?: (n: string, a: Record<string, unknown>) => unknown } = {}) {
  const eq = vi.fn();
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) =>
    opts.rpc ? opts.rpc(name, args) : { data: { outcome: "registered", registry_id: "r1", adopted_existing_facts: false }, error: null });
  const q = {
    select: () => q,
    eq: (...a: unknown[]) => (eq(...a), q),
    maybeSingle: async () => ({
      data: opts.studioFound === false ? null : { stripe_connected_account_id: opts.account === undefined ? "acct_123" : opts.account },
      error: opts.studioError ? { code: "XX" } : null,
    }),
  };
  const reg = { select: () => reg, eq: async () => ({ data: opts.registry ?? [], error: null }) };
  return { supabase: { rpc, from: vi.fn((t: string) => (t === "hosted_invoice_registry" ? reg : q)) } as never, rpc, eq };
}
const owns: BusinessObjectResolver = async ({ studioId, businessObjectId }) => studioId === STUDIO && businessObjectId === "bo-1";
const base = { studioId: STUDIO, stripeInvoiceId: "in_abc123", livemode: false, businessObjectType: "event_fee", businessObjectId: "bo-1", resolvers: { event_fee: owns } };

describe("registerHostedInvoice", () => {
  it("fails closed in production: no resolvers exist, so no database call is made", async () => {
    expect(Object.keys(PRODUCTION_BUSINESS_OBJECT_RESOLVERS)).toEqual([]);
    const f = fake();
    expect(await registerHostedInvoice({ ...base, supabase: f.supabase, resolvers: undefined })).toEqual({ ok: false, code: "business_object_type_unsupported", retryable: false });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("ignores inherited keys such as constructor / toString as types", async () => {
    const f = fake();
    for (const t of ["constructor", "toString"]) {
      const r = await registerHostedInvoice({ ...base, supabase: f.supabase, businessObjectType: t, resolvers: {} });
      expect(r.ok).toBe(false);
    }
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("registers with the studio's own account, read server-side", async () => {
    const f = fake({ account: "acct_studioown" });
    const r = await registerHostedInvoice({ ...base, supabase: f.supabase });
    expect(r).toEqual({ ok: true, outcome: "registered", registryId: "r1", adoptedExistingFacts: false });
    expect(f.eq).toHaveBeenCalledWith("id", STUDIO);
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_studio_id: STUDIO, p_stripe_account_id: "acct_studioown", p_stripe_invoice_id: "in_abc123", p_livemode: false, p_business_object_type: "event_fee", p_business_object_id: "bo-1", p_created_by: null });
  });
  it("accepts no account input: an injected stripeAccountId / metadata field is ignored", async () => {
    const f = fake({ account: "acct_real" });
    await registerHostedInvoice({ ...base, supabase: f.supabase, stripeAccountId: "acct_evil", metadata: { studio_id: OTHER } } as never);
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_stripe_account_id: "acct_real", p_studio_id: STUDIO });
  });
  it("refuses a business object of another studio (cross-studio) before any registration", async () => {
    const f = fake();
    expect(await registerHostedInvoice({ ...base, supabase: f.supabase, studioId: OTHER })).toEqual({ ok: false, code: "business_object_not_owned", retryable: false });
    expect(await registerHostedInvoice({ ...base, supabase: f.supabase, businessObjectId: "bo-other" })).toMatchObject({ code: "business_object_not_owned" });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("refuses when the invoice id is already registered to another studio or account scope (no rpc)", async () => {
    for (const registry of [[{ studio_id: OTHER, account_key: "acct_123" }], [{ studio_id: STUDIO, account_key: "acct_other" }]]) {
      const f = fake({ registry });
      expect(await registerHostedInvoice({ ...base, supabase: f.supabase })).toEqual({ ok: false, code: "registration_conflict", retryable: false });
      expect(f.rpc).not.toHaveBeenCalled();
    }
    const same = fake({ registry: [{ studio_id: STUDIO, account_key: "acct_123" }] });
    expect(await registerHostedInvoice({ ...base, supabase: same.supabase })).toMatchObject({ ok: true });
  });
  it("refuses subscription-type objects and subscription evidence", async () => {
    const f = fake();
    for (const t of ["subscription", "membership_subscription", "studio_subscription_invoice"]) {
      expect(await registerHostedInvoice({ ...base, supabase: f.supabase, businessObjectType: t, resolvers: { [t]: owns } })).toMatchObject({ code: "subscription_object_refused" });
    }
    expect(await registerHostedInvoice({ ...base, supabase: f.supabase, subscriptionEvidence: true })).toMatchObject({ code: "subscription_object_refused" });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("refuses a studio with no connected account, an unknown studio, and a malformed account", async () => {
    expect(await registerHostedInvoice({ ...base, supabase: fake({ account: null }).supabase })).toMatchObject({ code: "stripe_account_unavailable" });
    expect(await registerHostedInvoice({ ...base, supabase: fake({ studioFound: false }).supabase })).toMatchObject({ code: "stripe_account_unavailable" });
    expect(await registerHostedInvoice({ ...base, supabase: fake({ account: "bad id" }).supabase })).toMatchObject({ code: "stripe_account_unavailable" });
    expect(await registerHostedInvoice({ ...base, supabase: fake({ studioError: true }).supabase })).toEqual({ ok: false, code: "registration_failed", retryable: true });
  });
  it("validates inputs", async () => {
    const f = fake();
    for (const over of [{ studioId: "x" }, { stripeInvoiceId: "evt_1" }, { stripeInvoiceId: "in_a b" }, { livemode: "false" }, { businessObjectType: "Bad-Type" }, { businessObjectId: "  " }, { createdBy: "nope" }]) {
      expect(await registerHostedInvoice({ ...base, supabase: f.supabase, ...over } as never)).toEqual({ ok: false, code: "invalid_input", retryable: false });
    }
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("maps already_registered, and a throwing resolver is a retryable failure", async () => {
    const r = await registerHostedInvoice({ ...base, supabase: fake({ rpc: () => ({ data: { outcome: "already_registered", registry_id: "r9" }, error: null }) }).supabase });
    expect(r).toMatchObject({ ok: true, outcome: "already_registered", registryId: "r9" });
    const t = await registerHostedInvoice({ ...base, supabase: fake().supabase, resolvers: { event_fee: async () => { throw new Error("db down"); } } });
    expect(t).toEqual({ ok: false, code: "registration_failed", retryable: true });
  });
  it("maps 23505 to a safe conflict error without leaking database text", async () => {
    const r = await registerHostedInvoice({ ...base, supabase: fake({ rpc: () => ({ data: null, error: { code: "23505", message: "d24_registration_conflict secret detail" } }) }).supabase });
    expect(r).toEqual({ ok: false, code: "registration_conflict", retryable: false });
    expect(JSON.stringify(r)).not.toContain("secret");
  });
  it("retries deadlock / serialization aborts then succeeds; gives up as retryable after 3", async () => {
    let n = 0;
    const f = fake({ rpc: () => (++n < 3 ? { data: null, error: { code: n === 1 ? "40P01" : "40001" } } : { data: { outcome: "registered", registry_id: "r2" }, error: null }) });
    expect(await registerHostedInvoice({ ...base, supabase: f.supabase })).toMatchObject({ ok: true, registryId: "r2" });
    expect(f.rpc).toHaveBeenCalledTimes(3);
    const g = fake({ rpc: () => ({ data: null, error: { code: "40P01" } }) });
    expect(await registerHostedInvoice({ ...base, supabase: g.supabase })).toEqual({ ok: false, code: "registration_failed", retryable: true });
    expect(g.rpc).toHaveBeenCalledTimes(3);
  });
  it("treats FK / check violations as permanent and rejects control characters in the object id", async () => {
    for (const code of ["23503", "23514", "23502"]) {
      expect(await registerHostedInvoice({ ...base, supabase: fake({ rpc: () => ({ data: null, error: { code } }) }).supabase })).toEqual({ ok: false, code: "registration_failed", retryable: false });
    }
    expect(await registerHostedInvoice({ ...base, supabase: fake().supabase, businessObjectId: "bo-1\nx" })).toMatchObject({ code: "invalid_input" });
  });
  it("a non-function resolver value cannot authorize", async () => {
    expect(await registerHostedInvoice({ ...base, supabase: fake().supabase, resolvers: { event_fee: true as never } })).toMatchObject({ ok: false });
  });
  it("maps a missing migration to registration_unavailable and malformed results to failure", async () => {
    expect(await registerHostedInvoice({ ...base, supabase: fake({ rpc: () => ({ data: null, error: { code: "42883" } }) }).supabase })).toEqual({ ok: false, code: "registration_unavailable", retryable: true });
    expect(await registerHostedInvoice({ ...base, supabase: fake({ rpc: () => ({ data: { outcome: "weird" }, error: null }) }).supabase })).toMatchObject({ code: "registration_failed" });
  });
});

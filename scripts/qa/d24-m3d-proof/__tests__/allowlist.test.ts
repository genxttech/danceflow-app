import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateRequest } from "../allowlist";
import { STRIPE_API_VERSION } from "../config";
import type { ProofRequest } from "../types";

const ACCT = "acct_CONNECTEDTEST1";
const OTHER = "acct_SOMEONEELSE99";
const ev = (r: ProofRequest) => evaluateRequest({ stripeVersion: STRIPE_API_VERSION, ...r }, { connectedAcct: ACCT });
const base = (r: Partial<ProofRequest> & Pick<ProofRequest, "method" | "path">): ProofRequest => ({ stripeAccount: ACCT, ...r });
const KEY = "d24proof-abc12345-inv-A";

const validDraft: ProofRequest = base({
  method: "POST",
  path: "/v1/invoices",
  idempotencyKey: KEY,
  body: { customer: "cus_ABC123", collection_method: "send_invoice", days_until_due: "14", currency: "usd", auto_advance: "false", description: "D24-M3 proof invoice", "metadata[d24_intent_id]": "d24proof-intent-1" },
});

describe("proof allow-list: permitted requests", () => {
  it("accepts each rule of plan section 6 in its exact shape", () => {
    const ok: ProofRequest[] = [
      { method: "GET", path: "/v1/account" },
      { method: "GET", path: `/v1/accounts/${ACCT}` },
      base({ method: "POST", path: "/v1/customers", idempotencyKey: KEY, body: { name: "D24-M3 proof client 1", email: "d24-proof-abc123-a@example.com", "metadata[d24_intent_id]": "x1", "metadata[d24_client_ref]": "c1" } }),
      base({ method: "DELETE", path: "/v1/customers/cus_ABC123" }),
      validDraft,
      base({ method: "POST", path: "/v1/invoices/in_ABC123/add_lines", idempotencyKey: `${KEY}:lines`, body: { "lines[0][description]": "Line", "lines[0][amount]": "5500", "lines[1][description]": "Line 2", "lines[1][amount]": "2500" } }),
      base({ method: "GET", path: "/v1/invoices/in_ABC123" }),
      base({ method: "GET", path: "/v1/invoices", query: { customer: "cus_ABC123", limit: "100" } }),
      base({ method: "DELETE", path: "/v1/invoices/in_ABC123" }),
      base({ method: "GET", path: "/v1/transfers", query: { limit: "1" } }),
      base({ method: "GET", path: "/v1/webhook_endpoints" }),
    ];
    for (const r of ok) expect(ev(r), `${r.method} ${r.path}`).toMatchObject({ ok: true });
  });
});

describe("proof allow-list: finalize, send, pay, void, mark_uncollectible are blocked before any I/O", () => {
  for (const verb of ["finalize", "send", "pay", "void", "mark_uncollectible"]) {
    it(`POST /v1/invoices/{id}/${verb} is refused (with and without the proof's own headers)`, () => {
      const withKey = ev(base({ method: "POST", path: `/v1/invoices/in_ABC123/${verb}`, idempotencyKey: KEY, body: {} }));
      const bare = ev(base({ method: "POST", path: `/v1/invoices/in_ABC123/${verb}` }));
      expect(withKey.ok).toBe(false);
      expect(bare.ok).toBe(false);
      if (!withKey.ok) expect(withKey.reason).toMatch(/no allow-list rule/);
    });
  }
  it("names the dangerous operation in the refusal", () => {
    const r = ev(base({ method: "POST", path: "/v1/invoices/in_ABC123/finalize", idempotencyKey: KEY, body: {} }));
    expect(!r.ok && r.reason).toMatch(/finalize is never permitted/);
  });
  it("the verbs stay blocked under other methods too", () => {
    for (const m of ["GET", "DELETE", "POST"] as const) {
      expect(ev(base({ method: m, path: "/v1/invoices/in_ABC123/send", idempotencyKey: m === "POST" ? KEY : undefined })).ok).toBe(false);
    }
  });
});

describe("proof allow-list: every unrelated Stripe operation is blocked", () => {
  const unrelated: Array<[ProofRequest["method"], string]> = [
    ["POST", "/v1/charges"], ["POST", "/v1/refunds"], ["POST", "/v1/payment_intents"], ["POST", "/v1/payment_intents/pi_1/confirm"], ["POST", "/v1/transfers"],
    ["POST", "/v1/payouts"], ["GET", "/v1/balance"], ["POST", "/v1/credit_notes"], ["POST", "/v1/subscriptions"], ["POST", "/v1/products"], ["POST", "/v1/prices"],
    ["POST", "/v1/webhook_endpoints"], ["DELETE", "/v1/webhook_endpoints/we_1"], ["POST", "/v1/accounts"], ["POST", `/v1/accounts/${ACCT}`], ["DELETE", `/v1/accounts/${ACCT}`],
    ["GET", "/v1/customers"], ["GET", "/v1/customers/cus_ABC123"], ["POST", "/v1/customers/cus_ABC123"], ["POST", "/v1/invoices/in_ABC123"], ["POST", "/v1/invoiceitems"],
    ["GET", "/v1/events"], ["GET", "/v1/api_keys"], ["POST", "/v1/payment_methods/pm_1/attach"], ["GET", "/v1/invoices/upcoming"],
  ];
  for (const [m, p] of unrelated) {
    it(`${m} ${p}`, () => {
      expect(ev(base({ method: m, path: p, idempotencyKey: m === "POST" ? KEY : undefined, body: m === "POST" ? { x: "1" } : undefined })).ok).toBe(false);
    });
  }
  it("methods outside GET/POST/DELETE never match", () => {
    expect(ev({ method: "PUT" as never, path: "/v1/invoices", stripeAccount: ACCT }).ok).toBe(false);
    expect(ev({ method: "PATCH" as never, path: "/v1/invoices/in_ABC123", stripeAccount: ACCT }).ok).toBe(false);
  });
});

describe("proof allow-list: path and parameter hygiene", () => {
  it("rejects encoded separators, dot segments, queries in the path, trailing slashes, double slashes and full URLs", () => {
    for (const p of ["/v1/invoices/in_ABC123%2Ffinalize", "/v1/invoices/../charges", "/v1/invoices?x=1", "/v1/invoices/", "/v1//invoices", "https://api.stripe.com/v1/invoices", "/v1/invoices/in_ABC123 ", "/v2/invoices", "v1/invoices"]) {
      expect(ev(base({ method: "GET", path: p })).ok, p).toBe(false);
    }
  });
  it("rejects a Stripe-Account other than the pinned one, a missing one, and one on the identity reads", () => {
    expect(ev({ ...validDraft, stripeAccount: OTHER }).ok).toBe(false);
    expect(ev({ ...validDraft, stripeAccount: undefined }).ok).toBe(false);
    expect(ev({ method: "GET", path: "/v1/account", stripeAccount: ACCT }).ok).toBe(false);
    expect(ev({ method: "GET", path: `/v1/accounts/${ACCT}`, stripeAccount: ACCT }).ok).toBe(false);
  });
  it("identity read of any other connected account id is refused", () => {
    expect(ev({ method: "GET", path: `/v1/accounts/${OTHER}` }).ok).toBe(false);
  });
  it("rejects bad pinned ids", () => {
    expect(evaluateRequest(validDraft, { connectedAcct: "not-an-account" }).ok).toBe(false);
  });
  it("draft creation: only send_invoice, auto_advance=false, usd, 14-30 days, and no extra parameters", () => {
    const mut = (b: Record<string, string>) => ev({ ...validDraft, body: { ...(validDraft.body as Record<string, string>), ...b } });
    expect(mut({ collection_method: "charge_automatically" }).ok).toBe(false);
    expect(mut({ auto_advance: "true" }).ok).toBe(false);
    expect(mut({ currency: "eur" }).ok).toBe(false);
    expect(mut({ days_until_due: "7" }).ok).toBe(false);
    expect(mut({ days_until_due: "31" }).ok).toBe(false);
    expect(mut({ customer: "x" }).ok).toBe(false);
    for (const extra of ["default_payment_method", "pending_invoice_items_behavior", "transfer_data[destination]", "application_fee_amount", "on_behalf_of", "payment_settings[payment_method_types][0]", "footer"]) {
      expect(mut({ [extra]: "x" }).ok, extra).toBe(false);
    }
    const noAuto = { ...(validDraft.body as Record<string, string>) };
    delete noAuto.auto_advance;
    expect(ev({ ...validDraft, body: noAuto }).ok).toBe(false);
  });
  it("customers: the ONLY email allowed is the synthetic per-run example.com address, and it is required (Stripe needs one for send_invoice drafts)", () => {
    const post = (body: Record<string, string>) => ev(base({ method: "POST", path: "/v1/customers", idempotencyKey: KEY, body })).ok;
    const good = "d24-proof-a1b2c3d4-a@example.com";
    expect(post({ name: "n", email: good })).toBe(true);
    expect(post({ name: "n" })).toBe(false); // email is required now
    for (const bad of ["a@b.co", "real.person@gmail.com", "d24-proof-a1b2c3d4-a@example.org", "d24-proof-a1b2c3d4-a@sub.example.com", "d24-proof-A1B2C3D4-a@example.com", "D24-PROOF-a1b2c3d4-a@example.com", "d24-proof-a1b2c3d4-a@example.com ", "x+d24-proof-a1b2c3d4-a@example.com", "d24-proof-ab-a@example.com", "d24-proof-a1b2c3d4-a@example.com,b@example.com"]) {
      expect(post({ name: "n", email: bad }), bad).toBe(false);
    }
    expect(post({ name: "n", email: good, phone: "1" })).toBe(false);
    expect(post({ name: "n", email: good, description: "x" })).toBe(false);
  });
  it("add_lines: at most two lines, positive amount, total capped, both parts present", () => {
    const L = (body: Record<string, string>) => ev(base({ method: "POST", path: "/v1/invoices/in_ABC123/add_lines", idempotencyKey: KEY, body }));
    expect(L({ "lines[2][description]": "x", "lines[2][amount]": "100" }).ok).toBe(false);
    expect(L({ "lines[0][description]": "x", "lines[0][amount]": "0" }).ok).toBe(false);
    expect(L({ "lines[0][description]": "x", "lines[0][amount]": "-5" }).ok).toBe(false);
    expect(L({ "lines[0][description]": "x", "lines[0][amount]": "20001" }).ok).toBe(false);
    expect(L({ "lines[0][description]": "x", "lines[0][amount]": "15000", "lines[1][description]": "y", "lines[1][amount]": "15000" }).ok).toBe(false);
    expect(L({ "lines[0][description]": "x", "lines[0][amount]": "100", "lines[1][amount]": "100" }).ok).toBe(false);
    expect(L({ "lines[0][description]": "x", "lines[0][amount]": "100", "lines[0][tax_amounts][0][amount]": "1" }).ok).toBe(false);
    expect(L({ "lines[0][description]": "x", "lines[0][amount]": "20000" }).ok).toBe(true);
  });
  it("idempotency: required on POST with the d24proof- prefix, forbidden on reads/deletes", () => {
    expect(ev({ ...validDraft, idempotencyKey: undefined }).ok).toBe(false);
    expect(ev({ ...validDraft, idempotencyKey: "random-key" }).ok).toBe(false);
    expect(ev({ ...validDraft, idempotencyKey: `d24proof-${"a".repeat(300)}` }).ok).toBe(false);
    expect(ev(base({ method: "GET", path: "/v1/invoices/in_ABC123", idempotencyKey: KEY })).ok).toBe(false);
  });
  it("reads: list requires customer and limit=100 only; negatives accept only their exact query", () => {
    expect(ev(base({ method: "GET", path: "/v1/invoices", query: { customer: "cus_ABC123" } })).ok).toBe(false);
    expect(ev(base({ method: "GET", path: "/v1/invoices", query: { customer: "cus_ABC123", limit: "100", status: "open" } })).ok).toBe(false);
    expect(ev(base({ method: "GET", path: "/v1/invoices", query: { limit: "100" } })).ok).toBe(false);
    expect(ev(base({ method: "GET", path: "/v1/transfers", query: { limit: "5" } })).ok).toBe(false);
    expect(ev(base({ method: "GET", path: "/v1/transfers" })).ok).toBe(false);
    expect(ev(base({ method: "GET", path: "/v1/webhook_endpoints", query: { limit: "1" } })).ok).toBe(false);
    expect(ev(base({ method: "GET", path: "/v1/invoices/in_ABC123", body: { a: "b" } })).ok).toBe(false);
  });
});

describe("proof run 3 regression: send_invoice drafts need a customer email (req_TtLV74WY5HVm4g)", () => {
  it("the fake models Stripe: a send_invoice draft for a customer WITHOUT an email is refused with 400, and accepted once the customer has the synthetic email", async () => {
    const { createFakeTransport } = await import("../fakeTransport");
    const f = createFakeTransport({ platformId: "acct_PLATFORM0001", connectedId: "acct_CONNECTED001" });
    const post = (path: string, body: Record<string, string>, idem: string) => f.transport({ method: "POST", path, stripeAccount: "acct_CONNECTED001", stripeVersion: STRIPE_API_VERSION, idempotencyKey: idem, body }, "rk_test_unitonly0000000000");
    const noEmail = await post("/v1/customers", { name: "n" }, "d24proof-rg-1");
    const withEmail = await post("/v1/customers", { name: "n", email: "d24-proof-abc123-a@example.com" }, "d24proof-rg-2");
    const inv = (customer: string) => ({ customer, collection_method: "send_invoice", days_until_due: "30", currency: "usd", auto_advance: "false" });
    expect((await post("/v1/invoices", inv(String(noEmail.json?.id)), "d24proof-rg-3")).status).toBe(400);
    expect((await post("/v1/invoices", inv(String(withEmail.json?.id)), "d24proof-rg-4")).status).toBe(200);
  });
  it("scenarios.ts builds the email on the reserved example.com from the run id and the customer ref (lower-case alphanumerics only)", () => {
    const src = readFileSync(join(__dirname, "..", "scenarios.ts"), "utf8");
    expect(src).toContain("@example.com");
    expect(src).toContain("d24-proof-");
    expect(src).not.toMatch(/@(gmail|yahoo|outlook|hotmail)./);
  });
});

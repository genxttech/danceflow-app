// Allow-list for the D24 M3-D proof (plan section 6). Default deny: a request is permitted only when it matches one rule exactly
// (method, path shape, Stripe-Account binding, query keys, form keys and the value constraints). Evaluated BEFORE any network I/O.
// Finalize, send, pay, void, mark_uncollectible and every unrelated Stripe operation have no rule, so they can never be sent,
// whatever permissions the key carries.

import type { Method, ProofRequest } from "./types";

export type Verdict = { ok: true; rule: string } | { ok: false; reason: string };

const ID = "[A-Za-z0-9]{3,64}";
const ACCT_RE = /^acct_[A-Za-z0-9]{6,64}$/;

/** Hard limits that keep a mistaken call small: invoices stay tiny drafts. */
export const LIMITS = Object.freeze({ maxLineCents: 20_000, maxLines: 2, minDays: 14, maxDays: 30, idemKeyMax: 200 });

type Val = (v: string) => boolean;
const oneOf = (...xs: string[]): Val => (v) => xs.includes(v);
const re = (r: RegExp): Val => (v) => r.test(v);
const intRange = (lo: number, hi: number): Val => (v) => /^\d{1,9}$/.test(v) && Number(v) >= lo && Number(v) <= hi;

type Rule = {
  id: string;
  method: Method;
  path: RegExp;
  /** none: the header must be absent; connected: it must equal the pinned connected account. */
  account: "none" | "connected";
  query: Record<string, Val>;
  requiredQuery: string[];
  /** null = the request must have no body. */
  body: { keys: Array<{ key: RegExp; val: Val }>; required: string[] } | null;
  idempotency: "required" | "forbidden";
};

const metaVal = re(/^[A-Za-z0-9_.:-]{1,100}$/);
const textVal = re(/^[A-Za-z0-9 _.:#-]{1,200}$/);

function rules(connected: string): Rule[] {
  const lineIdx = `[0-${LIMITS.maxLines - 1}]`;
  return [
    { id: "identity.platform", method: "GET", path: /^\/v1\/account$/, account: "none", query: {}, requiredQuery: [], body: null, idempotency: "forbidden" },
    {
      id: "identity.connected",
      method: "GET",
      path: new RegExp(`^/v1/accounts/${connected.replace(/[^A-Za-z0-9_]/g, "")}$`),
      account: "none",
      query: {},
      requiredQuery: [],
      body: null,
      idempotency: "forbidden",
    },
    {
      id: "customer.create",
      method: "POST",
      path: /^\/v1\/customers$/,
      account: "connected",
      query: {},
      requiredQuery: [],
      // no email key: the proof fixture client has none, so Stripe has nothing to email even if an invoice were ever finalized by mistake
      body: {
        keys: [
          { key: /^name$/, val: textVal },
          { key: /^metadata\[d24_intent_id\]$/, val: metaVal },
          { key: /^metadata\[d24_client_ref\]$/, val: metaVal },
        ],
        required: ["name"],
      },
      idempotency: "required",
    },
    { id: "customer.delete", method: "DELETE", path: new RegExp(`^/v1/customers/cus_${ID}$`), account: "connected", query: {}, requiredQuery: [], body: null, idempotency: "forbidden" },
    {
      id: "invoice.create_draft",
      method: "POST",
      path: /^\/v1\/invoices$/,
      account: "connected",
      query: {},
      requiredQuery: [],
      body: {
        keys: [
          { key: /^customer$/, val: re(new RegExp(`^cus_${ID}$`)) },
          { key: /^collection_method$/, val: oneOf("send_invoice") },
          { key: /^days_until_due$/, val: intRange(LIMITS.minDays, LIMITS.maxDays) },
          { key: /^currency$/, val: oneOf("usd") },
          { key: /^auto_advance$/, val: oneOf("false") },
          { key: /^description$/, val: textVal },
          { key: /^metadata\[d24_intent_id\]$/, val: metaVal },
        ],
        required: ["customer", "collection_method", "days_until_due", "currency", "auto_advance"],
      },
      idempotency: "required",
    },
    {
      id: "invoice.add_lines",
      method: "POST",
      path: new RegExp(`^/v1/invoices/in_${ID}/add_lines$`),
      account: "connected",
      query: {},
      requiredQuery: [],
      body: {
        keys: [
          { key: new RegExp(`^lines\\[${lineIdx}\\]\\[description\\]$`), val: textVal },
          { key: new RegExp(`^lines\\[${lineIdx}\\]\\[amount\\]$`), val: intRange(1, LIMITS.maxLineCents) },
        ],
        required: ["lines[0][description]", "lines[0][amount]"],
      },
      idempotency: "required",
    },
    { id: "invoice.read", method: "GET", path: new RegExp(`^/v1/invoices/in_${ID}$`), account: "connected", query: {}, requiredQuery: [], body: null, idempotency: "forbidden" },
    {
      id: "invoice.list_by_customer",
      method: "GET",
      path: /^\/v1\/invoices$/,
      account: "connected",
      query: { customer: re(new RegExp(`^cus_${ID}$`)), limit: oneOf("100") },
      requiredQuery: ["customer", "limit"],
      body: null,
      idempotency: "forbidden",
    },
    // drafts only: enforced for real by the guarded client, which refuses a DELETE for any id it has not seen with status=draft
    { id: "invoice.delete_draft", method: "DELETE", path: new RegExp(`^/v1/invoices/in_${ID}$`), account: "connected", query: {}, requiredQuery: [], body: null, idempotency: "forbidden" },
    // the two expected-403 negatives (the key has NO permission on them); same request shape as every other call
    { id: "negative.transfers", method: "GET", path: /^\/v1\/transfers$/, account: "connected", query: { limit: oneOf("1") }, requiredQuery: ["limit"], body: null, idempotency: "forbidden" },
    { id: "negative.webhook_endpoints", method: "GET", path: /^\/v1\/webhook_endpoints$/, account: "connected", query: {}, requiredQuery: [], body: null, idempotency: "forbidden" },
  ];
}

/** Names the dangerous operation for a clearer refusal message. The rule table is still default-deny without this. */
function dangerLabel(path: string): string | null {
  const m = /(finalize|send|pay|void|mark_uncollectible|refund|payout|transfer|charge|payment|credit_note|subscription|product|price|webhook|api_key|balance|capture|cancel|attach)/i.exec(path);
  return m ? m[1].toLowerCase() : null;
}

export function evaluateRequest(req: ProofRequest, expect: { connectedAcct: string }): Verdict {
  if (!ACCT_RE.test(expect.connectedAcct)) return { ok: false, reason: "pinned connected account id is not a valid acct_ id" };
  // path hygiene first: encoded separators, dot segments, whitespace, query/fragment, host tricks are never matched
  if (typeof req.path !== "string" || !/^\/v1\/[A-Za-z0-9_/]+$/.test(req.path) || req.path.includes("//") || req.path.endsWith("/")) {
    return { ok: false, reason: `path is not a plain /v1 path: ${JSON.stringify(req.path)}` };
  }
  const rule = rules(expect.connectedAcct).find((r) => r.method === req.method && r.path.test(req.path));
  if (!rule) {
    const danger = dangerLabel(req.path);
    return { ok: false, reason: `no allow-list rule for ${req.method} ${req.path}${danger ? ` (${danger} is never permitted in the proof)` : ""}` };
  }
  if (rule.account === "none" && req.stripeAccount !== undefined) return { ok: false, reason: `${rule.id}: Stripe-Account must not be sent` };
  if (rule.account === "connected" && req.stripeAccount !== expect.connectedAcct) {
    return { ok: false, reason: `${rule.id}: Stripe-Account must be exactly the pinned connected account` };
  }
  const key = req.idempotencyKey;
  if (rule.idempotency === "forbidden" && key !== undefined) return { ok: false, reason: `${rule.id}: no Idempotency-Key allowed` };
  if (rule.idempotency === "required" && (key === undefined || !/^d24proof-[A-Za-z0-9:_-]+$/.test(key) || key.length > LIMITS.idemKeyMax)) {
    return { ok: false, reason: `${rule.id}: a d24proof-… Idempotency-Key is required` };
  }
  const q = req.query ?? {};
  for (const [k, v] of Object.entries(q)) {
    const val = rule.query[k];
    if (!val) return { ok: false, reason: `${rule.id}: query parameter not allowed: ${k}` };
    if (!val(v)) return { ok: false, reason: `${rule.id}: query value not allowed for ${k}` };
  }
  for (const k of rule.requiredQuery) if (!(k in q)) return { ok: false, reason: `${rule.id}: missing query parameter ${k}` };
  const body = req.body;
  if (rule.body === null) {
    if (body !== undefined && Object.keys(body).length > 0) return { ok: false, reason: `${rule.id}: no body allowed` };
  } else {
    if (!body) return { ok: false, reason: `${rule.id}: body required` };
    for (const [k, v] of Object.entries(body)) {
      if (typeof v !== "string") return { ok: false, reason: `${rule.id}: body values must be strings (${k})` };
      const spec = rule.body.keys.find((s) => s.key.test(k));
      if (!spec) return { ok: false, reason: `${rule.id}: body parameter not allowed: ${k}` };
      if (!spec.val(v)) return { ok: false, reason: `${rule.id}: body value not allowed for ${k}` };
    }
    for (const k of rule.body.required) if (!(k in body)) return { ok: false, reason: `${rule.id}: missing body parameter ${k}` };
    if (rule.id === "invoice.add_lines") {
      const idx = new Set(Object.keys(body).map((k) => Number(/\[(\d)\]/.exec(k)?.[1])));
      for (const i of idx) {
        if (!(`lines[${i}][description]` in body) || !(`lines[${i}][amount]` in body)) return { ok: false, reason: "invoice.add_lines: each line needs description and amount" };
      }
      const total = [...idx].reduce((s, i) => s + Number(body[`lines[${i}][amount]`]), 0);
      if (total > LIMITS.maxLineCents) return { ok: false, reason: "invoice.add_lines: total above the proof cap" };
    }
  }
  return { ok: true, rule: rule.id };
}

/** Printed by the script and listed in the PR so the owner can read exactly what is permitted. */
export function describeAllowList(connected = "acct_CONNECTED"): string[] {
  return rules(connected).map(
    (r) => `${r.method.padEnd(6)} ${r.path.source.replace(/\\/g, "").replace(/^\^|\$$/g, "")}  [${r.id}; Stripe-Account ${r.account === "none" ? "absent" : "= pinned connected"}]`,
  );
}

// D24 TEST-account provisioning (PROOF-SUPPORT ONLY, NOT AUTHORIZED TO RUN LIVE). Never imported from src/.
// Creates ONE production-equivalent Express connected account in the dedicated Stripe TEST sandbox, exactly as
// src/app/api/stripe/connect/onboarding/route.ts does, plus a D24-fixture metadata marker. Default deny: a closed allow-list of three requests,
// a hard call cap, no retry, no redirect, and an in-memory fake transport for --dry-run. This file imports NO real transport; the run.ts CLI cannot send a request.
// Nothing here has been run against Stripe. The proof's identity gate (checkConnectedAccount) is REUSED unchanged to judge the account that comes back.

import { createHash } from "node:crypto";
import { checkConnectedAccount, checkKeyShape, type ConnectedFacts } from "../d24-m3d-proof/identity";
import { redactText } from "../d24-m3d-proof/redact";
import type { ProofRequest, ProofResponse, Transport } from "../d24-m3d-proof/types";

/** Default API version of the pinned `stripe` SDK (22.0.1 -> node_modules/stripe/cjs/apiVersion.js). A test keeps it equal to the proof's pin. */
export const PROVISION_API_VERSION = "2026-03-25.dahlia";
export const PROVISION_HARD_CALL_CAP = 3;
export const FIXTURE_METADATA_KEY = "d24_proof_fixture";
export const FIXTURE_ROLE_POSITIVE = "express_prod_equivalent";

export const ENV = Object.freeze({
  key: "D24_PROVISION_STRIPE_KEY",
  platform: "D24_PROVISION_EXPECT_PLATFORM_ACCT",
  envelope: "D24_PROVISION_ENVELOPE_REF",
  phrase: "D24_PROVISION_AUTHORIZATION",
  evidenceDir: "D24_PROVISION_EVIDENCE_DIR",
});
export const AUTHORIZATION_PHRASE = "Approved: D24 TEST account provisioning as written";
/** The owner-issued envelope reference, e.g. D24-ENV-20261108-a1b2c3d4. The tool cannot verify the approval itself: it only refuses to run without a well-formed reference, which is recorded in the account metadata and the evidence. */
export const ENVELOPE_REF_RE = /^D24-ENV-\d{8}-[A-Za-z0-9]{8,32}$/;

export type Abort = { code: "blocked_request" | "budget_exceeded" | "livemode_true" | "version_mismatch" | "identity_mismatch" | "unexpected_status" | "transport_error" | "observed_mismatch"; message: string };
export class ProvisionAbort extends Error {
  readonly code: Abort["code"];
  constructor(code: Abort["code"], message: string) {
    super(redactText(message));
    this.name = "ProvisionAbort";
    this.code = code;
  }
}

/** The exact production create call (route.ts:69-77), with only the metadata replaced: no country, no business_type, no email, capabilities card_payments + transfers. */
export function buildCreateRequest(opts: { envelopeRef: string; idempotencyKey: string }): ProofRequest {
  return {
    method: "POST",
    path: "/v1/accounts",
    stripeVersion: PROVISION_API_VERSION,
    idempotencyKey: opts.idempotencyKey,
    body: {
      type: "express",
      "capabilities[card_payments][requested]": "true",
      "capabilities[transfers][requested]": "true",
      [`metadata[${FIXTURE_METADATA_KEY}]`]: "true",
      "metadata[d24_fixture_role]": FIXTURE_ROLE_POSITIVE,
      "metadata[d24_envelope_ref]": opts.envelopeRef,
    },
  };
}

const CREATE_KEYS = new Set(["type", "capabilities[card_payments][requested]", "capabilities[transfers][requested]", `metadata[${FIXTURE_METADATA_KEY}]`, "metadata[d24_fixture_role]", "metadata[d24_envelope_ref]"]);
const ACCT = /^acct_[A-Za-z0-9]{6,64}$/;

/** Why a request is not allowed (null = allowed). Pure; used before the transport is ever called. */
export function allowProblem(req: ProofRequest, state: { platformId: string | null; createdId: string | null; createSent: boolean }): string | null {
  if (req.stripeVersion !== PROVISION_API_VERSION) return "Stripe-Version missing or not the pin";
  if (req.stripeAccount !== undefined) return "Stripe-Account is never sent by provisioning";
  if (req.query && Object.keys(req.query).length > 0) return "query strings are not allowed";
  if (req.method === "GET" && req.path === "/v1/account") return req.idempotencyKey || req.body ? "GET /v1/account takes no body or idempotency key" : null;
  if (req.method === "GET") {
    const m = /^\/v1\/accounts\/(acct_[A-Za-z0-9]{6,64})$/.exec(req.path);
    if (!m) return "GET path not on the allow-list";
    if (!state.createdId || m[1] !== state.createdId) return "readback is only allowed for the account this run just created";
    return req.idempotencyKey || req.body ? "readback takes no body or idempotency key" : null;
  }
  if (req.method === "POST" && req.path === "/v1/accounts") {
    if (state.platformId === null) return "platform identity must be verified before the create";
    if (state.createSent) return "exactly one create per run";
    if (!req.idempotencyKey || !/^d24prov-[A-Za-z0-9-]{16,64}$/.test(req.idempotencyKey)) return "create requires a d24prov-… idempotency key";
    const b = req.body ?? {};
    for (const k of Object.keys(b)) if (!CREATE_KEYS.has(k)) return `form key ${k.slice(0, 40)} is not on the allow-list`;
    if (b.type !== "express" || b["capabilities[card_payments][requested]"] !== "true" || b["capabilities[transfers][requested]"] !== "true") return "create must be the production Express shape";
    if (b[`metadata[${FIXTURE_METADATA_KEY}]`] !== "true" || b["metadata[d24_fixture_role]"] !== FIXTURE_ROLE_POSITIVE) return "create must carry the fixture markers";
    if (!ENVELOPE_REF_RE.test(b["metadata[d24_envelope_ref]"] ?? "")) return "create must carry a well-formed envelope reference";
    return null;
  }
  return "request not on the allow-list (DELETE, update, account links, login links, balance, everything else: refused)";
}

export type ProvisionResult = {
  accountId: string;
  facts: ConnectedFacts;
  createRequestId: string | undefined;
  readbackRequestId: string | undefined;
  platformReadRequestId: string | undefined;
  idempotencyKeySha256: string;
  calls: Array<{ method: string; path: string; status: number | "ERROR"; requestId: string; atUtc: string }>;
  capabilities: Record<string, string>;
  chargesEnabled: boolean | null;
  /** Raw controller enums as observed (whitelisted short strings only), recorded for the owner; the verdict comes from the proof's gate, not from this. */
  observedController: Record<string, string>;
};

const CONTROLLER_PATHS: Array<[string, string[]]> = [["type", ["controller", "type"]], ["is_controller", ["controller", "is_controller"]], ["stripe_dashboard.type", ["controller", "stripe_dashboard", "type"]], ["requirement_collection", ["controller", "requirement_collection"]], ["losses.payments", ["controller", "losses", "payments"]], ["fees.payer", ["controller", "fees", "payer"]]];
export function observedController(j: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const t = j?.type;
  out["account.type"] = typeof t === "string" ? t.slice(0, 20) : "(absent)";
  for (const [label, path] of CONTROLLER_PATHS) {
    let cur: unknown = j;
    for (const k of path) cur = cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
    out[`controller.${label}`] = typeof cur === "string" || typeof cur === "boolean" ? String(cur).slice(0, 30) : "(absent)";
  }
  return out;
}

/** The whole flow against an injected transport. Pure of I/O apart from the transport. */
export async function runProvision(args: { transport: Transport; apiKey: string; expectPlatformAcct: string; envelopeRef: string; idempotencyKey: string; now?: () => Date }): Promise<ProvisionResult> {
  const keyProblem = checkKeyShape(args.apiKey);
  if (!keyProblem.ok) throw new ProvisionAbort("blocked_request", keyProblem.reason);
  if (!ACCT.test(args.expectPlatformAcct)) throw new ProvisionAbort("identity_mismatch", "pinned platform account id is malformed");
  if (!ENVELOPE_REF_RE.test(args.envelopeRef)) throw new ProvisionAbort("blocked_request", "envelope reference is malformed");
  const now = args.now ?? (() => new Date());
  const state = { platformId: null as string | null, createdId: null as string | null, createSent: false };
  const calls: ProvisionResult["calls"] = [];
  let used = 0;

  const send = async (req: ProofRequest): Promise<ProofResponse> => {
    const problem = allowProblem(req, state);
    if (problem) throw new ProvisionAbort("blocked_request", `${req.method} ${req.path}: ${problem}`);
    if (used >= PROVISION_HARD_CALL_CAP) throw new ProvisionAbort("budget_exceeded", "hard call cap reached");
    used += 1;
    if (req.method === "POST") state.createSent = true;
    const atUtc = now().toISOString();
    let res: ProofResponse;
    try {
      res = await args.transport(req, args.apiKey); // no retry, ever
    } catch (e) {
      calls.push({ method: req.method, path: req.path, status: "ERROR", requestId: "-", atUtc });
      const sent = req.method === "POST" ? " The create may or may not have happened: do NOT retry; look in the Stripe TEST dashboard (metadata d24_envelope_ref) and ask the owner for a new envelope." : "";
      throw new ProvisionAbort("transport_error", `${req.method} ${req.path} failed (${redactText(String((e as Error)?.message ?? e)).slice(0, 120)}).${sent}`);
    }
    calls.push({ method: req.method, path: req.path, status: res.status, requestId: res.requestId ?? "-", atUtc });
    if (res.stripeVersion !== undefined && res.stripeVersion !== PROVISION_API_VERSION) throw new ProvisionAbort("version_mismatch", "Stripe answered with a different API version");
    if (res.json?.livemode === true || (res.json && /"livemode"\s*:\s*true/.test(JSON.stringify(res.json)))) throw new ProvisionAbort("livemode_true", "a response reported livemode:true");
    return res;
  };

  const platform = await send({ method: "GET", path: "/v1/account", stripeVersion: PROVISION_API_VERSION });
  if (platform.status !== 200 || String(platform.json?.id ?? "") !== args.expectPlatformAcct) throw new ProvisionAbort("identity_mismatch", "GET /v1/account is not the pinned sandbox platform account");
  state.platformId = args.expectPlatformAcct;

  const created = await send(buildCreateRequest({ envelopeRef: args.envelopeRef, idempotencyKey: args.idempotencyKey }));
  const createdId = String(created.json?.id ?? "");
  if (created.status !== 200 || !ACCT.test(createdId) || createdId === args.expectPlatformAcct) throw new ProvisionAbort("unexpected_status", `create answered ${created.status} without a usable new account id; do NOT retry`);
  state.createdId = createdId;

  const read = await send({ method: "GET", path: `/v1/accounts/${createdId}`, stripeVersion: PROVISION_API_VERSION });
  if (read.status !== 200 || String(read.json?.id ?? "") !== createdId) throw new ProvisionAbort("identity_mismatch", "readback did not return the created account");

  // The proof's identity gate, unchanged, judges BOTH the create response and the independent readback.
  for (const [label, j] of [["create response", created.json], ["readback", read.json]] as const) {
    const v = checkConnectedAccount(j);
    if (!v.ok) throw new ProvisionAbort("observed_mismatch", `${label}: ${v.reason}`);
  }
  const verdict = checkConnectedAccount(read.json);
  if (!verdict.ok) throw new ProvisionAbort("observed_mismatch", verdict.reason);
  const md = read.json?.metadata as Record<string, unknown> | undefined;
  if (md?.[FIXTURE_METADATA_KEY] !== "true" || md?.d24_fixture_role !== FIXTURE_ROLE_POSITIVE) throw new ProvisionAbort("observed_mismatch", "readback metadata does not carry the fixture markers");

  const caps: Record<string, string> = {};
  const rc = read.json?.capabilities;
  if (rc && typeof rc === "object") for (const [k, v] of Object.entries(rc as Record<string, unknown>)) if (typeof v === "string") caps[k.slice(0, 40)] = v.slice(0, 20);
  return {
    accountId: createdId,
    facts: verdict.facts,
    createRequestId: created.requestId,
    readbackRequestId: read.requestId,
    platformReadRequestId: platform.requestId,
    idempotencyKeySha256: createHash("sha256").update(args.idempotencyKey).digest("hex"),
    calls,
    capabilities: caps,
    chargesEnabled: typeof read.json?.charges_enabled === "boolean" ? read.json.charges_enabled : null,
    observedController: observedController(read.json),
  };
}

/** Fake Stripe for --dry-run and tests. Models only what provisioning touches. `controller` lets a test return the old, mismatched account. */
export function createFakeProvisionTransport(o: { platformId: string; createdId?: string; accountType?: "express" | "none"; controller?: unknown; livemode?: boolean; createStatus?: number; throwOnCreate?: boolean }): { transport: Transport; calls: ProofRequest[] } {
  const calls: ProofRequest[] = [];
  const createdId = o.createdId ?? "acct_FAKEPROVISION01";
  let stored: Record<string, unknown> | null = null;
  const prodEquivalent = { type: "application", is_controller: true, stripe_dashboard: { type: "express" }, requirement_collection: "stripe", losses: { payments: "application" }, fees: { payer: "application_express" } };
  let n = 0;
  const transport: Transport = async (req) => {
    calls.push(structuredClone(req));
    const requestId = `req_fakeprov${++n}`;
    const base = { requestId, stripeVersion: PROVISION_API_VERSION };
    if (req.method === "GET" && req.path === "/v1/account") return { ...base, status: 200, json: { id: o.platformId, object: "account", livemode: false } };
    if (req.method === "POST" && req.path === "/v1/accounts") {
      if (o.throwOnCreate) throw new Error("socket hang up");
      if (o.createStatus && o.createStatus !== 200) return { ...base, status: o.createStatus, json: { error: { type: "api_error" } } };
      const md: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.body ?? {})) { const m = /^metadata\[(.+)\]$/.exec(k); if (m) md[m[1]] = v; }
      stored = { id: createdId, object: "account", livemode: o.livemode ?? false, type: o.accountType ?? "express", controller: o.controller === undefined ? prodEquivalent : o.controller, metadata: md, capabilities: { card_payments: "inactive", transfers: "inactive" }, charges_enabled: false };
      return { ...base, status: 200, json: stored };
    }
    if (req.method === "GET" && stored && req.path === `/v1/accounts/${createdId}`) return { ...base, status: 200, json: stored };
    return { ...base, status: 404, json: { error: { type: "invalid_request_error", code: "resource_missing" } } };
  };
  return { transport, calls };
}

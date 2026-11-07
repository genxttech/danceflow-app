// Identity gate (plan section 2). Runs before any scenario and aborts on any mismatch. Nothing here trusts a name; only the pinned ids.

import { STRIPE_API_VERSION } from "./config";
import { looksLikeLiveSecret } from "./redact";
import type { Expect } from "./types";
import type { GuardedClient } from "./guarded";

/** Owner-supplied environment variables. The key is NEVER read from a file or argv; only from this environment variable. */
export const ENV = Object.freeze({
  key: "D24_PROOF_STRIPE_KEY",
  platform: "D24_PROOF_EXPECT_PLATFORM_ACCT",
  connected: "D24_PROOF_EXPECT_CONNECTED_ACCT",
  pinnedSha: "D24_PROOF_PINNED_SHA256",
  phrase: "D24_PROOF_AUTHORIZATION",
});
export const AUTHORIZATION_PHRASE = "Approved: D24 M3-D Stripe TEST proof as written";

/** Restricted TEST key only: sk_* is too broad, *_live_* is live, pk_* is publishable. */
export function checkKeyShape(key: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (!key) return { ok: false, reason: "no key supplied" };
  if (!/^rk_test_[A-Za-z0-9]+$/.test(key)) {
    // never echo the key: describe the family only
    const family = /^(sk|rk|pk)_(test|live)_/.exec(key);
    return { ok: false, reason: `key must be a restricted test key (rk_test_…); got ${family ? `${family[1]}_${family[2]}_ key` : "an unrecognised string"}` };
  }
  return { ok: true };
}

const ACCT = /^acct_[A-Za-z0-9]{6,64}$/;
/** Environment names that would point the run (or the app under test) at a hosted database. */
const HOSTED_DB_VARS = ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_DB_URL", "SUPABASE_SERVICE_ROLE_KEY", "DIRECT_URL", "SHADOW_DATABASE_URL", "PGHOST"];
const isLocalHost = (v: string) => !/[?&]host=/i.test(v) && /^(?:[a-z]+:\/\/)?(?:[^@/]*@)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?]|$)/i.test(v);

/** Problems with the environment (empty list = ok). Never includes a secret value. */
export function checkEnvironment(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const name of HOSTED_DB_VARS) {
    const v = env[name];
    if (v && !isLocalHost(v)) problems.push(`${name} is set to a non-local value (a hosted database must not be reachable from the proof)`);
  }
  for (const [name, v] of Object.entries(env)) {
    if (name !== ENV.key && v && looksLikeLiveSecret(v)) problems.push(`${name} contains a live key (remove it from this shell)`);
  }
  for (const name of ["NODE_OPTIONS", "NODE_USE_SYSTEM_CA", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "OPENSSL_CONF", "OPENSSL_MODULES", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "npm_config_proxy", "npm_config_https_proxy", "NODE_USE_ENV_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    if (env[name]) problems.push(`${name} is set (it can redirect, observe or patch the HTTPS traffic that carries the key); unset it for the proof`);
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") problems.push("NODE_TLS_REJECT_UNAUTHORIZED=0 is set (TLS verification must stay on)");
  if (env.D24_HOSTED_INVOICE_CREATION === "on") problems.push("D24_HOSTED_INVOICE_CREATION=on is set (the flag must stay off)");
  return problems;
}

export function checkPinnedIds(env: Record<string, string | undefined>): { ok: true; expect: Expect } | { ok: false; reason: string } {
  const platformAcct = env[ENV.platform] ?? "";
  const connectedAcct = env[ENV.connected] ?? "";
  if (!ACCT.test(platformAcct)) return { ok: false, reason: `${ENV.platform} must be the sandbox account id (acct_…)` };
  if (!ACCT.test(connectedAcct)) return { ok: false, reason: `${ENV.connected} must be the connected test account id (acct_…)` };
  if (platformAcct === connectedAcct) return { ok: false, reason: "platform and connected account ids must differ" };
  return { ok: true, expect: { platformAcct, connectedAcct } };
}

/** What the gate verified about the connected account: enum strings only (every value below was compared against a fixed literal), never free text. */
export type ConnectedFacts = {
  accountType: "express" | "none";
  model: "legacy_express" | "controller_express";
  controller?: { type: "application"; is_controller: true; stripe_dashboard_type: "express"; requirement_collection: "stripe"; losses_payments: "application"; fees_payer: "application" | "application_express" };
  /** legacy express only: the dashboard type the account's controller object reported, when it had one */
  legacyDashboardType?: "express";
};

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The values the gate actually saw on the connected account: bounded enum-like tokens only, whatever the account returned. */
export type ConnectedObserved = {
  type: string;
  controller_type: string;
  controller_is_controller: string | boolean;
  controller_stripe_dashboard_type: string;
  controller_requirement_collection: string;
  controller_losses_payments: string;
  controller_fees_payer: string;
};
const TOKEN = /^[a-z_]{1,32}$/;
/** One observed value as a token: a lowercase enum-like string as is; "absent" | "null" | "unexpected_type:<typeof>" | "unrecognised" otherwise. Never free text. */
const tokenOf = (v: unknown): string => {
  if (v === undefined) return "absent";
  if (v === null) return "null";
  if (typeof v === "string") return TOKEN.test(v) ? v : "unrecognised";
  return `unexpected_type:${Array.isArray(v) ? "array" : typeof v}`;
};
/** Walks `path` down from `root`. A missing / null / non-object ancestor is DESCRIBED ("absent" | "null" | "unexpected_type:..."), never indexed. Returns the leaf or a token string for a broken path. */
const walk = (root: unknown, path: string[]): { leaf: unknown } | { broken: string } => {
  let cur = root;
  for (const k of path) {
    if (cur === undefined) return { broken: "absent" };
    if (cur === null) return { broken: "null" };
    if (!plain(cur)) return { broken: `unexpected_type:${Array.isArray(cur) ? "array" : typeof cur}` };
    cur = cur[k];
  }
  return { leaf: cur };
};
const observeToken = (root: unknown, path: string[]): string => {
  const w = walk(root, path);
  return "broken" in w ? w.broken : tokenOf(w.leaf);
};

/** Reads ONLY the seven fields below from the answer; nothing else is ever copied. */
export function observeConnectedAccount(json: Record<string, unknown> | null | undefined): ConnectedObserved {
  const j = json ?? {};
  const w = walk(j, ["controller", "is_controller"]);
  const isController: string | boolean = "broken" in w ? w.broken : typeof w.leaf === "boolean" ? w.leaf : w.leaf === undefined ? "absent" : w.leaf === null ? "null" : `unexpected_type:${Array.isArray(w.leaf) ? "array" : typeof w.leaf}`;
  return {
    type: observeToken(j, ["type"]),
    controller_type: observeToken(j, ["controller", "type"]),
    controller_is_controller: isController,
    controller_stripe_dashboard_type: observeToken(j, ["controller", "stripe_dashboard", "type"]),
    controller_requirement_collection: observeToken(j, ["controller", "requirement_collection"]),
    controller_losses_payments: observeToken(j, ["controller", "losses", "payments"]),
    controller_fees_payer: observeToken(j, ["controller", "fees", "payer"]),
  };
}

/**
 * Pure check of GET /v1/accounts/<connected>. Accepts ONLY an Express-dashboard account:
 *   (a) legacy type "express" (if a controller object is present and reports a stripe_dashboard.type, that must be "express"), or
 *   (b) type "none" (controller-model account) whose controller is EXACTLY the Express-equivalent: type application, is_controller true,
 *       stripe_dashboard.type express, requirement_collection stripe, losses.payments application, fees.payer application | application_express.
 * Anything else (standard, custom, none with any other / missing / mistyped controller value, unknown or non-string type) is refused. No blanket "none".
 */
export function checkConnectedAccount(json: Record<string, unknown> | null | undefined): { ok: true; facts: ConnectedFacts } | { ok: false; reason: string } {
  const j = json ?? {};
  const type = j.type;
  const c = j.controller;
  if (type === "express") {
    const legacy: ConnectedFacts = { accountType: "express", model: "legacy_express" };
    if (c === undefined || c === null) return { ok: true, facts: legacy };
    if (!plain(c)) return { ok: false, reason: 'connected account type is "express" but its controller is not an object' };
    const d = c.stripe_dashboard;
    if (d === undefined || d === null) return { ok: true, facts: legacy };
    if (!plain(d)) return { ok: false, reason: 'connected account type is "express" but controller.stripe_dashboard is not an object' };
    if (d.type === undefined) return { ok: true, facts: legacy };
    if (d.type !== "express") return { ok: false, reason: 'connected account type is "express" but controller.stripe_dashboard.type is not "express"' };
    return { ok: true, facts: { ...legacy, legacyDashboardType: "express" } };
  }
  if (type === "none") {
    if (!plain(c)) return { ok: false, reason: 'connected account type is "none" and it has no controller object (cannot be shown to be Express-equivalent)' };
    const dash = plain(c.stripe_dashboard) ? c.stripe_dashboard : null;
    const losses = plain(c.losses) ? c.losses : null;
    const fees = plain(c.fees) ? c.fees : null;
    const checks: Array<[string, boolean]> = [
      ["controller.type = application", c.type === "application"],
      ["controller.is_controller = true", c.is_controller === true],
      ["controller.stripe_dashboard.type = express", dash?.type === "express"],
      ["controller.requirement_collection = stripe", c.requirement_collection === "stripe"],
      ["controller.losses.payments = application", losses?.payments === "application"],
      ["controller.fees.payer = application | application_express", fees?.payer === "application" || fees?.payer === "application_express"],
    ];
    const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
    if (bad.length > 0) return { ok: false, reason: `connected account type is "none" and its controller is not Express-equivalent (failed: ${bad.join("; ")})` };
    return {
      ok: true,
      facts: {
        accountType: "none",
        model: "controller_express",
        controller: { type: "application", is_controller: true, stripe_dashboard_type: "express", requirement_collection: "stripe", losses_payments: "application", fees_payer: fees?.payer as "application" | "application_express" },
      },
    };
  }
  return { ok: false, reason: `connected account type is ${typeof type === "string" ? (type === "standard" || type === "custom" ? JSON.stringify(type) : "unrecognised") : "not a string"}, expected an Express-dashboard account (type express, or type none with an Express-equivalent controller)` };
}

/**
 * S0: GET /v1/account must be the pinned sandbox; GET /v1/accounts/<connected> must be the pinned connected account, Express-dashboard
 * (see checkConnectedAccount), and must not say livemode:true. Both reads go through the guarded client (allow-list, budget, livemode check).
 * Returns the evidence on success; throws ProofAbort("identity_mismatch") otherwise.
 */
export async function runIdentityGate(client: GuardedClient, expect: Expect, onObserved?: (o: ConnectedObserved) => void): Promise<{ platformId: string; connectedId: string; connectedType: string; connectedFacts: ConnectedFacts }> {
  const platform = await client.call({ method: "GET", path: "/v1/account", stripeVersion: STRIPE_API_VERSION });
  const platformId = String(platform.json?.id ?? "");
  if (platformId !== expect.platformAcct) throw client.raise("identity_mismatch", "GET /v1/account returned an id other than the pinned sandbox account");
  const connected = await client.call({ method: "GET", path: `/v1/accounts/${expect.connectedAcct}`, stripeVersion: STRIPE_API_VERSION });
  const connectedId = String(connected.json?.id ?? "");
  if (connectedId !== expect.connectedAcct) throw client.raise("identity_mismatch", "GET /v1/accounts/<connected> returned an id other than the pinned connected account");
  onObserved?.(observeConnectedAccount(connected.json)); // what the answer actually said, recorded BEFORE any verdict (a rejection must be diagnosable)
  if (connected.json?.livemode === true) throw client.raise("livemode_true", "connected account says livemode:true");
  const verdict = checkConnectedAccount(connected.json);
  if (!verdict.ok) throw client.raise("identity_mismatch", verdict.reason);
  client.markIdentityVerified(); // only now may any other request be sent
  return { platformId, connectedId, connectedType: verdict.facts.accountType, connectedFacts: verdict.facts };
}

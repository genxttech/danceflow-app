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

/**
 * S0: GET /v1/account must be the pinned sandbox; GET /v1/accounts/<connected> must be the pinned connected account, type express,
 * and must not say livemode:true. Both reads go through the guarded client (allow-list, budget, livemode check).
 * Returns the evidence on success; throws ProofAbort("identity_mismatch") otherwise.
 */
export async function runIdentityGate(client: GuardedClient, expect: Expect): Promise<{ platformId: string; connectedId: string; connectedType: string }> {
  const platform = await client.call({ method: "GET", path: "/v1/account", stripeVersion: STRIPE_API_VERSION });
  const platformId = String(platform.json?.id ?? "");
  if (platformId !== expect.platformAcct) throw client.raise("identity_mismatch", "GET /v1/account returned an id other than the pinned sandbox account");
  const connected = await client.call({ method: "GET", path: `/v1/accounts/${expect.connectedAcct}`, stripeVersion: STRIPE_API_VERSION });
  const connectedId = String(connected.json?.id ?? "");
  if (connectedId !== expect.connectedAcct) throw client.raise("identity_mismatch", "GET /v1/accounts/<connected> returned an id other than the pinned connected account");
  const connectedType = String(connected.json?.type ?? "");
  if (connectedType !== "express") throw client.raise("identity_mismatch", `connected account type is "${connectedType}", expected express`);
  if (connected.json?.livemode === true) throw client.raise("livemode_true", "connected account says livemode:true");
  client.markIdentityVerified(); // only now may any other request be sent
  return { platformId, connectedId, connectedType };
}

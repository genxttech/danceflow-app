import "server-only";
import { isLoopbackUrl } from "./loopback";
import type { IsvEnvName } from "./types";

/**
 * TW-4 R1: configuration and the "may this process call Twilio's registration APIs at all?" gate.
 *
 * Design rule (TW-4 §15): DEV and preview environments NEVER call Trust Hub / A2P create endpoints. The gate below allows the
 * real adapter only when BOTH the deployment is production AND `TW4_ISV_REAL_CALLS=on` is set deliberately. Nothing in the
 * application sets it. The fake adapter is allowed everywhere except production.
 */

type Env = Record<string, string | undefined>;

export type IsvConfig = {
  accountSid: string;
  /** The account auth token. EMPTY when an ISV API key is configured: the two are mutually exclusive and the token is then never read. */
  authToken: string;
  /**
   * Standard API key for the registration APIs (TWILIO_ISV_API_KEY_SID / TWILIO_ISV_API_KEY_SECRET). When present, every request is signed with
   * the key and the auth token plays no part: there is NO fallback from the key to the token. Absent = the original behavior (account
   * SID + auth token), which is what production uses today.
   */
  apiKeySid?: string;
  apiKeySecret?: string;
  primaryProfileSid: string;
  /** The Trust Hub policy of the ISV Primary profile; the preflight requires the Primary profile to carry exactly this policy. */
  primaryProfilePolicySid: string;
  secondaryProfilePolicySid: string;
  a2pPolicySid: string;
  complianceEmail: string;
  envName: IsvEnvName;
  /** Register as a Twilio MOCK brand (no fee, for a controlled dry run). Defaults to false. */
  mockBrand: boolean;
};

const SID = (prefix: string) => new RegExp(`^${prefix}[0-9a-fA-F]{32}$`);

export function isvEnvName(env: Env = process.env): IsvEnvName {
  const vercel = String(env.VERCEL_ENV ?? "").toLowerCase();
  if (vercel === "production") return "production";
  if (vercel === "preview") return "preview";
  if (String(env.NODE_ENV ?? "") === "test") return "test";
  return "development";
}

export type RealCallsGate = { allowed: true } | { allowed: false; reason: string };

export function realCallsAllowed(env: Env = process.env): RealCallsGate {
  if (isvEnvName(env) !== "production") return { allowed: false, reason: "Twilio registration calls are disabled outside production." };
  // A production build only: a local `next dev` with pulled production variables has NODE_ENV=development and is refused.
  if (String(env.NODE_ENV ?? "") !== "production") return { allowed: false, reason: "Twilio registration calls are disabled outside a production build." };
  if (String(env.TW4_ISV_REAL_CALLS ?? "") !== "on") return { allowed: false, reason: "Twilio registration calls are switched off." };
  return { allowed: true };
}

/**
 * TW-4F R2: may this process create Messaging Services and campaigns (and, in R2b, buy numbers) in a subaccount? Production deployment AND production build AND
 * BOTH `TW4_ISV_REAL_CALLS=on` (the registration gate) and `TW4_PROVISIONING_REAL_CALLS=on`: registration can be live while provisioning stays off. Fee-bearing
 * provisioning also needs a published price, an owner approval and funds (checked in the database) before the first call.
 */
export function provisioningCallsAllowed(env: Env = process.env): RealCallsGate {
  const registration = realCallsAllowed(env);
  if (!registration.allowed) return registration;
  if (String(env.TW4_PROVISIONING_REAL_CALLS ?? "") !== "on") return { allowed: false, reason: "Twilio provisioning calls are switched off." };
  return { allowed: true };
}

/**
 * TW-4F provider integration: may this deployment read subaccount Auth Tokens (GET, parent credentials) to verify subaccount-signed webhooks?
 * Production build on a production deployment AND `TW4_SUBACCOUNT_WEBHOOKS=on`, independently of TW4_ISV_REAL_CALLS: verifying callbacks is a
 * read, never a registration write. Off (the default) = a webhook naming one of our subaccounts is refused with 503; parent-signed webhooks are
 * unaffected.
 */
export function subaccountWebhooksAllowed(env: Env = process.env): RealCallsGate {
  if (isvEnvName(env) !== "production") return { allowed: false, reason: "Subaccount webhook verification is disabled outside production." };
  if (String(env.NODE_ENV ?? "") !== "production") return { allowed: false, reason: "Subaccount webhook verification is disabled outside a production build." };
  if (String(env.TW4_SUBACCOUNT_WEBHOOKS ?? "") !== "on") return { allowed: false, reason: "Subaccount webhook verification is switched off." };
  return { allowed: true };
}

/** The fake writes fake SIDs into the ledger and registration rows, so it may only run against a LOCAL database. */
function localDatabase(env: Env): boolean {
  return isLoopbackUrl(String(env.NEXT_PUBLIC_SUPABASE_URL ?? ""));
}

export function fakeAdapterAllowed(env: Env = process.env): boolean {
  return isvEnvName(env) !== "production" && String(env.TW4_ISV_FAKE ?? "") === "on" && localDatabase(env);
}

export type IsvConfigResult = { ok: true; config: IsvConfig } | { ok: false; missing: string[] };

/** Names of missing or malformed variables only; values are never echoed. */
export function loadIsvConfig(env: Env = process.env): IsvConfigResult {
  const missing: string[] = [];
  const need = (name: string, pattern?: RegExp) => {
    const value = String(env[name] ?? "").trim();
    if (!value || (pattern && !pattern.test(value))) missing.push(name);
    return value;
  };
  const accountSid = need("TWILIO_ACCOUNT_SID", SID("AC"));
  // Credentials: either an ISV API key (both variables) or the account auth token, never both. With a key, TWILIO_AUTH_TOKEN is not read at all.
  const apiKeySid = String(env.TWILIO_ISV_API_KEY_SID ?? "").trim();
  const apiKeySecret = String(env.TWILIO_ISV_API_KEY_SECRET ?? "").trim();
  const useApiKey = apiKeySid !== "" || apiKeySecret !== "";
  let authToken = "";
  if (useApiKey) {
    if (!SID("SK").test(apiKeySid)) missing.push("TWILIO_ISV_API_KEY_SID");
    if (!/^[A-Za-z0-9]{32}$/.test(apiKeySecret)) missing.push("TWILIO_ISV_API_KEY_SECRET");
  } else {
    authToken = need("TWILIO_AUTH_TOKEN");
  }
  const primaryProfileSid = need("TWILIO_ISV_PRIMARY_PROFILE_SID", SID("BU"));
  const primaryProfilePolicySid = need("TWILIO_ISV_PRIMARY_POLICY_SID", SID("RN"));
  const secondaryProfilePolicySid = need("TWILIO_ISV_SECONDARY_POLICY_SID", SID("RN"));
  const a2pPolicySid = need("TWILIO_ISV_A2P_POLICY_SID", SID("RN"));
  const complianceEmail = need("TWILIO_ISV_COMPLIANCE_EMAIL", /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: {
      accountSid, authToken, ...(useApiKey ? { apiKeySid, apiKeySecret } : {}), primaryProfileSid, primaryProfilePolicySid, secondaryProfilePolicySid, a2pPolicySid, complianceEmail,
      envName: isvEnvName(env),
      mockBrand: String(env.TW4_ISV_MOCK_BRAND ?? "") === "on",
    },
  };
}

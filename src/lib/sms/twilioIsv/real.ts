import "server-only";
import { SubaccountTokenProvider } from "./account";
import { isvEnvName, numberCallsAllowed, provisioningCallsAllowed, realCallsAllowed, subaccountWebhooksAllowed, type IsvConfig } from "./config";
import type { AvailableNumber, CampaignComplianceFacts, IsvNumberAdapter, OwnedNumberFacts, ServiceNumbersFacts, ServiceRouteFacts } from "./numberTypes";
import type { CampaignCreateInput, CampaignFacts, IsvProvisioningAdapter, MessagingServiceFacts } from "./provisioningTypes";
import {
  IsvApiError, type BrandStatus, type BundleStatus, type EndUserType, type EvaluationResult, type IsvAdapter, type IsvParentAdapter,
} from "./types";

/**
 * TW-4 R1: the REAL Twilio adapter (REST, one account per instance; TW-4F-3a: a studio legal entity's subaccount, form-encoded, HTTP Basic). It is the only code in the application that can
 * reach Twilio's registration APIs, and `createRealIsvAdapter` refuses to build one unless `realCallsAllowed()` is true
 * (production build on a production deployment AND TW4_ISV_REAL_CALLS=on).
 *
 * STATUS: request shapes follow Twilio's public Trust Hub / A2P documentation and are pinned by unit tests with an injected
 * `fetch`. It has NOT been run against live Twilio. Before the first production run, do a controlled dry run with a Twilio
 * MOCK brand (`TW4_ISV_MOCK_BRAND=on`) on a NON-pilot studio and read the first evaluation results. Error messages never include
 * request attributes.
 *
 * STABLE EXPORTS for SUBACCOUNT MESSAGING credentials (billed sends, evidence reads and sender verification; they do NOT need TW4_ISV_REAL_CALLS):
 *   - messagingTokenReadsAllowed(env)        the gate (production deployment + production build + one of SMS_BILLED_REAL_SEND / SMS_SENDER_VERIFY_READS /
 *                                            SMS_USAGE_EVIDENCE_READS = "on")
 *   - createMessagingTokenParent(creds, env) the token-read parent (GET Accounts/{sid}.json with PARENT credentials; active subaccounts only)
 *   - messagingTokenProvider(env)            process-wide SubaccountTokenProvider (memory only, TTL 60s) over that parent, or null when gated off / unconfigured
 *   - MESSAGING_TOKEN_TTL_MS
 *
 * Outcome classification (matters for paid steps): a POST is a DEFINITE failure only when Twilio answered with a parseable 4xx.
 * A network error, a timeout, a 429/5xx, an unreadable body, a 2xx without a valid SID: all are `transient`, i.e. the resource
 * may or may not exist, and the runner must reconcile instead of repeating.
 */

const TRUSTHUB = "https://trusthub.twilio.com/v1";
const MESSAGING = "https://messaging.twilio.com/v1";
const API = "https://api.twilio.com/2010-04-01";
const TIMEOUT_MS = 20_000;
const MAX_PAGES = 10;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

function classify(status: number): IsvApiError["kind"] {
  if (status === 401 || status === 403) return "account";
  if (status === 429 || status >= 500) return "transient";
  if (status >= 400) return "validation";
  return "transient"; // 1xx/3xx: not an answer we understand
}

type Credentials = Pick<IsvConfig, "accountSid" | "authToken" | "apiKeySid" | "apiKeySecret">;

/** The HTTP machinery shared by the registration adapter (one account) and the parent account-management client. It exposes no Twilio operation itself. */
export abstract class TwilioRest<C extends Credentials> {
  constructor(protected readonly config: C, protected readonly fetchImpl: FetchLike) {
    // A key SID without its secret would sign every request with an empty password. Fail loudly here instead (never fall back to the token).
    if (config.apiKeySid && !config.apiKeySecret) throw new IsvApiError("account", null, null, "an API key SID is configured without its secret");
  }

  /**
   * HTTP Basic. With an ISV API key: username = key SID, password = key secret (Twilio's documented API-key authentication; the Account SID
   * then only appears in URL paths). Otherwise the original account SID + auth token. The choice is made once, from configuration:
   * a rejected key is NEVER retried with the auth token.
   */
  protected authHeader() {
    const c = this.config;
    const pair = c.apiKeySid ? `${c.apiKeySid}:${c.apiKeySecret ?? ""}` : `${c.accountSid}:${c.authToken}`;
    return `Basic ${Buffer.from(pair).toString("base64")}`;
  }

  protected async request(method: "GET" | "POST", url: string, form?: Record<string, string | string[] | undefined>): Promise<Record<string, unknown>> {
    let body: string | undefined;
    if (form) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) {
        if (Array.isArray(value)) for (const item of value) params.append(key, item); // Twilio repeats the key for a list (MessageSamples, OptInKeywords, ...)
        else if (value !== undefined) params.append(key, value);
      }
      body = params.toString();
    }
    let status: number;
    let raw: string;
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: { Authorization: this.authHeader(), Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = response.status;
      raw = await response.text(); // reading the body can fail too: it is part of the network exchange
    } catch {
      throw new IsvApiError("transient", null, null, "network failure or timeout");
    }
    let json: Record<string, unknown> | null = null;
    try {
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    if (status >= 200 && status < 300) {
      // success status with an unreadable body: the request may well have been applied, so the caller must not treat it as a clean failure
      if (json === null) throw new IsvApiError("transient", status, null, "success response could not be read");
      return json;
    }
    // Twilio's own code and message only; never the request body. An unparseable error body is still classified by status.
    const code = json && json.code !== undefined ? String(json.code) : null;
    const message = json && typeof json.message === "string" ? json.message.slice(0, 200) : `http ${status}`;
    throw new IsvApiError(classify(status), status, code, message);
  }

  /** A 2xx response that carries no valid SID: the resource may exist, the outcome is unknown. */
  protected sid(json: Record<string, unknown>, pattern: RegExp): string {
    const value = String(json.sid ?? "");
    if (!pattern.test(value)) throw new IsvApiError("transient", null, null, "response carried no valid sid");
    return value;
  }

  /** GET a list, following Twilio's own next-page links (host-checked) for a bounded number of pages. */
  protected async listAll(firstUrl: string, host: string, rowsKey: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let url: string | null = firstUrl;
    for (let page = 0; page < MAX_PAGES && url; page += 1) {
      const json: Record<string, unknown> = await this.request("GET", url);
      // a list whose named collection is missing (a renamed key, an error shape) must not read as "nothing exists": these lookups guard duplicate creates
      if (rowsKey !== "results" && rowsKey !== "data" && !Array.isArray(json[rowsKey])) throw new IsvApiError("transient", null, null, "list response carried no collection");
      const list =Array.isArray(json[rowsKey]) ? (json[rowsKey] as Record<string, unknown>[]) : Array.isArray(json.results) ? (json.results as Record<string, unknown>[]) : Array.isArray(json.data) ? (json.data as Record<string, unknown>[]) : [];
      rows.push(...list);
      const meta = (json.meta ?? {}) as Record<string, unknown>;
      // a next-page link that is not on our own host is NOT "the last page": the listing is incomplete and cannot prove that anything is absent
      if (typeof meta.next_page_url === "string" && meta.next_page_url !== "" && !meta.next_page_url.startsWith(host)) throw new IsvApiError("transient", null, null, "list continues on an unexpected host");
      url = typeof meta.next_page_url === "string" && meta.next_page_url.startsWith(host) ? meta.next_page_url : null;
    }
    // A lookup that stopped with pages still to read cannot prove that a resource does NOT exist, and these lookups guard paid and
    // duplicate-prone creates: treat it as an unknown outcome so the run stops instead of creating.
    if (url) throw new IsvApiError("transient", null, null, "list too long to search safely");
    return rows;
  }
}

/** One account's registration adapter. TW-4F-3a: built for a studio legal entity's SUBACCOUNT (its SID and its own credentials), never the parent. */
export class RealIsvAdapter extends TwilioRest<IsvConfig> implements IsvAdapter {
  get accountSid(): string {
    return this.config.accountSid;
  }

  // --- customer profile ---------------------------------------------------------------------------------------------
  async getCustomerProfile(profileSid: string): Promise<{ status: BundleStatus; policySid: string | null }> {
    const json = await this.request("GET", `${TRUSTHUB}/CustomerProfiles/${encodeURIComponent(profileSid)}`);
    return { status: String(json.status ?? "unknown"), policySid: typeof json.policy_sid === "string" ? json.policy_sid : null };
  }

  async findCustomerProfile(friendlyName: string): Promise<string[]> {
    const rows = await this.listAll(`${TRUSTHUB}/CustomerProfiles?FriendlyName=${encodeURIComponent(friendlyName)}&PageSize=50`, TRUSTHUB, "results");
    return rows.filter((row) => row.friendly_name === friendlyName).map((row) => String(row.sid));
  }

  async createCustomerProfile(input: { friendlyName: string; email: string }): Promise<string> {
    const json = await this.request("POST", `${TRUSTHUB}/CustomerProfiles`, {
      FriendlyName: input.friendlyName, Email: input.email, PolicySid: this.config.secondaryProfilePolicySid,
    });
    return this.sid(json, /^BU[0-9a-fA-F]{32}$/);
  }

  async createEndUser(input: { friendlyName: string; type: EndUserType; attributes: Record<string, string> }): Promise<string> {
    const json = await this.request("POST", `${TRUSTHUB}/EndUsers`, {
      FriendlyName: input.friendlyName, Type: input.type, Attributes: JSON.stringify(input.attributes),
    });
    return this.sid(json, /^IT[0-9a-fA-F]{32}$/);
  }

  async createAddress(input: Parameters<IsvAdapter["createAddress"]>[0]): Promise<string> {
    const json = await this.request("POST", `${API}/Accounts/${encodeURIComponent(this.config.accountSid)}/Addresses.json`, {
      CustomerName: input.customerName, Street: input.street, StreetSecondary: input.streetSecondary || undefined,
      City: input.city, Region: input.region, PostalCode: input.postalCode, IsoCountry: input.isoCountry,
    });
    return this.sid(json, /^AD[0-9a-fA-F]{32}$/);
  }

  async createSupportingDocument(input: { friendlyName: string; addressSid: string }): Promise<string> {
    const json = await this.request("POST", `${TRUSTHUB}/SupportingDocuments`, {
      FriendlyName: input.friendlyName, Type: "customer_profile_address", Attributes: JSON.stringify({ address_sids: input.addressSid }),
    });
    return this.sid(json, /^RD[0-9a-fA-F]{32}$/);
  }

  async assignToCustomerProfile(profileSid: string, objectSid: string): Promise<string> {
    const json = await this.request("POST", `${TRUSTHUB}/CustomerProfiles/${encodeURIComponent(profileSid)}/EntityAssignments`, { ObjectSid: objectSid });
    return this.sid(json, /^BV[0-9a-fA-F]{32}$/);
  }

  private evaluation(json: Record<string, unknown>): { evaluationSid: string; result: EvaluationResult } {
    const evaluationSid = this.sid(json, /^EL[0-9a-fA-F]{32}$/);
    const failed = new Set<string>();
    const results = Array.isArray(json.results) ? (json.results as Record<string, unknown>[]) : [];
    for (const result of results) {
      const fields = Array.isArray(result.fields) ? (result.fields as Record<string, unknown>[]) : [];
      for (const field of fields) {
        if (field.passed === false && typeof field.object_field === "string") failed.add(field.object_field);
      }
    }
    // Fail closed: only Twilio's exact "compliant" with no failing field is compliant; only its exact "noncompliant" is noncompliant;
    // a missing, non-string, unknown or contradictory status is "unrecognized" (never success).
    const status = json.status;
    if (status === "compliant" && failed.size === 0) return { evaluationSid, result: { status: "compliant", failedFields: [] } };
    if (status === "noncompliant") return { evaluationSid, result: { status: "noncompliant", failedFields: [...failed] } };
    return { evaluationSid, result: { status: "unrecognized", failedFields: [...failed] } };
  }

  async evaluateCustomerProfile(profileSid: string) {
    return this.evaluation(await this.request("POST", `${TRUSTHUB}/CustomerProfiles/${encodeURIComponent(profileSid)}/Evaluations`, { PolicySid: this.config.secondaryProfilePolicySid }));
  }

  async submitCustomerProfile(profileSid: string): Promise<string> {
    const json = await this.request("POST", `${TRUSTHUB}/CustomerProfiles/${encodeURIComponent(profileSid)}`, { Status: "pending-review" });
    return this.sid(json, /^BU[0-9a-fA-F]{32}$/);
  }

  // --- A2P trust product --------------------------------------------------------------------------------------------
  async findTrustProduct(friendlyName: string): Promise<string[]> {
    const rows = await this.listAll(`${TRUSTHUB}/TrustProducts?FriendlyName=${encodeURIComponent(friendlyName)}&PageSize=50`, TRUSTHUB, "results");
    return rows.filter((row) => row.friendly_name === friendlyName).map((row) => String(row.sid));
  }

  async createTrustProduct(input: { friendlyName: string; email: string }): Promise<string> {
    const json = await this.request("POST", `${TRUSTHUB}/TrustProducts`, {
      FriendlyName: input.friendlyName, Email: input.email, PolicySid: this.config.a2pPolicySid,
    });
    return this.sid(json, /^BU[0-9a-fA-F]{32}$/);
  }

  async assignToTrustProduct(trustProductSid: string, objectSid: string): Promise<string> {
    const json = await this.request("POST", `${TRUSTHUB}/TrustProducts/${encodeURIComponent(trustProductSid)}/EntityAssignments`, { ObjectSid: objectSid });
    return this.sid(json, /^BV[0-9a-fA-F]{32}$/);
  }

  async evaluateTrustProduct(trustProductSid: string) {
    return this.evaluation(await this.request("POST", `${TRUSTHUB}/TrustProducts/${encodeURIComponent(trustProductSid)}/Evaluations`, { PolicySid: this.config.a2pPolicySid }));
  }

  async getTrustProductStatus(trustProductSid: string): Promise<{ status: BundleStatus }> {
    const json = await this.request("GET", `${TRUSTHUB}/TrustProducts/${encodeURIComponent(trustProductSid)}`);
    return { status: String(json.status ?? "unknown") };
  }

  async submitTrustProduct(trustProductSid: string): Promise<string> {
    const json = await this.request("POST", `${TRUSTHUB}/TrustProducts/${encodeURIComponent(trustProductSid)}`, { Status: "pending-review" });
    return this.sid(json, /^BU[0-9a-fA-F]{32}$/);
  }

  // --- brand --------------------------------------------------------------------------------------------------------
  async findBrand(input: { customerProfileSid: string; trustProductSid: string }): Promise<string[]> {
    const rows = await this.listAll(`${MESSAGING}/a2p/BrandRegistrations?PageSize=50`, MESSAGING, "data");
    const matches = rows.filter((row) => row.customer_profile_bundle_sid === input.customerProfileSid && row.a2p_profile_bundle_sid === input.trustProductSid);
    // In a mock run, an existing brand for this profile that is not a mock brand is a real (paid) one: stop, never adopt it.
    if (this.config.mockBrand && matches.some((row) => row.mock !== true)) throw new IsvApiError("transient", null, null, "an existing brand is not confirmed as a mock brand");
    return matches.map((row) => String(row.sid));
  }

  async createBrand(input: Parameters<IsvAdapter["createBrand"]>[0]): Promise<string> {
    const json = await this.request("POST", `${MESSAGING}/a2p/BrandRegistrations`, {
      CustomerProfileBundleSid: input.customerProfileSid, A2PProfileBundleSid: input.trustProductSid, BrandType: input.brandType,
      SkipAutomaticSecVet: input.skipAutomaticSecVet ? "true" : undefined, Mock: input.mock ? "true" : undefined,
    });
    const sid = this.sid(json, /^BN[0-9a-fA-F]{32}$/);
    // A MOCK run must never silently be a real, paid brand: Twilio's own answer has to say the brand is a mock. If it does not, the
    // outcome is "unknown" (the brand exists), so the runner stops and reconciles instead of carrying on.
    if (input.mock && json.mock !== true) throw new IsvApiError("transient", null, null, "brand mock flag not confirmed by Twilio");
    return sid;
  }

  async getBrandStatus(brandSid: string): Promise<BrandStatus> {
    const json = await this.request("GET", `${MESSAGING}/a2p/BrandRegistrations/${encodeURIComponent(brandSid)}`);
    if (this.config.mockBrand && json.mock !== true) throw new IsvApiError("transient", null, null, "brand is not confirmed as a mock brand");
    return String(json.status ?? "unknown");
  }
}

/** The only constructor used by application code. Throws unless the environment explicitly allows real Twilio calls. */
export function createRealIsvAdapter(config: IsvConfig, env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): RealIsvAdapter {
  const gate = realCallsAllowed(env);
  if (!gate.allowed) throw new IsvApiError("account", null, null, gate.reason);
  return new RealIsvAdapter(config, fetchImpl ?? ((url, init) => fetch(url, init)));
}

/**
 * TW-4F-3a: the PARENT account's account-management client. Parent credentials (account SID + auth token, or a Main API key) are needed to list,
 * create and read subaccounts; they are never used for Trust Hub or A2P calls (this class has no such method). Request shapes follow Twilio's public
 * Accounts documentation and are pinned by unit tests with an injected `fetch`; they have NOT been run against live Twilio.
 */
export class RealIsvParent extends TwilioRest<Credentials & Partial<Pick<IsvConfig, "primaryProfileSid">>> implements IsvParentAdapter {
  /**
   * GET only, and only the configured Primary profile (it lives in the parent account). This is the one Trust Hub request parent credentials make;
   * it can neither create nor change anything.
   */
  async getPrimaryProfile(): Promise<{ status: BundleStatus; policySid: string | null }> {
    const sid = String(this.config.primaryProfileSid ?? "");
    if (!/^BU[0-9a-fA-F]{32}$/.test(sid)) throw new IsvApiError("account", null, null, "no primary profile configured");
    const json = await this.request("GET", `${TRUSTHUB}/CustomerProfiles/${encodeURIComponent(sid)}`);
    // the reply must be about the profile that was asked for
    if (json.sid !== sid) throw new IsvApiError("transient", null, null, "primary profile reply does not match");
    return { status: String(json.status ?? "unknown"), policySid: typeof json.policy_sid === "string" ? json.policy_sid : null };
  }

  async findSubaccount(friendlyName: string): Promise<string[]> {
    const rows = await this.listAll(`${API}/Accounts.json?FriendlyName=${encodeURIComponent(friendlyName)}&PageSize=50`, API, "results");
    // closed accounts are gone for good: they never count as the studio's subaccount
    return rows.filter((row) => row.friendly_name === friendlyName && row.status !== "closed").map((row) => String(row.sid));
  }

  async createSubaccount(friendlyName: string): Promise<string> {
    const json = await this.request("POST", `${API}/Accounts.json`, { FriendlyName: friendlyName });
    return this.sid(json, /^AC[0-9a-fA-F]{32}$/);
  }

  async getSubaccountToken(accountSid: string): Promise<string> {
    if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid) || accountSid === this.config.accountSid) throw new IsvApiError("validation", null, null, "not a subaccount sid");
    const json = await this.request("GET", `${API}/Accounts/${encodeURIComponent(accountSid)}.json`);
    // the reply must be about the account that was asked for, and a closed account has no usable credential
    if (json.sid !== accountSid) throw new IsvApiError("transient", null, null, "account reply does not match");
    if (json.status === "closed") throw new IsvApiError("account", null, null, "subaccount is closed");
    const token = json.auth_token;
    // a reply without a usable token is not a credential: fail closed (never an empty password)
    if (typeof token !== "string" || !/^[0-9a-zA-Z]{32}$/.test(token)) throw new IsvApiError("transient", null, null, "response carried no valid credential");
    return token;
  }
}

/** The parent client. Same production gate as the registration adapter. */
export function createRealIsvParent(config: IsvConfig, env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): RealIsvParent {
  const gate = realCallsAllowed(env);
  if (!gate.allowed) throw new IsvApiError("account", null, null, gate.reason);
  return new RealIsvParent(config, fetchImpl ?? ((url, init) => fetch(url, init)));
}

/**
 * TW-4F provider integration: the parent client used ONLY to read subaccount tokens for webhook verification (parent account SID + auth token, the
 * existing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN). It has no Primary profile configured, so getPrimaryProfile refuses; creating subaccounts is never
 * called by the webhook path. Gated by `subaccountWebhooksAllowed`.
 */
export function createWebhookTokenParent(credentials: Pick<IsvConfig, "accountSid" | "authToken">, env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): RealIsvParent {
  const gate = subaccountWebhooksAllowed(env);
  if (!gate.allowed) throw new IsvApiError("account", null, null, gate.reason);
  if (!/^AC[0-9a-fA-F]{32}$/.test(credentials.accountSid) || !credentials.authToken) throw new IsvApiError("account", null, null, "parent credentials missing");
  return new RealIsvParent({ accountSid: credentials.accountSid, authToken: credentials.authToken }, fetchImpl ?? ((url, init) => fetch(url, init)));
}

/**
 * A registration adapter for ONE studio legal entity's subaccount: authenticated with the subaccount's own SID and auth token (Trust Hub and Messaging
 * are separate Twilio hosts and need the subaccount's credentials). The parent's API key is deliberately dropped: it must never sign a subaccount call.
 */
export function createScopedRealAdapter(config: IsvConfig, accountSid: string, authToken: string, env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): RealIsvAdapter {
  const gate = realCallsAllowed(env);
  if (!gate.allowed) throw new IsvApiError("account", null, null, gate.reason);
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid) || accountSid === config.accountSid) throw new IsvApiError("account", null, null, "not a subaccount sid");
  if (!authToken) throw new IsvApiError("account", null, null, "no subaccount credential");
  return new RealIsvAdapter({ ...config, accountSid, authToken, apiKeySid: undefined, apiKeySecret: undefined }, fetchImpl ?? ((url, init) => fetch(url, init)));
}

/** TTL of a subaccount token held for messaging (memory only). Short on purpose: bounds how long a rotated token stays useful. */
export const MESSAGING_TOKEN_TTL_MS = 60_000;

/**
 * May this deployment read subaccount Auth Tokens (GET, parent credentials) to sign messaging requests as the subaccount? Production build on a production
 * deployment AND one of SMS_BILLED_REAL_SEND=on (billed sends), SMS_SENDER_VERIFY_READS=on (sender verification reads) or SMS_USAGE_EVIDENCE_READS=on
 * (billing evidence reads). Independent of TW4_ISV_REAL_CALLS: these are reads and messaging, never registration writes.
 */
export function messagingTokenReadsAllowed(env: Record<string, string | undefined> = process.env): { allowed: true } | { allowed: false; reason: string } {
  if (isvEnvName(env) !== "production") return { allowed: false, reason: "Subaccount messaging credentials are disabled outside production." };
  if (String(env.NODE_ENV ?? "") !== "production") return { allowed: false, reason: "Subaccount messaging credentials are disabled outside a production build." };
  const on = (name: string) => String(env[name] ?? "") === "on";
  if (!on("SMS_BILLED_REAL_SEND") && !on("SMS_SENDER_VERIFY_READS") && !on("SMS_USAGE_EVIDENCE_READS")) {
    return { allowed: false, reason: "Subaccount messaging credentials are switched off." };
  }
  return { allowed: true };
}

/** The messaging token reader, stricter than the webhook one: a subaccount that is not "active" (suspended or closed) has no usable credential. */
class MessagingTokenParent extends RealIsvParent {
  async getSubaccountToken(accountSid: string): Promise<string> {
    if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid) || accountSid === this.config.accountSid) throw new IsvApiError("validation", null, null, "not a subaccount sid");
    const json = await this.request("GET", `${API}/Accounts/${encodeURIComponent(accountSid)}.json`);
    if (json.sid !== accountSid) throw new IsvApiError("transient", null, null, "account reply does not match");
    if (json.status !== "active") throw new IsvApiError("account", null, null, "subaccount is not active");
    const token = json.auth_token;
    if (typeof token !== "string" || !/^[0-9a-zA-Z]{32}$/.test(token)) throw new IsvApiError("transient", null, null, "response carried no valid credential");
    return token;
  }
}

/** The token-read parent for messaging (parent TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN). Gated by `messagingTokenReadsAllowed`; refuses the parent's own SID. */
export function createMessagingTokenParent(credentials: Pick<IsvConfig, "accountSid" | "authToken">, env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): RealIsvParent {
  const gate = messagingTokenReadsAllowed(env);
  if (!gate.allowed) throw new IsvApiError("account", null, null, gate.reason);
  if (!/^AC[0-9a-fA-F]{32}$/.test(credentials.accountSid) || !credentials.authToken) throw new IsvApiError("account", null, null, "parent credentials missing");
  return new MessagingTokenParent({ accountSid: credentials.accountSid, authToken: credentials.authToken }, fetchImpl ?? ((url, init) => fetch(url, init)));
}

const globalForMessaging = globalThis as unknown as { __tw4MessagingTokens?: { key: string; provider: SubaccountTokenProvider } };

/** Process-wide subaccount token provider for messaging (memory only, TTL 60s), or null when gated off or the parent credentials are missing. */
export function messagingTokenProvider(env: Record<string, string | undefined> = process.env): SubaccountTokenProvider | null {
  if (!messagingTokenReadsAllowed(env).allowed) return null;
  const accountSid = String(env.TWILIO_ACCOUNT_SID ?? "").trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN ?? "").trim();
  const key = `${accountSid}:${authToken}`;
  const held = globalForMessaging.__tw4MessagingTokens;
  if (held && held.key === key) return held.provider;
  try {
    const provider = new SubaccountTokenProvider(createMessagingTokenParent({ accountSid, authToken }, env), { ttlMs: MESSAGING_TOKEN_TTL_MS });
    globalForMessaging.__tw4MessagingTokens = { key, provider };
    return provider;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// TW-4F R2a: Messaging Service and A2P campaign provisioning inside ONE subaccount (subaccount credentials only; the parent key never signs these calls).
// Gated by provisioningCallsAllowed(): production build + production deployment + TW4_ISV_REAL_CALLS=on AND TW4_PROVISIONING_REAL_CALLS=on.
// Request shapes follow Twilio public Messaging Services / Usa2p documentation, pinned by unit tests with an injected fetch; NOT run against live Twilio.
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const MESSAGING_SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
const CAMPAIGN_REGISTRATION_SID = /^QE[0-9a-fA-F]{32}$/;
const PROVISION_ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;

const provStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const provBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const provChecked = (sid: string, pattern: RegExp): string => {
  if (!pattern.test(sid)) throw new IsvApiError("validation", null, null, "malformed resource sid");
  return sid;
};

/** Printable, single-line, bounded: what Twilio said failed, safe to store and show. */
function sanitizeCampaignErrors(value: unknown): string {
  const parts: string[] = [];
  const visit = (item: unknown) => {
    if (typeof item === "string") parts.push(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return parts.join("; ").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, 450);
}

export class RealProvisioningAdapter extends TwilioRest<IsvConfig> implements IsvProvisioningAdapter {
  /** Read-back facts from this adapter are real provider reads (the database accepts the fake source only on a local QA database). */
  readonly evidenceSource = "provider_read" as const;

  /** Not constructible from outside: only `createScopedProvisioningAdapter` builds one, after the provisioning gate says so. */
  private constructor(config: IsvConfig, fetchImpl: FetchLike) {
    super(config, fetchImpl);
  }

  /** The only way to build one: the provisioning gate and the subaccount checks are enforced here. */
  static forAccount(config: IsvConfig, accountSid: string, authToken: string, env: Record<string, string | undefined>, fetchImpl: FetchLike): RealProvisioningAdapter {
    const gate = provisioningCallsAllowed(env);
    if (!gate.allowed) throw new IsvApiError("account", null, null, gate.reason);
    if (!PROVISION_ACCOUNT_SID.test(accountSid) || accountSid === config.accountSid) throw new IsvApiError("account", null, null, "not a subaccount sid");
    if (!authToken) throw new IsvApiError("account", null, null, "no subaccount credential");
    // the parent's API key is dropped on purpose: it must never sign a subaccount call
    return new RealProvisioningAdapter({ ...config, accountSid, authToken, apiKeySid: undefined, apiKeySecret: undefined }, fetchImpl);
  }

  get accountSid(): string {
    return this.config.accountSid;
  }

  async findMessagingServices(friendlyNamePrefix: string): Promise<string[]> {
    const rows = await this.listAll(`${MESSAGING}/Services?PageSize=50`, MESSAGING, "services");
    return rows.filter((row) => typeof row.friendly_name === "string" && row.friendly_name.startsWith(friendlyNamePrefix) && row.account_sid === this.accountSid).map((row) => String(row.sid));
  }

  async createMessagingService(input: { friendlyName: string; inboundRequestUrl: string }): Promise<string> {
    // The service routes inbound texts to DanceFlow itself (not to each number), so the route is verifiable on the service.
    const json = await this.request("POST", `${MESSAGING}/Services`, {
      FriendlyName: input.friendlyName, InboundRequestUrl: input.inboundRequestUrl, InboundMethod: "POST", UseInboundWebhookOnNumber: "false",
    });
    return this.sid(json, MESSAGING_SERVICE_SID);
  }

  async getMessagingService(sid: string): Promise<MessagingServiceFacts> {
    const b = await this.request("GET", `${MESSAGING}/Services/${provChecked(sid, MESSAGING_SERVICE_SID)}`);
    return {
      sid: provStr(b.sid), account_sid: provStr(b.account_sid), friendly_name: provStr(b.friendly_name), inbound_request_url: provStr(b.inbound_request_url),
      use_inbound_webhook_on_number: provBool(b.use_inbound_webhook_on_number), us_app_to_person_registered: provBool(b.us_app_to_person_registered),
    };
  }

  async findCampaigns(messagingServiceSid: string): Promise<string[]> {
    const rows = await this.listAll(`${MESSAGING}/Services/${provChecked(messagingServiceSid, MESSAGING_SERVICE_SID)}/Compliance/Usa2p?PageSize=50`, MESSAGING, "compliance");
    // evidence-grade listing: a row of another or an unlabeled account means the response is not what we asked for, so the listing cannot certify absence
    if (rows.some((row) => row.account_sid !== this.accountSid)) throw new IsvApiError("transient", null, null, "campaign listing carried a foreign or unlabeled row");
    return rows.map((row) => String(row.sid));
  }

  async createCampaign(input: CampaignCreateInput): Promise<string> {
    const json = await this.request("POST", `${MESSAGING}/Services/${provChecked(input.messagingServiceSid, MESSAGING_SERVICE_SID)}/Compliance/Usa2p`, {
      BrandRegistrationSid: input.brandSid,
      UsAppToPersonUsecase: input.useCase,
      Description: input.description,
      MessageFlow: input.messageFlow,
      MessageSamples: input.messageSamples,
      HasEmbeddedLinks: String(input.hasEmbeddedLinks),
      HasEmbeddedPhone: String(input.hasEmbeddedPhone),
      SubscriberOptIn: String(input.subscriberOptIn),
      AgeGated: String(input.ageGated),
      DirectLending: String(input.directLending),
      OptInMessage: input.optInMessage,
      OptOutMessage: input.optOutMessage,
      HelpMessage: input.helpMessage,
      OptInKeywords: input.optInKeywords,
      OptOutKeywords: input.optOutKeywords,
      HelpKeywords: input.helpKeywords,
    });
    return this.sid(json, CAMPAIGN_REGISTRATION_SID);
  }

  async getCampaign(messagingServiceSid: string, campaignSid: string): Promise<CampaignFacts> {
    const b = await this.request("GET", `${MESSAGING}/Services/${provChecked(messagingServiceSid, MESSAGING_SERVICE_SID)}/Compliance/Usa2p/${provChecked(campaignSid, CAMPAIGN_REGISTRATION_SID)}`);
    return {
      sid: provStr(b.sid), account_sid: provStr(b.account_sid), messaging_service_sid: provStr(b.messaging_service_sid), brand_registration_sid: provStr(b.brand_registration_sid),
      us_app_to_person_usecase: provStr(b.us_app_to_person_usecase), campaign_status: provStr(b.campaign_status), mock: provBool(b.mock), errors: sanitizeCampaignErrors(b.errors),
    };
  }
}

/** A provisioning adapter for ONE subaccount, signed with that subaccount's own credentials. The parent's API key is dropped on purpose. */
export function createScopedProvisioningAdapter(
  config: IsvConfig, accountSid: string, authToken: string, env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike,
): RealProvisioningAdapter {
  return RealProvisioningAdapter.forAccount(config, accountSid, authToken, env, fetchImpl ?? ((url, init) => fetch(url, init)));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// TW-4F R2b: phone-number provisioning inside ONE subaccount (subaccount credentials only; the parent key never signs these calls). Gated by numberCallsAllowed():
// the provisioning gate PLUS TW4_NUMBER_REAL_CALLS=on. `purchaseNumber` is the only call that costs money. Request shapes follow Twilio public
// AvailablePhoneNumbers / IncomingPhoneNumbers / Messaging Services PhoneNumbers / Usa2p documentation, pinned by unit tests with an injected fetch;
// NOT run against live Twilio.
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const PHONE_NUMBER_SID = /^PN[0-9a-fA-F]{32}$/;
const E164_US = /^\+1[2-9][0-9]{9}$/;
const AREA_CODE = /^[2-9][0-9]{2}$/;

const numStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((item): item is string => typeof item === "string").slice(0, 20).map((item) => item.slice(0, 40)) : []);
const capability = (caps: unknown, name: string): boolean | null => {
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return null;
  const record = caps as Record<string, unknown>;
  const value = record[name] ?? record[name.toUpperCase()] ?? record[name.toLowerCase()];
  return typeof value === "boolean" ? value : null;
};

export class RealNumberAdapter extends TwilioRest<IsvConfig> implements IsvNumberAdapter {
  /** Read-back facts from this adapter are real provider reads (the database accepts the fake source only on a local QA database). */
  readonly evidenceSource = "provider_read" as const;

  /** Not constructible from outside: only `createScopedNumberAdapter` builds one, after the number gate says so. */
  private constructor(config: IsvConfig, fetchImpl: FetchLike) {
    super(config, fetchImpl);
  }

  static forAccount(config: IsvConfig, accountSid: string, authToken: string, env: Record<string, string | undefined>, fetchImpl: FetchLike): RealNumberAdapter {
    const gate = numberCallsAllowed(env);
    if (!gate.allowed) throw new IsvApiError("account", null, null, gate.reason);
    if (!PROVISION_ACCOUNT_SID.test(accountSid) || accountSid === config.accountSid) throw new IsvApiError("account", null, null, "not a subaccount sid");
    if (!authToken) throw new IsvApiError("account", null, null, "no subaccount credential");
    // the parent's API key is dropped on purpose: it must never sign a subaccount call
    return new RealNumberAdapter({ ...config, accountSid, authToken, apiKeySid: undefined, apiKeySecret: undefined }, fetchImpl);
  }

  get accountSid(): string {
    return this.config.accountSid;
  }

  private accountUrl(path: string): string {
    return `${API}/Accounts/${encodeURIComponent(this.accountSid)}/${path}`;
  }

  async searchAvailableNumbers(query: { areaCode?: string; limit: number }): Promise<AvailableNumber[]> {
    if (query.areaCode !== undefined && !AREA_CODE.test(query.areaCode)) throw new IsvApiError("validation", null, null, "invalid area code");
    const limit = Math.max(1, Math.min(50, Math.trunc(query.limit)));
    const params = new URLSearchParams({ SmsEnabled: "true", PageSize: String(limit) });
    if (query.areaCode) params.set("AreaCode", query.areaCode);
    const json = await this.request("GET", `${this.accountUrl("AvailablePhoneNumbers/US/Local.json")}?${params.toString()}`);
    const rows = Array.isArray(json.available_phone_numbers) ? (json.available_phone_numbers as Record<string, unknown>[]) : null;
    if (!rows) throw new IsvApiError("transient", null, null, "search response carried no collection");
    return rows
      .filter((row) => typeof row.phone_number === "string" && E164_US.test(row.phone_number))
      .map((row) => ({
        e164: String(row.phone_number), locality: provStr(row.locality), region: provStr(row.region),
        sms_capable: capability(row.capabilities, "sms") === true, mms_capable: capability(row.capabilities, "mms") === true, address_requirements: provStr(row.address_requirements),
      }));
  }

  async listIncomingNumbers(): Promise<{ sid: string; phone_number: string | null }[]> {
    const json = await this.request("GET", `${this.accountUrl("IncomingPhoneNumbers.json")}?PageSize=1000`);
    const rows = Array.isArray(json.incoming_phone_numbers) ? (json.incoming_phone_numbers as Record<string, unknown>[]) : null;
    if (!rows) throw new IsvApiError("transient", null, null, "list response carried no collection");
    // an inventory that stopped with pages still to read cannot prove the account holds nothing else
    if (typeof json.next_page_uri === "string" && json.next_page_uri) throw new IsvApiError("transient", null, null, "list too long to search safely");
    return rows
      // fail closed: every row the account's listing returns counts, whatever its account_sid says; a row without a valid sid makes the inventory unreadable
      .map((row) => {
        if (typeof row.sid !== "string" || !PHONE_NUMBER_SID.test(row.sid)) throw new IsvApiError("transient", null, null, "inventory row without a valid sid");
        return { sid: row.sid, phone_number: provStr(row.phone_number) };
      });
  }

  async findOwnedNumbers(e164: string): Promise<string[]> {
    if (!E164_US.test(e164)) throw new IsvApiError("validation", null, null, "invalid number");
    const json = await this.request("GET", `${this.accountUrl("IncomingPhoneNumbers.json")}?${new URLSearchParams({ PhoneNumber: e164, PageSize: "50" }).toString()}`);
    const rows = Array.isArray(json.incoming_phone_numbers) ? (json.incoming_phone_numbers as Record<string, unknown>[]) : null;
    if (!rows) throw new IsvApiError("transient", null, null, "list response carried no collection");
    // a lookup that stopped with pages still to read cannot prove a number is NOT owned, and it guards a paid create
    if (typeof json.next_page_uri === "string" && json.next_page_uri) throw new IsvApiError("transient", null, null, "list too long to search safely");
    return rows.filter((row) => row.account_sid === this.accountSid && row.phone_number === e164).map((row) => String(row.sid));
  }

  async purchaseNumber(input: { e164: string; friendlyName: string }): Promise<string> {
    if (!E164_US.test(input.e164)) throw new IsvApiError("validation", null, null, "invalid number");
    const json = await this.request("POST", this.accountUrl("IncomingPhoneNumbers.json"), { PhoneNumber: input.e164, FriendlyName: input.friendlyName.slice(0, 64) });
    return this.sid(json, PHONE_NUMBER_SID);
  }

  async getNumber(sid: string): Promise<OwnedNumberFacts> {
    const b = await this.request("GET", this.accountUrl(`IncomingPhoneNumbers/${provChecked(sid, PHONE_NUMBER_SID)}.json`));
    return { sid: provStr(b.sid), account_sid: provStr(b.account_sid), phone_number: provStr(b.phone_number), sms_capable: capability(b.capabilities, "sms") };
  }

  async listServiceNumbers(messagingServiceSid: string): Promise<string[]> {
    const rows = await this.listAll(`${MESSAGING}/Services/${provChecked(messagingServiceSid, MESSAGING_SERVICE_SID)}/PhoneNumbers?PageSize=50`, MESSAGING, "phone_numbers");
    return rows.filter((row) => row.account_sid === this.accountSid && typeof row.sid === "string" && PHONE_NUMBER_SID.test(row.sid)).map((row) => String(row.sid));
  }

  async attachNumber(input: { messagingServiceSid: string; phoneNumberSid: string }): Promise<string> {
    const json = await this.request("POST", `${MESSAGING}/Services/${provChecked(input.messagingServiceSid, MESSAGING_SERVICE_SID)}/PhoneNumbers`, { PhoneNumberSid: provChecked(input.phoneNumberSid, PHONE_NUMBER_SID) });
    return this.sid(json, PHONE_NUMBER_SID);
  }

  async getServiceNumbers(messagingServiceSid: string): Promise<ServiceNumbersFacts> {
    const service = await this.request("GET", `${MESSAGING}/Services/${provChecked(messagingServiceSid, MESSAGING_SERVICE_SID)}`);
    return { service_sid: provStr(service.sid), account_sid: provStr(service.account_sid), number_sids: await this.listServiceNumbers(messagingServiceSid) };
  }

  async getCampaignCompliance(messagingServiceSid: string, campaignSid: string): Promise<CampaignComplianceFacts> {
    const b = await this.request("GET", `${MESSAGING}/Services/${provChecked(messagingServiceSid, MESSAGING_SERVICE_SID)}/Compliance/Usa2p/${provChecked(campaignSid, CAMPAIGN_REGISTRATION_SID)}`);
    return {
      sid: provStr(b.sid), account_sid: provStr(b.account_sid), messaging_service_sid: provStr(b.messaging_service_sid), campaign_status: provStr(b.campaign_status), mock: provBool(b.mock),
      opt_in_keywords: numStrings(b.opt_in_keywords), opt_out_keywords: numStrings(b.opt_out_keywords), help_keywords: numStrings(b.help_keywords),
      opt_in_message: provStr(b.opt_in_message)?.slice(0, 320) ?? null, opt_out_message: provStr(b.opt_out_message)?.slice(0, 320) ?? null, help_message: provStr(b.help_message)?.slice(0, 320) ?? null,
    };
  }

  async getServiceRoute(messagingServiceSid: string): Promise<ServiceRouteFacts> {
    const b = await this.request("GET", `${MESSAGING}/Services/${provChecked(messagingServiceSid, MESSAGING_SERVICE_SID)}`);
    return { sid: provStr(b.sid), account_sid: provStr(b.account_sid), inbound_request_url: provStr(b.inbound_request_url), use_inbound_webhook_on_number: provBool(b.use_inbound_webhook_on_number) };
  }
}

/** A number adapter for ONE subaccount, signed with that subaccount's own credentials. The parent's API key is dropped on purpose. */
export function createScopedNumberAdapter(
  config: IsvConfig, accountSid: string, authToken: string, env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike,
): RealNumberAdapter {
  return RealNumberAdapter.forAccount(config, accountSid, authToken, env, fetchImpl ?? ((url, init) => fetch(url, init)));
}

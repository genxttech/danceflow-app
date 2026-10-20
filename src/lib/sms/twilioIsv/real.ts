import "server-only";
import { realCallsAllowed, subaccountWebhooksAllowed, type IsvConfig } from "./config";
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
abstract class TwilioRest<C extends Credentials> {
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

  protected async request(method: "GET" | "POST", url: string, form?: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const body = form
      ? new URLSearchParams(Object.entries(form).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString()
      : undefined;
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
  protected async listAll(firstUrl: string, host: string, rowsKey: "results" | "data"): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let url: string | null = firstUrl;
    for (let page = 0; page < MAX_PAGES && url; page += 1) {
      const json: Record<string, unknown> = await this.request("GET", url);
      const list = Array.isArray(json[rowsKey]) ? (json[rowsKey] as Record<string, unknown>[]) : Array.isArray(json.results) ? (json.results as Record<string, unknown>[]) : Array.isArray(json.data) ? (json.data as Record<string, unknown>[]) : [];
      rows.push(...list);
      const meta = (json.meta ?? {}) as Record<string, unknown>;
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

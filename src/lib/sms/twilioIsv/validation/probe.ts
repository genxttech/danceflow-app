import "server-only";

/**
 * TW-4 mock-brand validation, STAGE A: a READ-ONLY probe of the Twilio account. It can only issue HTTP GET requests, only to the three
 * Twilio hosts the registration APIs live on, and it never builds a request body. It creates nothing, changes nothing and cannot be
 * made to: `get` is the only network primitive in this file and it hard-refuses anything else. The report it returns never contains
 * credentials, request headers, full attribute values, or a full EIN (the registration number is reduced to its last four digits and
 * a match flag against the value the operator expects).
 *
 * What it answers before anything is created:
 *   - do the credentials work, is the account Full (not Trial);
 *   - is the Primary (ISV) profile `twilio-approved` and which policy does it carry;
 *   - which Trust Hub policies exist (to confirm the three TWILIO_ISV_*_POLICY_SID values), by name and SID;
 *   - what the Primary profile's business end user says (name, type, identity, registration-number last4) so the operator can compare it
 *     with the legal details they intend to use;
 *   - an inventory of the account's existing profiles / trust products / brands (a before-picture to diff after any later stage).
 */

const HOSTS = new Set(["trusthub.twilio.com", "messaging.twilio.com", "api.twilio.com"]);
const TIMEOUT_MS = 20_000;
const MAX_PAGES = 10;

export type ProbeFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal; redirect?: "error" },
) => Promise<{ status: number; text(): Promise<string> }>;

export class ProbeError extends Error {
  constructor(readonly kind: "account" | "validation" | "transient" | "refused", readonly status: number | null, readonly code: string | null, message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

type Json = Record<string, unknown>;
/** True only when the url's hostname is exactly the expected Twilio host (a prefix match would accept twilio.com.evil.example). */
function sameHost(rawUrl: string, host: string): boolean {
  try {
    const next = new URL(rawUrl);
    // same exact host, default https port, and a registration API path (a next link is data from Twilio, not a place to wander off to)
    return next.hostname === new URL(host).hostname && next.protocol === "https:" && next.port === "" && /^\/(v1|2010-04-01)\//.test(next.pathname);
  } catch {
    return false;
  }
}
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const last4 = (value: unknown): string | null => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
};
const digitsOf = (value: unknown): string => String(value ?? "").replace(/\D/g, "");

export type ProbeAuth = { username: string; password: string };

export type PrimaryProfileReport = {
  sid: string;
  status: string | null;
  policySid: string | null;
  policyMatchesConfigured: boolean | null;
  businessEndUser: null | {
    sid: string;
    type: string | null;
    businessName: string | null;
    businessType: string | null;
    businessIdentity: string | null;
    industries: string | null;
    registrationNumberType: string | null;
    registrationNumberLast4: string | null;
    /** Compared with the legal details the operator says they will use (null when none was supplied). */
    nameMatchesExpected: boolean | null;
    einMatchesExpected: boolean | null;
  };
  endUserAttributeKeys: string[];
};

export type PolicyRow = { sid: string; friendlyName: string | null; configuredAs: string[] };

export type InventoryReport = {
  customerProfiles: { total: number; byStatus: Record<string, number>; truncated: boolean };
  trustProducts: { total: number; byStatus: Record<string, number>; truncated: boolean };
  brands: { total: number; byStatus: Record<string, number>; truncated: boolean; sids: string[]; withBooleanMockField: number };
  /** Profiles / trust products whose FriendlyName starts with the prefix a later stage would use (expected: none). */
  namedPrefixMatches: { prefix: string; customerProfiles: number; trustProducts: number };
};

export type StageAReport = {
  readOnly: true;
  requests: { count: number; methods: string[]; hosts: string[] };
  /** ok === null means the account endpoint was deliberately not called (Standard API keys cannot read /Accounts). */
  account: { ok: boolean | null; status: string | null; type: string | null; skipped?: string };
  primary: PrimaryProfileReport | null;
  policies: PolicyRow[];
  configuredPolicyChecks: Record<string, "found" | "not_found" | "not_configured">;
  /** Checks that were NOT performed and why. A skipped check is not a pass: its section in this report is empty or null. */
  notRun: { section: string; reason: string }[];
  inventory: InventoryReport | null;
  problems: string[];
};

export type StageAInput = {
  accountSid: string;
  /** How the credentials authenticate. A Standard API key cannot read the Accounts resource (Twilio docs), so that call is skipped for api_key. */
  authMethod?: "api_key" | "auth_token";
  primaryProfileSid: string;
  /** The three policy SIDs the runner would use, if already known. */
  configuredPolicies?: { primary?: string; secondary?: string; a2p?: string };
  /** Legal details the operator intends to use; compared, never echoed. */
  expectedLegalName?: string;
  expectedEin?: string;
  friendlyNamePrefix?: string;
};

export class ReadOnlyProbe {
  private readonly log: { method: string; host: string }[] = [];

  constructor(private readonly auth: ProbeAuth, private readonly fetchImpl: ProbeFetch) {}

  /** The ONLY network primitive. GET only; https only; Twilio registration hosts only; no body. */
  private async get(rawUrl: string): Promise<Json> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ProbeError("refused", null, null, "malformed url");
    }
    if (url.protocol !== "https:" || !HOSTS.has(url.hostname)) throw new ProbeError("refused", null, null, "host not allowed for the read-only probe");
    this.log.push({ method: "GET", host: url.hostname });
    let status: number;
    let raw: string;
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: { Authorization: `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error", // a redirect would leave the host allow-list unchecked
      });
      status = response.status;
      raw = await response.text();
    } catch {
      throw new ProbeError("transient", null, null, "network failure or timeout");
    }
    let json: Json | null = null;
    try {
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : null;
    } catch {
      json = null;
    }
    if (status >= 200 && status < 300 && json) return json;
    const code = json && json.code !== undefined ? String(json.code) : null;
    // Twilio's free-text message is deliberately NOT carried: it can echo request fragments. Status and code are enough.
    const message = `http ${status}`;
    const kind = status === 401 || status === 403 ? "account" : status === 429 || status >= 500 || (status >= 200 && status < 300) ? "transient" : "validation";
    throw new ProbeError(kind, status, code, message);
  }

  private async listAll(firstUrl: string, host: string, key: "results" | "data" | "policies" | "end_users" | "entity_assignments"): Promise<{ rows: Json[]; truncated: boolean }> {
    const rows: Json[] = [];
    let url: string | null = firstUrl;
    for (let page = 0; page < MAX_PAGES && url; page += 1) {
      const json: Json = await this.get(url);
      const list = [json[key], json.results, json.data].find(Array.isArray) as Json[] | undefined;
      rows.push(...(list ?? []));
      const meta = (json.meta ?? {}) as Json;
      const next = str(meta.next_page_url);
      url = next && sameHost(next, host) ? next : null;
      if (next && !url) return { rows, truncated: true }; // an off-host next link is never followed; the list is incomplete
    }
    return { rows, truncated: Boolean(url) };
  }

  async account(accountSid: string): Promise<StageAReport["account"]> {
    const json = await this.get(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`);
    return { ok: true, status: str(json.status), type: str(json.type) };
  }

  async policies(configured: StageAInput["configuredPolicies"]): Promise<{ rows: PolicyRow[]; checks: StageAReport["configuredPolicyChecks"] }> {
    const { rows } = await this.listAll("https://trusthub.twilio.com/v1/Policies?PageSize=50", "https://trusthub.twilio.com", "results");
    const roles: [keyof NonNullable<StageAInput["configuredPolicies"]>, string][] = [["primary", "primary"], ["secondary", "secondary"], ["a2p", "a2p"]];
    const out: PolicyRow[] = rows.map((row) => ({
      sid: String(row.sid ?? ""),
      friendlyName: str(row.friendly_name),
      configuredAs: roles.filter(([key]) => configured?.[key] && configured[key] === row.sid).map(([, label]) => label),
    }));
    const checks: StageAReport["configuredPolicyChecks"] = {};
    for (const [key, label] of roles) {
      const value = configured?.[key];
      checks[label] = !value ? "not_configured" : out.some((row) => row.sid === value) ? "found" : "not_found";
    }
    return { rows: out, checks };
  }

  async primaryProfile(input: Pick<StageAInput, "primaryProfileSid" | "configuredPolicies" | "expectedLegalName" | "expectedEin">): Promise<PrimaryProfileReport> {
    const sid = input.primaryProfileSid;
    const profile = await this.get(`https://trusthub.twilio.com/v1/CustomerProfiles/${encodeURIComponent(sid)}`);
    const policySid = str(profile.policy_sid);
    const assignments = await this.listAll(`https://trusthub.twilio.com/v1/CustomerProfiles/${encodeURIComponent(sid)}/EntityAssignments?PageSize=50`, "https://trusthub.twilio.com", "results");
    const endUserSids = assignments.rows.map((row) => String(row.object_sid ?? "")).filter((value) => /^IT[0-9a-fA-F]{32}$/.test(value));
    let businessEndUser: PrimaryProfileReport["businessEndUser"] = null;
    const keys = new Set<string>();
    for (const endUserSid of endUserSids) {
      const endUser = await this.get(`https://trusthub.twilio.com/v1/EndUsers/${encodeURIComponent(endUserSid)}`);
      const attributes = (endUser.attributes ?? {}) as Json;
      Object.keys(attributes).forEach((key) => keys.add(key));
      const type = str(endUser.type);
      if (type !== "customer_profile_business_information" || businessEndUser) continue;
      const expectedName = input.expectedLegalName?.trim().toLowerCase();
      const expectedEin = input.expectedEin ? digitsOf(input.expectedEin) : "";
      const registration = digitsOf(attributes.business_registration_number);
      businessEndUser = {
        sid: endUserSid,
        type,
        businessName: str(attributes.business_name),
        businessType: str(attributes.business_type),
        businessIdentity: str(attributes.business_identity),
        industries: str(attributes.business_industry) ?? str(attributes.business_industries),
        registrationNumberType: str(attributes.business_registration_identifier),
        registrationNumberLast4: last4(attributes.business_registration_number),
        nameMatchesExpected: expectedName ? String(attributes.business_name ?? "").trim().toLowerCase() === expectedName : null,
        einMatchesExpected: expectedEin ? registration === expectedEin : null,
      };
    }
    return {
      sid,
      status: str(profile.status),
      policySid,
      policyMatchesConfigured: input.configuredPolicies?.primary ? input.configuredPolicies.primary === policySid : null,
      businessEndUser,
      endUserAttributeKeys: [...keys].sort(),
    };
  }

  async inventory(prefix: string): Promise<InventoryReport> {
    const tally = (rows: Json[], field: string) => rows.reduce<Record<string, number>>((acc, row) => {
      const key = String(row[field] ?? "unknown");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const profiles = await this.listAll("https://trusthub.twilio.com/v1/CustomerProfiles?PageSize=50", "https://trusthub.twilio.com", "results");
    const products = await this.listAll("https://trusthub.twilio.com/v1/TrustProducts?PageSize=50", "https://trusthub.twilio.com", "results");
    const brands = await this.listAll("https://messaging.twilio.com/v1/a2p/BrandRegistrations?PageSize=50", "https://messaging.twilio.com", "data");
    const starts = (rows: Json[]) => rows.filter((row) => String(row.friendly_name ?? "").startsWith(prefix)).length;
    return {
      customerProfiles: { total: profiles.rows.length, byStatus: tally(profiles.rows, "status"), truncated: profiles.truncated },
      trustProducts: { total: products.rows.length, byStatus: tally(products.rows, "status"), truncated: products.truncated },
      brands: {
        total: brands.rows.length, byStatus: tally(brands.rows, "status"), truncated: brands.truncated, sids: brands.rows.map((row) => String(row.sid ?? "")),
        // Stage C relies on Twilio echoing a boolean "mock" on brand records; existing brands show whether that field exists at all.
        withBooleanMockField: brands.rows.filter((row) => typeof row.mock === "boolean").length,
      },
      namedPrefixMatches: { prefix, customerProfiles: starts(profiles.rows), trustProducts: starts(products.rows) },
    };
  }

  /** The whole of Stage A. Each section is attempted independently so one failure does not hide the others. */
  async run(input: StageAInput): Promise<StageAReport> {
    const problems: string[] = [];
    const attempt = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        const e = error as ProbeError;
        problems.push(`${label}: ${e instanceof ProbeError ? `${e.kind}${e.status ? ` http ${e.status}` : ""}${e.code ? ` code ${e.code}` : ""}${e.status ? "" : ` - ${e.message}`}` : "unexpected error"}`);
        return fallback;
      }
    };
    const apiKey = input.authMethod === "api_key";
    let badCredentials = false;
    const rejectsCredentials = (error: unknown) => {
      if (error instanceof ProbeError && error.status === 401) badCredentials = true;
    };
    const noPolicies = { rows: [] as PolicyRow[], checks: {} as StageAReport["configuredPolicyChecks"] };
    // A Standard API key cannot read the Accounts resource: Twilio answers that call with 401 (code 70004/20003) even though the key is
    // fine. So with a key the account endpoint is NOT called, and the first Trust Hub read (the policy list, which a Standard key can
    // make) is the credential check instead. With the auth token the account call is a valid first check.
    const account: StageAReport["account"] = apiKey
      ? { ok: null, status: null, type: null, skipped: "Standard API keys cannot read /Accounts; credentials are checked by the Trust Hub reads instead" }
      : await attempt("account", async () => {
        try {
          return await this.account(input.accountSid);
        } catch (error) {
          rejectsCredentials(error);
          throw error;
        }
      }, { ok: false, status: null, type: null });
    // Only a 401 on a read that the credential type IS allowed to make means the credentials are rejected.
    const policies = badCredentials ? noPolicies : await attempt("policies", async () => {
      try {
        return await this.policies(input.configuredPolicies);
      } catch (error) {
        if (apiKey) rejectsCredentials(error);
        throw error;
      }
    }, noPolicies);
    const primary = badCredentials ? null : await attempt("primary_profile", () => this.primaryProfile(input), null);
    const inventory = badCredentials ? null : await attempt("inventory", () => this.inventory(input.friendlyNamePrefix ?? "df:"), null);
    const notRun: StageAReport["notRun"] = [];
    if (account.ok === null) notRun.push({ section: "account", reason: "Standard API keys cannot read /Accounts, so this check was not performed" });
    if (badCredentials) {
      // the policy read is the one that failed (listed under problems); the reads after it were not attempted
      for (const section of ["primary_profile", "inventory"]) notRun.push({ section, reason: "not performed because Twilio rejected the credentials" });
    }
    return {
      readOnly: true,
      requests: { count: this.log.length, methods: [...new Set(this.log.map((entry) => entry.method))], hosts: [...new Set(this.log.map((entry) => entry.host))].sort() },
      account,
      primary,
      policies: policies.rows,
      configuredPolicyChecks: policies.checks,
      notRun,
      inventory,
      problems,
    };
  }
}

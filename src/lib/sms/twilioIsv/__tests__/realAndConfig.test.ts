import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAdapterAllowed, isvEnvName, loadIsvConfig, realCallsAllowed, type IsvConfig } from "../config";
import { addressInput, businessEndUserAttributes, firstWizardField, representativeEndUserAttributes, safeField, stepFriendlyName, websiteUrl, type RunnerInputs } from "../payloads";
import { createRealIsvAdapter, RealIsvAdapter } from "../real";
import { IsvApiError } from "../types";

const config: IsvConfig = {
  accountSid: `AC${"1".repeat(32)}`, authToken: "secret-token-value", primaryProfileSid: `BU${"e".repeat(32)}`, primaryProfilePolicySid: `RN${"4".repeat(32)}`,
  secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms-compliance@isv.example", envName: "production", mockBrand: false,
};

type Recorded = { url: string; method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal };
function adapterWith(responses: { status: number; body: unknown }[]) {
  const calls: Recorded[] = [];
  const queue = [...responses];
  const adapter = new RealIsvAdapter(config, async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, signal: init.signal });
    const next = queue.shift() ?? { status: 200, body: {} };
    return { status: next.status, text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body)) };
  });
  return { adapter, calls };
}
const form = (call: Recorded) => Object.fromEntries(new URLSearchParams(call.body ?? ""));

describe("a mock run must never silently become a paid brand (review P2)", () => {
  const mockConfig = { ...config, mockBrand: true };
  const mockAdapter = (responses: { status: number; body: unknown }[]) => {
    const queue = [...responses];
    const calls: Recorded[] = [];
    const adapter = new RealIsvAdapter(mockConfig, async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body, signal: init.signal });
      const next = queue.shift() ?? { status: 200, body: {} };
      return { status: next.status, text: async () => JSON.stringify(next.body) };
    });
    return { adapter, calls };
  };
  const brandInput = { customerProfileSid: `BU${"a".repeat(32)}`, trustProductSid: `BU${"9".repeat(32)}`, brandType: "STANDARD" as const, skipAutomaticSecVet: false, mock: true };
  const sid = `BN${"1".repeat(32)}`;
  it("createBrand: Twilio must echo mock=true, otherwise the outcome is unknown (the brand exists) and the run stops", async () => {
    const ok = mockAdapter([{ status: 201, body: { sid, mock: true } }]);
    expect(await ok.adapter.createBrand(brandInput)).toBe(sid);
    for (const body of [{ sid }, { sid, mock: false }, { sid, mock: "true" }]) {
      const bad = mockAdapter([{ status: 201, body }]);
      expect(await bad.adapter.createBrand(brandInput).catch((e) => e)).toMatchObject({ kind: "transient" });
    }
  });
  it("findBrand and getBrandStatus refuse to treat a non-mock brand as the mock run's brand", async () => {
    const bu = `BU${"a".repeat(32)}`;
    const tp = `BU${"9".repeat(32)}`;
    const row = (mock: unknown) => ({ status: 200, body: { data: [{ sid, customer_profile_bundle_sid: bu, a2p_profile_bundle_sid: tp, ...(mock === undefined ? {} : { mock }) }], meta: {} } });
    expect(await mockAdapter([row(true)]).adapter.findBrand({ customerProfileSid: bu, trustProductSid: tp })).toEqual([sid]);
    for (const mock of [false, undefined]) {
      expect(await mockAdapter([row(mock)]).adapter.findBrand({ customerProfileSid: bu, trustProductSid: tp }).catch((e) => e)).toMatchObject({ kind: "transient" });
    }
    expect(await mockAdapter([{ status: 200, body: { status: "IN_REVIEW", mock: true } }]).adapter.getBrandStatus(sid)).toBe("IN_REVIEW");
    expect(await mockAdapter([{ status: 200, body: { status: "IN_REVIEW" } }]).adapter.getBrandStatus(sid).catch((e) => e)).toMatchObject({ kind: "transient" });
  });
  it("a non-mock configuration is unaffected", async () => {
    const plain = adapterWith([{ status: 200, body: { status: "APPROVED" } }]);
    expect(await plain.adapter.getBrandStatus(sid)).toBe("APPROVED");
  });
});

describe("Standard API key authentication for the registration APIs (decision D1)", () => {
  const KEY_SID = `SK${"3".repeat(32)}`;
  const KEY_SECRET = "k".repeat(32);
  const base: Record<string, string> = {
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`, TWILIO_ISV_PRIMARY_PROFILE_SID: `BU${"e".repeat(32)}`, TWILIO_ISV_PRIMARY_POLICY_SID: `RN${"4".repeat(32)}`,
    TWILIO_ISV_SECONDARY_POLICY_SID: `RN${"2".repeat(32)}`, TWILIO_ISV_A2P_POLICY_SID: `RN${"3".repeat(32)}`, TWILIO_ISV_COMPLIANCE_EMAIL: "compliance@example.test",
  };
  const basic = (pair: string) => `Basic ${Buffer.from(pair).toString("base64")}`;

  it("config: a key (both variables) loads WITHOUT reading TWILIO_AUTH_TOKEN, even when the token is present in the environment", () => {
    const loaded = loadIsvConfig({ ...base, TWILIO_ISV_API_KEY_SID: KEY_SID, TWILIO_ISV_API_KEY_SECRET: KEY_SECRET, TWILIO_AUTH_TOKEN: "ambient-token" });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config).toMatchObject({ apiKeySid: KEY_SID, apiKeySecret: KEY_SECRET, authToken: "" });
    expect(JSON.stringify(loaded.config)).not.toContain("ambient-token");
  });
  it("config: a key needs no TWILIO_AUTH_TOKEN at all; without a key the original token behavior is unchanged (production)", () => {
    expect(loadIsvConfig({ ...base, TWILIO_ISV_API_KEY_SID: KEY_SID, TWILIO_ISV_API_KEY_SECRET: KEY_SECRET }).ok).toBe(true);
    const token = loadIsvConfig({ ...base, TWILIO_AUTH_TOKEN: "t".repeat(32) });
    expect(token.ok && token.config).toMatchObject({ authToken: "t".repeat(32) });
    expect(token.ok && token.config.apiKeySid).toBeUndefined();
    expect(loadIsvConfig({ ...base })).toMatchObject({ ok: false, missing: ["TWILIO_AUTH_TOKEN"] });
  });
  it("config: a half-configured or malformed key is reported by NAME and never silently replaced by the token", () => {
    const withToken = { ...base, TWILIO_AUTH_TOKEN: "t".repeat(32) };
    expect(loadIsvConfig({ ...withToken, TWILIO_ISV_API_KEY_SID: KEY_SID })).toMatchObject({ ok: false, missing: ["TWILIO_ISV_API_KEY_SECRET"] });
    expect(loadIsvConfig({ ...withToken, TWILIO_ISV_API_KEY_SECRET: KEY_SECRET })).toMatchObject({ ok: false, missing: ["TWILIO_ISV_API_KEY_SID"] });
    expect(loadIsvConfig({ ...withToken, TWILIO_ISV_API_KEY_SID: `AC${"3".repeat(32)}`, TWILIO_ISV_API_KEY_SECRET: KEY_SECRET })).toMatchObject({ ok: false, missing: ["TWILIO_ISV_API_KEY_SID"] });
    expect(loadIsvConfig({ ...withToken, TWILIO_ISV_API_KEY_SID: KEY_SID, TWILIO_ISV_API_KEY_SECRET: "short" })).toMatchObject({ ok: false, missing: ["TWILIO_ISV_API_KEY_SECRET"] });
  });
  it("adapter: every request is signed with the key SID and secret (never the account SID or token), for reads and for writes", async () => {
    const calls: Recorded[] = [];
    const keyed = new RealIsvAdapter({ ...config, authToken: "", apiKeySid: KEY_SID, apiKeySecret: KEY_SECRET }, async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body, signal: init.signal });
      const sid = url.includes("Addresses.json") ? `AD${"a".repeat(32)}` : `BU${"a".repeat(32)}`;
      return { status: 201, text: async () => JSON.stringify({ sid, status: "draft" }) };
    });
    await keyed.getCustomerProfile(`BU${"e".repeat(32)}`);
    await keyed.createCustomerProfile({ friendlyName: "df:test:x:S1:1", email: "a@b.example" });
    await keyed.createAddress({ customerName: "A", street: "1 St", streetSecondary: "", city: "C", region: "OR", postalCode: "97201", isoCountry: "US" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
    for (const call of calls) expect(call.headers.Authorization).toBe(basic(`${KEY_SID}:${KEY_SECRET}`));
    expect(calls[2].url).toContain(`/Accounts/${config.accountSid}/Addresses.json`); // the Account SID is still the URL path, not the credential
  });
  it("NO FALLBACK: a rejected key produces ONE request and an error; the auth token is never tried, even when a token value exists", async () => {
    const calls: Recorded[] = [];
    const rejecting = new RealIsvAdapter({ ...config, authToken: "must-never-be-used", apiKeySid: KEY_SID, apiKeySecret: KEY_SECRET }, async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body, signal: init.signal });
      return { status: 401, text: async () => JSON.stringify({ code: 20003, message: "Permission Denied" }) };
    });
    const error = await rejecting.createCustomerProfile({ friendlyName: "df:test:x:S1:1", email: "a@b.example" }).catch((e) => e);
    expect(error).toMatchObject({ kind: "account", httpStatus: 401 });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe(basic(`${KEY_SID}:${KEY_SECRET}`));
    expect(JSON.stringify(calls)).not.toContain(Buffer.from(`${config.accountSid}:must-never-be-used`).toString("base64"));
    expect(String((error as Error).message)).not.toContain("must-never-be-used");
  });
  it("a key SID without its secret fails closed at construction (no request is ever signed with an empty password)", () => {
    const noFetch = async () => {
      throw new Error("must not be called");
    };
    expect(() => new RealIsvAdapter({ ...config, authToken: "", apiKeySid: KEY_SID }, noFetch)).toThrow("without its secret");
    expect(() => new RealIsvAdapter({ ...config, authToken: "", apiKeySid: KEY_SID, apiKeySecret: "" }, noFetch)).toThrow("without its secret");
    expect(() => new RealIsvAdapter({ ...config, authToken: "", apiKeySid: KEY_SID, apiKeySecret: KEY_SECRET }, noFetch)).not.toThrow();
    expect(() => new RealIsvAdapter(config, noFetch)).not.toThrow(); // token-only configuration (production) is unaffected
  });
  it("production behavior is unchanged: without a key the header is account SID + auth token", async () => {
    const plain = adapterWith([{ status: 200, body: { status: "twilio-approved", policy_sid: "RN" } }]);
    await plain.adapter.getCustomerProfile(`BU${"e".repeat(32)}`);
    expect(plain.calls[0].headers.Authorization).toBe(basic(`${config.accountSid}:${config.authToken}`));
  });
});

describe("the real-calls gate", () => {
  it("is closed everywhere except production with the explicit switch", () => {
    expect(realCallsAllowed({ VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on" })).toEqual({ allowed: true });
    for (const env of [
      {}, { TW4_ISV_REAL_CALLS: "on" }, { VERCEL_ENV: "production", NODE_ENV: "production" }, { VERCEL_ENV: "preview", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on" },
      { NODE_ENV: "development", TW4_ISV_REAL_CALLS: "on" }, { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "true" }, { NODE_ENV: "test", TW4_ISV_REAL_CALLS: "on" },
      // a local `next dev` with production variables pulled from Vercel
      { VERCEL_ENV: "production", NODE_ENV: "development", TW4_ISV_REAL_CALLS: "on" },
      { VERCEL_ENV: "production", TW4_ISV_REAL_CALLS: "on" },
    ]) expect(realCallsAllowed(env).allowed).toBe(false);
  });
  it("the real adapter cannot even be constructed when the gate is closed", () => {
    expect(() => createRealIsvAdapter(config, { VERCEL_ENV: "preview", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on" })).toThrow(IsvApiError);
    expect(() => createRealIsvAdapter(config, {})).toThrow(IsvApiError);
    expect(createRealIsvAdapter(config, { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on" }, async () => ({ status: 200, text: async () => "{}" }))).toBeInstanceOf(RealIsvAdapter);
  });
  it("the fake adapter is never allowed in production, and only against a LOCAL database (it writes fake SIDs into the ledger)", () => {
    const local = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
    expect(fakeAdapterAllowed({ ...local, VERCEL_ENV: "production", TW4_ISV_FAKE: "on" })).toBe(false);
    expect(fakeAdapterAllowed({ ...local, VERCEL_ENV: "preview", TW4_ISV_FAKE: "on" })).toBe(true);
    expect(fakeAdapterAllowed({ ...local, VERCEL_ENV: "preview" })).toBe(false);
    expect(fakeAdapterAllowed({ NEXT_PUBLIC_SUPABASE_URL: "https://epdrtzcydvnoidwrepqz.supabase.co", VERCEL_ENV: "preview", TW4_ISV_FAKE: "on" })).toBe(false);
    expect(fakeAdapterAllowed({ VERCEL_ENV: "preview", TW4_ISV_FAKE: "on" })).toBe(false);
    expect(fakeAdapterAllowed({ NEXT_PUBLIC_SUPABASE_URL: "not a url", TW4_ISV_FAKE: "on" })).toBe(false);
  });
  it("environment names", () => {
    expect(isvEnvName({ VERCEL_ENV: "production" })).toBe("production");
    expect(isvEnvName({ VERCEL_ENV: "preview" })).toBe("preview");
    expect(isvEnvName({ NODE_ENV: "test" })).toBe("test");
    expect(isvEnvName({})).toBe("development");
  });
});

describe("configuration", () => {
  const full = {
    TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`, TWILIO_AUTH_TOKEN: "tok", TWILIO_ISV_PRIMARY_PROFILE_SID: `BU${"e".repeat(32)}`,
    TWILIO_ISV_PRIMARY_POLICY_SID: `RN${"4".repeat(32)}`,
    TWILIO_ISV_SECONDARY_POLICY_SID: `RN${"2".repeat(32)}`, TWILIO_ISV_A2P_POLICY_SID: `RN${"3".repeat(32)}`, TWILIO_ISV_COMPLIANCE_EMAIL: "sms-compliance@isv.example",
  };
  it("loads a complete configuration and defaults the mock brand to off", () => {
    const result = loadIsvConfig(full);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.mockBrand).toBe(false);
    const mock = loadIsvConfig({ ...full, TW4_ISV_MOCK_BRAND: "on" });
    if (mock.ok) expect(mock.config.mockBrand).toBe(true);
  });
  it("reports only the NAMES of missing or malformed variables, never values", () => {
    const result = loadIsvConfig({ ...full, TWILIO_AUTH_TOKEN: "", TWILIO_ISV_PRIMARY_PROFILE_SID: "not-a-sid", TWILIO_ISV_COMPLIANCE_EMAIL: "bad" });
    expect(result).toEqual({ ok: false, missing: ["TWILIO_AUTH_TOKEN", "TWILIO_ISV_PRIMARY_PROFILE_SID", "TWILIO_ISV_COMPLIANCE_EMAIL"] });
    expect(JSON.stringify(result)).not.toContain("not-a-sid");
  });
  it("the policy SIDs and the Primary profile are REQUIRED configuration: nothing in code hard-codes a Twilio policy SID", () => {
    expect(loadIsvConfig({}).ok).toBe(false);
    const source = readFileSync(join(__dirname, "..", "real.ts"), "utf8") + readFileSync(join(__dirname, "..", "runner.ts"), "utf8") + readFileSync(join(__dirname, "..", "payloads.ts"), "utf8");
    expect(source).not.toMatch(/\bRN[0-9a-f]{32}\b/i);
    expect(source).not.toMatch(/\bBU[0-9a-f]{32}\b/i);
  });
});

describe("the real adapter's request shapes (injected fetch, no network)", () => {
  it("authenticates with HTTP Basic and posts form-encoded bodies", async () => {
    const { adapter, calls } = adapterWith([{ status: 201, body: { sid: `BU${"a".repeat(32)}` } }]);
    await adapter.createCustomerProfile({ friendlyName: "df:production:s:S1:1", email: "sms-compliance@isv.example" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://trusthub.twilio.com/v1/CustomerProfiles");
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`);
    expect(calls[0].headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(form(calls[0])).toEqual({ FriendlyName: "df:production:s:S1:1", Email: "sms-compliance@isv.example", PolicySid: config.secondaryProfilePolicySid });
  });
  it("end users carry JSON attributes; supporting documents reference the address", async () => {
    const { adapter, calls } = adapterWith([{ status: 201, body: { sid: `IT${"b".repeat(32)}` } }, { status: 201, body: { sid: `RD${"c".repeat(32)}` } }]);
    await adapter.createEndUser({ friendlyName: "f", type: "authorized_representative_1", attributes: { first_name: "Pat" } });
    await adapter.createSupportingDocument({ friendlyName: "d", addressSid: `AD${"d".repeat(32)}` });
    expect(form(calls[0])).toMatchObject({ Type: "authorized_representative_1", Attributes: JSON.stringify({ first_name: "Pat" }) });
    expect(calls[1].url).toBe("https://trusthub.twilio.com/v1/SupportingDocuments");
    expect(form(calls[1])).toMatchObject({ Type: "customer_profile_address", Attributes: JSON.stringify({ address_sids: `AD${"d".repeat(32)}` }) });
  });
  it("addresses go to the 2010 API under the account, assignments to EntityAssignments, evaluations with the right policy", async () => {
    const { adapter, calls } = adapterWith([
      { status: 201, body: { sid: `AD${"d".repeat(32)}` } }, { status: 201, body: { sid: `BV${"e".repeat(32)}` } },
      { status: 201, body: { sid: `EL${"f".repeat(32)}`, status: "compliant" } }, { status: 201, body: { sid: `EL${"f".repeat(32)}`, status: "compliant" } },
    ]);
    await adapter.createAddress({ customerName: "N", street: "1 A St", streetSecondary: "", city: "C", region: "OR", postalCode: "97201", isoCountry: "US" });
    await adapter.assignToCustomerProfile(`BU${"a".repeat(32)}`, `IT${"b".repeat(32)}`);
    await adapter.evaluateCustomerProfile(`BU${"a".repeat(32)}`);
    await adapter.evaluateTrustProduct(`BU${"9".repeat(32)}`);
    expect(calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Addresses.json`);
    expect(form(calls[0])).not.toHaveProperty("StreetSecondary");
    expect(calls[1].url).toBe(`https://trusthub.twilio.com/v1/CustomerProfiles/BU${"a".repeat(32)}/EntityAssignments`);
    expect(form(calls[1])).toEqual({ ObjectSid: `IT${"b".repeat(32)}` });
    expect(form(calls[2])).toEqual({ PolicySid: config.secondaryProfilePolicySid });
    expect(form(calls[3])).toEqual({ PolicySid: config.a2pPolicySid });
  });
  it("submission is a status update to pending-review", async () => {
    const { adapter, calls } = adapterWith([{ status: 200, body: { sid: `BU${"a".repeat(32)}` } }, { status: 200, body: { sid: `BU${"9".repeat(32)}` } }]);
    await adapter.submitCustomerProfile(`BU${"a".repeat(32)}`);
    await adapter.submitTrustProduct(`BU${"9".repeat(32)}`);
    expect(form(calls[0])).toEqual({ Status: "pending-review" });
    expect(calls[1].url).toBe(`https://trusthub.twilio.com/v1/TrustProducts/BU${"9".repeat(32)}`);
  });
  it("the brand request: STANDARD, vetting left on by default, mock only when asked", async () => {
    const { adapter, calls } = adapterWith([{ status: 201, body: { sid: `BN${"1".repeat(32)}` } }, { status: 201, body: { sid: `BN${"2".repeat(32)}`, mock: true } }]);
    await adapter.createBrand({ customerProfileSid: `BU${"a".repeat(32)}`, trustProductSid: `BU${"9".repeat(32)}`, brandType: "STANDARD", skipAutomaticSecVet: false, mock: false });
    await adapter.createBrand({ customerProfileSid: `BU${"a".repeat(32)}`, trustProductSid: `BU${"9".repeat(32)}`, brandType: "STANDARD", skipAutomaticSecVet: false, mock: true });
    expect(calls[0].url).toBe("https://messaging.twilio.com/v1/a2p/BrandRegistrations");
    expect(form(calls[0])).toEqual({ CustomerProfileBundleSid: `BU${"a".repeat(32)}`, A2PProfileBundleSid: `BU${"9".repeat(32)}`, BrandType: "STANDARD" });
    expect(form(calls[1]).Mock).toBe("true");
    expect(form(calls[0])).not.toHaveProperty("SkipAutomaticSecVet");
  });
  it("friendly-name lookups only return exact matches; brand lookup follows pages and matches both bundle sids", async () => {
    const bu = `BU${"a".repeat(32)}`;
    const tp = `BU${"9".repeat(32)}`;
    const { adapter } = adapterWith([
      { status: 200, body: { results: [{ sid: `BU${"1".repeat(32)}`, friendly_name: "x" }, { sid: `BU${"2".repeat(32)}`, friendly_name: "target" }] } },
      { status: 200, body: { data: [{ sid: `BN${"1".repeat(32)}`, customer_profile_bundle_sid: bu, a2p_profile_bundle_sid: `BU${"0".repeat(32)}` }], meta: { next_page_url: "https://messaging.twilio.com/v1/a2p/BrandRegistrations?Page=1" } } },
      { status: 200, body: { data: [{ sid: `BN${"2".repeat(32)}`, customer_profile_bundle_sid: bu, a2p_profile_bundle_sid: tp }], meta: {} } },
    ]);
    expect(await adapter.findCustomerProfile("target")).toEqual([`BU${"2".repeat(32)}`]);
    expect(await adapter.findBrand({ customerProfileSid: bu, trustProductSid: tp })).toEqual([`BN${"2".repeat(32)}`]);
  });
  it("evaluation results keep the names of failed Twilio fields and never their values", async () => {
    const { adapter } = adapterWith([{ status: 201, body: { sid: `EL${"f".repeat(32)}`, status: "noncompliant", results: [{ fields: [{ object_field: "email", passed: false, failure_reason: "bad@example.test is invalid" }, { object_field: "first_name", passed: true }] }] } }]);
    const { result } = await adapter.evaluateCustomerProfile(`BU${"a".repeat(32)}`);
    expect(result).toEqual({ status: "noncompliant", failedFields: ["email"] });
    expect(JSON.stringify(result)).not.toContain("bad@example.test");
  });
  it("classifies failures: 4xx validation, 401/403 account, 429/5xx/network transient; messages never echo request data", async () => {
    const kinds: [number, string][] = [[400, "validation"], [404, "validation"], [401, "account"], [403, "account"], [429, "transient"], [503, "transient"]];
    for (const [status, kind] of kinds) {
      const { adapter } = adapterWith([{ status, body: { code: 20001, message: "Invalid value" } }]);
      const error = await adapter.createEndUser({ friendlyName: "f", type: "customer_profile_business_information", attributes: { business_registration_number: "987654321" } }).catch((e) => e);
      expect(error).toBeInstanceOf(IsvApiError);
      expect(error.kind).toBe(kind);
      expect(String(error.message)).not.toContain("987654321");
    }
    const network = new RealIsvAdapter(config, async () => { throw new Error("socket hang up with token secret-token-value"); });
    const error = await network.getBrandStatus(`BN${"1".repeat(32)}`).catch((e) => e);
    expect(error).toMatchObject({ kind: "transient" });
    expect(String(error.message)).not.toContain("secret-token-value");
  });
  it("a 2xx response without a valid SID is not a success and not a clean failure either: the resource may exist (transient = unknown outcome)", async () => {
    const { adapter } = adapterWith([{ status: 201, body: { sid: "garbage" } }]);
    const error = await adapter.createCustomerProfile({ friendlyName: "f", email: "e@x.test" }).catch((e) => e);
    expect(error).toBeInstanceOf(IsvApiError);
    expect(error.kind).toBe("transient");
  });
  it("a success status with an unreadable body, and a body that cannot be read at all, are unknown outcomes, never definite failures", async () => {
    const unreadable = adapterWith([{ status: 201, body: "<html>cut off" }]);
    const first = await unreadable.adapter.createBrand({ customerProfileSid: `BU${"a".repeat(32)}`, trustProductSid: `BU${"9".repeat(32)}`, brandType: "STANDARD", skipAutomaticSecVet: false, mock: false }).catch((e) => e);
    expect(first).toMatchObject({ kind: "transient", httpStatus: 201 });
    const broken = new RealIsvAdapter(config, async () => ({ status: 201, text: async () => { throw new Error("stream reset"); } }));
    const second = await broken.createBrand({ customerProfileSid: `BU${"a".repeat(32)}`, trustProductSid: `BU${"9".repeat(32)}`, brandType: "STANDARD", skipAutomaticSecVet: false, mock: false }).catch((e) => e);
    expect(second).toMatchObject({ kind: "transient" });
  });
  it("an error status with a non-JSON body is still classified by its status (5xx unknown, 4xx definite)", async () => {
    const serverError = adapterWith([{ status: 502, body: "<html>bad gateway</html>" }]);
    expect(await serverError.adapter.getBrandStatus(`BN${"1".repeat(32)}`).catch((e) => e)).toMatchObject({ kind: "transient", httpStatus: 502 });
    const notFound = adapterWith([{ status: 404, body: "<html>not found</html>" }]);
    expect(await notFound.adapter.getBrandStatus(`BN${"1".repeat(32)}`).catch((e) => e)).toMatchObject({ kind: "validation", httpStatus: 404 });
  });
  it("every request carries a timeout signal, so a hung call cannot outlive the runner's lease", async () => {
    const { adapter, calls } = adapterWith([{ status: 200, body: { status: "APPROVED" } }]);
    await adapter.getBrandStatus(`BN${"1".repeat(32)}`);
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });
  it("profile lookups follow Twilio's own next-page links (same host only) so an existing resource beyond page one is still found", async () => {
    const { adapter, calls } = adapterWith([
      { status: 200, body: { results: [{ sid: `BU${"1".repeat(32)}`, friendly_name: "other" }], meta: { next_page_url: "https://trusthub.twilio.com/v1/CustomerProfiles?Page=1" } } },
      { status: 200, body: { results: [{ sid: `BU${"2".repeat(32)}`, friendly_name: "target" }], meta: { next_page_url: "https://evil.example/steal" } } },
    ]);
    expect(await adapter.findCustomerProfile("target")).toEqual([`BU${"2".repeat(32)}`]);
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["trusthub.twilio.com", "trusthub.twilio.com"]);
  });
  it("a lookup that stops with pages still unread is an UNKNOWN outcome, never 'nothing found' (a missed brand would be created twice)", async () => {
    const page = (n: number) => ({ status: 200, body: { data: [{ sid: `BN${String(n).padStart(32, "0")}`, customer_profile_bundle_sid: "x", a2p_profile_bundle_sid: "y" }], meta: { next_page_url: `https://messaging.twilio.com/v1/a2p/BrandRegistrations?Page=${n + 1}` } } });
    const { adapter, calls } = adapterWith(Array.from({ length: 10 }, (_, i) => page(i)));
    const error = await adapter.findBrand({ customerProfileSid: `BU${"a".repeat(32)}`, trustProductSid: `BU${"9".repeat(32)}` }).catch((e) => e);
    expect(error).toMatchObject({ kind: "transient" });
    expect(calls).toHaveLength(10);
    const profiles = adapterWith(Array.from({ length: 10 }, (_, i) => ({ status: 200, body: { results: [], meta: { next_page_url: `https://trusthub.twilio.com/v1/CustomerProfiles?Page=${i + 1}` } } })));
    expect(await profiles.adapter.findCustomerProfile("target").catch((e) => e)).toMatchObject({ kind: "transient" });
  });
  it("a lookup that reads its last page (no next link) within the limit is complete and returns normally", async () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ status: 200, body: { data: [], meta: i < 9 ? { next_page_url: `https://messaging.twilio.com/v1/a2p/BrandRegistrations?Page=${i + 1}` } : {} } }));
    const { adapter, calls } = adapterWith(pages);
    expect(await adapter.findBrand({ customerProfileSid: `BU${"a".repeat(32)}`, trustProductSid: `BU${"9".repeat(32)}` })).toEqual([]);
    expect(calls).toHaveLength(10);
  });
  it("the Primary profile lookup returns its status and policy", async () => {
    const { adapter } = adapterWith([{ status: 200, body: { status: "twilio-approved", policy_sid: `RN${"4".repeat(32)}` } }]);
    expect(await adapter.getCustomerProfile(`BU${"e".repeat(32)}`)).toEqual({ status: "twilio-approved", policySid: `RN${"4".repeat(32)}` });
  });
});

describe("payload mapping", () => {
  const inputs: RunnerInputs = {
    studio_id: "s", submission_seq: 1, state: "submitted_for_checks", studio_name: "S", studio_slug: "confidance-studio", studio_public_name: null,
    legal_name: "ConfiDance Test LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: null,
    address_line1: "12 Harbor Way", address_line2: "Suite 4", city: "Portland", region: "OR", postal_code: "97201", country: "US",
    rep_first_name: "Pat", rep_last_name: "Morgan", rep_title: "Owner", rep_position: "gm", rep_email: "pat@x.test", rep_phone: "+15035550123", preferred_area_code: "503", ein_last4: "4321", missing: [],
  };
  it("builds the business, representative and address payloads from the draft", () => {
    expect(businessEndUserAttributes(inputs, "987654321")).toEqual({
      type: "customer_profile_business_information",
      attributes: {
        business_identity: "direct_customer", business_industry: "EDUCATION", business_name: "ConfiDance Test LLC", business_regions_of_operation: "USA_AND_CANADA",
        business_registration_identifier: "EIN", business_registration_number: "987654321", business_type: "Limited Liability Corporation",
        website_url: "https://www.idanceflow.com/studios/confidance-studio",
      },
    });
    expect(representativeEndUserAttributes(inputs).attributes).toMatchObject({ job_position: "GM", email: "pat@x.test", first_name: "Pat" });
    expect(addressInput(inputs)).toEqual({ customerName: "ConfiDance Test LLC", street: "12 Harbor Way", streetSecondary: "Suite 4", city: "Portland", region: "OR", postalCode: "97201", isoCountry: "US" });
  });
  it("uses the studio's own website only when the owner chose it, and requires it then", () => {
    expect(websiteUrl({ ...inputs, website_choice: "own", website_url: "https://www.confidance.example" })).toBe("https://www.confidance.example");
    expect(() => websiteUrl({ ...inputs, website_choice: "own", website_url: null })).toThrow();
  });
  it("the field maps agree with the database's accepted highlight fields", () => {
    expect(firstWizardField(["nothing", "email", "business_name"])).toBe("rep_email");
    expect(firstWizardField(["nothing"])).toBeNull();
    expect(safeField("rep_email")).toBe("rep_email");
    expect(safeField("studio_slug")).toBeNull();
    expect(safeField(null)).toBeNull();
  });
  it("friendly names are deterministic and bounded", () => {
    expect(stepFriendlyName("production", "s1", "S1", 2)).toBe("df:production:s1:S1:2");
    expect(stepFriendlyName("production", "x".repeat(300), "S1", 2).length).toBe(128);
  });
});

describe("only real.ts can reach Twilio", () => {
  const dir = join(__dirname, "..");
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts") && statSync(join(dir, name)).isFile());
  it("covers the slice's files", () => expect(files.sort()).toEqual(["account.ts", "config.ts", "creditStore.ts", "entityStore.ts", "errorCatalog.ts", "factory.ts", "fake.ts", "loopback.ts", "outcomes.ts", "payloads.ts", "real.ts", "runner.ts", "store.ts", "subaccount.ts", "types.ts"]));
  it.each(files.filter((name) => name !== "real.ts"))("%s has no network call, Twilio host or credential read", (name) => {
    const code = readFileSync(join(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/twilio\.com|trusthub|from "twilio"|require\("twilio"\)/i);
    expect(code).not.toMatch(/TWILIO_AUTH_TOKEN\]|process\.env\.TWILIO/);
  });
  it("the runner never imports the real adapter", () => {
    expect(readFileSync(join(dir, "runner.ts"), "utf8")).not.toMatch(/from "\.\/real"/);
  });
  it("the runner has no SMS, Messaging Service, campaign or number code", () => {
    const code = readFileSync(join(dir, "runner.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/messages\.create|sendTwilioSms|MessagingService|Usa2p|IncomingPhoneNumbers|AvailablePhoneNumbers|createCampaign|purchaseNumber/i);
  });
});

describe("real adapter evaluation parsing fails closed", () => {
  const profile = `BU${"a".repeat(32)}`;
  const evaluate = async (body: unknown) => (await adapterWith([{ status: 201, body }]).adapter.evaluateCustomerProfile(profile)).result;
  const sid = `EL${"f".repeat(32)}`;
  it("explicit compliant with no failing field is compliant", async () => {
    expect(await evaluate({ sid, status: "compliant", results: [{ fields: [{ object_field: "email", passed: true }] }] })).toEqual({ status: "compliant", failedFields: [] });
  });
  it("explicit noncompliant keeps failing field names, and with none named stays noncompliant (never compliant)", async () => {
    expect(await evaluate({ sid, status: "noncompliant", results: [{ fields: [{ object_field: "email", passed: false }] }] })).toEqual({ status: "noncompliant", failedFields: ["email"] });
    expect(await evaluate({ sid, status: "noncompliant", results: [] })).toEqual({ status: "noncompliant", failedFields: [] });
    expect(await evaluate({ sid, status: "noncompliant" })).toEqual({ status: "noncompliant", failedFields: [] });
  });
  it("missing, malformed, unknown, wrong-case or contradictory statuses are unrecognized", async () => {
    for (const body of [
      { sid }, { sid, status: null }, { sid, status: "" }, { sid, status: "Compliant" }, { sid, status: "COMPLIANT" }, { sid, status: 1 }, { sid, status: { a: 1 } },
      { sid, status: "pending" }, { sid, status: "compliant", results: [{ fields: [{ object_field: "email", passed: false }] }] },
    ]) {
      expect((await evaluate(body)).status, JSON.stringify(body)).toBe("unrecognized");
    }
  });
  it("a reply without an evaluation SID is an error, not an evaluation", async () => {
    await expect(adapterWith([{ status: 201, body: { status: "compliant" } }]).adapter.evaluateCustomerProfile(profile)).rejects.toBeInstanceOf(IsvApiError);
  });
});

describe("real adapter: read-only trust product status", () => {
  const sid = `BU${"9".repeat(32)}`;
  it("GETs the trust product and returns its status text, sending no body", async () => {
    const { adapter, calls } = adapterWith([{ status: 200, body: { sid, status: "twilio-approved", email: "x@example.test" } }]);
    expect(await adapter.getTrustProductStatus(sid)).toEqual({ status: "twilio-approved" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`https://trusthub.twilio.com/v1/TrustProducts/${sid}`);
    expect(calls[0].body).toBeUndefined();
  });
  it("a reply without a status is reported as unknown, not as approved", async () => {
    const { adapter } = adapterWith([{ status: 200, body: { sid } }]);
    expect((await adapter.getTrustProductStatus(sid)).status).toBe("unknown");
  });
});

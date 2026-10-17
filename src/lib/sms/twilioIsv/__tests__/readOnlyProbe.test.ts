import { describe, expect, it } from "vitest";
import { ReadOnlyProbe, type ProbeFetch } from "../validation/probe";

const ACCOUNT = `AC${"1".repeat(32)}`;
const PRIMARY = `BU${"e".repeat(32)}`;
const ENDUSER = `IT${"a".repeat(32)}`;
const REP = `IT${"b".repeat(32)}`;
const POLICY_P = `RN${"4".repeat(32)}`;
const POLICY_S = `RN${"2".repeat(32)}`;
const POLICY_A = `RN${"3".repeat(32)}`;
const TOKEN = "super-secret-token-value";
const EIN = "12-3456789";

type Call = { url: string; method: string; headers: Record<string, string>; hasBody: boolean };

function fakeTwilio(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const calls: Call[] = [];
  const routes: Record<string, { status: number; body: unknown }> = {
    [`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}.json`]: { status: 200, body: { status: "active", type: "Full", friendly_name: "GenX" } },
    [`https://trusthub.twilio.com/v1/CustomerProfiles/${PRIMARY}`]: { status: 200, body: { sid: PRIMARY, status: "twilio-approved", policy_sid: POLICY_P } },
    [`https://trusthub.twilio.com/v1/CustomerProfiles/${PRIMARY}/EntityAssignments?PageSize=50`]: {
      status: 200, body: { results: [{ object_sid: ENDUSER }, { object_sid: REP }, { object_sid: `RD${"c".repeat(32)}` }], meta: {} },
    },
    [`https://trusthub.twilio.com/v1/EndUsers/${ENDUSER}`]: {
      status: 200,
      body: { sid: ENDUSER, type: "customer_profile_business_information", attributes: { business_name: "GenX TotalTech LLC", business_type: "Limited Liability Company", business_identity: "isv_reseller_or_partner", business_industry: "TECHNOLOGY", business_registration_identifier: "EIN", business_registration_number: "123456789" } },
    },
    [`https://trusthub.twilio.com/v1/EndUsers/${REP}`]: { status: 200, body: { sid: REP, type: "authorized_representative_1", attributes: { first_name: "Mike", email: "rep@example.com", phone_number: "+15035550100" } } },
    ["https://trusthub.twilio.com/v1/Policies?PageSize=50"]: {
      status: 200, body: { results: [{ sid: POLICY_P, friendly_name: "Primary Customer Profile of type ISV" }, { sid: POLICY_S, friendly_name: "Secondary Customer Profile" }, { sid: POLICY_A, friendly_name: "A2P Messaging Profile Standard Brand" }], meta: {} },
    },
    ["https://trusthub.twilio.com/v1/CustomerProfiles?PageSize=50"]: { status: 200, body: { results: [{ sid: PRIMARY, status: "twilio-approved", friendly_name: "GenX TotalTech LLC" }], meta: {} } },
    ["https://trusthub.twilio.com/v1/TrustProducts?PageSize=50"]: { status: 200, body: { results: [{ sid: `BU${"7".repeat(32)}`, status: "twilio-approved", friendly_name: "old" }], meta: {} } },
    ["https://messaging.twilio.com/v1/a2p/BrandRegistrations?PageSize=50"]: { status: 200, body: { data: [{ sid: `BN${"9".repeat(32)}`, status: "APPROVED" }], meta: {} } },
    ...overrides,
  };
  const fetchImpl: ProbeFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, hasBody: "body" in init });
    const hit = routes[url];
    if (!hit) return { status: 404, text: async () => JSON.stringify({ code: 20404, message: "not found" }) };
    return { status: hit.status, text: async () => JSON.stringify(hit.body) };
  };
  return { fetchImpl, calls };
}

const input = {
  accountSid: ACCOUNT, authMethod: "auth_token" as const, primaryProfileSid: PRIMARY, configuredPolicies: { primary: POLICY_P, secondary: POLICY_S, a2p: POLICY_A },
  expectedLegalName: "genx totaltech llc", expectedEin: EIN,
};

describe("Stage A read-only probe", () => {
  it("issues GET requests only, to Twilio registration hosts only, with no request body", async () => {
    const { fetchImpl, calls } = fakeTwilio();
    const report = await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).run(input);
    expect(calls.length).toBeGreaterThan(8);
    expect(calls.every((call) => call.method === "GET" && !call.hasBody)).toBe(true);
    expect(calls.every((call) => /^https:\/\/(trusthub|messaging|api)\.twilio\.com\//.test(call.url))).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.requests).toMatchObject({ count: calls.length, methods: ["GET"] });
    expect(report.problems).toEqual([]);
  });

  it("reports the account, the Primary profile, the policy checks and an inventory", async () => {
    const { fetchImpl } = fakeTwilio();
    const report = await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).run(input);
    expect(report.account).toEqual({ ok: true, status: "active", type: "Full" });
    expect(report.primary).toMatchObject({ status: "twilio-approved", policySid: POLICY_P, policyMatchesConfigured: true });
    expect(report.primary?.businessEndUser).toMatchObject({ businessName: "GenX TotalTech LLC", businessIdentity: "isv_reseller_or_partner", registrationNumberLast4: "6789", nameMatchesExpected: true, einMatchesExpected: true });
    expect(report.configuredPolicyChecks).toEqual({ primary: "found", secondary: "found", a2p: "found" });
    expect(report.policies.find((row) => row.sid === POLICY_S)?.configuredAs).toEqual(["secondary"]);
    expect(report.inventory?.brands).toMatchObject({ total: 1, byStatus: { APPROVED: 1 }, truncated: false });
    expect(report.inventory?.customerProfiles.byStatus).toEqual({ "twilio-approved": 1 });
    expect(report.inventory?.namedPrefixMatches).toEqual({ prefix: "df:", customerProfiles: 0, trustProducts: 0 });
  });

  it("flags a legal-name or EIN mismatch without echoing the expected values", async () => {
    const { fetchImpl } = fakeTwilio();
    const report = await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).run({ ...input, expectedLegalName: "Someone Else LLC", expectedEin: "98-7654321" });
    expect(report.primary?.businessEndUser).toMatchObject({ nameMatchesExpected: false, einMatchesExpected: false });
    const text = JSON.stringify(report);
    expect(text).not.toContain("Someone Else");
    expect(text).not.toContain("987654321");
  });

  it("never puts credentials, the full EIN, the representative's contact details or an Authorization header in the report", async () => {
    const { fetchImpl } = fakeTwilio();
    const text = JSON.stringify(await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).run(input));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64"));
    expect(text).not.toContain("123456789");
    expect(text).not.toContain("rep@example.com");
    expect(text).not.toContain("+15035550100");
    expect(text).not.toMatch(/authorization/i);
  });

  it("reports policy SIDs that Twilio does not know and unconfigured ones separately", async () => {
    const { fetchImpl } = fakeTwilio();
    const report = await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).run({ ...input, configuredPolicies: { primary: POLICY_P, secondary: `RN${"0".repeat(32)}` } });
    expect(report.configuredPolicyChecks).toEqual({ primary: "found", secondary: "not_found", a2p: "not_configured" });
  });

  it("an account-endpoint failure that is not a 401 (for example an API key that cannot read it) does not hide the other sections", async () => {
    const { fetchImpl, calls } = fakeTwilio({ [`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}.json`]: { status: 403, body: { code: 20003, message: "forbidden" } } });
    const report = await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).run(input);
    expect(report.account.ok).toBe(false);
    expect(report.primary?.status).toBe("twilio-approved");
    expect(report.inventory).not.toBeNull();
    expect(calls.length).toBeGreaterThan(5);
    expect(report.problems).toHaveLength(1);
  });

  it("a 401 (bad credentials) stops at the account check: nothing else is requested and the problem is reported, not thrown", async () => {
    const { fetchImpl, calls } = fakeTwilio({ [`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}.json`]: { status: 401, body: { code: 20003, message: "Authenticate" } } });
    const report = await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).run(input);
    expect(calls).toHaveLength(1);
    expect(report.account.ok).toBe(false);
    expect(report.primary).toBeNull();
    expect(report.inventory).toBeNull();
    expect(report.problems).toEqual(["account: account http 401 code 20003"]);
  });

  it("one failing section does not hide the others", async () => {
    const { fetchImpl } = fakeTwilio({ [`https://trusthub.twilio.com/v1/CustomerProfiles/${PRIMARY}`]: { status: 404, body: { code: 20404, message: "not found" } } });
    const report = await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).run(input);
    expect(report.primary).toBeNull();
    expect(report.policies).toHaveLength(3);
    expect(report.inventory).not.toBeNull();
    expect(report.problems).toHaveLength(1);
  });

  it("a list with more pages than the page limit is reported as truncated, and an off-host next link is never followed", async () => {
    const calls: string[] = [];
    const page = (n: number, next: string | null) => ({ status: 200, text: async () => JSON.stringify({ data: [{ sid: `BN${String(n).padStart(32, "0")}`, status: "APPROVED" }], results: [], meta: next ? { next_page_url: next } : {} }) });
    const fetchImpl: ProbeFetch = async (url) => {
      calls.push(url);
      if (url.startsWith("https://messaging.twilio.com/v1/a2p/BrandRegistrations")) return page(calls.length, `https://messaging.twilio.com/v1/a2p/BrandRegistrations?Page=${calls.length}`);
      return { status: 200, text: async () => JSON.stringify({ results: [], meta: { next_page_url: "https://evil.example/steal" } }) };
    };
    const inventory = await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).inventory("df:");
    expect(inventory.brands.truncated).toBe(true);
    expect(inventory.brands.total).toBe(10);
    expect(inventory.customerProfiles.truncated).toBe(true); // an off-host next link is not followed, so the list is reported as incomplete
    expect(calls.some((url) => url.includes("evil.example"))).toBe(false);
  });

  it("refuses any host that is not a Twilio registration host before making a request (hosts cannot come from Twilio responses either)", async () => {
    const calls: string[] = [];
    const fetchImpl: ProbeFetch = async (url) => {
      calls.push(url);
      return { status: 200, text: async () => "{}" };
    };
    const probe = new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl);
    // reach the private primitive on purpose: the guard is the point of this file
    const get = (probe as unknown as { get(url: string): Promise<unknown> }).get.bind(probe);
    await expect(get("https://evil.example/v1/x")).rejects.toMatchObject({ kind: "refused" });
    await expect(get("http://trusthub.twilio.com/v1/Policies")).rejects.toMatchObject({ kind: "refused" });
    await expect(get("not a url")).rejects.toMatchObject({ kind: "refused" });
    expect(calls).toHaveLength(0);
  });

  it("a network failure is a transient problem that never carries the credentials", async () => {
    const fetchImpl: ProbeFetch = async () => {
      throw new Error(`connect failed for Basic ${Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64")}`);
    };
    const report = await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).run(input);
    expect(report.problems[0]).toBe("account: transient - network failure or timeout");
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it("asks fetch to refuse redirects, so a Twilio redirect can never move a request off the allow-list", async () => {
    const inits: unknown[] = [];
    const fetchImpl: ProbeFetch = async (_url, init) => {
      inits.push(init);
      return { status: 200, text: async () => JSON.stringify({ status: "active", type: "Full" }) };
    };
    await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).account(ACCOUNT);
    expect(inits[0]).toMatchObject({ method: "GET", redirect: "error" });
  });

  it("never carries the free-text error message from Twilio into the report (it can echo request fragments such as an EIN)", async () => {
    const { fetchImpl } = fakeTwilio({ [`https://trusthub.twilio.com/v1/CustomerProfiles/${PRIMARY}`]: { status: 400, body: { code: 90001, message: "bad business_registration_number 123456789 for GenX TotalTech LLC" } } });
    const report = await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).run(input);
    expect(report.problems).toContain("primary_profile: validation http 400 code 90001");
    const text = JSON.stringify(report);
    expect(text).not.toContain("123456789");
    expect(text).not.toContain("bad business_registration_number");
  });

  it("follows only same-host next links under the registration API paths, on the default port, over https", async () => {
    for (const next of ["https://trusthub.twilio.com:8443/v1/x", "https://trusthub.twilio.com/other/path", "http://trusthub.twilio.com/v1/x", "https://trusthub.twilio.com/../v1/x/../../admin"]) {
      const calls: string[] = [];
      const fetchImpl: ProbeFetch = async (url) => {
        calls.push(url);
        return { status: 200, text: async () => JSON.stringify({ results: [], meta: { next_page_url: next } }) };
      };
      await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).policies(undefined);
      expect(calls).toHaveLength(1);
    }
  });

  it("reports how many existing brands carry a boolean mock field (Stage C relies on it)", async () => {
    const { fetchImpl } = fakeTwilio({ "https://messaging.twilio.com/v1/a2p/BrandRegistrations?PageSize=50": { status: 200, body: { data: [{ sid: "BN1", status: "APPROVED", mock: false }, { sid: "BN2", status: "APPROVED" }], meta: {} } } });
    const inventory = await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).inventory("df:");
    expect(inventory.brands.withBooleanMockField).toBe(1);
  });

  it("does not follow a next-page link whose host merely starts with a Twilio host name", async () => {
    const calls: string[] = [];
    const fetchImpl: ProbeFetch = async (url) => {
      calls.push(url);
      return { status: 200, text: async () => JSON.stringify({ results: [], meta: { next_page_url: "https://trusthub.twilio.com.evil.example/v1/x" } }) };
    };
    await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).policies(undefined);
    expect(calls.some((url) => url.includes("evil.example"))).toBe(false);
  });
});

describe("Stage A with a Standard API key (Twilio: Standard keys cannot access the Accounts resource)", () => {
  const keyInput = { ...input, authMethod: "api_key" as const };
  it("never requests /Accounts, reports the account check as skipped, and still reads Trust Hub and the inventory", async () => {
    const { fetchImpl, calls } = fakeTwilio();
    const report = await new ReadOnlyProbe({ username: "SK" + "2".repeat(32), password: TOKEN }, fetchImpl).run(keyInput);
    expect(calls.some((call) => call.url.includes("/Accounts/"))).toBe(false);
    expect(report.account).toMatchObject({ ok: null, skipped: expect.stringContaining("Standard API keys") });
    expect(report.primary?.status).toBe("twilio-approved");
    expect(report.inventory).not.toBeNull();
    expect(report.problems).toEqual([]);
  });
  it("the first Trust Hub read is the credential check: a 401 there stops everything else", async () => {
    const { fetchImpl, calls } = fakeTwilio({ "https://trusthub.twilio.com/v1/Policies?PageSize=50": { status: 401, body: { code: 20003, message: "x" } } });
    const report = await new ReadOnlyProbe({ username: "SK" + "2".repeat(32), password: TOKEN }, fetchImpl).run(keyInput);
    expect(calls).toHaveLength(1);
    expect(report.primary).toBeNull();
    expect(report.inventory).toBeNull();
    expect(report.problems).toEqual(["policies: account http 401 code 20003"]);
  });
  it("a 401 from the Accounts endpoint is never the reason to stop (it is not requested for keys), but with the auth token it still is", async () => {
    const { fetchImpl, calls } = fakeTwilio({ [`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}.json`]: { status: 401, body: { code: 70004, message: "Unauthorized" } } });
    const withToken = await new ReadOnlyProbe({ username: ACCOUNT, password: TOKEN }, fetchImpl).run(input);
    expect(calls).toHaveLength(1);
    expect(withToken.problems).toEqual(["account: account http 401 code 70004"]);
  });
});

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptEin } from "@/lib/sms/onboarding/ein";
import { RedactedSecret, SubaccountTokenProvider } from "../account";
import { subaccountWebhooksAllowed, type IsvConfig } from "../config";
import { FakeIsvParent, type FakeIsvAdapter } from "../fake";
import { describeOutcome } from "../outcomes";
import type { RunnerInputs } from "../payloads";
import { createRealIsvParent, createWebhookTokenParent, RealIsvAdapter, RealIsvParent } from "../real";
import { paidBrandSupported, registrationPath, REGISTRATION_TIERS } from "../registrationPath";
import { rotatingSubaccountAdapter } from "../rotation";
import { runBrandSubmission } from "../runner";
import { RunnerStoreError } from "../store";
import { IsvApiError, type IsvAdapter } from "../types";
import { MemoryRunnerStore } from "./memoryStore";

/**
 * TW-4F provider integration (Twilio ticket #29647095 answers). Synthetic fixtures and injected fetch only: nothing here can reach Twilio.
 */

const STUDIO = "a5800000-0000-4000-8000-00000000000a";
const ADMIN = "a5800000-0000-4000-8000-000000000401";
const ENTITY = "e0000000-0000-4000-8000-0000000000f1";
const PRIMARY = `BU${"e".repeat(32)}`;
const PRIMARY_POLICY = `RN${"4".repeat(32)}`;
const PARENT_SID = `AC${"1".repeat(32)}`;
const SUB_A = `AC${"a".repeat(32)}`;
const PROD = { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on" };

const config: IsvConfig = {
  accountSid: PARENT_SID, authToken: "p".repeat(32), primaryProfileSid: PRIMARY, primaryProfilePolicySid: PRIMARY_POLICY,
  secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms-compliance@isv.example", envName: "test", mockBrand: false,
};
const inputs: RunnerInputs = {
  studio_id: STUDIO, submission_seq: 1, state: "submitted_for_checks", studio_name: "Synthetic Studio", studio_slug: "synthetic-studio", studio_public_name: null,
  legal_name: "Synthetic Dance LLC", entity_type: "llc", industry: "EDUCATION", website_choice: "danceflow", website_url: null,
  address_line1: "1 Test Way", address_line2: null, city: "Portland", region: "OR", postal_code: "97201", country: "US",
  rep_first_name: "Sam", rep_last_name: "Rivera", rep_title: "Owner", rep_position: "ceo", rep_email: "owner@synthetic.example", rep_phone: "+15035550100",
  preferred_area_code: "503", ein_last4: "4321", missing: [],
};

type Seen = { url: string; method: string; headers: Record<string, string>; body?: string };
function stub(reply: (seen: Seen) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const entry = { url, method: init.method, headers: init.headers, body: init.body };
    seen.push(entry);
    const { status, body } = reply(entry);
    return { status, text: async () => JSON.stringify(body) };
  };
  return { seen, fetchImpl };
}
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

describe("Primary profile read (parent credentials, GET only)", () => {
  it("reads exactly the configured Primary profile with the parent's credentials and nothing else", async () => {
    const { seen, fetchImpl } = stub(() => ({ status: 200, body: { sid: PRIMARY, status: "twilio-approved", policy_sid: PRIMARY_POLICY } }));
    const parent = new RealIsvParent(config, fetchImpl);
    expect(await parent.getPrimaryProfile()).toEqual({ status: "twilio-approved", policySid: PRIMARY_POLICY });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", url: `https://trusthub.twilio.com/v1/CustomerProfiles/${PRIMARY}` });
    expect(seen[0].body).toBeUndefined();
    expect(seen[0].headers.Authorization).toBe(basic(PARENT_SID, config.authToken));
  });

  it("fails closed when no Primary is configured or the reply is about another profile", async () => {
    const none = stub(() => ({ status: 200, body: {} }));
    await expect(new RealIsvParent({ accountSid: PARENT_SID, authToken: "p".repeat(32) }, none.fetchImpl).getPrimaryProfile()).rejects.toMatchObject({ kind: "account" });
    expect(none.seen).toHaveLength(0);
    const other = stub(() => ({ status: 200, body: { sid: `BU${"9".repeat(32)}`, status: "twilio-approved", policy_sid: PRIMARY_POLICY } }));
    await expect(new RealIsvParent(config, other.fetchImpl).getPrimaryProfile()).rejects.toMatchObject({ kind: "transient" });
  });

  it("the parent client has no write method for Trust Hub or A2P resources", () => {
    const names = Object.getOwnPropertyNames(RealIsvParent.prototype).filter((name) => name !== "constructor");
    expect(names.sort()).toEqual(["createSubaccount", "findSubaccount", "getPrimaryProfile", "getSubaccountToken"]);
    expect(createRealIsvParent(config, PROD)).toBeInstanceOf(RealIsvParent);
  });
});

describe("the webhook token parent", () => {
  const on = { VERCEL_ENV: "production", NODE_ENV: "production", TW4_SUBACCOUNT_WEBHOOKS: "on" };
  it("is gated separately from registration calls and only in a production build", () => {
    expect(subaccountWebhooksAllowed({}).allowed).toBe(false);
    expect(subaccountWebhooksAllowed({ ...on, VERCEL_ENV: "preview" }).allowed).toBe(false);
    expect(subaccountWebhooksAllowed({ ...on, NODE_ENV: "development" }).allowed).toBe(false);
    expect(subaccountWebhooksAllowed({ ...on, TW4_SUBACCOUNT_WEBHOOKS: "yes" }).allowed).toBe(false);
    expect(subaccountWebhooksAllowed(on).allowed).toBe(true);
    // TW4_ISV_REAL_CALLS does not switch it on
    expect(subaccountWebhooksAllowed(PROD).allowed).toBe(false);
  });

  it("refuses without the switch or credentials, and can read tokens but not the Primary profile", async () => {
    expect(() => createWebhookTokenParent({ accountSid: PARENT_SID, authToken: "p".repeat(32) }, PROD)).toThrow(IsvApiError);
    expect(() => createWebhookTokenParent({ accountSid: "", authToken: "p".repeat(32) }, on)).toThrow(IsvApiError);
    expect(() => createWebhookTokenParent({ accountSid: PARENT_SID, authToken: "" }, on)).toThrow(IsvApiError);
    const { seen, fetchImpl } = stub(() => ({ status: 200, body: { sid: SUB_A, auth_token: "s".repeat(32) } }));
    const parent = createWebhookTokenParent({ accountSid: PARENT_SID, authToken: "p".repeat(32) }, on, fetchImpl);
    expect(await parent.getSubaccountToken(SUB_A)).toBe("s".repeat(32));
    await expect(parent.getPrimaryProfile()).rejects.toMatchObject({ kind: "account" });
    expect(seen).toHaveLength(1);
  });
});

describe("registration paths (provider-confirmed semantics)", () => {
  it("Standard: STANDARD brand with secondary vetting, MIXED campaign, priced", () => {
    const path = registrationPath("standard");
    expect(path.brand).toEqual({ brandType: "STANDARD", skipAutomaticSecVet: false });
    expect(path.campaignUseCase).toBe("MIXED");
    expect(paidBrandSupported(path)).toBe(true);
  });

  it("Low-Volume Standard: still a STANDARD brand, skips automatic secondary vetting, LOW_VOLUME campaign, no published price yet", () => {
    const path = registrationPath("low_volume_standard");
    expect(path.brand).toEqual({ brandType: "STANDARD", skipAutomaticSecVet: true });
    expect(path.campaignUseCase).toBe("LOW_VOLUME");
    expect(paidBrandSupported(path)).toBe(false);
  });

  it("anything else is refused (never guessed) and the paths are frozen", () => {
    for (const bad of ["", "STANDARD", "low_volume", "sole_proprietor", null, undefined, 1]) expect(() => registrationPath(bad)).toThrow();
    expect(REGISTRATION_TIERS).toEqual(["standard", "low_volume_standard"]);
    const path = registrationPath("standard");
    expect(() => { (path.brand as { skipAutomaticSecVet: boolean }).skipAutomaticSecVet = true; }).toThrow();
  });

  it("the real adapter sends SkipAutomaticSecVet=true and BrandType=STANDARD for a Low-Volume Standard brand", async () => {
    const { seen, fetchImpl } = stub(() => ({ status: 201, body: { sid: `BN${"5".repeat(32)}` } }));
    const adapter = new RealIsvAdapter({ ...config, accountSid: SUB_A, authToken: "s".repeat(32) }, fetchImpl);
    const lvs = registrationPath("low_volume_standard");
    await adapter.createBrand({ customerProfileSid: `BU${"6".repeat(32)}`, trustProductSid: `BU${"7".repeat(32)}`, ...lvs.brand, mock: false });
    const body = new URLSearchParams(seen[0].body);
    expect(body.get("BrandType")).toBe("STANDARD");
    expect(body.get("SkipAutomaticSecVet")).toBe("true");
    const std = registrationPath("standard");
    await adapter.createBrand({ customerProfileSid: `BU${"6".repeat(32)}`, trustProductSid: `BU${"7".repeat(32)}`, ...std.brand, mock: false });
    expect(new URLSearchParams(seen[1].body).has("SkipAutomaticSecVet")).toBe(false);
  });
});

describe("the runner in a subaccount: Primary read through the parent, Primary assigned to the Secondary", () => {
  let parent: FakeIsvParent;
  let adapter: FakeIsvAdapter;
  let store: MemoryRunnerStore;

  beforeEach(() => {
    process.env.SMS_EIN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    delete process.env.SMS_EIN_ENCRYPTION_KEY_ID;
    parent = new FakeIsvParent(PRIMARY, { primaryPolicySid: PRIMARY_POLICY });
    adapter = parent.seedAccount(SUB_A, "df:test:entity");
    store = new MemoryRunnerStore(inputs, encryptEin(STUDIO, { digits: "987654321", last4: "4321" }).ciphertext);
    store.platformAdmins.add(ADMIN);
    store.account = { legalEntityId: ENTITY, accountSid: SUB_A, status: "active" };
  });

  const run = (over: Partial<Parameters<typeof runBrandSubmission>[0]> = {}) =>
    runBrandSubmission({ store, adapter, primary: parent, config, studioId: STUDIO, actorId: ADMIN, confirmFee: false, ...over });
  /** Two runs: S1..T5 + review stop, then the confirmed submissions and the brand. */
  const toBrand = async (over: Partial<Parameters<typeof runBrandSubmission>[0]> = {}) => {
    const cfg = over.config ? { config: over.config } : {};
    await run({ confirmSubmit: ["S11"], ...cfg });
    await run({ confirmSubmit: ["S11", "T6"], ...cfg });
    return run({ confirmSubmit: ["S11", "T6"], confirmFee: true, ...over });
  };

  it("the subaccount cannot read the Primary: without the parent reader the preflight fails closed before any write", async () => {
    const result = await runBrandSubmission({ store, adapter, config, studioId: STUDIO, actorId: ADMIN, confirmFee: false });
    expect(result).toMatchObject({ outcome: "exception", detail: "preflight:primary_profile_not_approved" });
    expect(adapter.count("createCustomerProfile")).toBe(0);
    expect(store.ledger).toHaveLength(0);
  });

  it("with the parent reader the preflight passes and S9 assigns the parent's Primary profile to the subaccount's Secondary profile", async () => {
    const result = await run({ stopAfter: "S10" });
    expect(result.stepsRun).toContain("S9");
    expect(parent.count("getPrimaryProfile")).toBe(1);
    expect(adapter.count("getCustomerProfile")).toBe(0);
    const secondary = store.ledger.find((row) => row.step_key === "S1")?.provider_sid;
    expect(secondary).toMatch(/^BU/);
    expect(adapter.profiles.get(secondary!)?.assigned).toContain(PRIMARY);
    // the Primary is not a resource of the subaccount: nothing was created, read or submitted for it there
    expect(adapter.profiles.has(PRIMARY)).toBe(false);
  });

  it("a Primary that is not approved, has the wrong policy, or cannot be read stops the run before any write", async () => {
    parent.primaryStatus = "in-review";
    expect((await run()).detail).toBe("preflight:primary_profile_not_approved");
    parent.primaryStatus = "twilio-approved";
    const wrong = new FakeIsvParent(PRIMARY, { primaryPolicySid: `RN${"0".repeat(32)}` });
    expect((await run({ primary: wrong })).detail).toBe("preflight:primary_profile_policy_mismatch");
    parent.failNext("getPrimaryProfile", { kind: "transient" });
    expect((await run()).outcome).toBe("retry_later");
    parent.failNext("getPrimaryProfile", { kind: "account" });
    expect((await run()).outcome).toBe("exception");
    expect(store.ledger).toHaveLength(0);
    expect(adapter.calls).toHaveLength(0);
  });

  it("Standard tier (default): brand created with secondary vetting on", async () => {
    const result = await toBrand();
    expect(result.outcome).toBe("brand_submitted");
    const brand = adapter.calls.find((call) => call.method === "createBrand")?.input as { skipAutomaticSecVet: boolean; brandType: string };
    expect(brand).toMatchObject({ brandType: "STANDARD", skipAutomaticSecVet: false });
    expect(store.spendReservations).toHaveLength(1);
  });

  it("Low-Volume Standard, paid: stopped before ANY Twilio write (no submission, no reservation, no brand call: no published price)", async () => {
    store.tier = "low_volume_standard";
    const result = await toBrand();
    expect(result).toMatchObject({ outcome: "tier_unpriced", detail: "B1:low_volume_standard", stepsRun: [] });
    expect(adapter.calls).toHaveLength(0);
    expect(store.spendReservations).toHaveLength(0);
    expect(store.ledger).toHaveLength(0);
    expect(describeOutcome("tier_unpriced")).toMatch(/Low-Volume Standard/);
    expect(describeOutcome("tier_unpriced")).toMatch(/Nothing was reserved, called or charged/);
  });

  it("Low-Volume Standard, mock: the free mock brand skips automatic secondary vetting", async () => {
    store.tier = "low_volume_standard";
    const result = await toBrand({ config: { ...config, mockBrand: true } });
    expect(result.outcome).toBe("brand_submitted");
    const brand = adapter.calls.find((call) => call.method === "createBrand")?.input as { skipAutomaticSecVet: boolean; brandType: string; mock: boolean };
    expect(brand).toMatchObject({ brandType: "STANDARD", skipAutomaticSecVet: true, mock: true });
    expect(store.spendReservations).toHaveLength(0);
  });

  it("an onboarding whose brand already exists (a mock run) is not blocked when the mock switch is turned off, and nothing is bought again", async () => {
    store.tier = "low_volume_standard";
    expect((await toBrand({ config: { ...config, mockBrand: true } })).outcome).toBe("brand_submitted");
    const after = await run({ confirmSubmit: ["S11", "T6"], confirmFee: true });
    expect(after.outcome).not.toBe("tier_unpriced");
    expect(adapter.count("createBrand")).toBe(1);
    expect(store.spendReservations).toHaveLength(0);
  });

  it("an unreadable or unknown tier stops the run before any Twilio write", async () => {
    store.tierError = "57014";
    expect(await run()).toMatchObject({ outcome: "exception", detail: "tier:57014" });
    store.tierError = null;
    store.tier = "SOLE_PROPRIETOR";
    expect(await run()).toMatchObject({ outcome: "exception", detail: "tier:unknown" });
    expect(adapter.calls).toHaveLength(0);
    expect(store.ledger).toHaveLength(0);
  });
});

describe("token rotation (no overlap window)", () => {
  /** A stand-in subaccount whose every call needs the CURRENT token, as Twilio does: anything else is a 401. */
  function account(initial: string) {
    const state = { token: initial, calls: [] as { method: string; token: string }[] };
    const build = (sid: string, secret: RedactedSecret): IsvAdapter => {
      const token = secret.reveal();
      const guard = async <T>(method: string, value: T): Promise<T> => {
        state.calls.push({ method, token });
        if (token !== state.token) throw new IsvApiError("account", 401, "20003", "Authenticate");
        return value;
      };
      return {
        accountSid: sid,
        getCustomerProfile: () => guard("getCustomerProfile", { status: "draft", policySid: null }),
        createCustomerProfile: () => guard("createCustomerProfile", `BU${"8".repeat(32)}`),
        findCustomerProfile: () => guard("findCustomerProfile", []),
      } as unknown as IsvAdapter;
    };
    return { state, build };
  }
  function tokenSource(state: { token: string }, now = { t: 0 }, refreshIntervalMs = 0) {
    let reads = 0;
    const provider = new SubaccountTokenProvider({ getSubaccountToken: async () => { reads += 1; return state.token; } }, { now: () => now.t, refreshIntervalMs });
    return { provider, reads: () => reads, now };
  }

  it("a 401 after a rotation re-reads the token once and repeats the request with the new token", async () => {
    const { state, build } = account("t1".padEnd(32, "x"));
    const tokens = tokenSource(state);
    const adapter = await rotatingSubaccountAdapter(SUB_A, tokens.provider, build);
    expect(await adapter.createCustomerProfile({ friendlyName: "f", email: "e@x.example" })).toMatch(/^BU/);
    state.token = "t2".padEnd(32, "x"); // rotated at Twilio
    expect(await adapter.createCustomerProfile({ friendlyName: "f", email: "e@x.example" })).toMatch(/^BU/);
    expect(state.calls.map((c) => c.token.slice(0, 2))).toEqual(["t1", "t1", "t2"]);
    expect(tokens.reads()).toBe(2);
    expect(adapter.accountSid).toBe(SUB_A);
  });

  it("an unchanged token is a real credential failure: no retry, the 401 is returned", async () => {
    const { state, build } = account("t1".padEnd(32, "x"));
    // the parent keeps handing out t1 while Twilio rejects it (a suspended account, a wrong credential): never a loop
    const parentView = { token: "t1".padEnd(32, "x") };
    const tokens = tokenSource(parentView);
    const adapter = await rotatingSubaccountAdapter(SUB_A, tokens.provider, build);
    state.token = "something-else";
    await expect(adapter.findCustomerProfile("f")).rejects.toMatchObject({ kind: "account", httpStatus: 401 });
    expect(state.calls.filter((c) => c.method === "findCustomerProfile")).toHaveLength(1);
    expect(tokens.reads()).toBe(2);
  });

  it("other errors are never retried and a second 401 with a fresh token is final", async () => {
    let calls = 0;
    const build = (sid: string): IsvAdapter => ({
      accountSid: sid,
      findCustomerProfile: async () => { calls += 1; throw new IsvApiError("transient", 503, null, "down"); },
      createCustomerProfile: async () => { calls += 1; throw new IsvApiError("account", 401, "20003", "Authenticate"); },
    }) as unknown as IsvAdapter;
    let n = 0;
    const provider = new SubaccountTokenProvider({ getSubaccountToken: async () => `tok${(n += 1)}`.padEnd(32, "x") }, { refreshIntervalMs: 0 });
    const adapter = await rotatingSubaccountAdapter(SUB_A, provider, build);
    await expect(adapter.findCustomerProfile("f")).rejects.toMatchObject({ kind: "transient" });
    expect(calls).toBe(1);
    calls = 0;
    await expect(adapter.createCustomerProfile({ friendlyName: "f", email: "e" })).rejects.toMatchObject({ kind: "account", httpStatus: 401 });
    expect(calls).toBe(2); // the original and exactly one retry
  });

  it("an adapter built for another account is refused", async () => {
    const provider = new SubaccountTokenProvider({ getSubaccountToken: async () => "t".repeat(32) });
    await expect(rotatingSubaccountAdapter(SUB_A, provider, () => ({ accountSid: PARENT_SID }) as IsvAdapter)).rejects.toMatchObject({ kind: "account" });
  });

  it("forced re-reads of one account are spaced; inside the interval the cached token is the answer", async () => {
    const state = { token: "t1".padEnd(32, "x") };
    const tokens = tokenSource(state, { t: 0 }, 30_000);
    const first = await tokens.provider.tokenFor(SUB_A);
    // the token was read a moment ago: a forced re-read is not sent
    const r1 = await tokens.provider.refresh(SUB_A, first);
    expect(r1.changed).toBe(false);
    expect(tokens.reads()).toBe(1);
    state.token = "t2".padEnd(32, "x");
    tokens.now.t = 10_000; // inside the 30 s interval: no parent request
    const r2 = await tokens.provider.refresh(SUB_A, first);
    expect(r2.changed).toBe(false);
    expect(tokens.reads()).toBe(1);
    tokens.now.t = 31_000;
    const r3 = await tokens.provider.refresh(SUB_A, first);
    expect(r3.changed).toBe(true);
    expect(r3.secret.reveal().startsWith("t2")).toBe(true);
    expect(tokens.reads()).toBe(2);
    await expect(tokens.provider.refresh("AC123", null)).rejects.toMatchObject({ kind: "account" });
  });

  it("concurrent callers share ONE parent read, and a failed read is not repeated inside the interval (negative cache)", async () => {
    let reads = 0;
    let fail = true;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const now = { t: 0 };
    const provider = new SubaccountTokenProvider({ getSubaccountToken: async () => { reads += 1; await gate; if (fail) throw new IsvApiError("transient", 503, null, "down"); return "t".repeat(32); } }, { now: () => now.t, refreshIntervalMs: 30_000 });
    const burst = Array.from({ length: 20 }, () => provider.tokenFor(SUB_A).catch((e: unknown) => e));
    const refreshes = Array.from({ length: 20 }, () => provider.refresh(SUB_A, null).catch((e: unknown) => e));
    release();
    const results = await Promise.all([...burst, ...refreshes]);
    expect(reads).toBe(1);
    expect(results.every((r) => r instanceof IsvApiError)).toBe(true);
    // inside the interval: no new parent read, for tokenFor and refresh alike
    await expect(provider.tokenFor(SUB_A)).rejects.toMatchObject({ kind: "transient" });
    await expect(provider.refresh(SUB_A, null)).rejects.toMatchObject({ kind: "transient" });
    expect(reads).toBe(1);
    fail = false;
    now.t = 31_000;
    expect((await provider.tokenFor(SUB_A)).reveal()).toBe("t".repeat(32));
    expect(reads).toBe(2);
  });

  it("the parent's replies are bound to what was asked: another profile or account, a missing sid, or a closed account fail closed", async () => {
    const noSid = stub(() => ({ status: 200, body: { status: "twilio-approved", policy_sid: PRIMARY_POLICY } }));
    await expect(new RealIsvParent(config, noSid.fetchImpl).getPrimaryProfile()).rejects.toMatchObject({ kind: "transient" });
    for (const body of [{ sid: `AC${"c".repeat(32)}`, auth_token: "s".repeat(32) }, { auth_token: "s".repeat(32) }]) {
      const other = stub(() => ({ status: 200, body }));
      await expect(new RealIsvParent(config, other.fetchImpl).getSubaccountToken(SUB_A)).rejects.toMatchObject({ kind: "transient" });
    }
    const closed = stub(() => ({ status: 200, body: { sid: SUB_A, status: "closed", auth_token: "s".repeat(32) } }));
    await expect(new RealIsvParent(config, closed.fetchImpl).getSubaccountToken(SUB_A)).rejects.toMatchObject({ kind: "account" });
  });

  it("a failing token read never surfaces the credential or the parent's error text", async () => {
    const provider = new SubaccountTokenProvider({ getSubaccountToken: async () => { throw new IsvApiError("account", 401, "20003", `token ${"s".repeat(32)}`); } });
    const error = await provider.refresh(SUB_A, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IsvApiError);
    expect(String((error as Error).message)).not.toContain("s".repeat(32));
    expect(error).not.toBeInstanceOf(RunnerStoreError);
  });
});

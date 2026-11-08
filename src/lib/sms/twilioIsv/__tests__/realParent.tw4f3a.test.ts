import { describe, expect, it } from "vitest";
import type { IsvConfig } from "../config";
import { createRealIsvParent, createScopedRealAdapter, RealIsvAdapter, RealIsvParent } from "../real";
import { IsvApiError } from "../types";

/** TW-4F-3a: the REAL parent client and the per-subaccount adapter, pinned with an injected fetch. Nothing here reaches Twilio. */

const PARENT = `AC${"1".repeat(32)}`;
const SUB = `AC${"a".repeat(32)}`;
const PARENT_TOKEN = "p".repeat(32);
const SUB_TOKEN = "s".repeat(32);
const config: IsvConfig = {
  accountSid: PARENT, authToken: PARENT_TOKEN, primaryProfileSid: `BU${"e".repeat(32)}`, primaryProfilePolicySid: `RN${"4".repeat(32)}`,
  secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms-compliance@isv.example", envName: "test", mockBrand: false,
};
const PROD = { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on" };
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

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

describe("RealIsvParent", () => {
  it("lists subaccounts by exact friendly name and ignores closed ones", async () => {
    const { seen, fetchImpl } = stub(() => ({ status: 200, body: { results: [
      { sid: SUB, friendly_name: "df:test:e1", status: "active" },
      { sid: `AC${"b".repeat(32)}`, friendly_name: "df:test:e1", status: "closed" },
      { sid: `AC${"c".repeat(32)}`, friendly_name: "df:test:other", status: "active" },
    ], meta: {} } }));
    const parent = new RealIsvParent(config, fetchImpl);
    expect(await parent.findSubaccount("df:test:e1")).toEqual([SUB]);
    expect(seen[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts.json?FriendlyName=df%3Atest%3Ae1&PageSize=50");
    expect(seen[0].method).toBe("GET");
    expect(seen[0].headers.Authorization).toBe(basic(PARENT, PARENT_TOKEN));
  });

  it("creates a subaccount with only a friendly name; a reply without a valid SID is an unknown outcome", async () => {
    const ok = stub(() => ({ status: 201, body: { sid: SUB } }));
    expect(await new RealIsvParent(config, ok.fetchImpl).createSubaccount("df:test:e1")).toBe(SUB);
    expect(ok.seen[0]).toMatchObject({ method: "POST", url: "https://api.twilio.com/2010-04-01/Accounts.json", body: "FriendlyName=df%3Atest%3Ae1" });
    const bad = stub(() => ({ status: 201, body: { sid: "nope" } }));
    await expect(new RealIsvParent(config, bad.fetchImpl).createSubaccount("x")).rejects.toMatchObject({ kind: "transient" });
    const down = stub(() => ({ status: 503, body: {} }));
    await expect(new RealIsvParent(config, down.fetchImpl).createSubaccount("x")).rejects.toMatchObject({ kind: "transient" });
    const refused = stub(() => ({ status: 400, body: { code: 21200, message: "bad" } }));
    await expect(new RealIsvParent(config, refused.fetchImpl).createSubaccount("x")).rejects.toMatchObject({ kind: "validation" });
  });

  it("reads a subaccount's token only for a subaccount SID (never the parent's own) and fails closed on a reply without one", async () => {
    const ok = stub(() => ({ status: 200, body: { sid: SUB, auth_token: SUB_TOKEN } }));
    const parent = new RealIsvParent(config, ok.fetchImpl);
    expect(await parent.getSubaccountToken(SUB)).toBe(SUB_TOKEN);
    expect(ok.seen[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB}.json`);
    await expect(parent.getSubaccountToken(PARENT)).rejects.toThrow("not a subaccount sid");
    await expect(parent.getSubaccountToken("AC123")).rejects.toThrow("not a subaccount sid");
    expect(ok.seen).toHaveLength(1);
    for (const body of [{ sid: SUB }, { sid: SUB, auth_token: "" }, { sid: SUB, auth_token: "short" }, { sid: SUB, auth_token: 12345 }]) {
      const empty = stub(() => ({ status: 200, body }));
      await expect(new RealIsvParent(config, empty.fetchImpl).getSubaccountToken(SUB)).rejects.toBeInstanceOf(IsvApiError);
    }
  });

  it("is refused outside a production deployment with the switch on, and has no registration method at all", async () => {
    expect(() => createRealIsvParent(config, {})).toThrow(IsvApiError);
    expect(() => createRealIsvParent(config, { ...PROD, VERCEL_ENV: "preview" })).toThrow(IsvApiError);
    expect(createRealIsvParent(config, PROD)).toBeInstanceOf(RealIsvParent);
    const names = Object.getOwnPropertyNames(RealIsvParent.prototype);
    // TW-4F provider integration: the ONLY profile method is the read-only Primary profile GET (pinned by its own test below)
    expect(names.filter((name) => /Profile|TrustProduct|Brand|EndUser|Address|Document/.test(name))).toEqual(["getPrimaryProfile"]);
  });
});

describe("createScopedRealAdapter", () => {
  it("signs with the SUBACCOUNT's SID and token and never with the parent's key or token", async () => {
    const withKey: IsvConfig = { ...config, authToken: "", apiKeySid: `SK${"9".repeat(32)}`, apiKeySecret: "k".repeat(32) };
    const { seen, fetchImpl } = stub(() => ({ status: 200, body: { status: "twilio-approved", policy_sid: config.primaryProfilePolicySid } }));
    const adapter = createScopedRealAdapter(withKey, SUB, SUB_TOKEN, PROD, fetchImpl);
    expect(adapter).toBeInstanceOf(RealIsvAdapter);
    expect(adapter.accountSid).toBe(SUB);
    await adapter.getCustomerProfile(`BU${"d".repeat(32)}`);
    expect(seen[0].headers.Authorization).toBe(basic(SUB, SUB_TOKEN));
    expect(seen[0].headers.Authorization).not.toBe(basic(withKey.apiKeySid!, withKey.apiKeySecret!));
  });

  it("creates addresses in the subaccount's own path", async () => {
    const { seen, fetchImpl } = stub(() => ({ status: 201, body: { sid: `AD${"1".repeat(32)}` } }));
    const adapter = createScopedRealAdapter(config, SUB, SUB_TOKEN, PROD, fetchImpl);
    await adapter.createAddress({ customerName: "n", street: "s", streetSecondary: "", city: "c", region: "OR", postalCode: "97201", isoCountry: "US" });
    expect(seen[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB}/Addresses.json`);
  });

  it("refuses the parent's own SID, a malformed SID, a missing token and a non-production environment", () => {
    const noFetch = async () => ({ status: 500, text: async () => "" });
    expect(() => createScopedRealAdapter(config, PARENT, SUB_TOKEN, PROD, noFetch)).toThrow("not a subaccount sid");
    expect(() => createScopedRealAdapter(config, "AC12", SUB_TOKEN, PROD, noFetch)).toThrow("not a subaccount sid");
    expect(() => createScopedRealAdapter(config, SUB, "", PROD, noFetch)).toThrow("no subaccount credential");
    expect(() => createScopedRealAdapter(config, SUB, SUB_TOKEN, {}, noFetch)).toThrow(IsvApiError);
    expect(() => createScopedRealAdapter(config, SUB, SUB_TOKEN, { ...PROD, VERCEL_ENV: "preview" }, noFetch)).toThrow(IsvApiError);
  });
});

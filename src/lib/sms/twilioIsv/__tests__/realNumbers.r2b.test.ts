import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { numberCallsAllowed, provisioningCallsAllowed, type IsvConfig } from "../config";
import { FakeNumberAdapter, FakeNumberHub } from "../fakeNumbers";
import { createScopedNumberAdapter, RealNumberAdapter } from "../real";
import { rotatingSubaccountAdapter } from "../rotation";
import { IsvApiError } from "../types";

/** TW-4F R2b: the real number adapter's request shapes and gates (injected fetch; no live Twilio), the fake provider's semantics, and credential rotation. */

const PARENT = `AC${"0".repeat(32)}`;
const SUB = `AC${"1".repeat(32)}`;
const MG = `MG${"a".repeat(32)}`;
const QE = `QE${"b".repeat(32)}`;
const PN = `PN${"c".repeat(32)}`;
const E164 = "+12025550101";
const config: IsvConfig = {
  accountSid: PARENT, authToken: "", apiKeySid: `SK${"d".repeat(32)}`, apiKeySecret: "e".repeat(32), primaryProfileSid: `BU${"1".repeat(32)}`, primaryProfilePolicySid: `RN${"1".repeat(32)}`,
  secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms@example.test", envName: "production", mockBrand: false,
};
const PROD = { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on", TW4_PROVISIONING_REAL_CALLS: "on", TW4_NUMBER_REAL_CALLS: "on" };

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function fetchStub(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = responses.shift() ?? { status: 500, body: {} };
    return { status: next.status, text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body)) };
  };
  return { calls, impl };
}
const adapterWith = (responses: { status: number; body: unknown }[]) => {
  const stub = fetchStub(responses);
  return { stub, adapter: createScopedNumberAdapter(config, SUB, "subtoken", PROD, stub.impl) };
};
const auth = (call: Call) => Buffer.from(call.headers.Authorization.replace("Basic ", ""), "base64").toString();

describe("number purchase gate", () => {
  it("needs everything provisioning needs AND its own third switch", () => {
    expect(numberCallsAllowed(PROD)).toEqual({ allowed: true });
    expect(numberCallsAllowed({ ...PROD, TW4_NUMBER_REAL_CALLS: "off" }).allowed).toBe(false);
    expect(numberCallsAllowed({ ...PROD, TW4_NUMBER_REAL_CALLS: undefined }).allowed).toBe(false);
    expect(numberCallsAllowed({ ...PROD, TW4_PROVISIONING_REAL_CALLS: undefined }).allowed).toBe(false);
    expect(numberCallsAllowed({ ...PROD, TW4_ISV_REAL_CALLS: undefined }).allowed).toBe(false);
    expect(numberCallsAllowed({ ...PROD, NODE_ENV: "development" }).allowed).toBe(false);
    expect(numberCallsAllowed({ ...PROD, VERCEL_ENV: "preview" }).allowed).toBe(false);
    expect(numberCallsAllowed({}).allowed).toBe(false);
    // provisioning on does not turn number purchase on
    const noNumber = { ...PROD, TW4_NUMBER_REAL_CALLS: undefined };
    expect(provisioningCallsAllowed(noNumber)).toEqual({ allowed: true });
    expect(numberCallsAllowed(noNumber).allowed).toBe(false);
  });

  it("there is no ungated way to build the real adapter; the parent's SID and a missing credential are refused; nothing is called", () => {
    const stub = fetchStub([]);
    expect(() => RealNumberAdapter.forAccount(config, SUB, "t", {}, stub.impl)).toThrow(IsvApiError);
    expect(() => RealNumberAdapter.forAccount(config, SUB, "t", { ...PROD, TW4_NUMBER_REAL_CALLS: undefined }, stub.impl)).toThrow(IsvApiError);
    expect(() => createScopedNumberAdapter(config, PARENT, "t", PROD, stub.impl)).toThrow(/not a subaccount/);
    expect(() => createScopedNumberAdapter(config, "ACbad", "t", PROD, stub.impl)).toThrow(/not a subaccount/);
    expect(() => createScopedNumberAdapter(config, SUB, "", PROD, stub.impl)).toThrow(/no subaccount credential/);
    expect(RealNumberAdapter.forAccount(config, SUB, "t", PROD, stub.impl).evidenceSource).toBe("provider_read");
    expect(stub.calls).toHaveLength(0);
  });
});

describe("real number adapter request shapes (no live Twilio)", () => {
  it("signs every request with the SUBACCOUNT's SID and token, never the parent's API key", async () => {
    const { adapter, stub } = adapterWith([{ status: 200, body: { available_phone_numbers: [] } }]);
    await adapter.searchAvailableNumbers({ limit: 5 });
    expect(auth(stub.calls[0])).toBe(`${SUB}:subtoken`);
    expect(adapter.accountSid).toBe(SUB);
  });

  it("searches SMS-enabled US local numbers inside the subaccount (a GET: nothing is bought), normalizes capabilities and drops malformed numbers", async () => {
    const { adapter, stub } = adapterWith([{
      status: 200,
      body: { available_phone_numbers: [
        { phone_number: E164, locality: "Austin", region: "TX", capabilities: { voice: true, SMS: true, MMS: false }, address_requirements: "none" },
        { phone_number: "+442071234567", capabilities: { SMS: true } },
        { phone_number: "+12025550102", capabilities: { voice: true }, address_requirements: "local" },
      ] },
    }]);
    const found = await adapter.searchAvailableNumbers({ areaCode: "512", limit: 100 });
    const call = stub.calls[0];
    expect(call.method).toBe("GET");
    expect(call.url).toContain(`/Accounts/${SUB}/AvailablePhoneNumbers/US/Local.json?`);
    const query = new URL(call.url).searchParams;
    expect(query.get("SmsEnabled")).toBe("true");
    expect(query.get("AreaCode")).toBe("512");
    expect(query.get("PageSize")).toBe("50");
    expect(call.body).toBeUndefined();
    expect(found).toEqual([
      { e164: E164, locality: "Austin", region: "TX", sms_capable: true, mms_capable: false, address_requirements: "none" },
      { e164: "+12025550102", locality: null, region: null, sms_capable: false, mms_capable: false, address_requirements: "local" },
    ]);
    await expect(adapter.searchAvailableNumbers({ areaCode: "55", limit: 5 })).rejects.toThrow(/invalid area code/);
  });

  it("a search answer without its collection is an unknown outcome, never an empty list", async () => {
    const { adapter } = adapterWith([{ status: 200, body: { code: 0 } }]);
    await expect(adapter.searchAvailableNumbers({ limit: 5 })).rejects.toMatchObject({ kind: "transient" });
  });

  it("looks a number up by its exact E.164 in THIS account; another account's row is never counted; a lookup with more pages cannot prove absence", async () => {
    const { adapter, stub } = adapterWith([
      { status: 200, body: { incoming_phone_numbers: [{ sid: PN, account_sid: SUB, phone_number: E164 }, { sid: `PN${"d".repeat(32)}`, account_sid: PARENT, phone_number: E164 }], next_page_uri: null } },
      { status: 200, body: { incoming_phone_numbers: [], next_page_uri: "/2010-04-01/Accounts/x/IncomingPhoneNumbers.json?Page=1" } },
    ]);
    expect(await adapter.findOwnedNumbers(E164)).toEqual([PN]);
    expect(new URL(stub.calls[0].url).searchParams.get("PhoneNumber")).toBe(E164);
    await expect(adapter.findOwnedNumbers(E164)).rejects.toMatchObject({ kind: "transient" });
    await expect(adapter.findOwnedNumbers("12025550101")).rejects.toThrow(/invalid number/);
  });

  it("lists the WHOLE inventory of this account (own rows only); more pages than one page can show is refused, never a partial list", async () => {
    const { adapter, stub } = adapterWith([
      { status: 200, body: { incoming_phone_numbers: [{ sid: PN, account_sid: SUB, phone_number: E164 }, { sid: `PN${"d".repeat(32)}`, account_sid: PARENT, phone_number: "+12025550102" }], next_page_uri: null } },
      { status: 200, body: { incoming_phone_numbers: [], next_page_uri: "/2010-04-01/Accounts/x/IncomingPhoneNumbers.json?Page=1" } },
    ]);
    expect(await adapter.listIncomingNumbers()).toEqual([{ sid: PN, phone_number: E164 }]);
    expect(stub.calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB}/IncomingPhoneNumbers.json?PageSize=1000`);
    expect(stub.calls[0].method).toBe("GET");
    await expect(adapter.listIncomingNumbers()).rejects.toMatchObject({ kind: "transient" });
  });

  it("purchases with a form POST of the exact E.164 (the only call that costs money) and returns the PN sid; a 2xx without a sid is unknown", async () => {
    const { adapter, stub } = adapterWith([{ status: 201, body: { sid: PN } }, { status: 201, body: { sid: "nope" } }]);
    expect(await adapter.purchaseNumber({ e164: E164, friendlyName: "df:production:studio:pn:1" })).toBe(PN);
    const call = stub.calls[0];
    expect(call).toMatchObject({ method: "POST", url: `https://api.twilio.com/2010-04-01/Accounts/${SUB}/IncomingPhoneNumbers.json` });
    expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call.body);
    expect(form.get("PhoneNumber")).toBe(E164);
    expect(form.get("FriendlyName")).toBe("df:production:studio:pn:1");
    await expect(adapter.purchaseNumber({ e164: E164, friendlyName: "x" })).rejects.toMatchObject({ kind: "transient" });
    await expect(adapter.purchaseNumber({ e164: "+1555", friendlyName: "x" })).rejects.toThrow(/invalid number/);
  });

  it("classifies a purchase outcome the way the runner needs: a 4xx is a definite refusal, a 5xx / 429 / network error / unreadable success is unknown", async () => {
    const refused = adapterWith([{ status: 400, body: { code: 21452, message: "number not available" } }]);
    await expect(refused.adapter.purchaseNumber({ e164: E164, friendlyName: "x" })).rejects.toMatchObject({ kind: "validation", twilioCode: "21452" });
    for (const status of [429, 500, 503]) {
      const unknown = adapterWith([{ status, body: {} }]);
      await expect(unknown.adapter.purchaseNumber({ e164: E164, friendlyName: "x" })).rejects.toMatchObject({ kind: "transient" });
    }
    const unreadable = adapterWith([{ status: 200, body: "<html>" }]);
    await expect(unreadable.adapter.purchaseNumber({ e164: E164, friendlyName: "x" })).rejects.toMatchObject({ kind: "transient" });
    const denied = adapterWith([{ status: 401, body: {} }]);
    await expect(denied.adapter.purchaseNumber({ e164: E164, friendlyName: "x" })).rejects.toMatchObject({ kind: "account", httpStatus: 401 });
  });

  it("reads a number's facts, the service's sender pool, the campaign's compliance setup and the service route", async () => {
    const { adapter, stub } = adapterWith([
      { status: 200, body: { sid: PN, account_sid: SUB, phone_number: E164, capabilities: { sms: true, voice: true, mms: false } } },
      { status: 200, body: { sid: MG, account_sid: SUB } },
      { status: 200, body: { phone_numbers: [{ sid: PN, account_sid: SUB }, { sid: `PN${"e".repeat(32)}`, account_sid: PARENT }], meta: {} } },
      { status: 200, body: { sid: QE, account_sid: SUB, messaging_service_sid: MG, campaign_status: "VERIFIED", mock: false, opt_in_keywords: ["START"], opt_out_keywords: ["STOP", "END"], help_keywords: ["HELP"],
        opt_in_message: "in", opt_out_message: "out", help_message: "help" } },
      { status: 200, body: { sid: MG, account_sid: SUB, inbound_request_url: "https://app.example.test/api/sms/twilio/inbound", use_inbound_webhook_on_number: false } },
    ]);
    expect(await adapter.getNumber(PN)).toEqual({ sid: PN, account_sid: SUB, phone_number: E164, sms_capable: true });
    expect(await adapter.getServiceNumbers(MG)).toEqual({ service_sid: MG, account_sid: SUB, number_sids: [PN] });
    expect(await adapter.getCampaignCompliance(MG, QE)).toMatchObject({ campaign_status: "VERIFIED", mock: false, opt_out_keywords: ["STOP", "END"], help_keywords: ["HELP"] });
    expect(await adapter.getServiceRoute(MG)).toMatchObject({ use_inbound_webhook_on_number: false });
    expect(stub.calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "GET", "GET"]);
    expect(stub.calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB}/IncomingPhoneNumbers/${PN}.json`);
    expect(stub.calls[2].url).toContain(`https://messaging.twilio.com/v1/Services/${MG}/PhoneNumbers?`);
    expect(stub.calls[3].url).toBe(`https://messaging.twilio.com/v1/Services/${MG}/Compliance/Usa2p/${QE}`);
  });

  it("attaches a number to the Messaging Service with a form POST; malformed SIDs never reach the network", async () => {
    const { adapter, stub } = adapterWith([{ status: 201, body: { sid: PN } }]);
    expect(await adapter.attachNumber({ messagingServiceSid: MG, phoneNumberSid: PN })).toBe(PN);
    expect(stub.calls[0]).toMatchObject({ method: "POST", url: `https://messaging.twilio.com/v1/Services/${MG}/PhoneNumbers` });
    expect(new URLSearchParams(stub.calls[0].body).get("PhoneNumberSid")).toBe(PN);
    await expect(adapter.attachNumber({ messagingServiceSid: "MGbad", phoneNumberSid: PN })).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.attachNumber({ messagingServiceSid: MG, phoneNumberSid: "PNbad" })).rejects.toMatchObject({ kind: "validation" });
    expect(stub.calls).toHaveLength(1);
  });
});

describe("credential rotation (Twilio ticket #29647095: no overlap window)", () => {
  const token = (value: string) => ({ reveal: () => value }) as never;

  it("a 401 after a rotation re-reads the subaccount token ONCE and repeats that one request; a number is never bought twice", async () => {
    const stale = adapterWith([{ status: 401, body: {} }]);
    const fresh = adapterWith([{ status: 201, body: { sid: PN } }]);
    const builds: string[] = [];
    const tokens = { tokenFor: async () => token("old"), refresh: async () => ({ secret: token("new"), changed: true }) };
    const wrapped = await rotatingSubaccountAdapter(SUB, tokens as never, (_sid, secret) => {
      builds.push(secret.reveal());
      return secret.reveal() === "old" ? stale.adapter : fresh.adapter;
    });
    expect(await wrapped.purchaseNumber({ e164: E164, friendlyName: "x" })).toBe(PN);
    expect(builds).toEqual(["old", "new"]);
    expect(stale.stub.calls).toHaveLength(1);
    expect(fresh.stub.calls).toHaveLength(1);
    expect(wrapped.evidenceSource).toBe("provider_read");
    expect(wrapped.accountSid).toBe(SUB);
  });

  it("an unchanged token (a credential that really does not work) is not retried and stops the run; a second 401 is returned as it was", async () => {
    const stale = adapterWith([{ status: 401, body: {} }]);
    const tokens = { tokenFor: async () => token("old"), refresh: async () => ({ secret: token("old"), changed: false }) };
    const wrapped = await rotatingSubaccountAdapter(SUB, tokens as never, () => stale.adapter);
    await expect(wrapped.purchaseNumber({ e164: E164, friendlyName: "x" })).rejects.toMatchObject({ kind: "account", httpStatus: 401 });
    expect(stale.stub.calls).toHaveLength(1);
    const twice = adapterWith([{ status: 401, body: {} }]);
    const again = adapterWith([{ status: 401, body: {} }]);
    const tokens2 = { tokenFor: async () => token("old"), refresh: async () => ({ secret: token("new"), changed: true }) };
    const wrapped2 = await rotatingSubaccountAdapter(SUB, tokens2 as never, (_s, secret) => (secret.reveal() === "old" ? twice.adapter : again.adapter));
    await expect(wrapped2.purchaseNumber({ e164: E164, friendlyName: "x" })).rejects.toMatchObject({ kind: "account", httpStatus: 401 });
    expect(twice.stub.calls).toHaveLength(1);
    expect(again.stub.calls).toHaveLength(1);
  });

  it("a rotated token can never turn a subaccount adapter into the parent's: an adapter for another account is refused", async () => {
    const other = adapterWith([]);
    const tokens = { tokenFor: async () => token("t"), refresh: async () => ({ secret: token("t"), changed: false }) };
    await expect(rotatingSubaccountAdapter(`AC${"9".repeat(32)}`, tokens as never, () => other.adapter)).rejects.toMatchObject({ kind: "account" });
  });
});

describe("fake number provider (the only provider tests and local QA use)", () => {
  it("a number has exactly one owner across all accounts; another account cannot read, attach or buy it", async () => {
    const hub = new FakeNumberHub();
    const a = hub.adapterFor(SUB);
    const b = hub.adapterFor(`AC${"2".repeat(32)}`);
    a.seedAvailable(E164);
    a.registerService(MG);
    const sid = await a.purchaseNumber({ e164: E164, friendlyName: "x" });
    await expect(b.purchaseNumber({ e164: E164, friendlyName: "x" })).rejects.toMatchObject({ kind: "validation" });
    await expect(b.getNumber(sid)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(b.attachNumber({ messagingServiceSid: MG, phoneNumberSid: sid })).rejects.toMatchObject({ httpStatus: 404 });
    expect(await b.findOwnedNumbers(E164)).toEqual([]);
    expect(await a.findOwnedNumbers(E164)).toEqual([sid]);
    expect((await b.searchAvailableNumbers({ limit: 10 })).map((n) => n.e164)).not.toContain(E164);
  });

  it("a lost response applies the effect and still fails the call (the dangerous case the runner must reconcile)", async () => {
    const a = new FakeNumberAdapter(SUB);
    a.seedAvailable(E164);
    a.failNext("purchaseNumber", { kind: "transient", lostResponse: true });
    await expect(a.purchaseNumber({ e164: E164, friendlyName: "x" })).rejects.toMatchObject({ kind: "transient" });
    expect((await a.findOwnedNumbers(E164)).length).toBe(1);
    expect(a.evidenceSource).toBe("fake");
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildCampaignRequest } from "../campaignPayload";
import type { IsvConfig } from "../config";
import { numberFriendlyName } from "../numberRunner";
import { serviceFriendlyName } from "../provisionRunner";
import { createScopedNumberAdapter, createScopedProvisioningAdapter } from "../real";
import { IsvApiError } from "../types";

/**
 * TW-4F F5: OFFLINE request-shape contract for EVERY method of the real R2a / R2b adapters (create/find/read, search/purchase/attach) and the new release
 * methods. A stubbed fetch records each request; no network is ever reached. The pinned table below is the contract: HTTP method, URL (host, path, query) and
 * the exact form parameters. Twilio references used (checked 2026-10-22): messaging/api/service-resource, messaging/api/usapptoperson-resource,
 * messaging/api/phonenumber-resource, phone-numbers/api/incomingphonenumber-resource, phone-numbers/api/availablephonenumberlocal-resource.
 */

const PARENT = `AC${"0".repeat(32)}`;
const SUB = `AC${"1".repeat(32)}`;
const MG = `MG${"a".repeat(32)}`;
const QE = `QE${"b".repeat(32)}`;
const PN = `PN${"c".repeat(32)}`;
const BN = `BN${"d".repeat(32)}`;
const E164 = "+12025550101";
const STUDIO = "7f000000-0000-4000-8000-000000000001";
const config: IsvConfig = {
  accountSid: PARENT, authToken: "", apiKeySid: `SK${"d".repeat(32)}`, apiKeySecret: "e".repeat(32), primaryProfileSid: `BU${"1".repeat(32)}`, primaryProfilePolicySid: `RN${"1".repeat(32)}`,
  secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms@example.test", envName: "production", mockBrand: false,
};
const PROD = { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on", TW4_PROVISIONING_REAL_CALLS: "on", TW4_NUMBER_REAL_CALLS: "on" };

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function stub(responses: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const impl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = responses.shift() ?? { status: 500, body: {} };
    return { status: next.status, text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body)) };
  };
  return { calls, impl };
}
const numbers = (responses: { status: number; body: unknown }[]) => {
  const s = stub(responses);
  return { s, a: createScopedNumberAdapter(config, SUB, "subtoken", PROD, s.impl) };
};
const provisioning = (responses: { status: number; body: unknown }[]) => {
  const s = stub(responses);
  return { s, a: createScopedProvisioningAdapter(config, SUB, "subtoken", PROD, s.impl) };
};

/** The normalized shape of one request: method, URL and the form as [name, value] pairs in sent order (repeated keys stay repeated). */
const shape = (call: Call) => ({ method: call.method, url: call.url, form: call.body === undefined ? null : [...new URLSearchParams(call.body).entries()] });
const names = (call: Call) => [...new Set([...new URLSearchParams(call.body ?? "").keys()])].sort();

const API = `https://api.twilio.com/2010-04-01/Accounts/${SUB}`;
const MSG = "https://messaging.twilio.com/v1";

const campaign = buildCampaignRequest({ messagingServiceSid: MG, brandSid: BN, useCase: "LOW_VOLUME", displayName: "Harbor Dance", slug: "harbor-dance", origin: "https://www.idanceflow.com" });

describe("F5 contract: every real adapter request (method, path, query, form)", () => {
  it("R2a Messaging Service and campaign", async () => {
    const { a, s } = provisioning([
      { status: 200, body: { services: [], meta: {} } },
      { status: 201, body: { sid: MG } },
      { status: 200, body: { sid: MG, account_sid: SUB } },
      { status: 200, body: { compliance: [], meta: {} } },
      { status: 201, body: { sid: QE } },
      { status: 200, body: { sid: QE, account_sid: SUB } },
    ]);
    await a.findMessagingServices("df:production:");
    await a.createMessagingService({ friendlyName: serviceFriendlyName("production", STUDIO, 1), inboundRequestUrl: "https://www.idanceflow.com/api/twilio/inbound" });
    await a.getMessagingService(MG);
    await a.findCampaigns(MG);
    await a.createCampaign(campaign.input);
    await a.getCampaign(MG, QE);
    expect(s.calls.map(shape)).toEqual([
      { method: "GET", url: `${MSG}/Services?PageSize=50`, form: null },
      {
        method: "POST", url: `${MSG}/Services`,
        form: [["FriendlyName", `df:production:${STUDIO}:ms:1`], ["InboundRequestUrl", "https://www.idanceflow.com/api/twilio/inbound"], ["InboundMethod", "POST"], ["UseInboundWebhookOnNumber", "false"]],
      },
      { method: "GET", url: `${MSG}/Services/${MG}`, form: null },
      { method: "GET", url: `${MSG}/Services/${MG}/Compliance/Usa2p?PageSize=50`, form: null },
      { method: "POST", url: `${MSG}/Services/${MG}/Compliance/Usa2p`, form: expect.any(Array) },
      { method: "GET", url: `${MSG}/Services/${MG}/Compliance/Usa2p/${QE}`, form: null },
    ]);
    expect(names(s.calls[4])).toEqual([
      "AgeGated", "BrandRegistrationSid", "Description", "DirectLending", "HasEmbeddedLinks", "HasEmbeddedPhone", "HelpKeywords", "HelpMessage", "MessageFlow", "MessageSamples",
      "OptInKeywords", "OptInMessage", "OptOutKeywords", "OptOutMessage", "SubscriberOptIn", "UsAppToPersonUsecase",
    ]);
  });

  it("R2b search, inventory, purchase, attach and reads", async () => {
    const { a, s } = numbers([
      { status: 200, body: { available_phone_numbers: [] } },
      { status: 200, body: { incoming_phone_numbers: [] } },
      { status: 200, body: { incoming_phone_numbers: [] } },
      { status: 201, body: { sid: PN } },
      { status: 200, body: { sid: PN, account_sid: SUB, phone_number: E164, capabilities: { sms: true } } },
      { status: 200, body: { phone_numbers: [], meta: {} } },
      { status: 201, body: { sid: PN } },
      { status: 200, body: { sid: MG, account_sid: SUB } },
      { status: 200, body: { phone_numbers: [], meta: {} } },
      { status: 200, body: { sid: QE, account_sid: SUB } },
      { status: 200, body: { sid: MG, account_sid: SUB } },
    ]);
    await a.searchAvailableNumbers({ areaCode: "202", limit: 5 });
    await a.listIncomingNumbers();
    await a.findOwnedNumbers(E164);
    await a.purchaseNumber({ e164: E164, friendlyName: numberFriendlyName("production", STUDIO, 1) });
    await a.getNumber(PN);
    await a.listServiceNumbers(MG);
    await a.attachNumber({ messagingServiceSid: MG, phoneNumberSid: PN });
    await a.getServiceNumbers(MG);
    await a.getCampaignCompliance(MG, QE);
    await a.getServiceRoute(MG);
    expect(s.calls.map(shape)).toEqual([
      { method: "GET", url: `${API}/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&PageSize=5&AreaCode=202`, form: null },
      { method: "GET", url: `${API}/IncomingPhoneNumbers.json?PageSize=1000`, form: null },
      { method: "GET", url: `${API}/IncomingPhoneNumbers.json?PhoneNumber=%2B12025550101&PageSize=50`, form: null },
      { method: "POST", url: `${API}/IncomingPhoneNumbers.json`, form: [["PhoneNumber", E164], ["FriendlyName", `df:production:${STUDIO}:pn:1`]] },
      { method: "GET", url: `${API}/IncomingPhoneNumbers/${PN}.json`, form: null },
      { method: "GET", url: `${MSG}/Services/${MG}/PhoneNumbers?PageSize=50`, form: null },
      { method: "POST", url: `${MSG}/Services/${MG}/PhoneNumbers`, form: [["PhoneNumberSid", PN]] },
      { method: "GET", url: `${MSG}/Services/${MG}`, form: null },
      { method: "GET", url: `${MSG}/Services/${MG}/PhoneNumbers?PageSize=50`, form: null },
      { method: "GET", url: `${MSG}/Services/${MG}/Compliance/Usa2p/${QE}`, form: null },
      { method: "GET", url: `${MSG}/Services/${MG}`, form: null },
    ]);
  });

  it("F5 release and presence: DELETE with no body and no content type; presence is a GET", async () => {
    const n = numbers([{ status: 204, body: "" }, { status: 204, body: "" }, { status: 404, body: { code: 20404, message: "not found" } }]);
    expect(await n.a.releaseNumber(PN)).toBe("released");
    expect(await n.a.detachNumber({ messagingServiceSid: MG, phoneNumberSid: PN })).toBe("released");
    expect(await n.a.numberPresence(PN)).toBe("absent");
    const p = provisioning([{ status: 204, body: "" }, { status: 204, body: "" }, { status: 404, body: { code: 20404 } }, { status: 404, body: { code: 20404 } }]);
    expect(await p.a.deleteCampaign({ messagingServiceSid: MG, campaignSid: QE })).toBe("released");
    expect(await p.a.deleteMessagingService(MG)).toBe("released");
    expect(await p.a.campaignPresence({ messagingServiceSid: MG, campaignSid: QE })).toBe("absent");
    expect(await p.a.servicePresence(MG)).toBe("absent");
    expect([...n.s.calls, ...p.s.calls].map(shape)).toEqual([
      { method: "DELETE", url: `${API}/IncomingPhoneNumbers/${PN}.json`, form: null },
      { method: "DELETE", url: `${MSG}/Services/${MG}/PhoneNumbers/${PN}`, form: null },
      { method: "GET", url: `${API}/IncomingPhoneNumbers/${PN}.json`, form: null },
      { method: "DELETE", url: `${MSG}/Services/${MG}/Compliance/Usa2p/${QE}`, form: null },
      { method: "DELETE", url: `${MSG}/Services/${MG}`, form: null },
      { method: "GET", url: `${MSG}/Services/${MG}/Compliance/Usa2p/${QE}`, form: null },
      { method: "GET", url: `${MSG}/Services/${MG}`, form: null },
    ]);
    for (const call of [...n.s.calls, ...p.s.calls]) {
      expect(call.headers["Content-Type"]).toBeUndefined();
      // signed by the SUBACCOUNT, never the parent's API key
      expect(Buffer.from(call.headers.Authorization.replace("Basic ", ""), "base64").toString()).toBe(`${SUB}:subtoken`);
    }
  });
});

describe("F5 contract: documented limits and required fields", () => {
  it("the campaign request carries every required Usa2p parameter within Twilio's documented lengths", () => {
    expect(campaign.review.ok).toBe(true);
    const i = campaign.input;
    expect(i.description.length).toBeGreaterThanOrEqual(40);
    expect(i.description.length).toBeLessThanOrEqual(4096);
    expect(i.messageFlow.length).toBeGreaterThanOrEqual(40);
    expect(i.messageFlow.length).toBeLessThanOrEqual(2048);
    expect(i.messageSamples.length).toBeGreaterThanOrEqual(2);
    expect(i.messageSamples.length).toBeLessThanOrEqual(5);
    for (const sample of i.messageSamples) {
      expect(sample.length).toBeGreaterThanOrEqual(20);
      expect(sample.length).toBeLessThanOrEqual(1024);
    }
    for (const message of [i.optInMessage, i.optOutMessage, i.helpMessage]) {
      expect(message.length).toBeGreaterThanOrEqual(20);
      expect(message.length).toBeLessThanOrEqual(320);
    }
    for (const keywords of [i.optInKeywords, i.optOutKeywords, i.helpKeywords]) {
      expect(keywords.length).toBeGreaterThan(0);
      expect(keywords.join(",").length).toBeLessThanOrEqual(255);
      for (const k of keywords) expect(k).toMatch(/^[A-Za-z0-9]+$/);
    }
    expect(i.brandSid).toMatch(/^BN[0-9a-fA-F]{32}$/);
  });

  it("friendly names fit Twilio's 64-character limit for the realistic environments and sequences", () => {
    for (const env of ["production", "development", "preview"]) {
      for (const seq of [1, 99, 99999]) {
        expect(serviceFriendlyName(env, STUDIO, seq).length).toBeLessThanOrEqual(64);
        expect(numberFriendlyName(env, STUDIO, seq).length).toBeLessThanOrEqual(64);
      }
    }
  });

  it("the purchase never sends a FriendlyName over 64 characters, and malformed SIDs never leave the process", async () => {
    const { a, s } = numbers([{ status: 201, body: { sid: PN } }]);
    await a.purchaseNumber({ e164: E164, friendlyName: "x".repeat(200) });
    expect(new URLSearchParams(s.calls[0].body).get("FriendlyName")).toHaveLength(64);
    const none = numbers([]);
    await expect(none.a.releaseNumber("PNshort")).rejects.toThrow(IsvApiError);
    await expect(none.a.releaseNumber(`PN${"c".repeat(32)}/../x`)).rejects.toThrow(IsvApiError);
    await expect(none.a.detachNumber({ messagingServiceSid: "MGbad", phoneNumberSid: PN })).rejects.toThrow(IsvApiError);
    const pn = provisioning([]);
    await expect(pn.a.deleteCampaign({ messagingServiceSid: MG, campaignSid: "QEbad" })).rejects.toThrow(IsvApiError);
    await expect(pn.a.deleteMessagingService(QE)).rejects.toThrow(IsvApiError);
    expect(none.s.calls).toHaveLength(0);
    expect(pn.s.calls).toHaveLength(0);
  });
});

describe("F5 release outcome classification (what the runner relies on)", () => {
  const release = async (response: { status: number; body: unknown } | "network") => {
    const s = stub(response === "network" ? [] : [response]);
    const impl = response === "network" ? async () => { throw new Error("ECONNRESET"); } : s.impl;
    return createScopedNumberAdapter(config, SUB, "t", PROD, impl).releaseNumber(PN);
  };

  it("only Twilio's documented 404 with code 20404 reads as already absent", async () => {
    expect(await release({ status: 404, body: { code: 20404, message: "The requested resource was not found" } })).toBe("already_absent");
    // a 404 without Twilio's code (a proxy page, an unparseable body) is NOT an answer about this resource
    await expect(release({ status: 404, body: "<html>not found</html>" })).rejects.toMatchObject({ kind: "validation", httpStatus: 404, twilioCode: null });
    await expect(release({ status: 404, body: { code: 20003 } })).rejects.toMatchObject({ httpStatus: 404, twilioCode: "20003" });
  });

  it("a definite refusal is a parseable 4xx; 429, 5xx, a network failure and an unreadable success are transient (outcome unknown)", async () => {
    await expect(release({ status: 400, body: { code: 21000, message: "refused" } })).rejects.toMatchObject({ kind: "validation", httpStatus: 400 });
    await expect(release({ status: 401, body: { code: 20003 } })).rejects.toMatchObject({ kind: "account", httpStatus: 401 });
    await expect(release({ status: 429, body: { code: 20429 } })).rejects.toMatchObject({ kind: "transient" });
    await expect(release({ status: 503, body: {} })).rejects.toMatchObject({ kind: "transient" });
    await expect(release("network")).rejects.toMatchObject({ kind: "transient" });
    await expect(release({ status: 200, body: "not json" })).rejects.toMatchObject({ kind: "transient" });
  });

  it("a presence read about another resource or account proves nothing (throws, never 'present' or 'absent')", async () => {
    const other = numbers([{ status: 200, body: { sid: PN, account_sid: PARENT } }]);
    await expect(other.a.numberPresence(PN)).rejects.toMatchObject({ kind: "transient" });
    const wrong = provisioning([{ status: 200, body: { sid: `MG${"f".repeat(32)}`, account_sid: SUB } }]);
    await expect(wrong.a.servicePresence(MG)).rejects.toMatchObject({ kind: "transient" });
    const here = provisioning([{ status: 200, body: { sid: QE, account_sid: SUB } }]);
    expect(await here.a.campaignPresence({ messagingServiceSid: MG, campaignSid: QE })).toBe("present");
  });

  it("the release methods exist only on adapters built behind their gates", () => {
    const s = stub([]);
    expect(() => createScopedNumberAdapter(config, SUB, "t", { ...PROD, TW4_NUMBER_REAL_CALLS: undefined }, s.impl)).toThrow(IsvApiError);
    expect(() => createScopedProvisioningAdapter(config, SUB, "t", { ...PROD, TW4_PROVISIONING_REAL_CALLS: undefined }, s.impl)).toThrow(IsvApiError);
    expect(() => createScopedNumberAdapter(config, SUB, "t", {}, s.impl)).toThrow(IsvApiError);
    expect(s.calls).toHaveLength(0);
  });
});

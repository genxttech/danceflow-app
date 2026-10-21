import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildCampaignRequest, requestDigest } from "../campaignPayload";
import { provisioningCallsAllowed, type IsvConfig } from "../config";
import { createScopedProvisioningAdapter } from "../real";
import { IsvApiError } from "../types";

const PARENT = `AC${"0".repeat(32)}`;
const SUB = `AC${"1".repeat(32)}`;
const MG = `MG${"a".repeat(32)}`;
const QE = `QE${"b".repeat(32)}`;
const BN = `BN${"c".repeat(32)}`;
const config: IsvConfig = {
  accountSid: PARENT, authToken: "", apiKeySid: `SK${"d".repeat(32)}`, apiKeySecret: "e".repeat(32), primaryProfileSid: `BU${"1".repeat(32)}`, primaryProfilePolicySid: `RN${"1".repeat(32)}`,
  secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms@example.test", envName: "production", mockBrand: false,
};
const PROD = { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on", TW4_PROVISIONING_REAL_CALLS: "on" };

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
  return { stub, adapter: createScopedProvisioningAdapter(config, SUB, "subtoken", PROD, stub.impl) };
};
const auth = (call: Call) => Buffer.from(call.headers.Authorization.replace("Basic ", ""), "base64").toString();

describe("provisioning gate", () => {
  it("needs a production deployment, a production build, the registration switch AND the provisioning switch", () => {
    expect(provisioningCallsAllowed(PROD)).toEqual({ allowed: true });
    expect(provisioningCallsAllowed({ ...PROD, TW4_PROVISIONING_REAL_CALLS: "off" }).allowed).toBe(false);
    expect(provisioningCallsAllowed({ ...PROD, TW4_PROVISIONING_REAL_CALLS: undefined }).allowed).toBe(false);
    expect(provisioningCallsAllowed({ ...PROD, TW4_ISV_REAL_CALLS: undefined }).allowed).toBe(false);
    expect(provisioningCallsAllowed({ ...PROD, NODE_ENV: "development" }).allowed).toBe(false);
    expect(provisioningCallsAllowed({ ...PROD, VERCEL_ENV: "preview" }).allowed).toBe(false);
    expect(provisioningCallsAllowed({}).allowed).toBe(false);
  });

  it("the gate also holds for the static factory (there is no ungated way to build the real adapter)", async () => {
    const { RealProvisioningAdapter } = await import("../real");
    const stub = fetchStub([]);
    expect(() => RealProvisioningAdapter.forAccount(config, SUB, "t", {}, stub.impl)).toThrow(IsvApiError);
    expect(() => RealProvisioningAdapter.forAccount(config, PARENT, "t", PROD, stub.impl)).toThrow(/not a subaccount/);
    expect(RealProvisioningAdapter.forAccount(config, SUB, "t", PROD, stub.impl).evidenceSource).toBe("provider_read");
  });

  it("refuses to build outside the gate, for the parent's SID, or without a credential", () => {
    const stub = fetchStub([]);
    expect(() => createScopedProvisioningAdapter(config, SUB, "t", { ...PROD, TW4_PROVISIONING_REAL_CALLS: undefined }, stub.impl)).toThrow(IsvApiError);
    expect(() => createScopedProvisioningAdapter(config, PARENT, "t", PROD, stub.impl)).toThrow(/not a subaccount/);
    expect(() => createScopedProvisioningAdapter(config, "ACbad", "t", PROD, stub.impl)).toThrow(/not a subaccount/);
    expect(() => createScopedProvisioningAdapter(config, SUB, "", PROD, stub.impl)).toThrow(/no subaccount credential/);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("real provisioning adapter request shapes (no live Twilio)", () => {
  it("signs every request with the SUBACCOUNT's SID and token, never the parent's API key", async () => {
    const { adapter, stub } = adapterWith([{ status: 200, body: { services: [], meta: {} } }]);
    await adapter.findMessagingServices("df:test:x:ms:");
    expect(auth(stub.calls[0])).toBe(`${SUB}:subtoken`);
    expect(adapter.accountSid).toBe(SUB);
  });

  it("creates a Messaging Service that routes inbound to DanceFlow itself (not per number)", async () => {
    const { adapter, stub } = adapterWith([{ status: 201, body: { sid: MG } }]);
    expect(await adapter.createMessagingService({ friendlyName: "df:test:s:ms:1", inboundRequestUrl: "https://app.example.test/api/sms/twilio/inbound" })).toBe(MG);
    const call = stub.calls[0];
    expect(call).toMatchObject({ method: "POST", url: "https://messaging.twilio.com/v1/Services" });
    const form = new URLSearchParams(call.body);
    expect(form.get("FriendlyName")).toBe("df:test:s:ms:1");
    expect(form.get("InboundRequestUrl")).toBe("https://app.example.test/api/sms/twilio/inbound");
    expect(form.get("UseInboundWebhookOnNumber")).toBe("false");
    expect(form.get("InboundMethod")).toBe("POST");
  });

  it("lookups return only this account's matches, require the collection to be present and complete", async () => {
    const { adapter } = adapterWith([{ status: 200, body: { services: [
      { sid: MG, account_sid: SUB, friendly_name: "df:test:s:ms:1" }, { sid: `MG${"f".repeat(32)}`, account_sid: PARENT, friendly_name: "df:test:s:ms:1" }, { sid: `MG${"e".repeat(32)}`, account_sid: SUB, friendly_name: "other" },
    ], meta: { next_page_url: null } } }]);
    expect(await adapter.findMessagingServices("df:test:s:ms:")).toEqual([MG]);
    // a response without the collection must NOT read as "nothing exists" (it guards duplicate creates)
    const missing = adapterWith([{ status: 200, body: { unexpected: true } }]);
    await expect(missing.adapter.findMessagingServices("x")).rejects.toMatchObject({ kind: "transient" });
    const unfinished = adapterWith(Array.from({ length: 11 }, () => ({ status: 200, body: { services: [], meta: { next_page_url: "https://messaging.twilio.com/v1/Services?Page=1" } } })));
    await expect(unfinished.adapter.findMessagingServices("x")).rejects.toMatchObject({ kind: "transient" });
    // a next-page link to another host is not followed, and it is not "the last page" either: the listing is incomplete, so it cannot certify absence
    const hostile = adapterWith([{ status: 200, body: { services: [], meta: { next_page_url: "https://evil.example/v1/Services" } } }]);
    await expect(hostile.adapter.findMessagingServices("x")).rejects.toMatchObject({ kind: "transient" });
    expect(hostile.stub.calls).toHaveLength(1);
  });

  it("the campaign listing is evidence-grade: a foreign or unlabeled row, or an unexpected next page, makes it throw instead of reading as a clean listing", async () => {
    const ok = adapterWith([{ status: 200, body: { compliance: [{ sid: QE, account_sid: SUB }], meta: { next_page_url: null } } }]);
    expect(await ok.adapter.findCampaigns(MG)).toEqual([QE]);
    const foreign = adapterWith([{ status: 200, body: { compliance: [{ sid: QE, account_sid: SUB }, { sid: `QE${"f".repeat(32)}`, account_sid: PARENT }], meta: { next_page_url: null } } }]);
    await expect(foreign.adapter.findCampaigns(MG)).rejects.toMatchObject({ kind: "transient" });
    const unlabeled = adapterWith([{ status: 200, body: { compliance: [{ sid: QE }], meta: { next_page_url: null } } }]);
    await expect(unlabeled.adapter.findCampaigns(MG)).rejects.toMatchObject({ kind: "transient" });
    const truncated = adapterWith([{ status: 200, body: { compliance: [], meta: { next_page_url: "https://evil.example/v1/Services" } } }]);
    await expect(truncated.adapter.findCampaigns(MG)).rejects.toMatchObject({ kind: "transient" });
    const empty = adapterWith([{ status: 200, body: { compliance: [], meta: { next_page_url: null } } }]);
    expect(await empty.adapter.findCampaigns(MG)).toEqual([]);
  });

  it("submits the campaign under its service with repeated list parameters and the declared flags", async () => {
    const request = buildCampaignRequest({ messagingServiceSid: MG, brandSid: BN, useCase: "LOW_VOLUME", displayName: "Harbor Dance", slug: "harbor-dance", origin: "https://www.idanceflow.com" });
    const { adapter, stub } = adapterWith([{ status: 201, body: { sid: QE } }]);
    expect(await adapter.createCampaign(request.input)).toBe(QE);
    const call = stub.calls[0];
    expect(call).toMatchObject({ method: "POST", url: `https://messaging.twilio.com/v1/Services/${MG}/Compliance/Usa2p` });
    const form = new URLSearchParams(call.body);
    expect(form.get("BrandRegistrationSid")).toBe(BN);
    expect(form.get("UsAppToPersonUsecase")).toBe("LOW_VOLUME");
    expect(form.getAll("MessageSamples")).toHaveLength(request.input.messageSamples.length);
    expect(form.getAll("OptOutKeywords")).toContain("STOP");
    expect(form.getAll("OptInKeywords")).toContain("START");
    expect(form.getAll("HelpKeywords")).toContain("HELP");
    expect(form.get("HasEmbeddedLinks")).toBe("false");
    expect(form.get("HasEmbeddedPhone")).toBe("false");
  });

  it("reads a campaign back as normalized facts (sanitized errors, not the raw response)", async () => {
    const { adapter, stub } = adapterWith([{ status: 200, body: {
      sid: QE, account_sid: SUB, messaging_service_sid: MG, brand_registration_sid: BN, us_app_to_person_usecase: "MIXED", campaign_status: "FAILED", mock: false,
      errors: [{ fields: ["message_flow"], description: "Opt-in\u0007 flow\n unclear" }], description: "SECRET-ISH TEXT", auth_token: "nope",
    } }]);
    const facts = await adapter.getCampaign(MG, QE);
    expect(stub.calls[0].url).toBe(`https://messaging.twilio.com/v1/Services/${MG}/Compliance/Usa2p/${QE}`);
    expect(facts).toEqual({ sid: QE, account_sid: SUB, messaging_service_sid: MG, brand_registration_sid: BN, us_app_to_person_usecase: "MIXED", campaign_status: "FAILED", mock: false, errors: "message_flow; Opt-in flow unclear" });
    expect(JSON.stringify(facts)).not.toContain("SECRET");
  });

  it("classifies outcomes: a parsed 4xx is definite; network, 429/5xx, unreadable or SID-less success are transient (the resource may exist)", async () => {
    for (const [status, body, kind] of [[400, { code: 21715, message: "exists" }, "validation"], [401, { code: 20003, message: "auth" }, "account"], [429, {}, "transient"], [503, {}, "transient"],
      [201, "not json", "transient"], [201, { nothing: true }, "transient"]] as const) {
      const { adapter } = adapterWith([{ status, body }]);
      await expect(adapter.createMessagingService({ friendlyName: "n", inboundRequestUrl: "https://a.example/api/sms/twilio/inbound" }), String(status)).rejects.toMatchObject({ kind });
    }
    const thrown = createScopedProvisioningAdapter(config, SUB, "subtoken", PROD, async () => { throw new Error("socket"); });
    await expect(thrown.createMessagingService({ friendlyName: "n", inboundRequestUrl: "x" })).rejects.toMatchObject({ kind: "transient" });
  });

  it("refuses malformed SIDs before any request", async () => {
    const { adapter, stub } = adapterWith([]);
    await expect(adapter.getMessagingService("MGnot-a-sid")).rejects.toMatchObject({ kind: "validation" });
    await expect(adapter.getCampaign(MG, "QE1")).rejects.toMatchObject({ kind: "validation" });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("campaign request", () => {
  const args = { messagingServiceSid: MG, brandSid: BN, useCase: "MIXED" as const, displayName: "Harbor Dance", slug: "harbor-dance", origin: "https://www.idanceflow.com" };

  it("passes the package review, declares what it contains, and carries the keywords the inbound handler understands", () => {
    const request = buildCampaignRequest(args);
    expect(request.review.ok).toBe(true);
    expect(request.input).toMatchObject({ useCase: "MIXED", hasEmbeddedLinks: false, hasEmbeddedPhone: false, subscriberOptIn: true, ageGated: false, directLending: false });
    expect(request.input.optOutKeywords).toEqual(expect.arrayContaining(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]));
    expect(request.input.helpMessage).toContain("Harbor Dance");
    expect(request.input.messageSamples.every((sample) => /reply stop/i.test(sample) && /reply help/i.test(sample))).toBe(true);
  });

  it("the digest identifies the exact request: stable for the same input, different for another studio, use case or brand", () => {
    const base = buildCampaignRequest(args).digest;
    expect(buildCampaignRequest(args).digest).toBe(base);
    expect(buildCampaignRequest({ ...args, useCase: "LOW_VOLUME" }).digest).not.toBe(base);
    expect(buildCampaignRequest({ ...args, brandSid: `BN${"d".repeat(32)}` }).digest).not.toBe(base);
    expect(buildCampaignRequest({ ...args, slug: "other" }).digest).not.toBe(base);
    expect(requestDigest({ b: 1, a: 2 })).toBe(requestDigest({ a: 2, b: 1 }));
  });

  it("a studio without a slug or name fails review (the package is never submitted)", () => {
    expect(buildCampaignRequest({ ...args, slug: "" }).review.ok).toBe(false);
    expect(buildCampaignRequest({ ...args, displayName: "" }).review.ok).toBe(false);
  });
});

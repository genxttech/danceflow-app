import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));

import { runComplianceValidation } from "@/lib/sms/activation";
import type { IsvConfig } from "@/lib/sms/twilioIsv/config";
import { createScopedNumberAdapter, RealNumberReadAdapter } from "@/lib/sms/twilioIsv/real";
import { buildNumberReader } from "../numberReadRuntime";

/**
 * TW-4F A9b: activation's compliance validation reads (campaign compliance + service route) through the READ-ONLY number adapter, behind TW4_NUMBER_READS, so
 * activating or reactivating a location never requires the purchase switch (TW4_NUMBER_REAL_CALLS). With reads on and purchases off the two GETs work, with the
 * same request shapes and normalized facts as the purchase-capable adapter, while purchase, attach and release refuse; with both off nothing is built or called.
 * Injected fetch only; no live Twilio.
 */

const PARENT = `AC${"0".repeat(32)}`;
const SUB = `AC${"1".repeat(32)}`;
const MG = `MG${"a".repeat(32)}`;
const QE = `QE${"b".repeat(32)}`;
const config: IsvConfig = {
  accountSid: PARENT, authToken: "", apiKeySid: `SK${"d".repeat(32)}`, apiKeySecret: "e".repeat(32), primaryProfileSid: `BU${"1".repeat(32)}`, primaryProfilePolicySid: `RN${"1".repeat(32)}`,
  secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms@example.test", envName: "production", mockBrand: false,
};
const PROD = { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on" };
const READS = { ...PROD, TW4_NUMBER_READS: "on" };
const PURCHASE = { ...PROD, TW4_PROVISIONING_REAL_CALLS: "on", TW4_NUMBER_REAL_CALLS: "on" };

const CAMPAIGN = {
  sid: QE, account_sid: SUB, messaging_service_sid: MG, campaign_status: "VERIFIED", mock: false,
  opt_in_keywords: ["START"], opt_out_keywords: ["STOP", "END"], help_keywords: ["HELP"],
  opt_in_message: "You are subscribed.", opt_out_message: "You are unsubscribed.", help_message: "Reply STOP to opt out.",
};
const SERVICE = { sid: MG, account_sid: SUB, inbound_request_url: "https://www.idanceflow.com/api/sms/twilio/inbound", use_inbound_webhook_on_number: false };

function fetchStub(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const impl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const next = responses.shift() ?? { status: 500, body: {} };
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { calls, impl };
}
const auth = (headers: Record<string, string>) => Buffer.from(headers.Authorization.replace("Basic ", ""), "base64").toString();

describe("A9b: compliance reads through the read-only number adapter", () => {
  it("with reads ON and purchases OFF: both compliance reads are GETs, subaccount-signed, normalized exactly like the purchase adapter's", async () => {
    const stub = fetchStub([{ status: 200, body: CAMPAIGN }, { status: 200, body: SERVICE }]);
    const reader = RealNumberReadAdapter.forAccount(config, SUB, "subtoken", READS, stub.impl);
    const campaign = await reader.getCampaignCompliance(MG, QE);
    const route = await reader.getServiceRoute(MG);
    expect(stub.calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", `https://messaging.twilio.com/v1/Services/${MG}/Compliance/Usa2p/${QE}`],
      ["GET", `https://messaging.twilio.com/v1/Services/${MG}`],
    ]);
    for (const call of stub.calls) expect(auth(call.headers)).toBe(`${SUB}:subtoken`);   // never the parent key
    // the purchase-capable adapter (all switches on) returns the same facts for the same answers
    const ref = fetchStub([{ status: 200, body: CAMPAIGN }, { status: 200, body: SERVICE }]);
    const full = createScopedNumberAdapter(config, SUB, "subtoken", PURCHASE, ref.impl);
    expect(campaign).toEqual(await full.getCampaignCompliance(MG, QE));
    expect(route).toEqual(await full.getServiceRoute(MG));
    expect(ref.calls.map((c) => [c.method, c.url])).toEqual(stub.calls.map((c) => [c.method, c.url]));
  });

  it("refuses malformed service or campaign SIDs before any request", async () => {
    const stub = fetchStub([]);
    const reader = RealNumberReadAdapter.forAccount(config, SUB, "subtoken", READS, stub.impl);
    await expect(reader.getCampaignCompliance("MG123", QE)).rejects.toThrow();
    await expect(reader.getCampaignCompliance(MG, "QE../x")).rejects.toThrow();
    await expect(reader.getServiceRoute(`${MG}/PhoneNumbers`)).rejects.toThrow();
    expect(stub.calls).toHaveLength(0);
  });

  it("with reads ON and purchases OFF the same adapter still cannot purchase, attach or release, and the purchase adapter cannot be built", async () => {
    const stub = fetchStub([]);
    const reader = RealNumberReadAdapter.forAccount(config, SUB, "subtoken", READS, stub.impl);
    await expect(reader.purchaseNumber()).rejects.toThrow(/reads only: purchase/);
    await expect(reader.attachNumber()).rejects.toThrow(/reads only: attach/);
    for (const method of ["releaseNumber", "detachNumber", "deleteCampaign", "deleteMessagingService"]) expect(method in reader, method).toBe(false);
    expect(stub.calls).toHaveLength(0);
    expect(() => createScopedNumberAdapter(config, SUB, "subtoken", READS, stub.impl)).toThrow();
  });

  it("activation's runComplianceValidation runs end to end on the read-only adapter (reads on, purchases off) and records the provider facts", async () => {
    const stub = fetchStub([{ status: 200, body: CAMPAIGN }, { status: 200, body: SERVICE }]);
    const reader = RealNumberReadAdapter.forAccount(config, SUB, "subtoken", READS, stub.impl);
    const rpc: { fn: string; args: Record<string, unknown> }[] = [];
    const admin = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpc.push({ fn, args });
        if (fn === "tw4_act_check") return { data: { state: "ready_for_activation", items: [], ready: false, ledger: { account_sid: SUB, messaging_service_sid: MG, campaign_sid: QE } }, error: null };
        if (fn === "tw4_act_compliance_record") return { data: { outcome: "passed", codes: [] }, error: null };
        return { data: null, error: { code: "42883" } };
      },
    } as unknown as Pick<SupabaseClient, "rpc">;
    const out = await runComplianceValidation(admin as never, reader, { studioId: "s-1", actorId: "a-1", inboundUrl: SERVICE.inbound_request_url });
    expect(out).toEqual({ ok: true, data: { outcome: "passed", codes: [] } });
    const recorded = rpc.find((c) => c.fn === "tw4_act_compliance_record")?.args as { p_source: string; p_facts: { campaign: unknown; service: unknown } };
    expect(recorded.p_source).toBe("provider_read");
    expect(recorded.p_facts.campaign).toMatchObject({ sid: QE, opt_out_keywords: ["STOP", "END"] });
    expect(recorded.p_facts.service).toMatchObject({ sid: MG, inbound_request_url: SERVICE.inbound_request_url });
    expect(stub.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("buildNumberReader: both switches off, or reads on without configuration, builds nothing and calls nothing; the purchase switch alone never opens it", () => {
    const stub = fetchStub([]);
    expect(buildNumberReader({}, stub.impl)).toMatchObject({ ok: false });
    expect(buildNumberReader(PROD, stub.impl)).toMatchObject({ ok: false });
    expect(buildNumberReader(PURCHASE, stub.impl)).toMatchObject({ ok: false });
    expect(buildNumberReader(READS, stub.impl)).toMatchObject({ ok: false });   // no Twilio configuration in this test environment
    expect(stub.calls).toHaveLength(0);
  });
});

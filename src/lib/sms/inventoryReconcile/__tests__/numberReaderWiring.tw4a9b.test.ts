import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));

// ONLY the parent's token lookup is stubbed (it is the one network call the real builder makes that cannot be injected); everything else is the real code
const tokenLookups: string[] = [];
vi.mock("@/lib/sms/twilioIsv/real", async (orig) => {
  const actual = await orig<typeof import("@/lib/sms/twilioIsv/real")>();
  return {
    ...actual,
    createRealIsvParent: () => ({
      getSubaccountToken: async (accountSid: string) => {
        tokenLookups.push(accountSid);
        return "subtoken";
      },
    }),
  };
});

import { activationProviderReads, complianceReadRuntime, runComplianceValidation } from "@/lib/sms/activation";
import { RealNumberReadAdapter } from "@/lib/sms/twilioIsv/real";
import { buildNumberReader } from "../numberReadRuntime";

/**
 * TW-4F A9b: the REAL wiring of the read-only number reader, with full configuration and TW4_NUMBER_READS on (purchases off): buildNumberReader returns the
 * read-only adapter built through rotation with the SUBACCOUNT's token, and activation's compliance runtime uses exactly that, end to end. Injected fetch
 * only; the parent token lookup is stubbed; no live Twilio.
 */

const SUB = `AC${"1".repeat(32)}`;
const MG = `MG${"a".repeat(32)}`;
const QE = `QE${"b".repeat(32)}`;
const CONFIGURED = {
  VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on", TW4_NUMBER_READS: "on",
  TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`, TWILIO_ISV_API_KEY_SID: `SK${"d".repeat(32)}`, TWILIO_ISV_API_KEY_SECRET: "e".repeat(32),
  TWILIO_ISV_PRIMARY_PROFILE_SID: `BU${"1".repeat(32)}`, TWILIO_ISV_PRIMARY_POLICY_SID: `RN${"1".repeat(32)}`, TWILIO_ISV_SECONDARY_POLICY_SID: `RN${"2".repeat(32)}`,
  TWILIO_ISV_A2P_POLICY_SID: `RN${"3".repeat(32)}`, TWILIO_ISV_COMPLIANCE_EMAIL: "sms@example.test",
};

function fetchStub(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const impl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const next = responses.shift() ?? { status: 500, body: {} };
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { calls, impl };
}

describe("A9b: the real read-only reader wiring (full configuration, reads on, purchases off)", () => {
  it("buildNumberReader returns mode real and a RealNumberReadAdapter signed with the subaccount's token; writes still refuse", async () => {
    const stub = fetchStub([{ status: 200, body: { sid: MG, account_sid: SUB, inbound_request_url: "https://x/api/sms/twilio/inbound", use_inbound_webhook_on_number: false } }]);
    const reader = buildNumberReader(CONFIGURED, stub.impl);
    expect(reader.ok && reader.mode).toBe("real");
    if (!reader.ok) return;
    const adapter = await reader.adapterFor(SUB);
    expect(tokenLookups).toContain(SUB);
    expect(adapter.evidenceSource).toBe("provider_read");
    expect(await adapter.getServiceRoute(MG)).toMatchObject({ sid: MG, account_sid: SUB });
    expect(Buffer.from(stub.calls[0].headers.Authorization.replace("Basic ", ""), "base64").toString()).toBe(`${SUB}:subtoken`);
    await expect(adapter.purchaseNumber({ e164: "+12025550101", friendlyName: "x" })).rejects.toThrow(/reads only: purchase/);
    await expect(adapter.attachNumber({ messagingServiceSid: MG, phoneNumberSid: `PN${"c".repeat(32)}` })).rejects.toThrow(/reads only: attach/);
    expect(stub.calls).toHaveLength(1);
    expect(RealNumberReadAdapter.name).toBe("RealNumberReadAdapter");
  });

  it("activation's compliance runtime uses that real reader end to end: compliance passes with purchases off", async () => {
    const stub = fetchStub([
      { status: 200, body: { sid: QE, account_sid: SUB, messaging_service_sid: MG, campaign_status: "VERIFIED", mock: false, opt_in_keywords: ["START"], opt_out_keywords: ["STOP"], help_keywords: ["HELP"], opt_in_message: "in", opt_out_message: "out", help_message: "help" } },
      { status: 200, body: { sid: MG, account_sid: SUB, inbound_request_url: "https://x/api/sms/twilio/inbound", use_inbound_webhook_on_number: false } },
    ]);
    // complianceReadRuntime builds the reader from the environment; the fetch seam is the global fetch here
    const realFetch = globalThis.fetch;
    globalThis.fetch = stub.impl as unknown as typeof fetch;
    try {
      const runtime = complianceReadRuntime(CONFIGURED);
      expect(runtime.ok && runtime.mode).toBe("real");
      expect(activationProviderReads(CONFIGURED).compliance).toEqual({ enabled: true, reason: null });   // the console agrees with the reader
      if (!runtime.ok) return;
      const adapter = await runtime.adapterFor(SUB);
      expect(Object.keys(adapter).sort()).toEqual(["accountSid", "evidenceSource", "getCampaignCompliance", "getServiceRoute"]);
      const rpc: string[] = [];
      const db = {
        rpc: async (fn: string) => {
          rpc.push(fn);
          if (fn === "tw4_act_check") return { data: { state: "ready_for_activation", items: [], ready: false, ledger: { account_sid: SUB, messaging_service_sid: MG, campaign_sid: QE } }, error: null };
          return { data: { outcome: "passed", codes: [] }, error: null };
        },
      } as unknown as Pick<SupabaseClient, "rpc">;
      expect(await runComplianceValidation(db as never, adapter, { studioId: "s-1", actorId: "a-1", inboundUrl: "https://x/api/sms/twilio/inbound" })).toEqual({ ok: true, data: { outcome: "passed", codes: [] } });
      expect(rpc).toEqual(["tw4_act_check", "tw4_act_compliance_record"]);
      expect(stub.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

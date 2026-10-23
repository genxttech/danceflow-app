import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));

// the real reader by default; a test may substitute one whose adapters use an injected fetch (the parent-token fetch of the real builder is not injectable)
const readerOverride: { value: unknown } = { value: null };
const readerEnvs: Record<string, string | undefined>[] = [];
vi.mock("@/lib/sms/inventoryReconcile/numberReadRuntime", async (orig) => {
  const actual = await orig<typeof import("@/lib/sms/inventoryReconcile/numberReadRuntime")>();
  return {
    ...actual,
    buildNumberReader: (env: Record<string, string | undefined>) => {
      readerEnvs.push(env);
      return readerOverride.value ?? actual.buildNumberReader(env);
    },
  };
});

import { activationProviderReads, complianceReadRuntime, runComplianceValidation } from "../activation";
import type { IsvConfig } from "../twilioIsv/config";
import { RealNumberReadAdapter } from "../twilioIsv/real";

/**
 * TW-4F A9b: activation's compliance reads go through the READ-ONLY number reader (TW4_NUMBER_READS), never the purchase switch. With reads on and purchases
 * off, compliance validation passes end to end on a read-only adapter that still exposes only the two GET reads; turning purchases on alone enables nothing;
 * with both off nothing is built or called. Injected fetch only; no live Twilio.
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
const PURCHASE_ONLY = { ...PROD, TW4_PROVISIONING_REAL_CALLS: "on", TW4_NUMBER_REAL_CALLS: "on" };
const INBOUND = "https://www.idanceflow.com/api/sms/twilio/inbound";

function fetchStub(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; method: string }[] = [];
  const impl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method });
    const next = responses.shift() ?? { status: 500, body: {} };
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { calls, impl };
}
const db = () => {
  const calls: string[] = [];
  const client = {
    calls,
    rpc: async (fn: string) => {
      calls.push(fn);
      if (fn === "tw4_act_check") return { data: { state: "ready_for_activation", items: [], ready: false, ledger: { account_sid: SUB, messaging_service_sid: MG, campaign_sid: QE } }, error: null };
      if (fn === "tw4_act_compliance_record") return { data: { outcome: "passed", codes: [] }, error: null };
      return { data: null, error: { code: "42883" } };
    },
  };
  return client as unknown as Pick<SupabaseClient, "rpc"> & { calls: string[] };
};

afterEach(() => {
  readerOverride.value = null;
  readerEnvs.length = 0;
});

describe("A9b: activation compliance reads need TW4_NUMBER_READS, never the purchase switch", () => {
  it("reads ON + purchases OFF: compliance validation passes end to end on the read-only reader, narrowed to the two GET reads", async () => {
    const stub = fetchStub([
      { status: 200, body: { sid: QE, account_sid: SUB, messaging_service_sid: MG, campaign_status: "VERIFIED", mock: false, opt_in_keywords: ["START"], opt_out_keywords: ["STOP"], help_keywords: ["HELP"], opt_in_message: "in", opt_out_message: "out", help_message: "help" } },
      { status: 200, body: { sid: MG, account_sid: SUB, inbound_request_url: INBOUND, use_inbound_webhook_on_number: false } },
    ]);
    readerOverride.value = { ok: true, mode: "real", adapterFor: async (account: string) => RealNumberReadAdapter.forAccount(config, account, "subtoken", READS, stub.impl) };
    const runtime = complianceReadRuntime(READS);
    expect(runtime.ok && runtime.mode).toBe("real");
    expect(readerEnvs).toEqual([READS]);
    if (!runtime.ok) return;
    const adapter = await runtime.adapterFor(SUB);
    // J4's readOnly() narrowing still applies: only the identity and the two GET reads are reachable
    expect(Object.keys(adapter).sort()).toEqual(["accountSid", "evidenceSource", "getCampaignCompliance", "getServiceRoute"]);
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(adapter.evidenceSource).toBe("provider_read");
    const client = db();
    expect(await runComplianceValidation(client, adapter, { studioId: "s-1", actorId: "a-1", inboundUrl: INBOUND })).toEqual({ ok: true, data: { outcome: "passed", codes: [] } });
    expect(client.calls).toEqual(["tw4_act_check", "tw4_act_compliance_record"]);
    expect(stub.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("a subaccount whose token cannot be obtained rejects (the action turns it into provider_read_failed), never a pass", async () => {
    readerOverride.value = { ok: true, mode: "real", adapterFor: async () => { throw new Error("no subaccount token"); } };
    const runtime = complianceReadRuntime(READS);
    expect(runtime.ok).toBe(true);
    if (runtime.ok) await expect(runtime.adapterFor(SUB)).rejects.toThrow();
  });

  it("an adapter of another account is refused before any provider read (the ledger check is unchanged)", async () => {
    const stub = fetchStub([]);
    const other = `AC${"7".repeat(32)}`;
    readerOverride.value = { ok: true, mode: "real", adapterFor: async (account: string) => RealNumberReadAdapter.forAccount(config, account, "subtoken", READS, stub.impl) };
    const runtime = complianceReadRuntime(READS);
    if (!runtime.ok) throw new Error("expected a reader");
    const client = db();
    expect(await runComplianceValidation(client, await runtime.adapterFor(other), { studioId: "s-1", actorId: "a-1", inboundUrl: INBOUND })).toEqual({ ok: false, code: "account_mismatch" });
    expect(stub.calls).toHaveLength(0);
  });

  it("purchases ON alone (no TW4_NUMBER_READS) builds no compliance reader and the console reports compliance disabled", () => {
    expect(complianceReadRuntime(PURCHASE_ONLY)).toMatchObject({ ok: false });
    expect(activationProviderReads(PURCHASE_ONLY).compliance.enabled).toBe(false);
  });

  it("both off: nothing is built or called; reads on without configuration is still refused", () => {
    expect(complianceReadRuntime(PROD)).toMatchObject({ ok: false });
    expect(complianceReadRuntime({ NODE_ENV: "test" })).toMatchObject({ ok: false });
    expect(complianceReadRuntime(READS)).toMatchObject({ ok: false });   // no Twilio configuration in this test environment
    expect(activationProviderReads(PROD).compliance.enabled).toBe(false);
    expect(activationProviderReads(READS).compliance).toEqual({ enabled: true, reason: null });   // the console explanation follows the read gate
  });

  it("the local fake stays behind fakeAdapterAllowed and is narrowed the same way", async () => {
    const local = { NODE_ENV: "development", TW4_ISV_FAKE: "on", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" };
    const runtime = complianceReadRuntime(local);
    expect(runtime.ok && runtime.mode).toBe("fake");
    expect(readerEnvs).toEqual([]);   // the fake path never builds the real reader
    if (runtime.ok) expect(Object.keys(await runtime.adapterFor(SUB)).sort()).toEqual(["accountSid", "evidenceSource", "getCampaignCompliance", "getServiceRoute"]);
    expect(complianceReadRuntime({ NODE_ENV: "development", TW4_ISV_FAKE: "on", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" })).toMatchObject({ ok: false });
  });
});

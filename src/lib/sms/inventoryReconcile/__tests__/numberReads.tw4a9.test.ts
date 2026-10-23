import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));

import { numberCallsAllowed, numberReadsAllowed, provisioningCallsAllowed, type IsvConfig } from "@/lib/sms/twilioIsv/config";
import { buildNumberRuntime } from "@/lib/sms/twilioIsv/factory";
import { buildNumberReadRuntime } from "../numberReadRuntime";
import { createScopedNumberAdapter, RealNumberAdapter, RealNumberReadAdapter } from "@/lib/sms/twilioIsv/real";
import { IsvApiError } from "@/lib/sms/twilioIsv/types";

/**
 * TW-4F A9: the READ-ONLY number gate. Scheduled inventory listings must never require the purchase switch (TW4_NUMBER_REAL_CALLS): with TW4_NUMBER_READS on and the
 * purchase switch off, the list-only adapter can list a subaccount's numbers and EVERY purchase / attach path refuses; with both off nothing is constructed or called.
 * Injected fetch only; no live Twilio.
 */

const PARENT = `AC${"0".repeat(32)}`;
const SUB = `AC${"1".repeat(32)}`;
const PN = `PN${"c".repeat(32)}`;
const config: IsvConfig = {
  accountSid: PARENT, authToken: "", apiKeySid: `SK${"d".repeat(32)}`, apiKeySecret: "e".repeat(32), primaryProfileSid: `BU${"1".repeat(32)}`, primaryProfilePolicySid: `RN${"1".repeat(32)}`,
  secondaryProfilePolicySid: `RN${"2".repeat(32)}`, a2pPolicySid: `RN${"3".repeat(32)}`, complianceEmail: "sms@example.test", envName: "production", mockBrand: false,
};
const PROD = { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on" };
const READS = { ...PROD, TW4_NUMBER_READS: "on" };

function fetchStub(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const impl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const next = responses.shift() ?? { status: 500, body: {} };
    return { status: next.status, text: async () => JSON.stringify(next.body) };
  };
  return { calls, impl };
}

describe("TW4_NUMBER_READS: a read-only gate independent of the purchase switch", () => {
  it("is off by default and needs production, a production build, TW4_ISV_REAL_CALLS and TW4_NUMBER_READS", () => {
    expect(numberReadsAllowed({}).allowed).toBe(false);
    expect(numberReadsAllowed(PROD).allowed).toBe(false);
    expect(numberReadsAllowed({ ...READS, NODE_ENV: "development" }).allowed).toBe(false);
    expect(numberReadsAllowed({ ...READS, VERCEL_ENV: "preview" }).allowed).toBe(false);
    expect(numberReadsAllowed({ ...READS, TW4_ISV_REAL_CALLS: "off" }).allowed).toBe(false);
    expect(numberReadsAllowed(READS).allowed).toBe(true);
  });

  it("READS on does not arm provisioning or purchases, and the purchase switch does not open reads", () => {
    expect(provisioningCallsAllowed(READS).allowed).toBe(false);
    expect(numberCallsAllowed(READS).allowed).toBe(false);
    const purchaseOnly = { ...PROD, TW4_PROVISIONING_REAL_CALLS: "on", TW4_NUMBER_REAL_CALLS: "on" };
    expect(numberCallsAllowed(purchaseOnly).allowed).toBe(true);
    expect(numberReadsAllowed(purchaseOnly).allowed).toBe(false);
  });

  it("with READS on and the purchase switch off: the list-only adapter lists (GET, subaccount-signed); the purchase adapter and runtime refuse", async () => {
    const stub = fetchStub([{ status: 200, body: { incoming_phone_numbers: [{ sid: PN, phone_number: "+12025550101" }], next_page_uri: null } }]);
    const reader = RealNumberReadAdapter.forAccount(config, SUB, "subtoken", READS, stub.impl);
    expect(await reader.listIncomingNumbers()).toEqual([{ sid: PN, phone_number: "+12025550101" }]);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe("GET");
    expect(stub.calls[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB}/IncomingPhoneNumbers.json?PageSize=1000`);
    expect(Buffer.from(stub.calls[0].headers.Authorization.replace("Basic ", ""), "base64").toString()).toBe(`${SUB}:subtoken`);   // never the parent key
    expect(() => RealNumberAdapter.forAccount(config, SUB, "subtoken", READS, stub.impl)).toThrow(IsvApiError);
    expect(() => createScopedNumberAdapter(config, SUB, "subtoken", READS, stub.impl)).toThrow(IsvApiError);
    expect(buildNumberRuntime(READS).ok).toBe(false);
  });

  it("every purchase, attach or other non-read number call on the read-only adapter refuses BEFORE any network call", async () => {
    const stub = fetchStub([]);
    const reader = RealNumberReadAdapter.forAccount(config, SUB, "subtoken", READS, stub.impl);
    // the three reads it allows (listing, campaign compliance, service route) are pinned in this file and in numberCompliance.tw4a9b.test.ts
    const attempts: Array<() => Promise<unknown>> = [
      () => reader.purchaseNumber(),
      () => reader.attachNumber(),
      () => reader.searchAvailableNumbers(),
      () => reader.findOwnedNumbers(),
      () => reader.getNumber(),
      () => reader.listServiceNumbers(),
      () => reader.getServiceNumbers(),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow(/number inventory reads only/);
    expect(stub.calls).toHaveLength(0);
    expect("readCreationHistory" in reader).toBe(false);
  });

  it("even with TW4_NUMBER_READS=on (and every other switch on) the read adapter cannot purchase, attach, search or release: the only request it ever makes is the GET listing", async () => {
    const everything = { ...READS, TW4_PROVISIONING_REAL_CALLS: "on", TW4_NUMBER_REAL_CALLS: "on" };
    const stub = fetchStub([{ status: 200, body: { incoming_phone_numbers: [], next_page_uri: null } }]);
    const reader = RealNumberReadAdapter.forAccount(config, SUB, "subtoken", everything, stub.impl);
    await expect(reader.purchaseNumber()).rejects.toThrow(/reads only: purchase/);
    await expect(reader.attachNumber()).rejects.toThrow(/reads only: attach/);
    await expect(reader.searchAvailableNumbers()).rejects.toThrow(/reads only: search/);
    // no release, detach or delete exists on it (F5 #279's release adapters are separate types, built behind their own gate)
    for (const method of ["releaseNumber", "detachNumber", "numberPresence", "deleteCampaign", "deleteMessagingService", "readCreationHistory"]) {
      expect(method in reader, method).toBe(false);
    }
    await reader.listIncomingNumbers();
    expect(stub.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("only real.ts reaches Twilio: the inventory-reconcile modules and route have no network call, Twilio host or credential read", () => {
    const files = [
      ...readdirSync(join(__dirname, "..")).filter((n) => n.endsWith(".ts")).map((n) => join(__dirname, "..", n)),
      join(process.cwd(), "src/app/api/cron/sms-inventory-reconcile/route.ts"),
    ];
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, file).not.toMatch(/\bfetch\s*\(/);
      expect(code, file).not.toMatch(/twilio\.com|trusthub|from "twilio"|require\("twilio"\)/i);
      expect(code, file).not.toMatch(/process\.env\.TWILIO/);
    }
  });

  it("an incomplete listing is never returned as complete", async () => {
    const stub = fetchStub([{ status: 200, body: { incoming_phone_numbers: [], next_page_uri: "/next" } }, { status: 200, body: { incoming_phone_numbers: [{ sid: "bad" }] } }, { status: 200, body: {} }]);
    const reader = RealNumberReadAdapter.forAccount(config, SUB, "subtoken", READS, stub.impl);
    await expect(reader.listIncomingNumbers()).rejects.toThrow(IsvApiError);
    await expect(reader.listIncomingNumbers()).rejects.toThrow(IsvApiError);
    await expect(reader.listIncomingNumbers()).rejects.toThrow(IsvApiError);
  });

  it("refuses the parent account, a malformed SID and a missing credential", () => {
    const stub = fetchStub([]);
    expect(() => RealNumberReadAdapter.forAccount(config, PARENT, "t", READS, stub.impl)).toThrow(IsvApiError);
    expect(() => RealNumberReadAdapter.forAccount(config, "AC123", "t", READS, stub.impl)).toThrow(IsvApiError);
    expect(() => RealNumberReadAdapter.forAccount(config, SUB, "", READS, stub.impl)).toThrow(IsvApiError);
    expect(() => RealNumberReadAdapter.forAccount(config, SUB, "t", PROD, stub.impl)).toThrow(IsvApiError);
  });

  it("both switches off: the read runtime constructs nothing and calls nothing; READS on without configuration is still refused", () => {
    const stub = fetchStub([]);
    expect(buildNumberReadRuntime(PROD, stub.impl)).toMatchObject({ ok: false });
    expect(buildNumberReadRuntime({}, stub.impl)).toMatchObject({ ok: false });
    expect(buildNumberReadRuntime(READS, stub.impl)).toMatchObject({ ok: false });   // no Twilio configuration in this environment
    expect(stub.calls).toHaveLength(0);
  });
});

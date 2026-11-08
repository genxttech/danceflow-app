import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));

import { buildRunnerRuntime } from "../factory";
import { FakeIsvAdapter, FakeIsvParent } from "../fake";
import { RealIsvParent } from "../real";

const full = {
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`, TWILIO_AUTH_TOKEN: "tok", TWILIO_ISV_PRIMARY_PROFILE_SID: `BU${"e".repeat(32)}`,
  TWILIO_ISV_PRIMARY_POLICY_SID: `RN${"4".repeat(32)}`, TWILIO_ISV_SECONDARY_POLICY_SID: `RN${"2".repeat(32)}`, TWILIO_ISV_A2P_POLICY_SID: `RN${"3".repeat(32)}`, TWILIO_ISV_COMPLIANCE_EMAIL: "sms-compliance@isv.example",
};

describe("buildRunnerRuntime", () => {
  it("DEV, preview and test environments get no real adapter, even with credentials and the switch set", () => {
    for (const env of [{ ...full, TW4_ISV_REAL_CALLS: "on" }, { ...full, VERCEL_ENV: "preview", TW4_ISV_REAL_CALLS: "on" }, { ...full, NODE_ENV: "test", TW4_ISV_REAL_CALLS: "on" }]) {
      const result = buildRunnerRuntime(env);
      expect(result.ok).toBe(false);
    }
  });
  it("production without the explicit switch is refused; with the switch but incomplete configuration it names only the missing variables", () => {
    expect(buildRunnerRuntime({ ...full, VERCEL_ENV: "production", NODE_ENV: "production" }).ok).toBe(false);
    expect(buildRunnerRuntime({ ...full, VERCEL_ENV: "production", TW4_ISV_REAL_CALLS: "on", NODE_ENV: "development" }).ok).toBe(false); // pulled production variables on a dev machine
    const incomplete = buildRunnerRuntime({ VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on", TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}` });
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) {
      expect(incomplete.reason).toContain("TWILIO_AUTH_TOKEN");
      expect(incomplete.reason).not.toContain("1111");
    }
  });
  it("production with the switch and complete configuration builds the real adapter", () => {
    const result = buildRunnerRuntime({ ...full, VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("real");
      expect(result.parent).toBeInstanceOf(RealIsvParent);
      expect("adapter" in result).toBe(false); // TW-4F-3a: no adapter for the parent account exists, only adapterFor(subaccountSid)
      expect(typeof result.adapterFor).toBe("function");
      expect(result.config.mockBrand).toBe(false);
    }
  });
  it("the fake is available only outside production and only when asked for, and it is shared within the process", async () => {
    const local = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" };
    expect(buildRunnerRuntime({ ...local, VERCEL_ENV: "production", TW4_ISV_FAKE: "on" }).ok).toBe(false);
    expect(buildRunnerRuntime({ NEXT_PUBLIC_SUPABASE_URL: "https://shared-dev.supabase.co", NODE_ENV: "development", TW4_ISV_FAKE: "on" }).ok).toBe(false); // never against a shared database
    const a = buildRunnerRuntime({ ...local, NODE_ENV: "development", TW4_ISV_FAKE: "on" });
    const b = buildRunnerRuntime({ ...local, NODE_ENV: "development", TW4_ISV_FAKE: "on" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.mode).toBe("fake");
      expect(a.parent).toBeInstanceOf(FakeIsvParent);
      expect(a.parent).toBe(b.parent);
      const one = await a.adapterFor(`AC${"a".repeat(32)}`);
      const two = await a.adapterFor(`AC${"b".repeat(32)}`);
      expect(one).toBeInstanceOf(FakeIsvAdapter);
      expect(one.accountSid).toBe(`AC${"a".repeat(32)}`);
      expect(await b.adapterFor(`AC${"a".repeat(32)}`)).toBe(one); // the same account is the same fake account
      expect(two).not.toBe(one); // different accounts are isolated
      expect(a.config.mockBrand).toBe(false);
    }
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }) }));

import { FAKE_NUMBER_CATALOGUE, buildNumberRuntime, buildSubaccountAdaptersFor, buildProvisioningRuntime, fakeNumberHub, fakeProvisioningHub } from "../factory";
import { FakeNumberAdapter } from "../fakeNumbers";
import { FakeProvisioningAdapter } from "../fakeProvisioning";

const full = {
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`, TWILIO_AUTH_TOKEN: "tok", TWILIO_ISV_PRIMARY_PROFILE_SID: `BU${"e".repeat(32)}`,
  TWILIO_ISV_PRIMARY_POLICY_SID: `RN${"4".repeat(32)}`, TWILIO_ISV_SECONDARY_POLICY_SID: `RN${"2".repeat(32)}`, TWILIO_ISV_A2P_POLICY_SID: `RN${"3".repeat(32)}`, TWILIO_ISV_COMPLIANCE_EMAIL: "sms-compliance@isv.example",
};
const prod = { ...full, VERCEL_ENV: "production", NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "https://www.idanceflow.com" };
const local = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321", NODE_ENV: "development", TW4_ISV_FAKE: "on" };
const all = { TW4_ISV_REAL_CALLS: "on", TW4_PROVISIONING_REAL_CALLS: "on", TW4_NUMBER_REAL_CALLS: "on" };

describe("TW-4F J1: provisioning and number runtimes", () => {
  it("never real outside a production deployment AND a production build, whatever the switches", () => {
    for (const env of [{ ...full, ...all }, { ...full, ...all, VERCEL_ENV: "preview", NODE_ENV: "production" }, { ...full, ...all, NODE_ENV: "test" }, { ...prod, ...all, NODE_ENV: "development" }]) {
      expect(buildProvisioningRuntime(env).ok).toBe(false);
      expect(buildNumberRuntime(env).ok).toBe(false);
    }
  });

  it("each switch is separate: registration alone opens neither; provisioning opens R2a only; numbers need their own switch too", () => {
    const reg = { ...prod, TW4_ISV_REAL_CALLS: "on" };
    const regResult = buildProvisioningRuntime(reg);
    expect(regResult.ok).toBe(false);
    if (!regResult.ok) expect(regResult.reason).toMatch(/provisioning calls are switched off/);
    const prov = { ...reg, TW4_PROVISIONING_REAL_CALLS: "on" };
    expect(buildProvisioningRuntime(prov).ok).toBe(true);
    const num = buildNumberRuntime(prov);
    expect(num.ok).toBe(false);
    if (!num.ok) expect(num.reason).toMatch(/number purchase calls are switched off/);
    expect(buildNumberRuntime({ ...prov, TW4_NUMBER_REAL_CALLS: "on" }).ok).toBe(true);
    // the number switch alone opens nothing
    expect(buildNumberRuntime({ ...prod, TW4_NUMBER_REAL_CALLS: "on" }).ok).toBe(false);
  });

  it("real mode with every switch: scoped real adapters (built only on use), the https inbound route; an incomplete configuration names only variable names", () => {
    const result = buildProvisioningRuntime({ ...prod, ...all });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("real");
      expect(result.inboundUrl).toBe("https://www.idanceflow.com/api/sms/twilio/inbound");
      expect(result.origin).toBe("https://www.idanceflow.com");
      expect(result.envName).toBe("production");
      expect(typeof result.adapterFor).toBe("function");
    }
    const http = buildProvisioningRuntime({ ...prod, ...all, NEXT_PUBLIC_APP_URL: "http://www.idanceflow.com" });
    expect(http.ok && http.inboundUrl).toBeNull(); // the runner then refuses (config_missing) before any call
    const incomplete = buildNumberRuntime({ VERCEL_ENV: "production", NODE_ENV: "production", ...all, TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}` });
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) {
      expect(incomplete.reason).toContain("TWILIO_AUTH_TOKEN");
      expect(incomplete.reason).not.toContain("1111");
    }
  });

  it("the fake: only outside production, only on a loopback database, shared within the process, one fake account per subaccount", async () => {
    expect(buildProvisioningRuntime({ ...local, VERCEL_ENV: "production" }).ok).toBe(false);
    expect(buildNumberRuntime({ ...local, NEXT_PUBLIC_SUPABASE_URL: "https://shared-dev.supabase.co" }).ok).toBe(false);
    expect(fakeProvisioningHub({ ...local, VERCEL_ENV: "production" })).toBeNull();
    expect(fakeNumberHub({})).toBeNull();
    const a = buildProvisioningRuntime(local);
    const b = buildProvisioningRuntime(local);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.mode).toBe("fake");
    const one = await a.adapterFor(`AC${"a".repeat(32)}`);
    expect(one).toBeInstanceOf(FakeProvisioningAdapter);
    expect(one.evidenceSource).toBe("fake");
    expect(await b.adapterFor(`AC${"a".repeat(32)}`)).toBe(one);
    expect(await a.adapterFor(`AC${"b".repeat(32)}`)).not.toBe(one);
    // a local http app origin cannot be an inbound route: the fake uses a reserved, unroutable https name
    expect(a.inboundUrl).toBe("https://danceflow-local.invalid/api/sms/twilio/inbound");
    expect(buildProvisioningRuntime({ ...local, NEXT_PUBLIC_APP_URL: "https://app.example.test" }).ok && buildProvisioningRuntime({ ...local, NEXT_PUBLIC_APP_URL: "https://app.example.test" })).toMatchObject({ inboundUrl: "https://app.example.test/api/sms/twilio/inbound" });
  });

  it("buildSubaccountAdaptersFor: each kind under its own gate (the release extension point); fake mode shares the provisioning fakes", async () => {
    const off = await buildSubaccountAdaptersFor({ NODE_ENV: "development" })(`AC${"e".repeat(32)}`);
    expect(off).toEqual({ numbers: null, provisioning: null });
    const provOnly = buildSubaccountAdaptersFor({ ...prod, TW4_ISV_REAL_CALLS: "on", TW4_PROVISIONING_REAL_CALLS: "on" });
    expect(typeof provOnly).toBe("function"); // real adapters are not constructed here: that would read a subaccount token from the parent
    const fake = await buildSubaccountAdaptersFor(local)(`AC${"e".repeat(32)}`);
    expect(fake.numbers).toBeInstanceOf(FakeNumberAdapter);
    expect(fake.provisioning).toBe(fakeProvisioningHub(local)!.adapterFor(`AC${"e".repeat(32)}`));
  });

  it("the fake number provider sees the fake Messaging Service and campaign of the same account, and offers the seeded catalogue", async () => {
    const prov = buildProvisioningRuntime(local);
    const nums = buildNumberRuntime(local);
    expect(prov.ok && nums.ok).toBe(true);
    if (!prov.ok || !nums.ok) return;
    const sid = `AC${"c".repeat(32)}`;
    const p = (await prov.adapterFor(sid)) as FakeProvisioningAdapter;
    const mg = await p.createMessagingService({ friendlyName: "df:development:s:ms:1", inboundRequestUrl: prov.inboundUrl! });
    const n = (await nums.adapterFor(sid)) as FakeNumberAdapter;
    expect(n).toBeInstanceOf(FakeNumberAdapter);
    expect((await n.getServiceRoute(mg)).inbound_request_url).toBe(prov.inboundUrl);
    expect((await n.searchAvailableNumbers({ limit: 10 })).map((x) => x.e164)).toEqual([...FAKE_NUMBER_CATALOGUE]);
    // another account's service is invisible
    const other = (await nums.adapterFor(`AC${"d".repeat(32)}`)) as FakeNumberAdapter;
    await expect(other.getServiceRoute(mg)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async () => ({ data: null, error: { code: "42883" } }) }) }));

import { cancelReleaseAvailable, cancelReleaseRuntime, installedCancelTargets, parseCancelTarget, sharedFakeReleaseHubs, SupabaseCancelTargetSource } from "../cancelRuntime";
import type { CancelTargetSource } from "../cancelRunner";

const OP = "e0000001-0000-4000-8000-000000000001";

/** TW-4F F5: when may the panel offer provider release? Every switch must hold; production stays manual in this slice. */

const targets: CancelTargetSource = { target: async () => null };
const LOCAL = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", TW4_ISV_FAKE: "on", TW4_CANCEL_RELEASE: "on" };
const PROD = { VERCEL_ENV: "production", NODE_ENV: "production", TW4_ISV_REAL_CALLS: "on", TW4_PROVISIONING_REAL_CALLS: "on", TW4_NUMBER_REAL_CALLS: "on", TW4_CANCEL_RELEASE: "on" };

describe("F5 cancel release runtime", () => {
  it("is off by default; production stays manual (no real adapters are wired by this slice)", () => {
    expect(installedCancelTargets()).not.toBeNull();
    expect(cancelReleaseAvailable({})).toBe(false);
    expect(cancelReleaseAvailable({ ...LOCAL, TW4_CANCEL_RELEASE: undefined })).toBe(false);
    expect(cancelReleaseAvailable(PROD)).toBe(false);
    expect(cancelReleaseRuntime(LOCAL, { targets: null })).toMatchObject({ ok: false, reason: expect.stringContaining("not installed") });
    expect(cancelReleaseRuntime(LOCAL)).toMatchObject({ ok: true, mode: "fake" });
  });

  it("the database target source fails closed: a missing function, a refusal or an unexpected shape is no target", async () => {
    const source = (reply: { data: unknown; error: unknown }) => new SupabaseCancelTargetSource({ rpc: async () => reply });
    expect(await source({ data: null, error: { code: "PGRST202" } }).target(OP, OP)).toBeNull();
    expect(await source({ data: null, error: { code: "42501" } }).target(OP, OP)).toBeNull();
    expect(await source({ data: null, error: null }).target(OP, OP)).toBeNull();
    const good = {
      operation_id: OP, resource_id: OP, operation_status: "authorized", kind: "number", provider_state: "active", provider_sid: `PN${"1".repeat(32)}`, account_sid: `AC${"2".repeat(32)}`,
      messaging_service_sid: null, live_dependents: 0, dual_control: { request_id: OP, resource_id: OP, requested_by: OP, decided_by: OP, status: "consumed" },
    };
    expect(await source({ data: good, error: null }).target(OP, OP)).toMatchObject({ kind: "number", dualControl: { status: "consumed", resourceId: OP } });
    expect(parseCancelTarget({ ...good, kind: "other" })).toBeNull();
    expect(parseCancelTarget({ ...good, provider_state: "cancelled" })).toBeNull();
    expect(parseCancelTarget({ ...good, live_dependents: "0" })).toBeNull();
    expect(parseCancelTarget({ ...good, dual_control: { request_id: OP } })).toBeNull();
    expect(parseCancelTarget([good])).toBeNull();
  });

  it("a number is released through supplied real adapters only where the number gate is on too", async () => {
    const numbersOnly = { numbers: { accountSid: "x" } as never, provisioning: null };
    const noNumberGate = cancelReleaseRuntime({ ...PROD, TW4_NUMBER_REAL_CALLS: undefined }, { targets, realAdaptersFor: async () => numbersOnly });
    expect(noNumberGate.ok).toBe(true);
    // the runner sees no number adapter: a number target is refused before any claim
    const runner = noNumberGate.ok ? noNumberGate.runner : null;
    const deps = (runner as unknown as { deps: { adaptersFor(a: string): Promise<{ numbers: unknown }> } }).deps;
    expect((await deps.adaptersFor("AC")).numbers).toBeNull();
    const withGate = cancelReleaseRuntime(PROD, { targets, realAdaptersFor: async () => numbersOnly });
    const deps2 = (withGate.ok ? withGate.runner : null) as unknown as { deps: { adaptersFor(a: string): Promise<{ numbers: unknown }> } };
    expect((await deps2.deps.adaptersFor("AC")).numbers).not.toBeNull();
  });

  it("needs its own explicit switch, whatever else is configured", () => {
    expect(cancelReleaseRuntime({ ...LOCAL, TW4_CANCEL_RELEASE: undefined }, { targets })).toMatchObject({ ok: false, reason: expect.stringContaining("switched off") });
    expect(cancelReleaseRuntime({ ...LOCAL, TW4_CANCEL_RELEASE: "true" }, { targets }).ok).toBe(false);
  });

  it("uses the local fakes only on a local QA database with TW4_ISV_FAKE=on", () => {
    expect(cancelReleaseRuntime(LOCAL, { targets })).toMatchObject({ ok: true, mode: "fake" });
    expect(cancelReleaseRuntime({ ...LOCAL, NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" }, { targets }).ok).toBe(false);
    expect(cancelReleaseRuntime({ ...LOCAL, TW4_ISV_FAKE: undefined }, { targets }).ok).toBe(false);
    expect(sharedFakeReleaseHubs().numbers).toBe(sharedFakeReleaseHubs().numbers);
  });

  it("never builds a real adapter itself: production is available only with adapters the platform runtime supplies", () => {
    expect(cancelReleaseRuntime(PROD, { targets })).toMatchObject({ ok: false, reason: expect.stringContaining("No provider release adapter") });
    const supplied = vi.fn(async () => ({ numbers: null, provisioning: null }));
    expect(cancelReleaseRuntime(PROD, { targets, realAdaptersFor: supplied })).toMatchObject({ ok: true, mode: "real" });
    expect(supplied).not.toHaveBeenCalled();
    expect(cancelReleaseRuntime({ ...PROD, TW4_PROVISIONING_REAL_CALLS: undefined }, { targets, realAdaptersFor: supplied }).ok).toBe(false);
    expect(cancelReleaseRuntime({ ...PROD, VERCEL_ENV: "preview" }, { targets, realAdaptersFor: supplied }).ok).toBe(false);
  });
});

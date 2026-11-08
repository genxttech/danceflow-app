import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";
import { resolveStudioSmsMode, resolveStudioSmsSender } from "@/lib/sms/studioSender";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const registration = (): FakeRow => ({
  id: "reg-1",
  studio_id: STUDIO,
  messaging_service_sid: `MG${"a1".repeat(16)}`,
  campaign_sid: `QE${"0f".repeat(16)}`,
  sender_e164: "+15550109999",
  registration_status: "approved",
});

type Opts = {
  mode?: { data?: unknown; error?: { code?: string } | null };
  links?: FakeRow[];
  linkError?: { code: string };
  service?: unknown;
};

/** Fake client that records every table read and rpc. */
function make(opts: Opts = {}) {
  const base = createFakeSupabase({ studio_sms_registrations: [registration()], studio_sms_entity_studios: opts.links ?? [] });
  if (opts.mode) base.overrideRpc("tw4_usage_studio_mode", () => ({ data: opts.mode!.data ?? null, error: opts.mode!.error ?? null }));
  base.overrideRpc("tw4_recurring_service_state", () => ({ data: opts.service ?? "none", error: null }));
  const reads: string[] = [];
  const client = {
    rpc: base.client.rpc,
    from: (name: string) => {
      reads.push(name);
      if (name === "studio_sms_entity_studios" && opts.linkError) {
        const failing: Record<string, unknown> = {};
        for (const m of ["select", "eq", "limit"]) failing[m] = () => failing;
        failing.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: opts.linkError }).then(res);
        return failing;
      }
      return base.client.from(name);
    },
  } as unknown as SupabaseClient;
  return { client, reads, rpcNames: () => base.rpcCalls.map((c) => c.name), rpcCalls: base.rpcCalls };
}

const saved = process.env.DANCEFLOW_SMS_STATUS;
beforeEach(() => {
  process.env.DANCEFLOW_SMS_STATUS = "approved";
});
afterEach(() => {
  if (saved === undefined) delete process.env.DANCEFLOW_SMS_STATUS;
  else process.env.DANCEFLOW_SMS_STATUS = saved;
});

describe("resolveStudioSmsMode", () => {
  it("rpc billed -> billed (no table read)", async () => {
    const t = make({ mode: { data: "billed" } });
    expect(await resolveStudioSmsMode(t.client, STUDIO)).toBe("billed");
    expect(t.reads).toEqual([]);
    expect(t.rpcCalls[0]).toEqual({ name: "tw4_usage_studio_mode", args: { p_studio_id: STUDIO } });
  });

  it("rpc legacy -> legacy (no table read)", async () => {
    const t = make({ mode: { data: "legacy" } });
    expect(await resolveStudioSmsMode(t.client, STUDIO)).toBe("legacy");
    expect(t.reads).toEqual([]);
  });

  it.each([["maybe"], [null], [true], [""]])("rpc answer %j fails closed", async (data) => {
    const t = make({ mode: { data } });
    expect(await resolveStudioSmsMode(t.client, STUDIO)).toBe("failed");
    expect(t.reads).toEqual([]);
  });

  it.each(["PGRST202", "42883"])("rpc %s -> link table read; a linked studio is billed", async (code) => {
    const t = make({ mode: { error: { code } }, links: [{ studio_id: STUDIO }] });
    expect(await resolveStudioSmsMode(t.client, STUDIO)).toBe("billed");
    expect(t.reads).toEqual(["studio_sms_entity_studios"]);
  });

  it("rpc not installed and no link row -> legacy (another studio's link does not count)", async () => {
    const t = make({ mode: { error: { code: "PGRST202" } }, links: [{ studio_id: OTHER }] });
    expect(await resolveStudioSmsMode(t.client, STUDIO)).toBe("legacy");
  });

  it.each(["PGRST205", "42P01"])("rpc not installed and link table missing (%s) -> legacy", async (code) => {
    const t = make({ mode: { error: { code: "42883" } }, linkError: { code } });
    expect(await resolveStudioSmsMode(t.client, STUDIO)).toBe("legacy");
  });

  it("rpc not installed and another link-table error -> failed", async () => {
    const t = make({ mode: { error: { code: "42883" } }, linkError: { code: "XX000" } });
    expect(await resolveStudioSmsMode(t.client, STUDIO)).toBe("failed");
  });

  it("any other rpc error -> failed without reading the table", async () => {
    const t = make({ mode: { error: { code: "XX000" } }, links: [] });
    expect(await resolveStudioSmsMode(t.client, STUDIO)).toBe("failed");
    expect(t.reads).toEqual([]);
  });

  it("an rpc error with no code -> failed", async () => {
    const t = make({ mode: { error: {} } });
    expect(await resolveStudioSmsMode(t.client, STUDIO)).toBe("failed");
    expect(t.reads).toEqual([]);
  });
});

describe("resolveStudioSmsSender with billing mode", () => {
  it("billed -> sms_billed_studio without reading registrations or asking the service state", async () => {
    const t = make({ mode: { data: "billed" } });
    expect(await resolveStudioSmsSender(t.client, STUDIO)).toEqual({ ok: false, reason: "sms_billed_studio" });
    expect(t.reads).not.toContain("studio_sms_registrations");
    expect(t.rpcNames()).not.toContain("tw4_recurring_service_state");
  });

  it("billed via the link table (function not installed) is also billed, even with an approved legacy registration", async () => {
    const t = make({ mode: { error: { code: "PGRST202" } }, links: [{ studio_id: STUDIO }] });
    expect(await resolveStudioSmsSender(t.client, STUDIO)).toEqual({ ok: false, reason: "sms_billed_studio" });
    expect(t.reads).not.toContain("studio_sms_registrations");
  });

  it("failed -> sms_billing_check_failed, never a legacy sender", async () => {
    const t = make({ mode: { data: "garbage" } });
    expect(await resolveStudioSmsSender(t.client, STUDIO)).toEqual({ ok: false, reason: "sms_billing_check_failed" });
    expect(t.reads).not.toContain("studio_sms_registrations");
  });

  it("legacy -> the existing behavior (sender returned, service state asked)", async () => {
    const t = make({ mode: { data: "legacy" }, service: "active" });
    const result = await resolveStudioSmsSender(t.client, STUDIO);
    expect(result).toMatchObject({ ok: true, sender: { studioId: STUDIO, senderE164: "+15550109999" } });
    expect(t.rpcNames()).toEqual(["tw4_usage_studio_mode", "tw4_recurring_service_state"]);
  });

  it("legacy + suspended keeps the suspension refusal", async () => {
    const t = make({ mode: { data: "legacy" }, service: "suspended" });
    expect(await resolveStudioSmsSender(t.client, STUDIO)).toEqual({ ok: false, reason: "sms_service_suspended" });
  });

  it.each(["rejected", "disabled", "pending_review", ""])("platform switch %j -> sms_not_approved before any mode rpc", async (status) => {
    process.env.DANCEFLOW_SMS_STATUS = status;
    const t = make({ mode: { data: "billed" } });
    expect(await resolveStudioSmsSender(t.client, STUDIO)).toEqual({ ok: false, reason: "sms_not_approved" });
    expect(t.rpcCalls).toHaveLength(0);
    expect(t.reads).toEqual([]);
  });
});

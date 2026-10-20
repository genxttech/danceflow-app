import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeSupabase } from "@/lib/sms/__tests__/fakeSupabase";
import { resolveStudioFromInboundSender } from "@/lib/sms/studioSender";

const AC = `AC${"a1".repeat(16)}`;
const MG = `MG${"b2".repeat(16)}`;
const STUDIO = "11111111-1111-4111-8111-111111111111";

function client(rpc: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }) {
  const from = vi.fn(() => { throw new Error("the legacy table must not be read for a subaccount"); });
  return { c: { rpc: async (n: string, a: Record<string, unknown>) => rpc(n, a), from } as unknown as SupabaseClient, from };
}

describe("resolveStudioFromInboundSender with a signer subaccount", () => {
  it("asks only tw4_inbound_studio_for and returns its studio", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { c, from } = client((name, args) => { expect(name).toBe("tw4_inbound_studio_for"); seen.push(args); return { data: STUDIO, error: null }; });
    expect(await resolveStudioFromInboundSender(c, { accountSid: AC, messagingServiceSid: MG, to: "(503) 555-0123" })).toEqual({ ok: true, studioId: STUDIO });
    expect(seen[0]).toEqual({ p_account_sid: AC, p_messaging_service_sid: MG, p_to_e164: "+15035550123" });
    expect(from).not.toHaveBeenCalled();
  });
  it("a null answer is unknown_sender; an error is lookup_failed; neither falls back to the legacy table", async () => {
    const none = client(() => ({ data: null, error: null }));
    expect(await resolveStudioFromInboundSender(none.c, { accountSid: AC, to: "+15035550123" })).toEqual({ ok: false, reason: "unknown_sender" });
    const bad = client(() => ({ data: null, error: { code: "42883" } }));
    expect(await resolveStudioFromInboundSender(bad.c, { accountSid: AC, to: "+15035550123" })).toEqual({ ok: false, reason: "lookup_failed" });
    expect(none.from).not.toHaveBeenCalled();
    expect(bad.from).not.toHaveBeenCalled();
  });
});

describe("resolveStudioFromInboundSender for the parent account (unchanged)", () => {
  const legacy = () => createFakeSupabase({ studio_sms_registrations: [{ id: "r", studio_id: STUDIO, messaging_service_sid: MG, sender_e164: "+15035550123" }] });
  it.each([undefined, null, ""])("uses the legacy registration table when accountSid is %s", async (accountSid) => {
    const db = legacy();
    expect(await resolveStudioFromInboundSender(db.client as unknown as SupabaseClient, { accountSid, messagingServiceSid: MG, to: "+15035550123" })).toEqual({ ok: true, studioId: STUDIO });
    expect(db.rpcCalls.filter((c) => c.name === "tw4_inbound_studio_for")).toHaveLength(0);
  });
});

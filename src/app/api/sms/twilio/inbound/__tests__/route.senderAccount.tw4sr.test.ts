import { beforeEach, describe, expect, it, vi } from "vitest";

/** TW-4F sender readiness: the inbound route hands the VERIFIED signer's subaccount (or null for the parent) to the sender resolver. */

const state = vi.hoisted(() => ({ signer: null as unknown, resolve: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: () => { throw new Error("no effects expected"); }, rpc: async () => ({ data: null, error: null }) }) }));
vi.mock("@/lib/sms/twilioIsv/webhookRuntime", () => ({ buildWebhookAccountDeps: () => ({}), recordWebhookReceipt: async () => "new" }));
vi.mock("@/lib/sms/twilioWebhookAccount", async (orig) => ({
  ...(await orig<typeof import("@/lib/sms/twilioWebhookAccount")>()),
  verifyTwilioWebhookAccount: async () => ({ ok: true, account: state.signer }),
}));
vi.mock("@/lib/sms/studioSender", () => ({
  resolveStudioFromInboundSender: (...args: unknown[]) => (state.resolve as (...a: unknown[]) => unknown)(...args),
}));

import { POST } from "@/app/api/sms/twilio/inbound/route";

const AC = `AC${"a1".repeat(16)}`;
let ip = 0;
const request = (params: Record<string, string>) =>
  new Request("https://www.idanceflow.com/api/sms/twilio/inbound", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${++ip}` },
    body: new URLSearchParams(params).toString(),
  });
const PARAMS = { From: "+15550100123", To: "+15035550123", Body: "hello", MessageSid: `SM${"0a".repeat(16)}`, MessagingServiceSid: `MG${"b2".repeat(16)}` };
const resolver = () => state.resolve as ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
  state.resolve = vi.fn(async () => ({ ok: false, reason: "unknown_sender" }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("inbound route passes the signer account to the resolver", () => {
  it("subaccount signer -> its account SID", async () => {
    state.signer = { kind: "subaccount", accountSid: AC, legalEntityId: "e", studioIds: [] };
    const res = await POST(request(PARAMS));
    expect(res.status).toBe(200);
    expect(resolver()).toHaveBeenCalledTimes(1);
    expect(resolver().mock.calls[0][1]).toEqual({ messagingServiceSid: PARAMS.MessagingServiceSid, to: PARAMS.To, accountSid: AC });
  });
  it("parent signer -> null", async () => {
    state.signer = { kind: "parent" };
    await POST(request(PARAMS));
    expect(resolver().mock.calls[0][1]).toMatchObject({ accountSid: null });
  });
});

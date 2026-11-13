import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("the default client must not be needed when admin is injected"); } }));

import { pendingOptOutState } from "@/lib/sms/sendSuppression";
import { sendTwilioSms } from "@/lib/sms/twilio";
import { sendBilledSms, type BilledSendInput } from "@/lib/sms/usageBilling";
import { FakeBilledSmsProvider } from "@/lib/sms/usageProvider";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PHONE = "+15550100123";
const SERVICE = `MG${"2".repeat(32)}`;
const ACCOUNT = `AC${"1".repeat(32)}`;

type Res = { data: unknown; error: { code?: string } | null };
function rpcClient(blocks: (args: Record<string, unknown>, n: number) => Res | never) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let n = 0;
  return {
    calls,
    names: () => calls.map((c) => c.name),
    client: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "sms_pending_opt_out_blocks") return blocks(args, ++n);
        if (name === "tw4_usage_begin") return { data: { decision: "send", attempt_id: "a1", message_log_id: "l1", account_sid: ACCOUNT, messaging_service_sid: SERVICE, sender_e164: "+15035550199" }, error: null };
        if (name === "tw4_usage_dispatching") return { data: { dispatch: true }, error: null };
        return { data: {}, error: null };
      },
    } as never,
  };
}
const parkedFor = (studio: string) => (a: Record<string, unknown>): Res => ({ data: a.p_studio_id === studio && a.p_phone_e164 === PHONE, error: null });
const input = (over: Partial<BilledSendInput> = {}): BilledSendInput => ({
  source: { kind: "delivery", id: "d1" }, studioId: STUDIO, clientId: "c1", phoneE164: PHONE, body: "Hi", messageType: "m", relatedTable: null, relatedId: null, sentBy: null, statusCallbackBase: null,
});

const fetchMock = vi.fn();
beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = "ACtest0000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "t";
  process.env.DANCEFLOW_SMS_STATUS = "approved";
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ sid: "SM1", status: "queued" })));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("pendingOptOutState", () => {
  it("blocked / clear / unknown, normalizing the number like the canonical function", async () => {
    expect(await pendingOptOutState(rpcClient(parkedFor(STUDIO)).client, STUDIO, "(555) 010-0123")).toBe("blocked");
    expect(await pendingOptOutState(rpcClient(parkedFor(OTHER)).client, STUDIO, PHONE)).toBe("clear");
    expect(await pendingOptOutState(rpcClient(() => ({ data: null, error: { code: "57014" } })).client, STUDIO, PHONE)).toBe("unknown");
    expect(await pendingOptOutState(rpcClient(() => { throw new Error("x"); }).client, STUDIO, PHONE)).toBe("unknown");
    expect(await pendingOptOutState(rpcClient(() => ({ data: null, error: null })).client, STUDIO, PHONE)).toBe("unknown");
    expect(await pendingOptOutState(rpcClient(parkedFor(STUDIO)).client, STUDIO, "not a phone")).toBe("unknown");
    expect(await pendingOptOutState(rpcClient(parkedFor(STUDIO)).client, "", PHONE)).toBe("unknown");
  });
  it("only a function-not-installed error is clear (pre-migration); every other error is unknown", async () => {
    for (const code of ["PGRST202", "42883"]) expect(await pendingOptOutState(rpcClient(() => ({ data: null, error: { code } })).client, STUDIO, PHONE)).toBe("clear");
    for (const code of ["42P01", "PGRST205", "42501", "57014", "08006", undefined]) expect(await pendingOptOutState(rpcClient(() => ({ data: null, error: { code } })).client, STUDIO, PHONE)).toBe("unknown");
  });
});

describe("SMS_PENDING_OPT_OUT_REQUIRED (set when the migration is applied)", () => {
  const absent = () => rpcClient(() => ({ data: null, error: { code: "PGRST202" } })).client;
  it("unset: a missing function is clear (pre-migration); set: PGRST202 / 42883 fail closed, e.g. a stale schema cache after the apply", async () => {
    expect(await pendingOptOutState(absent(), STUDIO, PHONE, {})).toBe("clear");
    for (const v of ["1", "on", "true", " ON "]) {
      expect(await pendingOptOutState(absent(), STUDIO, PHONE, { SMS_PENDING_OPT_OUT_REQUIRED: v })).toBe("unknown");
      expect(await pendingOptOutState(rpcClient(() => ({ data: null, error: { code: "42883" } })).client, STUDIO, PHONE, { SMS_PENDING_OPT_OUT_REQUIRED: v })).toBe("unknown");
    }
    expect(await pendingOptOutState(absent(), STUDIO, PHONE, { SMS_PENDING_OPT_OUT_REQUIRED: "0" })).toBe("clear");
  });
  it("set: a working function still answers normally", async () => {
    const env = { SMS_PENDING_OPT_OUT_REQUIRED: "1" };
    expect(await pendingOptOutState(rpcClient(parkedFor(STUDIO)).client, STUDIO, PHONE, env)).toBe("blocked");
    expect(await pendingOptOutState(rpcClient(parkedFor(OTHER)).client, STUDIO, PHONE, env)).toBe("clear");
  });
  it("set: a text is not sent through sendTwilioSms or sendBilledSms when the function is missing", async () => {
    process.env.SMS_PENDING_OPT_OUT_REQUIRED = "1";
    try {
      expect(await sendTwilioSms({ studioId: STUDIO, admin: absent(), to: PHONE, body: "Hi", messagingServiceSid: SERVICE })).toMatchObject({ ok: false, errorCode: "sms_consent_check_failed" });
      const provider = new FakeBilledSmsProvider();
      expect(await sendBilledSms(absent(), provider, input())).toEqual({ outcome: "refused", reason: "unavailable" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(provider.sent).toHaveLength(0);
    } finally {
      delete process.env.SMS_PENDING_OPT_OUT_REQUIRED;
    }
  });
});

describe("sendTwilioSms (legacy sink backstop)", () => {
  const send = (admin: never, studioId = STUDIO) => sendTwilioSms({ studioId, admin, to: PHONE, body: "Hi", messagingServiceSid: SERVICE });
  it("an open parked STOP: no provider call", async () => {
    expect(await send(rpcClient(parkedFor(STUDIO)).client)).toMatchObject({ ok: false, errorCode: "sms_opted_out" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("fail closed on error / throw", async () => {
    expect(await send(rpcClient(() => ({ data: null, error: { code: "57014" } })).client)).toMatchObject({ ok: false, errorCode: "sms_consent_check_failed" });
    expect(await send(rpcClient(() => { throw new Error("x"); }).client)).toMatchObject({ ok: false, errorCode: "sms_consent_check_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("cross-studio: another studio's parked STOP does not block; pre-migration is clear", async () => {
    expect((await send(rpcClient(parkedFor(OTHER)).client)).ok).toBe(true);
    expect((await send(rpcClient(() => ({ data: null, error: { code: "PGRST202" } })).client)).ok).toBe(true);
  });
});

describe("sendBilledSms (billed sink)", () => {
  it("parked before begin: refused opted_out, nothing reserved, provider untouched", async () => {
    const db = rpcClient(parkedFor(STUDIO));
    const provider = new FakeBilledSmsProvider();
    expect(await sendBilledSms(db.client, provider, input())).toEqual({ outcome: "refused", reason: "opted_out" });
    expect(db.names()).not.toContain("tw4_usage_begin");
    expect(provider.sent).toHaveLength(0);
  });
  it("parked AFTER the first check (race with begin): the reservation is released, no dispatch marker, provider untouched", async () => {
    const db = rpcClient((a, n) => ({ data: n >= 2 && a.p_studio_id === STUDIO, error: null }));
    const provider = new FakeBilledSmsProvider();
    expect(await sendBilledSms(db.client, provider, input())).toEqual({ outcome: "refused", reason: "opted_out" });
    expect(db.names()).toContain("tw4_usage_begin");
    expect(db.names()).toContain("tw4_usage_release_unprepared");
    expect(db.names()).not.toContain("tw4_usage_dispatching");
    expect(provider.sent).toHaveLength(0);
  });
  it("fail closed: an unreadable check before or after begin never reaches the provider", async () => {
    for (const failAt of [1, 2]) {
      const db = rpcClient((_a, n) => (n === failAt ? { data: null, error: { code: "57014" } } : { data: false, error: null }));
      const provider = new FakeBilledSmsProvider();
      expect(await sendBilledSms(db.client, provider, input())).toEqual({ outcome: "refused", reason: "unavailable" });
      expect(db.names()).not.toContain("tw4_usage_dispatching");
      expect(provider.sent).toHaveLength(0);
    }
  });
  it("cross-studio and cleared: sends", async () => {
    const provider = new FakeBilledSmsProvider();
    const out = await sendBilledSms(rpcClient(parkedFor(OTHER)).client, provider, input());
    expect(out.outcome).not.toBe("refused");
  });
});

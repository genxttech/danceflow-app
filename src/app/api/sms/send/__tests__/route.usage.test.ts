import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";
import { FakeBilledSmsProvider } from "@/lib/sms/usageProvider";

/** TW-4F: the manual send route's billed path (taken when the resolver says sms_billed_studio). */

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof import("@/lib/sms/__tests__/fakeSupabase").createFakeSupabase> | null,
  resolver: { ok: false, reason: "sms_billed_studio" } as Record<string, unknown>,
  provider: null as unknown,
  sendBilled: vi.fn(),
  twilio: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db!.client }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.db!.client }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({
    studioId: "11111111-1111-4111-8111-111111111111",
    studioRole: "studio_owner",
    userId: "44444444-4444-4444-8444-444444444444",
  }),
}));
vi.mock("@/lib/sms/studioSender", () => ({ resolveStudioSmsSender: async () => h.resolver }));
vi.mock("@/lib/sms/usageProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/usageProvider")>();
  return { ...actual, billedSmsProviderFromEnv: () => h.provider };
});
vi.mock("@/lib/sms/twilio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/twilio")>();
  return { ...actual, sendTwilioSms: (...args: unknown[]) => h.twilio(...args) };
});
vi.mock("@/lib/sms/usageBilling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/usageBilling")>();
  return { ...actual, sendBilledSms: (...args: unknown[]) => h.sendBilled(...args) };
});

import { POST } from "@/app/api/sms/send/route";

const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const PHONE_E164 = "+15550100123";
const KEY = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const LOG = "log-1";

const ENV_KEYS = ["SMS_USAGE_BILLING", "TWILIO_STATUS_CALLBACK_SECRET", "DANCEFLOW_SMS_STATUS"] as const;
const savedEnv: Record<string, string | undefined> = {};
let ipCounter = 0;

const permission = (overrides: FakeRow = {}): FakeRow => ({
  id: "perm-1",
  studio_id: STUDIO_A,
  client_id: CLIENT_ID,
  phone_e164: PHONE_E164,
  consent_status: "opted_in",
  opted_out_at: null,
  updated_at: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

function seed(permissions: FakeRow[] = [permission()]) {
  h.db = createFakeSupabase({
    studios: [{ id: STUDIO_A, name: "Harbor Dance Studio" }],
    clients: [{ id: CLIENT_ID, studio_id: STUDIO_A, phone: "(555) 010-0123" }],
    sms_contact_permissions: permissions,
  });
}

function sendRequest(extra: Record<string, unknown> = { idempotencyKey: KEY }) {
  return new Request("https://example.test/api/sms/send", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++ipCounter}` },
    body: JSON.stringify({ clientId: CLIENT_ID, body: "Hi Alex, can we move Thursday?", ...extra }),
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SMS_USAGE_BILLING = "on";
  process.env.TWILIO_STATUS_CALLBACK_SECRET = "cb secret/1";
  h.resolver = { ok: false, reason: "sms_billed_studio" };
  h.provider = new FakeBilledSmsProvider();
  h.sendBilled.mockReset();
  h.sendBilled.mockResolvedValue({ outcome: "sent", logId: LOG, providerSid: "SM1" });
  h.twilio.mockReset();
  seed();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("billed path gates", () => {
  it("SMS_USAGE_BILLING off -> 503, no begin", async () => {
    delete process.env.SMS_USAGE_BILLING;
    const res = await POST(sendRequest());
    expect(res.status).toBe(503);
    expect(h.sendBilled).not.toHaveBeenCalled();
    expect(h.twilio).not.toHaveBeenCalled();
  });

  it("SMS_USAGE_BILLING set to something other than on -> 503", async () => {
    process.env.SMS_USAGE_BILLING = "true";
    expect((await POST(sendRequest())).status).toBe(503);
    expect(h.sendBilled).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["not a uuid", { idempotencyKey: "abc" }],
    ["empty", { idempotencyKey: "" }],
    ["a number", { idempotencyKey: 12 }],
    ["a v0 uuid", { idempotencyKey: "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa" }],
    ["bad variant", { idempotencyKey: "aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa" }],
  ])("idempotencyKey %s -> 400, no begin", async (_n, extra) => {
    const res = await POST(sendRequest(extra));
    expect(res.status).toBe(400);
    expect(h.sendBilled).not.toHaveBeenCalled();
    expect(h.twilio).not.toHaveBeenCalled();
  });

  it("provider factory null -> 503, no begin", async () => {
    h.provider = null;
    const res = await POST(sendRequest());
    expect(res.status).toBe(503);
    expect(h.sendBilled).not.toHaveBeenCalled();
  });

  it("the legacy sender is never used for a billed studio", async () => {
    await POST(sendRequest());
    expect(h.twilio).not.toHaveBeenCalled();
    expect(h.db!.rows("sms_message_logs")).toHaveLength(0); // the database (tw4_usage_begin) creates the log row, not the route
  });

  it("sms_billing_check_failed -> 500 and no billing call", async () => {
    h.resolver = { ok: false, reason: "sms_billing_check_failed" };
    const res = await POST(sendRequest());
    expect(res.status).toBe(500);
    expect(h.sendBilled).not.toHaveBeenCalled();
    expect(h.twilio).not.toHaveBeenCalled();
  });
});

describe("billed path input", () => {
  it("source is {manual, key lowercased}; studio comes from the session; the body carries the opt-out footer", async () => {
    await POST(sendRequest());
    expect(h.sendBilled).toHaveBeenCalledTimes(1);
    const [, provider, input] = h.sendBilled.mock.calls[0];
    expect(provider).toBe(h.provider);
    expect(input).toMatchObject({
      source: { kind: "manual", id: KEY.toLowerCase() },
      studioId: STUDIO_A,
      clientId: CLIENT_ID,
      phoneE164: PHONE_E164,
      messageType: "manual",
      relatedTable: "clients",
      relatedId: CLIENT_ID,
      sentBy: USER_ID,
    });
    expect(input.body).toContain("Hi Alex, can we move Thursday?");
    expect(input.body).toContain("Harbor Dance Studio: Reply STOP");
    expect(input.statusCallbackBase).toBe("https://example.test/api/sms/twilio/status?secret=cb%20secret%2F1");
  });

  it("a studio id in the request body is ignored", async () => {
    await POST(sendRequest({ idempotencyKey: KEY, studioId: "99999999-9999-4999-8999-999999999999" }));
    expect(h.sendBilled.mock.calls[0][2].studioId).toBe(STUDIO_A);
  });

  it("no callback secret -> a null callback base", async () => {
    delete process.env.TWILIO_STATUS_CALLBACK_SECRET;
    await POST(sendRequest());
    expect(h.sendBilled.mock.calls[0][2].statusCallbackBase).toBeNull();
  });
});

describe("billed path outcomes", () => {
  it("sent -> 200 with the log id", async () => {
    const res = await POST(sendRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: LOG });
  });

  it.each(["submitted", "settled"])("replay in state %s -> 200 (already sent)", async (state) => {
    h.sendBilled.mockResolvedValue({ outcome: "replay", logId: LOG, state, providerSid: "SM1" });
    const res = await POST(sendRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: LOG });
  });

  it("replay in state released -> 409", async () => {
    h.sendBilled.mockResolvedValue({ outcome: "replay", logId: LOG, state: "released", providerSid: null });
    const res = await POST(sendRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).ok).toBe(false);
  });

  it("replay in state reserved (never handed to the provider) -> 409 not sent", async () => {
    h.sendBilled.mockResolvedValue({ outcome: "replay", logId: LOG, state: "reserved", providerSid: null });
    const res = await POST(sendRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).ok).toBe(false);
  });

  it.each(["submitting", "unknown", "review", "weird"])("replay in state %s -> 202 uncertain", async (state) => {
    h.sendBilled.mockResolvedValue({ outcome: "replay", logId: LOG, state, providerSid: null });
    const res = await POST(sendRequest());
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: false, uncertain: true, id: LOG });
  });

  it("uncertain -> 202 uncertain:true", async () => {
    h.sendBilled.mockResolvedValue({ outcome: "uncertain", logId: LOG });
    const res = await POST(sendRequest());
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: false, uncertain: true });
  });

  it("rejected -> 502 and no provider text or code in the body", async () => {
    h.sendBilled.mockResolvedValue({ outcome: "rejected", logId: LOG, code: "21211" });
    const res = await POST(sendRequest());
    expect(res.status).toBe(502);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("21211");
    expect(text).not.toMatch(/twilio/i);
  });

  it.each([
    ["insufficient_credit", 402],
    ["monthly_limit", 402],
    ["no_billed_sender", 503],
    ["suspended", 503],
    ["switched_off", 503],
    ["no_price", 503],
    ["not_billed", 503],
    ["invalid", 400],
    ["forbidden", 403],
    ["unavailable", 503],
  ])("refused %s -> %i with its plain message", async (reason, status) => {
    h.sendBilled.mockResolvedValue({ outcome: "refused", reason });
    const res = await POST(sendRequest());
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });
});

describe("consent comes before billing", () => {
  it("an opted-out number is refused (400) before any billing call", async () => {
    seed([permission(), permission({ id: "p2", client_id: null, consent_status: "opted_out" })]);
    const res = await POST(sendRequest());
    expect(res.status).toBe(400);
    expect(h.sendBilled).not.toHaveBeenCalled();
  });

  it("a client without consent is refused (400) before any billing call", async () => {
    seed([]);
    const res = await POST(sendRequest());
    expect(res.status).toBe(400);
    expect(h.sendBilled).not.toHaveBeenCalled();
  });

  it("a missing key does not matter when consent already refused", async () => {
    seed([]);
    const res = await POST(sendRequest({}));
    expect(res.status).toBe(400);
    expect(h.sendBilled).not.toHaveBeenCalled();
  });
});

describe("end to end with the real billing library", () => {
  it("begin refusal TW007 reaches the caller as 402 and the provider is untouched", async () => {
    const actual = await vi.importActual<typeof import("@/lib/sms/usageBilling")>("@/lib/sms/usageBilling");
    h.sendBilled.mockImplementation((...args: Parameters<typeof actual.sendBilledSms>) => actual.sendBilledSms(...args));
    h.db!.overrideRpc("tw4_usage_begin", () => ({ data: null, error: { code: "TW007" } }));
    const res = await POST(sendRequest());
    expect(res.status).toBe(402);
    expect((h.provider as FakeBilledSmsProvider).sent).toHaveLength(0);
    expect(h.db!.rpcCalls.map((c) => c.name)).toEqual(["tw4_usage_begin"]);
  });

  it("sender no longer ready at the marker: 503 'not set up', never reported as uncertain; the provider is untouched and nothing is recorded as an outcome", async () => {
    const actual = await vi.importActual<typeof import("@/lib/sms/usageBilling")>("@/lib/sms/usageBilling");
    h.sendBilled.mockImplementation((...args: Parameters<typeof actual.sendBilledSms>) => actual.sendBilledSms(...args));
    h.db!.overrideRpc("tw4_usage_begin", () => ({
      data: { decision: "send", attempt_id: "att-1", message_log_id: LOG, account_sid: `AC${"1".repeat(32)}`, messaging_service_sid: `MG${"2".repeat(32)}`, sender_e164: "+15035550199" },
      error: null,
    }));
    h.db!.overrideRpc("tw4_usage_dispatching", () => ({ data: { dispatch: false, state: "released", reason: "sender_not_ready" }, error: null }));
    const res = await POST(sendRequest());
    const json = await res.json();
    expect(res.status).toBe(503);
    expect(json.uncertain).toBeUndefined();
    expect(json.ok).toBe(false);
    expect(json.error).toBe(actual.BILLED_REFUSAL_MESSAGE.no_billed_sender);
    expect((h.provider as FakeBilledSmsProvider).sent).toHaveLength(0);
    expect(h.db!.rpcCalls.map((c) => c.name)).toEqual(["tw4_usage_begin", "tw4_usage_dispatching"]);
  });

  it("credentials unavailable (prepare fails): 503, no dispatch marker, provider untouched; the attempt stays reserved for a retry of the same key", async () => {
    const actual = await vi.importActual<typeof import("@/lib/sms/usageBilling")>("@/lib/sms/usageBilling");
    h.sendBilled.mockImplementation((...args: Parameters<typeof actual.sendBilledSms>) => actual.sendBilledSms(...args));
    const account = `AC${"1".repeat(32)}`;
    (h.provider as FakeBilledSmsProvider).failPrepare(account);
    h.db!.overrideRpc("tw4_usage_begin", () => ({
      data: { decision: "send", attempt_id: "att-1", message_log_id: LOG, account_sid: account, messaging_service_sid: `MG${"2".repeat(32)}`, sender_e164: "+15035550199" },
      error: null,
    }));
    const res = await POST(sendRequest());
    expect(res.status).toBe(503);
    expect((await res.json()).uncertain).toBeUndefined();
    expect((h.provider as FakeBilledSmsProvider).sent).toHaveLength(0);
    expect(h.db!.rpcCalls.map((c) => c.name)).toEqual(["tw4_usage_begin"]);
  });
});

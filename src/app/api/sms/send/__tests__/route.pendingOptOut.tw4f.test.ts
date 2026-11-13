import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";
import { FakeBilledSmsProvider } from "@/lib/sms/usageProvider";

/** TW-4F compliance: the manual send route refuses a text to a number with an open parked STOP (billed and legacy path), and fails closed. */

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

const SERVICE = `MG${"2".repeat(32)}`;
const LEGACY = { ok: true, sender: { studioId: STUDIO_A, messagingServiceSid: SERVICE, senderE164: "+15035550199", campaignSid: `QE${"0f".repeat(16)}` } };

function check(fn: (a: Record<string, unknown>) => { data: unknown; error: unknown }) {
  h.db!.overrideRpc("sms_pending_opt_out_blocks", fn);
}
const parkedFor = (studio: string) => (a: Record<string, unknown>) => ({ data: a.p_studio_id === studio && a.p_phone_e164 === PHONE_E164, error: null });

describe.each([
  ["billed", { ok: false, reason: "sms_billed_studio" }],
  ["legacy", LEGACY],
] as const)("%s path", (_name, resolver) => {
  beforeEach(() => {
    h.resolver = resolver as Record<string, unknown>;
    h.twilio.mockResolvedValue({ ok: true, sid: "SM1", status: "queued" });
  });
  const noSend = () => {
    expect(h.twilio).not.toHaveBeenCalled();
    expect(h.sendBilled).not.toHaveBeenCalled();
    expect(h.db!.rows("sms_message_logs")).toHaveLength(0);
  };

  it("an open parked STOP -> 400 opted out, no provider call, no reservation, no log", async () => {
    check(parkedFor(STUDIO_A));
    const res = await POST(sendRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/opted out/);
    noSend();
  });

  it("fail closed: a lookup error, a throw or an unreadable answer sends nothing (500)", async () => {
    for (const fn of [() => ({ data: null, error: { code: "57014" } }), () => { throw new Error("down"); }, () => ({ data: "x", error: null })]) {
      h.twilio.mockClear(); h.sendBilled.mockClear();
      check(fn);
      expect((await POST(sendRequest())).status).toBe(500);
      noSend();
    }
  });

  it("cross-studio: another studio's parked STOP for the same number does not block this studio", async () => {
    check(parkedFor("99999999-9999-4999-8999-999999999999"));
    const res = await POST(sendRequest());
    expect(res.status).toBe(200);
  });

  it("pre-migration (function not installed) is not a block", async () => {
    check(() => ({ data: null, error: { code: "PGRST202" } }));
    expect((await POST(sendRequest())).status).toBe(200);
  });
});

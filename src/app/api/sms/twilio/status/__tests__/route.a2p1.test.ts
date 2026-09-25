import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { createFakeSupabase } from "@/lib/sms/__tests__/fakeSupabase";

/** A2P-1A: status callback requires a valid Twilio signature AND the existing callback secret. */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fake.current!.client,
}));

import { POST } from "@/app/api/sms/twilio/status/route";

const TEST_TOKEN = "fake-test-auth-token";
const CALLBACK_SECRET = "fake-callback-secret";
const BASE_URL = "https://www.idanceflow.com/api/sms/twilio/status";
const PARAMS = { MessageSid: "SMtest123", MessageStatus: "delivered" };

const ENV_KEYS = [
  "TWILIO_AUTH_TOKEN",
  "TWILIO_STATUS_CALLBACK_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};
let ipCounter = 0;

function statusRequest(
  options: {
    secret?: string;
    sign?: "valid" | "invalid" | "missing";
    params?: Record<string, string>;
  } = {},
) {
  const url = `${BASE_URL}?secret=${encodeURIComponent(options.secret ?? CALLBACK_SECRET)}`;
  const params = options.params ?? PARAMS;
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "x-forwarded-for": `192.0.2.${++ipCounter % 250}`,
  };
  const sign = options.sign ?? "valid";

  if (sign === "valid") headers["x-twilio-signature"] = getExpectedTwilioSignature(TEST_TOKEN, url, params);
  if (sign === "invalid") headers["x-twilio-signature"] = "aW52YWxpZC1zaWduYXR1cmU=";

  return new Request(url, { method: "POST", headers, body: new URLSearchParams(params).toString() });
}

function seedLog() {
  fake.current = createFakeSupabase({
    sms_message_logs: [
      { id: "log-1", provider: "twilio", provider_message_id: "SMtest123", status: "queued", delivered_at: null },
    ],
  });
  return fake.current;
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.TWILIO_AUTH_TOKEN = TEST_TOKEN;
  process.env.TWILIO_STATUS_CALLBACK_SECRET = CALLBACK_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe("status callback protection", () => {
  it("valid signature + valid secret -> accepted and delivery state updated", async () => {
    const db = seedLog();

    const response = await POST(statusRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(db.rows("sms_message_logs")[0]).toMatchObject({ status: "delivered" });
    expect(db.rows("sms_message_logs")[0].delivered_at).toBeTruthy();
  });

  const rejected: Array<{ name: string; options: Parameters<typeof statusRequest>[0]; status: number }> = [
    { name: "invalid signature", options: { sign: "invalid" }, status: 403 },
    { name: "missing signature", options: { sign: "missing" }, status: 403 },
    { name: "valid signature + invalid secret", options: { secret: "wrong-secret" }, status: 401 },
  ];

  for (const testCase of rejected) {
    it(`${testCase.name} -> ${testCase.status}, no delivery-log mutation`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const db = seedLog();
      const fromSpy = vi.spyOn(db.client, "from");

      const response = await POST(statusRequest(testCase.options));

      expect(response.status).toBe(testCase.status);
      expect(fromSpy).not.toHaveBeenCalled();
      expect(db.mutations).toHaveLength(0);
      expect(db.rows("sms_message_logs")[0]).toMatchObject({ status: "queued" });

      const logged = warn.mock.calls.flat().map(String).join("\n");
      expect(logged).not.toContain(TEST_TOKEN);
      expect(logged).not.toContain(CALLBACK_SECRET);
    });
  }

  it("missing auth token -> 503, no mutation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    delete process.env.TWILIO_AUTH_TOKEN;
    const db = seedLog();

    const response = await POST(statusRequest());

    expect(response.status).toBe(503);
    expect(db.mutations).toHaveLength(0);
  });

  it("never stores Twilio's raw ErrorMessage; keeps the code and a code-only message", async () => {
    const db = seedLog();
    const rawErrorMessage =
      "Carrier rejected +15550100123 (see https://example.test/api/sms/twilio/status?secret=fake-status-secret) - unreachable handset";

    const response = await POST(
      statusRequest({
        params: {
          MessageSid: "SMtest123",
          MessageStatus: "undelivered",
          ErrorCode: "30003",
          ErrorMessage: rawErrorMessage,
        },
      }),
    );

    expect(response.status).toBe(200);

    const log = db.rows("sms_message_logs")[0];
    expect(log).toMatchObject({
      status: "failed",
      provider_error_code: "30003",
      provider_error_message: "Twilio error 30003",
    });
    expect(log.failed_at).toBeTruthy();

    const stored = String(log.provider_error_message);
    expect(stored).not.toContain(rawErrorMessage);
    expect(stored).not.toContain("fake-status-secret");
    expect(stored).not.toContain("secret=");
    expect(stored).not.toContain("5550100123");
  });

  it("falls back to the generic message when an ErrorMessage arrives without a code", async () => {
    const db = seedLog();

    const response = await POST(
      statusRequest({
        params: {
          MessageSid: "SMtest123",
          MessageStatus: "failed",
          ErrorMessage: "Rejected +15550100123 ?secret=fake-status-secret",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(db.rows("sms_message_logs")[0]).toMatchObject({
      status: "failed",
      provider_error_code: null,
      provider_error_message: "The text could not be sent.",
    });
  });

  it("successful callbacks without an error keep provider error fields empty", async () => {
    const db = seedLog();

    await POST(statusRequest());

    expect(db.rows("sms_message_logs")[0]).toMatchObject({
      status: "delivered",
      provider_error_code: null,
      provider_error_message: null,
    });
  });

  it("the Twilio signature is checked before the callback secret", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = seedLog();

    const response = await POST(statusRequest({ sign: "invalid", secret: "wrong-secret" }));

    expect(response.status).toBe(403);
    expect(db.mutations).toHaveLength(0);
  });
});

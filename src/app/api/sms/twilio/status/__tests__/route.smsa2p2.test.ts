import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { createFakeSupabase } from "@/lib/sms/__tests__/fakeSupabase";

/** SMS-A2P-2: a status callback can only update the log of the studio that owns the sender. */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fake.current!.client,
}));

import { POST } from "@/app/api/sms/twilio/status/route";

const TEST_TOKEN = "fake-test-auth-token";
const CALLBACK_SECRET = "fake-callback-secret";
const BASE_URL = "https://www.idanceflow.com/api/sms/twilio/status";
const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";
const SERVICE_A = `MG${"a1".repeat(16)}`;
const SERVICE_B = `MG${"b2".repeat(16)}`;

const ENV_KEYS = [
  "TWILIO_AUTH_TOKEN",
  "TWILIO_STATUS_CALLBACK_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};
let ipCounter = 0;

function statusRequest(params: Record<string, string>) {
  const url = `${BASE_URL}?secret=${encodeURIComponent(CALLBACK_SECRET)}`;
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": `192.0.2.${++ipCounter % 250}`,
      "x-twilio-signature": getExpectedTwilioSignature(TEST_TOKEN, url, params),
    },
    body: new URLSearchParams(params).toString(),
  });
}

function seed() {
  fake.current = createFakeSupabase({
    sms_message_logs: [
      { id: "log-a", studio_id: STUDIO_A, provider: "twilio", provider_message_id: "SMa", status: "queued" },
      { id: "log-b", studio_id: STUDIO_B, provider: "twilio", provider_message_id: "SMb", status: "queued" },
    ],
    studio_sms_registrations: [
      { id: "ra", studio_id: STUDIO_A, messaging_service_sid: SERVICE_A },
      { id: "rb", studio_id: STUDIO_B, messaging_service_sid: SERVICE_B },
    ],
  });
  return fake.current;
}

const logs = () => Object.fromEntries(fake.current!.rows("sms_message_logs").map((row) => [String(row.id), row]));

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.TWILIO_AUTH_TOKEN = TEST_TOKEN;
  process.env.TWILIO_STATUS_CALLBACK_SECRET = CALLBACK_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe("status callback studio scoping", () => {
  it("the owning studio's Messaging Service updates its own log only", async () => {
    seed();

    const response = await POST(
      statusRequest({ MessageSid: "SMa", MessageStatus: "delivered", MessagingServiceSid: SERVICE_A }),
    );

    expect(response.status).toBe(200);
    expect(logs()["log-a"]).toMatchObject({ status: "delivered" });
    expect(logs()["log-b"]).toMatchObject({ status: "queued" });
    expect(fake.current!.mutations.flatMap((m) => m.ids)).toEqual(["log-a"]);
  });

  it("a callback from Studio B's Messaging Service cannot update Studio A's log", async () => {
    seed();

    const response = await POST(
      statusRequest({ MessageSid: "SMa", MessageStatus: "delivered", MessagingServiceSid: SERVICE_B }),
    );

    expect(response.status).toBe(403);
    expect(logs()["log-a"]).toMatchObject({ status: "queued" });
    expect(fake.current!.mutations).toHaveLength(0);
  });

  it("a callback without any Messaging Service cannot update a registered studio's log", async () => {
    seed();

    const response = await POST(statusRequest({ MessageSid: "SMb", MessageStatus: "delivered" }));

    expect(response.status).toBe(403);
    expect(logs()["log-b"]).toMatchObject({ status: "queued" });
  });

  it("an unknown message SID changes nothing", async () => {
    seed();

    const response = await POST(
      statusRequest({ MessageSid: "SMunknown", MessageStatus: "delivered", MessagingServiceSid: SERVICE_A }),
    );

    expect(response.status).toBe(200);
    expect(fake.current!.mutations).toHaveLength(0);
  });

  it("signature verification still runs first", async () => {
    seed();
    const url = `${BASE_URL}?secret=${CALLBACK_SECRET}`;

    const response = await POST(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "192.0.2.250" },
        body: new URLSearchParams({ MessageSid: "SMa", MessageStatus: "delivered" }).toString(),
      }),
    );

    expect(response.status).toBe(403);
    expect(fake.current!.mutations).toHaveLength(0);
  });
});

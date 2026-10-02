import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/** SMS-A2P-2: manual studio SMS sends only through the studio's own approved registration. */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake.current!.client,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fake.current!.client,
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({
    studioId: "11111111-1111-4111-8111-111111111111",
    studioRole: "studio_owner",
  }),
}));

import { POST } from "@/app/api/sms/send/route";

const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const PHONE_E164 = "+15550100123";
const SERVICE_A = `MG${"a1".repeat(16)}`;
const SERVICE_B = `MG${"b2".repeat(16)}`;

const ENV_KEYS = [
  "DANCEFLOW_SMS_STATUS",
  "SMS_PLATFORM_STATUS",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_MESSAGE_SERVICE_SID",
  "TWILIO_STATUS_CALLBACK_SECRET",
] as const;
const savedEnv: Record<string, string | undefined> = {};
const fetchMock = vi.fn();
let ipCounter = 0;

function registration(studioId: string, overrides: FakeRow = {}): FakeRow {
  return {
    id: `reg-${studioId}`,
    studio_id: studioId,
    messaging_service_sid: studioId === STUDIO_A ? SERVICE_A : SERVICE_B,
    campaign_sid: `QE${"0f".repeat(16)}`,
    sender_e164: studioId === STUDIO_A ? "+15550109999" : "+15550108888",
    registration_status: "approved",
    ...overrides,
  };
}

function seed(registrations: FakeRow[], permissions: FakeRow[] = [permission()]) {
  fake.current = createFakeSupabase({
    studios: [{ id: STUDIO_A, name: "Harbor Dance Studio" }],
    clients: [{ id: CLIENT_ID, studio_id: STUDIO_A, phone: "(555) 010-0123" }],
    sms_contact_permissions: permissions,
    studio_sms_registrations: registrations,
  });
  return fake.current;
}

function permission(overrides: FakeRow = {}): FakeRow {
  return {
    id: "perm-1",
    studio_id: STUDIO_A,
    client_id: CLIENT_ID,
    phone_e164: PHONE_E164,
    consent_status: "opted_in",
    opted_out_at: null,
    updated_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function sendRequest() {
  return new Request("https://example.test/api/sms/send", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.19.0.${++ipCounter}` },
    body: JSON.stringify({ clientId: CLIENT_ID, body: "Hi Alex, can we move Thursday's lesson to 5 PM?" }),
  });
}

const twilioCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("api.twilio.com"));

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.DANCEFLOW_SMS_STATUS = "approved";
  process.env.TWILIO_ACCOUNT_SID = "ACtest0000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "fake-test-auth-token";
  // A leftover global SID must never be used as a fallback.
  process.env.TWILIO_MESSAGING_SERVICE_SID = `MG${"9f".repeat(16)}`;

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ sid: "SMmanual1", status: "queued" }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("manual SMS per-studio gate", () => {
  it("approved studio: Twilio called once with that studio's Messaging Service; log is studio-scoped", async () => {
    const db = seed([registration(STUDIO_A), registration(STUDIO_B)]);

    const response = await POST(sendRequest());

    expect(response.status).toBe(200);
    expect(twilioCalls()).toHaveLength(1);
    const params = new URLSearchParams(String((twilioCalls()[0] as [string, RequestInit])[1].body));
    expect(params.get("MessagingServiceSid")).toBe(SERVICE_A);
    expect(params.get("MessagingServiceSid")).not.toBe(SERVICE_B);
    expect(String(params.get("Body"))).toContain("Harbor Dance Studio: Reply STOP");
    expect(db.rows("sms_message_logs")).toHaveLength(1);
    expect(db.rows("sms_message_logs")[0]).toMatchObject({ studio_id: STUDIO_A, client_id: CLIENT_ID });
  });

  it.each(["not_registered", "in_review", "rejected", "suspended"])(
    "%s studio fails closed with no Twilio call and no log row",
    async (status) => {
      const db = seed([registration(STUDIO_A, { registration_status: status })]);

      const response = await POST(sendRequest());

      expect(response.status).toBe(503);
      expect(twilioCalls()).toHaveLength(0);
      expect(db.rows("sms_message_logs")).toHaveLength(0);
    },
  );

  it("studio with no registration fails closed even though a global SID is configured", async () => {
    seed([registration(STUDIO_B)]);

    const response = await POST(sendRequest());

    expect(response.status).toBe(503);
    expect(twilioCalls()).toHaveLength(0);
  });

  it("global kill switch blocks an approved studio", async () => {
    process.env.DANCEFLOW_SMS_STATUS = "disabled";
    seed([registration(STUDIO_A)]);

    const response = await POST(sendRequest());

    expect(response.status).toBe(503);
    expect(twilioCalls()).toHaveLength(0);
  });

  it("another studio's consent cannot authorize this studio's send", async () => {
    seed([registration(STUDIO_A)], [permission({ studio_id: STUDIO_B })]);

    const response = await POST(sendRequest());

    expect(response.status).toBe(400);
    expect(twilioCalls()).toHaveLength(0);
  });
});

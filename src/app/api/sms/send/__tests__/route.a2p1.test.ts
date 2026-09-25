import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/** A2P-1A regression: manual studio-to-client SMS keeps its consent, approval and footer model. */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

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

const STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const PHONE_E164 = "+15550100123";

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

function seed(permissions: FakeRow[]) {
  fake.current = createFakeSupabase({
    studios: [{ id: STUDIO_ID, name: "Harbor Dance Studio" }],
    clients: [{ id: CLIENT_ID, studio_id: STUDIO_ID, phone: "(555) 010-0123" }],
    sms_contact_permissions: permissions,
  });
  return fake.current;
}

function permission(overrides: FakeRow = {}): FakeRow {
  return {
    id: "perm-1",
    studio_id: STUDIO_ID,
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
    headers: { "content-type": "application/json", "x-forwarded-for": `198.18.0.${++ipCounter}` },
    body: JSON.stringify({ clientId: CLIENT_ID, body: "Hi Alex, can we move Thursday's lesson to 5 PM?" }),
  });
}

function twilioCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("api.twilio.com"));
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];

  process.env.DANCEFLOW_SMS_STATUS = "approved";
  process.env.TWILIO_ACCOUNT_SID = "ACtest0000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "fake-test-auth-token";
  process.env.TWILIO_MESSAGING_SERVICE_SID = "MGtest0000000000000000000000000000";

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ sid: "SMmanual1", status: "queued" }), { status: 201 }),
  );
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

describe("manual studio SMS", () => {
  it("opted-in client -> sent once via Messaging Service with the studio footer and a log row", async () => {
    const db = seed([permission()]);

    const response = await POST(sendRequest());

    expect(response.status).toBe(200);
    expect(twilioCalls()).toHaveLength(1);

    const params = new URLSearchParams(String((twilioCalls()[0] as [string, RequestInit])[1].body));
    expect(params.get("MessagingServiceSid")).toBe("MGtest0000000000000000000000000000");
    expect(params.get("To")).toBe(PHONE_E164);
    expect(String(params.get("Body"))).toMatch(/Harbor Dance Studio: Reply STOP to opt out\. Reply HELP for help\.$/);

    expect(db.rows("sms_message_logs")[0]).toMatchObject({
      client_id: CLIENT_ID,
      message_type: "manual",
      provider_message_id: "SMmanual1",
    });
  });

  const blocked: Array<{ name: string; permissions: FakeRow[]; status: number }> = [
    { name: "no consent row", permissions: [], status: 400 },
    { name: "unknown consent", permissions: [permission({ consent_status: "unknown" })], status: 400 },
    {
      name: "opted out",
      permissions: [permission({ consent_status: "opted_out", opted_out_at: "2026-10-02T00:00:00.000Z" })],
      status: 400,
    },
  ];

  for (const testCase of blocked) {
    it(`${testCase.name} -> blocked (${testCase.status}), no Twilio call`, async () => {
      const db = seed(testCase.permissions);

      const response = await POST(sendRequest());

      expect(response.status).toBe(testCase.status);
      expect(twilioCalls()).toHaveLength(0);
      expect(db.rows("sms_message_logs")).toHaveLength(0);
    });
  }

  it("Twilio failure -> 500 with generic response; only a sanitized code is persisted or logged", async () => {
    process.env.TWILIO_STATUS_CALLBACK_SECRET = "fake-callback-secret";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = seed([permission()]);
    const rawProviderMessage =
      `The 'To' number ${PHONE_E164} is not valid. StatusCallback https://example.test/api/sms/twilio/status?secret=fake-callback-secret rejected.`;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 21211, message: rawProviderMessage }), { status: 400 }),
    );

    const response = await POST(sendRequest());
    const responseText = await response.text();

    expect(twilioCalls()).toHaveLength(1);
    expect(response.status).toBe(500);
    expect(JSON.parse(responseText)).toEqual({
      ok: false,
      error: "The text could not be sent. Please try again.",
    });

    const log = db.rows("sms_message_logs")[0];
    expect(log).toMatchObject({
      status: "failed",
      provider_error_code: "21211",
      provider_error_message: "Twilio error 21211",
    });

    const logged = errorSpy.mock.calls.flat().map(String).join("\n");

    for (const surface of [String(log.provider_error_message), responseText, logged]) {
      expect(surface).not.toContain("fake-callback-secret");
      expect(surface).not.toContain("secret=");
      expect(surface).not.toContain(PHONE_E164);
      expect(surface).not.toContain(rawProviderMessage);
    }
  });

  it("platform not approved -> blocked (503), no Twilio call", async () => {
    process.env.DANCEFLOW_SMS_STATUS = "pending_review";
    const db = seed([permission()]);

    const response = await POST(sendRequest());

    expect(response.status).toBe(503);
    expect(twilioCalls()).toHaveLength(0);
    expect(db.rows("sms_message_logs")).toHaveLength(0);
  });
});

describe("manual send UI notice", () => {
  it("tells staff texts are service-related only", () => {
    const card = readFileSync(
      join(process.cwd(), "src", "app", "app", "clients", "[id]", "ClientSendSmsCard.tsx"),
      "utf8",
    );

    expect(card).toContain("Service-related messages only. Do not send promotional content.");
  });
});

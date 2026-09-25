import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/** A2P-1A: automated SMS dispatch fails closed and sends only through the approved path. */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake.current!.client,
}));

vi.mock("@/lib/aria/outcome-verification", () => ({
  getAriaOutcomeExpectation: () => null,
  verifyPendingAriaOutcomes: async () => ({ checked: 0 }),
}));

import { dispatchQueuedOutboundDeliveries } from "@/lib/notifications/dispatch";

const STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CLIENT_ID = "44444444-4444-4444-8444-444444444444";
const PHONE_RAW = "(555) 010-0123";
const PHONE_E164 = "+15550100123";

const fetchMock = vi.fn();

const ENV_KEYS = [
  "DANCEFLOW_SMS_STATUS",
  "SMS_PLATFORM_STATUS",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_MESSAGE_SERVICE_SID",
  "TWILIO_FROM_NUMBER",
  "TWILIO_STATUS_CALLBACK_SECRET",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function smsRow(overrides: FakeRow = {}, payloadOverrides: FakeRow = {}): FakeRow {
  return {
    id: "delivery-1",
    studio_id: STUDIO_ID,
    channel: "sms",
    template_key: "appointment_confirmed",
    recipient_email: null,
    recipient_phone: PHONE_RAW,
    subject: null,
    body_text: null,
    body_html: null,
    reply_to_email: null,
    status: "queued",
    related_table: "appointments",
    related_id: "appt-1",
    created_at: "2026-10-01T00:00:00.000Z",
    payload: {
      appointmentLabel: "Private Lesson",
      startsAt: "2026-10-14T22:00:00.000Z",
      endsAt: "2026-10-14T22:45:00.000Z",
      studioTimeZone: "America/New_York",
      clientFirstName: "Alex",
      instructorFirstName: "Jamie",
      instructorLastName: "Rivera",
      recipientRole: "primary",
      recipientClientId: CLIENT_ID,
      ...payloadOverrides,
    },
    ...overrides,
  };
}

function permission(overrides: FakeRow = {}): FakeRow {
  return {
    id: `perm-${Math.random()}`,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    phone_e164: PHONE_E164,
    consent_status: "opted_in",
    opted_out_at: null,
    updated_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function seed(rows: { delivery?: FakeRow; permissions?: FakeRow[] } = {}) {
  fake.current = createFakeSupabase({
    outbound_deliveries: [rows.delivery ?? smsRow()],
    sms_contact_permissions: rows.permissions ?? [],
    studios: [{ id: STUDIO_ID, name: "Harbor Dance Studio" }],
  });
  return fake.current;
}

function deliveryRow() {
  return fake.current!.rows("outbound_deliveries")[0];
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
  process.env.TWILIO_FROM_NUMBER = "+15550109999";
  process.env.TWILIO_STATUS_CALLBACK_SECRET = "fake-callback-secret";

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ sid: "SMtest123", status: "queued" }), { status: 201 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("automated SMS fails closed", () => {
  const skipCases: Array<{
    name: string;
    reason: string;
    setup: () => void;
  }> = [
    {
      name: "platform not approved",
      reason: "sms_not_approved",
      setup: () => {
        process.env.DANCEFLOW_SMS_STATUS = "rejected";
        seed({ permissions: [permission()] });
      },
    },
    {
      name: "invalid phone",
      reason: "sms_invalid_phone",
      setup: () => seed({ delivery: smsRow({ recipient_phone: "12345" }), permissions: [permission()] }),
    },
    {
      name: "missing recipientClientId",
      reason: "sms_no_consent",
      setup: () =>
        seed({ delivery: smsRow({}, { recipientClientId: undefined }), permissions: [permission()] }),
    },
    {
      name: "malformed recipientClientId",
      reason: "sms_no_consent",
      setup: () =>
        seed({ delivery: smsRow({}, { recipientClientId: "not-a-uuid" }), permissions: [permission()] }),
    },
    {
      name: "no consent row",
      reason: "sms_no_consent",
      setup: () => seed({ permissions: [] }),
    },
    {
      name: "unknown consent",
      reason: "sms_no_consent",
      setup: () => seed({ permissions: [permission({ consent_status: "unknown" })] }),
    },
    {
      name: "consent row only for a different client",
      reason: "sms_no_consent",
      setup: () => seed({ permissions: [permission({ client_id: OTHER_CLIENT_ID })] }),
    },
    {
      name: "consent row only in a different studio",
      reason: "sms_no_consent",
      setup: () => seed({ permissions: [permission({ studio_id: OTHER_STUDIO_ID })] }),
    },
    {
      name: "exact row opted out",
      reason: "sms_opted_out",
      setup: () =>
        seed({
          permissions: [
            permission({ consent_status: "opted_out", opted_out_at: "2026-10-02T00:00:00.000Z" }),
          ],
        }),
    },
    {
      name: "opted-in row but another row for the same studio+phone is opted out",
      reason: "sms_opted_out",
      setup: () =>
        seed({
          permissions: [
            permission(),
            permission({
              client_id: OTHER_CLIENT_ID,
              consent_status: "opted_out",
              opted_out_at: "2026-10-02T00:00:00.000Z",
            }),
          ],
        }),
    },
    {
      name: "event registration template",
      reason: "sms_template_not_permitted",
      setup: () =>
        seed({
          delivery: smsRow({ template_key: "event_registration_confirmed", body_text: "Confirmed: Gala." }),
          permissions: [permission()],
        }),
    },
    {
      name: "event waitlist template",
      reason: "sms_template_not_permitted",
      setup: () =>
        seed({
          delivery: smsRow({ template_key: "event_waitlist_confirmation", body_text: "Waitlist." }),
          permissions: [permission()],
        }),
    },
    {
      name: "event reminder template",
      reason: "sms_template_not_permitted",
      setup: () =>
        seed({
          delivery: smsRow({ template_key: "event_registration_reminder_24h", body_text: "Reminder." }),
          permissions: [permission()],
        }),
    },
  ];

  for (const testCase of skipCases) {
    it(`${testCase.name} -> skipped (${testCase.reason}), zero Twilio calls`, async () => {
      testCase.setup();

      const result = await dispatchQueuedOutboundDeliveries(25, { origin: "https://example.test" });

      expect(twilioCalls()).toHaveLength(0);
      expect(result).toMatchObject({ processed: 1, sent: 0, failed: 0, skipped: 1 });
      expect(deliveryRow()).toMatchObject({ status: "skipped", error_message: testCase.reason });
      expect(fake.current!.rows("sms_message_logs")).toHaveLength(0);

      // Reason codes never carry phone numbers or message bodies.
      expect(String(deliveryRow().error_message)).not.toMatch(/\d{7,}|\+1|Alex|lesson/i);
    });
  }
});

describe("automated SMS approved send path", () => {
  it("permitted template + exact opted-in consent sends exactly once via the Messaging Service", async () => {
    seed({ permissions: [permission()] });

    const result = await dispatchQueuedOutboundDeliveries(25, { origin: "https://example.test" });

    expect(result).toMatchObject({ processed: 1, sent: 1, failed: 0, skipped: 0 });

    const calls = twilioCalls();
    expect(calls).toHaveLength(1);

    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toContain("/Messages.json");

    const params = new URLSearchParams(String(init.body));
    expect(params.get("MessagingServiceSid")).toBe("MGtest0000000000000000000000000000");
    expect(params.get("From")).toBeNull();
    expect(params.get("To")).toBe(PHONE_E164);

    const body = String(params.get("Body"));
    expect(body).toContain("Your private lesson is confirmed");
    expect(body.endsWith("Harbor Dance Studio: Reply STOP to opt out. Reply HELP for help.")).toBe(true);

    expect(params.get("StatusCallback")).toBe(
      "https://example.test/api/sms/twilio/status?secret=fake-callback-secret",
    );

    expect(deliveryRow()).toMatchObject({ status: "sent", provider_message_id: "SMtest123" });

    const logs = fake.current!.rows("sms_message_logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      studio_id: STUDIO_ID,
      client_id: CLIENT_ID,
      phone_e164: PHONE_E164,
      direction: "outbound",
      message_type: "appointment_confirmed",
      provider: "twilio",
      provider_message_id: "SMtest123",
      related_table: "appointments",
      related_id: "appt-1",
      body,
    });
  });

  it("sends without a status callback when no origin is available", async () => {
    seed({ permissions: [permission()] });

    await dispatchQueuedOutboundDeliveries(25);

    const params = new URLSearchParams(String((twilioCalls()[0] as [string, RequestInit])[1].body));
    expect(params.get("StatusCallback")).toBeNull();
  });

  it("records a code-only failure and never persists raw Twilio text (phone, callback secret)", async () => {
    seed({ permissions: [permission()] });
    const rawProviderMessage =
      `The 'To' number ${PHONE_E164} is not valid. StatusCallback https://example.test/api/sms/twilio/status?secret=fake-callback-secret rejected.`;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 21211, message: rawProviderMessage }), { status: 400 }),
    );

    const result = await dispatchQueuedOutboundDeliveries(25, { origin: "https://example.test" });

    expect(result).toMatchObject({ sent: 0, failed: 1, skipped: 0 });
    expect(deliveryRow()).toMatchObject({ status: "failed", error_message: "sms_send_failed:21211" });

    const log = fake.current!.rows("sms_message_logs")[0];
    expect(log).toMatchObject({
      status: "failed",
      provider_error_code: "21211",
      provider_error_message: "Twilio error 21211",
    });

    for (const persisted of [String(log.provider_error_message), String(deliveryRow().error_message)]) {
      expect(persisted).not.toContain("fake-callback-secret");
      expect(persisted).not.toContain("secret=");
      expect(persisted).not.toContain(PHONE_E164);
      expect(persisted).not.toContain("5550100123");
      expect(persisted).not.toContain(rawProviderMessage);
    }
  });

  it("uses the generic provider message when Twilio returns no error code", async () => {
    seed({ permissions: [permission()] });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: `Rejected ${PHONE_E164} ?secret=fake-callback-secret` }), {
        status: 500,
      }),
    );

    await dispatchQueuedOutboundDeliveries(25, { origin: "https://example.test" });

    expect(fake.current!.rows("sms_message_logs")[0]).toMatchObject({
      status: "failed",
      provider_error_code: null,
      provider_error_message: "The text could not be sent.",
    });
    expect(deliveryRow()).toMatchObject({ status: "failed", error_message: "sms_send_failed" });
  });
});

describe("A2P-1A source guards", () => {
  const ROOT = process.cwd();
  const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

  function productionSourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        return entry === "__tests__" || entry === "migrations" ? [] : productionSourceFiles(full);
      }
      return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
    });
  }

  it("no application path sends SMS from TWILIO_FROM_NUMBER or calls twilio messages.create", () => {
    const offenders = productionSourceFiles(join(ROOT, "src")).filter((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes("TWILIO_FROM_NUMBER") || /messages\.create\(/.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it("schedule enqueue carries recipientClientId and gates SMS on Twilio config + approval", () => {
    const schedule = read("src", "app", "app", "schedule", "actions.ts");

    expect(schedule).toMatch(/recipientRole,\s*recipientClientId,/);
    expect(schedule).toContain('queueRecipient(client, "primary", clientId);');
    expect(schedule).toContain('queueRecipient(partnerClient, "partner", partnerClientId);');
    expect(schedule).toContain("const smsConfigured = isTwilioConfigured() && isSmsSendingApproved();");
  });

  it("event SMS enqueue sites are unchanged; dispatch rejects their templates", () => {
    const register = read("src", "app", "events", "[slug]", "register", "actions.ts");

    expect(register).toContain('templateKey: "event_waitlist_confirmation"');
    expect(register).toContain('templateKey: "event_registration_confirmed"');
    expect(register).toContain('channel: "sms"');

    const compliance = read("src", "lib", "sms", "compliance.ts");
    expect(compliance).not.toMatch(/"event_[a-z_]+"/);
  });
});

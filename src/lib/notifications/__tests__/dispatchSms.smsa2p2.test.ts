import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/** SMS-A2P-2: automated appointment SMS resolves the studio's own approved registration. */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake.current!.client,
}));
vi.mock("@/lib/aria/outcome-verification", () => ({
  getAriaOutcomeExpectation: () => null,
  verifyPendingAriaOutcomes: async () => ({ checked: 0 }),
}));

import { dispatchQueuedOutboundDeliveries } from "@/lib/notifications/dispatch";

const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const PHONE_E164 = "+15550100123";
const SERVICE_A = `MG${"a1".repeat(16)}`;
const SERVICE_B = `MG${"b2".repeat(16)}`;
const fetchMock = vi.fn();

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

function smsRow(templateKey = "appointment_confirmed", studioId = STUDIO_A): FakeRow {
  return {
    id: "delivery-1",
    studio_id: studioId,
    channel: "sms",
    template_key: templateKey,
    recipient_email: null,
    recipient_phone: "(555) 010-0123",
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
      recipientRole: "primary",
      recipientClientId: CLIENT_ID,
    },
  };
}

function permission(studioId = STUDIO_A): FakeRow {
  return {
    id: `perm-${studioId}`,
    studio_id: studioId,
    client_id: CLIENT_ID,
    phone_e164: PHONE_E164,
    consent_status: "opted_in",
    opted_out_at: null,
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}

function seed(options: { registrations: FakeRow[]; permissions?: FakeRow[]; delivery?: FakeRow }) {
  fake.current = createFakeSupabase({
    outbound_deliveries: [options.delivery ?? smsRow()],
    sms_contact_permissions: options.permissions ?? [permission()],
    studios: [
      { id: STUDIO_A, name: "Harbor Dance Studio" },
      { id: STUDIO_B, name: "Lakeside Ballroom" },
    ],
    studio_sms_registrations: options.registrations,
  });
  return fake.current;
}

const twilioCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("api.twilio.com"));

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.DANCEFLOW_SMS_STATUS = "approved";
  process.env.TWILIO_ACCOUNT_SID = "ACtest0000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "fake-test-auth-token";
  process.env.TWILIO_MESSAGING_SERVICE_SID = `MG${"9f".repeat(16)}`;

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ sid: "SMtest123", status: "queued" }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("automated SMS per-studio gate", () => {
  it("approved studio sends once through its own Messaging Service; log is studio-scoped", async () => {
    const db = seed({ registrations: [registration(STUDIO_A), registration(STUDIO_B)] });

    const result = await dispatchQueuedOutboundDeliveries(25);

    expect(result).toMatchObject({ processed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(twilioCalls()).toHaveLength(1);
    const params = new URLSearchParams(String((twilioCalls()[0] as [string, RequestInit])[1].body));
    expect(params.get("MessagingServiceSid")).toBe(SERVICE_A);
    expect(params.get("MessagingServiceSid")).not.toBe(SERVICE_B);
    expect(String(params.get("Body"))).toContain("Harbor Dance Studio: Reply STOP");
    expect(db.rows("sms_message_logs")).toHaveLength(1);
    expect(db.rows("sms_message_logs")[0]).toMatchObject({ studio_id: STUDIO_A });
  });

  it.each(["not_registered", "in_review", "rejected", "suspended"])(
    "%s studio is skipped with sms_studio_not_approved and no Twilio call",
    async (status) => {
      const db = seed({ registrations: [registration(STUDIO_A, { registration_status: status })] });

      const result = await dispatchQueuedOutboundDeliveries(25);

      expect(result).toMatchObject({ sent: 0, skipped: 1 });
      expect(twilioCalls()).toHaveLength(0);
      expect(db.rows("sms_message_logs")).toHaveLength(0);
      expect(String(db.rows("outbound_deliveries")[0].error_message)).toContain("sms_studio_not_approved");
    },
  );

  it("no registration -> skipped, even with a global Messaging Service SID in the environment", async () => {
    seed({ registrations: [registration(STUDIO_B)] });

    const result = await dispatchQueuedOutboundDeliveries(25);

    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(twilioCalls()).toHaveLength(0);
  });

  it("global kill switch blocks an approved studio", async () => {
    process.env.DANCEFLOW_SMS_STATUS = "disabled";
    seed({ registrations: [registration(STUDIO_A)] });

    const result = await dispatchQueuedOutboundDeliveries(25);

    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(twilioCalls()).toHaveLength(0);
  });

  it("Studio B's consent and approved sender cannot authorize a Studio A send", async () => {
    seed({
      registrations: [registration(STUDIO_A, { registration_status: "in_review" }), registration(STUDIO_B)],
      permissions: [permission(STUDIO_B)],
    });

    const result = await dispatchQueuedOutboundDeliveries(25);

    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(twilioCalls()).toHaveLength(0);
  });

  it.each(["appointment_confirmed", "appointment_rescheduled", "appointment_cancelled"])(
    "%s remains permitted for an approved studio",
    async (templateKey) => {
      seed({ registrations: [registration(STUDIO_A)], delivery: smsRow(templateKey) });

      const result = await dispatchQueuedOutboundDeliveries(25);

      expect(result).toMatchObject({ sent: 1, skipped: 0 });
      expect(twilioCalls()).toHaveLength(1);
    },
  );

  it("event SMS stays blocked even for an approved studio", async () => {
    seed({ registrations: [registration(STUDIO_A)], delivery: smsRow("event_registration_confirmed") });

    const result = await dispatchQueuedOutboundDeliveries(25);

    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(twilioCalls()).toHaveLength(0);
  });
});

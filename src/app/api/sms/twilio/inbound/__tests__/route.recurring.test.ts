import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { createFakeSupabase as createBaseFake, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/**
 * Recurring service charges: a business that is SUSPENDED for an unpaid monthly charge keeps full inbound compliance handling. STOP, START and HELP are recorded and answered
 * exactly as for any other studio; the inbound route never asks about the recurring-charge state and nothing here can block a consumer's opt-out.
 */


const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fake.current!.client,
}));

import { POST } from "@/app/api/sms/twilio/inbound/route";
import {
  SMS_UNROUTED_REPLY,
  buildSmsHelpReply,
  buildSmsStartNoPriorConsentReply,
  buildSmsStartReply,
  buildSmsStopReply,
} from "@/lib/sms/compliance";

const TEST_TOKEN = "fake-test-auth-token";
const WEBHOOK_URL = "https://www.idanceflow.com/api/sms/twilio/inbound";
const PHONE = "+15550100123";
const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";
const SENDER_A = "+15550109999";
const SENDER_B = "+15550108888";
const SERVICE_A = `MG${"a1".repeat(16)}`;
const SERVICE_B = `MG${"b2".repeat(16)}`;

function createFakeSupabase(seed: Record<string, FakeRow[]> = {}) {
  const registration = (studioId: string, sid: string, sender: string): FakeRow => ({
    id: `reg-${studioId}`,
    studio_id: studioId,
    messaging_service_sid: sid,
    campaign_sid: `QE${"0f".repeat(16)}`,
    sender_e164: sender,
    registration_status: "approved",
  });

  return createBaseFake({
    studios: [
      { id: STUDIO_A, name: "Harbor Dance Studio" },
      { id: STUDIO_B, name: "Lakeside Ballroom" },
    ],
    studio_sms_registrations: [
      registration(STUDIO_A, SERVICE_A, SENDER_A),
      registration(STUDIO_B, SERVICE_B, SENDER_B),
    ],
    ...seed,
  });
}

const ENV_KEYS = ["TWILIO_AUTH_TOKEN", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};
let ipCounter = 0;

function permission(overrides: FakeRow): FakeRow {
  return {
    studio_id: STUDIO_A,
    organizer_id: null,
    client_id: "33333333-3333-4333-8333-333333333333",
    organizer_contact_id: null,
    phone_e164: PHONE,
    consent_status: "opted_in",
    consent_source: "studio_staff_manual",
    consent_at: "2026-09-01T00:00:00.000Z",
    opted_out_at: null,
    opted_out_source: null,
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function inboundRequest(
  body: string,
  options: {
    sign?: "valid" | "invalid" | "missing";
    ip?: string;
    from?: string;
    to?: string;
    serviceSid?: string;
  } = {},
) {
  const params: Record<string, string> = {
    From: options.from ?? PHONE,
    To: options.to ?? SENDER_A,
    Body: body,
    MessageSid: "SMinbound1",
  };
  if (options.serviceSid) params.MessagingServiceSid = options.serviceSid;
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "x-forwarded-for": options.ip ?? `203.0.113.${++ipCounter % 250}`,
  };

  const sign = options.sign ?? "valid";
  if (sign === "valid") headers["x-twilio-signature"] = getExpectedTwilioSignature(TEST_TOKEN, WEBHOOK_URL, params);
  if (sign === "invalid") headers["x-twilio-signature"] = "aW52YWxpZC1zaWduYXR1cmU=";

  return new Request(WEBHOOK_URL, { method: "POST", headers, body: new URLSearchParams(params).toString() });
}

function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/'/g, "&apos;");
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.TWILIO_AUTH_TOKEN = TEST_TOKEN;
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


function suspend(db: ReturnType<typeof createFakeSupabase>) {
  // the business is suspended; if anything on the inbound path asked, it would be told so
  db.overrideRpc("tw4_recurring_service_state", () => ({ data: "suspended", error: null }));
  return db;
}
const stateQueries = (db: ReturnType<typeof createFakeSupabase>) => db.rpcCalls.filter((c) => c.name === "tw4_recurring_service_state");

describe("a suspended business still processes STOP / START / HELP", () => {
  it("STOP opts the contact out, answers with the studio's stop reply, and never consults the recurring-charge state", async () => {
    const db = suspend(createFakeSupabase({ sms_contact_permissions: [permission({ id: "p1" })] }));
    fake.current = db;
    const response = await POST(inboundRequest("STOP"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(xmlEscape(buildSmsStopReply("Harbor Dance Studio")));
    expect(db.rows("sms_contact_permissions")[0]).toMatchObject({ consent_status: "opted_out", opted_out_source: "twilio_inbound_stop" });
    expect(db.rows("sms_message_logs")[0]).toMatchObject({ studio_id: STUDIO_A, direction: "inbound", message_type: "stop" });
    expect(stateQueries(db)).toHaveLength(0);
  });

  it("every standard opt-out keyword works for a suspended business", async () => {
    for (const keyword of ["STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]) {
      const db = suspend(createFakeSupabase({ sms_contact_permissions: [permission({ id: "p1" })] }));
      fake.current = db;
      await POST(inboundRequest(keyword));
      expect(db.rows("sms_contact_permissions")[0], keyword).toMatchObject({ consent_status: "opted_out" });
      expect(stateQueries(db)).toHaveLength(0);
    }
  });

  it("HELP is answered with the studio's help reply", async () => {
    const db = suspend(createFakeSupabase({ sms_contact_permissions: [permission({ id: "p1" })] }));
    fake.current = db;
    const response = await POST(inboundRequest("HELP"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(xmlEscape(buildSmsHelpReply("Harbor Dance Studio")));
    expect(stateQueries(db)).toHaveLength(0);
  });

  it("START records the opt-in again and is answered, for a contact who previously opted out", async () => {
    const db = suspend(createFakeSupabase({ sms_contact_permissions: [permission({ id: "p1", consent_status: "opted_out", opted_out_at: "2026-10-01T00:00:00.000Z", opted_out_source: "twilio_inbound_stop" })] }));
    fake.current = db;
    const response = await POST(inboundRequest("START"));
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/Response/);
    expect(db.rpcCalls.map((c) => c.name)).toEqual(["record_sms_inbound_opt_event"]);
    expect(stateQueries(db)).toHaveLength(0);
  });

  it("an ordinary message is logged for a suspended business and nothing is sent back by the application", async () => {
    const db = suspend(createFakeSupabase({ sms_contact_permissions: [permission({ id: "p1" })] }));
    fake.current = db;
    const response = await POST(inboundRequest("Can I reschedule Thursday?"));
    expect(response.status).toBe(200);
    expect(db.rows("sms_message_logs").filter((r) => r.direction === "outbound")).toHaveLength(0);
    expect(stateQueries(db)).toHaveLength(0);
  });
});

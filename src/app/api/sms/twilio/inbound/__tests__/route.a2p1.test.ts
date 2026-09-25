import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/** A2P-1A: inbound Twilio webhook — signature first, STOP/START/HELP semantics. */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => fake.current!.client,
}));

import { POST } from "@/app/api/sms/twilio/inbound/route";
import {
  SMS_HELP_REPLY,
  SMS_START_NO_PRIOR_CONSENT_REPLY,
  SMS_START_REPLY,
  SMS_STOP_REPLY,
} from "@/lib/sms/compliance";

const TEST_TOKEN = "fake-test-auth-token";
const WEBHOOK_URL = "https://www.idanceflow.com/api/sms/twilio/inbound";
const PHONE = "+15550100123";
const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";

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
  options: { sign?: "valid" | "invalid" | "missing"; ip?: string; from?: string } = {},
) {
  const params = { From: options.from ?? PHONE, To: "+15550109999", Body: body, MessageSid: "SMinbound1" };
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

describe("signature enforcement", () => {
  for (const sign of ["invalid", "missing"] as const) {
    it(`${sign} signature -> 403 and zero database access or mutation`, async () => {
      fake.current = createFakeSupabase({
        sms_contact_permissions: [permission({ id: "p1" })],
      });
      const fromSpy = vi.spyOn(fake.current.client, "from");

      const response = await POST(inboundRequest("STOP", { sign }));

      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("<Response>");
      expect(fromSpy).not.toHaveBeenCalled();
      expect(fake.current.mutations).toHaveLength(0);
      expect(fake.current.rows("sms_contact_permissions")[0]).toMatchObject({ consent_status: "opted_in" });
    });
  }

  it("missing auth token -> 503 and no mutation", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "p1" })] });

    const params = { From: PHONE, To: "+15550109999", Body: "STOP", MessageSid: "SMinbound1" };
    const response = await POST(
      new Request(WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": getExpectedTwilioSignature(TEST_TOKEN, WEBHOOK_URL, params),
        },
        body: new URLSearchParams(params).toString(),
      }),
    );

    expect(response.status).toBe(503);
    expect(fake.current.mutations).toHaveLength(0);
  });

  it("valid Twilio requests from one shared IP are never rate limited", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "p1" })] });

    for (let index = 0; index < 40; index += 1) {
      const response = await POST(inboundRequest("STOP", { ip: "198.51.100.7" }));
      expect(response.status).toBe(200);
    }
  });

  it("repeated rejected requests from one IP are rate limited", async () => {
    fake.current = createFakeSupabase({});
    const statuses: number[] = [];

    for (let index = 0; index < 35; index += 1) {
      statuses.push((await POST(inboundRequest("STOP", { sign: "invalid", ip: "198.51.100.99" }))).status);
    }

    expect(statuses.slice(0, 30).every((status) => status === 403)).toBe(true);
    expect(statuses.slice(30).every((status) => status === 429)).toBe(true);
  });
});

describe("STOP", () => {
  it("opts out every row for the phone and preserves consent_source and consent_at", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [
        permission({ id: "p1", consent_source: "studio_staff_manual" }),
        permission({ id: "p2", studio_id: STUDIO_B, consent_source: "public_lead_form" }),
      ],
    });

    const response = await POST(inboundRequest("stop"));
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain(xmlEscape(SMS_STOP_REPLY));

    const [p1, p2] = fake.current.rows("sms_contact_permissions");
    expect(p1).toMatchObject({
      consent_status: "opted_out",
      opted_out_source: "twilio_inbound_stop",
      consent_source: "studio_staff_manual",
      consent_at: "2026-09-01T00:00:00.000Z",
    });
    expect(p1.opted_out_at).toBeTruthy();
    expect(p2).toMatchObject({ consent_status: "opted_out", consent_source: "public_lead_form" });

    const inboundLogs = fake.current.rows("sms_message_logs");
    expect(inboundLogs).toHaveLength(2);
    expect(inboundLogs[0]).toMatchObject({ direction: "inbound", message_type: "stop", status: "received" });
  });

  it.each(["STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"])("%s is treated as STOP", async (keyword) => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "p1" })] });

    await POST(inboundRequest(keyword));

    expect(fake.current.rows("sms_contact_permissions")[0]).toMatchObject({ consent_status: "opted_out" });
  });
});

describe("START", () => {
  it("re-opts only opted-out rows that have prior consent evidence", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [
        permission({
          id: "prior",
          consent_status: "opted_out",
          consent_at: "2026-09-01T00:00:00.000Z",
          opted_out_at: "2026-09-10T00:00:00.000Z",
          opted_out_source: "twilio_inbound_stop",
        }),
        permission({
          id: "never",
          studio_id: STUDIO_B,
          consent_status: "opted_out",
          consent_at: null,
          opted_out_at: "2026-09-10T00:00:00.000Z",
          opted_out_source: "studio_staff_manual",
        }),
        permission({ id: "unknown", consent_status: "unknown", consent_at: null, consent_source: null }),
      ],
    });

    const response = await POST(inboundRequest("START"));
    expect(await response.text()).toContain(xmlEscape(SMS_START_REPLY));

    const rows = Object.fromEntries(
      fake.current.rows("sms_contact_permissions").map((row) => [String(row.id), row]),
    );

    expect(rows.prior).toMatchObject({
      consent_status: "opted_in",
      consent_source: "twilio_inbound_start",
      opted_out_at: null,
      opted_out_source: null,
    });
    expect(rows.prior.consent_at).not.toBe("2026-09-01T00:00:00.000Z");
    expect(rows.never).toMatchObject({ consent_status: "opted_out", consent_at: null });
    expect(rows.unknown).toMatchObject({ consent_status: "unknown", consent_at: null });
  });

  it("does not create initial consent for unknown-only rows", async () => {
    fake.current = createFakeSupabase({
      sms_contact_permissions: [permission({ id: "unknown", consent_status: "unknown", consent_at: null })],
    });

    const response = await POST(inboundRequest("YES"));

    expect(await response.text()).toContain(xmlEscape(SMS_START_NO_PRIOR_CONSENT_REPLY));
    expect(fake.current.rows("sms_contact_permissions")[0]).toMatchObject({ consent_status: "unknown" });
    expect(fake.current.mutations.filter((mutation) => mutation.table === "sms_contact_permissions")).toHaveLength(0);
  });

  it("does not create any consent row for an unknown phone", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [] });

    const response = await POST(inboundRequest("UNSTOP"));

    expect(await response.text()).toContain(xmlEscape(SMS_START_NO_PRIOR_CONSENT_REPLY));
    expect(fake.current.rows("sms_contact_permissions")).toHaveLength(0);
  });
});

describe("HELP", () => {
  it("returns the exact branded single-segment response", async () => {
    fake.current = createFakeSupabase({ sms_contact_permissions: [permission({ id: "p1" })] });

    for (const keyword of ["HELP", "info"]) {
      const response = await POST(inboundRequest(keyword));
      expect(await response.text()).toBe(`<Response><Message>${xmlEscape(SMS_HELP_REPLY)}</Message></Response>`);
    }

    expect(SMS_HELP_REPLY).toBe(
      "DanceFlow, operated by GenX TotalTech LLC: For help, contact support@idanceflow.com or your dance studio. Reply STOP to opt out. Msg&data rates may apply.",
    );
    expect(SMS_HELP_REPLY.length).toBeLessThanOrEqual(160);
    expect(/^[\x20-\x7e]*$/.test(SMS_HELP_REPLY)).toBe(true);
    expect(fake.current.rows("sms_contact_permissions")[0]).toMatchObject({ consent_status: "opted_in" });
  });
});

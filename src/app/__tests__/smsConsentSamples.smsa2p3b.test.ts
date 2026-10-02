import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/**
 * SMS-A2P-3B: the public /sms-consent sample messages must equal what DanceFlow actually
 * sends. The expected bodies are produced by the real dispatcher (Twilio mocked), not
 * restated here.
 */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake.current!.client,
}));
vi.mock("@/lib/aria/outcome-verification", () => ({
  getAriaOutcomeExpectation: () => null,
  verifyPendingAriaOutcomes: async () => ({ checked: 0 }),
}));

import { dispatchQueuedOutboundDeliveries } from "@/lib/notifications/dispatch";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const SERVICE_SID = `MG${"a1".repeat(16)}`;
const fetchMock = vi.fn();

const ENV_KEYS = ["DANCEFLOW_SMS_STATUS", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const;
const savedEnv: Record<string, string | undefined> = {};

const page = readFileSync(join(process.cwd(), "src", "app", "sms-consent", "page.tsx"), "utf8").replace(
  /\r\n/g,
  "\n",
);

const FOOTER = "Harbor Dance Studio: Reply STOP to opt out. Reply HELP for help.";

/** The sample message literals shown on the page, with escapes resolved as React renders them. */
function pageSamples() {
  const samples = [...page.matchAll(/<SampleMessage>\s*\{`([\s\S]*?)`\}\s*<\/SampleMessage>/g)].map((match) =>
    match[1].replace(/\\n/g, "\n").replace("${STOP_HELP_FOOTER}", FOOTER),
  );
  return samples;
}

function delivery(templateKey: string, payload: FakeRow): FakeRow {
  return {
    id: `delivery-${templateKey}`,
    studio_id: STUDIO,
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
      studioTimeZone: "America/New_York",
      clientFirstName: "Alex",
      instructorFirstName: "Jamie",
      instructorLastName: "Rivera",
      recipientRole: "primary",
      recipientClientId: CLIENT,
      ...payload,
    },
  };
}

async function actualBody(templateKey: string, payload: FakeRow) {
  fake.current = createFakeSupabase({
    outbound_deliveries: [delivery(templateKey, payload)],
    sms_contact_permissions: [
      {
        id: "perm-1",
        studio_id: STUDIO,
        client_id: CLIENT,
        phone_e164: "+15550100123",
        consent_status: "opted_in",
        opted_out_at: null,
        updated_at: "2026-10-01T00:00:00.000Z",
      },
    ],
    studios: [{ id: STUDIO, name: "Harbor Dance Studio" }],
    studio_sms_registrations: [
      {
        id: "reg-1",
        studio_id: STUDIO,
        messaging_service_sid: SERVICE_SID,
        campaign_sid: `QE${"0f".repeat(16)}`,
        sender_e164: "+15550109999",
        registration_status: "approved",
      },
    ],
  });
  fetchMock.mockClear();

  await dispatchQueuedOutboundDeliveries(25);

  const call = fetchMock.mock.calls.find(([url]) => String(url).includes("api.twilio.com"));
  expect(call).toBeTruthy();
  return String(new URLSearchParams(String((call as [string, RequestInit])[1].body)).get("Body"));
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.DANCEFLOW_SMS_STATUS = "approved";
  process.env.TWILIO_ACCOUNT_SID = "ACtest0000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "fake-test-auth-token";
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ sid: "SMtest", status: "queued" }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("/sms-consent samples equal real SMS output", () => {
  it("shows exactly four samples: three automatic appointment messages and one staff message", () => {
    expect(pageSamples()).toHaveLength(4);
  });

  it("confirmation sample matches the real confirmation (including the end-time line)", async () => {
    const body = await actualBody("appointment_confirmed", {
      startsAt: "2026-10-14T22:00:00.000Z",
      endsAt: "2026-10-14T22:30:00.000Z",
    });

    expect(pageSamples()[0]).toBe(body);
    expect(body).toContain("Wed, Oct 14, 2026, 6:00 PM EDT");
    expect(body).toContain("It is scheduled to end at Wed, Oct 14, 2026, 6:30 PM EDT.");
  });

  it("reschedule sample matches the real reschedule (including end time and instructor)", async () => {
    const body = await actualBody("appointment_rescheduled", {
      startsAt: "2026-10-16T21:00:00.000Z",
      endsAt: "2026-10-16T21:30:00.000Z",
    });

    expect(pageSamples()[1]).toBe(body);
    expect(body).toContain("Fri, Oct 16, 2026, 5:00 PM EDT");
  });

  it("cancellation sample matches the real cancellation", async () => {
    const body = await actualBody("appointment_cancelled", {
      startsAt: "2026-10-16T21:00:00.000Z",
      endsAt: "2026-10-16T21:30:00.000Z",
    });

    expect(pageSamples()[2]).toBe(body);
  });

  it("staff sample carries the same studio footer the manual send path appends", () => {
    const staff = pageSamples()[3];

    expect(staff.endsWith(`\n\n${FOOTER}`)).toBe(true);
    expect(staff).toContain("Harbor Dance Studio");
  });

  it("the sample dates name the correct weekdays", () => {
    const weekday = (iso: string) =>
      new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" });

    expect(weekday("2026-10-14")).toBe("Wed");
    expect(weekday("2026-10-16")).toBe("Fri");
    expect(page).not.toMatch(/Tue, Oct 14|Thu, Oct 16/);
  });

  it("public scope is unchanged: no event, ticket, marketing-offer or reminder claims", () => {
    expect(page).not.toMatch(/event|ticket|reminder|promo code|% off/i);
    expect(page).toContain("No marketing or promotional text messages are sent under this program.");
  });
});

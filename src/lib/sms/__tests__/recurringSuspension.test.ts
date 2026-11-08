import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/**
 * Recurring service charges: a SUSPENDED business cannot start new outbound texts (manual sends and automated appointment texts), fail-closed, while the check
 * does not exist for a business that never authorized a recurring charge, and does not break an environment where the feature is not installed.
 * Inbound STOP / START / HELP is covered in the inbound route's own test file.
 */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.current!.client }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fake.current!.client }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "11111111-1111-4111-8111-111111111111", studioRole: "studio_owner" }),
}));
vi.mock("@/lib/aria/outcome-verification", () => ({
  getAriaOutcomeExpectation: () => null,
  verifyPendingAriaOutcomes: async () => ({ checked: 0 }),
}));

import { POST } from "@/app/api/sms/send/route";
import { dispatchQueuedOutboundDeliveries } from "@/lib/notifications/dispatch";
import { resolveStudioFromInboundSender, resolveStudioSmsSender } from "@/lib/sms/studioSender";

const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const PHONE_E164 = "+15550100123";
const SERVICE_A = `MG${"a1".repeat(16)}`;
const SERVICE_B = `MG${"b2".repeat(16)}`;
const fetchMock = vi.fn();
let ipCounter = 0;

const ENV_KEYS = ["DANCEFLOW_SMS_STATUS", "SMS_PLATFORM_STATUS", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID", "TWILIO_MESSAGE_SERVICE_SID", "TWILIO_STATUS_CALLBACK_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};

const registration = (studioId: string, overrides: FakeRow = {}): FakeRow => ({
  id: `reg-${studioId}`,
  studio_id: studioId,
  messaging_service_sid: studioId === STUDIO_A ? SERVICE_A : SERVICE_B,
  campaign_sid: `QE${"0f".repeat(16)}`,
  sender_e164: studioId === STUDIO_A ? "+15550109999" : "+15550108888",
  registration_status: "approved",
  ...overrides,
});
const permission = (studioId = STUDIO_A): FakeRow => ({
  id: `perm-${studioId}`, studio_id: studioId, client_id: CLIENT_ID, phone_e164: PHONE_E164, consent_status: "opted_in", opted_out_at: null, updated_at: "2026-10-01T00:00:00.000Z",
});
const smsRow = (studioId = STUDIO_A): FakeRow => ({
  id: "delivery-1", studio_id: studioId, channel: "sms", template_key: "appointment_confirmed", recipient_email: null, recipient_phone: "(555) 010-0123", subject: null, body_text: null, body_html: null,
  reply_to_email: null, status: "queued", related_table: "appointments", related_id: "appt-1", created_at: "2026-10-01T00:00:00.000Z",
  payload: { appointmentLabel: "Private Lesson", startsAt: "2026-10-14T22:00:00.000Z", endsAt: "2026-10-14T22:45:00.000Z", studioTimeZone: "America/New_York", clientFirstName: "Alex", recipientRole: "primary", recipientClientId: CLIENT_ID },
});

function seed(serviceState: unknown = "none", error: { code: string } | null = null) {
  fake.current = createFakeSupabase({
    studios: [{ id: STUDIO_A, name: "Harbor Dance Studio" }, { id: STUDIO_B, name: "Lakeside Ballroom" }],
    clients: [{ id: CLIENT_ID, studio_id: STUDIO_A, phone: "(555) 010-0123" }],
    sms_contact_permissions: [permission()],
    studio_sms_registrations: [registration(STUDIO_A), registration(STUDIO_B)],
    outbound_deliveries: [smsRow()],
  });
  if (serviceState !== "unset") {
    fake.current.overrideRpc("tw4_recurring_service_state", (args) => (args.p_studio_id === STUDIO_A ? { data: serviceState, error } : { data: "none", error: null }));
  }
  return fake.current;
}

const sendRequest = () =>
  new Request("https://example.test/api/sms/send", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.19.1.${++ipCounter}` },
    body: JSON.stringify({ clientId: CLIENT_ID, body: "Hi Alex, can we move Thursday's lesson to 5 PM?" }),
  });
const twilioCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("api.twilio.com"));

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.DANCEFLOW_SMS_STATUS = "approved";
  process.env.TWILIO_ACCOUNT_SID = "ACtest0000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "fake-test-auth-token";
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ sid: "SMtest123", status: "queued" }), { status: 201 }));
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

describe("the outbound sender resolver", () => {
  it("a suspended business gets no sender; every other state sends; the question is asked about THAT studio only", async () => {
    for (const state of ["none", "active", "past_due"]) {
      const db = seed(state);
      expect(await resolveStudioSmsSender(db.client as never, STUDIO_A)).toMatchObject({ ok: true });
      expect(db.rpcCalls.filter((c) => c.name === "tw4_recurring_service_state")).toEqual([{ name: "tw4_recurring_service_state", args: { p_studio_id: STUDIO_A } }]);
    }
    const suspended = seed("suspended");
    expect(await resolveStudioSmsSender(suspended.client as never, STUDIO_A)).toEqual({ ok: false, reason: "sms_service_suspended" });
    expect(await resolveStudioSmsSender(suspended.client as never, STUDIO_B)).toMatchObject({ ok: true }); // another studio (another business) is unaffected
  });

  it("fails closed: an unreadable state, an error, or an answer it does not understand blocks the send", async () => {
    const missing = seed("none");
    missing.overrideRpc("tw4_recurring_service_state", () => ({ data: undefined, error: null }));
    expect(await resolveStudioSmsSender(missing.client as never, STUDIO_A)).toEqual({ ok: false, reason: "sms_service_check_failed" });
    for (const odd of [null, "", "weird", "SUSPENDED ", 3, { state: "none" }]) {
      expect(await resolveStudioSmsSender(seed(odd).client as never, STUDIO_A), String(odd)).toEqual({ ok: false, reason: "sms_service_check_failed" });
    }
    for (const code of ["57014", "42501", "XX000", "PGRST301"]) {
      expect(await resolveStudioSmsSender(seed(null, { code }).client as never, STUDIO_A), code).toEqual({ ok: false, reason: "sms_service_check_failed" });
    }
  });

  it("where the recurring feature is not installed yet (this code can ship before its migration) sending is unchanged", async () => {
    for (const code of ["PGRST202", "42883"]) {
      expect(await resolveStudioSmsSender(seed(null, { code }).client as never, STUDIO_A), code).toMatchObject({ ok: true });
    }
    expect(await resolveStudioSmsSender(seed("unset").client as never, STUDIO_A)).toMatchObject({ ok: true }); // the fake answers PGRST202 for an unknown function
  });

  it("the earlier gates still decide first: no registration, or the platform switch off, is refused without asking about recurring charges", async () => {
    const db = createFakeSupabase({ studio_sms_registrations: [] });
    expect(await resolveStudioSmsSender(db.client as never, STUDIO_A)).toEqual({ ok: false, reason: "sms_studio_not_approved" });
    expect(db.rpcCalls.filter((c) => c.name === "tw4_recurring_service_state")).toHaveLength(0); // (the billing mode is asked first: a legacy studio here)
    process.env.DANCEFLOW_SMS_STATUS = "paused";
    const paused = seed("suspended");
    expect(await resolveStudioSmsSender(paused.client as never, STUDIO_A)).toEqual({ ok: false, reason: "sms_not_approved" });
    expect(paused.rpcCalls).toHaveLength(0);
  });

  it("INBOUND resolution never consults the service state: a suspended business's contacts can still STOP, START and HELP", async () => {
    const db = seed("suspended");
    expect(await resolveStudioFromInboundSender(db.client as never, { messagingServiceSid: SERVICE_A, to: "+15550109999" })).toEqual({ ok: true, studioId: STUDIO_A });
    expect(db.rpcCalls.filter((c) => c.name === "tw4_recurring_service_state")).toHaveLength(0);
  });
});

describe("manual studio texts (POST /api/sms/send)", () => {
  it("a suspended business is refused with a clear message and nothing reaches Twilio or the message log", async () => {
    const db = seed("suspended");
    const response = await POST(sendRequest());
    expect(response.status).toBe(503);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Texting is paused");
    expect(body.error).toContain("STOP and HELP still work");
    expect(twilioCalls()).toHaveLength(0);
    expect(db.rows("sms_message_logs")).toHaveLength(0);
  });
  it("an unreadable state answers 500 'could not be verified' and sends nothing", async () => {
    const db = seed(null, { code: "57014" });
    const response = await POST(sendRequest());
    expect(response.status).toBe(500);
    expect(twilioCalls()).toHaveLength(0);
    expect(db.rows("sms_message_logs")).toHaveLength(0);
  });
  it("past due and active businesses, and ones with no recurring authorization, still send exactly once", async () => {
    for (const state of ["none", "active", "past_due"]) {
      seed(state);
      fetchMock.mockClear();
      const response = await POST(sendRequest());
      expect(response.status, state).toBe(200);
      expect(twilioCalls()).toHaveLength(1);
    }
  });
});

describe("automated appointment texts (dispatch)", () => {
  it("a suspended business's queued text is skipped with a reason, not sent, and not retried as if it had failed", async () => {
    const db = seed("suspended");
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ processed: 1, sent: 0, skipped: 1 });
    expect(twilioCalls()).toHaveLength(0);
    expect(db.rows("sms_message_logs")).toHaveLength(0);
    expect(JSON.stringify(db.rows("outbound_deliveries"))).toContain("sms_service_suspended");
  });
  it("an unreadable state fails that delivery (it is not skipped as if it were a decision), and never sends", async () => {
    seed(null, { code: "57014" });
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result.sent).toBe(0);
    expect(twilioCalls()).toHaveLength(0);
    expect(result).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    expect(fake.current!.rows("outbound_deliveries")[0]).toMatchObject({ status: "failed" });
    expect(JSON.stringify(fake.current!.rows("outbound_deliveries"))).toContain("sms_service_check_failed");
  });
  it("an active business's queued text sends once through its own Messaging Service", async () => {
    seed("active");
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ processed: 1, sent: 1 });
    expect(twilioCalls()).toHaveLength(1);
  });
});

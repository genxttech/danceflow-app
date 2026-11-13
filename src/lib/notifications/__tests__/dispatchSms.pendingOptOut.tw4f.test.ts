import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";
import { FakeBilledSmsProvider } from "@/lib/sms/usageProvider";

/**
 * TW-4F compliance: a STOP parked because its consent change failed suppresses automated texts at SEND time (queued and retried deliveries included),
 * on both the billed and the legacy path, with no provider call and no billing reservation. Fails closed when the check cannot be made.
 */

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof import("@/lib/sms/__tests__/fakeSupabase").createFakeSupabase> | null,
  provider: null as unknown,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db!.client }));
vi.mock("@/lib/aria/outcome-verification", () => ({
  getAriaOutcomeExpectation: () => null,
  verifyPendingAriaOutcomes: async () => ({ checked: 0 }),
}));
vi.mock("@/lib/sms/usageProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/usageProvider")>();
  return { ...actual, billedSmsProviderFromEnv: () => h.provider };
});

import { dispatchQueuedOutboundDeliveries } from "@/lib/notifications/dispatch";

const STUDIO_A = "11111111-1111-4111-8111-111111111111";
const STUDIO_B = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const PHONE_E164 = "+15550100123";
const SERVICE = `MG${"2".repeat(32)}`;

const ENV_KEYS = ["DANCEFLOW_SMS_STATUS", "SMS_USAGE_BILLING", "TWILIO_STATUS_CALLBACK_SECRET", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};
const fetchMock = vi.fn();

const smsRow = (studio = STUDIO_A): FakeRow => ({
  id: "delivery-1", studio_id: studio, channel: "sms", template_key: "appointment_confirmed", recipient_email: null, recipient_phone: "(555) 010-0123",
  subject: null, body_text: null, body_html: null, reply_to_email: null, status: "queued", related_table: "appointments", related_id: "appt-1",
  created_at: "2026-10-01T00:00:00.000Z",
  payload: { appointmentLabel: "Private Lesson", startsAt: "2026-10-14T22:00:00.000Z", endsAt: "2026-10-14T22:45:00.000Z", studioTimeZone: "America/New_York", clientFirstName: "Alex", recipientRole: "primary", recipientClientId: CLIENT_ID },
});

const permission = (studio = STUDIO_A): FakeRow => ({
  id: `perm-${studio}`, studio_id: studio, client_id: CLIENT_ID, phone_e164: PHONE_E164, consent_status: "opted_in", opted_out_at: null, updated_at: "2026-10-01T00:00:00.000Z",
});

type Check = (args: Record<string, unknown>) => { data: unknown; error: unknown };

function seed(mode: "billed" | "legacy", check: Check, studio = STUDIO_A) {
  const db = createFakeSupabase({
    outbound_deliveries: [smsRow(studio)],
    sms_contact_permissions: [permission(studio)],
    studios: [{ id: studio, name: "Harbor Dance Studio" }],
    studio_sms_registrations: mode === "legacy"
      ? [{ id: "reg", studio_id: studio, messaging_service_sid: SERVICE, campaign_sid: `QE${"0f".repeat(16)}`, sender_e164: "+15035550199", registration_status: "approved" }]
      : [],
  });
  db.overrideRpc("tw4_usage_studio_mode", () => ({ data: mode, error: null }));
  db.overrideRpc("tw4_usage_begin", () => ({ data: { decision: "send", attempt_id: "a1", message_log_id: "l1", account_sid: `AC${"1".repeat(32)}`, messaging_service_sid: SERVICE, sender_e164: "+15035550199" }, error: null }));
  db.overrideRpc("tw4_usage_dispatching", () => ({ data: { dispatch: true }, error: null }));
  db.overrideRpc("tw4_usage_submitted", () => ({ data: {}, error: null }));
  db.overrideRpc("tw4_usage_release_unprepared", () => ({ data: {}, error: null }));
  db.overrideRpc("sms_pending_opt_out_blocks", check);
  h.db = db;
  return db;
}

const delivery = () => h.db!.rows("outbound_deliveries")[0];
const rpcNames = () => h.db!.rpcCalls.map((c) => c.name);
const twilioCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("api.twilio.com"));
const provider = () => h.provider as FakeBilledSmsProvider;
/** the open parked STOP, keyed by studio + phone */
const parked = (open: Set<string>): Check => (a) => ({ data: open.has(`${a.p_studio_id}|${a.p_phone_e164}`), error: null });

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DANCEFLOW_SMS_STATUS = "approved";
  process.env.SMS_USAGE_BILLING = "on";
  process.env.TWILIO_STATUS_CALLBACK_SECRET = "cb-secret";
  process.env.TWILIO_ACCOUNT_SID = "ACtest0000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "fake-test-auth-token";
  h.provider = new FakeBilledSmsProvider();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ sid: "SM1", status: "queued" })));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe.each(["billed", "legacy"] as const)("%s path", (mode) => {
  const sentNothing = () => {
    expect(twilioCalls()).toHaveLength(0);
    expect(provider().sent).toHaveLength(0);
    expect(rpcNames()).not.toContain("tw4_usage_begin");
    expect(h.db!.rows("sms_message_logs")).toHaveLength(0);
  };

  it("an open parked STOP suppresses a queued delivery at send time: skipped, no provider call, no reservation, no log", async () => {
    seed(mode, parked(new Set([`${STUDIO_A}|${PHONE_E164}`])));
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(delivery()).toMatchObject({ status: "skipped", error_message: "sms_opted_out" });
    sentNothing();
  });

  it("interval: still suppressed on every run while the cron has not applied it (a second dispatch of a requeued row changes nothing)", async () => {
    seed(mode, parked(new Set([`${STUDIO_A}|${PHONE_E164}`])));
    await dispatchQueuedOutboundDeliveries(25);
    delivery().status = "queued"; // a retry / re-enqueue before the 15-minute cron
    await dispatchQueuedOutboundDeliveries(25);
    expect(delivery()).toMatchObject({ status: "skipped", error_message: "sms_opted_out" });
    sentNothing();
  });

  it("cross-studio isolation: studio A's parked STOP does not suppress studio B's text to the same number", async () => {
    seed(mode, parked(new Set([`${STUDIO_A}|${PHONE_E164}`])), STUDIO_B);
    await dispatchQueuedOutboundDeliveries(25);
    expect(delivery().status).not.toBe("skipped");
    expect(rpcNames()).toContain("sms_pending_opt_out_blocks");
  });

  it("after apply or supersede (no open row) the text goes out", async () => {
    seed(mode, parked(new Set()));
    await dispatchQueuedOutboundDeliveries(25);
    expect(delivery().status).toBe("sent");
  });

  it("fails closed: a lookup error or a throw means NO send (retried, not skipped, not sent)", async () => {
    for (const check of [(() => ({ data: null, error: { code: "57014" } })) as Check, (() => { throw new Error("down"); }) as Check, (() => ({ data: "garbage", error: null })) as Check]) {
      fetchMock.mockClear();
      seed(mode, check);
      await dispatchQueuedOutboundDeliveries(25);
      expect(delivery().status).not.toBe("sent");
      sentNothing();
    }
  });

  it("pre-migration: the function not installed (PGRST202 / 42883) is NOT a block, so sending is not broken before the SQL is applied", async () => {
    for (const code of ["PGRST202", "42883"]) {
      seed(mode, () => ({ data: null, error: { code } }));
      await dispatchQueuedOutboundDeliveries(25);
      expect(delivery().status).toBe("sent");
    }
  });
});

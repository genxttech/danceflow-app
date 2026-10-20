import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";
import { FakeBilledSmsProvider } from "@/lib/sms/usageProvider";

/** TW-4F: automated SMS for a studio of a verified legal business goes through the billed path (after the consent checks). */

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
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const PHONE_E164 = "+15550100123";
const ATTEMPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT = `AC${"1".repeat(32)}`;
const SERVICE = `MG${"2".repeat(32)}`;
const DELIVERY_ID = "delivery-1";

const ENV_KEYS = ["DANCEFLOW_SMS_STATUS", "SMS_USAGE_BILLING", "TWILIO_STATUS_CALLBACK_SECRET", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const;
const savedEnv: Record<string, string | undefined> = {};
const fetchMock = vi.fn();

const smsRow = (): FakeRow => ({
  id: DELIVERY_ID,
  studio_id: STUDIO_A,
  channel: "sms",
  template_key: "appointment_confirmed",
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
});

const permission = (): FakeRow => ({
  id: "perm-1",
  studio_id: STUDIO_A,
  client_id: CLIENT_ID,
  phone_e164: PHONE_E164,
  consent_status: "opted_in",
  opted_out_at: null,
  updated_at: "2026-10-01T00:00:00.000Z",
});

type Rpc = { data: unknown; error: { code?: string } | null };

function seed(opts: { permissions?: FakeRow[]; begin?: Rpc; mode?: Rpc } = {}) {
  const db = createFakeSupabase({
    outbound_deliveries: [smsRow()],
    sms_contact_permissions: opts.permissions ?? [permission()],
    studios: [{ id: STUDIO_A, name: "Harbor Dance Studio" }],
    studio_sms_registrations: [],
  });
  db.overrideRpc("tw4_usage_studio_mode", () => opts.mode ?? { data: "billed", error: null });
  db.overrideRpc("tw4_usage_begin", () => opts.begin ?? { data: { decision: "send", attempt_id: ATTEMPT, message_log_id: LOG, account_sid: ACCOUNT, messaging_service_sid: SERVICE }, error: null });
  db.overrideRpc("tw4_usage_dispatching", () => ({ data: { dispatch: true }, error: null }));
  db.overrideRpc("tw4_usage_submitted", () => ({ data: {}, error: null }));
  db.overrideRpc("tw4_usage_rejected", () => ({ data: {}, error: null }));
  db.overrideRpc("tw4_usage_uncertain", () => ({ data: {}, error: null }));
  h.db = db;
  return db;
}

const delivery = () => h.db!.rows("outbound_deliveries")[0];
const rpcNames = () => h.db!.rpcCalls.map((c) => c.name);
const fakeProvider = () => h.provider as FakeBilledSmsProvider;
const twilioCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("api.twilio.com"));

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.DANCEFLOW_SMS_STATUS = "approved";
  process.env.SMS_USAGE_BILLING = "on";
  process.env.TWILIO_STATUS_CALLBACK_SECRET = "cb-secret";
  h.provider = new FakeBilledSmsProvider();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("billed studio gates", () => {
  it("SMS_USAGE_BILLING off -> skipped sms_billing_unavailable, no begin", async () => {
    delete process.env.SMS_USAGE_BILLING;
    seed();
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
    expect(delivery()).toMatchObject({ status: "skipped", error_message: "sms_billing_unavailable" });
    expect(rpcNames()).not.toContain("tw4_usage_begin");
    expect(fakeProvider().sent).toHaveLength(0);
  });

  it("no provider (real sending not allowed) -> skipped sms_billing_unavailable", async () => {
    h.provider = null;
    seed();
    await dispatchQueuedOutboundDeliveries(25);
    expect(delivery()).toMatchObject({ status: "skipped", error_message: "sms_billing_unavailable" });
    expect(rpcNames()).not.toContain("tw4_usage_begin");
  });

  it("consent is checked before any billing call: an opted-out number is skipped, nothing reserved", async () => {
    seed({
      permissions: [
        permission(),
        { id: "p2", studio_id: STUDIO_A, client_id: null, phone_e164: PHONE_E164, consent_status: "opted_out", opted_out_at: "2026-10-02T00:00:00.000Z", updated_at: "2026-10-02T00:00:00.000Z" },
      ],
    });
    await dispatchQueuedOutboundDeliveries(25);
    expect(delivery()).toMatchObject({ status: "skipped", error_message: "sms_opted_out" });
    expect(rpcNames()).not.toContain("tw4_usage_begin");
  });

  it("no consent is skipped before any billing call", async () => {
    seed({ permissions: [] });
    await dispatchQueuedOutboundDeliveries(25);
    expect(delivery()).toMatchObject({ status: "skipped", error_message: "sms_no_consent" });
    expect(rpcNames()).not.toContain("tw4_usage_begin");
  });

  it("the billing-mode check failing is a terminal failure, never a legacy send", async () => {
    seed({ mode: { data: null, error: { code: "XX000" } } });
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(delivery()).toMatchObject({ status: "failed", error_message: "sms_billing_check_failed" });
    expect(rpcNames()).not.toContain("tw4_usage_begin");
    expect(twilioCalls()).toHaveLength(0);
    expect(fakeProvider().sent).toHaveLength(0);
  });

  it("the legacy Twilio path is never used for a billed studio", async () => {
    seed();
    await dispatchQueuedOutboundDeliveries(25);
    expect(twilioCalls()).toHaveLength(0);
    expect(h.db!.rows("sms_message_logs")).toHaveLength(0); // the database creates the log row inside tw4_usage_begin
  });
});

describe("billed refusals map to skips", () => {
  it.each([
    ["TW007", "sms_insufficient_credit"],
    ["TW012", "sms_monthly_limit"],
    ["TW015", "sms_no_billed_sender"],
    ["TW010", "sms_no_billed_sender"],
    ["TW016", "sms_service_suspended"],
    ["TW018", "sms_billing_unavailable"],
    ["TW008", "sms_billing_unavailable"],
  ])("begin %s -> skipped %s, provider never called", async (code, reason) => {
    seed({ begin: { data: null, error: { code } } });
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ sent: 0, skipped: 1, failed: 0 });
    expect(delivery()).toMatchObject({ status: "skipped", error_message: reason });
    expect(fakeProvider().sent).toHaveLength(0);
    expect(rpcNames()).not.toContain("tw4_usage_dispatching");
  });

  it.each([
    ["22023", "sms_billed_invalid"],
    ["42501", "sms_billed_forbidden"],
  ])("begin %s -> terminal failure %s", async (code, reason) => {
    seed({ begin: { data: null, error: { code } } });
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(delivery()).toMatchObject({ status: "failed", error_message: reason });
    expect(fakeProvider().sent).toHaveLength(0);
  });

  it("an unavailable database is retried: the row stays queued with a retry marker, nothing sent", async () => {
    seed({ begin: { data: null, error: { code: "XX000" } } });
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ sent: 0, failed: 0, skipped: 0, retrying: 1 });
    expect(delivery().status).toBe("queued");
    expect(String(delivery().error_message)).toMatch(/^retry:sms_billing_unavailable:\d{13}/);
    expect(fakeProvider().sent).toHaveLength(0);
  });
});

describe("billed outcomes", () => {
  it("accepted -> marked sent with the provider SID; the delivery row id is the source (kind delivery)", async () => {
    const db = seed();
    fakeProvider().nextSend({ kind: "accepted", sid: "SMaccepted1" });
    const result = await dispatchQueuedOutboundDeliveries(25, { origin: "https://app.test" });
    expect(result).toMatchObject({ sent: 1, failed: 0, skipped: 0 });
    expect(delivery()).toMatchObject({ status: "sent", provider_message_id: "SMaccepted1" });
    const begin = db.rpcCalls.find((c) => c.name === "tw4_usage_begin")!;
    expect(begin.args).toMatchObject({
      p_source_kind: "delivery",
      p_source_id: DELIVERY_ID,
      p_studio_id: STUDIO_A,
      p_client_id: CLIENT_ID,
      p_phone_e164: PHONE_E164,
      p_message_type: "appointment_confirmed",
      p_related_table: "appointments",
      p_related_id: "appt-1",
      p_sent_by: null,
    });
    expect(String(begin.args.p_body)).toContain("Harbor Dance Studio: Reply STOP");
    expect(db.rpcCalls.find((c) => c.name === "tw4_usage_submitted")?.args).toEqual({ p_attempt_id: ATTEMPT, p_provider_sid: "SMaccepted1" });
    expect(fakeProvider().sent).toHaveLength(1);
    expect(fakeProvider().sent[0]).toMatchObject({ accountSid: ACCOUNT, messagingServiceSid: SERVICE, to: PHONE_E164 });
    const callback = new URL(String(fakeProvider().sent[0].statusCallbackUrl));
    expect(callback.origin + callback.pathname).toBe("https://app.test/api/sms/twilio/status");
    expect(callback.searchParams.get("attempt")).toBe(ATTEMPT);
    expect(callback.searchParams.get("secret")).toBe("cb-secret");
  });

  it("no origin -> no status callback URL", async () => {
    seed();
    await dispatchQueuedOutboundDeliveries(25);
    expect(fakeProvider().sent[0].statusCallbackUrl).toBeNull();
  });

  it("uncertain -> terminal failure sms_outcome_unknown; a later run never sends again", async () => {
    seed();
    fakeProvider().nextSend({ kind: "uncertain", code: "network" });
    const first = await dispatchQueuedOutboundDeliveries(25);
    expect(first).toMatchObject({ sent: 0, failed: 1, retrying: 0 });
    expect(delivery()).toMatchObject({ status: "failed", error_message: "sms_outcome_unknown" });
    await dispatchQueuedOutboundDeliveries(25);
    expect(fakeProvider().sent).toHaveLength(1);
  });

  it("a definite provider refusal -> terminal failure carrying only the code", async () => {
    seed();
    fakeProvider().nextSend({ kind: "refused", code: "21211" });
    await dispatchQueuedOutboundDeliveries(25);
    expect(delivery()).toMatchObject({ status: "failed", error_message: "sms_send_failed:21211" });
  });

  it("a refusal whose release cannot be recorded is uncertain, not rejected", async () => {
    const db = seed();
    db.overrideRpc("tw4_usage_rejected", () => ({ data: null, error: { code: "XX000" } }));
    fakeProvider().nextSend({ kind: "refused", code: "21211" });
    await dispatchQueuedOutboundDeliveries(25);
    expect(delivery()).toMatchObject({ status: "failed", error_message: "sms_outcome_unknown" });
  });

  it.each(["submitted", "settled"])("replay in state %s -> marked sent with the stored SID, provider not called", async (state) => {
    seed({ begin: { data: { decision: "replay", attempt_id: ATTEMPT, message_log_id: LOG, state, provider_sid: "SMold" }, error: null } });
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ sent: 1 });
    expect(delivery()).toMatchObject({ status: "sent", provider_message_id: "SMold" });
    expect(fakeProvider().sent).toHaveLength(0);
    expect(rpcNames()).not.toContain("tw4_usage_dispatching");
  });

  it("replay of an attempt not yet handed to the provider (reserved) keeps the delivery queued for a retry; the provider is not called", async () => {
    seed({ begin: { data: { decision: "replay", attempt_id: ATTEMPT, message_log_id: LOG, state: "reserved", provider_sid: null }, error: null } });
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ sent: 0, failed: 0 });
    expect(delivery()).toMatchObject({ status: "queued" });
    expect(String(delivery().error_message)).toContain("sms_not_dispatched");
    expect(fakeProvider().sent).toHaveLength(0);
  });

  it.each(["submitting", "unknown", "review"])("replay in unknown state %s -> sms_outcome_unknown, provider not called", async (state) => {
    seed({ begin: { data: { decision: "replay", attempt_id: ATTEMPT, message_log_id: LOG, state, provider_sid: null }, error: null } });
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(delivery()).toMatchObject({ status: "failed", error_message: "sms_outcome_unknown" });
    expect(fakeProvider().sent).toHaveLength(0);
  });

  it("replay of a released attempt -> failed sms_not_sent, provider not called", async () => {
    seed({ begin: { data: { decision: "replay", attempt_id: ATTEMPT, message_log_id: LOG, state: "released", provider_sid: null }, error: null } });
    await dispatchQueuedOutboundDeliveries(25);
    expect(delivery()).toMatchObject({ status: "failed", error_message: "sms_not_sent" });
    expect(fakeProvider().sent).toHaveLength(0);
  });

  it("a dispatch marker that cannot be written never reaches the provider; the delivery stays queued and its retry is a replay of the same attempt", async () => {
    const db = seed();
    db.overrideRpc("tw4_usage_dispatching", () => ({ data: null, error: { code: "XX000" } }));
    await dispatchQueuedOutboundDeliveries(25);
    expect(fakeProvider().sent).toHaveLength(0);
    expect(delivery()).toMatchObject({ status: "queued" });
    expect(String(delivery().error_message)).toContain("sms_not_dispatched");
  });
});

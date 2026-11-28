import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";
import { RETRY_WINDOW_MS, buildRetryMarker } from "@/lib/notifications/deliveryOutcome";
import { FakeBilledSmsProvider } from "@/lib/sms/usageProvider";

/**
 * Outside the live production build the dispatcher leaves a queued text exactly as it found it, for the production
 * dispatcher to send. Real dispatcher, fake database, fake email provider, fake SMS transports.
 */

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof import("@/lib/sms/__tests__/fakeSupabase").createFakeSupabase> | null,
  provider: null as unknown,
}));
const emailMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db!.client }));
vi.mock("@/lib/aria/outcome-verification", () => ({
  getAriaOutcomeExpectation: () => null,
  verifyPendingAriaOutcomes: async () => ({ checked: 0 }),
}));
vi.mock("resend", () => ({ Resend: class { emails = { send: emailMock }; } }));
vi.mock("@/lib/sms/usageProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/usageProvider")>();
  return { ...actual, billedSmsProviderFromEnv: () => h.provider };
});

import { dispatchQueuedOutboundDeliveries } from "@/lib/notifications/dispatch";

const STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const SERVICE = `MG${"a1".repeat(16)}`;
const fetchMock = vi.fn();

const NON_PRODUCTION: Array<[string, string]> = [
  ["preview", "production"],
  ["development", "development"],
  ["", "production"],
  ["", "test"],
  ["production", "development"],
];

function declare(vercel: string, node: string) {
  vi.stubEnv("VERCEL_ENV", vercel);
  vi.stubEnv("NODE_ENV", node);
}

function smsRow(over: FakeRow = {}): FakeRow {
  return {
    id: "sms-1",
    studio_id: STUDIO_ID,
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
    error_message: null,
    claim_owner: null,
    claim_expires_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    payload: {
      appointmentLabel: "Private Lesson",
      startsAt: "2026-10-14T22:00:00.000Z",
      studioTimeZone: "America/New_York",
      clientFirstName: "Alex",
      recipientClientId: CLIENT_ID,
    },
    ...over,
  };
}

/** A text that carries an ARIA action, so any recorded outcome would show on the action too. */
const ariaSmsRow = (over: FakeRow = {}) =>
  smsRow({ template_key: "aria_execution_follow_up", related_table: "automation_actions", related_id: "action-1", body_text: "Hi", ...over });

function emailRow(over: FakeRow = {}): FakeRow {
  return smsRow({
    id: "email-1",
    channel: "email",
    template_key: "booking_request_received_client",
    recipient_email: "client@example.com",
    recipient_phone: null,
    subject: "We received your request",
    body_text: "Hi Alex",
    related_table: null,
    related_id: null,
    payload: null,
    created_at: "2026-10-02T00:00:00.000Z",
    ...over,
  });
}

const action: FakeRow = {
  id: "action-1",
  studio_id: STUDIO_ID,
  rule_key: null,
  status: "queued",
  execution_status: "queued",
  execution_attempt_count: 0,
};

/** Emulates claim_outbound_deliveries: queued rows, oldest first, whose lease is free or expired are leased to the caller. */
function installClaim(db: ReturnType<typeof createFakeSupabase>) {
  db.overrideRpc("claim_outbound_deliveries", (args) => {
    const now = Date.now();
    const due = db
      .rows("outbound_deliveries")
      .filter((row) => row.status === "queued" && (row.claim_owner == null || Date.parse(String(row.claim_expires_at)) <= now))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(0, Number(args.p_limit));
    for (const row of due) {
      row.claim_owner = args.p_owner;
      row.claim_expires_at = new Date(now + Number(args.p_lease_seconds) * 1000).toISOString();
    }
    return { data: due.map((row) => ({ ...row })), error: null };
  });
}

function seed(deliveries: FakeRow[], options: { claim?: boolean; billed?: boolean } = {}) {
  const db = createFakeSupabase({
    outbound_deliveries: deliveries,
    studios: [{ id: STUDIO_ID, name: "Harbor Dance Studio", public_name: "Harbor Dance", email: "front@example.com" }],
    sms_contact_permissions: [
      { id: "perm-1", studio_id: STUDIO_ID, client_id: CLIENT_ID, phone_e164: "+15550100123", consent_status: "opted_in", opted_out_at: null },
    ],
    studio_sms_registrations: options.billed
      ? []
      : [
          {
            id: "reg-1",
            studio_id: STUDIO_ID,
            messaging_service_sid: SERVICE,
            campaign_sid: `QE${"0f".repeat(16)}`,
            sender_e164: "+15550109999",
            registration_status: "approved",
          },
        ],
    automation_actions: [action],
  });
  if (options.claim !== false) installClaim(db);
  if (options.billed) db.overrideRpc("tw4_usage_studio_mode", () => ({ data: "billed", error: null }));
  h.db = db;
  return db;
}

const row = (id = "sms-1") => h.db!.rows("outbound_deliveries").find((r) => r.id === id)!;
const claimCalls = () => h.db!.rpcCalls.filter((c) => c.name === "claim_outbound_deliveries");
const otherRpcs = () => h.db!.rpcCalls.filter((c) => c.name !== "claim_outbound_deliveries");

/** No delivery outcome anywhere: no provider call, no message log, no billing call, the ARIA action as seeded. */
function expectNothingRecorded() {
  expect(fetchMock).not.toHaveBeenCalled();
  expect(otherRpcs()).toEqual([]);
  expect(h.db!.rows("sms_message_logs")).toEqual([]);
  expect(h.db!.rows("automation_action_events")).toEqual([]);
  expect(h.db!.rows("automation_actions")).toEqual([action]);
}

beforeEach(() => {
  vi.stubEnv("DANCEFLOW_SMS_STATUS", "approved");
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"0".repeat(32)}`);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "fake-test-auth-token");
  vi.stubEnv("SMS_USAGE_BILLING", "on");
  vi.stubEnv("RESEND_API_KEY", "re_test_not_a_real_key");
  h.provider = new FakeBilledSmsProvider();
  emailMock.mockReset();
  emailMock.mockResolvedValue({ data: { id: "provider-email-1" }, error: null });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(NON_PRODUCTION)("queued text with VERCEL_ENV=%j NODE_ENV=%j", (vercel, node) => {
  beforeEach(() => declare(vercel, node));

  it("is left exactly as it was and its claim is released", async () => {
    const seeded = ariaSmsRow();
    seed([seeded]);
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ processed: 0, sent: 0, failed: 0, skipped: 0, retrying: 0 });
    expect(row()).toEqual(seeded);
    expectNothingRecorded();
  });

  it("is never taken when the claim function does not exist", async () => {
    const seeded = ariaSmsRow();
    const db = seed([seeded], { claim: false });
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ processed: 0, sent: 0, failed: 0, skipped: 0 });
    expect(row()).toEqual(seeded);
    expect(db.mutations).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("outside production", () => {
  beforeEach(() => declare("preview", "production"));

  it("repeated runs consume no retry: an expired retry window is not recorded as exhausted", async () => {
    const marker = buildRetryMarker("sms_billing_unavailable", Date.now() - RETRY_WINDOW_MS - 60_000, true);
    const seeded = ariaSmsRow({ error_message: marker });
    seed([seeded]);
    for (let run = 0; run < 3; run += 1) await dispatchQueuedOutboundDeliveries(25);
    expect(row()).toEqual(seeded);
    expectNothingRecorded();
  });

  it.each([
    ["billing switched off", () => vi.stubEnv("SMS_USAGE_BILLING", "")],
    ["no billed provider", () => { h.provider = null; }],
    ["a provider that would accept", () => undefined],
  ])("billed studio, %s: the text is neither skipped, reserved nor sent", async (_name, arrange) => {
    arrange();
    const seeded = ariaSmsRow();
    seed([seeded], { billed: true });
    await dispatchQueuedOutboundDeliveries(25);
    expect(row()).toEqual(seeded);
    expectNothingRecorded();
    expect((h.provider as FakeBilledSmsProvider | null)?.sent ?? []).toEqual([]);
  });

  it("email in the same run is sent and recorded as before", async () => {
    const seeded = smsRow();
    seed([seeded, emailRow()]);
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ processed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(row("email-1")).toMatchObject({ status: "sent", provider_message_id: "provider-email-1" });
    expect(row()).toEqual(seeded);
  });

  it("a backlog of older texts longer than the run limit does not starve email", async () => {
    const texts = Array.from({ length: 7 }, (_, i) => smsRow({ id: `sms-${i + 1}` }));
    seed([...texts, emailRow(), emailRow({ id: "email-2" }), emailRow({ id: "email-3" })]);
    const result = await dispatchQueuedOutboundDeliveries(2);
    expect(result).toMatchObject({ processed: 2, sent: 2 });
    for (const text of texts) expect(row(String(text.id))).toEqual(text);
    // the run limit still holds: the third email waits for the next run
    expect(row("email-3")).toMatchObject({ status: "queued", claim_owner: null });
  });

  it("stops claiming after a bounded number of rounds and releases every held text", async () => {
    const texts = Array.from({ length: 30 }, (_, i) => smsRow({ id: `sms-${i + 1}` }));
    seed(texts);
    await dispatchQueuedOutboundDeliveries(1);
    expect(claimCalls()).toHaveLength(20);
    for (const text of texts) expect(row(String(text.id))).toEqual(text);
  });

  it("another dispatcher's claim on a text is not released", async () => {
    const theirs = smsRow({
      id: "sms-theirs",
      claim_owner: "99999999-9999-4999-8999-999999999999",
      claim_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    seed([theirs, smsRow()]);
    await dispatchQueuedOutboundDeliveries(25);
    expect(row("sms-theirs")).toEqual(theirs);
    expect(row()).toEqual(smsRow());
  });

  it("if the release fails only the lease remains, and no outcome is recorded", async () => {
    const seeded = ariaSmsRow();
    const db = seed([seeded]);
    db.failUpdates("outbound_deliveries", (values) => values.claim_owner === null);
    await dispatchQueuedOutboundDeliveries(25);
    expect(row()).toEqual({ ...seeded, claim_owner: expect.any(String), claim_expires_at: expect.any(String) });
    expectNothingRecorded();
  });

  it("the live production run that follows sends the same text", async () => {
    seed([smsRow()]);
    await dispatchQueuedOutboundDeliveries(25);
    expect(fetchMock).not.toHaveBeenCalled();
    declare("production", "production");
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ processed: 1, sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ status: "sent", provider_message_id: "SM1" });
  });
});

describe("live production build", () => {
  beforeEach(() => declare("production", "production"));

  it("claims once and processes texts and email together", async () => {
    seed([smsRow(), emailRow()]);
    const result = await dispatchQueuedOutboundDeliveries(2);
    expect(result).toMatchObject({ processed: 2, sent: 2 });
    expect(claimCalls()).toHaveLength(1);
  });

  it("takes texts when the claim function does not exist", async () => {
    seed([smsRow()], { claim: false });
    const result = await dispatchQueuedOutboundDeliveries(25);
    expect(result).toMatchObject({ processed: 1, sent: 1 });
    expect(row()).toMatchObject({ status: "sent" });
  });
});

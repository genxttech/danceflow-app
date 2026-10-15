import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";
import {
  DISPATCH_RUN_BUDGET_MS,
  PROVIDER_CALL_TIMEOUT_MS,
  RETRY_WINDOW_MS,
  buildRetryMarker,
  classifyEmailProviderError,
  describeDeliveryNoteForStaff,
  isRetryWindowExhausted,
  parseRetryMarker,
  sanitizeDeliveryErrorCode,
} from "@/lib/notifications/deliveryOutcome";

/**
 * T2: transactional dispatcher reliability. Real dispatcher, fake database with a lease-honouring claim emulation, fake
 * email provider (Resend SDK shape: errors are returned, never thrown) and fake SMS transport. No real provider calls.
 */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));
const sendMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.current!.client }));
vi.mock("@/lib/aria/outcome-verification", () => ({
  getAriaOutcomeExpectation: () => null,
  verifyPendingAriaOutcomes: async () => ({ checked: 0 }),
}));
vi.mock("resend", () => ({ Resend: class { emails = { send: sendMock }; } }));

import { dispatchQueuedOutboundDeliveries } from "@/lib/notifications/dispatch";

const STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";

const studio: FakeRow = {
  id: STUDIO_ID,
  name: "Harbor Dance LLC",
  public_name: "Harbor Dance",
  public_logo_url: null,
  email: "front@harbordance.com",
};

function emailRow(over: FakeRow = {}): FakeRow {
  return {
    id: "d-1",
    studio_id: STUDIO_ID,
    channel: "email",
    template_key: "booking_request_received_client",
    recipient_email: "client@example.com",
    recipient_phone: null,
    subject: "Harbor Dance: we received your lesson request",
    body_text: "Hi Alex,\n\nWe received your request.",
    body_html: null,
    reply_to_email: null,
    status: "queued",
    payload: null,
    related_table: null,
    related_id: null,
    error_message: null,
    claim_owner: null,
    claim_expires_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

/** Emulates claim_outbound_deliveries: queued rows whose lease is free or expired are leased to the caller. */
function installClaim(db: ReturnType<typeof createFakeSupabase>) {
  db.overrideRpc("claim_outbound_deliveries", (args) => {
    const now = Date.now();
    const due = db
      .rows("outbound_deliveries")
      .filter(
        (row) =>
          row.status === "queued" &&
          (row.claim_owner == null || Date.parse(String(row.claim_expires_at)) <= now),
      )
      .slice(0, Number(args.p_limit));
    for (const row of due) {
      row.claim_owner = args.p_owner;
      row.claim_expires_at = new Date(now + Number(args.p_lease_seconds) * 1000).toISOString();
    }
    return { data: due.map((row) => ({ ...row })), error: null };
  });
}

function seed(rows: FakeRow[], extra: Record<string, FakeRow[]> = {}) {
  fake.current = createFakeSupabase({ outbound_deliveries: rows, studios: [studio], ...extra });
  installClaim(fake.current);
  return fake.current;
}

const row = (id = "d-1") => fake.current!.rows("outbound_deliveries").find((r) => r.id === id)!;
/** Expire every lease, as if the lease period had passed. */
const expireLeases = () => {
  for (const r of fake.current!.rows("outbound_deliveries")) {
    if (r.claim_owner) r.claim_expires_at = new Date(Date.now() - 1000).toISOString();
  }
};
const accepted = (id = "email-1") => ({ data: { id }, error: null });
const providerError = (name: string, statusCode: number | null, message = "provider said something") => ({
  data: null,
  error: { name, statusCode, message },
});

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
  sendMock.mockReset();
  sendMock.mockResolvedValue(accepted());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("T2 outcome helpers", () => {
  it("classifies provider errors into retry or terminal with fixed codes", () => {
    const cases: Array<[unknown, string, string]> = [
      [{ name: "application_error", statusCode: null }, "retry", "provider_unreachable"],
      [{ name: "dispatcher_timeout", statusCode: null }, "retry", "provider_timeout"],
      [{ name: "internal_server_error", statusCode: 500 }, "retry", "provider_unavailable"],
      [{ name: "application_error", statusCode: 503 }, "retry", "provider_unavailable"],
      [{ name: "rate_limit_exceeded", statusCode: 429 }, "retry", "provider_rate_limited"],
      [{ name: "daily_quota_exceeded", statusCode: 429 }, "retry", "provider_rate_limited"],
      [{ name: "concurrent_idempotent_requests", statusCode: 409 }, "retry", "provider_concurrent_request"],
      [{ name: "invalid_api_key", statusCode: 403 }, "retry", "provider_auth_error"],
      [{ name: "missing_api_key", statusCode: 401 }, "retry", "provider_auth_error"],
      // 403 for an unverified sending domain is a definite rejection, not a credentials problem
      [{ name: "validation_error", statusCode: 403 }, "terminal", "provider_rejected:validation_error"],
      [{ name: "invalid_idempotent_request", statusCode: 409 }, "terminal", "provider_idempotency_mismatch"],
      [{ name: "validation_error", statusCode: 422 }, "terminal", "provider_rejected:validation_error"],
      [{ name: "invalid_from_address", statusCode: 422 }, "terminal", "provider_rejected:invalid_from_address"],
      [{ name: "Weird Name <x@y.z>", statusCode: 400 }, "terminal", "provider_rejected"],
    ];
    for (const [error, kind, code] of cases) {
      expect(classifyEmailProviderError(error as never)).toEqual({ kind, code });
    }
  });

  it("stores only bounded reason codes", () => {
    expect(sanitizeDeliveryErrorCode("provider_rejected:validation_error")).toBe("provider_rejected:validation_error");
    expect(sanitizeDeliveryErrorCode("sms_send_failed:21610")).toBe("sms_send_failed:21610");
    expect(sanitizeDeliveryErrorCode("The 'to' field is invalid: alex@example.com")).toBe("dispatch_error");
    expect(sanitizeDeliveryErrorCode("Bearer re_live_123 rejected")).toBe("dispatch_error");
    expect(sanitizeDeliveryErrorCode("x".repeat(200))).toBe("dispatch_error");
    expect(sanitizeDeliveryErrorCode(null)).toBe("dispatch_error");
  });

  it("round-trips retry markers and bounds the retry window", () => {
    const marker = buildRetryMarker("provider_unavailable", 1_700_000_000_000);
    expect(marker).toBe("retry:provider_unavailable:1700000000000");
    expect(parseRetryMarker(marker)).toEqual({ code: "provider_unavailable", firstAttemptMs: 1_700_000_000_000, unsentOnly: false });
    expect(buildRetryMarker("provider_auth_error", 1_700_000_000_000, true)).toBe("retry:provider_auth_error:1700000000000:n");
    expect(parseRetryMarker("retry:provider_auth_error:1700000000000:n")?.unsentOnly).toBe(true);
    expect(parseRetryMarker("provider_unavailable")).toBeNull();
    expect(isRetryWindowExhausted({ firstAttemptMs: 0 }, RETRY_WINDOW_MS)).toBe(false);
    expect(isRetryWindowExhausted({ firstAttemptMs: 0 }, RETRY_WINDOW_MS + 1)).toBe(true);
    expect(isRetryWindowExhausted(null, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(describeDeliveryNoteForStaff(marker)).toMatch(/retrying automatically/);
    expect(describeDeliveryNoteForStaff("provider_rejected:validation_error")).toBe("provider_rejected:validation_error");
  });
});

describe("T2 S3: provider accepted, then the database update fails", () => {
  it("email stays queued (not failed), and the retry re-sends with the same key and bytes, then records sent", async () => {
    const db = seed([emailRow()]);
    db.failUpdates("outbound_deliveries", (values) => values.status === "sent");

    const first = await dispatchQueuedOutboundDeliveries(10);
    expect(first).toMatchObject({ sent: 0, failed: 0, unconfirmed: 1 });
    expect(row().status).toBe("queued");
    // M1: the possibly-accepted attempt is recorded, so a later failure of this row is treated as uncertain.
    expect(parseRetryMarker(row().error_message)).toMatchObject({ code: "provider_accepted_unrecorded", unsentOnly: false });

    // Lease expires; the next run reclaims the row. The provider de-duplicates on the key and returns the same id.
    expireLeases();
    const second = await dispatchQueuedOutboundDeliveries(10);
    expect(second).toMatchObject({ sent: 1, failed: 0 });
    expect(row()).toMatchObject({ status: "sent", provider_message_id: "email-1", error_message: null });

    expect(sendMock).toHaveBeenCalledTimes(2);
    const [[payloadA, optionsA], [payloadB, optionsB]] = sendMock.mock.calls;
    expect(optionsA).toEqual({ idempotencyKey: "outbound-delivery:d-1" });
    expect(optionsB).toEqual(optionsA);
    expect(payloadB).toEqual(payloadA); // identical bytes, so the provider can de-duplicate
  });

  it("a row whose lease has not expired is not re-sent by a concurrent run", async () => {
    const db = seed([emailRow()]);
    db.failUpdates("outbound_deliveries", (values) => values.status === "sent");
    await dispatchQueuedOutboundDeliveries(10);
    const again = await dispatchQueuedOutboundDeliveries(10); // lease still held
    expect(again.processed).toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("T2 S2: lease expiry, reclaim and stale completion", () => {
  it("the first worker cannot overwrite the second worker's final state", async () => {
    seed([emailRow()]);
    // Worker A's provider call stalls; meanwhile its lease expires and worker B claims, sends and records the row.
    sendMock.mockImplementationOnce(async () => {
      expireLeases();
      const workerB = await dispatchQueuedOutboundDeliveries(10);
      expect(workerB).toMatchObject({ sent: 1 });
      expect(row().status).toBe("sent");
      // Worker A then sees a definite provider rejection and tries to record a failure.
      return providerError("validation_error", 422);
    });
    sendMock.mockResolvedValueOnce(accepted("email-B"));

    const workerA = await dispatchQueuedOutboundDeliveries(10);
    expect(workerA).toMatchObject({ failed: 0, lostClaims: 1 });
    expect(row()).toMatchObject({ status: "sent", provider_message_id: "email-B", error_message: null });
  });

  it("while the second worker still holds the reclaimed lease, the first worker's completion changes nothing", async () => {
    const db = seed([emailRow()]);
    sendMock.mockImplementationOnce(async () => {
      expireLeases();
      // Worker B claims the row but has not finished it yet.
      const claimed = await db.client.rpc("claim_outbound_deliveries", { p_owner: "worker-b", p_limit: 10, p_lease_seconds: 300 });
      expect((claimed.data as unknown[]).length).toBe(1);
      return providerError("validation_error", 422);
    });
    const workerA = await dispatchQueuedOutboundDeliveries(10);
    expect(workerA).toMatchObject({ failed: 0, lostClaims: 1 });
    expect(row()).toMatchObject({ status: "queued", claim_owner: "worker-b" });
    // Worker A's pre-attempt marker stays: its attempt may have been accepted, so worker B treats the row as uncertain.
    expect(parseRetryMarker(row().error_message)).toMatchObject({ code: "provider_attempt_started", unsentOnly: false });
  });

  it("a stale worker's success after reclaim does not double-record either", async () => {
    seed([emailRow()]);
    sendMock.mockImplementationOnce(async () => {
      expireLeases();
      await dispatchQueuedOutboundDeliveries(10);
      return accepted("email-1");
    });
    const workerA = await dispatchQueuedOutboundDeliveries(10);
    expect(workerA).toMatchObject({ sent: 0, lostClaims: 1 });
    expect(row().status).toBe("sent");
  });
});

describe("T2 S1: unsupported template keys fail closed", () => {
  it("an intake row is never sent, even with a stored body", async () => {
    seed([emailRow({ template_key: "intake_invitation_student", subject: "x", body_text: "y" })]);
    const result = await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1, sent: 0 });
    expect(row()).toMatchObject({ status: "skipped", error_message: "outbound_template_unsupported" });
  });

  it("a row without stored content or a renderer is skipped instead of sending a generic message", async () => {
    seed([emailRow({ template_key: "some_future_key", subject: "Only a subject", body_text: null, body_html: "<p>x</p>" })]);
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "skipped", error_message: "outbound_template_unsupported" });
  });

  it("preserves existing renderable rows: stored content, body without subject, appointment templates", async () => {
    seed([
      emailRow({ id: "stored" }),
      emailRow({ id: "no-subject", subject: null, body_text: "Real content." }),
      emailRow({
        id: "appointment",
        template_key: "appointment_confirmed",
        subject: null,
        body_text: null,
        payload: {
          appointmentLabel: "Private Lesson",
          startsAt: "2026-10-20T22:00:00.000Z",
          studioTimeZone: "America/New_York",
          clientFirstName: "Alex",
        },
      }),
    ]);
    const result = await dispatchQueuedOutboundDeliveries(10);
    expect(result).toMatchObject({ sent: 3, skipped: 0, failed: 0 });
    const subjects = sendMock.mock.calls.map(([payload]) => payload.subject).sort();
    expect(subjects).toEqual(["DanceFlow Notification", "Harbor Dance: we received your lesson request", "Private Lesson Confirmed"]);
    const appointmentCall = sendMock.mock.calls.find(([payload]) => payload.subject === "Private Lesson Confirmed")!;
    expect(appointmentCall[0].text).toContain("Your private lesson is confirmed for");
    expect(appointmentCall[0].from).toContain("Harbor Dance via DanceFlow"); // client-facing sender unchanged
    expect(appointmentCall[0].replyTo).toBe("front@harbordance.com");
  });
});

describe("T2: retries use the same provider idempotency key", () => {
  it("5xx then network failure then success: queued between attempts, first-attempt time kept, same key", async () => {
    seed([emailRow()]);
    sendMock
      .mockResolvedValueOnce(providerError("internal_server_error", 500))
      .mockResolvedValueOnce(providerError("application_error", null))
      .mockResolvedValueOnce(accepted("email-9"));

    const r1 = await dispatchQueuedOutboundDeliveries(10);
    expect(r1).toMatchObject({ retrying: 1, failed: 0 });
    const marker1 = parseRetryMarker(row().error_message);
    expect(row().status).toBe("queued");
    expect(marker1?.code).toBe("provider_unavailable");

    expireLeases();
    const realNow = Date.now.bind(Date);
    const later = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60_000); // a minute later
    await dispatchQueuedOutboundDeliveries(10);
    later.mockRestore();
    const marker2 = parseRetryMarker(row().error_message);
    expect(marker2).toEqual({ code: "provider_unreachable", firstAttemptMs: marker1!.firstAttemptMs, unsentOnly: false });

    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "sent", provider_message_id: "email-9", error_message: null });
    expect(new Set(sendMock.mock.calls.map(([, options]) => options.idempotencyKey))).toEqual(
      new Set(["outbound-delivery:d-1"]),
    );
  });

  it("409 concurrent request is retried; 409 payload mismatch is terminal and never resent", async () => {
    seed([emailRow({ id: "concurrent" }), emailRow({ id: "mismatch" })]);
    sendMock.mockImplementation(async (_payload: unknown, options: { idempotencyKey: string }) =>
      options.idempotencyKey.endsWith("concurrent")
        ? providerError("concurrent_idempotent_requests", 409)
        : providerError("invalid_idempotent_request", 409),
    );
    await dispatchQueuedOutboundDeliveries(10);
    expect(row("concurrent").status).toBe("queued");
    expect(parseRetryMarker(row("concurrent").error_message)?.code).toBe("provider_concurrent_request");
    expect(row("mismatch")).toMatchObject({ status: "failed", error_message: "provider_idempotency_mismatch" });

    expireLeases();
    sendMock.mockClear();
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock.mock.calls.map(([, options]) => options.idempotencyKey)).toEqual(["outbound-delivery:concurrent"]);
  });

  it("a hung provider call times out as an unknown outcome and stays queued", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    seed([emailRow()]);
    sendMock.mockImplementationOnce(() => new Promise(() => {})); // never settles
    const run = dispatchQueuedOutboundDeliveries(10);
    await vi.advanceTimersByTimeAsync(PROVIDER_CALL_TIMEOUT_MS + 1);
    const result = await run;
    expect(result).toMatchObject({ retrying: 1, failed: 0 });
    expect(row().status).toBe("queued");
    expect(parseRetryMarker(row().error_message)?.code).toBe("provider_timeout");
  });

  it("after the retry window the row ends as an unknown outcome without another provider call", async () => {
    const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
    seed([emailRow({ error_message: buildRetryMarker("provider_unreachable", thirteenHoursAgo) })]);
    const result = await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ failed: 1 });
    expect(row()).toMatchObject({ status: "failed", error_message: "provider_retry_window_exhausted" });
  });

  it("a missing provider key is retryable (nothing was sent)", async () => {
    delete process.env.RESEND_API_KEY;
    seed([emailRow()]);
    await dispatchQueuedOutboundDeliveries(10);
    expect(row().status).toBe("queued");
    // Nothing could have been sent (no API key, so no provider call): the attempt keeps the definitely-unsent flag.
    expect(parseRetryMarker(row().error_message)).toMatchObject({ code: "provider_not_configured", unsentOnly: true });
  });
});

describe("T2 S4: sanitized error storage", () => {
  it("never stores provider message text", async () => {
    seed([emailRow()]);
    sendMock.mockResolvedValueOnce(
      providerError("validation_error", 422, "Invalid `to` field: client@example.com (key re_live_abc)"),
    );
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "failed", error_message: "provider_rejected:validation_error" });
    expect(JSON.stringify(fake.current!.rows("outbound_deliveries"))).not.toContain("client@example.com (key");
  });

  it("local validation failures store fixed codes", async () => {
    seed([emailRow({ recipient_email: null })]);
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "failed", error_message: "missing_recipient_email" });
  });
});

describe("T2 S5: run budget", () => {
  it("stops starting sends after half the lease and releases the unattempted claims", async () => {
    seed([emailRow({ id: "a", created_at: "2026-10-01T00:00:01.000Z" }), emailRow({ id: "b", created_at: "2026-10-01T00:00:02.000Z" })]);
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    sendMock.mockImplementationOnce(async () => {
      offset = DISPATCH_RUN_BUDGET_MS + 1; // the first send took longer than the budget
      return accepted("email-a");
    });
    const result = await dispatchQueuedOutboundDeliveries(10);
    expect(result).toMatchObject({ sent: 1, deferred: 1 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(row("a").status).toBe("sent");
    expect(row("b").status).toBe("queued");
    expect(Date.parse(String(row("b").claim_expires_at))).toBeLessThanOrEqual(Date.now()); // claimable again now
  });
});

describe("T2: SMS (no provider idempotency) is closed, not re-sent, when recording the send fails once", () => {
  const fetchMock = vi.fn();
  const ENV = {
    DANCEFLOW_SMS_STATUS: "approved",
    TWILIO_ACCOUNT_SID: "ACtest0000000000000000000000000000",
    TWILIO_AUTH_TOKEN: "fake-test-auth-token",
    TWILIO_MESSAGING_SERVICE_SID: `MG${"9f".repeat(16)}`,
  };
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ sid: "SMtest123", status: "queued" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of Object.keys(ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("marks the row failed with a fixed code instead of re-sending", async () => {
    const db = seed(
      [
        emailRow({
          channel: "sms",
          template_key: "appointment_confirmed",
          recipient_email: null,
          recipient_phone: "(555) 010-0123",
          subject: null,
          body_text: null,
          related_table: "appointments",
          related_id: "appt-1",
          payload: {
            appointmentLabel: "Private Lesson",
            startsAt: "2026-10-20T22:00:00.000Z",
            studioTimeZone: "America/New_York",
            clientFirstName: "Alex",
            recipientClientId: CLIENT_ID,
          },
        }),
      ],
      {
        sms_contact_permissions: [
          {
            id: "perm-1",
            studio_id: STUDIO_ID,
            client_id: CLIENT_ID,
            phone_e164: "+15550100123",
            consent_status: "opted_in",
            opted_out_at: null,
            updated_at: "2026-10-01T00:00:00.000Z",
          },
        ],
        studio_sms_registrations: [
          {
            id: "reg-1",
            studio_id: STUDIO_ID,
            messaging_service_sid: `MG${"a1".repeat(16)}`,
            campaign_sid: `QE${"0f".repeat(16)}`,
            sender_e164: "+15550109999",
            registration_status: "approved",
          },
        ],
      },
    );
    db.failUpdates("outbound_deliveries", (values) => values.status === "sent");

    const result = await dispatchQueuedOutboundDeliveries(10);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("api.twilio.com"))).toHaveLength(1);
    expect(result).toMatchObject({ unconfirmed: 1, sent: 0 });
    expect(row()).toMatchObject({ status: "failed", error_message: "sms_sent_outcome_unrecorded" });

    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("api.twilio.com"))).toHaveLength(1);
  });
});

describe("T2: legacy unleased path (claim function missing)", () => {
  it("still sends and guards completion by queued status", async () => {
    fake.current = createFakeSupabase({ outbound_deliveries: [emailRow()], studios: [studio] }); // no claim override
    const result = await dispatchQueuedOutboundDeliveries(10);
    expect(result).toMatchObject({ sent: 1 });
    expect(row().status).toBe("sent");
  });
});

describe("T2 S2: zero-row completion is never counted", () => {
  it("a row finished elsewhere between claim and completion is reported as a lost claim, not sent", async () => {
    seed([emailRow()]);
    sendMock.mockImplementationOnce(async () => {
      // e.g. staff cancelled the delivery while the provider call was in flight
      Object.assign(row(), { status: "skipped", error_message: "cancelled_by_staff" });
      return accepted("email-1");
    });
    const result = await dispatchQueuedOutboundDeliveries(10);
    expect(result).toMatchObject({ sent: 0, failed: 0, lostClaims: 1 });
    expect(row()).toMatchObject({ status: "skipped", error_message: "cancelled_by_staff" });
    expect(row().provider_message_id ?? null).toBeNull();
  });
});

describe("T2: claim call is unchanged (M-0 claim function, permissions and fingerprints untouched)", () => {
  it("calls claim_outbound_deliveries with an owner, the caller's limit and the 300-second lease", async () => {
    const db = seed([emailRow()]);
    await dispatchQueuedOutboundDeliveries(17);
    const call = db.rpcCalls.find((c) => c.name === "claim_outbound_deliveries");
    expect(call?.args).toMatchObject({ p_limit: 17, p_lease_seconds: 300 });
    expect(String(call?.args.p_owner)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("T2 + M-0: commercial email keeps every marketing control through retries", () => {
  const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const postalStudio: FakeRow = {
    ...studio,
    address_line_1: "1 Harbor Way",
    address_line_2: null,
    city: "Wilmington",
    state: "NC",
    postal_code: "28401",
    country: "US",
  };
  function seedCommercial(suppression = "eligible") {
    fake.current = createFakeSupabase({
      outbound_deliveries: [
        emailRow({
          template_key: "automation_low_package_balance",
          subject: "Harbor Dance: renew your lesson package",
          body_text: "Hi Alex,\n\nYou are close to the end of your package.",
          payload: { content_origin: "system_default" },
        }),
      ],
      studios: [postalStudio],
    });
    installClaim(fake.current);
    fake.current.overrideRpc("marketing_suppression_status", () => ({ data: suppression, error: null }));
    fake.current.overrideRpc("marketing_issue_message_unsubscribe_token", () => ({ data: TOKEN, error: null }));
  }
  beforeEach(() => {
    process.env.MARKETING_FROM_EMAIL = "DanceFlow <news@mail.idanceflow.com>";
    process.env.NEXT_PUBLIC_SITE_URL = "https://www.idanceflow.com";
  });
  afterEach(() => {
    delete process.env.MARKETING_FROM_EMAIL;
  });

  it("a 5xx retry re-sends byte-identical commercial content (marketing sender, unsubscribe headers) with the same key", async () => {
    seedCommercial();
    sendMock.mockResolvedValueOnce(providerError("internal_server_error", 500)).mockResolvedValueOnce(accepted("email-c"));
    await dispatchQueuedOutboundDeliveries(10);
    expect(row().status).toBe("queued");
    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "sent", provider_message_id: "email-c" });
    const [[a, keyA], [b, keyB]] = sendMock.mock.calls;
    expect(b).toEqual(a);
    expect(keyB).toEqual(keyA);
    expect(a.from).toBe('"Harbor Dance via DanceFlow" <news@mail.idanceflow.com>');
    expect(a.headers).toMatchObject({ "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    // suppression is re-checked on every attempt (an unsubscribe between attempts is honoured)
    expect(fake.current!.rpcCalls.filter((c) => c.name === "marketing_suppression_status")).toHaveLength(2);
  });

  it("an unsubscribed recipient is still skipped with the marketing reason and never sent", async () => {
    seedCommercial("unsubscribed");
    const result = await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1 });
    expect(row()).toMatchObject({ status: "skipped", error_message: "marketing_unsubscribed" });
  });
});

describe("T2: staff screens treat a retry marker as in flight, not failed", () => {
  it("deliveryFailureNote hides retry markers and keeps real failure codes", async () => {
    const { deliveryFailureNote } = await import("@/lib/notifications/deliveryOutcome");
    expect(deliveryFailureNote(buildRetryMarker("provider_unavailable", Date.now()))).toBeNull();
    expect(deliveryFailureNote(null)).toBeNull();
    expect(deliveryFailureNote("")).toBeNull();
    expect(deliveryFailureNote("provider_rejected:validation_error")).toBe("provider_rejected:validation_error");
  });
});

describe("T2: ARIA requeue paths never resurrect an uncertain delivery", () => {
  const ACTION_ID = "44444444-4444-4444-8444-444444444444";
  const RUN_ID = "55555555-5555-4555-8555-555555555555";
  const past = () => new Date(Date.now() - 60_000).toISOString();

  /** An operational ARIA action email (no M-0 marketing path) that failed with `code`. */
  function ariaActionDelivery(over: FakeRow = {}): FakeRow {
    return emailRow({
      id: "aria-d",
      template_key: "aria_execution_aria_membership_past_due",
      subject: "Harbor Dance: membership billing needs attention",
      body_text: "Hi Alex,\n\nPlease update your payment details.",
      payload: { content_origin: "system_default" },
      related_table: "automation_actions",
      related_id: ACTION_ID,
      status: "failed",
      ...over,
    });
  }
  function failedAction(over: FakeRow = {}): FakeRow {
    return {
      id: ACTION_ID,
      studio_id: STUDIO_ID,
      rule_key: "aria_membership_past_due",
      status: "queued",
      execution_status: "failed",
      execution_delivery_id: "aria-d",
      execution_attempt_count: 1,
      execution_next_attempt_at: past(),
      execution_error_message: "x",
      ...over,
    };
  }
  function ariaDigestDelivery(over: FakeRow = {}): FakeRow {
    return emailRow({
      id: "digest-d",
      template_key: "aria_digest_morning",
      subject: "ARIA morning digest",
      body_text: "Your morning digest.",
      status: "failed",
      ...over,
    });
  }
  function failedRun(over: FakeRow = {}): FakeRow {
    return {
      id: RUN_ID,
      studio_id: STUDIO_ID,
      digest_type: "morning",
      digest_date: "2026-10-14",
      status: "failed",
      delivery_id: "digest-d",
      retry_count: 1,
      next_attempt_at: past(),
      error_message: "x",
      ...over,
    };
  }
  const action = () => fake.current!.rows("automation_actions")[0];
  const run = () => fake.current!.rows("aria_digest_runs")[0];
  const events = (type: string) =>
    fake.current!.rows("automation_action_events").filter((event) => event.event_type === type);
  const terminalAlerts = () => fake.current!.rows("platform_error_logs");

  const UNSAFE: Array<[string, string | null]> = [
    ["unknown outcome after the retry window", "provider_retry_window_exhausted"],
    ["payload mismatch on the reused key", "provider_idempotency_mismatch"],
    ["sanitizer fallback", "dispatch_error"],
    ["pre-T2 free text (cannot be classified)", "Unable to fetch data. The request could not be resolved."],
    ["no recorded reason", null],
  ];

  describe("action path (requeueFailedAriaActionDeliveries)", () => {
    it.each(UNSAFE)("%s: not requeued, action closed for staff, nothing sent", async (_label, code) => {
      seed([ariaActionDelivery({ error_message: code })], { automation_actions: [failedAction()] });
      const result = await dispatchQueuedOutboundDeliveries(10);
      expect(sendMock).not.toHaveBeenCalled();
      expect(result.requeued).toBe(0);
      expect(row("aria-d")).toMatchObject({ status: "failed", error_message: code });
      expect(action()).toMatchObject({
        status: "failed",
        execution_status: "exhausted",
        execution_next_attempt_at: null,
        execution_error_message: code && /^[a-z_]+$/.test(code) ? code : "dispatch_error",
      });
      expect(events("delivery_exhausted")).toHaveLength(1);
      expect(events("delivery_requeued")).toHaveLength(0);

      // Later runs leave it alone (no repeated close events, no send).
      await dispatchQueuedOutboundDeliveries(10);
      expect(sendMock).not.toHaveBeenCalled();
      expect(events("delivery_exhausted")).toHaveLength(1);
    });

    it("SMS failure after the provider call is never requeued", async () => {
      seed([ariaActionDelivery({ channel: "sms", error_message: "sms_sent_outcome_unrecorded" })], {
        automation_actions: [failedAction()],
      });
      await dispatchQueuedOutboundDeliveries(10);
      expect(row("aria-d").status).toBe("failed");
      expect(action().execution_status).toBe("exhausted");
    });

    it.each([
      ["definite provider rejection", "provider_rejected:validation_error"],
      ["pre-provider failure", "missing_sender_address"],
      ["email lookup/render exception", "dispatch_exception"],
    ])("%s: still requeued and re-sent once with the same key", async (_label, code) => {
      seed([ariaActionDelivery({ error_message: code })], { automation_actions: [failedAction()] });
      const result = await dispatchQueuedOutboundDeliveries(10);
      expect(result).toMatchObject({ requeued: 1, sent: 1 });
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0][1]).toEqual({ idempotencyKey: "outbound-delivery:aria-d" });
      expect(row("aria-d")).toMatchObject({ status: "sent", error_message: null });
      expect(action()).toMatchObject({ execution_status: "sent", execution_attempt_count: 2 });
      expect(events("delivery_requeued")).toHaveLength(1);
    });

    it("an expired retry window at dispatch closes the action at once (not scheduled for another attempt)", async () => {
      const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
      seed(
        [ariaActionDelivery({ status: "queued", error_message: buildRetryMarker("provider_timeout", thirteenHoursAgo) })],
        { automation_actions: [failedAction({ status: "queued", execution_status: "retrying", execution_next_attempt_at: null })] },
      );
      await dispatchQueuedOutboundDeliveries(10);
      expect(sendMock).not.toHaveBeenCalled();
      expect(row("aria-d")).toMatchObject({ status: "failed", error_message: "provider_retry_window_exhausted" });
      expect(action()).toMatchObject({ status: "failed", execution_status: "exhausted", execution_next_attempt_at: null });
      expect(events("delivery_exhausted")).toHaveLength(1);
    });

    it("an idempotency mismatch at dispatch closes the action at once", async () => {
      seed([ariaActionDelivery({ status: "queued", error_message: null })], {
        automation_actions: [failedAction({ status: "queued", execution_status: "retrying", execution_next_attempt_at: null })],
      });
      sendMock.mockResolvedValueOnce(providerError("invalid_idempotent_request", 409));
      await dispatchQueuedOutboundDeliveries(10);
      expect(action()).toMatchObject({ execution_status: "exhausted", execution_next_attempt_at: null });
    });

    it("a definite rejection at dispatch keeps the existing three-attempt retry schedule", async () => {
      seed([ariaActionDelivery({ status: "queued", error_message: null })], {
        automation_actions: [failedAction({ status: "queued", execution_status: "retrying", execution_next_attempt_at: null })],
      });
      sendMock.mockResolvedValueOnce(providerError("validation_error", 422));
      await dispatchQueuedOutboundDeliveries(10);
      expect(action()).toMatchObject({ status: "queued", execution_status: "failed", execution_attempt_count: 2 });
      expect(action().execution_next_attempt_at).not.toBeNull();
    });
  });

  describe("digest path (requeueFailedAriaDigestDeliveries)", () => {
    it.each(UNSAFE)("%s: not requeued, run closed with a terminal alert, nothing sent", async (_label, code) => {
      seed([ariaDigestDelivery({ error_message: code })], { aria_digest_runs: [failedRun()] });
      const result = await dispatchQueuedOutboundDeliveries(10);
      expect(sendMock).not.toHaveBeenCalled();
      expect(result.requeued).toBe(0);
      expect(row("digest-d")).toMatchObject({ status: "failed", error_message: code });
      expect(run()).toMatchObject({ status: "failed", retry_count: 1, next_attempt_at: null });
      expect(String(run().error_message)).toMatch(/^[a-z_]+$/);
      expect(terminalAlerts()).toHaveLength(1);
      expect(terminalAlerts()[0]).toMatchObject({ severity: "critical", source: "aria_digest" });
    });

    it("a definite rejection is still requeued and re-sent once with the same key", async () => {
      seed([ariaDigestDelivery({ error_message: "provider_rejected:validation_error" })], {
        aria_digest_runs: [failedRun()],
      });
      const result = await dispatchQueuedOutboundDeliveries(10);
      expect(result).toMatchObject({ requeued: 1, sent: 1 });
      expect(sendMock.mock.calls[0][1]).toEqual({ idempotencyKey: "outbound-delivery:digest-d" });
      expect(run()).toMatchObject({ status: "sent", retry_count: 2 });
    });

    it("an expired retry window at dispatch makes the run terminal at once", async () => {
      const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
      seed(
        [ariaDigestDelivery({ status: "queued", error_message: buildRetryMarker("provider_unreachable", thirteenHoursAgo) })],
        { aria_digest_runs: [{ ...failedRun(), status: "queued", next_attempt_at: null }] },
      );
      await dispatchQueuedOutboundDeliveries(10);
      expect(sendMock).not.toHaveBeenCalled();
      expect(run()).toMatchObject({ status: "failed", next_attempt_at: null });
      expect(terminalAlerts()).toHaveLength(1);
    });

    it("a definite rejection at dispatch keeps the existing retry schedule", async () => {
      seed([ariaDigestDelivery({ status: "queued", error_message: null })], {
        aria_digest_runs: [{ ...failedRun(), status: "queued", next_attempt_at: null }],
      });
      sendMock.mockResolvedValueOnce(providerError("validation_error", 422));
      await dispatchQueuedOutboundDeliveries(10);
      expect(run().status).toBe("failed");
      expect(run().next_attempt_at).not.toBeNull();
      expect(terminalAlerts()).toHaveLength(0);
    });
  });
});

describe("T2: isRequeueSafeFailure allowlist", () => {
  it("allows only failures that prove non-delivery", async () => {
    const { isRequeueSafeFailure } = await import("@/lib/notifications/deliveryOutcome");
    for (const code of ["missing_recipient_email", "missing_sender_address", "marketing_suppression_unavailable", "provider_rejected", "provider_rejected:validation_error", "dispatch_exception"]) {
      expect(isRequeueSafeFailure(code, "email")).toBe(true);
    }
    for (const code of ["provider_retry_window_exhausted", "provider_idempotency_mismatch", "dispatch_error", "provider_rejected:Bad Name", "retry:provider_timeout:1700000000000", "", null, undefined]) {
      expect(isRequeueSafeFailure(code, "email")).toBe(false);
    }
    expect(isRequeueSafeFailure("dispatch_exception", "sms")).toBe(false);
    expect(isRequeueSafeFailure("provider_rejected:validation_error", "sms")).toBe(false);
    expect(isRequeueSafeFailure("sms_sent_outcome_unrecorded", "sms")).toBe(false);
  });
});

describe("T2 M1: a failure after an attempt that may have been accepted is uncertain, not requeue-safe", () => {
  const loadHelpers = () => import("@/lib/notifications/deliveryOutcome");

  it("timeout, then a provider rejection: recorded as failed_after_uncertain_attempt (never requeued)", async () => {
    const { isRequeueSafeFailure, describeDeliveryNoteForStaff } = await loadHelpers();
    seed([emailRow()]);
    sendMock
      .mockResolvedValueOnce(providerError("dispatcher_timeout", null))
      .mockResolvedValueOnce(providerError("validation_error", 403));
    await dispatchQueuedOutboundDeliveries(10);
    expect(parseRetryMarker(row().error_message)).toMatchObject({ code: "provider_timeout", unsentOnly: false });
    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "failed", error_message: "failed_after_uncertain_attempt" });
    expect(isRequeueSafeFailure(row().error_message as string | null, "email")).toBe(false);
    expect(describeDeliveryNoteForStaff(row().error_message as string | null)).toMatch(/^Delivery uncertain:/);
  });

  it("accepted but unrecorded, then a provider rejection on the replay: uncertain", async () => {
    const db = seed([emailRow()]);
    db.failUpdates("outbound_deliveries", (values) => values.status === "sent");
    await dispatchQueuedOutboundDeliveries(10); // accepted; recording failed; marker written
    sendMock.mockResolvedValueOnce(providerError("validation_error", 422));
    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "failed", error_message: "failed_after_uncertain_attempt" });
  });

  it("5xx, then a pre-provider failure: uncertain too (an earlier attempt may have been accepted)", async () => {
    seed([emailRow()]);
    sendMock.mockResolvedValueOnce(providerError("internal_server_error", 500));
    await dispatchQueuedOutboundDeliveries(10);
    row().recipient_email = null; // the next attempt fails before any provider call
    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ status: "failed", error_message: "failed_after_uncertain_attempt" });
  });

  it("5xx, then a payload mismatch: keeps the more specific uncertain code", async () => {
    seed([emailRow()]);
    sendMock
      .mockResolvedValueOnce(providerError("internal_server_error", 500))
      .mockResolvedValueOnce(providerError("invalid_idempotent_request", 409));
    await dispatchQueuedOutboundDeliveries(10);
    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "failed", error_message: "provider_idempotency_mismatch" });
  });

  it("only definitely-unsent attempts, then a rejection: stays a definite (requeue-safe) rejection", async () => {
    const { isRequeueSafeFailure } = await loadHelpers();
    seed([emailRow()]);
    sendMock
      .mockResolvedValueOnce(providerError("rate_limit_exceeded", 429))
      .mockResolvedValueOnce(providerError("invalid_api_key", 403))
      .mockResolvedValueOnce(providerError("validation_error", 422));
    await dispatchQueuedOutboundDeliveries(10);
    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    expect(parseRetryMarker(row().error_message)).toMatchObject({ code: "provider_auth_error", unsentOnly: true });
    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "failed", error_message: "provider_rejected:validation_error" });
    expect(isRequeueSafeFailure(row().error_message as string | null, "email")).toBe(true);
  });

  it("a first-attempt rejection (no earlier attempt) is unchanged", async () => {
    seed([emailRow()]);
    sendMock.mockResolvedValueOnce(providerError("validation_error", 422));
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "failed", error_message: "provider_rejected:validation_error" });
  });

  it("ARIA action: timeout then rejection closes the action instead of scheduling a retry", async () => {
    seed(
      [
        emailRow({
          id: "aria-m1",
          template_key: "aria_execution_aria_membership_past_due",
          payload: { content_origin: "system_default" },
          related_table: "automation_actions",
          related_id: "action-m1",
        }),
      ],
      {
        automation_actions: [
          {
            id: "action-m1",
            studio_id: STUDIO_ID,
            rule_key: "aria_membership_past_due",
            status: "queued",
            execution_status: "queued",
            execution_attempt_count: 0,
          },
        ],
      },
    );
    sendMock
      .mockResolvedValueOnce(providerError("application_error", null))
      .mockResolvedValueOnce(providerError("validation_error", 422));
    await dispatchQueuedOutboundDeliveries(10);
    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    const action = fake.current!.rows("automation_actions")[0];
    expect(action).toMatchObject({ status: "failed", execution_status: "exhausted", execution_next_attempt_at: null });
    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});

describe("T2 MINOR 2: retry window ends as definitely-unsent only when no attempt could have been accepted", () => {
  const THIRTEEN_HOURS_AGO = () => Date.now() - 13 * 60 * 60 * 1000;

  it.each([
    ["provider_not_configured"],
    ["provider_auth_error"],
    ["provider_rate_limited"],
  ])("only %s attempts: ends as provider_retry_window_exhausted_unsent (retryable, worded as not delivered)", async (code) => {
    const { isRequeueSafeFailure, describeDeliveryNoteForStaff, isUncertainDeliveryOutcome } = await import(
      "@/lib/notifications/deliveryOutcome"
    );
    seed([emailRow({ error_message: buildRetryMarker(code, THIRTEEN_HOURS_AGO(), true) })]);
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "failed", error_message: "provider_retry_window_exhausted_unsent" });
    expect(isRequeueSafeFailure(row().error_message as string | null, "email")).toBe(true);
    expect(isUncertainDeliveryOutcome(row().error_message as string | null)).toBe(false);
    expect(describeDeliveryNoteForStaff(row().error_message as string | null)).toMatch(/^Not delivered:/);
  });

  it("the unsent flag is kept only while every attempt is definitely unsent", async () => {
    seed([emailRow()]);
    sendMock
      .mockResolvedValueOnce(providerError("missing_api_key", 401))
      .mockResolvedValueOnce(providerError("rate_limit_exceeded", 429))
      .mockResolvedValueOnce(providerError("dispatcher_timeout", null))
      .mockResolvedValueOnce(providerError("invalid_api_key", 403));
    const markers: Array<boolean | undefined> = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await dispatchQueuedOutboundDeliveries(10);
      markers.push(parseRetryMarker(row().error_message)?.unsentOnly);
      expireLeases();
    }
    // An ambiguous attempt clears the flag for good, even if later attempts are definitely refused.
    expect(markers).toEqual([true, true, false, false]);
  });

  it("a window that included a possibly-accepted attempt still ends as an unknown outcome", async () => {
    seed([emailRow({ error_message: buildRetryMarker("provider_auth_error", THIRTEEN_HOURS_AGO(), false) })]);
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "failed", error_message: "provider_retry_window_exhausted" });
  });

  it("ARIA action: a definitely-unsent window end keeps the normal retry schedule and is requeued", async () => {
    seed(
      [
        emailRow({
          id: "aria-n",
          template_key: "aria_execution_aria_membership_past_due",
          payload: { content_origin: "system_default" },
          related_table: "automation_actions",
          related_id: "action-n",
          error_message: buildRetryMarker("provider_not_configured", THIRTEEN_HOURS_AGO(), true),
        }),
      ],
      {
        automation_actions: [
          {
            id: "action-n",
            studio_id: STUDIO_ID,
            rule_key: "aria_membership_past_due",
            status: "queued",
            execution_status: "queued",
            execution_attempt_count: 0,
          },
        ],
      },
    );
    await dispatchQueuedOutboundDeliveries(10);
    const action = fake.current!.rows("automation_actions")[0];
    expect(action).toMatchObject({ status: "queued", execution_status: "failed", execution_attempt_count: 1 });
    expect(action.execution_next_attempt_at).not.toBeNull();
    // Next requeue pass (the fake ignores the next-attempt time): requeued and sent with the same key.
    expireLeases();
    const result = await dispatchQueuedOutboundDeliveries(10);
    expect(result).toMatchObject({ requeued: 1, sent: 1 });
    expect(sendMock.mock.calls[0][1]).toEqual({ idempotencyKey: "outbound-delivery:aria-n" });
  });
});

describe("T2 re-review MAJOR 1: a pre-attempt marker means a lost outcome write is treated as possibly accepted", () => {
  const isOutcomeWrite = (prefix: string) => (values: FakeRow) =>
    typeof values.error_message === "string" && values.error_message.startsWith(prefix);

  it("writes an attempt-started marker (no unsent flag) before the provider is called", async () => {
    seed([emailRow()]);
    let seenDuringCall: unknown;
    sendMock.mockImplementationOnce(async () => {
      seenDuringCall = row().error_message;
      return accepted();
    });
    await dispatchQueuedOutboundDeliveries(10);
    expect(parseRetryMarker(seenDuringCall)).toMatchObject({ code: "provider_attempt_started", unsentOnly: false });
    expect(row()).toMatchObject({ status: "sent", error_message: null });
  });

  it("scenario A: refused attempts, then a timeout whose outcome write is lost, then the window ends: unknown outcome", async () => {
    const elevenHoursAgo = Date.now() - 11 * 60 * 60 * 1000;
    const db = seed([emailRow({ error_message: buildRetryMarker("provider_rate_limited", elevenHoursAgo, true) })]);
    db.failUpdates("outbound_deliveries", isOutcomeWrite("retry:provider_timeout:"));
    sendMock.mockResolvedValueOnce(providerError("dispatcher_timeout", null));
    await dispatchQueuedOutboundDeliveries(10);
    // Without the pre-attempt marker the row would still carry the stale `:n` (all-unsent) marker here.
    expect(parseRetryMarker(row().error_message)).toMatchObject({ code: "provider_attempt_started", unsentOnly: false });
    expect(parseRetryMarker(row().error_message)?.firstAttemptMs).toBe(elevenHoursAgo);

    expireLeases();
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 2 * 60 * 60 * 1000);
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ status: "failed", error_message: "provider_retry_window_exhausted" });
  });

  it("scenario B: a fresh row's timeout outcome write is lost, then a rejection: uncertain", async () => {
    const db = seed([emailRow()]);
    db.failUpdates("outbound_deliveries", isOutcomeWrite("retry:provider_timeout:"));
    sendMock
      .mockResolvedValueOnce(providerError("dispatcher_timeout", null))
      .mockResolvedValueOnce(providerError("validation_error", 422));
    await dispatchQueuedOutboundDeliveries(10);
    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "failed", error_message: "failed_after_uncertain_attempt" });
  });

  it("a definitely-refused attempt still keeps the unsent flag (the outcome write replaces the pre-attempt marker)", async () => {
    seed([emailRow()]);
    sendMock.mockResolvedValueOnce(providerError("rate_limit_exceeded", 429));
    await dispatchQueuedOutboundDeliveries(10);
    expect(parseRetryMarker(row().error_message)).toMatchObject({ code: "provider_rate_limited", unsentOnly: true });
  });

  it("if the pre-attempt marker cannot be written, the provider is not called and the row is untouched", async () => {
    const db = seed([emailRow()]);
    db.failUpdates("outbound_deliveries", isOutcomeWrite("retry:provider_attempt_started:"));
    const result = await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, failed: 0 });
    expect(row()).toMatchObject({ status: "queued", error_message: null });
  });

  it("if the claim was lost before the attempt started, the provider is not called", async () => {
    const db = seed([emailRow()]);
    db.overrideRpc("claim_outbound_deliveries", (args) => {
      const target = db.rows("outbound_deliveries")[0];
      const copy = { ...target, claim_owner: args.p_owner };
      target.claim_owner = "another-worker"; // reclaimed after this run loaded it
      target.claim_expires_at = new Date(Date.now() + 300_000).toISOString();
      return { data: [copy], error: null };
    });
    const result = await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ lostClaims: 1, sent: 0 });
  });

  it("a first-attempt rejection is still a definite (retryable) rejection", async () => {
    seed([emailRow()]);
    sendMock.mockResolvedValueOnce(providerError("validation_error", 422));
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "failed", error_message: "provider_rejected:validation_error" });
  });

  /** Updates that wrote an attempt-started marker (checked on the recorded writes, not the final row state). */
  const attemptMarkerWrites = () =>
    fake.current!.mutations.filter(
      (mutation) =>
        mutation.table === "outbound_deliveries" &&
        mutation.op === "update" &&
        String((mutation.values as FakeRow | null)?.error_message ?? "").startsWith("retry:provider_attempt_started:"),
    );

  it("SMS rows never get an attempt marker (no provider idempotency; behaviour unchanged)", async () => {
    seed([emailRow({ channel: "sms", template_key: "intake_invitation_student", recipient_phone: "+15550100123" })]);
    await dispatchQueuedOutboundDeliveries(10);
    expect(attemptMarkerWrites()).toHaveLength(0);
    expect(row()).toMatchObject({ status: "skipped", error_message: "sms_template_not_permitted" });
  });

  it("an email send attempt writes exactly one attempt marker", async () => {
    seed([emailRow()]);
    await dispatchQueuedOutboundDeliveries(10);
    expect(attemptMarkerWrites()).toHaveLength(1);
  });

  it.each([
    ["no provider key", () => delete process.env.RESEND_API_KEY, {}],
    ["missing recipient", () => undefined, { recipient_email: null }],
    ["unsupported template", () => undefined, { template_key: "intake_invitation_student" }],
  ])("%s: stops before the provider, so no attempt marker is written", async (_label, arrange, over) => {
    arrange();
    seed([emailRow(over as FakeRow)]);
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(attemptMarkerWrites()).toHaveLength(0);
  });

  it("an M-0 suppression skip stops before the provider, so no attempt marker is written", async () => {
    process.env.MARKETING_FROM_EMAIL = "DanceFlow <news@mail.idanceflow.com>";
    try {
      fake.current = createFakeSupabase({
        outbound_deliveries: [
          emailRow({ template_key: "automation_low_package_balance", payload: { content_origin: "system_default" } }),
        ],
        studios: [{ ...studio, address_line_1: "1 Harbor Way", city: "Wilmington", state: "NC", postal_code: "28401", country: "US" }],
      });
      installClaim(fake.current);
      fake.current.overrideRpc("marketing_suppression_status", () => ({ data: "suppressed", error: null }));
      await dispatchQueuedOutboundDeliveries(10);
      expect(sendMock).not.toHaveBeenCalled();
      expect(attemptMarkerWrites()).toHaveLength(0);
      expect(row()).toMatchObject({ status: "skipped", error_message: "marketing_suppressed" });
    } finally {
      delete process.env.MARKETING_FROM_EMAIL;
    }
  });

  it("a pre-provider stop whose outcome write is lost does not make a later rejection uncertain", async () => {
    delete process.env.RESEND_API_KEY;
    const db = seed([emailRow()]);
    db.failUpdates("outbound_deliveries", isOutcomeWrite("retry:provider_not_configured:"));
    await dispatchQueuedOutboundDeliveries(10);
    expect(row().error_message).toBeNull(); // nothing recorded, and nothing could have been sent
    process.env.RESEND_API_KEY = "re_test_not_a_real_key";
    sendMock.mockResolvedValueOnce(providerError("validation_error", 422));
    expireLeases();
    await dispatchQueuedOutboundDeliveries(10);
    expect(row()).toMatchObject({ status: "failed", error_message: "provider_rejected:validation_error" });
  });

  it("staff see an in-flight first attempt as sending, not as a delivery problem", async () => {
    const { describeDeliveryNoteForStaff, deliveryFailureNote } = await import("@/lib/notifications/deliveryOutcome");
    const marker = buildRetryMarker("provider_attempt_started", Date.now());
    expect(describeDeliveryNoteForStaff(marker)).toBe("Sending in progress.");
    expect(deliveryFailureNote(marker)).toBeNull();
    expect(describeDeliveryNoteForStaff("provider_retry_window_exhausted_unsent")).toMatch(
      /^Not delivered: every attempt was refused/,
    );
  });
});

describe("T2 re-review MINOR: a skip after a possibly-accepted attempt does not claim nothing was sent", () => {
  const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  function seedAriaCommercial(errorMessage: string | null) {
    fake.current = createFakeSupabase({
      outbound_deliveries: [
        emailRow({
          id: "aria-s",
          template_key: "aria_execution_aria_low_package_balance",
          payload: { content_origin: "system_default" },
          related_table: "automation_actions",
          related_id: "action-s",
          error_message: errorMessage,
        }),
      ],
      studios: [{ ...studio, address_line_1: "1 Harbor Way", city: "Wilmington", state: "NC", postal_code: "28401", country: "US" }],
      automation_actions: [
        { id: "action-s", studio_id: STUDIO_ID, rule_key: "aria_low_package_balance", status: "queued", execution_attempt_count: 1 },
      ],
    });
    installClaim(fake.current);
    fake.current.overrideRpc("marketing_suppression_status", () => ({ data: "unsubscribed", error: null }));
    fake.current.overrideRpc("marketing_issue_message_unsubscribe_token", () => ({ data: TOKEN, error: null }));
  }
  beforeEach(() => {
    process.env.MARKETING_FROM_EMAIL = "DanceFlow <news@mail.idanceflow.com>";
  });
  afterEach(() => {
    delete process.env.MARKETING_FROM_EMAIL;
  });
  const action = () => fake.current!.rows("automation_actions")[0];
  const skipEvent = () => fake.current!.rows("automation_action_events").find((e) => e.event_type === "execution_skipped");

  it("after an earlier possibly-accepted attempt, the note warns it may already have reached the client", async () => {
    seedAriaCommercial(buildRetryMarker("provider_unavailable", Date.now() - 60_000));
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(row("aria-s")).toMatchObject({ status: "skipped", error_message: "marketing_unsubscribed" });
    expect(String(action().review_note)).toMatch(/may already have reached the client/);
    expect((skipEvent()!.metadata as Record<string, unknown>).earlier_attempt_uncertain).toBe(true);
  });

  it("without an uncertain earlier attempt, the marketing wording is unchanged", async () => {
    seedAriaCommercial(null);
    await dispatchQueuedOutboundDeliveries(10);
    expect(action().review_note).toBe(
      "ARIA did not send this follow-up: the client is not eligible for marketing email from this studio.",
    );
    expect((skipEvent()!.metadata as Record<string, unknown>).earlier_attempt_uncertain).toBeUndefined();
  });

  it("after only definitely-refused attempts, the marketing wording is unchanged", async () => {
    seedAriaCommercial(buildRetryMarker("provider_rate_limited", Date.now() - 60_000, true));
    await dispatchQueuedOutboundDeliveries(10);
    expect(String(action().review_note)).toMatch(/not eligible for marketing email/);
  });
});

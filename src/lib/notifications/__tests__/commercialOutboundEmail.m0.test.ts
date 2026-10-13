import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/**
 * Marketing M-0 (D1/D2): commercial ARIA / automation emails pass the marketing controls at the dispatch boundary;
 * operational ones are unchanged. Real dispatcher, fake database, fake provider.
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
const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const LEGAL = "DanceFlow is a software platform owned and operated by GenX TotalTech LLC.";

const studio = (over: FakeRow = {}): FakeRow => ({
  id: STUDIO_ID,
  name: "Harbor Dance LLC",
  public_name: "Harbor Dance",
  public_logo_url: null,
  email: "front@harbordance.com",
  address_line_1: "1 Harbor Way",
  address_line_2: null,
  city: "Wilmington",
  state: "NC",
  postal_code: "28401",
  country: "US",
  ...over,
});

function delivery(over: FakeRow = {}): FakeRow {
  return {
    id: "d-1",
    studio_id: STUDIO_ID,
    channel: "email",
    template_key: "automation_low_package_balance",
    recipient_email: "client@example.com",
    subject: "Harbor Dance: renew your lesson package",
    body_text: "Hi Alex,\n\nYou are close to the end of your package.",
    body_html: null,
    reply_to_email: null,
    status: "queued",
    payload: { content_origin: "system_default" },
    related_table: null,
    related_id: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function seed(row: FakeRow, studioRow: FakeRow = studio(), extra: Record<string, FakeRow[]> = {}) {
  fake.current = createFakeSupabase({ outbound_deliveries: [row], studios: [studioRow], ...extra });
  fake.current.overrideRpc("marketing_suppression_status", () => ({ data: "eligible", error: null }));
  fake.current.overrideRpc("marketing_issue_message_unsubscribe_token", () => ({ data: TOKEN, error: null }));
}
const status = (id = "d-1") => fake.current!.rows("outbound_deliveries").find((r) => r.id === id);

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
  process.env.MARKETING_FROM_EMAIL = "DanceFlow <news@mail.idanceflow.com>";
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.idanceflow.com";
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });
});
afterEach(() => {
  delete process.env.MARKETING_FROM_EMAIL;
});

describe("commercial ARIA / automation email at the dispatch boundary", () => {
  it("goes out from the marketing sender with the studio address, an unsubscribe link and one-click headers", async () => {
    seed(delivery());
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [payload, options] = sendMock.mock.calls[0];
    expect(payload.from).toBe('"Harbor Dance via DanceFlow" <news@mail.idanceflow.com>');
    expect(payload.headers).toEqual({
      "List-Unsubscribe": `<https://www.idanceflow.com/api/email/unsubscribe/${TOKEN}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(payload.html).toContain(`https://www.idanceflow.com/unsubscribe/marketing/${TOKEN}`);
    expect(payload.html).toContain("1 Harbor Way · Wilmington, NC, 28401 · US");
    // the compliance block sits inside the footer, before the legal line, which stays last and single
    expect(payload.html.indexOf('data-df-marketing-compliance="1"')).toBeLessThan(payload.html.lastIndexOf(LEGAL));
    expect(payload.html.split(LEGAL).length - 1).toBe(1);
    expect(payload.text).toContain(`Unsubscribe from Harbor Dance marketing emails: https://www.idanceflow.com/unsubscribe/marketing/${TOKEN}`);
    expect(payload.text.endsWith(LEGAL)).toBe(true);
    expect(options).toEqual({ idempotencyKey: "outbound-delivery:d-1" });
    expect(fake.current!.rpcCalls.find((c) => c.name === "marketing_issue_message_unsubscribe_token")?.args).toMatchObject({
      p_scope_kind: "studio",
      p_scope_id: STUDIO_ID,
      p_email: "client@example.com",
      p_source_table: "outbound_deliveries",
      p_source_id: "d-1",
    });
    expect(status()?.status).toBe("sent");
  });

  it.each([
    ["unsubscribed", "marketing_unsubscribed"],
    ["suppressed", "marketing_suppressed"],
    ["invalid", "marketing_invalid_recipient"],
  ])("a %s address is not sent (skipped: %s)", async (result, reason) => {
    seed(delivery());
    fake.current!.overrideRpc("marketing_suppression_status", () => ({ data: result, error: null }));
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(status()).toMatchObject({ status: "skipped", error_message: reason });
  });

  it("a suppression lookup failure prevents the send (fail closed)", async () => {
    seed(delivery());
    fake.current!.overrideRpc("marketing_suppression_status", () => ({ data: null, error: { message: "db down" } }));
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(status()).toMatchObject({ status: "failed", error_message: "marketing_suppression_unavailable" });
  });

  it("a studio without a complete postal address cannot send commercial email", async () => {
    seed(delivery(), studio({ postal_code: null }));
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(status()).toMatchObject({ status: "skipped", error_message: "marketing_footer_address_missing" });
  });

  it("without a configured marketing sender nothing goes out through the transactional sender", async () => {
    delete process.env.MARKETING_FROM_EMAIL;
    seed(delivery());
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(status()).toMatchObject({ status: "failed", error_message: "marketing_sender_not_configured" });
  });

  it("a studio-customized operational template is treated as commercial", async () => {
    seed(delivery({ template_key: "automation_unsigned_document", payload: { content_origin: "studio_customized" } }));
    fake.current!.overrideRpc("marketing_suppression_status", () => ({ data: "unsubscribed", error: null }));
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(status()).toMatchObject({ status: "skipped", error_message: "marketing_unsubscribed" });
  });

  it("an ARIA execution that is skipped for marketing eligibility closes its action as skipped (never retried)", async () => {
    seed(
      delivery({ template_key: "aria_execution_aria_stale_active_student", related_table: "automation_actions", related_id: "act-1" }),
      studio(),
      {
        automation_actions: [{ id: "act-1", studio_id: STUDIO_ID, rule_key: "aria_stale_active_student", status: "queued", execution_attempt_count: 0 }],
        automation_action_events: [],
      },
    );
    fake.current!.overrideRpc("marketing_suppression_status", () => ({ data: "unsubscribed", error: null }));
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).not.toHaveBeenCalled();
    expect(fake.current!.rows("automation_actions")[0]).toMatchObject({ status: "skipped", execution_status: "skipped", execution_error_message: "marketing_unsubscribed" });
    expect(fake.current!.rows("automation_action_events").map((e) => e.event_type)).toContain("execution_skipped");
  });
});

describe("operational email is unchanged", () => {
  it("an operational template with system content uses the transactional sender, no unsubscribe headers and no suppression lookup", async () => {
    seed(delivery({ template_key: "aria_execution_aria_membership_past_due", payload: { content_origin: "system_default" } }));
    await dispatchQueuedOutboundDeliveries(10);
    const [payload] = sendMock.mock.calls[0];
    expect(payload.from).toBe('"Harbor Dance via DanceFlow" <notify@idanceflow.com>');
    expect(payload.headers).toBeUndefined();
    expect(fake.current!.rpcCalls.some((c) => c.name === "marketing_suppression_status")).toBe(false);
  });

  it("appointment and event templates never pass through marketing controls", async () => {
    seed(delivery({ template_key: "appointment_confirmed", payload: null }));
    fake.current!.overrideRpc("marketing_suppression_status", () => ({ data: "unsubscribed", error: null }));
    await dispatchQueuedOutboundDeliveries(10);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].headers).toBeUndefined();
  });
});

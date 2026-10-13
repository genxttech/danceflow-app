import { describe, expect, it, vi } from "vitest";
import { classifyProviderError, sendMarketingEmail, type MarketingEmailTransport } from "../provider";
import {
  buildListUnsubscribeHeaders,
  buildUnsubscribeLinks,
  isUnsubscribeToken,
  marketingSiteOrigin,
} from "../unsubscribeLinks";
import {
  CONTENT_ORIGIN_CUSTOMIZED,
  CONTENT_ORIGIN_SYSTEM,
  OUTBOUND_EMAIL_CLASSIFICATION,
  classifyOutboundEmail,
} from "../messageClassification";

const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("provider outcome classification (M-0 send-attempt lifecycle)", () => {
  it.each([
    ["validation_error", "rejected"],
    ["invalid_parameter", "rejected"],
    ["missing_required_field", "rejected"],
    ["rate_limit_exceeded", "not_sent"],
    ["daily_quota_exceeded", "not_sent"],
    ["invalid_from_address", "not_sent"],
    ["invalid_api_key", "not_sent"],
    ["application_error", "uncertain"],
    ["internal_server_error", "uncertain"],
    ["concurrent_idempotent_requests", "uncertain"],
    ["invalid_idempotent_request", "uncertain"],
    ["something_new", "uncertain"],
  ])("%s -> %s", (name, kind) => {
    expect(classifyProviderError({ name, message: "x" }).kind).toBe(kind);
  });

  it("an error without a code is uncertain, never assumed not sent", () => {
    expect(classifyProviderError({ message: "rejected" })).toEqual({ kind: "uncertain", code: "unknown_error" });
  });

  it("sends headers and the idempotency key, and returns the provider id", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "msg-1" }, error: null });
    const outcome = await sendMarketingEmail({ send } as MarketingEmailTransport, {
      from: "news@example.test",
      to: "a@example.test",
      subject: "S",
      html: "<p>h</p>",
      text: "t",
      replyTo: "studio@example.test",
      headers: { "List-Unsubscribe": "<https://x/y>" },
      idempotencyKey: "mkt-studio-1",
    });
    expect(outcome).toEqual({ kind: "sent", messageId: "msg-1" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["a@example.test"], headers: { "List-Unsubscribe": "<https://x/y>" }, replyTo: "studio@example.test" }),
      { idempotencyKey: "mkt-studio-1" },
    );
  });

  it("a thrown transport error or a missing message id is uncertain", async () => {
    const message = { from: "f@x.test", to: "a@x.test", subject: "S", html: "h", text: "t", headers: {}, idempotencyKey: "k" };
    await expect(sendMarketingEmail({ send: vi.fn().mockRejectedValue(new Error("timeout")) }, message)).resolves.toEqual({
      kind: "uncertain",
      code: "transport_error",
    });
    await expect(sendMarketingEmail({ send: vi.fn().mockResolvedValue({ data: {}, error: null }) }, message)).resolves.toEqual({
      kind: "uncertain",
      code: "missing_message_id",
    });
  });
});

describe("unsubscribe links and RFC 8058 headers", () => {
  it("builds the confirmation page link and the one-click endpoint for each kind", () => {
    const env = { NEXT_PUBLIC_SITE_URL: "https://www.idanceflow.com/" } as unknown as NodeJS.ProcessEnv;
    expect(buildUnsubscribeLinks(TOKEN.toUpperCase(), "studio", env)).toEqual({
      pageUrl: `https://www.idanceflow.com/unsubscribe/marketing/${TOKEN}`,
      oneClickUrl: `https://www.idanceflow.com/api/email/unsubscribe/${TOKEN}`,
    });
    expect(buildUnsubscribeLinks(TOKEN, "organizer", env).pageUrl).toBe(
      `https://www.idanceflow.com/unsubscribe/organizer-marketing/${TOKEN}`,
    );
    expect(buildUnsubscribeLinks(TOKEN, "message", env).pageUrl).toBe(`https://www.idanceflow.com/unsubscribe/marketing/${TOKEN}`);
  });

  it("refuses to build a link without a valid token (a marketing email is never sent without one)", () => {
    expect(() => buildUnsubscribeLinks("tok-1", "studio")).toThrow();
    expect(() => buildUnsubscribeLinks("", "studio")).toThrow();
    expect(isUnsubscribeToken("x' or 1=1")).toBe(false);
  });

  it("emits RFC 2369 + RFC 8058 one-click headers", () => {
    expect(buildListUnsubscribeHeaders("https://www.idanceflow.com/api/email/unsubscribe/abc")).toEqual({
      "List-Unsubscribe": "<https://www.idanceflow.com/api/email/unsubscribe/abc>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("defaults to the production origin", () => {
    expect(marketingSiteOrigin({} as unknown as NodeJS.ProcessEnv)).toBe("https://idanceflow.com");
  });
});

describe("message classification (D1)", () => {
  it("covers every email-executable ARIA rule and every legacy automation default template", () => {
    for (const rule of ["aria_low_package_balance", "aria_stale_active_student", "aria_intro_no_purchase", "aria_membership_past_due", "aria_membership_canceling"]) {
      expect(OUTBOUND_EMAIL_CLASSIFICATION[`aria_execution_${rule}`]).toBeDefined();
    }
    for (const rule of ["low_package_balance", "no_upcoming_lesson", "unsigned_document", "pending_booking_request", "first_lesson_follow_up"]) {
      expect(OUTBOUND_EMAIL_CLASSIFICATION[`automation_${rule}`]).toBeDefined();
    }
  });

  it("re-engagement, renewal, retention and conversion messages are commercial regardless of content origin", () => {
    for (const key of [
      "aria_execution_aria_low_package_balance",
      "aria_execution_aria_stale_active_student",
      "aria_execution_aria_intro_no_purchase",
      "aria_execution_aria_membership_canceling",
      "automation_low_package_balance",
      "automation_no_upcoming_lesson",
      "automation_first_lesson_follow_up",
    ]) {
      expect(classifyOutboundEmail(key, { content_origin: CONTENT_ORIGIN_SYSTEM })).toBe("commercial");
    }
  });

  it("operational templates stay operational only with unmodified system content", () => {
    expect(classifyOutboundEmail("automation_unsigned_document", { content_origin: CONTENT_ORIGIN_SYSTEM })).toBe("operational");
    expect(classifyOutboundEmail("aria_execution_aria_membership_past_due", { content_origin: CONTENT_ORIGIN_SYSTEM })).toBe("operational");
    expect(classifyOutboundEmail("automation_unsigned_document", { content_origin: CONTENT_ORIGIN_CUSTOMIZED })).toBe("commercial");
    expect(classifyOutboundEmail("automation_pending_booking_request", null)).toBe("commercial");
  });

  it("an unregistered automation key fails closed to commercial", () => {
    expect(classifyOutboundEmail("automation_aria_cancellation_follow_up", { content_origin: CONTENT_ORIGIN_SYSTEM })).toBe("commercial");
    expect(classifyOutboundEmail("aria_execution_new_rule", null)).toBe("commercial");
  });

  it("templates outside the automation families keep their existing operational handling", () => {
    expect(classifyOutboundEmail("appointment_confirmed", null)).toBe("operational");
    expect(classifyOutboundEmail("event_registration_confirmed", null)).toBe("operational");
    expect(classifyOutboundEmail("aria_digest_morning", null)).toBe("operational");
  });
});

describe("campaign batch claim outcomes", () => {
  it("never sends to a recipient whose final claim is unsubscribed or suppressed, and counts it as suppressed", async () => {
    const { deliverCampaignBatch, emptyDeliverySummary } = await import("../campaignDelivery");
    const outcomes: Record<string, string> = { r1: "unsubscribed", r2: "suppressed", r3: "in_flight" };
    const admin = {
      rpc: vi.fn(async (_name: string, params: { p_recipient_id: string }) => ({
        data: { outcome: outcomes[params.p_recipient_id] },
        error: null,
      })),
    };
    const send = vi.fn();
    const summary = emptyDeliverySummary();
    await deliverCampaignBatch({
      summary,
      admin: admin as never,
      transport: { send } as unknown as MarketingEmailTransport,
      kind: "studio",
      scopeId: "s1",
      campaignId: "c1",
      recipientIds: ["r1", "r2", "r3"],
      from: "Studio <m@example.com>",
      render: () => ({ subject: "s", html: "h", text: "t" }),
    });
    expect(send).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ suppressed: 2, skipped: 1, sent: 0, attempted: 0 });
  });
});

describe("abandoned 'sending' campaign (C13)", () => {
  function adminWithLiveClaims(result: { count: number | null; error: unknown }) {
    const filters: Array<[string, string, unknown]> = [];
    const query = {
      select: () => query,
      eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), query),
      gt: (c: string, v: unknown) => (filters.push(["gt", c, v]), Promise.resolve(result)),
    };
    return { admin: { from: () => query } as never, filters };
  }
  const now = new Date("2026-10-13T12:00:00.000Z");
  const base = { kind: "studio" as const, scopeId: "s1", campaignId: "c1", now };

  it("stays locked while recently touched, even with no live claim", async () => {
    const { isAbandonedSendingCampaign } = await import("../campaignDelivery");
    const { admin } = adminWithLiveClaims({ count: 0, error: null });
    expect(await isAbandonedSendingCampaign(admin, { ...base, updatedAt: "2026-10-13T11:50:00.000Z" })).toBe(false);
  });

  it("stays locked while any recipient holds a live claim", async () => {
    const { isAbandonedSendingCampaign } = await import("../campaignDelivery");
    const { admin, filters } = adminWithLiveClaims({ count: 1, error: null });
    expect(await isAbandonedSendingCampaign(admin, { ...base, updatedAt: "2026-10-13T11:00:00.000Z" })).toBe(false);
    expect(filters).toContainEqual(["eq", "status", "sending"]);
    expect(filters).toContainEqual(["gt", "claim_expires_at", now.toISOString()]);
  });

  it("is resumable when stale with no live claim; a lookup error or missing timestamp keeps it locked", async () => {
    const { isAbandonedSendingCampaign } = await import("../campaignDelivery");
    expect(await isAbandonedSendingCampaign(adminWithLiveClaims({ count: 0, error: null }).admin, { ...base, updatedAt: "2026-10-13T11:00:00.000Z" })).toBe(true);
    expect(await isAbandonedSendingCampaign(adminWithLiveClaims({ count: null, error: { message: "x" } }).admin, { ...base, updatedAt: "2026-10-13T11:00:00.000Z" })).toBe(false);
    expect(await isAbandonedSendingCampaign(adminWithLiveClaims({ count: 0, error: null }).admin, { ...base, updatedAt: null })).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/** PAY-DC-3 (D3 / D-A): the canonical legal line in HTML and plain text. */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));
const sendMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake.current!.client,
}));

vi.mock("@/lib/aria/outcome-verification", () => ({
  getAriaOutcomeExpectation: () => null,
  verifyPendingAriaOutcomes: async () => ({ checked: 0 }),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import { EMAIL_LEGAL_LINE, appendEmailLegalText } from "@/lib/email/brand";
import {
  renderDanceFlowSystemEmail,
  renderPlainTextAsStudioEmail,
  renderStudioBrandedEmail,
} from "@/lib/notifications/email-branding";
import {
  dispatchQueuedOutboundDeliveries,
  sendWelcomeToDanceFlowEmail,
} from "@/lib/notifications/dispatch";

const CANONICAL = "DanceFlow is a software platform owned and operated by GenX TotalTech LLC.";
const STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const read = (...parts: string[]) =>
  readFileSync(join(process.cwd(), ...parts), "utf8").replace(/\r\n/g, "\n");

function occurrences(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
});

describe("canonical legal line", () => {
  it("is the exact approved text", () => {
    expect(EMAIL_LEGAL_LINE).toBe(CANONICAL);
  });

  it("appendEmailLegalText appends once and is idempotent", () => {
    const once = appendEmailLegalText("Hi Alex,\n\nSee you Tuesday.\n");
    expect(once).toBe(`Hi Alex,\n\nSee you Tuesday.\n\n${CANONICAL}`);
    expect(appendEmailLegalText(once)).toBe(once);
    expect(occurrences(appendEmailLegalText(appendEmailLegalText(once)), CANONICAL)).toBe(1);
    expect(appendEmailLegalText("")).toBe(CANONICAL);
    expect(appendEmailLegalText(null)).toBe(CANONICAL);
  });

  it("appears exactly once in every HTML shell (system, studio, organizer-branded)", () => {
    const system = renderDanceFlowSystemEmail({ previewText: "x", heading: "x", bodyText: "Body" });
    const studio = renderStudioBrandedEmail(
      { name: "Harbor Dance", logoUrl: null },
      { previewText: "x", heading: "x", bodyText: "Body" },
    );
    const plain = renderPlainTextAsStudioEmail({ studioName: "Harbor Dance", subject: "x", bodyText: "Body" });
    for (const html of [system, studio, plain]) {
      expect(occurrences(html, CANONICAL)).toBe(1);
      expect(html).not.toContain("DanceFlow is a product of");
    }
  });
});

describe("plain-text coverage", () => {
  function seed(delivery: FakeRow) {
    fake.current = createFakeSupabase({
      outbound_deliveries: [delivery],
      studios: [{ id: STUDIO_ID, name: "Harbor Dance", public_name: null, public_logo_url: null, email: null }],
    });
  }

  it("queued email dispatch adds the line to the text part exactly once", async () => {
    seed({
      id: "d-1",
      studio_id: STUDIO_ID,
      channel: "email",
      template_key: "booking_request_approved_client",
      recipient_email: "client@example.com",
      subject: "Approved",
      body_text: `Hi Alex,\n\nApproved.\n\n${CANONICAL}`,
      body_html: null,
      reply_to_email: null,
      status: "queued",
      payload: null,
      created_at: "2026-10-01T00:00:00.000Z",
    });
    await dispatchQueuedOutboundDeliveries(10);
    const args = sendMock.mock.calls[0][0] as { text: string; html: string };
    // The stored body already ends with the line (e.g. a retried row): the text part is not doubled.
    expect(occurrences(args.text, CANONICAL)).toBe(1);
    expect(args.text.endsWith(CANONICAL)).toBe(true);
  });

  it("automation_* client email (no stored HTML) is sent in the studio shell with the HTML legal footer (D-A)", async () => {
    seed({
      id: "d-2",
      studio_id: STUDIO_ID,
      channel: "email",
      template_key: "automation_lead_follow_up",
      recipient_email: "lead@example.com",
      subject: "Following up",
      body_text: "Hi Sam,\n\nWe wanted to follow up with you.",
      body_html: null,
      reply_to_email: null,
      status: "queued",
      payload: null,
      created_at: "2026-10-01T00:00:00.000Z",
    });
    await dispatchQueuedOutboundDeliveries(10);
    const args = sendMock.mock.calls[0][0] as { text: string; html: string };
    expect(args.html).toContain("<!doctype html>");
    expect(args.html).toContain("Sent by Harbor Dance through DanceFlow.");
    expect(occurrences(args.html, CANONICAL)).toBe(1);
    expect(args.text.endsWith(CANONICAL)).toBe(true);
  });

  it("the welcome email text carries the line", async () => {
    await sendWelcomeToDanceFlowEmail({ to: "owner@example.com", fullName: "Pat", audience: "studio" });
    const args = sendMock.mock.calls[0][0] as { text: string };
    expect(args.text.endsWith(CANONICAL)).toBe(true);
  });

  it.each([
    [["src", "app", "app", "clients", "[id]", "actions.ts"], "text: appendEmailLegalText(text),"],
    [["src", "app", "api", "notifications", "send", "route.ts"], "text: appendEmailLegalText(params.text),"],
    [["src", "app", "app", "support", "actions.ts"], "text: appendEmailLegalText(bodyText),"],
    [["src", "app", "platform", "invites", "actions.ts"], "text: appendEmailLegalText("],
    [["src", "app", "api", "platform", "daily-digest", "route.ts"], "text: appendEmailLegalText(text),"],
  ])("direct send %j appends the line to its text part", (parts, needle) => {
    expect(read(...(parts as string[]))).toContain(needle);
  });

  it("marketing campaign text is left alone (CAN-SPAM out of scope)", () => {
    expect(read("src", "app", "app", "marketing", "campaigns", "actions.ts")).not.toContain(
      "appendEmailLegalText",
    );
  });
});

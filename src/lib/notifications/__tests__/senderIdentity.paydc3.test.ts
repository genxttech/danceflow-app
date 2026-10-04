import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeRow } from "@/lib/sms/__tests__/fakeSupabase";

/** PAY-DC-3 (D2 / D-C / D-D / D-G): client-facing sender identity. */

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

import { dispatchQueuedOutboundDeliveries } from "@/lib/notifications/dispatch";
import { resolveOutboundFromEmail } from "@/lib/notifications/outbound";
import {
  CLIENT_FACING_TEMPLATE_KEYS,
  isClientFacingTemplateKey,
  resolveClientSenderDisplayName,
} from "@/lib/notifications/senderIdentity";

const STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const ENV_KEYS = ["NOTIFICATION_FROM_EMAIL", "OUTBOUND_EMAIL_FROM", "RESEND_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

function emailRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: "delivery-1",
    studio_id: STUDIO_ID,
    channel: "email",
    template_key: "booking_request_approved_client",
    recipient_email: "client@example.com",
    recipient_phone: null,
    subject: "Your request was approved",
    body_text: "Hi Alex,\n\nYour lesson request was approved.",
    body_html: null,
    reply_to_email: "front@harbordance.com",
    status: "queued",
    related_table: null,
    related_id: null,
    created_at: "2026-10-01T00:00:00.000Z",
    payload: null,
    ...overrides,
  };
}

function seed(delivery: FakeRow, studio: FakeRow = {}) {
  fake.current = createFakeSupabase({
    outbound_deliveries: [delivery],
    studios: [
      {
        id: STUDIO_ID,
        name: "Harbor Dance LLC",
        public_name: "Harbor Dance",
        public_logo_url: null,
        email: "front@harbordance.com",
        ...studio,
      },
    ],
  });
}

async function sentArgs() {
  await dispatchQueuedOutboundDeliveries(10);
  expect(sendMock).toHaveBeenCalledTimes(1);
  return sendMock.mock.calls[0][0] as { from: string; replyTo?: string; text: string; html: string };
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("client-facing template allowlist", () => {
  it("is the explicit current-main list (no waitlist, no staff/platform keys)", () => {
    expect([...CLIENT_FACING_TEMPLATE_KEYS].sort()).toEqual(
      [
        "appointment_cancelled",
        "appointment_confirmed",
        "appointment_rescheduled",
        "group_class_series_cancelled",
        "booking_request_approved_client",
        "booking_request_declined_client",
        "booking_request_received_client",
        "client_portal_invite",
        "commerce_digital_purchase_confirmed",
        "document_assignment",
        "document_due_soon_reminder",
        "document_overdue_reminder",
        "document_sign_request",
        "document_signature_reminder",
        "document_signing_completed_signer",
        "event_registration_confirmed",
        "event_registration_reminder_24h",
        "event_registration_ticket_confirmation_resend",
        "student_lesson_reminder_24h",
        "student_lesson_reminder_2h",
      ].sort(),
    );
  });

  it("matches the approved automation_* / aria_execution_* prefixes only when a rule key follows", () => {
    expect(isClientFacingTemplateKey("automation_lead_follow_up")).toBe(true);
    expect(isClientFacingTemplateKey("aria_execution_lapsed_client")).toBe(true);
    expect(isClientFacingTemplateKey("automation_")).toBe(false);
    expect(isClientFacingTemplateKey("aria_execution_")).toBe(false);
  });

  it("excludes staff, platform, digest, dispute, accountant and waitlist keys", () => {
    for (const key of [
      "booking_request_staff_alert",
      "booking_request_approved_instructor",
      "document_signing_completed_studio",
      "document_signing_declined_studio",
      "aria_digest_morning",
      "payment_dispute_opened_studio",
      "accountant_secure_delivery",
      "event_waitlist_confirmation",
      "welcome_to_danceflow",
      "platform_admin_invite",
      "instructor_daily_agenda",
      "owner_daily_digest",
      "",
    ]) {
      expect(isClientFacingTemplateKey(key)).toBe(false);
    }
  });
});

describe("display name resolution", () => {
  it("uses the organizer name for organizer events, else studio public_name, else name", () => {
    expect(
      resolveClientSenderDisplayName({
        organizerName: "Summer Swing Fest",
        studio: { public_name: "Harbor Dance", name: "Harbor Dance LLC" },
      }),
    ).toBe("Summer Swing Fest via DanceFlow");
    expect(resolveClientSenderDisplayName({ studio: { public_name: "Harbor Dance", name: "X" } })).toBe(
      "Harbor Dance via DanceFlow",
    );
    expect(resolveClientSenderDisplayName({ studio: { public_name: "  ", name: "Harbor Dance LLC" } })).toBe(
      "Harbor Dance LLC via DanceFlow",
    );
  });

  it("returns null when no safe name remains, so the sender stays plain DanceFlow", () => {
    expect(resolveClientSenderDisplayName({ studio: { public_name: "", name: "" } })).toBeNull();
    expect(resolveClientSenderDisplayName({ studio: { name: '"<>,;:@()' } })).toBeNull();
    expect(resolveClientSenderDisplayName({ studio: null })).toBeNull();
  });
});

describe("resolveOutboundFromEmail", () => {
  it("returns the configured sender unchanged without a sender name (staff/system email)", () => {
    expect(resolveOutboundFromEmail()).toBe("DanceFlow <notify@idanceflow.com>");
    process.env.OUTBOUND_EMAIL_FROM = "DanceFlow <alerts@idanceflow.com>";
    expect(resolveOutboundFromEmail({ senderName: "" })).toBe("DanceFlow <alerts@idanceflow.com>");
  });

  it("keeps the environment address and replaces only the display name", () => {
    expect(resolveOutboundFromEmail({ senderName: "Harbor Dance via DanceFlow" })).toBe(
      '"Harbor Dance via DanceFlow" <notify@idanceflow.com>',
    );
    process.env.NOTIFICATION_FROM_EMAIL = "DanceFlow <Notify@IDanceFlow.com>";
    expect(resolveOutboundFromEmail({ senderName: "Harbor Dance via DanceFlow" })).toBe(
      '"Harbor Dance via DanceFlow" <notify@idanceflow.com>',
    );
    process.env.NOTIFICATION_FROM_EMAIL = "notify@idanceflow.com";
    expect(resolveOutboundFromEmail({ senderName: "Harbor Dance via DanceFlow" })).toBe(
      '"Harbor Dance via DanceFlow" <notify@idanceflow.com>',
    );
  });

  it("sanitizes header-unsafe names and cannot inject a second address or header", () => {
    const from = resolveOutboundFromEmail({
      senderName: 'Smith, Jones "Dance"\r\nBcc: evil@x.com <evil@x.com> via DanceFlow',
    });
    expect(from).toBe('"Smith Jones Dance Bcc evil x.com evil x.com via DanceFlow" <notify@idanceflow.com>');
    expect(from.match(/</g)).toHaveLength(1);
    expect(from).not.toMatch(/[\r\n,;]/);
  });
});

describe("dispatch From per template", () => {
  it("sends allowlisted studio-context email as the studio, keeping Reply-To", async () => {
    seed(emailRow());
    const args = await sentArgs();
    expect(args.from).toBe('"Harbor Dance via DanceFlow" <notify@idanceflow.com>');
    expect(args.replyTo).toBe("front@harbordance.com");
  });

  it("uses the organizer sender name stored at queue time for event emails", async () => {
    seed(
      emailRow({
        template_key: "event_registration_confirmed",
        payload: { senderDisplayName: "Summer Swing Fest via DanceFlow" },
      }),
    );
    const args = await sentArgs();
    expect(args.from).toBe('"Summer Swing Fest via DanceFlow" <notify@idanceflow.com>');
  });

  it("applies to the automation_* prefix family", async () => {
    seed(emailRow({ template_key: "automation_lead_follow_up" }));
    const args = await sentArgs();
    expect(args.from).toBe('"Harbor Dance via DanceFlow" <notify@idanceflow.com>');
  });

  it("keeps plain DanceFlow for non-allowlisted staff email, even with a stored sender name", async () => {
    seed(
      emailRow({
        template_key: "booking_request_staff_alert",
        payload: { senderDisplayName: "Harbor Dance via DanceFlow" },
      }),
    );
    const args = await sentArgs();
    expect(args.from).toBe("DanceFlow <notify@idanceflow.com>");
    expect(args.replyTo).toBe("front@harbordance.com");
  });

  it("falls back to plain DanceFlow when the studio has no usable name", async () => {
    seed(emailRow(), { name: "", public_name: null });
    const args = await sentArgs();
    expect(args.from).toBe("DanceFlow <notify@idanceflow.com>");
  });
});

describe("source boundaries", () => {
  const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

  it("leaves the marketing sender untouched", () => {
    for (const file of [
      ["src", "app", "app", "marketing", "campaigns", "actions.ts"],
      ["src", "app", "app", "organizer-campaigns", "[id]", "actions.ts"],
    ]) {
      const source = read(...file);
      expect(source).toContain("MARKETING_FROM_EMAIL");
      expect(source).not.toContain("senderIdentity");
      expect(source).not.toContain("resolveOutboundFromEmail");
    }
  });

  it("never reads organizer Stripe columns for sender identity", () => {
    const branding = read("src", "lib", "notifications", "event-email-branding.ts");
    expect(branding).not.toMatch(/stripe_/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/lib/sms/__tests__/fakeSupabase";

/** PAY-DC-3: event email subjects, merchant line placement and caller wiring (D-F / D-G / D3). */

const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeSupabase> | null }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fake.current!.client,
}));

import { buildEventConfirmedEmailTemplate, buildEventEmailSubject } from "@/lib/notifications/templates";
import { resolveEventEmailBranding } from "@/lib/notifications/event-email-branding";

const read = (...parts: string[]) =>
  readFileSync(join(process.cwd(), ...parts), "utf8").replace(/\r\n/g, "\n");

const MADE_TO =
  "Your payment was made to Harbor Dance. DanceFlow provides the software used to manage this transaction.";

function template(overrides: Partial<Parameters<typeof buildEventConfirmedEmailTemplate>[0]> = {}) {
  return buildEventConfirmedEmailTemplate({
    eventName: "Fall Showcase",
    attendeeFirstName: "Alex",
    attendeeLastName: "Lee",
    ticketTypeName: "General",
    quantity: 1,
    totalPrice: 45,
    currency: "USD",
    eventUrl: "https://www.idanceflow.com/events/fall-showcase",
    brandName: "Harbor Dance",
    ...overrides,
  });
}

describe("subjects (D-F)", () => {
  it("confirmation and resend carry the organizer or studio brand", () => {
    expect(template().subject).toBe("Registration confirmed for Fall Showcase — Harbor Dance");
    expect(template({ brandName: "Summer Swing Fest" }).subject).toBe(
      "Registration confirmed for Fall Showcase — Summer Swing Fest",
    );
  });

  it("the reminder subject is 'Reminder: {event} — {brand}'", () => {
    expect(template({ subjectKind: "reminder" }).subject).toBe("Reminder: Fall Showcase — Harbor Dance");
  });

  it("omits the suffix when no brand is known", () => {
    expect(buildEventEmailSubject({ eventName: "Fall Showcase", brandName: "  " })).toBe(
      "Registration confirmed for Fall Showcase",
    );
  });
});

describe("merchant line placement", () => {
  it("appears in text and HTML only when supplied", () => {
    const withLine = template({ merchantLine: MADE_TO });
    expect(withLine.bodyText).toContain(`Total: $45.00\n${MADE_TO}`);
    expect(withLine.bodyHtml).toContain(MADE_TO);

    const without = template();
    expect(without.bodyText).not.toContain("payment was made to");
    expect(without.bodyHtml).not.toContain("payment was made to");
  });

  it("escapes the line in HTML", () => {
    const html = template({ merchantLine: "This transaction was processed for <b>X</b> through DanceFlow." }).bodyHtml;
    expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
  });
});

describe("resolveEventEmailBranding (D-G)", () => {
  it("returns both names and the organizer sender name for organizer events", async () => {
    fake.current = createFakeSupabase({
      events: [{ id: "evt-1", studio_id: "studio-1", organizer_id: "org-1" }],
      studios: [{ id: "studio-1", name: "Harbor Dance LLC", public_name: "Harbor Dance", public_logo_url: null }],
      organizers: [{ id: "org-1", name: "Summer Swing Fest", stripe_connected_account_id: "acct_1Org" }],
    });
    const branding = await resolveEventEmailBranding({ eventId: "evt-1", studioId: "studio-1" });
    expect(branding).toMatchObject({
      name: "Summer Swing Fest",
      kind: "organizer",
      studioName: "Harbor Dance",
      organizerName: "Summer Swing Fest",
      senderDisplayName: "Summer Swing Fest via DanceFlow",
    });
  });

  it("uses the studio for studio events", async () => {
    fake.current = createFakeSupabase({
      events: [{ id: "evt-2", studio_id: "studio-1", organizer_id: null }],
      studios: [{ id: "studio-1", name: "Harbor Dance LLC", public_name: "Harbor Dance", public_logo_url: null }],
    });
    const branding = await resolveEventEmailBranding({ eventId: "evt-2", studioId: "studio-1" });
    expect(branding).toMatchObject({
      name: "Harbor Dance",
      kind: "studio",
      organizerName: null,
      senderDisplayName: "Harbor Dance via DanceFlow",
    });
  });
});

describe("caller wiring (source guards)", () => {
  const webhook = read("src", "app", "api", "payments", "webhook", "route.ts");
  const resend = read("src", "app", "app", "events", "[id]", "registrations", "actions.ts");
  const reminders = read("src", "app", "api", "cron", "event-reminders", "route.ts");

  it("every payment-bearing event email derives its merchant line from persisted facts", () => {
    expect(webhook.match(/resolveEventMerchantLine\(\{/g)).toHaveLength(2);
    expect(webhook).toContain("paymentStatus: registration.payment_status,");
    expect(webhook).toContain("paymentStatus: order.payment_status,");
    expect(resend).toContain("resolveEventMerchantLine({");
    expect(reminders).toContain("paymentStatus: row.payment_status,");
    for (const source of [webhook, resend, reminders]) {
      expect(source).not.toMatch(/merchantLine:\s*["'`]/);
    }
  });

  it("stores the organizer/studio sender name at queue time for the event email only", () => {
    expect(webhook.match(/senderDisplayName: branding\.senderDisplayName,/g)).toHaveLength(2);
    expect(resend).toContain("senderDisplayName: branding.senderDisplayName,");
    expect(reminders).toContain("senderDisplayName: branding.senderDisplayName,");
  });

  it("keeps every dedupe key byte-for-byte", () => {
    expect(webhook).toContain("dedupeKey: `event_registration_confirmed:email:${registration.id}`,");
    expect(webhook).toContain("dedupeKey: `event_registration_confirmed:sms:${registration.id}`,");
    expect(webhook).toContain("dedupeKey: `event_cart_order_confirmed:email:${order.id}`,");
    expect(webhook).toContain("dedupeKey: `event_cart_order_confirmed:sms:${order.id}`,");
    expect(resend).toContain("dedupeKey: `event_registration_resend:email:${registration.id}:${Date.now()}`,");
    expect(reminders).toContain(
      "dedupeKey: `event_registration_reminder_24h:email:${row.id}:${reminderKey}`,",
    );
    expect(reminders).toContain("dedupeKey: `event_registration_reminder_24h:sms:${row.id}:${reminderKey}`,");
  });

  it("the reminder uses the reminder subject and no longer rewrites the event name for email", () => {
    expect(reminders).toContain('subjectKind: "reminder",');
    expect(reminders).toMatch(/buildEventConfirmedEmailTemplate\(\{\s*\n\s*eventName: eventValue\.name,/);
  });

  it("does not stamp existing event rows to manufacture a merchant line", () => {
    const merchant = read("src", "lib", "notifications", "merchantIdentity.ts");
    expect(merchant).not.toMatch(/\.update\(|\.insert\(|\.upsert\(/);
  });
});

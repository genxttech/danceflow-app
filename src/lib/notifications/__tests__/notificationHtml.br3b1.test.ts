import { describe, expect, it } from "vitest";
import {
  renderNotificationHtml,
  resolveNotificationStudioBranding,
  resolveReminderReplyTo,
  type NotificationDeliveryRow,
} from "@/lib/notifications/notification-html";

function delivery(overrides: Partial<NotificationDeliveryRow>): NotificationDeliveryRow {
  return {
    id: "d1",
    studio_id: "s1",
    user_id: null,
    client_id: "c1",
    delivery_type: "student_lesson_reminder_24h",
    channel: "email",
    status: "pending",
    subject: null,
    body: null,
    metadata: {},
    scheduled_for: new Date().toISOString(),
    ...overrides,
  };
}

const PORTAL_URL = "https://www.idanceflow.com/portal/acme-dance";

describe("resolveNotificationStudioBranding", () => {
  it("prefers public_name, resolves the portal URL, and normalizes the reply-to email", () => {
    const branding = resolveNotificationStudioBranding({
      id: "s1",
      name: "Acme Dance LLC",
      public_name: "Acme Dance",
      public_logo_url: "https://cdn.example.com/logo.png",
      slug: "acme-dance",
      email: "  Studio@Example.COM ",
    });
    expect(branding.name).toBe("Acme Dance");
    expect(branding.portalUrl).toBe(PORTAL_URL);
    expect(branding.replyToEmail).toBe("studio@example.com");
  });

  it("falls back safely when there is no row", () => {
    const branding = resolveNotificationStudioBranding(null);
    expect(branding).toEqual({ name: "Your dance studio", logoUrl: null, portalUrl: null, replyToEmail: null });
  });
});

describe("resolveReminderReplyTo", () => {
  it("accepts a valid studio email", () => {
    expect(resolveReminderReplyTo("studio@example.com")).toBe("studio@example.com");
  });

  it("rejects an invalid or missing studio email", () => {
    expect(resolveReminderReplyTo("not-an-email")).toBeNull();
    expect(resolveReminderReplyTo(null)).toBeNull();
    expect(resolveReminderReplyTo(undefined)).toBeNull();
    expect(resolveReminderReplyTo("")).toBeNull();
  });
});

describe("24h reminder", () => {
  it("uses the confirmation URL as the primary CTA when present and valid", () => {
    const html = renderNotificationHtml({
      delivery: delivery({
        metadata: {
          clientName: "Alex",
          startsAt: "2026-10-03T18:00:00.000Z",
          studioTimezone: "America/New_York",
          confirmationUrl: "https://www.idanceflow.com/appointments/confirm/abc123",
        },
      }),
      studioName: "Acme Dance",
      studioLogoUrl: null,
      portalUrl: PORTAL_URL,
    });
    expect(html).toContain('href="https://www.idanceflow.com/appointments/confirm/abc123"');
    expect(html).toContain(">Confirm Appointment<");
  });

  it("keeps the student portal link available as secondary body text (does not discard it)", () => {
    const html = renderNotificationHtml({
      delivery: delivery({
        metadata: {
          confirmationUrl: "https://www.idanceflow.com/appointments/confirm/abc123",
        },
      }),
      studioName: "Acme Dance",
      studioLogoUrl: null,
      portalUrl: PORTAL_URL,
    });
    expect(html).toContain("Student Portal");
    expect(html).toContain(PORTAL_URL);
  });

  it("falls back to the portal CTA when there is no confirmation URL", () => {
    const html = renderNotificationHtml({
      delivery: delivery({ metadata: {} }),
      studioName: "Acme Dance",
      studioLogoUrl: null,
      portalUrl: PORTAL_URL,
    });
    expect(html).toContain(">Open Student Portal<");
    expect(html).toContain(`href="${PORTAL_URL}"`);
  });

  it("rejects an unsafe confirmation URL and falls back to the portal", () => {
    const html = renderNotificationHtml({
      delivery: delivery({ metadata: { confirmationUrl: "javascript:alert(1)" } }),
      studioName: "Acme Dance",
      studioLogoUrl: null,
      portalUrl: PORTAL_URL,
    });
    expect(html).not.toContain("javascript:");
    expect(html).toContain(">Open Student Portal<");
  });

  it("has no duplicate greeting/intro paragraph", () => {
    const html = renderNotificationHtml({
      delivery: delivery({ metadata: { clientName: "Alex" } }),
      studioName: "Acme Dance",
      studioLogoUrl: null,
      portalUrl: PORTAL_URL,
    });
    expect(html.match(/Hi Alex,/g)?.length).toBe(1);
  });
});

describe("2h reminder (unchanged CTA behavior)", () => {
  it("always uses the portal CTA, never the confirmation URL", () => {
    const html = renderNotificationHtml({
      delivery: delivery({
        delivery_type: "student_lesson_reminder_2h",
        metadata: { confirmationUrl: "https://www.idanceflow.com/appointments/confirm/abc123" },
      }),
      studioName: "Acme Dance",
      studioLogoUrl: null,
      portalUrl: PORTAL_URL,
    });
    expect(html).not.toContain("appointments/confirm");
    expect(html).toContain(">Open Student Portal<");
    expect(html).toContain("Your lesson starts soon");
  });
});

describe("staff destinations", () => {
  it("instructor agenda points to /app/schedule (not the student portal)", () => {
    const html = renderNotificationHtml({
      delivery: delivery({ delivery_type: "instructor_daily_agenda", subject: "Tomorrow's agenda" }),
      studioName: "Acme Dance",
      studioLogoUrl: null,
      portalUrl: PORTAL_URL,
    });
    expect(html).toContain('href="https://www.idanceflow.com/app/schedule"');
    expect(html).toContain(">Open Schedule<");
    expect(html).not.toContain(PORTAL_URL);
  });

  it("owner digest points to /app (not the student portal)", () => {
    const html = renderNotificationHtml({
      delivery: delivery({ delivery_type: "owner_daily_digest", subject: "Studio activity" }),
      studioName: "Acme Dance",
      studioLogoUrl: null,
      portalUrl: PORTAL_URL,
    });
    expect(html).toContain('href="https://www.idanceflow.com/app"');
    expect(html).toContain(">Open DanceFlow<");
    expect(html).not.toContain(PORTAL_URL);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildInstructorAssignmentEmail,
  buildPortalBookingClientEmail,
  buildPortalBookingStaffEmail,
  buildPublicBookingClientEmail,
  buildPublicBookingStaffEmail,
  buildScheduleDecisionClientEmail,
  PORTAL_STAFF_REVIEW_PATH,
  STAFF_SCHEDULE_PATH,
} from "@/lib/notifications/scheduling-emails";

const STUDIO_WITH_LOGO = {
  name: "Acme Dance LLC",
  public_name: "Acme Dance",
  public_logo_url: "https://cdn.example.com/logo.png",
  slug: "acme-dance",
};
const STUDIO_NO_LOGO = {
  name: "Riverside Ballroom",
  public_name: null,
  public_logo_url: null,
  slug: "riverside-ballroom",
};

describe("public booking emails", () => {
  it("client email: public_name precedence, HTML and text both present, no duplicate lead-in", () => {
    const msg = buildPublicBookingClientEmail({
      studio: STUDIO_WITH_LOGO,
      customerName: "Jordan Lee",
      requestedTime: "Sat, Oct 3 at 2:00 PM",
    });
    expect(msg.subject).toBe("Acme Dance received your lesson request");
    expect(msg.bodyText).toContain("Hi Jordan,");
    expect(msg.bodyText).toContain("Acme Dance received your intro lesson request");
    expect(msg.bodyHtml).toContain("Acme Dance");
    expect(msg.bodyHtml.match(/Hi Jordan,/g)?.length).toBe(1);
    expect(msg.bodyHtml.match(/received your intro lesson request/g)?.length).toBe(1);
  });

  it("client email: falls back to name and shows the initial tile when there is no logo", () => {
    const msg = buildPublicBookingClientEmail({
      studio: STUDIO_NO_LOGO,
      customerName: "Sam",
      requestedTime: "Mon, Oct 5 at 10:00 AM",
    });
    expect(msg.subject).toContain("Riverside Ballroom");
    expect(msg.bodyHtml).not.toContain("<img");
    expect(msg.bodyHtml).toMatch(/>R<\/td>/);
  });

  it("staff email: absolute review URL, no duplicate lead-in, canonical footer", () => {
    const msg = buildPublicBookingStaffEmail({
      studio: STUDIO_WITH_LOGO,
      customerName: "Jordan Lee",
      customerEmail: "jordan@example.com",
      customerPhone: null,
      requestedTime: "Sat, Oct 3 at 2:00 PM",
      danceInterests: null,
      notes: null,
    });
    expect(msg.bodyText).toContain("https://www.idanceflow.com/app/schedule/requests");
    expect(msg.bodyHtml).toContain('href="https://www.idanceflow.com/app/schedule/requests"');
    expect(msg.bodyHtml.match(/submitted a public booking request/g)?.length).toBe(1);
    expect(msg.bodyHtml).toContain("Internal notification for Acme Dance staff.");
    expect(msg.bodyHtml).toContain("Sent by Acme Dance through DanceFlow.");
  });
});

describe("portal booking emails", () => {
  it("client email uses public_name and logo", () => {
    const msg = buildPortalBookingClientEmail({
      studio: STUDIO_WITH_LOGO,
      clientFirstName: "Riley",
      lessonType: "Private Lesson",
      requestedTime: "Tue, Oct 7 at 4:00 PM",
    });
    expect(msg.bodyText).toContain("Hi Riley,");
    expect(msg.bodyText).toContain("Acme Dance received your request for Private Lesson");
    expect(msg.bodyHtml).toContain(`src="${STUDIO_WITH_LOGO.public_logo_url}"`);
  });

  it("client email falls back to name with no logo", () => {
    const msg = buildPortalBookingClientEmail({
      studio: STUDIO_NO_LOGO,
      clientFirstName: null,
      lessonType: "Group Class",
      requestedTime: "Wed, Oct 8 at 6:00 PM",
    });
    expect(msg.bodyText).toContain("Hi there,");
    expect(msg.bodyText).toContain("Riverside Ballroom received your request");
    expect(msg.bodyHtml).not.toContain("<img");
  });

  it("staff alert has an absolute, clickable review URL (not the old relative path)", () => {
    const msg = buildPortalBookingStaffEmail({
      studio: STUDIO_WITH_LOGO,
      clientName: "Riley Chen",
      lessonType: "Private Lesson",
      requestedTime: "Tue, Oct 7 at 4:00 PM",
    });
    expect(PORTAL_STAFF_REVIEW_PATH).toBe("/app/schedule/requests?status=pending");
    const expectedUrl = "https://www.idanceflow.com/app/schedule/requests?status=pending";
    expect(msg.bodyText).toContain(expectedUrl);
    expect(msg.bodyText).not.toMatch(/(?<!https:\/\/www\.idanceflow\.com)\/app\/schedule\/requests\?status=pending/);
    expect(msg.bodyHtml).toContain(`href="${expectedUrl}"`);
    expect(msg.bodyHtml).toContain(">Review request<");
    expect(msg.bodyHtml).toContain("Internal notification for Acme Dance staff.");
  });

  it("staff alert renders as branded HTML (was text-only with body_html: null)", () => {
    const msg = buildPortalBookingStaffEmail({
      studio: STUDIO_WITH_LOGO,
      clientName: "Riley Chen",
      lessonType: "Private Lesson",
      requestedTime: "Tue, Oct 7 at 4:00 PM",
    });
    expect(msg.bodyHtml).toContain("<!doctype html>");
    expect(msg.bodyHtml).toContain("Acme Dance");
  });
});

describe("schedule decision emails (approved/declined)", () => {
  it("approved: correct heading, portal CTA, and detail row", () => {
    const msg = buildScheduleDecisionClientEmail({
      studio: STUDIO_WITH_LOGO,
      status: "approved",
      clientFirstName: "Alex",
      requestedTime: "Sat, Oct 3 at 2:00 PM",
      staffNote: null,
    });
    expect(msg.subject).toBe("Acme Dance approved your lesson request");
    expect(msg.bodyHtml).toContain("Your lesson request is approved");
    expect(msg.bodyHtml).toContain(">Open Client Portal<");
    expect(msg.bodyHtml).toContain("https://www.idanceflow.com/portal/acme-dance");
  });

  it("declined: correct heading and staff-note detail", () => {
    const msg = buildScheduleDecisionClientEmail({
      studio: STUDIO_WITH_LOGO,
      status: "declined",
      clientFirstName: "Alex",
      requestedTime: "Sat, Oct 3 at 2:00 PM",
      staffNote: "Room unavailable at that time",
    });
    expect(msg.subject).toBe("Acme Dance update about your lesson request");
    expect(msg.bodyHtml).toContain("Your lesson request was reviewed");
    expect(msg.bodyText).toContain("Studio note: Room unavailable at that time");
  });

  it("has no duplicate greeting/intro paragraph in the HTML", () => {
    const msg = buildScheduleDecisionClientEmail({
      studio: STUDIO_WITH_LOGO,
      status: "approved",
      clientFirstName: "Alex",
      requestedTime: "Sat, Oct 3 at 2:00 PM",
      staffNote: null,
    });
    expect(msg.bodyHtml.match(/Hi Alex,/g)?.length).toBe(1);
    expect(msg.bodyHtml.match(/approved your requested lesson time|approved your lesson request for/g)?.length).toBe(1);
  });

  it("HTML and text are both present", () => {
    const msg = buildScheduleDecisionClientEmail({
      studio: STUDIO_NO_LOGO,
      status: "approved",
      clientFirstName: "Alex",
      requestedTime: "Sat, Oct 3 at 2:00 PM",
      staffNote: null,
    });
    expect(msg.bodyText.length).toBeGreaterThan(0);
    expect(msg.bodyHtml).toContain("<!doctype html>");
  });
});

describe("instructor assignment email", () => {
  it("points staff to /app/schedule, not the client/student portal", () => {
    const msg = buildInstructorAssignmentEmail({
      studio: STUDIO_WITH_LOGO,
      instructorFirstName: "Sam",
      clientName: "Alex Kim",
      appointmentTitle: "Private Lesson",
      appointmentTime: "Sat, Oct 3 at 2:00 PM",
      staffNote: null,
    });
    expect(STAFF_SCHEDULE_PATH).toBe("/app/schedule");
    const scheduleUrl = "https://www.idanceflow.com/app/schedule";
    expect(msg.bodyHtml).toContain(`href="${scheduleUrl}"`);
    expect(msg.bodyHtml).toContain(">Open Schedule<");
    expect(msg.bodyHtml).not.toContain("/portal/");
  });

  it("uses public_name and logo (defect: previously selected only studios.name)", () => {
    const msg = buildInstructorAssignmentEmail({
      studio: STUDIO_WITH_LOGO,
      instructorFirstName: "Sam",
      clientName: "Alex Kim",
      appointmentTitle: "Private Lesson",
      appointmentTime: "Sat, Oct 3 at 2:00 PM",
      staffNote: null,
    });
    expect(msg.bodyHtml).toContain(`src="${STUDIO_WITH_LOGO.public_logo_url}"`);
    expect(msg.bodyHtml).toContain("Acme Dance");
    expect(msg.bodyHtml).not.toContain("Acme Dance LLC");
  });

  it("no duplicate greeting/intro in the HTML", () => {
    const msg = buildInstructorAssignmentEmail({
      studio: STUDIO_NO_LOGO,
      instructorFirstName: "Sam",
      clientName: "Alex Kim",
      appointmentTitle: "Private Lesson",
      appointmentTime: "Sat, Oct 3 at 2:00 PM",
      staffNote: "Bring extra shoes",
    });
    expect(msg.bodyHtml.match(/Hi Sam,/g)?.length).toBe(1);
    expect(msg.bodyHtml).toContain("Studio note: Bring extra shoes");
  });
});

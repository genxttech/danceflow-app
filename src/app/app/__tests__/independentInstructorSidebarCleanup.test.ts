import { describe, expect, it } from "vitest";
import { buildStudioSections } from "../layout";

// Desktop/mobile parity note: AppSidebarShell.tsx computes normalizedSections
// once (via normalizeSections(sections, ...)) from this same buildStudioSections
// output and passes the identical array to DesktopSidebar, MobileSidebar, and
// MobileTopBar -- there is no separate mobile section-building path to diverge
// from. That was confirmed by direct code reading during the FC-1B4 audit; it
// is not independently re-verified here since this repo has no component-
// render test infrastructure (no .test.tsx / testing-library) to exercise
// AppSidebarShell.tsx itself. Testing buildStudioSections' single output, as
// this file does, is what parity reduces to at the unit level.

function allHrefs(sections: ReturnType<typeof buildStudioSections>) {
  return sections.flatMap((section) => section.items.map((item) => item.href));
}

function allTitles(sections: ReturnType<typeof buildStudioSections>) {
  return sections.map((section) => section.title);
}

const baseIndependentInstructorParams = {
  unreadNotificationsCount: 2,
  leadsBadgeCount: 0,
  role: "independent_instructor",
  isPlatformAdmin: false,
  portalHref: "/portal/test-studio",
  publicProfileHref: "/studios/test-studio",
};

describe("buildStudioSections - independent instructor (FC-1B4)", () => {
  it("does not include the dead Floor Rental section or its links", () => {
    const sections = buildStudioSections({
      ...baseIndependentInstructorParams,
      hasLinkedPortalAccess: true,
    });

    expect(allTitles(sections)).not.toContain("Floor Rental");

    const hrefs = allHrefs(sections);
    expect(hrefs).not.toContain("/app/payments");
    expect(hrefs).not.toContain("/app/expenses");
    expect(hrefs).not.toContain("/app/rooms");
  });

  it("retains Dashboard, My Schedule, and Notifications", () => {
    const sections = buildStudioSections({
      ...baseIndependentInstructorParams,
      hasLinkedPortalAccess: true,
    });
    const hrefs = allHrefs(sections);

    expect(hrefs).toContain("/app");
    expect(hrefs).toContain("/app/schedule");
    expect(hrefs).toContain("/app/notifications");
  });

  it("retains the Public Site and Support sections unchanged", () => {
    const sections = buildStudioSections({
      ...baseIndependentInstructorParams,
      hasLinkedPortalAccess: true,
    });
    const hrefs = allHrefs(sections);

    expect(hrefs).toContain("/discover");
    expect(hrefs).toContain("/discover/studios");
    expect(hrefs).toContain("/discover/events");
    expect(hrefs).toContain("/account");
    expect(hrefs).toContain("/app/help");
    expect(hrefs).toContain("/knowledgebase");
  });

  it("shows My Studio Portal when there is a linked client_account_links row", () => {
    const sections = buildStudioSections({
      ...baseIndependentInstructorParams,
      hasLinkedPortalAccess: true,
    });

    expect(allHrefs(sections)).toContain("/portal/test-studio");
  });

  it("hides My Studio Portal when there is no linked client_account_links row", () => {
    const sections = buildStudioSections({
      ...baseIndependentInstructorParams,
      hasLinkedPortalAccess: false,
    });

    expect(allHrefs(sections)).not.toContain("/portal/test-studio");
  });

  it("hides My Studio Portal when hasLinkedPortalAccess is omitted (defaults to false)", () => {
    const sections = buildStudioSections({ ...baseIndependentInstructorParams });

    expect(allHrefs(sections)).not.toContain("/portal/test-studio");
  });

  it("hides My Studio Portal when portalHref itself is null, regardless of link status", () => {
    const sections = buildStudioSections({
      ...baseIndependentInstructorParams,
      portalHref: null,
      hasLinkedPortalAccess: true,
    });

    expect(sections.flatMap((s) => s.items.map((i) => i.label))).not.toContain(
      "My Studio Portal",
    );
  });
});

describe("buildStudioSections - staff regression (FC-1B4 must not affect other roles)", () => {
  const staffBaseParams = {
    unreadNotificationsCount: 0,
    leadsBadgeCount: 0,
    isPlatformAdmin: false,
    portalHref: null,
    publicProfileHref: null,
  };

  it("studio_owner still sees the full staff sidebar including Payments/Expenses/Rooms", () => {
    const sections = buildStudioSections({
      ...staffBaseParams,
      role: "studio_owner",
    });
    const hrefs = allHrefs(sections);

    expect(hrefs).toContain("/app/payments");
    expect(hrefs).toContain("/app/expenses");
    expect(hrefs).toContain("/app/rooms");
    expect(hrefs).toContain("/app/clients");
  });

  it("front_desk still sees payments/sales items", () => {
    const sections = buildStudioSections({
      ...staffBaseParams,
      role: "front_desk",
    });
    const hrefs = allHrefs(sections);

    expect(hrefs).toContain("/app/payments");
    expect(hrefs).toContain("/app/clients");
  });

  it("instructor still sees My Schedule under Schedule & Space", () => {
    const sections = buildStudioSections({
      ...staffBaseParams,
      role: "instructor",
    });
    const hrefs = allHrefs(sections);

    expect(hrefs).toContain("/app/schedule");
  });
});

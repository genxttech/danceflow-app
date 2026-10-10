import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/app/app/events/actions", () => ({ createEventAction: vi.fn(), updateEventAction: vi.fn() }));
vi.mock("@/app/app/events/EventDescriptionAIAssistant", () => ({ default: () => null }));

import EventForm from "@/app/app/events/EventForm";

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function renderCreate(
  props: { eventType?: string; commerce?: boolean; organizers?: Array<{ id: string; name: string }>; organizerWorkspace?: boolean } = {},
) {
  return renderToStaticMarkup(
    createElement(EventForm, {
      mode: "create",
      organizers: props.organizers ?? [],
      organizerWorkspace: props.organizerWorkspace ?? false,
      eventCommerceEnabled: props.commerce ?? true,
      initialValues: { visibility: "public", publicDirectoryEnabled: false, ...(props.eventType ? { eventType: props.eventType } : {}) },
    }),
  );
}

describe("simplified Create Event form", () => {
  it("renders the five sections in a single narrow column with one primary action", () => {
    const html = renderCreate();
    for (const heading of ["What are you creating?", "Event details", "How will people attend?", "Who can find it?", "Advanced settings"]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain("max-w-3xl");
    expect(html.match(/type="submit"/g)?.length).toBe(1);
    expect(html).toContain(">Create Event<");
    expect(html).toContain('href="/app/events"');
    expect(html).not.toContain("xl:grid-cols");
  });

  it("selecting Competition changes the CTA and describes the next step", () => {
    const html = renderCreate({ eventType: "competition" });
    expect(html).toContain("Create Event &amp; Set Up Competition");
    expect(html).toContain("set up the competition");
    expect(html).toContain('name="eventType" value="competition"');
    // Competition OS owns entries and prices: no generic registration choice.
    expect(html).not.toContain("Registration required");
    expect(html).toContain("Competition entries, divisions and prices are set up in the next step");
    expect(renderCreate({ eventType: "workshop" })).not.toContain("Set Up Competition");
  });

  it("groups types into large single-select rows and shows subtypes only for grouped categories", () => {
    const html = renderCreate({ eventType: "party" });
    expect(html.match(/name="eventTypeCategory"/g)?.length).toBe(6);
    expect(html).toContain('name="eventSubtype"');
    expect(html).toContain("Social Dance");
    expect(html).toContain('name="eventType" value="party"');
    expect(renderCreate({ eventType: "competition" })).not.toContain('name="eventSubtype"');
  });

  it("keeps Advanced settings collapsed by default with a visible expand affordance", () => {
    const html = renderCreate();
    expect(html).toMatch(/<details(?![^>]*\bopen\b)[^>]*>/);
    expect(html).toContain("Show");
    expect(html).toContain("transform:rotate(0deg)");
    // collapsed content stays in the DOM so defaults (registration opens now, slug, dance style) still submit
    expect(html).toContain('name="registrationOpensAt"');
    expect(html).toContain('name="slug"');
  });

  it("submits every field the create action reads, with single-day events ending on the start date", () => {
    const html = renderCreate({ eventType: "workshop" });
    for (const field of [
      "name", "startDate", "endDate", "startTime", "endTime", "timezone", "eventType", "status", "visibility",
      "publicDirectoryEnabled", "shortDescription", "venueName", "city", "state", "waitlistEnabled", "registrationRequired",
      "capacity", "locationCount", "scheduleItemCount", "guestCoachCount",
    ]) {
      expect(html).toContain(`name="${field}"`);
    }
    expect(html).toMatch(/name="endDate" value="\d{4}-\d{2}-\d{2}"/);
    expect(html).toMatch(/<input id="name"[^>]*required/);
    expect(html).toMatch(/<input id="startDate"[^>]*required/);
  });

  it("keeps the group-class final date optional and the default type unchanged", () => {
    const html = renderCreate();
    expect(html).toContain('name="eventType" value="group_class"');
    expect(html).toMatch(/<input id="endDate" type="date"(?![^>]*required)[^>]*name="endDate"/);
    expect(html).toContain("Final class date (optional)");
  });

  it("defaults to the same hidden public draft the form always created", () => {
    const html = renderCreate();
    expect(html).toContain('name="status" value="draft"');
    expect(html).toContain('name="visibility" value="public"');
    expect(html).toContain('name="publicDirectoryEnabled" value="false"');
  });

  it("reveals the attendance basics only when registration is required; a basic listing offers Organizer Suite instead", () => {
    const withReg = renderCreate();
    expect(withReg).toContain("Registration required");
    expect(withReg).toContain("No registration needed");
    expect(withReg).toContain("Attendance limit");
    const basic = renderCreate({ commerce: false });
    expect(basic).not.toContain("Attendance limit");
    expect(basic).not.toContain('name="registrationOpensAt"');
    expect(basic).toContain("Start Organizer Suite");
  });

  it("never submits a stale capacity or waitlist when the attendance section is not in use", () => {
    for (const html of [renderCreate({ eventType: "competition" }), renderCreate({ commerce: false })]) {
      expect(html).toContain('name="capacity" value=""');
      expect(html).toContain('name="waitlistEnabled" value="false"');
    }
    const source = read("src/app/app/events/EventForm.tsx");
    expect(source).toContain('{!capacityVisible ? <input type="hidden" name="capacity" value="" /> : null}');
  });

  it("offers the audience as intent choices with Discovery as a secondary option", () => {
    const html = renderCreate();
    for (const label of ["Public", "Anyone with the link", "Studio only", "Save as draft", "Publish now", "Also show in DanceFlow Discovery"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain('id="visibility"');
    expect(html).not.toContain("Visibility detail");
  });

  it("uses real labels and keeps selectable rows keyboard reachable with a visible focus state", () => {
    const html = renderCreate();
    expect(html).toMatch(/<label[^>]*for="startDate"/);
    expect(html).toMatch(/<label[^>]*for="name"/);
    expect(html).toContain("has-[:focus-visible]:ring-2");
    expect(html).not.toMatch(/name="eventTypeCategory"[^>]*tabindex="-1"/);
  });

  it("shows a locked organizer as plain text and keeps its id in the form", () => {
    const html = renderCreate({ organizers: [{ id: "org-1", name: "Rhythm Co" }], organizerWorkspace: true });
    expect(html).toContain("Hosted by");
    expect(html).toContain('name="organizerId" value="org-1"');
  });

  it("leaves the edit form on its existing layout", () => {
    const html = renderToStaticMarkup(
      createElement(EventForm, { mode: "edit", organizers: [], eventCommerceEnabled: true, initialValues: { id: "e1", name: "Existing" } }),
    );
    expect(html).toContain("Save Event Changes");
    expect(html).toContain("Publishing destination");
    expect(html).not.toContain("What are you creating?");
  });

  it("keeps the Competition redirect, the regular events redirect and the role gate (no backend change)", () => {
    const actions = read("src/app/app/events/actions.ts");
    expect(actions).toContain("redirect(competitionSetupHref(competitionSetupEventId));");
    expect(actions).toContain('redirect("/app/events");');
    expect(read("src/app/app/events/new/page.tsx")).toContain("canManageEvents(context.studioRole, context.isPlatformAdmin)");
  });
});

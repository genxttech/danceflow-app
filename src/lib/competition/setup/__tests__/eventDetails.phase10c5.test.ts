import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/app/events/[id]/competition/simpleActions", () => ({ createCompetitionDraftAction: vi.fn(), uploadCompetitionCoverImageAction: vi.fn() }));

import { presentationSummary } from "@/app/app/events/[id]/competition/new/EventPageStep";
import { canEditCompetitionEventOperations, canManageCompetition } from "@/lib/competition/access";
import { zonedDateTimeToUtcDate } from "@/lib/booking/selfServiceAvailability";
import { STUDIO_CUSTOM_V3_DEFAULTS as P } from "../studioCustomV3";
import {
  EMPTY_PRESENTATION,
  OPERATIONS_PERMISSION_TEXT,
  chooseAdjudication,
  choosePurpose,
  chooseStyle,
  deriveDraft,
  initialAnswers,
  operationalChanges,
  presentationChanges,
  restoreAnswers,
  setPresentation,
  stepErrors,
  updateFormat,
  type EventPresentation,
  type SetupAnswers,
} from "../draft";
import { withDivisions, withOfferings } from "./divisionTestHelpers";

/**
 * 10C.5 inline Competition Event Details: venue, address, dates, times and time zone edited in the wizard, change-only,
 * owner/admin roles only, never the slug, status, visibility or registration flags.
 */

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const STORED: EventPresentation = {
  ...EMPTY_PRESENTATION,
  name: "Spring Classic",
  venueName: "Main Studio",
  addressLine1: "100 Congress Ave",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  startDate: "2027-03-06",
  endDate: "2027-03-07",
  startTime: "18:00",
  endTime: "22:00",
  timezone: "America/Chicago",
};
const BASE = { eventName: "Spring Classic", profileKey: "studio_simple", profileVersion: 3, requestKey: "request-key-0001", event: STORED };

function complete(presentation: EventPresentation = STORED): SetupAnswers {
  let answers = chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(undefined, presentation), P, "competition"), P, "country"), "country", "adjudicated");
  answers = updateFormat(withOfferings(answers, P, "country", ["pro_am"]), "country", "pro_am", { pricing: "free" });
  return withDivisions(answers, P);
}

describe("permissions: owners and admins only", () => {
  it("studio owners/admins and organizer owners/admins may change venue and dates; staff, instructors and platform support may not", () => {
    for (const studioRole of ["studio_owner", "studio_admin"]) expect(canEditCompetitionEventOperations({ studioRole, organizerUserRole: null }), studioRole).toBe(true);
    for (const organizerUserRole of ["organizer_owner", "organizer_admin"]) expect(canEditCompetitionEventOperations({ studioRole: null, organizerUserRole }), organizerUserRole).toBe(true);
    for (const studioRole of ["studio_staff", "instructor", "front_desk", "platform_admin", null]) {
      expect(canEditCompetitionEventOperations({ studioRole, organizerUserRole: "organizer_staff" }), String(studioRole)).toBe(false);
    }
    // Existing competition access is unchanged (no role gains or loses competition management).
    expect(canManageCompetition({ isPlatformAdmin: false, studioRole: null, organizerUserRole: "organizer_staff" })).toBe(true);
    expect(canManageCompetition({ isPlatformAdmin: true, studioRole: null, organizerUserRole: null })).toBe(true);
  });

  it("a venue or date change without the permission is refused by the derivation (forged answers included)", () => {
    const answers = setPresentation(complete(), { venueName: "Grand Ballroom", startDate: "2027-04-10", endDate: "2027-04-11" });
    for (const canEditOperations of [false, undefined]) {
      const draft = deriveDraft(answers, P, { ...BASE, canEditOperations });
      expect(draft.payload).toBeNull();
      expect(draft.errors.event).toEqual([OPERATIONS_PERMISSION_TEXT]);
    }
    const allowed = deriveDraft(answers, P, { ...BASE, canEditOperations: true });
    expect(allowed.errors).toEqual({});
    expect(allowed.payload?.event).toEqual({ venue_name: "Grand Ballroom", start_date: "2027-04-10", end_date: "2027-04-11" });
  });

  it("presentation-only changes need no elevated permission", () => {
    const draft = deriveDraft(setPresentation(complete(), { summary: "New summary" }), P, { ...BASE, canEditOperations: false });
    expect(draft.errors).toEqual({});
    expect(draft.payload?.event).toEqual({ summary: "New summary" });
  });

  it("the server action, page and workspace pass the elevated permission and never call the legacy event rewrite", () => {
    const action = read("src/app/app/events/[id]/competition/simpleActions.ts");
    expect(action).toContain("const { supabase, event, canEditOperations } = await requireCompetitionManager(eventId);");
    expect(action).toContain("    canEditOperations,\n");
    expect(action).not.toMatch(/updateEventAction|buildInsertUpdatePayload|replaceEventLocationSchedule|\.from\("events"\)\s*\.update/);
    expect(read("src/lib/competition/workspaceServer.ts")).toContain("const canEditOperations = canManage && canEditCompetitionEventOperations(");
    expect(read("src/app/app/events/[id]/competition/new/page.tsx")).toContain("canEditOperations={canEditOperations}");
  });
});

describe("only changed fields are written; nothing else about the event moves", () => {
  it("unchanged answers write nothing, including venue, dates and time zone", () => {
    expect(deriveDraft(complete(), P, { ...BASE, canEditOperations: true }).payload?.event).toEqual({});
  });

  it("text is trimmed, emptied optional fields are cleared, a start date and a time zone are never cleared", () => {
    expect(presentationChanges({ ...STORED, venueName: "  Main   Studio " }, STORED)).toEqual({});
    expect(presentationChanges({ ...STORED, addressLine1: "", endDate: "", endTime: "" }, STORED)).toEqual({ address_line_1: null, end_date: null, end_time: null });
    expect(presentationChanges({ ...STORED, startDate: "", timezone: "" }, STORED)).toEqual({});
    expect(presentationChanges({ ...STORED, timezone: "America/New_York", startTime: "17:30" }, STORED)).toEqual({ timezone: "America/New_York", start_time: "17:30" });
    expect(operationalChanges({ summary: "x", city: "Dallas", timezone: "America/Denver" })).toEqual(["city", "timezone"]);
  });

  it("never offers the slug, publication status, visibility or registration flags", () => {
    const keys = Object.keys(presentationChanges({ ...STORED, name: "x" }, STORED));
    expect(keys).toEqual(["name"]);
    const source = read("src/lib/supabase/migrations/20261113090000_phase10c5_competition_draft.sql");
    const allowed = source.match(/where k not in \(([^)]*)\)\) then\n\s+raise exception 'The event page details are not valid\./)?.[1] ?? "";
    for (const forbidden of ["slug", "status", "visibility", "registration_required", "event_type", "account_required"]) expect(allowed).not.toContain(`'${forbidden}'`);
  });

  it("the wizard keeps pending venue and date edits across refresh and Back", () => {
    const answers = setPresentation(complete(), { venueName: "Grand Ballroom", startTime: "17:00", timezone: "America/Denver" });
    expect(restoreAnswers(JSON.parse(JSON.stringify(answers)), P)?.presentation).toEqual(answers.presentation);
    const missing = JSON.parse(JSON.stringify(answers));
    delete missing.presentation.timezone;
    expect(restoreAnswers(missing, P)).toBeNull();
  });
});

describe("validation and event-local time", () => {
  const errors = (change: Partial<EventPresentation>) => stepErrors(setPresentation(complete(), change), P, "event");

  it("dates must be real, ordered and present", () => {
    expect(errors({ startDate: "" })).toEqual(["Enter a valid start date."]);
    expect(errors({ startDate: "2027-02-30" })).toEqual(["Enter a valid start date."]);
    expect(errors({ endDate: "2027-03-05" })).toEqual(["The end date cannot be before the start date."]);
    expect(errors({ endDate: "" })).toEqual([]);
  });

  it("times must be valid and, on a one-day event, end after they start", () => {
    expect(errors({ startTime: "25:00" })).toEqual(["Enter a valid start time."]);
    expect(errors({ endDate: "2027-03-06", endTime: "17:00" })).toEqual(["On a one-day event the end time must be after the start time."]);
    expect(errors({ endTime: "17:00" })).toEqual([]);
  });

  it("time zone and state come from the shared DanceFlow lists", () => {
    expect(errors({ timezone: "Europe/Paris" })).toEqual(["Choose the event's time zone."]);
    expect(errors({ timezone: "America/Phoenix" })).toEqual([]);
    expect(errors({ state: "ZZ" })).toEqual(["Choose a state from the list."]);
  });

  it("registration dates are read in the event's (new) time zone, not the server's", () => {
    const action = read("src/app/app/events/[id]/competition/simpleActions.ts");
    expect(action).toContain("const zone = getEventTimeZone({ timezone: draft.payload.event.timezone ?? event.timezone });");
    expect(action).toContain('zonedDateTimeToUtcDate(opens, "00:00", zone)');
    const chicago = zonedDateTimeToUtcDate("2027-02-01", "00:00", "America/Chicago").toISOString();
    const losAngeles = zonedDateTimeToUtcDate("2027-02-01", "00:00", "America/Los_Angeles").toISOString();
    expect([chicago, losAngeles]).toEqual(["2027-02-01T06:00:00.000Z", "2027-02-01T08:00:00.000Z"]);
  });

  it("the preview shows pending venue, dates and times as written (event-local, never shifted)", () => {
    expect(presentationSummary({ ...STORED, venueName: "Grand Ballroom", city: "Dallas", startDate: "2027-04-10", endDate: "2027-04-11", startTime: "09:30", endTime: "" })).toEqual({
      dates: "Apr 10, 2027 – Apr 11, 2027",
      times: "9:30 AM",
      venue: "Grand Ballroom · Dallas, TX",
    });
  });
});

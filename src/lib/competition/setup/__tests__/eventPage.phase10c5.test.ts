import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => "/", redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/app/app/events/[id]/competition/simpleActions", () => ({ createCompetitionDraftAction: vi.fn(), uploadCompetitionCoverImageAction: vi.fn() }));

import { EventPagePreview, EventPageStep } from "@/app/app/events/[id]/competition/new/EventPageStep";
import { eventImagePublicPrefix } from "@/lib/events/media";
import { STUDIO_CUSTOM_V3_DEFAULTS as P } from "../studioCustomV3";
import {
  addCustomDance,
  addHighlight,
  chooseAdjudication,
  choosePurpose,
  chooseStyle,
  deriveDraft,
  initialAnswers,
  presentationChanges,
  removeHighlight,
  restoreAnswers,
  selectAllCategoryDances,
  setHighlight,
  setPresentation,
  stepErrors,
  toggleFormatStyle,
  updateFormat,
  visibleSteps,
  EMPTY_PRESENTATION,
  type EventPresentation,
  type SetupAnswers,
} from "../draft";
import { TEST_EVENT, withDivisions, withOfferings } from "./divisionTestHelpers";

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const STORED: EventPresentation = {
  ...EMPTY_PRESENTATION,
  name: "Spring Classic",
  venueName: "Main Studio",
  city: "Austin",
  state: "TX",
  startDate: "2027-03-06",
  endDate: "2027-03-07",
  startTime: "18:00",
  timezone: "America/Chicago",
  summary: "A friendly studio competition.",
  description: "Two days of dancing.\nBring your best smile.",
  coverImageUrl: "https://dev.supabase.co/storage/v1/object/public/event-media/studio-1/spring/cover.jpg",
  highlights: ["Live band"],
  registrationInfo: "",
};
const CONTEXT = { eventName: "Spring Classic", profileKey: "studio_simple", profileVersion: 3, requestKey: "request-key-0001", event: STORED, canEditOperations: true };
const SUMMARY = { dates: "Mar 6, 2027", times: "6:00 PM", venue: "Main Studio · Austin, TX" };
const NO_LOCKS = { activeRegistrations: false, additionalLocations: false, datedRecords: false };

function complete(presentation: EventPresentation = STORED): SetupAnswers {
  let answers = chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(undefined, presentation), P, "competition"), P, "country"), "country", "adjudicated");
  answers = withOfferings(answers, P, "country", ["pro_am"]);
  answers = updateFormat(answers, "country", "pro_am", { pricing: "free" });
  return withDivisions(answers, P);
}

describe("Event details & presentation: model", () => {
  it("is a visible step before Review and starts from the event's current values", () => {
    const answers = complete();
    expect(visibleSteps(answers, P).slice(-2)).toEqual(["event", "review"]);
    expect(answers.presentation).toEqual(STORED);
    expect(answers.presentation.highlights).not.toBe(STORED.highlights);
  });

  it("writes nothing when nothing changed, and only the changed fields otherwise", () => {
    expect(deriveDraft(complete(), P, CONTEXT).payload?.event).toEqual({});
    let answers = setPresentation(complete(), { summary: "  A friendly studio competition.  " });
    expect(deriveDraft(answers, P, CONTEXT).payload?.event).toEqual({});
    answers = setPresentation(answers, { registrationInfo: "Entries close two weeks before the event." });
    answers = setHighlight(addHighlight(answers), 1, "  Pro/Am   scholarship ");
    expect(deriveDraft(answers, P, CONTEXT).payload?.event).toEqual({
      highlights: ["Live band", "Pro/Am scholarship"],
      registration_info: "Entries close two weeks before the event.",
    });
    expect(presentationChanges({ ...STORED, description: "" }, STORED)).toEqual({ description: null });
    expect(presentationChanges({ ...STORED, coverImageUrl: "" }, STORED)).toEqual({ cover_image_url: null });
  });

  it("never writes blindly: without the stored event values the payload changes nothing", () => {
    const answers = setPresentation(complete(), { name: "Renamed" });
    const withoutBaseline = { ...CONTEXT, event: undefined };
    expect(deriveDraft(answers, P, withoutBaseline).payload?.event).toEqual({});
  });

  it("programs are named after the edited title", () => {
    const answers = setPresentation(complete(), { name: "Spring Classic 2027" });
    expect(deriveDraft(answers, P, CONTEXT).payload?.programs[0].name).toBe("Spring Classic 2027");
    expect(deriveDraft(answers, P, CONTEXT).payload?.event).toEqual({ name: "Spring Classic 2027" });
  });

  it("validates the title, lengths, highlights and the cover image", () => {
    expect(stepErrors(setPresentation(complete(), { name: "   " }), P, "event")).toEqual(["Enter the event title."]);
    expect(stepErrors(setPresentation(complete(), { summary: "x".repeat(301) }), P, "event")).toEqual(["Use 300 characters or fewer for the short summary."]);
    expect(stepErrors(setPresentation(complete(), { registrationInfo: "x".repeat(2001) }), P, "event")).toEqual(["Use 2000 characters or fewer for the registration information."]);
    expect(stepErrors(addHighlight(complete()), P, "event")).toEqual(["Fill in or remove empty highlights."]);
    expect(stepErrors(setPresentation(complete(), { coverImageUrl: "javascript:alert(1)" }), P, "event")).toEqual(["Upload the cover image again."]);
    expect(deriveDraft(setPresentation(complete(), { name: "" }), P, CONTEXT).payload).toBeNull();
    let answers = complete();
    for (let index = 0; index < 8; index += 1) answers = addHighlight(answers);
    expect(answers.presentation.highlights).toHaveLength(6);
    expect(removeHighlight(answers, 0).presentation.highlights).toHaveLength(5);
  });

  it("restores valid presentation answers and rejects malformed ones", () => {
    const answers = setPresentation(complete(), { registrationInfo: "Bring your shoes." });
    expect(restoreAnswers(JSON.parse(JSON.stringify(answers)), P)).toEqual(answers);
    expect(restoreAnswers({ ...answers, presentation: { ...answers.presentation, highlights: "Live band" } }, P)).toBeNull();
    expect(restoreAnswers({ ...answers, presentation: undefined }, P)).toBeNull();
    expect(restoreAnswers({ ...answers, version: 4 }, P)).toBeNull();
  });

  it("cover images are accepted only under the studio's event-media prefix", () => {
    expect(eventImagePublicPrefix("https://dev.supabase.co/", "studio-1")).toBe("https://dev.supabase.co/storage/v1/object/public/event-media/studio-1/");
  });
});

describe("Event details & presentation: UI", () => {
  it("the preview uses the public event page components and shows highlights and registration information", () => {
    const html = renderToStaticMarkup(createElement(EventPagePreview, { presentation: { ...STORED, registrationInfo: "Bring your shoes." }, summary: SUMMARY }));
    expect(html).toContain("Spring Classic");
    expect(html).toContain("A friendly studio competition.");
    expect(html).toContain(STORED.coverImageUrl);
    expect(html).toContain("Highlights");
    expect(html).toContain("Live band");
    expect(html).toContain("Important registration information");
    expect(html).toContain("Main Studio · Austin, TX");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("owners/admins edit venue, dates, times and time zone inline, with no detour to Edit event", () => {
    const html = renderToStaticMarkup(createElement(EventPageStep, { eventId: "e1", answers: complete(), baseline: STORED, canEditOperations: true, locks: NO_LOCKS, update: () => undefined }));
    expect(html).toContain("Venue, dates and time zone");
    expect(html).toContain('value="Main Studio"');
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2027-03-06"');
    expect(html).toContain('type="time"');
    expect(html).toContain('<option value="America/Chicago" selected="">');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('href="/app/events/e1/edit"');
    expect(html).not.toMatch(/name="(slug|status|visibility)/);
    expect(html).toContain("No changes to the event page yet.");
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
  });

  it("without an owner/admin role the fields are read-only and the reason is shown", () => {
    const html = renderToStaticMarkup(createElement(EventPageStep, { eventId: "e1", answers: complete(), baseline: STORED, canEditOperations: false, locks: NO_LOCKS, update: () => undefined }));
    expect(html).toContain("Only studio owners and admins, and organizer owners and admins, can change the venue, dates, times or time zone.");
    expect(html.match(/disabled=""/g)?.length).toBe(11);
    expect(html).not.toContain('href="/app/events/e1/edit"');
  });

  it("registrations, extra locations or dated records lock the affected fields with an explanation", () => {
    const registrations = renderToStaticMarkup(createElement(EventPageStep, { eventId: "e1", answers: complete(), baseline: STORED, canEditOperations: true, locks: { ...NO_LOCKS, activeRegistrations: true }, update: () => undefined }));
    expect(registrations).toContain("already has registrations");
    expect(registrations.match(/disabled=""/g)?.length).toBe(11);
    expect(registrations).toContain('href="/app/events/e1/edit"');
    const dated = renderToStaticMarkup(createElement(EventPageStep, { eventId: "e1", answers: complete(), baseline: STORED, canEditOperations: true, locks: { ...NO_LOCKS, datedRecords: true }, update: () => undefined }));
    expect(dated).toContain("dated schedule items or sessions");
    expect(dated.match(/disabled=""/g)?.length).toBe(5);
    const locations = renderToStaticMarkup(createElement(EventPageStep, { eventId: "e1", answers: complete(), baseline: STORED, canEditOperations: true, locks: { ...NO_LOCKS, additionalLocations: true }, update: () => undefined }));
    expect(locations).toContain("additional locations");
    expect(locations.match(/disabled=""/g)?.length).toBe(6);
  });

  it("the public event page renders through the same shared components and reads the new fields", () => {
    const page = readFileSync(join(ROOT, "src/app/events/[slug]/page.tsx"), "utf8");
    for (const component of ["<EventCoverImage", "<EventHeroText", "<EventDescriptionBody", "<EventHighlights", "<EventRegistrationInfo"]) expect(page).toContain(component);
    expect(page).toContain("public_highlights,");
    expect(page).toContain("public_registration_info,");
  });
});

describe("dance limits are per category", () => {
  it("more than 20 dances in one category is refused, even though the program may use up to 60", () => {
    let answers = chooseAdjudication(chooseStyle(choosePurpose(initialAnswers(undefined, TEST_EVENT), P, "competition"), P, "ballroom"), "ballroom", "adjudicated");
    answers = toggleFormatStyle(withOfferings(answers, P, "ballroom", ["ndca_pro_am"], ["american_smooth"]), P, "ballroom", "ndca_pro_am", "american_additional");
    for (const name of ["Carolina Shag", "Balboa", "Collegiate Shag", "Two Step", "Kizomba"]) answers = addCustomDance(answers, P, "ballroom", name);
    answers = selectAllCategoryDances(answers, P, "ballroom", "ndca_pro_am", "american_additional");
    expect(stepErrors(answers, P, "dances")).toEqual(["Choose 20 dances or fewer for Ballroom Pro/Am Single-Dance — Additional American Style Dances."]);
  });
});

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
import { STUDIO_CUSTOM_V2_DEFAULTS as P } from "../studioCustomV2";
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
  type EventPresentation,
  type SetupAnswers,
} from "../draft";
import { TEST_EVENT, withDivisions, withOfferings } from "./divisionTestHelpers";

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const STORED: EventPresentation = {
  name: "Spring Classic",
  summary: "A friendly studio competition.",
  description: "Two days of dancing.\nBring your best smile.",
  coverImageUrl: "https://dev.supabase.co/storage/v1/object/public/event-media/studio-1/spring/cover.jpg",
  highlights: ["Live band"],
  registrationInfo: "",
};
const CONTEXT = { eventName: "Spring Classic", profileKey: "studio_simple", profileVersion: 2, requestKey: "request-key-0001", event: STORED };
const SUMMARY = { dates: "Mar 6, 2027", times: "6:00 PM", venue: "Main Studio · Austin, TX" };

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

  it("venue and dates are shown read-only with a link to Edit event; nothing is changed by default", () => {
    const html = renderToStaticMarkup(createElement(EventPageStep, { eventId: "e1", answers: complete(), baseline: STORED, summary: SUMMARY, update: () => undefined }));
    expect(html).toContain('href="/app/events/e1/edit"');
    expect(html).toContain("These belong to the event and are not changed here.");
    expect(html).not.toMatch(/name="(venue|start_date|end_date|slug)/);
    expect(html).toContain("No changes to the event page yet.");
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
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
    expect(stepErrors(answers, P, "dances")).toEqual(["Choose 20 dances or fewer for Ballroom Pro/Am — Additional American Style Dances."]);
  });
});

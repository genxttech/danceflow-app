import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/app/schedule/groupClassSeriesActions", () => ({
  previewGroupClassSeriesAction: vi.fn(),
  createGroupClassSeriesAction: vi.fn(),
}));

const { default: GroupClassSeriesForm, SeriesActionBar, SeriesPreviewList } = await import(
  "@/app/app/schedule/new/GroupClassSeriesForm"
);
const { default: GroupClassModeToggle } = await import("@/app/app/schedule/new/GroupClassModeToggle");

const INSTRUCTORS = [{ id: "11111111-1111-4111-8111-111111111111", first_name: "Maria", last_name: "Lopez" }];
const ROOMS = [{ id: "22222222-2222-4222-8222-222222222222", name: "Studio A" }];

function render(extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(GroupClassSeriesForm, {
      instructors: INSTRUCTORS,
      rooms: ROOMS,
      studioTimeZone: "America/New_York",
      onChooseMode: () => undefined,
      ...extra,
    }),
  );
}

function visibleText(markup: string) {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("GroupClassModeToggle (one-time vs series)", () => {
  it("marks the selected option with aria-pressed and a visible check, not by color alone", () => {
    const series = renderToStaticMarkup(createElement(GroupClassModeToggle, { mode: "series", onChange: () => undefined }));
    expect(series).toContain("✓ Class series");
    expect(series).not.toContain("✓ One-time class");
    expect((series.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect((series.match(/aria-pressed="false"/g) ?? []).length).toBe(1);

    const oneTime = renderToStaticMarkup(createElement(GroupClassModeToggle, { mode: "one_time", onChange: () => undefined }));
    expect(oneTime).toContain("✓ One-time class");
    expect(oneTime).not.toContain("✓ Class series");
    expect(oneTime).toContain('role="group"');
    expect(oneTime).toContain('aria-label="Class type"');
  });

  it("the create form defaults to the one-time class flow and only switches for broad staff on Group Class", () => {
    const source = read("src/app/app/schedule/new/AppointmentCreateForm.tsx");
    expect(source).toContain('useState<GroupClassMode>("one_time")');
    expect(source).toContain('isGroupClass && classMode === "series" && !instructorSearchMode');
    expect(source).toContain("<GroupClassSeriesForm");
    expect(source).toContain("<GroupClassModeToggle");
    // the existing standalone path is untouched: same action, no series RPCs referenced here
    expect(source).toContain("createAppointmentAction");
    expect(source).not.toMatch(/create_group_class_series|preview_group_class_series/);
  });
});

describe("GroupClassSeriesForm structure", () => {
  const markup = render({ initialDate: "2027-01-12" });
  const text = visibleText(markup);

  it("every label points at a real control", () => {
    const ids = new Set([...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    const htmlFor = [...markup.matchAll(/ for="([^"]+)"/g)].map((m) => m[1]);
    expect(htmlFor.length).toBeGreaterThan(15);
    for (const target of htmlFor) expect(ids.has(target)).toBe(true);
    for (const id of [
      "series-title", "series-description", "series-starts-on", "series-start-time", "series-duration", "series-interval",
      "series-count", "series-ends-on", "series-instructor", "series-room", "series-location", "series-capacity",
    ]) {
      expect(htmlFor).toContain(id);
    }
  });

  it("uses owner-facing language and the required core fields", () => {
    for (const label of [
      "Class name", "Description", "First class date", "Days of the week", "Start time", "Length (minutes)",
      "Repeat every (weeks)", "Series ends", "After a number of classes", "On a date", "Instructor", "Room", "Location",
      "Maximum students",
    ]) {
      expect(text).toContain(label);
    }
    expect(text).not.toMatch(/rrule|recurrence|occurrence_index|interval_weeks|client_request|rpc|postgres|\bUTC\b|timestamp/i);
  });

  it("does not expose payment or pricing settings of any kind", () => {
    expect(text).not.toMatch(/direct.?payment|price|pricing|\$|stripe|checkout|refund|credit card|depleted/i);
    expect(markup).not.toMatch(/name="[^"]*(payment|price|amount)[^"]*"/i);
  });

  it("starts with the first date's weekday selected and the single next action disabled until complete", () => {
    expect(markup).toMatch(/<input id="series-day-2"[^>]*checked=""/);
    expect(markup).not.toMatch(/<input id="series-day-3"[^>]*checked=""/);
    const primary = markup.match(/<button type="submit"[^>]*>[^<]*<\/button>/)?.[0] ?? "";
    expect(primary).toContain("Preview schedule");
    expect(primary).toContain('disabled=""');
    expect(text).not.toContain("Create series (");
  });

  it("selected weekdays carry a visible check mark as well as color", () => {
    expect(markup).toContain("✓ Tue");
    expect(markup).not.toContain("✓ Wed");
  });

  it("progressive disclosure: enrollment options are collapsed with a chevron that rotates when open", () => {
    const details = markup.match(/<details[^>]*>/)?.[0] ?? "";
    expect(details).not.toMatch(/\bopen\b/);
    expect(markup).toContain("Enrollment options");
    const summary = markup.match(/<summary[\s\S]*?<\/summary>/)?.[0] ?? "";
    expect(summary).toContain("<svg");
    expect(summary).toContain("group-open:rotate-180");
    expect(text).not.toContain("Which credits can be used?");
  });

  it("is built for narrow screens: stacked by default, columns only from breakpoints, full-width controls", () => {
    expect(markup).toContain("md:grid-cols-2");
    expect(markup).toContain("sm:flex-row");
    expect(markup).toContain("w-full");
    expect(markup).not.toMatch(/overflow-x-scroll|min-w-\[[0-9]{3,}px\]/);
  });

  it("groups fields into labelled sections and keeps visible focus styles", () => {
    expect(markup).toContain('aria-labelledby="series-class-heading"');
    expect(markup).toContain('aria-labelledby="series-schedule-heading"');
    expect(markup).toContain('aria-labelledby="series-where-heading"');
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain("<fieldset");
    expect(markup).toContain("<legend");
  });

  it("never renders the request id or a studio id into the page", () => {
    expect(markup).not.toMatch(/name="(clientRequestId|studioId|studio_id)"/);
    // The only ids on the page are the studio's own instructor and room option values.
    const withoutOptions = markup.replace(/<option[^>]*>/g, "");
    expect(withoutOptions).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(markup).not.toContain('type="hidden"');
  });
});

describe("SeriesPreviewList", () => {
  const rows = [
    { index: 1, dateLabel: "Tue, Jan 12", timeLabel: "6:30 PM – 7:30 PM", dstGuidance: null, conflict: null, skipped: false },
    {
      index: 2, dateLabel: "Thu, Jan 14", timeLabel: "6:30 PM – 7:30 PM", dstGuidance: null, skipped: false,
      conflict: { category: "instructor_overlap" as const, message: "The instructor is already booked at this time." },
    },
    {
      index: 3, dateLabel: "Tue, Jan 19", timeLabel: "6:30 PM – 7:30 PM", dstGuidance: null, skipped: true,
      conflict: { category: "room_booked" as const, message: "The room is already booked at this time." },
    },
    {
      index: 4, dateLabel: "Sun, Mar 14", timeLabel: "3:30 AM – 4:30 AM", conflict: null, skipped: false,
      dstGuidance: "Clocks move forward on this date, so your usual start time doesn't exist. The class starts at the adjusted time shown.",
    },
  ];
  const markup = renderToStaticMarkup(
    createElement(SeriesPreviewList, {
      rows, summary: { instructor: "Instructor: Maria Lopez", place: "Studio A" },
      onSkip: () => undefined, onRestore: () => undefined, disabled: false,
    }),
  );
  const text = visibleText(markup);

  it("summarizes the class count, attention needed, instructor and place", () => {
    expect(text).toContain("3 classes in this series");
    expect(text).toContain("1 date needs attention");
    expect(text).toContain("Instructor: Maria Lopez · Studio A");
  });

  it("conflicts name the date, state the category in words, and offer to skip", () => {
    expect(text).toContain("Thu, Jan 14");
    expect(text).toContain("Instructor conflict: The instructor is already booked at this time. Skip this date to continue.");
    expect(markup).toContain('aria-label="Skip Thu, Jan 14"');
  });

  it("skipped dates say so in words, are struck through, and can be restored", () => {
    expect(text).toContain("Skipped — this class won't be created.");
    expect(markup).toContain("line-through");
    expect(markup).toContain('aria-label="Restore Tue, Jan 19"');
    expect(text).not.toContain("Room conflict:");
  });

  it("shows daylight-saving guidance in plain words", () => {
    expect(text).toContain("Daylight saving: Clocks move forward on this date");
  });

  it("shows no raw UTC, ids or database terms", () => {
    expect(markup).not.toMatch(/\d{4}-\d{2}-\d{2}T|UTC|occurrence_index|series_id|rpc/i);
    expect(markup).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it("disables skip and restore while an action is pending", () => {
    const disabled = renderToStaticMarkup(
      createElement(SeriesPreviewList, {
        rows, summary: { instructor: "", place: "" }, onSkip: () => undefined, onRestore: () => undefined, disabled: true,
      }),
    );
    expect(disabled.match(/<button[^>]*disabled=""/g)?.length).toBe(rows.length);
  });
});

describe("SeriesActionBar (one obvious next action)", () => {
  function bar(props: Record<string, unknown>) {
    return renderToStaticMarkup(
      createElement(SeriesActionBar, {
        previewCurrent: false, canPreview: true, canCreate: false, previewPending: false, createPending: false,
        createCount: 6, unresolvedConflicts: 0, hint: "hint", onPreview: () => undefined, onCreate: () => undefined,
        ...props,
      }),
    );
  }
  const primary = (markup: string) => markup.match(/<button type="submit"[^>]*>[^<]*<\/button>/)?.[0] ?? "";

  it("offers Preview first", () => {
    const m = bar({});
    expect(primary(m)).toContain("Preview schedule");
    expect(primary(m)).not.toContain('disabled=""');
    expect(m).not.toContain("Check again");
  });

  it("a pending preview disables the action and shows progress (no duplicate preview)", () => {
    const m = bar({ canPreview: false, previewPending: true });
    expect(primary(m)).toContain("Checking schedule…");
    expect(primary(m)).toContain('disabled=""');
    expect(visibleText(m)).toContain("Checking every date for conflicts…");
  });

  it("offers Create series with the class count once the preview is clean", () => {
    const m = bar({ previewCurrent: true, canCreate: true });
    expect(primary(m)).toContain("Create series (6 classes)");
    expect(primary(m)).not.toContain('disabled=""');
    expect(m).toContain("Check again");
  });

  it("a pending create is disabled and cannot be double-clicked", () => {
    const m = bar({ previewCurrent: true, canCreate: false, canPreview: false, createPending: true });
    expect(primary(m)).toContain("Creating series…");
    expect(primary(m)).toContain('disabled=""');
    expect(visibleText(m)).toContain("Creating your series — please wait.");
    expect(m.match(/<button[^>]*disabled=""/g)?.length).toBe(2);
  });

  it("unresolved conflicts keep Create unavailable and explain what to do", () => {
    const m = bar({ previewCurrent: true, canCreate: false, unresolvedConflicts: 2 });
    expect(primary(m)).toContain('disabled=""');
    expect(visibleText(m)).toContain("Skip or resolve 2 conflicting dates to create the series.");
  });

  it("announces status changes politely for assistive technology", () => {
    expect(bar({})).toContain('role="status"');
    expect(bar({})).toContain('aria-live="polite"');
  });

  it("uses singular wording for one class", () => {
    expect(primary(bar({ previewCurrent: true, canCreate: true, createCount: 1 }))).toContain("Create series (1 class)");
  });
});

describe("boundaries (source guards)", () => {
  const source = read("src/app/app/schedule/new/GroupClassSeriesForm.tsx");

  it("creates only through the reviewed B2 actions and never touches data layers directly", () => {
    expect(source).toContain("createGroupClassSeriesAction");
    expect(source).toContain("previewGroupClassSeriesAction");
    expect(source).not.toMatch(/supabase|createAdminClient|createClient|\.rpc\(|service.?role/i);
    expect(source).not.toMatch(/create_group_class_series|preview_group_class_series|create_group_class_appointment/);
  });

  it("has no legacy Events, Stripe, Twilio or payment code", () => {
    expect(source).not.toMatch(/\/app\/events|event_sessions|stripe|twilio|checkout|direct_payment|directPayment|campaignAllowance/i);
  });

  it("generates the request id once through the form model, never in render or in handlers", () => {
    expect(source.match(/randomUUID/g)?.length).toBe(1);
    expect(source).toContain("initSeriesFormState(() => crypto.randomUUID()");
  });

  it("the series form does not import or modify the one-time class action", () => {
    expect(source).not.toContain("createAppointmentAction");
    expect(source).not.toContain('from "../actions"');
  });

  it("the surrounding files only add the toggle and a read-only display time zone", () => {
    const toggle = read("src/app/app/schedule/new/GroupClassModeToggle.tsx");
    expect(toggle).not.toMatch(/events/i);
    const page = read("src/app/app/schedule/new/page.tsx");
    expect(page).toContain("studioTimeZone");
    expect(page).not.toMatch(/group_class_series|preview_group_class_series/);
  });
});

describe("B4 polish: unconfirmed create and long series", () => {
  function bar(props: Record<string, unknown>) {
    return renderToStaticMarkup(
      createElement(SeriesActionBar, {
        previewCurrent: true, canPreview: true, canCreate: true, previewPending: false, createPending: false,
        createCount: 6, unresolvedConflicts: 0, hint: "hint", onPreview: () => undefined, onCreate: () => undefined,
        ...props,
      }),
    );
  }

  it("after an unconfirmed create, 'Check again' is withheld and the owner is steered to retry Create", () => {
    const m = bar({ unconfirmedCreate: true });
    expect(m).not.toContain("Check again");
    expect(m).toContain("Create series (6 classes)");
    expect(m).not.toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(visibleText(m)).toContain("Select Create series to try again. It's safe — nothing will be duplicated.");
  });

  it("a normal clean preview still offers 'Check again'", () => {
    expect(bar({})).toContain("Check again");
  });

  it("a pending create still shows the pending status (not the retry hint)", () => {
    const m = bar({ unconfirmedCreate: true, createPending: true, canCreate: false, canPreview: false });
    expect(visibleText(m)).toContain("Creating your series — please wait.");
    expect(visibleText(m)).not.toContain("Select Create series to try again");
  });

  it("the form derives the flag only from an unconfirmed result for the CURRENT definition and keeps the approved copy", () => {
    const source = read("src/app/app/schedule/new/GroupClassSeriesForm.tsx");
    expect(source).toContain('createResult.key === key && createResult.state.status === "error" && createResult.state.code === "action_failed"');
    const runner = read("src/lib/schedule/groupClassSeriesActionRunner.ts");
    expect(runner).toContain("We couldn't confirm whether the series was created. Check your schedule, then try again — retrying is safe.");
  });

  it("the action area stays reachable over a long preview list (sticky only while a preview is showing)", () => {
    const source = read("src/app/app/schedule/new/GroupClassSeriesForm.tsx");
    expect(source).toContain('view.previewCurrent ? "sticky bottom-2 z-10 shadow-lg md:bottom-4" : ""');
  });
});

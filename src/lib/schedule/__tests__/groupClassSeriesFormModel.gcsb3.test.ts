import { describe, expect, it } from "vitest";

import { parseSeriesInput } from "@/lib/schedule/groupClassSeries";
import {
  buildSeriesFormData,
  checkDefinition,
  definitionKey,
  deriveSeriesView,
  dstGuidance,
  effectiveSkipped,
  formatOccurrenceDate,
  formatTimeRange,
  initSeriesFormState,
  seriesFormReducer,
  type CreateStateInput,
  type PreviewOccurrenceInput,
  type PreviewStateInput,
  type SeriesFormAction,
  type SeriesFormState,
} from "@/lib/schedule/groupClassSeriesFormModel";

const REQUEST_ID = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";
const INSTRUCTOR = "11111111-1111-4111-8111-111111111111";
const ROOM = "22222222-2222-4222-8222-222222222222";

function filled(): SeriesFormState {
  return initSeriesFormState(() => REQUEST_ID, {
    title: "Beginner Salsa",
    startsOn: "2027-01-12",
    weekdays: [2, 4],
    startTime: "18:30",
    durationMinutes: "60",
    occurrenceCount: "6",
    instructorId: INSTRUCTOR,
    roomId: ROOM,
  });
}

function occurrences(overrides: Record<number, Partial<PreviewOccurrenceInput>> = {}): PreviewOccurrenceInput[] {
  return [1, 2, 3, 4, 5, 6].map((index) => {
    const start = new Date(Date.UTC(2027, 0, 12 + (index - 1) * 2, 23, 30));
    return {
      index,
      localDate: start.toISOString().slice(0, 10),
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
      dstNote: null,
      conflict: null,
      ...(overrides[index] ?? {}),
    };
  });
}

function view(
  state: SeriesFormState,
  extra: {
    preview?: PreviewStateInput;
    previewedKey?: string | null;
    create?: CreateStateInput;
    createKey?: string | null;
    pending?: { preview: boolean; create: boolean };
  } = {},
) {
  return deriveSeriesView({
    state,
    previewState: extra.preview ?? { status: "idle" },
    previewedKey: extra.previewedKey ?? null,
    createState: extra.create ?? { status: "idle" },
    createKey: extra.createKey ?? null,
    pending: extra.pending ?? { preview: false, create: false },
    timeZone: "America/New_York",
  });
}

describe("request id lifecycle", () => {
  it("is generated exactly once per form instance and never changed by any action", () => {
    let generated = 0;
    const generator = () => {
      generated += 1;
      return `${REQUEST_ID.slice(0, -2)}${String(generated).padStart(2, "0")}`;
    };
    let state = initSeriesFormState(generator, { title: "x" });
    const firstId = state.requestId;
    expect(generated).toBe(1);

    const actions: SeriesFormAction[] = [
      { type: "edit", patch: { title: "Changed" } },
      { type: "edit", patch: { startsOn: "2027-02-01", occurrenceCount: "8" } },
      { type: "toggleWeekday", day: 3 },
      { type: "toggleWeekday", day: 3 },
      { type: "skip", index: 2 },
      { type: "restore", index: 2 },
      { type: "edit", patch: { title: "" } }, // e.g. after a validation error the user keeps editing
      { type: "edit", patch: { endMode: "date", endsOn: "2027-03-01" } },
    ];
    for (const action of actions) {
      state = seriesFormReducer(state, action);
      expect(state.requestId).toBe(firstId);
    }
    expect(generated).toBe(1);
  });

  it("a genuinely fresh form instance gets a fresh id", () => {
    let n = 0;
    const generator = () => `id-${(n += 1)}`;
    expect(initSeriesFormState(generator).requestId).not.toBe(initSeriesFormState(generator).requestId);
  });

  it("the same id is what every preview and create submission carries (failed or successful)", () => {
    const state = filled();
    const first = buildSeriesFormData(state);
    const afterEdit = buildSeriesFormData(seriesFormReducer(state, { type: "edit", patch: { title: "Renamed" } }));
    const afterSkip = buildSeriesFormData(seriesFormReducer(state, { type: "skip", index: 3 }));
    expect([first, afterEdit, afterSkip].map((fd) => fd.get("clientRequestId"))).toEqual([REQUEST_ID, REQUEST_ID, REQUEST_ID]);
  });
});

describe("submission payload", () => {
  it("round-trips through the server's own parser", () => {
    let state = filled();
    state = seriesFormReducer(state, { type: "edit", patch: { rosterCapacity: "12", locationName: " Main Floor ", allowSelfEnrollment: true, packageEnabled: true } });
    state = seriesFormReducer(state, { type: "skip", index: 2 });
    const parsed = parseSeriesInput(buildSeriesFormData(state));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      title: "Beginner Salsa",
      weekdays: [2, 4],
      startsOn: "2027-01-12",
      localStartTime: "18:30:00",
      durationMinutes: 60,
      occurrenceCount: 6,
      endsOn: null,
      skipIndices: [2],
      rosterCapacity: 12,
      locationName: "Main Floor",
      selfEnrollmentAllowed: true,
      publiclyDiscoverable: false,
      acceptedFundingTypes: ["package"],
      clientRequestId: REQUEST_ID,
    });
  });

  it("never sends a studio id or any payment field", () => {
    const fd = buildSeriesFormData(
      seriesFormReducer(filled(), { type: "edit", patch: { allowSelfEnrollment: true, showToLinkedStudents: true, packageEnabled: true, membershipEnabled: true } }),
    );
    const keys = [...fd.keys()].join(",").toLowerCase();
    expect(keys).not.toMatch(/studio|payment|price|amount|stripe/);
    expect(fd.getAll("acceptedFundingTypes")).toEqual(["package", "membership"]);
  });

  it("sends only the active end rule", () => {
    const count = buildSeriesFormData(filled());
    expect(count.get("endMode")).toBe("count");
    expect(count.has("endsOn")).toBe(false);
    const byDate = buildSeriesFormData(seriesFormReducer(filled(), { type: "edit", patch: { endMode: "date", endsOn: "2027-03-02" } }));
    expect(byDate.get("endMode")).toBe("date");
    expect(byDate.has("occurrenceCount")).toBe(false);
  });
});

describe("definition checks", () => {
  it("an empty form is not ready; a filled one is", () => {
    expect(checkDefinition(initSeriesFormState(() => REQUEST_ID)).ok).toBe(false);
    expect(checkDefinition(filled()).ok).toBe(true);
  });

  it("surfaces the server's limits (cap, interval, duration) without a second rule set", () => {
    expect(checkDefinition(seriesFormReducer(filled(), { type: "edit", patch: { occurrenceCount: "105" } }))).toMatchObject({ ok: false, code: "occurrence_cap_exceeded" });
    expect(checkDefinition(seriesFormReducer(filled(), { type: "edit", patch: { intervalWeeks: "53" } }))).toMatchObject({ ok: false, code: "invalid_recurrence" });
    expect(checkDefinition(seriesFormReducer(filled(), { type: "edit", patch: { durationMinutes: "721" } }))).toMatchObject({ ok: false, code: "invalid_recurrence" });
    expect(checkDefinition(seriesFormReducer(filled(), { type: "edit", patch: { durationMinutes: "4" } }))).toMatchObject({ ok: false, code: "invalid_recurrence" });
  });

  it("enrollment options need a funding choice (matches the server)", () => {
    const state = seriesFormReducer(filled(), { type: "edit", patch: { showToLinkedStudents: true } });
    expect(checkDefinition(state)).toMatchObject({ ok: false, code: "policy_invalid" });
    expect(checkDefinition(seriesFormReducer(state, { type: "edit", patch: { membershipEnabled: true } })).ok).toBe(true);
  });
});

describe("definitionKey (what invalidates a preview)", () => {
  const base = definitionKey(filled().values);

  it.each([
    ["title", { title: "Other" }],
    ["description", { description: "More" }],
    ["start date", { startsOn: "2027-01-19" }],
    ["weekdays", { weekdays: [2, 5] }],
    ["start time", { startTime: "19:00" }],
    ["duration", { durationMinutes: "75" }],
    ["interval", { intervalWeeks: "2" }],
    ["end mode", { endMode: "date" as const, endsOn: "2027-03-01" }],
    ["count", { occurrenceCount: "8" }],
    ["instructor", { instructorId: "" }],
    ["room", { roomId: "" }],
    ["location", { locationName: "Hall" }],
    ["capacity", { rosterCapacity: "10" }],
    ["self enrollment", { allowSelfEnrollment: true }],
    ["visibility", { showToLinkedStudents: true }],
    ["packages", { packageEnabled: true }],
    ["memberships", { membershipEnabled: true }],
  ])("changes when the %s changes", (_label, patch) => {
    expect(definitionKey({ ...filled().values, ...patch })).not.toBe(base);
  });

  it("ignores insignificant whitespace, weekday order and the unused end field", () => {
    const values = filled().values;
    expect(definitionKey({ ...values, title: "  Beginner Salsa  ", weekdays: [4, 2] })).toBe(base);
    expect(definitionKey({ ...values, endsOn: "2030-01-01" })).toBe(base); // count mode ignores endsOn
  });
});

describe("skip and restore", () => {
  it("skips and restores by original occurrence index", () => {
    let state = filled();
    state = seriesFormReducer(state, { type: "skip", index: 4 });
    state = seriesFormReducer(state, { type: "skip", index: 2 });
    state = seriesFormReducer(state, { type: "skip", index: 2 }); // idempotent
    expect(effectiveSkipped(state)).toEqual([2, 4]);
    state = seriesFormReducer(state, { type: "restore", index: 2 });
    expect(effectiveSkipped(state)).toEqual([4]);
  });

  it("skip choices only apply to the definition they were made for", () => {
    let state = seriesFormReducer(filled(), { type: "skip", index: 3 });
    expect(effectiveSkipped(state)).toEqual([3]);
    state = seriesFormReducer(state, { type: "edit", patch: { startTime: "19:00" } });
    expect(effectiveSkipped(state)).toEqual([]);
    expect(buildSeriesFormData(state).getAll("skipIndices")).toEqual([]);
    // returning to the original definition does not silently resurrect stale skips under a new key
    state = seriesFormReducer(state, { type: "skip", index: 1 });
    expect(effectiveSkipped(state)).toEqual([1]);
  });
});

describe("deriveSeriesView", () => {
  it("shows the generated occurrences from a current preview with studio-local labels (no raw UTC)", () => {
    const state = filled();
    const v = view(state, { preview: { status: "preview", occurrences: occurrences() }, previewedKey: definitionKey(state.values) });
    expect(v.previewCurrent).toBe(true);
    expect(v.rows).toHaveLength(6);
    expect(v.rows[0]).toMatchObject({ index: 1, dateLabel: "Tue, Jan 12", timeLabel: "6:30 PM – 7:30 PM", conflict: null, skipped: false, dstGuidance: null });
    for (const row of v.rows) {
      expect(`${row.dateLabel} ${row.timeLabel}`).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:|Z\b|UTC|GMT/);
    }
    expect(v.canCreate).toBe(true);
    expect(v.createCount).toBe(6);
  });

  it("changing any definition field invalidates the preview and disables create until previewed again", () => {
    const state = filled();
    const previewState: PreviewStateInput = { status: "preview", occurrences: occurrences() };
    const key = definitionKey(state.values);
    expect(view(state, { preview: previewState, previewedKey: key }).canCreate).toBe(true);

    const changed = seriesFormReducer(state, { type: "edit", patch: { roomId: "" } });
    const stale = view(changed, { preview: previewState, previewedKey: key });
    expect(stale.previewCurrent).toBe(false);
    expect(stale.rows).toEqual([]);
    expect(stale.canCreate).toBe(false);
    expect(stale.canPreview).toBe(true);

    // a fresh preview for the new definition makes it current again
    expect(view(changed, { preview: previewState, previewedKey: definitionKey(changed.values) }).canCreate).toBe(true);
  });

  it("an unresolved conflict disables creation; skipping the conflicting date permits it; restoring blocks again", () => {
    let state = filled();
    const key = definitionKey(state.values);
    const previewState: PreviewStateInput = {
      status: "preview",
      occurrences: occurrences({ 3: { conflict: { category: "instructor_overlap", message: "The instructor is already booked at this time." } } }),
    };
    let v = view(state, { preview: previewState, previewedKey: key });
    expect(v.unresolvedConflicts).toBe(1);
    expect(v.canCreate).toBe(false);

    state = seriesFormReducer(state, { type: "skip", index: 3 });
    v = view(state, { preview: previewState, previewedKey: key });
    expect(v.rows[2]).toMatchObject({ index: 3, skipped: true });
    expect(v.unresolvedConflicts).toBe(0);
    expect(v.createCount).toBe(5);
    expect(v.canCreate).toBe(true);

    state = seriesFormReducer(state, { type: "restore", index: 3 });
    v = view(state, { preview: previewState, previewedKey: key });
    expect(v.canCreate).toBe(false);
  });

  it("only skipped conflicts are exempt: another unskipped conflict still blocks", () => {
    let state = filled();
    const key = definitionKey(state.values);
    const previewState: PreviewStateInput = {
      status: "preview",
      occurrences: occurrences({
        2: { conflict: { category: "room_booked", message: "The room is already booked at this time." } },
        5: { conflict: { category: "room_unavailable", message: "The room is unavailable at this time." } },
      }),
    };
    state = seriesFormReducer(state, { type: "skip", index: 2 });
    const v = view(state, { preview: previewState, previewedKey: key });
    expect(v.unresolvedConflicts).toBe(1);
    expect(v.canCreate).toBe(false);
  });

  it("conflicts reported by a create attempt for this definition override a clean preview", () => {
    const state = filled();
    const key = definitionKey(state.values);
    const v = view(state, {
      preview: { status: "preview", occurrences: occurrences() },
      previewedKey: key,
      create: { status: "conflict", conflicts: [{ index: 4, conflict: { category: "instructor_overlap", message: "The instructor is already booked at this time." } }] },
      createKey: key,
    });
    expect(v.rows[3].conflict?.category).toBe("instructor_overlap");
    expect(v.canCreate).toBe(false);
    // a conflict result for an OLDER definition is ignored
    const older = view(state, {
      preview: { status: "preview", occurrences: occurrences() },
      previewedKey: key,
      create: { status: "conflict", conflicts: [{ index: 4, conflict: { category: "other", message: "x" } }] },
      createKey: "some-older-key",
    });
    expect(older.rows[3].conflict).toBeNull();
  });

  it("cannot create when every occurrence is skipped", () => {
    let state = filled();
    const key = definitionKey(state.values);
    for (let i = 1; i <= 6; i += 1) state = seriesFormReducer(state, { type: "skip", index: i });
    const v = view(state, { preview: { status: "preview", occurrences: occurrences() }, previewedKey: key });
    expect(v.createCount).toBe(0);
    expect(v.canCreate).toBe(false);
  });

  it("pending states prevent duplicate previews and double-submitted creates", () => {
    const state = filled();
    const base = { preview: { status: "preview", occurrences: occurrences() } as PreviewStateInput, previewedKey: definitionKey(state.values) };
    expect(view(state, { ...base, pending: { preview: true, create: false } })).toMatchObject({ canPreview: false, canCreate: false });
    expect(view(state, { ...base, pending: { preview: false, create: true } })).toMatchObject({ canPreview: false, canCreate: false });
    expect(view(state, { ...base, pending: { preview: false, create: false } })).toMatchObject({ canPreview: true, canCreate: true });
  });

  it("cannot preview an incomplete definition", () => {
    expect(view(initSeriesFormState(() => REQUEST_ID)).canPreview).toBe(false);
  });

  it("carries DST guidance for adjusted occurrences", () => {
    const state = filled();
    const v = view(state, {
      preview: { status: "preview", occurrences: occurrences({ 2: { dstNote: "nonexistent_adjusted" }, 3: { dstNote: "ambiguous_later_selected" } }) },
      previewedKey: definitionKey(state.values),
    });
    expect(v.rows[1].dstGuidance).toMatch(/move forward/);
    expect(v.rows[2].dstGuidance).toMatch(/happens twice/);
    expect(v.rows[0].dstGuidance).toBeNull();
  });
});

describe("presentation helpers", () => {
  it("formats dates as calendar dates and times in the studio zone", () => {
    expect(formatOccurrenceDate("2027-03-14")).toBe("Sun, Mar 14");
    expect(formatTimeRange("2027-03-14T22:00:00.000Z", "2027-03-14T23:00:00.000Z", "America/New_York")).toBe("6:00 PM – 7:00 PM");
    expect(formatTimeRange("2027-01-12T23:30:00.000Z", "2027-01-13T00:30:00.000Z", "America/Los_Angeles")).toBe("3:30 PM – 4:30 PM");
  });

  it("DST guidance is plain language with no database or standards terminology", () => {
    for (const note of ["nonexistent_adjusted", "ambiguous_later_selected"] as const) {
      const text = dstGuidance(note) ?? "";
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/postgres|rfc|utc|offset|timestamp|sql|database/i);
    }
    expect(dstGuidance(null)).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SERIES_CONFLICT_COPY,
  SERIES_ERROR_MESSAGES,
  buildCreateRpcArgs,
  buildPreviewRpcArgs,
  findInternalOverlaps,
  mapSeriesRpcError,
  mapWithConcurrency,
  parseSeriesInput,
  toDstNote,
  toSafeConflict,
} from "@/lib/schedule/groupClassSeries";

const REQUEST_ID = "0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9";
const INSTRUCTOR = "11111111-1111-4111-8111-111111111111";
const ROOM = "22222222-2222-4222-8222-222222222222";

function valid(overrides: Record<string, string | string[] | undefined> = {}) {
  return {
    title: "  Salsa Level 1  ",
    instructorId: INSTRUCTOR,
    roomId: ROOM,
    locationName: " Main Floor ",
    rosterCapacity: "12",
    weekdays: ["4", "2", "2"],
    intervalWeeks: "1",
    startsOn: "2027-01-12",
    startTime: "18:30",
    endTime: "19:30",
    endMode: "count",
    occurrenceCount: "6",
    skipIndices: ["4", "2", "2"],
    clientRequestId: REQUEST_ID,
    ...overrides,
  };
}

function formData(values: Record<string, string | string[] | undefined>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) fd.append(key, item);
  }
  return fd;
}

describe("parseSeriesInput", () => {
  it("parses and normalizes a valid definition (record and FormData alike)", () => {
    for (const input of [valid(), formData(valid())]) {
      const parsed = parseSeriesInput(input);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value).toEqual({
        title: "Salsa Level 1",
        description: null,
        instructorId: INSTRUCTOR,
        roomId: ROOM,
        locationName: "Main Floor",
        rosterCapacity: 12,
        weekdays: [2, 4],
        intervalWeeks: 1,
        startsOn: "2027-01-12",
        endsOn: null,
        occurrenceCount: 6,
        localStartTime: "18:30:00",
        durationMinutes: 60,
        skipIndices: [2, 4],
        clientRequestId: REQUEST_ID.toLowerCase(),
        publiclyDiscoverable: false,
        selfEnrollmentAllowed: false,
        acceptedFundingTypes: null,
      });
    }
  });

  it("accepts an explicit duration, an end date and comma-separated lists", () => {
    const parsed = parseSeriesInput(
      valid({ endTime: undefined, durationMinutes: "90", endMode: "date", endsOn: "2027-03-02", occurrenceCount: undefined, weekdays: "1,3", skipIndices: "1,2" }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({ durationMinutes: 90, endsOn: "2027-03-02", occurrenceCount: null, weekdays: [1, 3], skipIndices: [1, 2] });
    }
  });

  it("never carries a studio id: the studio comes only from the server context", () => {
    const parsed = parseSeriesInput(valid({ studioId: "99999999-9999-4999-8999-999999999999" } as never));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(JSON.stringify(parsed.value)).not.toContain("9999");
  });

  it.each([
    ["missing title", { title: "" }, "invalid_input"],
    ["overlong title", { title: "x".repeat(201) }, "invalid_input"],
    ["malformed request id", { clientRequestId: "not-a-uuid" }, "invalid_input"],
    ["missing request id", { clientRequestId: undefined }, "invalid_input"],
    ["malformed instructor id", { instructorId: "x'; drop table" }, "invalid_input"],
    ["malformed room id", { roomId: "123" }, "invalid_input"],
    ["capacity 0", { rosterCapacity: "0" }, "invalid_input"],
    ["capacity text", { rosterCapacity: "many" }, "invalid_input"],
    ["no weekdays", { weekdays: undefined }, "invalid_recurrence"],
    ["weekday 0", { weekdays: ["0"] }, "invalid_recurrence"],
    ["weekday 8", { weekdays: ["8"] }, "invalid_recurrence"],
    ["weekday text", { weekdays: ["tue"] }, "invalid_recurrence"],
    ["interval 0", { intervalWeeks: "0" }, "invalid_recurrence"],
    ["interval 53", { intervalWeeks: "53" }, "invalid_recurrence"],
    ["impossible date", { startsOn: "2027-02-30" }, "invalid_recurrence"],
    ["bad date format", { startsOn: "01/12/2027" }, "invalid_recurrence"],
    ["no end mode", { endMode: undefined }, "invalid_recurrence"],
    ["count 0", { occurrenceCount: "0" }, "invalid_recurrence"],
    ["count over cap", { occurrenceCount: "105" }, "occurrence_cap_exceeded"],
    ["end before start", { endMode: "date", endsOn: "2027-01-01", occurrenceCount: undefined }, "invalid_recurrence"],
    ["bad start time", { startTime: "25:00" }, "invalid_recurrence"],
    ["end time before start", { endTime: "18:00" }, "invalid_recurrence"],
    ["no end time or duration", { endTime: undefined }, "invalid_recurrence"],
    ["duration 4", { endTime: undefined, durationMinutes: "4" }, "invalid_recurrence"],
    ["duration 721", { endTime: undefined, durationMinutes: "721" }, "invalid_recurrence"],
    ["skip index 0", { skipIndices: ["0"] }, "invalid_skip"],
    ["skip index text", { skipIndices: ["x"] }, "invalid_skip"],
    ["unknown funding type", { acceptedFundingTypes: ["cash"] }, "policy_invalid"],
    ["direct payment is not accepted from this layer", { acceptedFundingTypes: ["direct_payment"] }, "policy_invalid"],
    ["discoverable without funding", { publiclyDiscoverable: "on" }, "policy_invalid"],
    ["self-enrollment without funding", { selfEnrollmentAllowed: "true" }, "policy_invalid"],
  ])("rejects %s", (_label, overrides, code) => {
    expect(parseSeriesInput(valid(overrides as Record<string, string | string[] | undefined>))).toEqual({ ok: false, code });
  });

  it("accepts the enrollment-policy defaults the UI may expose", () => {
    const parsed = parseSeriesInput(valid({ publiclyDiscoverable: "on", selfEnrollmentAllowed: "on", acceptedFundingTypes: ["package", "membership"] }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({ publiclyDiscoverable: true, selfEnrollmentAllowed: true, acceptedFundingTypes: ["package", "membership"] });
    }
  });
});

describe("RPC argument builders", () => {
  it("use the supplied studio, send the same definition to both RPCs, and never send a payment amount", () => {
    const parsed = parseSeriesInput(valid({ acceptedFundingTypes: ["membership"] }));
    if (!parsed.ok) throw new Error("parse failed");
    const preview = buildPreviewRpcArgs("studio-ctx", parsed.value);
    const create = buildCreateRpcArgs("studio-ctx", parsed.value);

    expect(preview.p_studio_id).toBe("studio-ctx");
    expect(create.p_studio_id).toBe("studio-ctx");
    for (const key of Object.keys(preview) as (keyof typeof preview)[]) {
      expect(create[key]).toEqual(preview[key]);
    }
    expect(create).toMatchObject({
      p_client_request_id: REQUEST_ID.toLowerCase(),
      p_skip_indices: [2, 4],
      p_accepted_funding_types: ["membership"],
      p_direct_payment_amount: null,
    });
  });
});

describe("mapSeriesRpcError", () => {
  it.each([
    ["GCSB1_UNAUTHORIZED: Not authorized", "unauthorized"],
    ["GCSB1_INVALID_RECURRENCE: Choose at least one weekday.", "invalid_recurrence"],
    ["GCSB1_INVALID_TIMEZONE: The studio time zone is not valid.", "invalid_timezone"],
    ["GCSB1_INVALID_DEFINITION: A class title is required.", "invalid_definition"],
    ["GCSB1_INSTRUCTOR_UNASSIGNABLE: x", "instructor_unassignable"],
    ["GCSB1_ROOM_INVALID: x", "room_invalid"],
    ["GCSB1_OCCURRENCE_CAP_EXCEEDED: x", "occurrence_cap_exceeded"],
    ["GCSB1_INVALID_SKIP: x", "invalid_skip"],
    ["GCSB1_NO_OCCURRENCES: x", "no_occurrences"],
    ["GCSB1_POLICY_INVALID: x", "policy_invalid"],
    ["GCSB1_IDEMPOTENCY_CONFLICT: x", "idempotency_conflict"],
  ] as const)("maps %s", (message, code) => {
    expect(mapSeriesRpcError({ message })).toBe(code);
  });

  it("maps anything unrecognized to unknown and never echoes raw database text", () => {
    for (const error of [
      { message: 'duplicate key value violates unique constraint "uq_group_class_series_client_request"' },
      { message: 'permission denied for table appointments' },
      { message: "GCSB1_SOMETHING_NEW: surprise" },
      { message: null },
      null,
      undefined,
    ]) {
      const code = mapSeriesRpcError(error as never);
      expect(code).toBe("unknown");
      expect(SERIES_ERROR_MESSAGES[code]).not.toMatch(/duplicate|permission denied|appointments|uq_|GCSB1/);
    }
  });

  it("every user-facing message is free of internals", () => {
    for (const message of Object.values(SERIES_ERROR_MESSAGES)) {
      expect(message).not.toMatch(/GCSB1|rpc|sql|constraint|violat|uuid/i);
    }
    expect(SERIES_ERROR_MESSAGES.idempotency_conflict).toBe("This series was already created or changed. Refresh before trying again.");
  });
});

describe("conflict mapping", () => {
  it.each([
    ["That instructor is already booked during this time.", "instructor_overlap"],
    ["That instructor has a schedule block during this time.", "instructor_block"],
    ["That room is unavailable during this time.", "room_unavailable"],
    ["That room is already booked during this time.", "room_booked"],
  ] as const)("maps the canonical engine message %s", (message, category) => {
    expect(toSafeConflict(message)).toEqual({ category, message: SERIES_CONFLICT_COPY[category] });
  });

  it("maps unknown or sensitive text to a generic safe conflict without echoing it", () => {
    const safe = toSafeConflict("Jane Doe (jane@example.com) has a private lesson, notes: knee injury");
    expect(safe).toEqual({ category: "other", message: SERIES_CONFLICT_COPY.other });
    expect(JSON.stringify(safe)).not.toMatch(/Jane|jane@|knee/);
    expect(toSafeConflict(undefined).category).toBe("other");
  });

  it("drift guard: the engine still returns exactly the messages this layer maps", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/schedule/conflicts.ts"), "utf8");
    for (const literal of [
      "That instructor is already booked during this time.",
      "That instructor has a schedule block during this time.",
      "That room is unavailable during this time.",
      "That room is already booked during this time.",
    ]) {
      expect(source).toContain(literal);
    }
  });
});

describe("findInternalOverlaps", () => {
  it("is empty for any schedule B1 can generate: one class per date, at most 12 hours, even on a 23-hour DST day", () => {
    const hour = 3_600_000;
    const start = Date.parse("2027-03-13T23:00:00.000Z");
    const rows = [
      { index: 1, startsAt: new Date(start).toISOString(), endsAt: new Date(start + 12 * hour).toISOString() },
      // consecutive-day class on the 23-hour spring-forward day
      { index: 2, startsAt: new Date(start + 23 * hour).toISOString(), endsAt: new Date(start + 35 * hour).toISOString() },
      // consecutive-day class after a 25-hour fall-back day
      { index: 3, startsAt: new Date(start + 48 * hour).toISOString(), endsAt: new Date(start + 60 * hour).toISOString() },
    ];
    expect(findInternalOverlaps(rows)).toEqual([]);
  });

  it("reports overlapping occurrences if it ever happened", () => {
    expect(
      findInternalOverlaps([
        { index: 3, startsAt: "2027-01-02T10:30:00.000Z", endsAt: "2027-01-02T12:00:00.000Z" },
        { index: 1, startsAt: "2027-01-01T10:00:00.000Z", endsAt: "2027-01-01T11:00:00.000Z" },
        { index: 2, startsAt: "2027-01-02T10:00:00.000Z", endsAt: "2027-01-02T11:00:00.000Z" },
      ]),
    ).toEqual([2, 3]);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order and never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5 * (9 - n)));
      active -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("rejects when any item fails (callers fail closed)", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("toDstNote", () => {
  it("passes the two B1 DST flags through and drops anything else", () => {
    expect(toDstNote("nonexistent_adjusted")).toBe("nonexistent_adjusted");
    expect(toDstNote("ambiguous_later_selected")).toBe("ambiguous_later_selected");
    expect(toDstNote(null)).toBeNull();
    expect(toDstNote("something_else")).toBeNull();
  });
});

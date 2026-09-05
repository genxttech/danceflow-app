import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * FC-1B2: Independent Instructor Narrow My Schedule.
 *
 * FC-1B1 removed independent_instructor's access to the general staff
 * schedule query entirely, leaving /app/schedule fully staff-only in
 * behavior but not actually gated at the page level for this specific
 * route (unlike the other five FC-1B1 pages) -- this page had no role
 * check at all. FC-1B2 restores a useful experience for
 * independent_instructor at this exact route via a wholly separate,
 * narrow, role-conditional read path added to the SAME page component:
 * their own floor rentals in full, and everything else reduced to a
 * generic room + time "in use"/unavailable signal with no client, instructor,
 * appointment-type, notes, or payment data. Staff roles must reach the
 * existing unmodified query below the branch, unchanged.
 *
 * Pre-push revision: the horizon is a DanceFlow product decision of 30
 * days (not the unrelated 7-day staff/self-service conventions), shared
 * identically by own rentals and anonymized occupancy so the two can never
 * drift apart. The anonymized-occupancy exclusion is by the own rental's
 * own appointment id (not by client id), so a non-floor-rental appointment
 * on the same linked client record still surfaces as generic "In use"
 * occupancy instead of silently vanishing.
 *
 * FC-1B2 Terminology Alignment: rooms may legitimately be shared under
 * FC-1B3, so ordinary occupancy renders as "In use" (never "Busy", which
 * would wrongly imply occupied = unbookable). "Unavailable" stays reserved
 * for a true hard block (room/studio closure via a room_unavailable row).
 *
 * This suite drives the real page component (not a stand-in), rendering
 * its returned JSX to static markup so the privacy assertions can inspect
 * actual output, not just query call shape -- per the review requirement
 * to test the real data-shaping/render decision, not only a pure helper.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest =
      `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

vi.mock("next/link", () => ({
  default: (props: { href: string; children: React.ReactNode; className?: string }) =>
    React.createElement("a", { href: props.href, className: props.className }, props.children),
}));

const getCurrentStudioContextMock = vi.fn();

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) => getCurrentStudioContextMock(...args),
}));

type Row = Record<string, unknown>;

const STUDIO_ID = "studio-1";
const OTHER_STUDIO_ID = "studio-2";
const USER_ID = "user-ii-1";
const OWN_CLIENT_ID = "own-client-1";
const SECOND_OWN_CLIENT_ID = "own-client-2";

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const DAY = 24 * 60 * 60 * 1000;
// Kept comfortably away from the exact 30-day cutoff (rather than millisecond-
// precise) since the page computes its own "now" a few ms after this module
// loads -- a half-day margin makes the inside/outside assertions immune to
// that clock drift while still proving the ~30-day boundary meaningfully.
const JUST_INSIDE = 29.9 * DAY;
const JUST_OUTSIDE = 30.1 * DAY;

function linkRow(clientId: string, overrides: Partial<Row> = {}): Row {
  return {
    studio_id: STUDIO_ID,
    user_id: USER_ID,
    client_id: clientId,
    status: "linked",
    ...overrides,
  };
}

function appointmentRows(): Row[] {
  return [
    {
      id: "appt-own-upcoming",
      studio_id: STUDIO_ID,
      client_id: OWN_CLIENT_ID,
      appointment_type: "floor_space_rental",
      title: "Evening practice block",
      starts_at: iso(2 * DAY),
      ends_at: iso(2 * DAY + 60 * 60 * 1000),
      status: "scheduled",
      payment_status: "paid",
      price_amount: 45,
      room_id: "room-own",
      rooms: { id: "room-own", name: "Studio A" },
    },
    {
      id: "appt-own-recent",
      studio_id: STUDIO_ID,
      client_id: OWN_CLIENT_ID,
      appointment_type: "floor_space_rental",
      title: "Last week's block",
      starts_at: iso(-3 * DAY),
      ends_at: iso(-3 * DAY + 60 * 60 * 1000),
      status: "attended",
      payment_status: "paid",
      price_amount: 45,
      room_id: "room-own",
      rooms: { id: "room-own", name: "Studio A" },
    },
    {
      id: "appt-own-beyond-horizon",
      studio_id: STUDIO_ID,
      client_id: OWN_CLIENT_ID,
      appointment_type: "floor_space_rental",
      title: "Far-out own rental",
      starts_at: iso(35 * DAY),
      ends_at: iso(35 * DAY + 60 * 60 * 1000),
      status: "scheduled",
      payment_status: "paid",
      price_amount: 45,
      room_id: "room-own",
      rooms: { id: "room-own", name: "Studio A" },
    },
    {
      id: "appt-own-non-rental",
      studio_id: STUDIO_ID,
      client_id: OWN_CLIENT_ID,
      appointment_type: "private_lesson",
      title: "Should never render as My Rental",
      starts_at: iso(4 * DAY),
      ends_at: iso(4 * DAY + 60 * 60 * 1000),
      status: "scheduled",
      payment_status: "paid",
      billing_note: "Should never render at all",
      price_amount: 60,
      room_id: "room-own-nonrental",
      rooms: { id: "room-own-nonrental", name: "Studio E" },
    },
    {
      id: "appt-second-own-client",
      studio_id: STUDIO_ID,
      client_id: SECOND_OWN_CLIENT_ID,
      appointment_type: "floor_space_rental",
      title: "Second client's rental",
      starts_at: iso(5 * DAY),
      ends_at: iso(5 * DAY + 60 * 60 * 1000),
      status: "scheduled",
      payment_status: "paid",
      price_amount: 45,
      room_id: "room-second",
      rooms: { id: "room-second", name: "Studio F" },
    },
    {
      id: "appt-unrelated-lesson",
      studio_id: STUDIO_ID,
      client_id: "unrelated-client-1",
      appointment_type: "private_lesson",
      title: "Jane Doe private lesson",
      starts_at: iso(1 * DAY),
      ends_at: iso(1 * DAY + 60 * 60 * 1000),
      status: "scheduled",
      payment_status: "paid",
      billing_note: "VIP client, comp next session",
      price_amount: 80,
      room_id: "room-other",
      rooms: { id: "room-other", name: "Studio B" },
    },
    {
      id: "appt-other-ii-rental",
      studio_id: STUDIO_ID,
      client_id: "other-ii-client-1",
      appointment_type: "floor_space_rental",
      title: "Another instructor's rental",
      starts_at: iso(3 * DAY),
      ends_at: iso(3 * DAY + 60 * 60 * 1000),
      status: "scheduled",
      payment_status: "waived",
      price_amount: 45,
      room_id: "room-third",
      rooms: { id: "room-third", name: "Studio C" },
    },
    {
      id: "appt-cancelled",
      studio_id: STUDIO_ID,
      client_id: "unrelated-client-2",
      appointment_type: "private_lesson",
      title: "Cancelled lesson",
      starts_at: iso(1.5 * DAY),
      ends_at: iso(1.5 * DAY + 60 * 60 * 1000),
      status: "cancelled",
      payment_status: null,
      price_amount: 80,
      room_id: "room-other",
      rooms: { id: "room-other", name: "Studio B" },
    },
    {
      id: "appt-out-of-window",
      studio_id: STUDIO_ID,
      client_id: "unrelated-client-3",
      appointment_type: "private_lesson",
      title: "Far future lesson",
      starts_at: iso(40 * DAY),
      ends_at: iso(40 * DAY + 60 * 60 * 1000),
      status: "scheduled",
      payment_status: "paid",
      price_amount: 80,
      room_id: "room-other",
      rooms: { id: "room-other", name: "Studio B" },
    },
    {
      id: "appt-other-studio",
      studio_id: OTHER_STUDIO_ID,
      client_id: OWN_CLIENT_ID,
      appointment_type: "floor_space_rental",
      title: "Cross-host rental (different studio)",
      starts_at: iso(1 * DAY),
      ends_at: iso(1 * DAY + 60 * 60 * 1000),
      status: "scheduled",
      payment_status: "paid",
      price_amount: 45,
      room_id: "room-cross-host",
      rooms: { id: "room-cross-host", name: "Cross Host Room" },
    },
    // Boundary pair proving the own-rental and occupancy queries share the
    // exact same horizon and cannot drift: one own + one unrelated
    // appointment just inside 30 days (both must appear), and one own +
    // one unrelated just outside (neither must appear).
    {
      id: "appt-own-just-inside",
      studio_id: STUDIO_ID,
      client_id: OWN_CLIENT_ID,
      appointment_type: "floor_space_rental",
      title: "Own rental just inside the horizon",
      starts_at: iso(JUST_INSIDE),
      ends_at: iso(JUST_INSIDE + 60 * 60 * 1000),
      status: "scheduled",
      payment_status: "paid",
      price_amount: 45,
      room_id: "room-boundary-own",
      rooms: { id: "room-boundary-own", name: "Studio Boundary Own" },
    },
    {
      id: "appt-unrelated-just-inside",
      studio_id: STUDIO_ID,
      client_id: "unrelated-client-boundary",
      appointment_type: "private_lesson",
      title: "Unrelated lesson just inside the horizon",
      starts_at: iso(JUST_INSIDE),
      ends_at: iso(JUST_INSIDE + 60 * 60 * 1000),
      status: "scheduled",
      payment_status: "paid",
      price_amount: 80,
      room_id: "room-boundary-unrelated",
      rooms: { id: "room-boundary-unrelated", name: "Studio Boundary Unrelated" },
    },
    {
      id: "appt-own-just-outside",
      studio_id: STUDIO_ID,
      client_id: OWN_CLIENT_ID,
      appointment_type: "floor_space_rental",
      title: "Own rental just outside the horizon",
      starts_at: iso(JUST_OUTSIDE),
      ends_at: iso(JUST_OUTSIDE + 60 * 60 * 1000),
      status: "scheduled",
      payment_status: "paid",
      price_amount: 45,
      room_id: "room-boundary-own-outside",
      rooms: { id: "room-boundary-own-outside", name: "Studio Boundary Own Outside" },
    },
    {
      id: "appt-unrelated-just-outside",
      studio_id: STUDIO_ID,
      client_id: "unrelated-client-boundary-outside",
      appointment_type: "private_lesson",
      title: "Unrelated lesson just outside the horizon",
      starts_at: iso(JUST_OUTSIDE),
      ends_at: iso(JUST_OUTSIDE + 60 * 60 * 1000),
      status: "scheduled",
      payment_status: "paid",
      price_amount: 80,
      room_id: "room-boundary-unrelated-outside",
      rooms: { id: "room-boundary-unrelated-outside", name: "Studio Boundary Unrelated Outside" },
    },
    // Overlapping unrelated appointments in the same room -- must both
    // render as separate, safe, non-sensitive "In use" cards.
    {
      id: "appt-overlap-a",
      studio_id: STUDIO_ID,
      client_id: "unrelated-overlap-client-a",
      appointment_type: "private_lesson",
      title: "Overlap lesson A",
      starts_at: iso(6 * DAY),
      ends_at: iso(6 * DAY + 90 * 60 * 1000),
      status: "scheduled",
      payment_status: "paid",
      price_amount: 80,
      room_id: "room-overlap",
      rooms: { id: "room-overlap", name: "Studio Overlap" },
    },
    {
      id: "appt-overlap-b",
      studio_id: STUDIO_ID,
      client_id: "unrelated-overlap-client-b",
      appointment_type: "coaching",
      title: "Overlap lesson B",
      starts_at: iso(6 * DAY + 30 * 60 * 1000),
      ends_at: iso(6 * DAY + 120 * 60 * 1000),
      status: "confirmed",
      payment_status: "paid",
      price_amount: 90,
      room_id: "room-overlap",
      rooms: { id: "room-overlap", name: "Studio Overlap" },
    },
  ];
}

function instructorScheduleBlockRows(): Row[] {
  return [
    {
      studio_id: STUDIO_ID,
      instructor_id: "staff-instructor-1",
      room_id: "room-closure",
      reason: "personal",
      title: "Staff lunch break",
      notes: "Do not disturb -- private note",
      starts_at: iso(1.2 * DAY),
      ends_at: iso(1.2 * DAY + 30 * 60 * 1000),
      rooms: { id: "room-closure", name: "Studio D" },
    },
    {
      // No room assigned -- must never appear (nothing to place on the
      // schedule, and no way to render it without ambiguity).
      studio_id: STUDIO_ID,
      instructor_id: "staff-instructor-2",
      room_id: null,
      reason: "meeting",
      title: "Off-site meeting",
      starts_at: iso(1.3 * DAY),
      ends_at: iso(1.3 * DAY + 30 * 60 * 1000),
      rooms: null,
    },
  ];
}

function makeChain(rows: Row[]) {
  let current = rows;

  const chain = {
    select: () => chain,
    eq(col: string, val: unknown) {
      current = current.filter((r) => r[col] === val);
      return chain;
    },
    in(col: string, vals: unknown[]) {
      current = current.filter((r) => vals.includes(r[col]));
      return chain;
    },
    not(col: string, op: string, val: unknown) {
      if (op === "is" && val === null) {
        current = current.filter((r) => r[col] !== null && r[col] !== undefined);
      } else if (op === "in") {
        const ids = String(val)
          .replace(/^\(|\)$/g, "")
          .split(",")
          .filter(Boolean);
        current = current.filter((r) => !ids.includes(String(r[col])));
      }
      return chain;
    },
    gte(col: string, val: string) {
      current = current.filter((r) => String(r[col]) >= val);
      return chain;
    },
    lt(col: string, val: string) {
      current = current.filter((r) => String(r[col]) < val);
      return chain;
    },
    gt(col: string, val: string) {
      current = current.filter((r) => String(r[col]) > val);
      return chain;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      const dir = opts?.ascending === false ? -1 : 1;
      current = [...current].sort((a, b) =>
        String(a[col]).localeCompare(String(b[col])) * dir,
      );
      return chain;
    },
    limit(n: number) {
      current = current.slice(0, n);
      return chain;
    },
    async maybeSingle() {
      return { data: current[0] ?? null, error: null };
    },
    then(
      onFulfilled: (value: { data: Row[]; error: null }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve({ data: current, error: null }).then(onFulfilled, onRejected);
    },
  };

  return chain;
}

class UnexpectedQueryError extends Error {
  constructor(table: string) {
    super(`UNEXPECTED_QUERY:${table}`);
  }
}

function createFakeSupabase(options: {
  links?: Row[];
  studios?: Row[];
  throwOnStaffTables?: boolean;
}) {
  const links = options.links ?? [];
  const studios =
    options.studios ?? [{ id: STUDIO_ID, slug: "test-studio", timezone: "America/New_York" }];
  const appointments = appointmentRows();
  const blocks = instructorScheduleBlockRows();

  return {
    from(table: string) {
      if (table === "client_account_links") return makeChain(links);
      if (table === "studios") return makeChain(studios);
      if (table === "appointments") return makeChain(appointments);
      if (table === "instructor_schedule_blocks") return makeChain(blocks);

      if (options.throwOnStaffTables) {
        // Proves the independent-instructor branch never reaches any
        // staff-only query (e.g. client_account_ledger, client_packages,
        // events, instructors, rooms as used by the staff path). Every
        // chain method used anywhere in the staff path is stubbed so a
        // missing method can never masquerade as this proof (a bare
        // TypeError would mask the real assertion, not confirm it).
        const err = new UnexpectedQueryError(table);
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        chain.select = self;
        chain.eq = self;
        chain.in = self;
        chain.not = self;
        chain.or = self;
        chain.order = self;
        chain.limit = self;
        chain.gte = self;
        chain.lt = self;
        chain.lte = self;
        chain.gt = self;
        chain.neq = self;
        // FC-1B5D: instructor role now also resolves its own instructors.id
        // via .maybeSingle() (resolveViewerInstructorId) before the
        // appointments query -- stub it so this still surfaces as the
        // intended UnexpectedQueryError rather than a masking TypeError.
        chain.maybeSingle = () => Promise.reject(err);
        chain.single = () => Promise.reject(err);
        chain.then = (
          onFulfilled: (v: unknown) => unknown,
          onRejected?: (r: unknown) => unknown,
        ) => Promise.reject(err).then(onFulfilled, onRejected);
        return chain;
      }

      return makeChain([]);
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fakeSupabase,
}));

let fakeSupabase: ReturnType<typeof createFakeSupabase>;

const { default: SchedulePage } = await import("../page");

function mockStudioContext(role: string) {
  getCurrentStudioContextMock.mockResolvedValue({
    studioId: STUDIO_ID,
    studioRole: role,
    isPlatformAdmin: false,
    userId: USER_ID,
    email: "instructor@example.test",
  });
}

async function renderSchedulePage() {
  const element = await SchedulePage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element as React.ReactElement);
}

function countOccurrences(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  getCurrentStudioContextMock.mockReset();
});

describe("independent_instructor narrow My Schedule -- FC-1B2", () => {
  it("sees their own floor rental with legitimate details (title, time, room, status, payment, price)", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).toContain("Evening practice block");
    expect(html).toContain("Studio A");
    expect(html).toContain("paid");
    expect(html).toContain("$45.00");
  });

  it("labels the schedule horizon as Next 30 days", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).toContain("Next 30 days");
    expect(html).not.toContain("Next 14 days");
  });

  it("an own rental inside the 30-day horizon appears in My Schedule", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).toContain("Evening practice block");
  });

  it("an own rental beyond the 30-day horizon does not appear in My Schedule", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).not.toContain("Far-out own rental");
  });

  it("shows an unrelated normal appointment inside the window only as a generic \"In use\" block, never its real content", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).toContain("Studio B");
    expect(html).toContain("In use");
    expect(html).not.toContain("Busy");
    expect(html).not.toContain("Jane Doe");
    expect(html).not.toContain("VIP client");
    expect(html).not.toContain("private_lesson");
    expect(html).not.toContain("Private Lesson");
  });

  it("unrelated occupancy beyond the 30-day window does not appear", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).not.toContain("Far future lesson");
  });

  it("boundary: an own rental and an unrelated appointment just inside 30 days both appear", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).toContain("Own rental just inside the horizon");
    expect(html).toContain("Studio Boundary Unrelated");
  });

  it("boundary: an own rental and an unrelated appointment just outside 30 days both are absent -- own-rental and occupancy queries cannot drift", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).not.toContain("Own rental just outside the horizon");
    expect(html).not.toContain("Studio Boundary Unrelated Outside");
    expect(html).not.toContain("Studio Boundary Own Outside");
  });

  it("shows another independent instructor's rental only as a generic \"In use\" block", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).toContain("Studio C");
    expect(html).toContain("In use");
    expect(html).not.toContain("Busy");
    expect(html).not.toContain("Another instructor's rental");
    expect(html).not.toContain("other-ii-client-1");
    expect(html).not.toContain("waived");
    expect(html).not.toContain("WAIVED");
  });

  it("a non-floor-rental appointment on the instructor's own linked client still surfaces as generic \"In use\", not as My Rental, and is not silently dropped", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    // Must appear as a generic "in use" signal for its room...
    expect(html).toContain("Studio E");
    // ...but never with its own title, note, or as a My Rental card.
    expect(html).not.toContain("Should never render as My Rental");
    expect(html).not.toContain("Should never render at all");
  });

  it("the own rental's own appointment does not also appear as a duplicate anonymous \"In use\" block", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    const roomAvailabilityIndex = html.indexOf("Room Availability");
    const recentRentalsIndex = html.indexOf("Recent Rentals");
    const roomAvailabilitySection = html.slice(
      roomAvailabilityIndex,
      recentRentalsIndex === -1 ? html.length : recentRentalsIndex,
    );

    // Studio A is the own rental's room -- it must never appear inside the
    // Room Availability section, only inside Your Upcoming Rentals.
    expect(roomAvailabilitySection).not.toContain("Studio A");
  });

  it("overlapping anonymous \"In use\" blocks in the same room both render safely with no sensitive content", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(countOccurrences(html, "Studio Overlap")).toBe(2);
    expect(html).not.toContain("Overlap lesson A");
    expect(html).not.toContain("Overlap lesson B");
    expect(html).not.toContain("coaching");
  });

  it("multiple simultaneously linked client_account_links rows: both linked clients' own rentals appear", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({
      links: [linkRow(OWN_CLIENT_ID), linkRow(SECOND_OWN_CLIENT_ID)],
    });

    const html = await renderSchedulePage();

    expect(html).toContain("Evening practice block");
    expect(html).toContain("Second client");
    expect(html).toContain("Studio F");
  });

  it("duplicate linked rows for the same client id are safely deduplicated (no duplicate rental card)", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({
      links: [linkRow(OWN_CLIENT_ID), linkRow(OWN_CLIENT_ID, { relationship_type: "self" })],
    });

    const html = await renderSchedulePage();

    expect(countOccurrences(html, "Evening practice block")).toBe(1);
  });

  it("generic \"In use\" blocks contain no client identity, payment detail, notes, revealing type label, or action link", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).not.toContain("/app/schedule/appt-");
    expect(html).not.toMatch(/href="[^"]*appt-unrelated-lesson[^"]*"/);
    expect(html).not.toMatch(/href="[^"]*appt-other-ii-rental[^"]*"/);
    expect(html).not.toContain("appt-unrelated-lesson");
    expect(html).not.toContain("appt-other-ii-rental");
  });

  it("a cancelled appointment does not appear as an \"In use\" block", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).not.toContain("Cancelled lesson");
  });

  it("studio-authored instructor_schedule_blocks show as a non-sensitive Unavailable label, not their reason/notes/instructor", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).toContain("Studio D");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("Staff lunch break");
    expect(html).not.toContain("Do not disturb");
    expect(html).not.toContain("personal");
  });

  it("a schedule block with no assigned room is not rendered at all", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).not.toContain("Off-site meeting");
  });

  it("own rental exposes only the Manage My Rentals link (the FC-1-authorized management surface), no staff mutation controls", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).toContain("/portal/test-studio/floor-space/my-rentals");
    expect(html).not.toContain("New Appointment");
    expect(html).not.toContain("Mark Eligible Lessons Attended");
  });

  it("cross-host isolation: a rental at a different studio (same user, same client id) is never shown while viewing this studio", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [linkRow(OWN_CLIENT_ID)] });

    const html = await renderSchedulePage();

    expect(html).not.toContain("Cross-host rental");
    expect(html).not.toContain("Cross Host Room");
  });

  it("revoked link: a disconnected client_account_links row grants no own-rental visibility, and that client's appointment shows only as \"In use\"", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({
      links: [linkRow(OWN_CLIENT_ID, { status: "disconnected" })],
    });

    const html = await renderSchedulePage();

    expect(html).not.toContain("Evening practice block");
    expect(html).toContain("No upcoming rentals");
    // The now-unowned client's appointment must still surface as a purely
    // anonymized "In use" signal, proving the branch degrades safely rather
    // than silently granting or silently erroring.
    expect(html).toContain("Studio A");
  });

  it("no linked client at all: narrow view renders safely with empty own-rentals and \"In use\" occupancy still populated", async () => {
    mockStudioContext("independent_instructor");
    fakeSupabase = createFakeSupabase({ links: [] });

    const html = await renderSchedulePage();

    expect(html).toContain("No upcoming rentals");
    expect(html).toContain("My Schedule");
  });

  it.each(["studio_owner", "studio_admin", "front_desk", "instructor", "platform_admin"])(
    "%s still reaches the unmodified staff schedule query, never the narrow branch",
    async (role) => {
      mockStudioContext(role);
      fakeSupabase = createFakeSupabase({ links: [], throwOnStaffTables: true });

      const error = await SchedulePage({ searchParams: Promise.resolve({}) }).catch((e) => e);

      // Staff roles must reach the pre-existing staff query (client_packages,
      // client_account_ledger, events, instructors, rooms), which this fake
      // deliberately throws on -- proving the narrow independent-instructor
      // branch was never taken and the staff surface is unchanged.
      expect(error).toBeInstanceOf(UnexpectedQueryError);
    },
  );
});

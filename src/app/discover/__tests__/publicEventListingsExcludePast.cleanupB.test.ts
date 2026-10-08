import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cleanup PR B: public event listings (discover, "Newly added", discover counts, public studio + organizer pages,
 * studio + organizer embeds, client portal) show current and upcoming events only. Ended events are bounded out in
 * the query (`end_date >= eventEndDateLowerBound(now)`, never unbounded history) and then removed exactly with the
 * shared end-moment rule BEFORE any limit is applied, so they can never take a slot or inflate a count.
 */

type Call = { method: string; args: unknown[] };

const state: { calls: Record<string, Call[]>; rows: Record<string, unknown> } = { calls: {}, rows: {} };

function builder(table: string) {
  const calls: Call[] = (state.calls[table] = state.calls[table] ?? []);
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "not", "gte", "lte", "order", "limit"]) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  chain.maybeSingle = async () => ({ data: state.rows[table] ?? null, error: null });
  chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: state.rows[table] ?? [], error: null });
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => builder(table) }),
}));

const NOW = new Date("2026-10-08T15:00:00.000Z");

function eventRow(id: string, fields: Record<string, unknown>) {
  return {
    id,
    name: id,
    slug: id,
    event_type: "social_dance",
    public_summary: null,
    public_description: null,
    public_cover_image_url: null,
    venue_name: null,
    city: null,
    state: null,
    postal_code: null,
    timezone: "America/New_York",
    start_time: null,
    end_time: null,
    registration_required: false,
    beginner_friendly: false,
    ...fields,
  };
}

describe("studio embed events API", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    state.calls = {};
    state.rows = {
      studios: {
        id: "studio-a",
        name: "Studio A",
        public_name: null,
        slug: "studio-a",
        public_directory_enabled: true,
        billing_plan: "pro",
        subscription_status: "active",
      },
      // rows the bounded prefilter can still return: ended-within-a-day events sort first
      events: [
        eventRow("ended-yesterday", { start_date: "2026-10-07", end_date: "2026-10-07" }),
        eventRow("ended-this-morning", { start_date: "2026-10-08", end_date: "2026-10-08", end_time: "09:00:00" }),
        eventRow("in-progress-multi-day", { start_date: "2026-10-07", end_date: "2026-10-10" }),
        eventRow("tonight", { start_date: "2026-10-08", start_time: "19:00:00", end_date: "2026-10-08", end_time: "22:00:00" }),
        eventRow("next-week", { start_date: "2026-10-15", end_date: "2026-10-15" }),
      ],
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns current + future events, omits ended ones, and fills the limit from non-past events", async () => {
    const { GET } = await import("@/app/api/embed/studios/[studioSlug]/events/route");
    const response = await GET(
      new Request("https://example.test/api/embed/studios/studio-a/events?limit=2", {
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0" },
      }),
      { params: Promise.resolve({ studioSlug: "studio-a" }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: Array<{ id: string }> };
    expect(body.events.map((event) => event.id)).toEqual(["in-progress-multi-day", "tonight"]);

    const eventCalls = state.calls.events ?? [];
    // bounded history: end_date prefilter, never an unbounded fetch
    expect(eventCalls).toContainEqual({ method: "gte", args: ["end_date", "2026-10-07"] });
    // over-fetch so dropped past rows cannot shrink the list below the requested limit
    const limitCall = eventCalls.find((call) => call.method === "limit");
    expect(Number(limitCall?.args[0])).toBeGreaterThan(2);
    // publication rules preserved
    expect(eventCalls).toContainEqual({ method: "eq", args: ["visibility", "public"] });
    expect(eventCalls).toContainEqual({ method: "in", args: ["status", ["published", "open"]] });
  });
});

function source(path: string) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

describe("public event listing surfaces use the shared end-moment rule", () => {
  const surfaces = [
    "src/app/discover/events/page.tsx",
    "src/app/discover/page.tsx",
    "src/app/studios/[studioSlug]/page.tsx",
    "src/app/organizers/[slug]/page.tsx",
    "src/app/api/embed/studios/[studioSlug]/events/route.ts",
    "src/app/api/embed/organizers/[slug]/events/route.ts",
    "src/app/portal/[studioSlug]/page.tsx",
  ];

  for (const path of surfaces) {
    it(`${path}: bounded end_date prefilter + exact filterNotPastEvents, no start_date proxy`, () => {
      const text = source(path);
      expect(text).toContain('from "@/lib/events/eventTiming"');
      expect(text).toContain('.gte("end_date", eventEndDateLowerBound(');
      expect(text).toContain("filterNotPastEvents(");
      expect(text).not.toMatch(/\.gte\("start_date",/);
    });
  }

  it("discover events: 'Newly added' and the main list are both derived from the filtered rows", () => {
    const text = source("src/app/discover/events/page.tsx");
    expect(text).toContain("const typedEvents = filterNotPastEvents((events ?? []) as EventRow[], now);");
    // the raw rows are not used anywhere else
    expect(text.match(/\(events \?\? \[\]\)/g)?.length).toBe(1);
    expect(text).toMatch(/timezone,\n\s+visibility,/);
  });

  it("discover hub: the public event count no longer counts ended events (no head-only count of all history)", () => {
    const text = source("src/app/discover/page.tsx");
    expect(text).toContain("const publicEventCount = filterNotPastEvents(");
    expect(text).not.toContain("eventCountResult.count");
  });

  it("limited lists filter BEFORE slicing and over-fetch with the shared buffer", () => {
    const studio = source("src/app/studios/[studioSlug]/page.tsx");
    expect(studio).toContain(".limit(6 + EVENT_LIST_PAST_BUFFER)");
    expect(studio).toContain("filterNotPastEvents((events ?? []) as EventRow[], now).slice(0, 6)");

    const portal = source("src/app/portal/[studioSlug]/page.tsx");
    expect(portal).toContain(".limit(6 + EVENT_LIST_PAST_BUFFER)");
    expect(portal).toMatch(/filterNotPastEvents\(\s*\(upcomingStudioEvents \?\? \[\]\) as PortalStudioEventRow\[\],\s*new Date\(nowIso\),\s*\)\.slice\(0, 6\)/);

    for (const path of ["src/app/api/embed/studios/[studioSlug]/events/route.ts", "src/app/api/embed/organizers/[slug]/events/route.ts"]) {
      const text = source(path);
      expect(text).toContain(".limit(limit + EVENT_LIST_PAST_BUFFER)");
      expect(text).toContain(".slice(0, limit)");
    }
  });

  it("organizer page and embed keep the active-subscription access filter", () => {
    expect(source("src/app/organizers/[slug]/page.tsx")).toContain("hasActivePublicAccess");
    expect(source("src/app/api/embed/organizers/[slug]/events/route.ts")).toContain(
      ".filter((event) => hasActivePublicAccess(getStudio(event.studios)))",
    );
  });

  it("publication visibility rules are unchanged (published/open + public + directory)", () => {
    for (const path of ["src/app/discover/events/page.tsx", "src/app/discover/page.tsx", "src/app/studios/[studioSlug]/page.tsx"]) {
      const text = source(path);
      expect(text).toContain('.eq("visibility", "public")');
      expect(text).toContain('.in("status", ["published", "open"])');
    }
  });
});

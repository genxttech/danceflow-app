import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scratchPreflight, classifyPlacements } from "@/lib/competition/scratch/scratch";
import { loadScratchOffer, mayOfferScratch, type ScratchOfferSupabase } from "@/lib/competition/scratch/scratchOffer";

type Placement = { entry_id: string; status: string; heat: { lock_state: string; status: string } };

const heat = (status: string, lock_state = "open") => ({ status, lock_state });
const placed = (entry_id: string, heatStatus: string, status = "scheduled", lock = "open"): Placement => ({ entry_id, status, heat: heat(heatStatus, lock) });

function fake(options: { placements?: Placement[]; closed?: string[]; fail?: string; maxRows?: number }) {
  const calls: { table: string; filters: [string, unknown][] }[] = [];
  const supabase: ScratchOfferSupabase = {
    from: (table) => ({
      select: () => {
        const call = { table, filters: [] as [string, unknown][] };
        calls.push(call);
        const query = {
          eq: (c: string, v: string) => (call.filters.push([c, v]), query),
          in: (c: string, v: string[]) => (call.filters.push([c, v]), query),
          order: () => query,
          range: async (from: number, to: number) => {
            if (options.fail === table) return { data: null, error: { message: "boom" } };
            const all: unknown[] = table === "event_competition_heat_entries" ? (options.placements ?? []) : (options.closed ?? []).map((id) => ({ id }));
            return { data: all.slice(from, Math.min(to + 1, from + (options.maxRows ?? 1000))), error: null };
          },
        };
        return query;
      },
    }),
  };
  return { supabase, calls };
}

describe("SC1 whole-entry scratch offer (Option A)", () => {
  it.each([
    ["an active heat", [placed("e", "active")]],
    ["a completed heat", [placed("e", "complete")]],
    ["one completed heat and a later scheduled heat", [placed("e", "complete"), placed("e", "scheduled")]],
    ["one active heat and later checked-in heats", [placed("e", "scheduled", "checked_in"), placed("e", "active"), placed("e", "scheduled")]],
    ["a danced placement", [placed("e", "scheduled", "danced"), placed("e", "scheduled")]],
    ["a disqualified placement", [placed("e", "scheduled", "disqualified")]],
    ["a locked heat", [placed("e", "scheduled", "scheduled", "locked")]],
    ["a certified heat", [placed("e", "scheduled", "scheduled", "certified")]],
  ])("offers nothing for %s, and the server preflight refuses it too", async (_label, placements) => {
    const offer = await loadScratchOffer(fake({ placements }).supabase, "ev");
    expect(offer.loaded).toBe(true);
    expect(mayOfferScratch(offer, "e")).toBe(false);
    const placementClass = classifyPlacements(placements.map((p) => ({ heatLockState: p.heat.lock_state, placementStatus: p.status, heatStatus: p.heat.status })));
    expect(scratchPreflight({ entryStatus: "confirmed", placementClass }).allowed).toBe(false);
  });

  it("offers an entry with only scheduled heats, an unplaced entry, and leaves other entries' heats out of it", async () => {
    const offer = await loadScratchOffer(fake({ placements: [placed("a", "scheduled"), placed("a", "scheduled", "checked_in"), placed("b", "complete")] }).supabase, "ev");
    expect(mayOfferScratch(offer, "a")).toBe(true);
    expect(mayOfferScratch(offer, "unplaced")).toBe(true);
    expect(mayOfferScratch(offer, "b")).toBe(false);
  });

  it("offers nothing for a disqualified or complete entry status", async () => {
    const { supabase, calls } = fake({ closed: ["d"] });
    expect(mayOfferScratch(await loadScratchOffer(supabase, "ev"), "d")).toBe(false);
    expect(calls.find((c) => c.table === "event_competition_entries")?.filters).toEqual([["event_id", "ev"], ["status", ["disqualified", "complete"]]]);
  });

  it("reads past the response row limit, including a server limit below the page size", async () => {
    const placements = [...Array.from({ length: 1200 }, (_, i) => placed(`ok${i}`, "scheduled")), placed("late", "complete")];
    for (const maxRows of [1000, 500]) {
      const { supabase, calls } = fake({ placements, maxRows });
      const offer = await loadScratchOffer(supabase, "ev");
      expect(mayOfferScratch(offer, "late")).toBe(false);
      expect(calls.filter((c) => c.table === "event_competition_heat_entries").every((c) => c.filters.some(([k, v]) => k === "event_id" && v === "ev"))).toBe(true);
    }
  });

  it.each(["event_competition_heat_entries", "event_competition_entries"])("offers nothing when %s cannot be read", async (table) => {
    const offer = await loadScratchOffer(fake({ fail: table }).supabase, "ev");
    expect(offer.loaded).toBe(false);
    expect(mayOfferScratch(offer, "anything")).toBe(false);
  });

  it.each(["day-of", "registrations"])("the %s page shows its scratch link only through mayOfferScratch", (page) => {
    const source = readFileSync(`src/app/app/events/[id]/competition/${page}/page.tsx`, "utf8");
    const links = source.split("href={scratchHref(").length - 1;
    expect(links).toBe(1);
    expect(source.slice(0, source.indexOf("href={scratchHref(")).slice(-200)).toContain("mayOfferScratch(scratchOffer");
  });
});

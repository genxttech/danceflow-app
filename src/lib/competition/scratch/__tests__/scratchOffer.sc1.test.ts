import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scratchPreflight, classifyPlacements } from "@/lib/competition/scratch/scratch";
import { loadScratchOffer, mayOfferScratch, type ScratchOfferSupabase } from "@/lib/competition/scratch/scratchOffer";

type Placement = { entry_id: string; status: string; heat: { lock_state: string; status: string } };
const PAGES = [
  ["day-of", /\{mayOfferScratch\(scratchOffer, entry\.entryId\) \? \(\s*<Link href=\{scratchHref\(id, entry\.entryId\)\}/],
  ["registrations", /\.includes\(entry\.status\) \? null : mayOfferScratch\(scratchOffer, entry\.id\) \? <Link href=\{scratchHref\(id, entry\.id\)\}/],
] as const;

const heat = (status: string, lock_state = "open") => ({ status, lock_state });
const placed = (entry_id: string, heatStatus: string, status = "scheduled", lock = "open"): Placement => ({ entry_id, status, heat: heat(heatStatus, lock) });

function fake(options: { placements?: Placement[]; closed?: { id: string; status: string }[]; fail?: string; maxRows?: number }) {
  const calls: { table: string; columns: string; filters: [string, unknown][] }[] = [];
  const supabase: ScratchOfferSupabase = {
    from: (table) => ({
      select: (columns) => {
        const call = { table, columns, filters: [] as [string, unknown][] };
        calls.push(call);
        const query = {
          eq: (c: string, v: string) => (call.filters.push([c, v]), query),
          in: (c: string, v: string[]) => (call.filters.push([c, v]), query),
          order: () => query,
          range: async (from: number, to: number) => {
            if (options.fail === table) return { data: null, error: { message: "boom" } };
            const all: unknown[] = table === "event_competition_heat_entries" ? (options.placements ?? []) : (options.closed ?? []);
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

  it("reads the heat status and lock state it decides on", async () => {
    const { supabase, calls } = fake({});
    await loadScratchOffer(supabase, "ev");
    expect(calls.find((c) => c.table === "event_competition_heat_entries")?.columns).toBe("entry_id, status, heat:event_competition_heats(lock_state, status)");
  });

  it("offers nothing for an entry with a placement whose heat cannot be read", async () => {
    const unreadable = { entry_id: "e", status: "scheduled", heat: null } as unknown as Placement;
    const offer = await loadScratchOffer(fake({ placements: [placed("e", "scheduled"), unreadable, placed("other", "scheduled")] }).supabase, "ev");
    expect(mayOfferScratch(offer, "e")).toBe(false);
    expect(mayOfferScratch(offer, "other")).toBe(true);
  });

  it("offers nothing for a disqualified or complete entry status", async () => {
    const { supabase, calls } = fake({ closed: [{ id: "d", status: "disqualified" }] });
    expect(mayOfferScratch(await loadScratchOffer(supabase, "ev"), "d")).toBe(false);
    expect(calls.find((c) => c.table === "event_competition_entries")?.filters).toEqual([["event_id", "ev"], ["status", ["disqualified", "complete", "scratched", "withdrawn"]]]);
  });

  it("marks scratched and withdrawn entries as having left, so the day-of console offers no no-show for them", async () => {
    const offer = await loadScratchOffer(fake({ closed: [{ id: "w", status: "withdrawn" }, { id: "s", status: "scratched" }, { id: "d", status: "disqualified" }] }).supabase, "ev");
    expect([...offer.left].sort()).toEqual(["s", "w"]);
    expect([...offer.blocked]).toEqual(["d"]);
    const source = readFileSync("src/app/app/events/[id]/competition/day-of/page.tsx", "utf8");
    expect(source).toContain("const hasLeft = scratchOffer.left.has(entry.entryId);");
    expect(source).toContain("const canMark = !hasLeft && canMarkNoShow({");
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

  it.each(PAGES)("the %s page shows its one scratch link only when mayOfferScratch allows it", (page, guarded) => {
    const source = readFileSync(`src/app/app/events/[id]/competition/${page}/page.tsx`, "utf8");
    expect(source).toMatch(guarded);
    expect(source.split("scratchHref(").length - 1).toBe(1);
    expect(source).not.toContain("registrations/scratch");
  });
});

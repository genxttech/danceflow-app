import { describe, expect, it } from "vitest";
import { mergeViewerRounds, parseViewerRounds, placementLabel } from "../viewer";

const pub = (over: Record<string, unknown> = {}) => ({
  publication: { id: "p1", version: 1, published_at: "2026-11-01T00:00:00Z", visibility: "public" },
  event_id: "e1",
  round: { id: "r1", name: "Final", round_type: "final", division_id: "d1", division_name: "Newcomer Waltz", program_name: "Pro-Am" },
  rows: [
    { entry_number: "101", display_name: "A and B", placement: 1, tie_group: null, advanced: null, rating_band: null, mine: true },
    { entry_number: "102", display_name: null, placement: 2, tie_group: null, advanced: null, rating_band: null, mine: false },
  ],
  excluded: [{ entry_number: "103", display_name: null, mine: false }],
  ...over,
});

describe("F3 results viewer parsing", () => {
  it("parses a published round with rows, mine flags and excluded numbers", () => {
    const [r] = parseViewerRounds([pub()]);
    expect(r).toMatchObject({ publicationId: "p1", publicationVersion: 1, roundId: "r1", roundName: "Final", divisionName: "Newcomer Waltz", visibility: "public" });
    expect(r.rows.map((x) => [x.entryNumber, x.displayName, x.mine])).toEqual([["101", "A and B", true], ["102", null, false]]);
    expect(r.excluded).toEqual([{ entryNumber: "103", displayName: null, mine: false }]);
  });
  it("drops malformed publications and rows instead of guessing", () => {
    expect(parseViewerRounds(null)).toEqual([]);
    expect(parseViewerRounds({})).toEqual([]);
    expect(parseViewerRounds([null, 3, {}, pub({ publication: { id: "p", version: "1", visibility: "public" } })])).toEqual([]);
    expect(parseViewerRounds([pub({ publication: { id: "p2", version: 1, visibility: "everyone" } })])).toEqual([]);
    const [r] = parseViewerRounds([pub({ rows: [null, { display_name: "x" }, { entry_number: "7", placement: "1" }] })]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].placement).toBeNull();
  });
  it("never turns a missing display name into a name", () => {
    const [r] = parseViewerRounds([pub({ excluded: [{ entry_number: "9", mine: false }] })]);
    expect(r.excluded[0].displayName).toBeNull();
  });
  it("merges the entrant view first and shows each publication once", () => {
    const mine = parseViewerRounds([pub()]);
    const other = parseViewerRounds([pub({ publication: { id: "p9", version: 2, visibility: "public" }, round: { id: "r9", name: "Semi" } })]);
    const merged = mergeViewerRounds(mine, [...mine, ...other]);
    expect(merged.map((m) => m.publicationId)).toEqual(["p1", "p9"]);
    expect(merged[0].rows[0].mine).toBe(true);
  });
  it("labels placements, ties and callback outcomes", () => {
    const base = { entryNumber: "1", displayName: null, tieGroup: null, ratingBand: null, mine: false };
    expect(placementLabel({ ...base, placement: 2, advanced: null })).toBe("2");
    expect(placementLabel({ ...base, placement: 2, tieGroup: "t1", advanced: null })).toBe("2 (tie)");
    expect(placementLabel({ ...base, placement: null, advanced: true })).toBe("Advanced");
    expect(placementLabel({ ...base, placement: null, advanced: false })).toBe("Not advanced");
    expect(placementLabel({ ...base, placement: null, advanced: null })).toBe("No placement");
  });
});

describe("F3 results page wiring", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const page = (require("node:fs") as typeof import("node:fs")).readFileSync(new URL("../../../../app/events/[slug]/competition/results/page.tsx", import.meta.url), "utf8");
  it("reads only through the two F3 reader RPCs and has no write path", () => {
    expect(page).toContain('"competition_my_results"');
    expect(page).toContain('"competition_event_results_public"');
    expect(page).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(page).not.toMatch(/createAdminClient|service_role/);
  });
  it("only asks for the entrant view when signed in, and never indexes the page", () => {
    expect(page).toMatch(/signedIn \? supabase\.rpc\("competition_my_results"/);
    expect(page).toContain("robots: { index: false, follow: false }");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPlacements,
  entryStatusLabel,
  isScratchable,
  parseResolution,
  scratchDecision,
  scratchErrorMessage,
  SCRATCH_RESOLUTIONS,
} from "@/lib/competition/scratch/scratch";

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const MIGRATION = read("src/lib/supabase/migrations/20270108090000_competition_sc1_scratch.sql");
const ACTIONS = read("src/app/app/events/[id]/competition/registrations/scratch/actions.ts");

describe("SC1 terminology (S-D1)", () => {
  it("shows both stored statuses as Scratched", () => {
    expect(entryStatusLabel("scratched")).toBe("Scratched");
    expect(entryStatusLabel("withdrawn")).toBe("Scratched");
    expect(entryStatusLabel("needs_review")).toBe("Needs Review");
  });

  it("only scratches live entries", () => {
    expect(["pending", "confirmed", "waitlisted"].every(isScratchable)).toBe(true);
    expect(["scratched", "withdrawn", "complete", "disqualified"].some(isScratchable)).toBe(false);
  });
});

describe("SC1 placement classes", () => {
  it("picks the most protective state", () => {
    expect(classifyPlacements([])).toBe("unplaced");
    expect(classifyPlacements([{ heatLockState: "open", placementStatus: "scheduled" }])).toBe("open");
    expect(classifyPlacements([{ heatLockState: "locked", placementStatus: "checked_in" }])).toBe("locked");
    expect(classifyPlacements([{ heatLockState: "open", placementStatus: "danced" }, { heatLockState: "locked", placementStatus: "scheduled" }])).toBe("danced");
    expect(classifyPlacements([{ heatLockState: "certified", placementStatus: "scheduled" }, { heatLockState: "open", placementStatus: "danced" }])).toBe("certified");
  });

  it("does not treat an already-scratched placement in a locked heat as locked", () => {
    expect(classifyPlacements([{ heatLockState: "locked", placementStatus: "scratched" }])).toBe("open");
  });
});

describe("SC1 scratch decisions", () => {
  const base = { policy: "no_refund" as const, resolution: "no_refund" as const, isOfficial: false };

  it("lets any manager make a normal scratch with no reason", () => {
    expect(scratchDecision({ ...base, placementClass: "open" })).toEqual({
      allowed: true,
      needsOfficial: false,
      needsReason: false,
      isException: false,
      lockedHeat: false,
    });
  });

  it("requires an official and a reason in a locked heat (S-D2)", () => {
    expect(scratchDecision({ ...base, placementClass: "locked" }).allowed).toBe(false);
    expect(scratchDecision({ ...base, placementClass: "locked", isOfficial: true })).toMatchObject({ allowed: true, needsReason: true, lockedHeat: true });
  });

  it("treats a non-default resolution as an official exception", () => {
    expect(scratchDecision({ ...base, placementClass: "open", resolution: "refund" }).allowed).toBe(false);
    expect(scratchDecision({ ...base, placementClass: "open", resolution: "refund", isOfficial: true })).toMatchObject({
      allowed: true,
      isException: true,
      needsReason: true,
    });
    expect(scratchDecision({ ...base, policy: "refund", resolution: "refund", placementClass: "open" })).toMatchObject({ allowed: true, isException: false });
  });

  it("never scratches danced or certified entries, even for officials", () => {
    expect(scratchDecision({ ...base, placementClass: "danced", isOfficial: true }).allowed).toBe(false);
    expect(scratchDecision({ ...base, placementClass: "certified", isOfficial: true }).allowed).toBe(false);
  });

  it("does not offer competition credit yet", () => {
    expect(SCRATCH_RESOLUTIONS.find((r) => r.key === "credit")?.available).toBe(false);
    expect(scratchDecision({ ...base, placementClass: "open", resolution: "credit", isOfficial: true }).allowed).toBe(false);
  });

  it("parses only known resolutions", () => {
    expect(parseResolution("refund")).toBe("refund");
    expect(parseResolution("cash")).toBeNull();
  });
});

describe("SC1 error copy", () => {
  it("maps every database refusal code the migration raises", () => {
    const codes = [...new Set(MIGRATION.match(/COMP_SC1_[A-Z_]+/g) ?? [])];
    expect(codes.length).toBeGreaterThan(5);
    for (const code of codes) expect(scratchErrorMessage(`${code}: detail`), code).not.toBe("The entry could not be scratched. Try again.");
  });
});

describe("SC1 never moves money", () => {
  it("the scratch action calls no payment, refund or Stripe code", () => {
    expect(ACTIONS).not.toMatch(/stripe|refunds\.create|request_competition_order_refund|event_payments|event_orders/i);
    expect(ACTIONS).toContain("scratch_competition_entry");
  });

  it("the migration writes fee_handling retain only and touches no payment tables", () => {
    expect(MIGRATION).toContain("'app.competition_entry_fee_handling', 'retain'");
    expect(MIGRATION).not.toMatch(/update public\.event_(payments|orders|registrations)|insert into public\.event_order_refunds/i);
  });
});

// OD-20 (owner decision 2026-11-23, Option A, organizer exclusion only): wording never presents an organizer
// exclusion as a governing-body disqualification, and the wording change alters no behavior.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  effectivelyExcludedEntryIds,
  exclusionReasonLabel,
  exclusionWindowOpen,
  canCosign,
  parseExclusionRows,
  pendingExclusionRequests,
  validateExclusionReason,
  parseExclusionReasonKind,
} from "../advancement";
import { EXCLUDED_LABEL, excludedCoupleLabel } from "../reviewTypes";
import { canMarkNoShow } from "../../noShow";

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const ALLOWED = /not a governing-body disqualification/g;

describe("OD-20 organizer exclusion wording", () => {
  it("the label is 'Excluded (organizer decision)' and is used for managers and everyone else", () => {
    expect(EXCLUDED_LABEL).toBe("Excluded (organizer decision)");
    expect(excludedCoupleLabel({ reason_kind: "refunded", reason: "Registration refunded" })).toBe("Excluded (organizer decision): refunded, Registration refunded");
    const panels = read("src/app/app/events/[id]/competition/results/[roundId]/CallbackPanels.tsx");
    expect(panels).toContain("{EXCLUDED_LABEL}</h3>");
    expect(panels).toContain(": EXCLUDED_LABEL}");
    expect(panels).toContain("not a governing-body disqualification");
  });

  it("no user-facing exclusion surface says disqualified / DQ / disqualification (except the explicit disclaimer)", () => {
    const files = [
      "src/app/app/events/[id]/competition/results/[roundId]/CallbackPanels.tsx",
      "src/app/app/events/[id]/competition/results/[roundId]/page.tsx",
      "src/app/app/events/[id]/competition/results/actions.ts",
      "src/app/events/[slug]/competition/results/page.tsx",
      "src/lib/competition/results/messages.ts",
      "src/lib/competition/results/reviewTypes.ts",
      "src/lib/competition/results/advancement.ts",
      "src/lib/competition/results/correction.ts",
      "src/lib/competition/noShow.ts",
    ];
    for (const file of files) {
      const text = read(file).replace(ALLOWED, "");
      // The only tolerated hits are database status literals (noShow.ts's refused-status list and its comment).
      const hits = (text.match(/[^\n]*(disqualif|\bDQ\b)[^\n]*/gi) ?? []).filter((line) => !/\["scratched", "danced", "disqualified"\]|scratched \/ danced \/ disqualified/.test(line));
      expect(hits, file).toEqual([]);
    }
  });

  it("every exclusion message and the saved notices name the organizer decision or stay neutral", () => {
    const actions = read("src/app/app/events/[id]/competition/results/actions.ts");
    expect(actions).toContain("Exclusion (organizer decision) requested.");
    expect(actions).toContain("Exclusion (organizer decision) co-signed.");
    expect(actions).toContain("Exclusion (organizer decision) reversed.");
  });
});

describe("OD-20 disqualified status is not a supported action", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (name === "__tests__" || name === "node_modules") return [];
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  it("no application code writes the status disqualified", () => {
    const pattern = /status\s*:\s*["']disqualified["']/;
    const writers = [...walk(join(ROOT, "src/app")), ...walk(join(ROOT, "src/lib"))].filter((f) => pattern.test(readFileSync(f, "utf8")));
    expect(writers).toEqual([]);
  });
});

describe("OD-20 behavior is unchanged by the wording", () => {
  const rows = parseExclusionRows({
    rows: [
      { id: "a", seq: 1, kind: "exclude_requested", entry_id: "e1", reason_kind: "ineligible", reason: "r", actor: "u1", actor_role: "manager", at: "t", completed: true },
      { id: "b", seq: 2, kind: "exclude_cosigned", entry_id: "e1", reason_kind: "ineligible", reason: "r", actor: "u2", decision_id: "a", completed: true },
      { id: "c", seq: 3, kind: "exclude_requested", entry_id: "e2", reason_kind: "other", reason: "r2", actor: "u1", completed: false },
      { id: "d", seq: 4, kind: "reverse_requested", entry_id: "e1", reason_kind: "ineligible", reason: "fixed", actor: "u1", completed: true },
      { id: "e", seq: 5, kind: "reverse_cosigned", entry_id: "e1", reason_kind: "ineligible", reason: "fixed", actor: "u2", completed: true },
      { id: "f", seq: 6, kind: "exclude_cosigned", entry_id: "e3", reason_kind: "refunded", reason: "r3", actor: "u2", completed: true },
    ],
  });

  it("exclusion state machine", () => {
    expect(rows).toHaveLength(6);
    expect([...effectivelyExcludedEntryIds(rows)]).toEqual(["e3"]);
    expect(pendingExclusionRequests(rows).map((r) => r.id)).toEqual(["c"]);
    expect(canCosign(rows[2], "u1")).toBe(false);
    expect(canCosign(rows[2], "u9")).toBe(true);
    expect(["draft", "active", "ballots_locked", "calculated", "approved"].map(exclusionWindowOpen)).toEqual([false, true, true, false, false]);
  });

  it("reason kinds, labels and validation", () => {
    expect(["ineligible", "refunded", "other"].map((k) => exclusionReasonLabel(k as never))).toEqual(["Ineligible", "Refunded", "Other"]);
    expect(parseExclusionReasonKind("disqualified")).toBeNull();
    expect(parseExclusionReasonKind("refunded")).toBe("refunded");
    expect(validateExclusionReason("ab").ok).toBe(false);
    expect(validateExclusionReason("  abc ")).toEqual({ ok: true, value: "abc" });
  });

  it("no-show window: scratched / danced / disqualified entries are still refused, others allowed", () => {
    const base = { roundStatus: "active", heatStatus: "active" };
    expect(["scheduled", "checked_in"].map((entryStatus) => canMarkNoShow({ ...base, entryStatus }))).toEqual([true, true]);
    expect(["scratched", "danced", "disqualified"].map((entryStatus) => canMarkNoShow({ ...base, entryStatus }))).toEqual([false, false, false]);
    expect(canMarkNoShow({ roundStatus: "ballots_locked", heatStatus: "active", entryStatus: "scheduled" })).toBe(false);
  });
});

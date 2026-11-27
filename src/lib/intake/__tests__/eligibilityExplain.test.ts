import { describe, expect, it } from "vitest";
import { RECONCILE_OUTCOMES } from "@/lib/intake/reconcilePreview";
import { QUALIFICATION_RULES, explainOutcome, explainedOutcomes } from "@/lib/intake/eligibilityExplain";

describe("eligibility explanations", () => {
  it("explain every outcome the database can return, in plain language", () => {
    expect([...explainedOutcomes()].sort()).toEqual([...RECONCILE_OUTCOMES].sort());
    for (const outcome of RECONCILE_OUTCOMES) {
      const e = explainOutcome(outcome);
      expect(e.label.length).toBeGreaterThan(2);
      expect(e.reason.length).toBeGreaterThan(20);
      expect(`${e.summary} ${e.reason}`).not.toMatch(/\b(rpc|sql|uuid|trigger|gate a|outbox)\b/i);
    }
  });
  it("tells the studio what to do when setup is missing", () => {
    expect(explainOutcome("no_template").nextStep).toMatch(/template|form/i);
    expect(explainOutcome("no_published_version").nextStep).toMatch(/publish/i);
    expect(explainOutcome("studio_not_enabled").tone).toBe("attention");
  });
  it("points to manual intake for the owner-decided exclusions", () => {
    for (const o of ["imported_source", "before_enablement", "existing_student"] as const) expect(explainOutcome(o).nextStep).toMatch(/manually/i);
    expect(explainOutcome("existing_student").reason).toMatch(/partner/i);
  });
  it("states the qualification rules including no back-fill, group classes, imports, leads and partners", () => {
    const text = QUALIFICATION_RULES.join(" ").toLowerCase();
    for (const phrase of ["group classes", "back-filled", "imported", "leads", "partner"]) expect(text).toContain(phrase);
  });
});

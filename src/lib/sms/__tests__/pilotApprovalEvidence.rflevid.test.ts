import { describe, expect, it } from "vitest";
import {
  APPROVAL_REF_MAX, APPROVAL_REF_MIN, approvalRefInRange, documentRefValid, EVIDENCE_MAX_AGE_DAYS, usdToCents, validatePilotEvidence, type PilotEvidenceInput,
} from "../pilotApprovalEvidence";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const ok = (over: Partial<PilotEvidenceInput> = {}): PilotEvidenceInput => ({
  authorizedOn: "2026-10-20", authorizedByRole: "owner_written", scope: "pilot_period_cover", amountCents: 2500, periodKey: "2026-10", documentRef: "AUTH-DOC-0001", documentSha256: "c".repeat(64), ...over,
});

describe("pilot approval evidence (shared module)", () => {
  it("reference boundaries 9 / 10 / 120 / 121 / 200 / 201", () => {
    expect([APPROVAL_REF_MIN, APPROVAL_REF_MAX]).toEqual([10, 200]);
    for (const [n, want] of [[9, false], [10, true], [120, true], [121, true], [200, true], [201, false]] as const) expect(approvalRefInRange("x".repeat(n))).toBe(want);
    expect(approvalRefInRange("  " + "x".repeat(9) + "  ")).toBe(false); // trimmed, like btrim
    expect(approvalRefInRange("  " + "x".repeat(10) + "  ")).toBe(true);
  });

  it("dollars to cents", () => {
    expect([usdToCents("25"), usdToCents("25.0"), usdToCents("25.00"), usdToCents("0.5"), usdToCents("1.05")]).toEqual([2500, 2500, 2500, 50, 105]);
    for (const bad of ["", "-1", "1.234", "1,000", "abc", "1e3", " "]) expect(usdToCents(bad)).toBeNull();
  });

  it("document reference: opaque id or plain https link only", () => {
    for (const good of ["AUTH-DOC-0001", "doc:2026/10#a", "https://example.com", "https://docs.example.com/a/b.pdf"]) expect(documentRefValid(good), good).toBe(true);
    for (const bad of ["short", "has space here", "http://example.com/x", "https://example.com/x?t=1", "https://u:p@example.com/x", "-lead-hyphen-id", "a".repeat(501)]) {
      expect(documentRefValid(bad), bad).toBe(false);
    }
  });

  it("a valid input passes and is normalized", () => {
    const r = validatePilotEvidence(ok(), "2026-10", NOW);
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ amountCents: 2500, periodKey: "2026-10", authorizedByRole: "owner_written" }) });
  });

  it("date window: today and tomorrow pass, the day after tomorrow fails; 400 days passes, 401 fails", () => {
    const d = (off: number) => new Date(NOW + off * 86_400_000).toISOString().slice(0, 10);
    expect(validatePilotEvidence(ok({ authorizedOn: d(0) }), "2026-10", NOW).ok).toBe(true);
    expect(validatePilotEvidence(ok({ authorizedOn: d(1) }), "2026-10", NOW).ok).toBe(true);
    expect(validatePilotEvidence(ok({ authorizedOn: d(2) }), "2026-10", NOW).ok).toBe(false);
    expect(validatePilotEvidence(ok({ authorizedOn: d(-EVIDENCE_MAX_AGE_DAYS) }), "2026-10", NOW).ok).toBe(true);
    expect(validatePilotEvidence(ok({ authorizedOn: d(-EVIDENCE_MAX_AGE_DAYS - 1) }), "2026-10", NOW).ok).toBe(false);
    for (const bad of ["", "20261020", "2026-13-01", "2026-02-30"]) expect(validatePilotEvidence(ok({ authorizedOn: bad }), "2026-10", NOW).ok, bad).toBe(false);
  });

  it("refuses wrong role, scope, period, amount, sha", () => {
    const cases: Partial<PilotEvidenceInput>[] = [
      { authorizedByRole: "policy_lapse" }, { authorizedByRole: "" }, { scope: "x" }, { periodKey: "2026-11" }, { amountCents: 0 }, { amountCents: "12.5" }, { documentSha256: "A".repeat(64) },
      { documentSha256: "a".repeat(63) },
    ];
    for (const over of cases) expect(validatePilotEvidence(ok(over), "2026-10", NOW).ok, JSON.stringify(over)).toBe(false);
  });
});

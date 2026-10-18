import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../actions", () => ({ runSmsOnboardingAction: vi.fn(), setSmsOnboardingAccessAction: vi.fn(), setSmsRunnerWindowAction: vi.fn() }));

import SmsOnboardingPilot from "../SmsOnboardingPilot";
import SmsStepEvidence, { parseEvaluationNote } from "../SmsStepEvidence";

const STUDIO = "a5700000-0000-4000-8000-00000000000a";
const ADMIN = "a5700000-0000-4000-8000-000000000401";
const status = {
  onboarding_id: "onb", state: "profile_review", step: "T5", submission_seq: 2, ein_on_file: true, leased: false, brand_status: null,
  steps: [
    { step_key: "S10", status: "succeeded", fee_bearing: false, fee_confirmed: false, error_code: null, evaluation_verdict: "compliant" },
    { step_key: "S11", status: "succeeded", fee_bearing: false, fee_confirmed: false, error_code: null },
    { step_key: "T5", status: "failed", fee_bearing: false, fee_confirmed: false, error_code: "noncompliant", evaluation_verdict: "noncompliant" },
  ],
  confirmations: [{ step_key: "S11", confirmed_by: ADMIN, confirmed_at: "2026-10-18T10:00:00Z", consumed: true }, { step_key: "T6", confirmed_by: ADMIN, confirmed_at: "2026-10-18T10:05:00Z", consumed: false }],
  evaluations: [
    { at: "2026-10-18T09:59:00Z", note: "step=S10;verdict=compliant;context=preverify;seq=2" },
    { at: "2026-10-18T09:00:00Z", note: "step=T5;verdict=unrecognized;context=step;seq=2" },
    { at: "2026-10-18T08:00:00Z", note: "<script>alert(1)</script>" },
  ],
} as never;
const text = (markup: string) => markup.replace(/<!-- -->/g, "");
const html = text(renderToStaticMarkup(createElement(SmsStepEvidence, { status })));

describe("TW-4F-1b: the read-only step evidence panel", () => {
  it("shows each step with its status, evaluation verdict and code", () => {
    expect(html).toContain("Steps and evidence (attempt 2, 3 steps recorded)");
    expect(html).toContain("S10 Evaluate profile");
    expect(html).toContain("Compliant");
    expect(html).toContain("Not compliant");
    expect(html).toContain("noncompliant");
    expect(html).toContain("S11 SUBMIT profile for review");
  });
  it("shows who confirmed each irreversible submission, shortened, and whether it was used", () => {
    expect(html).toContain("SUBMIT profile for review: confirmed");
    expect(html).toContain("by admin …000401");
    expect(html).not.toContain(ADMIN);
    expect(html).toContain("used");
    expect(html).toContain("not used (expires after 15 minutes)");
  });
  it("shows recent evaluations including the fresh re-check, and ignores anything that is not a well-formed evidence note", () => {
    expect(html).toContain("fresh re-check before a submission");
    expect(html).toContain("Not recognized (treated as not compliant)");
    expect(html).not.toContain("alert(1)");
    expect(parseEvaluationNote("step=S10;verdict=compliant;context=step;seq=1")).toEqual({ step: "S10", verdict: "compliant", context: "step", seq: 1 });
    for (const bad of ["", "step=S11;verdict=compliant;context=step;seq=1", "step=S10;verdict=great;context=step;seq=1", "step=S10;verdict=compliant;context=step;seq=x", "x step=S10;verdict=compliant;context=step;seq=1"]) {
      expect(parseEvaluationNote(bad)).toBeNull();
    }
  });
  it("has empty states and offers no action (no form, no button)", () => {
    const empty = text(renderToStaticMarkup(createElement(SmsStepEvidence, { status: { ...(status as object), steps: [], confirmations: [], evaluations: [] } as never })));
    expect(empty).toContain("Nothing has run for this attempt yet.");
    expect(empty).toContain("None confirmed for this attempt.");
    expect(empty).toContain("No evaluation recorded yet.");
    expect(html).not.toMatch(/<form|<button|<input/);
  });
  it("contains no business data: no EIN, email, address or Twilio identifier shapes", () => {
    expect(html).not.toMatch(/\b[A-Z]{2}[0-9a-f]{32}\b/);
    expect(html).not.toMatch(/@|\d{2}-\d{7}/);
  });
});

describe("TW-4F-1b: the evidence appears in the platform panel only where it exists", () => {
  const row = { studioId: STUDIO, studioName: "Harbor Dance", submissionSeq: 2, submittedAt: "2026-10-15T12:00:00Z", updatedAt: null, einStored: true, accessEnabled: true, state: "profile_review" };
  const render = (evidence: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(SmsOnboardingPilot, { studios: [{ id: STUDIO, name: "Harbor Dance" }], rows: [row] as never, unavailable: false, notice: false, error: null, evidence: evidence as never }));
  it("renders the evidence under the studio row", () => {
    expect(render({ [STUDIO]: status })).toContain("Steps and evidence");
  });
  it("renders nothing extra when there is no evidence (or it could not be loaded)", () => {
    expect(render({})).not.toContain("Steps and evidence");
    expect(renderToStaticMarkup(createElement(SmsOnboardingPilot, { studios: [], rows: [row] as never, unavailable: false, notice: false, error: null }))).not.toContain("Steps and evidence");
  });
});

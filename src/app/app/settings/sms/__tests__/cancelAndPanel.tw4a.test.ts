import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../actions", () => ({ saveSmsSetupAction: vi.fn(), submitSmsSetupAction: vi.fn(), cancelSmsSetupAction: vi.fn() }));
vi.mock("@/app/platform/sms/actions", () => ({ setSmsOnboardingAccessAction: vi.fn(), runSmsOnboardingAction: vi.fn(), setSmsRunnerWindowAction: vi.fn() }));

import SmsCancelSetup from "../SmsCancelSetup";
import SmsOnboardingPilot from "@/app/platform/sms/SmsOnboardingPilot";

describe("cancel control", () => {
  it("starts collapsed: a single quiet action, no destructive control until the owner asks", () => {
    const html = renderToStaticMarkup(createElement(SmsCancelSetup, { submitted: false }));
    expect(html).toContain("Cancel setup");
    expect(html).not.toContain("Yes, cancel setup");
    expect(html).not.toContain("EIN will be removed");
  });
});

describe("platform oversight rows", () => {
  const base = { studioId: "a5700000-0000-4000-8000-00000000000a", studioName: "Harbor Dance", submissionSeq: 1, submittedAt: "2026-10-15T12:00:00Z", updatedAt: null, einStored: true };
  const render = (rows: unknown[]) =>
    renderToStaticMarkup(createElement(SmsOnboardingPilot, { studios: [{ id: base.studioId, name: "Harbor Dance" }], rows: rows as never, unavailable: false, notice: false, error: null }));
  it("shows a paused setup as Off (setup paused)", () => {
    const html = render([{ ...base, accessEnabled: false, state: "submitted_for_checks" }]);
    expect(html).toContain("Off (setup paused)");
  });
  it("a switch that is off with nothing started is just Off", () => {
    const html = render([{ ...base, accessEnabled: false, state: null, einStored: false, submittedAt: null }]);
    expect(html).toContain(">Off<");
    expect(html).not.toContain("paused");
  });
  it("flags states that need DanceFlow attention", () => {
    for (const state of ["needs_info", "blocked", "exception", "suspended"]) {
      expect(render([{ ...base, accessEnabled: true, state }])).toContain("Needs attention");
    }
    for (const state of ["draft", "brand_pending", "active"]) {
      expect(render([{ ...base, accessEnabled: true, state }])).not.toContain("Needs attention");
    }
  });
});

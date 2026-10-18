import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../actions", () => ({ runSmsOnboardingAction: vi.fn(), setSmsOnboardingAccessAction: vi.fn(), setSmsRunnerWindowAction: vi.fn() }));

import SmsCampaignPackage from "../SmsCampaignPackage";
import SmsOnboardingPilot from "../SmsOnboardingPilot";

const STUDIO = "a5700000-0000-4000-8000-00000000000a";
const text = (markup: string) => markup.replace(/<!-- -->/g, "");
const render = (props: Partial<Parameters<typeof SmsCampaignPackage>[0]> = {}) =>
  text(renderToStaticMarkup(createElement(SmsCampaignPackage, { studioName: "Harbor Dance LLC", publicName: "Harbor Dance", slug: "harbor-dance", origin: "https://www.idanceflow.com", ...props })));

describe("TW-4F-2a: the read-only campaign package panel", () => {
  it("shows a passing checklist and the package text built from the public name, slug and template", () => {
    const html = render();
    expect(html).toContain("Campaign package for Twilio pre-review (all checks pass)");
    expect(html).toContain("Pass: Description is 40-4096 characters");
    expect(html).toContain("https://www.idanceflow.com/studios/harbor-dance/sms-terms");
    expect(html).toContain("Harbor Dance uses DanceFlow");
    expect(html).not.toContain("Harbor Dance LLC uses"); // the public name wins over the registered name
  });
  it("reports what to fix when the studio has no slug, and says nothing is sent", () => {
    const html = render({ slug: null });
    expect(html).toMatch(/\(\d+ checks? to fix\)/);
    expect(html).toContain("Fix: The studio has a public page (slug)");
    expect(html).toContain("Nothing is sent to Twilio from here");
  });
  it("offers no action: a read-only text box, no form, no button, no input", () => {
    const html = render();
    expect(html).toContain("readOnly=\"\"");
    expect(html).not.toMatch(/<form|<button|<input/);
  });
  it("contains no EIN, email or Twilio identifier", () => {
    const html = render();
    expect(html).not.toMatch(/\b\d{2}-\d{7}\b|@|\b[A-Z]{2}[0-9a-f]{32}\b/);
  });
});

describe("TW-4F-2a: the package appears in the platform panel only for studios with pilot access", () => {
  const studios = [{ id: STUDIO, name: "Harbor Dance LLC", slug: "harbor-dance", public_name: "Harbor Dance" }];
  const row = { studioId: STUDIO, studioName: "Harbor Dance LLC", submissionSeq: 1, submittedAt: null, updatedAt: null, einStored: false, accessEnabled: true, state: "submitted_for_checks" };
  const panel = (over: Record<string, unknown>) =>
    text(renderToStaticMarkup(createElement(SmsOnboardingPilot, { studios, rows: [{ ...row, ...over }] as never, unavailable: false, notice: false, error: null })));
  it("renders for a studio with access, using that studio's slug and public name", () => {
    const html = panel({});
    expect(html).toContain("Campaign package for Twilio pre-review");
    expect(html).toContain("/studios/harbor-dance/sms-terms");
  });
  it("does not render for a studio whose pilot access is off", () => {
    expect(panel({ accessEnabled: false })).not.toContain("Campaign package for Twilio pre-review");
  });
});

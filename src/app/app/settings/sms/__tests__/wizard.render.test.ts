import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../actions", () => ({
  saveSmsSetupAction: vi.fn(),
  submitSmsSetupAction: vi.fn(),
  cancelSmsSetupAction: vi.fn(),
}));

import SmsSetupWizard, { type WizardCampaignPreview } from "../SmsSetupWizard";
import SmsStatusTracker from "../SmsStatusTracker";
import { buildCampaignPackage } from "@/lib/sms/onboarding/campaignTemplate";
import { emptyDraft } from "@/lib/sms/onboarding/fields";

const pkg = buildCampaignPackage({ displayName: "Harbor Dance", origin: "https://idanceflow.com", slug: "harbor-dance" });
const campaign: WizardCampaignPreview = { description: pkg.description, samples: pkg.samples, termsUrl: pkg.termsUrl, privacyUrl: pkg.privacyUrl, optInPageUrl: pkg.optInPageUrl };

/** The full opening tag of the named input (React's server renderer moves name/value to the end of the tag). */
const inputTag = (html: string, name: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";

const render = (props: Partial<Parameters<typeof SmsSetupWizard>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SmsSetupWizard, {
      initial: { ...emptyDraft(), legal_name: "Harbor Dance Studio LLC", industry: "EDUCATION", website_choice: "danceflow" },
      einOnFile: false,
      einLast4: null,
      canEdit: true,
      highlightFields: [],
      campaign,
      ...props,
    }),
  );

describe("setup wizard", () => {
  it("offers the four steps, the IRS-match warning, and a save/submit path for the owner", () => {
    const html = render();
    for (const label of ["1. Business", "2. Representative", "3. Texting number", "4. Review"]) expect(html).toContain(label);
    expect(html).toContain("exactly as printed on your IRS EIN letter");
    expect(html).toContain("Save draft");
    expect(html).toContain("Submit for review");
    expect(html).not.toContain("Cancel setup"); // cancellation lives in SmsCancelSetup (also available after submission)
    expect(html).toContain("We will pick a local number");
  });
  it("shows the generated campaign text and sample messages for review, with the studio's pages", () => {
    const html = render();
    expect(html).toContain("transactional appointment messages");
    expect(html).toContain("Your private lesson is confirmed");
    expect(html).toContain("Harbor Dance: Reply STOP to opt out");
    expect(html).toContain("/studios/harbor-dance/sms-terms");
    expect(html).toContain("/studios/harbor-dance/sms-privacy");
    expect(html).not.toMatch(/reminder/i);
  });
  it("requires every attestation as an unchecked box", () => {
    const html = render();
    for (const name of ["attest_authorized", "attest_accurate", "attest_opt_in_only", "attest_fees_terms"]) {
      const tag = inputTag(html, name);
      expect(tag).toContain('type="checkbox"');
      expect(tag).not.toContain("checked");
    }
    expect(html).toContain("No marketing");
  });
  it("never shows an EIN: only that one is on file and its last four, and the value is never prefilled", () => {
    const html = render({ einOnFile: true, einLast4: "6789" });
    expect(html).toContain("On file, ending 6789");
    expect(html).not.toMatch(/\d{2}-\d{7}/);
    expect(inputTag(html, "ein")).not.toContain("value=");
  });
  it("without edit rights every input is disabled and there is no submit or cancel", () => {
    const html = render({ canEdit: false });
    expect(html).not.toContain("Submit for review");
    expect(html).not.toContain("Save draft");
    expect(html).not.toContain("Cancel setup");
    expect(html).toContain("Only the studio owner can submit this setup");
    for (const name of ["legal_name", "ein", "rep_email", "preferred_area_code"]) expect(inputTag(html, name)).toContain('disabled=""');
  });
  it("highlights the field Twilio-side checks asked about, and marks it invalid for assistive tech", () => {
    const html = render({ highlightFields: ["rep_email", "ein"] });
    expect(inputTag(html, "rep_email")).toContain('aria-invalid="true"');
    expect(inputTag(html, "ein")).toContain('aria-invalid="true"');
    expect(inputTag(html, "city")).toContain('aria-invalid="false"');
  });
  it("uses plain language: no provider vocabulary and no identifiers anywhere in the markup", () => {
    const html = render();
    expect(html).not.toMatch(/trust ?hub|twilio|\bTCR\b|10DLC|messaging service|\bSID\b|brand registration/i);
  });
});

describe("status tracker", () => {
  it("shows the five steps with a screen-reader status for each", () => {
    const html = renderToStaticMarkup(createElement(SmsStatusTracker, { state: "brand_pending", textingOn: false }));
    for (const label of ["Business verification", "Brand approval", "Campaign approval", "Number ready", "Turn on texting"]) expect(html).toContain(label);
    expect(html).toContain("complete");
    expect(html).toContain("in progress");
    expect(html).toContain("Brand review");
  });
  it("says texting is on only when the registration is approved", () => {
    expect(renderToStaticMarkup(createElement(SmsStatusTracker, { state: "active", textingOn: true }))).toContain("Texting is on");
    expect(renderToStaticMarkup(createElement(SmsStatusTracker, { state: "ready_for_activation", textingOn: false }))).not.toContain("Texting is on</h2>");
  });
  it("copy never mentions provider terms", () => {
    for (const state of ["draft", "needs_info", "blocked", "exception", "suspended"] as const) {
      expect(renderToStaticMarkup(createElement(SmsStatusTracker, { state, textingOn: false }))).not.toMatch(/twilio|trust ?hub|\bSID\b/i);
    }
  });
});

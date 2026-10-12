import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 10C.5 defect found in browser QA: the footer's Continue button and the Review step's submit button rendered in the
 * same slot without keys, so React reused one DOM node. The click that moved to Review turned that node into
 * type="submit" mid-event and the browser submitted the form, creating the draft before Review was confirmed.
 * Covered end-to-end by e2e/tests/competition-setup-registration-isolation.spec.ts; this guards the source.
 */

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const WIZARD = readFileSync(join(ROOT, "src/app/app/events/[id]/competition/new/CompetitionSetupWizard.tsx"), "utf8");

describe("wizard footer: Continue never becomes the submit button", () => {
  it("gives the submit and Continue buttons distinct keys", () => {
    const submit = WIZARD.indexOf('key="create-draft"');
    const proceed = WIZARD.indexOf('key="continue"');
    expect(submit).toBeGreaterThan(-1);
    expect(proceed).toBeGreaterThan(-1);
    expect(WIZARD.slice(submit, submit + 80)).toContain('type="submit"');
    expect(WIZARD.slice(proceed, proceed + 80)).toContain('type="button" onClick={next}');
  });

  it("has exactly one submit button, shown only on Review", () => {
    expect(WIZARD.match(/^\s+type="submit"$/gm)?.length).toBe(1);
    const review = WIZARD.indexOf("{isReview ? (");
    expect(review).toBeGreaterThan(-1);
    expect(WIZARD.search(/^\s+type="submit"$/m)).toBeGreaterThan(review);
  });
});

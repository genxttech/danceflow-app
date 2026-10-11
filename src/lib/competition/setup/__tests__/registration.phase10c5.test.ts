import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 10C.5 Registration step guidance: the account benefit is stated as PLANNED (results and judges' feedback
 * in the competitor portal are not built yet), what works today is labelled separately, the account
 * requirement stays organizer-configurable, and competition registration is never presented as studio
 * lead/client conversion.
 */

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const WIZARD = read("src/app/app/events/[id]/competition/new/CompetitionSetupWizard.tsx");

describe("Registration step guidance", () => {
  it("explains the account benefit and marks it as planned", () => {
    expect(WIZARD).toContain(
      "A DanceFlow account allows competitors to receive released competition results and judges&apos; feedback directly in their personal portal, reducing manual distribution for organizers.",
    );
    const planned = WIZARD.indexOf(">Planned</span>");
    const benefit = WIZARD.indexOf("A DanceFlow account allows competitors");
    expect(planned).toBeGreaterThan(-1);
    expect(benefit - planned).toBeLessThan(200);
  });

  it("separates what is available now from what is planned", () => {
    const available = WIZARD.indexOf(">Available now</span>");
    expect(available).toBeGreaterThan(WIZARD.indexOf(">Planned</span>"));
    expect(WIZARD.slice(available, available + 300)).toContain("dancers who register themselves are linked to their own account");
  });

  it("keeps the account requirement organizer-configurable", () => {
    expect(WIZARD).toContain("checked={answers.registration.accountRequired}");
    expect(WIZARD).toContain("setRegistration(current, { accountRequired: changeEvent.target.checked })");
    expect(read("src/app/events/[slug]/competition/register/page.tsx")).toContain("event.account_required_for_registration && !user");
  });

  it("names the registrant types and never presents registration as lead/client conversion", () => {
    expect(WIZARD).toContain("instructors registering students, studios registering several competitors, or parents and guardians");
    expect(WIZARD).toContain("Registering for your competition never makes anyone a lead or client of your studio.");
  });

  it("competition registration code does not create host-studio clients or leads", () => {
    for (const path of [
      "src/app/api/events/[slug]/competition/checkout/route.ts",
      "src/app/events/[slug]/competition/register/page.tsx",
      "src/lib/competition/registrationServer.ts",
    ]) {
      expect(read(path), path).not.toMatch(/from\("(clients|leads)"\)\s*\.(insert|upsert)/);
    }
    const tenC = read("src/lib/supabase/migrations/20261109090000_phase10c_competitor_registration.sql");
    expect(tenC).not.toMatch(/insert into public\.(clients|leads)\b/i);
  });
});

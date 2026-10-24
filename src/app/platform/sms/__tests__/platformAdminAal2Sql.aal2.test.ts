import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Static checks of the (unapplied) TW-4F AAL2 migration and of the challenge page step-up wiring. */
const mig = join(process.cwd(), "src", "lib", "supabase", "migrations");
const up = readFileSync(join(mig, "20261230090000_twilio_platform_admin_aal2.sql"), "utf8");
const down = readFileSync(join(mig, "rollback", "20261230090000_twilio_platform_admin_aal2_rollback.sql"), "utf8");
const page = readFileSync(join(process.cwd(), "src", "app", "(auth)", "platform-mfa", "challenge", "page.tsx"), "utf8");

describe("AAL2 migration", () => {
  it("requires aal2 in the helper and in all three registration policies, keeping the role check", () => {
    expect(up.match(/auth\.jwt\(\) ->> 'aal'/g)?.length).toBe(1 + 4); // helper + select + insert + update(using, check)
    expect(up).toMatch(/_sms_onb_is_platform_admin[\s\S]*platform_role = 'platform_admin'/);
    expect(up.match(/p\.platform_role = 'platform_admin'/g)?.length).toBe(5);
  });
  it("has a rollback that removes the aal2 requirement and is transactional", () => {
    expect(down).not.toMatch(/'aal'/);
    expect(up).toMatch(/^begin;/m);
    expect(down).toMatch(/^begin;/m);
    expect(down.match(/platform_role = 'platform_admin'/g)?.length).toBe(5);
  });
  it("fails loudly on a policy-name mismatch and checks its own result", () => {
    expect(up).not.toMatch(/drop policy if exists/);
    expect(up).toMatch(/TW4F_AAL2_PRECONDITION/);
    expect(up).toMatch(/TW4F_AAL2_POSTCONDITION/);
    const original = readFileSync(join(mig, "20261012090000_smsa2p1_studio_sms_registrations.sql"), "utf8");
    for (const name of up.match(/drop policy "[^"]+"/g) ?? []) expect(original).toContain(name.replace("drop policy ", "create policy "));
  });
  it("does not touch grants (service-role tw4_* functions are unchanged)", () => {
    expect(up).not.toMatch(/\bgrant\b|\brevoke\b/i);
  });
});

describe("challenge page step-up wiring", () => {
  it("lets an aal2 session re-verify only when stepup=1, and validates the return path on both render and submit", () => {
    expect(page).toContain('aalData?.currentLevel === "aal2" && !stepUp');
    expect(page.match(/safePlatformReturnPath\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(page).toContain("redirect(nextPath)");
  });
  it("still requires the platform-admin role for the page and for the verify action", () => {
    expect(page.match(/await requirePlatformAdmin\(\)/g)?.length).toBe(2);
  });
});

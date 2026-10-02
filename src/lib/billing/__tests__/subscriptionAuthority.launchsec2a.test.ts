import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canManageWorkspaceSubscription } from "../subscriptionAuthority";

/** LAUNCH-SEC-2A (#1): one owner-level rule for subscription management. */

describe("canManageWorkspaceSubscription", () => {
  it.each(["studio_owner", "organizer_owner"])("allows %s", (role) => {
    expect(canManageWorkspaceSubscription(role, false)).toBe(true);
  });

  it("allows a platform admin", () => {
    expect(canManageWorkspaceSubscription("platform_admin", true)).toBe(true);
  });

  it.each([
    "studio_admin",
    "front_desk",
    "instructor",
    "independent_instructor",
    "client",
    "organizer_admin",
    "organizer_staff",
    "platform_admin", // the role string alone is not platform authority
    "STUDIO_OWNER",
    "",
    null,
    undefined,
  ])("denies %s", (role) => {
    expect(canManageWorkspaceSubscription(role, false)).toBe(false);
  });

  it.each([
    "src/app/api/billing/checkout/route.ts",
    "src/app/api/billing/portal/route.ts",
    "src/app/app/settings/billing/page.tsx",
  ])("%s uses the shared rule and no local copy", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(source).toMatch(/canManageWorkspaceSubscription\(\s*context\.studioRole/);
    expect(source).not.toMatch(/function canManageBilling\(/);
  });
});

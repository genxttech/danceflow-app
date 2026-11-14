import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Google Play needs a public, sign-in-free URL that explains account deletion. */

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const page = read("src", "app", "account-deletion", "page.tsx").replace(/\s+/g, " ");

describe("public account-deletion page", () => {
  it("is a public page: no auth, session or redirect", () => {
    expect(page).not.toMatch(/redirect\(|requireUser|getUser|createClient|cookies\(/);
    expect(page).toContain("PublicShell");
    expect(page).toContain('canonical: "/account-deletion"');
  });

  it("explains the in-app path and the email path", () => {
    expect(page).toContain("Delete Account");
    expect(page).toContain("Settings");
    expect(page).toContain("mailto:support@idanceflow.com");
  });

  it("says what is removed and what may be kept", () => {
    expect(page).toContain("What is removed");
    expect(page).toContain("What may be kept");
    expect(page).toContain("cannot be undone");
  });

  it("matches the in-app deletion copy (settings screen and its confirmation)", () => {
    const settings = read("mobile", "student", "app", "settings.tsx");
    expect(settings).toContain("Delete Account");
    expect(settings).toContain("Studios may retain");
  });

  it("is crawlable: /account is disallowed by prefix, so robots must allow this longer path", () => {
    const robots = read("src", "app", "robots.ts");
    expect(robots).toContain('"/account"');
    expect(robots).toContain('allow: ["/", "/account-deletion"]');
  });

  it("is listed in the sitemap", () => {
    expect(read("src", "app", "sitemap.ts")).toContain("/account-deletion");
  });
});

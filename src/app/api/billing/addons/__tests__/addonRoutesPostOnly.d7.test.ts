import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D7 release security fix: the add-on billing routes used to export a GET that forwarded to POST, so a logged-in studio
 * owner who followed a cross-site link (top-level navigation carries Lax cookies) could add or remove a paid subscription
 * item. They are POST-only now; the billing page posts forms. A route without a GET handler answers 405 in Next.js.
 */
const ROUTES = [
  "ai/checkout",
  "ai/remove",
  "organizer-suite/checkout",
  "organizer-suite/remove",
].map((name) => `src/app/api/billing/addons/${name}/route.ts`);

describe("add-on billing routes are POST-only", () => {
  it.each(ROUTES)("%s exports POST and no GET/HEAD handler, and never branches on a GET request", (file) => {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    expect(source).toMatch(/export async function POST\(/);
    expect(source).not.toMatch(/export\s+(async\s+)?function\s+(GET|HEAD)\b/);
    expect(source).not.toMatch(/export\s+const\s+(GET|HEAD)\b/);
    expect(source).not.toMatch(/export\s*\{[^}]*\b(GET|HEAD)\b/);
    expect(source).not.toMatch(/request\.method === "GET"/);
  });

  it("the billing page posts every add-on action as a form", () => {
    const page = readFileSync(path.join(process.cwd(), "src/app/app/settings/billing/page.tsx"), "utf8");
    const forms = [...page.matchAll(/action="\/api\/billing\/addons\/([a-z-/]+)"\s+method="post"/g)].map((m) => m[1]);
    expect(forms.sort()).toEqual(["ai/checkout", "ai/remove", "organizer-suite/checkout", "organizer-suite/remove"]);
    expect(page).not.toMatch(/href=\{?["'`]\/api\/billing\/addons/);
  });
});

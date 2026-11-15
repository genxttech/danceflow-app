import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/*
  A load failure must always offer "Try again": only 7 screens have pull to refresh, and a screen reader
  user cannot discover it, so without a button an offline failure ends with "go back and reopen".
  ErrorStates that report an action (saving, checkout, signing, location) are not load failures and may
  stay without a retry; list them here on purpose.
*/
const ACTION_ERRORS = new Set([
  "Location",
  "Settings update",
  "Saved events",
  "Discovery update",
  "Checkout needs attention",
  "Signing needs attention",
  "Request slots unavailable",
  "Content needs attention",
]);

const root = join(__dirname, "..", "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" ? [] : walk(p);
    return /\.tsx$/.test(name) ? [p] : [];
  });

describe("state coverage", () => {
  const files = [...walk(join(root, "app")), ...walk(join(root, "src", "components"))];

  it("every load-failure ErrorState has a Try again action", () => {
    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(/<ErrorState\b([\s\S]*?)\/>/g)) {
        const attrs = match[1];
        const title = /title="([^"]+)"/.exec(attrs)?.[1] ?? "(dynamic title)";
        if (!/onRetry=/.test(attrs) && !ACTION_ERRORS.has(title)) missing.push(`${file.slice(root.length + 1)}: ${title}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the Today and Saved screens show a failed load instead of an empty state", () => {
    const home = readFileSync(join(root, "app", "(tabs)", "home.tsx"), "utf8");
    expect(home).toMatch(/loadError \? \(\s*<ErrorState[^>]*onRetry=/);
    const favorites = readFileSync(join(root, "app", "favorites.tsx"), "utf8");
    expect(favorites).toMatch(/<ErrorState error=\{message\} onRetry=/);
  });
});

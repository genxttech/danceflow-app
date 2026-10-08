import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard: the New Client page rendered a visible "\n" around the "Personal details" and "Client photo"
 * sections because an editing artifact left the two characters backslash + n between JSX tags (JSX renders them as
 * text). Any `>` followed by a literal backslash-n and then whitespace and markup/text is that artifact.
 */

const ARTIFACT = />\\n\s+[<A-Za-z{]/;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && !entry.name.startsWith(".")) out.push(...tsxFiles(path));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

describe("no literal \\n artifacts between JSX tags", () => {
  it("the New Client page no longer renders a literal \\n around Personal details / Client photo", () => {
    const source = readFileSync("src/app/app/clients/new/page.tsx", "utf8");
    expect(source.includes("\\n")).toBe(false);
    expect(source).toMatch(/<summary[^>]*>\s*Personal details <span/);
    expect(source).toMatch(/<summary[^>]*>\s*Client photo <span/);
  });

  it("no .tsx file under src contains the artifact", () => {
    const offenders = tsxFiles("src").filter((file) => ARTIFACT.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "..");
const sources = readdirSync(dir).filter((f) => f.endsWith(".ts"));

describe("F1 engines are pure and implement only the approved Studio methods", () => {
  it.each(sources)("%s reads no clock, randomness, network, database or I/O", (file) => {
    const text = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [/\bDate\b/, /Math\.random/, /performance\.now/, /\bfetch\s*\(/, /supabase/i, /process\.env/, /\bfs\b/, /crypto\.random/, /setTimeout/]) {
      expect(text).not.toMatch(forbidden);
    }
    // the only allowed import outside the engines directory is the K0 contract
    for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
      expect(["node:crypto", "../contract"].includes(m[1]) || m[1].startsWith("./")).toBe(true);
    }
  });

  it("no governing-body or proficiency engine is present", () => {
    expect(sources.filter((f) => /ucwdc|ndca|wsdc|proficien/i.test(f))).toEqual([]);
  });
});

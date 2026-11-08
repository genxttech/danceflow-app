import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manifest } from "../../d24-m3d-proof/manifest";
import { AUTHORIZATION_PHRASE } from "../../d24-m3d-proof/identity";
import { CHECKS, MUTATIONS, ROOT, load, readWorkflow } from "./workflowChecks";

const base = readWorkflow();

describe("d24-stripe-test-proof.yml (static)", () => {
  for (const [name, check] of Object.entries(CHECKS)) {
    it(`protection present: ${name}`, () => {
      expect(check(base)).toBe(true);
    });
  }

  it("pins the harness manifest hash that the harness itself computes today (31 files)", () => {
    const m = manifest(join(ROOT, "scripts", "qa", "d24-m3d-proof"));
    expect(load(base).env?.D24_PINNED_MANIFEST_SHA256).toBe(m.sha256);
    expect(m.files.length).toBe(31);
  });

  it("hard-codes the harness's own approval sentence", () => {
    expect(load(base).env?.D24_APPROVAL_PHRASE).toBe(AUTHORIZATION_PHRASE);
  });

  it("ships with unfilled account ids and a placeholder evidence key (so it cannot run yet)", () => {
    const w = load(base);
    expect(w.env?.D24_PLATFORM_ACCT_PIN).toContain("PLACEHOLDER");
    expect(w.env?.D24_CONNECTED_ACCT_PIN).toContain("PLACEHOLDER");
    expect(readFileSync(join(ROOT, "scripts", "qa", "d24-github-proof", "evidence-public-key.pem"), "utf8")).toContain("D24-EVIDENCE-PUBLIC-KEY-PLACEHOLDER");
  });

  it("CODEOWNERS covers the proof workflow, harness, decrypt tool and evidence key for @genxttech", () => {
    const co = readFileSync(join(ROOT, ".github", "CODEOWNERS"), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    const owns = (p: string) => co.some((l) => l.startsWith(p + " ") && l.includes("@genxttech"));
    expect(owns("/.github/workflows/d24-*")).toBe(true);
    expect(owns("/scripts/qa/d24-m3d-proof/")).toBe(true);
    expect(owns("/scripts/qa/d24-github-proof/")).toBe(true); // holds the decrypt tool and evidence-public-key.pem
    expect(owns("/.github/CODEOWNERS")).toBe(true);
  });

  it("the new test directory is in the vitest include list", () => {
    expect(readFileSync(join(ROOT, "vitest.config.mts"), "utf8")).toContain("scripts/qa/d24-github-proof/__tests__/**/*.test.ts");
  });
});

describe("mutation checks: removing a protection makes the matching assertion fail", () => {
  it("every check is covered by at least one mutation", () => {
    const covered = new Set(MUTATIONS.map((m) => m.breaks));
    for (const name of Object.keys(CHECKS)) expect(covered.has(name), `no mutation for ${name}`).toBe(true);
  });
  for (const m of MUTATIONS) {
    it(`${m.name} -> ${m.breaks} fails`, () => {
      expect(CHECKS[m.breaks]).toBeTypeOf("function");
      const mutated = m.apply(base);
      expect(mutated).not.toBe(base);
      expect(CHECKS[m.breaks](mutated)).toBe(false);
    });
  }
});

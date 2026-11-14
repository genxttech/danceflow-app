import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CF1_QA_DB_CONTAINER, pinnedQaDbContainer } from "../../../e2e/helpers/qaDbContainer";
import { hasLocalPath, relativeInside, scrubString, scrubValue } from "../../../e2e/tools/path-scrub.mjs";

const root = path.resolve(__dirname, "..", "..", "..");
const read = (...p: string[]) => readFileSync(path.join(root, ...p), "utf8");

describe("harness container pin (review P2/P3)", () => {
  it("accepts only the dedicated CF1-C QA stack by exact name", () => {
    expect(pinnedQaDbContainer({ E2E_LOCAL_DB_CONTAINER: CF1_QA_DB_CONTAINER })).toBe("supabase_db_cf1c-qa");
    for (const other of ["supabase_db_danceflow-e2e-qa", "supabase_db_cf1c-qa2", "xsupabase_db_cf1c-qa", "supabase_db_", "", "df-d24-qa-43938", "cf1c-pg"]) {
      expect(pinnedQaDbContainer({ E2E_LOCAL_DB_CONTAINER: other }), other).toBeNull();
    }
    expect(pinnedQaDbContainer({})).toBeNull();
  });

  it("the three docker-exec helpers use the pin; none keeps the supabase_db_<anything> allowlist or reads the variable raw", () => {
    expect(read("e2e", "helpers", "cf1Acceptance.ts")).toContain('name !== "supabase_db_cf1c-qa"');
    for (const file of ["cf1Acceptance.ts", "competitionFullEventFixture.ts", "competitionScheduleHeats.ts"]) {
      expect(read("e2e", "helpers", file), file).not.toContain("supabase_db_[a-z0-9-]+");
    }
    for (const file of ["competitionFullEventFixture.ts", "competitionScheduleHeats.ts"]) {
      expect(read("e2e", "helpers", file), file).not.toMatch(/process\.env\.E2E_LOCAL_DB_CONTAINER \?\? ""/);
    }
    expect(read("e2e", "helpers", "competitionFullEventFixture.ts")).toContain("pinnedQaDbContainer()");
    const heats = read("e2e", "helpers", "competitionScheduleHeats.ts");
    expect(heats.match(/pinnedQaDbContainer\(\)/g)?.length).toBe(2);
  });
});

describe("local paths stay out of committed QA evidence", () => {
  it("relativises inside the run directory and reduces anything else to <local>/<name>", () => {
    const BS = String.fromCharCode(92);
    const run = path.resolve(root, "..", "scratch-of-someone", "runs", "r1");
    expect(relativeInside(run, path.join(run, "artifacts", "t", "trace.zip"))).toBe("artifacts/t/trace.zip");
    expect(relativeInside(run, path.join(run, "..", "other", "x.png"))).toBeNull();
    expect(scrubString(path.join(run, "artifacts", "a.png"), run)).toBe("artifacts/a.png");
    expect(scrubString(["C:", "Users", "someone", "AppData", "Local", "Temp", "secret-name", "file.txt"].join(BS))).toBe("<local>/file.txt");
    expect(scrubString("/Users/someone/work/project/out.json")).toBe("<local>/out.json");
    expect(scrubString("C:/Users/x/scratchpad/runs/2026-1/artifacts/a/b.png")).toBe("runs/2026-1/artifacts/a/b.png");
    expect(scrubString("expected 3 got 4 at /app/events/123")).toBe("expected 3 got 4 at /app/events/123");
  });
  it("scrubs deeply and reports leftovers", () => {
    const value = scrubValue({ a: [["C:", "Users", "m", "x", "y.png"].join(String.fromCharCode(92)), { b: "see /home/m/z/w.txt now" }], n: 3 });
    expect(JSON.stringify(value)).not.toMatch(/Users|home/);
    expect(hasLocalPath(JSON.stringify(value))).toBe(false);
    expect(hasLocalPath("C:/Users/m/q.png")).toBe(true);
  });
  it("no committed docs/qa/*.json carries an absolute local path", () => {
    const dir = path.join(root, "docs", "qa");
    const offenders = readdirSync(dir).filter((f) => f.endsWith(".json")).filter((f) => hasLocalPath(readFileSync(path.join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
  it("no tracked docs/qa file (md, sh, mjs, tsv, out, ...) carries a local path, the machine user name or AppData", () => {
    const files = execFileSync("git", ["ls-files", "docs/qa"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => hasLocalPath(readFileSync(path.join(root, f), "utf8")));
    expect(offenders).toEqual([]);
    expect(hasLocalPath("source /c/Dev/qa-run/evidence/rb4.sh")).toBe(true);
    expect(hasLocalPath("worktree <worktrees>/studioapp-cf1-int3 and $QA_RUN/evidence")).toBe(false);
  });
  it("both Playwright configs call the run-directory guard and the old name-based check is gone", () => {
    for (const file of ["playwright.acceptance.config.ts", "playwright.cf1.config.ts"]) {
      const text = read("e2e", file);
      expect(text, file).toContain("assertRunDirOutsideRepo(runDir,");
      expect(text, file).not.toContain("studioapp-qa");
    }
  });
});

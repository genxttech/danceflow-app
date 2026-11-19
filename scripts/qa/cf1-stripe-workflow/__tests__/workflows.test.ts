import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural tripwires for the two Competition Stripe TEST workflows (competition-stripe-canary.yml, competition-stripe-test-acceptance.yml).
 * They run in ordinary CI, never with a secret. A reviewed change to a workflow that breaks one of these rules must change the test in the same PR,
 * so the owner sees it in the diff. Same approach as the D24 workflow test.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const yaml = createRequire(import.meta.url)("js-yaml") as { load(s: string): unknown };

type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { if?: string; "runs-on"?: string; "timeout-minutes"?: number; environment?: unknown; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] };
type Wf = { on: Record<string, unknown>; permissions?: Record<string, string>; concurrency?: { group?: string; "cancel-in-progress"?: boolean }; env?: Record<string, string>; jobs: Record<string, Job> };

const SECRET = "CF1_STRIPE_TEST_SECRET_KEY";
const FILES = [
  { file: "competition-stripe-canary.yml", job: "canary", maxMinutes: 20, secretSteps: ["Stripe guard"], group: "competition-stripe-test-canary" },
  { file: "competition-stripe-test-acceptance.yml", job: "acceptance", maxMinutes: 90, secretSteps: ["Stripe guard", "Build and start the app"], group: "competition-stripe-test-acceptance" },
] as const;

for (const spec of FILES) {
  const text = readFileSync(join(REPO, ".github", "workflows", spec.file), "utf8");
  const doc = yaml.load(text) as Wf;
  const job = doc.jobs[spec.job];
  const code = text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

  describe(spec.file, () => {
    it("the only trigger is workflow_dispatch, with no inputs; no other trigger name appears outside comments", () => {
      expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
      const wd = doc.on.workflow_dispatch;
      expect(wd === null || (typeof wd === "object" && Object.keys(wd as object).length === 0)).toBe(true);
      for (const bad of ["pull_request_target", "pull_request", "push:", "schedule", "workflow_run", "repository_dispatch", "issue_comment", "workflow_call", "release:"]) expect(code).not.toContain(bad);
    });

    it("one job, bound to the protected competition-stripe-test environment, for a manual dispatch of main in the real repository", () => {
      expect(Object.keys(doc.jobs)).toEqual([spec.job]);
      const env = job.environment;
      expect(typeof env === "string" ? env : (env as { name?: string })?.name).toBe("competition-stripe-test");
      expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
      expect(job.if).toContain("github.repository == 'genxttech/danceflow-app'");
      expect(job.if).toContain("github.ref == 'refs/heads/main'");
      expect(job.if).not.toMatch(/\|\|/);
    });

    it("pinned runner, bounded timeout, single-flight, read-only token", () => {
      expect(job["runs-on"]).toBe("ubuntu-24.04");
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
      expect(job["timeout-minutes"]).toBeLessThanOrEqual(spec.maxMinutes);
      expect(doc.concurrency?.group).toBe(spec.group);
      expect(doc.concurrency?.["cancel-in-progress"]).toBe(false);
      expect(doc.permissions).toEqual({ contents: "read" });
      expect(job.permissions).toEqual({ contents: "read" });
    });

    it("every action is pinned to a full commit SHA", () => {
      const uses = job.steps.map((step) => step.uses).filter(Boolean) as string[];
      expect(uses.length).toBeGreaterThan(0);
      for (const use of uses) expect(use, use).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    });

    it(`the secret ${SECRET} is referenced only in the named steps' env, never at job or workflow level, never in run text`, () => {
      expect(Object.values(doc.env ?? {}).join(" ")).not.toContain(SECRET);
      expect(Object.values(job.env ?? {}).join(" ")).not.toContain(SECRET);
      const holders = job.steps.filter((step) => Object.values(step.env ?? {}).some((value) => String(value).includes(`secrets.${SECRET}`)));
      expect(holders.length).toBeGreaterThan(0);
      for (const step of holders) expect(spec.secretSteps.some((fragment) => (step.name ?? "").includes(fragment)), step.name).toBe(true);
      for (const step of job.steps) expect(step.run ?? "", step.name).not.toContain(`secrets.${SECRET}`);
      expect(code.match(/secrets\./g)?.every(() => true)).toBe(true);
      expect([...code.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).every((name) => name === SECRET)).toBe(true);
    });

    it("nothing echoes, traces or persists the key", () => {
      expect(code).not.toMatch(/set -x|set -o xtrace|xtrace/);
      expect(code).not.toMatch(/echo[^\n]*(KEY|SECRET)/i);
      expect(code).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
      for (const step of job.steps) {
        const run = step.run ?? "";
        if (run.includes("GITHUB_ENV")) expect(run, step.name).not.toMatch(/KEY|SECRET|PASSPHRASE/);
      }
    });

    it("INERT until its pins are real: the pinned commit is a placeholder, and the guards step refuses placeholders", () => {
      expect(job.env?.CF1_PINNED_COMMIT).toMatch(/^PLACEHOLDER|^[0-9a-f]{40}$/);
      const guards = job.steps.find((step) => (step.name ?? "").startsWith("Guards"));
      expect(guards?.run).toContain("*PLACEHOLDER*) echo");
      expect(guards?.run).toContain("exit 1");
      // The guards step is before every step that can use a secret.
      const guardIndex = job.steps.findIndex((step) => (step.name ?? "").startsWith("Guards"));
      const firstSecret = job.steps.findIndex((step) => Object.values(step.env ?? {}).some((value) => String(value).includes("secrets.")));
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(guardIndex).toBeLessThan(firstSecret);
    });

    it("the code under test is fetched by full SHA and must be on the release branch; the sandbox ids are the pinned TEST ids", () => {
      expect(job.env?.CF1_RELEASE_BRANCH).toBe("release/website-embeds");
      expect(job.env?.CF1_EXPECT_PLATFORM_ACCT).toBe("acct_1UZ320IPJs53nwt7");
      expect(job.env?.E2E_STRIPE_TEST_CONNECTED_ACCOUNT).toBe("acct_1UZibNRCFiaIzL1V");
      expect(code).toContain("merge-base --is-ancestor");
      expect(code).toMatch(/\^\[0-9a-f\]\{40\}\$/);
    });
  });
}

describe("canary specifics", () => {
  const text = readFileSync(join(REPO, ".github", "workflows", "competition-stripe-canary.yml"), "utf8");
  const code = text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  it("needs no database, app or suite: no docker, supabase, playwright, next or relay anywhere outside comments", () => {
    for (const word of ["docker", "supabase", "playwright", "next build", "next start", "cf1-stripe-relay", "psql", "pg_dump"]) expect(code).not.toContain(word);
  });
  it("runs exactly the guard script and surfaces a capability STOP (exit 2) without requesting onboarding", () => {
    expect(code).toContain("scripts/qa/cf1-stripe-guard.ts");
    expect(code).toContain('"$rc" = "2"');
    expect(code).toContain("do NOT request sandbox onboarding");
  });
});

describe("acceptance specifics", () => {
  const text = readFileSync(join(REPO, ".github", "workflows", "competition-stripe-test-acceptance.yml"), "utf8");
  const doc = yaml.load(text) as Wf;
  const steps = doc.jobs.acceptance.steps;
  it("the Stripe guard runs before the database and the suite, so a capability error is found first", () => {
    const names = steps.map((step) => step.name ?? "");
    const guard = names.findIndex((n) => n.startsWith("Stripe guard"));
    const database = names.findIndex((n) => n.startsWith("Local database stack"));
    const suite = names.findIndex((n) => n.startsWith("Build and start the app"));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(database);
    expect(database).toBeLessThan(suite);
  });
  it("the database and suite steps are BLOCKED (they fail closed) until D1 is built; changing that is a reviewed change to this test", () => {
    const database = steps.find((step) => (step.name ?? "").startsWith("Local database stack"));
    const suite = steps.find((step) => (step.name ?? "").startsWith("Build and start the app"));
    expect(database?.run).toContain("FAIL: database source not implemented");
    expect(suite?.run).toContain("FAIL: not implemented until the database step exists");
    expect(doc.jobs.acceptance.env?.CF1_DB_SNAPSHOT_SHA256).toMatch(/^PLACEHOLDER/);
  });
  it("evidence is encrypted before upload and plaintext is removed", () => {
    const names = steps.map((step) => step.name ?? "");
    expect(names.findIndex((n) => n.startsWith("Encrypt evidence"))).toBeLessThan(names.findIndex((n) => n.startsWith("Upload the ENCRYPTED")));
    const upload = steps.find((step) => (step.name ?? "").startsWith("Upload the ENCRYPTED"));
    expect(String(upload?.with?.path)).toContain("cf1-evidence.enc.json");
    expect(steps[steps.length - 1].if).toBe("always()");
  });
});

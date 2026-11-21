import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
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
type Job = { if?: string; needs?: string | string[]; outputs?: Record<string, string>; "runs-on"?: string; "timeout-minutes"?: number; environment?: unknown; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] };
type Wf = { "run-name"?: string; on: Record<string, unknown>; permissions?: Record<string, string>; concurrency?: { group?: string; "cancel-in-progress"?: boolean }; env?: Record<string, string>; jobs: Record<string, Job> };

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
    it("the only trigger is workflow_dispatch with exactly one required string input, pin; no other trigger name appears outside comments", () => {
      expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
      const wd = doc.on.workflow_dispatch as { inputs?: Record<string, { required?: boolean; type?: string }> };
      expect(Object.keys(wd.inputs ?? {})).toEqual(["pin"]);
      expect(wd.inputs?.pin?.required).toBe(true);
      expect(wd.inputs?.pin?.type).toBe("string");
      for (const bad of ["pull_request_target", "pull_request", "push:", "schedule", "workflow_run", "repository_dispatch", "issue_comment", "workflow_call", "release:"]) expect(code).not.toContain(bad);
    });

    it("two jobs: validate-pin (no environment) then the job bound to the protected competition-stripe-test environment, both for a manual dispatch of main in the real repository", () => {
      expect(Object.keys(doc.jobs)).toEqual(["validate-pin", spec.job]);
      const v = doc.jobs["validate-pin"];
      expect(v.environment).toBeUndefined();
      for (const j of [v, job]) {
        expect(j.if).toContain("github.event_name == 'workflow_dispatch'");
        expect(j.if).toContain("github.repository == 'genxttech/danceflow-app'");
        expect(j.if).toContain("github.ref == 'refs/heads/main'");
        expect(j.if).not.toContain("||");
      }
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
      expect(doc.jobs["validate-pin"].permissions).toEqual({ contents: "read", "pull-requests": "read" });
      expect(doc.jobs["validate-pin"]["timeout-minutes"]).toBeLessThanOrEqual(10);
    });

    it("every action is pinned to a full commit SHA", () => {
      const uses = [...doc.jobs["validate-pin"].steps, ...job.steps].map((step) => step.uses).filter(Boolean) as string[];
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

    it("the pin is the validated output of validate-pin (never a literal, never the raw input), and the guards step still refuses placeholders and bad shapes", () => {
      expect(job.env?.CF1_PINNED_COMMIT).toBe("${{ needs.validate-pin.outputs.sha }}");
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
  it("uses the runner's installed Chrome for the hosted Checkout payment: fixed path, checked, nothing downloaded, no browser install step", () => {
    expect(code).toContain('CF1_CHROME_PATH: "/usr/bin/google-chrome"');
    expect(code).toContain('[ -x "$CF1_CHROME_PATH" ]');
    for (const word of ["playwright install", "apt-get", "apt install", "sudo", "curl ", "wget "]) expect(code).not.toContain(word);
  });
  it("the Chrome check step never sees the Stripe key", () => {
    const doc2 = yaml.load(text) as Wf;
    const check = doc2.jobs.canary.steps.find((st) => st.name?.startsWith("Check the runner"));
    expect(check).toBeDefined();
    expect(JSON.stringify(check)).not.toContain("secrets.");
    expect(JSON.stringify(check)).not.toContain("STRIPE");
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

for (const spec of FILES) {
  const text = readFileSync(join(REPO, ".github", "workflows", spec.file), "utf8");
  const doc = yaml.load(text) as Wf;
  const validate = doc.jobs["validate-pin"];
  const job = doc.jobs[spec.job];
  const code = text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

  describe(`${spec.file}: pin validation precedes any secret`, () => {
    it("the secret job needs validate-pin (so the environment approval is requested only after validation passed), and validate-pin needs nothing", () => {
      expect(job.needs).toBe("validate-pin");
      expect(validate.needs).toBeUndefined();
    });

    it("validate-pin has no environment, no secret reference, and only the read-only GITHUB_TOKEN (github.token)", () => {
      const body = JSON.stringify(validate);
      expect(validate.environment).toBeUndefined();
      expect(body).not.toContain("secrets.");
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain("STRIPE");
      expect(validate.permissions?.contents).toBe("read");
      expect(Object.values(validate.permissions ?? {}).every((v) => v === "read")).toBe(true);
    });

    it("the validator comes from main at the dispatched commit (github.sha), is not fetched from the pin or a PR, and runs under env -i", () => {
      const fetchStep = validate.steps.find((st) => (st.name ?? "").startsWith("Fetch main"));
      expect(fetchStep?.env?.SHA).toBe("${{ github.sha }}");
      expect(fetchStep?.run).toContain('git fetch -q --no-tags --depth=1 origin "$SHA"');
      expect(JSON.stringify(fetchStep)).not.toContain("inputs.");
      const run = validate.steps.find((st) => st.id === "validate");
      expect(run?.run).toContain("/usr/bin/env -i");
      expect(run?.run).toContain("scripts/qa/cf1-stripe-workflow/validatePin.mjs");
      expect(run?.env).toEqual({ PIN: "${{ inputs.pin }}", GH_TOKEN: "${{ github.token }}" });
      const order = validate.steps.map((st) => st.id ?? st.name ?? "");
      expect(order.findIndex((n) => n.startsWith("Fetch main"))).toBeLessThan(order.indexOf("validate"));
      expect(validate.outputs).toEqual({ sha: "${{ steps.validate.outputs.sha }}" });
    });

    it("the raw input is used only as an env value of the validator step and in run-name; never in run text, never in the secret job", () => {
      const uses = [...code.matchAll(/inputs\.pin/g)].length;
      expect(uses).toBe(2); // run-name + the validator step's PIN env
      expect(doc["run-name"]).toContain("${{ inputs.pin }}");
      for (const st of [...validate.steps, ...job.steps]) expect(st.run ?? "", st.name).not.toMatch(/\$\{\{/);
      expect(JSON.stringify(job)).not.toContain("inputs.");
      expect(code).not.toContain("github.event.inputs");
    });

    it("the secret job re-checks shape and release-branch ancestry and fetches the pin by SHA", () => {
      expect(code).toContain('git -C "$SRC" fetch -q --no-tags --depth=1 origin "$CF1_PINNED_COMMIT"');
      expect(code).toContain("checkout -q --detach FETCH_HEAD");
      expect(code).toContain('[ "$(git -C "$SRC" rev-parse HEAD)" = "$CF1_PINNED_COMMIT" ]');
    });
  });
}

describe("trust root is owner-gated", () => {
  const owners = readFileSync(join(REPO, ".github", "CODEOWNERS"), "utf8").split(/\r?\n/).filter((l) => !l.trim().startsWith("#"));
  it("CODEOWNERS lists /.github/ and the validator directory for the same owner", () => {
    expect(owners).toContain("/.github/ @genxttech");
    expect(owners).toContain("/scripts/qa/cf1-stripe-workflow/ @genxttech");
  });
  it("the validator, its tests and these tripwires live under that directory", () => {
    for (const f of ["validatePin.mjs", "__tests__/validatePin.test.ts", "__tests__/workflows.test.ts"]) expect(existsSync(join(REPO, "scripts", "qa", "cf1-stripe-workflow", f)), f).toBe(true);
  });
  it("the workflows run the validator from that directory", () => {
    for (const spec of FILES) expect(readFileSync(join(REPO, ".github", "workflows", spec.file), "utf8")).toContain("scripts/qa/cf1-stripe-workflow/validatePin.mjs");
  });
});

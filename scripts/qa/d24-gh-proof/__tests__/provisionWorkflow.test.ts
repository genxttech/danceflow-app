import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTHORIZATION_PHRASE, ENV, buildCreateRequest } from "../../d24-test-provision/provision";

// Static assertions about .github/workflows/d24-provision-account.yml. The file is only PARSED, never run.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const WF_DIR = join(REPO, ".github", "workflows");
const NAME = "d24-provision-account.yml";
const yaml = createRequire(import.meta.url)("js-yaml") as { load(s: string): unknown };

type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { if?: string; "runs-on"?: string; "timeout-minutes"?: number; environment?: unknown; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] };
type Wf = { name: string; "run-name"?: string; on: Record<string, unknown>; permissions?: Record<string, string>; concurrency?: { group?: string; "cancel-in-progress"?: boolean }; defaults?: { run?: { shell?: string } }; env?: Record<string, string>; jobs: Record<string, Job> };

const text = readFileSync(join(WF_DIR, NAME), "utf8");
const doc = yaml.load(text) as Wf;
const job = doc.jobs.provision as Job;
const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const idx = (frag: string) => {
  const i = job.steps.findIndex((s) => (s.name ?? "").includes(frag));
  expect(i, `step containing ${JSON.stringify(frag)}`).toBeGreaterThanOrEqual(0);
  return i;
};
const step = (frag: string) => job.steps[idx(frag)] as Step;
const sha256Lf = (rel: string) => createHash("sha256").update(readFileSync(join(REPO, rel), "utf8").replace(/\r\n/g, "\n")).digest("hex");

describe("provisioning workflow: trigger, identity, environment", () => {
  it("the only trigger is workflow_dispatch with no inputs", () => {
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    const wd = doc.on.workflow_dispatch;
    expect(wd === null || (typeof wd === "object" && Object.keys(wd as object).length === 0)).toBe(true);
    for (const bad of ["pull_request_target", "pull_request", "push:", "schedule", "workflow_run", "repository_dispatch", "issue_comment", "workflow_call", "release:"]) expect(code, bad).not.toContain(bad);
  });
  it("one job, bound to the protected d24-stripe-test environment, main only, real repository only", () => {
    expect(Object.keys(doc.jobs)).toEqual(["provision"]);
    const env = job.environment;
    expect(typeof env === "string" ? env : (env as { name?: string })?.name).toBe("d24-stripe-test");
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain("github.repository == 'genxttech/danceflow-app'");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).not.toMatch(/\|\|/);
  });
  it("pinned runner, short timeout, single-flight, read-only token", () => {
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(20);
    expect(doc.concurrency).toEqual({ group: "d24-provision-account", "cancel-in-progress": false });
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read" });
    expect(code).not.toMatch(/id-token|write/);
  });
  it("every `uses:` is pinned to a full commit SHA and there is no artifact upload (nothing leaves the runner)", () => {
    const uses = job.steps.filter((s) => s.uses).map((s) => s.uses as string);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
    expect(code).not.toContain("upload-artifact");
  });
  it("the workflow identity check names this file", () => {
    expect(job.env?.D24_WORKFLOW_REF_EXPECTED).toBe(`genxttech/danceflow-app/.github/workflows/${NAME}@refs/heads/main`);
    expect(step("Guards").run).toContain('[ "$WORKFLOW_REF" = "$D24_WORKFLOW_REF_EXPECTED" ]');
  });
});

describe("provisioning workflow: inert until separately authorized", () => {
  const PLATFORM = "acct_1UZ320IPJs53nwt7"; // owner-supplied D24 sandbox platform (2026-11-08)
  const FORBIDDEN = ["acct_1UWz98RESPl6zEVj" /* D7 sandbox */, "acct_1TKgLCEYYNmPuFIX" /* DEV sandbox */, "acct_1TKgL3EY0sTayNiS" /* live account */];
  it("the pinned platform id is exactly the owner-supplied D24 sandbox, well-formed, and not the D7, DEV or live account", () => {
    expect(job.env?.D24_PROVISION_EXPECT_PLATFORM_ACCT).toBe(PLATFORM);
    expect(PLATFORM).toMatch(/^acct_[A-Za-z0-9]{6,64}$/);
    for (const bad of FORBIDDEN) expect(code).not.toContain(bad);
  });
  it("the guard still refuses a placeholder or malformed platform id and runs before anything is fetched", () => {
    const g = step("Guards").run as string;
    expect(g).toContain("*PLACEHOLDER*");
    expect(g).toContain("^acct_[A-Za-z0-9]{6,64}$");
    expect(g).toContain("exit 1");
    expect(idx("Guards")).toBeLessThan(idx("Fetch exactly"));
  });
  it("the only Stripe account id in the file is that platform id", () => {
    expect([...new Set(code.match(/acct_[A-Za-z0-9]+/g) ?? [])].sort()).toEqual(["acct_PLACEHOLDERCONNECTED", PLATFORM].sort());
  });
  it("without the secret it cannot reach Stripe: the tool refuses a missing or non-restricted key before building a transport", () => {
    expect(readFileSync(join(REPO, "scripts/qa/d24-test-provision/live.ts"), "utf8")).toContain("checkKeyShape(env[ENV.key])");
  });
  it("it is one-shot: its guard refuses once the proof workflow records a real connected account id (as it now does)", () => {
    const f = step("Fetch exactly").run as string;
    expect(f).toContain('grep -q \'D24_PROOF_EXPECT_CONNECTED_ACCT: "acct_PLACEHOLDERCONNECTED"\' .github/workflows/d24-stripe-test-proof.yml');
  });
});

describe("provisioning workflow: the key is separate and used only where needed", () => {
  const KEY = "D24_PROVISION_STRIPE_KEY";
  it("references only the provisioning secret, in exactly one step, as its only env entry besides the run id", () => {
    const secrets = [...code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(secrets).toEqual([KEY]);
    expect(code).not.toContain("D24_PROOF_STRIPE_KEY");
    const holders = job.steps.filter((s) => JSON.stringify(s.env ?? {}).includes("secrets."));
    expect(holders.map((s) => s.name)).toEqual([step("Provision (Stripe TEST").name]);
    expect(Object.keys(step("Provision (Stripe TEST").env ?? {}).sort()).toEqual(["D24_PROVISION_STRIPE_KEY", "RUN_ID"]);
  });
  it("the proof workflow never references the provisioning secret", () => {
    const proof = readFileSync(join(WF_DIR, "d24-stripe-test-proof.yml"), "utf8");
    expect(proof).not.toMatch(/D24_PROVISION/);
  });
  it("no other workflow reaches the environment or any d24 secret", () => {
    for (const f of readdirSync(WF_DIR).filter((n) => /\.ya?ml$/.test(n) && n !== NAME && n !== "d24-stripe-test-proof.yml")) {
      const t = readFileSync(join(WF_DIR, f), "utf8");
      expect(t, f).not.toMatch(/d24-stripe-test/i);
      expect(t, f).not.toMatch(/secrets\.D24/i);
      expect(t, f).not.toMatch(/secrets:\s*inherit/);
    }
  });
  it("the env var names in the workflow match the tool's contract, and the approval sentence equals the tool's constant", () => {
    expect(job.env?.D24_PROVISION_AUTHORIZATION).toBe(AUTHORIZATION_PHRASE);
    const run = step("Provision (Stripe TEST").run as string;
    for (const n of [ENV.key, ENV.platform, ENV.phrase, ENV.envelope, "D24_PROVISION_SUMMARY_FILE"]) expect(run, n).toContain(`${n}=`);
    expect(run).toContain('D24_PROVISION_ENVELOPE_REF="$REF"');
    expect(run).toContain('REF="D24-ENV-$(/usr/bin/date -u +%Y%m%d)-$RUN_ID"');
    expect(run).toContain("scripts/qa/d24-test-provision/live.ts --live");
  });
  it("the key reaches node only through a scrubbed environment and a toolcache node", () => {
    const run = step("Provision (Stripe TEST").run as string;
    expect(run).toContain("/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin");
    expect(run).toContain('NODE="$RUNNER_TOOL_CACHE/node/24.14.1/x64/bin/node"');
    expect(run).not.toMatch(/^\s*(node|npm)\s/m);
    expect(run).not.toMatch(/echo[^\n]*D24_PROVISION_STRIPE_KEY|set -x/);
    expect(job.env?.BASH_ENV).toBe("");
    expect(doc.defaults?.run?.shell?.startsWith("/usr/bin/bash ")).toBe(true);
  });
  it("order: guards < fetch/pins < node < npm ci < dry run < stray-process check < provision < cleanup", () => {
    const order = ["Commit and request plan", "Guards", "Fetch exactly", "Home directory", "Set up Node", "Install dependencies", "Dry run", "No stray processes", "Provision (Stripe TEST", "Remove the home"].map(idx);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(step("Remove the home").if).toBe("always()");
  });
});

describe("provisioning workflow: pins equal the repository", () => {
  const e = () => job.env as Record<string, string>;
  it("harness tree, package.json, package-lock.json and tsconfig.json pins", () => {
    expect(e().D24_PROOF_PINNED_TREE).toBe(execFileSync("git", ["rev-parse", "HEAD:scripts/qa/d24-m3d-proof"], { cwd: REPO, encoding: "utf8" }).trim());
    expect(e().D24_PIN_PACKAGE_JSON_SHA256).toBe(sha256Lf("package.json"));
    expect(e().D24_PIN_PACKAGE_LOCK_SHA256).toBe(sha256Lf("package-lock.json"));
    expect(e().D24_PIN_TSCONFIG_SHA256).toBe(sha256Lf("tsconfig.json"));
    const proof = readFileSync(join(WF_DIR, "d24-stripe-test-proof.yml"), "utf8");
    for (const k of ["D24_PROOF_PINNED_TREE", "D24_PIN_PACKAGE_JSON_SHA256", "D24_PIN_PACKAGE_LOCK_SHA256", "D24_PIN_TSCONFIG_SHA256"]) expect(proof, k).toContain(`${k}: "${e()[k]}"`);
  });
  it("the provisioning tooling listing hash equals the repository", () => {
    let s = "";
    for (const n of ["live.ts", "provision.ts", "run.ts"]) s += `${sha256Lf(`scripts/qa/d24-test-provision/${n}`)}  ${n}\n`;
    expect(e().D24_PIN_PROVISION_TOOLING_SHA256).toBe(createHash("sha256").update(s).digest("hex"));
    const f = step("Fetch exactly").run as string;
    expect(f).toContain("sha256sum live.ts provision.ts run.ts | sha256sum");
    expect(f).toContain('[ "$tooling" = "$D24_PIN_PROVISION_TOOLING_SHA256" ]');
  });
});

describe("provisioning workflow: the create request is the production Express configuration", () => {
  it("the request the workflow's tool builds equals the production onboarding route's account-creation parameters plus only the markers", () => {
    const route = readFileSync(join(REPO, "src/app/api/stripe/connect/onboarding/route.ts"), "utf8");
    expect(route).toMatch(/accounts\.create\(\{\s*type: "express",\s*capabilities: \{\s*card_payments: \{ requested: true \},\s*transfers: \{ requested: true \},?\s*\},\s*metadata:/);
    const body = buildCreateRequest({ envelopeRef: "D24-ENV-20261109-12345678901", idempotencyKey: "d24prov-0123456789abcdef" }).body as Record<string, string>;
    const nonMarker = Object.entries(body).filter(([k]) => !k.startsWith("metadata["));
    expect(Object.fromEntries(nonMarker)).toEqual({ type: "express", "capabilities[card_payments][requested]": "true", "capabilities[transfers][requested]": "true" });
    expect(Object.keys(body).filter((k) => k.startsWith("metadata[")).sort()).toEqual(["metadata[d24_envelope_ref]", "metadata[d24_fixture_role]", "metadata[d24_proof_fixture]"]);
  });
});

describe("recorded proof ids (provisioning run 42530005438, 2026-11-08)", () => {
  const proof = yaml.load(readFileSync(join(WF_DIR, "d24-stripe-test-proof.yml"), "utf8")) as Wf;
  const penv = (proof.jobs.proof as Job).env as Record<string, string>;
  const PLATFORM = "acct_1UZ320IPJs53nwt7";
  const CONNECTED = "acct_1UZeX9RPIxrr5yG6";
  const FORBIDDEN = ["acct_1UWz98RESPl6zEVj", "acct_1TKgLCEYYNmPuFIX", "acct_1TKgL3EY0sTayNiS"]; // D7 sandbox, DEV sandbox, live
  it("the proof pins exactly the D24 sandbox platform and the newly provisioned connected account", () => {
    expect(penv.D24_PROOF_EXPECT_PLATFORM_ACCT).toBe(PLATFORM);
    expect(penv.D24_PROOF_EXPECT_CONNECTED_ACCT).toBe(CONNECTED);
    expect(penv.D24_PROOF_EXPECT_PLATFORM_ACCT).not.toBe(penv.D24_PROOF_EXPECT_CONNECTED_ACCT);
  });
  it("neither is the D7, DEV or live account, and the platform equals the provisioning workflow's pin", () => {
    for (const bad of FORBIDDEN) {
      expect(penv.D24_PROOF_EXPECT_PLATFORM_ACCT).not.toBe(bad);
      expect(penv.D24_PROOF_EXPECT_CONNECTED_ACCT).not.toBe(bad);
    }
    expect(penv.D24_PROOF_EXPECT_PLATFORM_ACCT).toBe(job.env?.D24_PROVISION_EXPECT_PLATFORM_ACCT);
  });
  it("the provisioning guard now refuses (the proof workflow no longer holds the placeholder connected id)", () => {
    expect(readFileSync(join(WF_DIR, "d24-stripe-test-proof.yml"), "utf8")).not.toContain("acct_PLACEHOLDERCONNECTED");
  });
});

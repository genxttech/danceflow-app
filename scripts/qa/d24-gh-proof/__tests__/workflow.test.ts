import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTHORIZATION_PHRASE } from "../../d24-m3d-proof/identity";
import { manifest } from "../../d24-m3d-proof/manifest";
import { parsePublicKey } from "../evidence-crypto";

// Static assertions about .github/workflows/d24-stripe-test-proof.yml. The file is only PARSED, never run. Every assertion has a mutation check (see the PR report).

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const WORKFLOW = join(REPO, ".github", "workflows", "d24-stripe-test-proof.yml");
// js-yaml is a (dev) transitive dependency of eslint; it ships no types here, so it is loaded without them
const yaml = createRequire(import.meta.url)("js-yaml") as { load(s: string): unknown };

type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; shell?: string; "working-directory"?: string };
type Job = { name?: string; if?: string; "runs-on"?: string; "timeout-minutes"?: number; environment?: unknown; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[]; concurrency?: unknown; "continue-on-error"?: unknown; container?: unknown; services?: unknown };
type Wf = { name: string; "run-name"?: string; on: Record<string, unknown>; permissions?: Record<string, string>; concurrency?: { group?: string; "cancel-in-progress"?: boolean }; defaults?: { run?: { shell?: string } }; env?: Record<string, string>; jobs: Record<string, Job> };

const text = readFileSync(WORKFLOW, "utf8");
const doc = yaml.load(text) as Wf;
const job = doc.jobs.proof as Job;
const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); // comments removed (they may legitimately mention forbidden words)
const idx = (frag: string) => {
  const i = job.steps.findIndex((s) => (s.name ?? "").includes(frag));
  expect(i, `step containing ${JSON.stringify(frag)}`).toBeGreaterThanOrEqual(0);
  return i;
};
const stepByName = (frag: string) => job.steps[idx(frag)] as Step;
const KEY_NAME = "D24_PROOF_STRIPE_KEY";

describe("triggers and identity", () => {
  it("the only trigger is workflow_dispatch, with no inputs", () => {
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    const wd = doc.on.workflow_dispatch;
    expect(wd === null || (typeof wd === "object" && Object.keys(wd as object).length === 0)).toBe(true);
  });
  it("no other trigger name appears anywhere outside comments", () => {
    for (const bad of ["pull_request_target", "pull_request", "push:", "schedule", "workflow_run", "repository_dispatch", "issue_comment", "pull_request_review", "workflow_call", "release:", "check_suite", "deployment"]) expect(code, bad).not.toContain(bad);
  });
  it("there is exactly one job and it is bound to the d24-stripe-test environment", () => {
    expect(Object.keys(doc.jobs)).toEqual(["proof"]);
    const env = job.environment;
    expect(typeof env === "string" ? env : (env as { name?: string })?.name).toBe("d24-stripe-test");
  });
  it("the job runs only for a manual dispatch of main in the real repository", () => {
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain("github.repository == 'genxttech/danceflow-app'");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.if).not.toMatch(/\|\|/);
  });
  it("a pinned runner image, a short timeout, a single-flight concurrency group", () => {
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
    expect(doc.concurrency?.group).toBe("d24-stripe-test-proof");
    expect(doc.concurrency?.["cancel-in-progress"]).toBe(false);
  });
  it("no container, services or continue-on-error", () => {
    expect(job.container).toBeUndefined();
    expect(job.services).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(job.steps.some((s) => (s as Record<string, unknown>)["continue-on-error"] !== undefined)).toBe(false);
  });
  it("the run name shows the commit", () => {
    expect(doc["run-name"]).toContain("github.sha");
  });
});

describe("permissions", () => {
  it("workflow and job permissions are exactly contents: read", () => {
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read" });
  });
  it("nothing asks for write access, id-token or a broad scope", () => {
    expect(code).not.toMatch(/id-token/);
    expect(code).not.toMatch(/:\s*write\b/);
    expect(code).not.toMatch(/permissions:\s*write-all|read-all/);
    expect(code).not.toMatch(/GITHUB_TOKEN/);
  });
});

describe("third-party actions", () => {
  const uses = () => job.steps.filter((s) => s.uses).map((s) => s.uses as string);
  it("every `uses:` is pinned to a full 40-hex commit SHA", () => {
    expect(uses().length).toBeGreaterThan(0);
    for (const u of uses()) expect(u, u).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
  });
  it("only the two official actions that are needed are used (no checkout action: the commit is fetched with plain git)", () => {
    for (const u of uses()) expect(u, u).toMatch(/^actions\/(setup-node|upload-artifact)@/);
    expect(code).not.toMatch(/actions\/checkout/);
  });
  it("a fixed Node version is installed", () => {
    expect(stepByName("Set up Node").with?.["node-version"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("secrets and logs", () => {
  it("the key is referenced only as a step-level env of exactly the preflight and live steps", () => {
    const refs = job.steps.filter((s) => JSON.stringify(s.env ?? {}).includes("secrets."));
    expect(refs.map((s) => s.name).sort()).toEqual([stepByName("Live run").name, stepByName("Preflight").name].sort());
    for (const s of refs) expect(s.env).toEqual({ [KEY_NAME]: "${{ secrets.D24_PROOF_STRIPE_KEY }}" });
    expect((code.match(/secrets\./g) ?? []).length).toBe(2);
    expect(JSON.stringify(doc.env ?? {})).not.toContain("secrets");
    expect(JSON.stringify(job.env ?? {})).not.toContain("secrets");
  });
  it("no run script interpolates a ${{ }} expression (no script-injection surface)", () => {
    for (const s of job.steps) if (s.run) expect(s.run, s.name).not.toContain("${{");
  });
  it("no script echoes, prints or traces the key or the environment", () => {
    for (const s of job.steps) {
      if (!s.run) continue;
      expect(s.run, s.name).not.toContain(KEY_NAME);
      expect(s.run, s.name).not.toMatch(/\bset\s+-[a-z]*x|xtrace|\bprintenv\b|\benv\s*$|\benv\s*\||\bdeclare -p\b|\bexport -p\b/m);
      expect(s.run, s.name).not.toMatch(/::add-mask|::set-output|::save-state/);
    }
  });
  it("the live step sends all of its output to a file, never to the public log", () => {
    const run = stepByName("Live run").run as string;
    expect(run).toMatch(/run\.ts --live > "\$D24_TERMINAL_FILE" 2>&1/);
    expect(run).not.toMatch(/\btee\b|\bcat\b|\becho "\$/);
    expect(run).toContain("umask 077");
  });
  it("the preflight prints only check ids", () => {
    const run = stepByName("Preflight").run as string;
    expect(run).toContain("grep -oE '^(OK|FAIL|MANUAL) +[a-z0-9-]+'");
    expect(run).not.toMatch(/\bcat\b/);
  });
  it("the shell fails fast", () => {
    expect(doc.defaults?.run?.shell).toBe("bash --noprofile --norc -euo pipefail {0}");
    for (const s of job.steps) expect(s.shell).toBeUndefined();
  });
  it("only the three plaintext path variables are exported to later steps through GITHUB_ENV", () => {
    const run = stepByName("Paths for plaintext").run as string;
    const lines = run.split("\n").filter((l) => l.includes("echo")).map((l) => l.trim());
    expect(lines).toEqual(['echo "D24_PROOF_EVIDENCE_DIR=$RUNNER_TEMP/d24-evidence"', 'echo "D24_TERMINAL_FILE=$RUNNER_TEMP/d24-terminal.txt"', 'echo "D24_UPLOAD_DIR=$RUNNER_TEMP/d24-upload"']);
  });
});

describe("fail-closed guards", () => {
  it("a guard step refuses placeholder account ids, a wrong repo / ref / trigger and bad id or pin shapes", () => {
    const run = stepByName("Guards").run as string;
    expect(run).toContain("*PLACEHOLDER*");
    expect(run).toContain('"$GITHUB_REF" = "refs/heads/main"');
    expect(run).toContain('"$GITHUB_REPOSITORY" = "genxttech/danceflow-app"');
    expect(run).toContain('"$GITHUB_EVENT_NAME" = "workflow_dispatch"');
    expect(run).toContain("!=");
    expect(run).toContain("[0-9a-f]{64}");
    expect(run.match(/exit 1/g)?.length).toBeGreaterThanOrEqual(8);
  });
  it("the checked-out HEAD must equal the dispatched commit AND the dispatched commit must still be the tip of main", () => {
    const run = stepByName("Fetch exactly").run as string;
    expect(run).toContain('git fetch -q --no-tags --depth=1 origin "$SHA"');
    expect(run).toContain('[ "$(git rev-parse HEAD)" = "$SHA" ]');
    expect(run).toContain("git fetch -q --no-tags --depth=1 origin refs/heads/main");
    expect(run).toContain('[ "$(git rev-parse FETCH_HEAD)" = "$SHA" ]');
    expect(stepByName("Fetch exactly").env).toEqual({ SHA: "${{ github.sha }}" });
  });
  it("dependencies install without lifecycle scripts", () => {
    expect(stepByName("Install dependencies").run).toBe("npm ci --ignore-scripts --no-audit --no-fund");
  });
  it("the evidence public key is checked (fail closed on the placeholder) BEFORE the live step and before the key is used anywhere", () => {
    const run = stepByName("Evidence public key must be real").run as string;
    expect(run).toContain("encrypt-cli.ts --check-key");
    expect(idx("Evidence public key must be real")).toBeLessThan(idx("Preflight"));
    expect(idx("Evidence public key must be real")).toBeLessThan(idx("Live run"));
  });
  it("order: guards < fetch < paths < node < npm ci < key gate < hash pin < dry run < preflight < live < encrypt < upload < cleanup", () => {
    const order = ["Commit and pins", "Guards", "Fetch exactly", "Paths for plaintext", "Set up Node", "Install dependencies", "Evidence public key must be real", "Harness manifest hash", "Dry run", "Preflight", "Live run", "Encrypt evidence", "Upload the ENCRYPTED", "Remove plaintext"].map(idx);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
  });
  it("the harness manifest hash must equal the pin before anything runs", () => {
    const run = stepByName("Harness manifest hash").run as string;
    expect(run).toContain("--print-hash");
    expect(run).toContain('[ "$got" = "$D24_PROOF_PINNED_SHA256" ]');
  });
  it("the dry run happens without an evidence dir and without the key", () => {
    const s = stepByName("Dry run");
    expect(s.env).toBeUndefined();
    expect(s.run).toContain("env -u D24_PROOF_EVIDENCE_DIR");
    expect(s.run).toContain("--dry-run");
  });
});

describe("pins match the repository", () => {
  it("the pinned manifest hash equals the harness manifest at this commit (a harness change forces a reviewed update of this file)", () => {
    const m = manifest(join(REPO, "scripts", "qa", "d24-m3d-proof"));
    expect(job.env?.D24_PROOF_PINNED_SHA256).toBe(m.sha256);
  });
  it("the authorization sentence equals the harness constant", () => {
    expect(job.env?.D24_PROOF_AUTHORIZATION).toBe(AUTHORIZATION_PHRASE);
  });
  it("the pinned account ids are placeholders or well-formed distinct acct_ ids", () => {
    const p = job.env?.D24_PROOF_EXPECT_PLATFORM_ACCT ?? "";
    const c = job.env?.D24_PROOF_EXPECT_CONNECTED_ACCT ?? "";
    expect(p).toMatch(/^acct_[A-Za-z0-9]{6,64}$/);
    expect(c).toMatch(/^acct_[A-Za-z0-9]{6,64}$/);
    expect(p).not.toBe(c);
  });
  it("the evidence public key in the repo is either the clearly marked placeholder or a real RSA-4096 public key", () => {
    const pem = readFileSync(join(REPO, "scripts", "qa", "d24-gh-proof", "evidence-public-key.pem"), "utf8");
    if (/PLACEHOLDER/.test(pem)) expect(() => parsePublicKey(pem)).toThrow(/PLACEHOLDER/);
    else expect(() => parsePublicKey(pem)).not.toThrow();
  });
});

describe("evidence leaves the runner only encrypted", () => {
  it("the encrypt step runs after the live step even if it failed, and writes the envelope outside the checkout", () => {
    const s = stepByName("Encrypt evidence");
    expect(s.if).toBe("always() && steps.live.conclusion != 'skipped'");
    expect(stepByName("Live run").id).toBe("live");
    expect(s.run).toContain("encrypt-cli.ts --encrypt");
    expect(s.run).toContain('--out "$D24_UPLOAD_DIR/d24-proof-evidence.enc.json"');
    expect(s.run).toContain('--public-key "$D24_EVIDENCE_PUBLIC_KEY"');
  });
  it("the artifact is only the encrypted envelope, short-lived, and its absence is an error", () => {
    const s = stepByName("Upload the ENCRYPTED");
    expect(s.if).toBe("always() && steps.live.conclusion != 'skipped'");
    expect(s.with?.path).toBe("${{ runner.temp }}/d24-upload/d24-proof-evidence.enc.json");
    expect(Number(s.with?.["retention-days"])).toBeGreaterThan(0);
    expect(Number(s.with?.["retention-days"])).toBeLessThanOrEqual(7);
    expect(s.with?.["if-no-files-found"]).toBe("error");
    expect(JSON.stringify(s.with)).not.toMatch(/evidence-dir|d24-evidence|terminal/);
  });
  it("the plaintext is removed at the end, always", () => {
    const s = stepByName("Remove plaintext");
    expect(s.if).toBe("always()");
    expect(s.run).toContain('rm -rf "$D24_PROOF_EVIDENCE_DIR" "$D24_TERMINAL_FILE" "$D24_UPLOAD_DIR"');
  });
  it("the job summary comes from encrypt-cli (counts and hashes only); no step writes evidence into the summary", () => {
    expect(stepByName("Encrypt evidence").run).toContain('--summary-file "$GITHUB_STEP_SUMMARY"');
    for (const s of job.steps) if (s.run && s.name !== "Commit and pins under approval") expect(s.run, s.name).not.toMatch(/GITHUB_STEP_SUMMARY.*(terminal|evidence-dir)/);
  });
  it("the commit and pin are printed into the summary first", () => {
    const s = job.steps[0] as Step;
    expect(s.name).toContain("Commit and pins");
    expect(s.run).toContain("$GITHUB_STEP_SUMMARY");
    expect(s.run).toContain("$SHA");
    expect(s.run).toContain("$D24_PROOF_PINNED_SHA256");
  });
});

describe("code owners and test registration", () => {
  const owners = readFileSync(join(REPO, ".github", "CODEOWNERS"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"));
  it("the workflow, the harness, the proof tooling, the evidence key, the docs and the test config are owned by the repository owner", () => {
    for (const p of ["/.github/workflows/d24-*", "/scripts/qa/d24-m3d-proof/", "/scripts/qa/d24-gh-proof/", "/docs/billing/D24-GITHUB-ENVIRONMENT-PROOF.md", "/.github/CODEOWNERS", "/vitest.config.mts"]) {
      expect(owners, p).toContain(`${p} @genxttech`);
    }
  });
  it("the proof tooling tests are part of the vitest include list", () => {
    expect(readFileSync(join(REPO, "vitest.config.mts"), "utf8")).toContain("scripts/qa/d24-gh-proof/__tests__/**/*.test.ts");
  });
});

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
      // the key is only ever forwarded by name into the scrubbed environment of the two key steps, never echoed
      const forwarded = `${KEY_NAME}="$${KEY_NAME}"`;
      const rest = (s.run ?? "").split(forwarded).join("");
      expect(rest, s.name).not.toContain(KEY_NAME);
      if (s.run?.includes(forwarded)) expect(["Preflight", "Live run"].some((n) => (s.name ?? "").includes(n)), s.name).toBe(true);
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
    expect(doc.defaults?.run?.shell).toBe("/usr/bin/bash --noprofile --norc -euo pipefail {0}");
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
    expect(stepByName("Install dependencies").run).toContain("ci --ignore-scripts --no-audit --no-fund");
  });
  it("the evidence public key is checked (fail closed on the placeholder) BEFORE the live step and before the key is used anywhere", () => {
    const run = stepByName("Evidence public key must be real").run as string;
    expect(run).toContain("encrypt-cli.ts --check-key");
    expect(idx("Evidence public key must be real")).toBeLessThan(idx("Preflight"));
    expect(idx("Evidence public key must be real")).toBeLessThan(idx("Live run"));
  });
  it("order: guards < fetch < paths < node < npm ci < key gate < hash pin < dry run < preflight < live < encrypt < upload < cleanup", () => {
    const order = ["Commit and pins", "Guards", "Fetch exactly", "Paths for plaintext", "Set up Node", "Install dependencies", "Evidence public key must be real", "Harness manifest hash", "Dry run", "No stray processes", "Preflight", "Live run", "Encrypt evidence", "Upload the ENCRYPTED", "Remove plaintext"].map(idx);
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
    expect(s.run).not.toContain("D24_PROOF_EVIDENCE_DIR");
    expect(s.run).not.toContain(KEY_NAME);
    expect(s.run).toContain("/usr/bin/env -i");
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

const gitOut = (...args: string[]) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
const sha256Lf = (rel: string) => createHash("sha256").update(readFileSync(join(REPO, rel), "utf8").replace(/\r\n/g, "\n")).digest("hex");

describe("review round: workflow identity, input pins, clean environment", () => {
  it("a guard binds github.workflow_ref to this file on main", () => {
    expect(job.env?.D24_WORKFLOW_REF_EXPECTED).toBe("genxttech/danceflow-app/.github/workflows/d24-stripe-test-proof.yml@refs/heads/main");
    const g = stepByName("Guards");
    expect(g.env).toEqual({ WORKFLOW_REF: "${{ github.workflow_ref }}" });
    expect(g.run).toContain('[ "$WORKFLOW_REF" = "$D24_WORKFLOW_REF_EXPECTED" ]');
  });
  it("the harness git TREE id is pinned, equals the real tree, and is checked in plain shell before any node runs", () => {
    const pin = job.env?.D24_PROOF_PINNED_TREE;
    expect(pin).toMatch(/^[0-9a-f]{40}$/);
    expect(gitOut("rev-parse", "HEAD:scripts/qa/d24-m3d-proof")).toBe(pin);
    const f = stepByName("Fetch exactly").run as string;
    expect(f).toContain('[ "$(git rev-parse HEAD:scripts/qa/d24-m3d-proof)" = "$D24_PROOF_PINNED_TREE" ]');
  });
  it("package.json, package-lock.json and tsconfig.json are pinned by sha256, equal the repo, and verified before npm ci", () => {
    const e = job.env ?? {};
    expect(e.D24_PIN_PACKAGE_JSON_SHA256).toBe(sha256Lf("package.json"));
    expect(e.D24_PIN_PACKAGE_LOCK_SHA256).toBe(sha256Lf("package-lock.json"));
    expect(e.D24_PIN_TSCONFIG_SHA256).toBe(sha256Lf("tsconfig.json"));
    const f = stepByName("Fetch exactly").run as string;
    for (const [file, v] of [["package.json", "D24_PIN_PACKAGE_JSON_SHA256"], ["package-lock.json", "D24_PIN_PACKAGE_LOCK_SHA256"], ["tsconfig.json", "D24_PIN_TSCONFIG_SHA256"]]) {
      expect(f).toContain(`[ "$(sha256sum ${file} | cut -d' ' -f1)" = "$${v}" ]`);
    }
    expect(idx("Fetch exactly")).toBeLessThan(idx("Install dependencies"));
  });
  it("every step that runs node or npm uses a scrubbed environment with an explicit PATH (env -i)", () => {
    for (const frag of ["Install dependencies", "Evidence public key must be real", "Harness manifest hash", "Dry run", "Preflight", "Live run", "Encrypt evidence"]) {
      const r = stepByName(frag).run as string;
      expect(r, frag).toContain("/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin");
      expect(r, frag).not.toMatch(/^\s*(node|npm)\s/m);
      // never a bare `node`/`npm` word used as a command argument (it would resolve through PATH): only the absolute "$NODE"
      expect(r.replace(/\$NODE\b/g, ""), frag).not.toMatch(/(^|[\s"}\]])(node|npm)\s+("|\$)/m);
    }
  });
  it("stray processes are checked for (and refused) right before the key is used, and the node binary is the toolcache one", () => {
    const i = idx("No stray processes");
    expect(i).toBeLessThan(idx("Preflight"));
    expect(i).toBeGreaterThan(idx("Dry run"));
    const r = job.steps[i]?.run as string;
    expect(r).toContain("pgrep");
    expect(r).toContain("exit 1");
    for (const frag of ["Preflight", "Live run"]) expect(stepByName(frag).run).toContain('NODE="$RUNNER_TOOL_CACHE/node/24.14.1/x64/bin/node"');
  });
  it("the key steps do not rely on GITHUB_ENV values other than the three plaintext paths", () => {
    for (const frag of ["Preflight", "Live run"]) {
      const s = stepByName(frag);
      expect(Object.keys(s.env ?? {})).toEqual([KEY_NAME]);
    }
  });
});

describe("review round 3: host-independent hardening of the runner side", () => {
  const listing = (names: string[]) => {
    let s = "";
    for (const n of names) s += `${createHash("sha256").update(readFileSync(join(REPO, "scripts", "qa", "d24-gh-proof", n), "utf8").replace(/\r\n/g, "\n")).digest("hex")}  ${n}\n`;
    return createHash("sha256").update(s).digest("hex");
  };
  it("the tooling this job executes is pinned (sha256 of the sha256sum listing) and the pin equals the repo", () => {
    const names = ["encrypt-cli.ts", "evidence-crypto.ts", "summary.ts", "evidence-public-key.pem"];
    expect(job.env?.D24_PIN_TOOLING_SHA256).toBe(listing(names));
    const f = stepByName("Fetch exactly").run as string;
    expect(f).toContain("sha256sum encrypt-cli.ts evidence-crypto.ts summary.ts evidence-public-key.pem | sha256sum");
    expect(f).toContain('[ "$tooling" = "$D24_PIN_TOOLING_SHA256" ]');
  });
  it("the fetch step refuses stray npm/node config files", () => {
    const f = stepByName("Fetch exactly").run as string;
    expect(f).toContain("for f in .npmrc scripts/package.json scripts/qa/package.json scripts/qa/d24-gh-proof/package.json");
    expect(f).toContain('[ ! -e "$f" ]');
  });
  it("no such file exists in the repository (so the guard is satisfiable)", () => {
    for (const f of [".npmrc", "scripts/package.json", "scripts/qa/package.json", "scripts/qa/d24-gh-proof/package.json"]) expect(existsSync(join(REPO, f)), f).toBe(false);
  });
  it("bash startup variables are neutralised at job level and the shell and helper binaries are absolute", () => {
    expect(job.env?.BASH_ENV).toBe("");
    expect(job.env?.ENV).toBe("");
    expect(doc.defaults?.run?.shell?.startsWith("/usr/bin/bash ")).toBe(true);
    const r = stepByName("No stray processes").run as string;
    for (const bin of ["/usr/bin/id", "/usr/bin/pkill", "/usr/bin/pgrep"]) expect(r).toContain(bin);
    expect(r).not.toMatch(/(^|[\s(`$])(pkill|pgrep|id)\s/m);
  });
  it("CODEOWNERS also covers .npmrc and the nested package.json locations", () => {
    const co = readFileSync(join(REPO, ".github", "CODEOWNERS"), "utf8");
    for (const p of ["/.npmrc", "/scripts/package.json", "/scripts/qa/package.json"]) expect(co, p).toContain(`${p} @genxttech`);
  });
});

describe("review round: no other workflow may reach the environment or the secret", () => {
  const dir = join(REPO, ".github", "workflows");
  const others = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && f !== "d24-stripe-test-proof.yml" && f !== "d24-provision-account.yml");
  it("there is at least one other workflow (so this scan is not vacuous)", () => {
    expect(others.length).toBeGreaterThan(0);
  });
  it("no other workflow mentions the d24-stripe-test environment, the key secret, or any d24 proof secret", () => {
    for (const f of others) {
      const t = readFileSync(join(dir, f), "utf8");
      expect(t, f).not.toMatch(/d24-stripe-test/i);
      expect(t, f).not.toContain("D24_PROOF_STRIPE_KEY");
      expect(t, f).not.toMatch(/secrets\.D24/i);
      expect(t, f).not.toMatch(/secrets:\s*inherit/);
    }
  });
  it("the scan covers every workflow file in the directory, including other extensions", () => {
    for (const f of readdirSync(dir)) expect(f, f).toMatch(/\.ya?ml$/);
  });
  it("the CI gate runs on every pull request (no paths filter), so it also covers PRs that touch this boundary", () => {
    const t = readFileSync(join(dir, "e2e-public-event-registration.yml"), "utf8");
    expect(t).toContain("\n  pull_request: {}\n");
    expect(t).not.toMatch(/^\s+paths:/m);
  });
});

describe("review round: the owner doc states the preconditions honestly", () => {
  const doc = readFileSync(join(REPO, "docs", "billing", "D24-GITHUB-ENVIRONMENT-PROOF.md"), "utf8");
  it("requires a separate Write-only agent identity and removes the owner's token", () => {
    expect(doc).toMatch(/always acts as the user who created it/);
    expect(doc).toMatch(/separate identity/i);
    expect(doc).toMatch(/choose \*\*Write\*\*, never Maintain or Admin/);
    expect(doc).toContain("danceflow-engineering-bot");
    expect(doc).toMatch(/must \*\*not\*\* be a required reviewer/);
    expect(doc).toMatch(/Remove the owner's `genxttech` token/);
  });
  it("does not claim that engineering cannot do the owner steps", () => {
    expect(doc).not.toMatch(/Engineering must not and cannot do them/);
    expect(doc).not.toMatch(/forces a reviewed workflow update\b(?! \*\*only)/);
  });
  it("specifies the full ruleset and environment settings", () => {
    for (const s of ["Require review from Code Owners ON", "most recent reviewable push", "at least 1 approval", "no bypass for the agent identity", "required status check", "Allow administrators to bypass configured protection rules = OFF"]) expect(doc, s).toContain(s);
  });
  it("has one merge-ordering rule and tells the owner to check the workflow path", () => {
    expect(doc).toContain("Do not merge this PR until the environment");
    expect(doc).not.toMatch(/Merging the file alone is harmless/);
    expect(doc).toMatch(/workflow path is exactly `\.github\/workflows\/d24-stripe-test-proof\.yml`/);
  });
  it("says the approval sentence is a constant, that engineering holds the evidence key, and lists the runner residual", () => {
    expect(doc).toMatch(/constant supplied by this reviewed file/);
    expect(doc).toMatch(/Engineering holds the evidence private key/);
    expect(doc).toMatch(/moving image label/);
    expect(doc).toMatch(/proves integrity, not origin/);
  });
  it("documents the token transition, the fine-grained-token limit, the repo-secret residual and the reconciliation decision", () => {
    for (const s of ["credential.helper=manager", "gh auth setup-git", "gh auth logout --hostname github.com --user genxttech", "separate approval", "Option A (recommended): a GitHub App", "Option B: a classic personal access token", "3.0 [OWNER] ACCEPTED RESIDUAL", "deliberately hostile agent", "TEST-only", "When this must be re-opened", "Standing rule (record of the owner's decision)", "Hardware security key on the owner's GitHub account", "sudo-mode", "After-the-fact audit from another device or account the agent cannot read", "does **not** notify you of your **own** actions", "deployment review history", "Security log", "two hours", "delete every saved github.com password", "The agent identity can never satisfy the approval requirement", "Who merges this PR", "re-opens this branch as a new pull request authored by the agent identity", "recorded one-time owner bypass", "legacy triage", "prerequisite PR 1", "prerequisite PR 2", "Expected non-PASS results", "exit code 3", "By eye, because", "--option a|b", "verified_allowed", "Allow Marketplace actions by verified creators", "does not claim an independent boundary", "credential.interactive never", "GCM_INTERACTIVE=never", "3.A0", "Preview", "no 0 fallback", "If the output has no final `RESULT:` line", "cannot be used by a collaborator on another user's repository", "Workflows permission trade-off", "Residual P2 (future risk, not present today)", "0 repository-level Actions secrets", "no API to read the request log", "Dashboard glance", "new production-equivalent Express connected account", "separately authorized provisioning workflow", "Require actions to be pinned to a full-length commit SHA", "Prevent self-review", "verify-github-config.ts"]) expect(doc, s).toContain(s);
  });
  it("records the owner's accepted-residual decision instead of requiring a separate device, and does not claim an independent boundary", () => {
    expect(doc).not.toMatch(/Every owner GitHub action happens on a separate device/);
    expect(doc).not.toMatch(/never signed in to GitHub in any browser or app on this Windows account/);
    expect(doc).toMatch(/keeps approving[^.]*on this Windows PC/);
    expect(doc).toMatch(/never uses\*\* the owner's browser sessions/);
    expect(doc).toMatch(/gh` keyring token, the Git Credential Manager login, SSH keys/);
    expect(doc).toMatch(/live-mode key/);
    expect(doc).not.toContain("generates a notification the owner receives elsewhere");
    expect(doc).not.toContain("which a browser-driving agent cannot supply");
    expect(doc).not.toContain("so a stolen cookie alone cannot reach settings");
    expect(doc).not.toMatch(/means \*\*no change reaches `main` without the owner\*\*, code-owned or not/);
    expect(doc).toContain("accepted for **TEST-only proofs**");
    expect(doc).toContain("is **not** removed");
    expect(doc).toContain("An independent boundary against a deliberately hostile agent on the owner's Windows account.");
    expect(doc).not.toMatch(/independent boundary against a deliberately hostile agent\.\*\* The ruleset[^.]*do constrain/);
  });
  it("tells the owner the required status check and SHA pinning each have a prerequisite that would otherwise block merges or CI", () => {
    expect(doc).toMatch(/pull_request\.paths. filter, so a PR outside the filter never reports the check/);
    expect(doc).toMatch(/would stop running/);
  });
  it("the workflow header carries the same merge rule", () => {
    expect(text).toContain("must exist BEFORE this file is merged");
  });
});

describe("review round: CODEOWNERS coverage (every boundary path resolves to the owner)", () => {
  // simplified gitignore-style matcher sufficient for these patterns; the LAST matching rule wins, as on GitHub
  const rules = readFileSync(join(REPO, ".github", "CODEOWNERS"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/) as [string, ...string[]]);
  const toRe = (pat: string) => {
    let p = pat.replace(/^\//, "");
    const dirOnly = p.endsWith("/");
    p = p.replace(/\/$/, "");
    const re = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\u0001/g, ".*");
    return new RegExp(`^${re}${dirOnly ? "/.*" : "(/.*)?"}$`);
  };
  const ownersOf = (file: string) => {
    let hit: string[] | null = null;
    for (const [pat, ...own] of rules) if (toRe(pat).test(file)) hit = own;
    return hit;
  };
  it.each([
    ".github/CODEOWNERS",
    ".github/workflows/d24-stripe-test-proof.yml",
    ".github/workflows/ci-extra.yml",
    ".github/workflows/e2e-public-event-registration.yml",
    ".github/actions/anything/action.yml",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.mts",
    "scripts/qa/d24-m3d-proof/run.ts",
    "scripts/qa/d24-m3d-proof/__tests__/x.test.ts",
    "scripts/qa/d24-gh-proof/evidence-public-key.pem",
    "docs/billing/D24-GITHUB-ENVIRONMENT-PROOF.md",
  ])("%s is owned by @genxttech", (f) => {
    expect(ownersOf(f)).toEqual(["@genxttech"]);
  });
  // Governance change 2026-11-12 (docs/ops/GitHub_Governance_Change_Package.md): no catch-all. Routine paths merge on green
  // required checks; the sensitive areas below must stay owned. Every rule names only the owner, never the agent identity.
  it("there is no catch-all, and every rule names only @genxttech", () => {
    expect(rules.some(([p]) => p === "*" || p === "/*" || p === "**")).toBe(false);
    expect(rules.every((r) => r.length === 2 && r[1] === "@genxttech")).toBe(true);
  });
  it.each([
    "src/lib/supabase/migrations/20270301000000_x.sql",
    "src/lib/supabase/admin.ts",
    "src/proxy.ts",
    "src/lib/auth/staffApiAuth.ts",
    "src/app/(auth)/login/page.tsx",
    "src/lib/payments/stripe.ts",
    "src/app/api/stripe/webhook/route.ts",
    "src/app/api/webhooks/x/route.ts",
    "src/lib/billing/x.ts",
    "src/lib/usage/x.ts",
    "src/lib/events/event-order-payment.ts",
    "src/lib/sms/x.ts",
    "src/app/platform/sms/page.tsx",
    "src/app/api/cron/x/route.ts",
    "src/lib/integrations/gusto.ts",
    "vercel.json",
    "next.config.ts",
    "mobile/student/package.json",
    "mobile/business/app.json",
    "mobile/student/eas.json",
    "scripts/release/x.mjs",
    "src/lib/supabase/migrations/sql-tests/test_T_x.sql",
    "src/lib/supabase/migrations/rollback/2027_x_rollback.sql",
    "src/lib/competition/results/recompute.ts",
    "src/lib/competition/setup/fees.ts",
    "src/app/events/[slug]/competition/results/page.tsx",
    "src/app/api/events/[slug]/competition/release/route.ts",
    "src/app/app/events/[id]/competition/registrations/refund/actions.ts",
    "docs/competition/x.md",
    "e2e/tests/competition.spec.ts",
    "src/app/app/settings/sms/numberActions.ts",
    "src/app/app/clients/[id]/sms-actions.ts",
    "src/app/app/clients/[id]/ClientSmsConsentCard.tsx",
    "src/app/sms-consent/page.tsx",
    "src/app/studios/[studioSlug]/sms-terms/page.tsx",
    "src/app/studios/[studioSlug]/SmsLegalPage.tsx",
    "src/components/public/SmsConsentCheckbox.tsx",
    "src/lib/billing/smsCredits.ts",
    "src/app/api/billing/sms-credit/route.ts",
    "src/app/api/cron/sms-usage/route.ts",
    "scripts/hosted/reset.sql",
    "scripts/qa/tw4f/run.mjs",
    "scripts/tw4-validation/check.mjs",
  ])("sensitive path %s is owned by @genxttech", (f) => {
    expect(ownersOf(f)).toEqual(["@genxttech"]);
  });
  it.each(["src/app/api/staff/me/route.ts", "mobile/student/src/screens/Today.tsx", "docs/mobile/x.md", "src/lib/supabase/__tests__/x.test.ts"])(
    "routine path %s has no code owner",
    (f) => {
      expect(ownersOf(f)).toBeNull();
    },
  );
});

describe("code owners and test registration", () => {
  const owners = readFileSync(join(REPO, ".github", "CODEOWNERS"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"));
  it("the workflow, the harness, the proof tooling, the evidence key, the docs and the test config are owned by the repository owner", () => {
    for (const p of ["/.github/", "/package.json", "/package-lock.json", "/tsconfig.json", "/scripts/qa/d24-m3d-proof/", "/scripts/qa/d24-gh-proof/", "/docs/billing/D24-GITHUB-ENVIRONMENT-PROOF.md", "/vitest.config.mts"]) {
      expect(owners, p).toContain(`${p} @genxttech`);
    }
  });
  it("the proof tooling tests are part of the vitest include list", () => {
    expect(readFileSync(join(REPO, "vitest.config.mts"), "utf8")).toContain("scripts/qa/d24-gh-proof/__tests__/**/*.test.ts");
  });
});

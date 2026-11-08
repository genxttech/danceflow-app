// Static assertions about .github/workflows/d24-stripe-test-proof.yml. Each check returns true when its protection is present.
// workflow.test.ts proves the committed file passes every check AND that removing a protection makes the matching check fail (mutation checks).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
export const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "d24-stripe-test-proof.yml");
const yaml = createRequire(import.meta.url)("js-yaml") as { load: (s: string) => unknown };

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; id?: string; if?: string };
type Job = { environment?: string; permissions?: Record<string, string>; if?: string; "timeout-minutes"?: number; env?: Record<string, string>; steps: Step[] };
type Wf = { on?: unknown; true?: unknown; permissions?: Record<string, string>; concurrency?: { group?: string; "cancel-in-progress"?: boolean }; env?: Record<string, string>; jobs: Record<string, Job> };

export const load = (text: string): Wf => yaml.load(text) as Wf;
export const readWorkflow = (): string => readFileSync(WORKFLOW_PATH, "utf8");

const SECRET = "D24_PROOF_STRIPE_KEY";
const noComments = (t: string) => t.replace(/^\s*#.*$/gm, "");
const job = (t: string): Job => Object.values(load(t).jobs)[0];
const named = (steps: Step[], re: RegExp) => steps.find((s) => re.test(s.name ?? ""));
const runsOf = (t: string) => job(t).steps.map((s) => s.run ?? "").join("\n");

export const CHECKS: Record<string, (text: string) => boolean> = {
  onlyWorkflowDispatch: (t) => {
    const w = load(t);
    const on = (w.on ?? w.true) as Record<string, unknown> | string | string[] | undefined;
    const keys = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
    return keys.length === 1 && keys[0] === "workflow_dispatch" && !/pull_request|\bpush:|schedule:|workflow_run|issue_comment/.test(noComments(t));
  },
  noPullRequestTarget: (t) => !/pull_request_target/.test(noComments(t)),
  environmentBound: (t) => {
    const jobs = Object.values(load(t).jobs);
    return jobs.length === 1 && jobs[0].environment === "d24-stripe-test";
  },
  minimalPermissions: (t) => {
    const w = load(t);
    const only = (p: unknown) => JSON.stringify(p) === JSON.stringify({ contents: "read" });
    return only(w.permissions) && Object.values(w.jobs).every((j) => j.permissions === undefined || only(j.permissions)) && !/id-token/.test(noComments(t));
  },
  everyActionPinnedToFullSha: (t) => {
    const uses = job(t).steps.map((s) => s.uses).filter(Boolean) as string[];
    return uses.length > 0 && uses.every((u) => /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(u));
  },
  noSecretEcho: (t) => {
    const w = load(t);
    if (/set\s+-[a-z]*x|xtrace|toJSON\(\s*secrets|secrets\[|\$\{\{\s*secrets\s*\}\}|ACTIONS_STEP_DEBUG/.test(noComments(t))) return false;
    if (w.env && JSON.stringify(w.env).includes("secrets.")) return false;
    for (const j of Object.values(w.jobs)) {
      if (j.env && JSON.stringify(j.env).includes("secrets.")) return false;
      for (const s of j.steps) {
        if (/secrets\./.test(s.run ?? "")) return false; // a secret expression is never inlined into a script
        if (/secrets\./.test(JSON.stringify(s.with ?? {}))) return false;
        for (const line of (s.run ?? "").split("\n")) {
          if (!line.includes(SECRET)) continue;
          // the only permitted use of the variable inside a script is the mask command
          if (!/^\s*echo "::add-mask::\$\{D24_PROOF_STRIPE_KEY\}"\s*$/.test(line)) return false;
        }
        const mapsSecret = Object.values(s.env ?? {}).some((v) => /secrets\./.test(String(v)));
        if (mapsSecret && !/^(Preflight|Live Stripe)/.test(s.name ?? "")) return false;
        if (mapsSecret && String((s.env ?? {})[SECRET]).replace(/\s/g, "") !== "${{secrets.D24_PROOF_STRIPE_KEY}}") return false;
      }
    }
    return true;
  },
  failsClosedOnPlaceholderAccountIds: (t) => {
    const w = load(t);
    const steps = job(t).steps;
    const g = named(steps, /^Guards/);
    const live = steps.findIndex((s) => /^Live Stripe/.test(s.name ?? ""));
    if (!g) return false;
    const run = g.run ?? "";
    return (
      steps.indexOf(g) < live &&
      /\*PLACEHOLDER\*\)[^\n]*exit 1/.test(run) &&
      run.split("^acct_[A-Za-z0-9]{6,64}$").length - 1 === 2 &&
      run.includes("^[0-9a-f]{64}$") &&
      /acct_PLACEHOLDER/.test(`${w.env?.D24_PLATFORM_ACCT_PIN}${w.env?.D24_CONNECTED_ACCT_PIN}`)
    );
  },
  failsClosedOnPlaceholderEvidenceKey: (t) => {
    const steps = job(t).steps;
    const v = named(steps, /Verify checkout/);
    const ck = steps.findIndex((s) => /cli\.ts check-key/.test(s.run ?? ""));
    const live = steps.findIndex((s) => /^Live Stripe/.test(s.name ?? ""));
    return !!v && /grep -q "D24-EVIDENCE-PUBLIC-KEY-PLACEHOLDER"[^\n]*\n[^\n]*exit 1/.test(v.run ?? "") && steps.indexOf(v) < live && ck > -1 && ck < live;
  },
  mainOnlyAndRepositoryGuards: (t) => {
    const w = load(t);
    const j = job(t);
    const g = named(j.steps, /^Guards/);
    const jobIf = j.if ?? "";
    const run = g?.run ?? "";
    return (
      jobIf.includes("github.repository == 'genxttech/danceflow-app'") &&
      jobIf.includes("github.ref == 'refs/heads/main'") &&
      jobIf.includes("github.event_name == 'workflow_dispatch'") &&
      run.includes('"$RUN_REF" = "refs/heads/main"') &&
      run.includes('"$RUN_REPOSITORY" = "$EXPECTED_REPOSITORY"') &&
      run.includes('"$RUN_EVENT" = "workflow_dispatch"') &&
      w.env?.EXPECTED_REPOSITORY === "genxttech/danceflow-app"
    );
  },
  headMustEqualDispatchedSha: (t) => {
    const steps = job(t).steps;
    const co = steps.find((s) => /^actions\/checkout@/.test(s.uses ?? ""));
    const v = named(steps, /Verify checkout/);
    return !!co && co.with?.ref === "${{ github.sha }}" && co.with?.["persist-credentials"] === false && !!v && (v.run ?? "").includes('"$(git rev-parse HEAD)" = "$RUN_SHA"') && v.env?.RUN_SHA === "${{ github.sha }}";
  },
  stepOrder: (t) => {
    const s = job(t).steps;
    const order = [/^Show what/, /^Guards/, /^Check out/, /^Install the fixed Node/, /^Verify checkout/, /^Install dependencies/, /^Validate the evidence/, /^Verify the pinned/, /^Dry run/, /^Preflight/, /^Live Stripe/, /^Encrypt/, /^Upload/].map((re) => s.findIndex((x) => re.test(x.name ?? "")));
    return order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1]));
  },
  usesHarnessInOrderWithFlags: (t) => {
    const r = runsOf(t);
    const a = [r.search(/npm ci --ignore-scripts/), r.search(/run\.ts --print-hash/), r.search(/run\.ts --dry-run/), r.search(/run\.ts --preflight/), r.search(/run\.ts --live/)];
    return a.every((n, i) => n >= 0 && (i === 0 || n > a[i - 1]));
  },
  manifestHashVerifiedAgainstPin: (t) => {
    const w = load(t);
    const s = named(job(t).steps, /^Verify the pinned/);
    return !!s && /\[ "\$actual" = "\$D24_PINNED_MANIFEST_SHA256" \][^\n]*exit 1/.test(s.run ?? "") && /^[0-9a-f]{64}$/.test(w.env?.D24_PINNED_MANIFEST_SHA256 ?? "");
  },
  strictShellEverywhere: (t) => job(t).steps.filter((s) => s.run).every((s) => /^set -euo pipefail$/m.test(s.run as string)) && /defaults:\s*\n\s*run:\s*\n\s*shell: bash/.test(t),
  singleRunAndShortTimeout: (t) => {
    const w = load(t);
    const j = job(t);
    return !!w.concurrency?.group && w.concurrency["cancel-in-progress"] === false && typeof j["timeout-minutes"] === "number" && j["timeout-minutes"] <= 30;
  },
  fixedNodeAndNoScripts: (t) => {
    const s = job(t).steps;
    const sn = s.find((x) => /^actions\/setup-node@/.test(x.uses ?? ""));
    const r = runsOf(t);
    return !!sn && /^\d+\.\d+\.\d+$/.test(String(sn.with?.["node-version"])) && r.includes("npm ci --ignore-scripts") && !/npm (install|i)\b/.test(r);
  },
  summaryShowsShaAndHashFirst: (t) => {
    const first = job(t).steps[0];
    const run = first.run ?? "";
    return run.includes("GITHUB_STEP_SUMMARY") && run.includes("${RUN_SHA}") && run.includes("${D24_PINNED_MANIFEST_SHA256}") && first.env?.RUN_SHA === "${{ github.sha }}";
  },
  uploadsOnlyEncryptedEvidenceWithShortRetention: (t) => {
    const s = job(t).steps;
    const up = s.find((x) => /^actions\/upload-artifact@/.test(x.uses ?? ""));
    const enc = s.findIndex((x) => /^Encrypt/.test(x.name ?? ""));
    const p = String(up?.with?.path);
    return !!up && /d24-evidence\.enc\.json$/.test(p) && !p.includes("*") && Number(up.with?.["retention-days"]) >= 1 && Number(up.with?.["retention-days"]) <= 7 && enc > -1 && enc < s.indexOf(up) && up.with?.["if-no-files-found"] === "error";
  },
  evidenceNeverPrintedToLog: (t) => {
    const r = runsOf(t);
    return (
      r.includes('run.ts --live > "$RUNNER_TEMP/d24-live-stdout.txt" 2>&1') &&
      r.includes('run.ts --preflight > "$RUNNER_TEMP/d24-preflight.txt" 2>&1') &&
      r.includes('run.ts --dry-run > "$RUNNER_TEMP/d24-dryrun.txt" 2>&1') &&
      r.includes("{print $1, $2}") &&
      !/\bcat "?\$RUNNER_TEMP\/d24-(live|preflight|dryrun|evidence)/.test(r)
    );
  },
  evidenceDirOutsideCheckout: (t) => {
    const s = job(t).steps.filter((x) => x.env?.D24_PROOF_EVIDENCE_DIR);
    return s.length === 2 && s.every((x) => x.env?.D24_PROOF_EVIDENCE_DIR === "${{ runner.temp }}/d24-evidence");
  },
};

export type Mutation = { name: string; breaks: string; apply: (t: string) => string };
const rep = (from: string | RegExp, to: string) => (t: string) => {
  const r = t.replace(from, to);
  if (r === t) throw new Error(`mutation did not change the workflow: ${String(from)}`);
  return r;
};

const LIVE_HEAD = 'echo "::add-mask::${D24_PROOF_STRIPE_KEY}"\n          rc=0\n          node_modules/.bin/tsx scripts/qa/d24-m3d-proof/run.ts --live';

const LATE_GUARDS = "\n      - name: Guards (fail closed)\n        run: |\n          set -euo pipefail\n          true\n";

export const MUTATIONS: Mutation[] = [
  { name: "add pull_request trigger", breaks: "onlyWorkflowDispatch", apply: rep("on:\n  workflow_dispatch:", "on:\n  pull_request:\n  workflow_dispatch:") },
  { name: "add push trigger", breaks: "onlyWorkflowDispatch", apply: rep("on:\n  workflow_dispatch:", "on:\n  push:\n  workflow_dispatch:") },
  { name: "add schedule trigger", breaks: "onlyWorkflowDispatch", apply: rep("on:\n  workflow_dispatch:", "on:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:") },
  { name: "use pull_request_target", breaks: "noPullRequestTarget", apply: rep("on:\n  workflow_dispatch:", "on:\n  pull_request_target:\n  workflow_dispatch:") },
  { name: "rename environment", breaks: "environmentBound", apply: rep("environment: d24-stripe-test", "environment: other") },
  { name: "drop environment", breaks: "environmentBound", apply: rep("    environment: d24-stripe-test\n", "") },
  { name: "write permission", breaks: "minimalPermissions", apply: rep("permissions:\n  contents: read", "permissions:\n  contents: write") },
  { name: "id-token permission", breaks: "minimalPermissions", apply: rep("permissions:\n  contents: read", "permissions:\n  contents: read\n  id-token: write") },
  { name: "unpin checkout", breaks: "everyActionPinnedToFullSha", apply: rep(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v4") },
  { name: "short sha on upload", breaks: "everyActionPinnedToFullSha", apply: rep(/actions\/upload-artifact@[0-9a-f]{40}/, "actions/upload-artifact@ea165f8") },
  { name: "echo the secret", breaks: "noSecretEcho", apply: rep(LIVE_HEAD, LIVE_HEAD.replace('echo "::add-mask::${D24_PROOF_STRIPE_KEY}"', 'echo "key=${D24_PROOF_STRIPE_KEY}"')) },
  { name: "inline secret expression in a script", breaks: "noSecretEcho", apply: rep('echo "guards passed"', 'echo "${{ secrets.D24_PROOF_STRIPE_KEY }}"') },
  { name: "enable xtrace", breaks: "noSecretEcho", apply: rep(LIVE_HEAD, `set -x\n          ${LIVE_HEAD}`) },
  { name: "secret leaked to job env", breaks: "noSecretEcho", apply: rep('  EXPECTED_REPOSITORY: "genxttech/danceflow-app"', '  EXPECTED_REPOSITORY: "genxttech/danceflow-app"\n  LEAK: ${{ secrets.D24_PROOF_STRIPE_KEY }}') },
  { name: "secret mapped into the dry-run step", breaks: "noSecretEcho", apply: rep("      - name: Dry run (fake client, no network)\n        run:", "      - name: Dry run (fake client, no network)\n        env:\n          D24_PROOF_STRIPE_KEY: ${{ secrets.D24_PROOF_STRIPE_KEY }}\n        run:") },
  { name: "remove placeholder account-id refusal", breaks: "failsClosedOnPlaceholderAccountIds", apply: rep(/ *\*PLACEHOLDER\*\) echo[^\n]*exit 1;;/, "            *PLACEHOLDER*) :;;") },
  { name: "remove account-id format check", breaks: "failsClosedOnPlaceholderAccountIds", apply: rep(/ *\[\[ "\$D24_PLATFORM_ACCT_PIN" =~[^\n]*\n/, "") },
  { name: "remove placeholder evidence-key refusal", breaks: "failsClosedOnPlaceholderEvidenceKey", apply: rep(/ *if grep -q "D24-EVIDENCE-PUBLIC-KEY-PLACEHOLDER"[^\n]*\n[^\n]*\n *fi\n/, "") },
  { name: "drop check-key step", breaks: "failsClosedOnPlaceholderEvidenceKey", apply: rep("cli.ts check-key --key", "cli.ts encrypt --key") },
  { name: "remove main guard", breaks: "mainOnlyAndRepositoryGuards", apply: rep(/ *\[ "\$RUN_REF" = "refs\/heads\/main" \][^\n]*\n/, "") },
  { name: "remove repository guard", breaks: "mainOnlyAndRepositoryGuards", apply: rep(/ *\[ "\$RUN_REPOSITORY" = "\$EXPECTED_REPOSITORY" \][^\n]*\n/, "") },
  { name: "job if without main", breaks: "mainOnlyAndRepositoryGuards", apply: rep(" && github.ref == 'refs/heads/main' }}", " }}") },
  { name: "remove HEAD==sha check", breaks: "headMustEqualDispatchedSha", apply: rep(/ *\[ "\$\(git rev-parse HEAD\)" = "\$RUN_SHA" \][^\n]*\n/, "") },
  { name: "checkout another ref", breaks: "headMustEqualDispatchedSha", apply: rep("ref: ${{ github.sha }}", "ref: main") },
  { name: "persist credentials", breaks: "headMustEqualDispatchedSha", apply: rep("persist-credentials: false", "persist-credentials: true") },
  { name: "live instead of dry run", breaks: "usesHarnessInOrderWithFlags", apply: rep("run.ts --dry-run >", "run.ts --live >") },
  { name: "skip preflight", breaks: "usesHarnessInOrderWithFlags", apply: rep("run.ts --preflight >", "run.ts --allow-list >") },
  { name: "drop hash comparison", breaks: "manifestHashVerifiedAgainstPin", apply: rep(/ *\[ "\$actual" = "\$D24_PINNED_MANIFEST_SHA256" \][^\n]*\n/, "") },
  { name: "malformed hash pin", breaks: "manifestHashVerifiedAgainstPin", apply: rep(/D24_PINNED_MANIFEST_SHA256: "[0-9a-f]{64}"/, 'D24_PINNED_MANIFEST_SHA256: "abc"') },
  { name: "lax shell in a step", breaks: "strictShellEverywhere", apply: rep("      - name: Install dependencies (no lifecycle scripts)\n        run: |\n          set -euo pipefail\n", "      - name: Install dependencies (no lifecycle scripts)\n        run: |\n") },
  { name: "remove concurrency group", breaks: "singleRunAndShortTimeout", apply: rep("concurrency:\n  group: d24-stripe-test-proof\n  cancel-in-progress: false\n", "") },
  { name: "huge timeout", breaks: "singleRunAndShortTimeout", apply: rep("timeout-minutes: 25", "timeout-minutes: 360") },
  { name: "npm ci with scripts", breaks: "fixedNodeAndNoScripts", apply: rep("npm ci --ignore-scripts --no-audit", "npm ci --no-audit") },
  { name: "floating node", breaks: "fixedNodeAndNoScripts", apply: rep('node-version: "24.14.1"', 'node-version: "24"') },
  { name: "summary no longer shows sha", breaks: "summaryShowsShaAndHashFirst", apply: rep("commit SHA: \\`${RUN_SHA}\\`", "commit: hidden") },
  { name: "upload a whole folder", breaks: "uploadsOnlyEncryptedEvidenceWithShortRetention", apply: rep("path: ${{ runner.temp }}/d24-out/d24-evidence.enc.json", "path: ${{ runner.temp }}/d24-evidence/*") },
  { name: "long retention", breaks: "uploadsOnlyEncryptedEvidenceWithShortRetention", apply: rep("retention-days: 3", "retention-days: 90") },
  { name: "print the live output", breaks: "evidenceNeverPrintedToLog", apply: rep('run.ts --live > "$RUNNER_TEMP/d24-live-stdout.txt" 2>&1', "run.ts --live") },
  { name: "cat the preflight detail", breaks: "evidenceNeverPrintedToLog", apply: rep(`awk '/^(OK|FAIL|MANUAL)/ {print $1, $2}' "$RUNNER_TEMP/d24-preflight.txt"`, 'cat "$RUNNER_TEMP/d24-preflight.txt"') },
  { name: "evidence dir inside the workspace", breaks: "evidenceDirOutsideCheckout", apply: rep("D24_PROOF_EVIDENCE_DIR: ${{ runner.temp }}/d24-evidence\n        run: |\n          set -euo pipefail\n          " + LIVE_HEAD.split("\n")[0], "D24_PROOF_EVIDENCE_DIR: ${{ github.workspace }}/ev\n        run: |\n          set -euo pipefail\n          " + LIVE_HEAD.split("\n")[0]) },
  { name: "guards moved after upload", breaks: "stepOrder", apply: (t) => rep("- name: Guards (fail closed)", "- name: Zzz early (fail closed)")(t) + LATE_GUARDS },
];

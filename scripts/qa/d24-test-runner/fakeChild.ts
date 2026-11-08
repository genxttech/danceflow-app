// Fake child processes for --dry and the tests. No process is started, no network, no credential store. The fake emulates the exact output formats of
// git, npm, and the proof's CLI (--print-hash, --allow-list, --dry-run, --preflight, --live) so the runner's parsers are exercised for real.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manifest } from "../d24-m3d-proof/manifest";
import type { Exec, ExecResult } from "./exec";
import { sha256LfText, type MainVerifyOpts, type MainVerifyResult } from "./gitverify";
import { runnerManifest } from "./runnerpin";
import { KNOWN_RULE_IDS } from "./envelope";

export type FakeOpts = {
  commitSha: string;
  repoDir: string;
  dirty?: boolean;
  hiddenEdit?: boolean;
  /** hardware mode: merge-base --is-ancestor says the commit is NOT on the branch */
  notOnMain?: boolean;
  npmCiFails?: boolean;
  /** override what the fake proof reports as its manifest hash */
  proofHash?: string;
  proofFileCount?: number;
  ruleIds?: string[];
  dryRunOk?: boolean;
  preflightFail?: string[];
  preflightManual?: string[];
  /** live behaviour */
  live?: "ok" | "abort" | "unverifiable" | "no-evidence" | "overbudget" | "crash" | "timeout";
  /** hostile text appended to the live stdout (tests secret detection) */
  hostileStdout?: string;
  hostileEvidence?: string;
  /** runner-folder files (relative to scripts/qa/d24-test-runner) that git does NOT track (untracked or ignored): omitted from `git ls-files` */
  untracked?: string[];
  /** repo-relative path suffixes whose blob in the pinned commit differs from the disk, or that are absent from the commit's tree */
  tamperedContent?: string[];
  missingFromTree?: string[];
  /** what `git ls-remote` reports for the pinned branch, and what the fetched private ref then resolves to */
  lsRemoteSha?: string;
  fetchedSha?: string;
  /** captures the options of every simulated mainVerification call (what the runner passed) */
  mainCalls?: MainVerifyOpts[];
  /** captures every call (cmd + args + env) for assertions. Env values are kept so tests can check key placement. */
  calls?: Array<{ cmd: string; args: string[]; env: Record<string, string>; cwd: string }>;
};

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

// Brands: only executors created HERE are fakes. runEnvelope requires `dry === true` <=> the executor is a dry fake, so a caller cannot pass dry:true
// with a real executor to skip the owner-signature / credential / ledger gates, nor run a dry fake as if it were live.
const dryFakes = new WeakSet<Exec>();
const simulatedLiveFakes = new WeakSet<Exec>();
export const isDryFakeExec = (e: Exec) => dryFakes.has(e);
export const isSimulatedLiveExec = (e: Exec) => simulatedLiveFakes.has(e);
const simulatedMainVerify = new WeakMap<Exec, (o: MainVerifyOpts) => Promise<MainVerifyResult>>();
/** The simulated-live fake answers commit-on-main / committed-content itself (real git object walking is covered by realgit.test.ts). Only fakes have one. */
export const simulatedMainVerifyFor = (e: Exec) => simulatedMainVerify.get(e);

/** `simulateLive` is for tests of the LIVE gate path: still no process and no network, but accepted by runEnvelope with dry:false. */
export function createFakeExec(o: FakeOpts, hooks: { tap?: (cmd: string, args: string[]) => void; simulateLive?: boolean } = {}): Exec {
  const fn: Exec = async (cmd, args, opts) => {
    hooks.tap?.(cmd, args);
    o.calls?.push({ cmd, args, env: { ...opts.env }, cwd: opts.cwd });
    if (cmd === "git" || /[\\/]git(\.exe)?$/.test(cmd)) {
      const a: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-c") i++; // skip the "-c key=value" pair
        else if (args[i].startsWith("--git-dir=")) continue;
        else a.push(args[i]);
      }
      const mainSha = o.lsRemoteSha ?? "d".repeat(40);
      if (a[0] === "fetch") return ok();
      if (a[0] === "ls-remote") return ok(`${mainSha}\trefs/heads/main\n`);
      if (a[0] === "rev-parse" && a[a.length - 1].startsWith("refs/")) return ok(`${o.fetchedSha ?? mainSha}\n`);
      if (a[0] === "ls-files" && a[1] === "-z") {
        const dir = a[a.length - 1];
        let files: string[] = [];
        try {
          files = runnerManifest(join(opts.cwd, dir)).files.map((f) => f.path);
        } catch {
          files = [];
        }
        return ok(files.filter((f) => !(o.untracked ?? []).includes(f)).map((f) => `${dir}/${f}\0`).join(""));
      }
      if (a[0] === "merge-base") return { code: o.notOnMain ? 1 : 0, stdout: "", stderr: "" };
      if (a[0] === "rev-parse" && a[1] === "HEAD") return ok(`${o.commitSha}\n`);
      if (a[0] === "rev-parse") return ok(`${o.repoDir.replace(/\\/g, "/")}\n`);
      if (a[0] === "status") return ok(o.dirty ? " M scripts/qa/d24-m3d-proof/allowlist.ts\n" : "");
      if (a[0] === "diff-index") return { code: o.dirty ? 1 : 0, stdout: "", stderr: "" };
      if (a[0] === "ls-files") return ok(o.hiddenEdit ? "H a.ts\nh scripts/qa/d24-m3d-proof/guarded.ts\n" : "H a.ts\n");
      return ok();
    }
    // node <npm-cli.js> ci ...
    if (args.some((x) => /npm-cli\.js$/.test(x))) return o.npmCiFails ? { code: 1, stdout: "", stderr: "npm error integrity checksum failed" } : ok("added 1 package\n");
    const flag = args[args.length - 1];
    const proofDir = join(opts.cwd, "scripts", "qa", "d24-m3d-proof");
    if (flag === "--print-hash") {
      let m: { sha256: string; files: unknown[] };
      try {
        m = manifest(proofDir);
      } catch {
        m = { sha256: createHash("sha256").update("fake").digest("hex"), files: [] };
      }
      return ok(`script manifest SHA-256: ${o.proofHash ?? m.sha256}\nfiles: ${o.proofFileCount ?? m.files.length}\n`);
    }
    if (flag === "--allow-list") return ok(`Stripe-Version required on every request: 2026-03-25.dahlia\n${(o.ruleIds ?? [...KNOWN_RULE_IDS]).map((r) => `GET /v1/x  [${r}; Stripe-Account absent]`).join("\n")}\n`);
    if (flag === "--dry-run") return o.dryRunOk === false ? { code: 1, stdout: "OUTCOME: FAILED\n", stderr: "" } : ok("DRY RUN\nOUTCOME: OK\n");
    if (flag === "--preflight") {
      const lines = ["OK     node: node 24", ...(o.preflightFail ?? []).map((i) => `FAIL   ${i}: broken`), ...(o.preflightManual ?? ["sandbox", "connected-account", "key-permissions", "no-webhooks", "api-version", "local-postgres"]).map((i) => `MANUAL ${i}: confirm by hand`)];
      return { code: (o.preflightFail ?? []).length > 0 ? 2 : 0, stdout: `${lines.join("\n")}\npreflight: done\n`, stderr: "" };
    }
    if (flag === "--live") {
      if (o.live === "crash") throw new Error("spawn failed");
      if (o.live === "timeout") return { code: null, stdout: "", stderr: "", timedOut: true };
      const dir = opts.env.D24_PROOF_EVIDENCE_DIR;
      const mode = o.live ?? "ok";
      if (dir && mode !== "no-evidence") {
        mkdirSync(dir, { recursive: true });
        const clean = { skipped: null, stoppedBecause: null, deletedInvoices: ["in_a"], deletedCustomers: ["cus_a"], remainingInvoices: [], remainingCustomers: [], unverifiable: mode === "unverifiable" ? ["POST /v1/customers idem=d24proof-xxx"] : [], verifiedEmpty: mode !== "unverifiable" && mode !== "abort" };
        const ev = {
          outcome: mode === "ok" || mode === "overbudget" ? "OK" : "FAILED", runId: "fake1", mode: "live", scriptManifestSha256: o.proofHash ?? manifest(proofDir).sha256,
          callsUsed: mode === "overbudget" ? 41 : 30, blockedBeforeNetwork: 0,
          scenarios: [{ id: "S1", title: "x", checks: [{ id: "c1", ok: true, detail: "d" }, { id: "c2", ok: mode !== "abort", detail: "d" }] }],
          verdicts: { V1: { verdict: "PASS", basis: "b" }, V4: { verdict: "NOT TESTED", basis: "ledger" }, V7: { verdict: "NOT TESTED", basis: "ledger" } },
          cleanup: clean, abort: mode === "abort" ? { code: "unexpected_4xx_streak", message: "three 403" } : null, note: o.hostileEvidence ?? "",
        };
        writeFileSync(join(dir, "evidence-fake1.json"), JSON.stringify(ev, null, 2));
        writeFileSync(join(dir, "transcript-fake1.txt"), "1. GET /v1/account -> 200\nOUTCOME: OK\n");
      }
      return { code: mode === "ok" ? 0 : 1, stdout: `LIVE (fake)\nOUTCOME: ${mode === "ok" ? "OK" : "FAILED"}\n${o.hostileStdout ?? ""}`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unknown flag" };
  };
  if (hooks.simulateLive) {
    simulatedMainVerify.set(fn, async (mo) => {
      o.mainCalls?.push(mo);
      if (o.notOnMain) return { ancestry: { id: "commit-on-main", ok: false, detail: "SIMULATED: the pinned commit is not on the owner-merged branch" }, content: null };
      const ancestry = { id: "commit-on-main", ok: true, detail: "SIMULATED: the pinned commit is contained in the owner-merged branch" };
      if (!mo.pins) return { ancestry, content: null };
      const differ = mo.pins.filter((p) => {
        if ((o.tamperedContent ?? []).some((m) => p.rel.endsWith(m)) || (o.missingFromTree ?? []).some((m) => p.rel.endsWith(m))) return true;
        try {
          return sha256LfText(readFileSync(join(o.repoDir, p.rel))) !== p.sha256;
        } catch {
          return true;
        }
      });
      return { ancestry, content: { id: "committed-content", ok: differ.length === 0, detail: differ.length === 0 ? "SIMULATED: the held hashes equal the committed blobs" : `SIMULATED: ${differ.length} file(s) differ: ${differ.map((d) => d.rel).slice(0, 8).join(", ")}` } };
    });
  }
  (hooks.simulateLive ? simulatedLiveFakes : dryFakes).add(fn);
  return fn;
}

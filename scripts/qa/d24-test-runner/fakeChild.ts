// Fake child processes for --dry and the tests. No process is started, no network, no credential store. The fake emulates the exact output formats of
// git, npm, and the proof's CLI (--print-hash, --allow-list, --dry-run, --preflight, --live) so the runner's parsers are exercised for real.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manifest } from "../d24-m3d-proof/manifest";
import type { Exec, ExecResult } from "./exec";
import { KNOWN_RULE_IDS } from "./envelope";

export type FakeOpts = {
  commitSha: string;
  repoDir: string;
  dirty?: boolean;
  hiddenEdit?: boolean;
  npmCiFails?: boolean;
  /** override what the fake proof reports as its manifest hash */
  proofHash?: string;
  proofFileCount?: number;
  ruleIds?: string[];
  dryRunOk?: boolean;
  preflightFail?: string[];
  preflightManual?: string[];
  /** live behaviour */
  live?: "ok" | "abort" | "unverifiable" | "no-evidence" | "overbudget" | "crash";
  /** hostile text appended to the live stdout (tests secret detection) */
  hostileStdout?: string;
  hostileEvidence?: string;
  /** captures every call (cmd + args + env) for assertions. Env values are kept so tests can check key placement. */
  calls?: Array<{ cmd: string; args: string[]; env: Record<string, string>; cwd: string }>;
};

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

export function createFakeExec(o: FakeOpts): Exec {
  return async (cmd, args, opts) => {
    o.calls?.push({ cmd, args, env: { ...opts.env }, cwd: opts.cwd });
    if (cmd === "git") {
      const a = args.filter((x) => x !== "-c" && x !== "core.fsmonitor=false");
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
}

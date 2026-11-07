// Thin, parsed wrappers around the proof's own CLI. The runner trusts neither its own recomputation nor the proof's alone: it compares both.

import { join } from "node:path";
import type { Exec } from "./exec";

export const PROOF_ENTRY = "scripts/qa/d24-m3d-proof/run.ts";

export type ProofCall = { repoDir: string; env: Record<string, string>; exec: Exec; tsxCli?: string };

export const tsxCliPath = (repoDir: string) => join(repoDir, "node_modules", "tsx", "dist", "cli.mjs");

async function call(c: ProofCall, flag: string, timeoutMs: number) {
  return c.exec(process.execPath, [c.tsxCli ?? tsxCliPath(c.repoDir), PROOF_ENTRY, flag], { cwd: c.repoDir, env: c.env, timeoutMs });
}

export async function proofPrintHash(c: ProofCall): Promise<{ ok: boolean; sha256?: string; fileCount?: number }> {
  const r = await call(c, "--print-hash", 60_000);
  const h = /script manifest SHA-256: ([0-9a-f]{64})/.exec(r.stdout);
  const n = /^files: (\d+)/m.exec(r.stdout);
  return r.code === 0 && h ? { ok: true, sha256: h[1], fileCount: n ? Number(n[1]) : undefined } : { ok: false };
}

/** Rule ids exactly as the proof prints them: `[identity.platform; Stripe-Account absent]`. */
export async function proofAllowList(c: ProofCall): Promise<{ ok: boolean; ruleIds: string[] }> {
  const r = await call(c, "--allow-list", 60_000);
  const ids = [...r.stdout.matchAll(/\[([a-z_]+\.[a-z_]+);/g)].map((m) => m[1]);
  return { ok: r.code === 0 && ids.length > 0, ruleIds: [...new Set(ids)].sort() };
}

export async function proofDryRun(c: ProofCall): Promise<{ ok: boolean; detail: string }> {
  const r = await call(c, "--dry-run", 120_000);
  const ok = r.code === 0 && /OUTCOME: OK/.test(r.stdout);
  return { ok, detail: ok ? "dry run (fake client, no network) finished OUTCOME: OK" : `dry run did not finish OK (exit ${r.code})` };
}

export type PreflightLine = { status: "OK" | "FAIL" | "MANUAL"; id: string };
/** Runs the proof's own preflight (local only). `env` must be the proof environment. */
export async function proofPreflight(c: ProofCall): Promise<{ lines: PreflightLine[]; exitCode: number | null; stdout: string }> {
  const r = await call(c, "--preflight", 120_000);
  const lines = [...r.stdout.matchAll(/^(OK|FAIL|MANUAL)\s+([a-z0-9-]+):/gim)].map((m) => ({ status: m[1].toUpperCase() as PreflightLine["status"], id: m[2] }));
  return { lines, exitCode: r.code, stdout: r.stdout };
}

export async function proofLive(c: ProofCall) {
  return call(c, "--live", 30 * 60_000);
}

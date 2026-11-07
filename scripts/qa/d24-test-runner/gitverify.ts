// Clean-clone + pinned-commit verification. Read-only git queries plus `npm ci --ignore-scripts` (lockfile integrity). No Stripe, no credential.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec";

export type Gate = { id: string; ok: boolean; detail: string };

export type GitVerifyOpts = { repoDir: string; commitSha: string; lockfileSha256?: string; env: Record<string, string>; exec: Exec; runInstall: boolean; readLock?: (p: string) => Buffer; /** absolute git path (resolved from absolute PATH entries only); tests use the bare name with a fake exec */ gitBin?: string };

/** SHA-256 of package-lock.json with CRLF normalised, so a Windows autocrlf checkout and a Linux checkout pin the same value. */
export const lockfileSha = (buf: Buffer): string => createHash("sha256").update(buf.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");

/** Each query is a separate gate so a failure names exactly what was wrong. Order matters: nothing is installed unless the tree is already exactly the pinned commit. */
export async function verifyCleanClone(o: GitVerifyOpts): Promise<Gate[]> {
  const gates = await pristineGates(o);
  if (!gates[0].ok) return gates;
  return finishClone(o, gates);
}

/** HEAD == commit, repo root, clean tree, no diff vs HEAD, no hidden edits. Also used by the owner commands to prove they run from a pristine checkout. */
export async function pristineGates(o: Pick<GitVerifyOpts, "repoDir" | "commitSha" | "env" | "exec" | "gitBin">): Promise<Gate[]> {
  const gates: Gate[] = [];
  const git = (args: string[]) => o.exec(o.gitBin ?? "git", ["-c", "core.fsmonitor=false", ...args], { cwd: o.repoDir, env: o.env, timeoutMs: 60_000 });

  const head = await git(["rev-parse", "HEAD"]);
  const headSha = head.stdout.trim();
  gates.push({ id: "git-head", ok: head.code === 0 && headSha === o.commitSha, detail: head.code === 0 ? `HEAD ${headSha.slice(0, 12)} ${headSha === o.commitSha ? "==" : "!="} pinned ${o.commitSha.slice(0, 12)}` : "git rev-parse HEAD failed" });
  if (!gates[0].ok) return gates;

  const top = await git(["rev-parse", "--show-toplevel"]);
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  gates.push({ id: "git-toplevel", ok: top.code === 0 && norm(top.stdout.trim()) === norm(o.repoDir), detail: "repoDir is the root of the git working tree" });

  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
  gates.push({ id: "git-clean-tree", ok: status.code === 0 && status.stdout.trim() === "", detail: status.stdout.trim() === "" ? "no modified, staged or untracked files" : `${status.stdout.trim().split("\n").length} modified/staged/untracked path(s)` });

  const diff = await git(["diff-index", "--quiet", "HEAD", "--"]);
  gates.push({ id: "git-no-diff-vs-head", ok: diff.code === 0, detail: "no difference between the working tree and HEAD" });

  // assume-unchanged (lowercase tag) and skip-worktree (S) hide local edits from `git status`
  const lsv = await git(["ls-files", "-v"]);
  const hidden = lsv.stdout.split("\n").filter((l) => /^[a-zS] /.test(l));
  gates.push({ id: "git-no-hidden-edits", ok: lsv.code === 0 && hidden.length === 0, detail: hidden.length === 0 ? "no assume-unchanged / skip-worktree files" : `${hidden.length} file(s) flagged assume-unchanged or skip-worktree` });

  return gates;
}

async function finishClone(o: GitVerifyOpts, gates: Gate[]): Promise<Gate[]> {
  const git = (args: string[]) => o.exec(o.gitBin ?? "git", ["-c", "core.fsmonitor=false", ...args], { cwd: o.repoDir, env: o.env, timeoutMs: 60_000 });
  const read = o.readLock ?? ((p: string) => readFileSync(p));
  let lockSha = "";
  try {
    lockSha = lockfileSha(read(join(o.repoDir, "package-lock.json")));
  } catch {
    lockSha = "";
  }
  gates.push({ id: "lockfile-hash", ok: lockSha !== "" && (o.lockfileSha256 === undefined || lockSha === o.lockfileSha256), detail: lockSha === "" ? "package-lock.json unreadable" : o.lockfileSha256 === undefined ? `package-lock.json sha256 ${lockSha.slice(0, 16)} (not pinned by the envelope)` : `package-lock.json sha256 ${lockSha === o.lockfileSha256 ? "matches" : "DIFFERS from"} the envelope pin` });

  if (gates.some((g) => !g.ok)) return gates;

  if (o.runInstall) {
    const ci = await o.exec(process.execPath, [npmCliPath(), "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: o.repoDir, env: o.env, timeoutMs: 15 * 60_000 });
    gates.push({ id: "npm-ci", ok: ci.code === 0 && !ci.timedOut, detail: ci.code === 0 ? "npm ci --ignore-scripts verified the lockfile integrity hashes" : `npm ci failed (exit ${ci.code}); the lockfile and package.json disagree or integrity failed` });
    const after = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
    gates.push({ id: "git-clean-after-install", ok: after.code === 0 && after.stdout.trim() === "", detail: after.stdout.trim() === "" ? "install did not modify tracked or untracked-unignored files" : "install changed the working tree" });
  } else {
    gates.push({ id: "npm-ci", ok: false, detail: "npm ci was not run (install skipped): lockfile integrity NOT VERIFIED" });
  }
  return gates;
}

function npmCliPath(): string {
  const base = process.execPath.replace(/[\\/][^\\/]+$/, "");
  return join(base, "node_modules", "npm", "bin", "npm-cli.js");
}

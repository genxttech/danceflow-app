// Clean-clone + pinned-commit verification. Read-only git queries plus `npm ci --ignore-scripts` (lockfile integrity). No Stripe, no credential.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Exec } from "./exec";
import { PINNED_REF, PINNED_REPO_URL } from "./trustroot";

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

/** Git isolated from agent-writable configuration: no system or global config (so no url.<x>.insteadOf from ~/.gitconfig), no replace objects, no prompts. */
export function isolatedGitEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };
}

type GitOpts = { repoDir: string; env: Record<string, string>; exec: Exec; gitBin?: string };
const gitIn = (o: GitOpts) => (args: string[]) => o.exec(o.gitBin ?? "git", ["-c", "core.fsmonitor=false", ...args], { cwd: o.repoDir, env: isolatedGitEnv(o.env), timeoutMs: 120_000 });

/**
 * Every file the runner-folder hash covers (including the anchor) must be TRACKED by git. `git status` does not list ignored files (.git/info/exclude,
 * core.excludesFile), but the hash includes them, so an ignored anchor or source file would sit outside what the clean-tree and commit checks prove.
 */
export async function runnerTracked(o: GitOpts & { runnerRel: string; files: string[] }): Promise<Gate> {
  const ls = await gitIn(o)(["ls-files", "-z", "--", o.runnerRel]);
  if (ls.code !== 0) return { id: "runner-tracked", ok: false, detail: "git ls-files failed; tracked state of the runner files could not be established" };
  const tracked = new Set(ls.stdout.split("\0").filter((x) => x !== ""));
  const missing = o.files.filter((f) => !tracked.has(`${o.runnerRel}/${f}`));
  return { id: "runner-tracked", ok: missing.length === 0, detail: missing.length === 0 ? `all ${o.files.length} hashed runner files (including the anchor) are tracked by git` : `${missing.length} hashed runner file(s) are not tracked by git (untracked or ignored): ${missing.slice(0, 8).join(", ")}` };
}

const SUSPICIOUS_CONFIG = "^(url\.|http\.|include|includeif|credential\.|protocol\.|core\.(sshcommand|gitproxy|askpass)|remote\..*(url|pushurl|proxy))";

/**
 * Hardware mode only: the pinned commit (which contains the anchor file and the runner) must be an ancestor of the owner-merged branch of the
 * PINNED repository (trustroot.ts constants: not the anchor, not .git/config). Hardening against agent-writable git state: system/global config disabled,
 * replace objects off, no local url/http/proxy/include config, no shallow or replace refs or grafts; the branch tip is read with ls-remote, fetched into a
 * private ref, checked to be that exact commit, and ancestry is tested against that SHA (never FETCH_HEAD). Needs the network (GitHub, never Stripe).
 * This is still POLICY against a hostile same-user process (it controls the machine's git, TLS and filesystem): see the design doc.
 */
export async function commitOnMain(o: GitOpts & { commitSha: string; fileExists?: (p: string) => boolean }): Promise<Gate> {
  const git = gitIn(o);
  const no = (detail: string): Gate => ({ id: "commit-on-main", ok: false, detail });
  const cfg = await git(["config", "--local", "--get-regexp", SUSPICIOUS_CONFIG]);
  if (cfg.code === 0 && cfg.stdout.trim() !== "") return no("the repository's local git config redirects or alters remote access (url/http/proxy/include/credential entries): refused");
  const sh = await git(["rev-parse", "--is-shallow-repository"]);
  if (sh.code !== 0 || sh.stdout.trim() !== "false") return no("the repository is shallow or its state could not be read: refused");
  const rep = await git(["for-each-ref", "refs/replace"]);
  if (rep.code !== 0 || rep.stdout.trim() !== "") return no("replace refs exist (they can rewrite history seen by git): refused");
  const gp = await git(["rev-parse", "--git-path", "info/grafts"]);
  if (gp.code !== 0 || (o.fileExists ?? existsSync)(resolve(o.repoDir, gp.stdout.trim()))) return no("an info/grafts file exists or could not be checked (it can rewrite history seen by git): refused");

  const lr = await git(["ls-remote", PINNED_REPO_URL, PINNED_REF]);
  const tip = lr.stdout.trim().split(/\s+/)[0] ?? "";
  if (lr.code !== 0 || !/^[0-9a-f]{40}$/.test(tip)) return no(`could not read ${PINNED_REF} of the pinned repository (exit ${lr.code}); a hardware-approved run needs the pinned commit to be on the owner-merged branch`);
  const privateRef = "refs/d24-runner/main-check";
  const f = await git(["fetch", "--quiet", "--no-tags", PINNED_REPO_URL, `+${PINNED_REF}:${privateRef}`]);
  if (f.code !== 0 || f.timedOut) return no(`could not fetch ${PINNED_REF} from the pinned repository (exit ${f.code})`);
  const got = await git(["rev-parse", "--verify", privateRef]);
  if (got.code !== 0 || got.stdout.trim() !== tip) return no("the fetched branch tip differs from what ls-remote reported (changed during the check, or git is being redirected): refused");
  const a = await git(["merge-base", "--is-ancestor", o.commitSha, tip]);
  return { id: "commit-on-main", ok: a.code === 0, detail: a.code === 0 ? `${o.commitSha.slice(0, 12)} is contained in ${PINNED_REF} (${tip.slice(0, 12)}) of the pinned repository` : `${o.commitSha.slice(0, 12)} is NOT contained in ${PINNED_REF} of the pinned repository: the runner and anchor were not merged by the owner` };
}

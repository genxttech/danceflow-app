// Clean-clone + pinned-commit verification. Read-only git queries plus `npm ci --ignore-scripts` (lockfile integrity). No Stripe, no credential.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const git = (args: string[]) => o.exec(o.gitBin ?? "git", ["-c", "core.fsmonitor=false", ...args], { cwd: o.repoDir, env: isolatedGitEnv(o.env), timeoutMs: 60_000 });

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
  const git = (args: string[]) => o.exec(o.gitBin ?? "git", ["-c", "core.fsmonitor=false", ...args], { cwd: o.repoDir, env: isolatedGitEnv(o.env), timeoutMs: 60_000 });
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
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_/i.test(k))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };
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

export type MainVerifyOpts = GitOpts & {
  commitSha: string;
  /** TEST ONLY: the runner never passes this; the default is the trustroot.ts constant. */
  remoteUrl?: string;
  /** repo-relative files whose on-disk bytes must equal the blobs of commitSha (runner folder, anchor, proof folder) */
  contentFiles?: string[];
  readFile?: (rel: string) => Buffer;
  tmpRoot?: string;
};
export type MainVerifyResult = { ancestry: Gate; content: Gate | null };

/** Git blob id of the CRLF-normalised bytes (the form git stores). */
export const blobSha = (buf: Buffer): string => {
  const lf = Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return createHash("sha1").update(`blob ${lf.length}\0`).update(lf).digest("hex");
};

/**
 * Hardware mode only. Two checks, both done in a FRESH PRIVATE BARE REPOSITORY the runner creates itself, never in the working repository (whose
 * config, config.worktree, hooks, commit-graph, alternates, grafts and refs an agent can write):
 *  1. ANCESTRY: the pinned commit must be an ancestor of the tip of the owner-merged branch of the PINNED repository (trustroot.ts constants). The tip is
 *     read with ls-remote, fetched into the temp repo, checked to be that exact commit, and ancestry is tested against that SHA. The temp repo has no
 *     hooks (core.hooksPath -> empty dir), no commit-graph, no alternates, no worktree config, no grafts, no replace objects, and no system/global config.
 *     The commit object exists there only if the fetch brought it, i.e. only if it is reachable from the branch.
 *  2. CONTENT: the CRLF-normalised bytes on disk of every listed file (runner folder incl. anchor, proof folder) must hash to the blob recorded for that
 *     path in that commit. This does not trust git status / the stat cache, which a same-length rewrite with a restored mtime defeats.
 * Needs the network (GitHub, never Stripe) and anonymous read access to the pinned repository: the isolated environment has no credential helper.
 * Still POLICY against a hostile same-user process (it controls the machine's git binary, TLS trust, filesystem and the runner code itself).
 */
export async function mainVerification(o: MainVerifyOpts): Promise<MainVerifyResult> {
  const no = (detail: string): MainVerifyResult => ({ ancestry: { id: "commit-on-main", ok: false, detail }, content: null });
  let root: string;
  try {
    root = mkdtempSync(join(o.tmpRoot ?? tmpdir(), "d24-main-"));
  } catch {
    return no("could not create the private verification repository: refused");
  }
  try {
    const hooks = join(root, "no-hooks");
    const repo = join(root, "r.git");
    mkdirSync(hooks);
    const clean = Object.fromEntries(Object.entries(o.env).filter(([k]) => !/^GIT_/i.test(k)));
    const env = isolatedGitEnv(clean);
    const bin = o.gitBin ?? "git";
    const base = ["-c", `core.hooksPath=${hooks}`, "-c", "core.commitGraph=false", "-c", "core.fsmonitor=false", "-c", "extensions.worktreeConfig=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.fsckObjects=true"];
    const run = (args: string[]) => o.exec(bin, [...base, ...args], { cwd: root, env, timeoutMs: 180_000 });
    const g = (args: string[]) => run([`--git-dir=${repo}`, ...args]);
    const url = o.remoteUrl ?? PINNED_REPO_URL;

    const init = await run(["init", "--bare", "--quiet", repo]);
    if (init.code !== 0) return no("could not initialise the private verification repository: refused");
    const lr = await g(["ls-remote", url, PINNED_REF]);
    const tip = lr.stdout.trim().split(/\s+/)[0] ?? "";
    if (lr.code !== 0 || !/^[0-9a-f]{40}$/.test(tip)) return no(`could not read ${PINNED_REF} of the pinned repository anonymously (exit ${lr.code}); a hardware-approved run needs the pinned commit to be on the owner-merged branch`);
    const privateRef = "refs/d24-runner/main-check";
    const f = await g(["fetch", "--quiet", "--no-tags", url, `+${PINNED_REF}:${privateRef}`]);
    if (f.code !== 0 || f.timedOut) return no(`could not fetch ${PINNED_REF} from the pinned repository (exit ${f.code})`);
    const got = await g(["rev-parse", "--verify", privateRef]);
    if (got.code !== 0 || got.stdout.trim() !== tip) return no("the fetched branch tip differs from what ls-remote reported (changed during the check): refused");
    const a = await g(["merge-base", "--is-ancestor", o.commitSha, tip]);
    const ancestry: Gate = { id: "commit-on-main", ok: a.code === 0, detail: a.code === 0 ? `${o.commitSha.slice(0, 12)} is contained in ${PINNED_REF} (${tip.slice(0, 12)}) of the pinned repository (checked in a private temporary repository)` : `${o.commitSha.slice(0, 12)} is NOT contained in ${PINNED_REF} of the pinned repository: the runner and anchor were not merged by the owner` };
    if (!ancestry.ok || !o.contentFiles) return { ancestry, content: null };

    const lt = await g(["ls-tree", "-r", "-z", "--full-tree", o.commitSha, "--", ...o.contentFiles]);
    if (lt.code !== 0) return { ancestry, content: { id: "committed-content", ok: false, detail: "could not list the pinned commit's files: refused" } };
    const tree = new Map<string, { mode: string; sha: string }>();
    for (const rec of lt.stdout.split("\0")) {
      const m = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(rec);
      if (m) tree.set(m[3], { mode: m[1], sha: m[2] });
    }
    const read = o.readFile ?? ((rel: string) => readFileSync(join(o.repoDir, rel)));
    const bad: string[] = [];
    for (const rel of o.contentFiles) {
      const t = tree.get(rel);
      let disk = "";
      try {
        disk = blobSha(read(rel));
      } catch {
        disk = "";
      }
      if (!t || t.mode === "120000" || t.sha !== disk) bad.push(rel);
    }
    return { ancestry, content: { id: "committed-content", ok: bad.length === 0, detail: bad.length === 0 ? `all ${o.contentFiles.length} runner, anchor and proof files are byte-identical to the blobs of the pinned commit (stat cache not trusted)` : `${bad.length} file(s) differ from, or are absent in, the pinned commit: ${bad.slice(0, 8).join(", ")}` } };
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Ancestry only (the first of the two checks). */
export async function commitOnMain(o: Omit<MainVerifyOpts, "contentFiles">): Promise<Gate> {
  return (await mainVerification(o)).ancestry;
}

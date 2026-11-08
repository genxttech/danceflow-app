// Clean-clone + pinned-commit verification. Read-only git queries plus `npm ci --ignore-scripts` (lockfile integrity). No Stripe, no credential.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec";
import { nodeTip, type TipResult } from "./remotetip";
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

export type Pin = { rel: string; sha256: string };
export type MainVerifyOpts = GitOpts & {
  commitSha: string;
  /** repo-relative files with the sha256 (CRLF-normalised) the RUNNER ALREADY HOLDS from when it parsed/hashed them; never re-read from disk here */
  pins?: Pin[];
  /** TEST ONLY: the runner never passes any of these four; the defaults are the trustroot.ts constant and the node smart-HTTP lookup. */
  remoteUrl?: string;
  lookupTip?: (url: string, ref: string) => Promise<TipResult>;
  tmpRoot?: string;
  testHooks?: { afterInit?: (repo: string) => void; afterFetch?: (repo: string) => void };
};
export type MainVerifyResult = { ancestry: Gate; content: Gate | null };

export const gitObjectSha = (type: string, body: Buffer): string => createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");
export const sha256LfText = (buf: Buffer): string => createHash("sha256").update(buf.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");

type GitObj = { type: string; body: Buffer };
/** Parses a `cat-file --batch` stream (read as latin1 = byte-exact) and keeps ONLY objects whose SHA-1 we recompute ourselves; keyed by the recomputed id. */
export function parseBatch(stream: string): Map<string, GitObj> {
  const out = new Map<string, GitObj>();
  let pos = 0;
  while (pos < stream.length) {
    const nl = stream.indexOf("\n", pos);
    if (nl < 0) break;
    const m = /^[0-9a-f]{40} (blob|tree|commit|tag) (\d+)$/.exec(stream.slice(pos, nl));
    if (!m) {
      pos = nl + 1; // "<id> missing" or noise: nothing is added
      continue;
    }
    const size = Number(m[2]);
    const body = Buffer.from(stream.slice(nl + 1, nl + 1 + size), "latin1");
    pos = nl + 1 + size + 1;
    if (body.length !== size) break;
    out.set(gitObjectSha(m[1], body), { type: m[1], body });
  }
  return out;
}

export function parseCommit(body: Buffer): { tree: string | null; parents: string[] } {
  const head = body.toString("latin1").split("\n\n")[0].split("\n");
  const tree = head.find((l) => /^tree [0-9a-f]{40}$/.test(l))?.slice(5) ?? null;
  return { tree, parents: head.filter((l) => /^parent [0-9a-f]{40}$/.test(l)).map((l) => l.slice(7)) };
}

export function parseTree(body: Buffer): Array<{ mode: string; name: string; sha: string }> {
  const out: Array<{ mode: string; name: string; sha: string }> = [];
  let p = 0;
  while (p < body.length) {
    const sp = body.indexOf(0x20, p);
    const nul = sp < 0 ? -1 : body.indexOf(0x00, sp);
    if (sp < 0 || nul < 0 || nul + 21 > body.length) break;
    out.push({ mode: body.toString("latin1", p, sp), name: body.toString("latin1", sp + 1, nul), sha: body.toString("hex", nul + 1, nul + 21) });
    p = nul + 21;
  }
  return out;
}

/**
 * Hardware mode only. Nothing here trusts git's repository state, the temporary repository included (a same-user process can write into it between our
 * commands). Git is used only as a TRANSPORT and an OBJECT READER; every decision is made in node from objects whose SHA-1 we recompute ourselves:
 *  1. TIP: read without git (remotetip.ts: no repository, no config, no hooks) and matched on the exact ref name.
 *  2. FETCH into a fresh private bare repository (isolated env, hooks off). Redirected fetch, grafts, alternates, replace refs or a forged commit-graph can
 *     only supply wrong or missing objects, which fail the SHA-1 check or the walk: they can cause a refusal, never a pass.
 *  3. ANCESTRY: the commit list comes from `rev-list`, but only as a hint; the parents are read from verified commit objects and the walk from the tip to
 *     the pinned commit is done here.
 *  4. CONTENT: the pinned commit's tree is walked through verified tree objects; each pinned file's blob (verified) is hashed (sha256, CRLF-normalised) and
 *     must equal the hash the RUNNER already holds for it (parsed/hashed earlier), not a fresh read of the disk.
 * Needs the network (GitHub, never Stripe) and ANONYMOUS read access to the pinned repository. Still POLICY against a hostile same-user process.
 */
export async function mainVerification(o: MainVerifyOpts): Promise<MainVerifyResult> {
  const no = (detail: string): MainVerifyResult => ({ ancestry: { id: "commit-on-main", ok: false, detail }, content: null });
  const url = o.remoteUrl ?? PINNED_REPO_URL;
  const tipRes = await (o.lookupTip ?? ((u: string, r: string) => nodeTip(u, r)))(url, PINNED_REF);
  if (!tipRes.ok) return no(`could not read ${PINNED_REF} of the pinned repository: ${tipRes.why}. The gate needs ANONYMOUS read access (public repository or mirror); an explicit credential helper is an owner decision`);
  const tip = tipRes.sha;
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
    const env = isolatedGitEnv(o.env);
    const bin = o.gitBin ?? "git";
    const base = ["-c", `core.hooksPath=${hooks}`, "-c", "core.commitGraph=false", "-c", "core.fsmonitor=false", "-c", "extensions.worktreeConfig=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.fsckObjects=true"];
    const run = (args: string[], extra: { input?: string; latin1?: boolean } = {}) => o.exec(bin, [...base, ...args], { cwd: root, env, timeoutMs: 180_000, input: extra.input, encoding: extra.latin1 ? "latin1" : undefined });
    const g = (args: string[], extra: { input?: string; latin1?: boolean } = {}) => run([`--git-dir=${repo}`, ...args], extra);

    const init = await run(["init", "--bare", "--quiet", repo]);
    if (init.code !== 0) return no("could not initialise the private verification repository: refused");
    o.testHooks?.afterInit?.(repo);
    const f = await g(["fetch", "--quiet", "--no-tags", url, `+${PINNED_REF}:refs/d24-runner/main-check`]);
    if (f.code !== 0 || f.timedOut) return no(`could not fetch ${PINNED_REF} from the pinned repository (exit ${f.code})`);
    o.testHooks?.afterFetch?.(repo);

    const readObjects = async (shas: string[]): Promise<Map<string, GitObj> | null> => {
      const all = new Map<string, GitObj>();
      for (let i = 0; i < shas.length; i += 1500) {
        const r = await g(["cat-file", "--batch"], { input: `${shas.slice(i, i + 1500).join("\n")}\n`, latin1: true });
        if (r.code !== 0 || r.timedOut) return null;
        for (const [k, v] of parseBatch(r.stdout)) all.set(k, v);
      }
      return all;
    };

    // ancestry, decided here from verified commit objects
    const rl = await g(["rev-list", tip]);
    const listed = rl.stdout.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l));
    if (rl.code !== 0 || !listed.includes(tip)) return no("could not list the history of the pinned branch tip: refused");
    const objs = await readObjects(listed);
    if (!objs) return no("could not read the fetched history: refused");
    const commits = new Map<string, { tree: string | null; parents: string[] }>();
    for (const [sha, ob] of objs) if (ob.type === "commit") commits.set(sha, parseCommit(ob.body));
    if (!commits.has(tip)) return no("the branch tip commit could not be verified (its SHA-1 does not match): refused");
    const seen = new Set<string>([tip]);
    const stack = [tip];
    while (stack.length > 0) {
      const c = stack.pop() as string;
      for (const p of commits.get(c)?.parents ?? []) {
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    const onMain = seen.has(o.commitSha) && commits.has(o.commitSha);
    const ancestry: Gate = { id: "commit-on-main", ok: onMain, detail: onMain ? `${o.commitSha.slice(0, 12)} is contained in ${PINNED_REF} (${tip.slice(0, 12)}) of the pinned repository (tip read without git, history verified object by object)` : `${o.commitSha.slice(0, 12)} is NOT contained in ${PINNED_REF} of the pinned repository (or its history could not be verified): the runner and anchor were not merged by the owner` };
    if (!ancestry.ok || !o.pins) return { ancestry, content: null };

    // content: the committed blobs against the hashes the runner already holds
    const bad = (detail: string): MainVerifyResult => ({ ancestry, content: { id: "committed-content", ok: false, detail } });
    const rootTree = commits.get(o.commitSha)?.tree;
    if (!rootTree) return bad("the pinned commit has no verifiable tree: refused");
    type St = { pin: Pin; comps: string[]; i: number; tree: string; blob?: { mode: string; sha: string } | null };
    const states: St[] = o.pins.map((pin) => ({ pin, comps: pin.rel.split("/"), i: 0, tree: rootTree }));
    const trees = new Map<string, Array<{ mode: string; name: string; sha: string }>>();
    for (let guard = 0; guard < 32; guard++) {
      const open = states.filter((s) => s.blob === undefined);
      if (open.length === 0) break;
      const want = [...new Set(open.map((s) => s.tree))].filter((t) => !trees.has(t));
      if (want.length > 0) {
        const got = await readObjects(want);
        if (!got) return bad("could not read the pinned commit's trees: refused");
        for (const [sha, ob] of got) if (ob.type === "tree") trees.set(sha, parseTree(ob.body));
      }
      for (const s of open) {
        const ents = trees.get(s.tree);
        if (!ents) {
          s.blob = null;
          continue;
        }
        const e = ents.find((x) => x.name === Buffer.from(s.comps[s.i], "utf8").toString("latin1"));
        if (!e) {
          s.blob = null;
        } else if (s.i === s.comps.length - 1) {
          s.blob = /^100(644|755)$/.test(e.mode) ? { mode: e.mode, sha: e.sha } : null;
        } else if (e.mode === "40000") {
          s.tree = e.sha;
          s.i++;
        } else {
          s.blob = null;
        }
      }
    }
    for (const s of states) if (s.blob === undefined) s.blob = null;
    const blobShas = [...new Set(states.map((s) => s.blob?.sha).filter((x): x is string => Boolean(x)))];
    const blobs = blobShas.length > 0 ? await readObjects(blobShas) : new Map<string, GitObj>();
    if (!blobs) return bad("could not read the pinned commit's files: refused");
    const differ: string[] = [];
    for (const s of states) {
      const ob = s.blob ? blobs.get(s.blob.sha) : undefined;
      if (!ob || ob.type !== "blob" || sha256LfText(ob.body) !== s.pin.sha256) differ.push(s.pin.rel);
    }
    return { ancestry, content: { id: "committed-content", ok: differ.length === 0, detail: differ.length === 0 ? `all ${o.pins.length} runner, anchor and proof files: the hashes the runner holds equal the verified blobs of the pinned commit` : `${differ.length} file(s) differ from, or are absent in, the pinned commit: ${differ.slice(0, 8).join(", ")}` } };
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Ancestry only. */
export async function commitOnMain(o: Omit<MainVerifyOpts, "pins">): Promise<Gate> {
  return (await mainVerification(o)).ancestry;
}

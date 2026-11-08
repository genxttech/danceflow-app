// Fix-delta review of PR #419, findings F1-F5: REAL git (no fake executor) against local file:// upstreams. Each scenario also runs a faithful replica of the
// previous in-working-repo algorithm ("legacy") to show that the attack really works against it, and then shows the new private-temporary-repository gate
// refuses. No network, no Stripe, no credential: only git against throwaway repositories under the OS temp directory.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveGit } from "../bins";
import { realExec } from "../exec";
import { isolatedGitEnv, mainVerification, pristineGates, sha256LfText, type MainVerifyOpts, type Pin } from "../gitverify";
import type { TipResult } from "../remotetip";
import { tmp } from "./helpers";

const gitBin = resolveGit(process.env.PATH);
const describeGit = gitBin ? describe : describe.skip;
const BASE_ENV: Record<string, string> = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", TMP: process.env.TMP ?? process.env.TMPDIR ?? "/tmp" };
const IDENT = ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"];

function sh(cwd: string, args: string[], extra: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync(gitBin as string, [...IDENT, ...args], { cwd, env: { ...isolatedGitEnv(BASE_ENV), ...extra } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}`.trim() };
}
function g(cwd: string, ...args: string[]): string {
  const r = sh(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code})`);
  return r.out;
}

const ANCHOR = "scripts/qa/d24-test-runner/owner-hw-anchor.json";
const OTHER = "scripts/qa/d24-test-runner/other.ts";
const GOOD = '{"key":"AAAAAAAAAAAAAAAA"}\n';
const EVIL = '{"key":"BBBBBBBBBBBBBBBB"}\n';

type World = { dir: string; up: string; upUrl: string; work: string; A: string; M: string; B: string; C: string };

/** upstream (main = A -> M -> B), a normal clone of it (origin present), and an unmerged agent commit C (child of A) in the clone. */
function world(): World {
  const dir = tmp();
  const up = join(dir, "up.git");
  g(dir, "init", "--bare", "-b", "main", up);
  const seed = join(dir, "seed");
  g(dir, "init", "-b", "main", seed);
  mkdirSync(join(seed, "scripts", "qa", "d24-test-runner"), { recursive: true });
  writeFileSync(join(seed, ANCHOR), GOOD);
  writeFileSync(join(seed, OTHER), "export const a = 1;\n");
  g(seed, "add", "-A");
  g(seed, "commit", "-q", "-m", "A");
  const A = g(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "mid.txt"), "m\n");
  g(seed, "add", "-A");
  g(seed, "commit", "-q", "-m", "M");
  const M = g(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "README.md"), "b\n");
  g(seed, "add", "-A");
  g(seed, "commit", "-q", "-m", "B");
  const B = g(seed, "rev-parse", "HEAD");
  const upUrl = pathToFileURL(up).href;
  g(seed, "push", "-q", upUrl, "main:refs/heads/main");
  const work = join(dir, "work");
  g(dir, "clone", "-q", upUrl, work);
  g(work, "checkout", "-q", "-b", "agent", A);
  writeFileSync(join(work, "agent.txt"), "agent change\n");
  g(work, "add", "-A");
  g(work, "commit", "-q", "-m", "C (unmerged)");
  const C = g(work, "rev-parse", "HEAD");
  g(work, "checkout", "-q", "main");
  return { dir, up, upUrl, work, A, M, B, C };
}

/** Faithful replica of the PREVIOUS commit-on-main (bdc4a9c5): runs inside the working repository. */
const OLD_REGEX = "^(url.|http.|include|includeif|credential.|protocol.|core.(sshcommand|gitproxy|askpass)|remote..*(url|pushurl|proxy))";
function legacy(w: World, pin: string): { ok: boolean; why: string } {
  const r = (args: string[]) => sh(w.work, ["-c", "core.fsmonitor=false", ...args]);
  const cfg = r(["config", "--local", "--get-regexp", OLD_REGEX]);
  if (cfg.code === 0 && cfg.out !== "") return { ok: false, why: "config" };
  if (r(["rev-parse", "--is-shallow-repository"]).out !== "false") return { ok: false, why: "shallow" };
  if (r(["for-each-ref", "refs/replace"]).out !== "") return { ok: false, why: "replace" };
  const gp = r(["rev-parse", "--git-path", "info/grafts"]).out;
  if (existsSync(join(w.work, gp))) return { ok: false, why: "grafts" };
  const tip = r(["ls-remote", w.upUrl, "refs/heads/main"]).out.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(tip)) return { ok: false, why: "ls-remote" };
  if (r(["fetch", "--quiet", "--no-tags", w.upUrl, "+refs/heads/main:refs/d24-runner/main-check"]).code !== 0) return { ok: false, why: "fetch" };
  if (r(["rev-parse", "--verify", "refs/d24-runner/main-check"]).out !== tip) return { ok: false, why: "tip" };
  const a = r(["merge-base", "--is-ancestor", pin, tip]);
  return { ok: a.code === 0, why: a.code === 0 ? "ancestor" : "not-ancestor" };
}

/** The tip lookup of these tests: git ls-remote against the local upstream (the runner uses the repository-free node lookup instead), exact ref match. */
const lookupTipGit = (w: World) => async (_u: string, ref: string): Promise<TipResult> => {
  const r = sh(w.dir, ["ls-remote", w.upUrl, ref]);
  const hits = r.out.split("\n").map((l) => l.split(/\s+/)).filter((p) => p[1] === ref);
  return hits.length === 1 && /^[0-9a-f]{40}$/.test(hits[0][0]) ? { ok: true, sha: hits[0][0] } : { ok: false, why: "ls-remote" };
};
/** The hashes a run would hold right now for these files (read from the working tree). */
const held = (w: World, files: string[]): Pin[] => files.map((rel) => ({ rel, sha256: sha256LfText(readFileSync(join(w.work, rel))) }));
const real = (w: World, pin: string, pins?: Pin[], extra: Partial<MainVerifyOpts> = {}) => mainVerification({ repoDir: w.work, commitSha: pin, env: BASE_ENV, exec: realExec, gitBin: gitBin as string, remoteUrl: w.upUrl, lookupTip: lookupTipGit(w), pins, ...extra });
const T = 120_000;

describeGit("real git: the commit-on-main gate (F1-F5)", () => {
  it("F5: a NORMAL clone (remote.origin.url present) passes for a commit on main and refuses an unmerged one; the previous regex refused every clone", async () => {
    const w = world();
    expect(sh(w.work, ["config", "--local", "--get", "remote.origin.url"]).out).toBe(w.upUrl);
    const onMain = await real(w, w.B);
    expect(onMain.ancestry.ok, onMain.ancestry.detail).toBe(true);
    const unmerged = await real(w, w.C);
    expect(unmerged.ancestry.ok).toBe(false);
    expect(unmerged.ancestry.detail).toMatch(/NOT contained/);
    // the previous algorithm refused the normal clone outright, so its hardening never ran against real git
    expect(legacy(w, w.B)).toEqual({ ok: false, why: "config" });
  }, T);

  it("F1: url.<x>.insteadOf in config.worktree (extensions.worktreeConfig) redirects the PINNED URL: the previous gate is fooled, the temporary-repository gate is not", async () => {
    const w = world();
    // the agent's own "upstream" whose main IS its unmerged commit C
    const agent = join(w.dir, "agent.git");
    g(w.dir, "init", "--bare", "-b", "main", agent);
    g(w.work, "push", "-q", pathToFileURL(agent).href, `${w.C}:refs/heads/main`);
    g(w.work, "remote", "remove", "origin");
    g(w.work, "config", "extensions.worktreeConfig", "true");
    g(w.work, "config", "--worktree", `url.${pathToFileURL(agent).href}.insteadOf`, w.upUrl);
    expect(sh(w.work, ["ls-remote", w.upUrl, "refs/heads/main"]).out).toContain(w.C); // the redirect is live
    expect(legacy(w, w.C)).toEqual({ ok: true, why: "ancestor" }); // PREVIOUS GATE FOOLED
    const r = await real(w, w.C);
    expect(r.ancestry.ok).toBe(false);
    expect(r.ancestry.detail).toMatch(/NOT contained/);
  }, T);

  it("F2: a hand-edited commit-graph makes an unmerged commit look like an ancestor of main: the previous gate is fooled, the temporary-repository gate is not", async () => {
    const w = world();
    g(w.work, "remote", "remove", "origin");
    g(w.work, "-c", "commitGraph.generationVersion=1", "commit-graph", "write", "--reachable");
    forgeParent(w.work, w.M, w.C); // the middle commit's first parent := C (the tip itself is parsed from the object, deeper ancestors come from the graph)
    expect(sh(w.work, ["merge-base", "--is-ancestor", w.C, w.B]).code).toBe(0); // the lie is live in the working repository
    expect(sh(w.work, ["-c", "core.commitGraph=false", "merge-base", "--is-ancestor", w.C, w.B]).code).toBe(1); // ...and is only a lie
    expect(legacy(w, w.C)).toEqual({ ok: true, why: "ancestor" }); // PREVIOUS GATE FOOLED
    const r = await real(w, w.C);
    expect(r.ancestry.ok).toBe(false);
  }, T);

  it("F3: a reference-transaction hook plants info/grafts DURING the fetch (after the pre-check): the previous gate is fooled, the temporary repository never runs the hook", async () => {
    const w = world();
    g(w.work, "remote", "remove", "origin");
    const grafts = join(w.work, ".git", "info", "grafts").replace(/\\/g, "/");
    const hook = join(w.work, ".git", "hooks", "reference-transaction");
    mkdirSync(join(w.work, ".git", "hooks"), { recursive: true });
    mkdirSync(join(w.work, ".git", "info"), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\nif [ "$1" = "committed" ]; then echo "${w.B} ${w.C}" >> "${grafts}"; fi\nexit 0\n`);
    chmodSync(hook, 0o755);
    expect(existsSync(grafts)).toBe(false); // nothing for a pre-check to see
    expect(legacy(w, w.C)).toEqual({ ok: true, why: "ancestor" }); // PREVIOUS GATE FOOLED (the fetch fired the hook)
    expect(existsSync(grafts)).toBe(true);
    // fresh world so the planted file does not exist for the new gate either
    const w2 = world();
    g(w2.work, "remote", "remove", "origin");
    const grafts2 = join(w2.work, ".git", "info", "grafts").replace(/\\/g, "/");
    const hook2 = join(w2.work, ".git", "hooks", "reference-transaction");
    mkdirSync(join(w2.work, ".git", "hooks"), { recursive: true });
    mkdirSync(join(w2.work, ".git", "info"), { recursive: true });
    writeFileSync(hook2, `#!/bin/sh\nif [ "$1" = "committed" ]; then echo "${w2.B} ${w2.C}" >> "${grafts2}"; fi\nexit 0\n`);
    chmodSync(hook2, 0o755);
    const r = await real(w2, w2.C);
    expect(r.ancestry.ok).toBe(false);
    expect(existsSync(grafts2)).toBe(false); // the hook was never executed
  }, T);

  it("F4: a TRACKED anchor rewritten with the same length and its mtime restored passes git status/diff-index (stat cache); the committed-content check catches it", async () => {
    const w = world();
    sh(w.work, ["config", "core.trustctime", "false"]);
    sh(w.work, ["config", "core.checkStat", "minimal"]);
    const old = new Date("2020-01-01T00:00:00Z");
    const files = [ANCHOR, OTHER];
    for (const f of files) utimesSync(join(w.work, f), old, old);
    g(w.work, "update-index", "--really-refresh");
    const before = await real(w, w.B, held(w, files));
    expect(before.content?.ok, before.content?.detail).toBe(true);
    writeFileSync(join(w.work, ANCHOR), EVIL);
    expect(EVIL.length).toBe(GOOD.length);
    utimesSync(join(w.work, ANCHOR), old, old);
    const pristine = await pristineGates({ repoDir: w.work, commitSha: w.B, env: BASE_ENV, exec: realExec, gitBin: gitBin as string });
    expect(pristine.map((x) => `${x.id}:${x.ok}`).join(" ")).not.toContain("false"); // EVERY stat-cache based gate is clean
    const after = await real(w, w.B, held(w, files));
    expect(after.ancestry.ok).toBe(true); // honest: HEAD really is on main
    expect(after.content?.ok).toBe(false);
    expect(after.content?.detail).toContain(ANCHOR);
    // a CRLF checkout of the same text still matches (normalised)
    writeFileSync(join(w.work, ANCHOR), GOOD.replace(/\n/g, "\r\n"));
    expect((await real(w, w.B, held(w, files))).content?.ok).toBe(true);
  }, T);

  it("N2: the hash taken when the file was PARSED is what is compared: a fake anchor parsed, then the genuine bytes swapped back before the check, is refused", async () => {
    const w = world();
    writeFileSync(join(w.work, ANCHOR), EVIL); // the agent's anchor is what the run parses and hashes
    const heldAtParse = held(w, [ANCHOR, OTHER]);
    writeFileSync(join(w.work, ANCHOR), GOOD); // ...and the genuine bytes are put back while npm ci runs: the DISK now equals the commit
    expect(sha256LfText(readFileSync(join(w.work, ANCHOR)))).toBe(sha256LfText(Buffer.from(GOOD)));
    const r = await real(w, w.B, heldAtParse);
    expect(r.ancestry.ok).toBe(true);
    expect(r.content?.ok).toBe(false);
    expect(r.content?.detail).toContain(ANCHOR);
    expect((await real(w, w.B, held(w, [ANCHOR, OTHER]))).content?.ok).toBe(true); // sanity: genuinely held genuine bytes pass
  }, T);

  it("N1: files planted INSIDE the temporary repository (alternates, info/grafts, url.insteadOf, a redirected fetch) right after init and right after the fetch cannot make an unmerged commit pass", async () => {
    const w = world();
    const agent = join(w.dir, "agent.git");
    g(w.dir, "init", "--bare", "-b", "main", agent);
    g(w.work, "push", "-q", pathToFileURL(agent).href, `${w.C}:refs/heads/main`);
    const plantAll = (repo: string) => {
      const objs = join(w.work, ".git", "objects").replace(/\\/g, "/");
      mkdirSync(join(repo, "objects", "info"), { recursive: true });
      mkdirSync(join(repo, "info"), { recursive: true });
      writeFileSync(join(repo, "objects", "info", "alternates"), `${objs}
`); // the agent's objects (C and its tree) become readable
      writeFileSync(join(repo, "info", "grafts"), `${w.B} ${w.M} ${w.C}
`); // B now "has" C as a parent
      writeFileSync(join(repo, "config"), readFileSync(join(repo, "config"), "utf8") + `[url "${pathToFileURL(agent).href}"]
	insteadOf = ${w.upUrl}
`);
    };
    for (const when of ["afterInit", "afterFetch"] as const) {
      const r = await real(w, w.C, held(w, [ANCHOR]), { testHooks: { [when]: plantAll } });
      expect(r.ancestry.ok, when).toBe(false);
      expect(r.content, when).toBeNull();
    }
  }, T);

  it("N1b: forged git output cannot pass: an object whose SHA-1 does not match is dropped, so a made-up history is a refusal", async () => {
    const pin = "a".repeat(40);
    const tipSha = "b".repeat(40);
    // a made-up tip commit that claims the pin as its parent, and a made-up pin commit: both well-formed, neither hashes to the id it is served under
    const forgedTip = ["tree " + "c".repeat(40), "parent " + pin, "author x", "", "forged", ""].join("\n");
    const forgedPin = ["tree " + "d".repeat(40), "author y", "", "root", ""].join("\n");
    const exec = async (_c: string, args: string[]) => {
      if (args.includes("rev-list")) return { code: 0, stdout: [tipSha, pin, ""].join("\n"), stderr: "" };
      if (args.includes("cat-file")) return { code: 0, stdout: [tipSha + " commit " + forgedTip.length, forgedTip, pin + " commit " + forgedPin.length, forgedPin, ""].join("\n"), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await mainVerification({ repoDir: ".", commitSha: pin, env: {}, exec, lookupTip: async () => ({ ok: true, sha: tipSha }) });
    expect(r.ancestry.ok).toBe(false);
    expect(r.ancestry.detail).toMatch(/could not be verified/);
  });

  it("F8: failure to talk to the pinned remote at all is a refusal, not a pass", async () => {
    const w = world();
    const r = await mainVerification({ repoDir: w.work, commitSha: w.B, env: BASE_ENV, exec: realExec, gitBin: gitBin as string, remoteUrl: pathToFileURL(join(w.dir, "does-not-exist.git")).href, lookupTip: async () => ({ ok: true, sha: w.B }) });
    expect(r.ancestry.ok).toBe(false);
    expect(r.content).toBeNull();
  }, T);
});

/** Hand-edits the commit-graph: commit `child` gets `newParent` as its first parent and a generation above it, then the trailer hash is recomputed. */
function forgeParent(repo: string, child: string, newParent: string): void {
  const p = join(repo, ".git", "objects", "info", "commit-graph");
  const b = readFileSync(p);
  const chunks: Record<string, number> = {};
  for (let i = 0; i < b[6]; i++) {
    const o = 8 + i * 12;
    chunks[b.toString("latin1", o, o + 4)] = Number(b.readBigUInt64BE(o + 4));
  }
  const count = b.readUInt32BE(chunks.OIDF + 255 * 4);
  const idx = (oid: string) => {
    for (let i = 0; i < count; i++) if (b.toString("hex", chunks.OIDL + i * 20, chunks.OIDL + i * 20 + 20) === oid) return i;
    throw new Error(`${oid} not in the commit-graph`);
  };
  const cdat = chunks.CDAT + idx(child) * 36;
  b.writeUInt32BE(idx(newParent), cdat + 20);
  const word = b.readUInt32BE(cdat + 28);
  b.writeUInt32BE(((5 << 2) | (word & 3)) >>> 0, cdat + 28);
  const body = b.subarray(0, b.length - 20);
  createHash("sha1").update(body).digest().copy(b, b.length - 20);
  chmodSync(p, 0o644);
  writeFileSync(p, b);
}

// Pins the runner's own code. The hash covers every file of this folder except __tests__ (tests do not enforce anything), with CRLF normalised,
// using the same algorithm as the proof's manifest. The envelope carries it, so an edited enforcement module cannot run under an approved envelope.

import { createHash } from "node:crypto";
import { manifest } from "../d24-m3d-proof/manifest";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

function walk(dir: string, root: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      walk(p, root, out);
    } else out.push(relative(root, p).split(sep).join("/"));
  }
  return out;
}

export function runnerManifest(dir: string): { files: Array<{ path: string; sha256: string }>; sha256: string } {
  const files = walk(dir, dir).sort().map((rel) => ({ path: rel, sha256: createHash("sha256").update(readFileSync(join(dir, rel), "utf8").replace(/\r\n/g, "\n")).digest("hex") }));
  const roll = createHash("sha256");
  for (const f of files) roll.update(`${f.path}\0${f.sha256}\n`);
  return { files, sha256: roll.digest("hex") };
}

/** The runner must live inside the verified clean clone, at the fixed relative location, so `HEAD == pin` and a clean tree cover its files. */
export function runnerInsideClone(runnerDir: string, repoDir: string): { ok: boolean; detail: string } {
  if (!existsSync(runnerDir) || !existsSync(repoDir)) return { ok: false, detail: "runner or repo directory missing" };
  const norm = (p: string) => realpathSync(resolve(p)).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const expectedRepo = norm(resolve(runnerDir, "..", "..", ".."));
  const r = norm(runnerDir);
  const repo = norm(repoDir);
  const ok = repo === expectedRepo && r.startsWith(`${repo}/`) && r.endsWith("/scripts/qa/d24-test-runner");
  return { ok, detail: ok ? "the runner folder is scripts/qa/d24-test-runner of the verified clean clone" : "the runner is not part of the repository checkout being verified (--repo must be the clone this runner lives in)" };
}

/** Re-hashes both folders from disk (no stat cache, no git) and compares with the values held since the start of the run. */
export function heldUnchanged(dirs: { proofDir: string; runnerDir: string }, held: { proofSha: string; runnerSha: string }): boolean {
  try {
    return manifest(dirs.proofDir).sha256 === held.proofSha && runnerManifest(dirs.runnerDir).sha256 === held.runnerSha;
  } catch {
    return false;
  }
}

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { E2ESafetyError } from "./guards";

function canonical(p: string): string {
  const resolved = path.resolve(p);
  // Follow links when the path exists, so a junction / symlink that points into the repository is caught too.
  try {
    return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
  } catch {
    return resolved;
  }
}

/**
 * E2E artifacts (traces, screenshots, HTML reports, results.json) carry local paths, session tokens in URLs and page content. They must never be
 * written inside the repository, where a stray `git add` would commit them. Throws unless `runDir` is outside `repoRoot` (the root itself and any
 * directory below it, through links, are refused). Returns the canonical run directory.
 */
export function assertRunDirOutsideRepo(runDir: string | undefined, repoRoot: string): string {
  if (!runDir) throw new E2ESafetyError("E2E_RUN_DIR is required: an artifact directory outside the repository.");
  const run = canonical(runDir);
  const root = canonical(repoRoot);
  const rel = path.relative(root, run);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (inside) throw new E2ESafetyError("E2E_RUN_DIR must be outside the repository root (artifacts carry local paths and page content).");
  return run;
}

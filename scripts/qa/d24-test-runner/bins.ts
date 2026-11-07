// Absolute paths for system binaries. libuv searches the current directory first on Windows, so a bare "powershell.exe"/"icacls.exe"/"git" can be
// planted. System tools come from the FIXED Windows directory (never from an environment variable: no SystemRoot/drive-letter trust); git is
// resolved from absolute PATH entries only (never cwd or a relative entry).

import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const WINDOWS_DIR = String.raw`C:\Windows`;
const GIT_FALLBACK = String.raw`C:\Program Files\Git\cmd\git.exe`;

/** The fixed Windows directory. The argument is accepted (and ignored) so callers/tests can show that the environment has no influence. */
export function systemRoot(env?: Record<string, string | undefined>): string {
  void env;
  return WINDOWS_DIR;
}
/** On Windows, verifies the fixed directory really holds System32 (a machine with Windows elsewhere is refused rather than guessed). */
export function system32(_env?: Record<string, string | undefined>, exists: (p: string) => boolean = existsSync): string {
  const p = join(WINDOWS_DIR, "System32");
  if (process.platform === "win32" && !exists(p)) throw new Error(`${p} not found: refusing to guess another Windows directory from the environment`);
  return p;
}
export const powershellExe = (env?: Record<string, string | undefined>) => join(system32(env), "WindowsPowerShell", "v1.0", "powershell.exe");
export const icaclsExe = (env?: Record<string, string | undefined>) => join(system32(env), "icacls.exe");
export const taskkillExe = (env?: Record<string, string | undefined>) => join(system32(env), "taskkill.exe");

/** First absolute-PATH hit for git; null when not found. Relative PATH entries (which include cwd) are ignored. */
export function resolveGit(pathVar: string | undefined, exists: (p: string) => boolean = existsSync): string | null {
  const names = process.platform === "win32" ? ["git.exe"] : ["git"];
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const n of names) if (exists(join(dir, n))) return join(dir, n);
  }
  return process.platform === "win32" && exists(GIT_FALLBACK) ? GIT_FALLBACK : null;
}
export const GIT_FALLBACK_PATH = GIT_FALLBACK;

// Absolute paths for system binaries. libuv searches the current directory first on Windows, so a bare "powershell.exe"/"icacls.exe"/"git" can be
// planted. System tools come from %SystemRoot%\System32; git is resolved from absolute PATH entries only (never cwd or a relative entry).

import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export function systemRoot(env: Record<string, string | undefined> = process.env): string {
  const r = env.SystemRoot ?? env.SYSTEMROOT;
  return r && /^[A-Za-z]:\\windows$/i.test(r) ? r : "C:\\Windows";
}
export const system32 = (env?: Record<string, string | undefined>) => join(systemRoot(env), "System32");
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
  const fallback = process.platform === "win32" ? "C:\Program Files\Git\cmd\git.exe" : null;
  return fallback && exists(fallback) ? fallback : null;
}

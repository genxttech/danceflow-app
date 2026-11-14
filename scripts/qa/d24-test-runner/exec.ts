// Process execution seam. Everything the runner launches goes through an Exec so tests (and --dry) can substitute a fake and never start a real process.

import { spawn, spawnSync } from "node:child_process";
import { taskkillExe, system32 } from "./bins";

export type ExecOpts = { cwd: string; env: Record<string, string>; input?: string; timeoutMs?: number; /** "latin1" returns stdout byte-exact (one char per byte), for binary git object streams */ encoding?: "latin1" };
export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut?: boolean };
export type Exec = (cmd: string, args: string[], opts: ExecOpts) => Promise<ExecResult>;

const MAX_OUT = 4 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

/** Kills the child AND its descendants. A tsx launcher spawns the real node worker; killing only the launcher would leave the worker running. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync(taskkillExe(), ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore", cwd: system32(), timeout: 15_000 });
  } else {
    try {
      process.kill(-pid, "SIGKILL"); // negative pid = the whole process group (the child is spawned detached)
    } catch {
      /* already gone */
    }
  }
}

/** shell:false always. The caller supplies the COMPLETE environment (nothing is inherited), so the child sees exactly what the runner decided. */
export const realExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env as unknown as NodeJS.ProcessEnv, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (t) clearTimeout(t);
      resolve({ code, stdout, stderr, timedOut });
    };
    const t = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid) killTree(child.pid);
          setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(null);
          }, KILL_GRACE_MS).unref();
        }, opts.timeoutMs)
      : null;
    if (opts.encoding) child.stdout?.setEncoding(opts.encoding);
    child.stdout?.on("data", (d) => { if (stdout.length < MAX_OUT) stdout += d; });
    child.stderr?.on("data", (d) => { if (stderr.length < MAX_OUT) stderr += d; });
    child.on("error", (e) => { if (t) clearTimeout(t); if (!done) { done = true; reject(e); } });
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });

// Process execution seam. Everything the runner launches goes through an Exec so tests (and --dry) can substitute a fake and never start a real process.

import { spawn } from "node:child_process";

export type ExecOpts = { cwd: string; env: Record<string, string>; input?: string; timeoutMs?: number };
export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut?: boolean };
export type Exec = (cmd: string, args: string[], opts: ExecOpts) => Promise<ExecResult>;

const MAX_OUT = 4 * 1024 * 1024;

/** shell:false always. The caller supplies the COMPLETE environment (nothing is inherited), so the child sees exactly what the runner decided. */
export const realExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const t = opts.timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs) : null;
    child.stdout.on("data", (d) => { if (stdout.length < MAX_OUT) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < MAX_OUT) stderr += d; });
    child.on("error", (e) => { if (t) clearTimeout(t); reject(e); });
    child.on("close", (code) => { if (t) clearTimeout(t); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.end(opts.input ?? "");
  });

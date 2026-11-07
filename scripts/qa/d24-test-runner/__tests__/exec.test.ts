import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GIT_FALLBACK_PATH, icaclsExe, powershellExe, resolveGit, system32, systemRoot, taskkillExe } from "../bins";
import { realExec } from "../exec";
import { tmp } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("timeout kills the WHOLE process tree (P2-4)", () => {
  it("a grandchild that keeps working after the launcher is killed is killed too", async () => {
    const dir = tmp("d24-exec-");
    const beat = join(dir, "beat.txt");
    const grand = join(dir, "grandchild.js");
    const parent = join(dir, "parent.js");
    // grandchild: appends a byte every 50 ms forever. parent (the "tsx launcher"): spawns it, then idles.
    writeFileSync(grand, `const fs=require("fs");setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},"x"),50);`);
    writeFileSync(parent, `const {spawn}=require("child_process");spawn(process.execPath,[${JSON.stringify(grand)}],{stdio:"inherit"});setInterval(()=>{},1000);`);
    const started = Date.now();
    const r = await realExec(process.execPath, [parent], { cwd: dir, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" }, timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(existsSync(beat)).toBe(true); // the grandchild really ran
    await sleep(400);
    const size1 = statSync(beat).size;
    await sleep(900);
    const size2 = statSync(beat).size;
    expect(size2, "grandchild must have stopped writing").toBe(size1);
    expect(readFileSync(beat, "utf8").length).toBeGreaterThan(0);
  }, 30_000);

  it("a normal child is not flagged as timed out", async () => {
    const r = await realExec(process.execPath, ["-e", "console.log('hi')"], { cwd: tmp(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain("hi");
  });
});

describe("absolute system binaries, neutral resolution (P3-1, N-5)", () => {
  const WIN = String.raw`C:\Windows`;
  it("System32 paths are absolute and rooted at the fixed Windows dir, whatever PATH, cwd or SystemRoot says", () => {
    const env = { SystemRoot: String.raw`D:\Windows`, PATH: String.raw`.;C:\evil` };
    expect(powershellExe(env).toLowerCase()).toBe(String.raw`c:\windows\system32\windowspowershell\v1.0\powershell.exe`);
    expect(icaclsExe(env).toLowerCase()).toBe(String.raw`c:\windows\system32\icacls.exe`);
    expect(taskkillExe(env).toLowerCase()).toBe(String.raw`c:\windows\system32\taskkill.exe`);
  });
  it("SystemRoot / drive letters from the environment are never trusted", () => {
    for (const v of [String.raw`C:\evil\dir`, String.raw`..\..\x`, String.raw`D:\Windows`, String.raw`E:\windows`]) expect(systemRoot({ SystemRoot: v })).toBe(WIN);
  });
  it("the git fallback is a real absolute path with its backslashes (not a drive-relative string)", () => {
    expect(GIT_FALLBACK_PATH).toBe(String.raw`C:\Program Files\Git\cmd\git.exe`);
    expect(GIT_FALLBACK_PATH).toMatch(/^[A-Za-z]:\\/);
    if (process.platform === "win32") expect(resolveGit("", (p) => p === GIT_FALLBACK_PATH)).toBe(GIT_FALLBACK_PATH);
  });
  it("refuses (does not guess another drive) when the fixed Windows dir has no System32", () => {
    if (process.platform === "win32") expect(() => system32(undefined, () => false)).toThrow(/refusing to guess/);
  });
  it("git is resolved from ABSOLUTE PATH entries only (never cwd or relative entries)", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    const abs = process.platform === "win32" ? String.raw`C:\tools\git` : "/opt/git";
    const name = process.platform === "win32" ? "git.exe" : "git";
    const seen: string[] = [];
    const found = resolveGit(`.${sep}relative${sep}${abs}`, (p) => (seen.push(p), p.endsWith(name) && p.startsWith(abs)));
    expect(found?.startsWith(abs)).toBe(true);
    expect(seen.some((p) => p.startsWith("relative") || p.startsWith("."))).toBe(false);
    expect(resolveGit(`.${sep}relative`, () => false)).toBeNull();
  });
});

describe("no bare system binary names in spawn calls (static)", () => {
  it("credstore and exec launch powershell/icacls/taskkill only via bins.ts absolute paths", () => {
    for (const f of ["credstore.ts", "exec.ts", "gitverify.ts"]) {
      const src = readFileSync(join(__dirname, "..", f), "utf8");
      expect(src, f).not.toMatch(/spawn(Sync)?\(\s*"(powershell|icacls|taskkill)(\.exe)?"/);
      expect(src, f).not.toMatch(/process\.env\.SystemRoot/);
    }
  });
});

// Protected credential storage for the restricted TEST key. Two Windows back ends driven through Windows PowerShell 5.1 (no native module, no npm dependency):
//   1. Windows Credential Manager (advapi32 CredReadW/CredWriteW via P/Invoke), persistence LOCAL_MACHINE.
//   2. A DPAPI (CurrentUser scope) encrypted file with a user-only ACL.
// The secret travels ONLY over the helper's stdin (write) and stdout (read). It is never in argv, a file in clear, a log or an env var of this process.
// Threat model: both back ends are bound to the Windows user. ANY process running as the same user can read the secret (Credential Manager has no
// per-application ACL; DPAPI CurrentUser decrypts for any process of that user). They protect against disk theft, other users, backups and repo/commit leaks,
// NOT against malware or another agent running as the same user. If PowerShell module/script-block/transcription logging is enabled by policy,
// the read helper's output (SECRET:<value>) can be written to that log: the value is never in argv or the script text, but it IS in stdout. Check the
// machine's PowerShell logging policy before provisioning; if transcription is on, use a machine without it. System binaries are invoked by absolute path. Mitigations are the key's own restrictions (rk_test_, 3 permissions, a TEST sandbox) and its expiry.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { icaclsExe, powershellExe, system32 } from "./bins";
import { LABEL_RE } from "./envelope";

export interface CredentialStore {
  readonly kind: string;
  read(label: string): Promise<string | null>;
  write(label: string, secret: string): Promise<void>;
  remove(label: string): Promise<void>;
}

/** Runs a PowerShell script (passed as -EncodedCommand, so no secret and no quoting in argv). `stdin` is the only channel for a secret. */
export type PsRunner = (script: string, stdin?: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const defaultPsRunner: PsRunner = (script, stdin) =>
  new Promise((resolve, reject) => {
    const enc = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(powershellExe(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], { windowsHide: true, cwd: process.platform === "win32" ? system32() : undefined, stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: process.env.PATH ?? "" } as unknown as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });

const checkLabel = (label: string) => {
  if (!LABEL_RE.test(label)) throw new Error("credential label must match [A-Za-z0-9._-]{3,64}");
};
const targetName = (label: string) => `DanceFlow/D24-TEST/${label}`;

const CRED_CS = `
using System; using System.Runtime.InteropServices;
public static class D24Cred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CredReadW(string t, UInt32 type, UInt32 flags, out IntPtr p);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CredWriteW(ref CREDENTIAL c, UInt32 flags);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CredDeleteW(string t, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static string Read(string t) {
    IntPtr p; if (!CredReadW(t, 1, 0, out p)) { int e = Marshal.GetLastWin32Error(); if (e == 1168) return null; throw new Exception("CredRead failed " + e); }
    try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); return Marshal.PtrToStringUni(c.CredentialBlob, (int)c.CredentialBlobSize / 2); } finally { CredFree(p); }
  }
  public static void Write(string t, string secret) {
    CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = t; c.UserName = "d24-test-runner"; c.Persist = 2;
    c.CredentialBlobSize = (UInt32)(secret.Length * 2); c.CredentialBlob = Marshal.StringToCoTaskMemUni(secret);
    try { if (!CredWriteW(ref c, 0)) throw new Exception("CredWrite failed " + Marshal.GetLastWin32Error()); } finally { Marshal.ZeroFreeCoTaskMemUnicode(c.CredentialBlob); }
  }
  public static void Delete(string t) { if (!CredDeleteW(t, 1, 0)) { int e = Marshal.GetLastWin32Error(); if (e != 1168) throw new Exception("CredDelete failed " + e); } }
}`;

const psHeader = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'${CRED_CS}\n'@; `;

/** Parses the helper protocol: one line `SECRET:<value>`, `MISSING` or `OK`. Never throws a message that contains stdout. */
function parse(out: { code: number | null; stdout: string; stderr: string }, what: string): string | null {
  if (out.code !== 0) throw new Error(`credential helper failed during ${what} (exit ${out.code})`);
  const line = out.stdout.split(/\r?\n/).find((l) => l.length > 0) ?? "";
  if (line === "MISSING") return null;
  if (line === "OK") return "";
  if (line.startsWith("SECRET:")) return line.slice(7);
  throw new Error(`credential helper returned an unexpected answer during ${what}`);
}

export class WindowsCredentialManagerStore implements CredentialStore {
  readonly kind = "windows-credential-manager";
  constructor(private readonly ps: PsRunner = defaultPsRunner) {}
  async read(label: string): Promise<string | null> {
    checkLabel(label);
    return parse(await this.ps(`${psHeader}$s=[D24Cred]::Read('${targetName(label)}'); if ($s -eq $null) { 'MISSING' } else { 'SECRET:' + $s }`), "read");
  }
  async write(label: string, secret: string): Promise<void> {
    checkLabel(label);
    if (secret.length === 0 || /[\r\n]/.test(secret) || secret.length > 1000) throw new Error("refusing to store an empty, multi-line or oversized secret");
    parse(await this.ps(`${psHeader}$s=[Console]::In.ReadToEnd().TrimEnd("\`r","\`n"); [D24Cred]::Write('${targetName(label)}', $s); 'OK'`, secret), "write");
  }
  async remove(label: string): Promise<void> {
    checkLabel(label);
    parse(await this.ps(`${psHeader}[D24Cred]::Delete('${targetName(label)}'); 'OK'`), "remove");
  }
}

/** DPAPI CurrentUser-encrypted file (base64 of ProtectedData.Protect with the label as entropy). The ACL is reduced to the current user. */
export class DpapiFileStore implements CredentialStore {
  readonly kind = "dpapi-file";
  constructor(private readonly dir: string, private readonly ps: PsRunner = defaultPsRunner, private readonly lockdown: (file: string) => Promise<void> = icaclsUserOnly) {}
  private file(label: string) {
    checkLabel(label);
    return join(this.dir, `cred-${label}.dpapi`);
  }
  async read(label: string): Promise<string | null> {
    const f = this.file(label);
    if (!existsSync(f)) return null;
    const blob = readFileSync(f, "utf8").trim();
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $e=[Text.Encoding]::UTF8.GetBytes('${label}'); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser'); 'SECRET:' + [Text.Encoding]::UTF8.GetString($p)`;
    return parse(await this.ps(script, blob), "dpapi read");
  }
  async write(label: string, secret: string): Promise<void> {
    const f = this.file(label);
    if (secret.length === 0 || /[\r\n]/.test(secret) || secret.length > 1000) throw new Error("refusing to store an empty, multi-line or oversized secret");
    mkdirSync(this.dir, { recursive: true });
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().TrimEnd("\`r","\`n"); $e=[Text.Encoding]::UTF8.GetBytes('${label}'); $c=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$e,'CurrentUser'); 'SECRET:' + [Convert]::ToBase64String($c)`;
    const blob = parse(await this.ps(script, secret), "dpapi write");
    if (!blob) throw new Error("dpapi helper produced no data");
    writeFileSync(f, blob, { mode: 0o600 });
    await this.lockdown(f);
  }
  async remove(label: string): Promise<void> {
    const f = this.file(label);
    if (existsSync(f)) unlinkSync(f);
  }
}

async function icaclsUserOnly(file: string): Promise<void> {
  const user = process.env.USERNAME;
  if (!user) throw new Error("cannot determine the current user for the ACL");
  await new Promise<void>((resolve, reject) => {
    const c = spawn(icaclsExe(), [file, "/inheritance:r", "/grant:r", `${user}:(F)`], { windowsHide: true, cwd: system32(), stdio: "ignore" });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`icacls failed (exit ${code})`))));
  });
}

/** In-memory store for tests and --dry. Holds only a clearly fake value. */
export class MemoryStore implements CredentialStore {
  readonly kind = "memory";
  readonly map = new Map<string, string>();
  async read(label: string) {
    return this.map.get(label) ?? null;
  }
  async write(label: string, secret: string) {
    this.map.set(label, secret);
  }
  async remove(label: string) {
    this.map.delete(label);
  }
}

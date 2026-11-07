// Environment sanitisation. The child gets an ALLOW-LISTED environment (nothing inherited by default), never a filtered copy of ours. The result is
// then validated with the proof's own checkEnvironment so the two can never drift apart.

import { AUTHORIZATION_PHRASE, checkEnvironment, ENV } from "../d24-m3d-proof/identity";
import { looksLikeLiveSecret } from "../d24-m3d-proof/redact";
import type { Envelope } from "./envelope";

/** Names (case-insensitive) copied from the parent: the minimum node + git + npm need on Windows. No proxies, CA, NODE_*, DB or key variables. */
const BASE_ALLOW = ["PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "PROGRAMFILES", "PROGRAMDATA", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "LANG", "LC_ALL"];

export type ChildEnv = { env: Record<string, string>; droppedNames: string[] };

/** Base environment with no D24 variables (for git, npm, --print-hash, --allow-list, --dry-run). */
export function baseEnv(parent: Record<string, string | undefined>): ChildEnv {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (BASE_ALLOW.includes(k.toUpperCase()) && !looksLikeLiveSecret(v)) env[k] = v;
    else dropped.push(k);
  }
  return { env, droppedNames: dropped.sort() };
}

export type LiveVars = { key: string; evidenceDir: string; envelope: Envelope };

/** Environment for --preflight / --live: base + the proof's owner values. The key appears here and nowhere else in the runner. */
export function proofEnv(parent: Record<string, string | undefined>, v: LiveVars): ChildEnv {
  const b = baseEnv(parent);
  const env = {
    ...b.env,
    [ENV.key]: v.key,
    [ENV.platform]: v.envelope.accounts.platformAcct,
    [ENV.connected]: v.envelope.accounts.connectedAcct,
    [ENV.pinnedSha]: v.envelope.proof.manifestSha256,
    // the proof's own owner sentence: taken from the owner-approved envelope text, which validateEnvelope proved contains it verbatim
    [ENV.phrase]: AUTHORIZATION_PHRASE,
    D24_PROOF_EVIDENCE_DIR: v.evidenceDir,
  };
  const problems = checkEnvironment(env);
  if (problems.length > 0) throw new Error(`sanitised environment still fails the proof's environment check: ${problems.join(" | ")}`);
  return { env, droppedNames: b.droppedNames };
}

// OWNER-USER side of an installed run. It lists the inbox, shows the owner the fingerprint and terms of the ONE pending envelope, requires the
// first fingerprint group to be typed, and only then asks the authenticator for an assertion over the envelope hash, which it writes beside the
// envelope. It has no authority: the verifier in execinbox.ts re-checks everything from the install root. The authenticator call itself is injected
// (the real WebAuthn ceremony is the owner-enrollment work in OWNER-AUTH section 7 and cannot be exercised offline).

import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "./envelope";
import { confirmFirstGroup, fingerprintOfFile, firstGroup, termsLines } from "./fingerprint";
import { readFileNoFollow } from "./safefs";
import type { HardwareApprovalDoc } from "./webauthn";

export const ENVELOPE_FILE = "envelope.json";
export const ASSERTION_FILE = "assertion.hw.json";
export const RUN_ID_RE = /^[A-Za-z0-9-]{6,64}$/;
export const MAX_INBOX_FILE_BYTES = 200_000;

export type LauncherDeps = {
  inbox: string;
  /** the anchor fingerprint the install pins; an envelope written for another anchor is refused before any tap */
  expectedAnchorFingerprint: string;
  confirm(question: string): Promise<string>;
  /** raises the authenticator prompt; the challenge is the envelope hash. Called ONLY after the typed confirmation. */
  tap(envelopeSha256: string, envelope: Envelope): Promise<HardwareApprovalDoc>;
  out(line: string): void;
};
export type LaunchResult = { ok: boolean; runId?: string; fingerprint?: string; why?: string };

/** A regular, non-link, size-capped file read from the opened handle; null otherwise. */
export function readInboxFile(file: string): string | null {
  const b = readFileNoFollow(file, MAX_INBOX_FILE_BYTES);
  return b === null ? null : b.toString("utf8");
}

/** Run directories that have an envelope and no assertion yet. */
export function pendingRuns(inbox: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(inbox).sort()) {
    if (!RUN_ID_RE.test(name)) continue;
    const dir = join(inbox, name);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(dir, ENVELOPE_FILE)) && !existsSync(join(dir, ASSERTION_FILE))) out.push(name);
  }
  return out;
}

export async function launch(d: LauncherDeps): Promise<LaunchResult> {
  const refuse = (why: string): LaunchResult => (d.out(`REFUSED: ${why}`), { ok: false, why });
  const pending = pendingRuns(d.inbox);
  if (pending.length === 0) return refuse("nothing is pending in the inbox");
  if (pending.length > 1) return refuse(`${pending.length} envelopes are pending (${pending.join(", ")}): the launcher approves exactly one at a time; remove the extra ones`);
  const runId = pending[0];
  const text = readInboxFile(join(d.inbox, runId, ENVELOPE_FILE));
  if (text === null) return refuse("the envelope file is not a regular, small file");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("the envelope file is not valid JSON");
  }
  const f = fingerprintOfFile(raw);
  if (!f.ok) return refuse(`envelope invalid: ${f.why}`);
  if (f.envelope.hardwareAnchorFingerprintSha256 !== d.expectedAnchorFingerprint) return refuse("the envelope was written for a different hardware anchor than the installed one");
  for (const line of termsLines(f.envelope)) d.out(line);
  const typed = await d.confirm(`Compare the fingerprint above with the one in the chat proposal. Type its FIRST group (${firstGroup(f.fingerprint)}) to raise the tap: `);
  if (!confirmFirstGroup(typed, f.fingerprint)) return refuse("the typed group does not match: no tap was requested");
  let doc: HardwareApprovalDoc;
  try {
    doc = await d.tap(f.envelope.envelopeSha256, f.envelope);
  } catch {
    return refuse("the authenticator did not produce an assertion");
  }
  if (doc.envelopeSha256 !== f.envelope.envelopeSha256) return refuse("the assertion document names a different envelope hash");
  mkdirSync(join(d.inbox, runId), { recursive: true });
  writeFileSync(join(d.inbox, runId, ASSERTION_FILE), JSON.stringify(doc), { flag: "wx" });
  d.out(`assertion written for ${runId} (fingerprint ${f.fingerprint}). Start the scheduled task for run id ${runId}.`);
  return { ok: true, runId, fingerprint: f.fingerprint };
}

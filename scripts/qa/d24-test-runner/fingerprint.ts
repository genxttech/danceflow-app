// The value a human compares: the first 12 hex of the envelope's canonical sha256, uppercase, in three groups ("7F3A-91C2-0B5D"). The launcher
// computes it from the envelope it is about to have approved (never from a field the file merely claims), the chat proposal quotes the same string,
// and the owner must type the FIRST group before the tap is raised.

import { envelopeHash, validateEnvelope, type Envelope } from "./envelope";

export function envelopeFingerprint(envelopeSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(envelopeSha256)) throw new Error("envelope hash must be 64 lowercase hex");
  const h = envelopeSha256.slice(0, 12).toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}
export const firstGroup = (fp: string) => fp.split("-")[0];
/** Typed confirmation: exactly the first group, case-insensitive, nothing else. */
export const confirmFirstGroup = (typed: string, fp: string) => typed.trim().toUpperCase() === firstGroup(fp);

/** Recomputes the hash from the envelope content (the hash field in the file is checked, not trusted). */
export function fingerprintOfFile(raw: unknown): { ok: true; envelope: Envelope; fingerprint: string } | { ok: false; why: string } {
  const v = validateEnvelope(raw);
  if (!v.ok) return { ok: false, why: v.issues.map((i) => `${i.code}: ${i.detail}`).join(" | ") };
  const h = envelopeHash(v.envelope);
  if (h !== v.envelope.envelopeSha256) return { ok: false, why: "the envelope's own hash field does not match its content" };
  return { ok: true, envelope: v.envelope, fingerprint: envelopeFingerprint(h) };
}

/** The terms the owner reads next to the fingerprint (the chat proposal repeats them). */
export function termsLines(e: Envelope): string[] {
  return [
    `fingerprint        ${envelopeFingerprint(e.envelopeSha256)}`,
    `mode               ${e.mode}   key kind ${e.credential.keyKind}   key fp ${e.credential.keyFingerprintSha256Prefix}`,
    `accounts           platform ${e.accounts.platformAcct}   connected ${e.accounts.connectedAcct}`,
    `call ceiling       ${e.apiCallCeiling}   max runs ${e.maxRuns}   expires ${e.expiresUtc}`,
    `rules              ${e.permittedRuleIds.length} (${e.permittedRuleIds.join(", ")})`,
    `runner tree        ${e.runner.manifestSha256.slice(0, 12)} (${e.runner.fileCount} files)   proof ${e.proof.manifestSha256.slice(0, 12)}`,
    `code commit        ${e.code.commitSha.slice(0, 12)}   anchor ${e.hardwareAnchorFingerprintSha256.slice(0, 16)}`,
  ];
}

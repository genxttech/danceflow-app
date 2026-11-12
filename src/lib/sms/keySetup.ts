/**
 * Helpers for the one-time hardware-key setup page (owner bootstrap of the price authorization). Pure and client-safe: no server-only import, no secrets.
 * The page only DISPLAYS the public values of a key (credential id, P-256 public key x and y) and the flags that decide whether the database will accept it;
 * the owner-level bootstrap itself is run by engineering with those public values. A private key never leaves the authenticator.
 */

export type AuthFlags = { userPresent: boolean; userVerified: boolean; backupEligible: boolean; backedUp: boolean; attestedCredentialData: boolean };

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** authenticatorData: 32 bytes rpIdHash, then the flags byte (UP 0x01, UV 0x04, BE 0x08, BS 0x10, AT 0x40). */
export function parseAuthDataFlags(authData: Uint8Array): AuthFlags {
  if (authData.length < 37) throw new Error("authenticator data too short");
  const f = authData[32];
  return { userPresent: (f & 0x01) !== 0, userVerified: (f & 0x04) !== 0, backupEligible: (f & 0x08) !== 0, backedUp: (f & 0x10) !== 0, attestedCredentialData: (f & 0x40) !== 0 };
}

/** authenticatorData signCount: 4 bytes big endian after the flags byte. Many platform authenticators (including some Windows Hello builds) always report 0. */
export function parseSignCount(authData: Uint8Array): number {
  if (authData.length < 37) throw new Error("authenticator data too short");
  return authData[33] * 16777216 + authData[34] * 65536 + authData[35] * 256 + authData[36];
}

/** Plain-language meaning of a counter value for the owner (the database accepts a counter that stays 0 forever, but refuses any regression once it has moved). */
export function counterNote(count: number): string {
  return count === 0
    ? "Counter 0: this authenticator does not count signatures, so cloning cannot be detected by the counter. The key is not reported as synced, which is why this is accepted; it is a recorded, accepted limitation (see the runbook)."
    : "Counter " + count + ": the database will refuse any signature whose counter does not increase (clone detection stays on for this key).";
}

/**
 * What the database requires of a hardware credential (user presence and verification, NOT backup eligible and NOT backed up: a synced passkey is refused).
 * Returns null when acceptable, otherwise the reason in plain language.
 */
export function keyRefusal(flags: AuthFlags): string | null {
  if (!flags.userPresent) return "The key did not report user presence.";
  if (!flags.userVerified) return "The key did not verify you (a PIN or fingerprint is required). Set a PIN on the key and try again.";
  if (flags.backupEligible || flags.backedUp) return "This looks like a synced passkey (backup eligible). The database refuses synced passkeys. Use a hardware security key.";
  return null;
}

/** The uncompressed P-256 point 0x04 || x || y is the last 65 bytes of the SubjectPublicKeyInfo. */
export function spkiToXY(spki: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  if (spki.length < 65) throw new Error("public key too short");
  const raw = spki.slice(spki.length - 65);
  if (raw[0] !== 0x04) throw new Error("not an uncompressed P-256 point");
  return { x: raw.slice(1, 33), y: raw.slice(33, 65) };
}

export type KeyPublic = { label: string; credentialId: Uint8Array; x: Uint8Array; y: Uint8Array };

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const dec = (b: Uint8Array) => `decode('${toHex(b)}', 'hex')`;

/**
 * The owner-level bootstrap statement for engineering to run (a runbook step with no application path). Contains only public values.
 * The primary key and the offline recovery key are installed together so the system never runs with a primary and no recovery key.
 */
export function bootstrapStatement(p: { rpId: string; origin: string; primary: KeyPublic; recovery: KeyPublic }): string {
  return [
    "select public._tw4price_bootstrap_with_recovery(",
    `  ${lit(p.rpId)}, array[${lit(p.origin)}],`,
    `  ${dec(p.primary.credentialId)}, ${dec(p.primary.x)}, ${dec(p.primary.y)}, ${lit(p.primary.label)},`,
    `  ${dec(p.recovery.credentialId)}, ${dec(p.recovery.x)}, ${dec(p.recovery.y)}, ${lit(p.recovery.label)}`,
    ");",
  ].join("\n");
}

/**
 * The challenge-signing tool signs ANY pasted challenge, so it is OFF unless engineering deliberately switches it on (server setting TW4_KEY_SETUP_SIGNING=on) for the short window of an
 * enrolment proof (a key installed or replaced). Anything other than the exact string "on" keeps it off. Issue #454.
 */
export function signingToolEnabled(env: Record<string, string | undefined>): boolean {
  return env.TW4_KEY_SETUP_SIGNING === "on";
}

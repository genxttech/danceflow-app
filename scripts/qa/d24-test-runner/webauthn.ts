// Pure WebAuthn assertion verifier for the OWNER hardware-key approval of a D24 TEST envelope. No I/O except the optional sign-counter state helpers at the
// bottom. The rules mirror the repository's TW-4F price-authorization protocol (docs/twilio/TW-4F_Price_Hardware_Authenticator_Protocol.md):
//   ES256 only (COSE -7, P-256 + SHA-256; EdDSA/RS256 are refused exactly as that protocol refuses them), UP and UV set, BE and BS clear (device-bound key),
//   rpIdHash = SHA-256(rpId), one exact origin from the pinned list with crossOrigin false, type "webauthn.get", challenge = base64url(envelope hash bytes),
//   strictly increasing sign counter (0 stays 0 for tokens that do not count), no attestation.
// The challenge is the 32 raw bytes of the envelope's canonical SHA-256 (the same value the Ed25519 kind signs), so a tap approves exactly one envelope.
//
// NOTHING here talks to an authenticator, registers a credential, or opens a browser. Tests use software-generated vectors only.

import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "./canon";

export const HW_KIND = "webauthn-es256" as const;
/** Present in the runner folder => the runner requires the hardware approval kind for every live run (and the folder hash pins the file). */
export const ANCHOR_FILE = "owner-hw-anchor.json";

export type HardwareAnchor = {
  v: 1;
  kind: typeof HW_KIND;
  /** base64url credential id the ceremony must name */
  credentialId: string;
  /** P-256 public key point, 32-byte big-endian coordinates, base64url */
  publicKey: { x: string; y: string };
  rpId: string;
  origins: string[];
  /** true (default): require the UV flag. Setting false is only for documented test use. */
  requireUV: boolean;
  /** repository + branch that must contain the pinned commit before a live run (see runner gate commit-on-main) */
  repoUrl: string;
  branch: string;
  /** sha256 over the canonical JSON of the fields above (excluding this one): the value the owner records out of band */
  fingerprintSha256: string;
};

export type HardwareApprovalDoc = { v: 1; kind: typeof HW_KIND; envelopeSha256: string; credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string };

const B64U = /^[A-Za-z0-9_-]*$/;
const b64u = (buf: Buffer) => buf.toString("base64url");
const fromB64u = (s: string): Buffer | null => (typeof s === "string" && B64U.test(s) ? Buffer.from(s, "base64url") : null);
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const RPID_RE = /^(localhost|([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/;
const ORIGIN_RE = /^(https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|http:\/\/localhost)(:\d{1,5})?$/;

export function anchorFingerprint(a: Omit<HardwareAnchor, "fingerprintSha256">): string {
  const { v, kind, credentialId, publicKey, rpId, origins, requireUV, repoUrl, branch } = a;
  return createHash("sha256").update(canonicalJson({ v, kind, credentialId, publicKey, rpId, origins, requireUV, repoUrl, branch })).digest("hex");
}

/** Validates a pinned anchor. Returns the anchor or a list of problems; never throws. */
export function parseAnchor(raw: unknown): { ok: true; anchor: HardwareAnchor } | { ok: false; problems: string[] } {
  const p: string[] = [];
  const a = raw as Partial<HardwareAnchor> | null;
  if (!a || typeof a !== "object") return { ok: false, problems: ["anchor is not an object"] };
  const allowed = ["v", "kind", "credentialId", "publicKey", "rpId", "origins", "requireUV", "repoUrl", "branch", "fingerprintSha256"];
  for (const k of Object.keys(a)) if (!allowed.includes(k)) p.push(`unknown anchor field ${JSON.stringify(k.slice(0, 30))}`);
  if (a.v !== 1 || a.kind !== HW_KIND) p.push("anchor v/kind must be 1 / webauthn-es256");
  const id = typeof a.credentialId === "string" ? fromB64u(a.credentialId) : null;
  if (!id || id.length < 16 || id.length > 1023) p.push("credentialId must be base64url, 16..1023 bytes");
  const x = a.publicKey && typeof a.publicKey.x === "string" ? fromB64u(a.publicKey.x) : null;
  const y = a.publicKey && typeof a.publicKey.y === "string" ? fromB64u(a.publicKey.y) : null;
  if (!x || x.length !== 32 || !y || y.length !== 32) p.push("publicKey x and y must be 32-byte base64url values");
  else {
    try {
      createPublicKey({ key: { kty: "EC", crv: "P-256", x: a.publicKey!.x, y: a.publicKey!.y }, format: "jwk" });
    } catch {
      p.push("publicKey is not a point on P-256");
    }
  }
  if (typeof a.rpId !== "string" || !RPID_RE.test(a.rpId)) p.push("rpId must be a lowercase hostname (or localhost)");
  if (!Array.isArray(a.origins) || a.origins.length === 0 || a.origins.length > 4 || !a.origins.every((o) => typeof o === "string" && ORIGIN_RE.test(o))) p.push("origins must be 1..4 exact https origins (or http://localhost)");
  else if (typeof a.rpId === "string" && !a.origins.every((o) => { const h = new URL(o).hostname; return h === a.rpId || h.endsWith(`.${a.rpId}`); })) p.push("every origin must be the rpId or a subdomain of it");
  if (typeof a.requireUV !== "boolean") p.push("requireUV must be a boolean");
  if (typeof a.repoUrl !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/.test(a.repoUrl)) p.push("repoUrl must be an https://github.com/<owner>/<repo>.git URL");
  if (typeof a.branch !== "string" || !/^[A-Za-z0-9._/-]{1,60}$/.test(a.branch)) p.push("branch must be a plain branch name");
  if (p.length === 0 && anchorFingerprint(a as HardwareAnchor) !== a.fingerprintSha256) p.push("fingerprintSha256 does not match the anchor content (edited after the owner recorded it)");
  return p.length > 0 ? { ok: false, problems: p } : { ok: true, anchor: a as HardwareAnchor };
}

export function loadAnchor(file: string): { ok: true; anchor: HardwareAnchor } | { ok: false; problems: string[] } | null {
  if (!existsSync(file)) return null;
  try {
    return parseAnchor(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { ok: false, problems: ["anchor file is not valid JSON"] };
  }
}

/** Strict DER ECDSA signature -> true only for SEQUENCE { INTEGER r, INTEGER s } with minimal encodings and no trailing bytes. */
export function strictDerEcdsa(sig: Buffer): boolean {
  if (sig.length < 8 || sig.length > 72 || sig[0] !== 0x30) return false;
  let len = sig[1];
  let off = 2;
  if (len & 0x80) return false; // lengths here fit in one byte; the long form is non-minimal
  if (off + len !== sig.length) return false;
  for (let i = 0; i < 2; i++) {
    if (sig[off] !== 0x02) return false;
    len = sig[off + 1];
    if (len === 0 || len & 0x80 || off + 2 + len > sig.length) return false;
    const int = sig.subarray(off + 2, off + 2 + len);
    if (int[0] & 0x80) return false; // negative
    if (int.length > 1 && int[0] === 0x00 && !(int[1] & 0x80)) return false; // non-minimal leading zero
    if (int.length === 1 && int[0] === 0) return false; // zero
    off += 2 + len;
  }
  return off === sig.length;
}

export type VerifyInput = { envelopeSha256: string; doc: unknown; anchor: HardwareAnchor; storedSignCount: number };
export type VerifyResult = { ok: true; signCount: number; flags: number } | { ok: false; reason: string };

/** Verifies one assertion for one envelope hash. Never throws; the reason never contains attacker-controlled text beyond fixed labels. */
export function verifyAssertion(i: VerifyInput): VerifyResult {
  const no = (reason: string): VerifyResult => ({ ok: false, reason });
  const d = i.doc as Partial<HardwareApprovalDoc> | null;
  if (!d || typeof d !== "object" || d.v !== 1 || d.kind !== HW_KIND) return no("approval document missing or not a webauthn-es256 document");
  if (!/^[0-9a-f]{64}$/.test(i.envelopeSha256)) return no("envelope hash is not 64 hex");
  if (d.envelopeSha256 !== i.envelopeSha256) return no("the approval is for a different envelope hash");
  if (d.credentialId !== i.anchor.credentialId) return no("the assertion names a credential that is not the pinned owner credential");
  const authData = typeof d.authenticatorData === "string" ? fromB64u(d.authenticatorData) : null;
  const cdj = typeof d.clientDataJSON === "string" ? fromB64u(d.clientDataJSON) : null;
  const sig = typeof d.signature === "string" ? fromB64u(d.signature) : null;
  if (!authData || !cdj || !sig) return no("authenticatorData, clientDataJSON and signature must be unpadded base64url");
  if (cdj.length === 0 || cdj.length > 4096 || authData.length > 1024) return no("assertion fields have an implausible size");

  // clientDataJSON: exact fields, no duplicate keys, exact challenge/origin, not cross-origin
  const text = cdj.toString("utf8");
  if (Buffer.from(text, "utf8").compare(cdj) !== 0) return no("clientDataJSON is not valid UTF-8");
  for (const k of ["type", "challenge", "origin", "crossOrigin", "topOrigin"]) if ((text.match(new RegExp(`"${k}"\\s*:`, "g")) ?? []).length > 1) return no("clientDataJSON has a duplicate key");
  let cd: Record<string, unknown>;
  try {
    cd = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return no("clientDataJSON is not valid JSON");
  }
  if (cd === null || typeof cd !== "object" || Array.isArray(cd)) return no("clientDataJSON is not an object");
  if (cd.type !== "webauthn.get") return no("clientData type is not webauthn.get");
  const expectedChallenge = b64u(Buffer.from(i.envelopeSha256, "hex"));
  if (cd.challenge !== expectedChallenge) return no("the challenge is not the base64url of this envelope's canonical hash");
  if (typeof cd.origin !== "string" || !i.anchor.origins.includes(cd.origin)) return no("origin is not one of the pinned origins");
  if (cd.crossOrigin !== undefined && cd.crossOrigin !== false) return no("cross-origin assertions are refused");
  if (cd.topOrigin !== undefined) return no("assertions from an embedded context (topOrigin) are refused");

  // authenticatorData: 32 rpIdHash | 1 flags | 4 counter [| extensions]
  if (authData.length < 37) return no("authenticatorData is shorter than 37 bytes");
  if (!authData.subarray(0, 32).equals(sha256(i.anchor.rpId))) return no("rpIdHash does not match the pinned rpId");
  const flags = authData[32];
  if (!(flags & 0x01)) return no("user presence flag (UP) is not set");
  if (i.anchor.requireUV && !(flags & 0x04)) return no("user verification flag (UV) is not set");
  if (flags & 0x08 || flags & 0x10) return no("backup-eligible / backed-up flags are set: a synced credential is not accepted");
  if (flags & 0x40) return no("attested-credential-data flag is set on an assertion");
  if (flags & 0x20 || (flags & 0x02)) return no("reserved flag bits are set");
  if (!(flags & 0x80) && authData.length !== 37) return no("trailing bytes after authenticatorData without the extension flag");
  const signCount = authData.readUInt32BE(33);
  if (!Number.isInteger(i.storedSignCount) || i.storedSignCount < 0) return no("stored sign counter is invalid");
  if (!(i.storedSignCount === 0 && signCount === 0) && signCount <= i.storedSignCount) return no("sign counter did not increase (replay or cloned authenticator)");

  // signature over authData || sha256(clientDataJSON)
  if (!strictDerEcdsa(sig)) return no("signature is not a strictly encoded DER ECDSA signature");
  try {
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: i.anchor.publicKey.x, y: i.anchor.publicKey.y }, format: "jwk" });
    const ok = verify("sha256", Buffer.concat([authData, sha256(cdj)]), { key, dsaEncoding: "der" }, sig);
    if (!ok) return no("signature does not verify against the pinned credential public key");
  } catch {
    return no("signature does not verify against the pinned credential public key");
  }
  return { ok: true, signCount, flags };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Sign-counter state. One approval document is reused for every run of the SAME envelope (same counter value, accepted again); a NEW envelope needs a
// strictly higher counter than the highest accepted so far. The state file is detection-grade (same-user writable): see the design doc.

export type HwState = { v: 1; last: number; byEnvelope: Record<string, number> };
export const emptyState = (): HwState => ({ v: 1, last: 0, byEnvelope: {} });

export function readState(file: string): HwState {
  if (!existsSync(file)) return emptyState();
  const s = JSON.parse(readFileSync(file, "utf8")) as HwState;
  if (s.v !== 1 || !Number.isInteger(s.last) || s.last < 0 || typeof s.byEnvelope !== "object" || s.byEnvelope === null) throw new Error("hardware approval state file is malformed");
  return s;
}

/** The counter value to compare a NEW assertion against, or the exact value an already accepted envelope must present. */
export function counterFloor(state: HwState, envelopeSha256: string): { storedSignCount: number; sameEnvelope: boolean } {
  return envelopeSha256 in state.byEnvelope ? { storedSignCount: state.byEnvelope[envelopeSha256] - 1, sameEnvelope: true } : { storedSignCount: state.last, sameEnvelope: false };
}

/** Verifies and (on success) records the counter. A repeat of an accepted envelope must present exactly its recorded counter. */
export function verifyAndRecord(stateFile: string, i: Omit<VerifyInput, "storedSignCount">): VerifyResult {
  let state: HwState;
  try {
    state = readState(stateFile);
  } catch {
    return { ok: false, reason: "hardware approval state file is unreadable or malformed" };
  }
  const known = state.byEnvelope[i.envelopeSha256];
  const floor = counterFloor(state, i.envelopeSha256);
  // known envelope with a 0-counter token: recorded value 0 -> floor -1 would be invalid; handle the equal-counter case explicitly
  const r = known !== undefined && known === 0 ? verifyAssertion({ ...i, storedSignCount: 0 }) : verifyAssertion({ ...i, storedSignCount: Math.max(0, floor.storedSignCount) });
  if (!r.ok) return r;
  if (known !== undefined && r.signCount !== known) return { ok: false, reason: "a different assertion was presented for an envelope that was already approved with another counter" };
  if (known === undefined) {
    state.byEnvelope[i.envelopeSha256] = r.signCount;
    state.last = Math.max(state.last, r.signCount);
    mkdirSync(dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, stateFile);
  }
  return r;
}

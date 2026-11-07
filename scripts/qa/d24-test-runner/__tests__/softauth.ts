// SOFTWARE authenticator for tests only: generates P-256 keys and builds WebAuthn assertions in memory. It touches no real authenticator, no OS API and no
// browser. (The repository's TW-4F tests use the same idea in src/lib/sms/twilioIsv/__tests__/webauthnFixture.ts; this one is self-contained.)

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { anchorFingerprint, HW_KIND, type HardwareAnchor, type HardwareApprovalDoc } from "../webauthn";

export const RP_ID = "ops.example.test";
export const ORIGIN = "https://ops.example.test";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();

export type SoftAuth = { anchor: HardwareAnchor; privateKey: KeyObject; credentialId: string };

export function makeSoftAuth(over: Partial<Omit<HardwareAnchor, "fingerprintSha256">> = {}): SoftAuth {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(32).toString("base64url");
  const base = { v: 1 as const, kind: HW_KIND, credentialId, publicKey: { x: jwk.x as string, y: jwk.y as string }, rpId: RP_ID, origins: [ORIGIN], requireUV: true, repoUrl: "https://github.com/example-owner/example-repo.git", branch: "main", ...over };
  return { anchor: { ...base, fingerprintSha256: anchorFingerprint(base) }, privateKey, credentialId: base.credentialId };
}

export type AssertionOpts = {
  rpId?: string;
  flags?: number;
  signCount?: number;
  extension?: Buffer;
  type?: string;
  /** raw bytes of the hash to put in the challenge (default: the envelope hash) */
  challengeHex?: string;
  challengeText?: string;
  origin?: string;
  crossOrigin?: unknown;
  topOrigin?: string;
  /** replace the whole clientDataJSON text */
  clientDataText?: string;
  signWith?: KeyObject;
  /** edit the authenticatorData / clientData AFTER signing (tamper) */
  tamperAuthData?: (b: Buffer) => Buffer;
  tamperClientData?: (b: Buffer) => Buffer;
  rawSignature?: Buffer;
  signatureTransform?: (der: Buffer) => Buffer;
  credentialId?: string;
};

export function makeAssertion(a: SoftAuth, envelopeSha256: string, o: AssertionOpts = {}): HardwareApprovalDoc {
  const flags = o.flags ?? 0x05;
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(o.signCount ?? 1, 0);
  const authData = Buffer.concat([sha(o.rpId ?? a.anchor.rpId), Buffer.from([flags]), counter, o.extension ?? Buffer.alloc(0)]);
  const challenge = o.challengeText ?? Buffer.from(o.challengeHex ?? envelopeSha256, "hex").toString("base64url");
  const cdText =
    o.clientDataText ??
    JSON.stringify({ type: o.type ?? "webauthn.get", challenge, origin: o.origin ?? a.anchor.origins[0], ...(o.crossOrigin !== undefined ? { crossOrigin: o.crossOrigin } : {}), ...(o.topOrigin !== undefined ? { topOrigin: o.topOrigin } : {}) });
  const cdj = Buffer.from(cdText, "utf8");
  const der = sign("sha256", Buffer.concat([authData, sha(cdj)]), { key: o.signWith ?? a.privateKey, dsaEncoding: "der" });
  const signature = o.rawSignature ?? (o.signatureTransform ? o.signatureTransform(der) : der);
  return {
    v: 1,
    kind: HW_KIND,
    envelopeSha256,
    credentialId: o.credentialId ?? a.credentialId,
    authenticatorData: (o.tamperAuthData ? o.tamperAuthData(authData) : authData).toString("base64url"),
    clientDataJSON: (o.tamperClientData ? o.tamperClientData(cdj) : cdj).toString("base64url"),
    signature: signature.toString("base64url"),
  };
}

/** P-256 group order, for building the high-S twin of a signature. */
export const P256_N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");

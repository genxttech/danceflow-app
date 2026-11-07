/**
 * D4-2 test fixture: a SOFTWARE WebAuthn authenticator (a P-256 test key; never a real credential). It produces assertions exactly as an authenticator would
 * (authenticatorData, clientDataJSON, DER ECDSA signature), so the database verifier is exercised end to end. LOCAL QA DATABASE ONLY.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

export const RP_ID = "admin.example.test";
export const ORIGIN = "https://admin.example.test";

export const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64url");
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

export type AssertionOverrides = { origin?: string; rpId?: string; flags?: number; counter?: number; type?: string; crossOrigin?: boolean; challenge?: string };
export type Assertion = { credId: string; auth: string; client: string; sig: string };

export class SoftAuthenticator {
  readonly credId = randomBytes(32);
  readonly x: Buffer;
  readonly y: Buffer;
  private readonly privateKey: KeyObject;
  counter = 0;

  /** `share`: a second credential id for the SAME key (to test aliasing) */
  constructor(share?: SoftAuthenticator) {
    if (share) {
      this.privateKey = share.privateKey;
      this.x = share.x;
      this.y = share.y;
      return;
    }
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.privateKey = privateKey;
    this.x = Buffer.from(String(jwk.x), "base64url");
    this.y = Buffer.from(String(jwk.y), "base64url");
  }

  get credIdB64u(): string {
    return b64u(this.credId);
  }
  /** SQL bytea literals for the owner-level bootstrap */
  get hex() {
    return { cred: this.credId.toString("hex"), x: this.x.toString("hex"), y: this.y.toString("hex") };
  }

  /** An assertion over `challenge` (base64url, as the database returned it). Overrides produce deliberately wrong assertions. */
  assert(challenge: string, o: AssertionOverrides = {}): Assertion {
    const clientData = Buffer.from(JSON.stringify({ type: o.type ?? "webauthn.get", challenge: o.challenge ?? challenge, origin: o.origin ?? ORIGIN, crossOrigin: o.crossOrigin ?? false }));
    this.counter += 1;
    const authData = Buffer.concat([createHash("sha256").update(o.rpId ?? RP_ID).digest(), Buffer.from([o.flags ?? 0x05]), u32(o.counter ?? this.counter)]);
    const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), { key: this.privateKey, dsaEncoding: "der" });
    return { credId: this.credIdB64u, auth: b64u(authData), client: b64u(clientData), sig: b64u(signature) };
  }

  /** raw pieces for the ECDSA unit test */
  rawSign(message: Buffer): Buffer {
    return sign("sha256", message, { key: this.privateKey, dsaEncoding: "der" });
  }
}

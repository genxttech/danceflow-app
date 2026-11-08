// Evidence encryption for the GitHub-hosted D24 Stripe TEST proof. The repository is PUBLIC, so anything a workflow run uploads is public: the evidence pack is
// encrypted to an evidence PUBLIC key committed in the repo before it leaves the runner. Only the holder of the private half (engineering, generated offline)
// can read it. Built-in node:crypto only: hybrid RSA-OAEP (4096-bit, SHA-256) key wrap + AES-256-GCM, with the envelope header bound as GCM additional data.
//
// This module never touches the network and never prints plaintext. It is NOT part of the proof harness (scripts/qa/d24-m3d-proof): the harness manifest hash
// is pinned in the workflow and must not change when this file changes.

import { constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ALG = "RSA-OAEP-4096-SHA256+AES-256-GCM";
export const MIN_RSA_BITS = 4096;
/** The only file names an evidence bundle may contain (basenames; the run id is 8 hex characters). */
export const BUNDLE_NAME = /^(?:evidence-[0-9a-f]{8}\.json|transcript-[0-9a-f]{8}\.txt|terminal\.txt)$/;
const MAX_FILE_BYTES = 4_000_000;
const MAX_FILES = 16;

export type Envelope = {
  version: number;
  alg: string;
  /** SHA-256 of the public key's SPKI DER: lets the holder pick the right private key. Public information. */
  keyFingerprint: string;
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
  /** SHA-256 of the plaintext bundle (hex). Verified after decryption. */
  plaintextSha256: string;
};
export type BundleFile = { name: string; content: Buffer };

export const sha256Hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
/** The additional authenticated data: binds version, algorithm and key fingerprint, so none of them can be swapped without failing the tag. */
const aadFor = (version: number, alg: string, keyFingerprint: string) => Buffer.from(`D24-EVIDENCE|${version}|${alg}|${keyFingerprint}`, "utf8");

export class EvidenceCryptoError extends Error {}
const fail = (m: string): never => {
  throw new EvidenceCryptoError(m);
};

/** Parses the evidence PUBLIC key. Fails closed on a placeholder, on anything that is not a public RSA key of at least 4096 bits. */
export function parsePublicKey(pem: string): ReturnType<typeof createPublicKey> {
  if (/PLACEHOLDER/i.test(pem)) return fail("the evidence public key is still the PLACEHOLDER: refusing (generate the keypair offline and commit the public half)");
  if (/PRIVATE KEY/.test(pem)) return fail("the evidence key file contains a PRIVATE key: refusing (only the public key belongs in the repository)");
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(pem);
  } catch {
    return fail("the evidence public key could not be parsed");
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "rsa") return fail("the evidence public key must be an RSA public key");
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_BITS) return fail(`the evidence public key must be at least ${MIN_RSA_BITS} bits (got ${bits})`);
  return key;
}
const fingerprintOf = (key: ReturnType<typeof createPublicKey>) => sha256Hex(key.export({ type: "spki", format: "der" }) as Buffer);

/** Reads the evidence files (whitelisted basenames only; a directory, a link or a large file is refused) into one plaintext bundle. */
export function readBundleFiles(dir: string, extra: Array<{ name: string; path: string }> = []): BundleFile[] {
  const files: BundleFile[] = [];
  const take = (name: string, path: string) => {
    if (!BUNDLE_NAME.test(name)) return fail(`refusing to bundle ${JSON.stringify(name)}: not an expected evidence file name`);
    const st = statSync(path);
    if (!st.isFile()) return fail(`refusing to bundle ${name}: not a regular file`);
    if (st.size > MAX_FILE_BYTES) return fail(`refusing to bundle ${name}: larger than ${MAX_FILE_BYTES} bytes`);
    files.push({ name, content: readFileSync(path) });
  };
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (BUNDLE_NAME.test(name)) take(name, join(dir, name));
      else if (!/\.tmp$/.test(name)) fail(`unexpected file in the evidence directory: ${JSON.stringify(name.slice(0, 40))}`);
    }
  }
  for (const e of extra) if (existsSync(e.path)) take(e.name, e.path);
  if (files.length === 0) fail("no evidence files to bundle");
  if (files.length > MAX_FILES) fail("too many evidence files");
  if (new Set(files.map((f) => f.name)).size !== files.length) fail("duplicate evidence file names");
  return files;
}

/** Deterministic plaintext bundle (sorted by name). */
export function serializeBundle(files: BundleFile[]): Buffer {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Buffer.from(JSON.stringify({ v: 1, files: sorted.map((f) => ({ name: f.name, b64: f.content.toString("base64") })) }), "utf8");
}

export function parseBundle(plain: Buffer): BundleFile[] {
  let o: unknown;
  try {
    o = JSON.parse(plain.toString("utf8"));
  } catch {
    return fail("the decrypted bundle is not valid JSON");
  }
  const b = o as { v?: unknown; files?: unknown };
  if (!b || b.v !== 1 || !Array.isArray(b.files) || b.files.length === 0 || b.files.length > MAX_FILES) return fail("the decrypted bundle has an unexpected shape");
  const seen = new Set<string>();
  return b.files.map((f: unknown) => {
    const x = f as { name?: unknown; b64?: unknown };
    if (typeof x?.name !== "string" || typeof x?.b64 !== "string" || !BUNDLE_NAME.test(x.name)) return fail("the decrypted bundle names a file that is not an expected evidence file");
    if (seen.has(x.name)) return fail("the decrypted bundle repeats a file name");
    seen.add(x.name);
    return { name: x.name, content: Buffer.from(x.b64, "base64") };
  });
}

export function encryptBundle(plain: Buffer, publicKeyPem: string): Envelope {
  const pub = parsePublicKey(publicKeyPem);
  const keyFingerprint = fingerprintOf(pub);
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  cipher.setAAD(aadFor(ENVELOPE_VERSION, ENVELOPE_ALG, keyFingerprint));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedKey = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey);
  return {
    version: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    keyFingerprint,
    wrappedKey: wrappedKey.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    plaintextSha256: sha256Hex(plain),
  };
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
export function parseEnvelope(text: string): Envelope {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return fail("the envelope is not valid JSON");
  }
  const e = o as Record<string, unknown>;
  const keys = ["version", "alg", "keyFingerprint", "wrappedKey", "iv", "tag", "ciphertext", "plaintextSha256"];
  if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).sort().join() !== [...keys].sort().join()) return fail("the envelope has unexpected fields");
  if (e.version !== ENVELOPE_VERSION || e.alg !== ENVELOPE_ALG) return fail("unsupported envelope version or algorithm");
  for (const k of ["wrappedKey", "iv", "tag", "ciphertext"]) if (typeof e[k] !== "string" || !B64.test(e[k] as string)) return fail(`envelope field ${k} is not base64`);
  for (const k of ["keyFingerprint", "plaintextSha256"]) if (typeof e[k] !== "string" || !HEX64.test(e[k] as string)) return fail(`envelope field ${k} is not a SHA-256`);
  return e as unknown as Envelope;
}

/** Decrypts and verifies: GCM tag (covers ciphertext + header), then the plaintext SHA-256. Throws EvidenceCryptoError on ANY mismatch. */
export function decryptEnvelope(env: Envelope, privateKeyPem: string): Buffer {
  let priv: ReturnType<typeof createPrivateKey>;
  try {
    priv = createPrivateKey(privateKeyPem);
  } catch {
    return fail("the private key could not be parsed");
  }
  const fp = sha256Hex(createPublicKey(priv).export({ type: "spki", format: "der" }) as Buffer);
  if (fp !== env.keyFingerprint) return fail("this private key does not match the envelope's key fingerprint");
  let aesKey: Buffer;
  try {
    aesKey = privateDecrypt({ key: priv, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(env.wrappedKey, "base64"));
  } catch {
    return fail("the wrapped key could not be unwrapped");
  }
  if (aesKey.length !== 32) return fail("the wrapped key has an unexpected length");
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) return fail("the envelope iv or tag has an unexpected length");
  let plain: Buffer;
  try {
    const d = createDecipheriv("aes-256-gcm", aesKey, iv);
    d.setAAD(aadFor(env.version, env.alg, env.keyFingerprint));
    d.setAuthTag(tag);
    plain = Buffer.concat([d.update(Buffer.from(env.ciphertext, "base64")), d.final()]);
  } catch {
    return fail("authentication failed: the envelope was modified or is corrupt");
  }
  if (sha256Hex(plain) !== env.plaintextSha256) return fail("the plaintext SHA-256 does not match the envelope");
  return plain;
}

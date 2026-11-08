// D24 GitHub-environment proof: evidence encryption. The workflow's logs and artifacts are PUBLIC, so the evidence pack is encrypted
// to a public key committed in this directory before anything is uploaded. Only the private half (held by engineering, never in GitHub)
// can read it. Hybrid scheme with node's built-in crypto only: a random AES-256-GCM key encrypts the bundle, RSA-OAEP (SHA-256, 4096-bit key
// minimum) wraps that key. The envelope header is bound to the ciphertext as additional authenticated data, so changing any field is detected.

import { constants, createCipheriv, createDecipheriv, createHash, createPublicKey, createPrivateKey, publicEncrypt, privateDecrypt, randomBytes } from "node:crypto";

export const ENVELOPE_VERSION = "d24-evidence-v1";
export const PLACEHOLDER_MARKER = "D24-EVIDENCE-PUBLIC-KEY-PLACEHOLDER";
export const MIN_RSA_BITS = 4096;

export type Envelope = { v: typeof ENVELOPE_VERSION; alg: "RSA-OAEP-SHA256+AES-256-GCM"; wrappedKey: string; iv: string; tag: string; ciphertext: string };

export const sha256Hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Why this PEM may not be used as the evidence public key (null = usable). Fails closed on the placeholder, on anything that is not an RSA public key and on short keys. */
export function publicKeyProblem(pem: string): string | null {
  if (pem.includes(PLACEHOLDER_MARKER)) return "the evidence public key is still the PLACEHOLDER (engineering must commit the real public key first)";
  if (!/-----BEGIN PUBLIC KEY-----/.test(pem) || /PRIVATE KEY/.test(pem)) return "the evidence key file must contain exactly an SPKI PUBLIC KEY block and no private key";
  try {
    const k = createPublicKey(pem);
    if (k.asymmetricKeyType !== "rsa") return "the evidence public key must be an RSA key";
    const bits = k.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < MIN_RSA_BITS) return `the evidence public key has ${bits} bits (need >= ${MIN_RSA_BITS})`;
  } catch {
    return "the evidence key file is not a parseable public key";
  }
  return null;
}

const header = (): string => `${ENVELOPE_VERSION}|RSA-OAEP-SHA256+AES-256-GCM`;

export function encryptEvidence(plaintext: Buffer, publicKeyPem: string): Envelope {
  const problem = publicKeyProblem(publicKeyPem);
  if (problem) throw new Error(problem);
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  cipher.setAAD(Buffer.from(header()));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrappedKey = publicEncrypt({ key: createPublicKey(publicKeyPem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey);
  aesKey.fill(0);
  return { v: ENVELOPE_VERSION, alg: "RSA-OAEP-SHA256+AES-256-GCM", wrappedKey: wrappedKey.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

/** Throws on any tampering (wrong key, altered ciphertext, tag, IV, wrapped key or header). */
export function decryptEvidence(env: unknown, privateKeyPem: string): Buffer {
  const e = env as Partial<Envelope> | null;
  if (!e || typeof e !== "object" || e.v !== ENVELOPE_VERSION || e.alg !== "RSA-OAEP-SHA256+AES-256-GCM") throw new Error("not a d24-evidence-v1 envelope");
  for (const f of ["wrappedKey", "iv", "tag", "ciphertext"] as const) if (typeof e[f] !== "string") throw new Error(`envelope field ${f} is missing`);
  const aesKey = privateDecrypt({ key: createPrivateKey(privateKeyPem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(e.wrappedKey as string, "base64"));
  const iv = Buffer.from(e.iv as string, "base64");
  const tag = Buffer.from(e.tag as string, "base64");
  if (aesKey.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error("envelope field has the wrong length");
  const d = createDecipheriv("aes-256-gcm", aesKey, iv);
  d.setAAD(Buffer.from(header()));
  d.setAuthTag(tag);
  const out = Buffer.concat([d.update(Buffer.from(e.ciphertext as string, "base64")), d.final()]);
  aesKey.fill(0);
  return out;
}

// ---- bundle: the plaintext inside the envelope is a JSON object { v, files: { name: base64 }, sha256: { name: hex } } -------------------------------

export type Bundle = { v: "d24-bundle-v1"; files: Record<string, string>; sha256: Record<string, string> };

const SAFE_NAME = /^[A-Za-z0-9._-]{1,120}$/;

export function makeBundle(files: Record<string, Buffer>): Buffer {
  const b: Bundle = { v: "d24-bundle-v1", files: {}, sha256: {} };
  for (const name of Object.keys(files).sort()) {
    if (!SAFE_NAME.test(name) || name === "." || name === "..") throw new Error(`unsafe file name in bundle: ${name}`);
    b.files[name] = files[name].toString("base64");
    b.sha256[name] = sha256Hex(files[name]);
  }
  return Buffer.from(JSON.stringify(b));
}

/** Parses a bundle and verifies each file against the recorded sha256 (names are re-validated: no path can escape the output folder). */
export function openBundle(plain: Buffer): Record<string, Buffer> {
  const b = JSON.parse(plain.toString("utf8")) as Bundle;
  if (!b || b.v !== "d24-bundle-v1" || typeof b.files !== "object" || typeof b.sha256 !== "object") throw new Error("not a d24-bundle-v1 bundle");
  const out: Record<string, Buffer> = {};
  for (const name of Object.keys(b.files)) {
    if (!SAFE_NAME.test(name) || name === "." || name === "..") throw new Error(`unsafe file name in bundle: ${name}`);
    const data = Buffer.from(b.files[name], "base64");
    if (sha256Hex(data) !== b.sha256[name]) throw new Error(`sha256 mismatch for ${name}`);
    out[name] = data;
  }
  return out;
}

// ---- job summary: counts and hashes only. No account or object ids, no free text from the evidence. -------------------------------------------------

export type SummaryInput = { evidenceJson: string | null; cipherSha256: string; plainFiles: Record<string, string> };

/** Reads only numbers and fixed enum tokens out of the evidence JSON. Anything unexpected is shown as "unreadable", never echoed. */
export function summaryMarkdown(s: SummaryInput): string {
  let outcome = "unreadable";
  let calls: number | string = "unreadable";
  let blocked: number | string = "unreadable";
  const v = { pass: 0, passStripeSide: 0, fail: 0, notTested: 0, other: 0 };
  let checksOk = 0;
  let checksFailed = 0;
  if (s.evidenceJson) {
    try {
      const j = JSON.parse(s.evidenceJson) as Record<string, unknown>;
      if (["OK", "FAILED", "INCOMPLETE"].includes(String(j.outcome))) outcome = String(j.outcome);
      if (Number.isInteger(j.callsUsed)) calls = j.callsUsed as number;
      if (Number.isInteger(j.blockedBeforeNetwork)) blocked = j.blockedBeforeNetwork as number;
      for (const x of Object.values((j.verdicts ?? {}) as Record<string, { verdict?: unknown }>)) {
        const t = x?.verdict;
        if (t === "PASS") v.pass++;
        else if (t === "PASS (Stripe side only)") v.passStripeSide++;
        else if (t === "FAIL") v.fail++;
        else if (t === "NOT TESTED") v.notTested++;
        else v.other++;
      }
      for (const sc of Array.isArray(j.scenarios) ? (j.scenarios as Array<{ checks?: Array<{ ok?: unknown }> }>) : [])
        for (const c of Array.isArray(sc?.checks) ? sc.checks : []) {
          if (c?.ok === true) checksOk++;
          else checksFailed++;
        }
    } catch {
      /* stays "unreadable" */
    }
  }
  const lines = [
    "### D24 Stripe TEST proof result (counts and hashes only)",
    "",
    `- outcome: **${outcome}**`,
    `- Stripe requests sent: ${calls}; refused before the network (BLOCKED): ${blocked}`,
    `- verdicts: PASS ${v.pass}, PASS (Stripe side only) ${v.passStripeSide}, FAIL ${v.fail}, NOT TESTED ${v.notTested}, unrecognised ${v.other}`,
    `- scenario checks: ${checksOk} ok, ${checksFailed} failed`,
    `- ciphertext (artifact) sha256: \`${s.cipherSha256}\``,
    ...Object.keys(s.plainFiles).sort().map((n) => `- plaintext \`${n}\` sha256: \`${s.plainFiles[n]}\``),
    "",
    "The evidence itself is encrypted to the engineering public key; it is not shown here.",
  ];
  return lines.join("\n");
}

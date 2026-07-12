import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const DOCUMENT_FILES_BUCKET = "document-files";

export function createSigningToken() {
  return randomBytes(32).toString("base64url");
}

export function hashSigningToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function safeTokenEquals(token: string, expectedHash: string) {
  const actual = Buffer.from(hashSigningToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sourceStoragePath(studioId: string, envelopeId: string) {
  return `studios/${studioId}/envelopes/${envelopeId}/source.pdf`;
}

export function signedStoragePath(studioId: string, envelopeId: string) {
  return `studios/${studioId}/envelopes/${envelopeId}/signed.pdf`;
}

export function certificateStoragePath(studioId: string, envelopeId: string) {
  return `studios/${studioId}/envelopes/${envelopeId}/certificate.pdf`;
}

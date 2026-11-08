// Engineering-side tool (run on the machine that holds the evidence PRIVATE key; never on a runner):
//   decrypt-cli.ts --in <envelope.json> --private-key <pem> --out <new empty dir> [--expect-ciphertext-sha256 H] [--expect-plaintext-sha256 H]
// Verifies the GCM tag, the plaintext SHA-256, and (when given) the two SHA-256 values that the public job summary showed, then writes the evidence files into --out.
// It refuses to write into a non-empty directory, writes only whitelisted basenames, and prints only fixed status lines (never evidence content).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EvidenceCryptoError, decryptEnvelope, parseBundle, parseEnvelope, sha256Hex } from "./evidence-crypto";

export type CliIo = { out: (s: string) => void };
const NAMES = ["in", "private-key", "out", "expect-ciphertext-sha256", "expect-plaintext-sha256"];
const HEX64 = /^[0-9a-f]{64}$/;

export function runDecryptCli(argv: string[], io: CliIo): number {
  const v: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const val = argv[i + 1];
    if (!k?.startsWith("--") || !NAMES.includes(k.slice(2)) || val === undefined || val.startsWith("--")) {
      io.out("usage: decrypt-cli.ts --in F --private-key P --out DIR [--expect-ciphertext-sha256 H] [--expect-plaintext-sha256 H]");
      return 2;
    }
    v[k.slice(2)] = val;
  }
  if (!v.in || !v["private-key"] || !v.out) {
    io.out("refused: --in, --private-key and --out are required");
    return 2;
  }
  for (const k of ["expect-ciphertext-sha256", "expect-plaintext-sha256"]) {
    if (v[k] !== undefined && !HEX64.test(v[k] as string)) {
      io.out(`refused: --${k} must be 64 lowercase hex characters`);
      return 2;
    }
  }
  try {
    if (existsSync(v.out) && readdirSync(v.out).length > 0) {
      io.out("refused: --out exists and is not empty");
      return 2;
    }
    const text = readFileSync(v.in, "utf8");
    // the SHA-256 the public job summary showed is the hash of the file as uploaded
    if (v["expect-ciphertext-sha256"] !== undefined && sha256Hex(text) !== v["expect-ciphertext-sha256"]) throw new EvidenceCryptoError("the envelope file's SHA-256 does not match the expected ciphertext SHA-256");
    const env = parseEnvelope(text);
    if (v["expect-plaintext-sha256"] !== undefined && env.plaintextSha256 !== v["expect-plaintext-sha256"]) throw new EvidenceCryptoError("the envelope's plaintext SHA-256 does not match the expected value");
    const plain = decryptEnvelope(env, readFileSync(v["private-key"], "utf8"));
    const files = parseBundle(plain);
    mkdirSync(v.out, { recursive: true });
    for (const f of files) writeFileSync(join(v.out, f.name), f.content, { mode: 0o600, flag: "wx" });
    io.out(`OK: ${files.length} file(s) verified (GCM tag + plaintext SHA-256${v["expect-ciphertext-sha256"] ? " + expected ciphertext SHA-256" : ""}) and written`);
    return 0;
  } catch (e) {
    io.out(e instanceof EvidenceCryptoError ? `FAILED: ${e.message}` : `FAILED: ${(e as { code?: string })?.code ?? "unexpected error"}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runDecryptCli(process.argv.slice(2), { out: (s) => void process.stdout.write(`${s}\n`) });
}

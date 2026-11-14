// Runner-side CLI. Two modes, both offline:
//   --check-key <public-key.pem>                          fail closed (exit 1) unless the evidence public key is a real RSA >= 4096 public key (not the placeholder)
//   --encrypt --evidence-dir D --public-key P --out F [--terminal T] [--summary-file S]
//        bundles the evidence files (+ the captured terminal output), encrypts to P, writes the envelope to F, and appends the public summary (counts + hashes) to S.
// It prints nothing but fixed status lines: never evidence content, never a key, never an id.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EvidenceCryptoError, encryptBundle, parsePublicKey, readBundleFiles, serializeBundle, sha256Hex } from "./evidence-crypto";
import { factsFrom, renderSummary } from "./summary";

export type CliIo = { out: (s: string) => void };

function flags(argv: string[], names: string[]): { ok: true; v: Record<string, string> } | { ok: false; reason: string } {
  const v: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith("--") || !names.includes(k.slice(2))) return { ok: false, reason: `unexpected argument ${JSON.stringify(String(k).slice(0, 30))}` };
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) return { ok: false, reason: `${k} needs a value` };
    v[k.slice(2)] = val;
  }
  return { ok: true, v };
}

export function runEncryptCli(argv: string[], io: CliIo): number {
  try {
    if (argv[0] === "--check-key") {
      if (argv.length !== 2 || !argv[1] || argv[1].startsWith("--")) {
        io.out("refused: --check-key takes exactly one argument, the public key file");
        return 2;
      }
      parsePublicKey(readFileSync(argv[1], "utf8"));
      io.out("evidence public key: OK (RSA public key, >= 4096 bits, not the placeholder)");
      return 0;
    }
    if (argv[0] !== "--encrypt") {
      io.out("usage: encrypt-cli.ts --check-key <pem> | --encrypt --evidence-dir D --public-key P --out F [--terminal T] [--summary-file S]");
      return 2;
    }
    const f = flags(argv.slice(1), ["evidence-dir", "public-key", "out", "terminal", "summary-file"]);
    if (!f.ok) {
      io.out(`refused: ${f.reason}`);
      return 2;
    }
    const { "evidence-dir": dir, "public-key": keyPath, out, terminal, "summary-file": summaryFile } = f.v;
    if (!dir || !keyPath || !out) {
      io.out("refused: --evidence-dir, --public-key and --out are required");
      return 2;
    }
    const pem = readFileSync(keyPath, "utf8");
    parsePublicKey(pem); // fail closed BEFORE reading any evidence
    const files = readBundleFiles(dir, terminal ? [{ name: "terminal.txt", path: terminal }] : []);
    const plain = serializeBundle(files);
    const env = encryptBundle(plain, pem);
    mkdirSync(dirname(out), { recursive: true });
    const text = `${JSON.stringify(env)}\n`;
    writeFileSync(out, text, { mode: 0o600, flag: "wx" });
    const evidence = files.find((x) => /^evidence-[0-9a-f]{8}\.json$/.test(x.name));
    const md = renderSummary(factsFrom(evidence ? evidence.content.toString("utf8") : null), sha256Hex(text), env.plaintextSha256);
    if (summaryFile) appendFileSync(summaryFile, md);
    io.out(`evidence encrypted: ${files.length} file(s) -> 1 envelope; ciphertext sha256 ${sha256Hex(text)}; plaintext sha256 ${env.plaintextSha256}`);
    return 0;
  } catch (e) {
    // only our own fixed messages are printed; an unexpected error is described by its class, never its text (it could quote a path or a value)
    io.out(e instanceof EvidenceCryptoError ? `FAILED: ${e.message}` : `FAILED: ${(e as { code?: string })?.code ?? "unexpected error"}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runEncryptCli(process.argv.slice(2), { out: (s) => void process.stdout.write(`${s}\n`) });
}
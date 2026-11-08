// CLI for the D24 GitHub-environment proof evidence. Used by the workflow (check-key, encrypt) and by engineering (decrypt).
//   tsx cli.ts check-key  --key <public.pem>
//   tsx cli.ts encrypt    --key <public.pem> --evidence-dir <dir> [--extra name=path ...] --out <file.enc> --summary <file.md>
//   tsx cli.ts decrypt    --in <file.enc> --private-key <private.pem> --out <new-or-empty dir>
// Never prints evidence content. Keys are read from files given on the command line (the private key never exists in GitHub).

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decryptEvidence, encryptEvidence, makeBundle, openBundle, publicKeyProblem, sha256Hex, summaryMarkdown } from "./evidence-crypto";

function opts(argv: string[]): { map: Record<string, string[]>; bad: string | null } {
  const map: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith("--") || v === undefined) return { map, bad: `bad argument near ${k ?? "(end)"}` };
    (map[k.slice(2)] ??= []).push(v);
  }
  return { map, bad: null };
}

function mainInner(argv: string[], out: (s: string) => void = (s) => process.stdout.write(`${s}\n`)): number {
  const [cmd, ...rest] = argv;
  const { map, bad } = opts(rest);
  const one = (k: string): string | null => (map[k]?.length === 1 ? map[k][0] : null);
  if (bad) {
    out(`error: ${bad}`);
    return 2;
  }
  if (cmd === "check-key") {
    const f = one("key");
    if (!f || !existsSync(f)) {
      out("error: --key <file> is required and must exist");
      return 2;
    }
    const p = publicKeyProblem(readFileSync(f, "utf8"));
    out(p ? `REFUSED: ${p}` : "evidence public key: usable (RSA, >= 4096 bits)");
    return p ? 1 : 0;
  }
  if (cmd === "encrypt") {
    const key = one("key");
    const dir = one("evidence-dir");
    const dest = one("out");
    const sum = one("summary");
    if (!key || !dir || !dest || !sum || !existsSync(key) || !existsSync(dir)) {
      out("error: --key, --evidence-dir, --out and --summary are required");
      return 2;
    }
    const pem = readFileSync(key, "utf8");
    const p = publicKeyProblem(pem);
    if (p) {
      out(`REFUSED: ${p}`);
      return 1;
    }
    const files: Record<string, Buffer> = {};
    for (const n of readdirSync(dir).sort()) {
      const full = join(dir, n);
      if (statSync(full).isFile()) files[n] = readFileSync(full);
    }
    for (const x of map.extra ?? []) {
      const eq = x.indexOf("=");
      const name = x.slice(0, eq);
      const path = x.slice(eq + 1);
      if (eq < 1 || !existsSync(path)) {
        out("error: --extra needs name=path to an existing file");
        return 2;
      }
      files[name] = readFileSync(path);
    }
    if (Object.keys(files).length === 0) {
      out("REFUSED: nothing to encrypt (no evidence files)");
      return 1;
    }
    const cipherText = JSON.stringify(encryptEvidence(makeBundle(files), pem));
    writeFileSync(dest, cipherText, { flag: "wx", mode: 0o600 });
    const jsonName = Object.keys(files).find((n) => /^evidence-[A-Za-z0-9]+\.json$/.test(n));
    const plainFiles: Record<string, string> = {};
    for (const n of Object.keys(files)) plainFiles[n.replace(/-[0-9a-f]{8}(?=\.)/i, "-<runId>")] = sha256Hex(files[n]);
    writeFileSync(sum, summaryMarkdown({ evidenceJson: jsonName ? files[jsonName].toString("utf8") : null, cipherSha256: sha256Hex(cipherText), plainFiles }), { flag: "wx" });
    out(`encrypted ${Object.keys(files).length} file(s); ciphertext sha256 ${sha256Hex(cipherText)}`);
    return 0;
  }
  if (cmd === "decrypt") {
    const inp = one("in");
    const priv = one("private-key");
    const dest = one("out");
    if (!inp || !priv || !dest || !existsSync(inp) || !existsSync(priv)) {
      out("error: --in, --private-key and --out are required");
      return 2;
    }
    let files: Record<string, Buffer>;
    try {
      files = openBundle(decryptEvidence(JSON.parse(readFileSync(inp, "utf8")), readFileSync(priv, "utf8")));
    } catch (e) {
      out(`FAILED: ${(e as Error).message}`);
      return 1;
    }
    mkdirSync(dest, { recursive: true });
    for (const n of Object.keys(files)) writeFileSync(join(dest, n), files[n], { flag: "wx", mode: 0o600 });
    out(`decrypted and verified ${Object.keys(files).length} file(s) into ${dest}`);
    return 0;
  }
  out("usage: cli.ts check-key | encrypt | decrypt (see the header of this file)");
  return 2;
}

export function main(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s + "\n")): number {
  try {
    return mainInner(argv, out);
  } catch (e) {
    out(`FAILED: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));

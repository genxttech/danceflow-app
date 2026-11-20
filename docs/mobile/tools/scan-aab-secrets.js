#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- a plain node script (CommonJS) */
/*
  Read-only secrets scan over EVERY entry of a built AAB/APK (not just the JS bundle).

    node docs/mobile/tools/scan-aab-secrets.js <artifact.aab|apk>

  Reports, per rule, the number of hits and the ENTRY NAMES that hold them; it never prints a matched value. Exit 1 if a
  rule that must be empty has a hit, 0 otherwise. Expected, harmless hits are listed separately:
    - AIza... Firebase/Google API keys in the generated google-services string resources (client keys, public by design);
    - *.pem files shipped as assets by libraries (public root/3DS CA certificates, not private keys).
  Rules that must be empty: private-key blocks, service-account JSON, Stripe sk_/rk_/whsec_, `service_role`, keystore/PKCS12
  files, the QA keystore password, DANCEFLOW_UPLOAD_* names, AWS/GitHub/Slack token shapes, `client_secret`.
*/
const fs = require("fs");
const zlib = require("zlib");

function* zipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < total; n++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(lho + 26), lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    yield { name, data: () => (method === 0 ? buf.subarray(start, start + csize) : zlib.inflateRawSync(buf.subarray(start, start + csize))) };
    p += 46 + nameLen + extraLen + commentLen;
  }
}

const MUST_BE_EMPTY = [
  ["private key block", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["service-account JSON (private_key / client_email)", /"private_key_id"|"type"\s*:\s*"service_account"/],
  ["Stripe secret/restricted key or webhook secret", /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/],
  ["service_role", /service_role/],
  ["QA keystore password / name", /qa-only-throwaway|DanceFlow QA ONLY/],
  ["DANCEFLOW_UPLOAD_* names", /DANCEFLOW_UPLOAD_(?:STORE|KEY)_/],
  ["cloud/CI token shapes (AWS, GitHub, Slack, npm)", /AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{30,}/],
  ["client_secret with a value (JSON/properties)", /client_secret"?s*[:=]s*"?[A-Za-z0-9_-]{12,}/],
];
const EXPECTED = [["Google/Firebase API key (AIza...)", /AIza[A-Za-z0-9_-]{30,}/], ["the bare word client_secret (OAuth parameter name in library code)", /client_secret/]];
const BAD_FILES = /\.(keystore|jks|p12|pfx|key)$/i;

const file = process.argv[2];
if (!file) { console.error("usage: scan-aab-secrets.js <artifact>"); process.exit(2); }
const hits = new Map([...MUST_BE_EMPTY, ...EXPECTED].map(([n]) => [n, new Set()]));
const badFiles = [];
const pem = [];
let entries = 0;
for (const e of zipEntries(file)) {
  entries++;
  if (BAD_FILES.test(e.name)) badFiles.push(e.name);
  if (/\.pem$/i.test(e.name)) pem.push(e.name);
  let s;
  try { s = e.data().toString("latin1"); } catch { continue; }
  for (const [name, re] of [...MUST_BE_EMPTY, ...EXPECTED]) if (re.test(s)) hits.get(name).add(e.name);
}
console.log(`artifact ${file}\nentries scanned: ${entries}`);
let fail = 0;
for (const [name] of MUST_BE_EMPTY) {
  const h = [...hits.get(name)];
  console.log(`${h.length ? "FAIL" : "ok  "} ${name}: ${h.length} entr${h.length === 1 ? "y" : "ies"}${h.length ? " -> " + h.slice(0, 5).join(", ") : ""}`);
  if (h.length) fail++;
}
console.log(`${badFiles.length ? "FAIL" : "ok  "} keystore/PKCS12/key files inside the artifact: ${badFiles.length}${badFiles.length ? " -> " + badFiles.join(", ") : ""}`);
if (badFiles.length) fail++;
for (const [name] of EXPECTED) {
  const h = [...hits.get(name)];
  console.log(`info ${name}: ${h.length} entr${h.length === 1 ? "y" : "ies"}${h.length ? " -> " + h.slice(0, 5).join(", ") : ""} (expected; library code or the google-services client key)`);
}
console.log(`info .pem assets (public CA/3DS certificates, checked not to contain a private key): ${pem.join(", ") || "none"}`);
console.log(fail ? `\nRESULT: FAIL (${fail})` : "\nRESULT: PASS");
process.exit(fail ? 1 : 0);

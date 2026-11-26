#!/usr/bin/env node
// Proves what .gitleaks.toml reports and what it allows, on synthetic strings built at run time
// (nothing secret-shaped is stored in this file).
// Usage: node scripts/security/gitleaks-selftest.mjs <path to the gitleaks binary>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.argv[2];
if (!binary) {
  console.error("usage: node scripts/security/gitleaks-selftest.mjs <gitleaks binary>");
  process.exit(2);
}
const CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".gitleaks.toml");

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** Deterministic high-entropy text, so a run never depends on chance. */
function chars(label, length, alphabet = ALNUM) {
  let out = "";
  for (let i = 0; out.length < length; i++) {
    for (const byte of createHash("sha256").update(`${label}:${i}`).digest()) out += alphabet[byte % alphabet.length];
  }
  return out.slice(0, length);
}
const stripe = (kind, mode, body) => [kind, mode, body].join("_");
const webhook = (body) => ["whsec", body].join("_");
const assign = (name, value) => `export const ${name} = "${value}";\n`;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (issuer, role) => [b64({ alg: "HS256", typ: "JWT" }), b64({ iss: issuer, role, exp: 1983812996 }), chars(`sig-${issuer}`, 43)].join(".");

const shortTest = stripe("sk", "test", chars("short-test", 20));
const shortLive = stripe("sk", "live", chars("short-live", 20));
const separated = stripe("sk", "test", `${chars("sep-a", 16)}_${chars("sep-b", 18)}`);
const shortHook = webhook(chars("short-hook", 20));
const twilioSid = ["SK", chars("twilio", 32, "0123456789abcdef")].join("");
const TWILIO_FIXTURE = "src/lib/sms/__tests__/fixtures/twilio/documentedShapes.json";

/** [expected, path, content, description] */
const cases = [
  ["allow", "src/a/__tests__/short-test.test.ts", assign("stripeSecretKey", shortTest), "short sk_test_ in __tests__"],
  ["flag", "src/a/short-test.ts", assign("stripeSecretKey", shortTest), "the same string outside test code"],
  ["allow", "scripts/qa/x/short-live.ts", assign("stripeSecretKey", shortLive), "short sk_live_ in scripts/qa"],
  ["flag", "src/a/short-live.ts", assign("stripeSecretKey", shortLive), "the same string outside test code"],
  ["allow", "src/a/__tests__/separated.test.ts", assign("stripeSecretKey", separated), "long sk_test_ with a separator in __tests__"],
  ["flag", "src/a/separated.ts", assign("stripeSecretKey", separated), "the same string outside test code"],
  ["flag", "src/a/__tests__/legacy-live.test.ts", assign("stripeSecretKey", stripe("sk", "live", chars("legacy-live", 24))), "24-character sk_live_ (older real key length) in __tests__"],
  ["flag", "src/a/__tests__/full-live.test.ts", assign("stripeSecretKey", stripe("sk", "live", chars("full-live", 99))), "full-length sk_live_ in __tests__"],
  ["flag", "scripts/qa/x/full-restricted.ts", assign("stripeSecretKey", stripe("rk", "live", chars("full-restricted", 99))), "full-length rk_live_ in scripts/qa"],
  ["flag", "src/a/__tests__/full-test.test.ts", assign("stripeSecretKey", stripe("sk", "test", chars("full-test", 99))), "full-length sk_test_ in __tests__"],
  ["flag", "src/a/__tests__/inline-allow.test.ts", `export const stripeSecretKey = "${stripe("sk", "live", chars("inline", 99))}"; // gitleaks:allow\n`, "an inline allow comment does not hide a key"],
  ["allow", "src/a/__tests__/short-hook.test.ts", assign("webhookSecret", shortHook), "short whsec_ in __tests__"],
  ["flag", "src/a/short-hook.ts", assign("webhookSecret", shortHook), "the same string outside test code"],
  ["flag", "src/a/__tests__/full-hook.test.ts", assign("webhookSecret", webhook(chars("full-hook", 32))), "full-length whsec_ in __tests__"],
  ["allow", ".env.e2e.example", `SUPABASE_ANON_KEY=${jwt("supabase-demo", "anon")}\n`, "Supabase demo JWT"],
  ["flag", "src/a/service-role.env", `SUPABASE_SERVICE_ROLE_KEY=${jwt("supabase", "service_role")}\n`, "a JWT with a hosted-project issuer"],
  ["allow", TWILIO_FIXTURE, `{ "api_key": "${twilioSid}" }\n`, "synthetic Twilio SID in the documented-shape fixture"],
  ["flag", "src/a/twilio.json", `{ "api_key": "${twilioSid}" }\n`, "the same SID elsewhere"],
  ["flag", "src/a/__tests__/other-rule.test.ts", assign("githubToken", ["ghp", chars("github", 36)].join("_")), "another rule is not silenced in __tests__"],
];

const work = mkdtempSync(join(tmpdir(), "gitleaks-selftest-"));
let failed = 0;
try {
  const tree = join(work, "tree");
  for (const [, path, content] of cases) {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    writeFileSync(join(tree, path), content, { flag: "wx" });
  }
  const report = join(work, "report.json");
  execFileSync(resolve(binary), ["dir", ".", "--config", CONFIG, "--ignore-gitleaks-allow", "--redact", "--no-banner", "--exit-code", "0", "--report-format", "json", "--report-path", report], { cwd: tree, stdio: ["ignore", "inherit", "inherit"] });
  const findings = JSON.parse(readFileSync(report, "utf8")).map((f) => ({ rule: f.RuleID, file: f.File.replaceAll("\\", "/").replace(/^\.\//, "") }));
  for (const [expected, path, , description] of cases) {
    const rules = findings.filter((f) => f.file === path).map((f) => f.rule);
    const ok = expected === "flag" ? rules.length > 0 : rules.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} expect ${expected}: ${description} [${path}] reported by: ${rules.join(", ") || "nothing"}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`${cases.length - failed}/${cases.length} cases passed`);
process.exit(failed === 0 ? 0 : 1);

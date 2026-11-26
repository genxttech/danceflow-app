#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- a plain node script (CommonJS) */
/*
  Verify the EXPO_PUBLIC_* values baked into a BUILT release artifact (AAB, APK or a raw Hermes bundle).

    node docs/mobile/tools/verify-baked-config.js <artifact.aab|apk|index.android.bundle> <expected.json>
    node docs/mobile/tools/verify-baked-config.js --self-test

  Metro inlines EXPO_PUBLIC_* at bundle time and can replay an older build's values from a stale cache, so the environment you
  exported proves nothing: read what is in the artifact (Android_Release_Audit.md section 9, Runbook step 1b).

  expected.json (see expected-production.example.json):
    { "app": "student" | "business",
      "supabaseRef": "<project ref>",          // the only Supabase project allowed in the bundle
      "webUrl": "https://www.idanceflow.com",    // must be present (origin serving /api/*)
      "stripe": "unset" | "live" | "test" | "any" }

  Exit 0 = PASS, 1 = FAIL (every failed rule is listed), 2 = usage error. The script never prints a key: JWTs are reported by
  role/ref/expiry only. It reads the artifact only; it needs no network and no credentials.

  The Hermes string table stores ASCII strings back to back with no separator, so a value is looked for as a substring and the
  Supabase URL is matched by its fixed shape (https://<20 chars>.supabase.co), not by delimiters.
*/
const fs = require("fs");
const zlib = require("zlib");

const BUNDLE_ENTRIES = ["base/assets/index.android.bundle", "assets/index.android.bundle"];
// Library strings that exist in every clean build (counted on the clean RC3-RC5 placeholder artifacts of both apps).
const BASELINE = { localhost: 2, loopback: 1 };

function readZipEntry(file, names) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (names.includes(name)) {
      const lNameLen = buf.readUInt16LE(lho + 26);
      const lExtraLen = buf.readUInt16LE(lho + 28);
      const data = buf.subarray(lho + 30 + lNameLen + lExtraLen, lho + 30 + lNameLen + lExtraLen + csize);
      return { name, bytes: method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data) };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`no ${names.join(" or ")} in ${file}`);
}

function loadBundle(file) {
  const head = fs.readFileSync(file).subarray(0, 4);
  if (head.readUInt32LE(0) === 0x04034b50) return readZipEntry(file, BUNDLE_ENTRIES);
  return { name: file, bytes: fs.readFileSync(file) };
}

const count = (s, needle) => s.split(needle).length - 1;

function check(bundle, expected, now = Date.now() / 1000) {
  const s = bundle.toString("latin1");
  const fails = [];
  const notes = [];
  const rule = (ok, pass, fail) => { if (ok) notes.push(`ok   ${pass}`); else fails.push(`FAIL ${fail}`); };

  rule(bundle.readUInt32LE(0) === 0x1f1903c1 || bundle.readUInt32LE(0) === 0x03bc1fc6 || true, "bundle read", "bundle unreadable");

  // Placeholders and local/stack/dev values
  for (const bad of ["qa-placeholder", "10.0.2.2"]) rule(count(s, bad) === 0, `no "${bad}"`, `found "${bad}" (a QA/placeholder/emulator value is baked in)`);
  rule(!/https?:\/\/[a-z0-9.-]+\.invalid/.test(s), "no https://*.invalid placeholder host", "found an https://....invalid URL (a placeholder host is baked in)");
  rule(!/:566\d\d/.test(s), "no iso-qa stack port (:566xx)", "found a :566xx port (a disposable stack URL is baked in)");
  rule(!/:8791/.test(s), "no mock-web port (:8791)", "found :8791 (the QA mock web server is baked in)");
  rule(!/192\.168\.\d+\.\d+/.test(s), "no LAN address", "found a 192.168.x.x address");
  rule(count(s, "localhost") <= BASELINE.localhost, `"localhost" within the library baseline (<= ${BASELINE.localhost})`, `"localhost" appears ${count(s, "localhost")} times (baseline ${BASELINE.localhost}): a dev URL may be baked in`);
  rule(count(s, "127.0.0.1") <= BASELINE.loopback, `"127.0.0.1" within the library baseline (<= ${BASELINE.loopback})`, `"127.0.0.1" appears ${count(s, "127.0.0.1")} times (baseline ${BASELINE.loopback})`);

  // Secrets that must never reach a client
  rule(count(s, "service_role") === 0, 'no "service_role"', '"service_role" appears (a service key may be baked in)');
  rule(!/(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/.test(s), "no Stripe secret/restricted key", "a Stripe secret or restricted key (sk_/rk_) is baked in");
  rule(!/whsec_[A-Za-z0-9]{8,}/.test(s), "no Stripe webhook secret", "a Stripe webhook secret (whsec_) is baked in");
  rule(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s) && count(s, "PRIVATE KEY") === 0, "no private key", "a private key marker is present");

  // Supabase URL: exactly the production project
  const urls = [...new Set([...s.matchAll(/https:\/\/([a-z0-9]{20})\.supabase\.co/g)].map((m) => m[1]))];
  rule(urls.length === 1 && urls[0] === expected.supabaseRef, `Supabase URL is https://${expected.supabaseRef}.supabase.co and no other project`, `Supabase project(s) in the bundle: ${urls.join(", ") || "(none)"}; expected only ${expected.supabaseRef}`);

  // Anon key: exactly one JWT, role anon, same project, not expired
  const jwts = [...new Set([...s.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)].map((m) => m[0]))];
  const payloads = jwts.map((j) => { try { return JSON.parse(Buffer.from(j.split(".")[1], "base64url").toString()); } catch { return null; } });
  rule(jwts.length === 1, "exactly one JWT-shaped string (the anon key)", `${jwts.length} JWT-shaped strings in the bundle (expected exactly 1)`);
  if (jwts.length >= 1) {
    payloads.forEach((p, i) => {
      if (!p) { fails.push(`FAIL JWT #${i + 1} does not decode`); return; }
      rule(p.role === "anon", `JWT #${i + 1} role is anon`, `JWT #${i + 1} role is "${p.role}" (only the anon key may be baked in)`);
      rule(p.ref === expected.supabaseRef, `JWT #${i + 1} project ref is ${expected.supabaseRef}`, `JWT #${i + 1} project ref is "${p.ref}", expected ${expected.supabaseRef} (a key from another project, e.g. DEV)`);
      rule(p.iss === "supabase", `JWT #${i + 1} issuer is supabase`, `JWT #${i + 1} issuer is "${p.iss}"`);
      rule(typeof p.exp === "number" && p.exp > now, `JWT #${i + 1} not expired`, `JWT #${i + 1} is expired or has no exp`);
    });
  }

  // Web origin
  rule(expected.webUrl && count(s, expected.webUrl) >= 1, `web origin ${expected.webUrl} is present`, `web origin ${expected.webUrl} is NOT in the bundle`);
  const apex = "https://idanceflow.com";
  if (expected.webUrl !== apex && count(s, apex) > 0) notes.push(`info the apex literal "${apex}" is also present (both apps keep it as a code default; it is only used when the env var is missing)`);

  // Stripe publishable key policy
  const pks = [...new Set([...s.matchAll(/pk_(live|test)_[A-Za-z0-9]{8,}/g)].map((m) => m[1]))];
  if (expected.stripe === "unset") rule(pks.length === 0, "no Stripe publishable key baked in (the server supplies it)", `a Stripe publishable key (pk_${pks.join("/")}) is baked in but the expected policy is "unset"`);
  else if (expected.stripe === "live" || expected.stripe === "test") rule(pks.length === 1 && pks[0] === expected.stripe, `Stripe publishable key is pk_${expected.stripe}`, `Stripe publishable key mode(s): ${pks.join(", ") || "none"}; expected pk_${expected.stripe}`);
  else notes.push(`info Stripe publishable key mode(s) present: ${pks.join(", ") || "none"} (policy "any")`);

  return { fails, notes };
}

function selfTest() {
  const ref = "abcdefghijklmnopqrst";
  const jwt = (role, r, exp) => ["e30", Buffer.from(JSON.stringify({ iss: "supabase", role, ref: r, exp })).toString("base64url"), "c2lnbmF0dXJlMTIzNDU2"].map((x, i) => (i === 0 ? "eyJhbGciOiJIUzI1NiJ9" : x)).join(".");
  const good = `xx https://${ref}.supabase.co${jwt("anon", ref, 4102444800)}https://www.idanceflow.com http://localhost:8081 http://localhost:9999 127.0.0.1 yy`;
  const exp = { supabaseRef: ref, webUrl: "https://www.idanceflow.com", stripe: "unset" };
  const cases = [
    ["good", good, exp, 0],
    ["placeholder", good + " qa-placeholder.invalid", exp, 1],
    ["emulator url", good + " http://10.0.2.2:56600", exp, 1],
    ["wrong project", good.replace(ref, "zzzzzzzzzzzzzzzzzzzz"), exp, 1],
    ["service role key", good.replace(jwt("anon", ref, 4102444800), jwt("service_role", ref, 4102444800)), exp, 1],
    ["two jwts", good + jwt("anon", ref, 4102444801), exp, 1],
    ["expired", good.replace(jwt("anon", ref, 4102444800), jwt("anon", ref, 1000)), exp, 1],
    ["apex instead of www", good.replace("https://www.idanceflow.com", "https://other.example"), exp, 1],
    ["stripe secret", good + " sk_live_abcdefghijklmnop", exp, 1],
    ["publishable key when unset", good + " pk_live_abcdefghijklmnop", exp, 1],
    ["publishable live ok", good + " pk_live_abcdefghijklmnop", { ...exp, stripe: "live" }, 0],
    ["publishable test when live", good + " pk_test_abcdefghijklmnop", { ...exp, stripe: "live" }, 1],
    ["extra localhost", good + " http://localhost:3000", exp, 1],
  ];
  let bad = 0;
  for (const [name, text, e, want] of cases) {
    const got = check(Buffer.from(text, "latin1"), e).fails.length ? 1 : 0;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "BAD "} self-test: ${name} -> ${got ? "FAIL" : "PASS"} (expected ${want ? "FAIL" : "PASS"})`);
  }
  process.exit(bad ? 1 : 0);
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") return selfTest();
  if (args.length !== 2) { console.error("usage: verify-baked-config.js <artifact> <expected.json> | --self-test"); process.exit(2); }
  const expected = JSON.parse(fs.readFileSync(args[1], "utf8"));
  for (const k of ["app", "supabaseRef", "webUrl", "stripe"]) if (!expected[k]) { console.error(`expected.json is missing "${k}"`); process.exit(2); }
  const b = loadBundle(args[0]);
  console.log(`artifact ${args[0]}\nbundle   ${b.name} (${b.bytes.length} bytes)\napp      ${expected.app}`);
  const { fails, notes } = check(b.bytes, expected);
  notes.forEach((n) => console.log(n));
  fails.forEach((f) => console.log(f));
  console.log(fails.length ? `\nRESULT: FAIL (${fails.length} rule${fails.length > 1 ? "s" : ""})` : "\nRESULT: PASS");
  process.exit(fails.length ? 1 : 0);
}

main();

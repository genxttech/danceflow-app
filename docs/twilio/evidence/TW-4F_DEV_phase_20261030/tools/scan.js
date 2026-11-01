// Sensitive-value scan for evidence and report files. Prints categories, counts and file names only; never prints a matched value except classified non-sensitive fixture ids.
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const roots = process.argv.slice(2);
const rules = [
  ["jwt", /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g],
  ["bearer-or-auth-header", /(authorization|bearer)\s*[:=]\s*\S{8,}/gi],
  ["stripe-key", /\b(sk|pk|rk|whsec)_(live|test)?_?[A-Za-z0-9]{10,}/g],
  ["supabase-new-key", /\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/g],
  ["twilio-sid", /\b(AC|SK|MG|PN|CA|SM|QU|BU|HX|KX)[0-9a-f]{32}\b/g],
  ["resend-key", /\bre_[A-Za-z0-9]{16,}/g],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["phone-e164", /(?<![0-9A-Za-z])\+[1-9][0-9]{9,14}\b/g],
  ["ipv4-nonloopback", /\b(?!127\.|0\.0\.0\.0)(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ["cookie-or-token-name", /\b(sb-[a-z0-9]+-auth-token|access_token|refresh_token|code_verifier|set-cookie)\b/gi],
  ["password-word-assignment", /\bpassword\s*[:=]\s*\S+/gi],
  ["long-hex-secret", /\b[0-9a-f]{40,}\b/g],
  ["base64-long", /\b[A-Za-z0-9+/]{60,}={0,2}\b/g],
];
const uuidRe = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const files = [];
(function walk(p) { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else files.push(f); } });
const stat = (p) => fs.statSync(p);
const addRoot = (r) => { if (stat(r).isDirectory()) { (function walk(p) { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else files.push(f); } })(r); } else files.push(r); };
roots.forEach(addRoot);
const res = {}; const uuids = {}; let scanned = 0;
for (const f of files) {
  let t; try { t = f.endsWith(".gz") ? zlib.gunzipSync(fs.readFileSync(f)).toString("utf8") : fs.readFileSync(f, "utf8"); } catch { continue; }
  scanned++;
  for (const [name, re] of rules) { const m = t.match(re); if (m && m.length) { (res[name] = res[name] || []).push(`${path.basename(f)}(${m.length})`); } }
  for (const u of new Set(t.match(uuidRe) || [])) uuids[u] = (uuids[u] || 0) + 1;
}
console.log("files scanned:", scanned);
for (const [n] of rules) console.log(`${n}: ${res[n] ? res[n].slice(0, 12).join(", ") + (res[n].length > 12 ? ` ...+${res[n].length - 12} files` : "") : "none"}`);
const ids = Object.keys(uuids); const fixture = ids.filter((u) => /^00000000-0000-0000-0000-/.test(u) || /^a1a10000-0000-4000-8000-/.test(u));
console.log(`uuids: ${ids.length} distinct; synthetic fixture pattern: ${fixture.length}; other: ${ids.length - fixture.length}`);
console.log("other uuid sample (first 6 chars only):", ids.filter((u) => !fixture.includes(u)).slice(0, 15).map((u) => u.slice(0, 6) + "…").join(" "));

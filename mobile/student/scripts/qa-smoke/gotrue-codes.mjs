// Captures what a REAL GoTrue (the disposable iso-qa stack, never hosted) answers for the failures the Student app maps to
// words, using the app's own client library (supabase-js, PKCE flow like src/lib/supabase.ts). Records only name, HTTP
// status and error code (never the message text) into a JSON fixture and a markdown table.
//
//   node scripts/iso-qa.mjs up main --name gtcodes --auth        (prints the keys)
//   node mobile/student/scripts/qa-smoke/gotrue-codes.mjs --kong 56600 --anon <key> --service <key> --out <dir>
//
// HTTP only: no emulator, no hosted database.
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const kong = opt("kong", "56600");
const anon = opt("anon");
const service = opt("service");
const out = opt("out", ".");
if (!anon || !service) throw new Error("--anon and --service keys are required");
const base = `http://127.0.0.1:${kong}`;
mkdirSync(out, { recursive: true });

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const client = () => createClient(base, anon, { auth: { storage: mem(), persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce" } });
const admin = { apikey: service, authorization: `Bearer ${service}`, "content-type": "application/json" };

const rows = [];
const record = (id, call, error, note = "") => {
  rows.push({ id, call, name: error?.name ?? null, status: typeof error?.status === "number" ? error.status : null, code: typeof error?.code === "string" ? error.code : null, ok: !error, note });
  const r = rows.at(-1);
  console.log(`${id.padEnd(28)} ${call.padEnd(26)} -> ${r.ok ? "no error" : `${r.name} status=${r.status} code=${r.code}`}`);
};

const stamp = Date.now();
const email = (tag) => `gt.${tag}.${stamp}@example.test`;
// A confirmed account first, like the smoke harness: generate_link for an unknown address would create an unconfirmed user and issue a "signup" token, which verifyOtp(magiclink) then refuses.
const makeUser = async (e) => {
  const r = await fetch(`${base}/auth/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ email: e, email_confirm: true }) });
  return (await r.json()).id;
};
const link = async (e) => {
  await makeUser(e);
  const r = await fetch(`${base}/auth/v1/admin/generate_link`, { method: "POST", headers: admin, body: JSON.stringify({ type: "magiclink", email: e }) });
  const b = await r.json();
  return b.hashed_token || b.properties?.hashed_token;
};

// 1. A link used once, then used again (verifyOtp).
{
  const e = email("used");
  const hashed = await link(e);
  const first = await client().auth.verifyOtp({ token_hash: hashed, type: "magiclink" });
  record("verify-first-use", "auth.verifyOtp", first.error, "control: a fresh link must succeed");
  const second = await client().auth.verifyOtp({ token_hash: hashed, type: "magiclink" });
  record("verify-used-link", "auth.verifyOtp", second.error);
}
// 2. A token that never existed.
record("verify-unknown-token", "auth.verifyOtp", (await client().auth.verifyOtp({ token_hash: "0".repeat(64), type: "magiclink" })).error);
// 3. A malformed token (empty).
record("verify-empty-token", "auth.verifyOtp", (await client().auth.verifyOtp({ token_hash: "", type: "magiclink" })).error);
// 4. An unsupported type.
record("verify-bad-type", "auth.verifyOtp", (await client().auth.verifyOtp({ token_hash: "0".repeat(64), type: "bogus" })).error);
// 5. Invalid PKCE code exchange.
// (a) no code verifier stored on this device (a link opened on another device or after a reinstall): answered by the client library itself.
record("exchange-no-verifier", "auth.exchangeCodeForSession", (await client().auth.exchangeCodeForSession("00000000-0000-4000-8000-000000000000")).error, "client-side, never reaches GoTrue");
// (b) a verifier IS stored (signInWithOtp saved it) but the code is not a real flow: answered by GoTrue.
{
  const c = client();
  await c.auth.signInWithOtp({ email: email("exch"), options: { shouldCreateUser: true } });
  record("exchange-invalid-code", "auth.exchangeCodeForSession", (await c.auth.exchangeCodeForSession("00000000-0000-4000-8000-000000000000")).error, "verifier stored, code unknown");
}
// 6. Bad-format email on the send path.
for (const [tag, value] of [["no-at", "not-an-email"], ["empty", ""], ["spaces", "a b@example.test"], ["no-domain", "dana@"]]) {
  record(`send-bad-email-${tag}`, "auth.signInWithOtp", (await client().auth.signInWithOtp({ email: value, options: { shouldCreateUser: true } })).error);
}
// 7. Non-existent user with account creation off (the app uses shouldCreateUser: true; this is the contrast case).
record("send-no-user-create-off", "auth.signInWithOtp", (await client().auth.signInWithOtp({ email: email("nouser"), options: { shouldCreateUser: false } })).error);
// 8. Password reset for an address with no account.
record("reset-no-user", "auth.resetPasswordForEmail", (await client().auth.resetPasswordForEmail(email("noreset"))).error);
// 9. A deleted user's link.
{
  const e = email("deleted");
  const hashed = await link(e);
  const found = await (await fetch(`${base}/auth/v1/admin/users?per_page=200`, { headers: admin })).json();
  const user = (found.users ?? []).find((u) => u.email === e);
  if (user) await fetch(`${base}/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers: admin });
  record("verify-deleted-user-link", "auth.verifyOtp", (await client().auth.verifyOtp({ token_hash: hashed, type: "magiclink" })).error, user ? "user deleted before verify" : "user not found to delete");
}
// 10. Send-rate limits: the same address repeatedly, then many addresses (disposable stack only).
{
  const e = email("rate");
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const r = await client().auth.signInWithOtp({ email: e, options: { shouldCreateUser: true } });
    seen.push(r.error ? `${r.error.status}/${r.error.code}` : "ok");
    if (r.error) record(`send-repeat-${i + 1}`, "auth.signInWithOtp", r.error, "same address");
  }
  console.log("same address sequence:", seen.join(" "));
  const many = [];
  for (let i = 0; i < 40; i++) {
    const r = await client().auth.signInWithOtp({ email: email(`flood${i}`), options: { shouldCreateUser: true } });
    many.push(r.error ? `${r.error.status}/${r.error.code}` : "ok");
    if (r.error) { record(`send-flood-${i + 1}`, "auth.signInWithOtp", r.error, "different addresses"); break; }
  }
  console.log("many addresses sequence:", many.join(" "));
}

writeFileSync(join(out, "gotrue-codes.json"), JSON.stringify({ capturedAt: new Date().toISOString(), client: "supabase-js (flowType pkce)", rows }, null, 2));
const md = ["| case | call | error class | HTTP status | error code |", "|---|---|---|---|---|", ...rows.map((r) => `| ${r.id} | ${r.call} | ${r.name ?? "(none)"} | ${r.status ?? ""} | ${r.code ?? ""} |`)].join("\n");
writeFileSync(join(out, "gotrue-codes.md"), `${md}\n`);
console.log(`\nwrote ${rows.length} rows to ${out}`);

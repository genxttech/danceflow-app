#!/usr/bin/env node
// Proves an iso-qa --auth stack end to end, with no app code: password sign-in, a magic link delivered to Mailpit and redeemed, the resulting JWT accepted
// by PostgREST as that user (auth.uid()), and sign-out revoking the session. Exit 0 = every check passed.
//   node scripts/qa/iso-qa.mjs up baseline --auth --name <n> > stack.json
//   node scripts/qa/auth-profile/auth-smoke.mjs stack.json
import { randomUUID } from "node:crypto";
import { createUser, latestAuthLink, loadStack, psql } from "./lib.mjs";

const env = loadStack(process.argv[2]);
const results = [];
const check = (name, ok, detail = {}) => {
  results.push({ name, ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};

const email = `smoke-${randomUUID().slice(0, 8)}@example.test`;
const password = `qa-${randomUUID()}`;
const userId = await createUser(env, { email, password, fullName: "Smoke Test" });
check("admin user created", Boolean(userId));

const headers = { apikey: env.ISO_QA_ANON_KEY, "Content-Type": "application/json" };
const pw = await fetch(`${env.ISO_QA_AUTH_URL}/token?grant_type=password`, { method: "POST", headers, body: JSON.stringify({ email, password }) });
const session = await pw.json();
check("password grant", pw.status === 200 && Boolean(session.access_token), { status: pw.status });

// the JWT GoTrue issued is the one PostgREST and auth.uid() trust
// a throwaway probe function, in this disposable database only
psql(env, "create or replace function public.iso_qa_smoke_uid() returns uuid language sql stable as $$ select auth.uid() $$; grant execute on function public.iso_qa_smoke_uid() to authenticated; notify pgrst, 'reload schema';");
let uid2;
let resolved = null;
// PostgREST picks the new function up when its schema cache reloads; give it up to 30 s
for (let i = 0; i < 30; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  uid2 = await fetch(`${env.TW4A_LOCAL_URL}/rest/v1/rpc/iso_qa_smoke_uid`, { method: "POST", headers: { apikey: env.ISO_QA_ANON_KEY, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, body: "{}" });
  resolved = await uid2.json().catch(() => null);
  if (uid2.status !== 404) break;
  if (i === 5) psql(env, "notify pgrst, 'reload schema';");
}
check("PostgREST resolves auth.uid() from the GoTrue JWT", resolved === userId, { status: uid2.status });

const sentAt = Date.now() - 2000;
const otp = await fetch(`${env.ISO_QA_AUTH_URL}/otp?redirect_to=${encodeURIComponent("http://localhost:8790/")}`, { method: "POST", headers, body: JSON.stringify({ email, create_user: false }) });
check("magic link requested", otp.status === 200, { status: otp.status });
const mail = await latestAuthLink(env, email, sentAt);
check("magic link delivered to Mailpit", Boolean(mail.link), { subject: mail.subject });
const verify = await fetch(mail.link, { redirect: "manual" });
const location = verify.headers.get("location") ?? "";
const fragment = new URLSearchParams(location.split("#")[1] ?? "");
check("magic link redeemed (implicit flow)", verify.status === 303 && location.startsWith("http://localhost:8790/") && Boolean(fragment.get("access_token")), { status: verify.status });

const user = await fetch(`${env.ISO_QA_AUTH_URL}/user`, { headers: { apikey: env.ISO_QA_ANON_KEY, Authorization: `Bearer ${fragment.get("access_token")}` } });
const userBody = await user.json();
check("magic-link session is the same user", user.status === 200 && userBody.id === userId);

const out = await fetch(`${env.ISO_QA_AUTH_URL}/logout?scope=global`, { method: "POST", headers: { apikey: env.ISO_QA_ANON_KEY, Authorization: `Bearer ${session.access_token}` } });
check("sign out everywhere", out.status === 204, { status: out.status });
const after = await fetch(`${env.ISO_QA_AUTH_URL}/user`, { headers: { apikey: env.ISO_QA_ANON_KEY, Authorization: `Bearer ${session.access_token}` } });
check("revoked session is refused by GoTrue", after.status === 401 || after.status === 403, { status: after.status });

const cors = await fetch(`${env.ISO_QA_AUTH_URL}/health`, { method: "OPTIONS", headers: { Origin: "http://localhost:8790", "Access-Control-Request-Method": "POST" } });
check("browser CORS preflight through Kong", Boolean(cors.headers.get("access-control-allow-origin")), { status: cors.status });

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

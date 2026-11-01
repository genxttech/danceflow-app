// D4-2 REAL-BROWSER WebAuthn run (local only). Chromium (Playwright) with a CDP VIRTUAL authenticator (ctap2 / internal, user verifying) drives the same navigator.credentials
// calls as PriceAuthorize.tsx / PriceCredentials.tsx against the REAL in-database verifier of migration 20270204100000, through a tiny local HTTP bridge that plays the part of
// PostgREST (it sets the verified-claims JSON for a registered administrator and calls the public tw4_price_* functions; it is NOT the Next.js app and NOT GoTrue).
// Owner-level steps a hosted deployment does by runbook (the bootstrap of the first key, and moving the test DATABASE clock past a delay) are explicit /owner calls.
// LOCAL DISPOSABLE DOCKER DATABASE ONLY: pass --container <name> of a database with the chain applied (50 main migrations + 20270204090000 + 20270204100000).
// No hosted service, no provider secret, no real credential is involved.
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const CONTAINER = opt("container");
const PORT = Number(opt("port", "5871"));
if (!CONTAINER) { console.error("usage: node scripts/qa/tw4f/browser/webauthn-e2e.mjs --container <db container> [--port 5871]"); process.exit(2); }
const ORIGIN = `http://localhost:${PORT}`;
const A = "d4be0000-0000-4000-8000-0000000000a1", B = "d4be0000-0000-4000-8000-0000000000b2";

function sql(text) {
  const r = spawnSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], { input: text, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const nowS = () => Math.floor(Date.now() / 1000);
const claims = (sub, sid) => ({ sub, role: "authenticated", aal: "aal2", exp: nowS() + 3600, amr: [{ method: "totp", timestamp: nowS() - 30 }], session_id: sid });
const lit = (v) => (v === null || v === undefined ? "null" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const hex = (b64u) => Buffer.from(b64u, "base64url").toString("hex");
const ALLOWED = new Set(["tw4_price_propose", "tw4_price_authz_begin", "tw4_price_authz_finish", "tw4_price_cred_begin", "tw4_price_cred_enroll", "tw4_price_cred_revoke", "tw4_price_cred_apply", "tw4_price_cred_cancel",
  "tw4_price_cred_pending", "tw4_price_thaw", "tw4_price_freeze", "tw4_price_recovery_enroll", "tw4_price_recovery_freeze"]);

function rpc({ user, sid, fn, args: a }) {
  if (!ALLOWED.has(fn)) return { error: "function not allowed in the harness" };
  const c = JSON.stringify(claims(user, sid)).replace(/'/g, "''");
  const r = sql(`begin; set local role authenticated; select set_config('request.jwt.claims', '${c}', true); select public.${fn}(${a.map(lit).join(", ")})::text; commit;`);
  if (r.code !== 0) return { error: r.err.split("\n").find((l) => l.startsWith("ERROR")) ?? r.err.slice(0, 300) };
  try { return { data: JSON.parse(r.out.split("\n").pop()) }; } catch { return { error: "unparseable: " + r.out.slice(0, 200) }; }
}
const OWNER = {
  seed() {
    return sql(`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at, last_sign_in_at) values
      ('${A}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@be.test',now(),now(),now(),now()),
      ('${B}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','b@be.test',now(),now(),now(),now()) on conflict do nothing;
      insert into public.profiles (id, platform_role) values ('${A}','platform_admin'),('${B}','platform_admin') on conflict (id) do update set platform_role='platform_admin';
      insert into public.studio_sms_price_approvers (user_id, added_note) values ('${A}','owner registered for the browser run'),('${B}','second administrator for the browser run') on conflict do nothing;`);
  },
  bootstrap({ id, x, y }) {
    return sql(`select public._tw4price_bootstrap('localhost', array['${ORIGIN}'], decode('${hex(id)}','hex'), decode('${hex(x)}','hex'), decode('${hex(y)}','hex'), 'browser primary key')`);
  },
  // the DATABASE clock stands in for waiting: only the test database's timestamps move
  ageRequest({ id, hours }) {
    return sql(`begin; alter table public.studio_sms_price_change_requests disable trigger studio_sms_price_change_requests_guard;
      update public.studio_sms_price_change_requests set requested_at = requested_at - interval '${hours} hours', cooling_until = cooling_until - interval '${hours} hours', expires_at = expires_at - interval '${hours} hours' where id = '${id}';
      alter table public.studio_sms_price_change_requests enable always trigger studio_sms_price_change_requests_guard; commit;`);
  },
  ageChange({ id, hours }) {
    return sql(`begin; alter table public.studio_sms_price_credential_changes disable trigger studio_sms_price_credential_changes_guard;
      update public.studio_sms_price_credential_changes set requested_at = requested_at - interval '${hours} hours', effective_at = effective_at - interval '${hours} hours' where id = '${id}';
      alter table public.studio_sms_price_credential_changes enable always trigger studio_sms_price_credential_changes_guard; commit;`);
  },
  query({ q }) { return sql(q); },
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>d42 browser harness</title><body><script>
// the WebAuthn calls below are transcribed from PriceCredentials.tsx / PriceAuthorize.tsx
const b64uToBuf = (s) => { const pad = "=".repeat((4 - (s.length % 4)) % 4); const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out.buffer; };
const bufToB64u = (b) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b); let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); };
window.h = {
  async create(label) {
    const created = await navigator.credentials.create({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: "DanceFlow", id: "localhost" }, user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { userVerification: "required", residentKey: "discouraged" }, attestation: "none" } });
    const spki = created.response.getPublicKey();
    const raw = new Uint8Array(spki).slice(-65);
    return { id: bufToB64u(created.rawId), x: bufToB64u(raw.slice(1, 33)), y: bufToB64u(raw.slice(33, 65)) };
  },
  async sign(challenge, allow) {
    const cred = await navigator.credentials.get({ publicKey: { challenge: b64uToBuf(challenge), rpId: "localhost", allowCredentials: allow.map((id) => ({ type: "public-key", id: b64uToBuf(id) })), userVerification: "required", timeout: 60000 } });
    const r = cred.response;
    return { credId: bufToB64u(cred.rawId), auth: bufToB64u(r.authenticatorData), client: bufToB64u(r.clientDataJSON), sig: bufToB64u(r.signature) };
  },
  async rpc(body) { return (await fetch("/rpc", { method: "POST", body: JSON.stringify(body) })).json(); },
  async owner(op, body) { return (await fetch("/owner/" + op, { method: "POST", body: JSON.stringify(body ?? {}) })).json(); },
};
</script></body>`;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.setHeader("content-type", req.url === "/" ? "text/html" : "application/json");
    if (req.url === "/") return res.end(PAGE);
    const j = body ? JSON.parse(body) : {};
    if (req.url === "/rpc") return res.end(JSON.stringify(rpc(j)));
    if (req.url?.startsWith("/owner/")) { const r = OWNER[req.url.slice(7)]?.(j); return res.end(JSON.stringify(r ?? { error: "no such op" })); }
    res.statusCode = 404; res.end("{}");
  });
});

const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true });
let exit = 0;
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(ORIGIN + "/");
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const H = {
    create: (l) => page.evaluate((x) => window.h.create(x), l),
    sign: (c, allow) => page.evaluate(([x, y]) => window.h.sign(x, y), [c, allow]),
    rpc: (user, sid, fn, a) => page.evaluate((b) => window.h.rpc(b), { user, sid, fn, args: a }),
    owner: (op, b) => page.evaluate(([o, x]) => window.h.owner(o, x), [op, b ?? {}]),
  };
  const S1 = "browser-session-1", S2 = "browser-session-2";
  const q = async (text) => (await H.owner("query", { q: text })).out;

  check("owner seed (two registered administrators)", (await H.owner("seed")).code === 0);
  // 1. enroll the PRIMARY: the browser creates the key; the owner-level bootstrap registers it (runbook step)
  const primary = await H.create("primary");
  check("primary key created by the browser authenticator", primary.id && primary.x && primary.y);
  check("owner bootstrap registers the primary", (await H.owner("bootstrap", primary)).code === 0);

  // helper: a full enrolment ceremony (existing key signs, the new key proves possession)
  const enrol = async (signer, label, role) => {
    const nk = await H.create(label);
    const b = await H.rpc(A, S2, "tw4_price_cred_begin", ["enroll", nk.id, nk.x, nk.y, role, label]);
    if (b.error) return { error: b.error };
    const by = await H.sign(b.data.challenge, [signer]);
    const mine = await H.sign(b.data.challenge, [nk.id]);
    const e = await H.rpc(A, S2, "tw4_price_cred_enroll", [b.data.nonce, nk.id, nk.x, nk.y, role, label, by.credId, by.auth, by.client, by.sig, mine.auth, mine.client, mine.sig]);
    return { nk, e };
  };
  const spare = await enrol(primary.id, "browser spare", "spare");
  check("spare enrolment is PENDING (delay), not active", spare.e?.data?.status === "pending" && (await q("select count(*) from public.studio_sms_price_credentials where status='active'")) === "1", JSON.stringify(spare.e?.data ?? spare));
  check("apply before the delay is refused", (await H.rpc(A, S2, "tw4_price_cred_apply", [spare.e.data.change_id])).error?.includes("TW045"));
  await H.owner("ageChange", { id: spare.e.data.change_id, hours: 25 });
  check("spare applied after the (database-clock) delay", (await H.rpc(A, S2, "tw4_price_cred_apply", [spare.e.data.change_id])).data?.status === "applied");
  const recovery = await enrol(primary.id, "browser recovery", "recovery");
  await H.owner("ageChange", { id: recovery.e.data.change_id, hours: 25 });
  check("recovery key enrolled (third credential)", (await H.rpc(A, S2, "tw4_price_cred_apply", [recovery.e.data.change_id])).data?.status === "applied" && (await q("select count(*) from public.studio_sms_price_credentials where status='active'")) === "3");

  // 2. propose in session 1, wait through the cooling-off by moving the DATABASE clock, authorize in session 2
  const prop = await H.rpc(A, S1, "tw4_price_propose", ["number", 377, 115, "browser price", "a written reason for the browser run"]);
  check("propose (aal2, session 1)", prop.data?.request_id, JSON.stringify(prop.error ?? ""));
  const early = await H.rpc(A, S2, "tw4_price_authz_begin", [prop.data.request_id]);
  check("no challenge inside the cooling-off", early.data?.status === "refused");
  await H.owner("ageRequest", { id: prop.data.request_id, hours: 25 });
  check("the proposing session cannot authorize", (await H.rpc(A, S1, "tw4_price_authz_begin", [prop.data.request_id])).data?.status === "refused");
  const beg = await H.rpc(A, S2, "tw4_price_authz_begin", [prop.data.request_id]);
  check("challenge in session 2 lists primary and spare, not the recovery key", beg.data?.allow_credentials?.length === 2 && !beg.data.allow_credentials.includes(recovery.nk.id));
  const wrong = await H.sign(beg.data.challenge, [recovery.nk.id]);
  const wf = await H.rpc(A, S2, "tw4_price_authz_finish", [prop.data.request_id, beg.data.nonce, wrong.credId, wrong.auth, wrong.client, wrong.sig]);
  check("the RECOVERY key's real assertion cannot authorize a price", wf.data?.status === "rejected", wf.data?.reason);
  const sig = await H.sign(beg.data.challenge, [primary.id]);
  const fin = await H.rpc(A, S2, "tw4_price_authz_finish", [prop.data.request_id, beg.data.nonce, sig.credId, sig.auth, sig.client, sig.sig]);
  check("authorize with the primary: price published", fin.data?.status === "applied" && (await q("select customer_price_cents from public.studio_sms_price_list where kind='number' and active")) === "377", JSON.stringify(fin.data ?? fin.error));
  const rep = await H.rpc(A, S2, "tw4_price_authz_finish", [prop.data.request_id, beg.data.nonce, sig.credId, sig.auth, sig.client, sig.sig]);
  check("REPLAY of the same assertion publishes nothing", rep.data?.status === "refused" || rep.data?.status === "rejected" || !!rep.error, JSON.stringify(rep.data ?? rep.error).slice(0, 120));
  check("exactly one price row for the proposal", (await q("select count(*) from public.studio_sms_price_list where kind='number' and customer_price_cents=377")) === "1");

  // 3. freeze / thaw
  check("freeze by a registered session", (await H.rpc(B, "browser-b", "tw4_price_freeze", ["browser freeze test, owner suspects trouble"])).data?.status === "frozen");
  const p2 = await H.rpc(A, S1, "tw4_price_propose", ["number", 388, 115, "while frozen", "a written reason while frozen, refused"]);
  check("propose while frozen is refused", !!p2.error);
  const tb = await H.rpc(A, S2, "tw4_price_cred_begin", ["thaw", null, null, null, null, null]);
  const ts = await H.sign(tb.data.challenge, tb.data.allow_credentials);
  check("thaw with the hardware key", (await H.rpc(A, S2, "tw4_price_thaw", [tb.data.nonce, ts.credId, ts.auth, ts.client, ts.sig])).data?.status === "thawed");

  // 4. recovery freeze with the recovery key
  const fb = await H.rpc(A, S2, "tw4_price_cred_begin", ["recover_freeze", null, null, null, null, null]);
  const fs = await H.sign(fb.data.challenge, fb.data.allow_credentials);
  check("freeze with the RECOVERY key", (await H.rpc(A, S2, "tw4_price_recovery_freeze", [fb.data.nonce, fs.credId, fs.auth, fs.client, fs.sig])).data?.status === "frozen");
  const tb2 = await H.rpc(A, S2, "tw4_price_cred_begin", ["thaw", null, null, null, null, null]);
  check("the recovery key is not offered for the thaw", !tb2.data.allow_credentials.includes(recovery.nk.id));
  const ts2 = await H.sign(tb2.data.challenge, [primary.id]);
  check("thaw again with the primary", (await H.rpc(A, S2, "tw4_price_thaw", [tb2.data.nonce, ts2.credId, ts2.auth, ts2.client, ts2.sig])).data?.status === "thawed");

  // 5. IMMEDIATE revocation of the spare by the primary; the spare's real assertion is dead at once
  const rb = await H.rpc(A, S2, "tw4_price_cred_begin", ["revoke", spare.nk.id, null, null, null, null]);
  const rs = await H.sign(rb.data.challenge, rb.data.allow_credentials);
  const rv = await H.rpc(A, S2, "tw4_price_cred_revoke", [rb.data.nonce, spare.nk.id, rs.credId, rs.auth, rs.client, rs.sig]);
  check("revocation is immediate and final (no pending state)", rv.data?.status === "revoked" && (await q("select status from public.studio_sms_price_credentials where credential_id=decode('" + hex(spare.nk.id) + "','hex')")) === "revoked");
  const p3 = await H.rpc(A, S1, "tw4_price_propose", ["number", 399, 115, "after revoke", "a written reason after the revocation"]);
  await H.owner("ageRequest", { id: p3.data.request_id, hours: 25 });
  const b3 = await H.rpc(A, S2, "tw4_price_authz_begin", [p3.data.request_id]);
  check("revoked key no longer offered", !b3.data.allow_credentials.includes(spare.nk.id));
  const dead = await H.sign(b3.data.challenge, [spare.nk.id]);
  const df = await H.rpc(A, S2, "tw4_price_authz_finish", [p3.data.request_id, b3.data.nonce, dead.credId, dead.auth, dead.client, dead.sig]);
  check("the revoked key's real assertion is rejected", df.data?.status === "rejected", df.data?.reason);

  // 6. RECOVERY: the recovery key starts a re-enrolment of a new primary (long delay), the old primary can cancel it, then it completes
  const nk = await H.create("recovered primary");
  const rcb = await H.rpc(A, S2, "tw4_price_cred_begin", ["recover_enroll", nk.id, nk.x, nk.y, null, "recovered primary"]);
  const rcs = await H.sign(rcb.data.challenge, [recovery.nk.id]);
  const rcm = await H.sign(rcb.data.challenge, [nk.id]);
  const rre = await H.rpc(A, S2, "tw4_price_recovery_enroll", [rcb.data.nonce, nk.id, nk.x, nk.y, "recovered primary", rcs.credId, rcs.auth, rcs.client, rcs.sig, rcm.auth, rcm.client, rcm.sig]);
  check("recovery enrolment is pending for the long delay", rre.data?.status === "pending" && rre.data.effective_in_hours >= 72, JSON.stringify(rre.data ?? rre.error));
  check("apply before the recovery delay is refused", (await H.rpc(A, S2, "tw4_price_cred_apply", [rre.data.change_id])).error?.includes("TW045"));
  const cb = await H.rpc(A, S2, "tw4_price_cred_begin", ["cancel", null, null, null, null, rre.data.change_id]);
  const cs = await H.sign(cb.data.challenge, cb.data.allow_credentials);
  check("the primary cancels the recovery enrolment (the recovery key alone is not enough)", (await H.rpc(A, S2, "tw4_price_cred_cancel", [rre.data.change_id, cb.data.nonce, cs.credId, cs.auth, cs.client, cs.sig])).data?.status === "cancelled");
  const rcb2 = await H.rpc(A, S2, "tw4_price_cred_begin", ["recover_enroll", nk.id, nk.x, nk.y, null, "recovered primary"]);
  const rcs2 = await H.sign(rcb2.data.challenge, [recovery.nk.id]);
  const rcm2 = await H.sign(rcb2.data.challenge, [nk.id]);
  const rre2 = await H.rpc(A, S2, "tw4_price_recovery_enroll", [rcb2.data.nonce, nk.id, nk.x, nk.y, "recovered primary", rcs2.credId, rcs2.auth, rcs2.client, rcs2.sig, rcm2.auth, rcm2.client, rcm2.sig]);
  await H.owner("ageChange", { id: rre2.data.change_id, hours: 200 });
  check("recovery completes after the delay and replaces the whole set", (await H.rpc(A, S2, "tw4_price_cred_apply", [rre2.data.change_id])).data?.status === "applied" && (await q("select string_agg(role || ':' || enrolled_via, ',') from public.studio_sms_price_credentials where status='active'")) === "primary:recovery");
  // the recovered primary authorizes a price in a fresh pair of sessions
  const p4 = await H.rpc(A, S1, "tw4_price_propose", ["number", 411, 115, "after recovery", "a written reason after the recovery"]);
  await H.owner("ageRequest", { id: p4.data.request_id, hours: 25 });
  const b4 = await H.rpc(A, S2, "tw4_price_authz_begin", [p4.data.request_id]);
  const s4 = await H.sign(b4.data.challenge, [nk.id]);
  check("the recovered primary authorizes a price", (await H.rpc(A, S2, "tw4_price_authz_finish", [p4.data.request_id, b4.data.nonce, s4.credId, s4.auth, s4.client, s4.sig])).data?.status === "applied");
  check("the old primary is dead after recovery", (await q("select count(*) from public.studio_sms_price_credentials where status='revoked'")) === "3");
  check("the audit holds the recovery events", Number(await q("select count(*) from public.studio_sms_price_audit where event='recovery_used'")) >= 3);
} catch (e) {
  console.error("HARNESS ERROR", e);
  exit = 1;
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(exit || (failed ? 1 : 0));

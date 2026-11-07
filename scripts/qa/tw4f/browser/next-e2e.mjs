// D4-2 REAL Next.js browser acceptance of the single-owner pricing authorization (LOCAL DISPOSABLE STACK ONLY).
//   Real Chromium (Playwright) -> the REAL Next.js app (next build + next start, server actions) -> real local GoTrue + Kong + PostgREST -> Postgres with the repo migration chain.
//   WebAuthn: CDP virtual authenticators (real navigator.credentials.create/get, RP ID localhost, origin http://localhost:<port>). Login and the TOTP step-up go through the real pages.
//   Nothing hosted, no provider call, no real credential. Containers are labelled df.d4nxe=1 (df-nxe-*); `down` removes only those.
//
//   node scripts/qa/tw4f/browser/next-e2e.mjs all                 # up + build + start + run + report + down
//   node scripts/qa/tw4f/browser/next-e2e.mjs up|build|start|run|down  [--port 3417] [--dev] [--skip-build] [--keep] [--scenarios 1,2,3] [--no-monitor] [--out <dir>]
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
import * as L from "./next-e2e-lib.mjs";
import * as B from "./next-e2e-browser.mjs";
const { check, blocked, scn, q, sleep } = B;

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "all";
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const flag = (n) => argv.includes(`--${n}`);
const PORT = Number(opt("port", "3417"));
const ONLY = opt("scenarios", "") ? new Set(opt("scenarios", "").split(",")) : null;
const TAG = opt("tag", "");
const OUT = opt("out", path.join(L.REPO, "scripts", "qa", "tw4f", "results", "d4-1"));
const want = (id) => !ONLY || ONLY.has(String(id));
const SHORT = "x".repeat(0);

function die(m, c = 1) { console.error(m); process.exit(c); }

// ================================================================================================ lifecycle
async function doUp() {
  const t = Date.now();
  const s = await L.stackUp({ appPort: PORT, monitor: !flag("no-monitor"), reuse: flag("reuse") });
  console.log(`stack up in ${Math.round((Date.now() - t) / 1000)}s: ${s.url} (${s.applied.length} migrations, last ${s.applied.at(-1)})`);
  return s;
}
function doBuild(s) {
  if (flag("dev") || flag("skip-build")) return true;
  const t = Date.now();
  const ok = L.buildApp(s, { log: path.join(L.HOME, "build.log") });
  console.log(`next build ${ok ? "ok" : "FAILED"} in ${Math.round((Date.now() - t) / 1000)}s (log ${path.join(L.HOME, "build.log")})`);
  return ok;
}
async function doStart(s) {
  L.startApp(s, { log: path.join(L.HOME, "app.log"), dev: flag("dev") });
  await L.waitApp(s);
  console.log(`app up at ${s.appOrigin} (pid ${s.appPid}, ${flag("dev") ? "next dev" : "next start"})`);
}
function doDown() {
  const s = L.loadState();
  if (s) L.stopApp(s);
  L.removeAll();
  if (!flag("keep-snapshot")) L.removeSnapshot();
  console.log("down: df-nxe-* containers, network and snapshot image removed, app stopped");
}

// ================================================================================================ the run
const ctx = { rec: "recovery one", prim: "primary", state: null, A: null, secret: null, s1: null, s2: null, browser: null, sessions: () => B.SESSIONS };

async function setup(browser) {
  scn("0 setup");
  const s = ctx.state;
  const pw = `${randomBytes(18).toString("base64url")}Aa1!`;
  ctx.A = await B.createUser(s, "admin", pw);
  ctx.N = await B.createUser(s, "plain", pw);
  q(`insert into public.profiles (id, email, platform_role) values ('${ctx.A.id}', '${ctx.A.email}', 'platform_admin'), ('${ctx.N.id}', '${ctx.N.email}', null) on conflict (id) do update set platform_role = excluded.platform_role, email = excluded.email;
     insert into public.studio_sms_price_approvers (user_id, added_note) values ('${ctx.A.id}', 'synthetic owner for the Next.js browser run') on conflict do nothing;`);
  ctx.secret = await B.enrollTotp(s, ctx.A);
  ctx.s1 = await B.newSession(browser, s, "s1");
  ctx.s2 = await B.newSession(browser, s, "s2");
  check("login + TOTP challenge through the real pages (session 1)", await B.login(ctx.s1, ctx.A, ctx.secret), ctx.s1.page.url());
  await sleep(1500);
  check("login + TOTP challenge through the real pages (session 2, separate session)", await B.login(ctx.s2, ctx.A, ctx.secret), ctx.s2.page.url());
  const sess = B.sessionIds(ctx.A.id);
  check("two distinct GoTrue sessions exist", sess.length >= 2 && new Set(sess).size === sess.length, `${sess.length} sessions`);
  check("config defaults: single_owner, 24 h cooling-off, backup-eligible refused, monitoring not expected", B.cfg("mode || '/' || cooling_off_hours || '/' || allow_backup_eligible || '/' || monitoring_expected") === "single_owner/24/false/false", B.cfg("mode"));
  check("the keys panel is rendered by the Next page (no credentials yet)", (await (async () => { await B.openSms(ctx.s1); return ctx.s1.page.getByText("Hardware keys", { exact: true }).first().isVisible(); })()));
}

async function enrolAndApply(S, label, role, signerNames) {
  await B.only(S, signerNames);
  await B.openSms(S);
  const m1 = await B.requestKey(S, label, role);
  await B.adopt(S, label);
  const pending = Number(q(`select count(*) from public.studio_sms_price_credential_changes where status = 'pending' and label = ${B.lit(label)}`));
  await B.openSms(S);
  const early = await B.applyPending(S, label);
  const stillPending = B.keyStatus(label) !== "active";
  B.ageChanges(25);
  await B.openSms(S);
  const m2 = await B.applyPending(S, label);
  return { m1, m2, early, stillPending, pending, status: B.keyStatus(label) };
}

async function sc1() {
  scn(1);
  const S = ctx.s1;
  // 1a. first primary: the UI has no path for it (an existing key must sign); the real browser creates the key, the owner runbook step registers it
  await B.only(S, []);
  await B.openSms(S);
  const m0 = await B.requestKey(S, "first primary", "primary");
  check("UI before any key exists: enrol is refused with a clear sentence and creates nothing", /not allowed|refused|Nothing changed|not available/i.test(m0) && B.countActive() === 0, m0);
  await B.discardUnnamed(S);
  const created = await B.createKey(S, "primary");
  const rk = await B.createKey(S, "recovery one");
  const hx = (k) => `decode('${B.hexOf(k.id)}','hex'), decode('${B.hexOf(k.x)}','hex'), decode('${B.hexOf(k.y)}','hex')`;
  const r = L.psql(`select public._tw4price_bootstrap_with_recovery('localhost', array['${ctx.state.appOrigin}'], ${hx(created)}, 'primary', ${hx(rk)}, 'recovery one')`);
  ctx.rec = "recovery one";
  ctx.prim = "primary";
  check("owner bootstrap installs primary + recovery in one transaction (RP localhost, origin of the Next host)", r.code === 0 && B.countActive() === 2 && B.keyStatus("recovery one") === "active", r.err.slice(0, 120));
  await B.only(S, ["primary"]);
  await B.openSms(S);
  const opts = await S.page.locator('section[aria-label="Hardware keys for price authorization"] select option').allInnerTexts();
  check("the panel's role list offers no 'recovery' (a recovery key is never enrolled through the UI)", opts.length >= 1 && !opts.some((o) => /recovery/i.test(o)), opts.join(","));
  blocked("first primary enrolment THROUGH THE UI", "by design there is no UI path: Request a new key needs an existing key to sign (priceCredBegin/priceCredEnroll); the first key is the owner runbook bootstrap (_tw4price_bootstrap). Verified above that the UI refuses cleanly with no key.");

  // 1b. spare + recovery through the UI with the database-clock delay
  const sp = await enrolAndApply(S, "spare one", "spare", ["primary"]);
  check("spare request via UI is PENDING (not active)", sp.pending === 1 && /Requested/.test(sp.m1), sp.m1);
  check("Apply before the delay is refused with a clear sentence and the key stays pending", /not ended|cooling|Nothing changed|not allowed/i.test(sp.early) && sp.stillPending, sp.early);
  check("spare applied through the UI after the aged database clock", B.keyStatus("spare one") === "active" && /applied/.test(sp.m2), sp.m2);
  // a bootstrapped key has no proof yet: it does not count as the verified replacement the last-credential rule needs
  await B.only(S, ["spare one"]);
  await B.openSms(S);
  const early = await B.revokeKey(S, "spare one");
  check("last-credential rule: the spare cannot retire itself while the bootstrap primary has no enrolment proof", !/^Revoked\./.test(early) && B.keyStatus("spare one") === "active", early);
  const ap1 = await B.attestKey(S, "primary");
  const ap2 = await B.attestKey(S, "recovery one");
  check("owner-level enrolment proof: the real authenticator attests the bootstrap primary and the installed recovery key", ap1 === "attested" && ap2 === "attested" && Number(q("select count(*) from public.studio_sms_price_credentials where status = 'active' and proof_verified_at is null")) === 0, `${ap1} / ${ap2}`);
  await B.only(S, ["primary"]);
  await B.openSms(S);
  const recBtns = await B.rowButtons(S, "recovery one");
  const spBtns = await B.rowButtons(S, "spare one");
  check("policy UI: the recovery row offers ONLY 'Retire the recovery key'; ordinary rows offer 'Retire this key' and 'Evict with the recovery key'", recBtns.length === 1 && /^Retire the recovery key/.test(recBtns[0]) && spBtns.length === 2 && /^Retire this key/.test(spBtns[0]) && /^Evict with the recovery key/.test(spBtns[1]), JSON.stringify([recBtns, spBtns]));
  check("three-credential set: primary (owner-level) + spare (UI, delayed) + recovery (owner-level)", B.countActive() === 3 && B.activeKeys().includes("spare one:spare") && B.activeKeys().includes("recovery one:recovery"), B.activeKeys());
  check("the audit holds the credential_change_pending and credential_change_applied events", B.audit("credential_change_applied") >= 1 && B.audit("credential_change_pending") >= 1, `applied=${B.audit("credential_change_applied")} pending=${B.audit("credential_change_pending")}`);
}


// ---------------------------------------------------------------------------------------------------------------- helpers shared by the scenarios
const flagsOf = (authDataB64u) => Buffer.from(authDataB64u, "base64url")[32];
const finishBodies = (S) => S.actions.filter((a) => a.body.includes('"authData"') && a.body.includes('"requestId"'));
const replayHeaders = (a) => {
  const h = {};
  for (const k of ["next-action", "next-router-state-tree", "content-type", "accept"]) if (a.headers[k]) h[k] = a.headers[k];
  h.origin = a.headers.origin ?? ctx.state.appOrigin;
  h.referer = a.headers.referer ?? `${ctx.state.appOrigin}/platform/sms`;
  return h;
};
async function replay(S, a) {
  const r = await S.context.request.post(a.url, { headers: replayHeaders(a), data: a.body, maxRedirects: 0, failOnStatusCode: false });
  return { status: r.status(), text: await r.text(), redirect: r.headers()["x-action-redirect"] ?? r.headers()["location"] ?? "" };
}
const dollarsOf = (cents) => `${(cents / 100).toFixed(2)}`;
async function fresh(S) { if (!(await B.stepUp(S, ctx.secret))) throw new Error(`step-up failed for ${S.name}`); }

// ---------------------------------------------------------------------------------------------------------------- 2 propose -> cooling-off -> separate-session approval
async function sc2() {
  scn(2);
  const { s1, s2 } = ctx;
  const p0 = B.activePrice("number");
  await fresh(s1);
  const p = await B.propose(s1, "number", "4.25", "1.15", "browser price one", "a written reason for the browser run");
  const rid = B.latestRequest();
  const fc = (await s1.context.cookies()).find((c) => c.name === "tw4_price_flash");
  check("propose through the UI form (aal2 + fresh TOTP, session 1)", p.ok && /Proposal recorded/.test(p.text) && !!rid, p.text);
  check("recorded as a single-owner proposal v1 with a 24 h cooling-off, price untouched", /^pending\|owner\|v1\|425$/.test(B.requestRow(rid)) && Number(q(`select round(extract(epoch from cooling_until - now()) / 3600)::int from public.studio_sms_price_change_requests where id = '${rid}'`)) === 24 && B.activePrice("number") === p0, B.requestRow(rid));
  await B.only(s1, ["primary"]);
  const a1 = await B.authorizeBegin(s1, rid);
  check("the PROPOSING session is refused (no challenge summary)", a1.summary === null && !!a1.message, a1.message);
  await B.only(s2, ["primary"]);
  const a2 = await B.authorizeBegin(s2, rid);
  check("a second session is refused inside the cooling-off (no challenge)", a2.summary === null && !!a2.message, a2.message);
  B.ageRequests(25);
  const a3 = await B.authorizeBegin(s2, rid);
  check("after the (database-clock) cooling-off the separate session gets the challenge with the exact summary from the database", !!a3.summary && a3.summary.includes(dollarsOf(425)) && a3.summary.includes("proposal version 1"), a3.summary ?? a3.message);
  // the recovery key is not offered for pricing: the browser cannot find an allowed credential
  await B.only(s2, [ctx.rec]);
  await B.signClick(s2, rid);
  const wrong = await B.signMessage(s2, rid, 30000).catch(() => "TIMEOUT: the browser found no offered credential and kept waiting");
  check("an authenticator holding ONLY the recovery key cannot sign a price (the recovery key is not offered)", (/did not sign|refused/i.test(wrong) || /^TIMEOUT/.test(wrong)) && !/Authorized/.test(wrong) && B.activePrice("number") === p0, wrong);
  const a4 = await B.authorizeBegin(s2, rid);
  await B.only(s2, ["primary"]);
  await B.signClick(s2, rid);
  const done = await B.signMessage(s2, rid);
  check("authorize with the primary key: the price is published", /Authorized/.test(done) && B.activePrice("number") === "425", done);
  const cap = finishBodies(s2).at(-1);
  const body = JSON.parse(cap.body);
  const fl = flagsOf(body[0].authData);
  check("assertion profile (default virtual authenticator): UP and UV set, backup flags (BE/BS) clear", (fl & 0x05) === 0x05 && (fl & 0x18) === 0, `flags=0x${fl.toString(16)}`);
  const rp = await replay(s2, cap);
  check("REPLAY of the captured server-action request publishes nothing and applies once", !/"status":"applied"/.test(rp.text) && Number(q("select count(*) from public.studio_sms_price_list where kind = 'number' and customer_price_cents = 425")) === 1, `${rp.status} ${rp.text.slice(0, 160)}`);
  if (fc) check("the price flash cookie (set by the propose action) is HttpOnly, SameSite=Strict, path /platform/sms, lives <= 60 s", fc.httpOnly && fc.sameSite === "Strict" && fc.path === "/platform/sms" && fc.expires > 0 && fc.expires - Date.now() / 1000 <= 61, JSON.stringify({ httpOnly: fc.httpOnly, sameSite: fc.sameSite, path: fc.path, secure: fc.secure, ttl: Math.round(fc.expires - Date.now() / 1000) }));
  else blocked("flash cookie attributes", "the flash cookie had already expired or was not observable in the context at inspection time");
  void a4;

  // tampered proposal: sign over v1, revise to v2 before the signature reaches the database
  await fresh(s1);
  const p2 = await B.propose(s1, "number", "5.10", "1.15", "browser price two", "a written reason for the tamper check");
  const rid2 = B.latestRequest();
  check("second proposal recorded", p2.ok && !!rid2 && rid2 !== rid, p2.text);
  B.ageRequests(25);
  await B.only(s2, ["primary"]);
  const b1 = await B.authorizeBegin(s2, rid2);
  check("challenge issued for v1 of the second proposal", !!b1.summary && b1.summary.includes(dollarsOf(510)), b1.summary ?? b1.message);
  let held = null;
  await s2.page.route("**/platform/sms*", async (route) => {
    const req = route.request();
    if (!held && req.headers()["next-action"] && (req.postData() ?? "").includes('"authData"')) { held = route; return; }
    await route.continue();
  });
  await B.signClick(s2, rid2);
  for (let i = 0; i < 100 && !held; i++) await sleep(100);
  check("the signed finish request was held in the browser (signature over v1 captured)", !!held);
  const stale = held ? finishBodies(s2).at(-1) : null;
  const rv = await B.reviseUi(s1, rid2, "5.20", "1.15", "browser price two revised", "revised after the signature was made");
  const rid3 = B.latestRequest();
  check("revise through the UI voids v1 and creates v2", rv.ok && /Revised \(version 2\)/.test(rv.text) && rid3 !== rid2, rv.text);
  check("v2 restarts the 24 h cooling-off and the old request is no longer pending", /^pending\|owner\|v2\|520$/.test(B.requestRow(rid3)) && Number(q(`select round(extract(epoch from cooling_until - now()) / 3600)::int from public.studio_sms_price_change_requests where id = '${rid3}'`)) === 24 && !B.requestRow(rid2).startsWith("pending"), `${B.requestRow(rid2)} / ${B.requestRow(rid3)}`);
  if (held) await held.continue();
  const tm = await B.signMessage(s2, rid2, 60000).catch((e) => `NO MESSAGE ${String(e).slice(0, 60)}`);
  check("the pre-revision signature is REFUSED by the database and publishes nothing", !/Authorized/.test(tm) && B.activePrice("number") === "425", tm);
  await s2.page.unroute("**/platform/sms*");
  if (stale) {
    const rr = await replay(s2, stale);
    check("replaying the v1 signature again is also refused", !/"status":"applied"/.test(rr.text) && B.activePrice("number") === "425", rr.text.slice(0, 120));
  }
  const c1 = await B.authorizeBegin(s2, rid3);
  check("v2 cannot be authorized inside its restarted cooling-off", c1.summary === null && !!c1.message, c1.message);
  B.ageRequests(25);
  const c2 = await B.authorizeBegin(s2, rid3);
  await B.signClick(s2, rid3);
  const c3 = await B.signMessage(s2, rid3);
  check("after the new cooling-off v2 (5.20) is authorized and published", !!c2.summary?.includes(dollarsOf(520)) && /Authorized/.test(c3) && B.activePrice("number") === "520", c3);
}

// ---------------------------------------------------------------------------------------------------------------- 3 assurance: aal1, revoked, expired
async function sc3() {
  scn(3);
  const { s2, s1 } = ctx;
  const s3 = await B.newSession(ctx.browser, ctx.state, "s3-aal1");
  check("password-only login (aal1) succeeds", await B.login(s3, ctx.A, ctx.secret, { mfa: false }));
  await s3.page.goto("/platform/sms");
  check("an aal1 session is sent to the MFA challenge, not the pricing page", s3.page.url().includes("/platform-mfa/challenge"), s3.page.url());
  const capBegin = s2.actions.find((a) => /^\["[0-9a-f-]{36}"\]$/.test(a.body));
  const capPending = s2.actions.find((a) => a.body === "[]");
  const capPropose = s1.actions.find((a) => (a.headers["content-type"] ?? "").startsWith("multipart/form-data") && a.body.includes("customerUsd") && a.body.includes("browser price one"));
  const before = Number(q("select count(*) from public.studio_sms_price_change_requests"));
  const authBefore = B.audit("challenge_issued");
  const noData = (r) => !/"allowCredentials":\[|"challenge":"|"credentials":\[/.test(r.text) && (r.status >= 300 || /platform-mfa|login/.test(r.redirect + r.text));
  if (capPending) { const r = await replay(s3, capPending); check("aal1: the credential-list server action returns no data (redirect to the challenge)", noData(r) && /platform-mfa|login/.test(r.redirect + r.text), `${r.status} ${r.redirect}`); } else blocked("aal1 credential-list replay", "no captured priceCredPending request");
  if (capBegin) { const r = await replay(s3, capBegin); check("aal1: the authorize-begin server action returns no challenge", noData(r) && B.audit("challenge_issued") === authBefore, `${r.status} ${r.redirect}`); } else blocked("aal1 authorize-begin replay", "no captured request");
  if (capPropose) { const r = await replay(s3, capPropose); check("aal1: the propose form action creates nothing", Number(q("select count(*) from public.studio_sms_price_change_requests")) === before && /platform-mfa|login/.test(r.redirect + r.text), `${r.status} ${r.redirect}`); } else blocked("aal1 propose replay", "no captured form request");

  // revoked + expired GoTrue sessions
  for (const mode of ["revoked", "expired"]) {
    const S = await B.newSession(ctx.browser, ctx.state, `s-${mode}`);
    const had = new Set(B.sessionIds(ctx.A.id));
    await sleep(1200);
    check(`${mode}: full aal2 login first`, await B.login(S, ctx.A, ctx.secret));
    const mine = B.sessionIds(ctx.A.id).filter((id) => !had.has(id));
    check(`${mode}: exactly one new GoTrue session`, mine.length === 1, String(mine.length));
    const r0 = capPending ? await replay(S, capPending) : null;
    check(`${mode}: before the change the same request is served`, !!r0 && r0.status === 200 && !/platform-mfa/.test(r0.redirect), r0 ? `${r0.status}` : "no capture");
    if (mode === "revoked") q(`delete from auth.sessions where id = '${mine[0]}'`);
    else {
      await B.forgeExpiredJwt(S, ctx.state.jwt);
      const ra = capPending ? await replay(S, capPending) : null;
      check("expired: an expired ACCESS TOKEN whose session is still valid is silently refreshed and the action is served (aal2 retained)", !!ra && ra.status === 200 && !/platform-mfa|login/.test(ra.redirect), ra ? `${ra.status} ${ra.redirect}` : "no capture");
      const r = L.psql(`update auth.sessions set not_after = now() - interval '1 minute' where id = '${mine[0]}'`);
      if (r.code !== 0) { blocked("expired session (session not_after)", `auth.sessions.not_after unavailable: ${r.err.slice(0, 100)}`); continue; }
      await B.forgeExpiredJwt(S, ctx.state.jwt);
    }
    const r1 = capPending ? await replay(S, capPending) : null;
    check(`${mode}: the server action is refused afterwards (redirect, no data)`, !!r1 && /platform-mfa|login/.test(r1.redirect + r1.text) && !/"credentials":\[/.test(r1.text), r1 ? `${r1.status} ${r1.redirect}` : "");
    await S.page.goto("/platform/sms");
    check(`${mode}: the page sends the browser to sign in`, /\/login|platform-mfa/.test(S.page.url()), S.page.url());
  }

  // signed OUT (not just deleted): the stateless JWT outlives the sign-out; the stolen cookie and the raw token must both be refused
  {
    // the Log Out button signs the user out GLOBALLY (every session of that user), so this uses a second platform administrator and leaves the main owner's sessions alone
    const C = await B.createUser(ctx.state, "second", `${randomBytes(18).toString("base64url")}Aa1!`);
    q(`insert into public.profiles (id, email, platform_role) values ('${C.id}', '${C.email}', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';
       insert into public.studio_sms_price_approvers (user_id, added_note) values ('${C.id}', 'second synthetic administrator for the sign-out check') on conflict do nothing;`);
    const secretC = await B.enrollTotp(ctx.state, C);
    const S = await B.newSession(ctx.browser, ctx.state, "s-signedout");
    check("signed-out: full aal2 login first (second administrator)", await B.login(S, C, secretC));
    const token = await B.accessTokenOf(S);
    const jar = await S.context.cookies();
    const rpc = (tok) => L.http("POST", `${ctx.state.url}/rest/v1/rpc/tw4_price_cred_pending`, tok, {}, { apikey: ctx.state.anon });
    const pre = await rpc(token);
    check("signed-out: before sign-out the raw access token is accepted by the database RPC (PostgREST)", pre.status === 200, `${pre.status}`);
    const r0 = capPending ? await replay(S, capPending) : null;
    check("signed-out: before sign-out the server action is served", !!r0 && r0.status === 200 && !/platform-mfa|login/.test(r0.redirect));
    await B.signOutUi(S);
    check("signed-out: the Log Out button ends the session and lands on a public page", !S.page.url().includes("/platform"), S.page.url());
    const thief = await B.newSession(ctx.browser, ctx.state, "s-thief");
    await thief.context.addCookies(jar);
    const r1 = capPending ? await replay(thief, capPending) : null;
    check("signed-out: replaying the captured server action with the OLD cookies is refused (redirect, no data)", !!r1 && /platform-mfa|login/.test(r1.redirect + r1.text) && !/"credentials":\[/.test(r1.text), r1 ? `${r1.status} ${r1.redirect}` : "");
    const post = await rpc(token);
    check("signed-out: the still-unexpired JWT is refused BY THE DATABASE (session ended, 42501)", post.status !== 200 && /session has ended|42501/.test(post.text), `${post.status} ${post.text.slice(0, 120)}`);
    const priv = q("select r.rolname || ' super=' || r.rolsuper || ' sees_auth.sessions=' || has_table_privilege(r.oid, 'auth.sessions', 'select') from pg_proc p join pg_roles r on r.oid = p.proowner where p.proname = '_tw4price_session_actor' limit 1");
    console.log("  function owner of _tw4price_session_actor:", priv, "(on a hosted project verify the owner can read auth.sessions)");
    // forged tokens: valid signature (local secret), real sub, but a session that is not the caller's
    check("production behaviour: public.tw4_local_qa_only is ABSENT in this database", q("select coalesce(to_regclass('public.tw4_local_qa_only')::text, 'absent')") === "absent");
    const nLogin = await L.http("POST", `${ctx.state.url}/auth/v1/token?grant_type=password`, null, { email: ctx.N.email, password: ctx.N.password });
    const nSess = B.sessionIds(ctx.N.id).at(-1);
    check("another user's real GoTrue session exists for the forgery", nLogin.status === 200 && !!nSess, String(nLogin.status));
    const rpcWith = (tok) => L.http("POST", `${ctx.state.url}/rest/v1/rpc/tw4_price_cred_pending`, tok, {}, { apikey: ctx.state.anon });
    const cases = [
      ["another user's real session id re-signed into the caller's token", (p) => { p.session_id = nSess; }, /belongs to another user|42501/],
      ["a random (non-existent) session id", (p) => { p.session_id = "11111111-2222-4333-8444-555555555555"; }, /session has ended|42501/],
      ["no session_id claim at all", (p) => { delete p.session_id; }, /42501|sign in|session/i],
      ["a non-uuid session_id claim", (p) => { p.session_id = "not-a-session"; }, /42501|sign in|session/i],
    ];
    for (const [name, mutate, want] of cases) {
      const F = await B.newSession(ctx.browser, ctx.state, "s-forge");
      await sleep(1200);
      await B.login(F, C, secretC);
      const forged = await B.forgeJwt(F, ctx.state.jwt, mutate);
      const d = await rpcWith(forged);
      check(`forged token (${name}): refused by the database through PostgREST`, d.status >= 400 && want.test(d.text) && !/"credentials"/.test(d.text), `${d.status} ${d.text.slice(0, 110)}`);
      const r = capPending ? await replay(F, capPending) : null;
      check(`forged token (${name}): the real Next server action returns no data`, !!r && !/"credentials":\[/.test(r.text) && (r.status >= 300 || /"ok":false|login|platform-mfa/.test(r.text + r.redirect)), r ? `${r.status} ${(r.redirect || r.text).slice(0, 110).replace(/\n/g, " ")}` : "no capture");
    }
    check("the owner of the session-actor function can read auth.sessions (local role; hosted must be confirmed separately)", /sees_auth\.sessions=true/.test(priv), priv);
  }
}

// ---------------------------------------------------------------------------------------------------------------- 4 revocation
async function sc4() {
  scn(4);
  const { s1, s2 } = ctx;
  await B.only(s1, ["primary"]);
  await B.openSms(s1);
  const rv0 = await B.revokeKey(s1, "spare one");
  check("policy: the PRIMARY key cannot retire the spare (a key retires only itself)", !/^Revoked\./.test(rv0) && B.keyStatus("spare one") === "active", rv0);
  await B.only(s1, [ctx.rec]);
  await B.openSms(s1);
  const rv = await B.evictKey(s1, "spare one");
  check("revoke through the UI is immediate and final", /^Revoked\./.test(rv) && B.keyStatus("spare one") === "revoked" && /cannot be undone/.test(rv), rv);
  await B.openSms(s1);
  const list = await B.keyListText(s1);
  check("no cancel / undo control exists for a revoked key (no row, no pending change, no Cancel button)", !list.includes("spare one") && Number(q("select count(*) from public.studio_sms_price_credential_changes where status = 'pending'")) === 0 && (await s1.page.getByRole("button", { name: "Cancel with key" }).count()) === 0, list);
  check("the database exposes no cancel / undo / reinstate function for a revocation", Number(q("select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname ~ 'revoke.*(cancel|undo)' or (proname ~ '(undo|reinstate|unrevoke)' and proname ~ 'tw4_?price'))")) === 0);

  // the database allows at most 3 active credentials, so make room: spare two replaces the recovery key for this test (a recovery key is enrolled again at the end)
  const sp = await enrolAndApply(s1, "spare two", "spare", ["primary"]);
  check("second spare enrolled through the UI", B.keyStatus("spare two") === "active", sp.m2);
  await B.only(s1, ["primary"]);
  await B.openSms(s1);
  const rrv0 = await B.revokeKey(s1, ctx.rec);
  check("an ordinary (primary) key is NOT offered for retiring the recovery key: only the recovery key can retire itself", !/^Revoked\./.test(rrv0) && B.keyStatus(ctx.rec) === "active", rrv0);
  await B.only(s1, [ctx.rec]);
  await B.openSms(s1);
  const rrv = await B.revokeKey(s1, ctx.rec);
  check("the recovery key retires itself through the UI (immediate, final)", /^Revoked\./.test(rrv) && B.keyStatus(ctx.rec) === "revoked", rrv);
  await B.only(s1, ["spare two"]);
  await B.openSms(s1);
  const req3 = await B.requestKey(s1, "spare three", "spare");
  await B.adopt(s1, "spare three");
  const pendingBefore = Number(q("select count(*) from public.studio_sms_price_credential_changes where status = 'pending' and label = 'spare three'"));
  check("a new key is requested with the SPARE key's signature (pending)", /Requested/.test(req3) && pendingBefore === 1, req3);
  B.ageChanges(25);
  await fresh(s1);
  const p = await B.propose(s1, "number", "6.00", "1.15", "revoked signer price", "a written reason for the revoked signer check");
  const rid = B.latestRequest();
  B.ageRequests(25);
  await B.only(s2, ["spare two"]);
  const b = await B.authorizeBegin(s2, rid);
  check("challenge issued while spare two is still active (it is offered)", p.ok && !!b.summary, b.summary ?? b.message);
  await B.only(s1, ["spare two"]);
  await B.openSms(s1);
  const rv2 = await B.revokeKey(s1, "spare two");
  check("spare two revoked via the UI between the challenge and the signature", /^Revoked\./.test(rv2) && B.keyStatus("spare two") === "revoked", rv2);
  await B.signClick(s2, rid);
  const dead = await B.signMessage(s2, rid);
  check("the revoked key's REAL signature on the already-issued challenge is rejected, nothing published", !/Authorized/.test(dead) && B.activePrice("number") === "520", dead);
  const st = q("select coalesce(max(status), 'none') from public.studio_sms_price_credential_changes where label = 'spare three'");
  await B.openSms(s1);
  const ap = await B.applyPending(s1, "spare three").catch((e) => `NO ROW (${String(e).slice(0, 40)})`);
  check("the pending enrolment authorized by the now-revoked key is dead (voided, or Apply refused); the key never becomes active", B.keyStatus("spare three") !== "active", `change status before apply: ${st}; apply: ${ap.slice(0, 90)}`);
  B.withdraw(rid, ctx.A.id);
  await ensureRecovery("recovery two");
  check("a fresh recovery key is enrolled again for the following scenarios", B.keyStatus("recovery two") === "active" && B.countActive() === 2, B.activeKeys());
}

// ---------------------------------------------------------------------------------------------------------------- 7 authenticator profiles
async function sc7() {
  scn(7);
  const { s1 } = ctx;
  const sBE = await B.newSession(ctx.browser, ctx.state, "s7-be", { defaultBackupEligibility: true, defaultBackupState: true });
  check("login in a backup-eligible authenticator profile session", await B.login(sBE, ctx.A, ctx.secret));
  await B.only(sBE, ["primary"]);
  await B.openSms(sBE);
  const before = B.countActive();
  const m = await B.requestKey(sBE, "be spare", "spare");
  await B.adopt(sBE, "be spare");
  check("default allow_backup_eligible=false: a backup-eligible (BE/BS) key is refused at enrolment, nothing pending", /refused|backup|synced|Nothing changed/i.test(m) && !/^Requested/.test(m) && Number(q("select count(*) from public.studio_sms_price_credential_changes where status = 'pending'")) === 0 && B.countActive() === before, m);
  B.setConfig("allow_backup_eligible = true");
  await B.only(sBE, ["primary", "be spare"]);
  // the same BE key may be enrolled again only with a fresh ceremony: a new key is created by the UI
  await B.openSms(sBE);
  const m2 = await B.requestKey(sBE, "be spare 2", "spare");
  await B.adopt(sBE, "be spare 2");
  B.ageChanges(25);
  await B.openSms(sBE);
  const ap = await B.applyPending(sBE, "be spare 2");
  check("allow_backup_eligible=true: the BE key is accepted (pending then applied)", /Requested/.test(m2) && B.keyStatus("be spare 2") === "active", `${m2} / ${ap}`);

  // authorization with the BE key (flag true) and its refusal when the flag is turned back off
  await fresh(s1);
  await B.propose(s1, "number", "7.05", "1.15", "profile price one", "a written reason for the profile check");
  let rid = B.latestRequest();
  B.ageRequests(25);
  await B.only(sBE, ["be spare 2"], { backup: true });
  const a = await B.authorizeBegin(sBE, rid);
  await B.signClick(sBE, rid);
  const msg = await B.signMessage(sBE, rid);
  const cap = finishBodies(sBE).at(-1);
  const fl = cap ? flagsOf(JSON.parse(cap.body)[0].authData) : 0;
  check("the BE profile really produces BE+BS flags in the assertion (0x18)", (fl & 0x18) === 0x18, `flags=0x${fl.toString(16)}`);
  check("flag true: an assertion from the BE key is accepted and publishes", !!a.summary && /Authorized/.test(msg) && B.activePrice("number") === "705", msg);
  B.setConfig("allow_backup_eligible = false");
  await fresh(s1);
  await B.propose(s1, "number", "7.15", "1.15", "profile price two", "a written reason for the profile check two");
  rid = B.latestRequest();
  B.ageRequests(25);
  await B.authorizeBegin(sBE, rid);
  await B.signClick(sBE, rid);
  const msg2 = await B.signMessage(sBE, rid);
  check("flag back to false: the same BE key's assertion is REFUSED (backup-eligible) and nothing publishes", !/Authorized/.test(msg2) && /backup|synced|refused/i.test(msg2) && B.activePrice("number") === "705", msg2);
  await B.only(sBE, ["primary"]);
  await B.authorizeBegin(sBE, rid);
  await B.signClick(sBE, rid);
  const msg3 = await B.signMessage(sBE, rid);
  check("the non-backup-eligible primary still authorizes under the default", /Authorized/.test(msg3) && B.activePrice("number") === "715", msg3);

  // an authenticator that cannot / does not verify the user
  const sNV = await B.newSession(ctx.browser, ctx.state, "s7-nouv", { isUserVerified: false });
  check("login in a profile whose authenticator is NOT user-verified", await B.login(sNV, ctx.A, ctx.secret));
  await fresh(s1);
  await B.propose(s1, "number", "7.25", "1.15", "profile price three", "a written reason for the profile check three");
  rid = B.latestRequest();
  B.ageRequests(25);
  await B.only(sNV, ["primary"]);
  await B.authorizeBegin(sNV, rid);
  await B.signClick(sNV, rid);
  const msg4 = await B.signMessage(sNV, rid, 150000).catch((e) => `TIMEOUT ${String(e).slice(0, 60)}`);
  check("an authenticator that does not verify the user cannot authorize (userVerification: required)", !/Authorized/.test(msg4) && B.activePrice("number") === "715", msg4);
  B.withdraw(rid, ctx.A.id);

  // restore: revoke the BE keys
  await B.only(s1, [ctx.rec]);
  await B.openSms(s1);
  await B.evictKey(s1, "be spare 2");
  check("BE test key revoked again, set back to primary + recovery", B.keyStatus("be spare 2") === "revoked");
}

// ---------------------------------------------------------------------------------------------------------------- 6 concurrency
async function sc6() {
  scn(6);
  const { s1, s2 } = ctx;
  // at most 3 credentials may be active: [primary, recovery] + one race key at a time
  await enrolAndApply(s1, "race a", "spare", ["primary"]);
  check("race fixture active", B.keyStatus("race a") === "active");
  // 6a: the same revocation from two sessions at once
  await B.only(s1, ["race a"]);
  await B.only(s2, ["race a"], { bump: 10 });
  await B.openSms(s1);
  await B.openSms(s2);
  const auditBefore = B.audit("credential_revoked");
  const [r1, r2] = await Promise.all([B.revokeKey(s1, "race a"), B.revokeKey(s2, "race a")]);
  const revoked = [r1, r2].filter((m) => /^Revoked\./.test(m)).length;
  check("two sessions revoke the same key at once: exactly one revocation is recorded", B.keyStatus("race a") === "revoked" && B.audit("credential_revoked") === auditBefore + 1 && revoked >= 1, `${r1.slice(0, 60)} || ${r2.slice(0, 60)}`);
  check("the primary and recovery keys are untouched by the race", B.keyStatus("primary") === "active" && B.keyStatus(ctx.rec) === "active");
  // 6b: the same Apply from two sessions at once
  await enrolAndApplyNoApply(s1, "race c", "spare", ["primary"]);
  B.ageChanges(25);
  await B.only(s1, ["primary"]);
  await B.openSms(s1);
  await B.openSms(s2);
  const appBefore = B.audit("credential_change_applied");
  const [a1, a2] = await Promise.all([B.applyPending(s1, "race c"), B.applyPending(s2, "race c")]);
  check("two sessions apply the same pending key at once: one active row, one apply recorded", Number(q("select count(*) from public.studio_sms_price_credentials where label = 'race c' and status = 'active'")) === 1 && B.audit("credential_change_applied") === appBefore + 1, `${a1.slice(0, 50)} || ${a2.slice(0, 50)}`);
  // 6c: a new key requested with key B's signature while key B is being revoked (make room: revoke race c and the recovery key, enrol B)
  await B.only(s1, ["race c"]);
  await B.openSms(s1);
  await B.revokeKey(s1, "race c");
  await B.openSms(s1);
  await B.only(s1, [ctx.rec]);
  await B.revokeKey(s1, ctx.rec);
  await enrolAndApply(s1, "race b", "spare", ["primary"]);
  check("race fixture: [primary, race b] active", B.countActive() === 2 && B.keyStatus("race b") === "active", B.activeKeys());
  await B.only(s1, ["race b"]);
  await B.only(s2, ["race b"], { bump: 10 });
  await B.openSms(s1);
  await B.openSms(s2);
  const [e1, e2] = await Promise.all([B.requestKey(s1, "race d", "spare").catch((e) => `ERR ${String(e).slice(0, 60)}`), B.revokeKey(s2, "race b")]);
  await B.discardUnnamed(s1).catch(() => {});
  const pend = Number(q("select count(*) from public.studio_sms_price_credential_changes where status = 'pending' and label = 'race d'"));
  B.ageChanges(25);
  let ap = "";
  if (pend > 0) { await B.only(s2, ["primary"]); await B.openSms(s2); ap = await B.applyPending(s2, "race d").catch((e) => `NO ROW/ERR ${String(e).slice(0, 40)}`); }
  check("enrol signed by key B races B's revocation: B ends revoked and the key it authorized never becomes active", B.keyStatus("race b") === "revoked" && B.keyStatus("race d") !== "active", `enrol: ${e1.slice(0, 70)} | revoke: ${e2.slice(0, 40)} | apply: ${ap.slice(0, 60)}`);
  await ensureRecovery("recovery three");
  // 6d: two competing proposals of the same price from two sessions
  await fresh(s1);
  await fresh(s2);
  const [p1, p2] = await Promise.all([B.propose(s1, "number", "8.10", "1.15", "race price a", "a written reason for the race check a"), B.propose(s2, "number", "8.20", "1.15", "race price b", "a written reason for the race check b")]);
  check("two competing proposals for one price: exactly one stays open", Number(q("select count(*) from public.studio_sms_price_change_requests where status = 'pending' and kind = 'number'")) === 1 && [p1, p2].filter((x) => x.ok).length >= 1, `${p1.text.slice(0, 60)} || ${p2.text.slice(0, 60)}`);
  const open = B.latestRequest();
  if (open) B.withdraw(open, ctx.A.id);
  check("stored sign counters are non-negative and the key set is [primary, recovery]", Number(q("select count(*) from public.studio_sms_price_credentials where sign_count < 0")) === 0 && B.countActive() === 2, B.activeKeys());
}

/** the recovery key is installed only by the owner-level runbook step: the browser creates the key, the owner step registers it */
async function ensureRecovery(label) {
  const k = await B.createKey(ctx.s1, label);
  const r = L.psql(`select public._tw4price_install_recovery(decode('${B.hexOf(k.id)}','hex'), decode('${B.hexOf(k.x)}','hex'), decode('${B.hexOf(k.y)}','hex'), '${label}')`);
  if (r.code !== 0) throw new Error(`install recovery failed: ${r.err.slice(0, 200)}`);
  ctx.rec = label;
  await B.openSms(ctx.s1);
  const at = await B.attestKey(ctx.s1, label);
  if (at !== "attested") throw new Error(`attest of the installed recovery key failed: ${at}`);
}
async function enrolAndApplyNoApply(S, label, role, signers) {
  await B.only(S, signers);
  await B.openSms(S);
  const m = await B.requestKey(S, label, role);
  await B.adopt(S, label);
  return m;
}

// ---------------------------------------------------------------------------------------------------------------- 8 monitoring outage
async function sc8() {
  scn(8);
  const { s1 } = ctx;
  await enrolAndApplyNoApply(s1, "mon pending", "spare", ["primary"]);
  B.ageChanges(25);
  B.setConfig("monitoring_expected = true");
  await fresh(s1);
  const ctl = await B.propose(s1, "number", "9.10", "1.15", "monitor control", "a written reason for the monitoring control");
  check("control: monitoring expected AND available -> a proposal is accepted", ctl.ok, ctl.text);
  const cid = B.latestRequest();
  if (cid) B.withdraw(cid, ctx.A.id);
  for (const variant of ["table", "table+emitter"]) {
    L.psql("alter table if exists public.studio_sms_price_security_events rename to studio_sms_price_security_events_off");
    if (variant === "table+emitter") L.psql("alter function public._tw4pricemon_emit_event(text, uuid, jsonb) rename to _tw4pricemon_emit_event_off");
    check(`[${variant}] monitoring table is unavailable`, q("select to_regclass('public.studio_sms_price_security_events')::text") === "");
    await fresh(s1);
    const pr = await B.propose(s1, "number", "9.20", "1.15", "monitor outage", "a written reason during the outage");
    check(`[${variant}] propose is refused`, !pr.ok && Number(q("select count(*) from public.studio_sms_price_change_requests where status = 'pending'")) === 0, pr.text);
    await B.only(s1, ["primary"]);
    await B.openSms(s1);
    const en = await B.requestKey(s1, `mon new ${variant}`, "spare");
    await B.discardUnnamed(s1).catch(() => {});
    check(`[${variant}] enrol request is refused (no pending row)`, !/^Requested/.test(en) && Number(q(`select count(*) from public.studio_sms_price_credential_changes where label = ${B.lit(`mon new ${variant}`)}`)) === 0, en);
    await B.openSms(s1);
    await B.only(s1, [ctx.rec]);
    const rv = await B.revokeKey(s1, ctx.rec);
    check(`[${variant}] revoke is refused (the key stays active)`, !/^Revoked\./.test(rv) && B.keyStatus(ctx.rec) === "active", rv);
    await B.openSms(s1);
    const ap = await B.applyPending(s1, "mon pending");
    check(`[${variant}] apply is refused (change stays pending)`, B.keyStatus("mon pending") !== "active", ap);
    const fz = await B.freezeUi(s1, "monitoring outage test freeze from the UI");
    check(`[${variant}] FREEZE still works from the UI (safe direction)`, fz.ok && B.cfg("frozen") === "true", fz.text);
    await B.only(s1, ["primary"]);
    await B.openSms(s1);
    const th = await B.thaw(s1);
    check(`[${variant}] thaw (safe direction) result is recorded`, /resumed/i.test(th) ? B.cfg("frozen") === "false" : B.cfg("frozen") === "true", th);
    if (B.cfg("frozen") === "true") { /* leave frozen state to the next variant's freeze; thaw after restore */ }
    if (variant === "table+emitter") L.psql("alter function public._tw4pricemon_emit_event_off(text, uuid, jsonb) rename to _tw4pricemon_emit_event");
    L.psql("alter table if exists public.studio_sms_price_security_events_off rename to studio_sms_price_security_events");
    if (B.cfg("frozen") === "true") { await B.only(s1, ["primary"]); await B.openSms(s1); await B.thaw(s1); }
  }
  B.setConfig("monitoring_expected = false");
  await B.only(s1, ["primary"]);
  await B.openSms(s1);
  const ok = await B.applyPending(s1, "mon pending");
  check("after the table is back the pending change applies", B.keyStatus("mon pending") === "active", ok);
  await B.only(s1, ["mon pending"]);
  await B.openSms(s1);
  await B.revokeKey(s1, "mon pending");
}

// ---------------------------------------------------------------------------------------------------------------- 5 freeze / thaw / recovery
async function sc5() {
  scn(5);
  const { s1, s2 } = ctx;
  await fresh(s1);
  const fz = await B.freezeUi(s1, "owner suspects trouble during the browser run");
  check("freeze through the UI (aal2 session)", fz.ok && B.cfg("frozen") === "true", fz.text);
  const pf = await B.propose(s1, "number", "10.10", "1.15", "frozen proposal", "a written reason while frozen");
  check("propose while frozen is refused with a clear message", !pf.ok && pf.text.length > 10, pf.text);
  await B.only(s1, ["primary"]);
  await B.openSms(s1);
  const banner = await s1.page.getByText("Price publication is SUSPENDED").count();
  const th = await B.thaw(s1);
  check("the page shows the suspension banner and the primary key lifts it", banner > 0 && /resumed/i.test(th) && B.cfg("frozen") === "false", th);
  await B.only(s1, [ctx.rec]);
  await B.openSms(s1);
  const rf = await B.recoveryFreeze(s1);
  check("freeze with the RECOVERY key through the UI", /suspended/i.test(rf) && B.cfg("frozen") === "true", rf);
  const hold = B.cfg("recovery_hold");
  await B.only(s1, ["primary"]);
  await B.openSms(s1);
  const th2 = await B.thaw(s1);
  check("ordinary thaw is refused during a recovery freeze/hold", !/resumed/i.test(th2) && B.cfg("frozen") === "true", `${th2} (recovery_hold=${hold})`);
  await B.openSms(s1);
  const rr = await B.revokeKey(s1, ctx.rec);
  check("an ordinary key cannot revoke the recovery key (stays active)", !/^Revoked\./.test(rr) && B.keyStatus(ctx.rec) === "active", rr);
  // recovery enrolment
  await B.only(s1, [ctx.rec]);
  await B.openSms(s1);
  const st = await B.recoveryStart(s1, "recovered one");
  await B.adopt(s1, "recovered one");
  check("recovery enrolment through the UI is pending and suspends publication", /Recovery requested/.test(st) && B.suspended() === "true", `${st} (suspended=${B.suspended()})`);
  await B.only(s1, ["primary"]);
  await B.openSms(s1);
  const pc = await B.cancelPending(s1, "recovered one");
  check("a primary key cannot cancel the recovery enrolment (not offered / refused)", !/^Cancelled/.test(pc) && Number(q("select count(*) from public.studio_sms_price_credential_changes where status = 'pending' and label = 'recovered one'")) === 1, pc);
  await B.only(s1, [ctx.rec]);
  await B.openSms(s1);
  const rc = await B.cancelPending(s1, "recovered one");
  check("the recovery key cancels the recovery enrolment", /^Cancelled/.test(rc), rc);
  await B.openSms(s1);
  const st2 = await B.recoveryStart(s1, "recovered two");
  await B.adopt(s1, "recovered two");
  check("recovery restarted (new key), pending with the long delay", /Recovery requested/.test(st2) && Number(q("select round(extract(epoch from effective_at - requested_at) / 3600)::int from public.studio_sms_price_credential_changes where status = 'pending' and label = 'recovered two'")) >= 72);
  await B.only(s1, ["primary"]);
  await B.openSms(s1);
  const early = await B.applyPending(s1, "recovered two");
  check("apply before the recovery delay is refused", B.keyStatus("recovered two") !== "active", early);
  B.ageChanges(200);
  await B.openSms(s1);
  const ap = await B.applyPending(s1, "recovered two");
  check("after the delay the recovery completes and replaces the whole set", B.keyStatus("recovered two") === "active" && B.keyStatus("primary") === "revoked", `${ap} / ${B.activeKeys()}`);
  console.log("  active keys:", B.activeKeys(), "| suspended:", B.suspended(), "| frozen:", B.cfg("frozen"), "| recovery_hold:", B.cfg("recovery_hold"));
  if (B.suspended() === "true") {
    await B.only(s1, ["recovered two"]);
    await B.openSms(s1);
    const t3 = await B.thaw(s1);
    check("suspension after completed recovery is lifted with the recovered primary", B.suspended() === "false", t3);
  }
  await fresh(s1);
  const pp = await B.propose(s1, "number", "10.50", "1.15", "after recovery price", "a written reason after the recovery");
  const rid = B.latestRequest();
  B.ageRequests(25);
  await B.only(s2, ["recovered two"]);
  const b = await B.authorizeBegin(s2, rid);
  await B.signClick(s2, rid);
  const done = await B.signMessage(s2, rid);
  ctx.prim = "recovered two";
  check("the recovered primary authorizes a price from a separate session", pp.ok && !!b.summary && /Authorized/.test(done) && B.activePrice("number") === "1050", done);
  check("the audit holds recovery events", B.audit("recovery_used") >= 1 || Number(q("select count(*) from public.studio_sms_price_audit where event like 'recovery%'")) >= 1);
}

// ---------------------------------------------------------------------------------------------------------------- 9 UI errors, secrets, CSP, cookies
async function sc9() {
  scn(9);
  const { s1, state } = ctx;
  // client bundle: the built output must not contain any secret of this run
  const roots = [path.join(L.REPO, ".next", "static")];
  const secrets = { "service-role JWT": state.service, "JWT signing secret": state.jwt, "dummy Stripe secret": "sk_test_dummy_d4nxe", "dummy webhook secret": "whsec_dummy_d4nxe", "dummy Resend key": "re_dummy_d4nxe", "dummy Twilio token": "dummy_d4nxe", "TOTP secret": ctx.secret };
  if (flag("dev")) blocked("client bundle secret scan", "run in `next dev`: the built .next/static output is not representative");
  else {
    let files = 0, bytes = 0;
    const hits = {};
    const walk = (d) => { for (const n of readdirSync(d)) { const f = path.join(d, n); const st = statSync(f); if (st.isDirectory()) walk(f); else if (/\.(js|css|html|json|map|txt)$/.test(n)) { const t = readFileSync(f, "utf8"); files++; bytes += t.length; for (const [k, v] of Object.entries(secrets)) if (t.includes(v)) (hits[k] ??= []).push(path.relative(L.REPO, f)); } } };
    for (const r of roots) if (existsSync(r)) walk(r);
    check(`built client output (.next/static, ${files} files, ${(bytes / 1048576).toFixed(1)} MB) contains none of the run's secrets`, files > 20 && Object.keys(hits).length === 0, JSON.stringify(hits).slice(0, 200));
    }
  // headers + cookies on the real page
  const resp = await s1.context.request.get(`${state.appOrigin}/platform/sms`, { maxRedirects: 0, failOnStatusCode: false });
  const h = resp.headers();
  check("security headers on the pricing page (CSP, nosniff, frame, referrer)", !!h["content-security-policy"] && h["x-content-type-options"] === "nosniff" && h["x-frame-options"] === "SAMEORIGIN" && !!h["referrer-policy"], Object.keys(h).filter((k) => /security|frame|content-type-options|referrer/.test(k)).join(","));
  const csp = h["content-security-policy"] ?? "";
  check("CSP forbids framing, plugins and foreign form posts", /frame-ancestors 'self'/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'self'/.test(csp), csp.slice(0, 120));
  console.log("  NOTE CSP script-src:", (csp.match(/script-src[^;]*/) ?? [""])[0]);
  const cookies = await s1.context.cookies();
  const authCk = cookies.filter((c) => /^sb-.*auth-token/.test(c.name));
  check("Supabase session cookies are SameSite=Lax/Strict and path=/ (httpOnly is not set by @supabase/ssr by design; recorded)", authCk.length > 0 && authCk.every((c) => c.sameSite !== "None" && c.path === "/"), authCk.map((c) => `${c.name}:http=${c.httpOnly},secure=${c.secure},ss=${c.sameSite}`).join(" "));
  // CSP / console errors seen by any browser session
  const cspHits = ctx.sessions().flatMap((S) => S.console.filter((m) => /Content Security Policy|violates the following/i.test(m)));
  check("no Content-Security-Policy violation in any browser console during the run", cspHits.length === 0, cspHits[0] ?? "");
  // user-visible messages
  const bad = B.MESSAGES.filter((m) => /ERROR:|SQLSTATE|PGRST|postgres|stack|at \w+\.\w+ \(|eyJ[A-Za-z0-9_-]{20,}|Bearer |TW04\d|42501|23514/i.test(m.text));
  check(`all ${B.MESSAGES.length} user-visible messages are plain sentences (no SQLSTATE, token, stack or SQL text)`, B.MESSAGES.length > 20 && bad.length === 0, bad[0] ? `${bad[0].where}: ${bad[0].text.slice(0, 120)}` : "");
  const gen = [...new Set(B.MESSAGES.filter((m) => /The action failed\./.test(m.text)).map((m) => m.scenario))];
  console.log("  scenarios where only the generic 'The action failed' sentence was shown:", gen.join(",") || "none");
}


// ---------------------------------------------------------------------------------------------------------------- 10 stolen ordinary keys: the attacker flow
async function sc10() {
  scn(10);
  const { s1, s2 } = ctx;
  const P = ctx.prim;
  await ensureRecovery("recovery five");
  check("fixture: [primary, recovery] active (recovery installed owner-level)", B.countActive() === 2 && B.keyStatus(ctx.rec) === "active", B.activeKeys());
  const atk = await B.newSession(ctx.browser, ctx.state, "attacker");
  check("the attacker holds the account (a separate session) and the ordinary keys", await B.login(atk, ctx.A, ctx.secret));
  // 1. ordinary enrolment of role=recovery
  await B.only(atk, [P]);
  await B.openSms(atk);
  const opts = await atk.page.locator('section[aria-label="Hardware keys for price authorization"] select option').allInnerTexts();
  check("attacker: the UI offers no recovery role", !opts.some((o) => /recovery/i.test(o)), opts.join(","));
  const capEnrol = [...s1.actions].reverse().find((a) => a.body.includes('"purpose":"enroll"') && a.body.includes('"role":"spare"'));
  if (capEnrol) {
    const forged = { ...capEnrol, body: capEnrol.body.replace('"role":"spare"', '"role":"recovery"') };
    const r = await replay(atk, forged);
    check("attacker: the server action with role=recovery returns no challenge", !/"challenge":"|"allowCredentials":\[/.test(r.text) && r.status < 400, `${r.status} ${r.text.slice(0, 140).replace(/\n/g, " ")}`);
  } else blocked("forged role=recovery server action", "no captured enrol begin to modify");
  const evil = await B.createKey(atk, null);
  const token = await B.accessTokenOf(atk);
  const direct = await L.http("POST", `${ctx.state.url}/rest/v1/rpc/tw4_price_cred_begin`, token, { p_purpose: "enroll", p_cred_id: evil.id, p_x: evil.x, p_y: evil.y, p_role: "recovery", p_label: "attacker recovery" }, { apikey: ctx.state.anon });
  check("attacker: calling the database directly with the session token for role=recovery is refused", direct.status >= 400 && /never enrolled through an ordinary ceremony|22023/.test(direct.text), `${direct.status} ${direct.text.slice(0, 140)}`);
  await B.discardUnnamed(atk);
  check("attacker: no recovery credential was added", B.countActive() === 2 && Number(q("select count(*) from public.studio_sms_price_credentials where role = 'recovery' and status = 'active'")) === 1);

  // 2. a stolen spare is evicted by the owner; its signature is then useless
  await enrolAndApply(s1, "stolen spare", "spare", [P]);
  await fresh(s1);
  await B.propose(s1, "number", "11.10", "1.15", "attacker price", "a written reason for the attacker flow price");
  const rid = B.latestRequest();
  B.ageRequests(25);
  await B.only(atk, [P]);
  await B.openSms(atk);
  const ea = await B.revokeKey(atk, "stolen spare");
  check("attacker with the primary key cannot retire the spare (a key retires only itself)", !/^Revoked\./.test(ea) && B.keyStatus("stolen spare") === "active", ea);
  await B.openSms(atk);
  const eb = await B.evictKey(atk, "stolen spare");
  check("attacker with the primary key cannot evict it either (needs the recovery key)", !/^Revoked\./.test(eb) && B.keyStatus("stolen spare") === "active", eb);
  await B.only(s1, [ctx.rec]);
  await B.openSms(s1);
  const ev = await B.evictKey(s1, "stolen spare");
  check("owner evicts the stolen spare with the RECOVERY key through the UI (immediate)", /^Revoked\./.test(ev) && B.keyStatus("stolen spare") === "revoked", ev);
  await B.only(atk, ["stolen spare"]);
  const a = await B.authorizeBegin(atk, rid);
  let am = a.message;
  if (a.summary) { await B.signClick(atk, rid); am = await B.signMessage(atk, rid, 60000).catch(() => "TIMEOUT"); }
  check("attacker: the evicted spare cannot authorize the pending proposal", !/Authorized/.test(am ?? "") && B.activePrice("number") !== "1110", am ?? "");
  B.withdraw(rid, ctx.A.id);

  // 3. freeze / thaw by the owner and the attacker; recovery freeze holds
  await B.freezeUi(s1, "stolen key suspected, owner freezes from the UI");
  check("owner freezes through the UI", B.cfg("frozen") === "true");
  await B.only(atk, [P]);
  await B.openSms(atk);
  const t1 = await B.thaw(atk);
  console.log("  NOTE an ordinary key lifting an ORDINARY freeze:", t1.slice(0, 100));
  check("an ordinary key may lift an ordinary freeze (documented design) - outcome consistent with the DB", /resumed/i.test(t1) ? B.cfg("frozen") === "false" : B.cfg("frozen") === "true", t1);
  if (B.cfg("frozen") === "false") await B.freezeUi(s1, "stolen key suspected, owner freezes again");
  await B.only(s1, [ctx.rec]);
  await B.openSms(s1);
  const rf = await B.recoveryFreeze(s1);
  check("owner freezes with the RECOVERY key (hold)", /suspended/i.test(rf) && B.cfg("recovery_hold") === "true", rf);
  await B.only(atk, [P]);
  await B.openSms(atk);
  const t2 = await B.thaw(atk);
  check("attacker with the ordinary keys cannot lift the recovery freeze", !/resumed/i.test(t2) && B.cfg("frozen") === "true", t2);
  await B.openSms(atk);
  const rr = await B.revokeKey(atk, ctx.rec);
  check("attacker cannot retire the recovery key (not offered)", !/^Revoked\./.test(rr) && B.keyStatus(ctx.rec) === "active", rr);
  await B.openSms(atk);
  const en = await B.requestKey(atk, "attacker spare", "spare");
  await B.discardUnnamed(atk);
  B.ageChanges(25);
  await B.openSms(atk);
  const ap = await B.applyPending(atk, "attacker spare").catch((e) => `NO ROW (${String(e).slice(0, 40)})`);
  check("attacker: a spare requested during the hold never becomes active", B.keyStatus("attacker spare") !== "active", `request: ${en.slice(0, 70)} | apply: ${ap.slice(0, 70)}`);

  // 4. the owner completes the recovery DURING a monitoring outage
  B.setConfig("monitoring_expected = true");
  L.psql("alter table if exists public.studio_sms_price_security_events rename to studio_sms_price_security_events_off");
  L.psql("alter function public._tw4pricemon_emit_event(text, uuid, jsonb) rename to _tw4pricemon_emit_event_off");
  check("monitoring is expected AND unavailable", B.cfg("monitoring_expected") === "true" && q("select to_regclass('public.studio_sms_price_security_events')::text") === "");
  await B.only(s1, [ctx.rec]);
  await B.openSms(s1);
  const st = await B.recoveryStart(s1, "owner recovered");
  await B.adopt(s1, "owner recovered");
  check("owner starts the recovery with the recovery key during the outage (tolerant emit)", /Recovery requested/.test(st), st);
  B.ageChanges(200);
  await B.only(s1, [ctx.rec]);
  await B.openSms(s1);
  const done = await B.applyPending(s1, "owner recovered");
  check("owner completes the recovery during the outage; the whole ordinary set (attacker's keys) is replaced", /applied/.test(done) && B.keyStatus("owner recovered") === "active" && B.keyStatus(P) === "revoked", `${done} / ${B.activeKeys()}`);
  L.psql("alter function public._tw4pricemon_emit_event_off(text, uuid, jsonb) rename to _tw4pricemon_emit_event");
  L.psql("alter table if exists public.studio_sms_price_security_events_off rename to studio_sms_price_security_events");
  await B.only(atk, [P]);
  await B.openSms(atk);
  const t3 = await B.thaw(atk);
  check("attacker's old primary is dead after the recovery (not offered)", !/resumed/i.test(t3) && B.cfg("frozen") === "true", t3);
  await B.only(s1, ["owner recovered"]);
  await B.openSms(s1);
  const t4 = await B.thaw(s1);
  check("owner lifts the suspension with the recovered primary (monitoring back)", /resumed/i.test(t4) && B.cfg("frozen") === "false", t4);
  ctx.prim = "owner recovered";
  await fresh(s1);
  const pp = await B.propose(s1, "number", "11.50", "1.15", "after the attack", "a written reason after the attacker flow");
  const rid2 = B.latestRequest();
  B.ageRequests(25);
  await B.only(s2, ["owner recovered"]);
  const b = await B.authorizeBegin(s2, rid2);
  await B.signClick(s2, rid2);
  const m = await B.signMessage(s2, rid2);
  check("the recovered owner proposes and authorizes a price again (monitoring expected and present)", pp.ok && !!b.summary && /Authorized/.test(m) && B.activePrice("number") === "1150", m);
  B.setConfig("monitoring_expected = false");
}

// ---------------------------------------------------------------------------------------------------------------- 11 fresh-MFA policy (10 minutes) and the plain-aal2 safe actions
async function sc11() {
  scn(11);
  const P = ctx.prim;
  const S = await B.newSession(ctx.browser, ctx.state, "s-stale");
  await sleep(1500);
  check("login with a fresh TOTP (the session starts fresh)", await B.login(S, ctx.A, ctx.secret));
  const capPending = ctx.s2.actions.find((a) => a.body === "[]");
  const capBegin = ctx.s2.actions.find((a) => /^\["[0-9a-f-]{36}"\]$/.test(a.body));
  const capPropose = ctx.s1.actions.find((a) => (a.headers["content-type"] ?? "").startsWith("multipart/form-data") && a.body.includes("customerUsd"));
  const capFreeze = [...ctx.s1.actions].reverse().find((a) => (a.headers["content-type"] ?? "").startsWith("multipart/form-data") && a.body.includes("freeze from the UI"));
  const rpc = (tok, fn, body) => L.http("POST", `${ctx.state.url}/rest/v1/rpc/${fn}`, tok, body, { apikey: ctx.state.anon });
  const fresh0 = await B.accessTokenOf(S);
  const f0 = await rpc(fresh0, "tw4_price_cred_pending", {});
  check("fresh session: the database accepts the credential-list RPC", f0.status === 200, String(f0.status));
  const stale = await B.forgeJwt(S, ctx.state.jwt, (p) => { const t = Math.floor(Date.now() / 1000) - 700; p.amr = (p.amr ?? []).map((e) => (e && e.method === "totp" ? { ...e, timestamp: t } : e)); });
  const RID = "11111111-2222-4333-8444-555555555555";
  const c1 = await rpc(fresh0, "tw4_price_authz_begin", { p_request_id: RID });
  const d1 = await rpc(stale, "tw4_price_authz_begin", { p_request_id: RID });
  check("a TOTP verification 11 minutes old: the DATABASE refuses the authorize ceremony for freshness (a fresh token is refused for another reason)", d1.status >= 400 && /fresh authenticator code/.test(d1.text) && !/fresh authenticator code/.test(c1.text), `stale: ${d1.status} ${d1.text.slice(0, 90)} | fresh: ${c1.status} ${c1.text.slice(0, 60)}`);
  const d1b = await rpc(stale, "tw4_price_cred_begin", { p_purpose: "thaw", p_cred_id: null, p_x: null, p_y: null, p_role: null, p_label: null });
  check("stale: a credential ceremony (thaw challenge) is refused for freshness too", d1b.status >= 400 && /fresh authenticator code/.test(d1b.text), `${d1b.status} ${d1b.text.slice(0, 100)}`);
  const d2 = await rpc(stale, "tw4_price_propose", { p_kind: "number", p_customer_cents: 1234, p_provider_cents: 115, p_description: "stale session", p_reason: "a stale session must not propose" });
  check("stale: propose is refused by the database", d2.status >= 400 && Number(q("select count(*) from public.studio_sms_price_change_requests where status = 'pending'")) === 0, `${d2.status} ${d2.text.slice(0, 120)}`);
  if (capBegin) {
    const r = await replay(S, capBegin);
    check("stale: the authorize-begin server action bounces the browser to the step-up page (reason=stale)", /platform-mfa\/challenge\?stepup=1&reason=stale/.test(r.redirect), `${r.status} ${r.redirect}`);
  } else blocked("stale server-action bounce", "no captured authorize-begin request");
  if (capPending) { const r = await replay(S, capPending); check("stale: the plain-aal2 credential READ (panel list) is still served", r.status === 200 && !/platform-mfa/.test(r.redirect), `${r.status} ${r.redirect}`); }
  if (capPropose) {
    const r = await replay(S, capPropose);
    check("stale: the propose form action is bounced to the step-up page and creates nothing", /platform-mfa\/challenge\?stepup=1&reason=stale/.test(r.redirect) && Number(q("select count(*) from public.studio_sms_price_change_requests where status = 'pending'")) === 0, `${r.status} ${r.redirect}`);
  } else blocked("stale propose bounce", "no captured propose form");
  // freeze / report compromise / recovery freeze stay plain aal2: a stale (but aal2) session may still freeze
  if (B.cfg("frozen") !== "false") throw new Error("precondition: prices must not be frozen at this point");
  if (capFreeze) {
    const r = await replay(S, capFreeze);
    check("stale (11 min old TOTP): the REAL freeze form action is not bounced to the step-up page and freezes publication (plain aal2)", /price=1/.test(r.redirect) && !/platform-mfa/.test(r.redirect) && B.cfg("frozen") === "true", `${r.status} ${r.redirect} frozen=${B.cfg("frozen")}`);
  } else blocked("freeze form action on a stale session", "the freeze form submission was not captured from the earlier scenarios");
  const fz = await rpc(stale, "tw4_price_freeze", { p_reason: "stale session freezes: safe direction needs only aal2" });
  check("stale: FREEZE still works (plain aal2, safe direction)", fz.status === 200 && B.cfg("frozen") === "true", `${fz.status} ${fz.text.slice(0, 100)}`);
  const cp = await rpc(stale, "tw4_price_report_compromise", { p_note: "stale session reports a compromise: plain aal2" });
  check("stale: report-compromise works (plain aal2)", cp.status === 200, `${cp.status} ${cp.text.slice(0, 100)}`);
  // renew through the real page, then the same actions succeed
  check("step-up through /platform-mfa/challenge?stepup=1 with a new code succeeds", await B.stepUp(S, ctx.secret), S.page.url());
  if (capPending) { const r = await replay(S, capPending); check("after the step-up the same server action is served", r.status === 200 && !/platform-mfa|login/.test(r.redirect), `${r.status} ${r.redirect}`); }
  const tokNew = await B.accessTokenOf(S);
  const f1 = await rpc(tokNew, "tw4_price_cred_pending", {});
  check("after the step-up the database accepts the ceremony read again", f1.status === 200, String(f1.status));
  await B.only(S, [P]);
  await B.openSms(S);
  const th = await B.thaw(S);
  check("thaw (fresh tier) with the ordinary key after the step-up lifts the suspension", /resumed/i.test(th) && B.cfg("frozen") === "false", th);
  await B.stepUp(S, ctx.secret);
  const pr = await B.propose(S, "number", "12.34", "1.15", "after step-up", "a written reason after the step-up");
  check("propose succeeds again after the step-up", pr.ok && !!B.latestRequest(), pr.text);
  const open = B.latestRequest();
  if (open) B.withdraw(open, ctx.A.id);
}

// ---------------------------------------------------------------------------------------------------------------- 12 the last usable credential
async function sc12() {
  scn(12);
  const { s1 } = ctx;
  const P = ctx.prim;
  check("fixture: exactly one active signing credential", Number(q("select count(*) from public.studio_sms_price_credentials where status = 'active' and role <> 'recovery'")) === 1, B.activeKeys());
  await B.only(s1, [P]);
  await B.openSms(s1);
  const m0 = await B.revokeKey(s1, P);
  check("UI: the last active signing credential cannot retire itself (nothing changes)", !/^Revoked\./.test(m0) && B.keyStatus(P) === "active", m0);
  const en = await enrolAndApply(s1, "replacement spare", "spare", [P]);
  check("a replacement is enrolled through the UI and applied after the delay", B.keyStatus("replacement spare") === "active", en.m2);
  await B.only(s1, [P]);
  await B.openSms(s1);
  const m1 = await B.revokeKey(s1, P);
  check("once a replacement is active the old key retires itself through the UI", /^Revoked\./.test(m1) && B.keyStatus(P) === "revoked" && B.keyStatus("replacement spare") === "active", m1);
  ctx.prim = "replacement spare";
}

// ---------------------------------------------------------------------------------------------------------------- 13 repeated compromise reports and an immediate post-thaw freeze
async function sc13() {
  scn(13);
  const S = ctx.s1;
  const P = ctx.prim;
  if (B.cfg("frozen") !== "false") throw new Error("precondition: prices must not be frozen");
  const cnt = (where) => Number(q(`select count(*) from public.studio_sms_price_audit a where a.event = 'freeze_set' and a.actor = '${ctx.A.id}' and ${where}`));
  const base = cnt("true");
  const baseRepeat = cnt("a.detail ->> 'repeat' = 'true' and a.at > clock_timestamp() - interval '1 hour'");
  const baseLimited = cnt("a.detail ->> 'rate_limited' = 'true' and a.at > clock_timestamp() - interval '1 hour'");
  let accepted = 0;
  for (let i = 1; i <= 13; i++) {
    const r = await B.submitPriceForm(S, "Report a compromise (suspends publication)", { note: `compromise report ${i} from the browser run` });
    if (r.ok) accepted++;
  }
  const added = cnt("true") - base;
  const first = cnt("coalesce(a.detail ->> 'repeat', '') <> 'true' and coalesce(a.detail ->> 'rate_limited', '') <> 'true'") - (base - baseRepeat - baseLimited);
  const repeatHour = cnt("a.detail ->> 'repeat' = 'true' and a.at > clock_timestamp() - interval '1 hour'");
  const limitedHour = cnt("a.detail ->> 'rate_limited' = 'true' and a.at > clock_timestamp() - interval '1 hour'");
  check("13 compromise reports through the real form: every call is accepted and publication is frozen", accepted === 13 && B.cfg("frozen") === "true", `accepted=${accepted}`);
  check("exactly ONE freeze (one non-repeat freeze_set row); the 12 repeats add a bounded number of audited rows (at most 12 new rows)", first === 1 && added >= 2 && added <= 12, `new rows=${added}, first-freeze rows=${first}`);
  check("repeat rows are capped at 10 per administrator and hour, and ONE audited rate-limited row records the dropped reports", repeatHour <= 10 && limitedHour - baseLimited === 1, `repeat/h=${repeatHour} limited/h=${limitedHour}`);
  await B.only(S, [P]);
  await B.openSms(S);
  const th = await B.thaw(S);
  check("thaw after the report storm (fresh MFA, ordinary key)", /resumed/i.test(th) && B.cfg("frozen") === "false", th);
  const before = cnt("true");
  const f = await B.freezeUi(S, "a freeze right after the thaw must never be rate limited");
  const nonRepeatNew = cnt("true") - before;
  check("a freeze right after the thaw is IMMEDIATE (never limited: a new plain freeze_set row, frozen)", f.ok && B.cfg("frozen") === "true" && nonRepeatNew === 1, `${f.text.slice(0, 60)} newRows=${nonRepeatNew}`);
  await B.only(S, [P]);
  await B.openSms(S);
  await B.thaw(S);
  check("left unfrozen", B.cfg("frozen") === "false");
}

function writeReport(crashed, browserVersion) {
  mkdirSync(OUT, { recursive: true });
  const { execFileSync } = require_("node:child_process");
  const vcs = (...a) => { try { return execFileSync("git", a, { cwd: L.REPO, encoding: "utf8" }).trim(); } catch { return "n/a"; } };
  const by = {};
  for (const r of B.RESULTS) { const k = r.scenario; (by[k] ??= { PASS: 0, FAIL: 0, BLOCKED: 0 })[r.status]++; }
  const tot = { PASS: 0, FAIL: 0, BLOCKED: 0 };
  for (const r of B.RESULTS) tot[r.status]++;
  const meta = { when: new Date().toISOString(), branch: vcs("rev-parse", "--abbrev-ref", "HEAD"), head: vcs("rev-parse", "HEAD"), dirty: vcs("status", "--porcelain", "--", "src").length > 0, node: process.version, chromium: browserVersion, pgImage: L.PG_IMAGE,
    app: flag("dev") ? "next dev --webpack" : "next build + next start (Turbopack)", appOrigin: ctx.state?.appOrigin, migrations: ctx.state?.applied?.length, lastMigration: ctx.state?.applied?.at(-1), crashed: crashed ? String(crashed.message ?? crashed).slice(0, 300) : null };
  writeFileSync(path.join(OUT, `next-e2e-run${TAG ? "-" + TAG : ""}.json`), JSON.stringify({ meta, totals: tot, byScenario: by, results: B.RESULTS, messages: B.MESSAGES }, null, 2));
  const L2 = [];
  L2.push("# D4-2 real Next.js browser acceptance run", "", `- when ${meta.when}; branch ${meta.branch} @ ${meta.head.slice(0, 8)}${meta.dirty ? " (src dirty)" : ""}; node ${meta.node}; Chromium ${meta.chromium}`);
  L2.push(`- stack: ${meta.pgImage} + ${meta.migrations} repo migrations (last ${meta.lastMigration}), PostgREST, GoTrue, Kong (local, disposable); app: ${meta.app} at ${meta.appOrigin}`);
  L2.push(`- **totals: ${tot.PASS} PASS, ${tot.FAIL} FAIL, ${tot.BLOCKED} BLOCKED**${meta.crashed ? `; HARNESS CRASH: ${meta.crashed}` : ""}`, "", "| scenario | PASS | FAIL | BLOCKED |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(by)) L2.push(`| ${k} | ${v.PASS} | ${v.FAIL} | ${v.BLOCKED} |`);
  L2.push("", "## Checks", "");
  for (const r of B.RESULTS) L2.push(`- ${r.status} [${r.scenario}] ${r.name}${r.note ? " :: " + r.note.replace(/\n/g, " ") : ""}`);
  writeFileSync(path.join(OUT, `next-e2e-run${TAG ? "-" + TAG : ""}.md`), L2.join("\n") + "\n");
  console.log(`\nTOTAL ${tot.PASS} PASS, ${tot.FAIL} FAIL, ${tot.BLOCKED} BLOCKED -> ${path.join(OUT, `next-e2e-run${TAG ? "-" + TAG : ""}.md`)}`);
  return tot;
}

// ================================================================================================ dispatcher
async function runAll() {
  const s = L.loadState();
  if (!s) die("no stack: run `up` first (or use `all`)");
  ctx.state = s;
  const browser = await B.chromium.launch({ headless: true });
  let crashed = null;
  try {
    ctx.browser = browser;
    await setup(browser);
    for (const [id, fn] of [[1, sc1], [2, sc2], [3, sc3], [4, sc4], [7, sc7], [6, sc6], [8, sc8], [5, sc5], [10, sc10], [11, sc11], [12, sc12], [13, sc13], [9, sc9]]) if (want(id)) { try { await fn(); } catch (e) { check(`scenario ${id} aborted by a harness/page error`, false, String(e).split("\n")[0]); console.error(e); for (const S of B.SESSIONS) { try { await S.page.screenshot({ path: path.join(L.HOME, `abort-${id}-${S.name}.png`) }); } catch { /* ignore */ } } } }
  } catch (e) {
    crashed = e;
    console.error("HARNESS ERROR", e);
    for (const S of B.SESSIONS) { try { await S.page.screenshot({ path: path.join(L.HOME, `crash-${S.name}.png`) }); } catch { /* ignore */ } }
  } finally {
    const v = browser.version();
    await browser.close();
    writeReport(crashed, v);
  }
  return crashed;
}

if (cmd === "up") { await doUp(); }
else if (cmd === "build") { const s = L.loadState(); process.exit(doBuild(s) ? 0 : 1); }
else if (cmd === "start") { const s = L.loadState(); await doStart(s); }
else if (cmd === "down") { doDown(); }
else if (cmd === "run") { const c = await runAll(); process.exit(c ? 1 : 0); }
else if (cmd === "all") {
  let crashed = null;
  try {
    const s = await doUp();
    if (!doBuild(s)) die("build failed", 3);
    await doStart(s);
    crashed = await runAll();
  } finally {
    if (!flag("keep")) doDown();
  }
  process.exit(crashed ? 1 : 0);
} else die("usage: next-e2e.mjs all|up|build|start|run|down");

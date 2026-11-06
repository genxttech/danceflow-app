// D4-2 real-Next.js browser acceptance: BROWSER HELPERS (Playwright + CDP virtual authenticators, UI drivers, owner DDL on the disposable DB).
import { createRequire } from "node:module";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { http, q, psql, totp, sleep, REPO } from "./next-e2e-lib.mjs";
const require = createRequire(path.join(REPO, "package.json"));
export const { chromium } = require("playwright");

export const b64uOf = (b64) => Buffer.from(b64, "base64").toString("base64url");
export const hexOf = (b64u) => Buffer.from(b64u, "base64url").toString("hex");

// ------------------------------------------------------------------------------------------------ results
export const RESULTS = [];
export const MESSAGES = []; // every user-visible message the UI showed, for the "clear errors" review
let CUR = "0";
export const scn = (id) => { CUR = String(id); console.log(`\n=== scenario ${id} ===`); };
export function check(name, ok, note = "") {
  RESULTS.push({ scenario: CUR, name, status: ok ? "PASS" : "FAIL", note: String(note).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"}  [${CUR}] ${name}${note ? "  :: " + String(note).slice(0, 200) : ""}`);
  return !!ok;
}
export function blocked(name, reason) {
  RESULTS.push({ scenario: CUR, name, status: "BLOCKED", note: reason });
  console.log(`BLOCKED [${CUR}] ${name} :: ${reason}`);
}
export function seen(text, where) { if (text) MESSAGES.push({ scenario: CUR, where, text }); return text; }

// ------------------------------------------------------------------------------------------------ owner DDL (disposable database only)
/** run `fn` with every USER trigger of `table` disabled, restoring each trigger's original enable mode afterwards */
export function ownerUpdate(table, updateSql) {
  const trg = q(`select tgname || '|' || tgenabled::text from pg_trigger where tgrelid = 'public.${table}'::regclass and not tgisinternal`).split("\n").filter(Boolean).map((l) => l.split("|"));
  const dis = trg.map(([n]) => `alter table public.${table} disable trigger "${n}";`).join("\n");
  const en = trg.map(([n, m]) => `alter table public.${table} ${m === "A" ? "enable always" : m === "R" ? "enable replica" : "enable"} trigger "${n}";`).join("\n");
  q(`begin;\n${dis}\n${updateSql}\n${en}\ncommit;`);
}
export const ageChanges = (hours) => ownerUpdate("studio_sms_price_credential_changes", `update public.studio_sms_price_credential_changes set requested_at = requested_at - interval '${hours} hours', effective_at = effective_at - interval '${hours} hours' where status = 'pending';`);
export const ageRequests = (hours) => ownerUpdate("studio_sms_price_change_requests", `update public.studio_sms_price_change_requests set requested_at = requested_at - interval '${hours} hours', cooling_until = cooling_until - interval '${hours} hours', expires_at = expires_at - interval '${hours} hours' where status = 'pending';`);
export const setConfig = (setSql) => ownerUpdate("studio_sms_price_auth_config", `update public.studio_sms_price_auth_config set ${setSql};`);
export const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ------------------------------------------------------------------------------------------------ GoTrue users + TOTP
export async function createUser(state, label, password) {
  const email = `d4nxe-${label}-${randomBytes(3).toString("hex")}@example.test`;
  const r = await http("POST", `${state.url}/auth/v1/admin/users`, state.service, { email, password, email_confirm: true });
  if (r.status !== 200) throw new Error(`create user ${label}: ${r.text.slice(0, 200)}`);
  return { id: r.json.id, email, password };
}
export async function enrollTotp(state, user) {
  const login = await http("POST", `${state.url}/auth/v1/token?grant_type=password`, null, { email: user.email, password: user.password });
  if (login.status !== 200) throw new Error(`password grant: ${login.text.slice(0, 200)}`);
  const aal1 = login.json.access_token;
  const enrol = await http("POST", `${state.url}/auth/v1/factors`, aal1, { factor_type: "totp", friendly_name: `d4nxe-${randomBytes(2).toString("hex")}`, issuer: "d4nxe.example.test" });
  if (enrol.status !== 200) throw new Error(`enrol: ${enrol.text.slice(0, 200)}`);
  const f = enrol.json;
  for (const delta of [0, -30000, 30000]) {
    const ch = await http("POST", `${state.url}/auth/v1/factors/${f.id}/challenge`, aal1, {});
    const v = await http("POST", `${state.url}/auth/v1/factors/${f.id}/verify`, aal1, { challenge_id: ch.json.id, code: totp(f.totp.secret, Date.now() + delta) });
    if (v.status === 200) return f.totp.secret;
  }
  throw new Error("TOTP verify failed");
}

// ------------------------------------------------------------------------------------------------ sessions + virtual authenticators
export const SESSIONS = [];
const DEFAULT_AUTH = { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, defaultBackupEligibility: false, defaultBackupState: false };

export async function newSession(browser, state, name, authOpts = {}) {
  const context = await browser.newContext({ baseURL: state.appOrigin });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { ...DEFAULT_AUTH, ...authOpts } });
  const S = { name, context, page, cdp, authId: authenticatorId, actions: [], console: [], authOpts: { ...DEFAULT_AUTH, ...authOpts } };
  page.on("request", (req) => {
    const h = req.headers();
    if (h["next-action"]) S.actions.push({ url: req.url(), method: req.method(), headers: h, body: req.postData() ?? "" });
  });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") S.console.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
  SESSIONS.push(S);
  return S;
}

// credential vault: every key the browser ever created, with its private key, so a test can present exactly the keys a scenario names
const VAULT = new Map(); // id (b64u) -> CDP credential record
const NAMES = new Map(); // test name -> id
export const keyId = (name) => { const id = NAMES.get(name); if (!id) throw new Error(`no key named ${name}`); return id; };
export const keyNames = () => [...NAMES.keys()];

export async function sync(S) {
  const { credentials } = await S.cdp.send("WebAuthn.getCredentials", { authenticatorId: S.authId });
  for (const c of credentials) {
    const id = b64uOf(c.credentialId);
    const prev = VAULT.get(id);
    if (!prev || (c.signCount ?? 0) >= (prev.signCount ?? 0)) VAULT.set(id, c);
  }
}
/** make the session's authenticator hold EXACTLY the named keys (counters carried over from the newest use anywhere) */
export async function only(S, names, { backup = false } = {}) {
  for (const s of SESSIONS) await sync(s).catch(() => {});
  const { credentials } = await S.cdp.send("WebAuthn.getCredentials", { authenticatorId: S.authId });
  for (const c of credentials) await S.cdp.send("WebAuthn.removeCredential", { authenticatorId: S.authId, credentialId: c.credentialId });
  for (const n of names) {
    const rec = VAULT.get(keyId(n));
    const { backupEligibility, backupState, ...rest } = rec;
    await S.cdp.send("WebAuthn.addCredential", { authenticatorId: S.authId, credential: { ...rest, rpId: rest.rpId || "localhost", ...(backup ? { backupEligibility: true, backupState: true } : { backupEligibility: backupEligibility ?? false, backupState: backupState ?? false }) } });
  }
}
/** name the credential(s) the authenticator created since the last adoption */
export async function adopt(S, name) {
  await sync(S);
  const known = new Set(NAMES.values());
  const fresh = [...VAULT.keys()].filter((id) => !known.has(id));
  if (fresh.length !== 1) throw new Error(`adopt(${name}): expected exactly one new credential, found ${fresh.length}`);
  NAMES.set(name, fresh[0]);
  return fresh[0];
}
/** create a new key with the page's real navigator.credentials.create (same options as the panel) and name it */
export async function createKey(S, name) {
  const created = await S.page.evaluate(async () => {
    const bufToB64u = (b) => { const u = new Uint8Array(b); let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
    const c = await navigator.credentials.create({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: "DanceFlow" }, user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "key", displayName: "key" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { userVerification: "required", residentKey: "discouraged" }, attestation: "none" } });
    const raw = new Uint8Array(c.response.getPublicKey()).slice(-65);
    return { id: bufToB64u(c.rawId), x: bufToB64u(raw.slice(1, 33)), y: bufToB64u(raw.slice(33, 65)) };
  });
  if (name) await adopt(S, name);
  return created;
}
/** the access token of the browser's Supabase session cookie */
export async function accessTokenOf(S) {
  const all = await S.context.cookies();
  const parts = all.filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const raw = parts.map((c) => c.value).join("");
  const dec = raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString("utf8") : decodeURIComponent(raw);
  return JSON.parse(dec).access_token;
}
export async function signOutUi(S) {
  await S.page.goto("/platform/sms");
  await Promise.all([S.page.waitForURL((u) => !u.pathname.startsWith("/platform"), { timeout: 30000 }), S.page.getByRole("button", { name: "Log Out" }).first().click()]);
}
/** drop credentials the authenticator holds that we never named (a creation whose enrolment was refused) so the next adoption is unambiguous */
export async function discardUnnamed(S) {
  await sync(S);
  const known = new Set(NAMES.values());
  const { credentials } = await S.cdp.send("WebAuthn.getCredentials", { authenticatorId: S.authId });
  for (const c of credentials) if (!known.has(b64uOf(c.credentialId))) await S.cdp.send("WebAuthn.removeCredential", { authenticatorId: S.authId, credentialId: c.credentialId });
  for (const id of [...VAULT.keys()]) if (!known.has(id)) VAULT.delete(id);
}

// ------------------------------------------------------------------------------------------------ login + step-up through the real pages
async function submitCode(S, secret, expectUrl) {
  const page = S.page;
  for (const delta of [0, 30000, 60000]) {
    const code = totp(secret, Date.now() + delta);
    await page.locator("#code").fill(code);
    await Promise.all([page.waitForLoadState("load").catch(() => {}), page.locator("form:has(#code) button[type=submit]").click()]);
    try {
      await page.waitForURL(expectUrl, { timeout: 15000 });
      return true;
    } catch { /* wrong or replayed code: try the next time step */ }
    if (delta < 60000) await sleep(2500);
  }
  return false;
}
export async function login(S, user, secret, { mfa = true } = {}) {
  const page = S.page;
  await page.goto("/login?intent=studio");
  const form = page.locator("form:has(input[name=password])");
  await form.locator("input[name=email]").fill(user.email);
  await form.locator("input[name=password]").fill(user.password);
  await form.locator("button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
  // a platform administrator is bounced /app -> /platform/... -> the MFA challenge; let that chain settle before navigating
  await page.waitForURL(/\/platform/, { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState("load").catch(() => {});
  if (!mfa) return true;
  if (!page.url().includes("/platform-mfa/challenge")) await page.goto("/platform/sms");
  if (page.url().includes("/platform-mfa/challenge")) {
    if (!(await submitCode(S, secret, /\/platform(\?|$|\/)/))) return false;
  }
  await page.goto("/platform/sms");
  return page.url().includes("/platform/sms");
}
export async function stepUp(S, secret) {
  await S.page.goto("/platform-mfa/challenge?stepup=1&next=%2Fplatform%2Fsms");
  return submitCode(S, secret, /\/platform\/sms/);
}
/** rewrite the browser's Supabase session cookie so its access token is EXPIRED (re-signed with the stack's own JWT secret); the refresh token is left alone */
export async function forgeExpiredJwt(S, jwtSecret) {
  const all = await S.context.cookies();
  const parts = all.filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  if (!parts.length) throw new Error("no session cookie");
  const base = parts[0].name.replace(/\.\d+$/, "");
  const raw = parts.map((c) => c.value).join("");
  const dec = raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString("utf8") : decodeURIComponent(raw);
  const session = JSON.parse(dec);
  const payload = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString("utf8"));
  const past = Math.floor(Date.now() / 1000) - 120;
  payload.exp = past;
  const { signHs256 } = await import("./next-e2e-lib.mjs");
  session.access_token = signHs256(jwtSecret, payload);
  session.expires_at = past;
  session.expires_in = -120;
  const value = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  for (const c of parts) await S.context.clearCookies({ name: c.name });
  await S.context.addCookies([{ name: base, value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }]);
}
/** re-sign the session's access token with a mutated payload (the stack's own JWT secret) and write it back into the browser cookie; returns the forged token */
export async function forgeJwt(S, jwtSecret, mutate) {
  const all = await S.context.cookies();
  const parts = all.filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const base = parts[0].name.replace(/\.\d+$/, "");
  const raw = parts.map((c) => c.value).join("");
  const session = JSON.parse(raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString("utf8") : decodeURIComponent(raw));
  const payload = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString("utf8"));
  mutate(payload);
  const { signHs256 } = await import("./next-e2e-lib.mjs");
  session.access_token = signHs256(jwtSecret, payload);
  const value = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  for (const c of parts) await S.context.clearCookies({ name: c.name });
  await S.context.addCookies([{ name: base, value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }]);
  return session.access_token;
}
export const sessionIds = (userId) => q(`select id from auth.sessions where user_id = '${userId}' order by created_at`).split("\n").filter(Boolean);

// ------------------------------------------------------------------------------------------------ UI drivers (/platform/sms)
export async function openSms(S) {
  await S.page.goto("/platform/sms");
  await openAll(S);
  await S.page.locator("#price-changes").waitFor({ timeout: 30000 });
}
export const openAll = (S) => S.page.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
const keys = (S) => S.page.locator('section[aria-label="Hardware keys for price authorization"]');
const idleBtn = (S) => keys(S).getByRole("button", { name: "Lift suspension" });

/** drive one hardware-key section action and return the message it displays */
async function keysAct(S, click) {
  await openAll(S);
  await click();
  const msg = keys(S).locator("p[role=status]");
  const shown = await msg.waitFor({ timeout: 45000 }).then(() => true, () => false);
  if (!shown) return "TIMEOUT: no message within 45 s (the browser kept waiting for an authenticator)";
  await idleBtn(S).and(S.page.locator(":not([disabled])")).waitFor({ timeout: 60000 }).catch(() => {});
  await sleep(250);
  return seen((await msg.innerText()).trim(), "keys");
}
export async function requestKey(S, label, role) {
  await openAll(S);
  await keys(S).getByLabel("Label").fill(label);
  await keys(S).getByLabel("Role").selectOption(role);
  return keysAct(S, () => keys(S).getByRole("button", { name: "Request a new key" }).click());
}
export const keyListText = async (S) => (await keys(S).locator("ul").innerText()).trim();
export function applyPending(S, labelPart) {
  return keysAct(S, () => keys(S).locator("li", { hasText: new RegExp(`Pending .*${labelPart}`) }).getByRole("button", { name: "Apply" }).click());
}
export function cancelPending(S, labelPart) {
  return keysAct(S, () => keys(S).locator("li", { hasText: new RegExp(`Pending .*${labelPart}`) }).getByRole("button", { name: /^Cancel with/ }).click());
}
export function revokeKey(S, labelPart) {
  return keysAct(S, () => keys(S).locator("li", { hasText: new RegExp(`^${labelPart} \\(`) }).getByRole("button", { name: /Revoke now/ }).click());
}
export const thaw = (S) => keysAct(S, () => keys(S).getByRole("button", { name: "Lift suspension" }).click());
export const recoveryFreeze = (S) => keysAct(S, () => keys(S).getByRole("button", { name: "Freeze with recovery key" }).click());
export async function recoveryStart(S, label) {
  await openAll(S);
  await keys(S).getByLabel("Label").fill(label);
  return keysAct(S, () => keys(S).getByRole("button", { name: "Start recovery (new primary)" }).click());
}

/** submit a server-action form of the price section, return {ok, text} from the flash banner */
export async function submitPriceForm(S, formButtonName, fields) {
  await openSms(S);
  const form = S.page.locator("#price-changes form", { has: S.page.getByRole("button", { name: formButtonName }) });
  for (const [k, v] of Object.entries(fields)) {
    const el = form.locator(`[name=${k}]`);
    if (k === "kind") await el.selectOption(v); else await el.fill(v);
  }
  await Promise.all([S.page.waitForURL(/price(_error)?=1/, { timeout: 60000 }), form.getByRole("button", { name: formButtonName }).click()]);
  await S.page.locator("#price-changes").waitFor();
  const ok = S.page.url().includes("price=1");
  const banner = S.page.locator(ok ? "#price-changes p[role=status]" : "#price-changes p[role=alert]").first();
  const text = (await banner.innerText().catch(() => "")).trim();
  seen(text, "flash");
  return { ok, text };
}
export const propose = (S, kind, customer, provider, description, reason) => submitPriceForm(S, "Propose price change", { kind, customerUsd: customer, providerUsd: provider, description, reason });
export const freezeUi = (S, reason) => submitPriceForm(S, "Suspend price publication", { reason });
export const reviseUi = (S, requestId, customer, provider, description, reason) =>
  (async () => {
    await openSms(S);
    const form = S.page.locator("#price-changes form", { has: S.page.getByRole("button", { name: "Revise and restart the cooling-off" }) }).filter({ has: S.page.locator(`input[name=requestId][value="${requestId}"]`) });
    await form.locator("[name=customerUsd]").fill(customer);
    await form.locator("[name=providerUsd]").fill(provider);
    await form.locator("[name=description]").fill(description);
    await form.locator("[name=reason]").fill(reason);
    await Promise.all([S.page.waitForURL(/price(_error)?=1/, { timeout: 60000 }), form.getByRole("button", { name: "Revise and restart the cooling-off" }).click()]);
    const ok = S.page.url().includes("price=1");
    const text = (await S.page.locator(ok ? "#price-changes p[role=status]" : "#price-changes p[role=alert]").first().innerText().catch(() => "")).trim();
    seen(text, "flash");
    return { ok, text };
  })();

const reqLi = (S, requestId) => S.page.locator("#price-changes li", { hasText: requestId.slice(0, 8) }).filter({ hasText: "Mandatory cooling-off" }).first();
/** Authorize button of one proposal: returns {summary, message} ; message undefined while the challenge summary is on screen */
export async function authorizeBegin(S, requestId) {
  await openSms(S);
  const li = reqLi(S, requestId);
  await li.getByRole("button", { name: "Authorize with my hardware key" }).click();
  const sign = li.getByRole("button", { name: "Sign with the hardware key" });
  const msg = li.locator("p[role=status]");
  await Promise.race([sign.waitFor({ timeout: 30000 }), msg.waitFor({ timeout: 30000 })]).catch(() => {});
  const summary = (await sign.count()) ? (await li.locator("ul.list-disc").innerText().catch(() => "")).trim() : null;
  const message = (await msg.count()) ? seen((await msg.innerText()).trim(), "authorize") : null;
  return { summary, message };
}
export async function authorizeSign(S, requestId) {
  const li = reqLi(S, requestId);
  const msg = li.locator("p[role=status]");
  await li.getByRole("button", { name: "Sign with the hardware key" }).click();
  await msg.waitFor({ timeout: 90000 });
  await sleep(200);
  return seen((await msg.innerText()).trim(), "authorize");
}

export async function signClick(S, requestId) {
  await reqLi(S, requestId).getByRole("button", { name: "Sign with the hardware key" }).click();
}
export async function signMessage(S, requestId, timeout = 90000) {
  const msg = reqLi(S, requestId).locator("p[role=status]");
  await msg.waitFor({ timeout });
  await sleep(200);
  return seen((await msg.innerText()).trim(), "authorize");
}
/** the owner withdraws a proposal at database level (cleanup between scenarios only) */
export const withdraw = (id, adminId) => q(`select public._tw4price_do_reject('${id}', '${adminId}', 'withdrawn by the browser harness')`);

// ------------------------------------------------------------------------------------------------ DB readers
export const activeKeys = () => q("select coalesce(string_agg(label || ':' || role, ',' order by enrolled_at, label), '') from public.studio_sms_price_credentials where status = 'active'");
export const countActive = () => Number(q("select count(*) from public.studio_sms_price_credentials where status = 'active'"));
export const keyStatus = (label) => q(`select coalesce(max(status), 'none') from public.studio_sms_price_credentials where label = ${lit(label)}`);
export const activePrice = (kind) => q(`select coalesce(max(customer_price_cents)::text, 'none') from public.studio_sms_price_list where kind = ${lit(kind)} and active`);
export const latestRequest = (status = "pending") => q(`select id from public.studio_sms_price_change_requests where status = ${lit(status)} order by requested_at desc limit 1`);
export const requestRow = (id) => q(`select status || '|' || approval_mode || '|v' || proposal_version || '|' || customer_price_cents from public.studio_sms_price_change_requests where id = '${id}'`);
export const audit = (event) => Number(q(`select count(*) from public.studio_sms_price_audit where event = ${lit(event)}`));
export const cfg = (col) => q(`select ${col}::text from public.studio_sms_price_auth_config`);
export const suspended = () => q("select public._tw4price_suspended()::text");
export { q, psql, sleep };

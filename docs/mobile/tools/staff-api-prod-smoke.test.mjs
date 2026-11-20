/*
  Offline self-test of staff-api-prod-smoke.mjs:  node --test docs/mobile/tools/staff-api-prod-smoke.test.mjs
  Everything runs against loopback servers: a fake Supabase token endpoint and a fake staff API (plus, in one test, the repository's
  existing mock-staff-api.mjs). It never touches production. It proves the PASS/FAIL logic, GET-only, and that no credential, token,
  email or id reaches stdout, stderr or the saved summary.
*/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "staff-api-prod-smoke.mjs");
const FAKE = {
  email: "owner.secret@example.test",
  password: "Pa55-w0rd-secret!",
  otp: "482913",
  token: "fake-access-token-AAAA-1111-ZZZZ",
  refresh: "fake-refresh-token-BBBB-2222-YYYY",
  userId: "11111111-1111-4111-8111-111111111111",
  studioId: "22222222-2222-4222-8222-222222222222",
  clientId: "33333333-3333-4333-8333-333333333333",
  apptId: "44444444-4444-4444-8444-444444444444",
  name: "Zelda Fakename",
};

const row = () => ({ id: FAKE.apptId, title: null, appointmentType: "private_lesson", status: "scheduled", startsAt: "2026-11-20T15:00:00.000Z", endsAt: "2026-11-20T15:45:00.000Z", room: { id: "r", name: "Main" }, locationName: null, client: { id: FAKE.clientId, firstName: "Zelda", lastName: "Fakename" }, partner: null });

function staffApp(opts = {}) {
  const role = opts.role ?? "studio_owner";
  const broad = ["studio_owner", "studio_admin", "front_desk"].includes(role);
  const calls = [];
  const state = { limitedOnce: false };
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": opts.noCacheHeader ? "public" : "private, no-store", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${FAKE.token}`) return send(401, { error: "Authentication required.", code: "unauthenticated" });
    const p = new URL(req.url, "http://x").pathname.replace("/api/staff", "");
    if (p === "/me") return send(200, { user: { id: FAKE.userId, email: FAKE.email, fullName: FAKE.name }, workspaces: [{ studioId: FAKE.studioId, name: "Studio", publicName: null, slug: "s", role, timeZone: "America/New_York", accessAllowed: true, subscriptionStatus: "active", capabilities: { viewClients: broad } }] });
    if (p.endsWith("/today")) {
      if (opts.limitFirstToday && !state.limitedOnce) {
        state.limitedOnce = true;
        return send(429, { error: "Too many requests. Try again in a moment.", code: "rate_limited" }, { "retry-after": "1", "x-ratelimit-limit": "240" });
      }
      return send(200, { studioId: FAKE.studioId, date: "2026-11-20", timeZone: "America/New_York", instructorId: null, appointments: [row()] });
    }
    if (p.endsWith("/schedule")) return broad ? send(200, { studioId: FAKE.studioId, date: "2026-11-20", timeZone: "America/New_York", truncated: false, appointments: [{ ...row(), instructor: null }] }) : send(403, { error: "no", code: "role_not_permitted" });
    if (p.endsWith("/pulse")) {
      if (opts.badPulse) return send(200, { studioId: FAKE.studioId, today: "oops", leak: FAKE.token });
      return send(200, { studioId: FAKE.studioId, timeZone: "America/New_York", date: "2026-11-20", asOf: "2026-11-20T15:00:00.000Z", scope: broad ? "studio" : "own", instructorId: null, today: { total: 1, upcoming: 1, cancelled: 0, truncated: false }, next: null, newClientsLast7Days: 2 });
    }
    if (/\/clients\/[^/]+$/.test(p)) return send(200, { client: { id: FAKE.clientId, firstName: "Zelda", lastName: "Fakename", status: "active" }, timeZone: "America/New_York", activePackages: [], nextAppointment: null });
    if (p.endsWith("/clients")) return send(200, { clients: [{ id: FAKE.clientId, firstName: "Zelda", lastName: "Fakename", status: "active" }], nextCursor: null });
    if (/\/appointments\/[^/]+$/.test(p)) return send(200, { ...row(), studioId: FAKE.studioId, timeZone: "America/New_York", accessScope: "broad", notes: "private note", instructor: null });
    send(404, { error: "Not found", code: "not_found" });
  });
  return { server, calls };
}

function gotrue(opts = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url });
      const send = (c, j) => {
        res.writeHead(c, { "content-type": "application/json" });
        res.end(JSON.stringify(j));
      };
      const b = body ? JSON.parse(body) : {};
      const ok = { access_token: FAKE.token, refresh_token: FAKE.refresh, token_type: "bearer", user: { id: FAKE.userId, email: FAKE.email } };
      if (req.url.startsWith("/auth/v1/token?grant_type=password")) return b.email === FAKE.email && b.password === FAKE.password ? send(200, ok) : send(400, { error_code: "invalid_credentials", msg: `bad login for ${b.email}` });
      if (req.url === "/auth/v1/otp") return send(200, {});
      if (req.url === "/auth/v1/verify") return b.token === FAKE.otp && b.email === FAKE.email ? send(200, ok) : send(403, { error_code: "otp_expired" });
      send(404, {});
    });
  });
  return { server, calls };
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function runSmoke({ staff, auth, stdin, extra = [] }) {
  const sp = await listen(staff.server);
  const ap = await listen(auth.server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
  const envFile = path.join(dir, "business.env");
  fs.writeFileSync(envFile, `EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:${ap}\nEXPO_PUBLIC_SUPABASE_ANON_KEY=anon-public-key-for-test-only\nEXPO_PUBLIC_DANCEFLOW_WEB_URL=https://www.idanceflow.com\n`);
  const out = path.join(dir, "summary.txt");
  const child = spawn(process.execPath, [SCRIPT, "--public-env", envFile, "--out", out, "--base-url", `http://127.0.0.1:${sp}`, ...extra], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(stdin);
  const code = await new Promise((resolve) => child.on("close", resolve));
  staff.server.close();
  auth.server.close();
  const summary = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  const files = fs.readdirSync(dir);
  return { code, stdout, stderr, summary, files, dir };
}

function assertNoLeak(r, extraSecrets = []) {
  const all = [r.stdout, r.stderr, r.summary].join("\n");
  for (const v of [FAKE.email, FAKE.password, FAKE.otp, FAKE.token, FAKE.refresh, FAKE.userId, FAKE.studioId, FAKE.clientId, FAKE.apptId, FAKE.name, "Zelda", "private note", "anon-public-key", ...extraSecrets]) {
    assert.ok(!all.toLowerCase().includes(String(v).toLowerCase()), `output or summary leaked ${v.slice(0, 6)}...`);
  }
  assert.deepEqual(r.files.sort(), ["business.env", "summary.txt"].filter((f) => r.files.includes(f)).sort(), "no other file was written beside the env file and the summary");
}

test("owner, password sign-in: all calls PASS, GET only, nothing leaks", async () => {
  const staff = staffApp();
  const auth = gotrue();
  const r = await runSmoke({ staff, auth, stdin: `${FAKE.email}\n${FAKE.password}\n` });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  for (const p of ["/me", "/workspaces/:studioId/today", "/workspaces/:studioId/schedule", "/workspaces/:studioId/pulse", "/workspaces/:studioId/clients?q=", "/workspaces/:studioId/clients/:clientId", "/workspaces/:studioId/appointments/:appointmentId"]) {
    assert.match(r.summary, new RegExp(`PASS\\s+GET ${p.replace(/[?:/]/g, (c) => "\\" + c)}\\s`), `missing PASS for ${p}`);
  }
  assert.match(r.summary, /RESULT: PASS/);
  assert.match(r.summary, /ROLE\s+studio_owner/);
  assert.match(r.summary, /HEADERS seen \(names only\): cache-control/);
  assert.ok(staff.calls.length >= 7 && staff.calls.every((c) => c.method === "GET"), "only GET requests reach the staff API");
  assert.ok(auth.calls.every((c) => c.method === "POST") && auth.calls.length === 1, "one password grant, nothing else");
  assertNoLeak(r);
});

test("OTP flow signs in and passes", async () => {
  const r = await runSmoke({ staff: staffApp({ role: "front_desk" }), auth: gotrue(), stdin: `${FAKE.email}\n${FAKE.otp}\n`, extra: ["--otp"] });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.summary, /auth=otp/);
  assert.match(r.summary, /PASS\s+GET \/workspaces\/:studioId\/schedule/);
  assertNoLeak(r);
});

test("instructor: /schedule 403 is EXPECT (not PASS, not FAIL), so a build cannot enable the studio-day feature from it", async () => {
  const r = await runSmoke({ staff: staffApp({ role: "instructor" }), auth: gotrue(), stdin: `${FAKE.email}\n${FAKE.password}\n` });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.summary, /EXPECT\s+GET \/workspaces\/:studioId\/schedule\s+403/);
  assert.doesNotMatch(r.summary, /PASS\s+GET \/workspaces\/:studioId\/schedule/);
  assertNoLeak(r);
});

test("a wrong shape fails the run (exit 1), names only keys, and never echoes the response body", async () => {
  const r = await runSmoke({ staff: staffApp({ badPulse: true }), auth: gotrue(), stdin: `${FAKE.email}\n${FAKE.password}\n` });
  assert.equal(r.code, 1);
  assert.match(r.summary, /FAIL\s+GET \/workspaces\/:studioId\/pulse\s+200/);
  assert.match(r.summary, /RESULT: FAIL/);
  assert.doesNotMatch(r.summary, /PASS\s+GET \/workspaces\/:studioId\/pulse/);
  assertNoLeak(r);
});

test("a response without Cache-Control: no-store fails", async () => {
  const r = await runSmoke({ staff: staffApp({ noCacheHeader: true }), auth: gotrue(), stdin: `${FAKE.email}\n${FAKE.password}\n` });
  assert.equal(r.code, 1);
  assert.match(r.summary, /Cache-Control lacks no-store/);
});

test("a 429 is waited out once (Retry-After) and then passes", async () => {
  const staff = staffApp({ limitFirstToday: true });
  const t0 = Date.now();
  const r = await runSmoke({ staff, auth: gotrue(), stdin: `${FAKE.email}\n${FAKE.password}\n` });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(Date.now() - t0 >= 1000, "waited for Retry-After");
  assert.equal(staff.calls.filter((c) => c.url.includes("/today")).length, 2, "exactly one retry");
  assert.match(r.summary, /NOTE\s+429 received/);
  assert.match(r.summary, /x-ratelimit-limit/);
  assertNoLeak(r);
});

test("wrong password: exit 2, no staff call is made, the server's echoed email never appears", async () => {
  const staff = staffApp();
  const r = await runSmoke({ staff, auth: gotrue(), stdin: `${FAKE.email}\nnot-the-password\n` });
  assert.equal(r.code, 2);
  assert.equal(staff.calls.length, 0);
  assert.match(r.stderr, /Sign-in failed \(HTTP 400, invalid_credentials\)/);
  assert.ok(!(r.stdout + r.stderr).includes(FAKE.email));
  assert.ok(!(r.stdout + r.stderr).includes("not-the-password"));
});

test("refuses to send credentials to any host except production or loopback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-evil-"));
  const envFile = path.join(dir, "business.env");
  fs.writeFileSync(envFile, "EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:9\nEXPO_PUBLIC_SUPABASE_ANON_KEY=anon-public-key-for-test-only\n");
  const child = spawn(process.execPath, [SCRIPT, "--base-url", "https://evil.example.test", "--public-env", envFile], { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  child.stdin.end("");
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 2);
  assert.match(err, /Refusing to send credentials to evil.example.test/);
});

test("the script has no write verbs and never touches process.env for secrets", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(!/method:\s*"(PUT|PATCH|DELETE)"/.test(src), "no PUT/PATCH/DELETE");
  const posts = [...src.matchAll(/method:\s*"POST"/g)].length;
  assert.equal(posts, 1, "the only POST is the GoTrue sign-in helper");
  assert.ok(!/process\.env\.[A-Z_]*(TOKEN|PASSWORD)/.test(src) && !/env\[["'](TOKEN|PASSWORD)/.test(src));
  assert.ok(!/writeFileSync\([^)]*token/i.test(src));
});

let mock;
before(() => {});
after(() => mock?.kill());

test("against the repository's existing mock staff API: shape checks run, routes the mock does not serve FAIL", async () => {
  const mockPath = path.resolve(here, "..", "screenshots", "business-shell", "dark", "mock-staff-api.mjs");
  if (!fs.existsSync(mockPath)) return;
  mock = spawn(process.execPath, [mockPath], { stdio: "ignore" }); // listens on 127.0.0.1:3100
  await new Promise((resolve) => setTimeout(resolve, 800));
  const auth = gotrue();
  const ap = await listen(auth.server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-mock-"));
  const envFile = path.join(dir, "business.env");
  fs.writeFileSync(envFile, `EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:${ap}\nEXPO_PUBLIC_SUPABASE_ANON_KEY=anon-public-key-for-test-only\n`);
  const out = path.join(dir, "summary.txt");
  // the existing mock accepts any bearer; our fake token endpoint supplies one
  const child = spawn(process.execPath, [SCRIPT, "--public-env", envFile, "--out", out, "--base-url", "http://127.0.0.1:3100"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stdin.end(`${FAKE.email}\n${FAKE.password}\n`);
  const code = await new Promise((resolve) => child.on("close", resolve));
  auth.server.close();
  mock.kill();
  const summary = fs.readFileSync(out, "utf8");
  assert.equal(code, 1, "the mock has no /schedule or /pulse, and sends no Cache-Control, so the run must FAIL");
  assert.match(summary, /FAIL\s+GET \/workspaces\/:studioId\/pulse/);
  assert.ok(!summary.includes(FAKE.token) && !summary.includes(FAKE.password) && !summary.includes(FAKE.email));
});

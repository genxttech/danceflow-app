// Staff API end-to-end QA: real GoTrue tokens -> HTTP -> local Next dev server -> real supabase-js -> Kong -> PostgREST -> Postgres. Disposable local stack only.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

process.env.MSYS_NO_PATHCONV = "1";
const STACK = process.env.TW4A_LOCAL_URL;
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET;
const DB = process.env.TW4A_LOCAL_DB_CONTAINER;
const APP = process.env.STAFF_QA_APP ?? "http://localhost:3107";
const AUTH_CONTAINER = process.env.STAFF_QA_AUTH_CONTAINER;
const OUT = process.env.STAFF_QA_OUT;
for (const [k, v] of Object.entries({ STACK, SECRET, DB, AUTH_CONTAINER, OUT })) if (!v) throw new Error(`missing ${k}`);
for (const u of [STACK, APP]) if (!["127.0.0.1", "localhost"].includes(new URL(u).hostname)) throw new Error(`refusing non-loopback ${u}`);

const b64u = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const sign = (payload, secret = SECRET) => {
  const head = b64u({ alg: "HS256", typ: "JWT" });
  const body = b64u(payload);
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
};
const now = () => Math.floor(Date.now() / 1000);
const SERVICE = sign({ role: "service_role", iss: "supabase", exp: now() + 3600 });
const ANON = sign({ role: "anon", iss: "supabase", exp: now() + 3600 });
const psql = (sql) => execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" }).trim();

async function gotrue(method, path, body, token = SERVICE) {
  const res = await fetch(`${STACK}/auth/v1${path}`, {
    method,
    headers: { apikey: ANON, "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GoTrue ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const RUN = randomBytes(3).toString("hex");
const PASSWORD = randomBytes(18).toString("base64url"); // throwaway, this process only, never logged
const labels = ["instructorA", "colleagueA", "instructorB", "ownerA", "independentA", "deactivated", "platformAdmin", "banned", "loggedOut", "student"];
const users = {};
for (const label of labels) {
  const email = `staffhttp-${label.toLowerCase()}-${RUN}@example.test`;
  const created = await gotrue("POST", "/admin/users", { email, password: PASSWORD, email_confirm: true });
  users[label] = { id: created.id, email };
}
const signIn = async (label) =>
  (await gotrue("POST", "/token?grant_type=password", { email: users[label].email, password: PASSWORD }, ANON));
const sessions = {};
for (const label of labels) sessions[label] = await signIn(label);
const token = (label) => sessions[label].access_token;

const STUDIO_A = randomUUID(), STUDIO_B = randomUUID(), STUDIO_PAUSED = randomUUID();
const INS_A = randomUUID(), INS_COL = randomUUID(), INS_B = randomUUID();
const CLI_OWN = randomUUID(), CLI_COL = randomUUID(), CLI_B = randomUUID();
const ROOM = randomUUID();
const APPT_LESSON = randomUUID(), APPT_CLASS = randomUUID(), APPT_COL = randomUUID(), APPT_B = randomUUID();
const DAY = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const at = (t) => `${DAY}T${t}:00Z`;
const id = (label) => users[label].id;

psql(`begin;
set local session_replication_role = replica;
${labels.map((l) => `insert into public.profiles (id, email, full_name, platform_role) values ('${id(l)}', '${users[l].email}', 'QA ${l}', ${l === "platformAdmin" ? "'platform_admin'" : "null"}) on conflict (id) do update set full_name = excluded.full_name, platform_role = excluded.platform_role;`).join("\n")}
insert into public.user_account_status (user_id, status, deactivated_at) values ('${id("deactivated")}', 'deactivated', now());
insert into public.studios (id, name, slug, subscription_status, timezone) values
  ('${STUDIO_A}', 'HTTP QA Studio A', 'http-qa-a-${RUN}', 'active', 'America/New_York'),
  ('${STUDIO_B}', 'HTTP QA Studio B', 'http-qa-b-${RUN}', 'active', 'America/Chicago'),
  ('${STUDIO_PAUSED}', 'HTTP QA Paused', 'http-qa-p-${RUN}', 'past_due', 'America/New_York');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${id("instructorA")}', '${STUDIO_A}', 'instructor', true), ('${id("instructorA")}', '${STUDIO_PAUSED}', 'instructor', true),
  ('${id("colleagueA")}', '${STUDIO_A}', 'instructor', true), ('${id("instructorB")}', '${STUDIO_B}', 'instructor', true),
  ('${id("ownerA")}', '${STUDIO_A}', 'studio_owner', true), ('${id("independentA")}', '${STUDIO_A}', 'independent_instructor', true),
  ('${id("deactivated")}', '${STUDIO_A}', 'instructor', true), ('${id("platformAdmin")}', '${STUDIO_A}', 'studio_owner', true),
  ('${id("banned")}', '${STUDIO_A}', 'instructor', true), ('${id("loggedOut")}', '${STUDIO_A}', 'instructor', true);
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('${INS_A}', '${STUDIO_A}', '${id("instructorA")}', 'Ida', 'Teacher', true, true),
  ('${INS_COL}', '${STUDIO_A}', '${id("colleagueA")}', 'Cole', 'Teacher', true, true),
  ('${INS_B}', '${STUDIO_B}', '${id("instructorB")}', 'Bo', 'Teacher', true, true);
insert into public.clients (id, studio_id, first_name, last_name, email, phone, referral_source) values
  ('${CLI_OWN}', '${STUDIO_A}', 'Ana', 'Dancer', 'ana@example.test', '555-0101', 'secret-referral'),
  ('${CLI_COL}', '${STUDIO_A}', 'Colin', 'Dancer', 'colin@example.test', '555-0102', 'secret-referral'),
  ('${CLI_B}', '${STUDIO_B}', 'Bea', 'Elsewhere', 'bea@example.test', '555-0103', null);
insert into public.rooms (id, studio_id, name) values ('${ROOM}', '${STUDIO_A}', 'Main Floor');
insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, room_id, starts_at, ends_at, title, notes, status, price_amount, payment_status, roster_capacity) values
  ('${APPT_LESSON}', '${STUDIO_A}', '${INS_A}', 'private_lesson', '${CLI_OWN}', '${ROOM}', '${at("15:00")}', '${at("15:45")}', 'Own lesson', 'teaching note', 'scheduled', 125, 'unpaid', null),
  ('${APPT_CLASS}', '${STUDIO_A}', '${INS_A}', 'group_class', null, '${ROOM}', '${at("17:00")}', '${at("18:00")}', 'Own class', null, 'scheduled', null, 'unpaid', 12),
  ('${APPT_COL}', '${STUDIO_A}', '${INS_COL}', 'private_lesson', '${CLI_COL}', '${ROOM}', '${at("16:00")}', '${at("16:45")}', 'Colleague lesson', 'colleague note', 'scheduled', 90, 'paid', null),
  ('${APPT_B}', '${STUDIO_B}', '${INS_B}', 'private_lesson', '${CLI_B}', null, '${at("15:00")}', '${at("15:45")}', 'Studio B lesson', null, 'scheduled', 80, 'unpaid', null);
insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status) values
  ('${STUDIO_A}', '${APPT_CLASS}', '${CLI_OWN}', 'staff', 'booked'), ('${STUDIO_A}', '${APPT_CLASS}', '${CLI_COL}', 'staff', 'booked');
insert into public.lesson_recaps (studio_id, appointment_id, client_id, summary, homework, next_focus, visible_to_client) values
  ('${STUDIO_A}', '${APPT_LESSON}', '${CLI_OWN}', 'Worked on frame', 'Box step', 'Timing', true);
commit;`);

const results = [];
async function call(name, path, { auth, headers = {}, expect }) {
  const res = await fetch(`${APP}${path}`, {
    redirect: "manual",
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  const problems = [];
  if (res.status !== expect.status) problems.push(`status ${res.status} != ${expect.status}`);
  if (res.headers.get("location")) problems.push(`redirect to ${res.headers.get("location")}`);
  if (!String(res.headers.get("content-type")).includes("application/json")) problems.push(`content-type ${res.headers.get("content-type")}`);
  if (res.headers.get("cache-control") !== "private, no-store") problems.push(`cache-control ${res.headers.get("cache-control")}`);
  if (expect.code && body?.code !== expect.code) problems.push(`code ${body?.code} != ${expect.code}`);
  for (const leak of expect.noLeak ?? []) if (text.includes(leak)) problems.push(`leaks "${leak}"`);
  if (expect.check) { const msg = expect.check(body); if (msg) problems.push(msg); }
  results.push({ name, path: path.replace(/[0-9a-f-]{36}/g, "<id>"), status: res.status, code: body?.code ?? null, result: problems.length ? "FAIL" : "PASS", problems });
}
const LEAKS = ["price", "payment", "billing", "referral", "555-01", "ana@example", "Unnamed"];
const ws = (s) => `/api/staff/workspaces/${s}`;

// Authentication
await call("me: no token", "/api/staff/me", { expect: { status: 401, code: "unauthenticated" } });
await call("today: no token", `${ws(STUDIO_A)}/today?date=${DAY}`, { expect: { status: 401, code: "unauthenticated" } });
await call("detail: no token", `${ws(STUDIO_A)}/appointments/${APPT_LESSON}`, { expect: { status: 401, code: "unauthenticated" } });
await call("me: Supabase session cookie only", "/api/staff/me", {
  headers: { cookie: `sb-127-auth-token=${encodeURIComponent(JSON.stringify(sessions.instructorA))}` },
  expect: { status: 401, code: "unauthenticated" },
});
await call("me: student API header only", "/api/staff/me", { headers: { "x-danceflow-access-token": token("instructorA") }, expect: { status: 401, code: "unauthenticated" } });
await call("me: token signed with wrong secret", "/api/staff/me", { auth: sign({ sub: id("instructorA"), role: "authenticated", exp: now() + 600 }, "wrong-secret"), expect: { status: 401, code: "unauthenticated" } });
await call("me: expired token (right secret)", "/api/staff/me", { auth: sign({ sub: id("instructorA"), role: "authenticated", aud: "authenticated", exp: now() - 60 }), expect: { status: 401, code: "unauthenticated" } });
await call("me: anon key as bearer", "/api/staff/me", { auth: ANON, expect: { status: 401, code: "unauthenticated" } });

// Real GoTrue session lifecycle
await gotrue("POST", "/logout?scope=global", undefined, token("loggedOut"));
await call("me: token after GoTrue logout", "/api/staff/me", { auth: token("loggedOut"), expect: { status: 401, code: "unauthenticated" } });
await gotrue("PUT", `/admin/users/${id("banned")}`, { ban_duration: "24h" });
const bannedProbe = await fetch(`${APP}/api/staff/me`, { headers: { authorization: `Bearer ${token("banned")}` }, redirect: "manual" });
const bannedBody = await bannedProbe.json().catch(() => null);
results.push({
  name: "me: token issued before a GoTrue ban",
  path: "/api/staff/me",
  status: bannedProbe.status,
  code: bannedBody?.code ?? null,
  result: [401, 403].includes(bannedProbe.status) && ["unauthenticated", "account_inactive"].includes(bannedBody?.code) ? "PASS" : "FAIL",
  problems: [],
});
const refreshed = await gotrue("POST", "/token?grant_type=refresh_token", { refresh_token: sessions.instructorA.refresh_token }, ANON);
await call("me: token from a real refresh", "/api/staff/me", { auth: refreshed.access_token, expect: { status: 200 } });

// Account standing
await call("me: deactivated account", "/api/staff/me", { auth: token("deactivated"), expect: { status: 403, code: "account_inactive" } });
await call("me: platform admin", "/api/staff/me", { auth: token("platformAdmin"), expect: { status: 403, code: "platform_admin_unsupported" } });

// /me
await call("me: instructor", "/api/staff/me", {
  auth: token("instructorA"),
  expect: {
    status: 200,
    check: (b) => {
      const ids = (b?.workspaces ?? []).map((w) => w.studioId).sort();
      if (JSON.stringify(ids) !== JSON.stringify([STUDIO_A, STUDIO_PAUSED].sort())) return `workspaces ${ids}`;
      const a = b.workspaces.find((w) => w.studioId === STUDIO_A);
      const p = b.workspaces.find((w) => w.studioId === STUDIO_PAUSED);
      if (a.role !== "instructor" || a.accessAllowed !== true || a.capabilities?.viewStudioSchedule !== true || a.capabilities?.viewClients !== false) return "studio A entry wrong";
      if (p.accessAllowed !== false || p.subscriptionStatus !== "past_due") return "paused entry wrong";
      return null;
    },
  },
});
await call("me: student with no staff role", "/api/staff/me", { auth: token("student"), expect: { status: 200, check: (b) => (b?.workspaces?.length === 0 ? null : "expected no workspaces") } });

// Workspace boundary
await call("today: wrong studio", `${ws(STUDIO_B)}/today?date=${DAY}`, { auth: token("instructorA"), expect: { status: 403, code: "not_a_member" } });
await call("detail: wrong studio", `${ws(STUDIO_B)}/appointments/${APPT_B}`, { auth: token("instructorA"), expect: { status: 403, code: "not_a_member" } });
await call("today: studio that does not exist", `${ws(randomUUID())}/today?date=${DAY}`, { auth: token("instructorA"), expect: { status: 403, code: "not_a_member" } });
await call("today: paused studio", `${ws(STUDIO_PAUSED)}/today?date=${DAY}`, { auth: token("instructorA"), expect: { status: 403, code: "workspace_paused" } });
await call("today: malformed studio id", `${ws("not-a-uuid")}/today`, { auth: token("instructorA"), expect: { status: 400, code: "invalid_request" } });
await call("today: malformed date", `${ws(STUDIO_A)}/today?date=2026-02-30`, { auth: token("instructorA"), expect: { status: 400, code: "invalid_request" } });
await call("today: independent instructor", `${ws(STUDIO_A)}/today?date=${DAY}`, { auth: token("independentA"), expect: { status: 403, code: "role_not_permitted" } });

// Instructor projections
await call("today: instructor's own day", `${ws(STUDIO_A)}/today?date=${DAY}`, {
  auth: token("instructorA"),
  expect: {
    status: 200,
    noLeak: [...LEAKS, "Colleague lesson", "Studio B", "notes"],
    check: (b) => {
      const ids = (b?.appointments ?? []).map((a) => a.id);
      if (JSON.stringify(ids) !== JSON.stringify([APPT_LESSON, APPT_CLASS])) return `appointments ${ids}`;
      const lesson = b.appointments[0];
      const keys = Object.keys(lesson).sort().join(",");
      if (keys !== "appointmentType,client,endsAt,id,locationName,partner,room,startsAt,status,title") return `lesson keys ${keys}`;
      if (lesson.client?.firstName !== "Ana" || lesson.room?.name !== "Main Floor") return "lesson projection wrong";
      if (b.instructorId !== INS_A || b.timeZone !== "America/New_York" || b.date !== DAY) return "day header wrong";
      return null;
    },
  },
});
await call("detail: instructor's own lesson", `${ws(STUDIO_A)}/appointments/${APPT_LESSON}`, {
  auth: token("instructorA"),
  expect: {
    status: 200,
    noLeak: LEAKS,
    check: (b) =>
      b?.accessScope === "own-instructor" && b.notes === "teaching note" && b.recap?.summary === "Worked on frame" && b.instructor?.firstName === "Ida" && b.roster === null
        ? null
        : "lesson detail wrong",
  },
});
await call("detail: instructor's own class roster (RPC from #440)", `${ws(STUDIO_A)}/appointments/${APPT_CLASS}`, {
  auth: token("instructorA"),
  expect: {
    status: 200,
    noLeak: LEAKS,
    check: (b) => {
      const names = (b?.roster?.attendees ?? []).map((a) => a.name).sort();
      return JSON.stringify(names) === JSON.stringify(["Ana Dancer", "Colin Dancer"]) && b.roster.capacity === 12 ? null : `roster ${JSON.stringify(b?.roster)}`;
    },
  },
});
await call("detail: colleague's lesson", `${ws(STUDIO_A)}/appointments/${APPT_COL}`, { auth: token("instructorA"), expect: { status: 404, code: "not_found" } });
await call("detail: another studio's appointment via own studio", `${ws(STUDIO_A)}/appointments/${APPT_B}`, { auth: token("instructorA"), expect: { status: 404, code: "not_found" } });
await call("detail: colleague cannot read instructor A's class", `${ws(STUDIO_A)}/appointments/${APPT_CLASS}`, { auth: token("colleagueA"), expect: { status: 404, code: "not_found" } });
await call("detail: instructor B cannot reach studio A", `${ws(STUDIO_A)}/appointments/${APPT_CLASS}`, { auth: token("instructorB"), expect: { status: 403, code: "not_a_member" } });

// Broad staff
await call("detail: owner reads a colleague's lesson", `${ws(STUDIO_A)}/appointments/${APPT_COL}`, {
  auth: token("ownerA"),
  expect: { status: 200, noLeak: LEAKS, check: (b) => (b?.accessScope === "broad" && b.client?.firstName === "Colin" ? null : "owner detail wrong") },
});
await call("today: owner's own (empty) teaching day", `${ws(STUDIO_A)}/today?date=${DAY}`, {
  auth: token("ownerA"),
  expect: { status: 200, check: (b) => (b?.instructorId === null && b.appointments.length === 0 ? null : "owner today not empty") },
});

// Auth outage: stop GoTrue, expect 503 (not 401, so the app does not sign the user out)
execFileSync("docker", ["stop", AUTH_CONTAINER]);
try {
  await call("me: GoTrue down", "/api/staff/me", { auth: token("ownerA"), expect: { status: 503, code: "service_unavailable" } });
} finally {
  execFileSync("docker", ["start", AUTH_CONTAINER]);
}

writeFileSync(OUT, JSON.stringify({ day: DAY, gotrue: "v2.188.1", results }, null, 2));
const failed = results.filter((r) => r.result !== "PASS");
for (const r of results) console.log(`${r.result}  ${r.status} ${String(r.code ?? "").padEnd(26)} ${r.name}${r.problems.length ? `  <- ${r.problems.join("; ")}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

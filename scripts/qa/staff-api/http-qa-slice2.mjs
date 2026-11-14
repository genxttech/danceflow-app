// Staff API slice 2 end-to-end QA: real GoTrue tokens -> HTTP -> local Next dev server -> real supabase-js -> Kong -> PostgREST -> Postgres.
// Disposable local stack only (see README.md). Same environment as http-qa.mjs: TW4A_LOCAL_URL, TW4A_LOCAL_JWT_SECRET, TW4A_LOCAL_DB_CONTAINER,
// STAFF_QA_APP (default http://localhost:3107) and STAFF_QA_OUT (evidence JSON path).
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

process.env.MSYS_NO_PATHCONV = "1";
const STACK = process.env.TW4A_LOCAL_URL;
const SECRET = process.env.TW4A_LOCAL_JWT_SECRET;
const DB = process.env.TW4A_LOCAL_DB_CONTAINER;
const APP = process.env.STAFF_QA_APP ?? "http://localhost:3107";
const OUT = process.env.STAFF_QA_OUT;
for (const [k, v] of Object.entries({ STACK, SECRET, DB, OUT })) if (!v) throw new Error(`missing ${k}`);
for (const u of [STACK, APP]) if (!["127.0.0.1", "localhost"].includes(new URL(u).hostname)) throw new Error(`refusing non-loopback ${u}`);

const b64u = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const sign = (payload) => {
  const head = b64u({ alg: "HS256", typ: "JWT" });
  const body = b64u(payload);
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
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
const labels = ["frontDesk", "instructor", "colleague", "independent"];
const users = {};
for (const label of labels) {
  const email = `staffs2-${label.toLowerCase()}-${RUN}@example.test`;
  users[label] = { id: (await gotrue("POST", "/admin/users", { email, password: PASSWORD, email_confirm: true })).id, email };
}
const tokens = {};
for (const label of labels) tokens[label] = (await gotrue("POST", "/token?grant_type=password", { email: users[label].email, password: PASSWORD }, ANON)).access_token;
const uid = (l) => users[l].id;

const STUDIO = randomUUID();
const INS = randomUUID(), INS_COL = randomUUID();
const ANA = randomUUID(), COLIN = randomUUID(), LEE = randomUUID();
const LESSON = randomUUID(), CLASS = randomUUID(), CANCELLED = randomUUID();
const PKG = randomUUID();
const day = (n, t) => `${new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)}T${t}:00Z`;

psql(`begin;
set local session_replication_role = replica;
${labels.map((l) => `insert into public.profiles (id, email, full_name) values ('${uid(l)}', '${users[l].email}', 'QA ${l}') on conflict (id) do nothing;`).join("\n")}
insert into public.studios (id, name, slug, subscription_status, timezone) values ('${STUDIO}', 'HTTP Slice2 Studio', 'http-s2-${RUN}', 'active', 'America/Denver');
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${uid("frontDesk")}', '${STUDIO}', 'front_desk', true), ('${uid("instructor")}', '${STUDIO}', 'instructor', true),
  ('${uid("colleague")}', '${STUDIO}', 'instructor', true), ('${uid("independent")}', '${STUDIO}', 'independent_instructor', true);
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct) values
  ('${INS}', '${STUDIO}', '${uid("instructor")}', 'Ida', 'Teacher', true, true), ('${INS_COL}', '${STUDIO}', '${uid("colleague")}', 'Cole', 'Teacher', true, true);
insert into public.clients (id, studio_id, first_name, last_name, status, email, phone, referral_source) values
  ('${ANA}', '${STUDIO}', 'Ana', 'Alvarez', 'active', 'ana-s2@example.test', '555-0301', 'secret-referral'),
  ('${COLIN}', '${STUDIO}', 'Colin', 'Brook', 'active', 'colin-s2@example.test', '555-0302', null),
  ('${LEE}', '${STUDIO}', 'Lee', 'Dunn', 'lead', 'lee-s2@example.test', '555-0303', null);
insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, starts_at, ends_at, title, status, price_amount, payment_status, roster_capacity) values
  ('${LESSON}', '${STUDIO}', '${INS}', 'private_lesson', '${ANA}', '${day(3, "15:00")}', '${day(3, "15:45")}', 'Ana lesson', 'scheduled', 125, 'unpaid', null),
  ('${CLASS}', '${STUDIO}', '${INS}', 'group_class', null, '${day(2, "17:00")}', '${day(2, "18:00")}', 'Salsa', 'scheduled', null, 'unpaid', 12),
  ('${CANCELLED}', '${STUDIO}', '${INS}', 'group_class', null, '${day(4, "17:00")}', '${day(4, "18:00")}', 'Cancelled', 'cancelled', null, 'unpaid', 12);
insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status) values
  ('${STUDIO}', '${CLASS}', '${ANA}', 'staff', 'booked'), ('${STUDIO}', '${CLASS}', '${COLIN}', 'staff', 'booked'), ('${STUDIO}', '${CANCELLED}', '${ANA}', 'staff', 'booked');
insert into public.client_packages (id, studio_id, client_id, name_snapshot, active, archived_at, expiration_date, sold_price) values
  ('${PKG}', '${STUDIO}', '${ANA}', '10 Private Lessons', true, null, '${day(60, "00:00").slice(0, 10)}', 900);
insert into public.client_package_items (studio_id, client_package_id, usage_type, quantity_remaining, quantity_total, is_unlimited) values ('${STUDIO}', '${PKG}', 'private_lesson', 4, 10, false);
commit;`);

const results = [];
const LEAKS = ["price", "payment", "referral", "555-03", "@example.test", "Unnamed", "sold", "900"];
async function call(name, path, { token, method = "GET", headers = {}, body, expect }) {
  const res = await fetch(`${APP}${path}`, {
    method,
    redirect: "manual",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const problems = [];
  if (res.status !== expect.status) problems.push(`status ${res.status} != ${expect.status}`);
  if (res.headers.get("location")) problems.push(`redirect to ${res.headers.get("location")}`);
  if (!String(res.headers.get("content-type")).includes("application/json")) problems.push(`content-type ${res.headers.get("content-type")}`);
  if (res.headers.get("cache-control") !== "private, no-store") problems.push(`cache-control ${res.headers.get("cache-control")}`);
  if (expect.code && json?.code !== expect.code) problems.push(`code ${json?.code} != ${expect.code}`);
  if (expect.code && typeof json?.error !== "string") problems.push("error is not a flat string");
  for (const leak of expect.status === 200 ? LEAKS : []) if (!(expect.allow ?? []).includes(leak) && text.includes(leak)) problems.push(`leaks "${leak}"`);
  if (expect.check) { const msg = expect.check(json); if (msg) problems.push(msg); }
  results.push({ name, method, path: path.replace(/[0-9a-f-]{36}/g, "<id>"), status: res.status, code: json?.code ?? null, result: problems.length ? "FAIL" : "PASS", problems });
  return json;
}
const ws = `/api/staff/workspaces/${STUDIO}`;
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const key = () => `qa-${randomUUID()}`;
const attendance = (appointmentId, clientId) => psql(`select coalesce(string_agg(status || '|' || created_by::text || '|' || updated_at::text, ','), '') from public.attendance_records where appointment_id = '${appointmentId}' and client_id = '${clientId}';`);

// timeZone and timestamps
// /me returns the caller's OWN email by design; only that one address may appear.
await call("me: workspace carries the studio timeZone", "/api/staff/me", {
  token: tokens.frontDesk,
  expect: {
    status: 200,
    allow: ["@example.test"],
    check: (b) =>
      b?.workspaces?.[0]?.timeZone === "America/Denver" && b.user?.email === users.frontDesk.email && !JSON.stringify(b.workspaces).includes("@")
        ? null
        : `timeZone ${b?.workspaces?.[0]?.timeZone}`,
  },
});
await call("detail: timeZone and Z timestamps", `${ws}/appointments/${LESSON}`, {
  token: tokens.instructor,
  expect: { status: 200, check: (b) => (b?.timeZone === "America/Denver" && iso.test(b.startsAt) && iso.test(b.endsAt) ? null : `timeZone ${b?.timeZone} startsAt ${b?.startsAt}`) },
});

// client search
await call("clients: front desk sees active clients only", `${ws}/clients`, {
  token: tokens.frontDesk,
  expect: { status: 200, check: (b) => (JSON.stringify(b?.clients?.map((c) => c.id).sort()) === JSON.stringify([ANA, COLIN].sort()) && b.nextCursor === null && b.clients.every((c) => c.status === "active") ? null : JSON.stringify(b)) },
});
await call("clients: q filter", `${ws}/clients?q=brO`, { token: tokens.frontDesk, expect: { status: 200, check: (b) => (b?.clients?.length === 1 && b.clients[0].id === COLIN ? null : JSON.stringify(b)) } });
await call("clients: paging limit=1 returns a cursor", `${ws}/clients?limit=1`, { token: tokens.frontDesk, expect: { status: 200, check: (b) => (b?.clients?.length === 1 && typeof b.nextCursor === "string" ? null : JSON.stringify(b)) } });
await call("clients: instructor sees only the clients they teach", `${ws}/clients`, {
  token: tokens.instructor,
  expect: { status: 200, check: (b) => (JSON.stringify(b?.clients) === JSON.stringify([{ id: ANA, firstName: "Ana", lastName: "Alvarez", status: null }]) ? null : JSON.stringify(b)) },
});
await call("clients: independent instructor refused", `${ws}/clients`, { token: tokens.independent, expect: { status: 403, code: "role_not_permitted" } });
await call("clients: no token", `${ws}/clients`, { expect: { status: 401, code: "unauthenticated" } });
await call("clients: bad cursor", `${ws}/clients?cursor=%%%`, { token: tokens.frontDesk, expect: { status: 400, code: "invalid_request" } });

// client summary
await call("client: front desk summary with packages, next appointment and zone", `${ws}/clients/${ANA}`, {
  token: tokens.frontDesk,
  expect: {
    status: 200,
    check: (b) =>
      b?.client?.status === "active" && b.timeZone === "America/Denver" && b.activePackages?.[0]?.items?.[0]?.remaining === 4 && b.nextAppointment?.id === CLASS && iso.test(b.nextAppointment.startsAt)
        ? null
        : JSON.stringify(b),
  },
});
await call("client: instructor summary without status or packages", `${ws}/clients/${ANA}`, {
  token: tokens.instructor,
  expect: { status: 200, check: (b) => (b?.client?.status === null && b.activePackages === null && b.nextAppointment?.id === CLASS ? null : JSON.stringify(b)) },
});
await call("client: instructor refused a client they don't teach", `${ws}/clients/${LEE}`, { token: tokens.instructor, expect: { status: 404, code: "not_found" } });
await call("client: colleague refused", `${ws}/clients/${ANA}`, { token: tokens.colleague, expect: { status: 404, code: "not_found" } });

// attendance PUT
const put = (name, appointmentId, clientId, token, body, expect, headers = { "idempotency-key": key() }) =>
  call(name, `${ws}/appointments/${appointmentId}/attendance/${clientId}`, { token, method: "PUT", headers, body, expect });
await put("attendance: instructor marks a booked dancer present", CLASS, COLIN, tokens.instructor, { status: "attended" }, {
  status: 200,
  check: (b) => (b?.attendee?.clientId === COLIN && b.attendee.displayName === "Colin Brook" && b.attendee.status === "attended" && iso.test(b.attendee.updatedAt) ? null : JSON.stringify(b)),
});
const firstWrite = attendance(CLASS, COLIN);
const retryKey = key();
await put("attendance: retry with the same key writes nothing", CLASS, COLIN, tokens.instructor, { status: "attended" }, { status: 200 }, { "idempotency-key": retryKey });
const afterRetry = attendance(CLASS, COLIN);
results.push({ name: "attendance: database row unchanged by the retry", method: "SQL", path: "attendance_records", status: null, code: null, result: firstWrite && firstWrite === afterRetry ? "PASS" : "FAIL", problems: firstWrite === afterRetry ? [] : [`${firstWrite} -> ${afterRetry}`] });
results.push({ name: "attendance: row records the instructor as creator", method: "SQL", path: "attendance_records", status: null, code: null, result: firstWrite.includes(uid("instructor")) ? "PASS" : "FAIL", problems: [] });
await put("attendance: front desk marks no-show", CLASS, ANA, tokens.frontDesk, { status: "no_show" }, { status: 200, check: (b) => (b?.attendee?.status === "no_show" ? null : JSON.stringify(b)) });
await put("attendance: colleague refused", CLASS, ANA, tokens.colleague, { status: "attended" }, { status: 404, code: "not_found" });
await put("attendance: dancer not on the roster", CLASS, LEE, tokens.instructor, { status: "attended" }, { status: 404, code: "not_found" });
await put("attendance: cancelled class", CANCELLED, ANA, tokens.instructor, { status: "attended" }, { status: 409, code: "not_markable" });
await put("attendance: private lesson", LESSON, ANA, tokens.instructor, { status: "attended" }, { status: 409, code: "not_markable" });
await put("attendance: independent instructor refused", CLASS, ANA, tokens.independent, { status: "attended" }, { status: 403, code: "role_not_permitted" });
await put("attendance: missing Idempotency-Key", CLASS, ANA, tokens.instructor, { status: "attended" }, { status: 400, code: "invalid_request" }, {});
await put("attendance: status outside attended/no_show", CLASS, ANA, tokens.instructor, { status: "checked_in" }, { status: 400, code: "invalid_request" });
await put("attendance: body not JSON", CLASS, ANA, tokens.instructor, "{oops", { status: 400, code: "invalid_request" });
await put("attendance: no token", CLASS, ANA, null, { status: "attended" }, { status: 401, code: "unauthenticated" });

writeFileSync(OUT, JSON.stringify({ gotrue: "v2.188.1", results }, null, 2));
const failed = results.filter((r) => r.result !== "PASS");
for (const r of results) console.log(`${r.result}  ${String(r.status ?? "").padEnd(3)} ${String(r.code ?? "").padEnd(20)} ${r.name}${r.problems.length ? `  <- ${r.problems.join("; ")}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

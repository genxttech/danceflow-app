#!/usr/bin/env node
// Landmark 1A Slice 7 -- real concurrency verification (DEV ONLY).
//
//   node slice7_race_harness.mjs setup | run | cleanup
//
// Each competing operation is its own PostgREST RPC request, i.e. its own
// backend connection and its own transaction. slice7_race_helper.sql's
// _s7_race_op performs the operation, records how long it waited, then
// sleeps HOLD seconds inside the same transaction so any advisory lock it
// took stays held while the harness fires the competing request ~1s later.
// HOLD (4s) stays under the observed 8s authenticator statement/lock
// timeout, so those limits do not decide any outcome except race 12, which
// deliberately lowers lock_timeout to 1s to prove a slow writer fails closed.
//
// Safety: refuses to run unless both the linked project and the API URL are
// DEV (epdrtzcydvnoidwrepqz). Never reads or uses any PROD credential.
//
// Pass criteria per race and ordering (both orderings always run):
//   writer first -> writer OK; revocation waits (>= MINWAIT ms) and is
//                   rejected with the future-work message.
//   revoke first -> revocation OK; the writer waits (>= MINWAIT ms) and is
//                   rejected "no longer available for assignment".
//   always       -> forbidden-state query == 0 (no can_instruct=false
//                   instructor referenced by live future instructional work).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const DEV_REF = "epdrtzcydvnoidwrepqz";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../../..");
const SCRATCH = process.env.SLICE7_SCRATCH || join(tmpdir(), "slice7race");
mkdirSync(SCRATCH, { recursive: true });

const HOLD = 4;
const STAGGER_MS = 1000;
const MINWAIT = 1000;

// --- environment guard -------------------------------------------------------
const linked = readFileSync(join(ROOT, "supabase/.temp/project-ref"), "utf8").trim();
if (linked !== DEV_REF) {
  console.error(`REFUSING: repo is linked to ${linked}, not DEV ${DEV_REF}`);
  process.exit(2);
}
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const API = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!API?.includes(DEV_REF) || !KEY) {
  console.error("REFUSING: .env.local does not target DEV with a service key");
  process.exit(2);
}

// --- ids -----------------------------------------------------------------------
const F = "00000000-0000-0000-0000-00001a7f1000";
const G = "00000000-0000-0000-0000-00001a7f3000";
const ADM = "00000000-0000-0000-0000-00001a7f5001";
const PU = "00000000-0000-0000-0000-00001a7f5002";
const CL = "00000000-0000-0000-0000-00001a7f5301";
// Identity band: instructors revoked in a run keep immutable audit rows and
// therefore cannot be deleted (only deactivated), so each fresh run uses a new
// band of ids: SLICE7_BAND=0,1,2,... (band b uses index b*100+1 .. b*100+90).
const BAND = Number(process.env.SLICE7_BAND || 0);
const OFF = BAND * 100;
const p3 = (n) => String(OFF + n).padStart(3, "0");
const FI = (n) => `00000000-0000-0000-0000-00001a7f1${p3(n)}`;
const GI = (n) => `00000000-0000-0000-0000-00001a7f3${p3(n)}`;
const AID = (k) => `00000000-0000-0000-0000-00001a7f6${p3(k)}`;
const RID = (k) => `00000000-0000-0000-0000-00001a7f7${p3(k)}`;

// --- plumbing ------------------------------------------------------------------
function cliSql(sql) {
  const f = join(SCRATCH, `cli_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(f, sql);
  try {
    return execFileSync("supabase", ["db", "query", "--linked", "-f", f, "-o", "csv"], {
      cwd: ROOT,
      shell: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .split(/\r?\n/)
      .filter((l) => !/Initialising|new version|recommend/.test(l))
      .join("\n")
      .trim();
  } catch (e) {
    throw new Error(`cliSql failed: ${(e.stderr || e.message || "").toString().slice(0, 600)}`);
  }
}

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rpc(op, x, y = null, hold = 0, lockTimeoutMs = 0) {
  const t0 = Date.now();
  const res = await fetch(`${API}/rest/v1/rpc/_s7_race_op`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_op: op, p_x: x, p_y: y, p_hold: hold, p_lock_timeout_ms: lockTimeoutMs }),
  });
  const body = await res.json().catch(() => null);
  const out = typeof body === "string" ? body : JSON.stringify(body);
  const m = /waited_ms=(\d+)/.exec(out);
  return { out, waited: m ? Number(m[1]) : null, wall: Date.now() - t0 };
}

async function rawActionInsert(instructorId) {
  // A direct PostgREST table write (what any RLS-permitted client could send).
  const t0 = Date.now();
  const res = await fetch(`${API}/rest/v1/student_booking_action_requests`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({
      studio_id: F, client_id: CL, action_type: "book", mode: "approval_required", status: "pending",
      lesson_type: "private_lesson", instructor_id: instructorId,
      requested_starts_at: new Date(Date.now() + 2 * 86400e3).toISOString(),
      requested_ends_at: new Date(Date.now() + 2 * 86400e3 + 3600e3).toISOString(),
    }),
  });
  const text = await res.text();
  const wall = Date.now() - t0;
  return { out: res.ok ? `OK | waited_ms=${wall}` : `ERR: ${text} | waited_ms=${wall}`, waited: wall, wall };
}

async function rest(path, init = {}) {
  const res = await fetch(`${API}/rest/v1/${path}`, { headers, ...init });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const forbidden = async () => {
  const res = await fetch(`${API}/rest/v1/rpc/_s7_forbidden`, { method: "POST", headers, body: "{}" });
  return Number(await res.json());
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- race schedule -------------------------------------------------------------
const ins = {
  br: (id, instr, status, k) =>
    `insert into public.booking_requests (id, studio_id, client_id, instructor_id, source, status, appointment_type, requested_starts_at, requested_ends_at) values ('${id}','${F}','${CL}','${instr}','portal_schedule','${status}','intro_lesson', now()+interval '2 days', now()+interval '2 days 1 hour') on conflict (id) do nothing;`,
  ar: (id, instr) =>
    `insert into public.student_booking_action_requests (id, studio_id, client_id, action_type, mode, status, lesson_type, instructor_id, requested_starts_at, requested_ends_at) values ('${id}','${F}','${CL}','book','approval_required','pending','private_lesson','${instr}', now()+interval '2 days', now()+interval '2 days 1 hour') on conflict (id) do nothing;`,
  appt: (id, instr, status, offset) =>
    `insert into public.appointments (id, studio_id, client_id, instructor_id, appointment_type, title, starts_at, ends_at, status) values ('${id}','${F}','${CL}','${instr}','private_lesson','race', now()+interval '${offset}', now()+interval '${offset}' + interval '1 hour','${status}') on conflict (id) do nothing;`,
};

const RACES = [
  { key: "01", name: "revoke vs direct appointment INSERT", op: "w_appt" },
  {
    key: "02", name: "revoke vs booking-request approval/materialization", op: "w_materialize", blockedAlways: true,
    pre: (k, X) => ins.br(RID(k), X, "pending"), y: (k) => RID(k),
  },
  { key: "03", name: "revoke vs new booking_requests pending INSERT", op: "w_br" },
  { key: "04a", name: "revoke vs new action book (pending)", op: "w_ar_book" },
  { key: "04b", name: "revoke vs new action book (instant approved)", op: "w_ar_instant" },
  {
    key: "05", name: "revoke vs new action reschedule", op: "w_ar_resched",
    pre: (k, X, Y) => ins.appt(AID(k), Y, "scheduled", "3 days"), y: (k) => AID(k),
  },
  {
    key: "06a", name: "revoke vs booking-request reopen (declined->pending)", op: "w_br_reopen",
    pre: (k, X) => ins.br(RID(k), X, "declined"), y: (k) => RID(k),
  },
  {
    key: "06b", name: "revoke vs action-request retarget (Y->X)", op: "w_ar_retarget",
    pre: (k, X, Y) => ins.ar(RID(k), Y), y: (k) => RID(k),
  },
  { key: "07", name: "revoke vs direct client-style PostgREST action-request INSERT", op: "w_ar_book", raw: true },
  {
    key: "08", name: "revoke vs appointment cancelled->scheduled", op: "w_cancel_resurrect",
    pre: (k, X) => ins.appt(AID(k), X, "cancelled", "3 days"), y: (k) => AID(k),
  },
  {
    key: "09", name: "revoke vs appointment past->future ends_at", op: "w_past_future",
    pre: (k, X) => ins.appt(AID(k), X, "scheduled", "-3 days"), y: (k) => AID(k),
  },
];
const ORDERS = ["writer_first", "revoke_first"];

// Deterministic instructor/row index per (race, order); shared by setup and run.
const PLAN = [];
{
  let k = 0;
  for (const order of ORDERS) for (const race of RACES) { k += 1; PLAN.push({ race, order, k }); }
}
const K_LOCKTIMEOUT = PLAN.length + 1;
const K_TWOWRITERS = PLAN.length + 2;

let pass = 0, fail = 0;
const results = [];
function report(name, order, ok, detail) {
  ok ? pass++ : fail++;
  results.push({ name, order, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${order.padEnd(13)} ${detail}`);
}
const startsOk = (r) => r.out.startsWith("OK");

// --- commands ------------------------------------------------------------------
function setup() {
  cliSql(readFileSync(join(HERE, "slice7_race_helper.sql"), "utf8"));
  const pre = PLAN.map(({ race, k }) => (race.pre ? race.pre(k, FI(2 * k - 1), FI(2 * k)) : "")).join("\n");
  cliSql(`
insert into public.studios (id, name, slug, billing_plan, billing_override_enabled) values
  ('${F}', 'S7 Race Studio F', 't-landmark1a-s7-race-f', 'pro', true),
  ('${G}', 'S7 Race Studio G (seat)', 't-landmark1a-s7-race-g', 'growth', true)
on conflict (id) do nothing;
insert into auth.users (id, email)
  select ('00000000-0000-0000-0000-00001a7f2' || lpad(n::text, 3, '0'))::uuid, 't-landmark1a-s7-racef-' || n || '@example.test' from generate_series(${OFF + 1}, ${OFF + 90}) n on conflict do nothing;
insert into auth.users (id, email)
  select ('00000000-0000-0000-0000-00001a7f4' || lpad(n::text, 3, '0'))::uuid, 't-landmark1a-s7-raceg-' || n || '@example.test' from generate_series(${OFF + 1}, ${OFF + 20}) n on conflict do nothing;
insert into auth.users (id, email) values
  ('${ADM}', 't-landmark1a-s7-race-admin@example.test'), ('${PU}', 't-landmark1a-s7-race-portal@example.test') on conflict do nothing;
insert into public.profiles (id, email, full_name)
  select id, email, 'S7 race ' || email from auth.users where email like 't-landmark1a-s7-race%' on conflict (id) do nothing;
insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('${ADM}', '${F}', 'studio_admin', true), ('${ADM}', '${G}', 'studio_admin', true) on conflict do nothing;
insert into public.clients (id, studio_id, first_name, last_name, status, portal_user_id)
  values ('${CL}', '${F}', 'Race', 'Client', 'active', '${PU}') on conflict (id) do nothing;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct)
  select ('00000000-0000-0000-0000-00001a7f1' || lpad(n::text, 3, '0'))::uuid, '${F}',
         ('00000000-0000-0000-0000-00001a7f2' || lpad(n::text, 3, '0'))::uuid, 'RaceF' || n, 'S7', true, true
  from generate_series(${OFF + 1}, ${OFF + 90}) n on conflict (id) do nothing;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct)
  select ('00000000-0000-0000-0000-00001a7f3' || lpad(n::text, 3, '0'))::uuid, '${G}',
         ('00000000-0000-0000-0000-00001a7f4' || lpad(n::text, 3, '0'))::uuid, 'RaceG' || n, 'S7', true, false
  from generate_series(${OFF + 1}, ${OFF + 20}) n on conflict (id) do nothing;
${pre}
`);
  console.log("setup done");
}

async function race({ race: r, order, k }) {
  const X = FI(2 * k - 1), Y = FI(2 * k);
  const yArg = r.y ? r.y(k) : null;
  const writer = (hold) => rpc(r.op, X, yArg, hold);
  const revoke = (hold) => rpc("revoke_f", X, null, hold);
  const label = `${r.key} ${r.name}`;
  let w, v;

  if (order === "writer_first") {
    const p1 = writer(HOLD); await sleep(STAGGER_MS); const p2 = revoke(0);
    [w, v] = await Promise.all([p1, p2]);
  } else {
    const p1 = revoke(HOLD); await sleep(STAGGER_MS);
    const p2 = r.raw ? rawActionInsert(X) : writer(0);
    [v, w] = await Promise.all([p1, p2]);
  }
  const forb = await forbidden();
  let ok;
  if (r.blockedAlways) {
    // A live request already exists for this instructor, so revocation is blocked in BOTH orders.
    ok = v.out.includes("cannot be removed while") && startsOk(w) &&
      (order === "revoke_first" || v.waited >= MINWAIT);
  } else if (order === "writer_first") {
    ok = startsOk(w) && v.out.includes("cannot be removed while") && v.waited >= MINWAIT;
  } else {
    ok = startsOk(v) && w.out.includes("no longer available for assignment") && w.waited >= MINWAIT;
  }
  report(label, order, ok && forb === 0, `writer=[${w.out}] revoke=[${v.out}] forbidden=${forb}`);
}

async function run() {
  for (const step of PLAN) await race(step);

  // 12. lock_timeout fails closed: revoker holds exclusive 5s; writer's lock_timeout is 1s.
  {
    const k = K_LOCKTIMEOUT, X = FI(2 * k - 1);
    const p1 = rpc("revoke_f", X, null, 5); await sleep(STAGGER_MS);
    const p2 = rpc("w_appt", X, null, 0, 1000);
    const [v, w] = await Promise.all([p1, p2]);
    const rows = await rest(`appointments?instructor_id=eq.${X}&select=id`);
    const forb = await forbidden();
    report("12 writer lock_timeout fails closed (no row written)", "revoke_first",
      startsOk(v) && /lock timeout/.test(w.out) && w.waited >= 900 && w.waited < 3000 && rows.length === 0 && forb === 0,
      `revoke=[${v.out}] writer=[${w.out}] rowsWritten=${rows.length} forbidden=${forb}`);
  }

  // 10. two concurrent writers: both hold the shared lock; neither serializes on the other.
  {
    const k = K_TWOWRITERS, X = FI(2 * k - 1);
    const p1 = rpc("w_appt", X, null, HOLD); await sleep(STAGGER_MS);
    const p2 = rpc("w_appt", X, null, 0);
    const [a, b] = await Promise.all([p1, p2]);
    report("10 two concurrent writers both proceed (no serialization)", "-",
      startsOk(a) && startsOk(b) && b.waited < 800, `w1=[${a.out}] w2=[${b.out}]`);
  }

  // 11. revoke vs Slice 6 grant / reactivate (both hold the exclusive seat lock), both orderings.
  {
    let m = 0;
    for (const order of ["revoke_first", "other_first"]) {
      for (const kind of ["grant", "reactivate"]) {
        m += 1;
        const gx = GI(2 * m - 1), gy = GI(2 * m);
        // Studio G is seat-limited (growth = 5): drop every counted seat left over from earlier
        // iterations/runs so only this iteration's two instructors matter.
        await rest(`instructors?studio_id=eq.${G}`, { method: "PATCH", body: JSON.stringify({ active: false }) });
        await rest(`instructors?id=eq.${gx}`, { method: "PATCH", body: JSON.stringify({ can_instruct: true, active: true }) });
        await rest(`instructors?id=eq.${gy}`, {
          method: "PATCH",
          body: JSON.stringify(kind === "grant" ? { can_instruct: false, active: true } : { can_instruct: true, active: false }),
        });
        const other = kind === "grant" ? "grant_g" : "reactivate_g";
        const opFirst = order === "revoke_first" ? ["revoke_g", gx, null] : [other, null, gy];
        const opSecond = order === "revoke_first" ? [other, null, gy] : ["revoke_g", gx, null];
        const call = (o, hold) => rpc(o[0], o[1] ?? gx, o[2], hold);
        const p1 = call(opFirst, HOLD); await sleep(STAGGER_MS);
        const p2 = call(opSecond, 0);
        const [a, b] = await Promise.all([p1, p2]);
        const [x] = await rest(`instructors?id=eq.${gx}&select=can_instruct`);
        const [y] = await rest(`instructors?id=eq.${gy}&select=can_instruct,active`);
        report(`11 revoke vs ${kind}`, order,
          startsOk(a) && startsOk(b) && b.waited >= MINWAIT && x.can_instruct === false && y.can_instruct === true && y.active === true,
          `first=[${a.out}] second=[${b.out}] final(x.can_instruct=${x.can_instruct}, y=${y.can_instruct}/${y.active}) no deadlock`);
      }
    }
  }

  console.log(`\n== RACES: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

function cleanup() {
  const out = cliSql(`
delete from public.student_booking_action_requests where studio_id in ('${F}','${G}');
delete from public.booking_requests where studio_id in ('${F}','${G}');
delete from public.appointments where studio_id in ('${F}','${G}');
-- Instructors with immutable audit history (RESTRICT FK + immutable trigger) cannot be
-- deleted; they are deactivated and left. Audit protections are never weakened.
delete from public.instructors i where i.studio_id in ('${F}','${G}')
  and not exists (select 1 from public.instructor_audit_events e where e.instructor_id = i.id);
update public.instructors set active = false where studio_id in ('${F}','${G}');
drop function if exists public._s7_race_op(text, uuid, uuid, numeric, int);
drop function if exists public._s7_forbidden();
select (select count(*) from public.instructors where studio_id in ('${F}','${G}')) residue_instructors,
       (select count(*) from public.instructors where studio_id in ('${F}','${G}') and active) still_active,
       (select count(*) from public.instructor_audit_events where studio_id in ('${F}','${G}')) audit_rows,
       (select count(*) from pg_proc where proname in ('_s7_race_op','_s7_forbidden')) helper_fns_left;`);
  console.log(out);
}

const cmd = process.argv[2];
if (cmd === "setup") setup();
else if (cmd === "run") await run();
else if (cmd === "cleanup") cleanup();
else { console.error("usage: slice7_race_harness.mjs setup|run|cleanup"); process.exit(2); }

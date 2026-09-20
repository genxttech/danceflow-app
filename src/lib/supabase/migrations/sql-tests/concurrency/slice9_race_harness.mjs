#!/usr/bin/env node
// Landmark 1A Slice 9 -- real concurrency verification (DEV ONLY).
//
//   SLICE9_BAND=<n> node slice9_race_harness.mjs setup | run | cleanup
//
// Same technique as slice7/slice8: each competing operation is its own
// PostgREST RPC (own backend connection, own transaction) into the temporary
// DEV-only helper slice9_race_helper.sql, which performs the operation,
// records its wait, then sleeps HOLD seconds inside the same transaction so
// its locks stay held while the competing request arrives ~1s later.
//
// Safety: refuses unless the linked project AND the API URL are DEV
// (epdrtzcydvnoidwrepqz). Never reads a PROD credential.
//
// Expected serial semantics (Model A payroll):
//   promotion vs renter edit      client row is locked FOR UPDATE by promotion, so the renter
//                                 edit waits (or, edit first, promotion waits and is rejected).
//   promotion vs payroll edit     the payroll row is locked last; whichever commits first wins,
//                                 deterministically (edit-first => promotion reactivates).
//   promotion vs classification   promotion first => later edit wins; edit first => promotion is
//                                 REJECTED (never silently rewrites) with no partial promotion.
//   promotion vs promotion        the second waits on the client row and becomes an idempotent no-op.
//   revoke vs tenant direct write the direct write is rejected by the capability guard either way.
//   grant vs promotion at limit 1 exactly one succeeds; the other is rejected on seat count.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const DEV_REF = "epdrtzcydvnoidwrepqz";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../../..");
const SCRATCH = process.env.SLICE9_SCRATCH || join(tmpdir(), "slice9race");
mkdirSync(SCRATCH, { recursive: true });

const HOLD = 4;
const STAGGER_MS = 1000;
const MINWAIT = 2000;

const linked = readFileSync(join(ROOT, "supabase/.temp/project-ref"), "utf8").trim();
if (linked !== DEV_REF) { console.error(`REFUSING: repo linked to ${linked}, not DEV`); process.exit(2); }
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const API = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!API?.includes(DEV_REF) || !KEY) { console.error("REFUSING: .env.local does not target DEV with a service key"); process.exit(2); }

// ids -- band b shifts every synthetic id so reruns never collide with fixtures that
// immutable audit rows keep alive.
const BAND = Number(process.env.SLICE9_BAND || 0);
const p4 = (n) => String(n).padStart(4, "0");
const SID = (k) => `00000000-0000-0000-0000-00001b9d${p4(BAND * 100 + k)}`;
const UID = (k, j) => `00000000-0000-0000-0000-00001b9e${p4((BAND * 100 + k) * 10 + j)}`;   // j: 0 owner, 1..2 instructors, 4 hybrid client user
const IID = (k, j) => `00000000-0000-0000-0000-00001b9f${p4((BAND * 100 + k) * 10 + j)}`;
const CID = (k) => `00000000-0000-0000-0000-00001ba0${p4(BAND * 100 + k)}`;
const ADM = "00000000-0000-0000-0000-00001b9e9001";
const FRONT = "00000000-0000-0000-0000-00001b9e9002";

function cliSql(sql) {
  const f = join(SCRATCH, `cli_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(f, sql);
  try {
    return execFileSync("supabase", ["db", "query", "--linked", "-f", f, "-o", "csv"], { cwd: ROOT, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split(/\r?\n/).filter((l) => !/Initialising|new version|recommend/.test(l)).join("\n").trim();
  } catch (e) { throw new Error(`cliSql failed: ${(e.stderr || e.message || "").toString().slice(0, 700)}`); }
}
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const TENANT_OPS = new Set(["renter_off", "tenant_can_true", "tenant_can_false", "tenant_active_true"]);
async function op(name, studio, x = null, y = null, hold = 0) {
  const tenant = TENANT_OPS.has(name);
  const res = await fetch(`${API}/rest/v1/rpc/${tenant ? "_s9_race_tenant_op" : "_s9_race_op"}`, { method: "POST", headers, body: JSON.stringify(tenant ? { p_op: name, p_x: x, p_hold: hold } : { p_op: name, p_studio: studio, p_x: x, p_y: y, p_hold: hold }) });
  const body = await res.json().catch(() => null);
  const out = typeof body === "string" ? body : JSON.stringify(body);
  const m = /waited_ms=(\d+)/.exec(out);
  return { out, waited: m ? Number(m[1]) : null };
}
async function state(k) {
  const res = await fetch(`${API}/rest/v1/rpc/_s9_state`, { method: "POST", headers, body: JSON.stringify({ p_studio: SID(k), p_instructor: IID(k, 4), p_client: CID(k) }) });
  return String(await res.json());
}
async function instructorCap(k, j) {
  const res = await fetch(`${API}/rest/v1/instructors?id=eq.${IID(k, j)}&select=can_instruct`, { headers });
  const rows = await res.json();
  return String(rows?.[0]?.can_instruct);
}
async function instructorActive(k, j) {
  const res = await fetch(`${API}/rest/v1/instructors?id=eq.${IID(k, j)}&select=active`, { headers });
  const rows = await res.json();
  return String(rows?.[0]?.active);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (r) => r.out.startsWith("OK");
const GUARD = "Instructor capability can only be changed";
const SEAT = "reached its instructor seat limit";

// Each race: a = first operation (holds its locks), b = second (arrives 1s later).
// I(k,4) is the hybrid instructor (payroll row active/employee), C(k) its renter client,
// I(k,2) a capable instructor (revoke target), I(k,1) a grant candidate.
const promote = (k) => ["promote", SID(k), CID(k), "employee"];
const RACES = [
  { key: "P1a promotion vs renter edit (promotion first)", plan: "growth", a: (k) => promote(k), b: (k) => ["renter_off", SID(k), CID(k), null],
    check: (a, b, s) => ok(a) && ok(b) && b.waited >= MINWAIT && /cap=true,att=true/.test(s) && /renter=false/.test(s), why: "renter edit waits on the client row, then applies; promotion stands" },
  { key: "P1b promotion vs renter edit (edit first)", plan: "growth", a: (k) => ["renter_off", SID(k), CID(k), null], b: (k) => promote(k),
    check: (a, b, s) => ok(a) && !ok(b) && b.out.includes("independent-instructor relationship") && b.waited >= MINWAIT && /cap=false,att=false/.test(s), why: "promotion waits on the client row, then rejects; nothing granted" },
  { key: "P2a promotion vs payroll deactivation (promotion first)", plan: "growth", a: (k) => promote(k), b: (k) => ["payroll_off", SID(k), IID(k, 4), null],
    check: (a, b, s) => ok(a) && ok(b) && b.waited >= MINWAIT && /cap=true/.test(s) && /payroll=false\/employee/.test(s), why: "deactivation waits on the payroll row; capability persists (non-destructive drift)" },
  { key: "P2b promotion vs payroll deactivation (edit first)", plan: "growth", a: (k) => ["payroll_off", SID(k), IID(k, 4), null], b: (k) => promote(k),
    check: (a, b, s) => ok(a) && ok(b) && b.waited >= MINWAIT && /cap=true/.test(s) && /payroll=true\/employee/.test(s), why: "promotion waits, then reactivates payroll as part of the transition" },
  { key: "P3a promotion vs classification edit (promotion first)", plan: "growth", a: (k) => promote(k), b: (k) => ["class_edit", SID(k), IID(k, 4), "contractor"],
    check: (a, b, s) => ok(a) && ok(b) && b.waited >= MINWAIT && /cap=true/.test(s) && /payroll=true\/contractor/.test(s), why: "edit waits on the payroll row and wins afterwards" },
  { key: "P3b promotion vs classification edit (edit first)", plan: "growth", a: (k) => ["class_edit", SID(k), IID(k, 4), "contractor"], b: (k) => promote(k),
    check: (a, b, s) => ok(a) && !ok(b) && b.out.includes("already has an established payroll classification") && b.waited >= MINWAIT && /cap=false,att=false/.test(s) && /grants=0/.test(s), why: "promotion rejected, no partial promotion, classification never rewritten" },
  { key: "P4 promotion vs competing promotion", plan: "growth", a: (k) => promote(k), b: (k) => promote(k),
    check: (a, b, s) => ok(a) && ok(b) && b.waited >= MINWAIT && /cap=true,att=true/.test(s) && /grants=1/.test(s), why: "second waits on the client row, then is an idempotent no-op (one audit event)" },
  { key: "P5a revoke RPC vs tenant direct write (RPC first)", plan: "growth", a: (k) => ["revoke", SID(k), IID(k, 2), null], b: (k) => ["tenant_can_true", SID(k), IID(k, 2), null],
    check: (a, b) => ok(a) && !ok(b) && b.out.includes(GUARD), why: "tenant direct write rejected by the capability guard", extra: async (k) => (await instructorCap(k, 2)) === "false" },
  { key: "P5b tenant direct revoke vs revoke RPC (write first)", plan: "growth", a: (k) => ["tenant_can_false", SID(k), IID(k, 2), null], b: (k) => ["revoke", SID(k), IID(k, 2), null],
    check: (a, b) => !ok(a) && a.out.includes(GUARD) && ok(b), why: "direct revoke rejected; canonical revoke still succeeds and is not blocked by it", extra: async (k) => (await instructorCap(k, 2)) === "false" },
  { key: "P6a grant vs promotion at the limit (grant first)", plan: "starter", a: (k) => ["grant", SID(k), IID(k, 1), null], b: (k) => promote(k),
    check: (a, b, s) => ok(a) && !ok(b) && b.out.includes(SEAT) && b.waited >= MINWAIT && /cap=false/.test(s) && /usage=1/.test(s), why: "seat lock serializes; second re-checks and is rejected; usage never exceeds the limit" },
  { key: "P6b promotion vs grant at the limit (promotion first)", plan: "starter", a: (k) => promote(k), b: (k) => ["grant", SID(k), IID(k, 1), null],
    check: (a, b, s) => ok(a) && !ok(b) && b.out.includes(SEAT) && b.waited >= MINWAIT && /cap=true/.test(s) && /usage=1/.test(s), why: "seat lock serializes; grant rejected; usage stays 1" },
];
// Lock-order probe (documents the Slice 8 residual, see README): the canonical RPC lock order
// (seat lock, then instructor row) against a tenant direct update of a capable row's active flag
// (row lock, then the Slice 8 seat trigger's seat lock). PostgreSQL must abort exactly one with
// 40P01; no partial write, no invariant violation.
RACES.push({ key: "P7 lock-order probe: RPC order vs direct active write on a capable row", plan: "growth", inactiveCapable: true,
  a: (k) => ["seat_then_row", SID(k), IID(k, 2), "2"], b: (k) => ["tenant_active_true", SID(k), IID(k, 2), null],
  check: (a, b, s) => (ok(a) !== ok(b)) && (a.out + b.out).includes("deadlock detected"), why: "exactly one side aborted with 40P01 (deadlock_timeout 1s); the other completes",
  extra: async (k) => { const act = await instructorActive(k, 2); return act === "true" || act === "false"; } });
const PLAN = RACES.map((r, i) => ({ ...r, k: i + 1 }));

// --- setup / cleanup ------------------------------------------------------------------------
function setup() {
  cliSql(readFileSync(join(HERE, "slice9_race_helper.sql"), "utf8"));
  const list = PLAN.map((p) => p.k).join(",");
  const starters = PLAN.filter((p) => p.plan === "starter").map((p) => p.k).join(",") || "0";
  const sid = (e) => `('00000000-0000-0000-0000-00001b9d' || lpad((${BAND * 100} + ${e})::text, 4, '0'))::uuid`;
  const uid = (k, j) => `('00000000-0000-0000-0000-00001b9e' || lpad(((${BAND * 100} + ${k}) * 10 + ${j})::text, 4, '0'))::uuid`;
  const iid = (k, j) => `('00000000-0000-0000-0000-00001b9f' || lpad(((${BAND * 100} + ${k}) * 10 + ${j})::text, 4, '0'))::uuid`;
  cliSql(`
insert into auth.users (id, email) values ('${ADM}', 't-s9-race-admin@example.test'), ('${FRONT}', 't-s9-race-front@example.test') on conflict do nothing;
insert into public.profiles (id, email, full_name) values ('${ADM}', 't-s9-race-admin@example.test', 'S9 race admin'), ('${FRONT}', 't-s9-race-front@example.test', 'S9 race front') on conflict (id) do nothing;
insert into public.studios (id, name, slug)
  select ${sid("k")}, 'S9 Race ' || k, 't-s9-race-' || (${BAND * 100} + k) from unnest(array[${list}]) k on conflict (id) do nothing;
update public.studios set billing_plan = (case when k in (${starters}) then 'starter' else 'growth' end)::public.billing_plan, billing_override_enabled = true
  from unnest(array[${list}]) k where studios.id = ${sid("k")};
insert into auth.users (id, email)
  select ${uid("k", "j")}, 't-s9-race-u' || ((${BAND * 100} + k) * 10 + j) || '@example.test' from unnest(array[${list}]) k, generate_series(0, 4) j on conflict do nothing;
insert into public.profiles (id, email, full_name)
  select id, email, 'S9 race ' || email from auth.users where email like 't-s9-race-u%' on conflict (id) do nothing;
insert into public.user_studio_roles (user_id, studio_id, role, active)
  select '${ADM}', ${sid("k")}, 'studio_admin', true from unnest(array[${list}]) k on conflict do nothing;
insert into public.user_studio_roles (user_id, studio_id, role, active)
  select '${FRONT}', ${sid("k")}, 'front_desk', true from unnest(array[${list}]) k on conflict do nothing;
insert into public.user_studio_roles (user_id, studio_id, role, active)
  select ${uid("k", 0)}, ${sid("k")}, 'studio_owner', true from unnest(array[${list}]) k on conflict do nothing;
-- I1 grant candidate, I2 capable (revoke target), I4 hybrid instructor (payroll row active/employee)
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct)
  select ${iid("k", "j")}, ${sid("k")}, ${uid("k", "j")}, 'R' || k || 'x' || j, 'S9', true, false
  from unnest(array[${list}]) k, unnest(array[1, 2, 4]) j on conflict (id) do nothing;
update public.instructors set can_instruct = true from unnest(array[${list}]) k where instructors.id = ${iid("k", 2)} and k not in (${starters});
update public.instructors set active = false from unnest(array[${PLAN.filter((p) => p.inactiveCapable).map((p) => p.k).join(',') || '0'}]) k where instructors.id = ${iid("k", 2)};
insert into public.instructor_payroll_profiles (studio_id, instructor_id, payroll_active, worker_classification)
  select ${sid("k")}, ${iid("k", 4)}, true, 'employee' from unnest(array[${list}]) k on conflict do nothing;
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor, linked_instructor_id)
  select ('00000000-0000-0000-0000-00001ba0' || lpad((${BAND * 100} + k)::text, 4, '0'))::uuid, ${sid("k")}, 'Hyb', 'R' || k, 'active', true, null from unnest(array[${list}]) k on conflict (id) do nothing;
insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type, is_primary)
  select ${sid("k")}, ('00000000-0000-0000-0000-00001ba0' || lpad((${BAND * 100} + k)::text, 4, '0'))::uuid, ${uid("k", 4)}, 'linked', 'self', true from unnest(array[${list}]) k;
`);
  console.log(`setup done: band ${BAND}, ${PLAN.length} race studios`);
}

function cleanup() {
  const out = cliSql(`
drop function if exists public._s9_race_op(text, uuid, uuid, text, numeric);
drop function if exists public._s9_race_tenant_op(text, uuid, numeric);
drop function if exists public._s9_state(uuid, uuid, uuid);
update public.instructors set active = false where studio_id in (select id from public.studios where slug like 't-s9-race-%') and active;
delete from public.clients where studio_id in (select id from public.studios where slug like 't-s9-race-%');
delete from public.studios s where slug like 't-s9-race-%' and not exists (select 1 from public.instructor_audit_events e where e.studio_id = s.id);
select (select count(*) from public.studios where slug like 't-s9-race-%') retained_studios,
       (select count(*) from public.instructors i join public.studios s on s.id = i.studio_id where s.slug like 't-s9-race-%') retained_instructors,
       (select count(*) from public.instructors i join public.studios s on s.id = i.studio_id where s.slug like 't-s9-race-%' and i.active) still_active,
       (select count(*) from pg_proc where proname in ('_s9_race_op', '_s9_race_tenant_op', '_s9_state')) helper_fns_left;`);
  console.log(out);
}

async function run() {
  let pass = 0, fail = 0;
  for (const r of PLAN) {
    const k = r.k;
    const [an, as, ax, ay] = r.a(k), [bn, bs, bx, by] = r.b(k);
    const pa = op(an, as, ax, ay, HOLD);
    await sleep(STAGGER_MS);
    const pb = op(bn, bs, bx, by, 0);
    const [a, b] = await Promise.all([pa, pb]);
    const s = await state(k);
    let good = r.check(a, b, s);
    if (good && r.extra) good = await r.extra(k);
    if (good) pass++; else fail++;
    console.log(`${good ? "PASS" : "FAIL"} ${r.key}\n     A ${an}: ${a.out}\n     B ${bn}: ${b.out}\n     state: ${s}\n     expect: ${r.why}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

const cmd = process.argv[2];
if (cmd === "setup") setup();
else if (cmd === "run") await run();
else if (cmd === "cleanup") cleanup();
else { console.error("usage: SLICE9_BAND=<n> node slice9_race_harness.mjs setup | run | cleanup"); process.exit(2); }

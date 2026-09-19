#!/usr/bin/env node
// Landmark 1A Slice 8 -- real concurrency verification (DEV ONLY).
//
//   SLICE8_BAND=<n> node slice8_race_harness.mjs setup | run | cleanup
//
// Same technique as slice7_race_harness.mjs: each competing operation is its
// own PostgREST RPC (own backend connection, own transaction) into the
// temporary DEV-only helper slice8_race_helper.sql, which performs the
// operation, records its wait, then sleeps HOLD seconds inside the same
// transaction so its locks stay held while the competing request arrives ~1s
// later. HOLD (4s) stays under the observed 8s authenticator timeouts.
//
// Safety: refuses unless the linked project AND the API URL are DEV
// (epdrtzcydvnoidwrepqz). Never reads a PROD credential.
//
// Expected serial semantics:
//   downgrade races
//     transition_first: the seat transition authorizes under the OLD (higher)
//       limit and holds its lock; the downgrade commits meanwhile WITHOUT
//       waiting (entitlement writers do not take the seat lock). Both succeed;
//       final usage exceeds the new limit -- the permitted "transition then
//       downgrade" outcome.
//     downgrade_first: the downgrade commits first; the later transition
//       re-reads the lower limit and is REJECTED.
//   mutual races (owner demotion / two transitions at the limit): exactly one
//     succeeds; the second WAITS on the exclusive seat lock, re-checks, and is
//     rejected. Final usage never exceeds the limit.
//   cross-studio: different lock keys, so neither waits.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const DEV_REF = "epdrtzcydvnoidwrepqz";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../../..");
const SCRATCH = process.env.SLICE8_SCRATCH || join(tmpdir(), "slice8race");
mkdirSync(SCRATCH, { recursive: true });

const HOLD = 4;
const STAGGER_MS = 1000;
const MINWAIT = 1000;
const SEAT_MSG = "reached its instructor seat limit";

const linked = readFileSync(join(ROOT, "supabase/.temp/project-ref"), "utf8").trim();
if (linked !== DEV_REF) { console.error(`REFUSING: repo linked to ${linked}, not DEV`); process.exit(2); }
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const API = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!API?.includes(DEV_REF) || !KEY) { console.error("REFUSING: .env.local does not target DEV with a service key"); process.exit(2); }

// ids -- band b shifts every synthetic id (studios k+100b) so reruns never collide with
// fixtures that immutable audit rows keep alive.
const BAND = Number(process.env.SLICE8_BAND || 0);
const p4 = (n) => String(n).padStart(4, "0");
const SID = (k) => `00000000-0000-0000-0000-00001b8d${p4(BAND * 100 + k)}`;
const UID = (k, j) => `00000000-0000-0000-0000-00001b8e${p4((BAND * 100 + k) * 10 + j)}`;   // j: 0 owner, 1..5 instructors, 6 hybrid client user
const IID = (k, j) => `00000000-0000-0000-0000-00001b8f${p4((BAND * 100 + k) * 10 + j)}`;
const CID = (k) => `00000000-0000-0000-0000-00001b90${p4(BAND * 100 + k)}`;
const ADM = "00000000-0000-0000-0000-00001b8e9001";

function cliSql(sql) {
  const f = join(SCRATCH, `cli_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(f, sql);
  try {
    return execFileSync("supabase", ["db", "query", "--linked", "-f", f, "-o", "csv"], { cwd: ROOT, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split(/\r?\n/).filter((l) => !/Initialising|new version|recommend/.test(l)).join("\n").trim();
  } catch (e) { throw new Error(`cliSql failed: ${(e.stderr || e.message || "").toString().slice(0, 700)}`); }
}
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function op(name, studio, x = null, hold = 0, lockTimeoutMs = 0) {
  const res = await fetch(`${API}/rest/v1/rpc/_s8_race_op`, { method: "POST", headers, body: JSON.stringify({ p_op: name, p_studio: studio, p_x: x, p_hold: hold, p_lock_timeout_ms: lockTimeoutMs }) });
  const body = await res.json().catch(() => null);
  const out = typeof body === "string" ? body : JSON.stringify(body);
  const m = /waited_ms=(\d+)/.exec(out);
  return { out, waited: m ? Number(m[1]) : null };
}
async function state(studio) {
  const res = await fetch(`${API}/rest/v1/rpc/_s8_state`, { method: "POST", headers, body: JSON.stringify({ p_studio: studio }) });
  const [limit, usage] = String(await res.json()).split("/").map(Number);
  return { limit, usage };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (r) => r.out.startsWith("OK");

// --- race plan ------------------------------------------------------------------
// baseline per studio k: growth override (limit 5). owner(j0) is a capable instructor (free); X1 capable; X3 inactive+capable; X2/X4 candidates.
// group "D": stay at usage 1, downgrade later.  group "L1": usage 0 at limit 1 (starter).
const RACES = [];
for (const order of ["transition_first", "downgrade_first"]) {
  RACES.push({ key: "D1 downgrade vs grant", grp: "D", order, t: (k) => ["grant", SID(k), IID(k, 2)], d: (k) => ["downgrade", SID(k), null] });
  RACES.push({ key: "D2 downgrade vs reactivate", grp: "D", order, t: (k) => ["reactivate", SID(k), IID(k, 3)], d: (k) => ["downgrade", SID(k), null] });
  RACES.push({ key: "D3 downgrade vs hybrid promotion", grp: "D", order, t: (k) => ["promote", SID(k), CID(k)], d: (k) => ["downgrade", SID(k), null] });
  RACES.push({ key: "D4 override removal vs direct instructor write", grp: "D", order, t: (k) => ["direct_can", SID(k), IID(k, 2)], d: (k) => ["remove_override", SID(k), null] });
}
for (const order of ["transition_first", "downgrade_first"]) {
  RACES.push({ key: "D5 downgrade vs revoke (both always succeed)", grp: "DR", order, t: (k) => ["revoke", SID(k), IID(k, 1)], d: (k) => ["downgrade", SID(k), null] });
}
for (const order of ["first_a", "first_b"]) {
  RACES.push({ key: "O1 owner demotion vs grant", grp: "M", order, a: (k) => ["demote_owner", SID(k), UID(k, 0)], b: (k) => ["grant", SID(k), IID(k, 2)] });
  RACES.push({ key: "T1 grant vs reactivate (same studio)", grp: "M", order, a: (k) => ["grant", SID(k), IID(k, 2)], b: (k) => ["reactivate", SID(k), IID(k, 3)] });
  RACES.push({ key: "T2 direct instructor write vs RPC grant", grp: "M", order, a: (k) => ["direct_can", SID(k), IID(k, 2)], b: (k) => ["grant", SID(k), IID(k, 4)] });
}
const PLAN = RACES.map((r, i) => ({ ...r, k: i + 1 }));
const K_CROSS = PLAN.length + 1;   // studio pair (k, k+1)

// --- setup / cleanup ----------------------------------------------------------------
function setup() {
  cliSql(readFileSync(join(HERE, "slice8_race_helper.sql"), "utf8"));
  const ks = [...PLAN.map((p) => p.k), K_CROSS, K_CROSS + 1];
  const list = ks.join(",");
  const groups = Object.fromEntries(PLAN.map((p) => [p.k, p.grp]));
  const mutual = PLAN.filter((p) => p.grp === "M").map((p) => p.k).join(",") || "0";
  cliSql(`
insert into auth.users (id, email) values ('${ADM}', 't-s8-race-admin@example.test') on conflict do nothing;
insert into public.profiles (id, email, full_name) values ('${ADM}', 't-s8-race-admin@example.test', 'S8 race admin') on conflict (id) do nothing;
with ks as (select unnest(array[${list}]) k)
insert into public.studios (id, name, slug)
  select ('00000000-0000-0000-0000-00001b8d' || lpad((${BAND * 100} + k)::text, 4, '0'))::uuid, 'S8 Race ' || k, 't-s8-race-' || (${BAND * 100} + k) from ks on conflict (id) do nothing;
update public.studios set billing_plan = 'growth', billing_override_enabled = true where slug like 't-s8-race-%' and id in (select ('00000000-0000-0000-0000-00001b8d' || lpad((${BAND * 100} + k)::text, 4, '0'))::uuid from unnest(array[${list}]) k);
insert into auth.users (id, email)
  select ('00000000-0000-0000-0000-00001b8e' || lpad(((${BAND * 100} + k) * 10 + j)::text, 4, '0'))::uuid, 't-s8-race-u' || ((${BAND * 100} + k) * 10 + j) || '@example.test' from unnest(array[${list}]) k, generate_series(0, 6) j on conflict do nothing;
insert into public.profiles (id, email, full_name)
  select id, email, 'S8 race ' || email from auth.users where email like 't-s8-race-u%' on conflict (id) do nothing;
insert into public.user_studio_roles (user_id, studio_id, role, active)
  select '${ADM}', ('00000000-0000-0000-0000-00001b8d' || lpad((${BAND * 100} + k)::text, 4, '0'))::uuid, 'studio_admin', true from unnest(array[${list}]) k on conflict do nothing;
insert into public.user_studio_roles (user_id, studio_id, role, active)
  select ('00000000-0000-0000-0000-00001b8e' || lpad(((${BAND * 100} + k) * 10)::text, 4, '0'))::uuid, ('00000000-0000-0000-0000-00001b8d' || lpad((${BAND * 100} + k)::text, 4, '0'))::uuid, 'studio_owner', true from unnest(array[${list}]) k on conflict do nothing;
insert into public.instructors (id, studio_id, user_id, first_name, last_name, active, can_instruct)
  select ('00000000-0000-0000-0000-00001b8f' || lpad(((${BAND * 100} + k) * 10 + j)::text, 4, '0'))::uuid, ('00000000-0000-0000-0000-00001b8d' || lpad((${BAND * 100} + k)::text, 4, '0'))::uuid,
         ('00000000-0000-0000-0000-00001b8e' || lpad(((${BAND * 100} + k) * 10 + j)::text, 4, '0'))::uuid, 'R' || k || 'x' || j, 'S8', true, false
  from unnest(array[${list}]) k, generate_series(0, 4) j on conflict (id) do nothing;
insert into public.clients (id, studio_id, first_name, last_name, status, is_independent_instructor, linked_instructor_id)
  select ('00000000-0000-0000-0000-00001b90' || lpad((${BAND * 100} + k)::text, 4, '0'))::uuid, ('00000000-0000-0000-0000-00001b8d' || lpad((${BAND * 100} + k)::text, 4, '0'))::uuid, 'Hyb', 'R' || k, 'active', true, null from unnest(array[${list}]) k on conflict (id) do nothing;
insert into public.client_account_links (studio_id, client_id, user_id, status, relationship_type, is_primary)
  select ('00000000-0000-0000-0000-00001b8d' || lpad((${BAND * 100} + k)::text, 4, '0'))::uuid, ('00000000-0000-0000-0000-00001b90' || lpad((${BAND * 100} + k)::text, 4, '0'))::uuid, ('00000000-0000-0000-0000-00001b8e' || lpad(((${BAND * 100} + k) * 10 + 6)::text, 4, '0'))::uuid, 'linked', 'self', true from unnest(array[${list}]) k;
`);
  // Per-race state via SQL (trusted postgres; every capability change below is authorized by the seat gate).
  const stmts = [];
  for (const k of ks) {
    const grp = groups[k];
    const S = SID(k);
    // owner-instructor is capable (free)
    stmts.push(`update public.instructors set can_instruct = true where id = '${IID(k, 0)}';`);
    if (grp === "D" || grp === "DR") {
      stmts.push(`update public.instructors set can_instruct = true where id = '${IID(k, 1)}';`);   // usage 1
      stmts.push(`update public.instructors set active = false, can_instruct = true where id = '${IID(k, 3)}';`); // inactive+capable (not counted)
    } else if (grp === "M") {
      stmts.push(`update public.studios set billing_plan = 'starter' where id = '${S}';`);           // limit 1, usage 0
      stmts.push(`update public.instructors set active = false, can_instruct = true where id = '${IID(k, 3)}';`);
    } else {
      stmts.push(`update public.studios set billing_plan = 'growth' where id = '${S}';`);          // cross-studio studios: limit 5
    }
  }
  cliSql(stmts.join("\n"));
  console.log("setup done");
}

function cleanup() {
  const out = cliSql(`
delete from public.instructor_payroll_profiles where studio_id in (select id from public.studios where slug like 't-s8-race-%');
delete from public.client_account_links where studio_id in (select id from public.studios where slug like 't-s8-race-%');
delete from public.clients where studio_id in (select id from public.studios where slug like 't-s8-race-%');
-- Instructors with immutable audit history (RESTRICT FK + immutable trigger) cannot be deleted; they are
-- deactivated and left. Audit protections are never weakened.
delete from public.instructors i where i.studio_id in (select id from public.studios where slug like 't-s8-race-%')
  and not exists (select 1 from public.instructor_audit_events e where e.instructor_id = i.id);
update public.instructors set active = false where studio_id in (select id from public.studios where slug like 't-s8-race-%');
drop function if exists public._s8_race_op(text, uuid, uuid, numeric, int);
drop function if exists public._s8_state(uuid);
select (select count(*) from public.studios where slug like 't-s8-race-%') race_studios,
       (select count(*) from public.instructors where studio_id in (select id from public.studios where slug like 't-s8-race-%')) residue_instructors,
       (select count(*) from public.instructors where studio_id in (select id from public.studios where slug like 't-s8-race-%') and active) still_active,
       (select count(*) from pg_proc where proname in ('_s8_race_op','_s8_state')) helper_fns_left;`);
  console.log(out);
}

// --- run ------------------------------------------------------------------------------
let pass = 0, fail = 0;
function report(name, order, good, detail) {
  good ? pass++ : fail++;
  console.log(`${good ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${order.padEnd(17)} ${detail}`);
}

async function runDowngrade(r) {
  const k = r.k; const S = SID(k);
  const T = r.t(k), D = r.d(k);
  const before = await state(S);
  let t, d;
  if (r.order === "transition_first") {
    const p1 = op(T[0], T[1], T[2], HOLD); await sleep(STAGGER_MS); const p2 = op(D[0], D[1], D[2], 0);
    [t, d] = await Promise.all([p1, p2]);
  } else {
    d = await op(D[0], D[1], D[2], 0);          // downgrade commits first
    await sleep(300);
    t = await op(T[0], T[1], T[2], 0);          // later transition must see the lower limit
  }
  const after = await state(S);
  let good;
  if (r.grp === "DR") {
    good = ok(t) && ok(d) && after.usage <= before.usage;            // revoke/reduction always allowed
  } else if (r.order === "transition_first") {
    good = ok(t) && ok(d) && d.waited < 800 && after.limit === 1 && after.usage === before.usage + 1 && after.usage > after.limit;
  } else {
    good = ok(d) && t.out.includes(SEAT_MSG) && after.limit === 1 && after.usage === before.usage;
  }
  report(r.key, r.order, good, `before=${before.limit}/${before.usage} after=${after.limit}/${after.usage} transition=[${t.out.slice(0, 70)}] downgrade=[${d.out}]`);
}

async function runMutual(r) {
  const k = r.k; const S = SID(k);
  const A = r.a(k), B = r.b(k);
  const first = r.order === "first_a" ? A : B, second = r.order === "first_a" ? B : A;
  const p1 = op(first[0], first[1], first[2], HOLD); await sleep(STAGGER_MS); const p2 = op(second[0], second[1], second[2], 0);
  const [f, s] = await Promise.all([p1, p2]);
  const after = await state(S);
  const good = ok(f) && s.out.includes(SEAT_MSG) && s.waited >= MINWAIT && after.usage <= after.limit && after.usage === 1;
  report(r.key, r.order, good, `final=${after.limit}/${after.usage} first=[${f.out}] second=[${s.out.slice(0, 80)}]`);
}

async function run() {
  for (const r of PLAN) { if (r.grp === "M") await runMutual(r); else await runDowngrade(r); }

  // Cross-studio: independent lock keys => neither waits.
  {
    const k1 = K_CROSS, k2 = K_CROSS + 1;
    const p1 = op("grant", SID(k1), IID(k1, 2), HOLD); await sleep(STAGGER_MS); const p2 = op("grant", SID(k2), IID(k2, 2), 0);
    const [a, b] = await Promise.all([p1, p2]);
    const s1 = await state(SID(k1)), s2 = await state(SID(k2));
    report("X1 cross-studio transitions do not wait", "-", ok(a) && ok(b) && b.waited < 800 && s1.usage === 1 && s2.usage === 1, `a=[${a.out}] b=[${b.out}]`);
  }
  console.log(`\n== RACES: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

const cmd = process.argv[2];
if (cmd === "setup") setup();
else if (cmd === "run") await run();
else if (cmd === "cleanup") cleanup();
else { console.error("usage: slice8_race_harness.mjs setup|run|cleanup"); process.exit(2); }

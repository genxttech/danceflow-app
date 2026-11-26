#!/usr/bin/env node
// FAIL-CLOSED EVIDENCE for the staff write gate (Phase 1A) on a PRODUCTION BUILD (`next build` + `next start`) of an exact commit, against a DISPOSABLE iso-qa --auth stack.
// LOCAL ONLY. No hosted database, no hosted URL, no secret from the repository or the owner. Access tokens come from the disposable GoTrue and stay in this process's memory.
//
//   node scripts/qa/staff-api/write-gate-matrix.mjs --stack <stack.json> --web-dir <worktree with a finished `next build`> --expect-commit <sha> --out <dir> [--port 3191]
//
// Phases (every cell is a pass/fail record in <out>/matrix.json; exit code 1 if any cell fails or the leak guard finds a token):
//   1 CLOSED   STAFF_API_WRITE_POLICY not set: 5 write routes x 5 staff roles x 4 header variants, valid existing ids, expect 403 writes_disabled and a byte-identical database;
//              plus unauthenticated / other studio / platform admin / bad ids refused with their own codes first.
//   2 VARIANTS the same build restarted with malformed or narrower policies: each capability opens ONLY its own route(s); everything else stays closed with zero mutation;
//              the open route(s) really write (positive control that the fixtures are valid), and the version gate (426) answers after the kill switch.
//   3 READS    GET /clients (leads in, archived out, ?status=, q, instructor scope), GET notes paging, /me /today /schedule /pulse /appointments/{id}.
import fs from "node:fs";
import path from "node:path";
import { Results, UUID_RE, Web, networkRetries, call, callRetry, diffSnapshots, leakGuard, loadStack, parseArgs, psql, q, randomUUID, signIn, snapshot, treeState } from "./r3-gate-lib.mjs";
import { ROLES, seed } from "./r3-gate-seed.mjs";

const args = parseArgs(process.argv.slice(2), { stack: "required", "web-dir": "required", "expect-commit": "required", out: "required", port: "optional" });
const OUT = path.resolve(args.out);
fs.mkdirSync(OUT, { recursive: true });
const env = loadStack(args.stack);
const results = new Results();
const log = (m) => console.log(`[matrix] ${m}`);

// ---- preflight: the build under test is exactly the requested commit, clean, and the policy variable is not set anywhere we control
const tree = treeState(args["web-dir"]);
if (tree.head !== args["expect-commit"] || !tree.clean) throw new Error(`web tree is ${tree.head} (clean: ${tree.clean}), expected ${args["expect-commit"]}: refusing`);
if (!fs.existsSync(path.join(args["web-dir"], ".next", "BUILD_ID"))) throw new Error("no production build (.next/BUILD_ID): run `next build` first");
if (process.env.STAFF_API_WRITE_POLICY !== undefined) throw new Error("STAFF_API_WRITE_POLICY is set in this shell: refusing (the closed phase needs it unset)");
const web = new Web({ dir: args["web-dir"], port: Number(args.port ?? 3191), stack: env, logFile: path.join(OUT, "next-start.log") });
const BASE = web.base;

const HEADERS = { valid: { "X-DanceFlow-App": "business/0.2.0/2/android" }, missing: {}, malformed: { "X-DanceFlow-App": "business/0.2.0/two/android" }, "other-app": { "X-DanceFlow-App": "student/0.2.0/2/android" } };
const VALID = HEADERS.valid;

const fx = await seed(env);
const tok = {};
for (const k of Object.keys(fx.users)) tok[k] = await signIn(env, fx.emails[k], fx.password);
const S = fx.S.a;
const newClientId = randomUUID();
const noteId = randomUUID();

/** Five gated write routes with valid, existing ids: each WOULD succeed if the gate were open. `cap` is the capability word that opens it. */
const ROUTES = [
  { key: "attendance", cap: "appointmentAttendance", method: "PUT", path: `/api/staff/workspaces/${S}/appointments/${fx.A.lesson}/attendance`, body: () => ({ status: "attended" }) },
  { key: "roster-add", cap: "classRoster", method: "POST", path: `/api/staff/workspaces/${S}/appointments/${fx.A.klass}/roster`, body: () => ({ clientId: fx.C.dee, billingType: "free_comped" }) },
  { key: "roster-remove", cap: "classRoster", method: "DELETE", path: `/api/staff/workspaces/${S}/appointments/${fx.A.klass}/roster/${fx.C.ana}`, body: () => undefined },
  { key: "note", cap: "clientNotes", method: "POST", path: `/api/staff/workspaces/${S}/clients/${fx.C.ana}/notes`, body: () => ({ noteId, noteType: "general", body: "Gate evidence note" }) },
  { key: "client", cap: "clientCreate", method: "POST", path: `/api/staff/workspaces/${S}/clients`, body: () => ({ clientId: newClientId, firstName: "Gate", lastName: "Newclient", phone: "5550111234" }) },
];
const send = (r, token, headers = VALID, extra = {}) =>
  callRetry(BASE, r.method, extra.path ?? r.path, { token, headers: { "Idempotency-Key": `gate-${r.key}-${randomUUID().slice(0, 8)}`, ...headers }, body: r.body() });

async function expectUnchanged(group, name, run, expected) {
  const before = snapshot(env);
  const res = await run();
  const after = snapshot(env);
  const changed = diffSnapshots(before, after);
  const codeOk = Array.isArray(expected.code) ? expected.code.includes(res.code) : res.code === expected.code;
  const ok = res.status === expected.status && codeOk && changed.length === 0;
  results.add(group, name, { status: expected.status, code: expected.code, dbChanged: false }, { status: res.status, code: res.code, dbChanged: changed.length > 0 ? changed : false, ...(res.retriedAfter429 ? { retriedAfter429: true } : {}) }, ok);
  return res;
}

// =============================================================================================================== 1 CLOSED (policy unset)
log("phase 1: policy UNSET");
await web.start(undefined);
const baseline = snapshot(env);
fs.writeFileSync(path.join(OUT, "snapshot-initial.json"), JSON.stringify(baseline, null, 1));
for (const r of ROUTES) {
  for (const role of ROLES) {
    // an independent instructor is not host-studio staff (FC-1): the identity guard may refuse first with not_a_member; both are closed refusals
    const code = role === "indie" ? ["writes_disabled", "not_a_member"] : "writes_disabled";
    for (const [hname, h] of Object.entries(HEADERS)) {
      await expectUnchanged("closed: role x header", `${r.method} ${r.key} | ${role} | header=${hname}`, () => send(r, tok[role], h), { status: 403, code });
    }
  }
}
for (const r of ROUTES) {
  await expectUnchanged("closed: identity refusals come first", `${r.key} | no token`, () => callRetry(BASE, r.method, r.path, { headers: { "Idempotency-Key": "gate-anon-0001", ...VALID }, body: r.body() }), { status: 401, code: "unauthenticated" });
  await expectUnchanged("closed: identity refusals come first", `${r.key} | garbage token`, () => callRetry(BASE, r.method, r.path, { token: "not-a-token", headers: { "Idempotency-Key": "gate-anon-0002", ...VALID }, body: r.body() }), { status: 401, code: "unauthenticated" });
  await expectUnchanged("closed: identity refusals come first", `${r.key} | studio B owner on studio A`, () => send(r, tok.studioB), { status: 403, code: "not_a_member" });
  await expectUnchanged("closed: identity refusals come first", `${r.key} | platform admin`, () => send(r, tok.platform), { status: 403, code: "platform_admin_unsupported" });
  await expectUnchanged("closed: identity refusals come first", `${r.key} | owner, studio id not a uuid`, () => send(r, tok.owner, VALID, { path: r.path.replace(S, "not-a-uuid") }), { status: 400, code: "invalid_request" });
}
const closedAfter = snapshot(env);
const closedDiff = diffSnapshots(baseline, closedAfter);
results.add("closed: whole phase", "database identical before and after all closed cells (every snapshot table)", { changedTables: [] }, { changedTables: closedDiff }, closedDiff.length === 0);

// =============================================================================================================== 2 VARIANTS
log("phase 2: policy variants");
const ALL_CLOSED_POLICIES = [
  ["empty string", ""],
  ["whitespace", "   "],
  ["not json", "not json"],
  ["json null", "null"],
  ["array", "[]"],
  ["enabled missing", "{}"],
  ["enabled is an empty array", '{"enabled":[]}'],
  ["enabled is a string", '{"enabled":"classRoster"}'],
  ["enabled has a non-string", '{"enabled":[7]}'],
  ["unknown word only", '{"enabled":["bogusWord"]}'],
  ["malformed minimumCode (string)", '{"enabled":["classRoster","clientNotes","clientCreate","appointmentAttendance"],"minimumCode":{"android":"two"}}'],
  ["malformed minimumCode (negative)", '{"enabled":["classRoster","clientNotes","clientCreate","appointmentAttendance"],"minimumCode":{"android":-1}}'],
  ["malformed minimumCode (not an object)", '{"enabled":["classRoster","clientNotes","clientCreate","appointmentAttendance"],"minimumCode":2}'],
  ["malformed blockedCodes", '{"enabled":["classRoster","clientNotes","clientCreate","appointmentAttendance"],"blockedCodes":{"android":"x"}}'],
];
for (const [label, policy] of ALL_CLOSED_POLICIES) {
  await web.start(policy);
  // a representative cell per route and role class, with a VALID header: nothing may open
  for (const r of ROUTES) {
    await expectUnchanged(`variant closed: ${label}`, `${r.key} | owner | valid header`, () => send(r, tok.owner), { status: 403, code: "writes_disabled" });
  }
  await expectUnchanged(`variant closed: ${label}`, `note | frontdesk | valid header`, () => send(ROUTES[3], tok.frontdesk), { status: 403, code: "writes_disabled" });
}

// one capability at a time: only its route(s) answer; the other capabilities stay closed. The open route really writes (fixtures valid).
const CAPS = ["clientCreate", "clientNotes", "classRoster", "appointmentAttendance"];
for (const cap of CAPS) {
  const policy = JSON.stringify({ enabled: [cap] });
  await web.start(policy);
  const label = `variant ${policy}`;
  for (const r of ROUTES.filter((x) => x.cap !== cap)) {
    await expectUnchanged(label, `${r.key} (${r.cap}) stays closed | owner`, () => send(r, tok.owner), { status: 403, code: "writes_disabled" });
  }
  // version gate answers AFTER the kill switch: an enabled capability with a missing / malformed header is 426 and writes nothing
  for (const r of ROUTES.filter((x) => x.cap === cap)) {
    for (const hname of ["missing", "malformed", "other-app"]) {
      await expectUnchanged(label, `${r.key} enabled, header=${hname}`, () => send(r, tok.owner, HEADERS[hname]), { status: 426, code: "upgrade_required" });
    }
  }
  // an unauthenticated / other-studio / platform caller still gets their own refusal on an ENABLED capability
  const open = ROUTES.find((x) => x.cap === cap);
  await expectUnchanged(label, `${open.key} enabled, no token`, () => callRetry(BASE, open.method, open.path, { headers: { "Idempotency-Key": "gate-anon-0003", ...VALID }, body: open.body() }), { status: 401, code: "unauthenticated" });
  await expectUnchanged(label, `${open.key} enabled, studio B owner`, () => send(open, tok.studioB), { status: 403, code: "not_a_member" });
  await expectUnchanged(label, `${open.key} enabled, platform admin`, () => send(open, tok.platform), { status: 403, code: "platform_admin_unsupported" });
  // positive control: the enabled route succeeds with the SAME valid ids and header, and changes exactly the tables it should
  for (const r of ROUTES.filter((x) => x.cap === cap)) {
    const before = snapshot(env);
    const res = await send(r, tok.owner);
    const changed = diffSnapshots(before, snapshot(env)).map((c) => c.table);
    const want = { attendance: [200], "roster-add": [201], "roster-remove": [200], note: [201], client: [201] }[r.key];
    results.add(label, `${r.key} enabled + valid header + valid ids writes`, { status: want, dbChanged: true }, { status: res.status, code: res.code, tables: changed }, want.includes(res.status) && changed.length > 0);
  }
}

// the version gate with a policy that enables everything: minimumCode and blockedCodes act, and still write nothing when refusing
const FULL = ["clientCreate", "clientNotes", "classRoster", "appointmentAttendance"];
for (const [label, policy, header, status, code] of [
  ["minimumCode 3 vs code 2", { enabled: FULL, minimumCode: { android: 3 } }, "business/0.2.0/2/android", 426, "upgrade_required"],
  ["blockedCodes [2] vs code 2", { enabled: FULL, blockedCodes: { android: [2] } }, "business/0.2.0/2/android", 426, "upgrade_required"],
  ["ios header with an android-only minimum is still allowed to reach the route", { enabled: FULL, minimumCode: { android: 3 } }, "business/0.2.0/1/ios", 201, null],
]) {
  await web.start(JSON.stringify(policy));
  const r = ROUTES[4]; // quick-add client
  const reqClient = randomUUID();
  const mine = { ...r, body: () => ({ clientId: reqClient, firstName: "Ver", lastName: "Gate", phone: `55501${Math.floor(10000 + Math.random() * 89999)}` }) };
  if (status === 426) await expectUnchanged(`version gate: ${label}`, "quick-add client refused, nothing written", () => send(mine, tok.owner, { "X-DanceFlow-App": header }), { status, code });
  else {
    const res = await send(mine, tok.owner, { "X-DanceFlow-App": header });
    results.add(`version gate: ${label}`, "quick-add client allowed", { status }, { status: res.status, code: res.code }, res.status === status);
  }
}

// =============================================================================================================== 3 READS (policy unset)
log("phase 3: reads");
await web.start(undefined);
const W = (p) => `/api/staff/workspaces/${S}${p}`;
const get = (p, role = "owner", headers = {}) => callRetry(BASE, "GET", p, { token: tok[role], headers });
const names = (res) => (res.json?.clients ?? []).map((c) => `${c.firstName} ${c.lastName}`.trim());
const statusOf = (res) => res.status;
const check = (name, expected, actual, ok) => results.add("reads", name, expected, actual, ok);

const meRes = await get("/api/staff/me");
check("GET /api/staff/me lists the workspace", { status: 200 }, { status: meRes.status }, meRes.status === 200);
for (const [name, p] of [["today", W("/today")], ["schedule", W("/schedule")], ["pulse", W("/pulse")], ["appointment detail", W(`/appointments/${fx.A.lesson2}`)]]) {
  const r = await get(p);
  check(`GET ${name} (owner)`, { status: 200 }, { status: r.status, code: r.code }, r.status === 200);
}
const def = await get(W("/clients?limit=50"));
const defNames = names(def);
check("GET /clients default: leads and inactive are included, archived is hidden", { includes: ["Lena Lead", "Ana Rivera", "Ina Ctive"], excludes: ["Arch Ived"] }, { status: def.status, names: defNames },
  def.status === 200 && ["Lena Lead", "Ana Rivera", "Ina Ctive"].every((n) => defNames.includes(n)) && !defNames.includes("Arch Ived"));
const lead = await get(W("/clients?status=lead"));
const nonLeads = ["Ana Rivera", "Sam Okafor", "Colin Marsh", "Dee Walker", "Ina Ctive", "Arch Ived"];
check("GET /clients?status=lead returns the lead (and the leads quick-added by the variant cells above), no other status", { includes: "Lena Lead", excludesAll: nonLeads }, { status: lead.status, names: names(lead) }, lead.status === 200 && names(lead).includes("Lena Lead") && nonLeads.every((n) => !names(lead).includes(n)));
const arch = await get(W("/clients?status=archived"));
check("GET /clients?status=archived is allowed and returns the archived client (explicit request)", { status: 200 }, { status: arch.status, names: names(arch) }, arch.status === 200);
const bad = await get(W("/clients?status=bogus"));
check("GET /clients?status=bogus is refused", { status: 400, code: "invalid_request" }, { status: bad.status, code: bad.code }, bad.status === 400 && bad.code === "invalid_request");
const search = await get(W("/clients?q=Okafor"));
check("GET /clients?q=Okafor finds Sam", { names: ["Sam Okafor"] }, { status: search.status, names: names(search) }, search.status === 200 && names(search).includes("Sam Okafor"));
for (const role of ["admin", "frontdesk"]) {
  const r = await get(W("/clients?limit=50"), role);
  check(`GET /clients as ${role}: same visibility as the owner`, { includes: "Lena Lead", excludes: "Arch Ived" }, { status: r.status, names: names(r) }, r.status === 200 && names(r).includes("Lena Lead") && !names(r).includes("Arch Ived"));
}
// instructor scope: only the clients they teach (Ana and Sam have a lesson with Ida), no leads, no status filter
const ins = await get(W("/clients?limit=50"), "instructor");
check("GET /clients as instructor: only taught clients, no lead", { includesAny: ["Ana Rivera", "Sam Okafor"], excludes: ["Lena Lead", "Arch Ived", "Dee Walker"] }, { status: ins.status, code: ins.code, names: names(ins) },
  ins.status === 200 && !names(ins).includes("Lena Lead") && !names(ins).includes("Arch Ived") && !names(ins).includes("Dee Walker") && names(ins).length > 0);
const insNote = await get(W(`/clients/${fx.C.ana}/notes`), "instructor");
check("GET notes as instructor is refused (role)", { status: 403, code: "role_not_permitted" }, { status: insNote.status, code: insNote.code }, insNote.status === 403 && insNote.code === "role_not_permitted");

// notes paging: five notes inserted straight into the disposable database, newest first, limit 2 -> cursors
psql(env, `set session_replication_role = replica; ${[1, 2, 3, 4, 5].map((i) => `insert into public.client_activity_notes (id, studio_id, client_id, created_by, note_type, body, occurred_at) values (${q(randomUUID())}, ${q(S)}, ${q(fx.C.sam)}, ${q(fx.users.owner)}, 'general', 'paging note ${i}', now() - interval '${i} minutes');`).join(" ")}`);
let cursor = null;
const seen = [];
let pages = 0;
for (;;) {
  const r = await get(W(`/clients/${fx.C.sam}/notes?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
  if (r.status !== 200) { check("GET notes paging page", { status: 200 }, { status: r.status, code: r.code }, false); break; }
  pages++;
  seen.push(...(r.json.notes ?? []).map((n) => n.body));
  cursor = r.json.nextCursor ?? null;
  if (!cursor || pages > 6) break;
}
check("GET notes paging: 5 notes in 3 pages of 2, newest first, no duplicates", { pages: 3, order: ["paging note 1", "paging note 2", "paging note 3", "paging note 4", "paging note 5"] }, { pages, seen },
  pages === 3 && JSON.stringify(seen) === JSON.stringify(["paging note 1", "paging note 2", "paging note 3", "paging note 4", "paging note 5"]));
const badCursor = await get(W(`/clients/${fx.C.sam}/notes?cursor=zzz`));
check("GET notes with a bad cursor is refused", { status: 400 }, { status: badCursor.status, code: badCursor.code }, badCursor.status === 400);

// =============================================================================================================== wrap-up
await web.stop();
const summary = results.summary();
fs.writeFileSync(path.join(OUT, "matrix.json"), JSON.stringify({ generatedAt: new Date().toISOString(), commit: tree.head, treeClean: tree.clean, stack: "iso-qa (disposable, loopback)", policyAtStart: "STAFF_API_WRITE_POLICY not set", summary, networkRetries: networkRetries.count, cells: results.cells }, null, 1));
const md = [`# Write-gate matrix: ${summary.pass}/${summary.total} cells PASS (${summary.fail} FAIL)`, "", `Commit under test: ${tree.head} (clean worktree, production build)`, "", "| Group | Pass | Fail |", "|---|---|---|", ...Object.entries(summary.groups).map(([g, v]) => `| ${g} | ${v.pass} | ${v.fail} |`), "", ...results.cells.filter((c) => !c.ok).map((c) => `- FAIL ${c.group} :: ${c.name}: expected ${JSON.stringify(c.expected)} got ${JSON.stringify(c.actual)}`)].join("\n");
fs.writeFileSync(path.join(OUT, "matrix.md"), md + "\n");
fs.writeFileSync(path.join(OUT, "snapshot-final.json"), JSON.stringify(snapshot(env), null, 1));
const leaks = leakGuard(OUT, env);
fs.writeFileSync(path.join(OUT, "leak-guard.txt"), leaks.length ? leaks.join("\n") + "\n" : `leak guard: no access token, refresh token, JWT-shaped string or stack key in ${fs.readdirSync(OUT).length} saved files\n`);
console.log(md);
console.log(leaks.length ? `LEAK GUARD FAILED: ${leaks.join("; ")}` : "leak guard: clean");
process.exit(summary.fail === 0 && leaks.length === 0 ? 0 : 1);

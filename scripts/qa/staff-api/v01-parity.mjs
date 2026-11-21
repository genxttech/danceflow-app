#!/usr/bin/env node
// Differential for the routes the write gate deliberately does NOT cover: the shipped v0.1 class-attendance route (PUT .../attendance/{clientId}) and the reads the backport
// does not change. The same requests, with equivalent fresh fixtures, are sent to two production builds (the previous live commit and the backport commit) on the same
// disposable iso-qa stack; the normalized responses (ids and times masked) must be identical.
//
//   node scripts/qa/staff-api/v01-parity.mjs run --stack <stack.json> --web-dir <worktree with a finished build> --expect-commit <sha> --label <name> --out <file.json> [--port 3192]
//   node scripts/qa/staff-api/v01-parity.mjs compare <a.json> <b.json>
import fs from "node:fs";
import { Web, callRetry, leakGuard, loadStack, parseArgs, psql, q, randomUUID, signIn, treeState, Results } from "./r3-gate-lib.mjs";
import { seed } from "./r3-gate-seed.mjs";

if (process.argv[2] === "compare") {
  const [a, b] = process.argv.slice(3).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  let diffs = 0;
  for (const cell of a.cells) {
    const other = b.cells.find((c) => c.name === cell.name);
    const norm = (c) => JSON.stringify(c.normalized).replace(/[a-z]+.v[A-Za-z0-9]+@example.test/g, "<email>").replace(/maple-[0-9a-f]{8}/g, "<slug>");
    const same = other && norm(other) === norm(cell);
    // the notes GET route is new in the backport (it did not exist on the previous live commit): the one intended difference
    if (!same && cell.name === "GET notes (owner)" && cell.normalized.status === 404 && other?.normalized.status === 200) {
      console.log("EXPECTED-NEW GET notes (owner): 404 on the previous commit (route absent), 200 on the backport");
      continue;
    }
    if (!same) {
      diffs++;
      console.log(`DIFF ${cell.name}\n  ${a.label}: ${JSON.stringify(cell.normalized)}\n  ${b.label}: ${JSON.stringify(other?.normalized)}`);
    }
  }
  if (a.cells.length !== b.cells.length) diffs++;
  console.log(`${a.cells.length} cells (${a.label} ${a.commit.slice(0, 8)}) vs ${b.cells.length} cells (${b.label} ${b.commit.slice(0, 8)}): ${diffs === 0 ? "IDENTICAL" : `${diffs} DIFFERENT`}`);
  process.exit(diffs === 0 ? 0 : 1);
}

const args = parseArgs(process.argv.slice(3), { stack: "required", "web-dir": "required", "expect-commit": "required", label: "required", out: "required", port: "optional" });
const env = loadStack(args.stack);
const tree = treeState(args["web-dir"]);
if (tree.head !== args["expect-commit"] || !tree.clean) throw new Error(`web tree is ${tree.head} (clean: ${tree.clean}), expected ${args["expect-commit"]}: refusing`);
if (process.env.STAFF_API_WRITE_POLICY !== undefined) throw new Error("STAFF_API_WRITE_POLICY is set in this shell: refusing");
const outDir = args.out.replace(/[^/\\]+$/, "") || ".";
const web = new Web({ dir: args["web-dir"], port: Number(args.port ?? 3192), stack: env, logFile: `${args.out}.server.log` });
await web.start(undefined);

const fx = await seed(env, `v${args.label}`);
const tok = {};
for (const k of Object.keys(fx.users)) tok[k] = await signIn(env, fx.emails[k], fx.password);
const S = fx.S.a;
// class attendees: Ana (seeded), plus Sam, Colin, Dee for the other roles
psql(env, `set session_replication_role = replica; insert into public.appointment_attendees (studio_id, appointment_id, client_id, source, status) values ${[fx.C.sam, fx.C.colin, fx.C.dee].map((c) => `(${q(S)}, ${q(fx.A.klass)}, ${q(c)}, 'staff', 'booked')`).join(", ")};`);

const mask = (v) => JSON.parse(JSON.stringify(v ?? null).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})?/g, "<time>"));
const cells = [];
const cell = async (name, method, p, { role, headers, body, rawBody } = {}) => {
  const res = await callRetry(web.base, method, p, { token: role ? tok[role] : undefined, headers, body, rawBody });
  cells.push({ name, normalized: { status: res.status, code: res.code, body: mask(res.json ?? res.text) } });
};
const att = (clientId, appt = fx.A.klass) => `/api/staff/workspaces/${S}/appointments/${appt}/attendance/${clientId}`;
const key = (i) => ({ "Idempotency-Key": `parity-key-${i}-00` });

await cell("owner marks Ana attended", "PUT", att(fx.C.ana), { role: "owner", headers: key(1), body: { status: "attended" } });
await cell("same request again (state-based idempotency)", "PUT", att(fx.C.ana), { role: "owner", headers: key(2), body: { status: "attended" } });
await cell("Ana attended then no_show (terminal)", "PUT", att(fx.C.ana), { role: "owner", headers: key(3), body: { status: "no_show" } });
await cell("admin marks Sam no_show", "PUT", att(fx.C.sam), { role: "admin", headers: key(4), body: { status: "no_show" } });
await cell("front desk marks Colin attended", "PUT", att(fx.C.colin), { role: "frontdesk", headers: key(5), body: { status: "attended" } });
await cell("instructor marks Dee attended (their class)", "PUT", att(fx.C.dee), { role: "instructor", headers: key(6), body: { status: "attended" } });
await cell("independent instructor", "PUT", att(fx.C.dee), { role: "indie", headers: key(7), body: { status: "attended" } });
await cell("missing Idempotency-Key", "PUT", att(fx.C.ana), { role: "owner", body: { status: "attended" } });
await cell("short Idempotency-Key", "PUT", att(fx.C.ana), { role: "owner", headers: { "Idempotency-Key": "short" }, body: { status: "attended" } });
await cell("bad status", "PUT", att(fx.C.ana), { role: "owner", headers: key(8), body: { status: "late" } });
await cell("body not JSON", "PUT", att(fx.C.ana), { role: "owner", headers: key(9), rawBody: "{" });
await cell("invalid class id", "PUT", att(fx.C.ana, "nope"), { role: "owner", headers: key(10), body: { status: "attended" } });
await cell("client not on the roster", "PUT", att(fx.C.lena), { role: "owner", headers: key(11), body: { status: "attended" } });
await cell("no token", "PUT", att(fx.C.ana), { headers: key(12), body: { status: "attended" } });
await cell("other studio owner", "PUT", att(fx.C.ana), { role: "studioB", headers: key(13), body: { status: "attended" } });
await cell("platform admin", "PUT", att(fx.C.ana), { role: "platform", headers: key(14), body: { status: "attended" } });
await cell("with an X-DanceFlow-App header (ignored by this route)", "PUT", att(fx.C.ana), { role: "owner", headers: { ...key(15), "X-DanceFlow-App": "business/0.1.0/1/android" }, body: { status: "attended" } });
for (const [name, p] of [["me", "/api/staff/me"], ["today", `/api/staff/workspaces/${S}/today`], ["schedule", `/api/staff/workspaces/${S}/schedule`], ["pulse", `/api/staff/workspaces/${S}/pulse`], ["appointment detail", `/api/staff/workspaces/${S}/appointments/${fx.A.lesson2}`], ["client summary", `/api/staff/workspaces/${S}/clients/${fx.C.ana}`], ["notes", `/api/staff/workspaces/${S}/clients/${fx.C.ana}/notes`]]) {
  await cell(`GET ${name} (owner)`, "GET", p, { role: "owner" });
}
await cell("GET today (instructor)", "GET", `/api/staff/workspaces/${S}/today`, { role: "instructor" });
await cell("GET schedule (other studio)", "GET", `/api/staff/workspaces/${S}/schedule`, { role: "studioB" });

await web.stop();
fs.writeFileSync(args.out, JSON.stringify({ label: args.label, commit: tree.head, cells }, null, 1));
const leaks = leakGuard(outDir, env);
console.log(`${cells.length} cells saved for ${args.label} (${tree.head.slice(0, 8)}); leak guard: ${leaks.length ? leaks.join("; ") : "clean"}`);
process.exit(leaks.length ? 1 : 0);

#!/usr/bin/env node
// The web actions the staff-API backport moved onto the shared libraries, driven in a real browser against a PRODUCTION BUILD (`next start`) of an exact commit and a
// DISPOSABLE iso-qa --auth stack, signed in as seeded staff. Every step asserts on the database afterwards. LOCAL ONLY; passwords are the disposable stack's and stay in memory.
//
//   node scripts/qa/staff-api/web-actions-qa.mjs --stack <stack.json> --web-dir <worktree with a finished build> --expect-commit <sha> --out <dir> [--port 3194] [--chrome <path to chrome.exe>]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Results, Web, leakGuard, loadStack, parseArgs, psql, q, randomUUID, snapshot, diffSnapshots, treeState } from "./r3-gate-lib.mjs";
import { seed } from "./r3-gate-seed.mjs";

const args = parseArgs(process.argv.slice(2), { stack: "required", "web-dir": "required", "expect-commit": "required", out: "required", port: "optional", chrome: "optional" });
const OUT = path.resolve(args.out);
fs.mkdirSync(OUT, { recursive: true });
const env = loadStack(args.stack);
const tree = treeState(args["web-dir"]);
if (tree.head !== args["expect-commit"] || !tree.clean) throw new Error(`web tree is ${tree.head} (clean: ${tree.clean}), expected ${args["expect-commit"]}: refusing`);
if (process.env.STAFF_API_WRITE_POLICY !== undefined) throw new Error("STAFF_API_WRITE_POLICY is set in this shell: refusing");
const { chromium } = createRequire(path.join(args["web-dir"], "package.json"))("playwright");
const results = new Results();
const log = (m) => console.log(`[web] ${m}`);
const web = new Web({ dir: args["web-dir"], port: Number(args.port ?? 3194), stack: env, logFile: path.join(OUT, "next-start.log") });
await web.start(undefined);
const fx = await seed(env, `w${Date.now().toString(36)}`);
const S = fx.S.a;
const one = (sql) => psql(env, sql);
const num = (sql) => Number(one(sql));

// ------------------------------------------------------------------ extra fixtures: packages and lessons that charge them
const P = { colin: randomUUID(), dee: randomUUID(), sam: randomUUID(), ana: randomUUID() };
const L = { attendPkg: randomUUID(), nsNone: randomUUID(), nsPkg: randomUUID(), nsConflict: randomUUID(), nsPkg2: randomUUID() };
const pkg = (id, client, name) => `insert into public.client_packages (id, studio_id, client_id, name_snapshot, lessons_remaining) values (${q(id)}, ${q(S)}, ${q(client)}, ${q(name)}, 5);
  insert into public.client_package_items (studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining) values (${q(S)}, ${q(id)}, 'private_lesson', 5, 0, 5);`;
const lesson = (id, client, hoursAgo, billing, pkgId) => `insert into public.appointments (id, studio_id, instructor_id, appointment_type, client_id, room_id, starts_at, ends_at, status, price_amount, billing_type, client_package_id)
  values (${q(id)}, ${q(S)}, ${q(fx.I.ida)}, 'private_lesson', ${q(client)}, ${q(fx.R.a)}, now() - interval '${hoursAgo} hours', now() - interval '${hoursAgo} hours' + interval '45 minutes', 'scheduled', 125, ${q(billing)}, ${pkgId ? q(pkgId) : "null"});`;
psql(env, `begin; set local session_replication_role = replica;
${pkg(P.colin, fx.C.colin, "QA 5 pack Colin")} ${pkg(P.dee, fx.C.dee, "QA 5 pack Dee")} ${pkg(P.sam, fx.C.sam, "QA 5 pack Sam")} ${pkg(P.ana, fx.C.ana, "QA 5 pack Ana")}
${lesson(L.attendPkg, fx.C.colin, 8, "package_credit", P.colin)}
${lesson(L.nsNone, fx.C.sam, 9, "free_comped", null)}
${lesson(L.nsPkg, fx.C.dee, 10, "package_credit", P.dee)}
${lesson(L.nsConflict, fx.C.sam, 11, "package_credit", P.sam)}
${lesson(L.nsPkg2, fx.C.ana, 12, "package_credit", P.ana)}
commit;`);
const txCount = (appt) => num(`select count(*) from public.lesson_transactions where appointment_id=${q(appt)}`);
const used = (pk) => num(`select quantity_used from public.client_package_items where client_package_id=${q(pk)}`);
const status = (appt) => one(`select status from public.appointments where id=${q(appt)}`);
const noteRows = (client) => one(`select coalesce(string_agg(body, ' || ' order by created_at), '') from public.client_activity_notes where client_id=${q(client)}`);
const noteCount = (client) => num(`select count(*) from public.client_activity_notes where client_id=${q(client)}`);

// ------------------------------------------------------------------ browser
const browser = await chromium.launch({ executablePath: args.chrome ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
context.setDefaultTimeout(45_000);
let shots = 0;
async function shot(page, name) {
  const f = `${String(++shots).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 50)}.png`;
  await page.screenshot({ path: path.join(OUT, f), fullPage: true }).catch(() => {});
  return f;
}
async function login(role) {
  const page = await context.newPage();
  await page.goto(`${web.base}/login`);
  const form = page.locator("form:has(input[name=password])");
  await form.locator("input[name=email]").fill(fx.emails[role]);
  await form.locator("input[name=password]").fill(fx.password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }), form.locator("button[type=submit]").click()]);
  return page;
}
const settle = async (page) => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(800);
};
const until = async (fn, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return fn();
};
const bodyText = async (page) => (await page.locator("body").innerText()).replace(/\s+/g, " ");
const urlOf = (page) => new URL(page.url());
async function step(group, name, fn) {
  try {
    const r = await fn();
    results.add(group, name, r.expected, r.actual, r.ok);
  } catch (e) {
    results.add(group, name, "step runs to the end", String(e.message).slice(0, 300), false);
  }
}

const page = await login("owner");
log("signed in as owner");
await page.goto(`${web.base}/app/schedule/${L.attendPkg}`);
await settle(page);
await shot(page, "lesson-detail");

// ------------------------------------------------------------------ 1 attended
await step("web: mark attended", "private lesson on a package: attended, exactly one deduction", async () => {
  const before = { tx: txCount(L.attendPkg), used: used(P.colin) };
  await page.getByRole("button", { name: "Mark Attended" }).click();
  await settle(page);
  await shot(page, "after-attended");
  const after = { status: status(L.attendPkg), tx: txCount(L.attendPkg), used: used(P.colin) };
  return { expected: { status: "attended", tx: 1, used: 1, before: { tx: 0, used: 0 } }, actual: { ...after, before }, ok: after.status === "attended" && after.tx === 1 && after.used === 1 && before.tx === 0 };
});

// ------------------------------------------------------------------ 2 no-show: none / package / idempotent re-submit / different decision
async function noShowForm(p, charge) {
  await p.locator("summary", { hasText: "Mark No Show" }).click();
  await p.locator("#noShowMissedAppointmentCharge").selectOption(charge);
  await p.getByRole("button", { name: "Confirm No Show" }).click();
  await settle(p);
}
await step("web: no-show", "no charge: no deduction, note says 'No lesson deduction' with the appointment ref", async () => {
  await page.goto(`${web.base}/app/schedule/${L.nsNone}`);
  await settle(page);
  const before = { notes: noteCount(fx.C.sam), tx: txCount(L.nsNone) };
  await noShowForm(page, "none");
  const notes = noteRows(fx.C.sam);
  const after = { status: status(L.nsNone), tx: txCount(L.nsNone), notes: noteCount(fx.C.sam) - before.notes };
  return { expected: { status: "no_show", tx: 0, newNotes: 1, noteHas: ["No lesson deduction", `Appointment ref: ${L.nsNone}`] }, actual: { ...after, noteTail: notes.slice(-220) },
    ok: after.status === "no_show" && after.tx === 0 && after.notes === 1 && notes.includes("No lesson deduction") && notes.includes(`Appointment ref: ${L.nsNone}`) };
});

await step("web: no-show", "package charge: exactly one credit deducted, note rewritten to 'deducted'", async () => {
  await page.goto(`${web.base}/app/schedule/${L.nsPkg}`);
  await settle(page);
  const before = { tx: txCount(L.nsPkg), used: used(P.dee), notes: noteCount(fx.C.dee) };
  await noShowForm(page, "package");
  await shot(page, "after-noshow-package");
  const notes = noteRows(fx.C.dee);
  const after = { status: status(L.nsPkg), tx: txCount(L.nsPkg), used: used(P.dee), newNotes: noteCount(fx.C.dee) - before.notes };
  return { expected: { status: "no_show", tx: 1, used: 1, newNotes: 1, noteMentions: "deducted" }, actual: { ...after, noteTail: notes.slice(-260) },
    ok: after.status === "no_show" && after.tx === 1 && after.used === 1 && after.newNotes === 1 && /deducted/i.test(notes) && !/requested, not applied/i.test(notes) };
});

await step("web: no-show", "re-submitting the same no-show (stale tab, same charge) is idempotent: no second deduction, no duplicate note", async () => {
  // two tabs open on the same open lesson; the first records the no-show with a package charge, the second still shows the form and submits the same decision
  const a = await context.newPage();
  const b = await context.newPage();
  for (const p of [a, b]) {
    await p.goto(`${web.base}/app/schedule/${L.nsPkg2}`);
    await settle(p);
  }
  await noShowForm(a, "package");
  await until(() => txCount(L.nsPkg2) === 1);
  const mid = { tx: txCount(L.nsPkg2), used: used(P.ana), notes: noteCount(fx.C.ana) };
  await noShowForm(b, "package");
  await b.waitForTimeout(3000);
  await shot(b, "stale-tab-same-decision");
  const after = { tx: txCount(L.nsPkg2), used: used(P.ana), notes: noteCount(fx.C.ana), url: urlOf(b).search };
  return { expected: { afterFirst: { tx: 1, used: 1, notes: 1 }, afterSecond: "unchanged" }, actual: { mid, after }, ok: mid.tx === 1 && mid.used === 1 && mid.notes === 1 && after.tx === 1 && after.used === 1 && after.notes === 1 };
});

await step("web: no-show", "a DIFFERENT charge decision after a charge was applied is refused with the new message and changes nothing", async () => {
  const a = await context.newPage();
  const b = await context.newPage();
  for (const p of [a, b]) {
    await p.goto(`${web.base}/app/schedule/${L.nsConflict}`);
    await settle(p);
  }
  await noShowForm(a, "package");
  await until(() => txCount(L.nsConflict) === 1);
  const mid = { tx: txCount(L.nsConflict), used: used(P.sam) };
  const before = snapshot(env);
  await noShowForm(b, "none");
  await b.getByText("already recorded with a different charge decision").first().waitFor({ timeout: 15_000 }).catch(() => {});
  const text = await bodyText(b);
  await shot(b, "stale-tab-different-decision");
  const changed = diffSnapshots(before, snapshot(env));
  const msg = "already recorded with a different charge decision";
  return { expected: { message: msg, dbChanged: false }, actual: { mid, url: decodeURIComponent(urlOf(b).search).slice(0, 200), hasMessage: text.includes(msg), messageInRedirect: decodeURIComponent(urlOf(b).search).includes(msg), dbChanged: changed }, ok: mid.tx === 1 && mid.used === 1 && (text.includes(msg) || decodeURIComponent(urlOf(b).search).includes(msg)) && changed.length === 0 };
});

// ------------------------------------------------------------------ 3 add client (and the duplicate-email refusal)
const email = `webnew.${Date.now().toString(36)}@example.test`;
await step("web: add client", "new client with an email is created and opened", async () => {
  await page.goto(`${web.base}/app/clients/new`);
  await settle(page);
  const before = num(`select count(*) from public.clients where studio_id=${q(S)}`);
  await page.locator("#firstName").fill("Webby");
  await page.locator("#lastName").fill("Created");
  await page.locator("#email").fill(email);
  await page.locator("#phone").fill("5550177001");
  await shot(page, "client-form");
  await page.getByRole("button", { name: /^(Create|Add|Save)/i }).first().click();
  await settle(page);
  await shot(page, "client-created");
  const after = num(`select count(*) from public.clients where studio_id=${q(S)}`);
  const row = one(`select first_name||' '||last_name||'/'||coalesce(status::text,'') from public.clients where studio_id=${q(S)} and lower(email)=lower(${q(email)})`);
  return { expected: { delta: 1, row: "Webby Created" }, actual: { delta: after - before, row, url: urlOf(page).pathname }, ok: after - before === 1 && row.startsWith("Webby Created") };
});
await step("web: add client", "the same email again is refused and no row is added", async () => {
  await page.goto(`${web.base}/app/clients/new`);
  await settle(page);
  const before = num(`select count(*) from public.clients where studio_id=${q(S)}`);
  await page.locator("#firstName").fill("Webby");
  await page.locator("#lastName").fill("Duplicate");
  await page.locator("#email").fill(email);
  await page.locator("#phone").fill("5550177002");
  await page.getByRole("button", { name: /^(Create|Add|Save)/i }).first().click();
  await settle(page);
  await page.getByText(/already exists/i).first().waitFor({ timeout: 15_000 }).catch(() => {});
  const text = await bodyText(page);
  await shot(page, "client-duplicate");
  const after = num(`select count(*) from public.clients where studio_id=${q(S)}`);
  return { expected: { delta: 0, refusal: true }, actual: { delta: after - before, url: urlOf(page).search.slice(0, 120), mentionsDuplicate: /already exists|duplicate/i.test(text) }, ok: after === before && /already exists|duplicate/i.test(text + urlOf(page).search) };
});

// ------------------------------------------------------------------ 4 client note
await step("web: client note", "a note typed on the client page is saved", async () => {
  await page.goto(`${web.base}/app/clients/${fx.C.lena}?tab=notes`);
  await settle(page);
  const before = noteCount(fx.C.lena);
  await page.locator("#clientActivityNoteBody").fill("Web action note for the gate evidence");
  await page.getByRole("button", { name: "Add Note" }).click();
  await settle(page);
  await shot(page, "client-note");
  const after = noteCount(fx.C.lena);
  return { expected: { delta: 1, body: "Web action note for the gate evidence" }, actual: { delta: after - before, tail: noteRows(fx.C.lena).slice(-80) }, ok: after - before === 1 && noteRows(fx.C.lena).includes("Web action note for the gate evidence") };
});

// ------------------------------------------------------------------ 5 class roster: enroll + cancel
const attendee = (client) => one(`select coalesce((select status from public.appointment_attendees where appointment_id=${q(fx.A.klass)} and client_id=${q(client)} order by created_at desc limit 1), 'none')`);
const outbox = () => ({ notifications: num("select count(*) from public.notifications"), deliveries: num("select count(*) from public.notification_deliveries") });
await step("web: class roster", "enroll a dancer in the class (free/comped) and the dancer is booked", async () => {
  await page.goto(`${web.base}/app/schedule/enroll-student?appointmentId=${fx.A.klass}`);
  await settle(page);
  await shot(page, "enroll-form");
  const before = { attendee: attendee(fx.C.sam), ob: outbox() };
  await page.locator("#clientId").selectOption(fx.C.sam);
  await settle(page);
  const billing = page.locator("#billingType");
  if (await billing.count()) await billing.selectOption("free_comped");
  await shot(page, "enroll-form-filled");
  await page.locator("button[type=submit]").last().click();
  await settle(page);
  await shot(page, "enroll-done");
  const after = { attendee: attendee(fx.C.sam), ob: outbox() };
  return { expected: { attendee: "booked" }, actual: { before, after, url: urlOf(page).pathname + urlOf(page).search.slice(0, 80) }, ok: after.attendee === "booked" };
});
await step("web: class roster", "enrolling the same dancer again is refused and the roster is unchanged", async () => {
  await page.goto(`${web.base}/app/schedule/enroll-student?appointmentId=${fx.A.klass}`);
  await settle(page);
  const before = num(`select count(*) from public.appointment_attendees where appointment_id=${q(fx.A.klass)}`);
  await page.locator("#clientId").selectOption(fx.C.sam).catch(() => {});
  await settle(page);
  const billing = page.locator("#billingType");
  if (await billing.count()) await billing.selectOption("free_comped");
  await page.locator("button[type=submit]").last().click();
  await settle(page);
  await shot(page, "enroll-again");
  const after = num(`select count(*) from public.appointment_attendees where appointment_id=${q(fx.A.klass)}`);
  return { expected: { delta: 0 }, actual: { delta: after - before, url: urlOf(page).search.slice(0, 100) }, ok: after === before };
});
await step("web: class roster", "remove the dancer from the class and the dancer is cancelled", async () => {
  await page.goto(`${web.base}/app/schedule/${fx.A.klass}`);
  await settle(page);
  await shot(page, "class-detail");
  const row = page.locator("div").filter({ hasText: "Sam Okafor" }).filter({ has: page.locator("summary", { hasText: "Remove" }) }).last();
  const details = row.locator("details").filter({ has: page.locator("summary", { hasText: "Remove" }) }).first();
  await details.locator("summary").click();
  await shot(page, "class-remove-open");
  await details.locator("button[type=submit]").first().click();
  await settle(page);
  await until(() => attendee(fx.C.sam) === "cancelled", 15_000);
  await shot(page, "class-after-remove");
  const now = attendee(fx.C.sam);
  return { expected: { attendee: "cancelled" }, actual: { attendee: now, url: urlOf(page).search.slice(0, 100) }, ok: now === "cancelled" };
});

await browser.close();
await web.stop();
const summary = results.summary();
fs.writeFileSync(path.join(OUT, "web-actions.json"), JSON.stringify({ generatedAt: new Date().toISOString(), commit: tree.head, summary, cells: results.cells }, null, 1));
const md = [`# Web actions: ${summary.pass}/${summary.total} PASS`, "", ...results.cells.map((c) => `- ${c.ok ? "PASS" : "FAIL"} [${c.group}] ${c.name}${c.ok ? "" : `: expected ${JSON.stringify(c.expected)} got ${JSON.stringify(c.actual)}`}`)].join("\n");
fs.writeFileSync(path.join(OUT, "web-actions.md"), md + "\n");
const leaks = leakGuard(OUT, env);
console.log(md);
console.log(leaks.length ? `LEAK GUARD FAILED: ${leaks.join("; ")}` : "leak guard: clean");
process.exit(summary.fail === 0 && leaks.length === 0 ? 0 : 1);

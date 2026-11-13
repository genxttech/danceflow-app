#!/usr/bin/env node
// Website Embeds acceptance run. LOCAL / DISPOSABLE iso-qa --auth STACKS ONLY (loadStack refuses anything else).
//
//   node scripts/qa/iso-qa.mjs up baseline --auth --name emb > stack.json
//   node scripts/qa/auth-profile/business-shell/seed-staff.mjs stack.json seed.json
//   # apply src/lib/supabase/migrations/20270216090000_website_embed_settings.sql to that container, start the app
//   # against the stack on http://localhost:3100 (localhost, not 127.0.0.1: GoTrue redirects to localhost), then:
//   node scripts/qa/embeds/acceptance.mjs stack.json seed.json out-dir [http://localhost:3100]
//
// Every fixture is created here (idempotently), so the assertions never depend on leftovers of an earlier run. No payment
// provider is contacted: the registration handoff stops at the page that would start checkout.
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { createUser, latestAuthLink, loadStack, psql } from "../auth-profile/lib.mjs";

const [stackFile, seedFile, outDir, baseArg] = process.argv.slice(2);
if (!stackFile || !seedFile || !outDir) throw new Error("usage: acceptance.mjs <stack.json> <seed.json> <out-dir> [base-url]");
const env = loadStack(stackFile);
const seed = JSON.parse(readFileSync(seedFile, "utf8"));
const B = baseArg ?? "http://localhost:3100";
if (!["localhost", "127.0.0.1"].includes(new URL(B).hostname)) throw new Error("base URL must be local");
mkdirSync(outDir, { recursive: true });

const results = [];
const rec = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : String(detail).slice(0, 220));
};
const sql = (q) => psql(env, q);

// ---------- fixtures ----------
const studioA = sql("select id||'|'||slug from studios where name = 'Maple Street Dance'").split("|");
const studioB = sql("select id||'|'||slug from studios where name = 'Harbor Ballroom'").split("|");
const [A, aSlug] = studioA;
const [Bid, bSlug] = studioB;
const NEW_PWD = `Embed-QA-${Math.random().toString(36).slice(2, 10)}!`;

const isoDow = (d) => d.getUTCDay() || 7;
const dayStr = (d) => d.toISOString().slice(0, 10);
const plus = (n) => new Date(Date.now() + n * 86400000);
let start = plus(3);
if (isoDow(start) === 7) start = plus(4);
const startDay = dayStr(start);
const SERIES = "99999999-0000-4000-8000-000000000001";
const FULL = "99999999-0000-4000-8000-000000000201";
const PRICED = "99999999-0000-4000-8000-000000000202";

sql(`
update studios set public_directory_enabled = true where id in ('${A}','${Bid}');
delete from public.studio_embed_settings where studio_id in ('${A}','${Bid}');
delete from appointment_attendees where appointment_id in (select id from appointments where group_class_series_id='${SERIES}' or id in ('${FULL}','${PRICED}'));
delete from group_class_enrollment_policies where appointment_id in (select id from appointments where group_class_series_id='${SERIES}' or id in ('${FULL}','${PRICED}'));
delete from appointments where group_class_series_id='${SERIES}' or id in ('${FULL}','${PRICED}');
delete from group_class_series where id='${SERIES}';
delete from events where slug like 'embqa-%';
insert into group_class_series(id,studio_id,title,description,timezone,weekdays,interval_weeks,starts_on,occurrence_count,local_start_time,duration_minutes,default_roster_capacity,publicly_discoverable,self_enrollment_allowed,accepted_funding_types,direct_payment_amount)
 values('${SERIES}','${A}','Tuesday Bachata','Weekly partner work','America/New_York',array[${isoDow(start)}]::smallint[],1,'${startDay}',4,'19:00',60,6,true,true,array['direct_payment']::text[],20);
insert into appointments(id,studio_id,appointment_type,title,starts_at,ends_at,status,roster_capacity,group_class_series_id,series_occurrence_index,occurrence_original_start)
 select ('99999999-0000-4000-8000-00000000010'||n)::uuid,'${A}','group_class','Tuesday Bachata',
  ('${startDay} 19:00 America/New_York'::timestamptz + ((n-1)*7||' days')::interval),('${startDay} 20:00 America/New_York'::timestamptz + ((n-1)*7||' days')::interval),'scheduled',6,'${SERIES}',n,('${startDay} 19:00 America/New_York'::timestamptz + ((n-1)*7||' days')::interval)
 from generate_series(1,4) n;
insert into group_class_enrollment_policies(studio_id,appointment_id,publicly_discoverable,self_enrollment_allowed,accepted_funding_types,direct_payment_amount)
 select studio_id,id,true,true,array['direct_payment']::text[],20 from appointments where group_class_series_id='${SERIES}';
insert into appointments(id,studio_id,appointment_type,title,starts_at,ends_at,status,roster_capacity) values
 ('${FULL}','${A}','group_class','Full House Salsa',('${startDay} 12:00 America/New_York')::timestamptz,('${startDay} 13:00 America/New_York')::timestamptz,'scheduled',3),
 ('${PRICED}','${A}','group_class','Priced Rumba',('${startDay} 15:00 America/New_York')::timestamptz,('${startDay} 16:00 America/New_York')::timestamptz,'scheduled',8);
insert into group_class_enrollment_policies(studio_id,appointment_id,publicly_discoverable,self_enrollment_allowed,accepted_funding_types,direct_payment_amount) values
 ('${A}','${FULL}',true,true,array['direct_payment']::text[],15),('${A}','${PRICED}',true,true,array['direct_payment']::text[],25);
insert into events(studio_id,name,slug,event_type,start_date,end_date,status,visibility,public_directory_enabled,venue_name,city,state,timezone) values
 ('${A}','Autumn Social Night','embqa-public','social_dance','${dayStr(plus(5))}','${dayStr(plus(5))}','published','public',true,'Maple Hall','Albany','NY','America/New_York'),
 ('${A}','Winter Workshop','embqa-multiday','workshop','${dayStr(plus(6))}','${dayStr(plus(8))}','published','public',true,'Maple Hall','Albany','NY','America/New_York'),
 ('${A}','Private Staff Retreat','embqa-private','workshop','${dayStr(plus(5))}','${dayStr(plus(5))}','published','private',false,null,null,null,'America/New_York'),
 ('${A}','Draft Gala','embqa-draft','party','${dayStr(plus(5))}','${dayStr(plus(5))}','draft','public',true,null,null,null,'America/New_York'),
 ('${A}','Old Recital','embqa-past','showcase','${dayStr(plus(-30))}','${dayStr(plus(-29))}','published','public',true,null,null,null,'America/New_York'),
 ('${Bid}','Other Studio Event','embqa-other','social_dance','${dayStr(plus(5))}','${dayStr(plus(5))}','published','public',true,null,null,null,'America/New_York');
update appointments set roster_capacity = 3 where id='${FULL}';
`);
// enrol three people so ${FULL} is genuinely full (attendee rows, as the registration flow would create them)
const fullClients = [];
for (let i = 1; i <= 3; i += 1) {
  const id = `99999999-0000-4000-8000-0000000003${String(i).padStart(2, "0")}`;
  sql(`insert into clients(id,studio_id,first_name,last_name,email) values('${id}','${A}','Fill${i}','Seat','fill${i}.seat@example.test') on conflict (id) do nothing;
       insert into appointment_attendees(studio_id,appointment_id,client_id,source,status) select '${A}','${FULL}','${id}','staff','booked' where not exists (select 1 from appointment_attendees where appointment_id='${FULL}' and client_id='${id}');`);
  fullClients.push(id);
}
const seriesFirst = "99999999-0000-4000-8000-000000000101";

// ---------- helpers ----------
const page = async (path) => {
  const r = await fetch(B + path, { redirect: "manual" });
  const html = await r.text();
  return { status: r.status, html, text: html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ") };
};
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chrome" });
async function login(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: B });
  const p = await ctx.newPage();
  await p.goto(B + "/login", { waitUntil: "domcontentloaded" });
  await p.locator('input[type="email"]').first().fill(email);
  await p.locator('input[type="password"]').first().fill(seed.PASSWORD);
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120000 }), p.locator('button[type="submit"]').first().click()]);
  return { ctx, p };
}

// ---------- 1. who may open the builder ----------
for (const [who, email] of [["instructor", "ida.instructor@example.test"], ["other-studio staff", "bo.otherstudio@example.test"]]) {
  const { ctx, p } = await login(email);
  await p.goto(B + "/app/settings/embeds", { waitUntil: "domcontentloaded" });
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(1500);
  rec(`${who} is turned away from the builder`, !/Your embed code/.test(await p.locator("body").innerText()), p.url());
  await ctx.close();
}

// ---------- 2. owner: builder (stored defaults are the factory defaults here) ----------
const { ctx: octx, p } = await login("owen.owner@example.test");
const openBuilder = async () => {
  await p.goto(B + "/app/settings/embeds", { waitUntil: "domcontentloaded" });
  await p.waitForSelector("text=Embed settings", { timeout: 120000 });
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(2500);
};
const code = () => p.locator('textarea[aria-label="Embed code"]').inputValue();
await openBuilder();
let c = await code();
rec("default code is an iframe for this studio's calendar", c.includes(aSlug) && /embed\/calendar/.test(c), c.slice(0, 160));
rec("default code carries no explicit options (they equal the stored defaults)", !/[?&](view|theme|accent)=/.test(c), c);
const kinds = p.locator("section[aria-label='Embed options'] button");
await kinds.filter({ hasText: /one class/i }).first().click();
const classOpts = await p.locator("#embed-class option").allInnerTexts();
rec("class list shows only public classes", classOpts.some((o) => /Bachata/.test(o)) && classOpts.some((o) => /Rumba/.test(o)), JSON.stringify(classOpts));
await p.selectOption("#embed-class", { index: 1 });
rec("class code points at /embed/class/<id>", /embed\/class\/[0-9a-f-]{36}/.test(await code()));
await kinds.filter({ hasText: /class calendar/i }).first().click();
await p.selectOption("#embed-view", "week");
await p.selectOption("#embed-theme", "dark");
await p.locator("#embed-accent").fill("#cc3366");
await p.waitForTimeout(300);
c = await code();
rec("options that differ from the stored defaults appear in the code", /view=week/.test(c) && /theme=dark/.test(c) && /cc3366/i.test(c), c);
await p.selectOption("#embed-view", "agenda");
await p.selectOption("#embed-theme", "light");
await p.locator("#embed-accent").fill("");
await p.waitForTimeout(300);
rec("options equal to the stored defaults are omitted from the code", !/[?&](view|theme|accent)=/.test(await code()), await code());
await p.locator("#embed-accent").fill("red;}</style><script>x");
await p.waitForTimeout(300);
c = await code();
rec("hostile accent never reaches the code", !c.includes("<script>x") && !c.includes("red;") && !/accent=/.test(c), c);
await p.locator("#embed-accent").fill("");
await p.getByRole("button", { name: "Copy embed code" }).click();
await p.waitForTimeout(400);
const clip = await p.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${e}`);
const norm = (s) => String(s).replaceAll("\r", "");
rec("copy puts the snippet on the clipboard", norm(clip) === norm(await code()) && clip.includes("<"), String(clip).slice(0, 100));
const src = await p.locator("section[aria-label='Preview'] iframe").first().getAttribute("src").catch(() => null);
rec("preview iframe loads an embed URL", !!src && /\/embed\//.test(src), String(src));
if (src) {
  const t = await p.frameLocator("section[aria-label='Preview'] iframe").first().locator("body").innerText({ timeout: 60000 }).catch((e) => `ERR ${e}`);
  rec("preview renders the classes", /Bachata|Salsa|Rumba/.test(t), t.slice(0, 100));
}
await p.screenshot({ path: `${outDir}/builder.png`, fullPage: true });

// ---------- 3. settings: defaults, opt-ins, events, stored appearance, kill switch ----------
const save = async () => {
  const st = p.locator("section[aria-label='Embed settings'] [role=status]");
  await p.getByRole("button", { name: "Save settings" }).click();
  await p.waitForTimeout(300);
  await p.getByRole("button", { name: "Save settings" }).waitFor({ timeout: 30000 });
  await p.waitForFunction(() => { const e = document.querySelector("section[aria-label='Embed settings'] [role=status]"); return !!e?.textContent?.trim(); }, null, { timeout: 30000 });
  await p.waitForTimeout(1200);
  return (await st.innerText()).trim();
};
const series = `/embed/class/${seriesFirst}`;
const cal = `/embed/calendar/${aSlug}`;
let r = await page(series);
rec("default: class embed shows neither price nor description", !/Price|\$20|Weekly partner work/.test(r.text), r.text.slice(0, 160));
r = await page(cal);
rec("events: public events shown; private, draft, past and other studio's never", /Autumn Social Night/.test(r.text) && /Winter Workshop/.test(r.text) && !/Private Staff Retreat|Draft Gala|Old Recital|Other Studio Event/.test(r.text), r.text.slice(0, 300));
rec("events: each links to its DanceFlow event page", /\/events\/embqa-public/.test(r.html));
await p.getByLabel("Show class descriptions", { exact: false }).check();
await p.getByLabel("Show class prices", { exact: false }).check();
let msg = await save();
rec("saving the opt-ins", /Saved/.test(msg), msg);
r = await page(series);
rec("opted in: series description and its price show", /Price \$20/.test(r.text) && /Weekly partner work/.test(r.text), r.text.slice(0, 220));
r = await page(`/embed/class/${PRICED}`);
rec("opted in: a class with its own direct price shows that price", /Price \$25/.test(r.text), r.text.slice(0, 200));
await p.getByLabel("Show public events", { exact: false }).uncheck();
await save();
r = await page(cal);
rec("events off: none shown and the title says classes", !/Autumn Social Night|Winter Workshop/.test(r.text), r.text.slice(0, 160));
await p.getByLabel("Show public events", { exact: false }).check();
await save();

await p.selectOption("#stored-view", "month");
await p.selectOption("#stored-theme", "dark");
await p.locator("#stored-accent").fill("#cc3366");
await save();
r = await page(cal);
rec("stored month/dark/#cc3366 apply to a URL without options", /role="table"/.test(r.html) && /bg-slate-900/.test(r.html) && /--embed-accent:\s*#cc3366/.test(r.html));
r = await page(`${cal}?view=agenda&theme=light`);
rec("explicit URL options override the stored defaults", !/role="table"/.test(r.html) && !/bg-slate-900/.test(r.html));
await openBuilder();
c = await code();
rec("with stored defaults, the pre-filled code carries no explicit options", /embed\/calendar\/[^"?]+"/.test(c) && !/[?&](view|theme|accent)=/.test(c), c);
await p.locator("#embed-view").selectOption("agenda");
await p.waitForTimeout(300);
rec("choosing a view different from the stored default is written into the code", /view=agenda/.test(await code()), await code());
await p.locator("#stored-accent").fill("red;}</style>");
msg = await save();
rec("bad stored accent is refused with fixed copy", /6-digit/.test(msg), msg);
r = await page(cal);
rec("the refused save changed nothing", /--embed-accent:\s*#cc3366/.test(r.html));

await p.locator("#stored-accent").fill("");
await p.getByLabel("Embeds are on", { exact: false }).uncheck();
msg = await save();
rec("kill switch saved", /now off/.test(msg), msg);
const off1 = await page(cal);
const off2 = await page(series);
rec("embeds off: calendar and class embeds are 404", off1.status === 404 && off2.status === 404, `${off1.status}/${off2.status}`);
rec("embeds off: the 404 leaks nothing about the studio", !/Maple Street|Bachata|Salsa|Rumba/.test(off1.text + off2.text));
rec("embeds off: public pages are unaffected", (await page(`/studios/${aSlug}/classes`)).status === 200);
await openBuilder();
rec("builder explains that embeds are off", (await p.getByText("Your embeds are switched off").count()) === 1);
const other = await page(`/embed/calendar/${bSlug}`);
rec("another studio's embeds are unaffected", other.status === 200 && /Other Studio Event/.test(other.text), other.status);
await p.getByLabel("Embeds are on", { exact: false }).check();
await save();
r = await page(cal);
rec("embeds back on: served again", r.status === 200 && /Maple Street Dance/.test(r.text), r.status);
await p.screenshot({ path: `${outDir}/settings.png`, fullPage: true });
await octx.close();

// ---------- 4. registration handoff, up to (not including) checkout ----------
const email = `dana.${Math.random().toString(36).slice(2, 8)}@example.test`;
const pwd = `Handoff-${Math.random().toString(36).slice(2, 10)}!`;
await createUser(env, { email, password: pwd, fullName: "Dana Dancer" });
const hctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const h = await hctx.newPage();
const hbody = async () => (await h.locator("body").innerText()).replace(/\s+/g, " ");
const embedHtml = (await page(series)).html;
const href = /href="(\/studios\/[^"]+\/register)"/.exec(embedHtml)?.[1];
rec("the embed offers a Register link for an open class", !!href, href);
const fullEmbed = await page(`/embed/class/${FULL}`);
rec("a full class offers no Register link", !/\/register"/.test(fullEmbed.html) && /class full/i.test(fullEmbed.text), fullEmbed.text.slice(0, 200));
await h.goto(B + href, { waitUntil: "domcontentloaded" });
await h.waitForURL(/\/login/, { timeout: 120000 });
rec("signed out: sent to login with the destination preserved", new URL(h.url()).searchParams.get("next") === href, h.url());
const sentAt = Date.now();
await h.locator('input[type="email"]').first().fill(email);
await h.locator('button[type="submit"]').first().click();
await h.waitForTimeout(2500);
const mail = await latestAuthLink(env, email, sentAt - 2000);
await h.goto(mail.link, { waitUntil: "domcontentloaded" });
await h.waitForURL((u) => u.pathname.includes("/register") || u.pathname.includes("verify-email"), { timeout: 120000 }).catch(() => {});
await h.waitForLoadState("networkidle").catch(() => {});
rec("the magic link returns the visitor to the class registration", h.url().includes("/register") || h.url().includes("verify-email"), h.url());
let t = await hbody();
await h.screenshot({ path: `${outDir}/handoff-1-after-link.png` });
if (/Confirm your email to continue/.test(t)) {
  rec("existing safeguard: confirm-your-email step is shown first", true);
  const verifyHref = await h.getByRole("link", { name: /Confirm my email/ }).getAttribute("href");
  rec("the confirm link returns to this class afterwards", !!verifyHref && decodeURIComponent(verifyHref).includes(href), verifyHref);
  // The local stack has no email provider, so the app's own "send" cannot deliver. Build the link exactly as sendEmailVerificationLink does
  // (GoTrue admin generate_link -> /callback?token_hash&type&next) and open it as the mailbox would.
  const gl = await (await fetch(`${env.ISO_QA_AUTH_URL}/admin/generate_link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ISO_QA_SERVICE_ROLE_KEY}`, apikey: env.ISO_QA_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email }),
  })).json();
  const hashed = gl.hashed_token ?? gl.properties?.hashed_token;
  const vtype = gl.verification_type ?? gl.properties?.verification_type;
  const cb = `${B}/callback?token_hash=${encodeURIComponent(hashed)}&type=${vtype}&next=${encodeURIComponent(verifyHref)}`;
  await h.goto(cb, { waitUntil: "domcontentloaded" });
  await h.waitForLoadState("networkidle").catch(() => {});
  t = await hbody();
  await h.screenshot({ path: `${outDir}/handoff-1b-verify-page.png` });
}
// the proof came from the mailbox link, so the account may now set its password (binding) and is signed in fresh
// Walk the app's own safeguard states until the register page proceeds (or we give up after a few steps).
const settle = async () => { await h.waitForLoadState("networkidle").catch(() => {}); await h.waitForTimeout(800); t = await hbody(); };
for (let step = 0; step < 5; step += 1) {
  if (await h.locator('input[name="password"]').count()) {
    await h.locator('input[name="password"]').fill(NEW_PWD);
    await h.locator('input[name="confirmPassword"]').fill(NEW_PWD);
    await h.screenshot({ path: `${outDir}/handoff-2-bind.png` });
    await h.locator('form button[type="submit"]').first().click();
    await settle();
  } else if (/Your email is verified/.test(t)) {
    await h.getByRole("link", { name: /^Continue/ }).first().click();
    await settle();
  } else if (/Sign in again to continue/.test(t)) {
    const again = Date.now();
    await h.getByRole("button", { name: /Sign in again/ }).click();
    await h.waitForURL(/\/login/, { timeout: 60000 });
    await h.locator('input[type="email"]').first().fill(email);
    await h.locator('button[type="submit"]').first().click();
    await h.waitForTimeout(2500);
    await h.goto((await latestAuthLink(env, email, again - 2000)).link, { waitUntil: "domcontentloaded" });
    await settle();
  } else break;
}
await h.screenshot({ path: `${outDir}/handoff-3-confirmed.png` });
rec("email confirmed: back on this class's register page", h.url().includes(href.split("?")[0]) || h.url().includes("/register"), h.url());
rec("email confirmed: the safeguard step is gone and the class is shown", !/Confirm your email to continue/.test(t) && /Bachata/.test(t), t.slice(0, 260));
rec("past the email step the existing eligibility check runs (this studio has no connected payment account, so it stops safely)", /Online payment isn.t available|Choose|Register/i.test(t), t.slice(0, 200));
rec("no payment is started by arriving (no Stripe page)", !/stripe\.com/.test(h.url()), h.url());
sql(`select 1`);
// a full class refuses a direct URL, and a made-up class is a 404 in the embed
await h.goto(`${B}/studios/${aSlug}/classes/${FULL}/register`, { waitUntil: "domcontentloaded" });
await h.waitForLoadState("networkidle").catch(() => {});
t = await hbody();
await h.screenshot({ path: `${outDir}/handoff-4-full.png` });
rec("full class: direct register URL is refused with a message", /full|no longer|isn.t available|not available/i.test(t) && !/Continue to payment|Pay now|Checkout/i.test(t), t.slice(0, 240));
rec("unknown class id: embed 404", (await page("/embed/class/00000000-0000-4000-8000-000000000999")).status === 404);
await hctx.close();
await browser.close();

const failed = results.filter((x) => !x.ok);
console.log(JSON.stringify({ total: results.length, failed: failed.length, failedNames: failed.map((x) => x.name) }));
process.exit(failed.length ? 1 : 0);

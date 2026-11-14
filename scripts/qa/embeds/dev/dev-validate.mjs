#!/usr/bin/env node
// Website Embeds validation against a DEV-connected app (run-local-dev-app.mjs) using the FICTIONAL fixtures + accounts only.
//   node dev-validate.mjs <creds.json> <out-dir> [base-url=http://localhost:3100]
// Refuses a non-local base URL. Every browser request is checked against an allowlist (localhost + the DEV Supabase host); anything else fails the run.
// The run changes only the embed settings of fictional studio A, and restores factory defaults at the end (accounts/fixtures cleanup removes the rest).
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const [credsFile, outDir, baseArg] = process.argv.slice(2);
if (!credsFile || !outDir) throw new Error("usage: dev-validate.mjs <creds.json> <out-dir> [base-url]");
const creds = JSON.parse(readFileSync(credsFile, "utf8"));
const B = baseArg ?? "http://localhost:3100";
if (!["localhost", "127.0.0.1"].includes(new URL(B).hostname)) throw new Error("base URL must be local");
mkdirSync(outDir, { recursive: true });
const DEV_HOST = "epdrtzcydvnoidwrepqz.supabase.co";
const PROD_HOST = "hvsujyfbftfffxpfmlpb.supabase.co";
// creds.target === "stack" is the disposable local dry run (its auth/database are loopback); "dev" allows only the DEV Supabase host besides localhost.
const allowHost = (h) => h === "localhost" || h === "127.0.0.1" || (creds.target === "dev" && h === DEV_HOST);

const aSlug = "embed-qa-fictional-a";
const bSlug = "embed-qa-fictional-b";
const SERIES_FIRST = "e3b00000-0000-4000-8000-0000000000a2";
const PRICED = "e3b00000-0000-4000-8000-0000000000a9";
const DESC = "Fictional weekly partner work for embed testing.";

const results = [];
const rec = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : String(detail).slice(0, 220));
};
const badRequests = [];
const page = async (path, init = {}) => {
  const r = await fetch(B + path, { redirect: "manual", ...init });
  const html = await r.text();
  return {
    status: r.status,
    headers: r.headers,
    html,
    text: html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "),
  };
};
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chrome" });
// Preventive: requests to any other host are aborted before they leave the browser (and recorded as failures).
const guard = (ctx) =>
  ctx.route("**/*", (route) => {
    try {
      const u = new URL(route.request().url());
      if (["data:", "blob:", "about:"].includes(u.protocol) || allowHost(u.hostname)) return route.continue();
    } catch {
      /* fall through to block */
    }
    badRequests.push("BLOCKED " + route.request().url().slice(0, 100));
    return route.abort();
  });
const watch = (ctx) => {
  guard(ctx);
  ctx.on("request", (rq) => {
    try {
      const u = new URL(rq.url());
      if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return;
      if (u.hostname === PROD_HOST) badRequests.push("PROD " + rq.url().slice(0, 80));
      else if (!allowHost(u.hostname)) badRequests.push(rq.url().slice(0, 120));
    } catch {
      /* ignore unparsable */
    }
  });
};
async function login(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  watch(ctx);
  const p = await ctx.newPage();
  await p.goto(B + "/login", { waitUntil: "domcontentloaded" });
  await p.locator('input[type="email"]').first().fill(email);
  await p.locator('input[type="password"]').first().fill(creds.password);
  await Promise.all([
    p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120000 }),
    p.locator('button[type="submit"]').first().click(),
  ]);
  return { ctx, p };
}

// ---------- 0. baseline: fixtures present, anonymous reads, fail closed ----------
const cal = `/embed/calendar/${aSlug}`;
const series = `/embed/class/${SERIES_FIRST}`;
let r = await page(cal);
rec("fixture studio A calendar embed is served", r.status === 200 && /Embed QA Studio A/.test(r.text), `${r.status} ${r.text.slice(0, 120)}`);
rec("events: public events shown; private, draft and other studio's never", /QA Social Night/.test(r.text) && /QA Winter Workshop/.test(r.text) && !/QA Private Retreat|QA Draft Gala|QA Other Studio Event/.test(r.text), r.text.slice(0, 300));
rec("default: classes shown without price or description", /QA Bachata Series|QA Rumba/.test(r.text) && !/Price \$|\$20|\$25|Fictional weekly partner/.test(r.text), r.text.slice(0, 200));
r = await page(series);
rec("default: class embed shows neither price nor description", r.status === 200 && !/Price|\$20|Fictional weekly partner/.test(r.text), r.text.slice(0, 160));
const emb = await page(cal);
rec("embed routes are frameable (no X-Frame-Options; frame-ancestors *)", !emb.headers.get("x-frame-options") && /frame-ancestors \*/.test(emb.headers.get("content-security-policy") ?? ""), `${emb.headers.get("x-frame-options")} | ${(emb.headers.get("content-security-policy") ?? "").slice(0, 80)}`);
const lg = await page("/login");
rec("every other page stays unframeable", /SAMEORIGIN|DENY/i.test(lg.headers.get("x-frame-options") ?? "") && /frame-ancestors 'self'/.test(lg.headers.get("content-security-policy") ?? ""), `${lg.headers.get("x-frame-options")}`);
rec("fail closed: unknown studio slug is 404", (await page("/embed/calendar/embed-qa-no-such-studio")).status === 404);
rec("fail closed: unknown class id is 404", (await page("/embed/class/00000000-0000-4000-8000-000000000999")).status === 404);
rec("fail closed: a malformed class id is 404", (await page("/embed/class/not-a-uuid")).status === 404);
// Next renders any page for a plain POST (same as /login), so read-only means: no form or server action to call on the page, and a forged action id is refused.
rec("embeds are read-only: the page has no form and a forged server-action call is refused", !/<form[s>]/i.test(emb.html) && (await page(cal, { method: "POST", headers: { "Next-Action": "00" + "a".repeat(40), "Content-Type": "text/plain" }, body: "[]" })).status >= 400);
const anonBuilder = await page("/app/settings/embeds");
rec("signed out: the builder is not served (redirect to login)", [302, 303, 307, 308].includes(anonBuilder.status) && /login/.test(anonBuilder.headers.get("location") ?? ""), `${anonBuilder.status} ${anonBuilder.headers.get("location")}`);

// ---------- 1. who may open the builder ----------
{
  const { ctx, p } = await login(creds.emails.instructorA);
  await p.goto(B + "/app/settings/embeds", { waitUntil: "domcontentloaded" });
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(1500);
  rec("studio A instructor is turned away from the builder", !/Your embed code/.test(await p.locator("body").innerText()), p.url());
  await ctx.close();
}
{
  const { ctx, p } = await login(creds.emails.ownerB);
  await p.goto(B + "/app/settings/embeds", { waitUntil: "domcontentloaded" });
  await p.waitForSelector("text=Embed settings", { timeout: 120000 });
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(2000);
  const bcode = await p.locator('textarea[aria-label="Embed code"]').inputValue();
  rec("studio B owner's builder is for studio B only", bcode.includes(bSlug) && !bcode.includes(aSlug), bcode.slice(0, 160));
  await p.locator("section[aria-label='Embed options'] button").filter({ hasText: /one class/i }).first().click().catch(() => {});
  const opts = await p.locator("#embed-class option").allInnerTexts().catch(() => []);
  rec("studio B owner never sees studio A's classes", !opts.some((o) => /Bachata|Rumba/.test(o)), JSON.stringify(opts));
  await ctx.close();
}

// ---------- 2. studio A owner: builder, stored settings, kill switch ----------
const { ctx: octx, p } = await login(creds.emails.ownerA);
const openBuilder = async () => {
  await p.goto(B + "/app/settings/embeds", { waitUntil: "domcontentloaded" });
  await p.waitForSelector("text=Embed settings", { timeout: 120000 });
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(2500);
};
const code = () => p.locator('textarea[aria-label="Embed code"]').inputValue();
await openBuilder();
let c = await code();
rec("builder: default code is an iframe for studio A's calendar", c.includes(aSlug) && /embed\/calendar/.test(c) && !/[?&](view|theme|accent)=/.test(c), c.slice(0, 160));
const kinds = p.locator("section[aria-label='Embed options'] button");
await kinds.filter({ hasText: /one class/i }).first().click();
const classOpts = await p.locator("#embed-class option").allInnerTexts();
rec("builder: class list shows studio A's public classes", classOpts.some((o) => /Bachata/.test(o)) && classOpts.some((o) => /Rumba/.test(o)), JSON.stringify(classOpts));
await p.selectOption("#embed-class", { index: 1 });
rec("builder: class code points at /embed/class/<id>", /embed\/class\/[0-9a-f-]{36}/.test(await code()));
await kinds.filter({ hasText: /class calendar/i }).first().click();
await p.selectOption("#embed-view", "week");
await p.selectOption("#embed-theme", "dark");
await p.locator("#embed-accent").fill("#cc3366");
await p.waitForTimeout(300);
c = await code();
rec("builder: options differing from stored defaults appear in the code", /view=week/.test(c) && /theme=dark/.test(c) && /cc3366/i.test(c), c);
await p.locator("#embed-accent").fill("red;}</style><script>x");
await p.waitForTimeout(300);
c = await code();
rec("builder: hostile accent never reaches the code", !c.includes("<script>x") && !c.includes("red;") && !/accent=/.test(c), c);
await p.selectOption("#embed-view", "agenda");
await p.selectOption("#embed-theme", "light");
await p.locator("#embed-accent").fill("");
const src = await p.locator("section[aria-label='Preview'] iframe").first().getAttribute("src").catch(() => null);
rec("builder: preview iframe loads an embed URL", !!src && /\/embed\//.test(src), String(src));
if (src) {
  const t = await p.frameLocator("section[aria-label='Preview'] iframe").first().locator("body").innerText({ timeout: 60000 }).catch((e) => `ERR ${e}`);
  rec("builder: preview renders studio A's classes", /Bachata|Rumba/.test(t), t.slice(0, 100));
}
await p.screenshot({ path: `${outDir}/builder.png`, fullPage: true });

const save = async () => {
  const st = p.locator("section[aria-label='Embed settings'] [role=status]");
  await p.getByRole("button", { name: "Save settings" }).click();
  await p.waitForTimeout(300);
  await p.getByRole("button", { name: "Save settings" }).waitFor({ timeout: 30000 });
  await p.waitForFunction(() => {
    const e = document.querySelector("section[aria-label='Embed settings'] [role=status]");
    return !!e?.textContent?.trim();
  }, null, { timeout: 30000 });
  await p.waitForTimeout(1200);
  return (await st.innerText()).trim();
};
await p.getByLabel("Show class descriptions", { exact: false }).check();
await p.getByLabel("Show class prices", { exact: false }).check();
let msg = await save();
rec("settings: opt-ins save", /Saved/.test(msg), msg);
r = await page(series);
rec("opted in: series description and its price show", /Price \$20/.test(r.text) && r.text.includes(DESC), r.text.slice(0, 220));
r = await page(`/embed/class/${PRICED}`);
rec("opted in: a class with its own direct price shows that price", /Price \$25/.test(r.text), r.text.slice(0, 200));
await openBuilder();
rec("settings persist after reload (opt-ins still ticked)", (await p.getByLabel("Show class descriptions", { exact: false }).isChecked()) && (await p.getByLabel("Show class prices", { exact: false }).isChecked()));
r = await page(`/embed/calendar/${bSlug}`);
rec("studio B's embed is unaffected by studio A's opt-ins", r.status === 200 && !/Price \$|Fictional weekly partner/.test(r.text) && !/QA Bachata/.test(r.text), r.text.slice(0, 160));
await p.getByLabel("Show public events", { exact: false }).uncheck();
await save();
r = await page(cal);
rec("events off: none shown", r.status === 200 && !/QA Social Night|QA Winter Workshop/.test(r.text), r.text.slice(0, 160));
await p.getByLabel("Show public events", { exact: false }).check();
await save();
await p.selectOption("#stored-view", "month");
await p.selectOption("#stored-theme", "dark");
await p.locator("#stored-accent").fill("#cc3366");
await save();
r = await page(cal);
rec("stored month/dark/#cc3366 apply to a URL without options", /role="table"/.test(r.html) && /bg-slate-900/.test(r.html) && /--embed-accent:\s*#cc3366/.test(r.html));
r = await page(`${cal}?view=agenda&theme=light`);
rec("explicit URL options override stored defaults", !/role="table"/.test(r.html) && !/bg-slate-900/.test(r.html));
await p.locator("#stored-accent").fill("red;}</style>");
msg = await save();
rec("bad stored accent is refused with fixed copy and changes nothing", /6-digit/.test(msg) && /--embed-accent:\s*#cc3366/.test((await page(cal)).html), msg);

await p.locator("#stored-accent").fill("");
await p.getByLabel("Embeds are on", { exact: false }).uncheck();
msg = await save();
rec("kill switch saved", /now off/.test(msg), msg);
const off1 = await page(cal);
const off2 = await page(series);
rec("embeds off: calendar and class embeds are 404", off1.status === 404 && off2.status === 404, `${off1.status}/${off2.status}`);
rec("embeds off: the 404 leaks nothing about the studio", !/Embed QA Studio|Bachata|Rumba/.test(off1.text + off2.text));
rec("embeds off: DanceFlow's own public pages are unaffected", (await page(`/studios/${aSlug}/classes`)).status === 200);
const other = await page(`/embed/calendar/${bSlug}`);
rec("embeds off: studio B's embeds still served", other.status === 200 && /QA Other Studio Event/.test(other.text), other.status);
await openBuilder();
rec("builder explains that embeds are off", (await p.getByText("Your embeds are switched off").count()) === 1);
await p.getByLabel("Embeds are on", { exact: false }).check();
await save();
r = await page(cal);
rec("embeds back on: served again", r.status === 200 && /Embed QA Studio A/.test(r.text), r.status);

// ---------- 3. registration handoff (anonymous visitor; no account is created and no payment can start) ----------
r = await page(series);
const href = /href="(\/studios\/[^"]+\/register)"/.exec(r.html)?.[1];
rec("handoff: the embed offers a Register link for an open class", !!href, href);
const link = /<a[^>]*href="\/studios\/[^"]+\/register"[^>]*>/.exec(r.html)?.[0] ?? "";
rec("handoff: the link leaves the frame (target _top or _blank)", /target="_(top|blank)"/.test(link), link);
if (href) {
  const hctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  watch(hctx);
  const h = await hctx.newPage();
  await h.goto(B + href, { waitUntil: "domcontentloaded" });
  await h.waitForURL(/\/login/, { timeout: 120000 });
  rec("handoff: signed out, the visitor reaches login with the destination preserved", new URL(h.url()).searchParams.get("next") === href, h.url());
  rec("handoff: no payment page was opened", !/stripe\.com/.test(h.url()));
  await h.screenshot({ path: `${outDir}/handoff-login.png` });
  await hctx.close();
}

// ---------- 4. restore factory defaults, confirm, and check network isolation ----------
await openBuilder();
await p.getByLabel("Show class descriptions", { exact: false }).uncheck();
await p.getByLabel("Show class prices", { exact: false }).uncheck();
await p.selectOption("#stored-view", "agenda");
await p.selectOption("#stored-theme", "light");
await p.locator("#stored-accent").fill("");
msg = await save();
rec("cleanup: factory defaults restored through the UI", /Saved/.test(msg), msg);
r = await page(series);
rec("cleanup: class embed is back to no price and no description", r.status === 200 && !/Price|Fictional weekly partner/.test(r.text), r.text.slice(0, 160));
await octx.close();
await browser.close();
rec("isolation: every browser request went to localhost or the DEV Supabase host only", badRequests.length === 0, badRequests.slice(0, 5).join(" ; "));

const failed = results.filter((x) => !x.ok);
console.log(JSON.stringify({ total: results.length, failed: failed.length, failedNames: failed.map((x) => x.name) }));
process.exit(failed.length ? 1 : 0);

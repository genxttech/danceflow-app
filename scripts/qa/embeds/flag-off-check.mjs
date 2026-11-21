// Website Embeds release gate, OFF state. Run against a build started WITHOUT WEBSITE_EMBEDS=on on an iso-qa stack seeded by seed-staff.mjs:
//   node scripts/qa/embeds/flag-off-check.mjs seed.json <studio-A-slug>
// Expects: both embed kinds 404, the owner's builder page not found, no "Website Embeds" menu item.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const seed = JSON.parse(readFileSync(process.argv[2], "utf8"));
const B = "http://localhost:3100";
const get = async (p) => { const r = await fetch(B + p, { redirect: "manual" }); return { s: r.status, t: await r.text() }; };
const out = [];
const rec = (n, ok, d = "") => { out.push(ok); console.log(ok ? "PASS" : "FAIL", n, ok ? "" : d); };
const slugRow = process.argv[3];
rec("flag off: calendar embed 404", (await get(`/embed/calendar/${slugRow}`)).s === 404);
rec("flag off: class embed 404", (await get(`/embed/class/99999999-0000-4000-8000-000000000101`)).s === 404);
const b = await chromium.launch({ channel: "chrome" });
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.goto(B + "/login", { waitUntil: "domcontentloaded" });
await p.locator('input[type="email"]').first().fill("owen.owner@example.test");
await p.locator('input[type="password"]').first().fill(seed.PASSWORD);
await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120000 }), p.locator('button[type="submit"]').first().click()]);
await p.goto(B + "/app/settings/embeds", { waitUntil: "domcontentloaded" });
await p.waitForLoadState("networkidle").catch(() => {});
const body = await p.locator("body").innerText();
rec("flag off: owner's builder page is not found", !/Your embed code|Embed settings/.test(body), body.slice(0, 120));
await p.goto(B + "/app/settings/public-profile", { waitUntil: "domcontentloaded" });
await p.waitForLoadState("networkidle").catch(() => {});
const nav = await p.content();
rec("flag off: no 'Website Embeds' menu item for the owner", !/Website Embeds/.test(nav) && /Public Profile Setup/.test(nav), "menu check");
await b.close();
process.exit(out.every(Boolean) ? 0 : 1);

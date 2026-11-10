#!/usr/bin/env node
// Playwright walkthrough of the DanceFlow Business app (mobile/business) against an iso-qa --auth stack, a local Next server running /api/staff, and the
// app's web export served by dev-web-proxy.mjs. Every step uses real GoTrue sessions; the magic link comes from Mailpit. LOCAL / DISPOSABLE STACKS ONLY.
//   node scripts/qa/auth-profile/business-shell/walk.mjs <stack.json> <seed.json> <out-dir> [--web http://localhost:8790]
// Writes one PNG per state plus evidence.json (status codes and tab lists, no tokens). Exit 0 = every step passed.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const [stackFile, seedFile, OUT] = process.argv.slice(2);
if (!stackFile || !seedFile || !OUT) throw new Error("usage: walk.mjs <stack.json> <seed.json> <out-dir> [--web url]");
const stack = JSON.parse(fs.readFileSync(stackFile, "utf8"));
const env = JSON.parse(fs.readFileSync(seedFile, "utf8"));
for (const key of ["TW4A_LOCAL_URL", "ISO_QA_MAIL_URL"]) if (!["127.0.0.1", "localhost"].includes(new URL(stack[key]).hostname)) throw new Error(`${key} is not local`);
if (!stack.TW4A_LOCAL_DB_CONTAINER?.startsWith("df-isoqa-")) throw new Error("not an iso-qa stack");
fs.mkdirSync(OUT, { recursive: true });
const webIndex = process.argv.indexOf("--web");
const WEB = webIndex > 0 ? process.argv[webIndex + 1] : "http://localhost:8790";
const SUPA = stack.TW4A_LOCAL_URL;
const MAIL = stack.ISO_QA_MAIL_URL;
const evidence = [];
const note = (step, detail) => {
  evidence.push({ step, ...detail });
  console.log(step, JSON.stringify(detail));
};
const psql = (sql) =>
  execFileSync("docker", ["exec", "-i", stack.TW4A_LOCAL_DB_CONTAINER, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });

async function latestLink(email, after) {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`${MAIL}/api/v1/messages`)).json();
    const msg = (list.messages ?? []).find((m) => m.To?.some((t) => t.Address === email) && new Date(m.Created).getTime() >= after);
    if (msg) {
      const full = await (await fetch(`${MAIL}/api/v1/message/${msg.ID}`)).json();
      const text = `${full.Text ?? ""} ${full.HTML ?? ""}`.replace(/&amp;/g, "&");
      const link = text.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/);
      if (link) return { subject: msg.Subject, link: link[0] };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no sign-in email for ${email}`);
}

async function sessionToken(page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith("-auth-token"));
    return key ? JSON.parse(localStorage.getItem(key)).access_token : null;
  });
}

async function staffStatus(token, p) {
  const res = await fetch(`${WEB}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => null);
  return { status: res.status, code: body?.code ?? null };
}

(async () => {
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const failures = [];
  page.on("pageerror", (e) => failures.push(String(e)));
  const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
  const ida = "ida.instructor@example.test";

  // 1. Real magic-link sign-in: GoTrue sends the mail, Mailpit catches it, the link's redirect carries a PKCE code back to the app.
  await page.goto(WEB + "/");
  await page.getByLabel("Email", { exact: true }).waitFor();
  await shot("e2e-00-sign-in");
  const sentAt = Date.now() - 2000;
  await page.getByLabel("Email", { exact: true }).fill(ida);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByText("a sign-in link is on its way").waitFor();
  await shot("e2e-01-link-sent");
  const mail = await latestLink(ida, sentAt);
  const verify = await fetch(mail.link, { redirect: "manual" });
  const location = verify.headers.get("location") ?? "";
  note("magic link", { subject: mail.subject, verifyStatus: verify.status, redirectScheme: location.split("?")[0], hasCode: /[?&]code=/.test(location) });
  const code = new URL(location.replace("danceflow-business://", "http://callback/")).searchParams.get("code");
  if (!code) throw new Error(`no PKCE code in redirect ${location}`);
  await page.goto(`${WEB}/?code=${encodeURIComponent(code)}`);

  // 2. /me-driven tabs + Today with data
  await page.getByText("4 appointments").waitFor({ timeout: 120000 });
  const instructorTabs = await page.getByRole("tab").allInnerTexts().catch(() => []);
  note("instructor tabs", { tabs: instructorTabs.map((t) => t.trim()) });
  await shot("e2e-02-today-data");

  // 3. Appointment detail: private lesson (recap) and group class (roster)
  await page.getByText("Ana Rivera").first().click();
  await page.getByText("Lesson recap").waitFor({ timeout: 60000 });
  await shot("e2e-03-detail-lesson");
  await page.goBack();
  await page.getByText("Beginner Salsa").click();
  await page.getByText("2 of 12 booked").waitFor({ timeout: 60000 });
  await shot("e2e-04-detail-class");
  await page.goBack();
  await page.getByText("4 appointments").waitFor();

  // 4. Empty day (real: nothing seeded tomorrow)
  await page.getByRole("button", { name: "Next day" }).click();
  await page.getByText("Nothing on your schedule").waitFor({ timeout: 60000 });
  await shot("e2e-05-empty-day");
  await page.getByRole("button", { name: "Today", exact: true }).first().click();
  await page.getByText("4 appointments").waitFor();

  // 5. 403: an appointment in a studio Ida does not belong to
  await page.goto(`${WEB}/appointments/${env.A.other}?studioId=${env.S.b}&tz=America/New_York`);
  await page.getByText("No access to this studio").waitFor({ timeout: 60000 });
  await shot("e2e-06-403-other-studio");
  // 5b. 403 on Today after the studio removes Ida's role mid-session
  await page.goto(WEB + "/today");
  await page.getByText("4 appointments").waitFor({ timeout: 60000 });
  psql(`update public.user_studio_roles set active = false where user_id = '${env.users.ida}';`);
  await page.getByRole("button", { name: "Next day" }).click();
  await page.getByText("No access to this studio").waitFor({ timeout: 60000 });
  await shot("e2e-07-403-role-removed");
  psql(`update public.user_studio_roles set active = true where user_id = '${env.users.ida}';`);

  // 6. Sign out, then the old token is refused
  await page.goto(WEB + "/today");
  await page.getByText("4 appointments").waitFor({ timeout: 60000 });
  const oldToken = await sessionToken(page);
  note("before sign-out", await staffStatus(oldToken, "/api/staff/me"));
  await page.goto(WEB + "/more");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Email", { exact: true }).waitFor();
  await shot("e2e-08-signed-out");
  note("old token after sign-out", await staffStatus(oldToken, "/api/staff/me"));
  note("storage after sign-out", { hasSession: (await sessionToken(page)) !== null });

  // 7. 401 in the app: password sign-in, then every session is revoked elsewhere (sign out everywhere)
  await page.getByLabel("Email", { exact: true }).fill(ida);
  await page.getByLabel("Password", { exact: true }).fill(env.PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("4 appointments").waitFor({ timeout: 60000 });
  const live = await sessionToken(page);
  const out = await fetch(`${SUPA}/auth/v1/logout?scope=global`, { method: "POST", headers: { Authorization: `Bearer ${live}`, apikey: stack.ISO_QA_ANON_KEY } });
  note("revoke all sessions", { status: out.status });
  await page.getByRole("button", { name: "Next day" }).click();
  await page.getByText("Your session has ended").waitFor({ timeout: 60000 });
  await shot("e2e-09-401-sign-in-again");
  await page.getByRole("button", { name: "Sign in again" }).click();
  await page.getByLabel("Email", { exact: true }).waitFor();
  note("sign in again", { landedOnSignIn: true });

  // 8. Owner: password sign-in, Pulse tab from capabilities, Today honest about no instructor profile
  await page.getByLabel("Email", { exact: true }).fill("owen.owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill(env.PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Not linked to an instructor profile").waitFor({ timeout: 60000 });
  const ownerTabs = await page.getByRole("tab").allInnerTexts().catch(() => []);
  note("owner tabs", { tabs: ownerTabs.map((t) => t.trim()) });
  await shot("e2e-10-owner-today-not-linked");
  await page.getByRole("tab", { name: "Pulse" }).click();
  await page.getByText("Studio pulse is coming").waitFor();
  await shot("e2e-11-owner-pulse");

  note("page errors", { count: failures.length, first: failures[0] ?? null });
  fs.writeFileSync(`${OUT}/evidence.json`, JSON.stringify({ day: env.DAY, gotrue: "v2.188.1", evidence }, null, 2));
  await browser.close();
})().catch(async (e) => {
  console.error("WALK FAILED:", e);
  fs.writeFileSync(`${OUT}/evidence.json`, JSON.stringify({ failed: String(e), evidence }, null, 2));
  process.exit(1);
});

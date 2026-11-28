import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";
import { loadE2EConfig } from "@/lib/e2e/config";
import { signIn } from "../helpers/competitionWizard";
import { openPlatformAdmin, type SmsAccount } from "../helpers/smsOnboardingFixture";

/**
 * TW-4F Z2 (zero-cost acceptance plan): a signed-in look at the owner and Platform Admin texting screens ON THE DATABASE the Z1 chain left behind
 * (run-chain.mjs --auth --hold). SIMULATED data, local stack only, fake provider. Skipped unless Z2_OUT names a directory: it needs that data.
 * It signs in two throwaway accounts (an extra owner of the Z1 pilot studios and an extra platform administrator), saves each screen's text and a
 * screenshot to Z2_OUT, and fails on a server error page. What the screens say is judged by reading the saved evidence.
 * The server under test is a separate process: its fake provider starts empty, so no provider action is pressed here.
 */
const OUT = process.env.Z2_OUT ?? "";
const P1 = "a1c00000-0000-4000-8000-00000000000a";
const P2 = "a1c00000-0000-4000-8000-00000000000b";
test.skip(!OUT, "needs the Z1 stack (set Z2_OUT)");
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const problems: string[] = [];
function watch(page: Page, who: string) {
  page.on("pageerror", (e) => problems.push(`${who} page error at ${new URL(page.url()).pathname}: ${e.message.slice(0, 200)}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${who} console error at ${new URL(page.url()).pathname}: ${m.text().slice(0, 200)}`); });
  page.on("response", (r) => { if (r.status() >= 500) problems.push(`${who} HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
}
async function capture(page: Page, name: string, path: string) {
  const response = await page.goto(path);
  expect(response?.status() ?? 0, path).toBeLessThan(500);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // open every collapsed section so the saved text is what the screen can show
  await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
  const text = await page.locator("body").innerText();
  writeFileSync(join(OUT, `${name}.txt`), `${page.url()}\n\n${text}`);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  expect(text, path).not.toMatch(/Application error|Internal Server Error|Something went wrong!/i);
}

async function account(role: string): Promise<SmsAccount> {
  const config = loadE2EConfig();
  const admin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession: false } });
  const email = `z2-${randomBytes(4).toString("hex")}-${role}@e2e.test`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`Z2 account ${role}: ${error?.message}`);
  const container = process.env.Z2_DB_CONTAINER ?? "";
  const id = data.user.id;
  const sql = role === "padmin"
    ? `insert into public.profiles (id, platform_role) values ('${id}', 'platform_admin') on conflict (id) do update set platform_role = 'platform_admin';`
    : `insert into public.profiles (id) values ('${id}') on conflict (id) do nothing; insert into public.user_studio_roles (user_id, studio_id, role, active) values ('${id}', '${P1}', '${role}', true), ('${id}', '${P2}', '${role}', true);`;
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" });
  return { id, email, password };
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));
test.afterAll(() => writeFileSync(join(OUT, "problems.json"), JSON.stringify(problems, null, 2)));

test("owner screens on the pilot location and the additional location", async ({ page, context, baseURL }) => {
  const owner = await account("studio_owner");
  watch(page, "owner");
  await signIn(page, owner, "/app/settings/sms");
  for (const [studio, name] of [[P1, "owner-pilot"], [P2, "owner-second-location"]] as const) {
    await context.addCookies([{ name: "app_selected_studio_id", value: studio, url: baseURL! }]);
    await capture(page, `${name}-texting`, "/app/settings/sms");
    await capture(page, `${name}-location`, "/app/settings/sms/location");
  }
});

test("front desk sees no owner controls", async ({ page, context, baseURL }) => {
  const desk = await account("front_desk");
  watch(page, "front desk");
  await signIn(page, desk, "/app");
  await context.addCookies([{ name: "app_selected_studio_id", value: P1, url: baseURL! }]);
  await capture(page, "frontdesk-texting", "/app/settings/sms");
});

test("platform administrator screens", async ({ browser }) => {
  const config = loadE2EConfig();
  const { context, page } = await openPlatformAdmin(browser, await account("padmin"), config);
  watch(page, "platform admin");
  try {
    await capture(page, "platform-sms", "/platform/sms");
    await capture(page, "platform-sms-studio", `/platform/sms?studio=${P1}`);
  } finally {
    await context.close();
  }
});

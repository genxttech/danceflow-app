import { randomBytes, randomUUID } from "node:crypto";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { E2EConfig } from "@/lib/e2e/config";
import { totp } from "@/lib/e2e/totp";
import { createClient } from "@supabase/supabase-js";
import { e2eAdminClient, type CompetitionAccount } from "./competitionFixture";
import { signIn } from "./competitionWizard";

/**
 * TW-4F-5: fixtures and UI drivers for the self-service SMS onboarding E2E specs. Everything is run-scoped (random ids, slugs and accounts) and
 * cleaned up exactly. The app under test must be a LOCAL dev server pointed at the local QA Supabase stack with TW4_ISV_FAKE=on: the Twilio adapter
 * is then an in-process fake, so nothing can reach Twilio, and no SMS, email or payment is involved. See e2e/README.md.
 */

export type SmsAccount = CompetitionAccount;
export type SmsFixture = {
  runId: string;
  studioA: { id: string; name: string; slug: string };
  studioB: { id: string; name: string; slug: string };
  owner: SmsAccount;
  frontDesk: SmsAccount;
  otherOwner: SmsAccount;
  platformAdmin: SmsAccount;
};

async function must<T>(promise: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`SMS onboarding E2E fixture: ${what}: ${error.message}`);
  return data as T;
}

export async function createSmsFixture(config: E2EConfig): Promise<SmsFixture> {
  const admin = e2eAdminClient(config);
  const runId = randomBytes(4).toString("hex");
  async function account(role: string): Promise<SmsAccount> {
    const email = `e2e-sms-${runId}-${role}@e2e.test`;
    const password = randomBytes(18).toString("base64url");
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`SMS onboarding E2E fixture: account ${role}: ${error?.message}`);
    return { id: data.user.id, email, password };
  }
  const owner = await account("owner");
  const frontDesk = await account("frontdesk");
  const otherOwner = await account("otherowner");
  const platformAdmin = await account("padmin");
  const studioA = { id: randomUUID(), name: `E2E SMS Studio A ${runId}`, slug: `e2e-sms-a-${runId}` };
  const studioB = { id: randomUUID(), name: `E2E SMS Studio B ${runId}`, slug: `e2e-sms-b-${runId}` };

  await must(admin.from("profiles").upsert([
    { id: owner.id, email: owner.email, full_name: "E2E Owner" },
    { id: frontDesk.id, email: frontDesk.email, full_name: "E2E Front Desk" },
    { id: otherOwner.id, email: otherOwner.email, full_name: "E2E Other Owner" },
    { id: platformAdmin.id, email: platformAdmin.email, full_name: "E2E Platform Admin", platform_role: "platform_admin" },
  ]), "profiles");
  await must(admin.from("studios").insert([
    { id: studioA.id, name: studioA.name, slug: studioA.slug, public_name: `E2E Harbor Dance ${runId}`, subscription_status: "active" },
    { id: studioB.id, name: studioB.name, slug: studioB.slug, subscription_status: "active" },
  ]), "studios");
  await must(admin.from("user_studio_roles").insert([
    { user_id: owner.id, studio_id: studioA.id, role: "studio_owner", active: true },
    { user_id: frontDesk.id, studio_id: studioA.id, role: "front_desk", active: true },
    { user_id: otherOwner.id, studio_id: studioB.id, role: "studio_owner", active: true },
  ]), "roles");
  return { runId, studioA, studioB, owner, frontDesk, otherOwner, platformAdmin };
}

export async function cleanupSmsFixture(config: E2EConfig, fixture: SmsFixture | undefined) {
  if (!fixture) return;
  const admin = e2eAdminClient(config);
  const studioIds = [fixture.studioA.id, fixture.studioB.id];
  const accounts = [fixture.owner, fixture.frontDesk, fixture.otherOwner, fixture.platformAdmin];
  // the onboarding, ledger, audit, window, confirmation and registration rows cascade from the studios
  await admin.from("user_studio_roles").delete().in("studio_id", studioIds);
  // a studio with credit history cannot be hard-deleted (ON DELETE RESTRICT keeps financial evidence); such studios stay until the local database is reset
  await admin.from("studios").delete().in("id", studioIds);
  await admin.from("profiles").delete().in("id", accounts.map((a) => a.id));
  for (const a of accounts) await admin.auth.admin.deleteUser(a.id);
}

export const PILOT = (page: Page) => page.locator("section#onboarding-pilot");

/** Platform admin: turn the self-service SMS onboarding pilot ON or OFF for one studio, through the real platform page. */
export async function setPilotAccess(page: Page, studioName: string, enabled: boolean, reason = "E2E pilot") {
  await page.goto("/platform/sms");
  const form = PILOT(page).locator("form").first();
  await form.locator('select[name="studioId"]').selectOption({ label: studioName });
  await form.locator('input[name="reason"]').fill(reason);
  const box = form.locator('input[name="enabled"]');
  if (enabled) await box.check();
  else await box.uncheck();
  await form.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/pilot=saved/);
}

/** Platform admin: open (hours > 0) or close (0) the runner window for one studio. */
export async function setRunnerWindow(page: Page, studioName: string, hours: number) {
  await page.goto("/platform/sms");
  const form = PILOT(page).locator('form[aria-label="Runner window"]');
  await form.locator('select[name="studioId"]').selectOption({ label: studioName });
  await form.locator('input[name="hours"]').fill(String(hours));
  await form.locator('input[name="reason"]').fill("E2E runner window");
  await form.getByRole("button", { name: "Set window" }).click();
  await page.waitForURL(/runner=/);
}

export const BUSINESS = {
  legal_name: "E2E Harbor Dance LLC",
  address_line1: "12 Harbor Way",
  city: "Portland",
  region: "OR",
  postal_code: "97201",
  rep_first_name: "Pat",
  rep_last_name: "Morgan",
  rep_title: "Owner",
  rep_email: "pat@e2e.test",
  rep_phone: "(503) 555-0123",
  preferred_area_code: "503",
};

/** Fills the three data steps of the Texting wizard exactly as an owner would. The EIN is a synthetic, obviously fake number. */
export async function fillWizard(page: Page, ein = "98-7654321") {
  const nav = page.getByRole("navigation", { name: "Setup steps" });
  await nav.getByRole("button", { name: /1\. Business/ }).click();
  await page.locator('input[name="legal_name"]').fill(BUSINESS.legal_name);
  await page.locator('select[name="entity_type"]').selectOption("llc");
  await page.locator('select[name="industry"]').selectOption("EDUCATION");
  await page.locator('input[name="ein"]').fill(ein);
  await page.locator('input[name="address_line1"]').fill(BUSINESS.address_line1);
  await page.locator('input[name="city"]').fill(BUSINESS.city);
  await page.locator('select[name="region"]').selectOption(BUSINESS.region);
  await page.locator('input[name="postal_code"]').fill(BUSINESS.postal_code);
  await page.locator('input[name="website_choice"][value="danceflow"]').check();
  await nav.getByRole("button", { name: /2\. Representative/ }).click();
  await page.locator('input[name="rep_first_name"]').fill(BUSINESS.rep_first_name);
  await page.locator('input[name="rep_last_name"]').fill(BUSINESS.rep_last_name);
  await page.locator('input[name="rep_title"]').fill(BUSINESS.rep_title);
  await page.locator('select[name="rep_position"]').selectOption("ceo");
  await page.locator('input[name="rep_email"]').fill(BUSINESS.rep_email);
  await page.locator('input[name="rep_phone"]').fill(BUSINESS.rep_phone);
  await nav.getByRole("button", { name: /3\. Texting number/ }).click();
  await page.locator('input[name="preferred_area_code"]').fill(BUSINESS.preferred_area_code);
}

export async function saveDraft(page: Page) {
  await page.getByRole("button", { name: "Save draft" }).click();
}

export async function submitReview(page: Page, attest = true) {
  const nav = page.getByRole("navigation", { name: "Setup steps" });
  await nav.getByRole("button", { name: /4\. Review/ }).click();
  if (attest) for (const name of ["attest_authorized", "attest_accurate", "attest_opt_in_only", "attest_fees_terms"]) await page.locator(`input[name="${name}"]`).check();
  await page.getByRole("button", { name: "Submit for review" }).click();
}

/** The whole owner journey up to "Submitted", through the real wizard. */
export async function ownerSubmitsSetup(page: Page, owner: SmsAccount) {
  await signIn(page, owner, "/app/settings/sms");
  await expect(page.getByRole("navigation", { name: "Setup steps" })).toBeVisible();
  await fillWizard(page);
  await saveDraft(page);
  await submitReview(page);
  await expect(page.getByRole("heading", { name: "Submitted" })).toBeVisible({ timeout: 30_000 });
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Platform admin sign-in: the platform requires an authenticator code (TOTP, AAL2). The local QA auth service must have TOTP enabled
// (see e2e/README.md); the helper enrols a factor through the real setup page the first time and answers the challenge afterwards.
// ---------------------------------------------------------------------------------------------------------------------------------------

const enrolled = new Map<string, string>();

/**
 * Enrols the platform admin's authenticator factor through the auth API (password sign-in, enrol, verify with a computed code) so the browser
 * meets the CHALLENGE page like any returning admin. The first-time SETUP page is deliberately not driven here: it enrols a factor on every
 * render, so a second render of that page (a refresh, or a double request during the redirect) is refused by the auth service with
 * "a factor with that friendly name already exists" and the page then says setup could not be started.
 */
export async function enrolPlatformAdminTotp(config: E2EConfig, account: SmsAccount) {
  const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signedIn = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  if (signedIn.error) throw new Error(`SMS onboarding E2E fixture: platform admin sign-in: ${signedIn.error.message}`);
  const enrolment = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "E2E authenticator" });
  if (enrolment.error || !enrolment.data.totp?.secret) throw new Error(`SMS onboarding E2E fixture: MFA enrol: ${enrolment.error?.message ?? "no secret"} (is TOTP enabled on the local auth service? see e2e/README.md)`);
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: enrolment.data.id, code: totp(enrolment.data.totp.secret) });
  if (verified.error) throw new Error(`SMS onboarding E2E fixture: MFA verify: ${verified.error.message}`);
  enrolled.set(account.id, enrolment.data.totp.secret);
}

async function enterCode(page: Page, secret: string) {
  // The same code cannot be used twice in one 30 s window: if the first attempt is refused, wait for the next window and try once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('input[name="code"]').fill(totp(secret, Date.now() + attempt * 30_000));
    await page.getByRole("button", { name: /verify|continue/i }).click();
    const refused = page.getByText(/did not verify|invalid|incorrect/i).first();
    await Promise.race([
      page.waitForURL((url) => !url.pathname.startsWith("/platform-mfa"), { timeout: 20_000 }).catch(() => undefined),
      refused.waitFor({ timeout: 20_000 }).catch(() => undefined),
    ]);
    if (!new URL(page.url()).pathname.startsWith("/platform-mfa")) return;
    if (attempt === 0) await page.waitForTimeout(31_000);
  }
  throw new Error("the authenticator code was not accepted");
}

/** Signs a platform admin in (password, then the authenticator code) and lands on `next`. */
export async function signInPlatformAdmin(page: Page, account: SmsAccount, next = "/platform/sms") {
  await signIn(page, account, next);
  // The sign-in redirect chain ends on the panel, or (platform MFA) on the authenticator setup / challenge page; the first landing URL can still be
  // an intermediate one, and loading the setup page twice would enrol a second factor, so wait for where it settles instead of navigating again.
  const settled = async () => {
    const path = new URL(page.url()).pathname;
    if (path.startsWith("/platform-mfa/setup") && (await page.locator("p.font-mono").count())) return "setup";
    if (path.startsWith("/platform-mfa/challenge") && (await page.locator('input[name="code"]').count())) return "challenge";
    if (await page.locator("section#onboarding-pilot").count()) return "panel";
    return "wait";
  };
  await expect.poll(settled, { timeout: 60_000, intervals: [500] }).not.toBe("wait");
  const where = await settled();
  if (where === "setup") {
    const secret = (await page.locator("p.font-mono").first().innerText()).trim();
    enrolled.set(account.id, secret);
    await enterCode(page, secret);
  } else if (where === "challenge") {
    const secret = enrolled.get(account.id);
    if (!secret) throw new Error("no enrolled authenticator secret for this platform admin in this run");
    await enterCode(page, secret);
  }
  if (!(await page.locator("section#onboarding-pilot").count())) await page.goto(next);
  await expect(page.locator("section#onboarding-pilot")).toBeVisible({ timeout: 30_000 });
}

/** One signed-in platform admin browser context for a whole spec (a new context would need a new authenticator challenge each time). */
export async function openPlatformAdmin(browser: Browser, account: SmsAccount, config: E2EConfig): Promise<{ context: BrowserContext; page: Page }> {
  await enrolPlatformAdminTotp(config, account);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInPlatformAdmin(page, account);
  return { context, page };
}

/**
 * TW-4F-3a: gives studio A a legal entity, a $150 spend cap, one authorized brand spend and an ACTIVE (fake) Twilio subaccount, through the real
 * service-role SQL functions. No Twilio call is involved: the dev server's fake parent account creates the matching fake account on demand.
 * The evidence tables have no API privileges, so this fixture cannot delete the rows it creates; see e2e/README.md for the local cleanup.
 */
export async function provisionFakeSubaccount(config: E2EConfig, fixture: SmsFixture): Promise<{ legalEntityId: string; accountSid: string }> {
  const admin = e2eAdminClient(config);
  const actor = fixture.platformAdmin.id;
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn} failed (${error.code ?? "unknown"})`);
    return data as T;
  };
  const created = await call<{ legal_entity_id: string }>("tw4_entity_create_for_studio", { p_studio_id: fixture.studioA.id, p_actor: actor, p_verification_note: "E2E fixture: synthetic legal entity" });
  const entity = created.legal_entity_id;
  await call("tw4_entity_set_spend_cap", { p_entity_id: entity, p_cents: 15_000, p_actor: actor });
  // TW-4F-3b-0: the brand has a published price, and the studio has funded its prepaid credit through a (synthetic) SETTLED payment
  await call("tw4_price_set", { p_kind: "brand", p_customer_cents: 1_000, p_provider_cents: 400, p_description: "Brand registration (e2e)", p_actor: actor });
  await call("tw4_credit_settle_topup", { p_studio_id: fixture.studioA.id, p_provider_ref: `pi_e2e_${fixture.runId}`, p_amount_cents: 5_000, p_event_id: `evt_e2e_${fixture.runId}` });
  await call("tw4_spend_authorize", { p_entity_id: entity, p_kind: "brand", p_amount_cents: 1_000, p_approval_ref: "E2E fixture approval", p_actor: actor });
  await call("tw4_subaccount_confirm", { p_entity_id: entity, p_actor: actor });
  await call("tw4_subaccount_begin", { p_entity_id: entity, p_actor: actor, p_friendly_name: `df:e2e:${entity}`, p_environment: "development" });
  const accountSid = `AC${randomBytes(16).toString("hex")}`;
  await call("tw4_subaccount_finish", { p_entity_id: entity, p_actor: actor, p_status: "active", p_account_sid: accountSid });
  return { legalEntityId: entity, accountSid };
}

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "../helpers/competitionFixture";
import { cleanupSmsFixture, createSmsFixture, openPlatformAdmin, ownerSubmitsSetup, setPilotAccess, type SmsFixture } from "../helpers/smsOnboardingFixture";

/**
 * TW-4F supervised-pilot panel: the money controls, driven through the real platform page against a LOCAL stack (fake Twilio, nothing reaches
 * Twilio or Stripe). The studio's owner submits the setup as the verified ConfiDance Unlimited, LLC, so the founder-authorized $150 pilot
 * ceiling can be recorded; then owner fee approvals (one per operation, at the published price), refusals, withdrawal, and the Low-Volume Standard
 * guards. It publishes synthetic prices and creates the (single, system-wide) pilot exception: run it only on a disposable local database and
 * clean up afterwards (see e2e/README.md).
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const PILOT_NAME = "ConfiDance Unlimited, LLC";
let config: E2EConfig;
let fixture: SmsFixture;
let adminContext: BrowserContext;
let admin: Page;

const panel = () => admin.locator("section#subaccount-panel");
const card = () => panel().locator(`[data-testid="studio-panel"][data-studio="${fixture.studioA.name}"]`);
const banner = () => panel().locator('p[role="status"], p[role="alert"]').first();
const section = (title: string) => card().locator('[data-testid="studio-steps"] details').filter({ has: admin.locator(":scope > summary", { hasText: title }) }).first();
async function open(title: string) {
  await admin.goto("/platform/sms"); // a clean URL, so the next waitForURL only matches this submission's redirect
  const steps = card().locator('[data-testid="studio-steps"]');
  if (!(await steps.evaluate((el) => (el as HTMLDetailsElement).open))) await steps.locator("summary").first().click();
  const s = section(title);
  if (!(await s.evaluate((el) => (el as HTMLDetailsElement).open))) await s.locator(":scope > summary").click();
  return s;
}
async function feeForm(kind: string) {
  const s = await open("Setup budget and fee approvals");
  const details = s.locator("details", { has: admin.locator(":scope > summary", { hasText: "Record an owner fee approval" }) });
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.locator(":scope > summary").click();
  return details.locator("form", { has: admin.locator(`input[name="kind"][value="${kind}"]`) });
}

// 20261230 (U-4): a pilot approval (and the pilot exception) carries the owner's / founder's dated written authorization as hashed evidence; the fee forms keep it in a closed details block
const evidenceDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
async function fillEvidence(form: Locator, role: "owner_written" | "founder_written", openDetails: boolean) {
  if (openDetails) await form.locator("details > summary").click();
  await form.locator('input[name="authorizedOn"]').fill(evidenceDate);
  await form.locator('select[name="authorizedByRole"]').selectOption(role);
  await form.locator('input[name="documentRef"]').fill("E2E-AUTH-DOC-0001");
  await form.locator('input[name="documentSha256"]').fill("a".repeat(64));
}

test.beforeAll(async ({ browser }) => {
  config = loadE2EConfig();
  fixture = await createSmsFixture(config);
  ({ context: adminContext, page: admin } = await openPlatformAdmin(browser, fixture.platformAdmin, config));
  await setPilotAccess(admin, fixture.studioA.name, true);
  const owner = await browser.newContext();
  try {
    await ownerSubmitsSetup(await owner.newPage(), fixture.owner, PILOT_NAME);
  } finally {
    await owner.close();
  }
  // synthetic published prices (the panel only ever authorizes at the published price)
  const db = e2eAdminClient(config);
  for (const [kind, customer, provider] of [["brand", 4600, 4150], ["number", 150, 115]] as const) {
    const { error } = await db.rpc("tw4_price_set", { p_kind: kind, p_customer_cents: customer, p_provider_cents: provider, p_description: `${kind} (e2e panel)`, p_actor: fixture.platformAdmin.id });
    if (error) throw new Error(`price fixture failed (${error.code})`);
  }
});
test.afterAll(async () => {
  await adminContext?.close();
  await cleanupSmsFixture(config, fixture);
});

test("legal business and a $150 budget for the ConfiDance studio", async () => {
  let s = await open("Legal business");
  await s.locator('input[name="verificationNote"]').fill("Oregon SOS registry entry checked (e2e)");
  await s.locator('input[name="verified"]').check();
  await s.getByRole("button", { name: "Create legal business" }).click();
  await admin.waitForURL(/panel=1/);
  s = await open("Setup budget and fee approvals");
  await s.locator('input[name="capDollars"]').fill("150");
  await s.locator('input[name="confirmCap"]').fill("150");
  await s.getByRole("button", { name: "Set budget" }).click();
  await admin.waitForURL(/panel=1/);
  await expect(banner()).toContainText("$150.00");
});

test("the pilot ceiling needs the founder approval and the acknowledgement, is at most $150, and is then shown as non-spendable", async () => {
  let s = await open("Setup budget and fee approvals");
  let pilot = s.locator("form", { hasText: "ConfiDance pilot ceiling" });
  await pilot.locator('input[name="approvalRef"]').fill("Founder email 2026-10-20 (e2e)");
  await fillEvidence(pilot, "founder_written", false);
  await pilot.getByRole("button", { name: "Record pilot ceiling" }).click();
  await admin.waitForURL(/panel_error=1/);
  await expect(banner()).toContainText("non-spendable");

  s = await open("Setup budget and fee approvals");
  pilot = s.locator("form", { hasText: "ConfiDance pilot ceiling" });
  await pilot.locator('input[name="ceilingDollars"]').fill("150.01");
  await pilot.locator('input[name="approvalRef"]').fill("Founder email 2026-10-20 (e2e)");
  await fillEvidence(pilot, "founder_written", false);
  await pilot.locator('input[name="understood"]').check();
  await pilot.getByRole("button", { name: "Record pilot ceiling" }).click();
  await admin.waitForURL(/panel_error=1/);
  await expect(banner()).toContainText("at most $150.00");

  s = await open("Setup budget and fee approvals");
  pilot = s.locator("form", { hasText: "ConfiDance pilot ceiling" });
  await pilot.locator('input[name="approvalRef"]').fill("Founder email 2026-10-20 (e2e)");
  await fillEvidence(pilot, "founder_written", false);
  await pilot.locator('input[name="understood"]').check();
  await pilot.getByRole("button", { name: "Record pilot ceiling" }).click();
  await admin.waitForURL(/panel=1/);
  await expect(banner()).toContainText("Pilot exception recorded");
  await expect(card()).toContainText("ConfiDance pilot: $150 non-spendable ceiling");
  await expect(card()).toContainText("$0.00 used, $0.00 approved but not yet reserved, $150.00 left of $150.00");
});

test("an owner fee approval: refused without the owner confirmation; recorded once; the same written approval cannot authorize a second operation", async () => {
  let form = await feeForm("brand");
  await expect(form).toContainText("$46.00");
  await form.locator('input[name="approvalRef"]').fill("Owner email 2026-10-20 approving brand $46 (e2e)");
  await form.getByRole("button", { name: "Record approval" }).click();
  await admin.waitForURL(/panel_error=1/);
  await expect(banner()).toContainText("Nothing was authorized");

  form = await feeForm("brand");
  await form.locator('select[name="funding"]').selectOption("pilot");
  await form.locator('input[name="approvalRef"]').fill("Owner email 2026-10-20 approving brand $46 (e2e)");
  await fillEvidence(form, "owner_written", true);
  await form.locator('input[name="ownerApproved"]').check();
  await form.getByRole("button", { name: "Record approval" }).click();
  await admin.waitForURL(/panel=1/);
  await expect(banner()).toContainText("one brand fee of $46.00 (pilot ceiling)");
  await expect(card().locator('[data-testid="fee-approvals"]')).toContainText("Brand registration $46.00 (pilot ceiling)");
  await expect(card()).toContainText("$46.00 approved but not yet reserved, $104.00 left of $150.00");

  // replay of the same written approval (a resubmitted form): refused, nothing added
  form = await feeForm("brand");
  await form.locator('select[name="funding"]').selectOption("pilot");
  await form.locator('input[name="approvalRef"]').fill("owner email 2026-10-20 approving brand $46 (e2e)  ");
  await fillEvidence(form, "owner_written", true);
  await form.locator('input[name="ownerApproved"]').check();
  await form.getByRole("button", { name: "Record approval" }).click();
  await admin.waitForURL(/panel_error=1/);
  await expect(banner()).toContainText("each owner approval authorizes one operation");
  await expect(card().locator('[data-testid="fee-approvals"] li')).toHaveCount(1);
});

test("the setup budget cannot drop below what is approved; Low-Volume Standard is refused while the Standard-price brand approval is open", async () => {
  let s = await open("Setup budget and fee approvals");
  await s.locator('input[name="capDollars"]').fill("40");
  await s.locator('input[name="confirmCap"]').fill("40");
  await s.getByRole("button", { name: "Set budget" }).click();
  await admin.waitForURL(/panel_error=1/);
  await expect(banner()).toContainText("below what is already authorized");

  s = await open("Registration path");
  await s.locator('input[value="low_volume_standard"]').check();
  await s.locator("summary", { hasText: "eligibility checklist" }).click();
  for (const box of await s.locator('input[name^="elig_"]').all()) await box.check();
  await s.locator('input[name="reason"]').fill("EIN business, about 200 texts a month");
  await s.getByRole("button", { name: "Save registration path" }).click();
  await admin.waitForURL(/panel_error=1/);
  await expect(banner()).toContainText("open Standard-price brand fee approval");
});

test("withdrawing the approval frees the ceiling; then Low-Volume Standard is allowed and its brand approval is disabled (no published price)", async () => {
  const s = await open("Setup budget and fee approvals");
  const item = s.locator('[data-testid="fee-approvals"] li').first();
  await item.locator('input[name="note"]').fill("Owner switched to Low-Volume Standard");
  await item.getByRole("button", { name: "Withdraw" }).click();
  await admin.waitForURL(/panel=1/);
  await expect(banner()).toContainText("withdrawn");
  await expect(card()).toContainText("$0.00 approved but not yet reserved, $150.00 left of $150.00");

  const t = await open("Registration path");
  await t.locator('input[value="low_volume_standard"]').check();
  await t.locator("summary", { hasText: "eligibility checklist" }).click();
  for (const box of await t.locator('input[name^="elig_"]').all()) await box.check();
  await t.locator('input[name="reason"]').fill("EIN business, about 200 texts a month");
  await t.getByRole("button", { name: "Save registration path" }).click();
  await admin.waitForURL(/panel=1/);
  await expect(banner()).toContainText("Low-Volume Standard");

  const brand = await feeForm("brand");
  await expect(brand).toContainText("No Low-Volume Standard price published yet");
  await expect(brand.getByRole("button", { name: "Record approval" })).toBeDisabled();
  // other fees are unaffected
  const number = await feeForm("number");
  await number.locator('input[name="approvalRef"]').fill("Owner email 2026-10-20 approving number $1.50 (e2e)");
  await fillEvidence(number, "owner_written", true);
  await number.locator('input[name="ownerApproved"]').check();
  await number.getByRole("button", { name: "Record approval" }).click();
  await admin.waitForURL(/panel=1/);
  await expect(banner()).toContainText("one number fee of $1.50");
});

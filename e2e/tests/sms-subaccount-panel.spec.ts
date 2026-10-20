import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { signIn } from "../helpers/competitionWizard";
import { BUSINESS, cleanupSmsFixture, createSmsFixture, openPlatformAdmin, ownerSubmitsSetup, setPilotAccess, type SmsFixture } from "../helpers/smsOnboardingFixture";

/**
 * TW-4F supervised-pilot subaccount panel, driven through the real platform page against a LOCAL stack with the in-process FAKE Twilio parent
 * (TW4_ISV_FAKE=on, non-production). Nothing here can reach Twilio. It writes NO price, credit, pilot or fee-approval rows (those tables are shared
 * with the financial workstream's suites; fee approvals are covered by unit tests and the SQL suites).
 * Journey: legal business from the submitted setup, setup budget, the separately confirmed Create subaccount (double click creates one), the
 * registration path with the Low-Volume Standard checklist, and an owner's location attestation that fails verification and is rejected.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let config: E2EConfig;
let fixture: SmsFixture;
let adminContext: BrowserContext;
let admin: Page;

const panel = () => admin.locator("section#subaccount-panel");
const card = () => panel().locator(`[data-testid="studio-panel"][data-studio="${fixture.studioA.name}"]`);
const banner = () => panel().locator('p[role="status"], p[role="alert"]').first();
// a section is the <details> whose OWN summary carries the title (the card wrapper contains every summary, so match the direct child only)
const section = (title: string) => card().locator('[data-testid="studio-steps"] details').filter({ has: admin.locator(':scope > summary', { hasText: title }) }).first();
async function open(title: string) {
  // cards start collapsed (progress and next action only) unless the last action was about that studio
  const steps = card().locator('[data-testid="studio-steps"]');
  if (!(await steps.evaluate((el) => (el as HTMLDetailsElement).open))) await steps.locator("summary").first().click();
  const s = section(title);
  if (!(await s.evaluate((el) => (el as HTMLDetailsElement).open))) await s.locator(":scope > summary").click();
  return s;
}

test.beforeAll(async ({ browser }) => {
  config = loadE2EConfig();
  fixture = await createSmsFixture(config);
  ({ context: adminContext, page: admin } = await openPlatformAdmin(browser, fixture.platformAdmin, config));
  await setPilotAccess(admin, fixture.studioA.name, true);
  await setPilotAccess(admin, fixture.studioB.name, true);
  const owner = await browser.newContext();
  try {
    await ownerSubmitsSetup(await owner.newPage(), fixture.owner);
  } finally {
    await owner.close();
  }
});
test.afterAll(async () => {
  await adminContext?.close();
  await cleanupSmsFixture(config, fixture);
});

test("a studio owner cannot see the subaccount panel", async ({ page }) => {
  await signIn(page, fixture.owner, "/platform/sms");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto("/platform/sms");
  await expect(page.locator("section#subaccount-panel")).toHaveCount(0);
});

test("the submitted setup appears as Configured with one next action: create the legal business", async () => {
  await admin.goto("/platform/sms");
  await expect(card()).toBeVisible();
  await expect(card().locator('[data-testid="next-action"]')).toContainText("Create the legal business");
  await expect(card()).toContainText("Legal business: Configured");
  await expect(card()).toContainText("Twilio subaccount: Not started");
});

test("creating the legal business: refusals first (no checkbox, an EIN in the note), then success", async () => {
  await admin.goto("/platform/sms");
  const s = await open("Legal business");
  await s.locator('input[name="verificationNote"]').fill("Oregon SOS registry entry checked (e2e)");
  await s.getByRole("button", { name: "Create legal business" }).click();
  await admin.waitForURL(/panel_error=/);
  await expect(banner()).toContainText("verified the legal business");

  await admin.goto("/platform/sms"); // a clean URL, so the next waitForURL only matches this submission's redirect
  const s2 = await open("Legal business");
  await s2.locator('input[name="verificationNote"]').fill("EIN 98-7654321 matched");
  await s2.locator('input[name="verified"]').check();
  await s2.getByRole("button", { name: "Create legal business" }).click();
  await admin.waitForURL(/panel_error=/);
  await expect(banner()).toContainText("Do not type an EIN");

  await admin.goto("/platform/sms"); // a clean URL, so the next waitForURL only matches this submission's redirect
  const s3 = await open("Legal business");
  await s3.locator('input[name="verificationNote"]').fill("Oregon SOS registry entry checked (e2e)");
  await s3.locator('input[name="verified"]').check();
  await s3.getByRole("button", { name: "Create legal business" }).click();
  await admin.waitForURL(/panel=/);
  await expect(banner()).toContainText("Legal business created");
  await expect(card()).toContainText("Legal business: Approved");
  await expect(card().locator('[data-testid="next-action"]')).toContainText("Set the cumulative setup budget");
});

test("the setup budget needs the amount typed twice", async () => {
  await admin.goto("/platform/sms");
  let s = await open("Setup budget and fee approvals");
  await s.locator('input[name="capDollars"]').fill("150");
  await s.locator('input[name="confirmCap"]').fill("1500");
  await s.getByRole("button", { name: "Set budget" }).click();
  await admin.waitForURL(/panel_error=/);
  await expect(banner()).toContainText("Type the same amount again");
  await admin.goto("/platform/sms"); // a clean URL, so the next waitForURL only matches this submission's redirect
  s = await open("Setup budget and fee approvals");
  await s.locator('input[name="capDollars"]').fill("150");
  await s.locator('input[name="confirmCap"]').fill("150");
  await s.getByRole("button", { name: "Set budget" }).click();
  await admin.waitForURL(/panel=/);
  await expect(banner()).toContainText("$150.00");
  await expect(card().locator('[data-testid="next-action"]')).toContainText("Create the Twilio subaccount");
});

test("the monthly spending limit sits next to the setup budget: read-only, Not set until the owner approves one, with a chevron disclosure", async () => {
  await admin.goto("/platform/sms");
  const s = await open("Setup budget and fee approvals");
  const block = s.locator('[data-testid="monthly-limit"]');
  await expect(block).toBeVisible();
  await expect(block.locator('[data-testid="monthly-limit-status"]')).toHaveText("Not set");
  await expect(block.locator('[data-testid="monthly-limit-approved"]')).toHaveText("$0.00");
  await expect(block.locator('[data-testid="monthly-limit-used"]')).toHaveText("$0.00");
  await expect(block.locator('[data-testid="monthly-limit-remaining"]')).toHaveText("$0.00");
  await expect(block.locator('[data-testid="monthly-limit-timezone"]')).not.toBeEmpty();
  await expect(block).toContainText("Only the owner sets it");
  await expect(block.locator("form, input, button, select")).toHaveCount(0);
  // progressive disclosure: closed by default; the chevron turns when it opens and back when it closes (Tailwind v4 rotate-* sets the CSS rotate property)
  const details = block.locator("details");
  const chevron = details.locator(":scope > summary svg");
  await expect(details).not.toHaveAttribute("open", "");
  const closed = await chevron.evaluate((el) => getComputedStyle(el).rotate);
  await details.locator(":scope > summary").click();
  await expect(details).toHaveAttribute("open", "");
  await expect(details).toContainText("Platform safety ceiling");
  await expect(details).toContainText("No limit changes recorded.");
  await expect.poll(() => chevron.evaluate((el) => getComputedStyle(el).rotate)).not.toBe(closed);
  await details.locator(":scope > summary").click();
  await expect(details).not.toHaveAttribute("open", "");
  await expect.poll(() => chevron.evaluate((el) => getComputedStyle(el).rotate)).toBe(closed);
  // every disclosure on the card has a visible chevron
  for (const summary of await card().locator("summary").all()) if (await summary.isVisible()) await expect(summary.locator("svg").first()).toBeVisible();
});

test("the owner of a location that now belongs to a legal business is not offered the location link", async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await signIn(page, fixture.owner, "/app/settings/sms");
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    await page.goto("/app/settings/sms");
    await expect(page.getByRole("heading", { name: "Texting", exact: true })).toBeVisible();
    await expect(page.locator('[data-testid="sms-location-link"]')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("Create subaccount: the wrong phrase creates nothing; a double click creates exactly one", async () => {
  await admin.goto("/platform/sms");
  let s = await open("Twilio subaccount");
  await s.locator('input[name="phrase"]').fill("create subaccount");
  await s.getByRole("button", { name: "Create subaccount" }).click();
  await admin.waitForURL(/panel_error=/);
  await expect(banner()).toContainText("Nothing was created");
  await expect(card()).toContainText("Twilio subaccount: Not started");

  await admin.goto("/platform/sms"); // a clean URL, so the next waitForURL only matches this submission's redirect
  s = await open("Twilio subaccount");
  await s.locator('input[name="phrase"]').fill("CREATE SUBACCOUNT");
  const button = s.getByRole("button", { name: "Create subaccount" });
  await button.dblclick();
  await admin.waitForURL(/panel(_error)?=/, { timeout: 60_000 });
  await admin.goto("/platform/sms");
  await expect(card()).toContainText("Twilio subaccount: Active");
  await expect(card().getByRole("button", { name: "Create subaccount" })).toHaveCount(0);
  await admin.goto("/platform/sms"); // a clean URL, so the next waitForURL only matches this submission's redirect
  await open("Twilio subaccount");
  const auditBox = section("Audit evidence");
  await auditBox.locator(":scope > summary").click();
  // one creation: one confirmation consumed and one finished subaccount step
  await expect(auditBox.locator("li", { hasText: "Subaccount creation confirmed" })).toHaveCount(1);
});

test("registration path: Low-Volume Standard needs the full checklist, is shown as blocked for the paid brand, and is never presented as approval", async () => {
  await admin.goto("/platform/sms");
  let s = await open("Registration path");
  await s.locator('input[value="low_volume_standard"]').check();
  await s.locator('input[name="reason"]').fill("EIN business, about 200 texts a month");
  await s.getByRole("button", { name: "Save registration path" }).click();
  await admin.waitForURL(/panel_error=/);
  await expect(banner()).toContainText("every eligibility check");

  await admin.goto("/platform/sms"); // a clean URL, so the next waitForURL only matches this submission's redirect
  s = await open("Registration path");
  await s.locator('input[value="low_volume_standard"]').check();
  await s.locator("summary", { hasText: "eligibility checklist" }).click();
  for (const box of await s.locator('input[name^="elig_"]').all()) await box.check();
  await s.locator('input[name="reason"]').fill("EIN business, about 200 texts a month");
  await s.getByRole("button", { name: "Save registration path" }).click();
  await admin.waitForURL(/panel=/);
  await expect(banner()).toContainText("Twilio still reviews");
  await expect(card()).toContainText("Registration path: Configured");
  // with the subaccount active, the Low-Volume Standard price gap is the only blocker, so it IS the next action
  await expect(card().locator('[data-testid="next-action"]')).toContainText("no published brand price");

  await admin.goto("/platform/sms"); // a clean URL, so the next waitForURL only matches this submission's redirect
  s = await open("Registration path");
  await s.locator('input[value="standard"]').check();
  await s.locator('input[name="reason"]').fill("Back to the pilot default (D3)");
  await s.getByRole("button", { name: "Save registration path" }).click();
  await admin.waitForURL(/panel=/);
  await expect(banner()).toContainText("Standard");
});

test("location linking: another business's owner attests studio B; the verification fails in the database and the admin rejects it", async ({ browser }) => {
  const other = await browser.newContext();
  try {
    const page = await other.newPage();
    await signIn(page, fixture.otherOwner, "/app/settings/sms");
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    // one click from Texting to the attestation (studio B is not linked to a legal business)
    await page.goto("/app/settings/sms");
    await page.locator('[data-testid="sms-location-link"]').getByRole("link", { name: "Link this location" }).click();
    await page.waitForURL(/\/app\/settings\/sms\/location$/);
    await expect(page.getByRole("heading", { name: "Add this location to your existing business" })).toBeVisible();
    await page.locator('input[name="legalName"]').fill(BUSINESS.legal_name);
    await page.locator('input[name="einLast4"]').fill("4321");
    await page.getByRole("button", { name: "Send for review" }).click();
    await page.waitForURL(/result=no_attest/, { timeout: 60_000 });
    await expect(page.locator('p[role="alert"]')).toContainText("Confirm the attestation");
    await page.locator('input[name="legalName"]').fill(BUSINESS.legal_name);
    await page.locator('input[name="einLast4"]').fill("4321");
    await page.locator('input[name="attest"]').check();
    await page.getByRole("button", { name: "Send for review" }).click();
    await page.waitForURL(/result=sent/, { timeout: 60_000 });
    await expect(page.locator('p[role="status"]')).toContainText("Request sent");
    // a second request while one is pending is refused
    await page.locator('input[name="legalName"]').fill(BUSINESS.legal_name);
    await page.locator('input[name="einLast4"]').fill("4321");
    await page.locator('input[name="attest"]').check();
    await page.getByRole("button", { name: "Send for review" }).click();
    await page.waitForURL(/result=exists/, { timeout: 60_000 });
    await expect(page.locator('p[role="alert"]')).toContainText("already waiting");
  } finally {
    await other.close();
  }

  await admin.goto("/platform/sms");
  const requests = panel().locator('[data-testid="location-requests"]');
  const item = requests.locator("li", { hasText: fixture.studioB.name });
  await expect(item).toContainText("Name and EIN last four match");
  // the name and EIN match, but the attester does not own a studio of this business: the database refuses the link
  await item.locator('input[name="note"]').fill("Checked the franchise agreement (e2e)");
  await item.locator('input[name="verified"]').check();
  await item.getByRole("button", { name: "Approve link" }).click();
  await admin.waitForURL(/panel_error=/);
  await expect(banner()).toContainText("checks do not agree");

  const again = panel().locator('[data-testid="location-requests"] li', { hasText: fixture.studioB.name });
  await again.locator('input[name="note"]').fill("Attester does not own this business");
  await again.getByRole("button", { name: "Reject" }).click();
  await admin.waitForURL(/panel=/);
  await expect(banner()).toContainText("rejected");
  await expect(panel().locator('[data-testid="location-requests"]')).toHaveCount(0);
});

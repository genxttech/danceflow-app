import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { signIn } from "../helpers/competitionWizard";
import {
  BUSINESS,
  cleanupSmsFixture,
  createSmsFixture,
  fillWizard,
  openPlatformAdmin,
  saveDraft,
  setPilotAccess,
  submitReview,
  type SmsFixture,
} from "../helpers/smsOnboardingFixture";

/**
 * TW-4F-5: the studio owner's Texting setup, driven through the real browser UI against a LOCAL stack with the in-process fake Twilio adapter.
 * Nothing here can reach Twilio, send an SMS or an email. Covers the happy path, validation, the pilot switch, the role / tenant matrix, the
 * read-only state after submission and cancelling.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let config: E2EConfig;
let fixture: SmsFixture;

let adminContext: BrowserContext;
let adminPage: Page;

test.beforeAll(async ({ browser }) => {
  config = loadE2EConfig();
  fixture = await createSmsFixture(config);
  ({ context: adminContext, page: adminPage } = await openPlatformAdmin(browser, fixture.platformAdmin, config));
});
test.afterAll(async () => {
  await adminContext?.close();
  await cleanupSmsFixture(config, fixture);
});

test("the Texting page does not exist for a studio the pilot is off for, not even for its owner", async ({ page }) => {
  await signIn(page, fixture.owner, "/app/settings/sms");
  await page.waitForURL((url) => !url.pathname.startsWith("/app/settings/sms"));
  expect(new URL(page.url()).pathname).toBe("/app/settings");
  await expect(page.getByRole("navigation", { name: "Setup steps" })).toHaveCount(0);
});

test("a platform admin switches the pilot on for studio A only", async () => {
  await setPilotAccess(adminPage, fixture.studioA.name, true);
  const row = adminPage.locator("section#onboarding-pilot tbody tr", { hasText: fixture.studioA.name }).first();
  await expect(row).toContainText("On");
  // studio B has no row: the switch is per studio
  await expect(adminPage.locator("section#onboarding-pilot tbody tr", { hasText: fixture.studioB.name })).toHaveCount(0);
});

test("role and tenant matrix: front desk and another studio's owner cannot reach studio A's setup; the owner can", async ({ browser }) => {
  for (const [label, account, expectedPath] of [
    ["front desk of studio A", fixture.frontDesk, "/app"],
    ["owner of studio B (pilot off)", fixture.otherOwner, "/app/settings"],
  ] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, account, "/app/settings/sms");
    await page.waitForURL((url) => !url.pathname.startsWith("/app/settings/sms"));
    expect(new URL(page.url()).pathname, label).toBe(expectedPath);
    await expect(page.getByRole("navigation", { name: "Setup steps" }), label).toHaveCount(0);
    await context.close();
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, fixture.owner, "/app/settings/sms");
  await expect(page.getByRole("navigation", { name: "Setup steps" })).toBeVisible();
  await context.close();
});

test("an invalid EIN is refused with a message, the form jumps to the step with the problem, and nothing is saved", async ({ page }) => {
  await signIn(page, fixture.owner, "/app/settings/sms");
  await fillWizard(page, "12345");
  await saveDraft(page);
  await expect(page.getByText(/9-digit EIN/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('input[name="ein"]')).toBeVisible(); // the business step is shown again
  await page.reload();
  await expect(page.locator('input[name="legal_name"]')).not.toHaveValue(BUSINESS.legal_name);
});

test("a valid draft is saved and survives a reload; the review step refuses a submission without every attestation", async ({ page }) => {
  await signIn(page, fixture.owner, "/app/settings/sms");
  await fillWizard(page);
  await saveDraft(page);
  await expect(page.getByText("Saved", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.locator('input[name="legal_name"]')).toHaveValue(BUSINESS.legal_name);
  // the EIN is never shown again once stored
  await expect(page.locator('input[name="ein"]')).not.toHaveValue("98-7654321");
  await submitReview(page, false);
  await expect(page.getByRole("heading", { name: "Submitted" })).toHaveCount(0);
});

test("submitting with every attestation shows 'Submitted', makes the form read-only and offers cancelling", async ({ page }) => {
  await signIn(page, fixture.owner, "/app/settings/sms");
  await submitReview(page, true);
  await expect(page.getByRole("heading", { name: "Submitted" })).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Submitted" })).toBeVisible();
  await expect(page.locator('input[name="legal_name"]')).toBeDisabled();
  await expect(page.getByRole("region", { name: "Cancel setup" }).or(page.locator('section[aria-label="Cancel setup"]'))).toBeVisible();
});

test("the platform switch turned off after submission pauses the setup: still visible, nothing editable", async ({ page }) => {
  await setPilotAccess(adminPage, fixture.studioA.name, false, "E2E pause");
  await signIn(page, fixture.owner, "/app/settings/sms");
  await expect(page.getByRole("status").filter({ hasText: /paused/i }).first()).toBeVisible();
  await expect(page.locator('input[name="legal_name"]')).toHaveCount(0); // status only: no editable form while paused
  await setPilotAccess(adminPage, fixture.studioA.name, true, "E2E resume");
});

test("cancelling the setup ends it, and the owner can start a fresh one", async ({ page }) => {
  await signIn(page, fixture.owner, "/app/settings/sms");
  await page.getByRole("button", { name: "Cancel setup" }).click();
  await page.getByRole("button", { name: "Yes, cancel setup" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Setup cancelled." })).toBeVisible({ timeout: 30_000 });
  await page.reload();
  // a cancelled setup leaves history only: the owner is offered a fresh, empty setup
  await expect(page.getByRole("navigation", { name: "Setup steps" })).toBeVisible();
  await expect(page.locator('input[name="ein"]')).toHaveValue("");
});

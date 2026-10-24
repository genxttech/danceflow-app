import { test, expect, type Page } from "@playwright/test";

/**
 * TW-4F J4: the platform-admin SMS activation console, driven through the real platform page against a LOCAL stack with the in-process FAKE Twilio
 * (TW4_ISV_FAKE=on, non-production, loopback database). Nothing here can reach Twilio, send SMS or charge.
 * Intended journey: a platform admin opens /platform/sms, reads the checklist of a campaign_pending location, records the sender from the ledger,
 * attests Advanced Opt-Out (Console step, D4), runs compliance validation and sender verification with the fakes, marks the location ready, activates it
 * (manual release) and suspends it again. The pilot business stays blocked by KI-1 throughout.
 *
 * Every test is fixme until the platform-admin browser E2E infrastructure exists (tracker Q1): an admin session fixture plus a seeded location with a
 * provider-confirmed service, campaign, number and attachment in the fake universe.
 */

const BLOCKED = "BLOCKED: admin browser E2E infra (Q1)";
const panel = (page: Page) => page.locator("section#sms-activation");
const studio = (page: Page, name: string) => panel(page).locator('[data-testid="activation-studio"]').filter({ hasText: name });
const banner = (page: Page) => panel(page).locator('p[role="status"], p[role="alert"]').first();

test.describe("TW-4F activation console", () => {
  test.fixme("admin opens /platform/sms and sees every checklist item, the ledger identifiers and the not-ready state", { annotation: { type: "fixme", description: BLOCKED } }, async ({ page }) => {
    await page.goto("/platform/sms#sms-activation");
    const card = studio(page, "E2E Activation Studio");
    await expect(card.locator('[data-testid="activation-item"]')).toHaveCount(14);
    await expect(card.locator('[data-testid="activation-ledger"]')).toContainText("MG");
    await expect(card.locator('[data-testid="activation-ready"]')).toHaveText("Checklist: not ready");
  });

  test.fixme("records the sender from the ledger and attests Advanced Opt-Out with all five items and an evidence reference", { annotation: { type: "fixme", description: BLOCKED } }, async ({ page }) => {
    await page.goto("/platform/sms#sms-activation");
    const card = studio(page, "E2E Activation Studio");
    const record = card.locator('[data-testid="activation-record-sender"]');
    await record.getByRole("checkbox").check();
    await record.getByRole("button", { name: "Record sender" }).click();
    await expect(banner(page)).toContainText("Sender recorded from the ledger");
    const attest = studio(page, "E2E Activation Studio").locator('[data-testid="activation-attest"]');
    for (const box of await attest.getByRole("checkbox").all()) await box.check();
    await attest.locator('input[name="evidenceRef"]').fill("E2E console screenshot reference");
    await attest.getByRole("button", { name: "Record attestation" }).click();
    await expect(banner(page)).toContainText("Advanced Opt-Out attestation recorded");
  });

  test.fixme("validates compliance and verifies the sender with the fake provider reads", { annotation: { type: "fixme", description: BLOCKED } }, async ({ page }) => {
    await page.goto("/platform/sms#sms-activation");
    await studio(page, "E2E Activation Studio").getByRole("button", { name: "Run compliance validation" }).click();
    await expect(banner(page)).toContainText("Compliance validation passed (local fake provider)");
    await studio(page, "E2E Activation Studio").getByRole("button", { name: "Verify sender" }).click();
    await expect(banner(page)).toContainText("Sender verified (local fake provider)");
  });

  test.fixme("marks ready, activates to active (manual release) and suspends with a reason", { annotation: { type: "fixme", description: BLOCKED } }, async ({ page }) => {
    await page.goto("/platform/sms#sms-activation");
    const ready = studio(page, "E2E Activation Studio").locator('[data-testid="activation-mark-ready"]');
    await ready.locator('input[name="note"]').fill("E2E: every checklist item reviewed");
    await ready.getByRole("checkbox").check();
    await ready.getByRole("button", { name: "Mark ready" }).click();
    await expect(banner(page)).toContainText("Marked ready for activation");
    const activate = studio(page, "E2E Activation Studio").locator('[data-testid="activation-activate"]');
    await activate.locator('input[name="note"]').fill("E2E: manual activation after review");
    await activate.getByRole("checkbox").check();
    await activate.getByRole("button", { name: "Activate" }).click();
    await expect(banner(page)).toContainText("Location activated");
    const suspend = studio(page, "E2E Activation Studio").locator('[data-testid="activation-suspend"]');
    await suspend.locator('input[name="reason"]').fill("E2E: immediate stop check");
    await suspend.getByRole("button", { name: "Suspend now" }).click();
    await expect(banner(page)).toContainText("Location suspended");
  });

  test.fixme("the pilot business shows the KI-1 blocking note and cannot be marked ready or activated", { annotation: { type: "fixme", description: BLOCKED } }, async ({ page }) => {
    await page.goto("/platform/sms#sms-activation");
    const card = studio(page, "ConfiDance");
    await expect(card.locator('[data-testid="activation-ki1-blocking"]')).toContainText("KI-1 (pilot ceiling double capture) must be re-decided by the owner");
    await expect(card.getByRole("button", { name: "Mark ready" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Activate" })).toBeDisabled();
  });
});

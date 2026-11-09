import { test, expect } from "@playwright/test";

/**
 * TW-4F J3: the studio owner chooses an offered texting number and approves its published monthly price, then can withdraw the open approval.
 * FIXME (BLOCKED): needs Q1's auth-capable isolated stack (signed-in owner, pilot switch on, campaign verified, an offer recorded by the admin runner with the
 * FAKE provider). Until then the database rules are covered by localStack.j3owner and the UI by numberSelection.j3 / page.j3. No Twilio, Stripe or SMS.
 * Test ids: sms-number-selection, sms-number-option, sms-number-confirm, sms-number-approve, sms-number-approved, sms-number-withdraw, sms-number-result,
 * sms-number-error, sms-number-blocked, sms-next-cta.
 */
test.describe("Settings -> Texting: owner number selection (J3)", () => {
  test.fixme("owner picks an offered number, confirms the recurring charge and approves it", async ({ page }) => {
    await page.goto("/app/settings/sms");
    await expect(page.getByTestId("sms-next-cta")).toHaveAttribute("href", "#sms-number");
    const section = page.getByTestId("sms-number-selection");
    await expect(page.getByTestId("sms-number-approve")).toBeDisabled();
    await section.getByTestId("sms-number-option").first().check();
    await page.getByTestId("sms-number-confirm").check();
    await page.getByTestId("sms-number-approve").click();
    await expect(page.getByTestId("sms-number-result")).toContainText("Number approved");
  });

  test.fixme("a second approval is refused while one is open; the owner can withdraw it", async ({ page }) => {
    await page.goto("/app/settings/sms");
    await expect(page.getByTestId("sms-number-approved")).toBeVisible();
    await page.getByTestId("sms-number-withdraw").click();
    await expect(page.getByTestId("sms-number-result")).toContainText("withdrawn");
  });

  test.fixme("no published price or a reached pilot limit shows no approval form", async ({ page }) => {
    await page.goto("/app/settings/sms");
    await expect(page.getByTestId("sms-number-blocked")).toBeVisible();
    await expect(page.getByTestId("sms-number-approve")).toHaveCount(0);
  });

  test.fixme("a studio admin and front desk never see the number choice", async ({ page }) => {
    await page.goto("/app/settings/sms");
    await expect(page.getByTestId("sms-number-selection")).toHaveCount(0);
  });
});

import { expect, type Page } from "@playwright/test";
import type { CompetitionAccount } from "./competitionFixture";
// Aliased: a plain Playwright helper, not a React hook (its "use" prefix trips react-hooks/rules-of-hooks).
import { useUniqueE2ESourceIp as assignUniqueSourceIp } from "./rateLimitBypass";

/** Phase 10C.5: drives the real Competition setup wizard through the browser (no API shortcuts). */

export async function signIn(page: Page, account: CompetitionAccount, next = "/app") {
  // The password login is rate-limited per source; each signing-in test uses its own synthetic source address.
  await assignUniqueSourceIp(page);
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  const form = page.locator("form").filter({ has: page.locator('input[name="loginMode"][value="password"]') });
  await form.locator('input[name="email"]').fill(account.email);
  await form.locator('input[name="password"]').fill(account.password);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

export const wizardStep = (page: Page) => page.locator("section[aria-labelledby]").last();
export const continueButton = (page: Page) => page.getByRole("button", { name: "Continue", exact: true });

export async function openWizard(page: Page, eventId: string) {
  await page.goto(`/app/events/${eventId}/competition/new`);
  await expect(page.getByRole("heading", { name: "Set up your competition" })).toBeVisible();
}

async function next(page: Page, expectedHeading: string) {
  await continueButton(page).click();
  await expect(wizardStep(page).getByRole("heading", { level: 3 }).first()).toHaveText(expectedHeading);
}

export type CompetitionRegistrationInput = { opens?: string; closes?: string; accountRequired: boolean };
export type EventPageInput = { summary?: string; highlight?: string; registrationInfo?: string };

/** Purpose -> Styles -> Adjudicated -> Rules: a Country (or Ballroom) adjudicated competition. */
export async function startCompetition(page: Page, style: "Country" | "Ballroom") {
  await page.getByRole("button", { name: /^Competition Dancers compete/ }).click();
  await next(page, "Which styles?");
  await page.getByRole("button", { name: new RegExp(`^${style} ${style} partner`) }).click();
  await next(page, "Will this produce an official competitive result?");
  await page.getByRole("button", { name: /^Adjudicated Official result/ }).click();
  await next(page, "Which rules?");
  await expect(page.getByRole("button", { name: /^Studio \/ Custom Rules/ })).toHaveAttribute("aria-pressed", "true");
  await next(page, "What will you offer?");
}

/** Offerings -> Divisions -> Dances for one Country Couples category (Newcomer · Open, Two Step). */
export async function chooseCountryCouples(page: Page) {
  await page.getByRole("checkbox", { name: /^Couples Two dancers/ }).check();
  await next(page, "Divisions");
  await page.getByRole("button", { name: "Newcomer", exact: true }).click();
  await page.getByRole("button", { name: "Open", exact: true }).nth(1).click();
  await next(page, "Dances");
  await page.getByRole("button", { name: "Two Step", exact: true }).click();
  await next(page, "Rounds");
  await next(page, "Competition registration");
}

/** Offerings -> Divisions -> Dances for an NDCA Pro/Am Multi-Dance in American Smooth (Bronze · B, Waltz + Foxtrot). */
export async function chooseNdcaProAmMultiDance(page: Page) {
  await page.getByRole("checkbox", { name: /^Pro\/Am Multi-Dance/ }).check();
  await page.getByRole("button", { name: "American Smooth", exact: true }).click();
  await next(page, "Divisions");
  await page.getByRole("button", { name: "Bronze", exact: true }).click();
  await page.getByRole("button", { name: "B", exact: true }).click();
  await next(page, "Dances");
  await page.getByRole("button", { name: "Waltz", exact: true }).click();
  await page.getByRole("button", { name: "Foxtrot", exact: true }).click();
  await next(page, "Rounds");
  await next(page, "Competition registration");
}

/** Competition registration -> Pricing -> Event page -> Review. */
export async function finishSetup(page: Page, registration: CompetitionRegistrationInput, pricing: { model: "Per dance" | "Per entry"; amount: string }, eventPage: EventPageInput = {}) {
  const step = wizardStep(page);
  if (registration.opens) await step.getByLabel("Competition registration opens (optional)").fill(registration.opens);
  if (registration.closes) await step.getByLabel("Competition registration closes (optional)").fill(registration.closes);
  await step.getByRole("checkbox", { name: "Competitors need a DanceFlow account to enter the competition" }).setChecked(registration.accountRequired);
  await next(page, "Pricing");
  await step.getByRole("button", { name: pricing.model, exact: true }).first().click();
  await step.getByRole("textbox").first().fill(pricing.amount);
  await next(page, "Event details & presentation");
  if (eventPage.summary) await step.getByRole("textbox", { name: /^Short summary/ }).fill(eventPage.summary);
  if (eventPage.registrationInfo) await step.getByRole("textbox", { name: /^Important registration information/ }).fill(eventPage.registrationInfo);
  if (eventPage.highlight) {
    await step.getByRole("button", { name: "Add a highlight" }).click();
    await step.getByRole("textbox", { name: /highlight/i }).last().fill(eventPage.highlight);
  }
  await next(page, "Review");
}

/** Review -> "Create Competition Draft" -> the competition workspace. */
export async function createDraft(page: Page, eventId: string) {
  await Promise.all([
    page.waitForURL((url) => url.pathname === `/app/events/${eventId}/competition`, { timeout: 90_000 }),
    page.getByRole("button", { name: "Create Competition Draft" }).click({ noWaitAfter: true }),
  ]);
}

export async function publishFromWorkspace(page: Page, eventId: string) {
  await page.goto(`/app/events/${eventId}/competition`);
  await page.getByRole("button", { name: "Publish competition" }).click();
  await expect(page.getByRole("button", { name: "Open registration" })).toBeVisible({ timeout: 30_000 });
}

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { signIn } from "../helpers/competitionWizard";
import {
  PILOT,
  cleanupSmsFixture,
  createSmsFixture,
  openPlatformAdmin,
  ownerSubmitsSetup,
  setPilotAccess,
  setRunnerWindow,
  type SmsFixture,
} from "../helpers/smsOnboardingFixture";

/**
 * TW-4F-5: the platform admin's registration runner, driven through the real platform page against a LOCAL stack with the in-process FAKE Twilio
 * adapter (TW4_ISV_FAKE=on, non-production). Nothing here can reach Twilio. It walks the admin journey the production runner enforces:
 * evaluate, review, confirm the profile submission, confirm the trust product submission and the brand fee, and checks every refusal on the way
 * (no open window, missing or wrong SUBMIT phrase, one confirmation never covers another, a studio owner cannot use the panel).
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let config: E2EConfig;
let fixture: SmsFixture;
let adminContext: BrowserContext;
let admin: Page;

const row = () => PILOT(admin).locator("tbody tr", { hasText: fixture.studioA.name }).first();
const notice = () => PILOT(admin).locator('p[role="status"]').first();
const alertBox = () => PILOT(admin).locator('p[role="alert"]').first();
const evidence = () => admin.locator('[data-testid="sms-step-evidence"]').first();

/** Clicks one of the row's buttons after setting its confirmations; the page reloads with the outcome in a banner. */
async function runRow(options: { fee?: boolean; profile?: boolean; trust?: boolean; phrase?: string; button?: "Run next steps" | "Check status" } = {}) {
  await admin.goto("/platform/sms");
  const form = row().locator("form").first();
  const set = async (name: string, on: boolean) => (on ? form.locator(`input[name="${name}"]`).check() : form.locator(`input[name="${name}"]`).uncheck());
  if ((options.button ?? "Run next steps") === "Run next steps") {
    await set("confirmFee", Boolean(options.fee));
    await set("confirmSubmitProfile", Boolean(options.profile));
    await set("confirmSubmitTrustProduct", Boolean(options.trust));
    await form.locator('input[name="submitPhrase"]').fill(options.phrase ?? "");
  }
  await form.getByRole("button", { name: options.button ?? "Run next steps" }).click();
  await admin.waitForURL(/runner(_error)?=/, { timeout: 60_000 });
}

test.beforeAll(async ({ browser }) => {
  config = loadE2EConfig();
  fixture = await createSmsFixture(config);
  ({ context: adminContext, page: admin } = await openPlatformAdmin(browser, fixture.platformAdmin, config));
  await setPilotAccess(admin, fixture.studioA.name, true);
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

test("a studio owner cannot open the platform panel", async ({ page }) => {
  await signIn(page, fixture.owner, "/platform/sms");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto("/platform/sms");
  await expect(page.locator("section#onboarding-pilot")).toHaveCount(0);
});

test("the panel lists the submitted setup with every safety control unticked, and no evidence yet", async () => {
  await admin.goto("/platform/sms");
  await expect(row()).toContainText("Submitted");
  await expect(row()).toContainText("Yes"); // EIN on file
  const form = row().locator("form").first();
  for (const name of ["confirmFee", "confirmSubmitProfile", "confirmSubmitTrustProduct"]) await expect(form.locator(`input[name="${name}"]`)).not.toBeChecked();
  await expect(form.locator('input[name="submitPhrase"]')).toHaveValue("");
  await expect(form.getByRole("button", { name: "Check status" })).toBeVisible();
  await evidence().locator("summary").click();
  await expect(evidence()).toContainText("Nothing has run for this attempt yet.");
  await expect(evidence()).toContainText("None confirmed for this attempt.");
});

test("the campaign package for the Twilio pre-review flags the local http origin, passes every other check, and carries the studio's public name and links", async () => {
  await admin.goto("/platform/sms");
  const pkg = admin.locator('[data-testid="sms-campaign-package"]').first();
  // the local dev server's public origin is http://localhost, so exactly the https check fails; on the real site every check passes
  await expect(pkg.locator("summary")).toContainText("1 check to fix");
  await pkg.locator("summary").click();
  await expect(pkg).toContainText("Fix: Opt-in, Terms and Privacy links are https");
  await expect(pkg).toContainText("Pass: Description is 40-4096 characters");
  await expect(pkg).toContainText("Pass: The message flow quotes the exact consent disclosure");
  const text = await pkg.locator("textarea").inputValue();
  expect(text).toContain(`E2E Harbor Dance ${fixture.runId}`);
  expect(text).toContain(`/studios/${fixture.studioA.slug}/sms-terms`);
  expect(text).toContain("Use case (to be confirmed before submission): MIXED");
  expect(text).not.toMatch(/d{2}-d{7}/); // never an EIN
});

test("running with no open runner window creates nothing", async () => {
  await runRow();
  await expect(notice()).toContainText(/window for this studio is closed/i);
  await evidence().locator("summary").click();
  await expect(evidence()).toContainText("Nothing has run for this attempt yet.");
});

test("with a window open the run evaluates and then stops before the irreversible submission, even with nothing ticked", async () => {
  await setRunnerWindow(admin, fixture.studioA.name, 1);
  await runRow();
  await expect(notice()).toContainText(/Stopped before an irreversible submission/i);
  await expect(notice()).toContainText("S11");
  await admin.goto("/platform/sms");
  await evidence().locator("summary").click();
  await expect(evidence()).toContainText("S10 Evaluate profile");
  await expect(evidence()).toContainText("Compliant");
  await expect(evidence()).not.toContainText("S11 SUBMIT profile for review succeeded");
  await expect(evidence()).toContainText("None confirmed for this attempt.");
});

test("a ticked submission without the exact word SUBMIT is refused and changes nothing", async () => {
  for (const phrase of ["", "submit", "SUBMIT NOW"]) {
    await runRow({ profile: true, phrase });
    await expect(alertBox()).toContainText(/type SUBMIT exactly/i);
  }
  await admin.goto("/platform/sms");
  await evidence().locator("summary").click();
  await expect(evidence()).toContainText("None confirmed for this attempt.");
});

test("confirming ONLY the profile submits it and stops again before the trust product", async () => {
  await runRow({ profile: true, phrase: "SUBMIT" });
  await expect(notice()).toContainText(/irreversible submission/i);
  await expect(notice()).toContainText("T6");
  await admin.goto("/platform/sms");
  await evidence().locator("summary").click();
  await expect(evidence()).toContainText("SUBMIT profile for review: confirmed");
  await expect(evidence()).toContainText("used");
  await expect(evidence()).toContainText("T5 Evaluate trust product");
});

test("a run that ticks nothing never submits the trust product, however many times it is repeated", async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    await runRow({});
    await expect(notice()).toContainText(/Stopped before an irreversible submission/i);
    await expect(notice()).not.toContainText(/brand fee|submitted to Twilio/i);
  }
  await admin.goto("/platform/sms");
  await evidence().locator("summary").click();
  await expect(evidence()).not.toContainText("SUBMIT trust product: confirmed");
  await expect(evidence()).not.toContainText("B1 Brand (fee)");
});

test("the read-only status check asks where the review stands and changes nothing", async () => {
  await runRow({ button: "Check status" });
  await expect(notice()).toContainText(/Status checked|brand|profile=/i);
  await admin.goto("/platform/sms");
  await expect(row()).toContainText("Business verification");
});

test("the fee confirmation, the trust product confirmation and SUBMIT together finish the registration, each recorded once", async () => {
  await runRow({ trust: true, fee: true, phrase: "SUBMIT" });
  await expect(notice()).toContainText(/brand were submitted|brand is now in review/i);
  await admin.goto("/platform/sms");
  await expect(row()).toContainText("Brand review");
  await evidence().locator("summary").click();
  await expect(evidence()).toContainText("SUBMIT trust product: confirmed");
  await expect(evidence()).toContainText("B1 Brand (fee)");
  // nothing left to run: only the status check remains
  await expect(row().locator("form").first().getByRole("button", { name: "Check status" })).toBeVisible();
});

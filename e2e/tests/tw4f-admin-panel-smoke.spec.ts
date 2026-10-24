import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { signIn } from "../helpers/competitionWizard";
import { cleanupTw4fFixture, createTw4fFixture, openTw4fAdmin, seedTw4fEntity, seedTw4fSecondStudioEntity, tw4fEnvironmentProblem, PILOT_CEILING_CENTS, type Tw4fFixture } from "../helpers/tw4fFixture";

/**
 * TW-4F Q1 smoke: the seeded fixture (platform admin with TOTP, owner + second studio owner, legal entity capped at $150, published test prices, the $150
 * pilot exception) and the EXISTING platform admin panel. It asserts only what the panel already renders (section#subaccount-panel, the studio-panel
 * cards), so it should fail loudly if a Wave 1 slice breaks the admin shell once it can run. Owner: Q1.
 *
 * Status: not executed in any recorded run (BLOCKED): the isolated stack has no auth service, so createTw4fFixture / admin TOTP sign-in cannot run there.
 * Environment: LOCAL dev server + LOCAL Supabase stack with TW4_ISV_FAKE=on (nothing can reach Twilio, Stripe or any carrier). Without the fake adapter
 * the spec is skipped by tw4fEnvironmentProblem(): a skip is BLOCKED in the QA matrix, never PASS.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let config: E2EConfig;
let fixture: Tw4fFixture;
let adminContext: BrowserContext;
let admin: Page;

test.beforeAll(async ({ browser }) => {
  const problem = tw4fEnvironmentProblem();
  test.skip(Boolean(problem), problem ?? "");
  config = loadE2EConfig();
  fixture = await createTw4fFixture(config);
  ({ context: adminContext, page: admin } = await openTw4fAdmin(browser, fixture, config));
  await seedTw4fEntity(browser, config, fixture, admin);
  await seedTw4fSecondStudioEntity(browser, config, fixture, admin);
});
test.afterAll(async () => {
  await adminContext?.close();
  await cleanupTw4fFixture(config, fixture);
});

const card = (page: Page, studioName: string) => page.locator("section#subaccount-panel").locator(`[data-testid="studio-panel"][data-studio="${studioName}"]`);

test("the seeded fixture produced a legal entity capped at the $150 pilot ceiling", async () => {
  expect(fixture.legalEntityId, "legal entity id").toMatch(/^[0-9a-f-]{36}$/);
  expect(fixture.otherLegalEntityId, "second studio's entity id").toMatch(/^[0-9a-f-]{36}$/);
  expect(fixture.otherLegalEntityId).not.toBe(fixture.legalEntityId);
  expect(PILOT_CEILING_CENTS).toBe(15_000);
});

test("the platform admin sees both studios' cards in the subaccount panel", async () => {
  await admin.goto("/platform/sms");
  await expect(admin.locator("section#subaccount-panel")).toBeVisible();
  await expect(card(admin, fixture.studioA.name)).toBeVisible();
  await expect(card(admin, fixture.studioB.name)).toBeVisible();
  await expect(card(admin, fixture.studioA.name).locator('[data-testid="next-action"]')).toBeVisible();
});

test("a studio owner cannot see the platform panel", async ({ page }) => {
  await signIn(page, fixture.owner, "/platform/sms");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto("/platform/sms");
  await expect(page.locator("section#subaccount-panel")).toHaveCount(0);
});

test("the second studio's owner cannot see the platform panel or studio A's card", async ({ page }) => {
  await signIn(page, fixture.otherOwner, "/platform/sms");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto("/platform/sms");
  await expect(page.locator("section#subaccount-panel")).toHaveCount(0);
  await expect(page.getByText(fixture.studioA.name)).toHaveCount(0);
});

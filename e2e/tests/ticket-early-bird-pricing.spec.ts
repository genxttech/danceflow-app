import { test, expect, type Page } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { cleanupTicketPricingFixture, createTicketPricingFixture, readOrdersForEvent, readTicket, type TicketPricingFixture } from "../helpers/ticketPricingFixture";
import { signIn } from "../helpers/competitionWizard";
import { useUniqueE2ESourceIp as assignUniqueSourceIp } from "../helpers/rateLimitBypass";

/**
 * CI-A -- early-bird ticket pricing integrity, through the real public event page, registration form, cart checkout
 * and ticket editor. Every fixture event requires a waiver, so checkout stores the order and its price snapshots and
 * redirects to document signing BEFORE any Stripe call (no Stripe request; Stripe-side amounts are covered by the
 * route integration tests). Run-scoped fixtures, deleted afterwards.
 */

test.describe.configure({ mode: "serial", timeout: 240_000 });

const RACE_SECONDS = 75;

test.describe("Early-bird ticket pricing (CI-A)", () => {
  let config: E2EConfig;
  let fixture: TicketPricingFixture;

  test.beforeAll(async () => {
    config = loadE2EConfig();
    fixture = await createTicketPricingFixture(config, { raceCutoffIso: new Date(Date.now() + RACE_SECONDS * 1000).toISOString() });
  });

  test.afterAll(async () => {
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    await cleanupTicketPricingFixture(config, fixture);
  });

  async function openForm(page: Page, slug: string) {
    await assignUniqueSourceIp(page);
    await page.goto(`/events/${slug}`);
    await page.getByText("Open Registration Form").click();
  }

  /** The visible checkout form (the page can also hold a hidden copy, e.g. for the mobile layout). */
  const cartForm = (page: Page) => page.locator('form[action="/api/events/cart/checkout"]').filter({ visible: true }).first();

  async function fillBuyer(page: Page) {
    const form = cartForm(page);
    await form.locator('input[name="attendeeFirstName"]').fill("Pat");
    await form.locator('input[name="attendeeLastName"]').fill("Buyer");
    await form.locator('input[name="attendeeEmail"]').fill(`buyer-${fixture.runId}@e2e.test`);
  }

  test("early-bird card, form line and checkout total agree; quantities and mixed tickets total correctly; the order snapshot matches", async ({ page }) => {
    await assignUniqueSourceIp(page);
    await page.goto(`/events/${fixture.events.early.slug}`);
    // Public ticket card (Tickets tab) and the lowest-price label use the same effective price.
    await expect(page.getByText("From $25.00").first()).toBeVisible();
    await page.getByRole("tab", { name: "Tickets" }).click();
    const card = page.locator("article", { hasText: "Early Bird Pass" }).first();
    await expect(card.getByText("$30.00")).toBeVisible();
    await expect(card.getByText("Early bird pricing active")).toBeVisible();
    await page.getByText("Open Registration Form").click();
    // Form line: effective price with the regular price shown alongside
    await expect(page.getByText("Early bird price · regular $40.00")).toBeVisible();
    await cartForm(page).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.earlyBird}"]`).fill("2");
    await cartForm(page).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.regular}"]`).fill("1");
    // 2 x 30.00 + 1 x 25.00
    await expect(cartForm(page).locator("details", { hasText: "Your checkout" }).getByText("$85.00")).toBeVisible();
    await expect(cartForm(page).locator("details", { hasText: "Your checkout" }).getByText("$60.00")).toBeVisible();
    await fillBuyer(page);
    // The buyer is attendee 1 of each ticket line: 2 early-bird + 1 regular needs exactly one more name.
    await expect(cartForm(page).locator('input[name="additionalAttendeeNames"]')).toHaveCount(1);
    await cartForm(page).locator('input[name="additionalAttendeeNames"]').fill("Second Guest");
    await cartForm(page).locator('button[type="submit"]').click();
    await page.waitForURL(/\/sign\//, { timeout: 90_000 });

    const { orders, items, registrations } = await readOrdersForEvent(config, fixture.events.early.id);
    expect(orders).toHaveLength(1);
    expect(Number(orders[0].total_amount)).toBe(85);
    const byTicket = Object.fromEntries(items.map((item) => [item.ticket_type_id, item]));
    expect(Number(byTicket[fixture.tickets.earlyBird].unit_price)).toBe(30);
    expect(Number(byTicket[fixture.tickets.earlyBird].total_price)).toBe(60);
    expect(byTicket[fixture.tickets.earlyBird].quantity).toBe(2);
    expect((byTicket[fixture.tickets.earlyBird].metadata as { pricing: Record<string, unknown> }).pricing).toMatchObject({ unit_cents: 3000, regular_unit_cents: 4000, early_bird: true });
    expect(Number(byTicket[fixture.tickets.regular].unit_price)).toBe(25);
    expect(registrations.map((row) => Number(row.unit_price)).sort()).toEqual([25, 30]);
  });

  test("an expired early-bird ticket shows and is priced at the regular price", async ({ page }) => {
    await assignUniqueSourceIp(page);
    await page.goto(`/events/${fixture.events.expired.slug}`);
    await page.getByRole("tab", { name: "Tickets" }).click();
    await expect(page.locator("article", { hasText: "Expired Early Bird Pass" }).first().getByText("$40.00")).toBeVisible();
    await expect(page.getByText("Early bird pricing active")).toHaveCount(0);
    await page.getByText("Open Registration Form").click();
    await expect(page.getByText(/Early bird price · regular/)).toHaveCount(0);
    await cartForm(page).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.expired}"]`).fill("1");
    await expect(cartForm(page).locator("details", { hasText: "Your checkout" }).getByText("$40.00").first()).toBeVisible();
    await fillBuyer(page);
    await cartForm(page).locator('button[type="submit"]').click();
    await page.waitForURL(/\/sign\//, { timeout: 90_000 });
    const { orders, items } = await readOrdersForEvent(config, fixture.events.expired.id);
    expect(Number(orders[0].total_amount)).toBe(40);
    expect(Number(items[0].unit_price)).toBe(40);
  });

  test("a cutoff that passes while the form is open never produces an unconfirmed higher charge", async ({ page }) => {
    await openForm(page, fixture.events.race.slug);
    await expect(page.getByText("Early bird price · regular $40.00")).toBeVisible(); // shown at 30.00
    await cartForm(page).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.race}"]`).fill("1");
    await expect(cartForm(page).locator("details", { hasText: "Your checkout" }).getByText("$30.00").first()).toBeVisible();
    await fillBuyer(page);
    const cutoff = await readTicket(config, fixture.tickets.race);
    const waitMs = Date.parse(cutoff.early_bird_ends_at as string) - Date.now() + 2_000;
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    await cartForm(page).locator('button[type="submit"]').click();
    await page.waitForURL(/error=ticket_price_changed/, { timeout: 60_000 });
    await expect(page.getByText(/Ticket prices changed since you opened this page/)).toBeVisible();
    expect((await readOrdersForEvent(config, fixture.events.race.id)).orders).toHaveLength(0);

    // Fresh confirmation: the form re-opens with the error (no click needed), now at the regular price, and
    // resubmitting charges exactly what is shown.
    await expect(page.getByText(/Early bird price · regular/)).toHaveCount(0);
    await cartForm(page).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.race}"]`).fill("1");
    await expect(cartForm(page).locator("details", { hasText: "Your checkout" }).getByText("$40.00").first()).toBeVisible();
    await fillBuyer(page);
    await cartForm(page).locator('button[type="submit"]').click();
    await page.waitForURL(/\/sign\//, { timeout: 90_000 });
    const after = await readOrdersForEvent(config, fixture.events.race.id);
    expect(after.orders).toHaveLength(1);
    expect(Number(after.items[0].unit_price)).toBe(40);
  });

  test("the ticket editor interprets the early-bird cutoff in the event's time zone and rejects invalid input", async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, fixture.owner, `/app/events/${fixture.events.editor.id}/tickets`);
    await page.goto(`/app/events/${fixture.events.editor.id}/tickets`);
    await expect(page.getByText("Early bird ends (America/Chicago time)").first()).toBeVisible();

    const editForm = page.locator("form").filter({ has: page.locator(`input[name="ticketId"][value="${fixture.tickets.editor}"]`) });
    // Wait for the server action itself (networkidle can settle before it answers).
    const submit = async (form: typeof editForm) => {
      await Promise.all([
        page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/app/events/${fixture.events.editor.id}/tickets`), { timeout: 60_000 }),
        form.locator('button[type="submit"]').first().click(),
      ]);
      await page.waitForLoadState("load");
    };
    const save = () => submit(editForm);
    await editForm.locator('input[name="earlyBirdEnabled"]').check();
    await editForm.locator('input[name="earlyBirdPrice"]').fill("45");
    await editForm.locator('input[name="earlyBirdEndsAt"]').fill("2027-03-01T00:00");
    await save();
    await expect(page.getByText("Early bird price must be lower than the regular ticket price.")).toBeVisible();
    expect(await readTicket(config, fixture.tickets.editor)).toMatchObject({ early_bird_enabled: false });

    const editForm2 = page.locator("form").filter({ has: page.locator(`input[name="ticketId"][value="${fixture.tickets.editor}"]`) });
    await editForm2.locator('input[name="earlyBirdEnabled"]').check();
    await editForm2.locator('input[name="earlyBirdPrice"]').fill("30");
    await editForm2.locator('input[name="earlyBirdEndsAt"]').fill("2027-03-14T02:30"); // does not exist in Chicago (DST gap)
    await submit(editForm2);
    await expect(page.getByText(/does not exist in the event's time zone/)).toBeVisible();

    const editForm3 = page.locator("form").filter({ has: page.locator(`input[name="ticketId"][value="${fixture.tickets.editor}"]`) });
    await editForm3.locator('input[name="earlyBirdEnabled"]').check();
    await editForm3.locator('input[name="earlyBirdPrice"]').fill("30");
    await editForm3.locator('input[name="earlyBirdEndsAt"]').fill("2027-03-01T00:00");
    await submit(editForm3);
    await expect.poll(async () => (await readTicket(config, fixture.tickets.editor)).early_bird_enabled, { timeout: 30_000 }).toBe(true);
    const saved = await readTicket(config, fixture.tickets.editor);
    expect(Number(saved.early_bird_price)).toBe(30);
    expect(new Date(saved.early_bird_ends_at as string).toISOString()).toBe("2027-03-01T06:00:00.000Z"); // 00:00 CST
    // The editor shows it back in event time (stable on re-save).
    const editForm4 = page.locator("form").filter({ has: page.locator(`input[name="ticketId"][value="${fixture.tickets.editor}"]`) });
    await expect(editForm4.locator('input[name="earlyBirdEndsAt"]')).toHaveValue("2027-03-01T00:00");
    await page.context().close();
  });

  test("existing ordinary event pages render and competition registration stays inaccessible", async ({ page }) => {
    await assignUniqueSourceIp(page);
    for (const event of Object.values(fixture.events)) {
      const response = await page.goto(`/events/${event.slug}`);
      expect(response?.status(), event.slug).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: event.name })).toBeVisible();
    }
    const register = await page.goto(`/events/${fixture.events.early.slug}/competition/register`);
    expect(register?.status()).toBe(404);
    const resume = await page.request.get(`/api/events/${fixture.events.early.slug}/competition/resume`, { maxRedirects: 0 });
    expect(resume.status()).toBe(404);
  });
});

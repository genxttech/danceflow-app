import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient, readPrograms, type CompetitionAccount } from "./competitionFixture";
import { createCompetitionEvent, type Couple, type CreatedEvent } from "./competitionFullEvent";
import { chooseCountryCouples, createDraft, finishSetup, signIn, startCompetition, wizardStep } from "./competitionWizard";

/**
 * Q1 extension: refund, scratch, duplicate check-in and tenant-isolation scenarios (R2 refunds, SC1 scratch, CI-B check-in).
 * Every state change goes through the DanceFlow UI; the admin client here only READS evidence, with ONE exception that is
 * a recorded product gap: `seedPricingRules` writes the event's fee and discount rules, because no organizer UI creates
 * them (only the WSDC competitor surcharge has one).
 */

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const toCents = (value: unknown) => Math.round(Number(value ?? 0) * 100);

/** A signed-in browser context for one account (own context, so two desks are really two sessions). */
export async function signedInContext(browser: Browser, account: CompetitionAccount, next?: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, account, next);
  return { context, page };
}

/** Stage 1 for a second, priced event: Create Event, setup wizard (Country, Newcomer/Open, Two Step, $40 per entry), publish, open registration. */
export async function createPricedCompetition(page: Page, config: E2EConfig, input: { name: string; startDate: string; entryFee: number }): Promise<CreatedEvent> {
  const event = await createCompetitionEvent(page, config, { name: input.name, startDate: input.startDate, endDate: input.startDate });
  await expect(page.getByRole("heading", { name: "Set up your competition" })).toBeVisible();
  await startCompetition(page, "Country");
  await chooseCountryCouples(page);
  await finishSetup(page, { accountRequired: false }, { model: "Per entry", amount: String(input.entryFee) }, {
    summary: "Q1 refund and scratch scenarios.", registrationInfo: "Entries are confirmed once payment completes.",
  });
  await createDraft(page, event.id);
  await page.getByRole("button", { name: "Publish competition" }).click();
  await expect(page.getByRole("button", { name: "Open registration" })).toBeVisible({ timeout: 30_000 });
  return event;
}

export async function openRegistration(page: Page) {
  await page.getByRole("button", { name: "Open registration" }).click();
  await expect(page.getByRole("button", { name: "Close registration" })).toBeVisible({ timeout: 30_000 });
}

/**
 * PRODUCT GAP (setup only): the organizer UI has no way to create fee or discount rules, so the refund scenarios that
 * need a fee line and a discounted net cap seed them here with the service-role client, before anyone registers.
 * Nothing about a registration, payment, refund or check-in is written this way.
 */
export async function seedPricingRules(config: E2EConfig, eventId: string, rules: { feePerEntry: number; discountPercent: number }) {
  const admin = e2eAdminClient(config);
  const [program] = await readPrograms(config, eventId);
  const base = { event_id: eventId, program_id: program.id, registration_mode: "both", currency: "USD", active: true };
  const { error } = await admin.from("event_competition_fee_rules").insert([
    { ...base, name: "Processing fee", calculation_type: "flat_per_entry", amount: rules.feePerEntry, priority: 10 },
    { ...base, name: "Early registration discount", calculation_type: "discount_percentage", amount: 0, percentage: rules.discountPercent, priority: 20 },
  ]);
  if (error) throw new Error(`seed pricing rules: ${error.message}`);
}

/** Several couples in ONE cart (one order): build each entry on the public page, then continue to checkout. Returns the Stripe URL. */
export async function registerCouples(page: Page, slug: string, contact: { name: string; email: string; phone: string }, couples: Couple[]) {
  await page.goto(`/events/${slug}/competition/register`);
  await expect(page.getByRole("heading", { name: "Competition Registration" })).toBeVisible();
  await page.getByPlaceholder("Contact name").fill(contact.name);
  await page.getByPlaceholder("Contact email").fill(contact.email);
  await page.getByPlaceholder("Contact phone").fill(contact.phone);
  const entries = page.locator("section").filter({ has: page.getByRole("heading", { name: "Entries", exact: true }) });
  for (const couple of couples) {
    for (const person of [couple.leader, couple.follower]) {
      await page.getByPlaceholder("First name").fill(person.firstName);
      await page.getByPlaceholder("Last name").fill(person.lastName);
      await page.getByRole("button", { name: "Add to roster" }).click();
      await expect(page.getByText(`${person.firstName} ${person.lastName}`).first()).toBeVisible();
    }
    await page.getByRole("combobox", { name: "Leader", exact: true }).selectOption({ label: `${couple.leader.firstName} ${couple.leader.lastName}` });
    await page.getByRole("combobox", { name: "Follower", exact: true }).selectOption({ label: `${couple.follower.firstName} ${couple.follower.lastName}` });
    const dances = page.locator("label").filter({ hasText: "Two Step" }).getByRole("checkbox");
    if ((await dances.count()) && !(await dances.first().isChecked())) await dances.first().check();
    await page.getByRole("button", { name: "Add entry", exact: true }).click();
    await expect(entries.getByText(`${couple.leader.firstName} ${couple.leader.lastName} · ${couple.follower.firstName} ${couple.follower.lastName}`)).toBeVisible();
  }
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 90_000 });
  return page.url();
}

// ------------------------------------------------------------------ read-only evidence

type Row = Record<string, unknown>;
async function readRows(config: E2EConfig, table: string, columns: string, filter: Record<string, string>): Promise<Row[]> {
  let query = e2eAdminClient(config).from(table).select(columns);
  for (const [key, value] of Object.entries(filter)) query = query.eq(key, value);
  const { data, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as unknown as Row[];
}

/** Everything money-related about one order, read with the service-role client. */
export async function readOrderMoney(config: E2EConfig, eventId: string, orderId: string) {
  const [orders, items, refunds, allocations, registrations, entries] = await Promise.all([
    readRows(config, "event_orders", "id, status, payment_status, total_amount, subtotal_amount, discount_amount", { id: orderId }),
    readRows(config, "event_order_items", "id, item_type, description, total_price, metadata", { order_id: orderId }),
    readRows(config, "event_order_refunds", "id, status, amount_cents, source, stripe_refund_id, stripe_payment_intent_id, stripe_account_id, refund_request_id, reason, succeeded_at", { order_id: orderId }),
    readRows(config, "event_order_refund_allocations", "refund_id, order_item_id, entry_id, line_kind, amount_cents, withdraw_entry, participation_outcome", { order_id: orderId }),
    readRows(config, "event_registrations", "id, payment_status, total_price", { order_id: orderId }),
    readRows(config, "event_competition_entries", "id, order_item_id, display_name, status, sort_order", { order_id: orderId }),
  ]);
  const registrationIds = registrations.map((row) => row.id as string);
  const admin = e2eAdminClient(config);
  const { data: payments, error } = registrationIds.length
    ? await admin.from("event_payments").select("id, amount, refund_amount, refunded_at, status, stripe_payment_intent_id, stripe_account_id").in("registration_id", registrationIds)
    : { data: [], error: null };
  if (error) throw new Error(`event_payments: ${error.message}`);
  const { data: accounting, error: accountingError } = await admin.from("accounting_entries")
    .select("id, entry_type, category, direction, gross_amount, refund_amount, net_amount, entry_date, posted_at, entry_status, stripe_payment_intent_id, source_table, source_id, reverses_entry_id")
    .eq("event_id", eventId).eq("category", "competition_entry_refund");
  if (accountingError) throw new Error(`accounting_entries: ${accountingError.message}`);
  return { order: orders[0], items, refunds, allocations, registrations, entries, payments: (payments ?? []) as Row[], refundAccounting: (accounting ?? []) as Row[] };
}

export async function readScratches(config: E2EConfig, eventId: string) {
  return readRows(config, "event_competition_scratches", "id, entry_id, path, is_exception, policy_resolution, requested_resolution, reason, previous_status, performed_by, request_id", { event_id: eventId });
}

export async function readCheckin(config: E2EConfig, eventId: string) {
  const [sessions, participants] = await Promise.all([
    readRows(config, "event_competition_checkin_sessions", "id, registration_cart_id, order_id, status, payment_status, balance_due, currency", { event_id: eventId }),
    readRows(config, "event_competition_checkin_participants", "id, checkin_session_id, display_name, presence_status, checked_in_at, checked_in_by", { event_id: eventId }),
  ]);
  return { sessions, participants };
}

// ------------------------------------------------------------------ R2 refund page

export type RefundLine = { itemId: string; label: string; remainingCents: number; capCents: number; kind: "entry" | "fee" };

/** The refund page's lines, read from the rendered table (the staff's own view of the caps). */
export async function readRefundLines(page: Page): Promise<RefundLine[]> {
  const rows = page.locator("form:has(textarea#reason) tbody tr");
  const count = await rows.count();
  const lines: RefundLine[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const itemId = await row.locator('input[name="itemId"]').inputValue();
    const text = (await row.innerText()).replace(/\s+/g, " ");
    const amounts = [...text.matchAll(/\$([\d,]+\.\d{2})/g)].map((match) => Math.round(Number(match[1].replace(/,/g, "")) * 100));
    // Cells: line label, "<remaining> of <cap>", refunded, ...
    const label = (await row.locator("td").first().locator("span").first().innerText()).trim();
    lines.push({ itemId, label, kind: /^Fee$/m.test(await row.locator("td").first().innerText()) ? "fee" : "entry", remainingCents: amounts[0], capCents: amounts[1] });
  }
  return lines;
}

export async function openRefundPage(page: Page, eventId: string, orderId: string) {
  await page.goto(`/app/events/${eventId}/competition/registrations/${orderId}/refund`);
  await expect(page.getByRole("heading", { name: /^Refunds · / })).toBeVisible();
}

/** Fill the refund form: amount per line (dollars), the scratch checkbox per line, the reason. Does not submit. */
export async function fillRefundForm(page: Page, input: { amounts: Record<string, number>; scratch?: Record<string, boolean>; reason: string }) {
  for (const [itemId, cents] of Object.entries(input.amounts)) await page.locator(`#amount_${itemId}`).fill((cents / 100).toFixed(2));
  for (const [itemId, checked] of Object.entries(input.scratch ?? {})) {
    const box = page.locator(`input[name="withdraw_${itemId}"]`);
    if (checked) await box.check(); else await box.uncheck();
  }
  await page.locator("#reason").fill(input.reason);
}

export const refundButton = (page: Page) => page.getByRole("button", { name: "Refund selected lines" });

/** Total refunds Stripe holds for a payment intent on the connected account (the source of truth for "one refund"). */
export async function stripeRefundsFor(stripe: import("stripe").default, account: string, paymentIntent: string) {
  const list = await stripe.refunds.list({ payment_intent: paymentIntent, limit: 20 }, { stripeAccount: account });
  return list.data;
}

export { toCents };
export { wizardStep };

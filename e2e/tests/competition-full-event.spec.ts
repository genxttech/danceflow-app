import { test, expect, type Browser, type Page } from "@playwright/test";
import Stripe from "stripe";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient, readPrograms, type CompetitionAccount } from "../helpers/competitionFixture";
import {
  cleanupCompetitionFullEventFixture,
  createCompetitionFullEventFixture,
  type CompetitionFullEventFixture,
} from "../helpers/competitionFullEventFixture";
import {
  createCompetitionEvent,
  payCheckoutSession,
  readCompetitionRegistrations,
  registerCouple,
  verifyEmailAndBindPassword,
  type Couple,
  type CreatedEvent,
} from "../helpers/competitionFullEvent";
import { chooseCountryCouples, createDraft, finishSetup, signIn, startCompetition, wizardStep } from "../helpers/competitionWizard";
import {
  createPricedCompetition,
  fillRefundForm,
  openRefundPage,
  openRegistration,
  readCheckin,
  readOrderMoney,
  readRefundLines,
  readScratches,
  refundButton,
  registerCouples,
  seedPricingRules,
  signedInContext,
  stripeRefundsFor,
} from "../helpers/competitionFullEventMoney";
import { useUniqueE2ESourceIp as assignUniqueSourceIp } from "../helpers/rateLimitBypass";

/**
 * Q1 -- the full simulated competition (Competition OS definition of done, §9), driven through the real DanceFlow UI
 * on a local stack. This file grows stage by stage as the slices land; stages that cannot be driven yet are
 * `test.fixme` with the definition-of-done wording, so they show up as pending rather than passing.
 *
 * Only the base seed is written directly (studio with a Stripe TEST connected account, owner, judges, dancers:
 * competitionFullEventFixture.ts). Everything else is created by people in browsers. The service-role client is used
 * only to READ evidence, and Stripe's API only to pay the hosted Checkout page the way `stripe trigger` does (the page
 * runs bot detection and is never automated) -- see docs/qa/local-e2e-environment.md.
 *
 * Environment: local app started with NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true and Stripe TEST keys, webhooks
 * via `stripe listen --forward-connect-to <app>/api/payments/webhook`, local QA Supabase. The run declares it with
 * E2E_COMPETITION_REGISTRATION_ENABLED=true, E2E_STRIPE_TEST_SECRET_KEY (sk_test_/rk_test_) and
 * E2E_STRIPE_TEST_CONNECTED_ACCOUNT; without them the whole file skips.
 */

test.describe.configure({ mode: "serial", timeout: 300_000 });

const FLAG_ON = process.env.E2E_COMPETITION_REGISTRATION_ENABLED === "true";
const TEST_KEY = process.env.E2E_STRIPE_TEST_SECRET_KEY ?? "";
const ACCOUNT = process.env.E2E_STRIPE_TEST_CONNECTED_ACCOUNT ?? "";
const ENTRY_FEE = 40;

test.describe("Full simulated competition (Q1)", () => {
  test.skip(!FLAG_ON, "Needs the app started with NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true (E2E_COMPETITION_REGISTRATION_ENABLED=true).");
  test.skip(!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(TEST_KEY) || !/^acct_[A-Za-z0-9]+$/.test(ACCOUNT), "Stripe TEST key and test connected account not provided");

  let config: E2EConfig;
  let fixture: CompetitionFullEventFixture;
  let stripe: Stripe;
  let event: CreatedEvent;
  /** Every registration made in stage 2, in order: who registered, and the couple they entered. */
  const registrations: Array<{ who: string; email: string; account?: CompetitionAccount; couple: Couple }> = [];
  /** The second, priced competition (fee line + discount) used by the refund and duplicate check-in scenarios. */
  let refundEvent: CreatedEvent;
  /** The main-event entry scratched in 3d and refunded in 3e. */
  let scratchTarget: { orderId: string; entryId: string; name: string };
  let refundOrder: { id: string; paymentIntent: string; couples: Couple[]; buyerEmail: string };

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl)) throw new Error("refusing: not the local QA Supabase");
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.baseUrl)) throw new Error("refusing: not a local app");
    stripe = new Stripe(TEST_KEY);
    if ((await stripe.balance.retrieve()).livemode) throw new Error("refusing: Stripe key is live");
    fixture = await createCompetitionFullEventFixture(config, { connectedAccountId: ACCOUNT });
  });

  test.afterAll(async () => {
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    await cleanupCompetitionFullEventFixture(config, fixture);
  });

  async function as(browser: Browser, account: CompetitionAccount, next?: string): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, account, next);
    return page;
  }

  const evidence = (value: unknown) => test.info().annotations.push({ type: "evidence", description: JSON.stringify(value) });

  // ---------------------------------------------------------------- Stage 1

  test("stage 1: owner creates the competition event, configures categories and pricing, publishes and opens registration", async ({ browser }) => {
    const page = await as(browser, fixture.owner);
    event = await createCompetitionEvent(page, config, { name: `E2E Spring Classic ${fixture.runId}`, startDate: "2027-04-17", endDate: "2027-04-17" });
    await expect(page.getByRole("heading", { name: "Set up your competition" })).toBeVisible();

    // Country, adjudicated, Studio/Custom rules; one Couples category (Newcomer · Open, Two Step), $40 per entry.
    await startCompetition(page, "Country");
    await chooseCountryCouples(page);
    await finishSetup(page, { accountRequired: false }, { model: "Per entry", amount: String(ENTRY_FEE) }, {
      summary: "Q1 simulated competition.", registrationInfo: "Entries are confirmed once payment completes.",
    });
    await expect(wizardStep(page)).toContainText("Draft · registration closed");
    await createDraft(page, event.id);

    await page.getByRole("button", { name: "Publish competition" }).click();
    await expect(page.getByRole("button", { name: "Open registration" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Open registration" }).click();
    await expect(page.getByRole("button", { name: "Close registration" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Published · Registration open/)).toBeVisible();

    const [program] = await readPrograms(config, event.id);
    expect(program).toMatchObject({ rules_profile_key: "studio_simple", rules_profile_version: 3, status: "configured", registration_status: "open" });
    const { data: eventRow } = await e2eAdminClient(config).from("events").select("status, visibility, event_type, studio_id").eq("id", event.id).single();
    expect(eventRow).toEqual({ status: "published", visibility: "public", event_type: "competition", studio_id: fixture.studioId });
    evidence({ stage: 1, event, program: { id: program.id, status: program.status, registration_status: program.registration_status } });

    // The public event page now offers competition entry.
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(`/events/${event.slug}`);
    await expect(visitor.getByRole("link", { name: "Open Competition Registration" })).toBeVisible();
    await visitor.context().close();
    await page.context().close();
  });

  // ---------------------------------------------------------------- Stage 2

  test("stage 2: three dancer accounts and one guest register on the public page and pay with a test card; the webhook settles", async ({ browser }) => {
    const partners = [["Drew", "Partner"], ["Emery", "Partner"], ["Finley", "Partner"]];
    for (const [index, dancer] of fixture.dancers.entries()) {
      registrations.push({
        who: `dancer${index + 1}`, email: dancer.email, account: dancer,
        // Every dancer links themselves ("this is me"); the first leads, the others follow.
        couple: index === 0
          ? { leader: { firstName: dancer.firstName, lastName: dancer.lastName, isSelf: true }, follower: { firstName: partners[index][0], lastName: partners[index][1] } }
          : { leader: { firstName: partners[index][0], lastName: partners[index][1] }, follower: { firstName: dancer.firstName, lastName: dancer.lastName, isSelf: true } },
      });
    }
    registrations.push({
      who: "guest", email: fixture.guest.email,
      couple: { leader: { firstName: fixture.guest.firstName, lastName: fixture.guest.lastName }, follower: { firstName: "Harper", lastName: "Partner" } },
    });

    for (const registration of registrations) {
      const page = await (await browser.newContext()).newPage();
      await assignUniqueSourceIp(page);
      // "This is me" needs a verified, password-bound email: the dancer proves the mailbox, sets a password, and is
      // signed in on a fresh session (LAUNCH-SEC-1C).
      if (registration.account) await verifyEmailAndBindPassword(page, registration.account);
      const contactName = registration.account
        ? `${fixture.dancers.find((d) => d.id === registration.account!.id)!.firstName} ${fixture.dancers.find((d) => d.id === registration.account!.id)!.lastName}`
        : `${fixture.guest.firstName} ${fixture.guest.lastName}`;
      const checkoutUrl = await registerCouple(page, event.slug, { name: contactName, email: registration.email, phone: "5125550100" }, registration.couple);
      const sessionId = checkoutUrl.match(/cs_test_[A-Za-z0-9]+/)?.[0];
      expect(sessionId, "hosted Checkout URL carries a test session").toBeTruthy();
      const open = await stripe.checkout.sessions.retrieve(sessionId!, {}, { stripeAccount: ACCOUNT });
      expect([open.livemode, open.status, open.payment_status, open.amount_total]).toEqual([false, "open", "unpaid", ENTRY_FEE * 100]);

      const paid = await payCheckoutSession(stripe, ACCOUNT, sessionId!);
      expect([paid.status, paid.payment_status]).toEqual(["complete", "paid"]);

      // The verified webhook (not the returning browser) settles the order; the status page says so.
      await expect.poll(async () => {
        const state = await readCompetitionRegistrations(config, event.id);
        return state.orders.find((order) => order.stripe_checkout_session_id === sessionId)?.payment_status;
      }, { timeout: 90_000, intervals: [1_000] }).toBe("paid");
      await page.goto(paid.success_url!);
      await expect(page.getByText("Registration confirmed")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Confirmed", { exact: true }).first()).toBeVisible();
      await page.context().close();
    }

    const state = await readCompetitionRegistrations(config, event.id);
    expect(state.orders).toHaveLength(registrations.length);
    for (const order of state.orders) expect(order).toMatchObject({ status: expect.stringMatching(/^(paid|confirmed|completed)$/), payment_status: "paid" });
    expect(state.payments.filter((payment) => payment.status === "paid")).toHaveLength(registrations.length);
    expect(state.payments.every((payment) => Number(payment.amount) === ENTRY_FEE && payment.stripe_account_id === ACCOUNT)).toBe(true);
    expect(state.entries).toHaveLength(registrations.length);
    expect(state.entries.every((entry) => entry.status === "confirmed")).toBe(true);
    // "This is me" linked each dancer's competitor record to their own account; the guest's competitors have none.
    const linked = state.competitors.filter((competitor) => competitor.user_id).map((competitor) => competitor.user_id).sort();
    expect(linked).toEqual(fixture.dancers.map((dancer) => dancer.id).sort());
    evidence({ stage: 2, orders: state.orders.map((o) => ({ status: o.status, payment_status: o.payment_status, total: o.total_amount })), entries: state.entries.length, linkedCompetitors: linked.length });
  });

  // ---------------------------------------------------------------- Stage 3 (R2 refunds, SC1 scratch) on a second, priced event

  test.fixme("stage 3: an entry is CHANGED through the UI", async () => {
    // TODO(entry change UI): there is no screen that edits an entry after payment. The per-entry refund scenarios
    // (3a-3e) below are live; changing an entry stays pending.
  });

  test("stage 3 setup: a second competition with a fee line and a discount; one buyer pays for two entries in one order", async ({ browser }) => {
    const owner = await as(browser, fixture.owner);
    refundEvent = await createPricedCompetition(owner, config, { name: `E2E Refund Classic ${fixture.runId}`, startDate: "2027-05-15", entryFee: ENTRY_FEE });
    // PRODUCT GAP: no organizer UI creates fee/discount rules (only the WSDC surcharge has one), so they are seeded.
    await seedPricingRules(config, refundEvent.id, { feePerEntry: 5, discountPercent: 10 });
    await openRegistration(owner);
    await owner.context().close();

    const buyerEmail = `e2e-compfull-${fixture.runId}-buyer2@example.com`;
    const couples: Couple[] = [
      { leader: { firstName: "Ines", lastName: "Alder" }, follower: { firstName: "Jonas", lastName: "Birch" } },
      { leader: { firstName: "Kira", lastName: "Cedar" }, follower: { firstName: "Lars", lastName: "Dune" } },
    ];
    const page = await (await browser.newContext()).newPage();
    await assignUniqueSourceIp(page);
    const checkoutUrl = await registerCouples(page, refundEvent.slug, { name: "Bea Buyer", email: buyerEmail, phone: "5125550101" }, couples);
    const sessionId = checkoutUrl.match(/cs_test_[A-Za-z0-9]+/)?.[0];
    expect(sessionId, "hosted Checkout URL carries a test session").toBeTruthy();
    const open = await stripe.checkout.sessions.retrieve(sessionId!, {}, { stripeAccount: ACCOUNT });
    // 2 entries x $40 + 2 x $5 processing fee = $90; the 10% discount applies to the $80 of entries (fee lines are not discounted) = $8, so $82.
    expect([open.livemode, open.status, open.amount_total]).toEqual([false, "open", 8200]);
    const paid = await payCheckoutSession(stripe, ACCOUNT, sessionId!);
    expect([paid.status, paid.payment_status]).toEqual(["complete", "paid"]);
    await expect.poll(async () => (await readCompetitionRegistrations(config, refundEvent.id)).orders[0]?.payment_status, { timeout: 90_000, intervals: [1_000] }).toBe("paid");
    await page.goto(paid.success_url!);
    await expect(page.getByText("Registration confirmed")).toBeVisible({ timeout: 30_000 });
    await page.context().close();

    const state = await readCompetitionRegistrations(config, refundEvent.id);
    expect(state.orders).toHaveLength(1);
    const orderId = state.orders[0].id as string;
    const money = await readOrderMoney(config, refundEvent.id, orderId);
    expect(Number(money.order.total_amount)).toBe(82);
    expect(Number(money.order.discount_amount)).toBe(8);
    expect(money.entries).toHaveLength(2);
    expect(money.entries.every((entry) => entry.status === "confirmed")).toBe(true);
    expect(money.items.filter((item) => item.item_type === "competition_entry")).toHaveLength(2);
    const paymentIntent = String(money.payments[0]?.stripe_payment_intent_id ?? paid.payment_intent);
    expect(paymentIntent).toMatch(/^pi_/);
    refundOrder = { id: orderId, paymentIntent, couples, buyerEmail };
    evidence({ stage: "3 setup", total: money.order.total_amount, discount: money.order.discount_amount, items: money.items.map((i) => [i.item_type, i.description, i.total_price]) });
  });

  test("stage 3b: a discounted line refunds at most its net cap (cap + 0.01 is refused, nothing written); fee lines are separate lines", async ({ browser }) => {
    const { context, page } = await signedInContext(browser, fixture.owner);
    // Reach the refund page the way staff do: Registrations -> Refunds.
    await page.goto(`/app/events/${refundEvent.id}/competition/registrations`);
    await page.locator("section").filter({ hasText: refundOrder.buyerEmail }).getByRole("link", { name: "Refunds" }).click();
    await expect(page.getByRole("heading", { name: /^Refunds · / })).toBeVisible();
    const lines = await readRefundLines(page);
    const entryLines = lines.filter((line) => line.kind === "entry");
    const feeLines = lines.filter((line) => line.kind === "fee");
    expect(entryLines).toHaveLength(2);
    expect(feeLines).toHaveLength(1);
    // The 10% discount is spread over the lines: every entry's cap is below its $40 price, and caps add up to the order total.
    expect(entryLines.every((line) => line.capCents < ENTRY_FEE * 100 && line.capCents > 0)).toBe(true);
    expect(entryLines.reduce((sum, line) => sum + line.capCents, 0) + feeLines[0].capCents).toBe(8200);

    for (const line of [entryLines[0], feeLines[0]]) {
      await openRefundPage(page, refundEvent.id, refundOrder.id);
      await fillRefundForm(page, { amounts: { [line.itemId]: line.remainingCents + 1 }, scratch: entryLines.some((e) => e.itemId === line.itemId) ? { [line.itemId]: false } : {}, reason: "Q1 cap check" });
      await refundButton(page).click();
      await expect(page.locator("p[role=alert]")).toContainText("more than its remaining refundable amount", { timeout: 30_000 });
    }
    const after = await readOrderMoney(config, refundEvent.id, refundOrder.id);
    expect(after.refunds).toHaveLength(0);
    expect(after.allocations).toHaveLength(0);
    expect(after.refundAccounting).toHaveLength(0);
    expect(await stripeRefundsFor(stripe, ACCOUNT, refundOrder.paymentIntent)).toHaveLength(0);
    expect(after.entries.every((entry) => entry.status === "confirmed")).toBe(true);
    evidence({ stage: "3b", caps: lines.map((l) => [l.kind, l.label, l.capCents]) });
    await context.close();
  });

  test("stage 3a: partial per-entry refund of ONE of the two entries: order, ledger, dated refund entry and the Stripe refund agree; the other entry and the fee line are untouched", async ({ browser }) => {
    const { context, page } = await signedInContext(browser, fixture.owner);
    await openRefundPage(page, refundEvent.id, refundOrder.id);
    const lines = await readRefundLines(page);
    const target = lines.filter((line) => line.kind === "entry")[0];
    const other = lines.filter((line) => line.kind === "entry")[1];
    // Refund exactly the net cap of the first entry; the default "also scratch this entry" stays on.
    await fillRefundForm(page, { amounts: { [target.itemId]: target.remainingCents }, reason: "Q1 partial per-entry refund" });
    await refundButton(page).click();
    await expect(page.getByRole("status")).toContainText("Refund Succeeded", { timeout: 60_000 });

    await expect.poll(async () => (await readOrderMoney(config, refundEvent.id, refundOrder.id)).refunds.map((r) => r.status), { timeout: 60_000 }).toEqual(["succeeded"]);
    const money = await readOrderMoney(config, refundEvent.id, refundOrder.id);
    const [refund] = money.refunds;
    expect(refund).toMatchObject({ source: "staff", amount_cents: target.remainingCents, stripe_account_id: ACCOUNT, reason: "Q1 partial per-entry refund" });
    // Ledger: one allocation, on the refunded entry's line only; no fee line and no other entry.
    expect(money.allocations).toHaveLength(1);
    expect(money.allocations[0]).toMatchObject({ order_item_id: target.itemId, line_kind: "entry", amount_cents: target.remainingCents, withdraw_entry: true });
    // The order is partially refunded, and the payment row carries the refunded amount.
    expect(money.order.payment_status).toBe("partially_refunded");
    expect(Math.round(Number(money.payments[0].refund_amount) * 100)).toBe(target.remainingCents);
    // Entries: the refunded one is scratched, the other is still confirmed.
    const byItem = new Map(money.entries.map((entry) => [entry.order_item_id as string, entry.status]));
    expect(["withdrawn", "scratched"]).toContain(byItem.get(target.itemId));
    expect(byItem.get(other.itemId)).toBe("confirmed");
    // Accounting: one dated competition_entry_refund entry (dated when the refund succeeded), not a void of the revenue.
    expect(money.refundAccounting).toHaveLength(1);
    const [entry] = money.refundAccounting;
    expect(Math.round(Number(entry.refund_amount ?? entry.gross_amount) * 100)).toBe(target.remainingCents);
    expect(String(entry.entry_date)).toBe(String(refund.succeeded_at).slice(0, 10));
    expect(entry.entry_status).not.toBe("voided");
    // Stripe holds exactly this one refund, for exactly this amount.
    const stripeRefunds = await stripeRefundsFor(stripe, ACCOUNT, refundOrder.paymentIntent);
    expect(stripeRefunds.map((r) => [r.amount, r.status])).toEqual([[target.remainingCents, "succeeded"]]);
    expect(stripeRefunds[0].id).toBe(refund.stripe_refund_id);
    evidence({ stage: "3a", refund: { amount: refund.amount_cents, status: refund.status }, accounting: { date: entry.entry_date, category: entry.category }, order: money.order.payment_status });
    await context.close();
  });

  test("stage 3c: the refund form submitted twice with the same request id produces ONE Stripe refund (idempotency); only the selected fee line is refunded", async ({ browser }) => {
    const { context, page } = await signedInContext(browser, fixture.owner);
    await openRefundPage(page, refundEvent.id, refundOrder.id);
    const lines = await readRefundLines(page);
    const fee = lines.find((line) => line.kind === "fee")!;
    expect(fee.remainingCents).toBe(fee.capCents); // untouched by the entry refund
    await fillRefundForm(page, { amounts: { [fee.itemId]: fee.remainingCents }, reason: "Q1 double submit" });
    // Two submissions of the SAME rendered form (same hidden request id), back to back: a double click / a retry.
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>("form:has(textarea#reason)")!;
      form.requestSubmit();
      form.requestSubmit();
    });
    await expect(page.getByRole("heading", { name: /^Refunds · / })).toBeVisible();
    await expect.poll(async () => (await readOrderMoney(config, refundEvent.id, refundOrder.id)).refunds.filter((r) => r.status === "succeeded").length, { timeout: 60_000 }).toBe(2);
    // Let a duplicate attempt, if any, land before counting.
    await page.waitForTimeout(3_000);
    const money = await readOrderMoney(config, refundEvent.id, refundOrder.id);
    expect(money.refunds).toHaveLength(2);
    const feeRefund = money.refunds.find((r) => r.reason === "Q1 double submit")!;
    expect(feeRefund.amount_cents).toBe(fee.remainingCents);
    const feeAllocations = money.allocations.filter((a) => a.refund_id === feeRefund.id);
    expect(feeAllocations).toHaveLength(1);
    expect(feeAllocations[0]).toMatchObject({ order_item_id: fee.itemId, line_kind: "fee", amount_cents: fee.remainingCents, withdraw_entry: false });
    const stripeRefunds = await stripeRefundsFor(stripe, ACCOUNT, refundOrder.paymentIntent);
    expect(stripeRefunds).toHaveLength(2);
    expect(stripeRefunds.filter((r) => r.amount === fee.remainingCents)).toHaveLength(1);
    // The second entry is still confirmed and unrefunded; two dated refund entries now exist.
    expect(money.entries.filter((e) => e.status === "confirmed")).toHaveLength(1);
    expect(money.refundAccounting).toHaveLength(2);
    expect(money.order.payment_status).toBe("partially_refunded");
    evidence({ stage: "3c", stripeRefunds: stripeRefunds.map((r) => [r.id, r.amount]), ledger: money.refunds.length });
    await context.close();
  });

  // ---------------------------------------------------------------- Stage 4

  test("stage 4: check-in issues bibs; the running order is built and the schedule published", async ({ browser }) => {
    const page = await as(browser, fixture.owner);
    const before = await readCompetitionRegistrations(config, event.id);

    // Entries: staff confirm each entry's eligibility (check-in requires eligible or waived entries).
    await page.goto(`/app/events/${event.id}/competition/registrations`);
    const eligibilityForms = page.locator('form:has(select[name="eligibilityStatus"])');
    await expect(eligibilityForms).toHaveCount(registrations.length);
    for (let index = 0; index < registrations.length; index += 1) {
      const form = eligibilityForms.nth(index);
      await form.locator("select").selectOption("eligible");
      await form.getByRole("button", { name: "Save" }).click();
      await expect(form.locator("select")).toHaveValue("eligible", { timeout: 30_000 });
    }
    await expect.poll(async () => (await readCompetitionRegistrations(config, event.id)).entries.every((entry) => entry.eligibility_status === "eligible"), { timeout: 30_000 }).toBe(true);

    let bib = 101;
    for (const registration of registrations) {
      const cart = before.carts.find((item) => String(item.buyer_email).toLowerCase() === registration.email.toLowerCase())!;
      await page.goto(`/app/events/${event.id}/competition/checkin`);
      await expect(page.getByRole("heading", { name: "Competition Check-In" })).toBeVisible();
      const row = page.locator("div.divide-y > div").filter({ hasText: registration.email });
      await Promise.all([
        page.waitForURL((url) => /\/competition\/checkin\/[0-9a-f-]{36}$/.test(url.pathname), { timeout: 60_000 }),
        row.getByRole("button", { name: "Start check-in" }).click(),
      ]);
      expect(cart.order_id).toBeTruthy();

      // Every participant arrives.
      const participants = page.locator("section").filter({ has: page.getByRole("heading", { name: "Participants and waivers" }) });
      for (const name of [registration.couple.leader, registration.couple.follower].map((p) => `${p.firstName} ${p.lastName}`)) {
        const block = participants.locator("div.border-t").filter({ has: page.getByRole("heading", { name, exact: true }) });
        await block.locator('select[name="presenceStatus"]').selectOption("present");
        await block.getByRole("button", { name: "Save" }).click();
        await expect(block.locator('select[name="presenceStatus"]')).toHaveValue("present", { timeout: 30_000 });
      }
      // The entry is verified at the desk.
      const verification = page.locator("section").filter({ has: page.getByRole("heading", { name: "Entry verification" }) });
      await verification.locator('select[name="verificationStatus"]').selectOption("verified");
      await verification.getByRole("button", { name: "Save" }).click();
      await expect(verification.locator('select[name="verificationStatus"]')).toHaveValue("verified", { timeout: 30_000 });
      // Bibs: one competitor number per number holder.
      const numbers = page.locator("section").filter({ has: page.getByRole("heading", { name: "Competitor numbers" }) });
      while (await numbers.getByRole("button", { name: "Issue" }).count()) {
        const form = numbers.locator("form").first();
        await form.getByPlaceholder("Number").fill(String(bib));
        await form.getByRole("button", { name: "Issue" }).click();
        await expect(numbers.getByText(`#${bib} · Issued`)).toBeVisible({ timeout: 30_000 });
        bib += 1;
      }
      await expect(page.getByRole("button", { name: "Complete check-in" })).toBeEnabled({ timeout: 30_000 });
      await page.getByRole("button", { name: "Complete check-in" }).click();
      await expect(page.getByText("Check-in complete")).toBeVisible({ timeout: 30_000 });
    }

    const admin = e2eAdminClient(config);
    const { data: sessions } = await admin.from("event_competition_checkin_sessions").select("status, payment_status, credential_status").eq("event_id", event.id);
    expect(sessions).toHaveLength(registrations.length);
    expect(sessions!.every((s) => s.status === "complete" && s.payment_status === "complete" && s.credential_status !== "missing")).toBe(true);
    const { data: credentials } = await admin.from("event_competition_credentials").select("credential_number, status").eq("event_id", event.id).neq("status", "void");
    const bibs = (credentials ?? []).map((c) => c.credential_number);
    expect(bibs.length).toBeGreaterThanOrEqual(registrations.length);
    expect(new Set(bibs).size).toBe(bibs.length);

    // Running order: generate heats from the confirmed entries, then publish.
    await page.goto(`/app/events/${event.id}/competition/schedule`);
    await expect(page.getByRole("heading", { name: "Schedule & Heats" })).toBeVisible();
    await page.getByRole("button", { name: "Generate heats" }).click();
    await expect(page.getByRole("status")).toContainText(/Created \d+ heats? for 4 entries/, { timeout: 60_000 });
    await expect(page.getByRole("list", { name: "Running order" })).toBeVisible();
    await page.getByRole("button", { name: "Publish running order" }).click();
    await expect(page.getByRole("status")).toContainText("Running order published.", { timeout: 60_000 });
    await expect(page.getByText(/^Published · \d+ heats · 4 entries on the floor$/)).toBeVisible();

    const { data: versions } = await admin.from("event_competition_schedule_versions").select("status, published_at").eq("event_id", event.id);
    expect(versions?.filter((v) => ["published", "live"].includes(v.status))).toHaveLength(1);
    evidence({ stage: 4, sessions: sessions!.length, bibs, versions });
    await page.context().close();
  });

  // ---------------------------------------------------------------- Stage 4b: duplicate / concurrent check-in (CI-B)

  test("stage 4b: two desks start the same batch at once: one session; both mark the same participant present at once: one checked_in_by, first stamp kept", async ({ browser }) => {
    const desks = [await signedInContext(browser, fixture.owner), await signedInContext(browser, fixture.deskAdmin)];
    const row = (page: Page) => page.locator("div.divide-y > div").filter({ hasText: refundOrder.buyerEmail });
    for (const { page } of desks) {
      await page.goto(`/app/events/${refundEvent.id}/competition/checkin`);
      await expect(row(page).getByRole("button", { name: "Start check-in" })).toBeVisible();
    }
    // Both desks press "Start check-in" for the same registration together.
    await Promise.all(desks.map(({ page }) => Promise.all([
      page.waitForURL((url) => /\/competition\/checkin\/[0-9a-f-]{36}$/.test(url.pathname), { timeout: 60_000 }),
      row(page).getByRole("button", { name: "Start check-in" }).click(),
    ])));
    const urls = desks.map(({ page }) => page.url());
    const sessions = (await readCheckin(config, refundEvent.id)).sessions.filter((session) => session.order_id === refundOrder.id);
    expect(sessions).toHaveLength(1);
    expect(urls.every((url) => url.endsWith(`/${sessions[0].id}`)), "both desks land on the one session").toBe(true);

    // Both desks mark the same participant present together.
    const leader = refundOrder.couples[0].leader;
    const name = `${leader.firstName} ${leader.lastName}`;
    const mark = async (page: Page) => {
      const block = page.locator("section").filter({ has: page.getByRole("heading", { name: "Participants and waivers" }) }).locator("div.border-t").filter({ has: page.getByRole("heading", { name, exact: true }) });
      await block.locator('select[name="presenceStatus"]').selectOption("present");
      return block;
    };
    const blocks = await Promise.all(desks.map(({ page }) => mark(page)));
    await Promise.all(blocks.map((block) => block.getByRole("button", { name: "Save" }).click()));
    await expect.poll(async () => (await readCheckin(config, refundEvent.id)).participants.find((p) => p.display_name === name)?.presence_status, { timeout: 30_000 }).toBe("present");
    await desks[0].page.waitForTimeout(2_000);
    const first = (await readCheckin(config, refundEvent.id)).participants.filter((p) => p.display_name === name);
    expect(first).toHaveLength(1);
    expect([fixture.owner.id, fixture.deskAdmin.id]).toContain(first[0].checked_in_by);
    expect(first[0].checked_in_at).toBeTruthy();

    // A repeat mark from the OTHER desk (a stale page, a double tap) changes neither the stamp nor the actor.
    const winner = first[0].checked_in_by === fixture.owner.id ? 0 : 1;
    const repeat = desks[1 - winner].page;
    await repeat.goto(desks[1 - winner].page.url());
    const block = await mark(repeat);
    await block.getByRole("button", { name: "Save" }).click();
    await repeat.waitForTimeout(2_000);
    const second = (await readCheckin(config, refundEvent.id)).participants.find((p) => p.display_name === name)!;
    expect([second.checked_in_by, second.checked_in_at]).toEqual([first[0].checked_in_by, first[0].checked_in_at]);
    // The other participants of the batch were not touched.
    const others = (await readCheckin(config, refundEvent.id)).participants.filter((p) => p.display_name !== name);
    expect(others.every((p) => p.presence_status !== "present")).toBe(true);
    evidence({ stage: "4b", sessions: sessions.length, checkedInBy: first[0].checked_in_by === fixture.owner.id ? "owner" : "deskAdmin", stampKept: true });
    for (const { context } of desks) await context.close();
  });

  test("stage 4b (ticket scan): the same attendee ticket scanned by two desks at once admits once, if competition registrations carry ticket codes", async ({ browser }) => {
    const admin = e2eAdminClient(config);
    const { data: registrationsForOrder } = await admin.from("event_registrations").select("id").eq("order_id", refundOrder.id);
    const { data: attendees } = await admin.from("event_registration_attendees").select("id, ticket_code, checked_in_at").in("registration_id", (registrationsForOrder ?? []).map((r) => r.id as string));
    const codes = (attendees ?? []).filter((a) => a.ticket_code);
    evidence({ stage: "4b scan probe", attendees: attendees?.length ?? 0, withTicketCode: codes.length });
    test.skip(codes.length === 0, "Not applicable: competition registrations issue no attendee ticket codes, so the #295 scan path has nothing to scan.");
    const code = codes[0].ticket_code as string;
    const desks = [await signedInContext(browser, fixture.owner), await signedInContext(browser, fixture.deskAdmin)];
    for (const { page } of desks) await page.goto(`/app/events/${refundEvent.id}/check-in`);
    const scans = await Promise.all(desks.map(async ({ page }) => {
      await page.locator('input[name="ticketCode"]').fill(code);
      await Promise.all([page.waitForURL(/(success|warning|error)=/, { timeout: 60_000 }), page.locator('form:has(input[name="ticketCode"]) button').first().click()]);
      return new URL(page.url()).search;
    }));
    evidence({ stage: "4b scan", results: scans });
    expect(scans.filter((search) => search.includes("success=checked_in")).length).toBeLessThanOrEqual(1);
    const { data: after } = await admin.from("event_registration_attendees").select("id, checked_in_at").eq("ticket_code", code);
    expect(after).toHaveLength(1);
    for (const { context } of desks) await context.close();
  });

  test("stage 3a (desk): after the partial refund the check-in desk shows no balance due", async ({ browser }) => {
    test.skip(process.env.E2E_DESK_BALANCE_FIX !== "true", "BLOCKED on W2 (competition-cib-desk-balance): the desk subtracts refund_amount from the paid total, so a partially refunded order shows a balance due.");
    const { context, page } = await signedInContext(browser, fixture.owner);
    const session = (await readCheckin(config, refundEvent.id)).sessions.find((s) => s.order_id === refundOrder.id)!;
    await page.goto(`/app/events/${refundEvent.id}/competition/checkin/${session.id}`);
    // Any desk action recalculates the session; re-save the verification so the balance is recomputed now.
    const presence = page.locator('select[name="presenceStatus"]').first();
    await presence.selectOption({ index: 1 }).catch(() => undefined);
    const fresh = (await readCheckin(config, refundEvent.id)).sessions.find((s) => s.order_id === refundOrder.id)!;
    evidence({ stage: "3a desk", payment_status: fresh.payment_status, balance_due: fresh.balance_due });
    expect(fresh.payment_status).toBe("complete");
    expect(Number(fresh.balance_due)).toBe(0);
    await expect(page.getByText("Balance Due", { exact: true })).toHaveCount(0);
    await context.close();
  });

  test.fixme("stage 4: a duplicate check-in is rejected for a scanned QR/ticket code on the COMPETITION check-in screen", async () => {
    // Competition check-in has no scan input (it works on registration batches, not ticket codes). The compare-and-set and
    // batch behaviour is covered by the stage 4b tests above; a competition scan screen is a product decision, not a test gap.
  });

  // ---------------------------------------------------------------- Stage 3d / 3e: scratch and refund are separate actions (SC1 + R2)

  test("stage 3d: a normal scratch in an open heat moves no money: banner 'No payment was changed', no payment or refund rows, one audit row", async ({ browser }) => {
    const { context, page } = await signedInContext(browser, fixture.owner);
    const guest = registrations.find((r) => r.who === "guest")!;
    const state = await readCompetitionRegistrations(config, event.id);
    const cart = state.carts.find((c) => String(c.buyer_email).toLowerCase() === guest.email.toLowerCase())!;
    const entry = state.entries.find((e) => e.registration_cart_id === cart.id)!;
    scratchTarget = { orderId: cart.order_id as string, entryId: entry.id as string, name: `${guest.couple.leader.firstName} ${guest.couple.leader.lastName}` };

    const admin = e2eAdminClient(config);
    const before = await readOrderMoney(config, event.id, scratchTarget.orderId);
    const { data: placementBefore } = await admin.from("event_competition_heat_entries").select("status, event_competition_heats(lock_state, status)").eq("entry_id", scratchTarget.entryId);
    expect(placementBefore).toHaveLength(1);
    expect((placementBefore![0] as unknown as { event_competition_heats: { lock_state: string } }).event_competition_heats.lock_state).toBe("open");

    await page.goto(`/app/events/${event.id}/competition/registrations`);
    await page.locator("div.py-5.grid").filter({ hasText: scratchTarget.name }).getByRole("link", { name: "Scratch", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Scratch entry" })).toBeVisible();
    await page.getByRole("button", { name: "Scratch entry" }).click();
    await expect(page.getByRole("status")).toContainText("No payment was changed", { timeout: 30_000 });

    const after = await readOrderMoney(config, event.id, scratchTarget.orderId);
    expect(after.entries.find((e) => e.id === scratchTarget.entryId)?.status).toMatch(/^(scratched|withdrawn)$/);
    expect(after.refunds).toHaveLength(0);
    expect(after.allocations).toHaveLength(0);
    expect(after.refundAccounting).toHaveLength(0);
    expect(after.order).toEqual(before.order);
    expect(after.payments).toEqual(before.payments);
    expect(await stripeRefundsFor(stripe, ACCOUNT, String(before.payments[0].stripe_payment_intent_id))).toHaveLength(0);
    const { data: placementAfter } = await admin.from("event_competition_heat_entries").select("status, event_competition_heats(lock_state)").eq("entry_id", scratchTarget.entryId);
    expect(placementAfter!.map((p) => p.status)).toEqual(["scratched"]);
    expect((placementAfter![0] as unknown as { event_competition_heats: { lock_state: string } }).event_competition_heats.lock_state).toBe("open");
    const scratches = (await readScratches(config, event.id)).filter((s) => s.entry_id === scratchTarget.entryId);
    expect(scratches).toHaveLength(1);
    expect(scratches[0]).toMatchObject({ path: "normal", is_exception: false, performed_by: fixture.owner.id });
    evidence({ stage: "3d", scratchRows: scratches.length, refundRows: after.refunds.length });
    await context.close();
  });

  test.fixme("stage 3d (official): an official scratch in a locked, not-yet-danced heat needs a reason, leaves the heat locked and writes one audit row; a danced heat refuses the scratch", async () => {
    // BLOCKED (O1 day-of run console): no screen locks a heat or marks one danced, so there is no UI path to a locked or
    // danced heat, and the scenario may not edit rows to get there. SC1's own walkthrough (PR 306, F3/F4/F8) seeds those
    // heats directly. Re-enable when O1 lands.
  });

  test("stage 3e: scratch and refund are separate actions: refunding the already-scratched entry goes through the R2 page, and the scratch page offers no refund", async ({ browser }) => {
    const { context, page } = await signedInContext(browser, fixture.owner);
    // The scratch page of an already-scratched entry is read-only and has nothing that moves money.
    await page.goto(`/app/events/${event.id}/competition/registrations/scratch/${scratchTarget.entryId}`);
    await expect(page.getByText("This entry is already scratched.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Scratch entry" })).toHaveCount(0);
    await expect(page.getByRole("radio", { name: /refund/i })).toHaveCount(0);

    await openRefundPage(page, event.id, scratchTarget.orderId);
    const [line] = await readRefundLines(page);
    expect(line.kind).toBe("entry");
    // The scratch checkbox on this line is disabled and unchecked ("Already scratched"); the refund still works.
    await expect(page.locator(`input[name="withdraw_${line.itemId}"]`)).toBeDisabled();
    await expect(page.getByText("Already scratched")).toBeVisible();
    await fillRefundForm(page, { amounts: { [line.itemId]: line.remainingCents }, reason: "Q1 refund of a scratched entry" });
    await refundButton(page).click();
    await expect(page.getByRole("status")).toContainText("Refund Succeeded", { timeout: 60_000 });

    const money = await readOrderMoney(config, event.id, scratchTarget.orderId);
    expect(money.refunds.map((r) => [r.status, r.amount_cents])).toEqual([["succeeded", line.remainingCents]]);
    expect(money.allocations).toHaveLength(1);
    expect(money.allocations[0]).toMatchObject({ order_item_id: line.itemId, amount_cents: line.remainingCents, withdraw_entry: false });
    expect(money.order.payment_status).toBe("refunded");
    expect(money.entries.find((e) => e.id === scratchTarget.entryId)?.status).toMatch(/^(scratched|withdrawn)$/);
    expect(money.refundAccounting).toHaveLength(1);
    // Refunding added no scratch audit row: one scratch (3d), one refund (here), two separate records.
    expect((await readScratches(config, event.id)).filter((s) => s.entry_id === scratchTarget.entryId)).toHaveLength(1);
    expect(await stripeRefundsFor(stripe, ACCOUNT, String(money.payments[0].stripe_payment_intent_id))).toHaveLength(1);
    evidence({ stage: "3e", refund: money.refunds[0].amount_cents, order: money.order.payment_status });
    await context.close();
  });

  // ---------------------------------------------------------------- Tenant isolation

  test("tenant isolation: another studio's owner gets a 404 on the refund and scratch pages and nothing is written", async ({ browser }) => {
    const { context, page } = await signedInContext(browser, fixture.otherOwner);
    const before = await readOrderMoney(config, refundEvent.id, refundOrder.id);
    const scratchesBefore = (await readScratches(config, refundEvent.id)).length + (await readScratches(config, event.id)).length;
    const targets = [
      `/app/events/${refundEvent.id}/competition/registrations/${refundOrder.id}/refund`,
      `/app/events/${event.id}/competition/registrations/${scratchTarget.orderId}/refund`,
      `/app/events/${event.id}/competition/registrations/scratch/${scratchTarget.entryId}`,
      `/app/events/${refundEvent.id}/competition/registrations/scratch/${before.entries[1].id as string}`,
    ];
    for (const path of targets) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }
    const after = await readOrderMoney(config, refundEvent.id, refundOrder.id);
    expect(after.refunds).toEqual(before.refunds);
    expect(after.allocations).toEqual(before.allocations);
    expect((await readScratches(config, refundEvent.id)).length + (await readScratches(config, event.id)).length).toBe(scratchesBefore);
    await context.close();
  });

  // ---------------------------------------------------------------- Stages 5-10 (pending slices)

  test.fixme("stage 5: day-of: heats are run, one scratch is recorded", async () => {
    // TODO(O1 day-of run console): mark heats run/danced and record one scratch through the UI.
  });

  test.fixme("stage 6: three judges log in and submit ballots; one paper ballot is entered by the scorer; one ballot correction is versioned with a reason", async () => {
    // TODO(E1 officials + E2 ballots): fixture.judges are seeded; assign them to the panel, then submit ballots.
  });

  test.fixme("stage 7: a prelim with recall advances the correct entries into a generated final; placements and a tie resolve per the approved spec", async () => {
    // TODO(F1 engines + F2 results/round progression).
  });

  test.fixme("stage 8: a second staff member approves; before approval no public, dancer or other-tenant user can see any result", async () => {
    // TODO(F2 approval + F3 reader RLS): assert draft results are hidden from anon, dancers and other tenants.
  });

  test.fixme("stage 9: publish; the dancer sees only their own entries and the published placements, the public results page shows the published version, another studio and event see nothing; a correction republishes as v2 with an audit trail", async () => {
    // TODO(F3 publication + portals).
  });

  test.fixme("stage 10: closeout: exports downloaded, settlement reconciled (entry revenue minus refunds), program marked complete, event deletion blocked", async () => {
    // TODO(C1 closeout + exports).
  });
});

import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import Stripe from "stripe";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "../helpers/competitionFixture";
import { cleanupStripeTestModeFixture, createStripeTestModeFixture, type StripeTestModeFixture } from "../helpers/stripeTestModeFixture";
import { signIn } from "../helpers/competitionWizard";

/**
 * PAY-WH-1A M-2 -- box-office (card reader) ticket sales against REAL Stripe test mode: a Stripe Terminal SIMULATED
 * reader on the test connected account (test-mode objects only; no live configuration), the real box-office UI, the
 * real terminal routes and the signed webhook.
 *
 * Proves: a card-reader sale reserves its ticket before any charge; a sold-out sale is refused before the reader is
 * started; a successful charge confirms the ticket (and writes its payment row); a charge that can no longer be
 * fulfilled is NOT treated as fulfilment -- it fails visibly, records a captured-payment exception and alerts staff;
 * a cancelled reader payment releases the hold. Competing sales that the box-office UI itself would block are created
 * directly in the database and labelled as set-up (they stand in for a concurrent sale on another device / online).
 */

test.describe.configure({ mode: "serial", timeout: 300_000 });

const TEST_KEY = process.env.E2E_STRIPE_TEST_SECRET_KEY ?? "";
const ACCOUNT = process.env.E2E_STRIPE_TEST_CONNECTED_ACCOUNT ?? "";
const CRON_SECRET = process.env.E2E_CRON_SECRET ?? "";

test.describe("PAY-WH-1A box-office card-reader capacity (real Stripe test mode, simulated reader)", () => {
  test.skip(!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(TEST_KEY) || !/^acct_[A-Za-z0-9]+$/.test(ACCOUNT) || !CRON_SECRET, "Stripe TEST key, test connected account and local cron secret not provided");
  let config: E2EConfig;
  let fixture: StripeTestModeFixture;
  let stripe: Stripe;
  let stripeReaderId = "";
  let stripeLocationId = "";
  let readerRowId = "";
  const onAccount = { stripeAccount: ACCOUNT };
  const tickets = { success: randomUUID(), unfulfilled: randomUUID(), refused: randomUUID(), cancelled: randomUUID() };

  const admin = () => e2eAdminClient(config);

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl)) throw new Error("refusing: not the local QA Supabase");
    stripe = new Stripe(TEST_KEY);
    if ((await stripe.balance.retrieve()).livemode) throw new Error("refusing: Stripe key is live");
    fixture = await createStripeTestModeFixture(config, { connectedAccountId: ACCOUNT });
    const eventId = fixture.events.orgEarly.id;
    const ticket = (id: string, name: string) => ({
      id, event_id: eventId, name, ticket_kind: "general_admission", price: 20, currency: "USD", capacity: 1, active: true, sort_order: 10, attendees_per_ticket: 1,
    });
    await admin().from("event_ticket_types").insert([
      ticket(tickets.success, "Box Success"), ticket(tickets.unfulfilled, "Box Unfulfilled"),
      ticket(tickets.refused, "Box Refused"), ticket(tickets.cancelled, "Box Cancelled"),
    ]).throwOnError();
    const location = await stripe.terminal.locations.create({
      display_name: `E2E Box Office ${fixture.runId}`,
      address: { line1: "1 E2E Street", city: "Austin", state: "TX", postal_code: "78701", country: "US" },
    }, onAccount);
    stripeLocationId = location.id;
    const reader = await stripe.terminal.readers.create({ registration_code: "simulated-wpe", location: location.id, label: `E2E Sim ${fixture.runId}` }, onAccount);
    stripeReaderId = reader.id;
    const { data: locationRow } = await admin().from("stripe_terminal_locations").insert({
      studio_id: fixture.studioId, stripe_account_id: ACCOUNT, stripe_location_id: location.id, display_name: location.display_name, active: true,
    }).select("id").single().throwOnError();
    const { data: readerRow } = await admin().from("stripe_terminal_readers").insert({
      studio_id: fixture.studioId, terminal_location_id: locationRow!.id, stripe_account_id: ACCOUNT, stripe_reader_id: reader.id,
      stripe_location_id: location.id, label: "E2E Simulated Reader", device_type: reader.device_type, status: "online", active: true,
    }).select("id").single().throwOnError();
    readerRowId = readerRow!.id;
  });

  test.afterAll(async () => {
    if (!fixture) return;
    if (stripeReaderId) await stripe.terminal.readers.del(stripeReaderId, {}, onAccount).catch(() => null);
    if (stripeLocationId) await stripe.terminal.locations.del(stripeLocationId, {}, onAccount).catch(() => null);
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    const db = admin();
    await db.from("terminal_payment_sessions").delete().eq("studio_id", fixture.studioId);
    await db.from("payments").delete().eq("studio_id", fixture.studioId);
    await db.from("stripe_terminal_readers").delete().eq("studio_id", fixture.studioId);
    await db.from("stripe_terminal_locations").delete().eq("studio_id", fixture.studioId);
    await db.from("attendance_records").delete().eq("studio_id", fixture.studioId);
    await cleanupStripeTestModeFixture(config, fixture);
  });

  async function runCron() {
    const response = await fetch(`${config.baseUrl}/api/cron/event-cart-orders`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(response.status).toBe(200);
  }

  async function sellCardReader(page: Page, ticketId: string, tag: string) {
    await page.goto("/app/events/sell-tickets");
    await page.locator("#eventIdVisible").selectOption(fixture.events.orgEarly.id);
    await page.locator("#ticketTypeIdVisible").selectOption(ticketId);
    await page.locator("#paymentMethodVisible").selectOption("card_reader");
    await page.locator("#attendeeFirstName_1").fill("Box");
    await page.locator("#attendeeLastName_1").fill(tag);
    await page.locator("#attendeeEmail_1").fill(`e2e-box-${fixture.runId}-${tag}@example.com`);
    await page.getByRole("button", { name: "Continue to Card Reader" }).click();
    await page.waitForURL(/\/app\/payments\/terminal\/[0-9a-f-]{36}/, { timeout: 60_000 });
    const paymentId = page.url().match(/terminal\/([0-9a-f-]{36})/)![1];
    const { data: registration } = await admin().from("event_registrations").select("id, status, payment_status, terminal_hold_until, order_id")
      .eq("attendee_email", `e2e-box-${fixture.runId}-${tag}@example.com`).single();
    return { paymentId, registration: registration as { id: string; status: string; payment_status: string; terminal_hold_until: string | null; order_id: string | null } };
  }

  async function startReader(page: Page) {
    await page.locator("#readerId").selectOption(readerRowId);
    await page.getByRole("button", { name: "Send payment to reader" }).click();
    await page.waitForURL(/(success|error)=/, { timeout: 60_000 });
  }

  /** Simulated reader: the customer taps a test card. */
  async function presentCard(paymentId: string) {
    await stripe.testHelpers.terminal.readers.presentPaymentMethod(stripeReaderId, {}, onAccount);
    const { data: session } = await admin().from("terminal_payment_sessions").select("stripe_payment_intent_id").eq("payment_id", paymentId)
      .order("created_at", { ascending: false }).limit(1).single();
    const intentId = String(session?.stripe_payment_intent_id);
    let intent = await stripe.paymentIntents.retrieve(intentId, {}, onAccount);
    for (let i = 0; i < 30 && intent.status !== "succeeded"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      intent = await stripe.paymentIntents.retrieve(intentId, {}, onAccount);
    }
    expect(intent.status).toBe("succeeded");
    return intent;
  }

  /** Labelled set-up: the held seat is taken by a concurrent sale after this sale's terminal hold lapsed. */
  async function lapseHoldAndSellSeatElsewhere(registrationId: string, ticketId: string, tag: string) {
    await admin().from("event_registrations").update({ terminal_hold_until: new Date(Date.now() - 60_000).toISOString() }).eq("id", registrationId).throwOnError();
    await admin().from("event_registrations").insert({
      event_id: fixture.events.orgEarly.id, ticket_type_id: ticketId, studio_id: fixture.studioId, status: "confirmed", payment_status: "paid",
      quantity: 1, unit_price: 20, total_price: 20, currency: "USD", registration_source: "admin", attendee_first_name: "Other",
      attendee_last_name: tag, attendee_email: `e2e-box-${fixture.runId}-${tag}-other@example.com`,
    }).throwOnError();
  }

  test("B1 a card-reader sale reserves its ticket; the charge confirms it (ticket + payment row); a second sale is refused", async ({ page }) => {
    await signIn(page, fixture.owner, "/app/events/sell-tickets");
    const sale = await sellCardReader(page, tickets.success, "b1");
    expect(sale.registration).toMatchObject({ status: "pending", payment_status: "pending", order_id: null });
    expect(new Date(String(sale.registration.terminal_hold_until)).getTime()).toBeGreaterThan(Date.now());
    await startReader(page);
    expect(page.url()).toContain("success=terminal_payment_sent");
    const intent = await presentCard(sale.paymentId);
    expect(intent.payment_method_types).toEqual(["card_present"]);
    await page.getByRole("button", { name: "Refresh status" }).click();
    await page.waitForURL(/success=terminal_payment_(succeeded|already_recorded)/, { timeout: 60_000 });
    const { data: registration } = await admin().from("event_registrations").select("status, payment_status, terminal_hold_until, stripe_payment_intent_id").eq("id", sale.registration.id).single();
    expect(registration).toEqual({ status: "confirmed", payment_status: "paid", terminal_hold_until: null, stripe_payment_intent_id: intent.id });
    const { data: payments } = await admin().from("event_payments").select("source, status, amount, stripe_account_id").eq("registration_id", sale.registration.id);
    expect(payments).toEqual([{ source: "terminal_ticket_sale", status: "paid", amount: 20, stripe_account_id: ACCOUNT }]);
    const { data: issued } = await admin().from("event_registration_attendees").select("ticket_code, ticket_issued_at").eq("registration_id", sale.registration.id);
    expect(issued).toHaveLength(1);
    expect(issued![0].ticket_code).toBeTruthy();
    expect(issued![0].ticket_issued_at).toBeTruthy();
    expect((await admin().from("event_order_settlement_exceptions").select("id").eq("registration_id", sale.registration.id)).data).toEqual([]);

    // The last ticket is sold: another card-reader sale is refused before anything is charged.
    await page.goto("/app/events/sell-tickets");
    await page.locator("#eventIdVisible").selectOption(fixture.events.orgEarly.id);
    await page.locator("#ticketTypeIdVisible").selectOption(tickets.success);
    await page.locator("#paymentMethodVisible").selectOption("card_reader");
    await page.locator("#attendeeFirstName_1").fill("Box");
    await page.locator("#attendeeLastName_1").fill("b1-second");
    await page.locator("#attendeeEmail_1").fill(`e2e-box-${fixture.runId}-b1-second@example.com`);
    await page.getByRole("button", { name: "Continue to Card Reader" }).click();
    await expect(page.getByText(/no longer available|ticket\(s\) remain/i)).toBeVisible();
    expect((await admin().from("event_registrations").select("id").eq("attendee_email", `e2e-box-${fixture.runId}-b1-second@example.com`)).data).toEqual([]);
  });

  test("B2 a sold-out sale is refused when the reader is started: nothing is charged", async ({ page }) => {
    await signIn(page, fixture.owner, "/app/events/sell-tickets");
    const sale = await sellCardReader(page, tickets.refused, "b2");
    await lapseHoldAndSellSeatElsewhere(sale.registration.id, tickets.refused, "b2");
    await startReader(page);
    expect(page.url()).toContain("error=terminal_tickets_unavailable");
    await expect(page.getByText("These tickets are no longer available, so the card reader was not started. Nothing was charged.")).toBeVisible();
    expect((await admin().from("terminal_payment_sessions").select("id").eq("payment_id", sale.paymentId)).data).toEqual([]);
    expect((await admin().from("event_registrations").select("status").eq("id", sale.registration.id).single()).data?.status).toBe("pending");
  });

  test("B3 a charge that can no longer be fulfilled is never treated as fulfilment: visible failure, alerted exception, no refund", async ({ page }) => {
    await signIn(page, fixture.owner, "/app/events/sell-tickets");
    const sale = await sellCardReader(page, tickets.unfulfilled, "b3");
    // The sale itself creates its attendee rows (the database stamps their codes at insert; check-in refuses unpaid
    // registrations). Fulfilment of a charge it cannot honour must leave them exactly as the sale created them.
    const attendeesAtSale = (await admin().from("event_registration_attendees").select("id, ticket_code, ticket_issued_at").eq("registration_id", sale.registration.id).order("id")).data;
    await startReader(page);
    expect(page.url()).toContain("success=terminal_payment_sent");
    await lapseHoldAndSellSeatElsewhere(sale.registration.id, tickets.unfulfilled, "b3");
    const intent = await presentCard(sale.paymentId);
    await page.getByRole("button", { name: "Refresh status" }).click();
    await page.waitForURL(/error=terminal_ticket_not_fulfilled/, { timeout: 60_000 });
    await expect(page.getByText(/The card was charged, but the tickets could not be issued/)).toBeVisible();

    const { data: registration } = await admin().from("event_registrations").select("status, payment_status").eq("id", sale.registration.id).single();
    expect(registration).toEqual({ status: "pending", payment_status: "pending" });
    expect((await admin().from("event_payments").select("id").eq("registration_id", sale.registration.id)).data).toEqual([]);
    expect((await admin().from("event_registration_attendees").select("id, ticket_code, ticket_issued_at").eq("registration_id", sale.registration.id).order("id")).data).toEqual(attendeesAtSale);
    const { data: exceptions } = await admin().from("event_order_settlement_exceptions")
      .select("id, kind, money_state, status, payment_id, stripe_payment_intent_id, amount_cents, event_id").eq("registration_id", sale.registration.id);
    expect(exceptions).toEqual([expect.objectContaining({
      kind: "terminal_paid_capacity_unavailable", money_state: "captured", status: "open", payment_id: sale.paymentId,
      stripe_payment_intent_id: intent.id, amount_cents: 2000, event_id: fixture.events.orgEarly.id,
    })]);
    expect(await stripe.refunds.list({ payment_intent: intent.id }, onAccount).then((r) => r.data)).toEqual([]);
    await runCron();
    const { data: alerted } = await admin().from("event_order_settlement_exceptions").select("alert_status").eq("id", exceptions![0].id).single();
    expect(alerted?.alert_status).toBe("sent");
    expect((await admin().from("notifications").select("type").eq("dedupe_key", `payment_exception:${exceptions![0].id}`)).data).toEqual([{ type: "payment_exception" }]);

    await page.goto(`/app/events/${fixture.events.orgEarly.id}/registrations`);
    await expect(page.getByTestId("payment-exception").filter({ hasText: "A card-reader sale was charged but the tickets were sold out" })).toBeVisible();
  });

  test("B4 a cancelled reader payment releases the terminal hold (the seat is free again)", async ({ page }) => {
    await signIn(page, fixture.owner, "/app/events/sell-tickets");
    const sale = await sellCardReader(page, tickets.cancelled, "b4");
    await startReader(page);
    await page.getByRole("button", { name: "Cancel attempt" }).click();
    await page.waitForURL(/success=terminal_payment_canceled/, { timeout: 60_000 });
    const { data: registration } = await admin().from("event_registrations").select("terminal_hold_until").eq("id", sale.registration.id).single();
    expect(registration?.terminal_hold_until).toBeNull();
    expect((await admin().from("payments").select("status").eq("id", sale.paymentId).single()).data?.status).toBe("failed");
    // The database no longer counts the cancelled sale: another sale of the last seat is accepted.
    const { error } = await admin().from("event_registrations").insert({
      event_id: fixture.events.orgEarly.id, ticket_type_id: tickets.cancelled, studio_id: fixture.studioId, status: "pending", payment_status: "pending",
      quantity: 1, unit_price: 20, total_price: 20, currency: "USD", registration_source: "admin", attendee_first_name: "Next", attendee_last_name: "b4",
      attendee_email: `e2e-box-${fixture.runId}-b4-next@example.com`, terminal_hold_until: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    expect(error).toBeNull();
  });
});

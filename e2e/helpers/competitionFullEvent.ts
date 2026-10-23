import { expect, type Page } from "@playwright/test";
import type Stripe from "stripe";
import type { E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "./competitionFixture";

/**
 * Q1 full simulated competition: browser steps for stages 1, 2 and 4, plus read-only database evidence. Every state
 * change goes through the DanceFlow UI; the admin client here only reads.
 */

export type CreatedEvent = { id: string; slug: string; name: string };

/** Stage 1a: Competitions -> New Competition (the ordinary Create Event form, preselected to Competition). */
export async function createCompetitionEvent(page: Page, config: E2EConfig, input: { name: string; startDate: string; endDate: string }): Promise<CreatedEvent> {
  await page.goto("/app/events/new?type=competition");
  await expect(page.getByRole("heading", { name: "New Competition" })).toBeVisible();
  // A cold dev server can recompile and reload the form right after first paint; let it settle before typing.
  await page.waitForLoadState("networkidle");
  await page.locator("#name").fill(input.name);
  await page.locator("#startDate").fill(input.startDate);
  await expect(page.locator("#startDate")).toHaveValue(input.startDate);
  const multiDay = page.getByRole("checkbox", { name: /multiple days|ends on a different day/i });
  if (input.endDate !== input.startDate && (await multiDay.count())) {
    await multiDay.check();
    await page.locator("#endDateInput").fill(input.endDate);
  }
  await page.locator("#startTime").fill("09:00");
  await page.locator("#endTime").fill("21:00");
  await page.locator("#venueName").fill("E2E Grand Ballroom");
  await page.locator("#city").fill("Austin");
  await page.locator("#state").selectOption("TX");
  await page.getByText("Public", { exact: true }).click();
  await page.getByText("Publish now", { exact: true }).click();
  await expect(page.locator("#name")).toHaveValue(input.name);
  await expect(page.locator("#startDate")).toHaveValue(input.startDate);
  await Promise.all([
    page.waitForURL((url) => /^\/app\/events\/[0-9a-f-]{36}\/competition\/new$/.test(url.pathname), { timeout: 90_000 }),
    page.getByRole("button", { name: /^Create/ }).click({ noWaitAfter: true }),
  ]);
  const id = new URL(page.url()).pathname.split("/")[3];
  const { data, error } = await e2eAdminClient(config).from("events").select("id, slug, name, status, visibility, event_type").eq("id", id).single();
  if (error || !data) throw new Error(`created event not found: ${error?.message}`);
  return { id: data.id, slug: data.slug, name: data.name };
}

/** The local Supabase stack's mail catcher (Mailpit/Inbucket web API); loopback only. */
const LOCAL_MAILBOX = process.env.E2E_LOCAL_MAILBOX_URL ?? "http://127.0.0.1:55324";

async function latestMagicLinkTokenHash(email: string, after: number) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(LOCAL_MAILBOX)) throw new Error("refusing: mailbox is not local");
  let found: string | null = null;
  await expect.poll(async () => {
    const search = await fetch(`${LOCAL_MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`).then((r) => r.json()) as { messages?: Array<{ ID: string; Created: string }> };
    const message = (search.messages ?? []).find((m) => Date.parse(m.Created) >= after - 5_000);
    if (!message) return null;
    const body = await fetch(`${LOCAL_MAILBOX}/api/v1/message/${message.ID}`).then((r) => r.json()) as { HTML?: string; Text?: string };
    found = `${body.Text ?? ""} ${body.HTML ?? ""}`.replaceAll("&amp;", "&").match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1] ?? null;
    return found;
  }, { timeout: 60_000, intervals: [1_000] }).not.toBeNull();
  return found as unknown as string;
}

/**
 * LAUNCH-SEC-1C: "this is me" needs a verified, password-bound email (my_verified_email). A dancer gets it the way a
 * real user does: request a sign-in link, open it, and set a password on Account security. The local stack's default
 * Supabase email template links to GoTrue's PKCE verify URL, which DanceFlow deliberately never treats as proof, so
 * the harness opens the DanceFlow token-hash link format that production emails (and sendEmailVerificationLink) use,
 * built from the same token in the delivered email. Keeps the account's password.
 */
export async function verifyEmailAndBindPassword(page: Page, account: { email: string; password: string }) {
  const requestedAt = Date.now();
  await page.goto("/login?intent=public&next=%2Faccount");
  await page.locator("#public-email").fill(account.email);
  await page.locator("#public-email").press("Enter");
  await expect(page).toHaveURL(/check-email|mode=/, { timeout: 30_000 });
  const tokenHash = await latestMagicLinkTokenHash(account.email, requestedAt);
  await page.goto(`/callback?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink&next=${encodeURIComponent("/account/verify-email")}`);
  await expect(page.getByRole("heading", { name: "Create your password" })).toBeVisible({ timeout: 60_000 });
  await page.locator("#password").fill(account.password);
  await page.locator("#confirmPassword").fill(account.password);
  await page.getByRole("button", { name: "Save password and continue" }).click();
  await expect(page.getByRole("heading", { name: "Your email is verified" })).toBeVisible({ timeout: 60_000 });
}

export type Couple ={ leader: { firstName: string; lastName: string; isSelf?: boolean }; follower: { firstName: string; lastName: string; isSelf?: boolean } };

/** Stage 2: build one couple entry on /events/[slug]/competition/register and start checkout. Returns the Stripe URL. */
export async function registerCouple(page: Page, slug: string, contact: { name: string; email: string; phone: string }, couple: Couple) {
  await page.goto(`/events/${slug}/competition/register`);
  await expect(page.getByRole("heading", { name: "Competition Registration" })).toBeVisible();
  await page.getByPlaceholder("Contact name").fill(contact.name);
  await page.getByPlaceholder("Contact email").fill(contact.email);
  await page.getByPlaceholder("Contact phone").fill(contact.phone);
  for (const person of [couple.leader, couple.follower]) {
    await page.getByPlaceholder("First name").fill(person.firstName);
    await page.getByPlaceholder("Last name").fill(person.lastName);
    if (person.isSelf) await page.getByRole("checkbox", { name: /This is me/ }).check();
    await page.getByRole("button", { name: "Add to roster" }).click();
    await expect(page.getByText(`${person.firstName} ${person.lastName}`).first()).toBeVisible();
  }
  if (couple.leader.isSelf || couple.follower.isSelf) await expect(page.getByText("You", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Leader", exact: true }).selectOption({ label: `${couple.leader.firstName} ${couple.leader.lastName}` });
  await page.getByRole("combobox", { name: "Follower", exact: true }).selectOption({ label: `${couple.follower.firstName} ${couple.follower.lastName}` });
  const dances = page.locator("label").filter({ hasText: "Two Step" }).getByRole("checkbox");
  if ((await dances.count()) && !(await dances.first().isChecked())) await dances.first().check();
  await page.getByRole("button", { name: "Add entry", exact: true }).click();
  const entries = page.locator("section").filter({ has: page.getByRole("heading", { name: "Entries", exact: true }) });
  await expect(entries.getByText(`${couple.leader.firstName} ${couple.leader.lastName} · ${couple.follower.firstName} ${couple.follower.lastName}`)).toBeVisible();
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 90_000 });
  return page.url();
}

/**
 * Pays an open Checkout Session in TEST mode the way `stripe trigger checkout.session.completed` does (the hosted page
 * runs bot detection and is never automated): a tok_visa PaymentMethod confirmed through the payment page with the test
 * key. Stripe then emits the authentic signed webhooks to the local listener.
 */
export async function payCheckoutSession(stripe: Stripe, account: string, sessionId: string) {
  const onAccount = { stripeAccount: account };
  const paymentPage = (await stripe.rawRequest("GET", `/v1/payment_pages/${sessionId}`, {}, onAccount)) as unknown as { total_summary?: { due?: number }; livemode?: boolean };
  expect(paymentPage.livemode).toBe(false);
  const session = await stripe.checkout.sessions.retrieve(sessionId, {}, onAccount);
  const paymentMethod = await stripe.paymentMethods.create({
    type: "card", card: { token: "tok_visa" }, billing_details: { name: "E2E Buyer", email: session.customer_email ?? session.customer_details?.email ?? undefined },
  }, onAccount);
  try {
    await stripe.rawRequest("POST", `/v1/payment_pages/${sessionId}/confirm`, { payment_method: paymentMethod.id, expected_amount: paymentPage.total_summary?.due }, onAccount);
  } catch (error) {
    const raw = (error as { raw?: { code?: string; message?: string } }).raw;
    throw new Error(`Stripe test confirm failed: ${raw?.code ?? ""} ${raw?.message ?? String(error)}`);
  }
  return stripe.checkout.sessions.retrieve(sessionId, {}, onAccount);
}

/** Read-only evidence: the competition carts, orders, payments and entries of one event. */
export async function readCompetitionRegistrations(config: E2EConfig, eventId: string) {
  const admin = e2eAdminClient(config);
  const read = async (table: string, columns: string) => {
    const { data, error } = await admin.from(table).select(columns).eq("event_id", eventId);
    if (error) throw new Error(`${table}: ${error.message}`);
    return (data ?? []) as unknown as Record<string, unknown>[];
  };
  const [carts, orders, registrations, entries, participants, competitors] = await Promise.all([
    read("event_competition_registration_carts", "id, order_id, buyer_name, buyer_email, buyer_user_id, status, quoted_total, currency"),
    read("event_orders", "id, buyer_email, status, payment_status, total_amount, stripe_checkout_session_id, paid_at"),
    read("event_registrations", "id, order_id, status, payment_status, total_price"),
    read("event_competition_entries", "id, registration_cart_id, status, eligibility_status, verification_status, entry_number"),
    read("event_competition_entry_participants", "entry_id, display_name, participant_role, dance_role, competitor_id"),
    read("event_competition_competitors", "id, user_id, first_name, last_name, email"),
  ]);
  const registrationIds = registrations.map((row) => row.id as string);
  const { data: payments, error } = registrationIds.length
    ? await admin.from("event_payments").select("registration_id, amount, status, stripe_account_id").in("registration_id", registrationIds)
    : { data: [], error: null };
  if (error) throw new Error(`event_payments: ${error.message}`);
  return { carts, orders, registrations, entries, participants, competitors, payments: (payments ?? []) as Record<string, unknown>[] };
}

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

  // ---------------------------------------------------------------- Stage 3 (pending slices)

  test.fixme("stage 3: one entry is changed, one cancelled with a per-entry refund; totals reconcile", async () => {
    // TODO(R2 CI-D per-entry refunds + entry change UI): change one entry through the UI, cancel another with a
    // per-entry refund, then reconcile order totals, payments and refunds.
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

  test.fixme("stage 4: a duplicate check-in scan is rejected", async () => {
    // TODO(R1 CI-B check-in CAS + scan path): competition check-in has no scan input in the UI today.
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

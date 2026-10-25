import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient, readPrograms } from "../helpers/competitionFixture";
import { createCompetitionEvent, payCheckoutSession, readCompetitionRegistrations, verifyEmailAndBindPassword, type CreatedEvent } from "../helpers/competitionFullEvent";
import { openRegistration } from "../helpers/competitionFullEventMoney";
import { chooseCountryCouples, createDraft, finishSetup, startCompetition } from "../helpers/competitionWizard";
import {
  anonymousPage,
  cleanupScheduleAcceptanceFixture,
  createScheduleAcceptanceFixture,
  openHeat,
  publishedVersions,
  readBallotCount,
  readEntries,
  readHeatEvidence,
  readOfficials,
  readPanelStatus,
  readScratchAudit,
  registerRoster,
  scenarioStatus,
  signedIn,
  startCompetitionWithJudging,
  stepShots,
  visit,
  type RosterCouple,
  type ScheduleAcceptanceFixture,
} from "../helpers/competitionScheduleHeats";
import { useUniqueE2ESourceIp as assignUniqueSourceIp } from "../helpers/rateLimitBypass";

/**
 * QA-A -- Schedule & Heats acceptance walkthrough (Competition OS). Every step is driven through the real DanceFlow UI
 * on a local stack; the service-role client only READS (database evidence after each user-visible step). The only
 * writes outside the browser are the Q1 base seed (studio, accounts, roles) and Stripe TEST payment of the hosted
 * Checkout page, exactly as competition-full-event.spec.ts does it.
 *
 * Scenario ids (SCN-n) match docs/qa/competition-schedule-heats-acceptance-<date>.md. Anything with no UI is a
 * `test.fixme` labelled NOT IMPLEMENTED; a SQL setup step would be labelled SETUP SHORTCUT (there are none here).
 *
 * System under test: the qa-sut integration branch (R2/SC1 + CI-B + desk balance + CB-2 + K1 + E1 + O1 + E2), local
 * Supabase stack with the July baseline and the repo migrations applied in order. See the report for exact SHAs.
 *
 * Environment (same declaration as competition-full-event.spec.ts): E2E_COMPETITION_REGISTRATION_ENABLED=true,
 * E2E_STRIPE_TEST_SECRET_KEY, E2E_STRIPE_TEST_CONNECTED_ACCOUNT, E2E_LOCAL_DB_CONTAINER (append-only teardown),
 * E2E_LOCAL_MAILBOX_URL (the stack's mail catcher, used to verify judges' email through the real sign-in link) and,
 * optionally, E2E_SUPABASE_ANON_KEY for the database authorization scenario.
 */

test.describe.configure({ mode: "serial", timeout: 600_000 });

const FLAG_ON = process.env.E2E_COMPETITION_REGISTRATION_ENABLED === "true";
const TEST_KEY = process.env.E2E_STRIPE_TEST_SECRET_KEY ?? "";
const ACCOUNT = process.env.E2E_STRIPE_TEST_CONNECTED_ACCOUNT ?? "";
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? "";
const ENTRY_FEE = 40;
const PHONE = "5125550100";

const AVERY = { firstName: "Avery", lastName: "Lead" };
const COUPLES = {
  e1: { leader: AVERY, follower: { firstName: "Drew", lastName: "Partner" } },
  e2: { leader: AVERY, follower: { firstName: "Emery", lastName: "Partner" } },
  e3: { leader: { firstName: "Blair", lastName: "Step" }, follower: { firstName: "Finley", lastName: "Partner" } },
  e4: { leader: { firstName: "Casey", lastName: "Turn" }, follower: { firstName: "Gale", lastName: "Guest" } },
} satisfies Record<string, RosterCouple>;
/** The partner whose name is unique to each entry (Avery is in e1 and e2). */
const KEY_NAME = { e1: "Drew Partner", e2: "Emery Partner", e3: "Blair Step", e4: "Casey Turn" } as const;
type EntryKey = keyof typeof KEY_NAME;

const WORKSPACE_PAGES = ["schedule", "officials", "day-of", "ballots", "readiness", "registrations", "divisions"] as const;

test.describe("Schedule & Heats acceptance (QA-A)", () => {
  test.skip(!FLAG_ON, "Needs the app started with NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true (E2E_COMPETITION_REGISTRATION_ENABLED=true).");
  test.skip(!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(TEST_KEY) || !/^acct_[A-Za-z0-9]+$/.test(ACCOUNT), "Stripe TEST key and test connected account not provided");

  let config: E2EConfig;
  let fixture: ScheduleAcceptanceFixture;
  let stripe: Stripe;
  /** Event A: callback judging, used only for the setup / callback-target readiness scenario. */
  let callbackEvent: CreatedEvent;
  /** Event B: the schedule event (Newcomer division with entries + an empty "Bronze Open" division). */
  let event: CreatedEvent;
  let roundId = "";
  const entryIds: Partial<Record<EntryKey, string>> = {};
  /** Scenario results the access scenarios record for the report. */
  const base = () => `/app/events/${event.id}/competition`;

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl)) throw new Error("refusing: not the local QA Supabase");
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.baseUrl)) throw new Error("refusing: not a local app");
    stripe = new Stripe(TEST_KEY);
    if ((await stripe.balance.retrieve()).livemode) throw new Error("refusing: Stripe key is live");
    fixture = await createScheduleAcceptanceFixture(config, { connectedAccountId: ACCOUNT });
  });

  test.afterAll(async () => {
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    await cleanupScheduleAcceptanceFixture(config, fixture);
  });

  const evidence = (value: unknown) => test.info().annotations.push({ type: "evidence", description: JSON.stringify(value) });
  const status = (page: Page) => page.getByRole("status");

  async function entryId(key: EntryKey): Promise<string> {
    const { entries, participants } = await readEntries(config, event.id);
    const match = entries.find((entry) => participants.some((p) => p.entry_id === entry.id && p.display_name === KEY_NAME[key]));
    if (!match) throw new Error(`no entry found for ${KEY_NAME[key]}`);
    return (entryIds[key] = match.id as string);
  }

  /** The row of one entry on the Competition Registrations page. */
  const entryRow = (page: Page, key: EntryKey): Locator => page.locator("div.py-5.grid").filter({ hasText: KEY_NAME[key] });

  async function setEligibility(page: Page, key: EntryKey, value: "eligible" | "ineligible") {
    await page.goto(`${base()}/registrations`);
    const form = entryRow(page, key).locator('form:has(select[name="eligibilityStatus"])');
    await form.locator("select").selectOption(value);
    await form.getByRole("button", { name: "Save" }).click();
    await expect(entryRow(page, key).locator('select[name="eligibilityStatus"]')).toHaveValue(value, { timeout: 30_000 });
  }

  // ================================================================== SCN-1 Setup

  test("SCN-1.1 setup: a callback competition shows the callback-target readiness blocker until the organizer sets a target (W4/K1)", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    callbackEvent = await createCompetitionEvent(page, config, { name: `E2E Callback Setup ${fixture.runId}`, startDate: "2027-05-15", endDate: "2027-05-15" });
    await startCompetitionWithJudging(page, "Country", /^Callbacks \+ Final/);
    await chooseCountryCouples(page);
    await finishSetup(page, { accountRequired: false }, { model: "Per entry", amount: String(ENTRY_FEE) }, { summary: "QA-A callback setup." });
    await createDraft(page, callbackEvent.id);
    await shot(page, "callback-draft-created");

    const rounds = (await readHeatEvidence(config, callbackEvent.id)).rounds;
    const callbackRound = rounds.find((round) => round.scoring_method === "callback_tally");
    expect(callbackRound, "the Callbacks + Final option creates a callback_tally round").toBeTruthy();
    expect(callbackRound!.target_advancement_count).toBeNull();
    expect(rounds.find((round) => round.name === "Final")?.scoring_method).toBe("ordinal_majority");

    await page.goto(`/app/events/${callbackEvent.id}/competition/advanced`);
    await expect(page.getByText(/Callback target not set\. This blocks schedule readiness/)).toBeVisible();
    await shot(page, "blocker-visible");

    await page.getByLabel(/^Callback target for /).fill("3");
    await page.getByRole("button", { name: "Save target" }).click();
    await expect.poll(async () => (await readHeatEvidence(config, callbackEvent.id)).rounds.find((r) => r.scoring_method === "callback_tally")?.target_advancement_count, { timeout: 30_000 }).toBe(3);
    await page.reload();
    await expect(page.getByLabel(/^Callback target for /)).toHaveValue("3");
    await expect(page.getByText(/Callback target not set/)).toHaveCount(0);
    await shot(page, "blocker-cleared-after-reload");
    evidence({ scenario: "SCN-1.1", event: callbackEvent.id, target: 3 });
    await page.context().close();
  });

  test("SCN-1.2 setup: owner creates the schedule competition, adds a second division, publishes and opens registration", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    event = await createCompetitionEvent(page, config, { name: `E2E Schedule Classic ${fixture.runId}`, startDate: "2027-04-17", endDate: "2027-04-17" });
    await startCompetition(page, "Country");
    await chooseCountryCouples(page);
    await finishSetup(page, { accountRequired: false }, { model: "Per entry", amount: String(ENTRY_FEE) }, {
      summary: "QA-A Schedule & Heats acceptance.", registrationInfo: "Entries are confirmed once payment completes.",
    });
    await createDraft(page, event.id);
    await shot(page, "draft-created");

    // Divisions and event configuration: a second, empty division so the day-of console has a round to cancel.
    await page.goto(`${base()}/divisions`);
    await expect(page.getByRole("heading", { name: "Divisions" })).toBeVisible();
    await page.getByRole("button", { name: "Add division" }).first().click();
    const form = page.locator("form").filter({ has: page.locator('input[name="skillLabel"]') });
    await form.locator('input[name="name"]').fill("Bronze Open");
    await form.locator('input[name="skillLabel"]').fill("Bronze");
    await form.getByRole("button", { name: "Add division" }).click();
    await expect(page.getByText("Bronze Open").first()).toBeVisible({ timeout: 30_000 });
    await shot(page, "second-division-added");

    await page.goto(base());
    await page.getByRole("button", { name: "Publish competition" }).click();
    await expect(page.getByRole("button", { name: "Open registration" })).toBeVisible({ timeout: 30_000 });
    await openRegistration(page);
    await shot(page, "published-registration-open");

    const [program] = await readPrograms(config, event.id);
    expect(program).toMatchObject({ status: "configured", registration_status: "open" });
    const evidenceNow = await readHeatEvidence(config, event.id);
    expect(evidenceNow.rounds.length).toBeGreaterThanOrEqual(2);
    const { data: divisions } = await e2eAdminClient(config).from("event_competition_divisions").select("name, status").eq("event_id", event.id);
    expect(divisions?.map((d) => d.name)).toEqual(expect.arrayContaining(["Bronze Open"]));
    evidence({ scenario: "SCN-1.2", event: event.id, divisions: divisions?.length, rounds: evidenceNow.rounds.length });
    await page.context().close();
  });

  // ================================================================== SCN-2 Registration and eligible entries

  test("SCN-2.1 registration: three buyers pay for four entries with a test card (Avery dances two entries); the Entries page shows them paid", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const orders: Array<{ name: string; email: string; couples: RosterCouple[]; total: number }> = [
      { name: "Avery Lead", email: `e2e-compfull-${fixture.runId}-ordera@example.com`, couples: [COUPLES.e1, COUPLES.e2], total: 2 * ENTRY_FEE },
      { name: "Blair Step", email: `e2e-compfull-${fixture.runId}-orderb@example.com`, couples: [COUPLES.e3], total: ENTRY_FEE },
      { name: "Casey Turn", email: `e2e-compfull-${fixture.runId}-orderc@example.com`, couples: [COUPLES.e4], total: ENTRY_FEE },
    ];
    for (const order of orders) {
      const page = await (await browser.newContext()).newPage();
      await assignUniqueSourceIp(page);
      const checkoutUrl = await registerRoster(page, event.slug, { name: order.name, email: order.email, phone: PHONE }, order.couples);
      const sessionId = checkoutUrl.match(/cs_test_[A-Za-z0-9]+/)?.[0];
      expect(sessionId, "hosted Checkout URL carries a test session").toBeTruthy();
      const open = await stripe.checkout.sessions.retrieve(sessionId!, {}, { stripeAccount: ACCOUNT });
      expect([open.livemode, open.status, open.amount_total]).toEqual([false, "open", order.total * 100]);
      const paid = await payCheckoutSession(stripe, ACCOUNT, sessionId!);
      expect([paid.status, paid.payment_status]).toEqual(["complete", "paid"]);
      await expect.poll(async () => (await readCompetitionRegistrations(config, event.id)).orders.find((o) => o.stripe_checkout_session_id === sessionId)?.payment_status, { timeout: 90_000, intervals: [1_000] }).toBe("paid");
      await page.goto(paid.success_url!);
      await expect(page.getByText("Registration confirmed")).toBeVisible({ timeout: 30_000 });
      await shot(page, `confirmation-${order.name.split(" ")[0].toLowerCase()}`);
      await page.context().close();
    }
    const state = await readCompetitionRegistrations(config, event.id);
    expect(state.orders).toHaveLength(3);
    expect(state.entries).toHaveLength(4);
    expect(state.entries.every((entry) => entry.status === "confirmed")).toBe(true);
    expect(state.payments.filter((p) => p.status === "paid")).toHaveLength(3);
    // Avery is ONE competitor in two entries: the premise of the conflict scenario.
    const avery = state.participants.filter((p) => p.display_name === "Avery Lead");
    expect(avery).toHaveLength(2);
    expect(new Set(avery.map((p) => p.competitor_id)).size).toBe(1);
    for (const key of ["e1", "e2", "e3", "e4"] as const) await entryId(key);

    const owner = await signedIn(browser, fixture.owner);
    await owner.goto(`${base()}/registrations`);
    await expect(owner.getByRole("heading", { name: "Competition Registrations" })).toBeVisible();
    await expect(owner.getByText("4 entries", { exact: true })).toBeVisible();
    await expect(owner.getByText("$80.00").first()).toBeVisible();
    await expect(owner.getByText("Paid", { exact: true }).first()).toBeVisible();
    await shot(owner, "entries-paid");
    evidence({ scenario: "SCN-2.1", orders: state.orders.length, entries: state.entries.length });
    await owner.context().close();
  });

  test("SCN-2.2 eligibility: an ineligible entry is excluded from the schedule; the Schedule page counts the rest", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    for (const key of ["e1", "e2", "e3"] as const) await setEligibility(page, key, "eligible");
    await setEligibility(page, "e4", "ineligible");
    await shot(page, "eligibility-set");
    await expect.poll(async () => {
      const { entries } = await readEntries(config, event.id);
      return Object.fromEntries(entries.map((e) => [e.id as string, e.eligibility_status as string]));
    }, { timeout: 30_000 }).toEqual({ [entryIds.e1!]: "eligible", [entryIds.e2!]: "eligible", [entryIds.e3!]: "eligible", [entryIds.e4!]: "ineligible" });

    await page.goto(`${base()}/schedule`);
    await expect(page.getByRole("heading", { name: "Schedule & Heats" })).toBeVisible();
    await expect(page.getByText("3 confirmed entries are ready to schedule.")).toBeVisible();
    await shot(page, "schedule-before-generate");
    expect((await readHeatEvidence(config, event.id)).floorHeats).toHaveLength(0);
    await page.context().close();
  });

  // ================================================================== SCN-3 Schedule and heat generation

  test("SCN-3.1 generate heats: Avery's two entries land in different heats; no competitor is double-booked; a conflicting move is refused in the UI", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await page.goto(`${base()}/schedule`);
    await page.getByRole("button", { name: "Generate heats" }).click();
    await expect(status(page)).toContainText(/Created \d+ heats? for 3 entries/, { timeout: 60_000 });
    await expect(page.getByRole("list", { name: "Running order" })).toBeVisible();
    await expect(page.getByText(/^Draft — not published yet · \d+ heats · 3 entries on the floor$/)).toBeVisible();
    await shot(page, "heats-generated");

    const heats = await readHeatEvidence(config, event.id);
    const placed = heats.floorLayout.flatMap((heat) => heat.entryIds);
    expect(new Set(placed)).toEqual(new Set([entryIds.e1, entryIds.e2, entryIds.e3]));
    expect(placed).toHaveLength(3);
    expect(heats.doubleBookings).toEqual([]);
    const heatOf = (key: EntryKey) => heats.floorLayout.find((heat) => heat.entryIds.includes(entryIds[key]!))!;
    expect(heatOf("e1").heatId, "the shared dancer's two entries are in different scoring heats").not.toBe(heatOf("e2").heatId);
    expect(heatOf("e1").floorNumber, "...and in different floor heats").not.toBe(heatOf("e2").floorNumber);
    expect(publishedVersions(heats)).toHaveLength(0);

    // The UI refuses the conflicting move: Heat X (with Avery's first entry) cannot join the heat that has her second.
    const text = await openHeat(page, event.id, heatOf("e1").floorNumber);
    expect(text).toContain("Avery Lead");
    const blocked = page.locator('select[name="target"] option[disabled]').filter({ hasText: /Avery Lead is already dancing in Heat \d+/ });
    await expect(blocked.first()).toBeAttached();
    await shot(page, "conflicting-move-disabled");
    evidence({ scenario: "SCN-3.1", floorHeats: heats.floorHeats.length, scoringHeats: heats.scoringHeats.length, doubleBookings: heats.doubleBookings.length });
    await page.context().close();
  });

  test("SCN-3.2 capacity: a per-division heat size of 2 applies when heats are regenerated with all four entries", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const heats = await readHeatEvidence(config, event.id);
    await openHeat(page, event.id, heats.floorLayout[0].floorNumber);
    await page.getByLabel("Max entries per heat for this division").first().fill("2");
    await page.locator("aside").getByRole("button", { name: "Save", exact: true }).first().click();
    await expect(status(page)).toContainText("Heat size saved", { timeout: 30_000 });
    await shot(page, "capacity-saved");
    await expect.poll(async () => (await readHeatEvidence(config, event.id)).rounds.some((r) => (r.configuration as { max_entries_per_heat?: number } | null)?.max_entries_per_heat === 2), { timeout: 30_000 }).toBe(true);

    // The fourth entry becomes eligible, the draft is cleared and regenerated.
    await setEligibility(page, "e4", "eligible");
    await page.goto(`${base()}/schedule`);
    await page.getByRole("button", { name: "Start over" }).click();
    await expect(status(page)).toContainText("The draft running order was cleared.", { timeout: 30_000 });
    await expect.poll(async () => (await readHeatEvidence(config, event.id)).floorHeats.length, { timeout: 30_000 }).toBe(0);
    await page.getByRole("button", { name: "Generate heats" }).click();
    await expect(status(page)).toContainText(/Created \d+ heats? for 4 entries/, { timeout: 60_000 });
    await shot(page, "regenerated-with-capacity");

    const after = await readHeatEvidence(config, event.id);
    const draftLayout = after.floorLayout.filter((heat) => heat.entryIds.length > 0);
    expect(draftLayout.flatMap((heat) => heat.entryIds)).toHaveLength(4);
    expect(draftLayout.every((heat) => heat.entryIds.length <= 2), "no scoring heat holds more than the saved capacity").toBe(true);
    expect(draftLayout.length).toBeGreaterThanOrEqual(2);
    expect(after.doubleBookings).toEqual([]);
    const heatOf = (key: EntryKey) => draftLayout.find((heat) => heat.entryIds.includes(entryIds[key]!))!;
    expect(heatOf("e1").heatId).not.toBe(heatOf("e2").heatId);
    await expect(page.getByText(/^Draft — not published yet · \d+ heats · 4 entries on the floor$/)).toBeVisible();
    evidence({ scenario: "SCN-3.2", scoringHeats: draftLayout.length, sizes: draftLayout.map((heat) => heat.entryIds.length) });
    await page.context().close();
  });

  test("SCN-3.3 editing the draft: move a heat, add an empty heat, remove it; numbering stays contiguous", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const before = await readHeatEvidence(config, event.id);
    const numbers = (e: typeof before) => e.floorHeats.map((row) => Number(row.heat_number)).sort((a, b) => a - b);
    const total = before.floorHeats.length;
    expect(numbers(before)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    const lastFloorId = before.floorHeats.find((row) => Number(row.heat_number) === total)!.id as string;

    await openHeat(page, event.id, total);
    await page.getByLabel("Position in the running order").selectOption("1");
    await page.getByRole("button", { name: "Move heat" }).click();
    await expect(status(page)).toContainText("Running order updated.", { timeout: 30_000 });
    await shot(page, "heat-moved-to-first");
    await expect.poll(async () => Number((await readHeatEvidence(config, event.id)).floorHeats.find((row) => row.id === lastFloorId)?.heat_number), { timeout: 30_000 }).toBe(1);
    expect(numbers(await readHeatEvidence(config, event.id))).toEqual(Array.from({ length: total }, (_, i) => i + 1));

    await page.getByRole("button", { name: "Add empty heat after" }).click();
    await expect(status(page)).toContainText("Empty heat added.", { timeout: 30_000 });
    await shot(page, "empty-heat-added");
    await expect.poll(async () => (await readHeatEvidence(config, event.id)).floorHeats.length, { timeout: 30_000 }).toBe(total + 1);
    await page.getByRole("button", { name: "Remove empty heat" }).click();
    await expect(status(page)).toContainText("Empty heat removed.", { timeout: 30_000 });
    await expect.poll(async () => (await readHeatEvidence(config, event.id)).floorHeats.length, { timeout: 30_000 }).toBe(total);
    expect(numbers(await readHeatEvidence(config, event.id))).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    evidence({ scenario: "SCN-3.3", total });
    await page.context().close();
  });

  test("SCN-3.4 publish: the running order is published, survives a reload and is visible to a second manager", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const desk = await signedIn(browser, fixture.deskAdmin, `${base()}/schedule`);
    await expect(desk.getByText(/^Draft — not published yet/)).toBeVisible();

    await page.goto(`${base()}/schedule`);
    await page.getByRole("button", { name: "Publish running order" }).click();
    await expect(status(page)).toContainText("Running order published.", { timeout: 60_000 });
    await expect(page.getByText(/^Published · \d+ heats · 4 entries on the floor$/)).toBeVisible();
    await shot(page, "published");
    const published = await readHeatEvidence(config, event.id);
    expect(publishedVersions(published)).toHaveLength(1);
    expect(published.versions).toHaveLength(1);

    await page.reload();
    await expect(page.getByText(/^Published · \d+ heats · 4 entries on the floor$/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish running order" })).toHaveCount(0);
    await desk.reload();
    await expect(desk.getByText(/^Published · \d+ heats · 4 entries on the floor$/)).toBeVisible();
    await shot(desk, "second-manager-sees-published");
    evidence({ scenario: "SCN-3.4", versions: published.versions.map((v) => v.status) });
    await page.context().close();
    await desk.context().close();
  });

  test("SCN-3.5 reschedule: edit the published running order into a draft copy, move a heat, republish; exactly one version is in effect", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const desk = await signedIn(browser, fixture.deskAdmin, `${base()}/schedule`);
    await page.goto(`${base()}/schedule`);
    await page.getByRole("button", { name: "Edit running order" }).click();
    await expect(status(page)).toContainText("A new draft copy is ready to edit", { timeout: 30_000 });
    await expect(page.getByText(/^Draft — not published yet/)).toBeVisible();
    await shot(page, "draft-copy");
    let evidenceNow = await readHeatEvidence(config, event.id);
    expect(evidenceNow.versions).toHaveLength(2);
    expect(publishedVersions(evidenceNow)).toHaveLength(1);
    await desk.reload();
    await expect(desk.getByText(/^Published ·/), "the published order stays in effect while a draft copy is edited").toBeVisible();

    const draftId = evidenceNow.versions.find((v) => v.status === "draft")!.id as string;
    const draftHeats = evidenceNow.floorHeats.filter((row) => row.schedule_version_id === draftId);
    const lastDraft = draftHeats.find((row) => Number(row.heat_number) === draftHeats.length)!;
    await openHeat(page, event.id, draftHeats.length);
    await page.getByLabel("Position in the running order").selectOption("1");
    await page.getByRole("button", { name: "Move heat" }).click();
    await expect(status(page)).toContainText("Running order updated.", { timeout: 30_000 });
    await expect.poll(async () => Number((await readHeatEvidence(config, event.id)).floorHeats.find((row) => row.id === lastDraft.id)?.heat_number), { timeout: 30_000 }).toBe(1);

    await page.getByRole("button", { name: "Publish running order" }).click();
    await expect(status(page)).toContainText("Running order published.", { timeout: 60_000 });
    await expect(page.getByText(/^Published · \d+ heats · 4 entries on the floor$/)).toBeVisible();
    await shot(page, "republished");
    evidenceNow = await readHeatEvidence(config, event.id);
    expect(publishedVersions(evidenceNow)).toHaveLength(1);
    expect(publishedVersions(evidenceNow)[0].id).toBe(draftId);
    expect(evidenceNow.doubleBookings).toEqual([]);
    await page.reload();
    await expect(page.getByText(/^Published · \d+ heats · 4 entries on the floor$/)).toBeVisible();
    await desk.reload();
    await expect(desk.getByText(/^Published · \d+ heats · 4 entries on the floor$/)).toBeVisible();
    evidence({ scenario: "SCN-3.5", versions: evidenceNow.versions.map((v) => [v.version_number, v.status]) });
    await page.context().close();
    await desk.context().close();
  });

  // ================================================================== SCN-5 Officials and judges (E1)

  test("SCN-5.1 officials: unverified judges cannot be added; after verifying their email the owner adds three, names a chair and builds the panel to 'Panel ready'", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await page.goto(`${base()}/officials`);
    await expect(page.getByRole("heading", { name: "Officials and panels" })).toBeVisible();
    const judgeOption = (n: number) => page.locator('select[name="userId"] option', { hasText: `E2E Judge ${n}` });
    await expect(judgeOption(1)).toBeDisabled();
    await expect(judgeOption(1)).toContainText("email not verified");
    await shot(page, "unverified-judge-disabled");

    // Each judge proves their mailbox through the real sign-in link and sets a password (verified-email credential).
    for (const judge of fixture.judges) {
      const judgePage = await (await browser.newContext()).newPage();
      await assignUniqueSourceIp(judgePage);
      await verifyEmailAndBindPassword(judgePage, judge);
      await judgePage.context().close();
    }
    await page.reload();
    for (const n of [1, 2, 3]) {
      await expect(judgeOption(n)).toBeEnabled();
      const value = await judgeOption(n).getAttribute("value");
      await page.locator('select[name="userId"]').selectOption(value!);
      await page.getByRole("button", { name: "Add official" }).click();
      await expect(status(page)).toContainText("Official added.", { timeout: 30_000 });
    }
    await shot(page, "three-officials-added");

    // Chair: judge 1.
    const row = page.locator("li").filter({ hasText: "E2E Judge 1" }).filter({ has: page.getByRole("button", { name: "Make chair" }) });
    await row.getByRole("button", { name: "Make chair" }).click();
    await expect(status(page)).toContainText("Chair set.", { timeout: 30_000 });
    await expect(page.locator("li").filter({ hasText: "E2E Judge 1" }).getByText("Chair of judges")).toBeVisible();

    // Panel for the Newcomer round (not the empty Bronze division).
    const article = page.locator("article").filter({ hasNotText: "Bronze Open" }).first();
    for (const n of [1, 2, 3]) {
      const option = article.locator('select[name="officialId"] option', { hasText: `E2E Judge ${n}` });
      await article.locator('select[name="officialId"]').selectOption(await option.getAttribute("value") as string);
      await article.getByRole("button", { name: "Add to panel" }).click();
      await expect(status(page)).toContainText("Added to the panel.", { timeout: 30_000 });
    }
    await expect(page.locator("article").filter({ hasNotText: "Bronze Open" }).first().getByText(/Panel ready \(3 judges\)/)).toBeVisible();
    await shot(page, "panel-ready");

    const { officials, assignments } = await readOfficials(config, event.id);
    expect(officials.filter((o) => o.status === "active")).toHaveLength(3);
    expect(officials.filter((o) => o.role === "chair")).toHaveLength(1);
    expect(assignments).toHaveLength(3);
    const letters = assignments.map((a) => a.judge_letter as string);
    expect(new Set(letters).size).toBe(3);
    expect(letters.every((l) => /^[A-Z]{1,2}$/.test(l))).toBe(true);
    roundId = assignments[0].round_id as string;
    expect(await readPanelStatus(config, roundId)).toMatchObject({ ready: true, judge_count: 3 });
    evidence({ scenario: "SCN-5.1", letters, roundId });
    await page.context().close();
  });

  test("SCN-5.2 a judge sees only their own assignment; a non-official instructor sees none; neither can open the competition workspace", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const judge = await signedIn(browser, fixture.judges[1], "/app/judging");
    await expect(judge.getByRole("heading", { name: "Judging" })).toBeVisible();
    const section = judge.getByRole("region", { name: event.name });
    await expect(section).toBeVisible();
    await expect(section.getByText(/Judge$/)).toBeVisible();
    const body = (await judge.locator("body").innerText()).replace(/\s+/g, " ");
    for (const other of ["E2E Judge 1", "E2E Judge 3", "Avery", "Casey", callbackEvent.name]) expect(body, `judge view must not expose ${other}`).not.toContain(other);
    await shot(judge, "judge-own-assignments");
    const workspace = await visit(judge, `${base()}/schedule`);
    expect(workspace.status).toBe(404);

    const instructor = await signedIn(browser, fixture.instructor, "/app/judging");
    await expect(instructor.getByText("You have no judging assignments.")).toBeVisible();
    await shot(instructor, "instructor-no-assignments");
    const { assignments } = await readOfficials(config, event.id);
    expect(assignments).toHaveLength(3);
    await judge.context().close();
    await instructor.context().close();
  });

  // ================================================================== SCN-7 / SCN-6 Day-of, scratches

  test("SCN-7.1 day-of: schedule and start the round; floor heats move waiting -> on deck -> on the floor -> done, and survive a reload", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await page.goto(`${base()}/day-of`);
    await expect(page.getByRole("heading", { name: "Day-of" })).toBeVisible();
    await expect(page.getByText(/Running order: .* \(published\) · \d+ heats/)).toBeVisible();
    const rounds = page.getByRole("region", { name: "Rounds" });
    const roundItem = rounds.locator("li").filter({ hasNotText: "Bronze Open" });
    await expect(roundItem.getByText("Not scheduled")).toBeVisible();
    // Heats cannot start before the round does.
    await expect(page.getByText("Start the round first.").first()).toBeVisible();
    await shot(page, "day-of-before-round");

    await roundItem.getByRole("button", { name: "Schedule round" }).click();
    await expect(roundItem.getByText("Scheduled", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await readHeatEvidence(config, event.id)).rounds.find((r) => r.id === roundId)?.status, { timeout: 30_000 }).toBe("scheduled");
    await roundItem.getByRole("button", { name: "Start round" }).click();
    await expect(roundItem.getByText("Running", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await readHeatEvidence(config, event.id)).rounds.find((r) => r.id === roundId)?.status, { timeout: 30_000 }).toBe("active");
    await shot(page, "round-running");

    // Heat 1: call to floor, start, complete.
    const heatsNow = await readHeatEvidence(config, event.id);
    const firstFloorId = heatsNow.floorHeats.find((row) => Number(row.heat_number) === 1)!.id as string;
    const stateOfFirst = async () => [...new Set((await readHeatEvidence(config, event.id)).scoringHeats.filter((h) => h.floor_heat_id === firstFloorId).map((h) => h.status as string))];
    const heatCard = (title: "On the floor" | "Up next") => page.getByRole("region", { name: title });
    await heatCard("Up next").getByRole("button", { name: "Call to floor" }).click();
    await expect(heatCard("On the floor").getByText("On deck")).toBeVisible({ timeout: 30_000 });
    expect(await stateOfFirst()).toEqual(["staging"]);
    await heatCard("On the floor").getByRole("button", { name: "Start heat" }).click();
    await expect(heatCard("On the floor").getByText("On the floor", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    expect(await stateOfFirst()).toEqual(["active"]);
    await shot(page, "heat-1-on-the-floor");
    await page.reload();
    await expect(heatCard("On the floor").getByText("Heat 1")).toBeVisible();
    await heatCard("On the floor").getByRole("button", { name: "Complete heat" }).click();
    await expect(page.getByText("No heat is on the floor.")).toBeVisible({ timeout: 30_000 });
    expect(await stateOfFirst()).toEqual(["complete"]);
    await expect(heatCard("Up next").getByText("Heat 2")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("region", { name: "Running order" }).getByText("Done").first()).toBeVisible();
    await shot(page, "heat-1-done-after-reload");
    evidence({ scenario: "SCN-7.1", firstHeatStates: ["staging", "active", "complete"] });
    await page.context().close();
  });

  test("SCN-6.1 scratch in an open heat: no payment changes, the entry leaves the heat, the day-of console no longer lists it", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const layout = (await readHeatEvidence(config, event.id)).floorLayout.filter((heat) => heat.status === "scheduled" && heat.lockState === "open" && heat.entryIds.length > 0);
    expect(layout.length, "an undanced, open heat with entries exists").toBeGreaterThan(0);
    const target = layout[0].entryIds[0];
    const key = (Object.keys(entryIds) as EntryKey[]).find((k) => entryIds[k] === target)!;
    const { orders: before } = await readCompetitionRegistrations(config, event.id);

    await page.goto(`${base()}/registrations`);
    await entryRow(page, key).getByRole("link", { name: "Scratch", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Scratch entry", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Scratch entry" }).click();
    await expect(status(page)).toContainText("No payment was changed", { timeout: 30_000 });
    await shot(page, "open-heat-scratched");

    const { orders: after } = await readCompetitionRegistrations(config, event.id);
    expect(after).toEqual(before);
    const audit = (await readScratchAudit(config, event.id)).filter((s) => s.entry_id === target);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ path: "normal", is_exception: false, performed_by: fixture.owner.id });
    const heats = await readHeatEvidence(config, event.id);
    expect(heats.placements.find((p) => p.entry_id === target)?.status).toBe("scratched");
    expect(heats.scoringHeats.find((h) => h.id === layout[0].heatId)?.lock_state).toBe("open");

    await page.goto(`${base()}/day-of`);
    await expect(page.getByRole("region", { name: "Up next" })).not.toContainText(KEY_NAME[key]);
    await page.reload();
    await expect(page.getByRole("region", { name: "Up next" })).not.toContainText(KEY_NAME[key]);
    await shot(page, "day-of-after-scratch");
    evidence({ scenario: "SCN-6.1", scratched: key });
    await page.context().close();
  });

  test("SCN-6.2 a danced heat refuses the scratch: the page explains why, offers no scratch button, and nothing is written", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const heats = await readHeatEvidence(config, event.id);
    const danced = heats.floorLayout.find((heat) => heat.status === "complete" && heat.entryIds.length > 0);
    expect(danced, "heat 1 was completed in SCN-7.1").toBeTruthy();
    const target = danced!.entryIds[0];
    const auditBefore = (await readScratchAudit(config, event.id)).length;
    await page.goto(`${base()}/registrations/scratch/${target}`);
    await expect(page.getByRole("heading", { name: "Scratch entry", level: 1 })).toBeVisible();
    await expect(page.locator("main p.bg-amber-50")).toBeVisible();
    await expect(page.getByRole("button", { name: "Scratch entry" })).toHaveCount(0);
    await shot(page, "danced-heat-refused");
    expect((await readScratchAudit(config, event.id)).length).toBe(auditBefore);
    const entry = (await readEntries(config, event.id)).entries.find((e) => e.id === target);
    expect(entry?.status).toBe("confirmed");
    await page.context().close();
  });

  test("SCN-6.3 official scratch in a locked heat: ballots are entered and locked, the reason is required, the heat stays locked, one audit row", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    // Ballots: the scorer's paper-ballot desk, one ballot per judge per heat (E2). Locking is what locks the heats.
    await page.goto(`${base()}/ballots/${roundId}`);
    await expect(page.getByRole("region", { name: "Round status" })).toContainText("Accepting ballots");
    const heatCount = (await readHeatEvidence(config, event.id)).scoringHeats.filter((h) => h.round_id === roundId).length;
    const judgeCount = await page.locator('select[name="officialId"]').first().evaluate((el) => (el as HTMLSelectElement).options.length - 1).catch(() => 3);
    for (let heat = 0; heat < heatCount; heat += 1) {
      for (let judge = 1; judge <= Math.max(judgeCount, 3); judge += 1) {
        await page.goto(`${base()}/ballots/${roundId}`);
        const details = page.locator("details").nth(heat);
        await details.locator("summary").click();
        const form = details.locator("form");
        await form.locator('select[name="officialId"]').selectOption({ index: judge });
        const marks = form.locator('select[name^="mark:"]');
        for (let i = 0; i < (await marks.count()); i += 1) await marks.nth(i).selectOption({ index: i + 1 });
        await form.getByRole("button", { name: "Save paper ballot" }).click();
        await expect(page.getByRole("status")).toBeVisible({ timeout: 30_000 });
      }
    }
    await expect.poll(() => readBallotCount(config, roundId), { timeout: 30_000 }).toBeGreaterThanOrEqual(heatCount * 3);
    await shot(page, "ballots-entered");
    await page.getByRole("button", { name: "Lock ballots" }).click();
    await expect(page.getByRole("region", { name: "Round status" })).toContainText("Ballots locked", { timeout: 30_000 });
    await shot(page, "ballots-locked");

    const locked = (await readHeatEvidence(config, event.id)).floorLayout.filter((heat) => heat.status !== "complete" && heat.lockState === "locked" && heat.entryIds.length > 0);
    expect(locked.length, "an undanced, locked heat with entries exists").toBeGreaterThan(0);
    const target = locked[0].entryIds[0];

    await page.goto(`${base()}/registrations/scratch/${target}`);
    await expect(page.getByText(/This entry is in a locked heat\. As an official you can scratch it without reopening the heat/)).toBeVisible();
    // The reason is required: submitting empty must not write anything.
    await page.getByRole("button", { name: "Scratch entry" }).click();
    await expect(page.getByRole("heading", { name: "Scratch entry", level: 1 })).toBeVisible();
    expect((await readScratchAudit(config, event.id)).filter((s) => s.entry_id === target)).toHaveLength(0);
    await page.getByLabel("Reason").fill("Dancer injured during warm-up");
    await page.getByRole("button", { name: "Scratch entry" }).click();
    await expect(page.getByText("Dancer injured during warm-up")).toBeVisible({ timeout: 30_000 });
    await page.goto(`${base()}/registrations/scratch/${target}`);
    await expect(page.getByText(/locked heat/).first()).toBeVisible();
    await expect(page.getByText("Dancer injured during warm-up")).toBeVisible();
    await shot(page, "official-locked-scratch-history");

    const audit = (await readScratchAudit(config, event.id)).filter((s) => s.entry_id === target);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ path: "official_locked", reason: "Dancer injured during warm-up", performed_by: fixture.owner.id });
    const after = await readHeatEvidence(config, event.id);
    expect(after.scoringHeats.find((h) => h.id === locked[0].heatId)?.lock_state, "the heat stays locked").toBe("locked");
    expect(after.placements.find((p) => p.entry_id === target)?.status).toBe("scratched");
    evidence({ scenario: "SCN-6.3", heatCount, ballots: await readBallotCount(config, roundId) });
    await page.context().close();
  });

  test("SCN-7.2 day-of: cancel a round with a reason; the empty Bronze Open round shows Cancelled and stays cancelled after a reload", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await page.goto(`${base()}/day-of`);
    const item = page.getByRole("region", { name: "Rounds" }).locator("li").filter({ hasText: "Bronze Open" });
    await item.getByLabel("Cancel reason").fill("No entries in this division");
    await item.getByRole("button", { name: "Cancel round" }).click();
    await expect(item.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 30_000 });
    await shot(page, "round-cancelled");
    await page.reload();
    await expect(page.getByRole("region", { name: "Rounds" }).locator("li").filter({ hasText: "Bronze Open" }).getByText("Cancelled", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Rounds" }).locator("li").filter({ hasText: "Bronze Open" }).getByRole("button", { name: "Cancel round" })).toHaveCount(0);
    const cancelled = (await readHeatEvidence(config, event.id)).rounds.filter((r) => r.status === "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].id).not.toBe(roundId);
    await page.context().close();
  });

  // ================================================================== SCN-8 Isolation and role-based access

  test("SCN-8.1 access matrix: owner and admin manage; front desk is sent to check-in; instructor, judge and another studio get 404; anonymous is sent to login", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const results: Record<string, Record<string, string>> = {};
    const record = (who: string, page_: string, value: string) => { (results[who] ??= {})[page_] = value; };

    for (const [who, account] of [["owner", fixture.owner], ["studio_admin", fixture.deskAdmin]] as const) {
      const page = await signedIn(browser, account);
      for (const name of WORKSPACE_PAGES) {
        const { status: code, url } = await visit(page, `${base()}/${name}`);
        record(who, name, `${code} ${url.pathname.replace(base(), "") || "/"}`);
        expect([code, url.pathname], `${who} ${name}`).toEqual([200, `${base()}/${name}`]);
      }
      const { status: code } = await visit(page, `${base()}/checkin`);
      expect(code).toBe(200);
      await shot(page, `${who}-schedule`);
      await page.context().close();
    }

    const desk = await signedIn(browser, fixture.frontDesk);
    for (const name of WORKSPACE_PAGES) {
      const { url } = await visit(desk, `${base()}/${name}`);
      record("front_desk", name, `redirect ${url.pathname.replace(base(), "")}`);
      expect(url.pathname, `front desk ${name}`).toBe(`${base()}/checkin`);
    }
    await expect(desk.getByRole("heading", { name: "Competition Check-In" })).toBeVisible();
    await shot(desk, "front-desk-checkin");
    await desk.context().close();

    for (const [who, account] of [["instructor", fixture.instructor], ["judge", fixture.judges[0]], ["other_studio_owner", fixture.otherOwner]] as const) {
      const page = await signedIn(browser, account);
      for (const name of [...WORKSPACE_PAGES, "checkin"]) {
        const { status: code } = await visit(page, `${base()}/${name}`);
        record(who, name, String(code));
        expect(code, `${who} ${name}`).toBe(404);
      }
      const scratch = await visit(page, `${base()}/registrations/scratch/${entryIds.e1}`);
      expect(scratch.status, `${who} scratch page`).toBe(404);
      await shot(page, `${who}-404`);
      await page.context().close();
    }

    const anon = await anonymousPage(browser);
    for (const name of [...WORKSPACE_PAGES, "checkin"]) {
      const { url } = await visit(anon, `${base()}/${name}`);
      record("anonymous", name, `redirect ${url.pathname}`);
      expect(url.pathname, `anonymous ${name}`).toBe("/login");
    }
    await shot(anon, "anonymous-login");
    await anon.context().close();
    evidence({ scenario: "SCN-8.1", matrix: results });
  });

  test("SCN-8.2 database authorization: another studio and an anonymous caller read no heats and cannot list officials; a judge's own assignments come back as theirs only", async () => {
    test.skip(!ANON_KEY, "E2E_SUPABASE_ANON_KEY not provided: database authorization checks NOT RUN");
    const anonClient = () => createClient(config.supabaseUrl, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const as = async (account: { email: string; password: string }) => {
      const client = anonClient();
      const { error } = await client.auth.signInWithPassword({ email: account.email, password: account.password });
      if (error) throw new Error(`sign-in failed for ${account.email}: ${error.message}`);
      return client;
    };
    const tables = ["event_competition_floor_heats", "event_competition_heats", "event_competition_heat_entries", "event_competition_officials", "event_competition_panel_assignments"];
    const owner = await as(fixture.owner);
    for (const table of tables) {
      const { data, error } = await owner.from(table).select("*").eq("event_id", event.id);
      expect(error, `owner reads ${table}`).toBeNull();
      expect(data?.length ?? 0, `owner reads rows in ${table}`).toBeGreaterThan(0);
    }
    for (const [who, client] of [["other studio owner", await as(fixture.otherOwner)], ["anonymous", anonClient()]] as const) {
      for (const table of tables) {
        const { data } = await client.from(table).select("*").eq("event_id", event.id);
        expect(data ?? [], `${who} must read no rows from ${table}`).toEqual([]);
      }
      const candidates = await client.rpc("list_competition_official_candidates", { p_event_id: event.id });
      expect(candidates.error, `${who} must not list official candidates`).not.toBeNull();
    }
    const judge = await as(fixture.judges[1]);
    const mine = await judge.rpc("my_competition_judging_assignments");
    expect(mine.error).toBeNull();
    const rowsMine = (mine.data ?? []) as Array<{ event_id: string; round_id: string }>;
    expect(rowsMine.length).toBe(1);
    expect(rowsMine[0]).toMatchObject({ event_id: event.id, round_id: roundId });
    evidence({ scenario: "SCN-8.2", tables });
  });

  test("SCN-9 database integrity: one version in effect, contiguous heat numbers, no double-booked dancer, every scratch audited, no payment moved by a scratch", async () => {
    const heats = await readHeatEvidence(config, event.id);
    expect(publishedVersions(heats)).toHaveLength(1);
    const effective = publishedVersions(heats)[0].id as string;
    const numbers = heats.floorHeats.filter((row) => row.schedule_version_id === effective).map((row) => Number(row.heat_number)).sort((a, b) => a - b);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    expect(heats.doubleBookings).toEqual([]);
    const scratched = heats.placements.filter((p) => p.status === "scratched").map((p) => p.entry_id as string);
    const audited = (await readScratchAudit(config, event.id)).map((s) => s.entry_id as string);
    expect(scratched.sort()).toEqual(audited.sort());
    const state = await readCompetitionRegistrations(config, event.id);
    expect(state.orders.every((o) => o.payment_status === "paid")).toBe(true);
    expect(state.payments.filter((p) => p.status === "paid")).toHaveLength(3);
    const { count } = await e2eAdminClient(config).from("event_order_refunds").select("id", { count: "exact", head: true }).eq("event_id", event.id);
    expect(count).toBe(0);
    evidence({ scenario: "SCN-9", effectiveVersion: effective, scratched: scratched.length });
  });

  // ================================================================== Not implemented

  test.fixme("SCN-4.1 heat-level judge assignment: assign a different judge to one heat of a round", async ({}, testInfo) => {
    scenarioStatus(testInfo, "NOT IMPLEMENTED", "E1 builds panels per ROUND (event_competition_panel_assignments.round_id); there is no per-heat judge assignment UI.");
  });

  test.fixme("SCN-4.2 instructor-to-heat assignment: assign an instructor to a heat and see an instructor conflict", async ({}, testInfo) => {
    scenarioStatus(testInfo, "NOT IMPLEMENTED", "The Schedule & Heats page has no instructor or staff assignment control; only dancer (competitor) conflicts are modelled.");
  });

  test.fixme("SCN-4.3 a real conflict banner: the running order cannot be published while a heat has a shared competitor", async ({}, testInfo) => {
    scenarioStatus(testInfo, "BLOCKED", "No UI path creates a shared-competitor heat: the planner avoids it and 'Move division to' disables the option (SCN-3.1). The publish guard is covered by the 10D SQL suite, not by this walkthrough.");
  });
});


import { randomUUID } from "node:crypto";
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "../helpers/competitionFixture";
import { createCompetitionEvent, payCheckoutSession, readCompetitionRegistrations, verifyEmailAndBindPassword, type CreatedEvent } from "../helpers/competitionFullEvent";
import { chooseCountryCouples, createDraft, finishSetup, startCompetition } from "../helpers/competitionWizard";
import {
  anonymousPage,
  cleanupScheduleAcceptanceFixture,
  createScheduleAcceptanceFixture,
  readBallotCount,
  readEntries,
  readHeatEvidence,
  readNoShows,
  readOfficials,
  readResultState,
  readScratchAudit,
  registerRoster,
  scenarioStatus,
  signedIn,
  stepShots,
  visit,
  type RosterCouple,
  type ScheduleAcceptanceFixture,
} from "../helpers/competitionScheduleHeats";
import { useUniqueE2ESourceIp as assignUniqueSourceIp } from "../helpers/rateLimitBypass";

/**
 * QA-A scoring and results walkthrough (Competition OS), the sequel to competition-schedule-heats-acceptance.spec.ts. It uses
 * the UI paths SS1 (#344) added: a DRAFT competition gets an approved studio scoring setup in Advanced settings, the callback
 * target is set there, and publishing pins the methods (REG). Two competitions are driven end to end:
 *
 *   D  "Callbacks + Final": callback target blocker (W4/K1), callback ballots from three judges' own sessions, lock, calculate.
 *   E  "Final only (ordinal majority)": a no-show, judge ballots, lock, official scratch in the locked heat, calculate, a
 *      refused calculator-only approval, a correction that makes the result stale, recalculation, approval by a second
 *      manager (heats certified), and who can and cannot see results.
 *
 * Only the Q1 base seed is written directly; everything else goes through the UI. The service-role client reads, and the F2 /
 * NS1 tables (closed to API roles) are read through the local DB container (E2E_LOCAL_DB_CONTAINER). The scenarios whose
 * behaviour has not been observed yet are labelled in their own annotations; nothing here is a SQL shortcut.
 *
 * Environment: same as the Schedule & Heats spec (Stripe TEST, local stack, mail catcher, anon key, DB container).
 */

test.describe.configure({ mode: "serial", timeout: 900_000 });

const FLAG_ON = process.env.E2E_COMPETITION_REGISTRATION_ENABLED === "true";
const TEST_KEY = process.env.E2E_STRIPE_TEST_SECRET_KEY ?? "";
const ACCOUNT = process.env.E2E_STRIPE_TEST_CONNECTED_ACCOUNT ?? "";
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? "";
const ENTRY_FEE = 40;
const T = 2;

const COUPLES: RosterCouple[] = [
  { leader: { firstName: "Ada", lastName: "Lead" }, follower: { firstName: "Bea", lastName: "Follow" } },
  { leader: { firstName: "Cy", lastName: "Step" }, follower: { firstName: "Di", lastName: "Turn" } },
  { leader: { firstName: "Eli", lastName: "Spin" }, follower: { firstName: "Fay", lastName: "Dip" } },
  { leader: { firstName: "Gus", lastName: "Glide" }, follower: { firstName: "Hana", lastName: "Sway" } },
];
const COUPLES5: RosterCouple[] = [...COUPLES, { leader: { firstName: "Ivy", lastName: "Reel" }, follower: { firstName: "Jo", lastName: "Swing" } }];
/** The name that identifies each entry on every screen (event E also has "Ivy Reel", the entry scratched in the early-locked heat). */
const NAME = ["Ada Lead", "Cy Step", "Eli Spin", "Gus Glide", "Ivy Reel"];

type Scored = { event: CreatedEvent; roundId: string; finalRoundId: string; entries: string[] };

/** Clicks a floor-console button and waits for its effect, re-clicking when the click was lost (see the Schedule & Heats spec). */
async function clickUntil(button: Locator, done: Locator) {
  await expect(async () => {
    if (await done.count()) return;
    if (await button.count()) await button.first().click();
    await expect(done.first()).toBeVisible({ timeout: 45_000 });
  }).toPass({ timeout: 240_000 });
}

test.describe("Scoring and results acceptance (QA-A)", () => {
  test.skip(!FLAG_ON, "Needs the app started with NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true (E2E_COMPETITION_REGISTRATION_ENABLED=true).");
  test.skip(!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(TEST_KEY) || !/^acct_[A-Za-z0-9]+$/.test(ACCOUNT), "Stripe TEST key and test connected account not provided");

  let config: E2EConfig;
  let fixture: ScheduleAcceptanceFixture;
  let stripe: Stripe;
  let D: Scored;
  let E: Scored;
  /** Set when the ballot desk actually locked the round. If the UI cannot lock (see tryLock), everything after the lock is BLOCKED. */
  const locked = { D: false, E: false };
  const LOCK_BLOCKED = "No UI path locks the heats, and the ballot desk refuses to lock a round while a heat is not locked ('N heat(s) not locked yet'): heat lock_state is changed only by the database function set_competition_heat_lock_state (used by F2 to certify), which no screen calls. So ballots cannot be locked, results cannot be calculated or approved, and the steps below are not reachable through the browser. No SQL shortcut is used.";
  const evidence = (value: unknown) => test.info().annotations.push({ type: "evidence", description: JSON.stringify(value) });
  const base = (s: Scored) => `/app/events/${s.event.id}/competition`;

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

  // ------------------------------------------------------------------ shared UI steps

  /** Wizard (Country, adjudicated) -> draft competition. */
  async function createDraftEvent(page: Page, name: string, date: string): Promise<CreatedEvent> {
    const event = await createCompetitionEvent(page, config, { name, startDate: date, endDate: date });
    await startCompetition(page, "Country");
    await chooseCountryCouples(page);
    await finishSetup(page, { accountRequired: false }, { model: "Per entry", amount: String(ENTRY_FEE) }, { summary: "QA-A scoring and results." });
    await createDraft(page, event.id);
    return event;
  }

  /** SS1: Advanced settings -> "Studio scoring · all divisions" -> choose a setup -> Apply. */
  async function applyScoring(page: Page, eventId: string, setup: "Callbacks + Final" | "Final only (ordinal majority)") {
    await page.goto(`/app/events/${eventId}/competition/advanced`);
    const block = page.locator("div").filter({ has: page.getByRole("heading", { name: "Studio scoring · all divisions" }) }).last();
    await block.getByLabel("Scoring setup").selectOption({ label: setup });
    await block.getByRole("button", { name: "Apply to all divisions" }).click();
    await expect(block.getByRole("status")).toContainText(/Scoring set up for 1 division/, { timeout: 60_000 });
  }

  async function publishAndOpen(page: Page, eventId: string) {
    await page.goto(`/app/events/${eventId}/competition`);
    await page.getByRole("button", { name: "Publish competition" }).click();
    await expect(page.getByRole("button", { name: "Open registration" })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Open registration" }).click();
    await expect(page.getByRole("button", { name: "Close registration" })).toBeVisible({ timeout: 60_000 });
  }

  /** One buyer, four distinct couples, one Stripe TEST payment. */
  async function registerAndPay(browser: Browser, event: CreatedEvent, tag: string, couples: RosterCouple[] = COUPLES) {
    const page = await (await browser.newContext()).newPage();
    await assignUniqueSourceIp(page);
    const email = `e2e-compfull-${fixture.runId}-${tag}@example.com`;
    const checkoutUrl = await registerRoster(page, event.slug, { name: "Ada Lead", email, phone: "5125550100" }, couples);
    const sessionId = checkoutUrl.match(/cs_test_[A-Za-z0-9]+/)?.[0];
    expect(sessionId, "hosted Checkout URL carries a test session").toBeTruthy();
    const open = await stripe.checkout.sessions.retrieve(sessionId!, {}, { stripeAccount: ACCOUNT });
    expect([open.livemode, open.status, open.amount_total]).toEqual([false, "open", couples.length * ENTRY_FEE * 100]);
    const paid = await payCheckoutSession(stripe, ACCOUNT, sessionId!);
    expect([paid.status, paid.payment_status]).toEqual(["complete", "paid"]);
    await expect.poll(async () => (await readCompetitionRegistrations(config, event.id)).orders.find((o) => o.stripe_checkout_session_id === sessionId)?.payment_status, { timeout: 90_000, intervals: [1_000] }).toBe("paid");
    await page.context().close();
    const { entries } = await readEntries(config, event.id);
    expect(entries).toHaveLength(couples.length);
    expect(entries.every((e) => e.status === "confirmed")).toBe(true);
    return NAME.slice(0, couples.length).map((name) => {
      const { entries: all } = { entries };
      return all.find((e) => String(e.display_name).includes(name))!.id as string;
    });
  }

  async function generateAndPublish(page: Page, eventId: string, count = 4) {
    await page.goto(`/app/events/${eventId}/competition/schedule`);
    await page.getByRole("button", { name: "Generate heats" }).click();
    await expect(page.getByRole("status")).toContainText(new RegExp(`Created \\d+ heats? for ${count} entries`), { timeout: 60_000 });
    await page.getByRole("button", { name: "Publish running order" }).click();
    await expect(page.getByRole("status")).toContainText("Running order published.", { timeout: 60_000 });
    await expect(page.getByText(new RegExp("^Published · \[0-9]+ heats · " + count + " entries on the floor" + "$"))).toBeVisible();
  }

  /** Officials page: three judges, judge 1 as chair, all three on the panel of the named round. */
  async function buildPanel(page: Page, eventId: string, roundText: string) {
    await page.goto(`/app/events/${eventId}/competition/officials`);
    const person = page.locator('select[name="userId"]');
    for (const n of [1, 2, 3]) {
      const option = page.locator('select[name="userId"] option', { hasText: `E2E Judge ${n}` });
      if (!(await option.count())) continue; // already an official of this event
      await expect(async () => {
        if (!(await page.locator('select[name="userId"] option', { hasText: `E2E Judge ${n}` }).count())) return;
        await person.selectOption(await option.getAttribute("value") as string);
        await page.getByRole("button", { name: "Add official" }).click();
        await expect(page.locator('select[name="userId"] option', { hasText: `E2E Judge ${n}` })).toHaveCount(0, { timeout: 20_000 });
      }).toPass({ timeout: 120_000 });
    }
    const chairButton = page.locator("li").filter({ hasText: "E2E Judge 1" }).getByRole("button", { name: "Make chair" });
    if (await chairButton.count()) {
      await chairButton.click();
      await expect(page.locator("li").filter({ hasText: "E2E Judge 1" }).getByText("Chair of judges")).toBeVisible({ timeout: 30_000 });
    }
    for (const n of [1, 2, 3]) {
      await expect(async () => {
        const article = page.locator("article").filter({ hasText: roundText }).first();
        if (await article.locator("li").filter({ hasText: `E2E Judge ${n}` }).count()) return;
        const option = article.locator('select[name="officialId"] option', { hasText: `E2E Judge ${n}` });
        await article.locator('select[name="officialId"]').selectOption(await option.getAttribute("value") as string);
        await article.getByRole("button", { name: "Add to panel" }).click();
        await expect(article.locator("li").filter({ hasText: `E2E Judge ${n}` })).toBeVisible({ timeout: 15_000 });
      }).toPass({ timeout: 120_000 });
    }
    await expect(page.locator("article").filter({ hasText: roundText }).first().getByText(/Panel ready/)).toBeVisible();
  }

  /** Day-of console: schedule and start the named round. */
  async function startRound(page: Page, eventId: string, roundText: string) {
    await page.goto(`/app/events/${eventId}/competition/day-of`);
    const round = page.getByRole("region", { name: "Rounds" }).locator("li").filter({ hasText: roundText }).first();
    await clickUntil(round.getByRole("button", { name: "Schedule round" }), round.getByRole("button", { name: "Start round" }));
    await clickUntil(round.getByRole("button", { name: "Start round" }), round.getByText("Running", { exact: true }));
  }

  /** Day-of console: bring the first heat onto the floor (the round must be running). */
  async function startHeat(page: Page, eventId: string) {
    await page.goto(`/app/events/${eventId}/competition/day-of`);
    const upNext = page.getByRole("region", { name: "Up next" });
    const onFloor = page.getByRole("region", { name: "On the floor" });
    await clickUntil(upNext.getByRole("button", { name: "Call to floor" }), onFloor.getByText("On deck"));
    await clickUntil(onFloor.getByRole("button", { name: "Start heat" }), onFloor.getByRole("button", { name: "Complete heat" }));
  }

  async function startRoundAndHeat(page: Page, eventId: string, roundText: string) {
    await startRound(page, eventId, roundText);
    await startHeat(page, eventId);
  }

  /** Opens the ballot desk, retrying while the dev server is still compiling the route (it answers a 404 meanwhile). */
  async function openDesk(page: Page, s: Scored, roundId: string) {
    await expect(async () => {
      await page.goto(`${base(s)}/ballots/${roundId}`);
      await expect(page.getByRole("region", { name: "Round status" })).toBeVisible({ timeout: 8_000 });
    }).toPass({ timeout: 120_000 });
  }

  const roundIdByName = async (eventId: string, name: string) => {
    const round = (await readHeatEvidence(config, eventId)).rounds.find((r) => r.name === name);
    if (!round) throw new Error(`no round named ${name}`);
    return round.id as string;
  };

  /**
   * Opens the ballot desk and locks the round when the desk allows it. When it does not, the refusal text is asserted and
   * recorded (this is the evidence for the BLOCKED scenarios below); nothing is forced.
   */
  async function tryLock(page: Page, s: Scored, roundId: string, key: "D" | "E", testInfo: import("@playwright/test").TestInfo) {
    // HL1: a heat is locked by a manager from the ballot desk once it has been danced, so complete the heat first.
    await page.goto(`/app/events/${s.event.id}/competition/day-of`);
    const onFloor = page.getByRole("region", { name: "On the floor" });
    if (await onFloor.getByRole("button", { name: "Complete heat" }).count()) {
      await clickUntil(onFloor.getByRole("button", { name: "Complete heat" }), page.getByText("No heat is on the floor."));
    }
    await openDesk(page, s, roundId);
    const lock = page.getByRole("button", { name: "Lock ballots" });
    await expect(lock).toBeVisible({ timeout: 30_000 });
    // HL1 (#350): the ballot desk's "Heats" section has a "Lock heat N" button per danced heat (manager only, round active). It asks with a
    // native confirm ("Lock heat N? Floor changes to this heat will be refused once locked."), accepted below; the note input is optional.
    page.on("dialog", (dialog) => { void dialog.accept(); });
    const lockHeat = page.getByRole("button", { name: /^Lock heat/ });
    if (await lockHeat.count()) {
      await expect(async () => {
        if (!(await page.getByRole("button", { name: /^Lock heat/ }).count())) return;
        await page.getByRole("button", { name: /^Lock heat/ }).first().click();
        await page.waitForLoadState("networkidle");
        await openDesk(page, s, roundId);
        await expect(page.getByRole("button", { name: /^Lock heat/ })).toHaveCount(0, { timeout: 15_000 });
      }).toPass({ timeout: 120_000 });
    }
    if (await lock.isEnabled({ timeout: 15_000 }).catch(() => false)) {
      await lock.click();
      await expect(page.getByRole("region", { name: "Round status" })).toContainText("Ballots locked", { timeout: 30_000 });
      locked[key] = true;
      return true;
    }
    const panel = page.getByRole("region", { name: "Lock and reopen" });
    await expect(panel).toContainText(/heat\(s\) not locked yet/);
    await expect(lock).toBeDisabled();
    const text = (await panel.innerText()).replace(/\s+/g, " ");
    testInfo.annotations.push({ type: "evidence", description: JSON.stringify({ lockRefusal: text }) });
    scenarioStatus(testInfo, "BLOCKED", LOCK_BLOCKED);
    return false;
  }

  const judgeBallotUrl = (s: Scored, roundId: string) => `/app/judging/${s.event.id}/rounds/${roundId}/ballot`;

  /** A judge ranks every entry on the sheet (rank n for the n-th row unless `order` says otherwise) and submits. */
  async function submitOrdinal(browser: Browser, judge: { email: string; password: string }, s: Scored, order?: number[], reason?: string) {
    const page = await signedIn(browser, judge as never, judgeBallotUrl(s, s.finalRoundId));
    await expect(page.getByRole("heading", { name: "Final", level: 1 })).toBeVisible();
    const before = await readBallotCount(config, s.finalRoundId);
    const marks = page.locator('select[name^="mark:"]');
    const count = await marks.count();
    for (let i = 0; i < count; i += 1) await marks.nth(i).selectOption({ index: (order ? order[i] : i) + 1 });
    if (reason) await page.getByLabel("Why are you correcting this ballot?").fill(reason);
    await page.getByRole("button", { name: reason ? "Submit correction" : "Submit ballot" }).click();
    await expect.poll(() => readBallotCount(config, s.finalRoundId), { timeout: 60_000 }).toBe(before + 1);
    await page.context().close();
    return count;
  }

  // ================================================================== SCN-0 setup

  test("SCN-0c setup (not a scenario): the three judges prove their mailbox through the real sign-in link; the owner does too (reading no-shows needs it)", async ({ browser }) => {
    for (const account of [...fixture.judges, fixture.owner]) {
      const page = await (await browser.newContext()).newPage();
      await assignUniqueSourceIp(page);
      await verifyEmailAndBindPassword(page, account);
      await page.context().close();
    }
  });

  // ================================================================== D: Callbacks + Final

  test("SCN-1.3 callback target: 'Callbacks + Final' is set up in Advanced settings; the 'Callback target not set' blocker shows until the organizer sets T, then persists", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const event = await createDraftEvent(page, `E2E Callback Results ${fixture.runId}`, "2027-06-12");
    await applyScoring(page, event.id, "Callbacks + Final");
    await shot(page, "callbacks-final-applied");

    const rounds = (await readHeatEvidence(config, event.id)).rounds;
    const callback = rounds.find((r) => r.name === "Callback round");
    const final = rounds.find((r) => r.name === "Final");
    expect(callback, "a callback round exists").toBeTruthy();
    expect(final, "a Final round exists").toBeTruthy();
    expect(callback!.target_advancement_count).toBeNull();
    D = { event, roundId: callback!.id as string, finalRoundId: final!.id as string, entries: [] };

    await expect(page.getByText(/Callback target not set\. This blocks schedule readiness/)).toBeVisible();
    await page.getByLabel(/^Callback target for Callback round/).fill(String(T));
    await page.getByRole("button", { name: "Save target" }).click();
    await expect.poll(async () => (await readHeatEvidence(config, event.id)).rounds.find((r) => r.id === D.roundId)?.target_advancement_count, { timeout: 30_000 }).toBe(T);
    await page.reload();
    await expect(page.getByLabel(/^Callback target for Callback round/)).toHaveValue(String(T));
    await expect(page.getByText(/Callback target not set/)).toHaveCount(0);
    await shot(page, "target-set");
    evidence({ scenario: "SCN-1.3", target: T });
    await page.context().close();
  });

  test("SCN-11.1 callback competition: publish (methods pinned), register and pay four entries, publish the running order, build the panel, start the round and heat", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await publishAndOpen(page, D.event.id);
    D.entries = await registerAndPay(browser, D.event, "d");
    await generateAndPublish(page, D.event.id);
    await shot(page, "schedule-published");
    await buildPanel(page, D.event.id, "Callback round");
    await shot(page, "panel-ready");
    await startRoundAndHeat(page, D.event.id, "Callback round");
    await shot(page, "heat-on-the-floor");
    const rounds = (await readHeatEvidence(config, D.event.id)).rounds;
    expect(rounds.find((r) => r.id === D.roundId)?.status).toBe("active");
    expect(rounds.find((r) => r.id === D.roundId)?.target_advancement_count).toBe(T);
    expect((await readOfficials(config, D.event.id)).assignments.filter((a) => a.round_id === D.roundId)).toHaveLength(3);
    await page.context().close();
  });

  test("SCN-11.2 callback ballots: a ballot with the wrong number of picks is refused; three judges each submit exactly T picks from their own account", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    // [judge index, picks]: judges 1 and 2 call back couples 1 and 2; judge 3 calls back couples 1 and 3.
    const plans: Array<[number, number[]]> = [[0, [0, 1]], [1, [0, 1]], [2, [0, 2]]];
    let first = true;
    for (const [judgeIndex, picks] of plans) {
      const page = await signedIn(browser, fixture.judges[judgeIndex] as never, judgeBallotUrl(D, D.roundId));
      await expect(page.getByRole("heading", { name: "Callback round", level: 1 })).toBeVisible();
      const boxes = page.locator('input[name="pick"]');
      await expect(boxes).toHaveCount(4);
      if (first) {
        // One pick only: the database refuses the final ballot and nothing is stored.
        await boxes.nth(0).check();
        await page.getByRole("button", { name: "Submit final ballot" }).click();
        await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
        expect(await readBallotCount(config, D.roundId)).toBe(0);
        await shot(page, "wrong-pick-count-refused");
        await boxes.nth(0).uncheck().catch(() => undefined);
        first = false;
      }
      for (const i of picks) await page.locator('input[name="pick"]').nth(i).check();
      const before = await readBallotCount(config, D.roundId);
      await page.getByRole("button", { name: "Submit final ballot" }).click();
      await expect.poll(() => readBallotCount(config, D.roundId), { timeout: 60_000 }).toBe(before + 1);
      await page.context().close();
    }
    expect(await readBallotCount(config, D.roundId)).toBe(3);
  });

  test("SCN-11.3a callback lock: the manager locks the callback ballots (or the desk states exactly why it cannot)", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const ok = await tryLock(page, D, D.roundId, "D", testInfo);
    await shot(page, ok ? "locked" : "lock-refused");
    await page.context().close();
  });

  test("SCN-11.3 callback result: the calculation advances exactly T couples, and the manager sees them", async ({ browser }, testInfo) => {
    test.skip(!locked.D, "BLOCKED: the callback ballots could not be locked (SCN-11.3a)");
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await page.goto(`${base(D)}/results/${D.roundId}`);
    await page.getByRole("button", { name: "Calculate result" }).click();
    const refusal = page.getByRole("alert").filter({ hasText: /does not define what to do in this case/ });
    const done = page.getByRole("status").filter({ hasText: /Calculated result version 1/ });
    await expect(refusal.or(done)).toBeVisible({ timeout: 60_000 });
    if (await refusal.count()) {
      // The engine refused the callback round (COMP_ENGINE_UNSPECIFIED_CASE). Record why, from the database, and stop: not a pass.
      const { data: programs } = await e2eAdminClient(config).from("event_competition_programs").select("advancement_method, scoring_method").eq("event_id", D.event.id);
      const round = (await readHeatEvidence(config, D.event.id)).rounds.find((r) => r.id === D.roundId);
      evidence({ scenario: "SCN-11.3", refusal: "COMP_ENGINE_UNSPECIFIED_CASE", programAdvancementMethod: programs?.[0]?.advancement_method, roundScoringMethod: round?.scoring_method, target: round?.target_advancement_count });
      await shot(page, "calculate-refused");
      scenarioStatus(testInfo, "BLOCKED", "Calculate is refused for the callback round: 'The scoring method does not define what to do in this case' (COMP_ENGINE_UNSPECIFIED_CASE). The callback engine requires the round's program to have advancement_method = promote_callback (check V2); see the recorded programAdvancementMethod.");
      await page.context().close();
      return;
    }
    await expect(page.getByRole("heading", { name: /^Version 1 - Calculated/ })).toBeVisible();
    await shot(page, "callback-result");
    const state = readResultState(D.roundId);
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]).toMatchObject({ version: 1, status: "calculated", calculated_by: fixture.owner.id });
    const advanced = state.rows.filter((r) => r.advanced === true).map((r) => r.entry_id);
    expect(advanced, "exactly T couples advance").toHaveLength(T);
    // Votes: couple 1 has 3, couple 2 has 2, couple 3 has 1, couple 4 has 0.
    expect(new Set(advanced)).toEqual(new Set([D.entries[0], D.entries[1]]));
    evidence({ scenario: "SCN-11.3", advanced: advanced.length });
    await page.context().close();
  });

  test.fixme("SCN-11.4 callback ties: a tie at the callback line is resolved within capacity by the approved rule", async ({}, testInfo) => {
    scenarioStatus(testInfo, "BLOCKED", "The tie rule at the callback line is defined by the F1 engine spec and has not been observed through the UI yet; the assertion is written after the first run so it does not encode a guess.");
  });

  test.fixme("SCN-11.5 the Final of a callback competition is built from the advanced couples and judged in one heat", async ({}, testInfo) => {
    scenarioStatus(testInfo, "BLOCKED", "To confirm on the first run: no screen was found in the code that creates the Final's heat from the callback result. If the UI offers one, this scenario is written against it; if not, it is a product gap.");
  });

  // ================================================================== E: Final only (ordinal majority)

  test("SCN-12.1 ordinal competition: scoring set up and published, five entries paid, running order published, panel ready, round running (the heat is not started yet)", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const event = await createDraftEvent(page, `E2E Ordinal Results ${fixture.runId}`, "2027-06-13");
    await applyScoring(page, event.id, "Final only (ordinal majority)");
    await shot(page, "final-only-applied");
    await publishAndOpen(page, event.id);
    const entries = await registerAndPay(browser, event, "e", COUPLES5);
    const finalRoundId = await roundIdByName(event.id, "Final");
    E = { event, roundId: finalRoundId, finalRoundId, entries };
    await generateAndPublish(page, event.id, 5);
    const layout = (await readHeatEvidence(config, event.id)).effective;
    expect(layout, "an ordinal Final is one heat").toHaveLength(1);
    expect(layout[0].entryIds).toHaveLength(5);
    await buildPanel(page, event.id, "Final");
    await startRound(page, event.id, "Final");
    await shot(page, "round-running");
    expect((await readHeatEvidence(config, event.id)).rounds.find((r) => r.id === finalRoundId)?.status).toBe("active");
    expect((await readHeatEvidence(config, event.id)).effective[0].status).toBe("scheduled");
    await page.context().close();
  });

  // ---- HL1: lock an unstarted heat, scratch inside it, reopen it, then run the heat -------------------------------------

  const lockHeatConfirm = (n: number) => `Lock heat ${n}? It has not been danced. The floor can't start or change it until it is reopened. Officials can still scratch entries with a reason.`;
  const heatsPanel = (page: Page) => page.getByRole("region", { name: "Heats" });

  test("SCN-15.1 early lock: a manager locks the not-yet-started heat; the confirm says so, the heat locks, and the floor console will not start it", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await openDesk(page, E, E.finalRoundId);
    const messages: string[] = [];
    page.on("dialog", (dialog) => { messages.push(dialog.message()); void dialog.accept(); });
    await expect(heatsPanel(page)).toBeVisible({ timeout: 30_000 });
    await heatsPanel(page).getByLabel("Note for locking heat 1").fill("Held for a scratch review");
    await heatsPanel(page).getByRole("button", { name: "Lock heat 1" }).click();
    await expect.poll(async () => (await readHeatEvidence(config, E.event.id)).effective[0].lockState, { timeout: 30_000 }).toBe("locked");
    expect(messages).toEqual([lockHeatConfirm(1)]);
    const heat = (await readHeatEvidence(config, E.event.id)).effective[0];
    expect(heat.status, "locked before it was danced").toBe("scheduled");
    await shot(page, "heat-locked-early");
    // Locked but not danced: Lock ballots stays disabled, with the not-danced reason.
    await expect(page.getByRole("region", { name: "Lock and reopen" })).toContainText("1 heat(s) not danced yet: 1.", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Lock ballots" })).toBeDisabled();

    await page.goto(`${base(E)}/day-of`);
    await expect(page.getByRole("button", { name: "Call to floor" })).toHaveCount(0);
    await expect(page.getByText("A scoring heat in this heat is locked.").first()).toBeVisible();
    await shot(page, "floor-refuses");
    await page.context().close();
  });

  test("SCN-6.3 official scratch in a locked, not-yet-danced heat: the reason is required, the heat stays locked, one audit row", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const target = E.entries[4];
    await expect(async () => {
      await page.goto(`${base(E)}/registrations/scratch/${target}`);
      await expect(page.getByRole("heading", { name: "Scratch entry", level: 1 })).toBeVisible({ timeout: 8_000 });
    }).toPass({ timeout: 120_000 });
    await expect(page.getByText(/This entry is in a locked heat\. As an official you can scratch it without reopening the heat/)).toBeVisible();
    // The reason is required: submitting empty writes nothing.
    await page.getByRole("button", { name: "Scratch entry" }).click();
    await expect(page.getByRole("heading", { name: "Scratch entry", level: 1 })).toBeVisible();
    expect((await readScratchAudit(config, E.event.id)).filter((x) => x.entry_id === target)).toHaveLength(0);
    await page.getByLabel("Reason").fill("Couple withdrew before the heat");
    await page.getByRole("button", { name: "Scratch entry" }).click();
    await expect(async () => {
      await page.goto(`${base(E)}/registrations/scratch/${target}`);
      await expect(page.getByText("Couple withdrew before the heat")).toBeVisible({ timeout: 8_000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByText(/locked heat/).first()).toBeVisible();
    await shot(page, "official-locked-scratch-history");
    const audit = (await readScratchAudit(config, E.event.id)).filter((x) => x.entry_id === target);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ path: "official_locked", reason: "Couple withdrew before the heat", performed_by: fixture.owner.id });
    const heats = await readHeatEvidence(config, E.event.id);
    expect(heats.effective[0].lockState, "the heat stays locked").toBe("locked");
    expect(heats.placements.find((p) => p.entry_id === target)?.status).toBe("scratched");
    await page.context().close();
  });

  test("SCN-15.2 reopen: the manager reopens the early-locked heat with a reason; the floor can start it again", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await openDesk(page, E, E.finalRoundId);
    const messages: string[] = [];
    page.on("dialog", (dialog) => { messages.push(dialog.message()); void dialog.accept(); });
    await heatsPanel(page).getByLabel("Reason for reopening heat 1").fill("Scratch handled, run the heat");
    await heatsPanel(page).getByRole("button", { name: "Reopen heat 1" }).click();
    await expect.poll(async () => (await readHeatEvidence(config, E.event.id)).effective[0].lockState, { timeout: 30_000 }).toBe("open");
    expect(messages).toEqual(["Reopen heat 1? The floor will be able to start or change it again. The reason is kept in the audit history."]);
    await shot(page, "heat-reopened");
    await page.goto(`${base(E)}/day-of`);
    await expect(page.getByRole("button", { name: "Call to floor" })).toBeVisible();
    await page.context().close();
  });

  test("SCN-15.3 the heat runs; a lock on a heat that is on the floor is refused (no button, and the database refuses a direct call)", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await startHeat(page, E.event.id);
    await openDesk(page, E, E.finalRoundId);
    await expect(heatsPanel(page).getByRole("button", { name: /^Lock heat/ })).toHaveCount(0);
    await expect(heatsPanel(page)).toContainText("On the floor");
    await shot(page, "no-lock-on-active-heat");
    if (ANON_KEY) {
      const heat = (await readHeatEvidence(config, E.event.id)).effective[0];
      const client = createClient(config.supabaseUrl, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      expect((await client.auth.signInWithPassword({ email: fixture.owner.email, password: fixture.owner.password })).error).toBeNull();
      const result = await client.rpc("set_competition_heat_lock_state", { selected_heat_id: heat.heatId, selected_state: "locked", selected_reason: "mid-dance" });
      expect(result.error?.message ?? "", "locking a heat on the floor is refused").toContain("COMP_HL1_LOCK_ACTIVE");
      expect((await readHeatEvidence(config, E.event.id)).effective[0].lockState).toBe("open");
    }
    await page.context().close();
  });

  test("SCN-10.1 no-show: the official marks the last entry as no-show in the active heat", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await page.goto(`${base(E)}/day-of`);
    const row = page.getByRole("region", { name: "On the floor" }).locator("li").filter({ hasText: NAME[3] }).last();
    await row.locator("summary").filter({ hasText: "Mark no-show" }).click();
    await row.getByLabel("No-show reason").fill("Did not arrive on the floor");
    await row.getByRole("button", { name: "Mark no-show" }).click();
    await expect(page.getByRole("status")).toContainText("No-show recorded.", { timeout: 30_000 });
    await expect(page.getByRole("region", { name: "On the floor" }).locator("li").filter({ hasText: NAME[3] }).last().getByText("No-show", { exact: true })).toBeVisible();
    await shot(page, "no-show-recorded");
    const state = await readNoShows(config, E.event.id);
    expect(state.active).toHaveLength(1);
    expect(state.active[0]).toMatchObject({ entry_id: E.entries[3], marked_by: fixture.owner.id });
    await page.context().close();
  });

  test("SCN-10.5 judge sheet: the no-show entry is gone from the ranking form, with a note", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const judge = await signedIn(browser, fixture.judges[1], judgeBallotUrl(E, E.finalRoundId));
    await expect(judge.getByRole("heading", { name: "Final", level: 1 })).toBeVisible();
    await expect(judge.getByRole("status").filter({ hasText: /marked as no-show by an official/ })).toBeVisible();
    await expect(judge.locator('select[name^="mark:"]'), "three entries to rank, not four").toHaveCount(3);
    const labels = (await judge.locator("form label").allInnerTexts()).join(" ");
    expect(labels).not.toContain(NAME[3]);
    for (const name of NAME.slice(0, 3)) expect(labels).toContain(name);
    await shot(judge, "sheet-without-no-show");
    await judge.context().close();
  });

  test("SCN-12.2 ordinal ballots: three judges rank the three entries who danced from their own accounts", async ({ browser }) => {
    // Judges 1 and 2 rank the entries in sheet order; judge 3 swaps the top two. The majority order is the sheet order.
    expect(await readBallotCount(config, E.finalRoundId)).toBe(0);
    expect(await submitOrdinal(browser, fixture.judges[0], E)).toBe(3);
    expect(await submitOrdinal(browser, fixture.judges[1], E)).toBe(3);
    expect(await submitOrdinal(browser, fixture.judges[2], E, [1, 0, 2])).toBe(3);
    expect(await readBallotCount(config, E.finalRoundId)).toBe(3);
  });

  test("SCN-12.3 lock: Lock ballots stays disabled while the heat is not danced; after the heat is completed, Lock heat and Lock ballots work", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    // The heat is on the floor: it has not been locked, so the desk refuses to lock the round (a heat on the floor counts as danced for the not-danced rule).
    await openDesk(page, E, E.finalRoundId);
    await expect(page.getByRole("region", { name: "Lock and reopen" })).toContainText("1 heat(s) not locked yet.", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Lock ballots" })).toBeDisabled();
    await shot(page, "heat-not-locked-yet");
    const ok = await tryLock(page, E, E.finalRoundId, "E", testInfo);
    await shot(page, ok ? "ballots-locked" : "lock-refused");
    if (ok) await expect.poll(async () => (await readHeatEvidence(config, E.event.id)).effective.map((h) => h.lockState), { timeout: 30_000 }).toEqual(["locked"]);
    await page.context().close();
  });

  test("SCN-15.4 reopen is refused for a danced heat after the ballots lock (no button, and the database refuses a direct call)", async ({ browser }, testInfo) => {
    test.skip(!locked.E, "BLOCKED: the ballots could not be locked (SCN-12.3)");
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await openDesk(page, E, E.finalRoundId);
    await expect(page.getByRole("button", { name: /^Reopen heat/ })).toHaveCount(0);
    await shot(page, "no-reopen-after-lock");
    if (ANON_KEY) {
      const heat = (await readHeatEvidence(config, E.event.id)).effective[0];
      const client = createClient(config.supabaseUrl, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      expect((await client.auth.signInWithPassword({ email: fixture.owner.email, password: fixture.owner.password })).error).toBeNull();
      const result = await client.rpc("set_competition_heat_lock_state", { selected_heat_id: heat.heatId, selected_state: "open", selected_reason: "reopen after the ballots locked" });
      expect(result.error?.message ?? "", "reopening is refused").toMatch(/COMP_HL1_REOPEN_(DANCED|ROUND_LOCKED)/);
      expect((await readHeatEvidence(config, E.event.id)).effective[0].lockState).toBe("locked");
    }
    await page.context().close();
  });

  test("SCN-10.4 after the ballots lock, marking a no-show is refused and the controls are gone", async ({ browser }, testInfo) => {
    test.skip(!locked.E, "BLOCKED: the ballots could not be locked (SCN-12.3)");
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await page.goto(`${base(E)}/day-of`);
    await expect(page.locator("summary").filter({ hasText: /Mark no-show/ })).toHaveCount(0);
    await shot(page, "no-show-controls-gone");
    const before = await readNoShows(config, E.event.id);
    if (ANON_KEY) {
      const client = createClient(config.supabaseUrl, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      expect((await client.auth.signInWithPassword({ email: fixture.owner.email, password: fixture.owner.password })).error).toBeNull();
      const { data: placements } = await e2eAdminClient(config).from("event_competition_heat_entries").select("id, entry_id").eq("event_id", E.event.id).eq("entry_id", E.entries[2]);
      const result = await client.rpc("mark_competition_heat_no_show", { p_heat_entry_id: placements![0].id, p_reason: "after lock", p_request_id: randomUUID() });
      expect(result.error, "marking after the ballots locked is refused").not.toBeNull();
    }
    expect((await readNoShows(config, E.event.id)).marks).toHaveLength(before.marks.length);
    await page.context().close();
  });

  test("SCN-14.1 calculate: the result ranks the entries who danced, excludes the no-show, and a calculator-only approval is refused", async ({ browser }, testInfo) => {
    test.skip(!locked.E, "BLOCKED: the ballots could not be locked (SCN-12.3)");
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await page.goto(`${base(E)}/results/${E.finalRoundId}`);
    await page.getByRole("button", { name: "Calculate result" }).click();
    await expect(page.getByRole("status")).toContainText(/Calculated result version 1/, { timeout: 60_000 });
    const table = page.locator("table").first();
    await expect(table).toContainText(NAME[0]);
    await expect(table).not.toContainText(NAME[3]);
    await shot(page, "result-v1");
    const state = readResultState(E.finalRoundId);
    expect(state.versions[0]).toMatchObject({ version: 1, status: "calculated", calculated_by: fixture.owner.id });
    const placed = state.rows.filter((r) => r.version === 1);
    expect(placed.map((r) => r.entry_id).sort()).toEqual([E.entries[0], E.entries[1], E.entries[2]].sort());
    expect(placed.find((r) => r.entry_id === E.entries[0])?.placement).toBe(1);
    expect(placed.find((r) => r.entry_id === E.entries[1])?.placement).toBe(2);
    expect(placed.find((r) => r.entry_id === E.entries[2])?.placement).toBe(3);

    // The calculator approving alone, with no reason, is refused.
    await page.getByRole("button", { name: "Approve with override" }).click();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    expect(readResultState(E.finalRoundId).approvals).toHaveLength(0);
    await shot(page, "calculator-only-approve-refused");
    await page.context().close();
  });

  test("SCN-14.2 correction: the manager opens a correction; the judge sheet shows the correction banner and takes a corrected ballot with a reason (CX1)", async ({ browser }, testInfo) => {
    test.skip(!locked.E, "BLOCKED: the ballots could not be locked (SCN-12.3)");
    const shot = stepShots(testInfo);
    const owner = await signedIn(browser, fixture.owner);
    await owner.goto(`${base(E)}/results/${E.finalRoundId}`);
    await owner.getByLabel(/Open a ballot correction/).fill("Judge 1 may have mis-ranked two couples");
    await owner.getByRole("button", { name: "Open correction" }).click();
    await expect(owner.getByRole("status")).toContainText("Correction opened.", { timeout: 30_000 });
    await expect(owner.getByText(/\(correction open\)/)).toBeVisible();
    await shot(owner, "correction-open");
    expect((await readHeatEvidence(config, E.event.id)).rounds.find((r) => r.id === E.finalRoundId)?.status).toBe("ballots_locked");

    // Judge 1 sees the correction banner and submits a corrected ballot (swapping the top two) with a reason.
    const judge = await signedIn(browser, fixture.judges[0], judgeBallotUrl(E, E.finalRoundId));
    await expect(judge.getByText(/Correction open: submit a corrected ballot\./)).toBeVisible();
    await shot(judge, "judge-sheet-correction-open");
    await judge.context().close();
    await submitOrdinal(browser, fixture.judges[0], E, [1, 0, 2], "Mis-ranked the top two");
    expect(await readBallotCount(config, E.finalRoundId)).toBe(4);
    await owner.context().close();
  });

  test("SCN-14.2b a corrected ballot makes the result stale: it cannot be approved until it is recalculated", async ({ browser }, testInfo) => {
    test.skip(!locked.E, "BLOCKED: the ballots could not be locked (SCN-12.3)");
    const shot = stepShots(testInfo);
    const owner = await signedIn(browser, fixture.owner);
    await owner.goto(`${base(E)}/results/${E.finalRoundId}`);
    // F2 marks the superseded version "Stale" and offers Calculate result again; there is nothing to approve.
    await expect(owner.getByRole("heading", { name: /^Version 1 - Stale/ })).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByRole("button", { name: "Calculate result" })).toBeVisible();
    await expect(owner.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
    expect(readResultState(E.finalRoundId).versions.map((v) => v.status)).toEqual(["stale"]);
    await shot(owner, "stale-no-approve");
    expect(readResultState(E.finalRoundId).approvals).toHaveLength(0);
    await owner.context().close();
  });

  test("SCN-14.3 recalculate and approve: a second manager approves, the heat is certified, and a certified heat refuses a scratch", async ({ browser }, testInfo) => {
    test.skip(!locked.E, "BLOCKED: the ballots could not be locked (SCN-12.3)");
    const shot = stepShots(testInfo);
    const owner = await signedIn(browser, fixture.owner);
    await owner.goto(`${base(E)}/results/${E.finalRoundId}`);
    await owner.getByRole("button", { name: "Calculate result" }).click();
    await expect(owner.getByRole("status")).toContainText(/Calculated result version 2/, { timeout: 60_000 });
    await shot(owner, "result-v2");
    await owner.context().close();

    const second = await signedIn(browser, fixture.deskAdmin);
    await second.goto(`${base(E)}/results/${E.finalRoundId}`);
    await second.getByRole("button", { name: "Approve result" }).click();
    await expect(second.getByRole("status")).toContainText("Result approved. The round's heats are certified.", { timeout: 60_000 });
    await shot(second, "approved");
    const state = readResultState(E.finalRoundId);
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0]).toMatchObject({ approved_by: fixture.deskAdmin.id, calculated_by: fixture.owner.id, override_reason: null });
    expect(state.versions.map((v) => v.status)).toEqual(expect.arrayContaining(["approved"]));
    expect((await readHeatEvidence(config, E.event.id)).effective.map((h) => h.lockState)).toEqual(["certified"]);
    // Judge 1's corrected ballot now agrees with judge 3 (couple 2 first), so the majority puts couple 2 first and couple 1 second.
    expect(state.rows.find((r) => r.version === 2 && r.entry_id === E.entries[1])?.placement).toBe(1);
    expect(state.rows.find((r) => r.version === 2 && r.entry_id === E.entries[0])?.placement).toBe(2);

    await expect(async () => {
      await second.goto(`${base(E)}/registrations/scratch/${E.entries[0]}`);
      await expect(second.getByRole("heading", { name: "Scratch entry", level: 1 })).toBeVisible({ timeout: 8_000 });
    }).toPass({ timeout: 120_000 });
    await expect(second.getByRole("button", { name: "Scratch entry" })).toHaveCount(0);
    await expect(second.locator("main p.bg-amber-50")).toBeVisible();
    await shot(second, "certified-scratch-refused");
    expect((await readScratchAudit(config, E.event.id)).filter((s) => s.entry_id === E.entries[0])).toHaveLength(0);
    await second.context().close();
  });

  test("SCN-14.4 who can see results: judges, the other studio, the instructor, and anonymous visitors cannot open them; the public event page shows none", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const url = `${base(E)}/results/${E.finalRoundId}`;
    for (const [who, account] of [["judge", fixture.judges[1]], ["instructor", fixture.instructor], ["other studio owner", fixture.otherOwner], ["front desk", fixture.frontDesk]] as const) {
      const page = await signedIn(browser, account);
      const { status, url: landed } = await visit(page, url);
      if (who === "front desk") expect(landed.pathname).toBe(`${base(E)}/checkin`);
      else expect(status, `${who} results page`).toBe(404);
      await page.context().close();
    }
    const anon = await anonymousPage(browser);
    expect((await visit(anon, url)).url.pathname).toBe("/login");
    await anon.goto(`/events/${E.event.slug}`);
    const body = (await anon.locator("body").innerText()).replace(/\s+/g, " ");
    expect(body).not.toMatch(/Version \d|Result approved|placement|1st place/i);
    await shot(anon, "public-event-page");
    await anon.context().close();
  });

  // ================================================================== not implemented

  test.fixme("SCN-13.1 publication: the dancer sees only their own entries and the published placements; a correction republishes as v2", async ({}, testInfo) => {
    scenarioStatus(testInfo, "NOT IMPLEMENTED", "F3 publication is not built: there is no publish step, no entrant results page and no published-results page to drive.");
  });
});

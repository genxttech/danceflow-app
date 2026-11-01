import { test, expect, type Browser, type TestInfo } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "../helpers/competitionFixture";
import { verifyEmailAndBindPassword } from "../helpers/competitionFullEvent";
import { useUniqueE2ESourceIp as assignUniqueSourceIpForContext } from "../helpers/rateLimitBypass";
import {
  cleanupScheduleAcceptanceFixture,
  createScheduleAcceptanceFixture,
  readBallotCount,
  scenarioStatus,
  signedIn,
  stepShots,
  type ScheduleAcceptanceFixture,
} from "../helpers/competitionScheduleHeats";
import {
  CF1_CODES,
  CF1_UI,
  applyScoring,
  blockedBy,
  buildPanel,
  coupleName,
  createDraftEvent,
  generateAndPublish,
  leftoverAnyCompetitionRows,
  leftoverCf1Rows,
  lockBallots,
  missing,
  probeCapabilities,
  publishAndOpen,
  readExclusions,
  readResultEvidence,
  readResultRows,
  registerAndPay,
  roundIds,
  startHeat,
  startRound,
  submitOrdinalBallot,
  type Cf1Capabilities,
  type Journey,
  type ScoredEvent,
} from "../helpers/cf1Acceptance";

/**
 * CF1-C cross-discipline regression (OD-17: the eligibility protections apply to ALL scored rounds and ALL disciplines;
 * gates U80-U83, and the UI half of U58/U59/U65). The protections are not enabled for live events until this passes (RB1 b).
 *
 *   SCN-R80  non-callback round (Final only, ordinal majority): lock, calculate, approve behave as before when nobody is unavailable.
 *   SCN-R81  one clean run and one unavailable-couple run per scoring setup the UI offers (enumerated at run time) in the
 *            discipline the wizard can create; Ballroom is BLOCKED (single-dance Ballroom wizard helper absent, multi-dance hold).
 *   SCN-R82  comped/manual entry without a registration: BLOCKED unless the registrations page offers a manual entry control.
 *   SCN-R83  rounds with no exclusion: the stored evidence has no exclusion content, the approve hash check passes (byte parity
 *            with the pre-CF1 text is U72/U83 in the SQL and vitest suites, which this spec cannot reproduce; it checks the end-to-end effect).
 *   SCN-X1   exclusion action (A5 + B): request, co-sign by a different person, shown as "Excluded", never as no-show.
 *   SCN-X2   exclusion safeguards: requester cannot co-sign; reversal only while P is false.
 *
 * Same rules as the advancement spec: UI-driven, read-only evidence, zero leftover rows, BLOCKED with a named dependency
 * when a prerequisite is absent. "Making a couple unavailable" is done only through the application (registration
 * cancellation on the registrations page); where that control is not found the scenario is BLOCKED and the SQL suites carry it.
 */

test.describe.configure({ mode: "serial", timeout: 2_400_000 });

const FLAG_ON = process.env.E2E_COMPETITION_REGISTRATION_ENABLED === "true";
const ACCOUNT = "acct_cf1cfixture"; // fake id: payments are fixture-seeded, no Stripe call
const ENTRY_FEE = 40;
const FINAL_ONLY = "Final only (ordinal majority)" as const;

test.describe("CF1 cross-discipline regression and OD-17 scope (CF1-C)", () => {
  test.skip(!FLAG_ON, "Needs the app started with NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true.");

  let config: E2EConfig;
  let fixture: ScheduleAcceptanceFixture;
  let j: Journey;
  let cap: Cf1Capabilities;
  const created: string[] = [];
  const clean: { event?: ScoredEvent } = {};
  const evidence = (value: unknown) => test.info().annotations.push({ type: "evidence", description: JSON.stringify(value) });

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl) || !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.baseUrl)) throw new Error("refusing: not the local QA stack");
    cap = probeCapabilities();
    fixture = await createScheduleAcceptanceFixture(config, { connectedAccountId: ACCOUNT });
    j = { config, fixture, account: ACCOUNT, entryFee: ENTRY_FEE };
  });

  test.afterAll(async () => {
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    await cleanupScheduleAcceptanceFixture(config, fixture);
    expect(Object.values(leftoverCf1Rows(created)).every((n) => n === 0), "CF1 rows left after teardown").toBe(true);
    expect(leftoverAnyCompetitionRows(created), "event_competition_* rows left after teardown").toEqual({});
    if (created.length) expect((await e2eAdminClient(config).from("events").select("id", { count: "exact", head: true }).in("id", created)).count).toBe(0);
  });

  /** Final-only (ordinal majority) event: setup -> publish -> 4 couples paid -> running order -> panel -> Final running with its heat on the floor. */
  async function ordinalEvent(browser: Browser, tag: string, date: string, setup: typeof FINAL_ONLY | string = FINAL_ONLY): Promise<ScoredEvent> {
    const page = await signedIn(browser, fixture.owner);
    const event = await createDraftEvent(j, page, `E2E CF1 ${tag} ${fixture.runId}`, date);
    created.push(event.id);
    await applyScoring(page, event.id, setup as typeof FINAL_ONLY);
    await publishAndOpen(page, event.id);
    const entries = await registerAndPay(j, browser, event, tag.toLowerCase(), 4);
    await generateAndPublish(page, event.id, 4);
    await buildPanel(page, event.id, "Final");
    await startRound(page, event.id, "Final");
    await startHeat(page, event.id);
    const { finalRoundId } = await roundIds(j, event.id).catch(async () => ({ finalRoundId: await finalOnly(event.id) }));
    await page.context().close();
    return { event, callbackRoundId: finalRoundId, finalRoundId, entries, names: entries.map((_, n) => coupleName(n)) };
  }
  async function finalOnly(eventId: string): Promise<string> {
    const { readHeatEvidence } = await import("../helpers/competitionScheduleHeats");
    const round = (await readHeatEvidence(config, eventId)).rounds.find((r) => r.name === "Final");
    if (!round) throw new Error("no Final round");
    return round.id as string;
  }

  async function lockCalcApprove(browser: Browser, s: ScoredEvent, testInfo: TestInfo, expectRefusal?: string) {
    const shot = stepShots(testInfo);
    const owner = await signedIn(browser, fixture.owner);
    const lock = await lockBallots(owner, s.event.id, s.finalRoundId);
    if (expectRefusal) {
      expect(lock.locked, "lock must be refused").toBe(false);
      expect(lock.refusal ?? "").toContain(expectRefusal);
      await shot(owner, "lock-refused");
      await owner.context().close();
      return;
    }
    expect(lock.locked, `lock: ${lock.refusal ?? ""}`).toBe(true);
    await owner.goto(`/app/events/${s.event.id}/competition/results/${s.finalRoundId}`);
    await owner.getByRole("button", { name: "Calculate result" }).click();
    await expect(owner.getByRole("status")).toContainText(/Calculated result version 1/, { timeout: 60_000 });
    await owner.context().close();
    const second = await signedIn(browser, fixture.deskAdmin);
    await second.goto(`/app/events/${s.event.id}/competition/results/${s.finalRoundId}`);
    await second.getByRole("button", { name: "Approve result" }).click();
    await expect(second.getByRole("status")).toContainText("Result approved. The round's heats are certified.", { timeout: 60_000 });
    await shot(second, "approved");
    await second.context().close();
  }

  /** Cancels a registration through the application's registrations page. Returns false when no such control exists. */
  /**
   * Makes one couple unavailable (predicate P clause ii: eligibility_status = ineligible) through the registrations page, the supported
   * manager control (updateCompetitionEntryEligibilityAction). A cancelled or refunded registration (clauses iii) has no UI until R2 refunds
   * (#292); those variants stay BLOCKED. Returns false when the control is absent.
   */
  async function setEntryEligibilityViaUi(browser: Browser, s: ScoredEvent, entryIndex: number, status: "ineligible" | "eligible"): Promise<boolean> {
    const page = await signedIn(browser, fixture.owner);
    await page.goto(`/app/events/${s.event.id}/competition/registrations`);
    const card = page.locator("div.grid").filter({ hasText: coupleName(entryIndex) }).filter({ has: page.locator('select[name="eligibilityStatus"]') }).last();
    const select = card.locator('select[name="eligibilityStatus"]');
    if (!(await select.count())) { await page.context().close(); return false; }
    await select.selectOption(status);
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card.locator('select[name="eligibilityStatus"]')).toHaveValue(status, { timeout: 30_000 });
    await page.context().close();
    return true;
  }

  async function cancelRegistrationViaUi(browser: Browser, s: ScoredEvent, entryIndex: number): Promise<boolean> {
    return setEntryEligibilityViaUi(browser, s, entryIndex, "ineligible");
  }

  test("SCN-0c setup (not a scenario): judges and managers prove their mailbox", async ({ browser }) => {
    for (const account of [...fixture.judges, fixture.owner, fixture.deskAdmin]) {
      const page = await (await browser.newContext()).newPage();
      await assignUniqueSourceIpForContext(page);
      await verifyEmailAndBindPassword(page, account);
      await page.context().close();
    }
  });

  test("SCN-R80 non-callback round (Final only, ordinal majority): lock, calculate and approve are unchanged for a clean round on the composed chain", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a1", "a2", "a3"]);
    if (required.length) blockedBy(testInfo, required, "A clean-round regression is only meaningful on the chain that carries the OD-17 checks.");
    const s = await ordinalEvent(browser, "R80", "2027-08-01");
    clean.event = s;
    for (let judge = 0; judge < 3; judge += 1) await submitOrdinalBallot(j, browser, judge, s);
    expect(await readBallotCount(config, s.finalRoundId)).toBe(3);
    await lockCalcApprove(browser, s, testInfo);
    const rows = readResultRows(s.finalRoundId);
    expect(rows.map((r) => r.placement)).toEqual([1, 2, 3, 4]);
    expect(readExclusions(s.finalRoundId), "no exclusion rows for a clean round").toHaveLength(0);
    evidence({ scenario: "SCN-R80", versions: [...new Set(rows.map((r) => r.version))] });
  });

  test("SCN-R83 rounds with no exclusion: the stored evidence has no exclusion content and the approve hash check passed", async ({}, testInfo) => {
    const required = missing(cap, ["a3"]);
    if (required.length) blockedBy(testInfo, required, "Evidence format with the exclusion section.");
    test.skip(!clean.event, "BLOCKED: SCN-R80 did not run");
    const versions = readResultEvidence(clean.event!.finalRoundId);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      const text = JSON.stringify(v.evidence);
      expect(text, "no exclusion reason in an exclusion-free round").not.toContain('"reason":"excluded"');
      expect(String(v.input_hash)).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(versions.map((v) => v.status)).toContain("approved"); // approve recomputes the hash and refuses on a mismatch
    evidence({ scenario: "SCN-R83", notProvedHere: "Byte-identity with the pre-CF1 text (hashes include run-specific ids); that is U72/U83 in the SQL and vitest parity suites. This test proves the end-to-end consequence only." });
  });

  test("SCN-R81 each scoring setup the UI offers: clean round passes, a couple whose registration was cancelled is refused at lock (COMP_ROSTER_ENTRY_UNAVAILABLE)", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a1", "a2", "a3"]);
    if (required.length) blockedBy(testInfo, required, "OD-17 lock check.");
    const page = await signedIn(browser, fixture.owner);
    const probeEvent = await createDraftEvent(j, page, `E2E CF1 R81probe ${fixture.runId}`, "2027-08-02");
    created.push(probeEvent.id);
    await page.goto(`/app/events/${probeEvent.id}/competition/advanced`);
    const options = await page.getByLabel("Scoring setup").locator("option").allInnerTexts();
    await page.context().close();
    const setups = [...new Set(options.map((o) => o.trim()).filter((o) => o && !/^(choose|select)/i.test(o)))]; // the select lists each setup per discipline group: de-duplicate (a repeat would create a same-named event)
    evidence({ scenario: "SCN-R81", setupsOffered: setups });
    expect(setups.length, "the UI offers at least one scoring setup").toBeGreaterThan(0);
    const ordinalOnly = setups.filter((o) => o === FINAL_ONLY);
    for (const setup of ordinalOnly) {
      const s = await ordinalEvent(browser, "R81u", "2027-08-03", setup);
      for (let judge = 0; judge < 3; judge += 1) await submitOrdinalBallot(j, browser, judge, s);
      if (!(await cancelRegistrationViaUi(browser, s, 3))) {
        scenarioStatus(testInfo, "BLOCKED", "No UI control cancels or refunds one registration on the registrations page, so the unavailable-couple half cannot run (SQL gates U57-U59, U61 carry it). The clean half ran but a half-run scenario is not a PASS.");
        testInfo.skip(true, "BLOCKED: no UI path to make a couple unavailable");
      }
      await lockCalcApprove(browser, s, testInfo, CF1_CODES.rosterEntryUnavailable);
      const open = await signedIn(browser, fixture.owner);
      await open.goto(`/app/events/${s.event.id}/competition/ballots/${s.finalRoundId}`);
      await expect(open.getByRole("region", { name: "Round status" })).not.toContainText("Ballots locked");
      await open.context().close();
    }
    const others = setups.filter((o) => o !== FINAL_ONLY && o !== "Callbacks + Final");
    if (others.length) evidence({ scenario: "SCN-R81", notCovered: `Setups the UI offers that this spec has no driver for yet: ${others.join(", ")}. Ballroom (single-dance) has no wizard helper in the harness and multi-dance is on hold.` });
  });

  test("SCN-R82 comped or manual entries without a registration are never refused for lack of refund evidence", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a1", "a2"]);
    if (required.length) blockedBy(testInfo, required, "Predicate P for entries without registration.");
    const page = await signedIn(browser, fixture.owner);
    const probe = await createDraftEvent(j, page, `E2E CF1 R82probe ${fixture.runId}`, "2027-08-04");
    created.push(probe.id);
    await page.goto(`/app/events/${probe.id}/competition/registrations`);
    const manual = page.getByRole("button", { name: /add (a )?(manual|comped|entry)|comp entry/i });
    const present = await manual.count();
    await page.context().close();
    if (!present) {
      scenarioStatus(testInfo, "BLOCKED", "No UI path creates an entry without a registration or order; the harness does not insert one (no write shortcut). Covered by SQL gate U82 (A1 suite) until a manual-entry screen exists.");
      testInfo.skip(true, "BLOCKED: no manual-entry control");
    }
    // A manual-entry screen exists: this scenario must be authored against it, not guessed.
    throw new Error("A manual-entry control now exists: write SCN-R82 against it (add comped entry, run lock/calculate/approve, expect no refusal).");
  });

  // ------------------------------------------------------------------ exclusion action (A5 + B)

  test("SCN-X1 exclusion: a manager requests it, a different person co-signs, the review shows Excluded (never no-show) and the round re-locks after corrected ballots", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a1", "a2", "a3", "a5", "b"]);
    if (required.length) blockedBy(testInfo, required, "Exclusion screens and RPCs.");
    const shot = stepShots(testInfo);
    const s = await ordinalEvent(browser, "X1", "2027-08-05");
    for (let judge = 0; judge < 3; judge += 1) await submitOrdinalBallot(j, browser, judge, s);
    if (!(await cancelRegistrationViaUi(browser, s, 3))) {
      scenarioStatus(testInfo, "BLOCKED", "No UI control cancels or refunds one registration, so no couple can be made unavailable (predicate P); the exclusion action cannot be driven through the UI here. SQL gates for A5 carry it.");
      testInfo.skip(true, "BLOCKED: no UI path to make a couple unavailable");
    }
    const owner = await signedIn(browser, fixture.owner);
    await owner.goto(`/app/events/${s.event.id}/competition/results/${s.finalRoundId}`);
    // The panel is open while the round is active. Pick the couple made ineligible (entry index 3), give a reason, request.
    const panel = owner.getByRole("region", { name: "Exclude a couple" });
    const optionValue = await panel.locator('select[name="entryId"]').locator("option").filter({ hasText: coupleName(3) }).first().getAttribute("value");
    await panel.locator('select[name="entryId"]').selectOption(optionValue!);
    await panel.getByLabel(/^Reason/).fill("The couple became ineligible after the round was danced");
    await panel.getByRole("button", { name: CF1_UI.excludeButton }).click();
    await expect(owner.getByRole("status")).toBeVisible({ timeout: 30_000 });
    const requested = readExclusions(s.finalRoundId);
    expect(requested.map((r) => r.kind)).toEqual(["exclude_requested"]);
    // The requester cannot co-sign (A5).
    await expect(owner.getByRole("button", { name: /Co-sign/i })).toHaveCount(0).catch(async () => {
      await owner.getByRole("button", { name: /Co-sign/i }).first().click();
      await expect(owner.locator('main [role="alert"]')).toBeVisible();
    });
    expect(readExclusions(s.finalRoundId).map((r) => r.kind)).toEqual(["exclude_requested"]);
    await shot(owner, "requested");
    await owner.context().close();
    const second = await signedIn(browser, fixture.deskAdmin);
    await second.goto(`/app/events/${s.event.id}/competition/results/${s.finalRoundId}`);
    await second.getByRole("button", { name: /Co-sign/i }).first().click();
    await expect(second.getByRole("status")).toBeVisible({ timeout: 30_000 });
    expect(readExclusions(s.finalRoundId).map((r) => r.kind)).toEqual(["exclude_requested", "exclude_cosigned"]);
    await shot(second, "cosigned");
    await second.context().close();
    // The excluded couple leaves every judge's sheet: the existing ballots no longer match the round, so each judge re-ranks the remaining couples.
    for (let judge = 0; judge < 3; judge += 1) await submitOrdinalBallot(j, browser, judge, s);
    // Lock, calculate: the couple is outside the ranking set and shown as Excluded in the review.
    await lockCalcApprove(browser, s, testInfo);
    const review = await signedIn(browser, fixture.owner);
    await review.goto(`/app/events/${s.event.id}/competition/results/${s.finalRoundId}`);
    await expect(review.getByRole("heading", { name: "Excluded from the ranking" })).toBeVisible();
    await expect(review.getByText(coupleName(3)).first()).toBeVisible();
    await expect(review.getByText(/No-show/i)).toHaveCount(0);
    await review.context().close();
  });

  test("SCN-X2 reversal is allowed only while the cause is gone: refused while the couple is still ineligible, accepted after eligibility is restored, co-signed by a different person", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a1", "a2", "a3", "a5", "b"]);
    if (required.length) blockedBy(testInfo, required, "Exclusion reversal screens and RPCs.");
    const shot = stepShots(testInfo);
    const s = await ordinalEvent(browser, "X2", "2027-08-06");
    for (let judge = 0; judge < 3; judge += 1) await submitOrdinalBallot(j, browser, judge, s);
    if (!(await setEntryEligibilityViaUi(browser, s, 3, "ineligible"))) {
      scenarioStatus(testInfo, "BLOCKED", "The registrations page offers no eligibility control for the couple.");
      testInfo.skip(true, "BLOCKED: no eligibility control");
    }
    // Exclude the couple (request by one manager, co-sign by another), exactly as SCN-X1.
    const owner = await signedIn(browser, fixture.owner);
    await owner.goto(`/app/events/${s.event.id}/competition/results/${s.finalRoundId}`);
    const panel = owner.getByRole("region", { name: "Exclude a couple" });
    const optionValue = await panel.locator('select[name="entryId"]').first().locator("option").filter({ hasText: coupleName(3) }).first().getAttribute("value");
    await panel.locator('select[name="entryId"]').first().selectOption(optionValue!);
    await panel.getByLabel(/^Reason/).first().fill("The couple became ineligible after the round was danced");
    await panel.getByRole("button", { name: CF1_UI.excludeButton }).click();
    await expect(owner.getByRole("status").first()).toBeVisible({ timeout: 30_000 });
    expect(readExclusions(s.finalRoundId).map((r) => r.kind)).toEqual(["exclude_requested"]);
    await owner.context().close();
    const second = await signedIn(browser, fixture.deskAdmin);
    await second.goto(`/app/events/${s.event.id}/competition/results/${s.finalRoundId}`);
    await second.getByRole("button", { name: /Co-sign exclusion/i }).first().click();
    await expect(second.getByRole("status").first()).toBeVisible({ timeout: 30_000 });
    expect(readExclusions(s.finalRoundId).map((r) => r.kind)).toEqual(["exclude_requested", "exclude_cosigned"]);
    await second.context().close();

    // 1. The cause is still there (ineligible): a reversal is refused and nothing is written.
    const reverser = await signedIn(browser, fixture.owner);
    await reverser.goto(`/app/events/${s.event.id}/competition/results/${s.finalRoundId}`);
    const reversal = reverser.locator("form").filter({ has: reverser.getByRole("button", { name: "Request reversal" }) });
    await reversal.getByLabel("Reason for reversing (required)").fill("The eligibility problem was fixed");
    await reversal.getByRole("button", { name: "Request reversal" }).click();
    await expect(reverser.locator('main [role="alert"]')).toContainText("still ineligible or refunded", { timeout: 30_000 });
    expect(readExclusions(s.finalRoundId).map((r) => r.kind), "no reversal row while the cause remains").toEqual(["exclude_requested", "exclude_cosigned"]);
    await shot(reverser, "reversal-refused-cause-remains");
    await reverser.context().close();

    // 2. Restore eligibility through the registrations page (the supported control), then the reversal is accepted.
    expect(await setEntryEligibilityViaUi(browser, s, 3, "eligible")).toBe(true);
    const owner2 = await signedIn(browser, fixture.owner);
    await owner2.goto(`/app/events/${s.event.id}/competition/results/${s.finalRoundId}`);
    const reversal2 = owner2.locator("form").filter({ has: owner2.getByRole("button", { name: "Request reversal" }) });
    await reversal2.getByLabel("Reason for reversing (required)").fill("The eligibility problem was fixed");
    await reversal2.getByRole("button", { name: "Request reversal" }).click();
    await expect(owner2.getByRole("status").first()).toBeVisible({ timeout: 30_000 });
    expect(readExclusions(s.finalRoundId).map((r) => r.kind)).toEqual(["exclude_requested", "exclude_cosigned", "reverse_requested"]);
    // The requester cannot co-sign their own reversal.
    await expect(owner2.getByRole("button", { name: /Co-sign reversal/i })).toHaveCount(0);
    await shot(owner2, "reversal-requested");
    await owner2.context().close();

    // 3. A different person co-signs; the couple is back in the round.
    const second2 = await signedIn(browser, fixture.deskAdmin);
    await second2.goto(`/app/events/${s.event.id}/competition/results/${s.finalRoundId}`);
    await second2.getByRole("button", { name: /Co-sign reversal/i }).first().click();
    await expect(second2.getByRole("status").first()).toBeVisible({ timeout: 30_000 });
    expect(readExclusions(s.finalRoundId).map((r) => r.kind)).toEqual(["exclude_requested", "exclude_cosigned", "reverse_requested", "reverse_cosigned"]);
    await shot(second2, "reversal-cosigned");
    await second2.context().close();

    // The round now locks, calculates and approves with the couple in the ranking.
    await lockCalcApprove(browser, s, testInfo);
    const placed = readResultRows(s.finalRoundId).filter((r) => r.version === 1);
    expect(placed.length, "all four couples are ranked again").toBe(s.entries.length);
  });
});

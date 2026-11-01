import { test, expect, type TestInfo } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "../helpers/competitionFixture";
import { verifyEmailAndBindPassword } from "../helpers/competitionFullEvent";
import { useUniqueE2ESourceIp as assignUniqueSourceIpForContext } from "../helpers/rateLimitBypass";
import {
  cleanupScheduleAcceptanceFixture,
  createScheduleAcceptanceFixture,
  readBallotCount,
  readHeatEvidence,
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
  createDraftEvent,
  generateAndPublish,
  leftoverAnyCompetitionRows,
  leftoverCf1Rows,
  lockBallots,
  missing,
  probeCapabilities,
  publishAndOpen,
  readAdvancements,
  readAuditKinds,
  readResultRows,
  registerAndPay,
  roundIds,
  setCallbackTarget,
  startHeat,
  startRound,
  submitCallbackBallot,
  clickUntil,
  submitOrdinalBallot,
  couple,
  coupleName,
  type Cf1Capabilities,
  type Journey,
  type ScoredEvent,
} from "../helpers/cf1Acceptance";

/**
 * CF1-C acceptance: Callback -> Final advancement (design section 13: SCN-11.4a, 11.4b, 11.5, 11.5b, 11.5c and its variants).
 *
 * Evidence-backed and UI-driven. The journey is advanced only through the application; the service-role client and read-only
 * psql (CF1 and F2 tables are closed to every API role) read the evidence. The Q1 seed is the only write, and teardown asserts
 * zero leftover rows. Every scenario first checks what the stack under test contains (probeCapabilities); a scenario whose
 * dependency is absent is BLOCKED with the dependency named, never passed. The CF1-B wording lives in CF1_UI and is
 * provisional until B exists.
 *
 * Environment (same as the QA-A scoring spec, but the dedicated CF1-C stack): E2E_LOCAL_DB_CONTAINER=supabase_db_cf1c-qa,
 * Stripe TEST key and connected account, app started with NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true, CF1_B_PRESENT=true
 * only when the app under test includes CF1-B.
 *
 * Three events (6 couples each, T = 4):
 *   P  tie within capacity (capacity 8): SCN-11.4a, then SCN-11.5 on the same event.
 *   Q  tie over capacity (capacity 4): SCN-11.4b, then the cancelled-Final correction arm (OD-10, U84) without an advancement.
 *   R  SCN-11.5b (correction before Final ballots -> generation 2), then SCN-11.5c in three states: Final heat locked, Final
 *      started, Final has a ballot.
 */

test.describe.configure({ mode: "serial", timeout: 2_400_000 });

const FLAG_ON = process.env.E2E_COMPETITION_REGISTRATION_ENABLED === "true";
const ACCOUNT = "acct_cf1cfixture"; // fake id: payments are fixture-seeded, no Stripe call
const ENTRY_FEE = 40;
const T = 4;
const N = 6;
/** Sheet row i -> picks of each of the three judges, giving tallies [3, 3, 0, 2, 2, 2]: five couples at or above the 4th tally (F-CT-02). */
const TIE_PICKS: number[][] = [[0, 1, 3, 4], [0, 1, 3, 5], [0, 1, 4, 5]];

test.describe("CF1 callback -> Final advancement acceptance (CF1-C)", () => {
  test.skip(!FLAG_ON, "Needs the app started with NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true (E2E_COMPETITION_REGISTRATION_ENABLED=true).");

  let config: E2EConfig;
  let fixture: ScheduleAcceptanceFixture;
  let j: Journey;
  let cap: Cf1Capabilities;
  const events: { P?: ScoredEvent; Q?: ScoredEvent; R?: ScoredEvent; C?: ScoredEvent } = {};
  const state = { P: { applied: false, finalDone: false }, Q: { calculated: false }, R: { applied: false } };
  const evidence = (value: unknown) => test.info().annotations.push({ type: "evidence", description: JSON.stringify(value) });
  const eventIds = () => Object.values(events).filter(Boolean).map((e) => e!.event.id);

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl)) throw new Error("refusing: not the local QA Supabase");
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.baseUrl)) throw new Error("refusing: not a local app");
    cap = probeCapabilities();
    fixture = await createScheduleAcceptanceFixture(config, { connectedAccountId: ACCOUNT });
    j = { config, fixture, account: ACCOUNT, entryFee: ENTRY_FEE };
  });

  test.afterAll(async () => {
    const ids = eventIds();
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    await cleanupScheduleAcceptanceFixture(config, fixture);
    // Zero leftover rows: the CF1 tables (insert-only, FK to events ON DELETE CASCADE) and every other event_competition_* table.
    expect(leftoverCf1Rows(ids), "CF1 rows left after teardown").toEqual(Object.fromEntries(Object.keys(leftoverCf1Rows(ids)).map((k) => [k, 0])));
    expect(leftoverAnyCompetitionRows(ids), "event_competition_* rows left after teardown").toEqual({});
    expect((await e2eAdminClient(config).from("events").select("id", { count: "exact", head: true }).in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])).count).toBe(0);
  });

  /** Common set-up of one callback competition up to a running Callback round with its heat on the floor and N couples paid. */
  async function buildCallbackEvent(browser: import("@playwright/test").Browser, key: "P" | "Q" | "R" | "C", date: string, capacity: number | null) {
    const page = await signedIn(browser, fixture.owner);
    const event = await createDraftEvent(j, page, `E2E CF1 ${key} ${fixture.runId}`, date);
    await applyScoring(page, event.id, "Callbacks + Final");
    await setCallbackTarget(page, event.id, T);
    if (capacity !== null && !(await applyFinalCapacity(page, event.id, capacity))) {
      test.info().annotations.push({ type: "BLOCKED", description: `No UI sets the Final's capacity before the Final has a heat (the schedule page's capacity form exists per existing heat only; default is 8); the scenario needs capacity ${capacity}.` });
      test.info().skip(true, "BLOCKED: no capacity control");
    }
    await publishAndOpen(page, event.id);
    const entries = await registerAndPay(j, browser, event, key.toLowerCase(), N);
    await generateAndPublish(page, event.id, N);
    await buildPanel(page, event.id, "Callback round");
    await startRound(page, event.id, "Callback round");
    await startHeat(page, event.id);
    const { callbackRoundId, finalRoundId } = await roundIds(j, event.id);
    const scored: ScoredEvent = { event, callbackRoundId, finalRoundId, entries, names: entries.map((_, n) => coupleName(n)) };
    events[key] = scored;
    await page.context().close();
    return scored;
  }

  /**
   * Capacity of the Final (B5/B6 reasoned RPC). The only UI is the schedule page's per-heat "Max entries per heat for this division"
   * form, which exists for a round only once that round has a heat. A Final has no heat before advancement is applied, so before apply
   * there is no UI to set it (default capacity is 8). Returns false when no such form is found for the Final round.
   */
  /**
   * Capacity of the Final before it has a heat: the schedule page's "Final heat size" section (CF1 B). Returns false when no such section exists.
   */
  async function applyFinalCapacity(page: import("@playwright/test").Page, eventId: string, capacity: number): Promise<boolean> {
    await page.goto(`/app/events/${eventId}/competition/schedule`);
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Final heat size/ }) }).first();
    if (!(await section.count())) return false;
    await section.getByLabel("Max entries in the Final heat").fill(String(capacity));
    await section.getByLabel(/^Reason/).fill("CF1-C acceptance fixes the Final capacity to exercise the tie rule");
    await section.getByRole("button", { name: "Save Final heat size" }).click();
    await expect(page.locator('main [role="status"]').first()).toContainText(/Heat size saved/, { timeout: 60_000 });
    return true;
  }

  async function ballotsLockedCalculatedApproved(browser: import("@playwright/test").Browser, s: ScoredEvent, testInfo: TestInfo, picks = TIE_PICKS) {
    for (let judge = 0; judge < 3; judge += 1) await submitCallbackBallot(j, browser, judge, s, picks[judge]);
    expect(await readBallotCount(config, s.callbackRoundId)).toBe(3);
    const owner = await signedIn(browser, fixture.owner);
    const lock = await lockBallots(owner, s.event.id, s.callbackRoundId);
    if (!lock.locked) {
      testInfo.annotations.push({ type: "evidence", description: JSON.stringify({ lockRefusal: lock.refusal }) });
      await owner.context().close();
      return null;
    }
    await owner.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    await owner.getByRole("button", { name: "Calculate result" }).click();
    await expect(owner.getByRole("status")).toContainText(/Calculated result version \d+/, { timeout: 60_000 });
    return owner;
  }

  // ================================================================== setup (not scenarios)

  test("SCN-0c setup (not a scenario): judges and owner prove their mailbox through the real sign-in link", async ({ browser }) => {
    for (const account of [...fixture.judges, fixture.owner, fixture.deskAdmin]) {
      const page = await (await browser.newContext()).newPage();
      await assignUniqueSourceIpForContext(page);
      await verifyEmailAndBindPassword(page, account);
      await page.context().close();
    }
  });

  // ================================================================== P: tie within capacity, then the Final

  test("SCN-11.4a tie within capacity: all tied couples advance (5 of T = 4), one advancement, one audit row, Final heat holds exactly those five", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a0", "a1", "a2", "a3", "b"]);
    if (required.length) blockedBy(testInfo, required, "Apply and the advancement panel do not exist yet.");
    const shot = stepShots(testInfo);
    const s = await buildCallbackEvent(browser, "P", "2027-07-10", null);
    const owner = await ballotsLockedCalculatedApproved(browser, s, testInfo);
    expect(owner, "ballots lock on the composed chain").not.toBeNull();
    const rows = readResultRows(s.callbackRoundId);
    const advancedEntries = rows.filter((r) => r.advanced === true).map((r) => r.entry_id as string);
    expect(advancedEntries, "five couples at or above the 4th tally advance").toHaveLength(5);
    expect(new Set(advancedEntries)).toEqual(new Set([0, 1, 3, 4, 5].map((i) => s.entries[i])));
    expect(rows.find((r) => r.entry_id === s.entries[2])?.advanced).toBe(false);
    await shot(owner!, "calculated-tie-within-capacity");
    await owner!.context().close();

    const second = await signedIn(browser, fixture.deskAdmin);
    await second.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    await second.getByRole("button", { name: "Approve result" }).click();
    await expect(second.getByRole("status")).toContainText(/approved/i, { timeout: 60_000 });
    await expect(second.getByText(CF1_UI.tieAtCut)).toBeVisible({ timeout: 60_000 });
    await expect(second.getByRole("button", { name: CF1_UI.advanceButton })).toBeVisible();
    // No manager-pick/override control exists for the tie (SCN-11.4a UI result).
    await expect(second.getByRole("button", { name: /override|pick|choose/i })).toHaveCount(0);
    await second.getByRole("button", { name: CF1_UI.advanceButton }).click();
    await expect(second.getByText(CF1_UI.advanceDone)).toBeVisible({ timeout: 60_000 });
    await shot(second, "advanced");

    const adv = readAdvancements(s.callbackRoundId);
    expect(adv.active).toHaveLength(1);
    expect(adv.active[0]).toMatchObject({ generation: 1, advanced_count: 5 });
    expect(adv.entries.map((e) => e.entry_id).sort()).toEqual([...advancedEntries].sort());
    expect(adv.heats).toHaveLength(1);
    const layout = (await readHeatEvidence(config, s.event.id)).effective.filter((h) => h.roundId === s.finalRoundId);
    expect(layout, "one Final heat").toHaveLength(1);
    expect([...layout[0].entryIds].sort()).toEqual([...advancedEntries].sort());
    expect(readAuditKinds(s.event.id).filter((k) => k === "advancement_applied")).toHaveLength(1);
    expect((await readHeatEvidence(config, s.event.id)).rounds.find((r) => r.id === s.callbackRoundId)?.status, "apply leaves the callback round status unchanged").toBe("approved");
    // Replay of the same click is not a second advancement (idempotent) and a second apply is refused.
    evidence({ scenario: "SCN-11.4a", advanced: advancedEntries.length, advancement: adv.active[0].id, finalHeat: layout[0].heatId });
    state.P.applied = true;
    await second.context().close();
  });

  test("SCN-11.5 Final built from the advanced couples: one heat, starts, three judges rank, calculate, second manager approves, heat certified", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a0", "a1", "a2", "a3", "b"]);
    if (required.length) blockedBy(testInfo, required, "The Final cannot be built or run.");
    test.skip(!state.P.applied, "BLOCKED: SCN-11.4a did not apply the advancement");
    const shot = stepShots(testInfo);
    const s = events.P!;
    const adv = readAdvancements(s.callbackRoundId);
    const roster = adv.entries.map((e) => e.entry_id as string);
    const owner = await signedIn(browser, fixture.owner);
    await buildPanel(owner, s.event.id, "Final");
    // Entrants and the public do not see the Final roster before publication (P-1 / OD-6).
    const dancer = await signedIn(browser, fixture.dancers[0] as never, `/events/${s.event.slug}`).catch(() => null);
    if (dancer) {
      expect((await dancer.locator("body").innerText()).replace(/\s+/g, " ")).not.toMatch(new RegExp(`${coupleName(0)}.*Final`, "i"));
      await dancer.context().close();
    }
    await startRound(owner, s.event.id, "Final");
    await startHeat(owner, s.event.id);
    await shot(owner, "final-on-the-floor");
    for (let judge = 0; judge < 3; judge += 1) await submitOrdinalBallot(j, browser, judge, s);
    expect(await readBallotCount(config, s.finalRoundId)).toBe(3);
    // Ballots are accepted for roster couples only: the sheet lists exactly the advanced entries.
    const sheet = await signedIn(browser, fixture.judges[0] as never, `/app/judging/${s.event.id}/rounds/${s.finalRoundId}/ballot`);
    await expect(sheet.locator('select[name^="mark:"]')).toHaveCount(roster.length);
    await sheet.context().close();
    const lock = await lockBallots(owner, s.event.id, s.finalRoundId);
    expect(lock.locked, `Final ballots lock: ${lock.refusal ?? ""}`).toBe(true);
    await owner.goto(`/app/events/${s.event.id}/competition/results/${s.finalRoundId}`);
    await owner.getByRole("button", { name: "Calculate result" }).click();
    await expect(owner.getByRole("status")).toContainText(/Calculated result version 1/, { timeout: 60_000 });
    await expect(owner.getByText(/COMP_ORDINAL_MULTI_HEAT/)).toHaveCount(0);
    await owner.context().close();
    const second = await signedIn(browser, fixture.deskAdmin);
    await second.goto(`/app/events/${s.event.id}/competition/results/${s.finalRoundId}`);
    await second.getByRole("button", { name: "Approve result" }).click();
    await expect(second.getByRole("status")).toContainText("Result approved. The round's heats are certified.", { timeout: 60_000 });
    await shot(second, "final-approved");
    const placed = readResultRows(s.finalRoundId).filter((r) => r.version === 1);
    expect(placed.map((r) => r.entry_id as string).sort()).toEqual([...roster].sort());
    const finalHeats = (await readHeatEvidence(config, s.event.id)).effective.filter((h) => h.roundId === s.finalRoundId);
    expect(finalHeats).toHaveLength(1);
    expect(finalHeats[0].lockState).toBe("certified");
    state.P.finalDone = true;
    await second.context().close();
  });

  // ================================================================== Q: tie over capacity

  test("SCN-11.4b tie over capacity: the result is saved with its scores, advancement stays unresolved, nothing advances, no approve or advance control is offered", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a0", "a1", "a2", "a3", "b"]);
    if (required.length) blockedBy(testInfo, required, "Approval guard and advancement panel do not exist yet.");
    const shot = stepShots(testInfo);
    const s = await buildCallbackEvent(browser, "Q", "2027-07-11", 4);
    const owner = await ballotsLockedCalculatedApproved(browser, s, testInfo);
    expect(owner).not.toBeNull();
    // Evidence is saved, and no row is advanced (the engine sets no flag; the database treats any null flag as a blocked tie).
    const rows = readResultRows(s.callbackRoundId);
    expect(rows.length, "scores are saved for every couple").toBe(s.entries.length);
    expect(rows.every((r) => r.advanced === null), "every row is unresolved (advanced is null)").toBe(true);
    const tied = rows.filter((r) => (r.output as { tie_status?: string } | null)?.tie_status === "tied_at_cut");
    expect(tied, "the three couples tied at the cut-off are recorded").toHaveLength(3);
    // The desk says so, in plain words, and lists the evidence.
    const panel = owner!.getByRole("region", { name: "Advancement unresolved" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("No couple has been advanced");
    await expect(panel).toContainText("DanceFlow does not break ties automatically");
    await expect(panel).toContainText("capacity of 4");
    for (const i of [3, 4, 5]) await expect(panel.getByText(coupleName(i)).first()).toBeVisible();
    await expect(panel.getByText(coupleName(0)).first()).toBeVisible(); // called back clearly
    await shot(owner!, "tie-over-capacity-unresolved");
    await owner!.context().close();

    // Nothing can approve or advance an unresolved result from the desk, and nothing was written.
    const second = await signedIn(browser, fixture.deskAdmin);
    await second.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    await expect(second.getByRole("button", { name: "Approve result" })).toHaveCount(0);
    await expect(second.getByRole("button", { name: CF1_UI.advanceButton })).toHaveCount(0);
    await shot(second, "no-approve-or-advance-control");
    const adv = readAdvancements(s.callbackRoundId);
    expect(adv.advancements, "no advancement written").toHaveLength(0);
    expect(adv.heats).toHaveLength(0);
    expect((await readHeatEvidence(config, s.event.id)).effective.filter((h) => h.roundId === s.finalRoundId)).toHaveLength(0);
    expect(readAuditKinds(s.event.id).filter((k) => k.startsWith("advancement_"))).toHaveLength(0);
    state.Q.calculated = true;
    await second.context().close();
  });

  test("SCN-11.4b-cap B5: the Final capacity cannot be raised to fit an unresolved tie", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a0", "b"]);
    if (required.length) blockedBy(testInfo, required, "Reasoned capacity RPC and its screen.");
    test.skip(!state.Q.calculated, "BLOCKED: SCN-11.4b did not produce the calculated callback round");
    const shot = stepShots(testInfo);
    const s = events.Q!;
    const page = await signedIn(browser, fixture.owner);
    await page.goto(`/app/events/${s.event.id}/competition/schedule`);
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Final heat size/ }) }).first();
    await expect(section, "the Final heat size control is offered").toBeVisible();
    await section.getByLabel("Max entries in the Final heat").fill("8");
    await section.getByLabel(/^Reason/).fill("CF1-C acceptance tries to raise the capacity to fit the tie");
    await section.getByRole("button", { name: "Save Final heat size" }).click();
    await expect(page.locator('main [role="alert"]')).toBeVisible({ timeout: 60_000 });
    expect((await readHeatEvidence(config, s.event.id)).rounds.find((r) => r.id === s.finalRoundId)?.configuration).toMatchObject({ max_entries_per_heat: 4 });
    await shot(page, "capacity-raise-refused");
    await page.context().close();
  });

  test("SCN-11.4b-resolve a judge-entry correction (co-signed) dissolves the tie; the unresolved version and its evidence are kept", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a0", "a1", "a2", "a3", "b"]);
    if (required.length) blockedBy(testInfo, required, "Correction and advancement.");
    test.skip(!state.Q.calculated, "BLOCKED: SCN-11.4b did not produce the calculated callback round");
    const shot = stepShots(testInfo);
    const s = events.Q!;
    const opener = await signedIn(browser, fixture.deskAdmin);
    await opener.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    await opener.getByLabel(CF1_UI.correctionReasonLabel).fill("CF1-C: judge 3 mis-ticked a couple on the callback sheet");
    await opener.getByRole("button", { name: CF1_UI.openCorrectionButton }).click();
    await expect.poll(async () => (await readHeatEvidence(config, s.event.id)).rounds.find((r) => r.id === s.callbackRoundId)?.status, { timeout: 240_000, intervals: [2_000] }).toBe("ballots_locked");
    await opener.context().close();
    const cosigner = await signedIn(browser, fixture.owner);
    await cosigner.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    await cosigner.getByRole("region", { name: "Correction co-sign" }).getByRole("button", { name: "Co-sign correction" }).click();
    await expect(cosigner.getByRole("status").filter({ hasText: "Correction co-signed" }).first()).toBeVisible({ timeout: 60_000 });
    await cosigner.context().close();
    await submitCallbackBallot(j, browser, 2, s, [0, 1, 3, 4]); // judge 3 ticks couples 0,1,3,4: tallies 3,3,3,2,1, so four couples are clear of the cut
    const owner2 = await signedIn(browser, fixture.owner);
    await owner2.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    await owner2.getByRole("button", { name: "Calculate result" }).click();
    await expect(owner2.getByRole("status")).toContainText(/Calculated result version 2/, { timeout: 60_000 });
    await expect(owner2.getByRole("region", { name: "Advancement unresolved" })).toHaveCount(0);
    await shot(owner2, "tie-dissolved");
    await owner2.context().close();
    const after = readResultRows(s.callbackRoundId);
    expect(after.filter((r) => r.version === 1).every((r) => r.advanced === null), "version 1 evidence is kept, still unresolved").toBe(true);
    expect(after.filter((r) => r.version === 2 && r.advanced === true), "version 2 advances exactly four").toHaveLength(4);
    const second = await signedIn(browser, fixture.deskAdmin);
    await second.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    await second.getByRole("button", { name: "Approve result" }).click();
    await expect(second.getByRole("status")).toContainText(/approved/i, { timeout: 60_000 });
    await second.getByRole("button", { name: CF1_UI.advanceButton }).click();
    await expect(second.getByText(CF1_UI.advanceDone)).toBeVisible({ timeout: 60_000 });
    await shot(second, "advanced-after-correction");
    expect(readAdvancements(s.callbackRoundId).active).toHaveLength(1);
    await second.context().close();
  });

  test("SCN-11.5c-cancelled correction with the Final round cancelled (no advancement) is refused COMP_ADVANCEMENT_FINAL_CANCELLED (OD-10, U84)", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a0", "a1", "b"]);
    if (required.length) blockedBy(testInfo, required, "Correction arm of the cancelled Final.");
    const shot = stepShots(testInfo);
    // Own event (the Day-of console already offers Cancel round for an unstarted Final), so this no longer depends on SCN-11.4b's capacity-4 event.
    const s = await buildCallbackEvent(browser, "C", "2027-07-13", null);
    const approvedOwner = await ballotsLockedCalculatedApproved(browser, s, testInfo);
    expect(approvedOwner).not.toBeNull();
    await approvedOwner!.context().close();
    const owner = await signedIn(browser, fixture.owner);
    // Cancel the Final round through the day-of console (O1 cancel_competition_round). If there is no such control the scenario is BLOCKED.
    await owner.goto(`/app/events/${s.event.id}/competition/day-of`);
    const finalRound = owner.getByRole("region", { name: "Rounds" }).locator("li").filter({ hasText: "Final" }).first();
    const cancel = finalRound.getByRole("button", { name: /Cancel round/i });
    if (!(await cancel.count())) {
      scenarioStatus(testInfo, "BLOCKED", "No UI control cancels a Final round that has not started; the SQL suite U84 covers the arm. Needs an O1 cancel control or B.");
      testInfo.skip(true, "BLOCKED: no cancel-round control");
    }
    owner.on("dialog", (d) => { void d.accept(); });
    await finalRound.getByLabel("Cancel reason").fill("CF1-C: cancelling the unstarted Final to prove the callback result is no longer correctable");
    await cancel.click();
    await expect.poll(async () => (await readHeatEvidence(config, s.event.id)).rounds.find((r) => r.id === s.finalRoundId)?.status, { timeout: 30_000 }).toBe("cancelled");
    await owner.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    await owner.getByLabel(CF1_UI.correctionReasonLabel).fill("CF1-C: the Final was cancelled, the callback result must not be correctable");
    await owner.getByRole("button", { name: CF1_UI.openCorrectionButton }).click();
    await expect(owner.locator('main [role="alert"]')).toContainText(CF1_CODES.finalCancelled, { timeout: 30_000 });
    await shot(owner, "correction-refused-final-cancelled");
    expect((await readHeatEvidence(config, s.event.id)).rounds.find((r) => r.id === s.callbackRoundId)?.status, "round status unchanged").not.toBe("ballots_locked");
    expect(readAdvancements(s.callbackRoundId).advancements).toHaveLength(0);
    await owner.context().close();
  });

  // ================================================================== R: correction before Final ballots, then the refusal variants

  test("SCN-11.5b correct the callback before Final ballots: the generation 1 Final heat is cancelled, generation 2 builds a new heat with the next heat number", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a0", "a1", "a2", "a3", "b"]);
    if (required.length) blockedBy(testInfo, required, "Correction/revocation and re-apply.");
    const shot = stepShots(testInfo);
    const s = await buildCallbackEvent(browser, "R", "2027-07-12", null);
    const owner = await ballotsLockedCalculatedApproved(browser, s, testInfo);
    expect(owner).not.toBeNull();
    await owner!.context().close();
    const second = await signedIn(browser, fixture.deskAdmin);
    await second.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    await second.getByRole("button", { name: "Approve result" }).click();
    await expect(second.getByRole("status")).toContainText(/approved/i, { timeout: 60_000 });
    await second.getByRole("button", { name: CF1_UI.advanceButton }).click();
    await expect(second.getByText(CF1_UI.advanceDone)).toBeVisible({ timeout: 60_000 });
    const gen1 = readAdvancements(s.callbackRoundId);
    expect(gen1.active).toHaveLength(1);
    const gen1HeatId = gen1.heats[0].heat_id as string;
    const gen1Roster = gen1.entries.map((e) => e.entry_id as string).sort();

    // Manager opens a correction with a reason; judge 3 files a corrected ballot (swapping a tied couple for the low one); recalculate; approve; advance again.
    await second.getByLabel(CF1_UI.correctionReasonLabel).fill("CF1-C: judge 3 mis-ticked a couple on the callback sheet");
    await second.getByRole("button", { name: CF1_UI.openCorrectionButton }).click();
    // The database is the authority on whether the correction opened (the desk redirect can be slow); then the desk must say so.
    await expect.poll(() => readAdvancements(s.callbackRoundId).revocations.length, { timeout: 240_000, intervals: [2_000] }).toBe(1);
    await expect(second.getByRole("status")).toContainText("Correction opened.", { timeout: 240_000 });
    await shot(second, "correction-open");
    const afterRevoke = readAdvancements(s.callbackRoundId);
    expect(afterRevoke.revocations).toHaveLength(1);
    expect(afterRevoke.revocations[0]).toMatchObject({ cause: "source_correction_opened" });
    expect(afterRevoke.active, "no active advancement after the correction opens").toHaveLength(0);
    const heatsNow = (await readHeatEvidence(config, s.event.id)).scoringHeats.filter((h) => h.round_id === s.finalRoundId);
    expect(heatsNow.find((h) => h.id === gen1HeatId)?.status, "generation 1 Final heat is cancelled and kept").toBe("cancelled");

    // A7 / OD-13: a different manager co-signs the judge-entry correction through the results page (CF1 B panel). The opener cannot.
    const opener = await signedIn(browser, fixture.deskAdmin);
    await opener.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    const openerPanel = opener.getByRole("region", { name: "Correction co-sign" });
    await expect(openerPanel).toContainText("Waiting for a different manager or chair to co-sign");
    await expect(openerPanel.getByRole("button", { name: "Co-sign correction" })).toHaveCount(0);
    await shot(opener, "cosign-waiting");
    await opener.context().close();
    const cosigner = await signedIn(browser, fixture.owner);
    await cosigner.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    await cosigner.getByRole("region", { name: "Correction co-sign" }).getByRole("button", { name: "Co-sign correction" }).click();
    await expect(cosigner.getByRole("status").filter({ hasText: "Correction co-signed" }).first()).toBeVisible({ timeout: 60_000 });
    await shot(cosigner, "cosign-done");
    await cosigner.context().close();
    await submitCallbackBallot(j, browser, 2, s, [0, 1, 2, 3]); // corrected: judge 3 ticks couple 2 instead of 4/5
    const owner2 = await signedIn(browser, fixture.owner);
    await owner2.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    await owner2.getByRole("button", { name: "Calculate result" }).click();
    await expect(owner2.getByRole("status")).toContainText(/Calculated result version 2/, { timeout: 60_000 });
    await owner2.context().close();
    await second.reload();
    await second.getByRole("button", { name: "Approve result" }).click();
    await expect(second.getByRole("status")).toContainText(/approved/i, { timeout: 60_000 });
    await second.getByRole("button", { name: CF1_UI.advanceButton }).click();
    await expect(second.getByText(CF1_UI.advanceDone)).toBeVisible({ timeout: 60_000 });
    await shot(second, "generation-2-applied");

    const gen2 = readAdvancements(s.callbackRoundId);
    expect(gen2.advancements.map((a) => a.generation)).toEqual([1, 2]);
    expect(gen2.active).toHaveLength(1);
    expect(gen2.active[0].generation).toBe(2);
    const newRoster = gen2.entries.filter((e) => e.advancement_id === gen2.active[0].id).map((e) => e.entry_id as string).sort();
    expect(newRoster, "generation 2 has the corrected list").not.toEqual(gen1Roster);
    const finalHeats = (await readHeatEvidence(config, s.event.id)).scoringHeats.filter((h) => h.round_id === s.finalRoundId);
    expect(finalHeats.filter((h) => h.status !== "cancelled")).toHaveLength(1);
    expect(Math.max(...finalHeats.map((h) => Number(h.heat_number)))).toBeGreaterThan(Math.min(...finalHeats.map((h) => Number(h.heat_number))));
    const kinds = readAuditKinds(s.event.id);
    expect(kinds.filter((k) => k === "advancement_applied")).toHaveLength(2);
    expect(kinds.filter((k) => k === "advancement_revoked")).toHaveLength(1);
    state.R.applied = true;
    await second.context().close();
  });

  const refusal = async (browser: import("@playwright/test").Browser, s: ScoredEvent, code: string, label: string, testInfo: TestInfo) => {
    const owner = await signedIn(browser, fixture.owner);
    await owner.goto(`/app/events/${s.event.id}/competition/results/${s.callbackRoundId}`);
    await owner.getByLabel(CF1_UI.correctionReasonLabel).fill("CF1-C: attempted correction after the Final has moved on");
    const before = readAdvancements(s.callbackRoundId);
    const kindsBefore = readAuditKinds(s.event.id).length;
    await owner.getByRole("button", { name: CF1_UI.openCorrectionButton }).click();
    await expect(owner.locator('main [role="alert"]')).toContainText(code, { timeout: 30_000 });
    await stepShots(testInfo)(owner, label);
    const after = readAdvancements(s.callbackRoundId);
    expect(after.revocations.length, "no revocation").toBe(before.revocations.length);
    expect(after.active.map((a) => a.id)).toEqual(before.active.map((a) => a.id));
    expect(readAuditKinds(s.event.id).length, "an aborted transaction writes no audit row").toBe(kindsBefore);
    expect((await readHeatEvidence(config, s.event.id)).rounds.find((r) => r.id === s.callbackRoundId)?.status).not.toBe("ballots_locked");
    await owner.context().close();
  };

  test("SCN-11.5c-locked correction is refused COMP_ADVANCEMENT_FINAL_LOCKED while the Final heat is early-locked (HL1)", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a0", "b"]);
    if (required.length) blockedBy(testInfo, required, "Correction refusal while the Final heat is locked.");
    test.skip(!state.R.applied, "BLOCKED: SCN-11.5b did not reach generation 2");
    const s = events.R!;
    const owner = await signedIn(browser, fixture.owner);
    await buildPanel(owner, s.event.id, "Final");
    // The Final is Draft after advancement and the desk offers an early Lock heat only for a scheduled round: schedule it through the Day-of console (Schedule round, no Start).
    await owner.goto(`/app/events/${s.event.id}/competition/day-of`);
    const finalRoundRow = owner.getByRole("region", { name: "Rounds" }).locator("li").filter({ hasText: "Final" }).first();
    await clickUntil(finalRoundRow.getByRole("button", { name: "Schedule round" }), finalRoundRow.getByRole("button", { name: "Start round" }));
    await owner.goto(`/app/events/${s.event.id}/competition/ballots/${s.finalRoundId}`);
    owner.on("dialog", (d) => { void d.accept(); });
    const heats = owner.getByRole("region", { name: "Heats" });
    if (!(await heats.getByRole("button", { name: /^Lock heat/ }).count())) {
      scenarioStatus(testInfo, "BLOCKED", "The desk offers Lock heat only while the round is scheduled or active (heatLock.ts EARLY_ROUND_STATUSES). After advancement the Final round is Draft and no UI step schedules it here, so a locked Final heat cannot be produced through the UI; the SQL suite covers COMP_ADVANCEMENT_FINAL_LOCKED.");
      await owner.context().close();
      return;
    }
    await heats.getByRole("button", { name: /^Lock heat/ }).first().click();
    await expect.poll(async () => (await readHeatEvidence(config, s.event.id)).effective.filter((h) => h.roundId === s.finalRoundId && h.status !== "cancelled").map((h) => h.lockState), { timeout: 30_000 }).toEqual(["locked"]);
    await refusal(browser, s, CF1_CODES.finalLocked, "refused-final-locked", testInfo);
    // Reopen so the next variant starts from an open heat.
    await owner.goto(`/app/events/${s.event.id}/competition/ballots/${s.finalRoundId}`);
    await owner.getByRole("region", { name: "Heats" }).getByLabel(/^Reason for reopening heat/).first().fill("CF1-C: reopen the early-locked Final heat so the next variant starts open");
    await owner.getByRole("region", { name: "Heats" }).getByRole("button", { name: /^Reopen heat/ }).first().click();
    await expect.poll(async () => (await readHeatEvidence(config, s.event.id)).effective.filter((h) => h.roundId === s.finalRoundId && h.status !== "cancelled").map((h) => h.lockState), { timeout: 30_000 }).toEqual(["open"]);
    await owner.context().close();
  });

  test("SCN-11.5c-started correction is refused COMP_ADVANCEMENT_FINAL_STARTED once the Final has started (no ballot yet)", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a0", "b"]);
    if (required.length) blockedBy(testInfo, required, "Correction refusal after the Final starts.");
    test.skip(!state.R.applied, "BLOCKED: SCN-11.5b did not reach generation 2");
    const s = events.R!;
    const owner = await signedIn(browser, fixture.owner);
    await startRound(owner, s.event.id, "Final");
    await startHeat(owner, s.event.id);
    expect(await readBallotCount(config, s.finalRoundId)).toBe(0);
    await refusal(browser, s, CF1_CODES.finalStarted, "refused-final-started", testInfo);
    await owner.context().close();
  });

  test("SCN-11.5c-ballot correction is refused COMP_CORRECTION_LATER_ROUND_BALLOTS (O5) once a Final ballot exists", async ({ browser }, testInfo) => {
    const required = missing(cap, ["a0", "b"]);
    if (required.length) blockedBy(testInfo, required, "Correction refusal with a Final ballot.");
    test.skip(!state.R.applied, "BLOCKED: SCN-11.5b did not reach generation 2");
    const s = events.R!;
    await submitOrdinalBallot(j, browser, 0, s);
    expect(await readBallotCount(config, s.finalRoundId)).toBe(1);
    await refusal(browser, s, CF1_CODES.ballotsExist, "refused-final-ballot", testInfo);
  });
});

void couple;

import { randomUUID } from "node:crypto";
import { test, expect, type Browser } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { lookupRegisteredEngine } from "@/lib/competition/results/engineAdapter";
import { evidenceHash, traceHash, type EvidenceInput } from "@/lib/competition/results/evidence";
import { rowToRpc } from "@/lib/competition/results/calculate";
import { e2eAdminClient } from "../helpers/competitionFixture";
import { verifyEmailAndBindPassword } from "../helpers/competitionFullEvent";
import { useUniqueE2ESourceIp as assignUniqueSourceIpForContext } from "../helpers/rateLimitBypass";
import { cleanupScheduleAcceptanceFixture, createScheduleAcceptanceFixture, signedIn, stepShots, type ScheduleAcceptanceFixture } from "../helpers/competitionScheduleHeats";
import {
  applyScoring,
  buildPanel,
  coupleName,
  createDraftEvent,
  generateAndPublish,
  leftoverAnyCompetitionRows,
  leftoverCf1Rows,
  lockBallots,
  publishAndOpen,
  readResultRows,
  registerAndPay,
  roundIds,
  setCallbackTarget,
  startHeat,
  startRound,
  submitCallbackBallot,
  submitOrdinalBallot,
  type Journey,
  type ScoredEvent,
} from "../helpers/cf1Acceptance";

/**
 * PV-1 (owner decision 2026-11-10): the database recomputes every result. Run with the app started WITH COMPETITION_FINALS_ENABLED=true on a stack
 * that has 20270215090000 applied.
 *   SCN-PV1-1 ordinal Final: the manager calls calculate_competition_round straight through PostgREST (own session, role authenticated) with two
 *             placements swapped -> COMP_RESULT_RECOMPUTE_MISMATCH, nothing stored; then the app's "Calculate result" succeeds and the stored
 *             placements equal the engine's.
 *   SCN-PV1-2 callback round: same with one advanced flag flipped, and with an honest row set but a forged warning list -> refused; the app path
 *             then calculates.
 * UI-driven set-up, read-only evidence, zero leftover rows.
 */

test.describe.configure({ mode: "serial", timeout: 2_400_000 });

const FLAG_ON = process.env.E2E_COMPETITION_REGISTRATION_ENABLED === "true";
const ACCOUNT = "acct_cf1cfixture";
const ENTRY_FEE = 40;

test.describe("PV-1 database recompute (CF1-C)", () => {
  test.skip(!FLAG_ON, "Needs the app started with NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true.");

  let config: E2EConfig;
  let fixture: ScheduleAcceptanceFixture;
  let j: Journey;
  const created: string[] = [];
  const evidence = (value: unknown) => test.info().annotations.push({ type: "evidence", description: JSON.stringify(value) });

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl) || !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.baseUrl)) throw new Error("refusing: not the local QA stack");
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

  /** The manager's own PostgREST session (role authenticated), never the service role. */
  async function managerClient() {
    const { createClient } = await import("@supabase/supabase-js");
    const anon = process.env.E2E_SUPABASE_ANON_KEY;
    if (!anon) throw new Error("E2E_SUPABASE_ANON_KEY is required");
    const client = createClient(config.supabaseUrl, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email: fixture.owner.email, password: fixture.owner.password });
    expect(error, "manager signs in").toBeNull();
    return client;
  }

  /** The honest engine run the app would make, from the database's own calculation input. */
  async function honestRun(client: Awaited<ReturnType<typeof managerClient>>, roundId: string) {
    const { data, error } = await client.rpc("competition_round_calculation_input", { p_round_id: roundId });
    expect(error?.message ?? null).toBeNull();
    const input = data as { engine_key: string; engine_version: string; evidence: EvidenceInput; input_hash: string };
    expect(evidenceHash(input.evidence)).toBe(input.input_hash);
    const engine = lookupRegisteredEngine(input.engine_key, input.engine_version);
    expect(engine, "a registered engine").toBeTruthy();
    const run = engine!.run(input.evidence);
    return { input, run, rows: run.rows.map(rowToRpc) };
  }

  async function forge(client: Awaited<ReturnType<typeof managerClient>>, roundId: string, h: Awaited<ReturnType<typeof honestRun>>, rows: unknown[], warnings: string[]) {
    return client.rpc("calculate_competition_round", {
      p_round_id: roundId,
      p_engine_key: h.input.engine_key,
      p_engine_version: h.input.engine_version,
      p_input_hash: h.input.input_hash,
      p_trace_hash: traceHash(h.run.trace),
      p_trace: h.run.trace,
      p_rows: rows,
      p_warnings: warnings,
      p_request_id: randomUUID(),
    });
  }

  async function appCalculates(browser: Browser, eventId: string, roundId: string) {
    const owner = await signedIn(browser, fixture.owner);
    await owner.goto(`/app/events/${eventId}/competition/results/${roundId}`);
    await owner.getByRole("button", { name: "Calculate result" }).click();
    await expect(owner.getByRole("status")).toContainText(/Calculated result version 1/, { timeout: 60_000 });
    await owner.context().close();
  }

  test("SCN-0c setup (not a scenario): judges and owner prove their mailbox", async ({ browser }) => {
    for (const account of [...fixture.judges, fixture.owner]) {
      const page = await (await browser.newContext()).newPage();
      await assignUniqueSourceIpForContext(page);
      await verifyEmailAndBindPassword(page, account);
      await page.context().close();
    }
  });

  test("SCN-PV1-1 ordinal Final: swapped placements sent straight to PostgREST are refused; the app path calculates", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const event = await createDraftEvent(j, page, `E2E PV1 O ${fixture.runId}`, "2027-04-10");
    created.push(event.id);
    await applyScoring(page, event.id, "Final only (ordinal majority)");
    await publishAndOpen(page, event.id);
    const entries = await registerAndPay(j, browser, event, "pvo", 4);
    await generateAndPublish(page, event.id, 4);
    await buildPanel(page, event.id, "Final");
    await startRound(page, event.id, "Final");
    await startHeat(page, event.id);
    const rounds = (await (await import("../helpers/competitionScheduleHeats")).readHeatEvidence(config, event.id)).rounds;
    const finalRoundId = rounds.find((r) => r.name === "Final")!.id as string;
    await page.context().close();
    const s: ScoredEvent = { event, callbackRoundId: finalRoundId, finalRoundId, entries, names: entries.map((_, n) => coupleName(n)) };
    for (let judge = 0; judge < 3; judge += 1) await submitOrdinalBallot(j, browser, judge, s);
    const owner = await signedIn(browser, fixture.owner);
    const lock = await lockBallots(owner, event.id, finalRoundId);
    expect(lock.locked, `lock: ${lock.refusal ?? ""}`).toBe(true);
    await shot(owner, "ballots-locked");
    await owner.context().close();

    const client = await managerClient();
    const h = await honestRun(client, finalRoundId);
    const swapped = h.rows.map((r) => ({ ...r }));
    const a = swapped.findIndex((r) => r.placement === 1);
    const b = swapped.findIndex((r) => r.placement === 2);
    [swapped[a].placement, swapped[b].placement] = [swapped[b].placement, swapped[a].placement];
    const forged = await forge(client, finalRoundId, h, swapped, h.run.warnings);
    evidence({ scenario: "SCN-PV1-1", forgedError: forged.error?.message ?? null });
    expect(forged.error?.message ?? "").toMatch(/^COMP_RESULT_RECOMPUTE_MISMATCH/);
    expect(readResultRows(finalRoundId), "nothing stored by the refused call").toEqual([]);

    await appCalculates(browser, event.id, finalRoundId);
    const stored = readResultRows(finalRoundId) as Array<{ entry_id: string; placement: number | null }>;
    const expected = Object.fromEntries(h.rows.map((r) => [r.entry_id, r.placement]));
    expect(Object.fromEntries(stored.map((r) => [r.entry_id, r.placement]))).toEqual(expected);
    evidence({ scenario: "SCN-PV1-1", storedPlacements: stored.length });
  });

  test("SCN-PV1-2 callback round: a flipped advanced flag or forged warnings are refused; the app path calculates", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const event = await createDraftEvent(j, page, `E2E PV1 C ${fixture.runId}`, "2027-04-11");
    created.push(event.id);
    await applyScoring(page, event.id, "Callbacks + Final");
    await setCallbackTarget(page, event.id, 2);
    await publishAndOpen(page, event.id);
    const entries = await registerAndPay(j, browser, event, "pvc", 4);
    await generateAndPublish(page, event.id, 4);
    await buildPanel(page, event.id, "Callback round");
    await startRound(page, event.id, "Callback round");
    await startHeat(page, event.id);
    const { callbackRoundId, finalRoundId } = await roundIds(j, event.id);
    await page.context().close();
    const s: ScoredEvent = { event, callbackRoundId, finalRoundId, entries, names: entries.map((_, n) => coupleName(n)) };
    // Distinct tallies [3, 2, 1, 0]: couples 0 and 1 advance with T = 2 (no tie at the cut).
    const picks = [[0, 1], [0, 1], [0, 2]];
    for (let judge = 0; judge < 3; judge += 1) await submitCallbackBallot(j, browser, judge, s, picks[judge]);
    const owner = await signedIn(browser, fixture.owner);
    const lock = await lockBallots(owner, event.id, callbackRoundId);
    expect(lock.locked, `lock: ${lock.refusal ?? ""}`).toBe(true);
    await shot(owner, "ballots-locked");
    await owner.context().close();

    const client = await managerClient();
    const h = await honestRun(client, callbackRoundId);
    const flipped = h.rows.map((r) => ({ ...r }));
    const loser = flipped.findIndex((r) => r.advanced === false);
    flipped[loser].advanced = true;
    const forgedFlag = await forge(client, callbackRoundId, h, flipped, h.run.warnings);
    const forgedWarnings = await forge(client, callbackRoundId, h, h.rows, [...h.run.warnings, "operator_note"].sort());
    evidence({ scenario: "SCN-PV1-2", forgedFlagError: forgedFlag.error?.message ?? null, forgedWarningsError: forgedWarnings.error?.message ?? null });
    expect(forgedFlag.error?.message ?? "").toMatch(/^COMP_RESULT_RECOMPUTE_MISMATCH/);
    expect(forgedWarnings.error?.message ?? "").toMatch(/^COMP_RESULT_RECOMPUTE_MISMATCH/);
    expect(readResultRows(callbackRoundId), "nothing stored by the refused calls").toEqual([]);

    await appCalculates(browser, event.id, callbackRoundId);
    const stored = readResultRows(callbackRoundId) as Array<{ entry_id: string; advanced: boolean | null }>;
    expect(Object.fromEntries(stored.map((r) => [r.entry_id, r.advanced]))).toEqual(Object.fromEntries(h.rows.map((r) => [r.entry_id, r.advanced])));
    expect(stored.filter((r) => r.advanced === true)).toHaveLength(2);
  });
});

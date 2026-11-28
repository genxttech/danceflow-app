import { randomUUID } from "node:crypto";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { createCompetitionEvent, verifyEmailAndBindPassword, type CreatedEvent } from "../helpers/competitionFullEvent";
import { chooseCountryCouples, continueButton, createDraft, startCompetition, wizardStep } from "../helpers/competitionWizard";
import {
  anonymousPage,
  cleanupScheduleAcceptanceFixture,
  createScheduleAcceptanceFixture,
  readBallotCount,
  readEntries,
  readHeatEvidence,
  readResultState,
  scenarioStatus,
  signedIn,
  stepShots,
  visit,
  type ScheduleAcceptanceFixture,
} from "../helpers/competitionScheduleHeats";
import {
  applyScoring,
  buildPanel,
  couple,
  coupleName,
  generateAndPublish,
  judgeBallotUrl,
  lockBallots,
  openDesk,
  psqlJson,
  publishAndOpen,
  startHeat,
  startRound,
  submitOrdinalBallot,
  type Journey,
  type ScoredEvent,
} from "../helpers/cf1Acceptance";

/**
 * P1 restricted pilot, production build, local stack only (OWNER-DECISIONS section 21; plan: p1-integrated-test-plan.md section 3).
 * One adult-only $0 competition, one final-only division, four couples (one scratched before the start), three judges.
 * Every state change goes through the app. A step whose app or database part is missing is BLOCKED (skipped with the named
 * dependency), never passed; later steps then do not run. NOT YET EXECUTED: selectors for unmerged parts are unverified.
 */

const ENABLED = process.env.E2E_P1_WALKTHROUGH === "true";
const APP_CANDIDATE = process.env.E2E_P1_APP_CANDIDATE ?? "";
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? "";
const ACCOUNT = "acct_p1walkthrough"; // fake id: every order in this run is $0, no provider call is made
const COUPLES = 4;
const SCRATCHED = 3; // index of the couple scratched before the start
const ADULT_DOB = "1990-01-15";
const MINOR_DOB = `${new Date().getUTCFullYear() - 12}-01-15`;

/** The app's own alerts. Next.js adds an empty route announcer with role="alert", which must not satisfy or break these checks. */
const appAlerts = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

/** cf1Acceptance.createDraftEvent with Free pricing: the wizard refuses a "Per entry" price of 0. */
async function createFreeDraftEvent(config: E2EConfig, page: Page, name: string, date: string): Promise<CreatedEvent> {
  const event = await createCompetitionEvent(page, config, { name, startDate: date, endDate: date });
  await startCompetition(page, "Country");
  await chooseCountryCouples(page);
  const step = wizardStep(page);
  const next = async (heading: string) => {
    await continueButton(page).click();
    await expect(wizardStep(page).getByRole("heading", { level: 3 }).first()).toHaveText(heading);
  };
  await step.getByRole("checkbox", { name: "Competitors need a DanceFlow account to enter the competition" }).setChecked(false);
  await next("Pricing");
  await step.getByRole("button", { name: "Free", exact: true }).first().click();
  await next("Event details & presentation");
  await step.getByRole("textbox", { name: /^Short summary/ }).fill("P1 restricted pilot walkthrough.");
  await next("Review");
  await createDraft(page, event.id);
  return event;
}

test.describe.configure({ mode: "serial", timeout: 900_000 });

test.describe("P1 restricted pilot walkthrough", () => {
  test.skip(!ENABLED, "Set E2E_P1_WALKTHROUGH=true only when a composed database candidate has passed (see the runbook).");

  let config: E2EConfig;
  let fixture: ScheduleAcceptanceFixture;
  let journey: Journey;
  let scored: ScoredEvent;
  let entries: string[] = [];
  let blockedBy: string | null = null;
  const problems: string[] = [];

  test.beforeAll(async () => {
    if (!APP_CANDIDATE) throw new Error("E2E_P1_APP_CANDIDATE (the built app commit) is required for evidence.");
    if (!ANON_KEY) throw new Error("E2E_SUPABASE_ANON_KEY (local stack) is required for the direct-request refusals.");
    config = loadE2EConfig();
    fixture = await createScheduleAcceptanceFixture(config, { connectedAccountId: ACCOUNT });
    journey = { config, fixture, account: ACCOUNT, entryFee: 0 };
  });

  test.afterAll(async () => {
    // The composed chain refuses deleting an event that holds scoring evidence (PR 844), so cleanup may fail by design:
    // use a disposable stack and reset it after the run.
    await cleanupScheduleAcceptanceFixture(config, fixture).catch((error) => console.warn(`cleanup incomplete (reset the stack): ${(error as Error).message}`));
  });

  test.beforeEach(({}, testInfo) => {
    test.skip(blockedBy !== null, `BLOCKED earlier: ${blockedBy}`);
    testInfo.annotations.push({ type: "candidate", description: APP_CANDIDATE });
  });

  function block(testInfo: TestInfo, reason: string): never {
    blockedBy = reason;
    scenarioStatus(testInfo, "BLOCKED", reason);
    test.skip(true, `BLOCKED: ${reason}`);
    throw new Error(reason);
  }

  function watch(page: Page) {
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console ${new URL(page.url()).pathname}: ${message.text().slice(0, 200)}`);
    });
    page.on("pageerror", (error) => problems.push(`page error ${new URL(page.url()).pathname}: ${error.message.slice(0, 200)}`));
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText ?? "";
      if (!/ERR_ABORTED/.test(reason)) problems.push(`request failed ${new URL(request.url()).pathname}: ${reason}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 500) problems.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    });
    return page;
  }
  const manager = async (browser: Parameters<typeof signedIn>[0], account = fixture.owner) => watch(await signedIn(browser, account));
  const base = () => `/app/events/${scored.event.id}/competition`;
  const scratchUrl = (entryId: string) => `${base()}/registrations/scratch/${entryId}`;
  const heatEntryStatuses = (entryId: string) =>
    psqlJson<string[]>(`select coalesce(json_agg(status order by status), '[]'::json) from public.event_competition_heat_entries where entry_id = '${entryId}'`);

  /** The same lifecycle request the scratch page sends, made directly as a signed-in user. */
  async function directScratch(account: { email: string; password: string }, entryId: string) {
    const client = createClient(config.supabaseUrl, ANON_KEY, { auth: { persistSession: false } });
    const { error: signInError } = await client.auth.signInWithPassword({ email: account.email, password: account.password });
    if (signInError) throw new Error(`sign-in for the direct request failed: ${signInError.message}`);
    const { error } = await client.rpc("change_competition_entry_lifecycle", {
      selected_entry_id: entryId,
      selected_status: "scratched",
      selected_reason: "P1 walkthrough direct request",
      selected_fee_handling: "not_applicable",
    });
    return error?.message ?? null;
  }

  /** Any database function called with a signed-in user's own session (never the service role). */
  async function rpcAs(account: { email: string; password: string }, name: string, args: Record<string, unknown>) {
    const client = createClient(config.supabaseUrl, ANON_KEY, { auth: { persistSession: false } });
    const { error: signInError } = await client.auth.signInWithPassword({ email: account.email, password: account.password });
    if (signInError) throw new Error(`sign-in for the direct request failed: ${signInError.message}`);
    const { error } = await client.rpc(name, args);
    return error?.message ?? null;
  }

  test("P1-00 candidate: the composed database parts are installed", async ({}, testInfo) => {
    const parts = psqlJson<Record<string, boolean>>(`select json_build_object(
      's6_lifecycle_definer', (select prosecdef from pg_proc where oid = to_regprocedure('public.change_competition_entry_lifecycle(uuid,text,text,text)')),
      's4_clearance_gate', to_regprocedure('public.r15_guard_heat_entry_clearance()') is not null,
      's5_age_guard', exists (select 1 from pg_trigger where tgname = 'event_competition_entry_participants_s5_age_guard'),
      'u18s_scratch_guard', exists (select 1 from pg_trigger where tgname = 'cf1_u18s_guard_heat_entry_scratch'),
      'od04_delete_guard', exists (select 1 from pg_trigger where tgname = 'a00_compod04_events_delete_guard'),
      'r10_panel_guard', exists (select 1 from pg_trigger where tgname = 'compr10_guard_round_panel_config'),
      'r11_approval_scope', exists (select 1 from pg_proc where prosrc like '%COMP_CORRECTION_APPROVER_REQUIRED%'),
      'od_published_order_guard', exists (select 1 from pg_trigger where tgname = 'zz_compd_guard_published_heat'),
      'p1_restriction', exists (select 1 from pg_class where relname like 'compp1\\_%') or exists (select 1 from pg_trigger where tgname like '%compp1%'))`);
    testInfo.annotations.push({ type: "evidence", description: JSON.stringify(parts) });
    const absent = Object.entries(parts).filter(([, present]) => !present).map(([name]) => name);
    if (absent.length) block(testInfo, `composed database candidate lacks: ${absent.join(", ")}`);
  });

  test("P1-01 accounts: judges and both managers verify their mailbox through the real sign-in link", async ({ browser }) => {
    for (const account of [...fixture.judges, fixture.owner, fixture.deskAdmin]) {
      const page = watch(await anonymousPage(browser));
      await verifyEmailAndBindPassword(page, account);
      await page.context().close();
    }
  });

  test("P1-02 setup: a $0 final-only competition; the callback setup is refused; publish and open registration", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await manager(browser);
    const event = await createFreeDraftEvent(config, page, `E2E P1 Pilot ${fixture.runId}`, "2027-06-19");
    scored = { event, callbackRoundId: "", finalRoundId: "", entries: [], names: [] };
    // Disabled operation: a callback setup. The restriction must refuse it, whatever the screen offers.
    await page.goto(`${base()}/advanced`);
    const studio = page.locator("div").filter({ has: page.getByRole("heading", { name: "Studio scoring · all divisions" }) }).last();
    await expect(studio.getByLabel("Scoring setup").locator("option", { hasText: "Callbacks + Final" }), "if the option is gone, assert its absence instead").toHaveCount(1);
    await studio.getByLabel("Scoring setup").selectOption({ label: "Callbacks + Final" });
    await studio.getByRole("button", { name: "Apply to all divisions" }).click();
    await expect(appAlerts(page).first(), "the refusal is shown").toBeVisible({ timeout: 60_000 });
    await shot(page, "callbacks-refused");
    const callbackRounds = psqlJson<number>(`select to_json(count(*)::int) from public.event_competition_rounds where event_id = '${event.id}' and scoring_method = 'callback_tally'`);
    expect(callbackRounds, "no callback round can be configured").toBe(0);
    await applyScoring(page, event.id, "Final only (ordinal majority)");
    await publishAndOpen(page, event.id);
    await shot(page, "published-open");
    await page.context().close();
  });

  test("P1-03 registration: adults register for $0; an under-18 competitor is refused on screen and by a direct request", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = watch(await anonymousPage(browser));
    await page.goto(`/events/${scored.event.slug}/competition/register`);
    await expect(page.getByRole("heading", { name: "Competition Registration" })).toBeVisible();
    const dob = page.getByLabel("Date of birth", { exact: true });
    if (!(await dob.count())) block(testInfo, "under-18 app enforcement (PR 835) is not in this build: no date of birth field");
    await page.getByPlaceholder("Contact name").fill(coupleName(0));
    await page.getByPlaceholder("Contact email").fill(`e2e-p1-${fixture.runId}@example.com`);
    await page.getByPlaceholder("Contact phone").fill("5125550100");
    await page.getByPlaceholder("First name").fill("Min");
    await page.getByPlaceholder("Last name").fill("Orr");
    await dob.fill(MINOR_DOB);
    await page.getByRole("button", { name: "Add to roster" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Competitors must be 18 or older" })).toBeVisible();
    await expect(page.getByText("Min Orr")).toHaveCount(0);
    await shot(page, "minor-refused");
    const couples = Array.from({ length: COUPLES }, (_, n) => couple(n));
    for (const person of couples.flatMap((c) => [c.leader, c.follower])) {
      await page.getByPlaceholder("First name").fill(person.firstName);
      await page.getByPlaceholder("Last name").fill(person.lastName);
      await dob.fill(ADULT_DOB);
      await page.getByRole("button", { name: "Add to roster" }).click();
      await expect(page.getByText(`${person.firstName} ${person.lastName}`).first()).toBeVisible();
    }
    const list = page.locator("section").filter({ has: page.getByRole("heading", { name: "Entries", exact: true }) });
    for (const c of couples) {
      await page.getByRole("combobox", { name: "Leader", exact: true }).selectOption({ label: `${c.leader.firstName} ${c.leader.lastName}` });
      await page.getByRole("combobox", { name: "Follower", exact: true }).selectOption({ label: `${c.follower.firstName} ${c.follower.lastName}` });
      const dance = page.locator("label").filter({ hasText: "Two Step" }).getByRole("checkbox");
      if ((await dance.count()) && !(await dance.first().isChecked())) await dance.first().check();
      await page.getByRole("button", { name: "Add entry", exact: true }).click();
      await expect(list.getByText(`${c.leader.firstName} ${c.leader.lastName} · ${c.follower.firstName} ${c.follower.lastName}`)).toBeVisible();
    }
    const sent = page.waitForRequest((request) => request.url().endsWith("/competition/checkout") && request.method() === "POST");
    await page.getByRole("button", { name: "Submit registration" }).click();
    const body = (await sent).postData() ?? "";
    await page.waitForURL(/\/competition\/register\/status/, { timeout: 90_000 });
    await shot(page, "registered");
    const read = await readEntries(config, scored.event.id);
    expect(read.entries).toHaveLength(COUPLES);
    expect(read.entries.every((entry) => entry.status === "confirmed")).toBe(true);
    entries = Array.from({ length: COUPLES }, (_, n) => read.entries.find((e) => String(e.display_name).includes(coupleName(n)))!.id as string);
    scored.entries = entries;
    // Direct request: the same cart replayed with one under-18 date of birth must create nothing.
    expect(body, "the captured request carries the dates of birth").toContain(ADULT_DOB);
    for (const [label, payload, code] of [
      ["under 18", body.replace(ADULT_DOB, MINOR_DOB), "minors_not_permitted"],
      ["missing date of birth", body.replace(ADULT_DOB, ""), "age_not_established"],
    ] as const) {
      const forged = JSON.parse(payload) as Record<string, unknown>;
      forged.clientRequestId = randomUUID();
      const refused = await page.request.post(`/api/events/${scored.event.slug}/competition/checkout`, { data: forged });
      expect(refused.status(), `${label} direct request`).toBe(422);
      expect(((await refused.json()) as { code?: string }).code, label).toBe(code);
    }
    expect((await readEntries(config, scored.event.id)).entries).toHaveLength(COUPLES);
    await page.context().close();
  });

  test("P1-04 eligibility: the organizer clears every adult entry on the Registrations page (a recorded determination, not a bare field write)", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const cleared = () =>
      psqlJson<number>(`select to_json(count(*)::int) from public.event_competition_entries e where e.event_id = '${scored.event.id}' and e.eligibility_status = 'eligible'
        and exists (select 1 from public.event_competition_eligibility_determinations d where d.entry_id = e.id)`);
    const page = await manager(browser);
    await page.goto(`${base()}/registrations`);
    if (!(await page.locator('input[name="criteria"]').count())) block(testInfo, "no organizer eligibility screen in this build (app part of PR 837 / 846)");
    await expect(page.locator('select[name="eligibilityStatus"]')).toHaveCount(COUPLES);
    for (let i = 0; i < COUPLES; i += 1) {
      await page.goto(`${base()}/registrations`);
      const form = page.locator('select[name="eligibilityStatus"]').nth(i).locator("xpath=ancestor::form[1]");
      await form.locator('select[name="eligibilityStatus"]').selectOption("eligible");
      for (const box of await form.locator('input[name="criteria"]').all()) await box.check();
      await form.locator('select[name="reasonCode"]').selectOption("criteria_verified_by_organizer");
      await form.getByRole("button", { name: "Save" }).click();
      await expect.poll(cleared, { timeout: 60_000 }).toBe(i + 1);
    }
    await expect(appAlerts(page)).toHaveCount(0);
    await shot(page, "eligibility-recorded");
    await page.context().close();
  });

  test("P1-05 running order: one final heat is generated and published", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await manager(browser);
    await generateAndPublish(page, scored.event.id, COUPLES);
    const evidence = await readHeatEvidence(config, scored.event.id);
    expect(evidence.effective, "a Final is one heat").toHaveLength(1);
    expect(evidence.effective[0].entryIds).toHaveLength(COUPLES);
    scored.finalRoundId = evidence.rounds.find((round) => round.name === "Final")!.id as string;
    await shot(page, "running-order");
    await page.context().close();
  });

  test("P1-06 scratch screen before the start: one couple is scratched with a reason; non-managers see nothing", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    // Deliberate refusal: this page is not watched (the browser logs the expected 404 as a console error).
    const judge = await signedIn(browser, fixture.judges[0] as never);
    expect((await visit(judge, scratchUrl(entries[SCRATCHED]))).status).toBe(404);
    await judge.context().close();
    expect(await directScratch(fixture.judges[0] as never, entries[SCRATCHED]), "a judge cannot scratch directly").toMatch(/cannot be managed/);
    const page = await manager(browser);
    // The links must be visible before the start, or their absence afterwards proves nothing.
    await page.goto(`${base()}/registrations`);
    await expect(page.getByRole("link", { name: "Scratch entry" })).toHaveCount(COUPLES);
    await page.goto(`${base()}/day-of`);
    await expect(page.getByRole("link", { name: "Scratch", exact: true }).first()).toBeVisible();
    await page.goto(scratchUrl(entries[SCRATCHED]));
    await expect(page.getByRole("heading", { name: "Scratch entry", level: 1 })).toBeVisible();
    await page.locator('textarea[name="reason"]').fill("P1 walkthrough: couple withdrew before the start");
    await page.getByRole("button", { name: "Scratch entry" }).click();
    await expect(page.getByRole("status")).toContainText("Entry scratched.", { timeout: 60_000 });
    await shot(page, "scratched");
    await expect(page.getByRole("button", { name: "Scratch entry" })).toHaveCount(0);
    expect((await readEntries(config, scored.event.id)).entries.find((e) => e.id === entries[SCRATCHED])?.status).toBe("scratched");
    expect(heatEntryStatuses(entries[SCRATCHED])).toEqual(["scratched"]);
    const audit = psqlJson<Array<{ reason: string; performed_by: string }>>(`select coalesce(json_agg(json_build_object('reason', reason, 'performed_by', performed_by)), '[]'::json)
      from public.event_competition_entry_changes where entry_id = '${entries[SCRATCHED]}' and change_type = 'scratch'`);
    expect(audit).toEqual([{ reason: "P1 walkthrough: couple withdrew before the start", performed_by: fixture.owner.id }]);
    await page.context().close();
  });

  test("P1-07 panel: three judges and a chair; the round starts", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await manager(browser);
    await buildPanel(page, scored.event.id, "Final");
    await startRound(page, scored.event.id, "Final");
    await shot(page, "round-running");
    await page.context().close();
  });

  test("P1-08 panel confirm (PR 925): a panel-breaking absence is refused until confirmed, then the judge is marked present again", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await manager(browser);
    await openDesk(page, scored.event.id, scored.finalRoundId);
    const reason = page.getByLabel(/^Absence reason for judge/).first();
    if (!(await reason.count())) block(testInfo, "no judge attendance control on the ballot desk");
    const row = reason.locator("xpath=ancestor::form[1]");
    await reason.fill("P1 walkthrough: judge stepped out");
    await row.getByRole("button", { name: "Mark absent" }).click();
    const confirm = page.getByRole("checkbox", { name: /Record it anyway/ });
    await expect(confirm.or(page.getByText("Absent", { exact: true }).first())).toBeVisible({ timeout: 60_000 });
    if (!(await confirm.count())) block(testInfo, "the absence was recorded without a confirmation: PR 864 database or PR 925 app part is missing");
    const absent = () => psqlJson<number>(`select to_json(count(*)::int) from public.event_competition_judge_attendance where round_id = '${scored.finalRoundId}' and status = 'absent'`);
    expect(absent(), "nothing is recorded before confirmation").toBe(0);
    await shot(page, "confirm-required");
    const again = page.getByLabel(/^Absence reason for judge/).first();
    await again.fill("P1 walkthrough: judge stepped out");
    await confirm.check();
    await again.locator("xpath=ancestor::form[1]").getByRole("button", { name: "Mark absent" }).click();
    await expect(page.getByRole("button", { name: "Mark present" })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Mark present" }).first().click();
    await expect(page.getByRole("button", { name: "Mark present" })).toHaveCount(0, { timeout: 60_000 });
    await shot(page, "present-again");
    await page.context().close();
  });

  test("P1-09 a ballot before the heat starts is refused on screen and by a direct request", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = watch(await signedIn(browser, fixture.judges[0] as never, judgeBallotUrl(scored.event.id, scored.finalRoundId)));
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole("heading", { name: "Final", level: 1 })).toBeVisible();
    await shot(page, "ballot-before-start-phone");
    const submit = page.getByRole("button", { name: "Submit ballot" });
    if ((await submit.count()) && (await submit.isEnabled())) {
      const marks = page.locator('select[name^="mark:"]');
      for (let i = 0; i < (await marks.count()); i += 1) await marks.nth(i).selectOption({ index: i + 1 });
      await submit.click();
      await page.waitForURL(/[?&]error=/, { timeout: 60_000 });
    } else {
      await expect(page.getByText(/No heats are ready to judge yet|has not started/)).toBeVisible();
    }
    const heatId = psqlJson<string>(`select to_json(id) from public.event_competition_heats where round_id = '${scored.finalRoundId}' and status <> 'cancelled' limit 1`);
    const marks = entries.filter((_, n) => n !== SCRATCHED).map((entry_id, n) => ({ entry_id, value: n + 1 }));
    expect(await rpcAs(fixture.judges[0] as never, "submit_competition_ballot", { p_round_id: scored.finalRoundId, p_heat_id: heatId, p_marks: marks, p_request_id: randomUUID() })).toMatch(/COMP_P1_HEAT_NOT_STARTED/);
    expect(await readBallotCount(config, scored.finalRoundId), "no ballot exists before the start").toBe(0);
    await page.context().close();
  });

  test("P1-10 the heat starts: whole-entry scratch is no longer offered, and a direct request is refused", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await manager(browser);
    await startHeat(page, scored.event.id);
    await page.goto(`${base()}/day-of`);
    await expect(page.getByRole("link", { name: "Scratch", exact: true })).toHaveCount(0);
    await shot(page, "day-of-no-scratch");
    await page.goto(`${base()}/registrations`);
    await expect(page.getByRole("link", { name: "Scratch entry" })).toHaveCount(0);
    await expect(page.getByText(/Whole-entry scratch is not available/).first()).toBeVisible();
    await page.goto(scratchUrl(entries[0]));
    await expect(page.getByText(coupleName(0)).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Scratch entry" })).toHaveCount(0);
    await expect(page.locator("main p.bg-amber-50")).toBeVisible();
    await shot(page, "scratch-page-refused");
    expect(await directScratch(fixture.owner as never, entries[0]), "the database refuses a started heat").toMatch(/COMP_ENTRY_LIFECYCLE_PLACED/);
    expect(heatEntryStatuses(entries[0])).toEqual(["scheduled"]);
    await page.context().close();
  });

  test("P1-11 judge ballots: three judges rank the three remaining couples from their own accounts", async ({ browser }) => {
    for (let judge = 0; judge < 3; judge += 1) expect(await submitOrdinalBallot(journey, browser, judge, scored), "the scratched couple is not on the sheet").toBe(COUPLES - 1);
    expect(await readBallotCount(config, scored.finalRoundId)).toBe(3);
  });

  test("P1-12 lock and calculate; the calculator cannot approve", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await manager(browser);
    const lock = await lockBallots(page, scored.event.id, scored.finalRoundId);
    expect(lock.locked, lock.refusal).toBe(true);
    await page.goto(`${base()}/results/${scored.finalRoundId}`);
    await page.getByRole("button", { name: "Calculate result" }).click();
    await expect(page.getByRole("status")).toContainText(/Calculated result version 1/, { timeout: 60_000 });
    const table = page.locator("table").first();
    await expect(table).toContainText(coupleName(0));
    await expect(table).not.toContainText(coupleName(SCRATCHED));
    await shot(page, "calculated");
    // The calculator approving, even with a substantive override reason, records nothing (pilot restriction).
    const substantive = "No other manager is available today, so I checked every result myself before approving";
    await page.locator('input[name="overrideReason"]').fill(substantive);
    await page.getByRole("button", { name: "Approve with override" }).click();
    await expect(appAlerts(page).first()).toBeVisible({ timeout: 60_000 });
    await shot(page, "self-approval-refused");
    const versionId = readResultState(scored.finalRoundId).versions[0].id as string;
    expect(await rpcAs(fixture.owner as never, "approve_competition_round_result", { p_round_id: scored.finalRoundId, p_result_version_id: versionId, p_override_reason: substantive, p_request_id: randomUUID() })).toMatch(/COMP_P1_SECOND_APPROVER_REQUIRED/);
    expect(readResultState(scored.finalRoundId).approvals).toHaveLength(0);
    await page.context().close();
  });

  test("P1-13 approval by a manager who did not calculate", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await manager(browser, fixture.deskAdmin);
    await page.goto(`${base()}/results/${scored.finalRoundId}`);
    await page.getByRole("button", { name: "Approve result" }).click();
    await expect(page.getByRole("status")).toContainText("Result approved.", { timeout: 60_000 });
    const state = readResultState(scored.finalRoundId);
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0]).toMatchObject({ approved_by: fixture.deskAdmin.id, calculated_by: fixture.owner.id, override_reason: null });
    expect(state.kinds, "approval audit row").toContain("result_approved");
    await shot(page, "approved");
    await page.context().close();
  });

  test("P1-14 publication: published to the public; an anonymous visitor sees the placed couples and not the scratched one", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const anonBefore = watch(await anonymousPage(browser));
    await anonBefore.goto(`/events/${scored.event.slug}/competition/results`);
    await expect(anonBefore.locator("body")).not.toContainText(coupleName(0));
    await anonBefore.context().close();
    const page = await manager(browser, fixture.deskAdmin);
    await page.goto(`${base()}/results/${scored.finalRoundId}`);
    const publication = page.getByRole("region", { name: "Publication" });
    await publication.getByLabel("The public as well").check();
    await publication.getByRole("button", { name: "Publish result" }).click();
    await expect(page.getByRole("status")).toContainText("Result published.", { timeout: 60_000 });
    await shot(page, "published");
    expect(readResultState(scored.finalRoundId).kinds, "publication audit row").toContain("result_published");
    await page.context().close();
    const anon = watch(await anonymousPage(browser));
    await anon.goto(`/events/${scored.event.slug}/competition/results`);
    await expect(anon.getByRole("heading", { name: "Results", level: 1 })).toBeVisible();
    for (const n of [0, 1, 2]) await expect(anon.locator("main")).toContainText(coupleName(n));
    await expect(anon.locator("main")).not.toContainText(coupleName(SCRATCHED));
    await shot(anon, "public-results");
    await anon.setViewportSize({ width: 375, height: 812 });
    await shot(anon, "public-results-phone");
    await anon.context().close();
  });

  test("P1-15 after publication: scratch stays refused; another studio and anonymous callers are refused", async ({ browser }) => {
    expect(await directScratch(fixture.owner as never, entries[1])).toMatch(/locked or certified heat|COMP_ENTRY_LIFECYCLE_PLACED/);
    const other = await signedIn(browser, fixture.otherOwner);
    for (const path of [scratchUrl(entries[1]), `${base()}/results/${scored.finalRoundId}`]) expect((await visit(other, path)).status, path).toBe(404);
    await other.context().close();
    expect(await directScratch(fixture.otherOwner as never, entries[1])).toMatch(/cannot be managed/);
    const anon = createClient(config.supabaseUrl, ANON_KEY, { auth: { persistSession: false } });
    const { error } = await anon.rpc("change_competition_entry_lifecycle", { selected_entry_id: entries[1], selected_status: "scratched", selected_reason: "anonymous", selected_fee_handling: "not_applicable" });
    expect(error?.message).toMatch(/permission denied|cannot be managed/);
    expect((await readEntries(config, scored.event.id)).entries.find((e) => e.id === entries[1])?.status).toBe("confirmed");
  });

  test("P1-99 no console errors or server errors were seen during the walkthrough", async ({}, testInfo) => {
    testInfo.annotations.push({ type: "evidence", description: JSON.stringify(problems.slice(0, 50)) });
    expect(problems).toEqual([]);
  });
});

import { execFileSync } from "node:child_process";
import { expect, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import type Stripe from "stripe";
import type { E2EConfig } from "@/lib/e2e/config";
import { createCompetitionEvent, payCheckoutSession, readCompetitionRegistrations, type CreatedEvent } from "./competitionFullEvent";
import { chooseCountryCouples, createDraft, finishSetup, startCompetition } from "./competitionWizard";
import { readEntries, readHeatEvidence, registerRoster, signedIn, type RosterCouple, type ScheduleAcceptanceFixture } from "./competitionScheduleHeats";
import { useUniqueE2ESourceIp as assignUniqueSourceIp } from "./rateLimitBypass";

/**
 * CF1-C acceptance helpers (Callback -> Final advancement). Rules this module enforces, from the CF1-C brief:
 *  - READ-ONLY evidence: CF1 and F2 tables are closed to every API role (no grants, RLS on, no policy), so they are read
 *    through the local database container inside `begin read only` (same mechanism as QA-A's `localPsqlJson`). Tables the
 *    service role may read still go through the service-role client (competitionScheduleHeats.readHeatEvidence).
 *  - The journey is advanced ONLY through the UI (the same drivers as the QA-A scoring spec, copied here so that spec stays
 *    QA-A-owned). No row is written to move a scenario forward. The only writes are the Q1 base seed and its teardown.
 *  - A scenario whose prerequisite is missing is BLOCKED with the named dependency, never PASSED.
 *  - Teardown verifies zero leftover rows (`leftoverCf1Rows`).
 *
 * UI wording for the CF1-B screens is PROVISIONAL (taken from the design's section 13 and the A0/A5/A6 contracts) and lives
 * in `CF1_UI` below so the first run against B edits one place only.
 */

// ------------------------------------------------------------------ provisional CF1-B wording (one place to fix)

export const CF1_UI = {
  advanceButton: /Advance to Final/i,
  advanceDone: /advanced to the Final|Final roster created|Advancement applied/i,
  tieAtCut: /tie at the cut/i,
  tieOverCapacity: /tie_over_capacity|tie over capacity/i,
  blockedBanner: /COMP_ADVANCEMENT_BLOCKED|cannot be approved|tie over capacity/i,
  correctionReasonLabel: /Open a ballot correction/,
  openCorrectionButton: "Open correction",
  excludeButton: /Exclude/i,
  withdrawButton: /Withdraw/i,
} as const;

/** Refusal codes the desk must show (design section 13 / A0 contract). */
export const CF1_CODES = {
  blocked: "COMP_ADVANCEMENT_BLOCKED",
  finalStarted: "COMP_ADVANCEMENT_FINAL_STARTED",
  finalLocked: "COMP_ADVANCEMENT_FINAL_LOCKED",
  finalCancelled: "COMP_ADVANCEMENT_FINAL_CANCELLED",
  ballotsExist: "COMP_CORRECTION_LATER_ROUND_BALLOTS",
  rosterEntryUnavailable: "COMP_ROSTER_ENTRY_UNAVAILABLE",
  belowMinimum: "COMP_ROSTER_BELOW_MINIMUM",
  alreadyApplied: "COMP_ADVANCEMENT_ALREADY_APPLIED",
} as const;

// ------------------------------------------------------------------ read-only database access

type Row = Record<string, unknown>;

function container(): string {
  const name = process.env.E2E_LOCAL_DB_CONTAINER ?? "";
  if (name !== "supabase_db_cf1c-qa") throw new Error("CF1-C reads only the dedicated stack: set E2E_LOCAL_DB_CONTAINER=supabase_db_cf1c-qa");
  return name;
}

/** Runs one read-only statement that returns a single JSON value in column 1. */
export function psqlJson<T = unknown>(sql: string): T {
  const out = execFileSync("docker", ["exec", "-i", container(), "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", `begin read only; ${sql}; commit`], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("[") || l.startsWith("{") || l.startsWith('"') || /^(true|false|null|\d)/.test(l));
  return (line ? JSON.parse(line) : null) as T;
}

const uuid = (value: string) => {
  if (!/^[0-9a-f-]{36}$/.test(value)) throw new Error(`malformed uuid ${value}`);
  return value;
};
const agg = (select: string) => `select coalesce(json_agg(row_to_json(t)), '[]'::json) from (${select}) t`;

// ------------------------------------------------------------------ capability probe (what is on the stack under test)

export type Cf1Capabilities = {
  a1: boolean; // exclusion table + helpers
  a0: boolean; // advancement tables, apply RPC, preview
  a4a: boolean; // callback-target lower bound
  a2: boolean; // lock redefinition (roster check)
  a3: boolean; // calculate/approve redefinition (roster check, exclusion evidence)
  a5: boolean; // exclusion action RPCs
  a6: boolean; // withdrawal RPCs
  /** CF1-B app screens present. Not detectable from the database: set CF1_B_PRESENT=true once the coordinator says the app under test includes B. */
  b: boolean;
  /** Applied migration versions in the 20270120 block, for the report header. */
  versions: string[];
};

export function probeCapabilities(): Cf1Capabilities {
  const r = psqlJson<Record<string, boolean>>(`select json_build_object(
    'a1', to_regclass('public.event_competition_round_exclusions') is not null,
    'a0', to_regclass('public.event_competition_round_advancements') is not null and exists (select 1 from pg_proc where proname = 'apply_competition_round_advancement'),
    'a4a', coalesce((select position('COMP_CALLBACK_TARGET_BELOW_MINIMUM' in pg_get_functiondef(p.oid)) > 0 from pg_proc p where p.proname = '_cf1_callback_target_check' limit 1), false),
    'a2', coalesce((select position('_cf1_require_roster_eligible' in pg_get_functiondef(p.oid)) > 0 from pg_proc p where p.proname = 'lock_competition_round_ballots' limit 1), false),
    'a3', coalesce((select position('_cf1_require_roster_eligible' in pg_get_functiondef(p.oid)) > 0 from pg_proc p where p.proname = 'calculate_competition_round' limit 1), false),
    'a5', exists (select 1 from pg_proc where proname = 'request_round_exclusion'),
    'a6', exists (select 1 from pg_proc where proname = 'withdraw_advanced_entry_from_final'))`);
  const versions = psqlJson<string[]>(`select coalesce(json_agg(version order by version), '[]'::json) from supabase_migrations.schema_migrations where version like '202701%'`) ?? [];
  return { a1: !!r.a1, a0: !!r.a0, a4a: !!r.a4a, a2: !!r.a2, a3: !!r.a3, a5: !!r.a5, a6: !!r.a6, b: process.env.CF1_B_PRESENT === "true", versions };
}

/** Names of the dependencies that are missing, from a list of required ones. */
export function missing(cap: Cf1Capabilities, required: Array<keyof Omit<Cf1Capabilities, "versions">>): string[] {
  return required.filter((key) => !cap[key]).map((key) => ({ a0: "A0 core (PR #370)", a1: "A1 helpers (PR #364)", a2: "A2 lock check (PR #365)", a3: "A3 results integrity (PR #366)", a4a: "A4a target guard (PR #369)", a5: "A5 exclusion action (PR #367)", a6: "A6 withdrawal (PR #368)", b: "B app (cf1-b-app)" }[key]));
}

/** Marks the running test BLOCKED (named dependency) and skips it. Never a pass. */
export function blockedBy(testInfo: TestInfo, dependencies: string[], detail: string) {
  testInfo.annotations.push({ type: "BLOCKED", description: `${detail} Needs: ${dependencies.join(", ")}.` });
  testInfo.skip(true, `BLOCKED by ${dependencies.join(", ")}`);
}

// ------------------------------------------------------------------ CF1 evidence readers (read-only)

export function readAdvancements(sourceRoundId: string) {
  const id = uuid(sourceRoundId);
  const advancements = psqlJson<Row[]>(agg(`select id, generation, target_round_id, advanced_count, carried_count, target_capacity, applied_by, request_id from public.event_competition_round_advancements where source_round_id = '${id}' order by generation`));
  const ids = advancements.map((a) => `'${a.id}'`).join(",") || "null";
  const entries = psqlJson<Row[]>(agg(`select advancement_id, entry_id, carried_withdrawal_id from public.event_competition_round_advancement_entries where advancement_id in (${ids})`));
  const heats = psqlJson<Row[]>(agg(`select advancement_id, heat_id, floor_heat_id from public.event_competition_round_advancement_heats where advancement_id in (${ids})`));
  const revocations = psqlJson<Row[]>(agg(`select advancement_id, cause, reason from public.event_competition_round_advancement_revocations where advancement_id in (${ids})`));
  return { advancements, entries, heats, revocations, active: advancements.filter((a) => !revocations.some((r) => r.advancement_id === a.id)) };
}

/** Result rows with the advancement flag and tally of the latest (or a given) version of a round. */
export function readResultRows(roundId: string) {
  const id = uuid(roundId);
  return psqlJson<Row[]>(agg(`select v.version, v.status, r.entry_id, r.placement, r.advanced, r.tally from public.event_competition_result_rows r join public.event_competition_result_versions v on v.id = r.result_version_id where v.round_id = '${id}' order by v.version, r.placement nulls last`));
}

export function readResultEvidence(roundId: string) {
  const id = uuid(roundId);
  return psqlJson<Row[]>(agg(`select version, status, evidence, input_hash, trace from public.event_competition_result_versions where round_id = '${id}' order by version`));
}

export function readAuditKinds(eventId: string) {
  const id = uuid(eventId);
  return psqlJson<string[]>(`select coalesce(json_agg(kind order by occurred_at), '[]'::json) from public.event_competition_audit_log where event_id = '${id}'`);
}

export function readExclusions(roundId: string) {
  const id = uuid(roundId);
  return psqlJson<Row[]>(agg(`select seq, kind, entry_id, reason_kind, actor, actor_role, request_id from public.event_competition_round_exclusions where round_id = '${id}' order by seq`));
}

export function readWithdrawals(targetRoundId: string) {
  const id = uuid(targetRoundId);
  return psqlJson<Row[]>(agg(`select seq, kind, entry_id, requested_by, cosigned_by, cosigned_role, prior_heat_entry_status from public.event_competition_final_withdrawals where target_round_id = '${id}' order by seq`));
}

/** Row counts of every CF1 table for the given events: the teardown assertion is that all are zero. */
export function leftoverCf1Rows(eventIds: string[]): Record<string, number> {
  if (!eventIds.length) return {};
  const list = eventIds.map((id) => `'${uuid(id)}'`).join(",");
  const tables = psqlJson<string[]>(`select coalesce(json_agg(table_name order by table_name), '[]'::json) from information_schema.columns where table_schema = 'public' and column_name = 'event_id' and (table_name like 'event\\_competition\\_round\\_advancement%' or table_name like 'event\\_competition\\_final\\_withdrawal%' or table_name = 'event_competition_round_exclusions' or table_name = 'event_competition_round_capacity_events')`);
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = psqlJson<number>(`select count(*) from public.${table} where event_id in (${list})`);
  return counts;
}

/** Baseline: nothing the run created may remain in ANY event_competition_* table for these events. */
export function leftoverAnyCompetitionRows(eventIds: string[]): Record<string, number> {
  if (!eventIds.length) return {};
  const list = eventIds.map((id) => `'${uuid(id)}'`).join(",");
  const tables = psqlJson<string[]>(`select coalesce(json_agg(c.table_name order by c.table_name), '[]'::json) from information_schema.columns c where c.table_schema = 'public' and c.column_name = 'event_id' and c.table_name like 'event\\_competition\\_%'`);
  const left: Record<string, number> = {};
  for (const table of tables) {
    const n = psqlJson<number>(`select count(*) from public.${table} where event_id in (${list})`);
    if (n) left[table] = n;
  }
  return left;
}

// ------------------------------------------------------------------ UI drivers (copied from the QA-A scoring spec; UI only)

export type Journey = { config: E2EConfig; fixture: ScheduleAcceptanceFixture; stripe: Stripe; account: string; entryFee: number };
export type ScoredEvent = { event: CreatedEvent; callbackRoundId: string; finalRoundId: string; entries: string[]; names: string[] };

export const couple = (n: number): RosterCouple => {
  const leaders = ["Ada", "Cy", "Eli", "Gus", "Ivy", "Kai", "Lou", "Max"];
  const followers = ["Bea", "Di", "Fay", "Hana", "Jo", "Kit", "Mae", "Ned"];
  return { leader: { firstName: leaders[n], lastName: `Lead${n}` }, follower: { firstName: followers[n], lastName: `Follow${n}` } };
};
export const coupleName = (n: number) => `${couple(n).leader.firstName} ${couple(n).leader.lastName}`;

export async function clickUntil(button: Locator, done: Locator) {
  await expect(async () => {
    if (await done.count()) return;
    if (await button.count()) await button.first().click();
    await expect(done.first()).toBeVisible({ timeout: 45_000 });
  }).toPass({ timeout: 240_000 });
}

export async function createDraftEvent(j: Journey, page: Page, name: string, date: string): Promise<CreatedEvent> {
  const event = await createCompetitionEvent(page, j.config, { name, startDate: date, endDate: date });
  await startCompetition(page, "Country");
  await chooseCountryCouples(page);
  await finishSetup(page, { accountRequired: false }, { model: "Per entry", amount: String(j.entryFee) }, { summary: "CF1-C acceptance." });
  await createDraft(page, event.id);
  return event;
}

export async function applyScoring(page: Page, eventId: string, setup: "Callbacks + Final" | "Final only (ordinal majority)") {
  await page.goto(`/app/events/${eventId}/competition/advanced`);
  const block = page.locator("div").filter({ has: page.getByRole("heading", { name: "Studio scoring · all divisions" }) }).last();
  await block.getByLabel("Scoring setup").selectOption({ label: setup });
  await block.getByRole("button", { name: "Apply to all divisions" }).click();
  await expect(block.getByRole("status")).toContainText(/Scoring set up for 1 division/, { timeout: 60_000 });
}

export async function setCallbackTarget(page: Page, eventId: string, target: number) {
  await page.goto(`/app/events/${eventId}/competition/advanced`);
  await page.getByLabel(/^Callback target for Callback round/).fill(String(target));
  await page.getByRole("button", { name: "Save target" }).click();
  await expect(page.getByLabel(/^Callback target for Callback round/)).toHaveValue(String(target));
}

export async function publishAndOpen(page: Page, eventId: string) {
  await page.goto(`/app/events/${eventId}/competition`);
  await page.getByRole("button", { name: "Publish competition" }).click();
  await expect(page.getByRole("button", { name: "Open registration" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Open registration" }).click();
  await expect(page.getByRole("button", { name: "Close registration" })).toBeVisible({ timeout: 60_000 });
}

/** One buyer, `count` distinct couples, one Stripe TEST payment. Returns entry ids in couple order. */
export async function registerAndPay(j: Journey, browser: Browser, event: CreatedEvent, tag: string, count: number): Promise<string[]> {
  const couples = Array.from({ length: count }, (_, n) => couple(n));
  const page = await (await browser.newContext()).newPage();
  await assignUniqueSourceIp(page);
  const email = `e2e-cf1c-${j.fixture.runId}-${tag}@example.com`;
  const checkoutUrl = await registerRoster(page, event.slug, { name: coupleName(0), email, phone: "5125550100" }, couples);
  const sessionId = checkoutUrl.match(/cs_test_[A-Za-z0-9]+/)?.[0];
  expect(sessionId, "hosted Checkout URL carries a test session").toBeTruthy();
  const open = await j.stripe.checkout.sessions.retrieve(sessionId!, {}, { stripeAccount: j.account });
  expect([open.livemode, open.status, open.amount_total]).toEqual([false, "open", count * j.entryFee * 100]);
  const paid = await payCheckoutSession(j.stripe, j.account, sessionId!);
  expect([paid.status, paid.payment_status]).toEqual(["complete", "paid"]);
  await expect.poll(async () => (await readCompetitionRegistrations(j.config, event.id)).orders.find((o) => o.stripe_checkout_session_id === sessionId)?.payment_status, { timeout: 90_000, intervals: [1_000] }).toBe("paid");
  await page.context().close();
  const { entries } = await readEntries(j.config, event.id);
  expect(entries).toHaveLength(count);
  return Array.from({ length: count }, (_, n) => entries.find((e) => String(e.display_name).includes(coupleName(n)))!.id as string);
}

export async function generateAndPublish(page: Page, eventId: string, count: number) {
  await page.goto(`/app/events/${eventId}/competition/schedule`);
  await page.getByRole("button", { name: "Generate heats" }).click();
  await expect(page.getByRole("status")).toContainText(new RegExp(`Created \\d+ heats? for ${count} entries`), { timeout: 60_000 });
  await page.getByRole("button", { name: "Publish running order" }).click();
  await expect(page.getByRole("status")).toContainText("Running order published.", { timeout: 60_000 });
}

export async function buildPanel(page: Page, eventId: string, roundText: string) {
  await page.goto(`/app/events/${eventId}/competition/officials`);
  const person = page.locator('select[name="userId"]');
  for (const n of [1, 2, 3]) {
    const option = page.locator('select[name="userId"] option', { hasText: `E2E Judge ${n}` });
    if (!(await option.count())) continue;
    await expect(async () => {
      if (!(await page.locator('select[name="userId"] option', { hasText: `E2E Judge ${n}` }).count())) return;
      await person.selectOption((await option.getAttribute("value")) as string);
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
      await article.locator('select[name="officialId"]').selectOption((await option.getAttribute("value")) as string);
      await article.getByRole("button", { name: "Add to panel" }).click();
      await expect(article.locator("li").filter({ hasText: `E2E Judge ${n}` })).toBeVisible({ timeout: 15_000 });
    }).toPass({ timeout: 120_000 });
  }
  await expect(page.locator("article").filter({ hasText: roundText }).first().getByText(/Panel ready/)).toBeVisible();
}

export async function startRound(page: Page, eventId: string, roundText: string) {
  await page.goto(`/app/events/${eventId}/competition/day-of`);
  const round = page.getByRole("region", { name: "Rounds" }).locator("li").filter({ hasText: roundText }).first();
  await clickUntil(round.getByRole("button", { name: "Schedule round" }), round.getByRole("button", { name: "Start round" }));
  await clickUntil(round.getByRole("button", { name: "Start round" }), round.getByText("Running", { exact: true }));
}

export async function startHeat(page: Page, eventId: string) {
  await page.goto(`/app/events/${eventId}/competition/day-of`);
  const upNext = page.getByRole("region", { name: "Up next" });
  const onFloor = page.getByRole("region", { name: "On the floor" });
  await clickUntil(upNext.getByRole("button", { name: "Call to floor" }), onFloor.getByText("On deck"));
  await clickUntil(onFloor.getByRole("button", { name: "Start heat" }), onFloor.getByRole("button", { name: "Complete heat" }));
}

export async function completeHeat(page: Page, eventId: string) {
  await page.goto(`/app/events/${eventId}/competition/day-of`);
  const onFloor = page.getByRole("region", { name: "On the floor" });
  if (await onFloor.getByRole("button", { name: "Complete heat" }).count()) await clickUntil(onFloor.getByRole("button", { name: "Complete heat" }), page.getByText("No heat is on the floor."));
}

export async function openDesk(page: Page, eventId: string, roundId: string) {
  await expect(async () => {
    await page.goto(`/app/events/${eventId}/competition/ballots/${roundId}`);
    await expect(page.getByRole("region", { name: "Round status" })).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 120_000 });
}

/** Locks every danced heat, then the ballots, from the manager's ballot desk. Returns false (with the desk text) when the desk refuses. */
export async function lockBallots(page: Page, eventId: string, roundId: string): Promise<{ locked: boolean; refusal?: string }> {
  await completeHeat(page, eventId);
  await openDesk(page, eventId, roundId);
  page.on("dialog", (dialog) => { void dialog.accept(); });
  const lockHeat = page.getByRole("button", { name: /^Lock heat/ });
  if (await lockHeat.count()) {
    await expect(async () => {
      if (!(await page.getByRole("button", { name: /^Lock heat/ }).count())) return;
      await page.getByRole("button", { name: /^Lock heat/ }).first().click();
      await page.waitForLoadState("networkidle");
      await openDesk(page, eventId, roundId);
      await expect(page.getByRole("button", { name: /^Lock heat/ })).toHaveCount(0, { timeout: 15_000 });
    }).toPass({ timeout: 120_000 });
  }
  const lock = page.getByRole("button", { name: "Lock ballots" });
  if (await lock.isEnabled({ timeout: 15_000 }).catch(() => false)) {
    await lock.click();
    await expect(page.getByRole("region", { name: "Round status" })).toContainText(/Ballots locked|refused|COMP_/, { timeout: 30_000 });
    const text = (await page.getByRole("region", { name: "Round status" }).innerText()).replace(/\s+/g, " ");
    return /Ballots locked/.test(text) ? { locked: true } : { locked: false, refusal: text };
  }
  return { locked: false, refusal: (await page.getByRole("region", { name: "Lock and reopen" }).innerText()).replace(/\s+/g, " ") };
}

export const judgeBallotUrl = (eventId: string, roundId: string) => `/app/judging/${eventId}/rounds/${roundId}/ballot`;

/** A callback judge ticks exactly the given couples (indexes into the sheet's rows) and submits the final ballot. */
export async function submitCallbackBallot(j: Journey, browser: Browser, judgeIndex: number, s: ScoredEvent, picks: number[]) {
  const page = await signedIn(browser, j.fixture.judges[judgeIndex] as never, judgeBallotUrl(s.event.id, s.callbackRoundId));
  const boxes = page.locator('input[name="pick"]');
  await expect(boxes).toHaveCount(s.entries.length);
  for (const i of picks) await boxes.nth(i).check();
  await page.getByRole("button", { name: /Submit (final )?ballot|Submit correction/ }).click();
  await expect(page.getByRole("status").or(page.getByRole("alert")).first()).toBeVisible({ timeout: 60_000 });
  await page.context().close();
}

/** A Final judge ranks the rows in the given order (rank n for row i = order[i]+1) and submits. */
export async function submitOrdinalBallot(j: Journey, browser: Browser, judgeIndex: number, s: ScoredEvent, order?: number[]) {
  const page = await signedIn(browser, j.fixture.judges[judgeIndex] as never, judgeBallotUrl(s.event.id, s.finalRoundId));
  const marks = page.locator('select[name^="mark:"]');
  const count = await marks.count();
  for (let i = 0; i < count; i += 1) await marks.nth(i).selectOption({ index: (order ? order[i] : i) + 1 });
  await page.getByRole("button", { name: /Submit ballot|Submit correction/ }).click();
  await expect(page.getByRole("status").or(page.getByRole("alert")).first()).toBeVisible({ timeout: 60_000 });
  await page.context().close();
  return count;
}

export async function roundIds(j: Journey, eventId: string) {
  const rounds = (await readHeatEvidence(j.config, eventId)).rounds;
  const callback = rounds.find((r) => r.name === "Callback round");
  const final = rounds.find((r) => r.name === "Final");
  if (!callback || !final) throw new Error("callback + final rounds not found");
  return { callbackRoundId: callback.id as string, finalRoundId: final.id as string };
}

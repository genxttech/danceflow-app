import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { E2EConfig } from "@/lib/e2e/config";
import { createCompetitionEvent, readCompetitionRegistrations, type CreatedEvent } from "./competitionFullEvent";
import { e2eAdminClient } from "./competitionFixture";
import { chooseCountryCouples, createDraft, finishSetup, startCompetition } from "./competitionWizard";
import { readEntries, readHeatEvidence, signedIn, type RosterCouple, type ScheduleAcceptanceFixture } from "./competitionScheduleHeats";
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
  // Real B wording (cf1/integration-2, src/lib/competition/results/advancement.ts and CallbackPanels.tsx), filled in on the first run.
  advanceButton: "Advance to Final",
  advanceDone: /Advanced \d+ couples? to the Final/,
  tieAtCut: /Ready to advance 5 couples to the Final/,
  tieOverCapacity: /Advancement is blocked/,
  correctionReasonLabel: /Open a ballot correction/,
  openCorrectionButton: "Open correction",
  excludeButton: /Exclude/i,
  withdrawButton: /Withdraw/i,
} as const;

/** Human text of the F2/CF1 refusal codes, read from the application's own message table so specs assert what the desk really shows. */
function loadMessages(): Record<string, string> {
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/lib/competition/results/messages.ts"), "utf8");
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/(COMP_[A-Z0-9_]+):\s*\n?\s*"((?:[^"\\]|\\.)*)"/g)) out[m[1]] = m[2];
  return out;
}
const MSG = loadMessages();
const msg = (code: string) => {
  if (!MSG[code]) throw new Error("no application message for " + code);
  return MSG[code];
};

/** Refusal texts the desk must show (the code itself is not displayed; the mapped sentence is). */
export const CF1_CODES = {
  blocked: msg("COMP_ADVANCEMENT_BLOCKED"),
  finalStarted: msg("COMP_ADVANCEMENT_FINAL_STARTED"),
  finalLocked: msg("COMP_ADVANCEMENT_FINAL_LOCKED"),
  finalCancelled: msg("COMP_ADVANCEMENT_FINAL_CANCELLED"),
  ballotsExist: msg("COMP_CORRECTION_LATER_ROUND_BALLOTS"),
  rosterEntryUnavailable: msg("COMP_ROSTER_ENTRY_UNAVAILABLE"),
  belowMinimum: msg("COMP_ROSTER_BELOW_MINIMUM"),
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
  let versions: string[] = [];
  try { versions = psqlJson<string[]>(`select coalesce(json_agg(version order by version), '[]'::json) from supabase_migrations.schema_migrations where version like '202701%'`) ?? []; } catch { /* a bare chain load has no migration table */ }
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
  return psqlJson<Row[]>(agg(`select v.version, v.status, r.entry_id, r.placement, r.advanced, r.output from public.event_competition_result_rows r join public.event_competition_result_versions v on v.id = r.result_version_id where v.round_id = '${id}' order by v.version, r.placement nulls last`));
}

export function readResultEvidence(roundId: string) {
  const id = uuid(roundId);
  return psqlJson<Row[]>(agg(`select version, status, input as evidence, input_hash, trace from public.event_competition_result_versions where round_id = '${id}' order by version`));
}

export function readAuditKinds(eventId: string) {
  const id = uuid(eventId);
  return psqlJson<string[]>(`select coalesce(json_agg(kind order by occurred_at), '[]'::json) from public.event_competition_result_events where event_id = '${id}'`);
}

export function readExclusions(roundId: string) {
  const id = uuid(roundId);
  return psqlJson<Row[]>(agg(`select seq, kind, entry_id, reason_kind, actor, actor_role, request_id from public.event_competition_round_exclusions where round_id = '${id}' order by seq`));
}

export function readBallotRows(roundId: string) {
  const id = uuid(roundId);
  return psqlJson<Row[]>(agg(`select official_id, version, source, supersedes_id is not null as supersedes, correction_reason from public.event_competition_ballots where round_id = '${id}' order by official_id, version`));
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

/** Fidelity: payments are FIXTURE-SEEDED (the project's own start/prepare/attach/finalize RPCs with fake provider ids; no Stripe call). */
export type Journey = { config: E2EConfig; fixture: ScheduleAcceptanceFixture; account: string; entryFee: number };
export const FIDELITY = "fixture-seeded payment";
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

/**
 * One buyer, `count` distinct couples, FIXTURE-SEEDED payment. The public registration form is driven through the UI up to
 * "Continue to checkout"; that single POST is intercepted (the browser never reaches the server's Stripe code), and the same
 * start -> prepare -> attach -> finalize RPCs the real flow and webhook use are then called with the captured draft and fake
 * provider ids. Covers the roster/entry/order DB end state; does NOT cover Stripe Checkout or the webhook route.
 */
export async function registerAndPay(j: Journey, browser: Browser, event: CreatedEvent, tag: string, count: number): Promise<string[]> {
  const couples = Array.from({ length: count }, (_, n) => couple(n));
  const page = await (await browser.newContext()).newPage();
  await assignUniqueSourceIp(page);
  let captured: { clientRequestId: string; draft: unknown } | null = null;
  await page.route(`**/api/events/${event.slug}/competition/checkout`, async (route) => {
    captured = JSON.parse(route.request().postData() ?? "null");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: `/events/${event.slug}` }) });
  });
  await fillRoster(page, event.slug, { name: coupleName(0), email: `e2e-cf1c-${j.fixture.runId}-${tag}@example.com`, phone: "5125550100" }, couples);
  await expect.poll(() => captured, { timeout: 30_000 }).not.toBeNull();
  await page.context().close();
  const admin = e2eAdminClient(j.config);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(name, args);
    if (error) throw new Error(`${name}: ${error.message}`);
    return (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
  };
  const request = captured as unknown as { clientRequestId: string; draft: unknown };
  const started = await rpc("start_competition_registration", { p_event_id: event.id, p_client_request_id: request.clientRequestId, p_draft: request.draft, p_actor_user_id: null });
  const orderId = started.order_id as string;
  const prepared = await rpc("prepare_competition_registration_payment", { p_order_id: orderId });
  expect(prepared.state, "order is payable").toBe("payable");
  const sessionId = `cs_test_cf1c${j.fixture.runId.replace(/[^A-Za-z0-9]/g, "")}${tag}${Date.now()}`;
  await rpc("attach_competition_registration_checkout", { p_order_id: orderId, p_stripe_account_id: j.account, p_checkout_session_id: sessionId, p_checkout_expires_at: new Date(Date.now() + 35 * 60_000).toISOString() });
  const fin = await rpc("finalize_competition_registration", { p_order_id: orderId, p_stripe_account_id: j.account, p_checkout_session_id: sessionId, p_payment_intent_id: sessionId.replace("cs_test_", "pi_"), p_amount_cents: prepared.amount_cents, p_currency: prepared.currency });
  expect(JSON.stringify(fin)).toMatch(/finalized/);
  expect((await readCompetitionRegistrations(j.config, event.id)).orders.find((o) => o.id === orderId)?.payment_status).toBe("paid");
  const { entries } = await readEntries(j.config, event.id);
  expect(entries).toHaveLength(count);
  expect(entries.every((e) => e.status === "confirmed")).toBe(true);
  return Array.from({ length: count }, (_, n) => entries.find((e) => String(e.display_name).includes(coupleName(n)))!.id as string);
}

/** Copy of QA-A's registerRoster that stops after clicking "Continue to checkout" (no wait for the Stripe redirect). */
async function fillRoster(page: Page, slug: string, contact: { name: string; email: string; phone: string }, couples: RosterCouple[]) {
  await page.goto(`/events/${slug}/competition/register`);
  await expect(page.getByRole("heading", { name: "Competition Registration" })).toBeVisible();
  await page.getByPlaceholder("Contact name").fill(contact.name);
  await page.getByPlaceholder("Contact email").fill(contact.email);
  await page.getByPlaceholder("Contact phone").fill(contact.phone);
  const people = new Map<string, { firstName: string; lastName: string }>();
  for (const c of couples) for (const p of [c.leader, c.follower]) people.set(`${p.firstName} ${p.lastName}`, p);
  for (const p of people.values()) {
    await page.getByPlaceholder("First name").fill(p.firstName);
    await page.getByPlaceholder("Last name").fill(p.lastName);
    await page.getByRole("button", { name: "Add to roster" }).click();
    await expect(page.getByText(`${p.firstName} ${p.lastName}`).first()).toBeVisible();
  }
  const entries = page.locator("section").filter({ has: page.getByRole("heading", { name: "Entries", exact: true }) });
  for (const c of couples) {
    await page.getByRole("combobox", { name: "Leader", exact: true }).selectOption({ label: `${c.leader.firstName} ${c.leader.lastName}` });
    await page.getByRole("combobox", { name: "Follower", exact: true }).selectOption({ label: `${c.follower.firstName} ${c.follower.lastName}` });
    const dances = page.locator("label").filter({ hasText: "Two Step" }).getByRole("checkbox");
    if ((await dances.count()) && !(await dances.first().isChecked())) await dances.first().check();
    await page.getByRole("button", { name: "Add entry", exact: true }).click();
    await expect(entries.getByText(`${c.leader.firstName} ${c.leader.lastName} · ${c.follower.firstName} ${c.follower.lastName}`)).toBeVisible();
  }
  await page.getByRole("button", { name: "Continue to checkout" }).click();
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
      await expect(page.locator('select[name="userId"] option', { hasText: `E2E Judge ${n}` })).toHaveCount(0, { timeout: 120_000 });
    }).toPass({ timeout: 300_000 });
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
      await expect(article.locator("li").filter({ hasText: `E2E Judge ${n}` })).toBeVisible({ timeout: 90_000 });
    }).toPass({ timeout: 300_000 });
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
  }).toPass({ timeout: 300_000 });
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
    }).toPass({ timeout: 300_000 });
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

const testInfoRef = () => test.info();
export const judgeBallotUrl = (eventId: string, roundId: string) => `/app/judging/${eventId}/rounds/${roundId}/ballot`;

/** A callback judge ticks exactly the given couples (indexes into the sheet's rows) and submits the final ballot. */
export async function submitCallbackBallot(j: Journey, browser: Browser, judgeIndex: number, s: ScoredEvent, picks: number[]) {
  const page = await signedIn(browser, j.fixture.judges[judgeIndex] as never, judgeBallotUrl(s.event.id, s.callbackRoundId));
  const boxes = page.locator('input[name="pick"]');
  await expect(boxes).toHaveCount(s.entries.length);
  // Evidence (CX1/B coordinator request): the sheet's state BEFORE ticking, and the judge's ballot rows before and after.
  const preChecked = await boxes.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).checked));
  const ballotsBefore = readBallotRows(s.callbackRoundId);
  await testInfoRef().attach(`judge${judgeIndex + 1}-sheet-before-ticking`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  // A correction sheet may come pre-filled with the judge's earlier picks: set every box explicitly.
  for (let i = 0; i < s.entries.length; i += 1) await boxes.nth(i).setChecked(picks.includes(i));
  // A correction (the sheet already holds a submitted ballot) asks for a reason (CX1 / ballot page: "Why are you correcting this ballot?").
  const why = page.getByLabel("Why are you correcting this ballot?");
  if (await why.count()) await why.fill("CF1-C: corrected callback picks after review");
  await page.getByRole("button", { name: /Submit (final )?ballot|Submit correction/ }).click();
  // The ballot action always redirects back with ?saved= or ?error=. The page also shows a standing correction-window status banner, so wait on the redirect, not on any status element (run 12: an early reload cancelled the in-flight correction).
  await page.waitForURL(/[?&](saved|error)=/, { timeout: 60_000 });
  await page.reload();
  const postChecked = await page.locator('input[name="pick"]').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).checked));
  testInfoRef().annotations.push({ type: "evidence", description: JSON.stringify({ judge: judgeIndex + 1, requestedPicks: picks, sheetCheckedBeforeTicking: preChecked, sheetCheckedAfterSubmit: postChecked, ballotRowsBefore: ballotsBefore, ballotRowsAfter: readBallotRows(s.callbackRoundId) }) });
  expect(await page.locator('main [role="alert"]').count(), `judge ${judgeIndex + 1} ballot refused: ${await page.locator('main [role="alert"]').allInnerTexts()}`).toBe(0);
  await page.context().close();
}

/** A Final judge ranks the rows in the given order (rank n for row i = order[i]+1) and submits. */
export async function submitOrdinalBallot(j: Journey, browser: Browser, judgeIndex: number, s: ScoredEvent, order?: number[]) {
  const page = await signedIn(browser, j.fixture.judges[judgeIndex] as never, judgeBallotUrl(s.event.id, s.finalRoundId));
  const marks = page.locator('select[name^="mark:"]');
  const count = await marks.count();
  for (let i = 0; i < count; i += 1) await marks.nth(i).selectOption({ index: (order ? order[i] : i) + 1 });
  await page.getByRole("button", { name: /Submit ballot|Submit correction/ }).click();
  await page.waitForURL(/[?&](saved|error)=/, { timeout: 60_000 });
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

/**
 * A7 / OD-13: a judge-entry correction needs a co-sign by the chair or another manager before a replacement ballot is accepted
 * (COMP_CORRECTION_COSIGN_REQUIRED). The integrated app has NO screen for this: `cosign_competition_correction` is not called by any
 * app code. The acceptance co-signs through the same authenticated RPC a future screen would call (as a different manager than the
 * opener, using that user's own session, never the service role). Evidence for the scenario must say the co-sign was RPC-driven.
 */
export async function cosignCorrectionViaRpc(config: E2EConfig, account: { email: string; password: string }, roundId: string) {
  const { createClient } = await import("@supabase/supabase-js");
  const anon = process.env.E2E_SUPABASE_ANON_KEY;
  if (!anon) throw new Error("E2E_SUPABASE_ANON_KEY is required to co-sign through the authenticated RPC.");
  const causeId = psqlJson<string | null>(`select to_json(id) from public.event_competition_correction_causes where round_id = '${roundId}' order by seq desc limit 1`);
  expect(causeId, "an open correction has a recorded cause").not.toBeNull();
  const client = createClient(config.supabaseUrl, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  expect(signInError, "co-signer signs in").toBeNull();
  const { error } = await client.rpc("cosign_competition_correction", { p_cause_id: causeId, p_request_id: crypto.randomUUID() });
  expect(error?.message ?? null, "co-sign RPC accepted").toBeNull();
  testInfoRef().annotations.push({ type: "evidence", description: JSON.stringify({ cosign: "rpc-only (no app UI exists)", causeId, by: account.email.replace(/^[^@]*/, "***") }) });
}

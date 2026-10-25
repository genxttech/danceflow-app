import { randomBytes } from "node:crypto";
import { expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import type { E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient, type CompetitionAccount } from "./competitionFixture";
import {
  cleanupCompetitionFullEventFixture,
  createCompetitionFullEventFixture,
  type CompetitionFullEventFixture,
} from "./competitionFullEventFixture";
import { signIn } from "./competitionWizard";
import { useUniqueE2ESourceIp as assignUniqueSourceIp } from "./rateLimitBypass";

/**
 * QA-A Schedule & Heats acceptance helpers. Extends the Q1 base seed (competitionFullEventFixture) compatibly: the
 * Q1 fixture is created and cleaned by its own functions, and this module only ADDS two studio staff accounts
 * (front_desk, instructor) and the instructor role for the three judges, which the Q1 seed left role-less.
 * Everything else a scenario depends on is created through the DanceFlow UI. The service-role client only READS.
 */

export type ScheduleAcceptanceFixture = CompetitionFullEventFixture & {
  /** CB-2: an active front_desk member of the studio (check-in desk only). */
  frontDesk: CompetitionAccount;
  /** A studio instructor who is NOT an official and not a manager. */
  instructor: CompetitionAccount;
};

export async function createScheduleAcceptanceFixture(config: E2EConfig, options: { connectedAccountId: string }): Promise<ScheduleAcceptanceFixture> {
  const base = await createCompetitionFullEventFixture(config, options);
  const admin = e2eAdminClient(config);
  const password = () => randomBytes(18).toString("base64url");
  const fixture: ScheduleAcceptanceFixture = {
    ...base,
    frontDesk: { id: "", email: `e2e-compfull-${base.runId}-frontdesk@e2e.test`, password: password() },
    instructor: { id: "", email: `e2e-compfull-${base.runId}-instructor@e2e.test`, password: password() },
  };
  try {
    for (const [account, name, role] of [[fixture.frontDesk, "E2E Front Desk", "front_desk"], [fixture.instructor, "E2E Instructor", "instructor"]] as const) {
      const { data, error } = await admin.auth.admin.createUser({ email: account.email, password: account.password, email_confirm: true });
      if (error || !data.user) throw new Error(`schedule acceptance fixture: account ${account.email}: ${error?.message}`);
      account.id = data.user.id;
      const profile = await admin.from("profiles").upsert({ id: account.id, email: account.email, full_name: name });
      if (profile.error) throw new Error(`schedule acceptance fixture: profile ${name}: ${profile.error.message}`);
      const roleRow = await admin.from("user_studio_roles").insert({ user_id: account.id, studio_id: fixture.studioId, role, active: true });
      if (roleRow.error) throw new Error(`schedule acceptance fixture: role ${role}: ${roleRow.error.message}`);
    }
    // Judges are studio team members (instructor role) so E1 can list them as official candidates; they are still
    // unverified until the scenario proves each mailbox through the UI.
    for (const judge of fixture.judges) {
      const roleRow = await admin.from("user_studio_roles").insert({ user_id: judge.id, studio_id: fixture.studioId, role: "instructor", active: true });
      if (roleRow.error) throw new Error(`schedule acceptance fixture: judge role: ${roleRow.error.message}`);
    }
    return fixture;
  } catch (error) {
    await cleanupScheduleAcceptanceFixture(config, fixture).catch((cleanupError) => {
      console.error(`schedule acceptance fixture: cleanup after failed creation was incomplete: ${(cleanupError as Error).message}`);
    });
    throw error;
  }
}

/** Removes the two extra accounts, then the Q1 seed (which removes the studio, roles, events and the other accounts). */
export async function cleanupScheduleAcceptanceFixture(config: E2EConfig, fixture: ScheduleAcceptanceFixture | undefined) {
  if (!fixture) return;
  const admin = e2eAdminClient(config);
  const failures: string[] = [];
  try {
    await cleanupCompetitionFullEventFixture(config, fixture);
  } catch (error) {
    failures.push((error as Error).message);
  }
  for (const account of [fixture.frontDesk, fixture.instructor]) {
    if (!account.id) continue;
    const profile = await admin.from("profiles").delete().eq("id", account.id);
    if (profile.error) failures.push(`profile ${account.email}: ${profile.error.message}`);
    const user = await admin.auth.admin.deleteUser(account.id);
    if (user.error) failures.push(`auth user ${account.email}: ${user.error.message}`);
  }
  const ids = [fixture.frontDesk.id, fixture.instructor.id].filter(Boolean);
  if (ids.length) {
    const { count, error } = await admin.from("profiles").select("id", { count: "exact", head: true }).in("id", ids);
    if (error) failures.push(`leftover check profiles: ${error.message}`);
    else if (count) failures.push(`profiles: ${count} row(s) left`);
  }
  if (failures.length) throw new Error(`Schedule acceptance fixture cleanup incomplete: ${failures.join("; ")}`);
}

// ------------------------------------------------------------------ screenshots on every step

/** One numbered full-page screenshot per call, attached to the test so the HTML report and the JSON carry its path. */
export function stepShots(testInfo: TestInfo) {
  let n = 0;
  return async (page: Page, label: string) => {
    n += 1;
    const name = `${String(n).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
}

/** Records a "label" annotation so the report builder can map each test to its scenario id and status. */
export function scenarioStatus(testInfo: TestInfo, type: "NOT IMPLEMENTED" | "BLOCKED" | "SETUP SHORTCUT", description: string) {
  testInfo.annotations.push({ type, description });
}

// ------------------------------------------------------------------ sessions

export async function signedIn(browser: Browser, account: CompetitionAccount, next?: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, account, next);
  return page;
}

/** A fresh anonymous browser context with its own synthetic source address. */
export async function anonymousPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await assignUniqueSourceIp(page);
  return page;
}

// ------------------------------------------------------------------ registration

export type Person = { firstName: string; lastName: string };
export type RosterCouple = { leader: Person; follower: Person };

/**
 * One public cart with several couples where a person may appear in more than one couple. Each distinct person is
 * added to the roster once, so a repeated dancer is ONE competitor in both entries (the schedule conflict scenario
 * depends on that). Returns the hosted Checkout URL.
 */
export async function registerRoster(page: Page, slug: string, contact: { name: string; email: string; phone: string }, couples: RosterCouple[]) {
  await page.goto(`/events/${slug}/competition/register`);
  await expect(page.getByRole("heading", { name: "Competition Registration" })).toBeVisible();
  await page.getByPlaceholder("Contact name").fill(contact.name);
  await page.getByPlaceholder("Contact email").fill(contact.email);
  await page.getByPlaceholder("Contact phone").fill(contact.phone);
  const people = new Map<string, Person>();
  for (const couple of couples) for (const person of [couple.leader, couple.follower]) people.set(`${person.firstName} ${person.lastName}`, person);
  for (const person of people.values()) {
    await page.getByPlaceholder("First name").fill(person.firstName);
    await page.getByPlaceholder("Last name").fill(person.lastName);
    await page.getByRole("button", { name: "Add to roster" }).click();
    await expect(page.getByText(`${person.firstName} ${person.lastName}`).first()).toBeVisible();
  }
  const entries = page.locator("section").filter({ has: page.getByRole("heading", { name: "Entries", exact: true }) });
  for (const couple of couples) {
    await page.getByRole("combobox", { name: "Leader", exact: true }).selectOption({ label: `${couple.leader.firstName} ${couple.leader.lastName}` });
    await page.getByRole("combobox", { name: "Follower", exact: true }).selectOption({ label: `${couple.follower.firstName} ${couple.follower.lastName}` });
    const dances = page.locator("label").filter({ hasText: "Two Step" }).getByRole("checkbox");
    if ((await dances.count()) && !(await dances.first().isChecked())) await dances.first().check();
    await page.getByRole("button", { name: "Add entry", exact: true }).click();
    await expect(entries.getByText(`${couple.leader.firstName} ${couple.leader.lastName} · ${couple.follower.firstName} ${couple.follower.lastName}`)).toBeVisible();
  }
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 90_000 });
  return page.url();
}

// ------------------------------------------------------------------ read-only database evidence

type Row = Record<string, unknown>;

async function rows(config: E2EConfig, table: string, columns: string, filter: Record<string, string>): Promise<Row[]> {
  let query = e2eAdminClient(config).from(table).select(columns);
  for (const [key, value] of Object.entries(filter)) query = query.eq(key, value);
  const { data, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as unknown as Row[];
}

export type HeatEvidence = {
  versions: Row[];
  floorHeats: Row[];
  scoringHeats: Row[];
  placements: Row[];
  rounds: Row[];
  /** Per scoring heat: its floor heat number and the entries and competitors placed (not scratched). */
  floorLayout: Array<{ roundId: string; floorId: string; versionId: string; floorNumber: number; heatId: string; heatNumber: number; status: string; lockState: string; entryIds: string[]; competitorIds: string[] }>;
  /** floorLayout restricted to the published (or live) version when one exists, else the whole layout. */
  effective: HeatEvidence["floorLayout"];
  /** Competitors that appear twice in ONE floor heat (must always be empty). */
  doubleBookings: Array<{ floorNumber: number; competitorId: string }>;
};

export async function readHeatEvidence(config: E2EConfig, eventId: string): Promise<HeatEvidence> {
  const [versions, floorHeats, scoringHeats, placements, rounds, participants] = await Promise.all([
    rows(config, "event_competition_schedule_versions", "id, version_number, name, status, published_at", { event_id: eventId }),
    rows(config, "event_competition_floor_heats", "id, schedule_version_id, heat_number", { event_id: eventId }),
    rows(config, "event_competition_heats", "id, round_id, floor_heat_id, heat_number, name, status, lock_state", { event_id: eventId }),
    rows(config, "event_competition_heat_entries", "heat_id, entry_id, status", { event_id: eventId }),
    rows(config, "event_competition_rounds", "id, division_id, name, status, scoring_method, target_advancement_count, configuration", { event_id: eventId }),
    rows(config, "event_competition_entry_participants", "entry_id, competitor_id", { event_id: eventId }),
  ]);
  const competitorsByEntry = new Map<string, string[]>();
  for (const participant of participants) {
    const list = competitorsByEntry.get(participant.entry_id as string) ?? [];
    if (participant.competitor_id) list.push(participant.competitor_id as string);
    competitorsByEntry.set(participant.entry_id as string, list);
  }
  const numberByFloor = new Map(floorHeats.map((row) => [row.id as string, Number(row.heat_number)]));
  const floorLayout = scoringHeats.map((heat) => {
    const entryIds = placements.filter((p) => p.heat_id === heat.id && p.status !== "scratched").map((p) => p.entry_id as string);
    return {
      roundId: heat.round_id as string,
      floorId: heat.floor_heat_id as string,
      versionId: floorHeats.find((row) => row.id === heat.floor_heat_id)?.schedule_version_id as string ?? "",
      floorNumber: numberByFloor.get(heat.floor_heat_id as string) ?? 0,
      heatId: heat.id as string,
      heatNumber: Number(heat.heat_number),
      status: heat.status as string,
      lockState: heat.lock_state as string,
      entryIds,
      competitorIds: entryIds.flatMap((id) => competitorsByEntry.get(id) ?? []),
    };
  });
  const doubleBookings: HeatEvidence["doubleBookings"] = [];
  for (const floorId of new Set(floorLayout.map((heat) => heat.floorId))) {
    const seen = new Set<string>();
    const floorNumber = floorLayout.find((heat) => heat.floorId === floorId)!.floorNumber;
    for (const competitorId of floorLayout.filter((heat) => heat.floorId === floorId).flatMap((heat) => heat.competitorIds)) {
      if (seen.has(competitorId)) doubleBookings.push({ floorNumber, competitorId });
      seen.add(competitorId);
    }
  }
  const inEffect = versions.find((v) => ["published", "live"].includes(v.status as string));
  const effective = inEffect ? floorLayout.filter((heat) => heat.versionId === inEffect.id) : floorLayout;
  return { versions, floorHeats, scoringHeats, placements, rounds, floorLayout, effective, doubleBookings };
}

/** The published (or live) version rows of an event. */
export const publishedVersions = (evidence: HeatEvidence) => evidence.versions.filter((v) => ["published", "live"].includes(v.status as string));

export async function readOfficials(config: E2EConfig, eventId: string) {
  const [officials, assignments] = await Promise.all([
    rows(config, "event_competition_officials", "id, user_id, role, status", { event_id: eventId }),
    rows(config, "event_competition_panel_assignments", "id, round_id, official_id, judge_letter", { event_id: eventId }),
  ]);
  return { officials, assignments };
}

export async function readPanelStatus(config: E2EConfig, roundId: string) {
  const { data, error } = await e2eAdminClient(config).rpc("competition_round_panel_status", { p_round_id: roundId });
  if (error) throw new Error(`competition_round_panel_status: ${error.message}`);
  return data as { ready: boolean; judge_count?: number; min_judges?: number; chair_designated?: boolean; missing?: string[] };
}

export async function readEntries(config: E2EConfig, eventId: string) {
  const [entries, participants] = await Promise.all([
    rows(config, "event_competition_entries", "id, display_name, status, eligibility_status, entry_number, division_id, order_id", { event_id: eventId }),
    rows(config, "event_competition_entry_participants", "entry_id, display_name, competitor_id", { event_id: eventId }),
  ]);
  return { entries, participants };
}

export async function readScratchAudit(config: E2EConfig, eventId: string) {
  return rows(config, "event_competition_scratches", "id, entry_id, path, is_exception, reason, previous_status, performed_by", { event_id: eventId });
}

export async function readBallotCount(config: E2EConfig, roundId: string) {
  const { count, error } = await e2eAdminClient(config).from("event_competition_ballots").select("id", { count: "exact", head: true }).eq("round_id", roundId);
  if (error) throw new Error(`event_competition_ballots: ${error.message}`);
  return count ?? 0;
}

// ------------------------------------------------------------------ small UI readers

/** Names of the dancers shown in the open heat detail panel of the Schedule page. */
export async function heatPanelNames(page: Page): Promise<string> {
  return (await page.locator("aside[aria-label$='details']").innerText()).replace(/\s+/g, " ");
}

/** Opens Heat n from the running order list and returns the panel text. */
export async function openHeat(page: Page, eventId: string, number: number): Promise<string> {
  await page.goto(`/app/events/${eventId}/competition/schedule`);
  await page.getByRole("list", { name: "Running order" }).getByRole("link", { name: new RegExp(`^Heat ${number}\\b`) }).click();
  await page.waitForURL(/[?&]heat=/, { timeout: 30_000 });
  await expect(page.getByRole("complementary", { name: `Heat ${number} details` })).toBeVisible({ timeout: 30_000 });
  return heatPanelNames(page);
}

/** Status of a navigation: 200 for a page, 404 for notFound(), or the final URL when the app redirects. */
export async function visit(page: Page, path: string): Promise<{ status: number; url: URL }> {
  const response = await page.goto(path);
  return { status: response?.status() ?? 0, url: new URL(page.url()) };
}

// ------------------------------------------------------------------ setup wizard variant

/**
 * Like competitionWizard.startCompetition, but also picks the judging option ("How are results given?") that the
 * adjudicated answer reveals, e.g. "Callbacks + Final". startCompetition itself is unchanged.
 */
export async function startCompetitionWithJudging(page: Page, style: "Country" | "Ballroom", judging: RegExp) {
  const stepHeading = () => page.locator("section[aria-labelledby]").last().getByRole("heading", { level: 3 }).first();
  const advance = async (heading: string) => {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(stepHeading()).toHaveText(heading);
  };
  await page.getByRole("button", { name: /^Competition Dancers compete/ }).click();
  await advance("Which styles?");
  await page.getByRole("button", { name: new RegExp(`^${style} ${style} partner`) }).click();
  await advance("Will this produce an official competitive result?");
  await page.getByRole("button", { name: /^Adjudicated Official result/ }).click();
  await expect(page.getByText("How are results given?")).toBeVisible();
  await page.getByRole("button", { name: judging }).click();
  await advance("Which rules?");
  await expect(page.getByRole("button", { name: /^Studio \/ Custom Rules/ })).toHaveAttribute("aria-pressed", "true");
  await advance("What will you offer?");
}

// ------------------------------------------------------------------ NS1 (heat no-shows, #342)

/** True when the system under test includes NS1's tables (the spec skips the no-show scenarios otherwise). */
export async function ns1Present(config: E2EConfig): Promise<boolean> {
  const { error } = await e2eAdminClient(config).from("event_competition_heat_no_shows").select("id", { head: true, count: "exact" });
  return !error;
}

export async function readNoShows(config: E2EConfig, eventId: string) {
  const [marks, voids] = await Promise.all([
    rows(config, "event_competition_heat_no_shows", "id, round_id, heat_id, heat_entry_id, entry_id, reason, marked_by, request_id", { event_id: eventId }),
    rows(config, "event_competition_heat_no_show_voids", "id, no_show_id, reason, voided_by", { event_id: eventId }),
  ]);
  return { marks, voids, active: marks.filter((mark) => !voids.some((v) => v.no_show_id === mark.id)) };
}

/** The heat placement row (heat_entries.id) of an entry in a heat of the version in effect. */
export async function heatEntryIdFor(config: E2EConfig, eventId: string, entryId: string, heatId: string): Promise<string> {
  const found = (await rows(config, "event_competition_heat_entries", "id, heat_id, entry_id", { event_id: eventId })).find((row) => row.entry_id === entryId && row.heat_id === heatId);
  if (!found) throw new Error(`no heat placement for entry ${entryId} in heat ${heatId}`);
  return found.id as string;
}

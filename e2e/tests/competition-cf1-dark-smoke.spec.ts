import { test, expect, type Page } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "../helpers/competitionFixture";
import { verifyEmailAndBindPassword } from "../helpers/competitionFullEvent";
import { useUniqueE2ESourceIp as assignUniqueSourceIp } from "../helpers/rateLimitBypass";
import { cleanupScheduleAcceptanceFixture, createScheduleAcceptanceFixture, openHeat, signedIn, stepShots, type ScheduleAcceptanceFixture } from "../helpers/competitionScheduleHeats";
import { createDraftEvent, leftoverAnyCompetitionRows, psqlJson, publishAndOpen, registerAndPay, type Journey } from "../helpers/cf1Acceptance";

/**
 * CF1 dark smoke (SCN-DARK). Run ONLY against an app started WITHOUT COMPETITION_FINALS_ENABLED (and without
 * COMPETITION_PUBLIC_RESULTS_ENABLED). Proves that a studio sees nothing of Competition Finals:
 *   DARK-1 workspace navigation is the live release navigation (no Day-of, Officials/Scoring are "Later", no Ballots link)
 *   DARK-2 every CF1 page answers 404 for the studio owner, with real event and round ids (officials, ballots, ballots/[round],
 *          day-of, results, results/[round], /app/judging, judge ballot, judge desk)
 *   DARK-3 the public results page answers 404 for an anonymous visitor
 *   DARK-4 the live pages CF1 modified show no CF1 control: Advanced settings (studio scoring, callback target)
 *   DARK-6 heat-size hotfix: the reason field is shown, the change is saved and one audit row with a request id is written
 *   DARK-5 the live pages still work: Overview, Divisions, Schedule, Advanced, Readiness render for the owner (HTTP 200)
 * UI-driven, read-only evidence, zero leftover rows (same rules as the CF1-C specs).
 */

test.describe.configure({ mode: "serial", timeout: 900_000 });

const ACCOUNT = "acct_cf1darkfixture"; // fake id: no payment is made

test.describe("CF1 dark smoke: Competition Finals is invisible with the flag off", () => {
  test.skip(process.env.E2E_COMPETITION_REGISTRATION_ENABLED !== "true", "Needs the app started with NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true (the setup wizard).");

  let config: E2EConfig;
  let fixture: ScheduleAcceptanceFixture;
  let j: Journey;
  const created: string[] = [];
  let eventId = "";
  let slug = "";
  let roundId = "";

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl) || !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.baseUrl)) throw new Error("refusing: not the local QA stack");
    fixture = await createScheduleAcceptanceFixture(config, { connectedAccountId: ACCOUNT });
    j = { config, fixture, account: ACCOUNT, entryFee: 40 };
  });

  test.afterAll(async () => {
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    await cleanupScheduleAcceptanceFixture(config, fixture);
    expect(leftoverAnyCompetitionRows(created), "event_competition_* rows left after teardown").toEqual({});
    if (created.length) expect((await e2eAdminClient(config).from("events").select("id", { count: "exact", head: true }).in("id", created)).count).toBe(0);
  });

  async function status(page: Page, path: string) {
    const response = await page.goto(path);
    return response?.status() ?? 0;
  }

  test("SCN-DARK setup: a studio competition with rounds, created through the live wizard", async ({ browser }) => {
    // Like the CF1-C specs (SCN-0c): the owner proves their mailbox first; audited RPCs such as the heat size require a verified email.
    const verify = await (await browser.newContext()).newPage();
    await assignUniqueSourceIp(verify);
    await verifyEmailAndBindPassword(verify, fixture.owner);
    await verify.context().close();
    const page = await signedIn(browser, fixture.owner);
    const event = await createDraftEvent(j, page, `E2E CF1 dark ${fixture.runId}`, "2027-03-14");
    created.push(event.id);
    eventId = event.id;
    const rows = psqlJson<Array<{ id: string; slug: string | null }>>(
      `select coalesce(json_agg(json_build_object('id', r.id, 'slug', e.slug)), '[]'::json) from public.event_competition_rounds r join public.events e on e.id = r.event_id where r.event_id = '${eventId}'`,
    );
    expect(rows.length, "the wizard created at least one round").toBeGreaterThan(0);
    roundId = rows[0].id;
    slug = rows[0].slug ?? "";
    test.info().annotations.push({ type: "evidence", description: JSON.stringify({ eventId, roundId, slug, rounds: rows.length }) });
    await page.context().close();
  });

  test("SCN-DARK-1 workspace navigation is the live release navigation", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await page.goto(`/app/events/${eventId}/competition`);
    const nav = page.getByRole("navigation", { name: "Competition workspace" });
    await expect(nav).toBeVisible();
    await expect(nav.getByText("Day-of")).toHaveCount(0);
    await expect(nav.getByText("Ballots")).toHaveCount(0);
    for (const label of ["Officials", "Scoring", "Results", "Awards"]) {
      await expect(nav.locator('[aria-disabled="true"]', { hasText: label }), `${label} is a disabled "Later" item`).toHaveCount(1);
    }
    expect(await nav.locator("a[href*='/officials'], a[href*='/ballots'], a[href*='/day-of'], a[href*='/results'], a[href*='/judging']").count()).toBe(0);
    await shot(page, "workspace-nav");
    await page.context().close();
  });

  test("SCN-DARK-2 every CF1 page answers 404 for the studio owner", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    const paths = [
      `/app/events/${eventId}/competition/officials`,
      `/app/events/${eventId}/competition/ballots`,
      `/app/events/${eventId}/competition/ballots/${roundId}`,
      `/app/events/${eventId}/competition/day-of`,
      `/app/events/${eventId}/competition/results`,
      `/app/events/${eventId}/competition/results/${roundId}`,
      `/app/judging`,
      `/app/judging/${eventId}/rounds/${roundId}/ballot`,
      `/app/judging/${eventId}/rounds/${roundId}/ballot/desk`,
    ];
    const results: Record<string, number> = {};
    for (const path of paths) results[path] = await status(page, path);
    testInfo.annotations.push({ type: "evidence", description: JSON.stringify(results) });
    await shot(page, "last-cf1-page-404");
    for (const path of paths) expect(results[path], path).toBe(404);
    await page.context().close();
  });

  test("SCN-DARK-3 the public results page answers 404 for an anonymous visitor", async ({ browser }, testInfo) => {
    expect(slug, "the event has a public slug").not.toBe("");
    const page = await (await browser.newContext()).newPage();
    const code = await status(page, `/events/${slug}/competition/results`);
    testInfo.annotations.push({ type: "evidence", description: JSON.stringify({ path: `/events/${slug}/competition/results`, status: code }) });
    expect(code).toBe(404);
    await page.context().close();
  });

  test("SCN-DARK-4 Advanced settings shows no studio scoring or callback-target control", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    expect(await status(page, `/app/events/${eventId}/competition/advanced`)).toBe(200);
    await expect(page.getByRole("heading", { name: "Studio scoring · all divisions" })).toHaveCount(0);
    await expect(page.locator('[data-testid="studio-scoring"]')).toHaveCount(0);
    await expect(page.getByText(/Callback target for /)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Apply to (all divisions|this division)/ })).toHaveCount(0);
    await shot(page, "advanced-no-cf1");
    await page.context().close();
  });

  test("SCN-DARK-6 heat-size hotfix (ac902c28): with the flag off, 'Max entries per heat' takes a reason and is saved and audited", async ({ browser }, testInfo) => {
    const shot = stepShots(testInfo);
    const page = await signedIn(browser, fixture.owner);
    await publishAndOpen(page, eventId);
    const event = { id: eventId, slug } as Parameters<typeof registerAndPay>[2];
    await registerAndPay(j, browser, event, "dark", 2);
    await page.goto(`/app/events/${eventId}/competition/schedule`);
    await page.getByRole("button", { name: "Generate heats" }).click();
    await expect(page.getByRole("status")).toContainText(/Created \d+ heats? for 2 entries/, { timeout: 60_000 });
    await openHeat(page, eventId, 1);
    await expect(page.getByText(/^Final heat size/)).toHaveCount(0); // the CF1 Final heat-size section stays dark
    const reason = "Smaller heats keep the floor readable for judges";
    await page.getByLabel("Max entries per heat for this division").first().fill("2");
    await page.getByLabel("Reason (required, kept in the audit history)").first().fill(reason);
    await page.locator("aside").getByRole("button", { name: "Save", exact: true }).first().click();
    await expect(page.getByRole("status")).toContainText("Heat size saved", { timeout: 30_000 });
    await shot(page, "heat-size-saved");
    const audit = psqlJson<Array<{ new_capacity: number; reason: string; request_id: string | null }>>(
      `select coalesce(json_agg(json_build_object('new_capacity', c.new_capacity, 'reason', c.reason, 'request_id', c.request_id)), '[]'::json) from public.event_competition_round_capacity_events c where c.event_id = '${eventId}'`,
    );
    testInfo.annotations.push({ type: "evidence", description: JSON.stringify({ capacityEvents: audit }) });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ new_capacity: 2, reason });
    expect(audit[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
    await page.context().close();
  });

  test("SCN-DARK-5 the live competition pages still render for the owner", async ({ browser }, testInfo) => {
    const page = await signedIn(browser, fixture.owner);
    const paths = ["", "/divisions", "/schedule", "/advanced", "/registrations", "/checkin", "/readiness"].map((p) => `/app/events/${eventId}/competition${p}`);
    const results: Record<string, number> = {};
    for (const path of paths) results[path] = await status(page, path);
    testInfo.annotations.push({ type: "evidence", description: JSON.stringify(results) });
    for (const path of paths) expect(results[path], path).toBe(200);
    await expect(page.getByText(/Callback targets|Studio scoring methods/)).toHaveCount(0);
    await page.context().close();
  });
});

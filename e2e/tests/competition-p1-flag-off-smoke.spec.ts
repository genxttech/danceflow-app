import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { createCompetitionEvent, verifyEmailAndBindPassword, type CreatedEvent } from "../helpers/competitionFullEvent";
import { anonymousPage, cleanupScheduleAcceptanceFixture, createScheduleAcceptanceFixture, signedIn, visit, type ScheduleAcceptanceFixture } from "../helpers/competitionScheduleHeats";
import { psqlJson } from "../helpers/cf1Acceptance";

/**
 * P1 flag-off smoke. Run ONLY against a production build made with NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED,
 * COMPETITION_FINALS_ENABLED and COMPETITION_PUBLIC_RESULTS_ENABLED all unset (the NEXT_PUBLIC value is inlined at build).
 * Not covered: the in-app Scratch page and its Registrations link are not behind a flag (manager-only workspace).
 * NOT YET EXECUTED.
 */

const ENABLED = process.env.E2E_P1_FLAG_OFF === "true";

test.describe.configure({ mode: "serial", timeout: 900_000 });

test.describe("P1 flag-off smoke", () => {
  test.skip(!ENABLED, "Set E2E_P1_FLAG_OFF=true only against the build made without the three Competition flags.");

  let config: E2EConfig;
  let fixture: ScheduleAcceptanceFixture;
  let event: CreatedEvent;

  test.beforeAll(async () => {
    config = loadE2EConfig();
    fixture = await createScheduleAcceptanceFixture(config, { connectedAccountId: "acct_p1flagoff" });
  });
  test.afterAll(async () => {
    await cleanupScheduleAcceptanceFixture(config, fixture).catch((error) => console.warn(`cleanup incomplete (reset the stack): ${(error as Error).message}`));
  });

  const writes = () =>
    psqlJson<Record<string, number>>(`select json_build_object(
      'carts', (select count(*)::int from public.event_competition_registration_carts where event_id = '${event.id}'),
      'orders', (select count(*)::int from public.event_orders where event_id = '${event.id}'),
      'entries', (select count(*)::int from public.event_competition_entries where event_id = '${event.id}'))`);

  test("P1-F1 the owner can still create and view an ordinary published event", async ({ browser }) => {
    const verify = await anonymousPage(browser);
    await verifyEmailAndBindPassword(verify, fixture.owner);
    await verify.context().close();
    const page = await signedIn(browser, fixture.owner);
    event = await createCompetitionEvent(page, config, { name: `E2E P1 Flag Off ${fixture.runId}`, startDate: "2027-06-20", endDate: "2027-06-20" });
    for (const path of ["/app", "/app/events", `/app/events/${event.id}`]) expect((await visit(page, path)).status, path).toBe(200);
    await page.context().close();
    const anon = await anonymousPage(browser);
    expect((await visit(anon, `/events/${event.slug}`)).status).toBe(200);
    await anon.context().close();
  });

  test("P1-F2 public competition pages and APIs refuse, and nothing is created", async ({ browser }) => {
    const anon = await anonymousPage(browser);
    for (const path of [`/events/${event.slug}/competition/register`, `/events/${event.slug}/competition/register/status`, `/events/${event.slug}/competition/results`]) {
      expect((await visit(anon, path)).status, path).toBe(404);
    }
    for (const action of ["checkout", "resume", "release"]) {
      const response = await anon.request.post(`/api/events/${event.slug}/competition/${action}`, { data: { clientRequestId: randomUUID(), draft: {}, token: randomUUID() } });
      expect(response.status(), action).toBe(404);
    }
    expect(writes()).toEqual({ carts: 0, orders: 0, entries: 0 });
    await anon.context().close();
  });

  test("P1-F3 finals pages are absent for the owner", async ({ browser }) => {
    const page = await signedIn(browser, fixture.owner);
    const base = `/app/events/${event.id}/competition`;
    for (const path of [`${base}/officials`, `${base}/ballots`, `${base}/day-of`, `${base}/results`, `${base}/results/${randomUUID()}`, "/app/judging"]) {
      expect((await visit(page, path)).status, path).toBe(404);
    }
    await page.context().close();
  });
});

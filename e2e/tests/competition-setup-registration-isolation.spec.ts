import { test, expect, type Browser, type Page } from "@playwright/test";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import {
  cleanupCompetitionFixture,
  createCompetitionFixture,
  e2eAdminClient,
  readEventRegistration,
  readPrograms,
  type CompetitionAccount,
  type CompetitionFixture,
} from "../helpers/competitionFixture";
import {
  chooseCountryCouples,
  chooseNdcaProAmMultiDance,
  continueButton,
  createDraft,
  finishSetup,
  openWizard,
  publishFromWorkspace,
  signIn,
  startCompetition,
  wizardStep,
} from "../helpers/competitionWizard";

/**
 * Phase 10C.5 -- Competition setup wizard and registration isolation, driven through the real browser UI.
 *
 * Competition draft creation, publishing and competition registration never change the event's ordinary ticket
 * registration (registration_required, account requirement, window, ticket types). Browser-visible results are
 * checked, and the database is checked independently with the service-role client.
 *
 * The server's competition registration feature flag cannot be read from the browser, so the run declares it:
 * E2E_COMPETITION_REGISTRATION_ENABLED=true when the app under test was started with
 * NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true, otherwise the flag-off expectations apply. Registration is
 * only ever opened in the flag-on run, on a run-scoped fixture event, and is closed again before cleanup.
 */

const FLAG_ON = process.env.E2E_COMPETITION_REGISTRATION_ENABLED === "true";

// Each test drives the full wizard through a dev server; allow for first-compile latency.
test.describe.configure({ mode: "serial", timeout: 240_000 });

test.describe("Competition setup: registration isolation (Phase 10C.5)", () => {
  let config: E2EConfig;
  let fixture: CompetitionFixture;
  let legacyV2Before: unknown;

  test.beforeAll(async () => {
    config = loadE2EConfig();
    fixture = await createCompetitionFixture(config);
    legacyV2Before = await readPrograms(config, fixture.events.legacyV2.id);
  });

  test.afterAll(async () => {
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    await cleanupCompetitionFixture(config, fixture);
  });

  async function as(browser: Browser, account: CompetitionAccount, next?: string): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, account, next);
    return page;
  }

  test("draft creation keeps ordinary ticket registration ON, and stores the competition's own window and account setting", async ({ browser }) => {
    const event = fixture.events.ticketsOn;
    const before = await readEventRegistration(config, event.id);
    expect(before.event.registration_required).toBe(true);

    const page = await as(browser, fixture.owner);
    await openWizard(page, event.id);
    await startCompetition(page, "Country");
    await chooseCountryCouples(page);
    // The competition step starts blank (it never reads the event's ticket window) with an account required.
    const step = wizardStep(page);
    await expect(step.getByLabel("Competition registration opens (optional)")).toHaveValue("");
    await expect(step.getByLabel("Competition registration closes (optional)")).toHaveValue("");
    await expect(step.getByRole("checkbox", { name: "Competitors need a DanceFlow account to enter the competition" })).toBeChecked();
    await expect(step).toContainText("Ticket sales and the event's own registration settings are not changed");
    await finishSetup(page, { opens: "2027-01-10", closes: "2027-02-20", accountRequired: true }, { model: "Per dance", amount: "25" });
    await expect(wizardStep(page)).toContainText("opens 2027-01-10, closes 2027-02-20 · account required · ticket sales unchanged");
    await expect(wizardStep(page)).toContainText("Draft · registration closed");
    // Regression (found in browser QA): the click that reaches Review must not submit the form. Nothing is created
    // until "Create Competition Draft" is pressed.
    await page.waitForTimeout(5_000);
    expect(new URL(page.url()).pathname).toBe(`/app/events/${event.id}/competition/new`);
    expect(await readPrograms(config, event.id)).toHaveLength(0);
    await expect(page.getByRole("button", { name: "Create Competition Draft" })).toBeEnabled();
    await createDraft(page, event.id);
    await expect(page.getByRole("button", { name: "Publish competition" })).toBeVisible();

    const after = await readEventRegistration(config, event.id);
    expect(after).toEqual(before);
    const [program] = await readPrograms(config, event.id);
    expect(program).toMatchObject({ rules_profile_key: "studio_simple", rules_profile_version: 3, status: "draft", registration_status: "closed" });
    expect(program.configuration.setup.registration.account_required).toBe(true);
    // Whole days in the event time zone (America/Chicago): opens 00:00 on Jan 10, closes 23:59 on Feb 20.
    expect(new Date(program.configuration.setup.registration.opens_at).toISOString()).toBe("2027-01-10T06:00:00.000Z");
    expect(new Date(program.configuration.setup.registration.closes_at).toISOString()).toBe("2027-02-21T05:59:00.000Z");
    await page.context().close();
  });

  test("draft creation keeps ordinary ticket registration OFF; the competition account setting is independent", async ({ browser }) => {
    const event = fixture.events.ticketsOff;
    const before = await readEventRegistration(config, event.id);
    expect(before.event).toMatchObject({ registration_required: false, account_required_for_registration: true });

    const page = await as(browser, fixture.owner);
    await openWizard(page, event.id);
    await startCompetition(page, "Country");
    await chooseCountryCouples(page);
    await finishSetup(page, { accountRequired: false }, { model: "Per entry", amount: "40" });
    await expect(wizardStep(page)).toContainText("No window set · ticket sales unchanged");
    await createDraft(page, event.id);

    expect(await readEventRegistration(config, event.id)).toEqual(before);
    const [program] = await readPrograms(config, event.id);
    expect(program).toMatchObject({ rules_profile_version: 3, status: "draft", registration_status: "closed" });
    expect(program.configuration.setup.registration).toEqual({ opens_at: null, closes_at: null, account_required: false });
    await page.context().close();
  });

  test("publishing does not open competition registration or change ordinary registration", async ({ browser }) => {
    const page = await as(browser, fixture.owner);
    for (const event of [fixture.events.ticketsOn, fixture.events.ticketsOff]) {
      const before = await readEventRegistration(config, event.id);
      await publishFromWorkspace(page, event.id);
      await expect(page.getByText("Open registration", { exact: true }).first()).toBeVisible();
      expect(await readEventRegistration(config, event.id)).toEqual(before);
      const [program] = await readPrograms(config, event.id);
      expect(program).toMatchObject({ status: "configured", registration_status: "closed" });
      expect(program.profile_locked_at).not.toBeNull();
    }
    await page.context().close();
  });

  test("public event page: tickets follow the ordinary setting; no competition entry while the flag is off or registration is closed", async ({ page }) => {
    await page.goto(`/events/${fixture.events.ticketsOn.slug}`);
    await expect(page.getByText("Open Registration Form")).toBeVisible();
    await expect(page.getByText("Basic Event Listing")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Open (Competition|Showcase) Registration/ })).toHaveCount(0);

    await page.goto(`/events/${fixture.events.ticketsOff.slug}`);
    await expect(page.getByText("Basic Event Listing")).toBeVisible();
    await expect(page.getByText("Open Registration Form")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Open (Competition|Showcase) Registration/ })).toHaveCount(0);

    const response = await page.goto(`/events/${fixture.events.ticketsOff.slug}/competition/register`);
    if (!FLAG_ON) expect(response?.status()).toBe(404);
    else await expect(page.getByText("Competition registration is not currently open.")).toBeVisible();
  });

  test("competition entry CTA follows competition registration, independently of tickets (flag-on run only)", async ({ browser }) => {
    test.skip(!FLAG_ON, "Needs the app started with NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true (E2E_COMPETITION_REGISTRATION_ENABLED=true).");
    const event = fixture.events.ticketsOff;
    const before = await readEventRegistration(config, event.id);
    const owner = await as(browser, fixture.owner);
    await owner.goto(`/app/events/${event.id}/competition`);
    await owner.getByRole("button", { name: "Open registration" }).click();
    await expect(owner.getByRole("button", { name: "Close registration" })).toBeVisible({ timeout: 30_000 });
    expect(await readEventRegistration(config, event.id)).toEqual(before);

    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(`/events/${event.slug}`);
    await expect(visitor.getByRole("link", { name: "Open Competition Registration" })).toBeVisible();
    await expect(visitor.getByText("Basic Event Listing")).toBeVisible();
    await expect(visitor.getByText("Open Registration Form")).toHaveCount(0);
    await visitor.goto(`/events/${fixture.events.ticketsOn.slug}`);
    await expect(visitor.getByRole("link", { name: "Open Competition Registration" })).toHaveCount(0);
    await expect(visitor.getByText("Open Registration Form")).toBeVisible();
    // The competition does not require an account, so a signed-out visitor reaches the entry form.
    await visitor.goto(`/events/${event.slug}/competition/register`);
    await expect(visitor.getByRole("heading", { name: "Competition Registration" })).toBeVisible();
    await expect(visitor.getByText("Competition registration is not currently open.")).toHaveCount(0);

    await owner.getByRole("button", { name: "Close registration" }).click();
    await expect(owner.getByText("Registration is open.")).toHaveCount(0, { timeout: 30_000 });
    expect(await readEventRegistration(config, event.id)).toEqual(before);
    await visitor.goto(`/events/${event.slug}`);
    await expect(visitor.getByRole("link", { name: "Open Competition Registration" })).toHaveCount(0);
    const [program] = await readPrograms(config, event.id);
    expect(program.registration_status).toBe("closed");
    await owner.context().close();
    await visitor.context().close();
  });

  test("NDCA Multi-Dance: draft is created and published, but opening registration is refused while the hold exists", async ({ browser }) => {
    const event = fixture.events.multiDance;
    const before = await readEventRegistration(config, event.id);
    const page = await as(browser, fixture.owner);
    await openWizard(page, event.id);
    await startCompetition(page, "Ballroom");
    await chooseNdcaProAmMultiDance(page);
    await finishSetup(page, { accountRequired: true }, { model: "Per entry", amount: "60" });
    await createDraft(page, event.id);
    await publishFromWorkspace(page, event.id);
    await page.getByRole("button", { name: "Open registration" }).click();
    await expect(page.getByText(/Multi-Dance results are not supported/)).toBeVisible({ timeout: 30_000 });

    const [program] = await readPrograms(config, event.id);
    expect(program).toMatchObject({ rules_profile_version: 3, registration_status: "closed" });
    const admin = e2eAdminClient(config);
    const { data: contests } = await admin.from("event_competition_contests").select("contest_type, configuration").eq("event_id", event.id);
    expect(contests?.map((contest) => [contest.contest_type, contest.configuration?.setup?.registration_hold])).toEqual([
      ["multi_dance", "multi_dance_results_not_operational"],
    ]);
    expect(await readEventRegistration(config, event.id)).toEqual(before);
    await page.context().close();
  });

  test("an instructor cannot open the wizard or change a competition event's venue", async ({ browser }) => {
    const event = fixture.events.operations;
    const admin = e2eAdminClient(config);
    const { data: before } = await admin.from("events").select("venue_name, updated_at").eq("id", event.id).single();
    const page = await as(browser, fixture.instructor);
    const wizard = await page.goto(`/app/events/${event.id}/competition/new`);
    expect(wizard?.status()).toBe(404);

    await page.goto(`/app/events/${event.id}/edit`);
    await page.locator('input[name="venueName"]').fill("Instructor Venue");
    await page.getByRole("button", { name: "Save Event Changes" }).click();
    // Refused by the database guard (protect_competition_event_operations), surfaced by Edit event.
    await expect(page.getByText(/can change the venue, dates, times or time zone of a competition event/)).toBeVisible({ timeout: 30_000 });
    const { data: after } = await admin.from("events").select("venue_name, updated_at").eq("id", event.id).single();
    expect(after).toEqual(before);
    await page.context().close();
  });

  test("Back, Continue and refresh keep wizard selections; the event page fields render on the public page", async ({ browser }) => {
    const event = fixture.events.presentation;
    const before = await readEventRegistration(config, event.id);
    const page = await as(browser, fixture.owner);
    await openWizard(page, event.id);
    await startCompetition(page, "Country");
    await page.getByRole("checkbox", { name: /^Couples Two dancers/ }).check();
    await continueButton(page).click();
    await page.getByRole("button", { name: "Newcomer", exact: true }).click();
    await page.getByRole("button", { name: "Open", exact: true }).nth(1).click();

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: /^Couples Two dancers/ })).toBeChecked();
    await continueButton(page).click();
    await expect(page.getByRole("button", { name: "Newcomer", exact: true })).toHaveAttribute("aria-pressed", "true");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Set up your competition" })).toBeVisible();
    // After a refresh the wizard resumes with the same answers (the step list keeps every reached step enabled).
    await page.getByRole("button", { name: "6. Divisions" }).click();
    await expect(page.getByRole("button", { name: "Newcomer", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Open", exact: true }).nth(1)).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "5. Offerings" }).click();
    await expect(page.getByRole("checkbox", { name: /^Couples Two dancers/ })).toBeChecked();

    await page.getByRole("button", { name: "6. Divisions" }).click();
    await continueButton(page).click();
    await page.getByRole("button", { name: "Two Step", exact: true }).click();
    await continueButton(page).click();
    await continueButton(page).click();
    await finishSetup(page, { accountRequired: true }, { model: "Per dance", amount: "20" }, {
      summary: "An E2E summary for the public page.", highlight: "Live band", registrationInfo: "Entries close two weeks before.",
    });
    await createDraft(page, event.id);

    const after = await readEventRegistration(config, event.id);
    expect({ ...after.event, updated_at: null }).toEqual({ ...before.event, updated_at: null });
    expect(after.tickets).toEqual(before.tickets);

    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(`/events/${event.slug}`);
    await expect(visitor.getByRole("heading", { level: 1, name: event.name })).toBeVisible();
    await expect(visitor.getByText("An E2E summary for the public page.").first()).toBeVisible();
    await expect(visitor.getByText("Live band").first()).toBeVisible();
    await expect(visitor.getByText("Entries close two weeks before.").first()).toBeVisible();
    await expect(visitor.getByText("Open Registration Form")).toBeVisible();
    await page.context().close();
    await visitor.context().close();
  });

  test("existing studio_simple@2 programs are untouched", async ({ browser }) => {
    expect(await readPrograms(config, fixture.events.legacyV2.id)).toEqual(legacyV2Before);
    const page = await as(browser, fixture.owner);
    await page.goto(`/app/events/${fixture.events.legacyV2.id}/competition`);
    await expect(page.getByText(/rules v2/)).toBeVisible();
    await page.context().close();
  });
});

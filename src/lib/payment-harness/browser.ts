import { chromium } from "playwright";
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  PaymentHarnessSafetyError,
  assertConfirmed,
  assertPaymentHarnessClient,
  assertPaymentHarnessEnvironmentAllowed,
  assertPaymentHarnessStudio,
} from "@/lib/payment-harness/guards";
import { establishPaymentHarnessFloorRentalFixture } from "@/lib/payment-harness/fixture";
import {
  markPaymentHarnessRunFailed,
  markPaymentHarnessRunPassed,
  startPaymentHarnessRun,
  updatePaymentHarnessRunEvidence,
} from "@/lib/payment-harness/evidence";
import type {
  PaymentHarnessBrowserScenarioResult,
  PaymentHarnessCheckoutCapture,
  PaymentHarnessCheckpoint,
  PaymentHarnessConfig,
} from "@/lib/payment-harness/types";

/**
 * Payment Harness browser wrapper (Slice 4) -- phases 1-3 of the portal
 * floor-rental checkout scenario: authenticate, submit Pay Open Balance
 * once and capture the Stripe Checkout session, then submit again and
 * verify the identical session is reused. Stops before payment
 * completion: no card entry, no PaymentIntent.confirm, no Charge.
 *
 * Split deliberately into two layers:
 *   - Pure functions (origin/URL/session-id/balance parsing and the
 *     assertions built on them) that take plain strings and never touch a
 *     browser -- fully unit-testable without Playwright or a real Stripe
 *     account.
 *   - Orchestration functions that take an injected `PaymentHarnessBrowserPage`
 *     (a narrow, structural interface, not Playwright's own `Page` type) --
 *     tests inject a fake implementing just these methods; only
 *     `createPaymentHarnessBrowser` below ever launches a real browser.
 *
 * Login goes through the app's own, already-in-production
 * admin-generated-magic-link pattern (see
 * src/app/app/clients/[id]/actions.ts's studio-invite email flow and the
 * real src/app/(auth)/callback/route.ts, both unmodified here): this
 * module calls `adminSupabase.auth.admin.generateLink({type:"magiclink"})`
 * to obtain a `token_hash`, then navigates the browser to the real
 * `/callback` route, which runs the real `supabase.auth.verifyOtp()` check
 * and issues a real session via real Set-Cookie headers -- the same
 * verification a human clicking an emailed magic link goes through. No new
 * app route, no fabricated cookie, no SSR-cookie replication, no
 * service-role auth bypass. Portal client login has no password option in
 * the UI (`src/app/(auth)/login/page.tsx` only offers `loginMode:
 * "magic_link"` for the `public` intent), so this is the only mechanism
 * available that doesn't require reading a real email inbox or storing a
 * new harness credential -- confirmed with the user before implementing.
 *
 * After the callback lands, `verifyAuthenticatedPortalIdentity` positively
 * confirms the authenticated identity actually corresponds to
 * `config.clientId` (via `profiles` + `client_account_links`, the same
 * tables `src/lib/auth/portal-linking.ts` itself uses) before any balance
 * check or checkout action is trusted -- `config.portalLoginEmail` alone is
 * never assumed to imply the right client.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

// The only hostname Stripe hosted Checkout Sessions are ever served from.
const STRIPE_CHECKOUT_HOSTNAMES = new Set(["checkout.stripe.com"]);

const STRIPE_CHECKOUT_SESSION_ID_PATTERN = /\/(cs_[a-zA-Z0-9_]+)(?:[/?#]|$)/;

// Exact copy from src/app/portal/[studioSlug]/floor-space/my-rentals/page.tsx
// ("Balance due right now" label, `formatCurrency` immediately after it) --
// intentionally string-matched against the real page rather than a
// data-testid, since adding one would be an app-code change outside this
// slice's scope.
const BALANCE_LABEL = "Balance due right now";
const CURRENCY_PATTERN = /\$([\d,]+\.\d{2})/;
const BALANCE_LABEL_SEARCH_WINDOW = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function checkpoint(name: string, status: "passed" | "failed", detail?: string): PaymentHarnessCheckpoint {
  return Object.freeze({ name, status, at: nowIso(), ...(detail ? { detail } : {}) });
}

// ---------------------------------------------------------------------------
// Pure functions -- no browser, no network, fully unit-testable.
// ---------------------------------------------------------------------------

export type PaymentHarnessNavigationOrigin = "app" | "stripe_checkout";

/**
 * The single navigation-origin gate every browser action in this module
 * goes through. Fails closed on anything other than the configured app
 * origin or the real Stripe Checkout hostname -- an unexpected external
 * origin (a redirect chain gone wrong, a phishing-shaped domain, a typo in
 * PAYMENT_HARNESS_BASE_URL) is refused rather than silently followed.
 */
export function assertAllowedNavigationOrigin(
  url: string,
  config: PaymentHarnessConfig,
  context: string,
): PaymentHarnessNavigationOrigin {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): navigated to an unparseable URL. Refusing to proceed.`,
      "BROWSER_URL_UNPARSEABLE",
    );
  }

  if (parsed.origin === config.baseUrl) return "app";
  if (STRIPE_CHECKOUT_HOSTNAMES.has(parsed.hostname)) return "stripe_checkout";

  throw new PaymentHarnessSafetyError(
    `Fail-closed (${context}): navigation left the allowed origin set (the configured Payment ` +
      `Harness application origin, or Stripe Checkout). Refusing to proceed.`,
    "BROWSER_UNEXPECTED_ORIGIN",
  );
}

/**
 * Parses a Stripe Checkout Session id out of a hosted Checkout URL's path
 * (`https://checkout.stripe.com/c/pay/cs_test_...#fidkd...` or the legacy
 * `/pay/cs_...` shape) -- matches the `cs_...` path segment regardless of
 * prefix or trailing fragment, so it isn't tied to one specific Checkout
 * URL layout. Returns `null` (never throws) when nothing matches; callers
 * that require a session id fail closed on that `null` themselves.
 */
export function parseStripeCheckoutSessionId(checkoutUrl: string): string | null {
  const match = checkoutUrl.match(STRIPE_CHECKOUT_SESSION_ID_PATTERN);
  return match ? match[1] : null;
}

/**
 * Parses and requires a **test-mode** Checkout Session id
 * (`cs_test_...`) from a Checkout URL -- an independent, URL-level
 * test-mode check, in the same spirit as stripeTestMode.ts's
 * `assertStripeObjectIsTestMode` (never trust context; verify from the
 * artifact itself). `cs_live_...` fails closed with a distinct code.
 */
export function assertStripeCheckoutUrlIsTestMode(checkoutUrl: string, context: string): string {
  const sessionId = parseStripeCheckoutSessionId(checkoutUrl);

  if (!sessionId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): could not parse a Stripe Checkout session id from the ` +
        `navigated URL. Refusing to proceed.`,
      "CHECKOUT_SESSION_ID_UNPARSEABLE",
    );
  }

  if (!sessionId.startsWith("cs_test_")) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): Stripe Checkout session id is not test-mode. Refusing to proceed.`,
      "CHECKOUT_SESSION_LIVEMODE",
    );
  }

  return sessionId;
}

/**
 * Extracts the balance (in cents) rendered near the "Balance due right
 * now" label from the My Rentals page's plain rendered text. Deliberately
 * a plain string search, not a DOM/locator traversal -- keeps this fully
 * unit-testable and independent of Playwright's selector API. Returns
 * `null` (never throws) when the label or a following dollar amount can't
 * be found.
 */
export function parseDisplayedBalanceCents(pageText: string): number | null {
  const labelIndex = pageText.indexOf(BALANCE_LABEL);
  if (labelIndex === -1) return null;

  const window = pageText.slice(
    labelIndex + BALANCE_LABEL.length,
    labelIndex + BALANCE_LABEL.length + BALANCE_LABEL_SEARCH_WINDOW,
  );
  const match = window.match(CURRENCY_PATTERN);
  if (!match) return null;

  const dollars = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(dollars)) return null;

  return Math.round(dollars * 100);
}

export function assertDisplayedBalanceMatches(
  pageText: string,
  expectedCents: number,
  context: string,
): number {
  const displayedCents = parseDisplayedBalanceCents(pageText);

  if (displayedCents === null) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): could not find/parse a displayed balance on the My Rentals page.`,
      "DISPLAYED_BALANCE_UNPARSEABLE",
    );
  }

  if (displayedCents !== expectedCents) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): displayed balance (${displayedCents} cents) does not match the ` +
        `fixture's expected balance (${expectedCents} cents). Refusing to proceed to checkout.`,
      "DISPLAYED_BALANCE_MISMATCH",
    );
  }

  return displayedCents;
}

/**
 * Fails closed unless both captures parsed a session id and the two ids
 * are identical -- a different (or unparseable) second session means the
 * "Pay Open Balance" submit created a new Checkout Session instead of
 * reusing the first one's still-open pending payment.
 */
export function assertSameCheckoutSession(
  first: PaymentHarnessCheckoutCapture,
  second: PaymentHarnessCheckoutCapture,
  context: string,
): void {
  if (!first.sessionId || !second.sessionId || first.sessionId !== second.sessionId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the second Pay Open Balance submit did not reuse the first ` +
        `Stripe Checkout Session. Refusing to report this as a successful reuse.`,
      "CHECKOUT_SESSION_NOT_REUSED",
    );
  }
}

// ---------------------------------------------------------------------------
// Browser page abstraction -- structural interface + real Playwright-backed
// implementation. Orchestration functions below depend only on the
// interface, so tests inject a fake without ever importing Playwright.
// ---------------------------------------------------------------------------

export interface PaymentHarnessBrowserPage {
  goto(url: string): Promise<void>;
  url(): string;
  getDisplayedPageText(): Promise<string>;
  submitPayOpenBalance(): Promise<void>;
}

export type PaymentHarnessBrowser = {
  readonly page: PaymentHarnessBrowserPage;
  close(): Promise<void>;
};

/**
 * Launches a real, headless Chromium browser via Playwright. The only
 * function in this module that does so -- every phase/orchestration
 * function below takes an already-constructed `PaymentHarnessBrowserPage`,
 * so unit tests never need this factory or a real browser binary.
 */
export async function createPaymentHarnessBrowser(): Promise<PaymentHarnessBrowser> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const playwrightPage = await context.newPage();

  const page: PaymentHarnessBrowserPage = {
    async goto(url: string) {
      await playwrightPage.goto(url, { waitUntil: "load" });
    },
    url() {
      return playwrightPage.url();
    },
    async getDisplayedPageText() {
      return playwrightPage.locator("body").innerText();
    },
    async submitPayOpenBalance() {
      await playwrightPage.getByRole("button", { name: "Pay Open Balance" }).click();
      await playwrightPage.waitForLoadState("load");
    },
  };

  return {
    page,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Auth + DB helpers
// ---------------------------------------------------------------------------

/**
 * Positively verifies that `config.portalLoginEmail` is actually linked to
 * `config.clientId` (and that link's studio is actually `config.studioId`)
 * -- run immediately after login, before anything the authenticated
 * session can see or do is trusted. Resolves the relationship from the
 * same tables `src/lib/auth/portal-linking.ts` itself uses
 * (`profiles` for email -> auth user id, `client_account_links` for the
 * user -> client/studio relationship), via the injected admin client, then
 * runs the real Slice 1 guards against the resolved values -- never trusts
 * `config.portalLoginEmail` alone to imply the right client authenticated.
 * Read-only: never creates, updates, or repairs a relationship (that is
 * `ensurePortalProfileAndClientLinks`'s job, deliberately not reused
 * here). Fails closed on zero, multiple, or non-"linked" matches at
 * either resolution step.
 */
async function verifyAuthenticatedPortalIdentity(
  adminSupabase: AdminClient,
  config: PaymentHarnessConfig,
  context: string,
): Promise<void> {
  const { data: profileRows, error: profileError } = await adminSupabase
    .from("profiles")
    .select("id")
    .eq("email", config.portalLoginEmail);

  if (profileError) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to resolve the authenticated portal user for the ` +
        `configured login email.`,
      "PORTAL_IDENTITY_LOOKUP_FAILED",
    );
  }

  const profiles = profileRows ?? [];

  if (profiles.length === 0) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): no portal user profile found for the configured login email. ` +
        `Refusing to proceed.`,
      "PORTAL_IDENTITY_NOT_FOUND",
    );
  }

  if (profiles.length > 1) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): more than one portal user profile matched the configured login ` +
        `email. Refusing to proceed with an ambiguous identity.`,
      "PORTAL_IDENTITY_AMBIGUOUS",
    );
  }

  const authUserId = profiles[0].id as string;

  const { data: linkRows, error: linkError } = await adminSupabase
    .from("client_account_links")
    .select("client_id, studio_id")
    .eq("user_id", authUserId)
    .eq("client_id", config.clientId)
    .eq("status", "linked");

  if (linkError) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to resolve the configured client's portal account link.`,
      "PORTAL_IDENTITY_LOOKUP_FAILED",
    );
  }

  const links = linkRows ?? [];

  if (links.length === 0) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): no active portal relationship links the configured login email ` +
        `to the configured client. Refusing to proceed.`,
      "PORTAL_IDENTITY_NOT_FOUND",
    );
  }

  if (links.length > 1) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): more than one active portal relationship links the configured ` +
        `login email to the configured client. Refusing to proceed with an ambiguous relationship.`,
      "PORTAL_IDENTITY_AMBIGUOUS",
    );
  }

  const link = links[0];
  assertPaymentHarnessClient(config, link.client_id as string, context);
  assertPaymentHarnessStudio(config, link.studio_id as string, context);
}

/**
 * Authenticates the browser as the configured QA portal client via the
 * app's real, unmodified auth callback route -- see this file's module
 * doc comment for why this is the mechanism used. Re-checks the
 * environment allowlist immediately before requesting the link (a fresh,
 * real credential-issuing action, not just a read). After the callback
 * lands, positively verifies the authenticated identity via
 * `verifyAuthenticatedPortalIdentity` before returning -- so no caller of
 * this function can ever proceed past login with an unverified identity.
 */
async function authenticateAsConfiguredPortalClient(params: {
  page: PaymentHarnessBrowserPage;
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
}): Promise<void> {
  const { page, adminSupabase, config } = params;
  const context = "authenticateAsConfiguredPortalClient";

  assertPaymentHarnessEnvironmentAllowed(config.environment, context);

  const { data: linkData, error } = await adminSupabase.auth.admin.generateLink({
    type: "magiclink",
    email: config.portalLoginEmail,
    options: { redirectTo: `${config.baseUrl}/callback` },
  });

  if (error || !linkData?.properties?.hashed_token) {
    // Never interpolate the link/token itself -- only the fact that
    // generation failed.
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to generate a Payment Harness portal login link.`,
      "PORTAL_LOGIN_LINK_FAILED",
    );
  }

  const tokenHash = linkData.properties.hashed_token;
  const callbackUrl = `${config.baseUrl}/callback?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink`;

  await page.goto(callbackUrl);

  const landedOrigin = assertAllowedNavigationOrigin(page.url(), config, context);
  if (landedOrigin !== "app" || new URL(page.url()).pathname.startsWith("/login")) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the login callback did not land back in the configured ` +
        `application as an authenticated session. Refusing to proceed.`,
      "PORTAL_LOGIN_FAILED",
    );
  }

  await verifyAuthenticatedPortalIdentity(adminSupabase, config, context);
}

async function resolveConfiguredStudioSlug(
  adminSupabase: AdminClient,
  config: PaymentHarnessConfig,
  context: string,
): Promise<string> {
  const { data, error } = await adminSupabase
    .from("studios")
    .select("slug")
    .eq("id", config.studioId)
    .maybeSingle();

  if (error || !data?.slug) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): could not resolve the configured studio's slug.`,
      "STUDIO_SLUG_LOOKUP_FAILED",
    );
  }

  return data.slug as string;
}

function buildMyRentalsUrl(baseUrl: string, studioSlug: string, clientId: string): string {
  return `${baseUrl}/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals?client=${encodeURIComponent(clientId)}`;
}

/**
 * Read-only check that exactly one pending floor-rental `payments` row
 * exists for the configured client -- the same (studio_id, client_id,
 * source='floor_rental', status='pending') shape
 * `portal-floor-rental-checkout-session.ts` itself queries by. Never
 * creates, updates, or deletes a payment row; only confirms what the real
 * checkout route already wrote.
 */
async function verifyExactlyOnePendingFloorRentalPayment(
  adminSupabase: AdminClient,
  config: PaymentHarnessConfig,
  context: string,
): Promise<void> {
  const { data, error } = await adminSupabase
    .from("payments")
    .select("id")
    .eq("studio_id", config.studioId)
    .eq("client_id", config.clientId)
    .eq("source", "floor_rental")
    .eq("status", "pending");

  if (error) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to verify the pending floor-rental payment row: ${error.message}.`,
      "PENDING_PAYMENT_LOOKUP_FAILED",
    );
  }

  const rows = data ?? [];
  if (rows.length !== 1) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): expected exactly one pending floor-rental payment row for the ` +
        `configured client, found ${rows.length}.`,
      "PENDING_PAYMENT_COUNT_MISMATCH",
    );
  }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * Phase 1 -- establishes fixture state, authenticates, navigates to My
 * Rentals, and verifies the displayed balance matches the fixture's
 * expected balance before any checkout action is attempted.
 */
export async function runFixtureAndPortalStatePhase(params: {
  page: PaymentHarnessBrowserPage;
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
}): Promise<{
  expectedBalanceCents: number;
  displayedBalanceCents: number;
  myRentalsUrl: string;
  checkpoint: PaymentHarnessCheckpoint;
}> {
  const { page, adminSupabase, config } = params;
  const context = "runFixtureAndPortalStatePhase";

  assertPaymentHarnessEnvironmentAllowed(config.environment, context);

  const fixtureResult = await establishPaymentHarnessFloorRentalFixture(adminSupabase, config);

  await authenticateAsConfiguredPortalClient({ page, adminSupabase, config });

  const studioSlug = await resolveConfiguredStudioSlug(adminSupabase, config, context);
  const myRentalsUrl = buildMyRentalsUrl(config.baseUrl, studioSlug, config.clientId);

  await page.goto(myRentalsUrl);
  assertAllowedNavigationOrigin(page.url(), config, context);

  const pageText = await page.getDisplayedPageText();
  const displayedBalanceCents = assertDisplayedBalanceMatches(
    pageText,
    fixtureResult.expectedBalanceCents,
    context,
  );

  return {
    expectedBalanceCents: fixtureResult.expectedBalanceCents,
    displayedBalanceCents,
    myRentalsUrl,
    checkpoint: checkpoint(
      "phase1_fixture_and_portal_state",
      "passed",
      `reusedExisting=${fixtureResult.reusedExisting} created=${fixtureResult.created}`,
    ),
  };
}

/**
 * Phase 2 -- clicks the real Pay Open Balance button, waits for navigation
 * to Stripe hosted Checkout, and captures the URL/session id. Never enters
 * card details or completes payment.
 */
export async function runFirstCheckoutSubmitPhase(params: {
  page: PaymentHarnessBrowserPage;
  config: PaymentHarnessConfig;
}): Promise<{ checkout: PaymentHarnessCheckoutCapture; checkpoint: PaymentHarnessCheckpoint }> {
  const { page, config } = params;
  const context = "runFirstCheckoutSubmitPhase";

  assertPaymentHarnessEnvironmentAllowed(config.environment, context);

  await page.submitPayOpenBalance();

  const url = page.url();
  const origin = assertAllowedNavigationOrigin(url, config, context);
  if (origin !== "stripe_checkout") {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): submitting Pay Open Balance did not navigate to Stripe Checkout.`,
      "CHECKOUT_NAVIGATION_FAILED",
    );
  }

  const sessionId = assertStripeCheckoutUrlIsTestMode(url, context);

  return {
    checkout: Object.freeze({ url, sessionId }),
    checkpoint: checkpoint("phase2_first_checkout_submit", "passed", `sessionId=${sessionId}`),
  };
}

/**
 * Phase 3 -- navigates back to My Rentals, submits Pay Open Balance again,
 * and verifies the second Checkout Session is identical to the first
 * (proving reuse, not a duplicate session/payment row). Read-only DB
 * verification of the pending payments row; never writes one.
 */
export async function runReuseVerificationPhase(params: {
  page: PaymentHarnessBrowserPage;
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  myRentalsUrl: string;
  firstCheckout: PaymentHarnessCheckoutCapture;
}): Promise<{ checkout: PaymentHarnessCheckoutCapture; checkpoint: PaymentHarnessCheckpoint }> {
  const { page, adminSupabase, config, myRentalsUrl, firstCheckout } = params;
  const context = "runReuseVerificationPhase";

  assertPaymentHarnessEnvironmentAllowed(config.environment, context);

  await page.goto(myRentalsUrl);
  assertAllowedNavigationOrigin(page.url(), config, context);

  await page.submitPayOpenBalance();

  const url = page.url();
  const origin = assertAllowedNavigationOrigin(url, config, context);
  if (origin !== "stripe_checkout") {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the second Pay Open Balance submit did not navigate to Stripe Checkout.`,
      "CHECKOUT_NAVIGATION_FAILED",
    );
  }

  const sessionId = assertStripeCheckoutUrlIsTestMode(url, context);
  const secondCheckout: PaymentHarnessCheckoutCapture = Object.freeze({ url, sessionId });

  assertSameCheckoutSession(firstCheckout, secondCheckout, context);
  await verifyExactlyOnePendingFloorRentalPayment(adminSupabase, config, context);

  return {
    checkout: secondCheckout,
    checkpoint: checkpoint("phase3_reuse_verification", "passed", `sessionId=${sessionId}`),
  };
}

// ---------------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs phases 1-3 of the floor-rental browser scenario end to end. Stops
 * before payment completion -- there is no phase 4 here.
 *
 * `confirmed` mirrors the Slice 1 `assertConfirmed` guard: this slice has
 * no CLI yet, so the caller (a future Slice 8 CLI) is expected to pass
 * through its own `--confirm` flag here rather than this function
 * inventing a default.
 *
 * `evidence` is optional and purely DI-based -- when provided, this
 * records expected balance, first/second Checkout Session ids, and one
 * checkpoint per phase via the real (unmodified) Slice 2 evidence.ts
 * functions, which already work against fakes with no migration applied.
 * When omitted, the scenario runs with no evidence writes at all.
 */
export async function runPaymentHarnessFloorRentalBrowserScenario(params: {
  page: PaymentHarnessBrowserPage;
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  confirmed: boolean;
  evidence?: {
    runId: string;
    scenario: string;
    deploymentSha: string;
  };
}): Promise<PaymentHarnessBrowserScenarioResult> {
  const { page, adminSupabase, config, confirmed, evidence } = params;
  const context = "runPaymentHarnessFloorRentalBrowserScenario";

  assertConfirmed(confirmed, context);
  assertPaymentHarnessEnvironmentAllowed(config.environment, context);

  const checkpoints: PaymentHarnessCheckpoint[] = [];

  try {
    const phase1 = await runFixtureAndPortalStatePhase({ page, adminSupabase, config });
    checkpoints.push(phase1.checkpoint);

    if (evidence) {
      await startPaymentHarnessRun({
        adminSupabase,
        config,
        runId: evidence.runId,
        scenario: evidence.scenario,
        deploymentSha: evidence.deploymentSha,
        expectedBalanceCents: phase1.expectedBalanceCents,
      });
      await updatePaymentHarnessRunEvidence({
        adminSupabase,
        config,
        runId: evidence.runId,
        checkpoint: phase1.checkpoint,
      });
    }

    const phase2 = await runFirstCheckoutSubmitPhase({ page, config });
    checkpoints.push(phase2.checkpoint);

    if (evidence) {
      await updatePaymentHarnessRunEvidence({
        adminSupabase,
        config,
        runId: evidence.runId,
        patch: { firstSessionId: phase2.checkout.sessionId },
        checkpoint: phase2.checkpoint,
      });
    }

    const phase3 = await runReuseVerificationPhase({
      page,
      adminSupabase,
      config,
      myRentalsUrl: phase1.myRentalsUrl,
      firstCheckout: phase2.checkout,
    });
    checkpoints.push(phase3.checkpoint);

    if (evidence) {
      await updatePaymentHarnessRunEvidence({
        adminSupabase,
        config,
        runId: evidence.runId,
        patch: { reusedSessionId: phase3.checkout.sessionId },
        checkpoint: phase3.checkpoint,
      });
      await markPaymentHarnessRunPassed({ adminSupabase, config, runId: evidence.runId });
    }

    return Object.freeze({
      displayedBalanceCents: phase1.displayedBalanceCents,
      firstCheckout: phase2.checkout,
      secondCheckout: phase3.checkout,
      checkoutReused: true,
      checkpoints: Object.freeze([...checkpoints]),
    });
  } catch (scenarioError) {
    if (evidence) {
      const message = scenarioError instanceof Error ? scenarioError.message : String(scenarioError);
      await markPaymentHarnessRunFailed({ adminSupabase, config, runId: evidence.runId, failureReason: message }).catch(
        () => {
          // The scenario failure is the one that matters -- a failure to
          // record it must never mask or replace the original error.
        },
      );
    }
    throw scenarioError;
  }
}

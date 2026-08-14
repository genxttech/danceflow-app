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
import {
  verifyCheckoutSessionIsTestMode,
  type StripeClientFactory,
} from "@/lib/payment-harness/stripeVerification";
import {
  assertConnectListenerReady,
  type ConnectTriggerFn,
  type StripeEventClientFactory,
} from "@/lib/payment-harness/connectListenerReadiness";
import type {
  PaymentHarnessBrowserScenarioResult,
  PaymentHarnessCheckoutCapture,
  PaymentHarnessCheckpoint,
  PaymentHarnessConfig,
  PaymentHarnessExecutionMode,
  PaymentHarnessFulfillmentOutcome,
  PaymentHarnessFulfillmentResult,
  PaymentHarnessPrePaymentReadinessResult,
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
 *
 * Slice 5 extends this with two opt-in phases, controlled by the
 * orchestrator's `executionMode` (default `"checkout_reuse_only"`, under
 * which neither ever runs -- every Slice 4 test is unchanged): phase 4
 * completes the already-captured hosted Checkout Session in Stripe test
 * mode only (real `checkout.stripe.com` card fields, Stripe's published
 * `4242 4242 4242 4242` test card -- never `PaymentIntent.confirm`, never
 * the Charge API, never an app-side payment-state write), and phase 5
 * verifies fulfillment by reading real `payments`/`appointments` rows
 * through a bounded poll -- never by writing to either table.
 *
 * Slice 6 splits what was previously the first half of phase 4 into its
 * own, independently callable phase: `runPrePaymentReadinessPhase` runs
 * three independent checks in order -- `assertAppWebhookRouteReady`
 * probes the real, already-deployed `/api/payments/webhook` route (no new
 * route) with a deliberately unsigned request and requires exactly the
 * same 400 "Invalid webhook request" response the route already gives any
 * unsigned call -- this proves only that the app's own webhook route is
 * reachable and has a webhook secret configured, nothing about Stripe's
 * Connect delivery path; `verifyCheckoutSessionIsTestMode`
 * (stripeVerification.ts) independently re-confirms `livemode === false`
 * on the Checkout Session itself via the harness-only Stripe test key; and
 * `assertConnectListenerReady` (connectListenerReadiness.ts) is the real,
 * deterministic Connect-listener readiness gate -- it triggers exactly one
 * harmless, Connect-scoped test event, requires a matching
 * `payment_provider_events` row to appear within a bounded window, and
 * independently re-retrieves that exact Stripe Event (id/type/livemode/
 * account all verified) before treating the delivery path as alive. This
 * phase takes no `page` parameter at all -- it is structurally incapable
 * of calling `page.completeTestPayment()` or touching card fields, since
 * it never receives a page reference to call anything on. It returns a
 * frozen `PaymentHarnessPrePaymentReadinessResult` (safe evidence -- ids,
 * a DB status, `livemode`, a timestamp; never a secret or card data) and
 * control to the caller.
 *
 * `runPaymentCompletionPhase` is the *only* place `page.completeTestPayment()`
 * is ever called in this module: it calls `runPrePaymentReadinessPhase`
 * first and only proceeds to card entry if that resolves without
 * throwing. There is no code path around this ordering, no config flag,
 * boolean argument, or caller override that skips the listener-readiness
 * check before payment completion.
 *
 * A joint safety review of an earlier revision of this slice (Maya Reed +
 * Daniel Hayes) found that the first two checks alone cannot detect the
 * specific, previously-reproduced operational failure this gate exists to
 * prevent: a Stripe CLI Connect-webhook listener that showed "Ready!" at
 * some point but whose websocket later silently disconnects while the
 * app's own route stays perfectly healthy. `assertConnectListenerReady`
 * closes that gap by proving a *freshly generated* event actually
 * traveled the real delivery path moments ago, rather than trusting any
 * cached/assumed state.
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

// The real, already-deployed Stripe webhook route (src/app/api/payments/webhook/route.ts)
// -- never a new route added for this harness.
const APP_WEBHOOK_ROUTE_PATH = "/api/payments/webhook";

// ~30s total bound (15 attempts x 2s) -- "bounded wait/poll... No infinite
// polling." Both are overridable per-call for tests.
const DEFAULT_FULFILLMENT_POLL_MAX_ATTEMPTS = 15;
const DEFAULT_FULFILLMENT_POLL_INTERVAL_MS = 2000;

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

/**
 * Computes a card expiry (MM/YY) safely in the future relative to
 * `referenceDate` -- deliberately computed rather than a hardcoded string
 * like `"12/34"`, which would itself eventually become a past date, the
 * same "future by construction, not a fixed date that ages" reasoning
 * fixture.ts already uses for its own lead time. Exported for direct unit
 * testing; the real card-entry helper below is the only caller in
 * non-test code.
 */
export function buildFutureTestCardExpiry(referenceDate: Date = new Date()): string {
  const future = new Date(referenceDate);
  future.setFullYear(future.getFullYear() + 8);
  const month = String(future.getMonth() + 1).padStart(2, "0");
  const year = String(future.getFullYear()).slice(-2);
  return `${month}/${year}`;
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
  /**
   * Slice 5: completes the already-loaded hosted Checkout page using
   * Stripe's published test card only. Narrowly encapsulated here --
   * no card data is ever a parameter, return value, or logged anywhere;
   * the real implementation's card constants live entirely inside
   * `createPaymentHarnessBrowser`'s own closure.
   */
  completeTestPayment(): Promise<void>;
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
    async completeTestPayment() {
      // Stripe hosted Checkout's documented field ids for its own
      // published testing guidance -- unverified against a live page in
      // this slice (no real browser is launched during implementation
      // per this slice's own constraints); confirm/adjust these against
      // the real rendered page before this method is first exercised for
      // real, the same disclosed-but-unverified status Slice 4's balance
      // selector already carries.
      const TEST_CARD_NUMBER = "4242424242424242";
      const TEST_CARD_CVC = "123";

      await playwrightPage.locator("#cardNumber").fill(TEST_CARD_NUMBER);
      await playwrightPage.locator("#cardExpiry").fill(buildFutureTestCardExpiry());
      await playwrightPage.locator("#cardCvc").fill(TEST_CARD_CVC);

      const billingName = playwrightPage.locator("#billingName");
      if ((await billingName.count()) > 0) {
        await billingName.fill("Payment Harness QA");
      }

      await playwrightPage.getByRole("button", { name: /pay|submit/i }).click();
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

async function resolveConfiguredStudioConnectedAccountId(
  adminSupabase: AdminClient,
  config: PaymentHarnessConfig,
  context: string,
): Promise<string> {
  const { data, error } = await adminSupabase
    .from("studios")
    .select("stripe_connected_account_id")
    .eq("id", config.studioId)
    .maybeSingle();

  if (error || !data?.stripe_connected_account_id) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): could not resolve the configured studio's connected Stripe ` +
        `account. Refusing to proceed with an ambiguous session/account context.`,
      "STUDIO_CONNECTED_ACCOUNT_LOOKUP_FAILED",
    );
  }

  return data.stripe_connected_account_id as string;
}

/** Read-only: resolves and returns the id of the single pending
 * floor-rental payment row, so later phases can verify the *same* row
 * transitions to paid -- never creates or modifies it. */
async function resolvePendingFloorRentalPaymentId(
  adminSupabase: AdminClient,
  config: PaymentHarnessConfig,
  context: string,
): Promise<string> {
  const { data, error } = await adminSupabase
    .from("payments")
    .select("id")
    .eq("studio_id", config.studioId)
    .eq("client_id", config.clientId)
    .eq("source", "floor_rental")
    .eq("status", "pending");

  if (error) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to resolve the pending floor-rental payment row before payment.`,
      "PENDING_PAYMENT_LOOKUP_FAILED",
    );
  }

  const rows = data ?? [];
  if (rows.length !== 1) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): expected exactly one pending floor-rental payment row before ` +
        `payment, found ${rows.length}.`,
      "PENDING_PAYMENT_COUNT_MISMATCH",
    );
  }

  return rows[0].id as string;
}

type AppointmentSnapshot = ReadonlyMap<string, { status: string; paymentStatus: string }>;

/** Read-only: snapshots every floor-rental appointment's status/payment_status
 * for the configured client, so a later phase can prove any appointment
 * *outside* the charged payable set was never touched by fulfillment. */
async function snapshotFloorRentalAppointments(
  adminSupabase: AdminClient,
  config: PaymentHarnessConfig,
  context: string,
): Promise<AppointmentSnapshot> {
  const { data, error } = await adminSupabase
    .from("appointments")
    .select("id, status, payment_status")
    .eq("studio_id", config.studioId)
    .eq("client_id", config.clientId)
    .eq("appointment_type", "floor_space_rental");

  if (error) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to snapshot floor-rental appointments.`,
      "APPOINTMENT_SNAPSHOT_FAILED",
    );
  }

  const snapshot = new Map<string, { status: string; paymentStatus: string }>();
  for (const row of data ?? []) {
    snapshot.set(row.id as string, {
      status: row.status as string,
      paymentStatus: row.payment_status as string,
    });
  }
  return snapshot;
}

function snapshotToEvidenceRecord(snapshot: AppointmentSnapshot): Record<string, string> {
  return Object.fromEntries([...snapshot].map(([id, value]) => [id, value.paymentStatus]));
}

/**
 * App webhook route reachability/configuration check -- **not** a Stripe
 * Connect listener readiness check, and must never be described or relied
 * on as one (see this slice's own safety-review finding, in the module
 * doc comment above). Sends a real, deliberately unsigned POST to the
 * real, already-deployed webhook route and requires exactly the same 400
 * "Invalid webhook request" response the route already gives any request
 * with no `stripe-signature` header (see
 * src/app/api/payments/webhook/route.ts's own `if (!signature)` branch,
 * checked before any DB access, so this probe has no side effects).
 *
 * What this proves: the app's own webhook route is deployed, reachable,
 * and has a webhook secret configured (a 503 means the secret itself is
 * missing). What it does **not** prove: that Stripe's actual Connect
 * delivery mechanism is connected to that route -- for a `development`
 * run that depends on an operator-managed
 * `stripe listen --forward-connect-to` process entirely outside this
 * app's own infrastructure, which this check never observes in any way.
 * A dead/disconnected listener and a healthy one produce the identical
 * response here. Kept as one useful, narrowly-scoped precondition layer,
 * not the payment-completion safety gate -- see
 * `assertConnectListenerReady` (connectListenerReadiness.ts) for that.
 */
export type AppWebhookRouteReadinessFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

async function assertAppWebhookRouteReady(params: {
  config: PaymentHarnessConfig;
  context: string;
  fetchImpl?: AppWebhookRouteReadinessFetch;
}): Promise<void> {
  const { config, context } = params;
  const fetchImpl =
    params.fetchImpl ?? (globalThis.fetch as unknown as AppWebhookRouteReadinessFetch);
  const url = `${config.baseUrl}${APP_WEBHOOK_ROUTE_PATH}`;

  let response: { status: number };
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the app's Stripe webhook route was not reachable. Refusing to ` +
        `proceed.`,
      "APP_WEBHOOK_ROUTE_UNREACHABLE",
    );
  }

  if (response.status === 503) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the app's Stripe webhook route reports it is not configured ` +
        `(missing webhook secret). Refusing to proceed.`,
      "APP_WEBHOOK_ROUTE_NOT_CONFIGURED",
    );
  }

  if (response.status !== 400) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the app's Stripe webhook route did not respond as expected to a ` +
        `reachability probe (status ${response.status}). Refusing to proceed.`,
      "APP_WEBHOOK_ROUTE_UNEXPECTED_RESPONSE",
    );
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded poll (never infinite) of the payment row's own status --
 * read-only, never writes. Distinguishes a confident `"fulfilled"` read
 * from a confident-but-still-pending `"not_fulfilled_within_timeout"` read
 * from a genuinely ambiguous `"verification_error"` (a DB error, or a
 * status other than the two expected transitional values) -- see
 * `PaymentHarnessFulfillmentResult`'s own doc comment in types.ts for why
 * these three are never collapsed into a boolean.
 */
async function pollForPaymentRowStatus(params: {
  adminSupabase: AdminClient;
  paymentId: string;
  maxAttempts: number;
  intervalMs: number;
  sleepFn: (ms: number) => Promise<void>;
}): Promise<{ result: PaymentHarnessFulfillmentResult; row: Record<string, unknown> | null }> {
  const { adminSupabase, paymentId, maxAttempts, intervalMs, sleepFn } = params;
  let lastRow: Record<string, unknown> | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { data, error } = await adminSupabase
      .from("payments")
      .select("*")
      .eq("id", paymentId)
      .maybeSingle();

    if (error) {
      return { result: "verification_error", row: null };
    }

    lastRow = (data as Record<string, unknown> | null) ?? null;

    if (lastRow?.status === "paid") {
      return { result: "fulfilled", row: lastRow };
    }

    if (lastRow?.status && lastRow.status !== "pending") {
      return { result: "verification_error", row: lastRow };
    }

    if (attempt < maxAttempts - 1) {
      await sleepFn(intervalMs);
    }
  }

  return { result: "not_fulfilled_within_timeout", row: lastRow };
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
  payableAppointmentIds: readonly string[];
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
    payableAppointmentIds: fixtureResult.payableAppointmentIds,
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

/**
 * Phase 4a -- pre-payment readiness. Runs the three independent checks
 * that must all pass before any card data is ever entered, in this exact
 * order: (1) `assertAppWebhookRouteReady` -- the app's own webhook route
 * is reachable and configured; (2) `verifyCheckoutSessionIsTestMode` --
 * the captured Checkout Session is independently re-confirmed test-mode
 * via a fresh Stripe API call; (3) `assertConnectListenerReady` -- the
 * real, deterministic Connect-listener readiness gate
 * (connectListenerReadiness.ts), which triggers one harmless
 * Connect-scoped test event and requires proof it actually traveled the
 * real delivery path within a bounded window.
 *
 * Deliberately takes no `page` parameter -- there is no card-entry action
 * this function could call even by mistake, since it never receives a
 * page reference at all. Never mutates `payments`/`appointments` (every
 * DB call it makes, directly or via the checks above, is a `.select()`).
 * Safe to call on its own during manual QA against a real dev
 * environment, independent of `runPaymentCompletionPhase` -- see
 * `runPaymentHarnessFloorRentalBrowserScenario`'s `"pre_payment_readiness"`
 * execution mode.
 */
export async function runPrePaymentReadinessPhase(params: {
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  firstCheckout: PaymentHarnessCheckoutCapture;
  fetchImpl?: AppWebhookRouteReadinessFetch;
  createStripeClient?: StripeClientFactory;
  connectReadiness?: {
    triggerFn?: ConnectTriggerFn;
    now?: () => Date;
    sleepFn?: (ms: number) => Promise<void>;
    pollMaxAttempts?: number;
    pollIntervalMs?: number;
    createStripeEventClient?: StripeEventClientFactory;
  };
}): Promise<PaymentHarnessPrePaymentReadinessResult> {
  const { adminSupabase, config, firstCheckout, fetchImpl, createStripeClient, connectReadiness } =
    params;
  const context = "runPrePaymentReadinessPhase";

  assertPaymentHarnessEnvironmentAllowed(config.environment, context);

  await assertAppWebhookRouteReady({ config, context, fetchImpl });

  const connectedAccountId = await resolveConfiguredStudioConnectedAccountId(
    adminSupabase,
    config,
    context,
  );
  const paymentId = await resolvePendingFloorRentalPaymentId(adminSupabase, config, context);

  if (!firstCheckout.sessionId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): no Checkout Session id was captured to verify before payment.`,
      "CHECKOUT_SESSION_ID_UNPARSEABLE",
    );
  }

  await verifyCheckoutSessionIsTestMode({
    sessionId: firstCheckout.sessionId,
    connectedAccountId,
    context,
    createStripeClient,
  });

  // Real, deterministic Connect-listener readiness gate -- replaces the
  // prior unconditional CONNECT_LISTENER_READINESS_UNAVAILABLE block.
  // Throws unless a freshly-triggered, freshly-verified event proves the
  // delivery path is alive right now.
  const connectReadinessResult = await assertConnectListenerReady({
    adminSupabase,
    connectedAccountId,
    environment: config.environment,
    context,
    triggerFn: connectReadiness?.triggerFn,
    now: connectReadiness?.now,
    sleepFn: connectReadiness?.sleepFn,
    pollMaxAttempts: connectReadiness?.pollMaxAttempts,
    pollIntervalMs: connectReadiness?.pollIntervalMs,
    createStripeEventClient: connectReadiness?.createStripeEventClient,
  });

  return Object.freeze({
    paymentId,
    connectedAccountId,
    checkoutSessionId: firstCheckout.sessionId,
    connectReadiness: connectReadinessResult,
    checkpoint: checkpoint(
      "phase4a_pre_payment_readiness",
      "passed",
      `paymentId=${paymentId} providerEventId=${connectReadinessResult.providerEventId}`,
    ),
  });
}

/**
 * Phase 4b -- completes the already-captured hosted Checkout Session in
 * Stripe test mode only. The *only* function in this module that ever
 * calls `page.completeTestPayment()`, and it does so exactly once, and
 * only after `runPrePaymentReadinessPhase` resolves without throwing --
 * there is no code path around this ordering.
 */
export async function runPaymentCompletionPhase(params: {
  page: PaymentHarnessBrowserPage;
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  firstCheckout: PaymentHarnessCheckoutCapture;
  fetchImpl?: AppWebhookRouteReadinessFetch;
  createStripeClient?: StripeClientFactory;
  connectReadiness?: {
    triggerFn?: ConnectTriggerFn;
    now?: () => Date;
    sleepFn?: (ms: number) => Promise<void>;
    pollMaxAttempts?: number;
    pollIntervalMs?: number;
    createStripeEventClient?: StripeEventClientFactory;
  };
}): Promise<{
  paymentId: string;
  checkpoint: PaymentHarnessCheckpoint;
  readiness: PaymentHarnessPrePaymentReadinessResult;
}> {
  const { page, adminSupabase, config, firstCheckout, fetchImpl, createStripeClient, connectReadiness } =
    params;
  const context = "runPaymentCompletionPhase";

  const readiness = await runPrePaymentReadinessPhase({
    adminSupabase,
    config,
    firstCheckout,
    fetchImpl,
    createStripeClient,
    connectReadiness,
  });

  await page.completeTestPayment();

  const landedOrigin = assertAllowedNavigationOrigin(page.url(), config, context);
  if (landedOrigin !== "app") {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the post-payment redirect did not land back in the configured ` +
        `application. Refusing to proceed.`,
      "PAYMENT_REDIRECT_FAILED",
    );
  }

  return {
    paymentId: readiness.paymentId,
    checkpoint: checkpoint("phase4_payment_completion", "passed", `paymentId=${readiness.paymentId}`),
    readiness,
  };
}

/**
 * Phase 5 -- bounded, read-only verification that the real webhook
 * actually fulfilled the payment: the payment row transitioned to `paid`
 * with every expected field, every payable appointment is `paid`, no
 * non-payable appointment changed, and no duplicate payment row exists.
 * Never throws for a `not_fulfilled_within_timeout`/`verification_error`
 * outcome -- returns it, so the caller (the orchestrator) can record it as
 * evidence before deciding how to fail. Structural field/duplicate checks
 * only run once the poll itself confirms `"fulfilled"`.
 */
export async function runFulfillmentVerificationPhase(params: {
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  paymentId: string;
  expectedSessionId: string;
  expectedBalanceCents: number;
  payableAppointmentIds: readonly string[];
  appointmentSnapshotBefore: AppointmentSnapshot;
  maxAttempts?: number;
  intervalMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<PaymentHarnessFulfillmentOutcome> {
  const {
    adminSupabase,
    config,
    paymentId,
    expectedSessionId,
    expectedBalanceCents,
    payableAppointmentIds,
    appointmentSnapshotBefore,
    maxAttempts = DEFAULT_FULFILLMENT_POLL_MAX_ATTEMPTS,
    intervalMs = DEFAULT_FULFILLMENT_POLL_INTERVAL_MS,
    sleepFn = defaultSleep,
  } = params;
  const context = "runFulfillmentVerificationPhase";

  assertPaymentHarnessEnvironmentAllowed(config.environment, context);

  const poll = await pollForPaymentRowStatus({
    adminSupabase,
    paymentId,
    maxAttempts,
    intervalMs,
    sleepFn,
  });

  if (poll.result !== "fulfilled") {
    return Object.freeze({
      result: poll.result,
      paymentId,
      paymentIntentId: (poll.row?.stripe_payment_intent_id as string | undefined) ?? null,
      checkpoint: checkpoint("phase5_fulfillment_verification", "failed", `result=${poll.result}`),
    });
  }

  const paidRow = poll.row as Record<string, unknown>;

  if (paidRow.id !== paymentId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the paid payment row is not the same row created before payment.`,
      "FULFILLMENT_PAYMENT_ID_MISMATCH",
    );
  }

  const paidCents = Math.round(Number(paidRow.amount) * 100);
  if (paidCents !== expectedBalanceCents) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): paid amount (${paidCents} cents) does not match the expected ` +
        `fixture balance (${expectedBalanceCents} cents).`,
      "FULFILLMENT_AMOUNT_MISMATCH",
    );
  }

  if (paidRow.stripe_checkout_session_id !== expectedSessionId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the paid row's Checkout Session id does not match the captured session.`,
      "FULFILLMENT_SESSION_MISMATCH",
    );
  }

  const paymentIntentId = (paidRow.stripe_payment_intent_id as string | null) ?? null;
  if (!paymentIntentId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the paid row is missing a PaymentIntent id.`,
      "FULFILLMENT_PAYMENT_INTENT_MISSING",
    );
  }

  const { data: allPaymentRows, error: allPaymentsError } = await adminSupabase
    .from("payments")
    .select("id, status")
    .eq("studio_id", config.studioId)
    .eq("client_id", config.clientId)
    .eq("source", "floor_rental");

  if (allPaymentsError) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to verify no duplicate payment row exists.`,
      "FULFILLMENT_PAYMENT_LOOKUP_FAILED",
    );
  }

  const paidRows = (allPaymentRows ?? []).filter((row) => row.status === "paid");
  if (paidRows.length !== 1) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): expected exactly one paid floor-rental payment row, found ${paidRows.length}.`,
      "FULFILLMENT_DUPLICATE_PAYMENT",
    );
  }

  const { data: appointmentRows, error: appointmentsError } = await adminSupabase
    .from("appointments")
    .select("id, status, payment_status")
    .eq("studio_id", config.studioId)
    .eq("client_id", config.clientId)
    .eq("appointment_type", "floor_space_rental");

  if (appointmentsError) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to verify appointment payment state after fulfillment.`,
      "FULFILLMENT_APPOINTMENTS_LOOKUP_FAILED",
    );
  }

  const payableIdSet = new Set(payableAppointmentIds);
  for (const appt of appointmentRows ?? []) {
    const id = appt.id as string;

    if (payableIdSet.has(id)) {
      if (appt.payment_status !== "paid") {
        throw new PaymentHarnessSafetyError(
          `Fail-closed (${context}): payable appointment ${id} was not marked paid after fulfillment.`,
          "FULFILLMENT_APPOINTMENT_NOT_PAID",
        );
      }
      continue;
    }

    const before = appointmentSnapshotBefore.get(id);
    if (
      before &&
      (before.status !== appt.status || before.paymentStatus !== appt.payment_status)
    ) {
      throw new PaymentHarnessSafetyError(
        `Fail-closed (${context}): non-payable appointment ${id} changed unexpectedly during fulfillment.`,
        "FULFILLMENT_UNRELATED_APPOINTMENT_CHANGED",
      );
    }
  }

  return Object.freeze({
    result: "fulfilled" as const,
    paymentId,
    paymentIntentId,
    checkpoint: checkpoint(
      "phase5_fulfillment_verification",
      "passed",
      `paymentIntentId=${paymentIntentId}`,
    ),
  });
}

// ---------------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs the floor-rental browser scenario end to end. `executionMode`
 * (default `"checkout_reuse_only"`, unchanged for every Slice 4 caller/
 * test) controls how far it goes -- see
 * `PaymentHarnessExecutionMode`'s own doc comment in types.ts for the
 * three explicit, mutually exclusive scopes:
 *
 *   - `"checkout_reuse_only"`: stops after phase 3 (reuse verification).
 *     Never touches Stripe payment completion or the Connect-listener
 *     readiness gate.
 *   - `"pre_payment_readiness"`: additionally runs
 *     `runPrePaymentReadinessPhase` (phase 4a) and stops -- proves the app
 *     route, the Checkout Session, and the real Connect-listener delivery
 *     path are all ready, without ever calling `page.completeTestPayment()`
 *     or entering card data. Safe to run against a real dev environment on
 *     its own.
 *   - `"complete_payment"`: additionally runs `runPaymentCompletionPhase`
 *     (phase 4b, which itself calls `runPrePaymentReadinessPhase` first)
 *     and phase 5 (fulfillment verification).
 *
 * `confirmed` mirrors the Slice 1 `assertConfirmed` guard: this slice has
 * no CLI yet, so the caller (a future Slice 8 CLI) is expected to pass
 * through its own `--confirm` flag here rather than this function
 * inventing a default.
 *
 * `evidence` is optional and purely DI-based -- when provided, this
 * records expected balance, first/second Checkout Session ids, and one
 * checkpoint per phase (plus, once pre-payment readiness has run, the
 * payment id and connected account id; plus, when `"complete_payment"`
 * actually completes, the PaymentIntent id and appointment before/after
 * snapshots) via the real (unmodified) Slice 2 evidence.ts functions,
 * which already work against fakes with no migration applied. When
 * omitted, the scenario runs with no evidence writes at all.
 */
export async function runPaymentHarnessFloorRentalBrowserScenario(params: {
  page: PaymentHarnessBrowserPage;
  adminSupabase: AdminClient;
  config: PaymentHarnessConfig;
  confirmed: boolean;
  executionMode?: PaymentHarnessExecutionMode;
  fetchImpl?: AppWebhookRouteReadinessFetch;
  createStripeClient?: StripeClientFactory;
  connectReadiness?: {
    triggerFn?: ConnectTriggerFn;
    now?: () => Date;
    sleepFn?: (ms: number) => Promise<void>;
    pollMaxAttempts?: number;
    pollIntervalMs?: number;
    createStripeEventClient?: StripeEventClientFactory;
  };
  fulfillmentPoll?: {
    maxAttempts?: number;
    intervalMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  };
  evidence?: {
    runId: string;
    scenario: string;
    deploymentSha: string;
  };
}): Promise<PaymentHarnessBrowserScenarioResult> {
  const {
    page,
    adminSupabase,
    config,
    confirmed,
    executionMode = "checkout_reuse_only",
    fetchImpl,
    createStripeClient,
    connectReadiness,
    fulfillmentPoll,
    evidence,
  } = params;
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
    }

    if (executionMode === "checkout_reuse_only") {
      if (evidence) {
        await markPaymentHarnessRunPassed({ adminSupabase, config, runId: evidence.runId });
      }

      return Object.freeze({
        displayedBalanceCents: phase1.displayedBalanceCents,
        firstCheckout: phase2.checkout,
        secondCheckout: phase3.checkout,
        checkoutReused: true,
        checkpoints: Object.freeze([...checkpoints]),
        fulfillment: null,
        prePaymentReadiness: null,
      });
    }

    if (executionMode === "pre_payment_readiness") {
      const readiness = await runPrePaymentReadinessPhase({
        adminSupabase,
        config,
        firstCheckout: phase2.checkout,
        fetchImpl,
        createStripeClient,
        connectReadiness,
      });
      checkpoints.push(readiness.checkpoint);

      if (evidence) {
        await updatePaymentHarnessRunEvidence({
          adminSupabase,
          config,
          runId: evidence.runId,
          patch: {
            paymentId: readiness.paymentId,
            stripeConnectedAccountId: readiness.connectedAccountId,
            stripeWebhookEventId: readiness.connectReadiness.providerEventId,
          },
          checkpoint: readiness.checkpoint,
        });
        await markPaymentHarnessRunPassed({ adminSupabase, config, runId: evidence.runId });
      }

      return Object.freeze({
        displayedBalanceCents: phase1.displayedBalanceCents,
        firstCheckout: phase2.checkout,
        secondCheckout: phase3.checkout,
        checkoutReused: true,
        checkpoints: Object.freeze([...checkpoints]),
        fulfillment: null,
        prePaymentReadiness: readiness,
      });
    }

    // executionMode === "complete_payment"
    const appointmentSnapshotBefore = await snapshotFloorRentalAppointments(
      adminSupabase,
      config,
      context,
    );

    const phase4 = await runPaymentCompletionPhase({
      page,
      adminSupabase,
      config,
      firstCheckout: phase2.checkout,
      fetchImpl,
      createStripeClient,
      connectReadiness,
    });
    checkpoints.push(phase4.checkpoint);

    if (evidence) {
      await updatePaymentHarnessRunEvidence({
        adminSupabase,
        config,
        runId: evidence.runId,
        patch: {
          paymentId: phase4.paymentId,
          stripeConnectedAccountId: phase4.readiness.connectedAccountId,
          stripeWebhookEventId: phase4.readiness.connectReadiness.providerEventId,
        },
        checkpoint: phase4.checkpoint,
      });
    }

    const outcome = await runFulfillmentVerificationPhase({
      adminSupabase,
      config,
      paymentId: phase4.paymentId,
      expectedSessionId: phase3.checkout.sessionId ?? "",
      expectedBalanceCents: phase1.expectedBalanceCents,
      payableAppointmentIds: phase1.payableAppointmentIds,
      appointmentSnapshotBefore,
      maxAttempts: fulfillmentPoll?.maxAttempts,
      intervalMs: fulfillmentPoll?.intervalMs,
      sleepFn: fulfillmentPoll?.sleepFn,
    });
    checkpoints.push(outcome.checkpoint);

    if (evidence) {
      const appointmentSnapshotAfter =
        outcome.result === "fulfilled"
          ? await snapshotFloorRentalAppointments(adminSupabase, config, context)
          : null;

      await updatePaymentHarnessRunEvidence({
        adminSupabase,
        config,
        runId: evidence.runId,
        patch: {
          stripePaymentIntentId: outcome.paymentIntentId,
          appointmentIdsBefore: snapshotToEvidenceRecord(appointmentSnapshotBefore),
          ...(appointmentSnapshotAfter
            ? { appointmentIdsAfter: snapshotToEvidenceRecord(appointmentSnapshotAfter) }
            : {}),
        },
        checkpoint: outcome.checkpoint,
      });
    }

    if (outcome.result !== "fulfilled") {
      // Per this slice's explicit failure-handling requirements: do not
      // retry payment, do not create another Checkout session, do not
      // mutate the payment row -- report failure and preserve the
      // identifiers already recorded above (paymentId, session ids) for
      // manual investigation.
      throw new PaymentHarnessSafetyError(
        `Fail-closed (${context}): fulfillment verification did not confirm success within the ` +
          `bounded window (result=${outcome.result}, paymentId=${outcome.paymentId}). Do not retry ` +
          `payment or create another Checkout session -- investigate this payment/appointment ` +
          `state manually.`,
        "FULFILLMENT_NOT_CONFIRMED",
      );
    }

    if (evidence) {
      await markPaymentHarnessRunPassed({ adminSupabase, config, runId: evidence.runId });
    }

    return Object.freeze({
      displayedBalanceCents: phase1.displayedBalanceCents,
      firstCheckout: phase2.checkout,
      secondCheckout: phase3.checkout,
      checkoutReused: true,
      checkpoints: Object.freeze([...checkpoints]),
      fulfillment: outcome,
      prePaymentReadiness: phase4.readiness,
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

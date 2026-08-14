import { execFile } from "node:child_process";
import Stripe from "stripe";
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  PaymentHarnessSafetyError,
  assertPaymentHarnessEnvironmentAllowed,
} from "@/lib/payment-harness/guards";
import {
  assertPaymentHarnessStripeTestModeKey,
  assertStripeObjectIsTestMode,
} from "@/lib/payment-harness/stripeTestMode";
import type { PaymentHarnessEnvironment } from "@/lib/payment-harness/types";

/**
 * Deterministic Stripe Connect webhook-listener readiness gate.
 *
 * Replaces the prior Slice 5 unconditional
 * `assertConnectListenerReadinessUnavailable` block. Empirically designed
 * and validated (read-only discovery spike, then a real, single, harmless
 * `product.updated` trigger run once by hand -- not part of automated
 * tests, which only ever exercise this module through injected fakes):
 *
 *   1. trigger exactly one harmless, Connect-scoped test event
 *      (`stripe trigger product.updated --stripe-account <id>`) -- a
 *      short-lived, bounded child process, never a spawned/managed
 *      `stripe listen`;
 *   2. poll the real, unmodified `payment_provider_events` table
 *      (`.select()` only) for a row created at/after the trigger attempt,
 *      matching `provider='stripe'`, `event_type='product.updated'`;
 *   3. require *exactly one* such row -- zero is a timeout, more than one
 *      is ambiguous, and neither is silently resolved by picking a
 *      "best" candidate. A matched row's own `status` then decides the
 *      outcome: `"processed"` proceeds to step 4; `"failed"` (the real
 *      webhook route's own terminal-failure state) fails immediately with
 *      `CONNECT_LISTENER_READINESS_PROBE_FAILED`; any other status --
 *      chiefly `"received"`, which the route writes at insert time,
 *      *before* running the event's business logic and only later updating
 *      to `"processed"`/`"failed"` in a separate write -- is a normal,
 *      expected transient state and keeps polling rather than failing;
 *   4. take that row's own `provider_event_id` and retrieve the *exact*
 *      Stripe Event object through the harness-only test-mode Stripe
 *      client, scoped to the same connected account;
 *   5. verify the retrieved event's id/type/livemode/account all match
 *      expectations, using the real Slice 2 `assertStripeObjectIsTestMode`
 *      for the livemode check.
 *
 * Proves the full Stripe -> operator's `stripe listen --forward-connect-to`
 * -> real webhook route -> real signature verification ->
 * `payment_provider_events` path is alive *right now* -- not a cached
 * assumption from an earlier "Ready!" line, and immune to the previously
 * reproduced failure (CLI process alive, websocket silently disconnected),
 * since a stale/disconnected listener simply never produces a matching
 * row within the bounded window.
 *
 * Never uses the app's own `STRIPE_SECRET_KEY` -- only
 * `PAYMENT_HARNESS_STRIPE_SECRET_KEY`, via the real, unmodified
 * `assertPaymentHarnessStripeTestModeKey()`. Never spawns/manages a
 * `stripe listen` process, never adds a proxy or a new app route, never
 * writes to `payment_provider_events` (or anything else).
 */

type AdminClient = ReturnType<typeof createAdminClient>;

const PROBE_EVENT_TYPE = "product.updated";

// Separate from, and deliberately tighter than, the payment-fulfillment
// poll in browser.ts -- this is a pre-payment precondition check, not the
// wait for a real customer's payment to fulfill. ~12s bound (8 x 1.5s).
const DEFAULT_READINESS_POLL_MAX_ATTEMPTS = 8;
const DEFAULT_READINESS_POLL_INTERVAL_MS = 1500;

// Hard bound on the `stripe trigger` child process itself.
const DEFAULT_TRIGGER_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Injectable CLI trigger execution
// ---------------------------------------------------------------------------

export type ConnectTriggerResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type ConnectTriggerFn = (params: {
  eventType: string;
  connectedAccountId: string;
  apiKey: string;
}) => Promise<ConnectTriggerResult>;

function redactSecret(text: string, secret: string): string {
  if (secret && text.includes(secret)) {
    return text.split(secret).join("[REDACTED]");
  }
  return text;
}

/**
 * Real implementation -- the only place in this module that actually
 * shells out. A single, short-lived, bounded `execFile` call (argument
 * array, never a shell command string) -- never a spawned/managed
 * `stripe listen`. The API key is passed via the `STRIPE_API_KEY`
 * environment variable of the child process, never as a command-line
 * argument (which would be visible in process listings), and is stripped
 * from any captured stdout/stderr before it's ever returned, on the
 * chance it echoes back for any reason.
 */
const defaultConnectTrigger: ConnectTriggerFn = (params) =>
  new Promise((resolve) => {
    execFile(
      "stripe",
      ["trigger", params.eventType, "--stripe-account", params.connectedAccountId],
      {
        timeout: DEFAULT_TRIGGER_TIMEOUT_MS,
        env: { ...process.env, STRIPE_API_KEY: params.apiKey },
      },
      (error, stdout, stderr) => {
        resolve({
          // Any failure (non-zero exit, timeout/kill, spawn error) is
          // reported uniformly as a non-zero exit code -- the caller
          // fails closed on any of them identically.
          exitCode: error ? 1 : 0,
          stdout: redactSecret(stdout?.toString() ?? "", params.apiKey),
          stderr: redactSecret(stderr?.toString() ?? "", params.apiKey),
        });
      },
    );
  });

// ---------------------------------------------------------------------------
// Injectable Stripe Event retrieval
// ---------------------------------------------------------------------------

/** The minimal Stripe client surface this module calls -- lets tests
 * inject a fake without constructing a real `Stripe` instance. */
export type StripeEventRetrievalClient = {
  events: {
    retrieve: (
      id: string,
      params: Record<string, never>,
      options: { stripeAccount: string },
    ) => Promise<{ id?: unknown; type?: unknown; livemode?: unknown; account?: unknown }>;
  };
};

export type StripeEventClientFactory = (apiKey: string) => StripeEventRetrievalClient;

const defaultStripeEventClientFactory: StripeEventClientFactory = (apiKey) =>
  new Stripe(apiKey) as unknown as StripeEventRetrievalClient;

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultNow(): Date {
  return new Date();
}

/**
 * Fails closed (throws `PaymentHarnessSafetyError`) unless a fresh,
 * verifiable, Connect-scoped test event was observed traveling the real
 * delivery path within a bounded window. Never returns a "maybe" --
 * either every check passes, or it throws with a specific, distinguishable
 * code (see the module doc comment's five-step description).
 */
export async function assertConnectListenerReady(params: {
  adminSupabase: AdminClient;
  connectedAccountId: string;
  environment: PaymentHarnessEnvironment;
  context: string;
  triggerFn?: ConnectTriggerFn;
  now?: () => Date;
  sleepFn?: (ms: number) => Promise<void>;
  pollMaxAttempts?: number;
  pollIntervalMs?: number;
  createStripeEventClient?: StripeEventClientFactory;
}): Promise<void> {
  const {
    adminSupabase,
    connectedAccountId,
    environment,
    context,
    triggerFn = defaultConnectTrigger,
    now = defaultNow,
    sleepFn = defaultSleep,
    pollMaxAttempts = DEFAULT_READINESS_POLL_MAX_ATTEMPTS,
    pollIntervalMs = DEFAULT_READINESS_POLL_INTERVAL_MS,
    createStripeEventClient = defaultStripeEventClientFactory,
  } = params;

  assertPaymentHarnessEnvironmentAllowed(environment, context);

  const testModeKey = assertPaymentHarnessStripeTestModeKey();

  // Step 1: trigger exactly one harmless, Connect-scoped test event.
  const triggerStartedAt = now().toISOString();

  let triggerResult: ConnectTriggerResult;
  try {
    triggerResult = await triggerFn({
      eventType: PROBE_EVENT_TYPE,
      connectedAccountId,
      apiKey: testModeKey,
    });
  } catch {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the Connect-listener readiness probe (stripe trigger) failed to ` +
        `run. Refusing to proceed to payment.`,
      "CONNECT_LISTENER_TRIGGER_FAILED",
    );
  }

  if (triggerResult.exitCode !== 0) {
    // Success text alone is never trusted as readiness proof -- this
    // check only rules out the probe *attempt* itself failing; the real
    // proof is the DB row + Stripe retrieval below.
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the Connect-listener readiness probe (stripe trigger) exited ` +
        `non-zero. Refusing to proceed to payment.`,
      "CONNECT_LISTENER_TRIGGER_FAILED",
    );
  }

  // Step 2-3: poll payment_provider_events (read-only) for exactly one
  // matching row. CLI stdout never contains the created event's id (an
  // empirically confirmed limitation of the installed Stripe CLI), so
  // correlation is by event_type + created_at >= triggerStartedAt only.
  //
  // The real webhook route (src/app/api/payments/webhook/route.ts) inserts
  // this row at status="received" *before* running the event's business
  // logic, then updates it to status="processed" (success) or
  // status="failed" (caught exception) afterward -- two separate DB
  // round-trips, not one atomic write. A row observed at "received" is
  // therefore a normal, expected transient state, not a failure: it must
  // keep being polled, exactly like the zero-rows case, rather than being
  // treated as a terminal outcome. Only "processed" (success) and "failed"
  // (the route's own terminal-failure state) end the loop early; any other
  // status -- "received" or an unrecognized value -- keeps polling through
  // to the existing bounded timeout, which is already the fail-closed
  // backstop for a row that never reaches a terminal state.
  let matchedRow: { provider_event_id: unknown; status: unknown } | null = null;
  let failedRow: { provider_event_id: unknown; status: unknown } | null = null;
  let ambiguous = false;

  for (let attempt = 0; attempt < pollMaxAttempts; attempt += 1) {
    const { data, error } = await adminSupabase
      .from("payment_provider_events")
      .select("provider_event_id, status, created_at")
      .eq("provider", "stripe")
      .eq("event_type", PROBE_EVENT_TYPE)
      .gte("created_at", triggerStartedAt);

    if (error) {
      throw new PaymentHarnessSafetyError(
        `Fail-closed (${context}): failed to poll payment_provider_events for the Connect-listener ` +
          `readiness probe.`,
        "CONNECT_LISTENER_READINESS_LOOKUP_FAILED",
      );
    }

    const rows = data ?? [];

    if (rows.length > 1) {
      // Never silently choose the newest row -- an ambiguous window is a
      // failure, not a judgment call for this code to make.
      ambiguous = true;
      break;
    }

    if (rows.length === 1) {
      if (rows[0].status === "processed") {
        matchedRow = rows[0];
        break;
      }

      if (rows[0].status === "failed") {
        failedRow = rows[0];
        break;
      }

      // Matched but not yet terminal (e.g. "received") -- fall through to
      // the sleep/retry below rather than breaking the loop.
    }

    if (attempt < pollMaxAttempts - 1) {
      await sleepFn(pollIntervalMs);
    }
  }

  if (ambiguous) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): more than one payment_provider_events row matched the ` +
        `Connect-listener readiness probe window. Refusing to proceed with an ambiguous match.`,
      "CONNECT_LISTENER_READINESS_AMBIGUOUS",
    );
  }

  if (failedRow) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the matched Connect-listener readiness probe event failed to ` +
        `process (payment_provider_events.status="failed"). Refusing to proceed to payment.`,
      "CONNECT_LISTENER_READINESS_PROBE_FAILED",
    );
  }

  if (!matchedRow) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): no payment_provider_events row confirmed the Connect-listener ` +
        `readiness probe within the bounded window. The webhook delivery path may be down. ` +
        `Refusing to proceed to payment.`,
      "CONNECT_LISTENER_READINESS_TIMEOUT",
    );
  }

  // matchedRow.status === "processed" is a structural invariant here -- the
  // loop above only ever assigns matchedRow on that exact status.
  const providerEventId = matchedRow.provider_event_id;
  if (typeof providerEventId !== "string" || !providerEventId.startsWith("evt_")) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the matched Connect-listener readiness probe row has a missing ` +
        `or malformed provider_event_id.`,
      "CONNECT_LISTENER_READINESS_EVENT_ID_MALFORMED",
    );
  }

  // Step 4: retrieve the exact Stripe Event, scoped to the connected account.
  const stripeClient = createStripeEventClient(testModeKey);

  let event: { id?: unknown; type?: unknown; livemode?: unknown; account?: unknown };
  try {
    event = await stripeClient.events.retrieve(
      providerEventId,
      {},
      { stripeAccount: connectedAccountId },
    );
  } catch {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): failed to retrieve the Stripe event for Connect-listener ` +
        `readiness verification.`,
      "CONNECT_LISTENER_READINESS_EVENT_RETRIEVAL_FAILED",
    );
  }

  // Step 5: verify id/type/livemode/account.
  if (event.id !== providerEventId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the retrieved Stripe event id does not match the ` +
        `payment_provider_events row. Refusing to proceed.`,
      "CONNECT_LISTENER_READINESS_EVENT_ID_MISMATCH",
    );
  }

  if (event.type !== PROBE_EVENT_TYPE) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the retrieved Stripe event type does not match the expected ` +
        `readiness probe event type.`,
      "CONNECT_LISTENER_READINESS_EVENT_TYPE_MISMATCH",
    );
  }

  // Reuses the real Slice 2 test-mode assertion rather than a parallel
  // livemode check -- same STRIPE_LIVEMODE_TRUE/STRIPE_LIVEMODE_UNKNOWN
  // codes as every other livemode verification in this codebase.
  assertStripeObjectIsTestMode(event, context);

  if (event.account !== connectedAccountId) {
    throw new PaymentHarnessSafetyError(
      `Fail-closed (${context}): the retrieved Stripe event's connected account does not match ` +
        `the configured studio's connected account. Refusing to proceed.`,
      "CONNECT_LISTENER_READINESS_EVENT_ACCOUNT_MISMATCH",
    );
  }
}

import { describe, expect, it, vi, beforeEach } from "vitest";
import Stripe from "stripe";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";

/**
 * Regression coverage for the client payment-link ("pay this invoice")
 * checkout-session idempotency fix: resolveClientCheckoutSession reuses a
 * still-open Checkout Session instead of creating a duplicate, mints an
 * attempt-numbered Stripe idempotency key for a genuine replacement
 * (mirroring src/lib/payments/terminal-quick-charge.ts and
 * src/lib/events/event-order-payment.ts), and closes the concurrent-
 * first-request race via a compare-and-swap update on
 * payments.checkout_session_attempt_count rather than letting two
 * simultaneous requests both reach stripe.checkout.sessions.create.
 */

let paymentsTable: FakeTable;

type FakeSession = { id: string; status: string; url: string };

/**
 * Models real Stripe idempotency-key semantics: a create() call reusing a
 * previously-seen key returns the *cached* response from the original
 * call, decoupled from whatever the "live" object has since transitioned
 * to. This is what actually proves an attempt-numbered key -- not just a
 * different call count -- is what prevents a stale/duplicate object from
 * being silently replayed.
 */
function createFakeStripe() {
  let sessionCounter = 0;
  const sessions = new Map<string, FakeSession>();
  const createCalls: { idempotencyKey?: string }[] = [];
  const idempotencyCache = new Map<string, FakeSession>();
  /** Set by a test to make the next retrieve() throw this instead of its
   * normal lookup behavior -- used to model both a genuine "no such
   * checkout.session" response and a transient failure. */
  let nextRetrieveError: Error | null = null;

  const stripe = {
    checkout: {
      sessions: {
        create: vi.fn(async (_params: unknown, requestOptions: { idempotencyKey?: string }) => {
          const key = requestOptions?.idempotencyKey;
          if (key && idempotencyCache.has(key)) {
            createCalls.push({ idempotencyKey: key });
            return idempotencyCache.get(key)!;
          }
          sessionCounter += 1;
          const session: FakeSession = {
            id: `cs_${sessionCounter}`,
            status: "open",
            url: `https://checkout.stripe.com/cs_${sessionCounter}`,
          };
          sessions.set(session.id, session);
          if (key) idempotencyCache.set(key, { ...session });
          createCalls.push({ idempotencyKey: key });
          return session;
        }),
        retrieve: vi.fn(async (id: string) => {
          if (nextRetrieveError) {
            const error = nextRetrieveError;
            nextRetrieveError = null;
            throw error;
          }
          const session = sessions.get(id);
          if (!session) throw new Error(`Unknown session ${id}`);
          return session;
        }),
      },
    },
  };

  return {
    stripe,
    sessions,
    createCalls,
    failNextRetrieveWith(error: Error) {
      nextRetrieveError = error;
    },
  };
}

/** A real Stripe.errors.StripeInvalidRequestError, matching what the SDK
 * actually throws for a "No such checkout.session" / resource_missing
 * response -- the one case that should be treated as "genuinely gone." */
function genuineMissingSessionError() {
  return new Stripe.errors.StripeInvalidRequestError({
    message: "No such checkout.session: 'cs_gone'",
    code: "resource_missing",
    statusCode: 404,
    type: "invalid_request_error",
  });
}

/** A transient failure -- connection error, rate limit, 5xx -- that must
 * NOT be treated as "the session is gone." */
function transientRetrieveError() {
  return new Stripe.errors.StripeConnectionError({
    message: "An error occurred while communicating with Stripe.",
  });
}

let currentFakeStripe: ReturnType<typeof createFakeStripe>;

const { resolveClientCheckoutSession } = await import("@/lib/payments/client-checkout-session");

const PAYMENT_ID = "payment-1";
const CONNECTED_ACCOUNT_ID = "acct_1";

function seedPayment(overrides: Record<string, unknown> = {}) {
  const row = {
    id: PAYMENT_ID,
    status: "pending",
    stripe_checkout_session_id: null,
    checkout_session_attempt_count: 0,
    ...overrides,
  };
  paymentsTable.rows.push(row);
  return row;
}

function baseParams(overrides: Partial<Parameters<typeof resolveClientCheckoutSession>[0]> = {}) {
  return {
    adminSupabase: createFakeAdminClient({ payments: paymentsTable }) as never,
    stripe: currentFakeStripe.stripe as never,
    paymentId: PAYMENT_ID,
    currentAttemptCount: 0,
    existingSessionId: null,
    connectedAccountId: CONNECTED_ACCOUNT_ID,
    createSessionParams: { mode: "payment" as const, line_items: [] },
    ...overrides,
  };
}

beforeEach(() => {
  paymentsTable = new FakeTable();
  currentFakeStripe = createFakeStripe();
});

describe("resolveClientCheckoutSession", () => {
  it("reuses an existing open session instead of creating a new one", async () => {
    seedPayment({ stripe_checkout_session_id: "cs_existing" });
    currentFakeStripe.sessions.set("cs_existing", {
      id: "cs_existing",
      status: "open",
      url: "https://checkout.stripe.com/cs_existing",
    });

    const result = await resolveClientCheckoutSession(
      baseParams({ existingSessionId: "cs_existing" }),
    );

    expect(result).toEqual({ kind: "reuse", url: "https://checkout.stripe.com/cs_existing" });
    expect(currentFakeStripe.createCalls).toHaveLength(0);
  });

  it("treats a completed existing session as already processed, without creating a new one", async () => {
    seedPayment({ stripe_checkout_session_id: "cs_done" });
    currentFakeStripe.sessions.set("cs_done", {
      id: "cs_done",
      status: "complete",
      url: "https://checkout.stripe.com/cs_done",
    });

    const result = await resolveClientCheckoutSession(
      baseParams({ existingSessionId: "cs_done" }),
    );

    expect(result).toEqual({ kind: "already_processed" });
    expect(currentFakeStripe.createCalls).toHaveLength(0);
  });

  it("a genuinely missing existing session (Stripe resource_missing) allows a replacement to be created", async () => {
    seedPayment({ stripe_checkout_session_id: "cs_gone", checkout_session_attempt_count: 1 });
    currentFakeStripe.failNextRetrieveWith(genuineMissingSessionError());

    const result = await resolveClientCheckoutSession(
      baseParams({ existingSessionId: "cs_gone", currentAttemptCount: 1 }),
    );

    expect(result.kind).toBe("created");
    expect(currentFakeStripe.createCalls).toHaveLength(1);
    expect(currentFakeStripe.createCalls[0].idempotencyKey).toBe(
      `client-payment:${PAYMENT_ID}:checkout-session:1`,
    );
  });

  it("a transient failure retrieving the existing session fails closed -- no replacement session is created", async () => {
    seedPayment({ stripe_checkout_session_id: "cs_maybe_fine", checkout_session_attempt_count: 1 });
    currentFakeStripe.failNextRetrieveWith(transientRetrieveError());

    const result = await resolveClientCheckoutSession(
      baseParams({ existingSessionId: "cs_maybe_fine", currentAttemptCount: 1 }),
    );

    expect(result).toEqual({ kind: "error", message: "Checkout could not be started. Please try again." });
    expect(currentFakeStripe.createCalls).toHaveLength(0);

    const row = paymentsTable.rows.find((r) => r.id === PAYMENT_ID);
    expect(row?.checkout_session_attempt_count).toBe(1);
    expect(row?.stripe_checkout_session_id).toBe("cs_maybe_fine");
  });

  it("a transient failure re-checking a concurrent winner's session (lost-claim path) also fails closed", async () => {
    seedPayment();
    const row = paymentsTable.rows.find((r) => r.id === PAYMENT_ID)!;
    row.checkout_session_attempt_count = 1;
    row.stripe_checkout_session_id = "cs_from_winner";
    currentFakeStripe.failNextRetrieveWith(transientRetrieveError());

    const result = await resolveClientCheckoutSession(baseParams({ currentAttemptCount: 0 }));

    expect(result).toEqual({ kind: "error", message: "Checkout could not be started. Please try again." });
    expect(currentFakeStripe.createCalls).toHaveLength(0);
  });

  it("creates a fresh session when the existing one is expired", async () => {
    seedPayment({ stripe_checkout_session_id: "cs_expired", checkout_session_attempt_count: 1 });
    currentFakeStripe.sessions.set("cs_expired", {
      id: "cs_expired",
      status: "expired",
      url: "https://checkout.stripe.com/cs_expired",
    });

    const result = await resolveClientCheckoutSession(
      baseParams({ existingSessionId: "cs_expired", currentAttemptCount: 1 }),
    );

    expect(result.kind).toBe("created");
    expect(currentFakeStripe.createCalls).toHaveLength(1);
    expect(currentFakeStripe.createCalls[0].idempotencyKey).toBe(
      `client-payment:${PAYMENT_ID}:checkout-session:1`,
    );

    const updated = paymentsTable.rows.find((r) => r.id === PAYMENT_ID);
    expect(updated?.checkout_session_attempt_count).toBe(2);
  });

  it("creates a session with an attempt-0 idempotency key on a first-time request with no prior session", async () => {
    seedPayment();

    const result = await resolveClientCheckoutSession(baseParams());

    expect(result.kind).toBe("created");
    expect(currentFakeStripe.createCalls[0].idempotencyKey).toBe(
      `client-payment:${PAYMENT_ID}:checkout-session:0`,
    );
  });

  it("mints a different idempotency key for a replacement attempt than the original creation used", async () => {
    seedPayment();

    const first = await resolveClientCheckoutSession(baseParams());
    expect(first.kind).toBe("created");
    const firstKey = currentFakeStripe.createCalls[0].idempotencyKey;

    // Simulate the first session going stale and a genuine retry.
    const row = paymentsTable.rows.find((r) => r.id === PAYMENT_ID)!;
    const firstSessionId = row.stripe_checkout_session_id as string;
    currentFakeStripe.sessions.get(firstSessionId)!.status = "expired";

    const second = await resolveClientCheckoutSession(
      baseParams({
        existingSessionId: firstSessionId,
        currentAttemptCount: row.checkout_session_attempt_count as number,
      }),
    );

    expect(second.kind).toBe("created");
    const secondKey = currentFakeStripe.createCalls[1].idempotencyKey;
    expect(secondKey).not.toBe(firstKey);
    expect(secondKey).toBe(`client-payment:${PAYMENT_ID}:checkout-session:1`);
    if (second.kind === "created" && first.kind === "created") {
      expect(second.sessionId).not.toBe(first.sessionId);
    }
  });

  it("under Stripe idempotency semantics, reusing the same key would return the same cached session -- proving attempt-numbering is what prevents replaying a stale object", async () => {
    seedPayment();
    const first = await resolveClientCheckoutSession(baseParams());
    const firstKey = currentFakeStripe.createCalls[0].idempotencyKey!;

    // Directly exercise the fake's idempotency cache with the SAME key a
    // flat (non-attempt-numbered) implementation would have reused here.
    const replay = await currentFakeStripe.stripe.checkout.sessions.create(
      { mode: "payment", line_items: [] },
      { idempotencyKey: firstKey },
    );

    expect(first.kind).toBe("created");
    if (first.kind === "created") {
      expect(replay.id).toBe(first.sessionId);
    }
  });

  it("already-processed payment: a complete existing session short-circuits with no Stripe create call", async () => {
    seedPayment({ status: "pending", stripe_checkout_session_id: "cs_paid" });
    currentFakeStripe.sessions.set("cs_paid", { id: "cs_paid", status: "complete", url: "https://x" });

    const result = await resolveClientCheckoutSession(baseParams({ existingSessionId: "cs_paid" }));

    expect(result.kind).toBe("already_processed");
    expect(currentFakeStripe.createCalls).toHaveLength(0);
  });

  it("returns a generic error and does not leak the raw message when Stripe session creation throws", async () => {
    seedPayment();
    currentFakeStripe.stripe.checkout.sessions.create.mockRejectedValueOnce(
      new Error("Stripe internal secret detail XYZ"),
    );

    const result = await resolveClientCheckoutSession(baseParams());

    expect(result).toEqual({ kind: "error", message: "Checkout could not be started. Please try again." });
  });

  it("returns a generic error and does not leak the raw message when persisting the session fails", async () => {
    seedPayment();
    // The standard FakeTable/FakeQuery fixture has no hook for a raw DB
    // error on a specific update call, so this test wraps it with a
    // minimal client: the first update() (the attempt-claim CAS) behaves
    // normally against the real row, but the second update() (persisting
    // the newly-created session id) always fails.
    let updateCallCount = 0;
    const supabase = {
      from(table: string) {
        if (table !== "payments") throw new Error(`Unexpected table ${table}`);
        let isUpdate = false;
        let updatePayload: Record<string, unknown> = {};
        const state: { filters: [string, unknown][] } = { filters: [] };
        const builder = {
          select() {
            return builder;
          },
          update(payload: Record<string, unknown>) {
            isUpdate = true;
            updatePayload = payload;
            return builder;
          },
          eq(col: string, val: unknown) {
            state.filters.push([col, val]);
            return builder;
          },
          async maybeSingle() {
            if (!isUpdate) {
              const row = paymentsTable.rows.find((r) =>
                state.filters.every(([c, v]) => r[c] === v),
              );
              return { data: row ?? null, error: null };
            }

            updateCallCount += 1;
            if (updateCallCount === 2) {
              return { data: null, error: { message: "connection reset" } };
            }

            const row = paymentsTable.rows.find((r) =>
              state.filters.every(([c, v]) => r[c] === v),
            );
            if (!row) return { data: null, error: null };
            Object.assign(row, updatePayload);
            return { data: row, error: null };
          },
        };
        return builder;
      },
    };

    const result = await resolveClientCheckoutSession(
      baseParams({ adminSupabase: supabase as never }),
    );

    expect(result).toEqual({ kind: "error", message: "Checkout could not be started. Please try again." });
    expect(updateCallCount).toBe(2);
  });

  describe("concurrent first requests for the same paymentId (no prior session)", () => {
    it("only one request creates a Stripe session; the loser reuses the winner's session instead of creating a second one", async () => {
      seedPayment();

      // Both "requests" read currentAttemptCount=0 before either commits --
      // exactly what a real concurrent race looks like at the DB layer.
      const winner = await resolveClientCheckoutSession(baseParams({ currentAttemptCount: 0 }));
      const loser = await resolveClientCheckoutSession(baseParams({ currentAttemptCount: 0 }));

      expect(winner.kind).toBe("created");
      expect(loser.kind).toBe("reuse");
      expect(currentFakeStripe.createCalls).toHaveLength(1);
      if (winner.kind === "created" && loser.kind === "reuse") {
        expect(loser.url).toBe(winner.url);
      }
    });

    it("asks the loser to retry when the winner has claimed the attempt but not yet persisted a session id", async () => {
      seedPayment();
      // Simulate the winner having won the CAS claim (attempt_count already
      // incremented) but not yet finished its Stripe call/persist.
      const row = paymentsTable.rows.find((r) => r.id === PAYMENT_ID)!;
      row.checkout_session_attempt_count = 1;

      const loser = await resolveClientCheckoutSession(baseParams({ currentAttemptCount: 0 }));

      expect(loser.kind).toBe("retry_needed");
      expect(currentFakeStripe.createCalls).toHaveLength(0);
    });

    it("treats a payment that stopped being pending during the race as already processed", async () => {
      seedPayment({ status: "paid" });

      const result = await resolveClientCheckoutSession(baseParams({ currentAttemptCount: 0 }));

      expect(result.kind).toBe("already_processed");
      expect(currentFakeStripe.createCalls).toHaveLength(0);
    });
  });

  describe("admin-client write boundary (Fix 2)", () => {
    /** Mimics exactly what a client-portal billing-viewer's own user-scoped
     * session client would experience under RLS on `payments`: reads
     * succeed, but every update() is silently filtered (0 rows, no
     * error) -- there is no UPDATE policy for that relationship, only for
     * studio staff. Used as a negative control to prove the bug this fix
     * closes, then contrasted with the real admin fake below. */
    function createRlsRestrictedClient() {
      return {
        from(table: string) {
          if (table !== "payments") throw new Error(`Unexpected table ${table}`);
          let isUpdate = false;
          const state: { filters: [string, unknown][] } = { filters: [] };
          const builder = {
            select() {
              // Deliberately does NOT reset isUpdate: `.update(...).select(...)`
              // is still an UPDATE with a RETURNING clause in the real
              // Supabase API, not a fresh SELECT.
              return builder;
            },
            update() {
              isUpdate = true;
              return builder;
            },
            eq(col: string, val: unknown) {
              state.filters.push([col, val]);
              return builder;
            },
            async maybeSingle() {
              if (isUpdate) {
                // RLS silently filters every write for this caller -- not
                // an error, just zero rows matched.
                return { data: null, error: null };
              }
              const row = paymentsTable.rows.find((r) =>
                state.filters.every(([c, v]) => r[c] === v),
              );
              return { data: row ?? null, error: null };
            },
          };
          return builder;
        },
      };
    }

    it("regression control: a caller with only RLS-restricted (non-admin) write access gets stuck in a permanent retry_needed loop", async () => {
      seedPayment();
      const restrictedClient = createRlsRestrictedClient();

      const attempt1 = await resolveClientCheckoutSession(
        baseParams({ adminSupabase: restrictedClient as never, currentAttemptCount: 0 }),
      );
      const attempt2 = await resolveClientCheckoutSession(
        baseParams({ adminSupabase: restrictedClient as never, currentAttemptCount: 0 }),
      );

      // This is the exact bug Fix 2 closes -- documented here, not desired
      // behavior. The claim can never succeed for this caller, so every
      // attempt loops back to retry_needed and no Stripe session is ever
      // created for a legitimately-authorized billing-relationship caller.
      expect(attempt1.kind).toBe("retry_needed");
      expect(attempt2.kind).toBe("retry_needed");
      expect(currentFakeStripe.createCalls).toHaveLength(0);
    });

    it("a caller authorized only through the billing relationship succeeds when the route supplies a real admin client, instead of looping forever", async () => {
      seedPayment();

      // Same payment, same authorization scenario as the control above --
      // only the client passed in changes, exactly mirroring the route's
      // fix of constructing createAdminClient() after authorization
      // succeeds regardless of whether the caller is studio staff or a
      // billing-relationship-only portal viewer.
      const result = await resolveClientCheckoutSession(baseParams({ currentAttemptCount: 0 }));

      expect(result.kind).toBe("created");
      expect(currentFakeStripe.createCalls).toHaveLength(1);
    });
  });
});

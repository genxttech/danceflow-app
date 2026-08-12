import { describe, expect, it, vi, beforeEach } from "vitest";
import Stripe from "stripe";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";

/**
 * Regression coverage for the portal floor-rental balance checkout
 * duplicate-charge fix: resolvePortalFloorRentalCheckoutSession reuses (or
 * creates) a single pending `payments` row per (studio, client) instead of
 * calling stripe.checkout.sessions.create unconditionally on every submit,
 * reuses a still-open Checkout Session instead of creating a duplicate,
 * mints an attempt-numbered idempotency key for a genuine replacement, and
 * closes both the first-creation race (two concurrent submits, no row yet)
 * and the ordinary CAS race (a row already exists) without ever letting two
 * requests both reach stripe.checkout.sessions.create.
 */

let paymentsTable: FakeTable;

type FakeSession = { id: string; status: string; url: string };

/**
 * Same idempotency-cache-aware fake as client-checkout-session.test.ts: a
 * create() call reusing a previously-seen key returns the cached response
 * from the original call, so tests can prove attempt-numbering -- not just
 * a different call count -- is what prevents a stale object from being
 * silently replayed.
 */
function createFakeStripe() {
  let sessionCounter = 0;
  const sessions = new Map<string, FakeSession>();
  const createCalls: { idempotencyKey?: string }[] = [];
  const idempotencyCache = new Map<string, FakeSession>();
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

function genuineMissingSessionError() {
  return new Stripe.errors.StripeInvalidRequestError({
    message: "No such checkout.session: 'cs_gone'",
    code: "resource_missing",
    statusCode: 404,
    type: "invalid_request_error",
  });
}

function transientRetrieveError() {
  return new Stripe.errors.StripeConnectionError({
    message: "An error occurred while communicating with Stripe.",
  });
}

let currentFakeStripe: ReturnType<typeof createFakeStripe>;

const { resolvePortalFloorRentalCheckoutSession } = await import(
  "@/lib/payments/portal-floor-rental-checkout-session"
);

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";
const CONNECTED_ACCOUNT_ID = "acct_1";

function seedPendingPayment(overrides: Record<string, unknown> = {}) {
  const row = {
    id: "payment-1",
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    source: "floor_rental",
    payment_type: "floor_fee",
    status: "pending",
    amount: 100,
    stripe_checkout_session_id: null,
    checkout_session_attempt_count: 0,
    ...overrides,
  };
  paymentsTable.rows.push(row);
  return row;
}

function baseParams(
  overrides: Partial<Parameters<typeof resolvePortalFloorRentalCheckoutSession>[0]> = {},
) {
  return {
    adminSupabase: createFakeAdminClient({ payments: paymentsTable }) as never,
    stripe: currentFakeStripe.stripe as never,
    studioId: STUDIO_ID,
    clientId: CLIENT_ID,
    amount: 100,
    connectedAccountId: CONNECTED_ACCOUNT_ID,
    buildCreateSessionParams: (paymentId: string) => ({
      mode: "payment" as const,
      line_items: [],
      metadata: { paymentId },
    }),
    ...overrides,
  };
}

beforeEach(() => {
  paymentsTable = new FakeTable();
  paymentsTable.uniqueColumns = ["studio_id", "client_id"];
  currentFakeStripe = createFakeStripe();
});

describe("resolvePortalFloorRentalCheckoutSession", () => {
  it("creates one pending payment row and one Stripe session on a first-time request", async () => {
    const result = await resolvePortalFloorRentalCheckoutSession(baseParams());

    expect(result.kind).toBe("created");
    expect(paymentsTable.rows).toHaveLength(1);
    expect(paymentsTable.rows[0].status).toBe("pending");
    expect(paymentsTable.rows[0].amount).toBe(100);
    expect(currentFakeStripe.createCalls).toHaveLength(1);
    if (result.kind === "created") {
      expect(currentFakeStripe.createCalls[0].idempotencyKey).toBe(
        `portal-floor-rental:${result.paymentId}:checkout-session:0`,
      );
    }
  });

  it("a same-amount retry reuses the same pending payment row and its still-open session instead of creating a second one", async () => {
    const first = await resolvePortalFloorRentalCheckoutSession(baseParams());
    expect(first.kind).toBe("created");

    const second = await resolvePortalFloorRentalCheckoutSession(baseParams());

    expect(second.kind).toBe("reuse");
    expect(paymentsTable.rows).toHaveLength(1);
    expect(currentFakeStripe.createCalls).toHaveLength(1);
    if (first.kind === "created" && second.kind === "reuse") {
      expect(second.url).toBe(first.url);
    }
  });

  describe("concurrent first insert for the same (studio, client) pair", () => {
    it("one request wins the insert; the loser recovers via 23505 and reuses the winner's row", async () => {
      paymentsTable.raceOnNextInsert = (payload) => {
        paymentsTable.rows.push({
          id: "payment-winner",
          status: "pending",
          checkout_session_attempt_count: 0,
          stripe_checkout_session_id: null,
          created_at: "t0",
          ...payload,
        });
      };

      const result = await resolvePortalFloorRentalCheckoutSession(baseParams());

      expect(result.kind).toBe("created");
      expect(paymentsTable.rows).toHaveLength(1);
      expect(paymentsTable.rows[0].id).toBe("payment-winner");
      expect(currentFakeStripe.createCalls).toHaveLength(1);
    });

    it("asks the caller to retry when the concurrent winner's row was created for a different amount", async () => {
      paymentsTable.raceOnNextInsert = (payload) => {
        paymentsTable.rows.push({
          id: "payment-winner",
          status: "pending",
          checkout_session_attempt_count: 0,
          stripe_checkout_session_id: null,
          created_at: "t0",
          ...payload,
          amount: 250,
        });
      };

      const result = await resolvePortalFloorRentalCheckoutSession(baseParams({ amount: 100 }));

      expect(result).toEqual({ kind: "retry_needed" });
      expect(currentFakeStripe.createCalls).toHaveLength(0);
    });
  });

  describe("amount change since the last pending attempt", () => {
    it("voids the stale pending row and creates a fresh one for the new amount", async () => {
      seedPendingPayment({ amount: 100, stripe_checkout_session_id: "cs_stale" });
      currentFakeStripe.sessions.set("cs_stale", {
        id: "cs_stale",
        status: "open",
        url: "https://checkout.stripe.com/cs_stale",
      });

      const result = await resolvePortalFloorRentalCheckoutSession(baseParams({ amount: 175 }));

      expect(result.kind).toBe("created");
      const stale = paymentsTable.rows.find((r) => r.id === "payment-1");
      expect(stale?.status).toBe("voided");
      const fresh = paymentsTable.rows.find((r) => r.id !== "payment-1");
      expect(fresh?.amount).toBe(175);
      expect(fresh?.status).toBe("pending");
      // The stale row's still-open session was never touched/reused for the
      // new (different) amount.
      expect(currentFakeStripe.createCalls).toHaveLength(1);
    });
  });

  describe("existing session evaluation on a reused row", () => {
    it("reuses an open session", async () => {
      seedPendingPayment({ stripe_checkout_session_id: "cs_existing" });
      currentFakeStripe.sessions.set("cs_existing", {
        id: "cs_existing",
        status: "open",
        url: "https://checkout.stripe.com/cs_existing",
      });

      const result = await resolvePortalFloorRentalCheckoutSession(baseParams());

      expect(result).toEqual({ kind: "reuse", url: "https://checkout.stripe.com/cs_existing" });
      expect(currentFakeStripe.createCalls).toHaveLength(0);
    });

    it("treats a completed session as already processed", async () => {
      seedPendingPayment({ stripe_checkout_session_id: "cs_done" });
      currentFakeStripe.sessions.set("cs_done", { id: "cs_done", status: "complete", url: "https://x" });

      const result = await resolvePortalFloorRentalCheckoutSession(baseParams());

      expect(result).toEqual({ kind: "already_processed" });
      expect(currentFakeStripe.createCalls).toHaveLength(0);
    });

    it("a genuinely missing existing session allows a fresh attempt", async () => {
      seedPendingPayment({ stripe_checkout_session_id: "cs_gone", checkout_session_attempt_count: 1 });
      currentFakeStripe.failNextRetrieveWith(genuineMissingSessionError());

      const result = await resolvePortalFloorRentalCheckoutSession(baseParams());

      expect(result.kind).toBe("created");
      expect(currentFakeStripe.createCalls).toHaveLength(1);
      expect(currentFakeStripe.createCalls[0].idempotencyKey).toBe(
        "portal-floor-rental:payment-1:checkout-session:1",
      );
    });

    it("a transient retrieval failure fails closed -- zero Stripe create calls", async () => {
      seedPendingPayment({ stripe_checkout_session_id: "cs_maybe_fine", checkout_session_attempt_count: 1 });
      currentFakeStripe.failNextRetrieveWith(transientRetrieveError());

      const result = await resolvePortalFloorRentalCheckoutSession(baseParams());

      expect(result).toEqual({ kind: "error", message: "Checkout could not be started. Please try again." });
      expect(currentFakeStripe.createCalls).toHaveLength(0);
    });
  });

  describe("concurrent void between the initial snapshot and the fresh reuse re-check", () => {
    it("does not hand back the now-stale session, and does not create a second, redundant one", async () => {
      seedPendingPayment({ stripe_checkout_session_id: "cs_existing" });
      currentFakeStripe.sessions.set("cs_existing", {
        id: "cs_existing",
        status: "open",
        url: "https://checkout.stripe.com/cs_existing",
      });

      // Wraps the real fake admin client so the fresh reuse re-check's own
      // select() call (the one this fix adds, scoped to
      // "stripe_checkout_session_id") is the trigger point for a simulated
      // concurrent voider -- landing exactly in the window between
      // resolvePendingPaymentRow's earlier snapshot (which still saw
      // status='pending' and this session id) and the point where that
      // snapshot would otherwise have been trusted.
      const real = createFakeAdminClient({ payments: paymentsTable });
      let refetchCalls = 0;
      const wrappedAdmin = {
        from(table: string) {
          const realTable = real.from(table);
          return {
            ...realTable,
            select: (cols: string, opts?: { count?: string }) => {
              if (cols === "stripe_checkout_session_id") {
                refetchCalls += 1;
                const row = paymentsTable.rows.find((r) => r.id === "payment-1")!;
                row.status = "voided";
              }
              return realTable.select(cols, opts);
            },
          };
        },
      };

      const result = await resolvePortalFloorRentalCheckoutSession(
        baseParams({ adminSupabase: wrappedAdmin as never }),
      );

      expect(refetchCalls).toBe(1);
      // Never reuses the stale (now-voided) row's still-technically-open
      // Stripe session -- that would silently drop a real charge once the
      // webhook later sees status !== 'pending' on this row.
      expect(result).toEqual({ kind: "retry_needed" });
      // Nor does it paper over the situation by minting a second, redundant
      // live session -- the CAS claim below correctly loses (the row is no
      // longer 'pending') and asks the caller to retry instead.
      expect(currentFakeStripe.createCalls).toHaveLength(0);
    });

    it("fails closed (does not fall through to create a session) when the fresh re-check itself errors", async () => {
      seedPendingPayment({ stripe_checkout_session_id: "cs_existing" });
      currentFakeStripe.sessions.set("cs_existing", {
        id: "cs_existing",
        status: "open",
        url: "https://checkout.stripe.com/cs_existing",
      });

      const real = createFakeAdminClient({ payments: paymentsTable });
      const wrappedAdmin = {
        from(table: string) {
          const realTable = real.from(table);
          return {
            ...realTable,
            select: (cols: string, opts?: { count?: string }) => {
              if (cols === "stripe_checkout_session_id") {
                return {
                  eq: () => ({
                    eq: () => ({
                      eq: () => ({
                        eq: () => ({
                          eq: () => ({
                            maybeSingle: async () => ({
                              data: null,
                              error: { message: "connection reset" },
                            }),
                          }),
                        }),
                      }),
                    }),
                  }),
                };
              }
              return realTable.select(cols, opts);
            },
          };
        },
      };

      const result = await resolvePortalFloorRentalCheckoutSession(
        baseParams({ adminSupabase: wrappedAdmin as never }),
      );

      expect(result).toEqual({ kind: "error", message: "Checkout could not be started. Please try again." });
      expect(currentFakeStripe.createCalls).toHaveLength(0);
    });
  });

  describe("CAS race on an existing pending row", () => {
    it("only one request creates a Stripe session; the loser reuses the winner's session", async () => {
      seedPendingPayment();

      const winner = await resolvePortalFloorRentalCheckoutSession(baseParams());
      const loser = await resolvePortalFloorRentalCheckoutSession(baseParams());

      expect(winner.kind).toBe("created");
      expect(loser.kind).toBe("reuse");
      expect(currentFakeStripe.createCalls).toHaveLength(1);
    });

    it("a loser gets a bounded retry_needed -- never a second Stripe create -- when a concurrent caller wins the CAS first", async () => {
      seedPendingPayment();

      // Wraps the real fake admin client so the attempt-count CAS update's
      // own call is the trigger point for a simulated concurrent winner --
      // mutating the row's live attempt_count right before this request's
      // `.eq("checkout_session_attempt_count", 0)` filter is evaluated,
      // exactly modeling a winner's commit landing in the window between
      // this request's read and its own CAS.
      let claimAttempts = 0;
      const real = createFakeAdminClient({ payments: paymentsTable });
      const wrappedAdmin = {
        from(table: string) {
          const realTable = real.from(table);
          return {
            ...realTable,
            update: (payload: Record<string, unknown>) => {
              if ("checkout_session_attempt_count" in payload) {
                claimAttempts += 1;
                if (claimAttempts === 1) {
                  const row = paymentsTable.rows.find((r) => r.id === "payment-1")!;
                  row.checkout_session_attempt_count = 1;
                }
              }
              return realTable.update(payload);
            },
          };
        },
      };

      const result = await resolvePortalFloorRentalCheckoutSession(
        baseParams({ adminSupabase: wrappedAdmin as never }),
      );

      expect(result).toEqual({ kind: "retry_needed" });
      expect(currentFakeStripe.createCalls).toHaveLength(0);
    });
  });

  it("mints a different idempotency key for a genuine replacement attempt than the original", async () => {
    seedPendingPayment();

    const first = await resolvePortalFloorRentalCheckoutSession(baseParams());
    expect(first.kind).toBe("created");
    const firstKey = currentFakeStripe.createCalls[0].idempotencyKey;

    const row = paymentsTable.rows.find((r) => r.id === "payment-1")!;
    const firstSessionId = row.stripe_checkout_session_id as string;
    currentFakeStripe.sessions.get(firstSessionId)!.status = "expired";

    const second = await resolvePortalFloorRentalCheckoutSession(baseParams());

    expect(second.kind).toBe("created");
    const secondKey = currentFakeStripe.createCalls[1].idempotencyKey;
    expect(secondKey).not.toBe(firstKey);
    expect(secondKey).toBe("portal-floor-rental:payment-1:checkout-session:1");
  });

  it("under Stripe idempotency semantics, replaying the same key returns the same cached session -- proving attempt-numbering is what prevents replaying a stale object", async () => {
    seedPendingPayment();
    const first = await resolvePortalFloorRentalCheckoutSession(baseParams());
    const firstKey = currentFakeStripe.createCalls[0].idempotencyKey!;

    const replay = await currentFakeStripe.stripe.checkout.sessions.create(
      { mode: "payment", line_items: [] },
      { idempotencyKey: firstKey },
    );

    expect(first.kind).toBe("created");
    if (first.kind === "created") {
      expect(replay.id).toBe(first.sessionId);
    }
  });

  it("returns a generic error and does not leak the raw message when Stripe session creation throws", async () => {
    seedPendingPayment();
    currentFakeStripe.stripe.checkout.sessions.create.mockRejectedValueOnce(
      new Error("Stripe internal secret detail XYZ"),
    );

    const result = await resolvePortalFloorRentalCheckoutSession(baseParams());

    expect(result).toEqual({ kind: "error", message: "Checkout could not be started. Please try again." });
  });
});

/*
  GC-3.5-3 test double for the Stripe surface the public class purchase flow
  uses. Sessions and refunds live on a specific connected account: a retrieve,
  expire or refund with any other `stripeAccount` fails like Stripe's
  "No such ..." error. Idempotency keys return the SAME object for the same key
  (and refuse a reused key with different parameters), like Stripe.
*/

type Opts = { stripeAccount?: string; idempotencyKey?: string } | undefined;

export type FakeSession = {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number;
  currency: string;
  expires_at: number;
  payment_intent: string | null;
  metadata: Record<string, string>;
  account: string;
  params: Record<string, unknown>;
};

export function createFakeStripe() {
  const sessions = new Map<string, FakeSession>();
  const sessionByKey = new Map<string, { session: FakeSession; fingerprint: string }>();
  const refundByKey = new Map<string, { id: string; status: string; payment_intent: string; account: string }>();
  const calls = {
    create: [] as Array<{ params: Record<string, unknown>; opts: Opts }>,
    retrieve: [] as Array<{ id: string; opts: Opts }>,
    expire: [] as Array<{ id: string; opts: Opts }>,
    refunds: [] as Array<{ params: Record<string, unknown>; opts: Opts }>,
  };
  const failures = { create: false, refund: false, expire: false, retrieve: false };
  let seq = 0;

  const noSuch = (what: string) => Object.assign(new Error(`No such ${what}`), { type: "StripeInvalidRequestError", statusCode: 404 });

  const stripe = {
    checkout: {
      sessions: {
        async create(params: Record<string, unknown>, opts: Opts) {
          calls.create.push({ params, opts });
          if (failures.create) throw new Error("stripe create failed");
          if (!opts?.stripeAccount) throw new Error("platform session not allowed in this test");
          const fingerprint = JSON.stringify({ params, account: opts.stripeAccount });
          if (opts.idempotencyKey) {
            const prior = sessionByKey.get(opts.idempotencyKey);
            if (prior) {
              if (prior.fingerprint !== fingerprint) {
                throw Object.assign(new Error("Keys for idempotent requests can only be used with the same parameters"), { type: "StripeIdempotencyError" });
              }
              return prior.session;
            }
          }
          seq += 1;
          const lineItems = params.line_items as Array<{ price_data: { unit_amount: number; currency: string } }>;
          const session: FakeSession = {
            id: `cs_test_fake${seq}`,
            url: `https://checkout.stripe.com/c/pay/cs_test_fake${seq}`,
            status: "open",
            payment_status: "unpaid",
            amount_total: lineItems[0].price_data.unit_amount,
            currency: lineItems[0].price_data.currency,
            expires_at: params.expires_at as number,
            payment_intent: null,
            metadata: (params.metadata ?? {}) as Record<string, string>,
            account: opts.stripeAccount,
            params,
          };
          sessions.set(session.id, session);
          if (opts.idempotencyKey) sessionByKey.set(opts.idempotencyKey, { session, fingerprint });
          return session;
        },
        async retrieve(id: string, _params: unknown, opts: Opts) {
          calls.retrieve.push({ id, opts });
          if (failures.retrieve) throw new Error("stripe retrieve failed");
          const session = sessions.get(id);
          if (!session || session.account !== opts?.stripeAccount) throw noSuch("checkout.session");
          return session;
        },
        async expire(id: string, _params: unknown, opts: Opts) {
          calls.expire.push({ id, opts });
          if (failures.expire) throw new Error("stripe expire failed");
          const session = sessions.get(id);
          if (!session || session.account !== opts?.stripeAccount) throw noSuch("checkout.session");
          if (session.status !== "open") throw Object.assign(new Error("Only open sessions can be expired"), { type: "StripeInvalidRequestError" });
          session.status = "expired";
          return session;
        },
      },
    },
    refunds: {
      async create(params: Record<string, unknown>, opts: Opts) {
        calls.refunds.push({ params, opts });
        if (failures.refund) throw new Error("stripe refund failed");
        if (opts?.idempotencyKey && refundByKey.has(opts.idempotencyKey)) return refundByKey.get(opts.idempotencyKey)!;
        seq += 1;
        const refund = { id: `re_test_fake${seq}`, status: "succeeded", payment_intent: String(params.payment_intent), account: String(opts?.stripeAccount) };
        if (opts?.idempotencyKey) refundByKey.set(opts.idempotencyKey, refund);
        return refund;
      },
    },
  };

  /** Simulate the purchaser paying an open session. */
  function pay(sessionId: string, paymentIntent = `pi_test_for_${sessionId}`) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("no session");
    session.status = "complete";
    session.payment_status = "paid";
    session.payment_intent = paymentIntent;
    return session;
  }

  return { stripe, sessions, calls, failures, pay };
}

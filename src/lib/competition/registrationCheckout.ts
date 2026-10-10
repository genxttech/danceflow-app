import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { getStripe } from "@/lib/payments/stripe";
import { resolveStudioPaymentAccount } from "@/lib/payments/groupClassPurchase";
import { calculateApplicationFeeAmount, getOrganizerPlatformFeePercent } from "@/lib/events/platformFee";
import { COMPETITION_REGISTRATION_SOURCE, isUuid, releaseCompetitionRegistration } from "@/lib/competition/registrationLifecycle";

export { COMPETITION_REGISTRATION_SOURCE, isUuid, releaseCompetitionRegistration };

/*
  Phase 10C: server side of transactional competition registration (REGISTER -> PAY).

  Authority stays in the database (20261109090000_phase10c_competitor_registration.sql):
    start_competition_registration           -- validates everything, prices, creates the whole
                                               pending graph in ONE transaction; idempotent per
                                               (event, client_request_id)
    prepare_competition_registration_payment -- payable? signing complete? payment window
    attach_competition_registration_checkout -- binds the Checkout Session to order/studio account
    finalize_competition_registration        -- verified webhook (or free order) only
    release_competition_registration         -- expired / failed / abandoned / attach failure
  All five are service-role only; this module never chooses a price, never writes registration
  rows and never activates entries.

  Checkout: a DIRECT charge on the event studio's connected account, mode=payment, card only (no
  delayed methods, so success/expiry are decided inside the session), amount = the order's
  database price snapshot, deterministic Stripe idempotency key per (order, payment window).
*/

type StripeClient = ReturnType<typeof getStripe>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/;
const CHECKOUT_MIN_LIFETIME_MS = 30 * 60 * 1000; // Stripe: expires_at >= 30 minutes after creation
const CHECKOUT_SAFETY_MS = 30 * 1000;

export type CompetitionErrorCode =
  | "closed"
  | "invalid"
  | "sign_in_required"
  | "identity_unverified"
  | "forbidden"
  | "idempotency_conflict"
  | "duplicate_person"
  | "signing_incomplete"
  | "expired"
  | "not_payable"
  | "payment_not_ready"
  | "checkout_failed";

export class CompetitionRegistrationError extends Error {
  constructor(public code: CompetitionErrorCode, message: string, public status: number, public details: string[] = []) {
    super(message);
  }
}

/** Maps a database COMP10C_* refusal to an HTTP-safe error. Unknown errors never leak SQL text. */
export function classifyCompetitionRegistrationError(message: string | null | undefined, details?: string | null): CompetitionRegistrationError {
  const text = message ?? "";
  const code = /COMP10C_([A-Z_]+)/.exec(text)?.[1] ?? "";
  const human = text.replace(/^.*?COMP10C_[A-Z_]+:\s*/, "").trim();
  let detailList: string[] = [];
  try {
    const parsed = details ? JSON.parse(details) : null;
    if (Array.isArray(parsed)) detailList = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    detailList = [];
  }
  switch (code) {
    case "CLOSED": return new CompetitionRegistrationError("closed", "Competition registration is not currently open.", 409);
    case "INVALID": return new CompetitionRegistrationError("invalid", human || "Registration is incomplete.", 400, detailList);
    case "SIGN_IN_REQUIRED": return new CompetitionRegistrationError("sign_in_required", human || "Sign in before registering.", 401);
    case "IDENTITY_UNVERIFIED": return new CompetitionRegistrationError("identity_unverified", human || "Verify your email before linking this registration to your account.", 403);
    case "FORBIDDEN":
    case "ANCHOR_CROSS_STUDIO":
    case "ANCHOR_CONFLICT":
      return new CompetitionRegistrationError("forbidden", "One of the roster people cannot be linked to this registration.", 403);
    case "IDEMPOTENCY_CONFLICT": return new CompetitionRegistrationError("idempotency_conflict", "This registration was already submitted with different details. Start a new registration.", 409);
    case "DUPLICATE_PERSON": return new CompetitionRegistrationError("duplicate_person", "The same person appears twice in the roster.", 400);
    case "SIGNING_INCOMPLETE": return new CompetitionRegistrationError("signing_incomplete", "Required event documents must be signed before payment.", 409);
    case "EXPIRED": return new CompetitionRegistrationError("expired", "This registration hold has expired. Start again to register.", 409);
    case "ORDER_NOT_PAYABLE":
    case "ORDER_NOT_FOUND":
      return new CompetitionRegistrationError("not_payable", "This registration is no longer awaiting payment.", 409);
    default:
      return new CompetitionRegistrationError("checkout_failed", "Competition checkout could not be started.", 500);
  }
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------

export type StartResult = {
  cart_id: string;
  cart_token: string;
  order_id: string;
  registration_id: string;
  order_status: string;
  payment_status: string;
  total_cents: number;
  currency: string;
  requires_signing: boolean;
  expires_at: string | null;
  checkout_session_id: string | null;
  stripe_account_id: string | null;
  entry_count: number;
  replay: boolean;
};

export async function startCompetitionRegistration(admin: Db, params: {
  eventId: string;
  clientRequestId: string;
  draft: unknown;
  actorUserId: string | null;
}): Promise<StartResult> {
  const { data, error } = await admin.rpc("start_competition_registration", {
    p_event_id: params.eventId,
    p_client_request_id: params.clientRequestId,
    p_draft: params.draft,
    p_actor_user_id: params.actorUserId,
  });
  if (error) throw classifyCompetitionRegistrationError(error.message, (error as { details?: string }).details);
  const result = (Array.isArray(data) ? data[0] : data) as StartResult | null;
  if (!result?.order_id || !result.cart_token) throw new CompetitionRegistrationError("checkout_failed", "Competition checkout could not be started.", 500);
  return result;
}

export async function quoteCompetitionRegistration(admin: Db, params: { eventId: string; draft: unknown }) {
  const { data, error } = await admin.rpc("quote_competition_registration", { p_event_id: params.eventId, p_draft: params.draft });
  if (error) throw classifyCompetitionRegistrationError(error.message);
  return data as { valid: boolean; errors: string[]; total_cents: number; currency: string };
}

// ---------------------------------------------------------------------------
// PAY: prepare -> Checkout Session (deterministic key) -> attach
// ---------------------------------------------------------------------------

type PrepareResult = {
  order_id: string;
  state: "payable" | "free" | "finalized";
  event_id: string;
  studio_id: string;
  organizer_id: string | null;
  buyer_email: string;
  amount_cents: number;
  currency: string;
  expires_at: string;
  checkout_session_id: string | null;
  stripe_account_id: string | null;
  entry_count: number;
};

export function competitionCheckoutIdempotencyKey(orderId: string, expiresAtSeconds: number) {
  return `comp10c:${orderId}:checkout-session:${expiresAtSeconds}`;
}

/** Session expiry inside the order hold: hold end - 60s, never under Stripe's 30-minute minimum. */
export function competitionCheckoutExpiry(holdExpiresAt: string, now = Date.now()): number | null {
  const holdMs = Date.parse(holdExpiresAt);
  if (!Number.isFinite(holdMs)) return null;
  const expiresMs = holdMs - 60_000;
  if (expiresMs < now + CHECKOUT_MIN_LIFETIME_MS + CHECKOUT_SAFETY_MS) return null;
  return Math.floor(expiresMs / 1000);
}

export type PaymentStep =
  | { kind: "redirect"; url: string }
  | { kind: "status"; url: string };

export type CompetitionUrls = {
  statusUrl: string;
  cancelUrl: string;
};

async function expireCheckoutQuietly(stripe: StripeClient, sessionId: string, accountId: string) {
  try {
    await stripe.checkout.sessions.expire(sessionId, {}, { stripeAccount: accountId });
  } catch {
    console.warn("comp10c_checkout_expire_failed");
  }
}

async function prepare(admin: Db, orderId: string): Promise<PrepareResult> {
  const { data, error } = await admin.rpc("prepare_competition_registration_payment", { p_order_id: orderId });
  if (error) throw classifyCompetitionRegistrationError(error.message);
  return data as PrepareResult;
}

export async function beginCompetitionPayment(params: {
  admin: Db;
  stripe: StripeClient;
  orderId: string;
  eventName: string;
  urls: CompetitionUrls;
  now?: number;
}, restarts = 0): Promise<PaymentStep> {
  const { admin, stripe, orderId, urls } = params;
  let prepared: PrepareResult;
  try {
    prepared = await prepare(admin, orderId);
  } catch (error) {
    if (error instanceof CompetitionRegistrationError && error.code === "expired") {
      await releaseCompetitionRegistration(admin, { orderId, reason: "expired" });
    }
    throw error;
  }
  if (prepared.state === "finalized") return { kind: "status", url: urls.statusUrl };
  if (prepared.state === "free") {
    // Free order: finalize_competition_registration re-checks total = 0 and completed signing.
    const { error } = await admin.rpc("finalize_competition_registration", {
      p_order_id: orderId, p_stripe_account_id: null, p_checkout_session_id: null,
      p_payment_intent_id: null, p_amount_cents: null, p_currency: null,
    });
    if (error) throw classifyCompetitionRegistrationError(error.message);
    return { kind: "status", url: urls.statusUrl };
  }

  // Resume: the order already has its ONE bound Checkout Session.
  if (prepared.checkout_session_id) {
    const accountId = prepared.stripe_account_id ?? "";
    if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new CompetitionRegistrationError("checkout_failed", "Competition checkout could not be resumed.", 500);
    const existing = await stripe.checkout.sessions.retrieve(prepared.checkout_session_id, {}, { stripeAccount: accountId });
    if (existing.status === "open" && existing.url) return { kind: "redirect", url: existing.url };
    if (existing.status === "complete") return { kind: "status", url: urls.statusUrl };
    await releaseCompetitionRegistration(admin, { orderId, reason: "expired", checkoutSessionId: prepared.checkout_session_id, stripeAccountId: accountId });
    throw new CompetitionRegistrationError("expired", "This registration hold has expired. Start again to register.", 409);
  }

  const account = await resolveStudioPaymentAccount(admin, prepared.studio_id);
  if (!account.ready) throw new CompetitionRegistrationError("payment_not_ready", "Online payments are not enabled for this event.", 409);
  const feePercent = prepared.organizer_id ? await getOrganizerPlatformFeePercent(admin, prepared.studio_id) : 0;
  if (prepared.organizer_id && feePercent <= 0) {
    throw new CompetitionRegistrationError("payment_not_ready", "DanceFlow organizer checkout is not enabled for this listing.", 409);
  }
  const amountCents = Number(prepared.amount_cents);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new CompetitionRegistrationError("checkout_failed", "Competition checkout could not be started.", 500);
  const expiresAtSeconds = competitionCheckoutExpiry(prepared.expires_at, params.now);
  if (expiresAtSeconds === null) throw new CompetitionRegistrationError("expired", "This registration hold has expired. Start again to register.", 409);
  const applicationFee = calculateApplicationFeeAmount(amountCents / 100, feePercent);
  const metadata = {
    source: COMPETITION_REGISTRATION_SOURCE,
    order_id: orderId,
    event_id: prepared.event_id,
    studio_id: prepared.studio_id,
    connected_account_id: account.accountId,
    charge_model: "direct",
  };

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: prepared.buyer_email,
        client_reference_id: orderId,
        expires_at: expiresAtSeconds,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: (prepared.currency || "USD").toLowerCase(),
            unit_amount: amountCents,
            product_data: { name: `${params.eventName} — Competition registration (${prepared.entry_count} ${prepared.entry_count === 1 ? "entry" : "entries"})` },
          },
        }],
        success_url: urls.statusUrl,
        cancel_url: urls.cancelUrl,
        metadata,
        payment_intent_data: { ...(applicationFee > 0 ? { application_fee_amount: applicationFee } : {}), metadata },
      },
      { stripeAccount: account.accountId, idempotencyKey: competitionCheckoutIdempotencyKey(orderId, expiresAtSeconds) },
    );
  } catch {
    console.error("comp10c_checkout_create_failed");
    throw new CompetitionRegistrationError("checkout_failed", "Competition checkout could not be started.", 502);
  }
  if (!session.id || !session.url) {
    if (session.id) await expireCheckoutQuietly(stripe, session.id, account.accountId);
    throw new CompetitionRegistrationError("checkout_failed", "Competition checkout could not be started.", 502);
  }

  // Bind BEFORE the buyer ever sees the session.
  const { error: attachError } = await admin.rpc("attach_competition_registration_checkout", {
    p_order_id: orderId,
    p_stripe_account_id: account.accountId,
    p_checkout_session_id: session.id,
    p_checkout_expires_at: new Date((session.expires_at ?? expiresAtSeconds) * 1000).toISOString(),
  });
  if (attachError) {
    const classified = classifyCompetitionRegistrationError(attachError.message);
    if (/COMP10C_BINDING_CONFLICT/.test(attachError.message) && restarts === 0) {
      // A concurrent request bound its own session first; never leave ours payable.
      await expireCheckoutQuietly(stripe, session.id, account.accountId);
      return beginCompetitionPayment(params, restarts + 1);
    }
    await expireCheckoutQuietly(stripe, session.id, account.accountId);
    if (classified.code === "expired") await releaseCompetitionRegistration(admin, { orderId, reason: "expired" });
    throw classified;
  }
  return { kind: "redirect", url: session.url };
}

// ---------------------------------------------------------------------------
// RELEASE / FINALIZE wrappers
// ---------------------------------------------------------------------------

/** Buyer abandons from Stripe's cancel link: expire the open session first, then release. */
export async function abandonCompetitionRegistration(params: { admin: Db; stripe: StripeClient; orderId: string }): Promise<"released" | "finalizing" | "noop"> {
  const { data: order } = await params.admin
    .from("event_orders")
    .select("id, status, payment_status, stripe_checkout_session_id, metadata")
    .eq("id", params.orderId)
    .maybeSingle();
  if (!order || order.status !== "pending" || order.payment_status !== "pending") return "noop";
  const accountId = String((order.metadata as Record<string, unknown> | null)?.stripe_account_id ?? "");
  if (order.stripe_checkout_session_id && ACCOUNT_ID_PATTERN.test(accountId)) {
    const session = await params.stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id, {}, { stripeAccount: accountId });
    // Paid already: the webhook finalizes; releasing would only force a refund.
    if (session.status === "complete") return "finalizing";
    if (session.status === "open") await params.stripe.checkout.sessions.expire(order.stripe_checkout_session_id, {}, { stripeAccount: accountId });
  }
  const result = await releaseCompetitionRegistration(params.admin, { orderId: params.orderId, reason: "abandoned" });
  return result.outcome === "already_paid" ? "finalizing" : "released";
}

// ---------------------------------------------------------------------------
// Server-side status (never trusts a success query parameter)
// ---------------------------------------------------------------------------

export type CompetitionRegistrationDisplayState =
  | "confirmed"
  | "processing"
  | "awaiting_payment"
  | "awaiting_signature"
  | "expired"
  | "cancelled"
  | "payment_failed"
  | "needs_review";

export type CompetitionRegistrationStatusView = {
  state: CompetitionRegistrationDisplayState;
  eventSlug: string;
  eventName: string;
  totalCents: number;
  currency: string;
  entries: Array<{ label: string; status: string }>;
};

export function deriveCompetitionDisplayState(input: {
  orderStatus: string;
  paymentStatus: string;
  needsReview: boolean;
  requiresSigning: boolean;
  signingComplete: boolean;
  checkoutComplete: boolean;
  expired: boolean;
}): CompetitionRegistrationDisplayState {
  if (input.needsReview) return "needs_review";
  if (input.orderStatus === "confirmed" && input.paymentStatus === "paid") return "confirmed";
  if (input.paymentStatus === "failed") return "payment_failed";
  if (input.orderStatus === "expired") return "expired";
  if (input.orderStatus === "cancelled") return "cancelled";
  if (input.orderStatus === "pending" && input.checkoutComplete) return "processing";
  if (input.orderStatus === "pending" && input.expired) return "expired";
  if (input.orderStatus === "pending" && input.requiresSigning && !input.signingComplete) return "awaiting_signature";
  return "awaiting_payment";
}

export async function loadCompetitionRegistrationStatus(params: {
  admin: Db;
  stripe: StripeClient | null;
  token: string;
  eventSlug: string;
}): Promise<CompetitionRegistrationStatusView | null> {
  if (!isUuid(params.token)) return null;
  const { data: cart } = await params.admin
    .from("event_competition_registration_carts")
    .select("id, event_id, order_id, events:event_id(slug, name)")
    .eq("public_token", params.token)
    .maybeSingle();
  const event = Array.isArray(cart?.events) ? cart?.events[0] : cart?.events;
  if (!cart?.order_id || !event || event.slug !== params.eventSlug) return null;

  const [{ data: order }, { data: entries }, { data: checkpoint }] = await Promise.all([
    params.admin.from("event_orders")
      .select("id, status, payment_status, total_amount, currency, expires_at, stripe_checkout_session_id, metadata")
      .eq("id", cart.order_id).maybeSingle(),
    // Divisions are joined in a second read: entries reference them by a composite FK, which
    // PostgREST cannot embed by the single division_id column (the embed errors and drops the list).
    params.admin.from("event_competition_entries")
      .select("display_name, status, sort_order, division_id")
      .eq("order_id", cart.order_id).order("sort_order"),
    params.admin.from("event_signing_checkpoints").select("status").eq("order_id", cart.order_id).maybeSingle(),
  ]);
  if (!order) return null;
  const entryRows = (entries ?? []) as Array<{ display_name: string; status: string; division_id: string }>;
  const divisionNames = new Map<string, string>();
  if (entryRows.length > 0) {
    const { data: divisions } = await params.admin
      .from("event_competition_divisions")
      .select("id, name")
      .eq("event_id", cart.event_id)
      .in("id", [...new Set(entryRows.map((entry) => entry.division_id))]);
    for (const division of (divisions ?? []) as Array<{ id: string; name: string }>) divisionNames.set(division.id, division.name);
  }
  const metadata = (order.metadata ?? {}) as Record<string, unknown>;
  let checkoutComplete = false;
  const accountId = String(metadata.stripe_account_id ?? "");
  if (order.status === "pending" && order.stripe_checkout_session_id && params.stripe && ACCOUNT_ID_PATTERN.test(accountId)) {
    try {
      const session = await params.stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id, {}, { stripeAccount: accountId });
      checkoutComplete = session.status === "complete";
    } catch {
      checkoutComplete = false;
    }
  }
  const expired = Boolean(order.expires_at && Date.parse(order.expires_at) <= Date.now());
  const state = deriveCompetitionDisplayState({
    orderStatus: order.status,
    paymentStatus: order.payment_status,
    needsReview: Boolean(metadata.needs_review),
    requiresSigning: metadata.requires_signing === true,
    signingComplete: ["ready_for_payment", "payment_started", "completed"].includes(String(checkpoint?.status ?? "")),
    checkoutComplete,
    expired,
  });
  // A hold that lapsed without any provider session is released lazily (no webhook will come).
  if (state === "expired" && order.status === "pending" && !order.stripe_checkout_session_id) {
    try {
      await releaseCompetitionRegistration(params.admin, { orderId: order.id, reason: metadata.requires_signing === true ? "signing_expired" : "expired" });
    } catch {
      console.warn("comp10c_lazy_release_failed");
    }
  }
  return {
    state,
    eventSlug: event.slug,
    eventName: event.name,
    totalCents: Math.round(Number(order.total_amount ?? 0) * 100),
    currency: String(order.currency ?? "USD"),
    entries: entryRows.map((entry) => ({
      label: [divisionNames.get(entry.division_id), entry.display_name].filter(Boolean).join(" · "),
      status: entry.status,
    })),
  };
}

import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { getStripe } from "@/lib/payments/stripe";
import {
  CLASS_PURCHASE_SOURCE,
  classifyClassPurchaseError,
  policyPriceToCents,
  type ClassPurchaseErrorKind,
  type OwnPurchase,
} from "@/lib/public/classPurchase";

/*
  GC-3.5-3: server side of the public paid Group Class registration (Public
  Discovery acquisition, self-registration only).

  Authority stays in the GC-3.5-2 database RPCs:
    start_public_class_purchase    (USER session: auth.uid() + verified email)
    attach_public_class_purchase_checkout (service role)
    finalize_public_class_purchase (service role, verified webhook only)
    release_public_class_purchase  (USER session)
  This module never computes eligibility, never chooses a price and never
  writes clients, links, attendees or payments.

  Checkout: a DIRECT charge on the class studio's own connected account
  (`{ stripeAccount }`), mode=payment, card only (no async methods), USD, no
  application fee, amount = the hold's server-snapshotted amount_cents. The
  session is created with a deterministic idempotency key and is only ever
  shown to the purchaser after attach succeeded.
*/

type StripeClient = ReturnType<typeof getStripe>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/;
const CHECKOUT_MIN_LIFETIME_MS = 30 * 60 * 1000; // Stripe: expires_at must be >= 30 minutes after creation
const CHECKOUT_SAFETY_MS = 30 * 1000;
const CHECKOUT_DB_MAX_WINDOW_MS = 35 * 60 * 1000; // attach_public_class_purchase_checkout ceiling
const CHECKOUT_DEFAULT_PAST_HOLD_MS = 2 * 60 * 1000; // fresh hold (30 min) + 2 min = 32 min checkout

// ---------------------------------------------------------------------------
// Connect readiness and the public offer
// ---------------------------------------------------------------------------

export type StudioPaymentAccount = { ready: true; accountId: string } | { ready: false };

/**
 * The studio's canonical connected account, ready to take card payments. Same four-field rule every DanceFlow checkout
 * uses (PAY-DC): account id + onboarding complete + charges enabled + payouts enabled. No platform or other-studio fallback.
 */
export async function resolveStudioPaymentAccount(admin: Db, studioId: string): Promise<StudioPaymentAccount> {
  const { data, error } = await admin
    .from("studios")
    .select(
      "stripe_connected_account_id, stripe_connect_onboarding_complete, stripe_connect_charges_enabled, stripe_connect_payouts_enabled",
    )
    .eq("id", studioId)
    .maybeSingle();
  if (error || !data) return { ready: false };
  const row = data as {
    stripe_connected_account_id: string | null;
    stripe_connect_onboarding_complete: boolean | null;
    stripe_connect_charges_enabled: boolean | null;
    stripe_connect_payouts_enabled: boolean | null;
  };
  const accountId = row.stripe_connected_account_id?.trim() ?? "";
  if (
    !ACCOUNT_ID_PATTERN.test(accountId) ||
    row.stripe_connect_onboarding_complete !== true ||
    row.stripe_connect_charges_enabled !== true ||
    row.stripe_connect_payouts_enabled !== true
  ) {
    return { ready: false };
  }
  return { ready: true, accountId };
}

export type PublicClassPaymentOffer =
  | { available: true; amountCents: number }
  | { available: false; reason: "not_offered" | "payment_not_ready" };

/**
 * Display-only preview of the direct-payment offer for a public class (D8: shown on /register only). The hold created
 * by start_public_class_purchase snapshots the authoritative amount; this value is never sent to Stripe.
 */
export async function loadPublicClassPaymentOffer(
  admin: Db,
  params: { studioId: string; appointmentId: string },
): Promise<PublicClassPaymentOffer> {
  const { data, error } = await admin
    .from("group_class_enrollment_policies")
    .select("publicly_discoverable, self_enrollment_allowed, accepted_funding_types, direct_payment_amount")
    .eq("appointment_id", params.appointmentId)
    .eq("studio_id", params.studioId)
    .maybeSingle();
  if (error || !data) return { available: false, reason: "not_offered" };
  const policy = data as {
    publicly_discoverable: boolean | null;
    self_enrollment_allowed: boolean | null;
    accepted_funding_types: string[] | null;
    direct_payment_amount: number | string | null;
  };
  const amountCents = policyPriceToCents(policy.direct_payment_amount);
  if (
    policy.publicly_discoverable !== true ||
    policy.self_enrollment_allowed !== true ||
    !(policy.accepted_funding_types ?? []).includes("direct_payment") ||
    amountCents === null
  ) {
    return { available: false, reason: "not_offered" };
  }
  const account = await resolveStudioPaymentAccount(admin, params.studioId);
  return account.ready ? { available: true, amountCents } : { available: false, reason: "payment_not_ready" };
}

/** Any linked relationship (self or managing someone) at this studio: Public Discovery direct payment is not for them. */
export async function hasLinkedStudioRelationship(admin: Db, params: { userId: string; studioId: string }): Promise<boolean> {
  const { data, error } = await admin
    .from("client_account_links")
    .select("id")
    .eq("user_id", params.userId)
    .eq("studio_id", params.studioId)
    .eq("status", "linked")
    .limit(1);
  if (error) throw new Error("Studio relationship lookup failed.");
  return (data ?? []).length > 0;
}

/**
 * Prefill for the purchaser's minimal identity form: the account's own dancer profile, else the auth display name. Read
 * only; nothing here is authoritative (start_public_class_purchase re-validates the submitted names).
 */
export async function loadPurchaserPrefill(
  admin: Db,
  user: { id: string; user_metadata?: Record<string, unknown> | null },
): Promise<{ firstName: string; lastName: string; phone: string }> {
  let firstName = "";
  let lastName = "";
  let phone = "";
  try {
    const { data } = await admin
      .from("dancer_profiles")
      .select("first_name, last_name, phone")
      .eq("user_id", user.id)
      .maybeSingle();
    const row = data as { first_name?: string | null; last_name?: string | null; phone?: string | null } | null;
    firstName = row?.first_name?.trim() ?? "";
    lastName = row?.last_name?.trim() ?? "";
    phone = row?.phone?.trim() ?? "";
  } catch {
    // prefill is best-effort
  }
  if (!firstName && !lastName) {
    const meta = user.user_metadata ?? {};
    const full = typeof meta.full_name === "string" ? meta.full_name : typeof meta.name === "string" ? meta.name : "";
    const parts = full.trim().split(/\s+/).filter(Boolean);
    firstName = parts[0] ?? "";
    lastName = parts.slice(1).join(" ");
  }
  return { firstName: firstName.slice(0, 100), lastName: lastName.slice(0, 100), phone: phone.slice(0, 32) };
}

// ---------------------------------------------------------------------------
// The purchaser's own purchase state (RLS: purchaser reads only own holds)
// ---------------------------------------------------------------------------

type HoldRow = {
  id: string;
  status: OwnPurchase["status"];
  amount_cents: number;
  expires_at: string;
  created_at: string;
  stripe_checkout_session_id: string | null;
  stripe_account_id: string | null;
  client_id: string | null;
  attendee_id: string | null;
  payment_id: string | null;
  dancer_first_name: string;
  dancer_last_name: string;
};

const HOLD_COLUMNS =
  "id, status, amount_cents, expires_at, created_at, stripe_checkout_session_id, stripe_account_id, client_id, attendee_id, payment_id, dancer_first_name, dancer_last_name";

function toOwnPurchase(row: HoldRow): OwnPurchase {
  return {
    holdId: row.id,
    status: row.status,
    amountCents: Number(row.amount_cents),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    checkoutSessionId: row.stripe_checkout_session_id,
    stripeAccountId: row.stripe_account_id,
    clientId: row.client_id,
    attendeeId: row.attendee_id,
    paymentId: row.payment_id,
    dancerFirstName: row.dancer_first_name,
    dancerLastName: row.dancer_last_name,
  };
}

/** The signed-in purchaser's most recent purchase hold for this class, read on THEIR session (RLS). */
export async function loadLatestOwnPurchase(
  userClient: Db,
  params: { appointmentId: string; userId: string },
): Promise<OwnPurchase | null> {
  const { data, error } = await userClient
    .from("group_class_enrollment_holds")
    .select(HOLD_COLUMNS)
    .eq("appointment_id", params.appointmentId)
    .eq("purchaser_user_id", params.userId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error("Purchase lookup failed.");
  const row = (data ?? [])[0] as HoldRow | undefined;
  return row ? toOwnPurchase(row) : null;
}

async function loadOwnHoldById(userClient: Db, params: { holdId: string; userId: string }): Promise<OwnPurchase | null> {
  const { data, error } = await userClient
    .from("group_class_enrollment_holds")
    .select(HOLD_COLUMNS)
    .eq("id", params.holdId)
    .eq("purchaser_user_id", params.userId)
    .maybeSingle();
  if (error) throw new Error("Purchase lookup failed.");
  return data ? toOwnPurchase(data as HoldRow) : null;
}

/** Server-side status reads for the purchaser's OWN hold (ids come from their RLS-visible hold row, never the browser). */
export async function loadPurchaseSettlementState(
  admin: Db,
  params: { studioId: string; purchase: OwnPurchase },
): Promise<{ attendeeActive: boolean; refunded: boolean }> {
  const { purchase, studioId } = params;
  let attendeeActive = false;
  let refunded = false;
  if (purchase.status === "converted" && purchase.attendeeId) {
    const { data, error } = await admin
      .from("appointment_attendees")
      .select("id, status")
      .eq("id", purchase.attendeeId)
      .eq("studio_id", studioId)
      .maybeSingle();
    if (error) throw new Error("Enrollment lookup failed.");
    attendeeActive = (data as { status?: string } | null)?.status === "booked";
  }
  if (purchase.status === "conflict" && purchase.paymentId) {
    const { data, error } = await admin
      .from("payments")
      .select("id, status")
      .eq("id", purchase.paymentId)
      .eq("studio_id", studioId)
      .maybeSingle();
    if (error) throw new Error("Payment lookup failed.");
    refunded = (data as { status?: string } | null)?.status === "refunded";
  }
  return { attendeeActive, refunded };
}

// ---------------------------------------------------------------------------
// Start / resume Checkout
// ---------------------------------------------------------------------------

export type StartCheckoutResult =
  | { kind: "redirect"; url: string }
  | { kind: "finalizing" }
  | { kind: "error"; code: ClassPurchaseErrorKind };

type StartRpcRow = {
  hold_id: string;
  hold_status: string;
  amount_cents: number;
  currency: string;
  expires_at: string;
  stripe_checkout_session_id: string | null;
  dancer_first_name: string;
  dancer_last_name: string;
  reused: boolean;
};

export function checkoutIdempotencyKey(holdId: string, expiresAtSeconds: number) {
  return `gc35-hold:${holdId}:checkout-session:${expiresAtSeconds}`;
}

/**
 * Checkout expiry aligned to the hold (D5): a fresh hold (30 min) gets a 32-minute session, deterministic for the hold so a
 * double-click reuses the same Stripe idempotency key. Always >= Stripe's 30-minute minimum, <= the database's 35-minute
 * attach window and <= class start; null when no valid window remains (registration closed).
 */
export function computeCheckoutExpiry(params: { holdExpiresAt: string; classStartsAt: string; now?: number }): number | null {
  const now = params.now ?? Date.now();
  const holdExpires = Date.parse(params.holdExpiresAt);
  const startsAt = Date.parse(params.classStartsAt);
  if (!Number.isFinite(holdExpires) || !Number.isFinite(startsAt)) return null;
  const minMs = now + CHECKOUT_MIN_LIFETIME_MS + CHECKOUT_SAFETY_MS;
  const maxMs = Math.min(now + CHECKOUT_DB_MAX_WINDOW_MS - CHECKOUT_SAFETY_MS, startsAt);
  let expiresMs = holdExpires + CHECKOUT_DEFAULT_PAST_HOLD_MS;
  if (expiresMs < minMs) expiresMs = minMs;
  if (expiresMs > maxMs) expiresMs = maxMs;
  if (expiresMs < minMs) return null;
  return Math.floor(expiresMs / 1000);
}

async function expireCheckoutQuietly(stripe: StripeClient, sessionId: string, accountId: string) {
  try {
    await stripe.checkout.sessions.expire(sessionId, {}, { stripeAccount: accountId });
  } catch {
    console.warn("gc35_checkout_expire_failed");
  }
}

export async function startPublicClassCheckout(params: {
  userClient: Db;
  admin: Db;
  stripe: StripeClient;
  userId: string;
  studioId: string;
  appointmentId: string;
  classTitle: string;
  classDescription: string;
  classStartsAt: string;
  firstName: string;
  lastName: string;
  phone: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  now?: number;
}): Promise<StartCheckoutResult> {
  return startOrResume(params, 0);
}

async function startOrResume(
  params: Parameters<typeof startPublicClassCheckout>[0],
  restarts: number,
): Promise<StartCheckoutResult> {
  const now = params.now ?? Date.now();

  // UX pre-check (the RPC re-checks): never create a hold that cannot be paid.
  const account = await resolveStudioPaymentAccount(params.admin, params.studioId);
  if (!account.ready) return { kind: "error", code: "unavailable" };

  // Authoritative hold on the USER session: user, verified email, studio, policy and price are all server-derived.
  const { data, error } = await params.userClient.rpc("start_public_class_purchase", {
    p_appointment_id: params.appointmentId,
    p_first_name: params.firstName,
    p_last_name: params.lastName,
    p_phone: params.phone || null,
  });
  if (error) return { kind: "error", code: classifyClassPurchaseError(error.message) };
  const hold = ((Array.isArray(data) ? data[0] : data) ?? null) as StartRpcRow | null;
  if (!hold?.hold_id || !Number.isSafeInteger(Number(hold.amount_cents)) || Number(hold.amount_cents) <= 0) {
    return { kind: "error", code: "checkout_failed" };
  }

  // Resume: the hold already has its ONE Checkout Session (GC-3.5-2: one session per hold).
  if (hold.stripe_checkout_session_id) {
    const own = await loadOwnHoldById(params.userClient, { holdId: hold.hold_id, userId: params.userId });
    const sessionAccount = own?.stripeAccountId ?? null;
    if (!sessionAccount || !ACCOUNT_ID_PATTERN.test(sessionAccount)) return { kind: "error", code: "checkout_failed" };
    let existing: Stripe.Checkout.Session;
    try {
      existing = await params.stripe.checkout.sessions.retrieve(hold.stripe_checkout_session_id, {}, { stripeAccount: sessionAccount });
    } catch {
      console.error("gc35_checkout_retrieve_failed");
      return { kind: "error", code: "checkout_failed" };
    }
    if (existing.status === "open" && existing.url) return { kind: "redirect", url: existing.url };
    if (existing.status === "complete") return { kind: "finalizing" };
    // Expired session: this hold can take no new session. Release it, then start once more.
    if (restarts > 0) return { kind: "error", code: "checkout_failed" };
    const { error: releaseError } = await params.userClient.rpc("release_public_class_purchase", { p_hold_id: hold.hold_id });
    if (releaseError) return { kind: "error", code: classifyClassPurchaseError(releaseError.message) };
    return startOrResume(params, restarts + 1);
  }

  const expiresAtSeconds = computeCheckoutExpiry({
    holdExpiresAt: hold.expires_at,
    classStartsAt: params.classStartsAt,
    now,
  });
  if (expiresAtSeconds === null) return { kind: "error", code: "closed" };

  const amountCents = Number(hold.amount_cents);
  const metadata = {
    source: CLASS_PURCHASE_SOURCE,
    hold_id: hold.hold_id,
    studio_id: params.studioId,
    appointment_id: params.appointmentId,
  };

  let session: Stripe.Checkout.Session;
  try {
    session = await params.stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: params.customerEmail,
        client_reference_id: hold.hold_id,
        expires_at: expiresAtSeconds,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: amountCents,
              product_data: { name: params.classTitle, description: params.classDescription || undefined },
            },
          },
        ],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata,
        payment_intent_data: { metadata },
      },
      { stripeAccount: account.accountId, idempotencyKey: checkoutIdempotencyKey(hold.hold_id, expiresAtSeconds) },
    );
  } catch {
    console.error("gc35_checkout_create_failed");
    return { kind: "error", code: "checkout_failed" };
  }

  if (!session.id || !session.url) {
    await expireCheckoutQuietly(params.stripe, session.id, account.accountId);
    return { kind: "error", code: "checkout_failed" };
  }

  // Bind the session to the hold BEFORE the purchaser ever sees it.
  const { error: attachError } = await params.admin.rpc("attach_public_class_purchase_checkout", {
    p_hold_id: hold.hold_id,
    p_stripe_account_id: account.accountId,
    p_checkout_session_id: session.id,
    p_checkout_expires_at: new Date((session.expires_at ?? expiresAtSeconds) * 1000).toISOString(),
  });
  if (attachError) {
    // Never leave an untracked payable session behind; never redirect to it.
    await expireCheckoutQuietly(params.stripe, session.id, account.accountId);
    const message = attachError.message ?? "";
    console.error("gc35_checkout_attach_failed", { code: /^(GC35_[A-Z_]+)/.exec(message)?.[1] ?? "unknown" });
    if (/GC35_CHECKOUT_CUTOFF|GC35_CHECKOUT_EXPIRY_INVALID/.test(message)) return { kind: "error", code: "closed" };
    if (/GC35_CLASS_CANCELLED/.test(message)) return { kind: "error", code: "cancelled" };
    return { kind: "error", code: "checkout_failed" };
  }

  return { kind: "redirect", url: session.url };
}

// ---------------------------------------------------------------------------
// Release (purchaser cancels)
// ---------------------------------------------------------------------------

export type ReleaseResult = "released" | "finalizing" | "not_found" | "error";

export async function releaseOwnPublicClassPurchase(params: {
  userClient: Db;
  stripe: StripeClient;
  userId: string;
  holdId: string;
}): Promise<ReleaseResult> {
  const own = await loadOwnHoldById(params.userClient, { holdId: params.holdId, userId: params.userId });
  if (!own) return "not_found";
  if (own.status === "released") return "released";
  if (own.status !== "held") return "not_found";

  if (own.checkoutSessionId && own.stripeAccountId && ACCOUNT_ID_PATTERN.test(own.stripeAccountId)) {
    try {
      const session = await params.stripe.checkout.sessions.retrieve(own.checkoutSessionId, {}, { stripeAccount: own.stripeAccountId });
      // Paid already: the webhook will finalize; releasing now would only force a refund.
      if (session.status === "complete") return "finalizing";
      if (session.status === "open") {
        await params.stripe.checkout.sessions.expire(own.checkoutSessionId, {}, { stripeAccount: own.stripeAccountId });
      }
    } catch {
      console.error("gc35_release_checkout_expire_failed");
      return "error";
    }
  }

  const { error } = await params.userClient.rpc("release_public_class_purchase", { p_hold_id: params.holdId });
  if (error) {
    console.error("gc35_release_failed", { kind: classifyClassPurchaseError(error.message) });
    return "error";
  }
  return "released";
}

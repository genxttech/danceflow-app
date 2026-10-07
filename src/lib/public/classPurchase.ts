/*
  GC-3.5-3: pure helpers for the public paid Group Class registration flow
  (self-registration only, for a verified account NOT yet linked to the
  studio). Safe to import anywhere; the server-side reads/writes live in
  src/lib/payments/groupClassPurchase.ts.

  The database (GC-3.5-2: start/attach/finalize/release_public_class_purchase)
  is authoritative for every rule. Nothing here decides eligibility, price or
  outcome -- it only translates database/Stripe outcomes into safe copy and
  picks which already-authoritative state the page shows.
*/

export const CLASS_PURCHASE_SOURCE = "group_class_direct_payment";

/** "$25.00" from integer cents (USD only, D7). */
export function formatUsdCents(cents: number) {
  const safe = Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
  return `$${Math.floor(safe / 100).toLocaleString("en-US")}.${String(safe % 100).padStart(2, "0")}`;
}

/**
 * A policy price (numeric dollars from the database) as integer cents, or null when it is not a positive whole number of
 * cents within DanceFlow's limit. Display only: the hold's own amount_cents is the charge authority.
 */
export function policyPriceToCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.replace(/0+$/, "").length > 2) return null;
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 10_000_000 ? cents : null;
}

// ---------------------------------------------------------------------------
// Error translation: database/Stripe outcomes -> safe purchaser copy.
// Raw messages never reach the browser; only the kind travels in the URL.
// ---------------------------------------------------------------------------

export const CLASS_PURCHASE_ERROR_KINDS = [
  "unavailable",
  "cancelled",
  "closed",
  "full",
  "already_linked",
  "payment_pending",
  "name_invalid",
  "phone_invalid",
  "sign_in",
  "rate_limited",
  "checkout_failed",
  "release_failed",
] as const;

export type ClassPurchaseErrorKind = (typeof CLASS_PURCHASE_ERROR_KINDS)[number];

export function isClassPurchaseErrorKind(value: unknown): value is ClassPurchaseErrorKind {
  return typeof value === "string" && (CLASS_PURCHASE_ERROR_KINDS as readonly string[]).includes(value);
}

/** Maps a start/release RPC error message (GC35_* machine prefix) to a safe kind. Unknown -> checkout_failed. */
export function classifyClassPurchaseError(message: string | null | undefined): ClassPurchaseErrorKind {
  const text = String(message ?? "");
  if (/GC35_(CLASS_UNAVAILABLE|SELF_ENROLLMENT_CLOSED|DIRECT_PAYMENT_UNAVAILABLE)/.test(text)) return "unavailable";
  if (/GC35_CLASS_CANCELLED/.test(text)) return "cancelled";
  if (/GC35_CHECKOUT_CUTOFF/.test(text)) return "closed";
  if (/GC35_CLASS_FULL/.test(text)) return "full";
  if (/GC35_ALREADY_LINKED/.test(text)) return "already_linked";
  if (/GC35_PAYMENT_PENDING/.test(text)) return "payment_pending";
  if (/GC35_NAME_INVALID/.test(text)) return "name_invalid";
  if (/GC35_PHONE_INVALID/.test(text)) return "phone_invalid";
  if (/GC35_(AUTH_REQUIRED|EMAIL_UNVERIFIED)/.test(text)) return "sign_in";
  return "checkout_failed";
}

export function classPurchaseErrorMessage(kind: ClassPurchaseErrorKind, studioName: string) {
  switch (kind) {
    case "unavailable":
      return `Online payment is not available for this class right now. Please contact ${studioName}.`;
    case "cancelled":
      return "This class has been cancelled.";
    case "closed":
      return "Online registration for this class has closed.";
    case "full":
      return "This class is full.";
    case "already_linked":
      return `You're already connected to ${studioName}. Join this class from your Student Portal.`;
    case "payment_pending":
      return "Your previous payment is still being confirmed. Please try again in a few minutes.";
    case "name_invalid":
      return "Enter the dancer's first and last name.";
    case "phone_invalid":
      return "Enter a valid phone number or leave it blank.";
    case "sign_in":
      return "Please sign in again to continue.";
    case "rate_limited":
      return "Too many attempts. Please wait a few minutes and try again.";
    case "release_failed":
      return "We couldn't cancel this registration. Please try again.";
    case "checkout_failed":
    default:
      return "We couldn't start checkout. Please try again.";
  }
}

// ---------------------------------------------------------------------------
// Return/status view: which authoritative state to show. Browser return is
// DISPLAY ONLY -- the `purchase` query flag only chooses wording for a hold
// the database already has; it never marks anything paid.
// ---------------------------------------------------------------------------

export type OwnPurchase = {
  holdId: string;
  status: "held" | "converting" | "converted" | "released" | "conflict";
  amountCents: number;
  expiresAt: string;
  createdAt: string;
  checkoutSessionId: string | null;
  stripeAccountId: string | null;
  clientId: string | null;
  attendeeId: string | null;
  paymentId: string | null;
  dancerFirstName: string;
  dancerLastName: string;
};

export type PurchaseReturnFlag = "return" | "cancelled" | null;

export type PurchaseView =
  | { kind: "none" }
  | { kind: "registered"; purchase: OwnPurchase }
  | { kind: "finalizing"; purchase: OwnPurchase }
  | { kind: "checkout_open"; purchase: OwnPurchase }
  | { kind: "not_completed"; purchase: OwnPurchase }
  | { kind: "refunded"; purchase: OwnPurchase }
  | { kind: "needs_studio"; purchase: OwnPurchase };

/** Reconciliation grace after a hold's expiry during which a Checkout payment may still settle (GC-3.5-2: 10 minutes). */
export const PURCHASE_RECONCILIATION_GRACE_MS = 10 * 60 * 1000;

export function parsePurchaseReturnFlag(value: unknown): PurchaseReturnFlag {
  return value === "return" || value === "cancelled" ? value : null;
}

export function resolvePurchaseView(params: {
  purchase: OwnPurchase | null;
  returnFlag: PurchaseReturnFlag;
  /** The converted hold's attendee is still an active (booked) enrollment. */
  attendeeActive: boolean;
  /** The conflict payment has been refunded (payments.status = 'refunded'). */
  refunded: boolean;
  now?: number;
}): PurchaseView {
  const { purchase, returnFlag, attendeeActive, refunded } = params;
  const now = params.now ?? Date.now();
  if (!purchase) return { kind: "none" };

  if (purchase.status === "converted") {
    // A later staff cancellation ends the paid-registration view; the normal linked flow takes over.
    return attendeeActive ? { kind: "registered", purchase } : { kind: "none" };
  }

  if (purchase.status === "conflict") {
    return refunded ? { kind: "refunded", purchase } : { kind: "needs_studio", purchase };
  }

  if (purchase.status === "held" || purchase.status === "converting") {
    if (!purchase.checkoutSessionId) return { kind: "none" };
    const expires = Date.parse(purchase.expiresAt);
    const live = Number.isFinite(expires) && expires > now;
    const withinGrace = Number.isFinite(expires) && expires + PURCHASE_RECONCILIATION_GRACE_MS >= now;
    if (returnFlag === "return" && withinGrace) return { kind: "finalizing", purchase };
    if (!live) return { kind: "none" };
    if (returnFlag === "cancelled") return { kind: "not_completed", purchase };
    return { kind: "checkout_open", purchase };
  }

  return { kind: "none" };
}

/** Bounded polling while the webhook finalizes: attempts and interval. */
export const FINALIZING_POLL = { attempts: 12, intervalMs: 3000 } as const;

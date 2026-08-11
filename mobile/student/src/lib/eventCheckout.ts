import { danceflowApiFetch } from "@/lib/danceflowApi";

const CHECKOUT_CREATE_TIMEOUT_MS = 25000;
const CHECKOUT_CONFIRM_TIMEOUT_MS = 15000;
const CHECKOUT_STATUS_TIMEOUT_MS = 12000;

/**
 * A stable per-checkout-attempt id the server uses to deduplicate order
 * creation (src/app/api/student/events/[eventId]/checkout/route.ts,
 * resolveEventOrderForCheckout) -- a double-tap or a retry after a dropped
 * response must reuse the same id so the server returns the *same* order
 * instead of creating a second one and a second Stripe PaymentIntent/
 * Checkout Session. Callers own persisting/clearing this across retries
 * (see checkoutRequestIdRef in app/events/[id]/register.tsx); this module
 * only generates values in the shape the server requires.
 */
export function generateCheckoutRequestId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }

  // Fallback UUID v4 for Hermes builds without a native crypto.randomUUID.
  // Not cryptographically strong -- this value is only ever used as a
  // request-deduplication key, never a secret.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}


export function assertSafeEventCheckoutUrl(
  value: string,
  options?: { allowDanceFlowScheme?: boolean },
) {
  const trimmed = value.trim();

  if (
    options?.allowDanceFlowScheme &&
    trimmed.toLowerCase().startsWith("danceflow://")
  ) {
    return trimmed;
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("The secure checkout link was invalid.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("The secure checkout link was blocked.");
  }

  return parsed.toString();
}

async function withTimeout<T>(
  timeoutMs: number,
  errorMessage: string,
  request: (signal: AbortSignal) => Promise<T>
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await request(controller.signal);
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") {
      throw new Error(errorMessage);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export type EventCheckoutTicketSelection = {
  quantity: number;
  ticketTypeId: string;
};

export type CreateEventCheckoutInput = {
  additionalAttendeeNames: string[];
  buyerFirstName: string;
  buyerLastName: string;
  buyerPhone?: string;
  /** See generateCheckoutRequestId() above -- must be the same value for
   * every retry/fallback call belonging to one logical checkout attempt. */
  clientRequestId: string;
  eventId: string;
  notes?: string;
  paymentMode?: "checkout" | "payment_sheet";
  returnUrl?: string;
  ticketSelections: EventCheckoutTicketSelection[];
};

export type CreateEventCheckoutResult = {
  clientSecret?: string;
  checkoutUrl?: string;
  completed?: boolean;
  requiresSignature?: boolean;
  signingUrl?: string;
  orderId: string;
  publishableKey?: string;
  registrationIds: string[];
};

export type StudentEventOrderTicket = {
  checkedInAt: string | null;
  city: string | null;
  eventDate: string | null;
  eventId: string;
  eventName: string;
  eventSlug: string | null;
  eventTime: string | null;
  id: string;
  qrImageUrl: string | null;
  registrationId: string;
  state: string | null;
  ticketCode: string | null;
  ticketIssuedAt: string | null;
  ticketName: string;
  venue: string | null;
  waiverSignedAt: string | null;
};

export type StudentEventOrderStatus = {
  cancelledAt: string | null;
  currency: string;
  eventId: string;
  eventName: string;
  eventSlug: string | null;
  expiresAt: string | null;
  orderId: string;
  paidAt: string | null;
  paymentStatus: string;
  registrationIds: string[];
  status: string;
  ticketCodesIssued: number;
  ticketCount: number;
  tickets: StudentEventOrderTicket[];
  ticketsReady: boolean;
  totalAmount: number;
};

export async function createStudentEventCheckout(input: CreateEventCheckoutInput) {
  return withTimeout(
    CHECKOUT_CREATE_TIMEOUT_MS,
    "Checkout is taking too long. Please check your connection and try again.",
    (signal) =>
      danceflowApiFetch<CreateEventCheckoutResult>(
        `/api/student/events/${encodeURIComponent(input.eventId)}/checkout`,
        {
          body: JSON.stringify({
            additionalAttendeeNames: input.additionalAttendeeNames,
            buyerFirstName: input.buyerFirstName,
            buyerLastName: input.buyerLastName,
            buyerPhone: input.buyerPhone,
            clientRequestId: input.clientRequestId,
            notes: input.notes,
            paymentMode: input.paymentMode,
            returnUrl: input.returnUrl,
            ticketSelections: input.ticketSelections,
          }),
          method: "POST",
          signal,
        }
      )
  );
}

export async function confirmStudentEventOrder(orderId: string) {
  return withTimeout(
    CHECKOUT_CONFIRM_TIMEOUT_MS,
    "Payment confirmation is taking too long. Wallet will keep checking for your ticket.",
    (signal) =>
      danceflowApiFetch<{ confirmed: boolean; orderId: string; registrationIds: string[] }>(
        `/api/student/events/orders/${encodeURIComponent(orderId)}/confirm`,
        {
          method: "POST",
          signal,
        }
      )
  );
}

export async function getStudentEventOrderStatus(orderId: string) {
  return withTimeout(
    CHECKOUT_STATUS_TIMEOUT_MS,
    "Ticket status is taking too long to load. Wallet will try again shortly.",
    (signal) =>
      danceflowApiFetch<StudentEventOrderStatus>(
        `/api/student/events/orders/${encodeURIComponent(orderId)}`,
        { signal }
      )
  );
}

export async function resumeStudentEventCheckout(orderId: string) {
  return withTimeout(
    CHECKOUT_CREATE_TIMEOUT_MS,
    "Checkout is taking too long. Please check your connection and try again.",
    (signal) =>
      danceflowApiFetch<CreateEventCheckoutResult>(
        `/api/student/events/orders/${encodeURIComponent(orderId)}/resume-after-signing`,
        { method: "POST", signal },
      ),
  );
}

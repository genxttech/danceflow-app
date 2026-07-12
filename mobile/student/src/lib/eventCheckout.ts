import { danceflowApiFetch } from "@/lib/danceflowApi";

const CHECKOUT_CREATE_TIMEOUT_MS = 25000;
const CHECKOUT_CONFIRM_TIMEOUT_MS = 15000;
const CHECKOUT_STATUS_TIMEOUT_MS = 12000;

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
  documentConsentAccepted?: boolean;
  documentRequirementIds?: string[];
  documentSignatureName?: string;
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
            documentConsentAccepted: input.documentConsentAccepted,
            documentRequirementIds: input.documentRequirementIds,
            documentSignatureName: input.documentSignatureName,
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

import { danceflowApiFetch } from "@/lib/danceflowApi";

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
  returnUrl?: string;
  ticketSelections: EventCheckoutTicketSelection[];
};

export type CreateEventCheckoutResult = {
  checkoutUrl?: string;
  completed?: boolean;
  orderId: string;
  registrationIds: string[];
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
  ticketsReady: boolean;
  totalAmount: number;
};

export async function createStudentEventCheckout(input: CreateEventCheckoutInput) {
  return danceflowApiFetch<CreateEventCheckoutResult>(
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
        returnUrl: input.returnUrl,
        ticketSelections: input.ticketSelections,
      }),
      method: "POST",
    }
  );
}

export async function getStudentEventOrderStatus(orderId: string) {
  return danceflowApiFetch<StudentEventOrderStatus>(
    `/api/student/events/orders/${encodeURIComponent(orderId)}`
  );
}

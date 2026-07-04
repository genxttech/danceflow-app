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

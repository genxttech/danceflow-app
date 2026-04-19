type EventOutboundTemplateParams = {
  eventName: string;
  attendeeFirstName: string;
  attendeeLastName: string;
  ticketTypeName: string;
  quantity: number;
  totalPrice: number;
  currency: string;
  eventUrl: string;
};

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (currency || "USD").toUpperCase(),
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency || "USD"}`;
  }
}

function attendeeName(params: EventOutboundTemplateParams) {
  return `${params.attendeeFirstName} ${params.attendeeLastName}`.trim();
}

export function buildEventWaitlistEmailTemplate(
  params: EventOutboundTemplateParams
) {
  return {
    subject: `You're on the waitlist for ${params.eventName}`,
    bodyText: [
      `Hi ${params.attendeeFirstName || attendeeName(params)},`,
      ``,
      `You're now on the waitlist for ${params.eventName}.`,
      `Ticket: ${params.ticketTypeName}`,
      `Quantity: ${params.quantity}`,
      ``,
      `If a spot opens up, the organizer can contact you with next steps.`,
      `Event page: ${params.eventUrl}`,
      ``,
      `Thanks,`,
      `StudioFlow`,
    ].join("\n"),
  };
}

export function buildEventWaitlistSmsTemplate(
  params: EventOutboundTemplateParams
) {
  return `You're on the waitlist for ${params.eventName}. Ticket: ${params.ticketTypeName}. Qty: ${params.quantity}. Details: ${params.eventUrl}`;
}

export function buildEventConfirmedEmailTemplate(
  params: EventOutboundTemplateParams
) {
  return {
    subject: `Registration confirmed for ${params.eventName}`,
    bodyText: [
      `Hi ${params.attendeeFirstName || attendeeName(params)},`,
      ``,
      `Your registration is confirmed for ${params.eventName}.`,
      `Ticket: ${params.ticketTypeName}`,
      `Quantity: ${params.quantity}`,
      params.totalPrice > 0
        ? `Total: ${money(params.totalPrice, params.currency)}`
        : `Total: Free`,
      ``,
      `Event page: ${params.eventUrl}`,
      ``,
      `Thanks,`,
      `StudioFlow`,
    ].join("\n"),
  };
}

export function buildEventConfirmedSmsTemplate(
  params: EventOutboundTemplateParams
) {
  return `Confirmed: ${params.eventName}. Ticket: ${params.ticketTypeName}. Qty: ${params.quantity}. ${params.totalPrice > 0 ? `Total ${money(params.totalPrice, params.currency)}.` : `Free registration.`} Details: ${params.eventUrl}`;
}
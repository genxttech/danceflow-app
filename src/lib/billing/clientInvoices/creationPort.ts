import type { VerifiedClientInvoiceActor } from "./authorize";

/**
 * D24 M3-C: the seam between the client invoice UI and the M3-B creation orchestrator.
 *
 * The orchestrator (createHostedInvoice with CLIENT_INVOICE_SPEC_RESOLVERS, a real Stripe client factory, and studio_client_invoice_link_registration
 * after a `registered` result) is wired in a later, separately authorized package. Until then there is NO port: every caller gets null and the UI shows
 * creation as unavailable. Nothing here can call Stripe.
 *
 * Contract for the future implementation:
 *  - map the verified actor straight onto the orchestrator's AuthorizedBillingActor (same fields);
 *  - businessObjectType = "studio_client_invoice", businessObjectId = invoiceId, requestKey as given (it derives the Stripe idempotency key);
 *  - read studio_client_invoice_creation_spec FIRST and keep its `version`; only on result.state === "registered" call
 *    studio_client_invoice_link_registration(invoice, studio, intent, expectedVersion = that version) with the SERVICE-ROLE client (an edit in between is refused);
 *  - never finalize / send / pay; never return a payment URL.
 */
export type ClientInvoiceCreationPort = {
  createProviderDraft(input: { actor: VerifiedClientInvoiceActor; invoiceId: string; requestKey: string }): Promise<{ ok: true } | { ok: false; code: string }>;
};

export function getClientInvoiceCreationPort(): ClientInvoiceCreationPort | null {
  return null;
}

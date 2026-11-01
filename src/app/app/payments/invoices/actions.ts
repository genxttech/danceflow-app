"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authorizeClientInvoiceActor } from "@/lib/billing/clientInvoices/authorize";
import { getClientInvoiceCreationPort } from "@/lib/billing/clientInvoices/creationPort";
import {
  clientInvoiceErrorMessage,
  isClientInvoiceCreationEnabled,
  isUuid,
  parseDraftForm,
} from "@/lib/billing/clientInvoices/model";

export type ClientInvoiceActionState = { error: string; notice?: string };

/**
 * D24 M3-C: save (create or edit) a client invoice DRAFT.
 *
 * Studio and actor come from the verified session (authorizeClientInvoiceActor); no studio id, user id, total, Stripe id or status is read from the form.
 * Every rule that matters (role, same-studio client/reference, arithmetic, limits, edit-only-while-draft, version check, double-submit dedupe) is enforced
 * again by the database function this calls through the user's own JWT.
 */
export async function saveClientInvoiceDraftAction(_prev: ClientInvoiceActionState, formData: FormData): Promise<ClientInvoiceActionState> {
  const actor = await authorizeClientInvoiceActor("draft");
  if (!actor) return { error: clientInvoiceErrorMessage("client_invoice_forbidden") };

  const parsed = parseDraftForm(formData);
  if (!parsed.ok) return { error: parsed.error };
  const v = parsed.value;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("studio_client_invoice_save_draft", {
    p_studio_id: actor.studioId,
    p_request_key: v.requestKey,
    p_invoice_id: v.invoiceId,
    p_expected_version: v.expectedVersion,
    p_client_id: v.clientId,
    p_reference_type: v.referenceType,
    p_reference_id: v.referenceId,
    p_reference_note: v.referenceNote,
    p_lines: v.lines,
  });
  if (error) return { error: clientInvoiceErrorMessage(error.message, (error as { code?: string }).code) };

  const invoiceId = (data as { invoice_id?: string } | null)?.invoice_id;
  if (!isUuid(invoiceId)) return { error: clientInvoiceErrorMessage(null) };
  revalidatePath("/app/payments/invoices");
  redirect(`/app/payments/invoices/${invoiceId}?saved=1`);
}

/**
 * D24 M3-C: request the PROVIDER DRAFT for a saved draft. Unavailable by default and in this package: it needs D24_HOSTED_INVOICE_CREATION=on AND a
 * creation port (the M3-B orchestrator wiring, a separately authorized package). With either missing it refuses before any database or Stripe access
 * beyond authorization. It never finalizes, sends, or exposes a payment link.
 */
export async function requestClientInvoiceProviderDraftAction(_prev: ClientInvoiceActionState, formData: FormData): Promise<ClientInvoiceActionState> {
  if (!isClientInvoiceCreationEnabled()) {
    return { error: "Creating the invoice at Stripe is not available yet." };
  }
  const actor = await authorizeClientInvoiceActor("draft");
  if (!actor) return { error: clientInvoiceErrorMessage("client_invoice_forbidden") };
  const raw = formData.get("invoiceId");
  const requestKey = formData.get("requestKey");
  if (!isUuid(raw) || typeof requestKey !== "string" || !isUuid(requestKey)) return { error: clientInvoiceErrorMessage("client_invoice_not_found") };

  const port = getClientInvoiceCreationPort();
  if (!port) return { error: "Creating the invoice at Stripe is not available yet." };
  const result = await port.createProviderDraft({ actor, invoiceId: raw, requestKey });
  if (!result.ok) return { error: "The draft could not be created at Stripe. Nothing was sent to your client." };
  revalidatePath(`/app/payments/invoices/${raw}`);
  return { error: "", notice: "Draft created at Stripe. It has not been sent." };
}

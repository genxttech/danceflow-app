"use client";

import { useActionState } from "react";
import { requestClientInvoiceProviderDraftAction, type ClientInvoiceActionState } from "../actions";

const initialState: ClientInvoiceActionState = { error: "" };

/**
 * Creating the draft at Stripe is gated behind D24_HOSTED_INVOICE_CREATION (default off). While it is off the control is replaced by a plain
 * "not available" notice and renders no button. There is deliberately no finalize, send, or pay control anywhere in this package.
 */
export default function ProviderDraftControl({ invoiceId, requestKey, canEdit, creationEnabled }: { invoiceId: string; requestKey: string; canEdit: boolean; creationEnabled: boolean }) {
  const [state, formAction, pending] = useActionState(requestClientInvoiceProviderDraftAction, initialState);
  if (!creationEnabled || !canEdit) {
    return (
      <section className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] p-5 text-sm text-slate-600">
        Creating this invoice at Stripe is not available yet. Your draft stays saved in DanceFlow and nothing is sent to your client.
      </section>
    );
  }
  return (
    <form action={formAction} className="space-y-2 rounded-2xl border border-[var(--brand-border)] bg-white p-5">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="requestKey" value={requestKey} />
      <p className="text-sm text-slate-600">This creates a draft on your connected Stripe account. It is not finalized or sent, and there is no payment link.</p>
      <button type="submit" disabled={pending} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
        {pending ? "Creating..." : "Create draft at Stripe"}
      </button>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      {state.notice ? <p className="text-sm text-emerald-700">{state.notice}</p> : null}
    </form>
  );
}

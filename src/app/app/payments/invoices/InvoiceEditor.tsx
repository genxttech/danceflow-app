"use client";

import { useActionState, useState } from "react";
import { saveClientInvoiceDraftAction, type ClientInvoiceActionState } from "./actions";
import { MAX_FORM_LINES, formatCents } from "@/lib/billing/clientInvoices/model";

const initialState: ClientInvoiceActionState = { error: "" };

export type EditorClient = { id: string; name: string };
export type EditorLine = { description: string; quantity: number; unitPriceCents: number };

type Props = {
  requestKey: string;
  clients: EditorClient[];
  invoice?: { id: string; version: number; clientId: string; referenceType: string | null; referenceId: string | null; referenceNote: string | null };
  lines: EditorLine[];
  readOnly: boolean;
};

const input = "w-full rounded-xl border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-500";

export default function InvoiceEditor({ requestKey, clients, invoice, lines, readOnly }: Props) {
  const [state, formAction, pending] = useActionState(saveClientInvoiceDraftAction, initialState);
  const initialRows = lines.length > 0 ? lines : [{ description: "", quantity: 1, unitPriceCents: 0 }];
  const [rows, setRows] = useState(
    initialRows.map((l) => ({ description: l.description, quantity: String(l.quantity), price: l.unitPriceCents ? (l.unitPriceCents / 100).toFixed(2) : "" })),
  );
  const [refType, setRefType] = useState(invoice?.referenceType ?? "");

  // Display-only preview. The saved total is always computed by the database from the saved lines.
  const preview = rows.reduce((sum, r) => {
    const q = /^\d{1,6}$/.test(r.quantity) ? Number(r.quantity) : 0;
    const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(r.price.replace(/[$,\s]/g, ""));
    const cents = m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0") : 0;
    return sum + q * cents;
  }, 0);

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="requestKey" value={requestKey} />
      {invoice ? <input type="hidden" name="invoiceId" value={invoice.id} /> : null}
      {invoice ? <input type="hidden" name="expectedVersion" value={invoice.version} /> : null}

      <label className="block text-sm font-medium text-slate-700">
        Client
        <select name="clientId" required disabled={readOnly} defaultValue={invoice?.clientId ?? ""} className={`mt-1 ${input}`}>
          <option value="" disabled>
            Choose a client
          </option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="space-y-3" disabled={readOnly}>
        <legend className="text-sm font-medium text-slate-700">Lines</legend>
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <input
              name={`line_description_${i}`}
              value={row.description}
              maxLength={200}
              placeholder="Description"
              aria-label={`Line ${i + 1} description`}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, description: e.target.value } : r)))}
              className={`col-span-12 sm:col-span-6 ${input}`}
            />
            <input
              name={`line_quantity_${i}`}
              value={row.quantity}
              inputMode="numeric"
              placeholder="Qty"
              aria-label={`Line ${i + 1} quantity`}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, quantity: e.target.value } : r)))}
              className={`col-span-4 sm:col-span-2 ${input}`}
            />
            <input
              name={`line_price_${i}`}
              value={row.price}
              inputMode="decimal"
              placeholder="Unit price (USD)"
              aria-label={`Line ${i + 1} unit price`}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)))}
              className={`col-span-8 sm:col-span-4 ${input}`}
            />
          </div>
        ))}
        {!readOnly && rows.length < MAX_FORM_LINES ? (
          <button
            type="button"
            onClick={() => setRows([...rows, { description: "", quantity: "1", price: "" }])}
            className="rounded-xl border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Add line
          </button>
        ) : null}
        <p className="text-sm text-slate-600">
          Estimated total <strong>{formatCents(preview)}</strong> (USD). DanceFlow recalculates the total when you save.
        </p>
      </fieldset>

      <fieldset className="space-y-2" disabled={readOnly}>
        <legend className="text-sm font-medium text-slate-700">Related to (optional)</legend>
        <select name="referenceType" value={refType} onChange={(e) => setRefType(e.target.value)} className={input} aria-label="Related record type">
          <option value="">Nothing in particular</option>
          <option value="appointment">A lesson or appointment</option>
          <option value="event">An event</option>
          <option value="payment">An earlier payment</option>
          <option value="other">Something else</option>
        </select>
        {refType === "other" ? (
          <input name="referenceNote" defaultValue={invoice?.referenceNote ?? ""} maxLength={200} placeholder="What is this for?" className={input} />
        ) : refType ? (
          <input name="referenceId" defaultValue={invoice?.referenceId ?? ""} placeholder="Record id" className={input} />
        ) : null}
        <p className="text-xs text-slate-500">Linking a record is a reference only. It does not record or change any payment.</p>
      </fieldset>

      {state.error ? (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      ) : null}

      {readOnly ? null : (
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-[var(--brand-primary)] px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Saving..." : invoice ? "Save draft" : "Create draft"}
        </button>
      )}
    </form>
  );
}

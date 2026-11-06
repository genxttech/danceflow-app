import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authorizeClientInvoiceActor } from "@/lib/billing/clientInvoices/authorize";
import { CLIENT_INVOICE_STATUS_LABEL, formatCents, type ClientInvoiceStatus } from "@/lib/billing/clientInvoices/model";

type Row = { id: string; client_id: string; status: ClientInvoiceStatus; total_cents: number; line_count: number; created_at: string; updated_at: string };

export default async function ClientInvoicesPage() {
  const actor = await authorizeClientInvoiceActor("view");
  if (!actor) redirect("/app/payments");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studio_client_invoices")
    .select("id, client_id, status, total_cents, line_count, created_at, updated_at")
    .eq("studio_id", actor.studioId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error("Failed to load client invoices.");
  const rows = (data ?? []) as Row[];

  const clientIds = Array.from(new Set(rows.map((r) => r.client_id)));
  const names = new Map<string, string>();
  if (clientIds.length > 0) {
    const { data: clients } = await supabase.from("clients").select("id, first_name, last_name").eq("studio_id", actor.studioId).in("id", clientIds);
    for (const c of clients ?? []) names.set(c.id as string, `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Client");
  }

  return (
    <div className="space-y-8 p-1">
      <section className="rounded-[32px] border border-[var(--brand-border)] bg-white p-6 shadow-sm md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
          <Link href="/app/payments" className="underline">
            Payments
          </Link>{" "}
          / Client invoices
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">Client invoices</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
          One-time invoices from your studio to your clients. For now you can prepare drafts only: nothing is sent to a client and no payment link exists.
        </p>
        <div className="mt-4">
          <Link
            href="/app/payments/invoices/new"
            className="inline-flex rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white"
          >
            New draft
          </Link>
        </div>
      </section>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] p-5 text-sm text-slate-600">No client invoices yet.</div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const status = CLIENT_INVOICE_STATUS_LABEL[r.status] ?? { label: "Draft", detail: "" };
            return (
              <li key={r.id} className="rounded-2xl border border-[var(--brand-border)] bg-white p-4">
                <Link href={`/app/payments/invoices/${r.id}`} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-900">{names.get(r.client_id) ?? "Client"}</span>
                  <span className="text-sm text-slate-700">{formatCents(r.total_cents)}</span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">{status.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

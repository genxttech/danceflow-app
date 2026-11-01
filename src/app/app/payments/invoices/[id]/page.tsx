import Link from "next/link";
import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authorizeClientInvoiceActor } from "@/lib/billing/clientInvoices/authorize";
import { CLIENT_INVOICE_STATUS_LABEL, formatCents, isClientInvoiceCreationEnabled, isUuid, type ClientInvoiceStatus } from "@/lib/billing/clientInvoices/model";
import InvoiceEditor from "../InvoiceEditor";
import ProviderDraftControl from "./ProviderDraftControl";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> };

export default async function ClientInvoiceDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { saved } = await searchParams;
  if (!isUuid(id)) notFound();
  const viewer = await authorizeClientInvoiceActor("view");
  if (!viewer) redirect("/app/payments");
  const canEdit = (await authorizeClientInvoiceActor("draft")) !== null;

  const supabase = await createClient();
  const { data: inv } = await supabase
    .from("studio_client_invoices")
    .select("id, client_id, status, version, total_cents, reference_type, reference_id, reference_note")
    .eq("id", id)
    .eq("studio_id", viewer.studioId)
    .maybeSingle();
  if (!inv) notFound();
  const { data: lineRows } = await supabase
    .from("studio_client_invoice_lines")
    .select("position, description, quantity, unit_price_cents")
    .eq("invoice_id", id)
    .order("position");
  const { data: clientRows } = await supabase.from("clients").select("id, first_name, last_name").eq("studio_id", viewer.studioId).order("first_name").limit(1000);
  const clients = (clientRows ?? []).map((c) => ({ id: c.id as string, name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Unnamed client" }));

  const status = (inv.status as ClientInvoiceStatus) in CLIENT_INVOICE_STATUS_LABEL ? (inv.status as ClientInvoiceStatus) : "draft";
  const label = CLIENT_INVOICE_STATUS_LABEL[status];
  const editable = canEdit && status === "draft";

  return (
    <div className="space-y-8 p-1">
      <section className="rounded-[32px] border border-[var(--brand-border)] bg-white p-6 shadow-sm md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
          <Link href="/app/payments/invoices" className="underline">
            Client invoices
          </Link>{" "}
          / Invoice
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">
          {label.label} - {formatCents(Number(inv.total_cents))}
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">{label.detail}</p>
        {saved === "1" ? <p className="mt-3 text-sm font-medium text-emerald-700">Draft saved.</p> : null}
        {!editable ? <p className="mt-3 text-sm text-slate-600">This invoice cannot be edited{status !== "draft" ? " because it already exists at Stripe" : ""}.</p> : null}
      </section>

      <InvoiceEditor
        requestKey={randomUUID()}
        clients={clients}
        invoice={{
          id,
          version: Number(inv.version),
          clientId: inv.client_id as string,
          referenceType: (inv.reference_type as string | null) ?? null,
          referenceId: (inv.reference_id as string | null) ?? null,
          referenceNote: (inv.reference_note as string | null) ?? null,
        }}
        lines={(lineRows ?? []).map((l) => ({ description: l.description as string, quantity: Number(l.quantity), unitPriceCents: Number(l.unit_price_cents) }))}
        readOnly={!editable}
      />

      {status === "draft" ? <ProviderDraftControl invoiceId={id} requestKey={randomUUID()} canEdit={canEdit} creationEnabled={isClientInvoiceCreationEnabled()} /> : null}
    </div>
  );
}

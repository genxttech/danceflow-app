import Link from "next/link";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { authorizeClientInvoiceActor } from "@/lib/billing/clientInvoices/authorize";
import InvoiceEditor from "../InvoiceEditor";

export default async function NewClientInvoicePage() {
  const actor = await authorizeClientInvoiceActor("draft");
  if (!actor) redirect("/app/payments/invoices");

  const supabase = await createClient();
  const { data } = await supabase.from("clients").select("id, first_name, last_name").eq("studio_id", actor.studioId).order("first_name").limit(1000);
  const clients = (data ?? []).map((c) => ({ id: c.id as string, name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Unnamed client" }));

  return (
    <div className="space-y-8 p-1">
      <section className="rounded-[32px] border border-[var(--brand-border)] bg-white p-6 shadow-sm md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
          <Link href="/app/payments/invoices" className="underline">
            Client invoices
          </Link>{" "}
          / New draft
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">New draft invoice</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
          This saves a draft in DanceFlow. It is not sent to your client and has no payment link.
        </p>
      </section>
      <InvoiceEditor requestKey={randomUUID()} clients={clients} lines={[]} readOnly={false} />
    </div>
  );
}

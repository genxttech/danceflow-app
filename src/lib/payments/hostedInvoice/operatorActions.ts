"use server";

import { createClient } from "@/lib/supabase/server";
import { runOperatorAction, type OperatorAction, type OperatorResult } from "@/lib/payments/hostedInvoice/operator";

/**
 * D24 M2-B server actions. They run with the CALLER's session (user-scoped client, never the service role): the database derives the actor from
 * auth.uid(), checks the role and tenant, and requires aal2. Dark unless D24_OPERATOR_ACTIONS is "enabled". No UI is wired to these yet.
 * See docs/billing/D24-M2B-OPERATOR.md.
 */

async function run(action: OperatorAction, input: Record<string, unknown>): Promise<OperatorResult> {
  if (process.env.D24_OPERATOR_ACTIONS !== "enabled") return { ok: false, code: "disabled" };
  try {
    const supabase = await createClient();
    const { data: userData } = await supabase.auth.getUser();
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
    return await runOperatorAction(
      {
        env: process.env,
        nowSeconds: Math.floor(Date.now() / 1000),
        userId: userData.user?.id ?? null,
        claims: claimsError || !claimsData ? null : (claimsData.claims as Record<string, unknown>),
        rpc: (fn, args) => supabase.rpc(fn, args),
      },
      action,
      input,
    );
  } catch {
    return { ok: false, code: "unavailable" };
  }
}

export async function d24AcknowledgeAnomaliesAction(input: { invoiceRowId: string; codes: string[]; reason: string }) {
  return run("acknowledge", { invoiceRowId: input?.invoiceRowId, codes: input?.codes, reason: input?.reason });
}
export async function d24DismissUnmatchedAction(input: { invoiceRowId: string; reason: string }) {
  return run("dismiss", { invoiceRowId: input?.invoiceRowId, reason: input?.reason });
}
export async function d24RequeueDeferredAction(input: { providerEventId: string; reason: string }) {
  return run("requeue", { providerEventId: input?.providerEventId, reason: input?.reason });
}
export async function d24ListInvoicesAction(input: { state?: string; studioId?: string; includeDismissed?: boolean; limit?: number; offset?: number } = {}) {
  return run("list_invoices", { state: input?.state, studioId: input?.studioId, includeDismissed: input?.includeDismissed, limit: input?.limit, offset: input?.offset });
}
export async function d24GetInvoiceAction(input: { invoiceRowId: string }) {
  return run("get_invoice", { invoiceRowId: input?.invoiceRowId });
}
export async function d24ListDeferredAction(input: { state?: string; limit?: number; offset?: number } = {}) {
  return run("list_deferred", { state: input?.state, limit: input?.limit, offset: input?.offset });
}

import { CLIENT_INVOICE_BUSINESS_OBJECT_TYPE, formatCents } from "./model";

/**
 * D24 M3-C: trusted spec resolver for the M3-B creation orchestrator (its InvoiceSpecResolver type is structurally compatible; the resolver is wired
 * in a later, separately authorized package). Everything returned comes from DanceFlow records read by the SERVICE-ROLE client through
 * studio_client_invoice_creation_spec, which returns NULL for another studio's invoice, a non-draft, an inconsistent total or an out-of-limits total.
 * No request field reaches the invoice content. The Stripe customer is materialized from the studio's own client record (customerProfile).
 *
 * Not registered anywhere in this package: nothing can reach it.
 */
export const DEFAULT_DAYS_UNTIL_DUE = 30;

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
type ClientQuery = {
  select: (cols: string) => { eq: (c: string, v: string) => { eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> } } };
};

export type ClientInvoiceSpec = {
  customerProfile: { clientRef: string; name: string; email?: string | null };
  currency: string;
  daysUntilDue: number;
  lines: Array<{ description: string; amountCents: number }>;
};

type RawSpec = {
  invoice_id: string;
  client_id: string;
  currency: string;
  total_cents: number;
  lines: Array<{ description: string; quantity: number; unit_price_cents: number; line_total_cents: number }>;
};

export async function resolveClientInvoiceSpec(input: {
  supabase: { rpc: Rpc; from: (table: string) => ClientQuery };
  studioId: string;
  businessObjectId: string;
}): Promise<ClientInvoiceSpec | null> {
  const { data, error } = await input.supabase.rpc("studio_client_invoice_creation_spec", {
    p_invoice_id: input.businessObjectId,
    p_studio_id: input.studioId,
  });
  if (error || !data) return null;
  const raw = data as RawSpec;
  if (raw.invoice_id !== input.businessObjectId || !Array.isArray(raw.lines) || raw.lines.length === 0) return null;
  const { data: client } = await input.supabase
    .from("clients")
    .select("id, first_name, last_name, email")
    .eq("id", raw.client_id)
    .eq("studio_id", input.studioId)
    .maybeSingle();
  const c = client as { id: string; first_name: string | null; last_name: string | null; email: string | null } | null;
  if (!c) return null;
  const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
  if (!name) return null;
  const lines = raw.lines.map((l) => ({
    description: l.quantity > 1 ? `${l.description} (${l.quantity} x ${formatCents(l.unit_price_cents)})` : l.description,
    amountCents: l.line_total_cents,
  }));
  if (lines.reduce((n, l) => n + l.amountCents, 0) !== raw.total_cents) return null;
  return { customerProfile: { clientRef: c.id, name, email: c.email }, currency: raw.currency, daysUntilDue: DEFAULT_DAYS_UNTIL_DUE, lines };
}

export const CLIENT_INVOICE_SPEC_RESOLVERS = Object.freeze({ [CLIENT_INVOICE_BUSINESS_OBJECT_TYPE]: resolveClientInvoiceSpec });

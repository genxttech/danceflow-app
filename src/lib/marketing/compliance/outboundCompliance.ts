import type { createAdminClient } from "@/lib/supabase/admin";
import { escapeHtml, EMAIL_LEGAL_LINE } from "@/lib/email/brand";
import { extractSenderAddress, formatFrom } from "@/lib/email/sender";
import { buildListUnsubscribeHeaders, buildUnsubscribeLinks, isUnsubscribeToken } from "./unsubscribeLinks";

/**
 * Marketing M-0 (D1/D2): controls applied at the dispatch boundary to a COMMERCIAL queued email (outbound_deliveries)
 * before it reaches the provider. Commercial messages:
 *  - are refused for addresses unsubscribed from the studio's marketing or platform-suppressed (hard bounce/complaint);
 *    a suppression lookup that fails prevents the send;
 *  - go out from the marketing sender (not the transactional sender) with the studio's display name;
 *  - carry the studio's postal address, a per-message unsubscribe link and RFC 8058 one-click headers.
 * Operational messages never pass through here and are unaffected.
 */

export type MarketingSkipReason =
  | "marketing_unsubscribed"
  | "marketing_suppressed"
  | "marketing_invalid_recipient"
  | "marketing_footer_address_missing";

export type CommercialEmailDecision =
  | { action: "send"; from: string; html: string; text: string; headers: Record<string, string> }
  | { action: "skip"; reason: MarketingSkipReason }
  | { action: "fail"; error: string };

export type StudioPostalSettings = {
  name?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
};

const clean = (value: unknown) => String(value ?? "").trim();

/** Same completeness rule the studio campaign send uses (missing_marketing_footer). */
export function studioPostalAddress(studio: StudioPostalSettings | null | undefined) {
  if (
    !clean(studio?.name) ||
    !clean(studio?.address_line_1) ||
    !clean(studio?.city) ||
    !clean(studio?.state) ||
    !clean(studio?.postal_code) ||
    !clean(studio?.country)
  ) {
    return null;
  }
  return [
    clean(studio?.address_line_1),
    clean(studio?.address_line_2),
    [clean(studio?.city), clean(studio?.state), clean(studio?.postal_code)].filter(Boolean).join(", "),
    clean(studio?.country),
  ]
    .filter(Boolean)
    .join(" · ");
}

function complianceBlockHtml(params: { studioName: string; address: string; unsubscribeUrl: string }) {
  return (
    `<div data-df-marketing-compliance="1" style="margin:0 0 8px;">` +
    `<div style="margin:0 0 4px;">${escapeHtml(params.studioName)} · ${escapeHtml(params.address)}</div>` +
    `<div>You are receiving this because you are a client of ${escapeHtml(params.studioName)}. ` +
    `<a href="${escapeHtml(params.unsubscribeUrl)}" style="color:#6d28d9;text-decoration:underline;">Unsubscribe</a> ` +
    `from ${escapeHtml(params.studioName)} marketing emails.</div></div>`
  );
}

/**
 * Inserts the compliance block into an already-rendered branded email: immediately before the shell's legal line when
 * present (inside the footer, keeping the locked footer order), otherwise just before </body>, otherwise appended.
 */
export function injectComplianceFooter(html: string, block: string) {
  const legal = `<div>${escapeHtml(EMAIL_LEGAL_LINE)}</div>`;
  const at = html.lastIndexOf(legal);
  if (at >= 0) return html.slice(0, at) + block + html.slice(at);
  const body = html.toLowerCase().lastIndexOf("</body>");
  if (body >= 0) return html.slice(0, body) + block + html.slice(body);
  return html + block;
}

export function appendComplianceText(text: string, params: { studioName: string; address: string; unsubscribeUrl: string }) {
  return `${text.trimEnd()}\n\n${params.studioName} · ${params.address}\nUnsubscribe from ${params.studioName} marketing emails: ${params.unsubscribeUrl}`;
}

export async function prepareCommercialOutboundEmail(args: {
  admin: ReturnType<typeof createAdminClient>;
  deliveryId: string;
  studioId: string;
  recipientEmail: string;
  senderDisplayName: string | null;
  studio: StudioPostalSettings | null;
  studioDisplayName: string;
  html: string;
  text: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CommercialEmailDecision> {
  const env = args.env ?? process.env;
  const marketingAddress = extractSenderAddress(env.MARKETING_FROM_EMAIL);
  if (!marketingAddress) return { action: "fail", error: "marketing_sender_not_configured" };

  const address = studioPostalAddress(args.studio);
  if (!address) return { action: "skip", reason: "marketing_footer_address_missing" };

  const { data: status, error: statusError } = await args.admin.rpc("marketing_suppression_status", {
    p_scope_kind: "studio",
    p_scope_id: args.studioId,
    p_email: args.recipientEmail,
  });
  if (statusError || typeof status !== "string") return { action: "fail", error: "marketing_suppression_unavailable" };
  if (status === "unsubscribed") return { action: "skip", reason: "marketing_unsubscribed" };
  if (status === "suppressed") return { action: "skip", reason: "marketing_suppressed" };
  if (status !== "eligible") return { action: "skip", reason: "marketing_invalid_recipient" };

  const { data: token, error: tokenError } = await args.admin.rpc("marketing_issue_message_unsubscribe_token", {
    p_scope_kind: "studio",
    p_scope_id: args.studioId,
    p_email: args.recipientEmail,
    p_source_table: "outbound_deliveries",
    p_source_id: args.deliveryId,
  });
  if (tokenError || !isUnsubscribeToken(token)) return { action: "fail", error: "marketing_unsubscribe_token_unavailable" };

  const links = buildUnsubscribeLinks(token, "message", env);
  const footer = { studioName: args.studioDisplayName, address, unsubscribeUrl: links.pageUrl };

  let from: string;
  try {
    from = formatFrom(args.senderDisplayName ?? args.studioDisplayName, marketingAddress);
  } catch {
    return { action: "fail", error: "marketing_sender_not_configured" };
  }

  return {
    action: "send",
    from,
    html: injectComplianceFooter(args.html, complianceBlockHtml(footer)),
    text: appendComplianceText(args.text, footer),
    headers: buildListUnsubscribeHeaders(links.oneClickUrl),
  };
}

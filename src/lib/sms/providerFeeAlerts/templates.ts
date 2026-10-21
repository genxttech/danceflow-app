import { buildAppUrl } from "@/lib/email/brand";
import { renderDanceFlowSystemEmail } from "@/lib/notifications/email-branding";

/**
 * Operational email for an RFL alert. DanceFlow system mail (`platform_` keys: no studio reply-to). The body carries ONLY the alert's already-sanitized
 * summary, the studio name for an owner, and a link: never a Twilio SID, token, credential, amount, balance, provider cost or invoice reference.
 * Defense in depth: a summary that nevertheless looks sensitive is replaced by the kind's generic sentence.
 */
export const RFL_ALERT_KINDS = [
  "authorization_expiring", "owner_notice_second", "next_period_uncovered", "pilot_approval_needed", "funding_low", "negative_balance", "account_on_hold", "exposure_open",
  "provider_variance", "inventory_gap", "cancel_unknown", "cancelled_authorization_active", "charged_after_cancellation", "released_resource_active", "owner_unresponsive",
  "alert_delivery_exhausted",
] as const;
export type RflAlertKind = (typeof RFL_ALERT_KINDS)[number];

type Copy = { subject: string; heading: string; generic: string };
const COPY: Record<RflAlertKind, Copy> = {
  authorization_expiring: { subject: "Your texting authorization is ending soon", heading: "Texting authorization ending soon", generic: "Your recurring texting authorization is ending soon. Renew it in your texting settings to keep texting uninterrupted." },
  owner_notice_second: { subject: "Reminder: your texting authorization is ending", heading: "Texting authorization reminder", generic: "Your recurring texting authorization is still due to end and has not been renewed. Renew it in your texting settings." },
  next_period_uncovered: { subject: "Texting for the next period is not covered", heading: "Next period not covered", generic: "Texting for the next billing period is not covered yet. Open your texting settings to review it." },
  pilot_approval_needed: { subject: "Pilot approval needed", heading: "Pilot approval needed", generic: "A written approval is needed to cover the next pilot period." },
  funding_low: { subject: "Your texting credit is running low", heading: "Texting credit is low", generic: "Your texting credit is running low. Open your texting settings to review it." },
  negative_balance: { subject: "Your texting credit needs attention", heading: "Texting credit needs attention", generic: "Your texting credit account needs attention. Open your texting settings to review it." },
  account_on_hold: { subject: "Texting credit is on hold", heading: "Texting credit on hold", generic: "Texting credit is on hold, so recurring texting charges cannot run. Open your texting settings to review it." },
  exposure_open: { subject: "A texting provider fee needs review", heading: "Provider fee needs review", generic: "A provider fee for a texting resource is not covered and needs review." },
  provider_variance: { subject: "Provider charge differs from expectation", heading: "Provider charge variance", generic: "A recurring provider charge differs from what was expected and needs acknowledgement." },
  inventory_gap: { subject: "A texting resource is not being monitored", heading: "Texting resource not monitored", generic: "A texting resource is billed but not registered for monitoring. Register it before activating the studio." },
  cancel_unknown: { subject: "A cancellation outcome is unknown", heading: "Cancellation outcome unknown", generic: "A provider cancellation has an unknown outcome and needs reconciliation." },
  cancelled_authorization_active: { subject: "A cancelled resource still has an active authorization", heading: "Cancelled resource still authorized", generic: "A cancelled texting resource still has an active authorization and needs review." },
  charged_after_cancellation: { subject: "A provider charge arrived after cancellation", heading: "Charge after cancellation", generic: "The provider charged for a resource after its cancellation was confirmed. Open a dispute and record the outcome." },
  released_resource_active: { subject: "A released resource is still active", heading: "Released resource still active", generic: "A released texting resource is still active at the provider and needs review." },
  owner_unresponsive: { subject: "A studio owner has not renewed", heading: "Owner has not responded", generic: "A studio owner has not renewed an expiring recurring authorization after repeated notices." },
  alert_delivery_exhausted: { subject: "An alert could not be delivered", heading: "Alert delivery exhausted", generic: "An alert could not be delivered after repeated attempts and needs manual follow-up." },
};
const FALLBACK: Copy = { subject: "Texting provider fee notice", heading: "Texting provider fee notice", generic: "A texting provider fee notice needs your attention." };

const SENSITIVE = [
  /\b[A-Za-z]{2}[0-9a-fA-F]{32}\b/,
  /\$\s*\d/,
  /\d\s*\$/,
  /\b(?:cents?|token|balance|credential|password|secret|invoice|usd|dollars?)\b/i,
  /\bsk_(?:live|test)_/i,
];

export function isKnownRflAlertKind(kind: string): kind is RflAlertKind {
  return (RFL_ALERT_KINDS as readonly string[]).includes(kind);
}

export type RenderedRflEmail = { templateKey: string; subject: string; bodyText: string; bodyHtml: string };

function cleanLine(value: string, max: number) {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function sanitizeRflSummary(kind: string, summary: string) {
  const generic = (isKnownRflAlertKind(kind) ? COPY[kind] : FALLBACK).generic;
  const clean = cleanLine(String(summary ?? ""), 300);
  if (!clean || SENSITIVE.some((re) => re.test(clean))) return generic;
  return clean;
}

export function renderRflAlertEmail(params: { kind: string; summary: string; recipientKind: "owner" | "admin"; studioName?: string | null }): RenderedRflEmail {
  const known = isKnownRflAlertKind(params.kind);
  const copy = known ? COPY[params.kind as RflAlertKind] : FALLBACK;
  const summary = sanitizeRflSummary(params.kind, params.summary);
  const isOwner = params.recipientKind === "owner";
  const studioName = isOwner ? cleanLine(params.studioName ?? "", 80) : "";
  const actionUrl = buildAppUrl(isOwner ? "/app/settings/sms" : "/platform/sms");
  const actionLabel = isOwner ? "Open texting settings" : "Open the platform SMS page";
  const lines = [...(studioName ? [`Studio: ${studioName}`, ""] : []), summary];
  const bodyText = `${lines.join("\n")}\n\n${actionLabel}: ${actionUrl}`;
  const bodyHtml = renderDanceFlowSystemEmail({ previewText: copy.subject, eyebrow: "DanceFlow texting", heading: copy.heading, bodyText: lines.join("\n"), actionLabel, actionUrl });
  return { templateKey: known ? `platform_rfl_${params.kind}` : "platform_rfl_alert", subject: copy.subject, bodyText, bodyHtml };
}

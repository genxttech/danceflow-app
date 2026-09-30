/**
 * PAY-DC-3 sender identity (owner decision D2).
 *
 * Client-facing transactional email in a studio or organizer context is sent as
 * `"{Studio or Organizer public name} via DanceFlow" <notify@idanceflow.com>`. The sending address and
 * domain stay DanceFlow's and Reply-To is unchanged (the studio's operational address). Every other email
 * (staff, system, platform, SaaS, marketing) keeps the plain `DanceFlow` sender.
 *
 * The allowlist is explicit. Only the rule-driven automation / ARIA client email families are matched by
 * prefix, because their keys embed a rule key.
 */

import { resolveStudioDisplayName } from "@/lib/email/brand";
import { sanitizeSenderDisplayName } from "@/lib/email/sender";

export const CLIENT_FACING_TEMPLATE_KEYS: ReadonlySet<string> = new Set([
  "event_registration_confirmed",
  "event_registration_ticket_confirmation_resend",
  "event_registration_reminder_24h",
  "commerce_digital_purchase_confirmed",
  "appointment_confirmed",
  "appointment_rescheduled",
  "appointment_cancelled",
  "booking_request_received_client",
  "booking_request_approved_client",
  "booking_request_declined_client",
  "document_sign_request",
  "document_assignment",
  "document_signature_reminder",
  "document_due_soon_reminder",
  "document_overdue_reminder",
  "document_signing_completed_signer",
  "client_portal_invite",
  "student_lesson_reminder_24h",
  "student_lesson_reminder_2h",
]);

export const CLIENT_FACING_TEMPLATE_PREFIXES: readonly string[] = [
  "automation_",
  "aria_execution_",
];

export function isClientFacingTemplateKey(templateKey: string | null | undefined) {
  const key = String(templateKey ?? "");
  if (!key) return false;
  if (CLIENT_FACING_TEMPLATE_KEYS.has(key)) return true;
  return CLIENT_FACING_TEMPLATE_PREFIXES.some(
    (prefix) => key.startsWith(prefix) && key.length > prefix.length,
  );
}

/**
 * `{name} via DanceFlow`, where the name is the organizer's (organizer events) or else the studio's
 * `public_name` → `name`. Returns null when no safe name remains, so the caller keeps plain `DanceFlow`.
 */
export function resolveClientSenderDisplayName(params: {
  organizerName?: string | null;
  studio?: { public_name?: string | null; name?: string | null } | null;
}) {
  const organizer = sanitizeSenderDisplayName(params.organizerName);
  const studio = sanitizeSenderDisplayName(resolveStudioDisplayName(params.studio, ""));
  const name = organizer || studio;
  return name ? `${name} via DanceFlow` : null;
}

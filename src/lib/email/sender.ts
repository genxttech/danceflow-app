/**
 * BR-3 sender helpers. Pure and intentionally NOT wired into any live send path in BR-3A:
 * the actual From/Reply-To behavior is unchanged until the target sender is verified
 * (public DNS evidence plus owner confirmation in the Resend dashboard).
 */

import { EMAIL_CONTROL_CHAR_CLASS } from "@/lib/email/brand";

const NAME_UNSAFE_CHARS = new RegExp(`[${EMAIL_CONTROL_CHAR_CLASS}"<>\\\\]`, "g");

/** Target single transactional sender address. */
export const TRANSACTIONAL_FROM_ADDRESS = "notify@idanceflow.com";
export const TRANSACTIONAL_FROM_NAME = "DanceFlow";

const EMAIL_PATTERN = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

/** Mirrors `normalizeEmail` in `src/lib/notifications/outbound.ts`. */
export function normalizeReplyTo(value: string | null | undefined) {
  const email = value?.trim().toLowerCase() || null;
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** Mirrors `isDanceFlowSystemTemplate` in `src/lib/notifications/outbound.ts`. */
export function isSystemTemplateKey(templateKey: string) {
  return (
    templateKey.startsWith("platform_") ||
    templateKey.startsWith("danceflow_") ||
    templateKey === "welcome_to_danceflow" ||
    templateKey === "platform_admin_invite"
  );
}

/** `Display Name <address>`; the display name is stripped of control characters, quotes and angle brackets. */
export function formatFrom(
  name: string = TRANSACTIONAL_FROM_NAME,
  address: string = TRANSACTIONAL_FROM_ADDRESS,
) {
  const cleanAddress = address.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(cleanAddress)) {
    throw new Error("Invalid sender address.");
  }
  const cleanName = name
    .replace(NAME_UNSAFE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleanName ? `${cleanName} <${cleanAddress}>` : cleanAddress;
}

/** The target transactional From value (not used by any live sender yet). */
export const TRANSACTIONAL_FROM = formatFrom();

/**
 * Reply-To resolution with the same precedence as `outbound.ts`:
 * system templates never carry one; otherwise an explicit address, then the studio's own address.
 */
export function resolveReplyTo(params: {
  templateKey: string;
  explicit?: string | null;
  studioEmail?: string | null;
}) {
  if (isSystemTemplateKey(params.templateKey)) return null;
  return normalizeReplyTo(params.explicit) ?? normalizeReplyTo(params.studioEmail);
}

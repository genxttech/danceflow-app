/**
 * Sender helpers. `formatFrom` is the one From-header builder for transactional email (wired through
 * `resolveOutboundFromEmail` in `src/lib/notifications/outbound.ts` since PAY-DC-3); the Reply-To helpers
 * mirror the live outbound behavior.
 */

import { EMAIL_CONTROL_CHAR_CLASS } from "@/lib/email/brand";

// Control characters plus every RFC 5322 special that could close the quoted display name or split the
// address list: quotes, backslash, angle brackets, comma, semicolon, colon, @ and parentheses.
const NAME_UNSAFE_CHARS = new RegExp(`[${EMAIL_CONTROL_CHAR_CLASS}"<>\\\\,;:@()]`, "g");

const DISPLAY_NAME_MAX_LENGTH = 120;

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

/** Strips header-unsafe characters from a display name; returns "" when nothing usable remains. */
export function sanitizeSenderDisplayName(name: string | null | undefined) {
  const cleaned = String(name ?? "")
    .replace(NAME_UNSAFE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, DISPLAY_NAME_MAX_LENGTH).join("").trim();
}

/**
 * `"Display Name" <address>`. The display name is quoted after removing control characters and every
 * character that could break out of the quotes or split the address; an empty result falls back to
 * `DanceFlow`. The address must be a single plain mailbox.
 */
export function formatFrom(
  name: string = TRANSACTIONAL_FROM_NAME,
  address: string = TRANSACTIONAL_FROM_ADDRESS,
) {
  const cleanAddress = address.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(cleanAddress)) {
    throw new Error("Invalid sender address.");
  }
  const cleanName = sanitizeSenderDisplayName(name) || TRANSACTIONAL_FROM_NAME;
  return `"${cleanName}" <${cleanAddress}>`;
}

/** Extracts the mailbox from a configured From value (`Name <addr>`, `"Name" <addr>` or a bare address). */
export function extractSenderAddress(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const bracketed = raw.match(/<([^<>]+)>\s*$/);
  const candidate = (bracketed ? bracketed[1] : raw).trim().toLowerCase();
  return EMAIL_PATTERN.test(candidate) ? candidate : null;
}

/** The default transactional From value. */
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

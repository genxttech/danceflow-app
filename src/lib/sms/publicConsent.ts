import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { SMS_CONSENT_DISCLOSURE_VERSION, normalizeSmsPhone } from "@/lib/sms/compliance";

/**
 * A2P-1B: records explicit SMS consent given on an anonymous public studio form.
 *
 * Anonymous visitors cannot use the staff-only `upsert_sms_contact_permission` RPC, so
 * this server-only helper writes with the admin client. Every authoritative value
 * (studio, client, status, source, timestamp, disclosure version) is derived on the
 * server by the calling action; the browser only contributes whether `smsConsent=yes`.
 *
 * It never reverses an opt-out, never touches a different client's row, and never
 * attaches consent to a phone that differs from an existing client's stored phone.
 * A failure never blocks the lead/booking: it simply records no consent.
 */

export type PublicConsentForm = "public_lead_form" | "public_booking_form";

export type PublicConsentResult =
  | { recorded: true; action: "inserted" | "upgraded" }
  | {
      recorded: false;
      reason:
        | "unchecked"
        | "invalid_phone"
        | "phone_mismatch"
        | "opted_out"
        | "already_opted_in"
        | "duplicate"
        | "write_failed";
    };

export type PublicConsentInput = {
  /** Resolved server-side from the public studio slug (feature-enabled studios only). */
  studioId: string;
  /** The client row this action just created or resolved server-side. */
  clientId: string;
  /** True only when this action inserted the client row itself. */
  clientIsNew: boolean;
  /** Stored `clients.phone` for an existing client (ignored for new clients). */
  existingClientPhone?: string | null;
  /** Validated phone from the submitted form. */
  submittedPhone: string | null | undefined;
  /** `formData.get("smsConsent") === "yes"`. */
  consentChecked: boolean;
  form: PublicConsentForm;
};

type PermissionRow = {
  id: string;
  client_id: string | null;
  consent_status: string | null;
};

function failed(): PublicConsentResult {
  // Code-only log: no phone, name, studio, or provider detail.
  console.warn("sms_public_consent_write_failed");
  return { recorded: false, reason: "write_failed" };
}

export async function recordPublicFormSmsConsent(
  input: PublicConsentInput,
): Promise<PublicConsentResult> {
  if (!input.consentChecked) {
    return { recorded: false, reason: "unchecked" };
  }

  const phoneE164 = normalizeSmsPhone(input.submittedPhone ?? "");
  if (!phoneE164) {
    return { recorded: false, reason: "invalid_phone" };
  }

  if (!input.clientIsNew) {
    const storedPhone = normalizeSmsPhone(input.existingClientPhone ?? "");
    if (!storedPhone || storedPhone !== phoneE164) {
      return { recorded: false, reason: "phone_mismatch" };
    }
  }

  try {
    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from("sms_contact_permissions")
      .select("id, client_id, consent_status")
      .eq("studio_id", input.studioId)
      .eq("phone_e164", phoneE164);

    if (error) return failed();

    const rows = (data ?? []) as PermissionRow[];

    if (rows.some((row) => row.consent_status === "opted_out")) {
      return { recorded: false, reason: "opted_out" };
    }

    const now = new Date().toISOString();
    const evidence = {
      consent_status: "opted_in",
      consent_source: input.form,
      consent_at: now,
      consent_note: `disclosure=${SMS_CONSENT_DISCLOSURE_VERSION};form=${input.form}`,
      updated_by: null,
    };

    const existing = rows.find((row) => row.client_id === input.clientId) ?? null;

    if (existing) {
      if (existing.consent_status === "opted_in") {
        return { recorded: false, reason: "already_opted_in" };
      }

      // Only an "unknown" row may be upgraded; the status guard keeps a concurrent
      // opt-out from ever being overwritten.
      const { data: upgraded, error: updateError } = await supabase
        .from("sms_contact_permissions")
        .update({ ...evidence, updated_at: now })
        .eq("id", existing.id)
        .eq("consent_status", "unknown")
        .select("id");

      if (updateError) return failed();

      // Zero rows means the row changed concurrently; nothing was overwritten.
      if (!upgraded || upgraded.length === 0) {
        return { recorded: false, reason: "duplicate" };
      }

      return { recorded: true, action: "upgraded" };
    }

    const { error: insertError } = await supabase.from("sms_contact_permissions").insert({
      studio_id: input.studioId,
      client_id: input.clientId,
      phone_e164: phoneE164,
      ...evidence,
      created_by: null,
    });

    if (insertError) {
      // The partial unique index (studio_id, client_id, phone_e164) already holds a row.
      if ((insertError as { code?: string }).code === "23505") {
        return { recorded: false, reason: "duplicate" };
      }
      return failed();
    }

    return { recorded: true, action: "inserted" };
  } catch {
    return failed();
  }
}

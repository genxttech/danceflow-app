import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { SMS_CONSENT_DISCLOSURE_VERSION, normalizeSmsPhone } from "@/lib/sms/compliance";

/**
 * A2P-1B: records explicit SMS consent given on an anonymous public studio form.
 *
 * TW-2: the write goes through the canonical `record_sms_public_opt_in` database function
 * (service_role only), which checks the client belongs to the studio and appends the
 * consumer `public_opt_in` history event atomically with the consent row. Every
 * authoritative value (studio, client, source, timestamp, disclosure version) is derived on
 * the server; the browser only contributes whether `smsConsent=yes`.
 *
 * It never reverses an opt-out (any opt-out for the studio+phone wins, including a STOP
 * from a number that had no client yet), never touches a different client's row, and never
 * attaches consent to a phone that differs from an existing client's stored phone. A web
 * form cannot clear a consumer STOP: Twilio keeps that number blocked until the contact
 * texts START. A failure never blocks the lead/booking: it simply records no consent.
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

    const { data, error } = await supabase.rpc("record_sms_public_opt_in", {
      p_studio_id: input.studioId,
      p_client_id: input.clientId,
      p_phone_e164: phoneE164,
      p_source: input.form,
      p_note: `disclosure=${SMS_CONSENT_DISCLOSURE_VERSION};form=${input.form}`,
    });

    if (error) return failed();

    switch (data) {
      case "inserted":
      case "upgraded":
        return { recorded: true, action: data };
      case "opted_out":
      case "already_opted_in":
      case "duplicate":
        return { recorded: false, reason: data };
      default:
        return failed();
    }
  } catch {
    return failed();
  }
}

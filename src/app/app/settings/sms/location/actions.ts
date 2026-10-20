"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

/**
 * TW-4F: the studio OWNER attests that this location belongs to an existing legal business (an additional location). It creates a pending request
 * only; a platform admin verifies the association and decides. The database (`sms_location_attest`) re-checks that the caller owns this studio and
 * that the studio is not already linked; the request is never auto-approved, and the EIN is never asked for beyond its last four digits.
 */

const LOCATION_ATTESTATION_VERSION = "tw4f-location-v1";
const PATH = "/app/settings/sms/location";

export async function attestLocationAction(formData: FormData) {
  const context = await getCurrentStudioContext();
  const legalName = String(formData.get("legalName") ?? "").trim();
  const einLast4 = String(formData.get("einLast4") ?? "").trim();
  const back = (key: "sent" | "error", value: string): never => redirect(`${PATH}?${key}=${encodeURIComponent(value)}`);

  if (legalName.length < 2 || legalName.length > 200 || /[\u0000-\u001f\u007f]/.test(legalName)) back("error", "Enter the legal business name exactly as registered (2-200 characters).");
  if (!/^[0-9]{4}$/.test(einLast4)) back("error", "Enter only the last four digits of the business's EIN.");
  if (formData.get("attest") !== "on") back("error", "Confirm the attestation to send the request.");

  const supabase = await createClient();
  const { error } = (await supabase.rpc("sms_location_attest", {
    p_studio_id: context.studioId, p_claimed_legal_name: legalName, p_claimed_ein_last4: einLast4, p_attestation_version: LOCATION_ATTESTATION_VERSION,
  })) as { error: { code?: string } | null };
  if (error) {
    back("error",
      error.code === "42501" ? "Only the studio owner can send this request."
        : error.code === "23505" ? "This location already belongs to a legal business, or a request is already waiting for review."
          : "The request could not be sent. Nothing was changed.");
  }
  back("sent", "1");
}

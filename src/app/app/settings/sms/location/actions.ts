"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStudioSmsStatus } from "@/lib/sms/onboarding/client";
import { looksLikeEin } from "@/lib/sms/twilioIsv/panel";

/**
 * TW-4F: the studio OWNER attests that this location belongs to an existing legal business (an additional location). It creates a pending request
 * only; a platform admin verifies the association and decides. The pilot gate and the owner role are re-checked here (the page checks them too)
 * and again by the database (`sms_location_attest`: owner of this studio, studio not already linked, one pending request). Results come back as a
 * fixed code, never as text in the URL.
 */

const LOCATION_ATTESTATION_VERSION = "tw4f-location-v1";
const PATH = "/app/settings/sms/location";

export async function attestLocationAction(formData: FormData) {
  const context = await getCurrentStudioContext();
  const legalName = String(formData.get("legalName") ?? "").trim();
  const einLast4 = String(formData.get("einLast4") ?? "").trim();
  const back = (code: string): never => redirect(`${PATH}?result=${code}`);

  const supabase = await createClient();
  let allowed = false;
  try {
    const status = await getStudioSmsStatus(supabase, context.studioId);
    allowed = status.available && status.role === "studio_owner";
  } catch {
    allowed = false;
  }
  if (!allowed) back("not_owner");
  if (legalName.length < 2 || legalName.length > 200 || /[\u0000-\u001f\u007f]/.test(legalName) || looksLikeEin(legalName)) back("bad_name");
  if (!/^[0-9]{4}$/.test(einLast4)) back("bad_ein");
  if (formData.get("attest") !== "on") back("no_attest");

  const { error } = (await supabase.rpc("sms_location_attest", {
    p_studio_id: context.studioId, p_claimed_legal_name: legalName, p_claimed_ein_last4: einLast4, p_attestation_version: LOCATION_ATTESTATION_VERSION,
  })) as { error: { code?: string } | null };
  if (error) back(error.code === "42501" ? "not_owner" : error.code === "23505" ? "exists" : "failed");
  back("sent");
}

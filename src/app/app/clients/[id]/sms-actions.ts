"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { type SmsConsentStatus, upsertSmsConsent } from "@/lib/sms/compliance";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function canManageSmsConsent(role: string | null | undefined) {
  return ["studio_owner", "studio_admin", "front_desk"].includes(
    String(role ?? "").toLowerCase(),
  );
}

function validConsentStatus(value: string): SmsConsentStatus {
  if (value === "opted_in" || value === "opted_out" || value === "unknown") {
    return value;
  }

  return "unknown";
}

function clientMarketingPath(clientId: string) {
  return `/app/clients/${clientId}?tab=marketing`;
}

function withClientSmsMessage(
  clientId: string,
  params: {
    sms_consent?: string;
    sms_error?: string;
  },
) {
  const searchParams = new URLSearchParams();
  searchParams.set("tab", "marketing");

  if (params.sms_consent) {
    searchParams.set("sms_consent", params.sms_consent);
  }

  if (params.sms_error) {
    searchParams.set("sms_error", params.sms_error);
  }

  return `/app/clients/${clientId}?${searchParams.toString()}`;
}

export async function updateClientSmsConsentAction(formData: FormData) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;
  const studioRole = context.studioRole ?? "";

  const clientId = getString(formData, "clientId");
  const phoneRaw = getString(formData, "phone");
  const consentStatus = validConsentStatus(getString(formData, "consentStatus"));
  const consentNote = getString(formData, "consentNote");

  if (!clientId) {
    redirect(`/app/clients?error=${encodeURIComponent("Client not found.")}`);
  }

  if (!canManageSmsConsent(studioRole)) {
    redirect(
      withClientSmsMessage(clientId, {
        sms_error: "You do not have permission to update SMS consent.",
      }),
    );
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, studio_id")
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (clientError || !client) {
    redirect(
      withClientSmsMessage(clientId, {
        sms_error: "Client not found.",
      }),
    );
  }

  const result = await upsertSmsConsent(supabase, {
    studioId,
    clientId,
    phoneRaw,
    consentStatus,
    consentSource: "manual",
    consentNote: consentNote || null,
  });

  if (result.error) {
    redirect(
      withClientSmsMessage(clientId, {
        sms_error: result.error,
      }),
    );
  }

  revalidatePath(`/app/clients/${clientId}`);
  revalidatePath(clientMarketingPath(clientId));

  redirect(
    withClientSmsMessage(clientId, {
      sms_consent: "updated",
    }),
  );
}
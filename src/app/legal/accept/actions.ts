"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { startPaidPathAction } from "@/app/get-started/actions";
import { recordBusinessLegalAcceptance } from "@/lib/legal/agreements";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function getRequestAuditContext() {
  const headerStore = await headers();
  const forwardedFor =
    headerStore.get("x-forwarded-for") ??
    headerStore.get("x-real-ip") ??
    headerStore.get("cf-connecting-ip") ??
    headerStore.get("x-vercel-forwarded-for");

  return {
    ipAddress: forwardedFor
      ? forwardedFor.split(",")[0]?.trim().slice(0, 128) || null
      : null,
    userAgent: headerStore.get("user-agent")?.slice(0, 1000) ?? null,
  };
}

export async function acceptCurrentBusinessAgreementsAction(
  formData: FormData,
) {
  const legalAccepted = formData.get("legalAccepted") === "on";
  const intent = getString(formData, "intent") === "organizer"
    ? "organizer"
    : "studio";
  const planCode = getString(formData, "planCode");

  if (!legalAccepted) {
    redirect(
      `/legal/accept?intent=${encodeURIComponent(intent)}${
        planCode ? `&plan=${encodeURIComponent(planCode)}` : ""
      }&error=acceptance_required`,
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const auditContext = await getRequestAuditContext();

  await recordBusinessLegalAcceptance({
    supabase,
    userId: user.id,
    source: "business_reacceptance",
    intent,
    ipAddress: auditContext.ipAddress,
    userAgent: auditContext.userAgent,
  });

  const continuation = new FormData();
  continuation.set("intent", intent);
  if (planCode) continuation.set("planCode", planCode);

  await startPaidPathAction(continuation);
}

"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMyVerifiedEmail } from "@/lib/auth/verifiedIdentity";
import { ensurePortalProfileAndClientLinks, getAuthUserFullName } from "@/lib/auth/portal-linking";
import { checkRateLimit, getServerActionRateLimitKey } from "@/lib/security/rate-limit";
import { fetchPublicGroupClass, isUuid } from "@/lib/public/groupClasses";
import { canProceedToRegister, classRegisterPath } from "@/lib/public/classRegistration";
import { getStudioIdForPublicSlug } from "@/lib/public/classRegistrationData";

const CHECK_AGAIN_LIMIT = { limit: 5, windowMs: 10 * 60 * 1000 };

/*
  GC-3.4B-1 "Check again": re-runs ONLY the existing safe invitation claim
  (staff-issued invitations for the session's verified email, scoped to this
  class's studio). It never matches on clients.email, never creates anything,
  and its outcome is not reported: the page re-renders from the account's own
  relationships, so a failed, empty or ambiguous claim all look the same.
*/
export async function checkClassRegistrationLinkAction(formData: FormData) {
  const appointmentId = String(formData.get("appointmentId") ?? "").trim();
  if (!isUuid(appointmentId)) redirect("/discover/classes");

  const supabase = await createClient();

  // The class (and so its studio) is re-derived from the public read model;
  // the browser supplies only the appointment id.
  const item = await fetchPublicGroupClass(supabase, appointmentId);
  if (!item) redirect("/discover/classes");

  const registerPath = classRegisterPath(item.studioSlug, item.appointmentId);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?intent=public&next=${encodeURIComponent(registerPath)}`);
  }

  if (!canProceedToRegister(item)) redirect(registerPath);

  const verifiedEmail = await getMyVerifiedEmail(supabase);
  if (!verifiedEmail) redirect(registerPath);

  const limit = checkRateLimit(
    await getServerActionRateLimitKey("class-register:check-again", [user.id]),
    CHECK_AGAIN_LIMIT,
  );
  if (!limit.allowed) redirect(`${registerPath}?check=wait`);

  try {
    const studioId = await getStudioIdForPublicSlug(item.studioSlug);
    if (studioId) {
      // Contained: a claim failure never grants anything and is logged by the
      // helper as a bounded code only.
      await ensurePortalProfileAndClientLinks({
        userId: user.id,
        email: user.email,
        fullName: getAuthUserFullName(user),
        studioId,
        verifiedEmail,
      });
    }
  } catch {
    console.error("class_register_check_again_failed");
  }

  redirect(`${registerPath}?check=done`);
}

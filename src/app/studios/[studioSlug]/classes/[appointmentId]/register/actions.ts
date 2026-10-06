"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getMyVerifiedEmail } from "@/lib/auth/verifiedIdentity";
import { ensurePortalProfileAndClientLinks, getAuthUserFullName } from "@/lib/auth/portal-linking";
import { checkRateLimit, getServerActionRateLimitKey } from "@/lib/security/rate-limit";
import { fetchPublicGroupClass, isUuid } from "@/lib/public/groupClasses";
import {
  canProceedToRegister,
  classRegisterPath,
  parseRegistrationFundingChoice,
  resolveRegistrationDancer,
} from "@/lib/public/classRegistration";
import { getStudioIdForPublicSlug, listManageableDancers } from "@/lib/public/classRegistrationData";
import { classifySelfEnrollmentError } from "@/lib/schedule/selfEnrollmentErrors";
import { notifyGroupClassEnrolled, notifyStudioOfExternalGroupClassEnrollment } from "@/lib/notifications/groupClassNotices";

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

/*
  GC-3.4B-1: recovery for an account whose email is already bound but whose
  current session predates the binding (so my_verified_email() is still null
  for this session). Signing out this session and signing in again creates a
  session after the binding; nothing about the verified-email rule changes.
  The browser supplies only the appointment id; the return path is canonical.
*/
export async function signInAgainForClassAction(formData: FormData) {
  const appointmentId = String(formData.get("appointmentId") ?? "").trim();
  if (!isUuid(appointmentId)) redirect("/discover/classes");

  const supabase = await createClient();
  const item = await fetchPublicGroupClass(supabase, appointmentId);
  if (!item) redirect("/discover/classes");

  await supabase.auth.signOut({ scope: "local" });

  redirect(`/login?intent=public&next=${encodeURIComponent(classRegisterPath(item.studioSlug, item.appointmentId))}`);
}

/*
  GC-3.4C: join a public Group Class for an already-authorized dancer.

  The browser supplies only the appointment id, the dancer id and (when it
  had to choose) a "package:<id>" / "membership:<id>" funding choice.
  Everything else is re-derived here: the class and its studio from the
  public read model, the signed-in user, the verified identity, and the
  dancer from the account's own manageable relationships at that studio.

  The write is the existing authoritative self_enroll_class_attendee RPC,
  called on the USER session so auth.uid() drives its own authorization. It
  re-checks the relationship, public discoverability, the self-enrollment
  policy, the started-class guard, funding, capacity (locked trigger),
  cancellation and duplicates. Nothing here reserves or consumes credit.

  Notifications go out only for a NEW attendee id returned by a committed
  insert; both helpers are idempotent on that id and never throw. An
  "already enrolled" outcome is a success state with no notification.
*/
export async function enrollInClassAction(formData: FormData) {
  const appointmentId = String(formData.get("appointmentId") ?? "").trim();
  if (!isUuid(appointmentId)) redirect("/discover/classes");

  const supabase = await createClient();
  const item = await fetchPublicGroupClass(supabase, appointmentId);
  if (!item) redirect("/discover/classes");

  const registerPath = classRegisterPath(item.studioSlug, item.appointmentId);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?intent=public&next=${encodeURIComponent(registerPath)}`);
  }

  // Stale page for a class that can no longer proceed: show its current state.
  if (!canProceedToRegister(item)) redirect(registerPath);

  const verifiedEmail = await getMyVerifiedEmail(supabase);
  if (!verifiedEmail) redirect(registerPath);

  // The dancer must still be one of this account's own manageable dancers
  // at this class's studio; anything else selects nothing.
  const studioId = await getStudioIdForPublicSlug(item.studioSlug);
  if (!studioId) redirect(registerPath);
  // The dancer must be named explicitly (never inferred from "only one
  // dancer") and must be one of this account's own manageable dancers here.
  const requestedDancer = String(formData.get("dancer") ?? "").trim();
  if (!isUuid(requestedDancer)) redirect(registerPath);
  const dancers = await listManageableDancers({ userId: user.id, studioId });
  const resolution = resolveRegistrationDancer(dancers, requestedDancer);
  if (resolution.kind !== "ready") redirect(registerPath);

  const dancer = resolution.dancer;
  const dancerPath = classRegisterPath(item.studioSlug, item.appointmentId, dancer.clientId);
  const { clientPackageId, clientMembershipId } = parseRegistrationFundingChoice(
    String(formData.get("fundingChoice") ?? ""),
  );

  const { data: attendeeId, error } = await supabase.rpc("self_enroll_class_attendee", {
    p_appointment_id: item.appointmentId,
    p_client_id: dancer.clientId,
    p_client_package_id: clientPackageId,
    p_client_membership_id: clientMembershipId,
  });

  if (error) {
    const kind = classifySelfEnrollmentError(error.message);
    // Already enrolled is the idempotent success outcome: the page shows the
    // registered state from the database; nothing is sent again.
    if (kind === "already_enrolled") redirect(dancerPath);
    console.error("class_register_enroll_failed", { kind });
    redirect(`${dancerPath}&error=${kind}`);
  }

  if (typeof attendeeId === "string" && isUuid(attendeeId)) {
    // Post-commit only. Each helper is idempotent on the attendee id, logs
    // its own failures and never throws, so a delivery problem can never
    // undo or misreport the committed enrollment.
    try {
      await notifyGroupClassEnrolled({
        studioId,
        clientId: dancer.clientId,
        appointmentIds: [item.appointmentId],
        eventId: attendeeId,
        series: false,
        selfEnrolled: true,
      });
    } catch {
      console.error("class_register_dancer_notice_failed");
    }
    try {
      await notifyStudioOfExternalGroupClassEnrollment({ studioId, attendeeId });
    } catch {
      console.error("class_register_studio_notice_failed");
    }
  }

  redirect(dancerPath);
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { createClient } from "@/lib/supabase/server";
import {
  ensurePortalProfileAndClientLinks,
  getAuthUserFullName,
} from "@/lib/auth/portal-linking";

const REQUEST_TYPE_LABELS: Record<string, string> = {
  private_lesson: "Private lesson",
  coaching: "Coaching",
  group_class: "Group class question",
  makeup_lesson: "Make-up lesson",
  floor_rental: "Floor rental",
  scheduling_question: "Scheduling question",
};

const CONTACT_PREFERENCE_LABELS: Record<string, string> = {
  email: "Email me",
  phone: "Call me",
  text: "Text me, if I have opted in",
  portal: "Portal message or studio follow-up",
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function buildPortalLoginPath(studioSlug: string, error?: string) {
  const search = new URLSearchParams({
    intent: "public",
    next: `/portal/${studioSlug}`,
  });

  if (error) {
    search.set("error", error);
  }

  return `/login?${search.toString()}`;
}

function safePortalReturnTo(studioSlug: string, requestedReturnTo: string) {
  const fallback = `/portal/${encodeURIComponent(studioSlug)}`;

  if (!requestedReturnTo) return fallback;

  try {
    const normalized = decodeURIComponent(requestedReturnTo);

    if (normalized === `/portal/${studioSlug}`) {
      return fallback;
    }

    if (normalized.startsWith(`/portal/${studioSlug}?`)) {
      return fallback;
    }

    if (normalized === fallback || normalized.startsWith(`${fallback}?`)) {
      return fallback;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

export async function submitPortalBookingRequestAction(formData: FormData) {
  const studioSlug = getString(formData, "studioSlug");
  const requestedReturnTo = getString(formData, "returnTo");
  const returnTo = safePortalReturnTo(studioSlug, requestedReturnTo);
  const requestType = getString(formData, "requestType") || "private_lesson";
  const contactPreference = getString(formData, "contactPreference") || "email";
  const preferredTimes = getString(formData, "preferredTimes");
  const notes = getString(formData, "notes");

  try {
    if (!studioSlug || !preferredTimes) {
      redirect(appendQueryParam(returnTo, "error", "booking-request-failed"));
    }

    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      redirect(buildPortalLoginPath(studioSlug));
    }

    const { data: studio, error: studioError } = await supabase
      .from("studios")
      .select("id, name, slug, public_name")
      .eq("slug", studioSlug)
      .single();

    if (studioError || !studio) {
      redirect(buildPortalLoginPath(studioSlug, "portal-studio-not-found"));
    }

    let clientId: string | null = null;

    const { data: linkedClient, error: linkedClientError } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email")
      .eq("studio_id", studio.id)
      .eq("portal_user_id", user.id)
      .maybeSingle();

    if (linkedClientError) {
      throw linkedClientError;
    }

    if (linkedClient?.id) {
      clientId = linkedClient.id;
    } else if (user.email) {
      await ensurePortalProfileAndClientLinks({
        userId: user.id,
        email: user.email,
        fullName: getAuthUserFullName(user),
        studioId: studio.id,
      });

      const { data: repairedClient, error: repairedClientError } = await supabase
        .from("clients")
        .select("id")
        .eq("studio_id", studio.id)
        .eq("portal_user_id", user.id)
        .maybeSingle();

      if (repairedClientError) {
        throw repairedClientError;
      }

      clientId = repairedClient?.id ?? null;
    }

    if (!clientId) {
      redirect(appendQueryParam(returnTo, "error", "booking-request-failed"));
    }

    const typeLabel = REQUEST_TYPE_LABELS[requestType] ?? "Scheduling request";
    const preferenceLabel =
      CONTACT_PREFERENCE_LABELS[contactPreference] ?? "Studio follow-up";
    const noteParts = [
      `Portal booking request: ${typeLabel}`,
      `Preferred days/times: ${preferredTimes}`,
      `Contact preference: ${preferenceLabel}`,
      notes ? `Notes: ${notes}` : null,
    ].filter(Boolean);

    const { error: requestError } = await supabase.from("booking_requests").insert({
      studio_id: studio.id,
      client_id: clientId,
      source: "client_portal_request",
      status: "pending",
      requested_starts_at: null,
    });

    if (requestError) {
      throw requestError;
    }

    const { error: activityError } = await supabase.from("lead_activities").insert({
      studio_id: studio.id,
      client_id: clientId,
      activity_type: "booking_request",
      note: noteParts.join("\n"),
      follow_up_due_at: new Date().toISOString(),
      completed_at: null,
    });

    if (activityError) {
      console.error("portal booking request activity unavailable", activityError.message);
    }

    revalidatePath(`/portal/${studioSlug}`);
    revalidatePath("/app/leads");
    revalidatePath("/app/schedule");

    redirect(appendQueryParam(returnTo, "booking", "request-sent"));
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    console.error("portal booking request failed", error);
    redirect(appendQueryParam(returnTo, "error", "booking-request-failed"));
  }
}

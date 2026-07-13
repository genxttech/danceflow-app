"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { createClient } from "@/lib/supabase/server";
import { resolvePortalRelationship } from "@/lib/student-identity/portal-context";
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

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const REQUEST_TYPES = new Set(Object.keys(REQUEST_TYPE_LABELS));
const CONTACT_PREFERENCES = new Set(Object.keys(CONTACT_PREFERENCE_LABELS));

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function cleanText(value: string, maxLength: number) {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeSlug(value: string) {
  const slug = cleanText(value, 80);
  return SLUG_PATTERN.test(slug) ? slug : "";
}

function normalizeRequestType(value: string) {
  const requestType = cleanText(value, 80) || "private_lesson";
  return REQUEST_TYPES.has(requestType) ? requestType : "private_lesson";
}

function normalizeContactPreference(value: string) {
  const preference = cleanText(value, 80) || "email";
  return CONTACT_PREFERENCES.has(preference) ? preference : "email";
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
  const studioSlug = normalizeSlug(getString(formData, "studioSlug"));
  const requestedReturnTo = getString(formData, "returnTo");
  const returnTo = safePortalReturnTo(studioSlug, requestedReturnTo);
  const requestType = normalizeRequestType(getString(formData, "requestType"));
  const contactPreference = normalizeContactPreference(getString(formData, "contactPreference"));
  const preferredTimes = cleanText(getString(formData, "preferredTimes"), 500);
  const notes = cleanText(getString(formData, "notes"), 2000);
  const requestedClientId = getString(formData, "clientId") || null;

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

    let relationship = await resolvePortalRelationship({
      userId: user.id,
      studioId: studio.id,
      requestedClientId,
      permission: "can_manage_bookings",
    });

    if (!relationship && user.email) {
      await ensurePortalProfileAndClientLinks({
        userId: user.id,
        email: user.email,
        fullName: getAuthUserFullName(user),
        studioId: studio.id,
      });

      relationship = await resolvePortalRelationship({
        userId: user.id,
        studioId: studio.id,
        requestedClientId,
        permission: "can_manage_bookings",
      });
    }

    if (!relationship) {
      redirect(appendQueryParam(returnTo, "error", "booking-request-failed"));
    }

    const clientId = relationship.clientId;
    const { data: linkedClient, error: linkedClientError } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email, phone")
      .eq("studio_id", studio.id)
      .eq("id", clientId)
      .maybeSingle();

    if (linkedClientError || !linkedClient) {
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
      appointment_type: requestType,
      title: `${typeLabel} request from ${linkedClient ? `${linkedClient.first_name ?? ""} ${linkedClient.last_name ?? ""}`.trim() || "portal student" : "portal student"}`,
      requested_starts_at: null,
      requested_ends_at: null,
      customer_first_name: linkedClient?.first_name ?? null,
      customer_last_name: linkedClient?.last_name ?? null,
      customer_email: linkedClient?.email ?? user.email ?? null,
      customer_phone: linkedClient?.phone ?? null,
      dance_interests: preferenceLabel,
      notes: noteParts.join("\n"),
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

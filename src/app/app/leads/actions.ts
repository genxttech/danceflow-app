"use server";

import { redirect } from "next/navigation";
import { requireClientEditAccess } from "@/lib/auth/serverRoleGuard";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function getLeadSuccessRedirect(
  formData: FormData,
  fallback: string,
  successCode: string
) {
  const returnTo = getString(formData, "returnTo");
  return appendQueryParam(returnTo || fallback, "success", successCode);
}

function getLeadErrorRedirect(
  formData: FormData,
  fallback: string,
  errorCode: string
) {
  const returnTo = getString(formData, "returnTo");
  return appendQueryParam(returnTo || fallback, "error", errorCode);
}

export async function convertLeadToActiveAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const fallbackUrl = "/app/leads";

  try {
    const { supabase, studioId } = await requireClientEditAccess();

    if (!clientId) {
      redirect(getLeadErrorRedirect(formData, fallbackUrl, "lead_update_failed"));
    }

    const { error } = await supabase
      .from("clients")
      .update({ status: "active" })
      .eq("id", clientId)
      .eq("studio_id", studioId)
      .eq("status", "lead");

    if (error) {
      redirect(getLeadErrorRedirect(formData, fallbackUrl, "lead_update_failed"));
    }

    redirect(getLeadSuccessRedirect(formData, fallbackUrl, "lead_converted"));
  } catch {
    redirect(getLeadErrorRedirect(formData, fallbackUrl, "unknown"));
  }
}

export async function archiveLeadAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const fallbackUrl = "/app/leads";

  try {
    const { supabase, studioId } = await requireClientEditAccess();

    if (!clientId) {
      redirect(getLeadErrorRedirect(formData, fallbackUrl, "lead_update_failed"));
    }

    const { error } = await supabase
      .from("clients")
      .update({ status: "archived" })
      .eq("id", clientId)
      .eq("studio_id", studioId)
      .eq("status", "lead");

    if (error) {
      redirect(getLeadErrorRedirect(formData, fallbackUrl, "lead_update_failed"));
    }

    redirect(getLeadSuccessRedirect(formData, fallbackUrl, "lead_archived"));
  } catch {
    redirect(getLeadErrorRedirect(formData, fallbackUrl, "unknown"));
  }
}
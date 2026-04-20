"use server";

import { createClient } from "@/lib/supabase/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { canEditClients } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

async function getEditableStudioContext(returnTo: string) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!canEditClients(role)) {
    redirect(appendQueryParam(returnTo, "error", "unauthorized"));
  }

  return { supabase, studioId, role };
}

async function getStudioClientOrRedirect(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  clientId: string;
  returnTo: string;
}) {
  const { supabase, studioId, clientId, returnTo } = params;

  const { data: client, error } = await supabase
    .from("clients")
    .select(`
  id,
  studio_id,
  first_name,
  last_name,
  email,
  is_independent_instructor,
  linked_instructor_id,
  portal_user_id
`)
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .single();

  if (error || !client) {
    redirect(appendQueryParam(returnTo, "error", "client_not_found"));
  }

  return client;
}

export async function updateIndependentInstructorSettingsAction(
  formData: FormData
) {
  const clientId = getString(formData, "clientId");
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}`;
  const linkedInstructorIdRaw = getString(formData, "linkedInstructorId");
  const isIndependentInstructor = formData.get("isIndependentInstructor") === "on";

  if (!clientId) {
    redirect(appendQueryParam("/app/clients", "error", "missing_client"));
  }

  const { supabase, studioId } = await getEditableStudioContext(returnTo);
  const linkedInstructorId = linkedInstructorIdRaw || null;

  await getStudioClientOrRedirect({
    supabase,
    studioId,
    clientId,
    returnTo,
  });

  if (linkedInstructorId) {
    const { data: instructor, error: instructorError } = await supabase
      .from("instructors")
      .select("id, studio_id")
      .eq("id", linkedInstructorId)
      .eq("studio_id", studioId)
      .single();

    if (instructorError || !instructor) {
      redirect(
        appendQueryParam(returnTo, "error", "invalid_linked_instructor")
      );
    }
  }

  const { error: updateError } = await supabase
    .from("clients")
    .update({
      is_independent_instructor: isIndependentInstructor,
      linked_instructor_id: isIndependentInstructor ? linkedInstructorId : null,
    })
    .eq("id", clientId)
    .eq("studio_id", studioId);

  if (updateError) {
    redirect(
      appendQueryParam(returnTo, "error", "independent_instructor_update_failed")
    );
  }

  redirect(
    appendQueryParam(returnTo, "success", "independent_instructor_updated")
  );
}

export async function linkPartnerAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const partnerClientId = getString(formData, "partnerClientId");
  const relationshipType = getString(formData, "relationshipType") || "partner";
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}`;

  if (!clientId || !partnerClientId) {
    redirect(appendQueryParam(returnTo, "error", "missing_partner_client"));
  }

  if (clientId === partnerClientId) {
    redirect(appendQueryParam(returnTo, "error", "partner_same_as_client"));
  }

  if (!["partner", "spouse"].includes(relationshipType)) {
    redirect(appendQueryParam(returnTo, "error", "invalid_relationship_type"));
  }

  const { supabase, studioId } = await getEditableStudioContext(returnTo);

  const { data: clients, error: clientsError } = await supabase
    .from("clients")
    .select("id")
    .eq("studio_id", studioId)
    .in("id", [clientId, partnerClientId]);

  if (clientsError || !clients || clients.length !== 2) {
    redirect(appendQueryParam(returnTo, "error", "partner_client_not_found"));
  }

  const normalizedClientId =
    clientId < partnerClientId ? clientId : partnerClientId;
  const normalizedPartnerClientId =
    clientId < partnerClientId ? partnerClientId : clientId;

  const { error: deleteExistingError } = await supabase
    .from("client_relationships")
    .delete()
    .eq("studio_id", studioId)
    .or(
      `and(client_id.eq.${normalizedClientId},related_client_id.eq.${normalizedPartnerClientId}),and(client_id.eq.${normalizedPartnerClientId},related_client_id.eq.${normalizedClientId})`
    )
    .in("relationship_type", ["partner", "spouse"]);

  if (deleteExistingError) {
    redirect(appendQueryParam(returnTo, "error", "partner_link_failed"));
  }

  const { error: insertError } = await supabase
    .from("client_relationships")
    .insert({
      studio_id: studioId,
      client_id: normalizedClientId,
      related_client_id: normalizedPartnerClientId,
      relationship_type: relationshipType,
    });

  if (insertError) {
    redirect(appendQueryParam(returnTo, "error", "partner_link_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "partner_linked"));
}

export async function unlinkPartnerAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const partnerClientId = getString(formData, "partnerClientId");
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}`;

  if (!clientId || !partnerClientId) {
    redirect(appendQueryParam(returnTo, "error", "missing_partner_client"));
  }

  const { supabase, studioId } = await getEditableStudioContext(returnTo);

  const { error: deleteError } = await supabase
    .from("client_relationships")
    .delete()
    .eq("studio_id", studioId)
    .or(
      `and(client_id.eq.${clientId},related_client_id.eq.${partnerClientId}),and(client_id.eq.${partnerClientId},related_client_id.eq.${clientId})`
    )
    .in("relationship_type", ["partner", "spouse"]);

  if (deleteError) {
    redirect(appendQueryParam(returnTo, "error", "partner_unlink_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "partner_unlinked"));
}

export async function linkPortalAccessAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}`;

  if (!clientId) {
    redirect(appendQueryParam("/app/clients", "error", "missing_client"));
  }

  const { supabase, studioId } = await getEditableStudioContext(returnTo);

  const client = await getStudioClientOrRedirect({
    supabase,
    studioId,
    clientId,
    returnTo,
  });

  const email = client.email?.trim().toLowerCase();

  if (!email) {
    redirect(appendQueryParam(returnTo, "error", "portal_email_required"));
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, email")
    .eq("email", email)
    .maybeSingle();

  if (profileError) {
    redirect(appendQueryParam(returnTo, "error", "portal_lookup_failed"));
  }

  if (!profile) {
    redirect(appendQueryParam(returnTo, "error", "portal_account_not_found"));
  }

  const { error: updateError } = await supabase
    .from("clients")
    .update({
      portal_user_id: profile.id,
    })
    .eq("id", client.id)
    .eq("studio_id", studioId);

  if (updateError) {
    redirect(appendQueryParam(returnTo, "error", "portal_link_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "portal_linked"));
}

export async function unlinkPortalAccessAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}`;

  if (!clientId) {
    redirect(appendQueryParam("/app/clients", "error", "missing_client"));
  }

  const { supabase, studioId } = await getEditableStudioContext(returnTo);

  await getStudioClientOrRedirect({
    supabase,
    studioId,
    clientId,
    returnTo,
  });

  const { error: updateError } = await supabase
    .from("clients")
    .update({
      portal_user_id: null,
    })
    .eq("id", clientId)
    .eq("studio_id", studioId);

  if (updateError) {
    redirect(appendQueryParam(returnTo, "error", "portal_unlink_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "portal_unlinked"));
}

export async function sendPortalInviteAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}`;

  if (!clientId) {
    redirect(appendQueryParam("/app/clients", "error", "missing_client"));
  }

  const { supabase, studioId } = await getEditableStudioContext(returnTo);

  const client = await getStudioClientOrRedirect({
    supabase,
    studioId,
    clientId,
    returnTo,
  });

  const email = client.email?.trim().toLowerCase();

  if (!email) {
    redirect(appendQueryParam(returnTo, "error", "portal_email_required"));
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, slug")
    .eq("id", studioId)
    .single();

  if (studioError || !studio?.slug) {
    redirect(appendQueryParam(returnTo, "error", "portal_invite_failed"));
  }

   const configuredBaseUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim();

  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const proto = headerStore.get("x-forwarded-proto") ?? "http";

  const fallbackBaseUrl = host ? `${proto}://${host}` : "http://localhost:3000";
  const baseUrl = configuredBaseUrl || fallbackBaseUrl;

  const nextPath = `/portal/${encodeURIComponent(studio.slug)}`;

  const fullName =
  `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || undefined;

const { error: otpError } = await supabase.auth.signInWithOtp({
  email,
  options: {
    shouldCreateUser: true,
    emailRedirectTo: `${baseUrl}/callback?next=${encodeURIComponent(nextPath)}`,
    data: {
      full_name: fullName,
    },
  },
});

  if (otpError) {
    redirect(appendQueryParam(returnTo, "error", "portal_invite_failed"));
  }

  redirect(appendQueryParam(returnTo, "success", "portal_invite_sent"));
}
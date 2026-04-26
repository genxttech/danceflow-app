"use server";

import { createClient } from "@/lib/supabase/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { canEditClients } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { revalidatePath } from "next/cache";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function appendQueryParam(url: string, key: string, value: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${key}=${encodeURIComponent(value)}`;
}

function redirectWithResult(
  returnTo: string,
  kind: "success" | "error",
  code: string
): never {
  redirect(appendQueryParam(returnTo, kind, code));
}

async function getEditableStudioContext(returnTo: string) {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!canEditClients(role)) {
    redirectWithResult(returnTo, "error", "unauthorized");
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
    redirectWithResult(returnTo, "error", "client_not_found");
  }

  return client;
}

async function deactivateHostWorkspaceIndependentInstructorRole(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  userId: string | null | undefined;
}) {
  const { supabase, studioId, userId } = params;

  if (!userId) return;

  const { error } = await supabase
    .from("user_studio_roles")
    .update({
      active: false,
    })
    .eq("studio_id", studioId)
    .eq("user_id", userId)
    .eq("role", "independent_instructor");

  if (error) {
    throw new Error(error.message);
  }
}

async function activateIndependentInstructorPortalClient(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  clientId: string;
}) {
  const { supabase, studioId, clientId } = params;

  const { error } = await supabase
    .from("clients")
    .update({
      status: "active",
      is_independent_instructor: true,
    })
    .eq("id", clientId)
    .eq("studio_id", studioId)
    .eq("is_independent_instructor", true);

  if (error) {
    throw new Error(error.message);
  }
}

async function getBaseUrl() {
  const configuredBaseUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, "");
  }

  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const proto = headerStore.get("x-forwarded-proto") ?? "http";

  if (host) {
    return `${proto}://${host}`;
  }

  return "http://localhost:3000";
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

  const client = await getStudioClientOrRedirect({
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
      redirectWithResult(returnTo, "error", "invalid_linked_instructor");
    }
  }

  const clientStatusUpdate =
    isIndependentInstructor && client.portal_user_id ? { status: "active" } : {};

  const { error: updateError } = await supabase
    .from("clients")
    .update({
      is_independent_instructor: isIndependentInstructor,
      linked_instructor_id: isIndependentInstructor ? linkedInstructorId : null,
      ...clientStatusUpdate,
    })
    .eq("id", clientId)
    .eq("studio_id", studioId);

  if (updateError) {
    redirectWithResult(returnTo, "error", "independent_instructor_update_failed");
  }

  try {
    await deactivateHostWorkspaceIndependentInstructorRole({
      supabase,
      studioId,
      userId: client.portal_user_id,
    });
  } catch {
    redirectWithResult(returnTo, "error", "independent_instructor_update_failed");
  }

  redirectWithResult(returnTo, "success", "independent_instructor_updated");
}

export async function linkPartnerAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const partnerClientId = getString(formData, "partnerClientId");
  const relationshipType = getString(formData, "relationshipType") || "partner";
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}`;

  if (!clientId || !partnerClientId) {
    redirectWithResult(returnTo, "error", "missing_partner_client");
  }

  if (clientId === partnerClientId) {
    redirectWithResult(returnTo, "error", "partner_same_as_client");
  }

  if (!["partner", "spouse"].includes(relationshipType)) {
    redirectWithResult(returnTo, "error", "invalid_relationship_type");
  }

  const { supabase, studioId } = await getEditableStudioContext(returnTo);

  const { data: clients, error: clientsError } = await supabase
    .from("clients")
    .select("id")
    .eq("studio_id", studioId)
    .in("id", [clientId, partnerClientId]);

  if (clientsError || !clients || clients.length !== 2) {
    redirectWithResult(returnTo, "error", "partner_client_not_found");
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
    redirectWithResult(returnTo, "error", "partner_link_failed");
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
    redirectWithResult(returnTo, "error", "partner_link_failed");
  }

  redirectWithResult(returnTo, "success", "partner_linked");
}

export async function unlinkPartnerAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const partnerClientId = getString(formData, "partnerClientId");
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}`;

  if (!clientId || !partnerClientId) {
    redirectWithResult(returnTo, "error", "missing_partner_client");
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
    redirectWithResult(returnTo, "error", "partner_unlink_failed");
  }

  redirectWithResult(returnTo, "success", "partner_unlinked");
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
    redirectWithResult(returnTo, "error", "portal_email_required");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, email")
    .eq("email", email)
    .maybeSingle();

  if (profileError) {
    redirectWithResult(returnTo, "error", "portal_lookup_failed");
  }

  if (!profile) {
    redirectWithResult(returnTo, "error", "portal_account_not_found");
  }

  const portalActivationUpdate = client.is_independent_instructor
    ? { portal_user_id: profile.id, status: "active" }
    : { portal_user_id: profile.id };

  const { error: updateError } = await supabase
    .from("clients")
    .update(portalActivationUpdate)
    .eq("id", client.id)
    .eq("studio_id", studioId);

  if (updateError) {
    redirectWithResult(returnTo, "error", "portal_link_failed");
  }

  try {
    await deactivateHostWorkspaceIndependentInstructorRole({
      supabase,
      studioId,
      userId: profile.id,
    });
  } catch {
    redirectWithResult(returnTo, "error", "portal_link_failed");
  }

  redirectWithResult(returnTo, "success", "portal_linked");
}

export async function unlinkPortalAccessAction(formData: FormData) {
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

  try {
    await deactivateHostWorkspaceIndependentInstructorRole({
      supabase,
      studioId,
      userId: client.portal_user_id,
    });
  } catch {
    redirectWithResult(returnTo, "error", "portal_unlink_failed");
  }

  const { error: updateError } = await supabase
    .from("clients")
    .update({
      portal_user_id: null,
    })
    .eq("id", clientId)
    .eq("studio_id", studioId);

  if (updateError) {
    redirectWithResult(returnTo, "error", "portal_unlink_failed");
  }

  redirectWithResult(returnTo, "success", "portal_unlinked");
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
    redirectWithResult(returnTo, "error", "portal_email_required");
  }

  if (client.portal_user_id) {
    try {
      await deactivateHostWorkspaceIndependentInstructorRole({
        supabase,
        studioId,
        userId: client.portal_user_id,
      });

      if (client.is_independent_instructor) {
        await activateIndependentInstructorPortalClient({
          supabase,
          studioId,
          clientId: client.id,
        });
      }
    } catch {
      redirectWithResult(returnTo, "error", "portal_invite_failed");
    }
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, slug")
    .eq("id", studioId)
    .single();

  if (studioError || !studio?.slug) {
    redirectWithResult(returnTo, "error", "portal_invite_failed");
  }

  const baseUrl = await getBaseUrl();
  const nextPath = `/portal/${encodeURIComponent(studio.slug)}`;
  const fullName =
    `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || undefined;

  const { error: otpError } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${baseUrl}/callback?next=${encodeURIComponent(
        nextPath
      )}`,
      data: {
        full_name: fullName,
      },
    },
  });

  if (otpError) {
    redirectWithResult(returnTo, "error", "portal_invite_failed");
  }

  if (client.is_independent_instructor) {
    const { error: statusUpdateError } = await supabase
      .from("clients")
      .update({ status: "active" })
      .eq("id", client.id)
      .eq("studio_id", studioId);

    if (statusUpdateError) {
      redirectWithResult(returnTo, "error", "portal_invite_failed");
    }
  }

  redirectWithResult(returnTo, "success", "portal_invite_sent");
}

// Add this import near the top of src/app/app/clients/[id]/actions.ts if it is not already there:
// import { revalidatePath } from "next/cache";

function packageUsageUnitLabel(usageType: string, quantity: number) {
  const isSingular = Math.abs(quantity) === 1;

  if (usageType === "private_lesson") {
    return isSingular ? "private lesson credit" : "private lesson credits";
  }

  if (usageType === "group_class") {
    return isSingular ? "group class credit" : "group class credits";
  }

  if (usageType === "practice_party") {
    return isSingular ? "practice party credit" : "practice party credits";
  }

  return isSingular ? "package credit" : "package credits";
}

export async function adjustLessonCountCorrectionAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const packageItemId = getString(formData, "packageItemId");
  const correctionType = getString(formData, "correctionType");
  const quantityRaw = getString(formData, "quantity");
  const reason = getString(formData, "reason");
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}`;

  if (!clientId || !packageItemId || !correctionType || !quantityRaw || !reason) {
    redirectWithResult(returnTo, "error", "package_correction_missing_fields");
  }

  if (!["add", "debit"].includes(correctionType)) {
    redirectWithResult(returnTo, "error", "package_correction_invalid_type");
  }

  const quantity = Number.parseInt(quantityRaw, 10);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    redirectWithResult(returnTo, "error", "package_correction_invalid_quantity");
  }

  const { supabase, studioId } = await getEditableStudioContext(returnTo);

  const { data: packageItem, error: packageItemError } = await supabase
    .from("client_package_items")
    .select(`
      id,
      studio_id,
      client_package_id,
      usage_type,
      quantity_total,
      quantity_used,
      quantity_remaining,
      is_unlimited,
      client_packages!inner (
        id,
        client_id,
        name_snapshot
      )
    `)
    .eq("id", packageItemId)
    .eq("studio_id", studioId)
    .eq("client_packages.client_id", clientId)
    .maybeSingle();

  if (packageItemError || !packageItem) {
    redirectWithResult(returnTo, "error", "package_correction_package_not_found");
  }

  if (packageItem.is_unlimited) {
    redirectWithResult(returnTo, "error", "package_correction_unlimited_package");
  }

  const currentTotal = Number(packageItem.quantity_total ?? 0);
  const currentUsed = Number(packageItem.quantity_used ?? 0);
  const currentRemaining = Number(packageItem.quantity_remaining ?? 0);

  let nextTotal = currentTotal;
  let nextUsed = currentUsed;
  let nextRemaining = currentRemaining;
  const signedDelta = correctionType === "add" ? quantity : -quantity;

  if (correctionType === "add") {
    nextTotal = currentTotal + quantity;
    nextRemaining = currentRemaining + quantity;
  } else {
    if (currentRemaining - quantity < 0) {
      redirectWithResult(returnTo, "error", "package_correction_negative_balance");
    }

    nextUsed = currentUsed + quantity;
    nextRemaining = currentRemaining - quantity;
  }

  const { error: updateError } = await supabase
    .from("client_package_items")
    .update({
      quantity_total: nextTotal,
      quantity_used: nextUsed,
      quantity_remaining: nextRemaining,
    })
    .eq("id", packageItemId)
    .eq("studio_id", studioId);

  if (updateError) {
    redirectWithResult(returnTo, "error", "package_correction_update_failed");
  }

  const packageRelation = Array.isArray(packageItem.client_packages)
    ? packageItem.client_packages[0]
    : packageItem.client_packages;

  const directionLabel = correctionType === "add" ? "Added" : "Debited";
  const packageName = packageRelation?.name_snapshot ?? "Package";
  const unitLabel = packageUsageUnitLabel(packageItem.usage_type, quantity);

  const { data: userData } = await supabase.auth.getUser();

  const { error: ledgerError } = await supabase
    .from("lesson_transactions")
    .insert({
      studio_id: studioId,
      client_id: clientId,
      client_package_id: packageItem.client_package_id,
      transaction_type: "manual_adjustment",
      lessons_delta: signedDelta,
      balance_after: nextRemaining,
      notes: `${directionLabel} ${quantity} ${unitLabel} for ${packageName}. Reason: ${reason}`,
      created_by: userData.user?.id ?? null,
    });

  if (ledgerError) {
    redirectWithResult(returnTo, "error", "package_correction_ledger_failed");
  }

  revalidatePath(`/app/clients/${clientId}`);
  revalidatePath("/app/packages/client-balances");

  redirectWithResult(returnTo, "success", "package_correction_saved");
}


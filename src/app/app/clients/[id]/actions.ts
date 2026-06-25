"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Resend } from "resend";
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

type PortalProfileLink = {
  id: string;
  email: string | null;
};

async function findOrCreatePortalProfileByEmail(params: {
  email: string;
  fullName?: string | null;
}) {
  const email = params.email.trim().toLowerCase();
  const fullName = params.fullName?.trim() || null;
  const adminSupabase = createAdminClient();

  const { data: existingProfiles, error: profileLookupError } = await adminSupabase
    .from("profiles")
    .select("id, email")
    .ilike("email", email)
    .limit(1);

  if (profileLookupError) {
    throw profileLookupError;
  }

  const existingProfile = (existingProfiles?.[0] as PortalProfileLink | undefined) ?? null;

  if (existingProfile?.id) {
    return existingProfile;
  }

  const { data: authUsers, error: authLookupError } = await adminSupabase
    .schema("auth")
    .from("users")
    .select("id, email")
    .ilike("email", email)
    .limit(1);

  if (authLookupError) {
    throw authLookupError;
  }

  const authUser = (authUsers?.[0] as { id: string; email: string | null } | undefined) ?? null;

  if (!authUser?.id) {
    return null;
  }

  const { data: createdProfile, error: profileUpsertError } = await adminSupabase
    .from("profiles")
    .upsert(
      {
        id: authUser.id,
        email: authUser.email ?? email,
        full_name: fullName,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    )
    .select("id, email")
    .single();

  if (profileUpsertError) {
    throw profileUpsertError;
  }

  return createdProfile as PortalProfileLink;
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


function getOutboundFromEmail() {
  return (
    process.env.NOTIFICATION_FROM_EMAIL ||
    process.env.OUTBOUND_EMAIL_FROM ||
    "DanceFlow <notify@idanceflow.com>"
  );
}

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY.");
  }

  return new Resend(apiKey);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendClientPortalInviteEmail(params: {
  to: string;
  actionLink: string;
  clientName?: string;
  studioName?: string | null;
  studioLogoUrl?: string | null;
  portalUrl: string;
  isIndependentInstructor?: boolean;
}) {
  const to = params.to.trim().toLowerCase();

  if (!to) {
    throw new Error("Missing portal invite recipient.");
  }

  const greetingName = params.clientName?.trim() || "there";
  const studioName = params.studioName?.trim() || "your studio";
  const studioLogoUrl = params.studioLogoUrl?.trim() || "";
  const isIndependentInstructor = params.isIndependentInstructor === true;

  const portalRoleLabel = isIndependentInstructor
    ? "instructor portal"
    : "student portal";

  const portalDescription = isIndependentInstructor
    ? "view your schedule, manage floor-rental activity, and stay connected with the studio"
    : "view your lessons, packages, payments, and studio updates";

  const from = getOutboundFromEmail();
  const resend = getResendClient();

  const subject = `${studioName} invited you to join their DanceFlow ${
    isIndependentInstructor ? "instructor" : "student"
  } portal`;

  const text = [
    `Hi ${greetingName},`,
    "",
    `${studioName} invited you to access your DanceFlow ${portalRoleLabel}.`,
    "",
    `Through your portal, you can ${portalDescription}.`,
    "",
    "Use this secure link to accept the invite and go directly to your portal:",
    params.actionLink,
    "",
    "If the button does not work, copy and paste the link above into your browser.",
    "",
    `This invite was sent by ${studioName} through DanceFlow.`,
  ].join("\n");

  const logoHtml = studioLogoUrl
    ? `<div style="margin: 0 0 14px;"><img src="${escapeHtml(
        studioLogoUrl
      )}" alt="${escapeHtml(
        studioName
      )} logo" style="display: block; max-height: 72px; max-width: 220px; object-fit: contain; border-radius: 12px; background: white; padding: 6px;" /></div>`
    : "";

  const html = `
    <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6; max-width: 640px; margin: 0 auto;">
      <div style="padding: 24px; border-radius: 24px; background: linear-gradient(135deg, #2e1065 0%, #4c1d95 52%, #f97316 100%); color: white;">
        ${logoHtml}
        <p style="margin: 0 0 8px; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.82;">DanceFlow Portal Invite</p>
        <h1 style="margin: 0; font-size: 28px; line-height: 1.2;">${escapeHtml(
          studioName
        )} invited you to their ${escapeHtml(portalRoleLabel)}</h1>
      </div>

      <div style="padding: 24px;">
        <p>Hi ${escapeHtml(greetingName)},</p>
        <p><strong>${escapeHtml(
          studioName
        )}</strong> invited you to access your DanceFlow ${escapeHtml(
          portalRoleLabel
        )}.</p>
        <p>Through your portal, you can ${escapeHtml(portalDescription)}.</p>

        <p style="margin: 28px 0;">
          <a href="${escapeHtml(
            params.actionLink
          )}" style="display: inline-block; background: #4c1d95; color: white; text-decoration: none; padding: 13px 20px; border-radius: 14px; font-weight: 700;">
            Accept Invite
          </a>
        </p>

        <div style="border: 1px solid #e2e8f0; background: #f8fafc; border-radius: 16px; padding: 14px 16px; margin: 24px 0;">
          <p style="margin: 0; font-size: 14px; color: #475569;">
            This invite was sent by <strong>${escapeHtml(
              studioName
            )}</strong> through DanceFlow so you can access the studio portal they set up for you.
          </p>
        </div>

        <p style="font-size: 13px; color: #64748b;">
          If the button does not work, copy and paste this secure link into your browser:<br />
          <a href="${escapeHtml(params.actionLink)}">${escapeHtml(
            params.actionLink
          )}</a>
        </p>

        <p style="margin-top: 28px; color: #64748b; font-size: 13px;">
          DanceFlow helps studios manage scheduling, client portals, payments, and communication.
        </p>
      </div>
    </div>
  `;

  const response = await resend.emails.send({
    from,
    to: [to],
    subject,
    text,
    html,
  });

  if (response.error) {
    throw new Error(response.error.message || "Portal invite email send failed.");
  }

  return {
    providerMessageId: response.data?.id ?? null,
    subject,
  };
}

async function recordPortalInviteDelivery(params: {
  studioId: string;
  clientId: string;
  recipientEmail: string;
  subject: string;
  status: "sent" | "failed";
  providerMessageId?: string | null;
  errorMessage?: string | null;
}) {
  const adminSupabase = createAdminClient();
  const now = new Date().toISOString();

  await adminSupabase.from("outbound_deliveries").insert({
    studio_id: params.studioId,
    channel: "email",
    template_key: "client_portal_invite",
    recipient_email: params.recipientEmail,
    subject: params.subject,
    body_text: "Client portal invite email.",
    related_table: "clients",
    related_id: params.clientId,
    status: params.status,
    provider_message_id: params.providerMessageId ?? null,
    error_message: params.errorMessage ?? null,
    sent_at: params.status === "sent" ? now : null,
    updated_at: now,
  });
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

  const fullName = `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim();

  let profile: PortalProfileLink | null = null;

  try {
    profile = await findOrCreatePortalProfileByEmail({
      email,
      fullName,
    });
  } catch {
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
    .select("id, name, public_name, public_logo_url, slug")
    .eq("id", studioId)
    .single();

  if (studioError || !studio?.slug) {
    redirectWithResult(returnTo, "error", "portal_invite_failed");
  }

  const baseUrl = await getBaseUrl();
  const nextPath = `/portal/${encodeURIComponent(studio.slug)}`;
  const redirectTo = `${baseUrl}/callback?next=${encodeURIComponent(nextPath)}`;
  const portalUrl = `${baseUrl}${nextPath}`;
  const fullName =
    `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || undefined;

  try {
    const adminSupabase = createAdminClient();

    const { data: magicLinkData, error: magicLinkError } =
      await adminSupabase.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: {
          redirectTo,
          data: {
            full_name: fullName,
            signup_intent: "public",
            portal_invite: true,
            invited_studio_id: studioId,
            invited_client_id: client.id,
          },
        },
      });

    if (magicLinkError) {
      throw magicLinkError;
    }

    const tokenHash = magicLinkData.properties?.hashed_token;
    const actionLink = tokenHash
      ? `${baseUrl}/callback?token_hash=${encodeURIComponent(
          tokenHash
        )}&type=magiclink&next=${encodeURIComponent(nextPath)}`
      : magicLinkData.properties?.action_link;

    if (!actionLink) {
      throw new Error("Supabase did not return a portal invite action link.");
    }

    const inviteResult = await sendClientPortalInviteEmail({
      to: email,
      actionLink,
      clientName: fullName,
      studioName: studio.public_name || studio.name,
      studioLogoUrl: studio.public_logo_url,
      portalUrl,
      isIndependentInstructor: client.is_independent_instructor === true,
    });

    await recordPortalInviteDelivery({
      studioId,
      clientId: client.id,
      recipientEmail: email,
      subject: inviteResult.subject,
      status: "sent",
      providerMessageId: inviteResult.providerMessageId,
    }).catch((deliveryError) => {
      console.error("Failed to record portal invite delivery", deliveryError);
    });
  } catch (error) {
    await recordPortalInviteDelivery({
      studioId,
      clientId: client.id,
      recipientEmail: email,
      subject: `DanceFlow portal invite for ${fullName || email}`,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Portal invite email send failed.",
    }).catch((deliveryError) => {
      console.error("Failed to record portal invite delivery failure", deliveryError);
    });

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

  revalidatePath(returnTo);
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


type AccountLedgerEntryConfig = {
  entryType: string;
  direction: "credit" | "debit";
};

function getAccountLedgerEntryConfig(entryKind: string): AccountLedgerEntryConfig | null {
  const map: Record<string, AccountLedgerEntryConfig> = {
    credit_added: { entryType: "credit_added", direction: "credit" },
    floor_fee_credit: { entryType: "floor_fee_credit", direction: "credit" },
    refund_credit: { entryType: "refund_credit", direction: "credit" },
    charge_added: { entryType: "charge_added", direction: "debit" },
    floor_fee_charge: { entryType: "floor_fee_charge", direction: "debit" },
    lesson_charge: { entryType: "lesson_charge", direction: "debit" },
    manual_adjustment_credit: { entryType: "manual_adjustment", direction: "credit" },
    manual_adjustment_debit: { entryType: "manual_adjustment", direction: "debit" },
    reversal_credit: { entryType: "reversal", direction: "credit" },
    reversal_debit: { entryType: "reversal", direction: "debit" },
  };

  return map[entryKind] ?? null;
}

export async function addClientAccountLedgerEntryAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const entryKind = getString(formData, "entryKind");
  const amountRaw = getString(formData, "amount");
  const entryDate = getString(formData, "entryDate");
  const description = getString(formData, "description");
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}`;

  if (!clientId || !entryKind || !amountRaw || !entryDate || !description) {
    redirectWithResult(returnTo, "error", "account_ledger_missing_fields");
  }

  const config = getAccountLedgerEntryConfig(entryKind);

  if (!config) {
    redirectWithResult(returnTo, "error", "account_ledger_invalid_type");
  }

  const amount = Number.parseFloat(amountRaw);

  if (!Number.isFinite(amount) || amount <= 0) {
    redirectWithResult(returnTo, "error", "account_ledger_invalid_amount");
  }

  const { supabase, studioId } = await getEditableStudioContext(returnTo);

  await getStudioClientOrRedirect({
    supabase,
    studioId,
    clientId,
    returnTo,
  });

  const { data: userData } = await supabase.auth.getUser();

  const { error } = await supabase.from("client_account_ledger").insert({
    studio_id: studioId,
    client_id: clientId,
    entry_date: entryDate,
    entry_type: config.entryType,
    direction: config.direction,
    amount,
    description,
    created_by: userData.user?.id ?? null,
  });

  if (error) {
    redirectWithResult(returnTo, "error", "account_ledger_save_failed");
  }

  revalidatePath(`/app/clients/${clientId}`);

  redirectWithResult(returnTo, "success", "account_ledger_entry_saved");
}


export async function assignSyllabusTemplateToClientAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const templateId = getString(formData, "templateId");
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}?tab=syllabus`;

  if (!clientId || !templateId) {
    redirectWithResult(returnTo, "error", "syllabus_assignment_missing");
  }

  const { supabase, studioId } = await getEditableStudioContext(returnTo);

  const [{ data: client }, { data: template, error: templateError }] = await Promise.all([
    supabase.from("clients").select("id").eq("id", clientId).eq("studio_id", studioId).single(),
    supabase
      .from("syllabus_templates")
      .select("id, studio_id")
      .eq("id", templateId)
      .eq("studio_id", studioId)
      .eq("active", true)
      .single(),
  ]);

  if (!client || templateError || !template) {
    redirectWithResult(returnTo, "error", "syllabus_assignment_not_found");
  }

  const { data: existingAssignment } = await supabase
    .from("client_syllabus_assignments")
    .select("id, archived_at")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("syllabus_template_id", templateId)
    .maybeSingle();

  let assignmentId = existingAssignment?.id ?? "";

  if (existingAssignment?.id) {
    const { error } = await supabase
      .from("client_syllabus_assignments")
      .update({
        archived_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingAssignment.id)
      .eq("studio_id", studioId);

    if (error) redirectWithResult(returnTo, "error", "syllabus_assignment_failed");
  } else {
    const { data: createdAssignment, error } = await supabase
      .from("client_syllabus_assignments")
      .insert({
        studio_id: studioId,
        client_id: clientId,
        syllabus_template_id: templateId,
        visible_in_portal: false,
      })
      .select("id")
      .single();

    if (error || !createdAssignment) {
      redirectWithResult(returnTo, "error", "syllabus_assignment_failed");
    }

    assignmentId = createdAssignment.id;
  }

  const { data: templateItems } = await supabase
    .from("syllabus_template_items")
    .select("id")
    .eq("studio_id", studioId)
    .eq("template_id", templateId)
    .eq("active", true);

  if (assignmentId && templateItems && templateItems.length > 0) {
    await supabase.from("client_syllabus_progress").upsert(
      templateItems.map((item) => ({
        studio_id: studioId,
        client_id: clientId,
        assignment_id: assignmentId,
        template_item_id: item.id,
        status: "not_started",
      })),
      { onConflict: "assignment_id,template_item_id", ignoreDuplicates: true },
    );
  }

  revalidatePath(`/app/clients/${clientId}`);
  redirectWithResult(returnTo, "success", "syllabus_assigned");
}

export async function updateClientSyllabusProgressAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const assignmentId = getString(formData, "assignmentId");
  const templateItemId = getString(formData, "templateItemId");
  const status = getString(formData, "status") || "not_started";
  const notes = getString(formData, "notes");
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}?tab=syllabus`;

  const allowedStatuses = new Set([
    "not_started",
    "introduced",
    "practicing",
    "comfortable",
    "mastered",
  ]);

  if (!clientId || !assignmentId || !templateItemId || !allowedStatuses.has(status)) {
    redirectWithResult(returnTo, "error", "syllabus_progress_missing");
  }

  const { supabase, studioId } = await getEditableStudioContext(returnTo);

  const { data: assignment } = await supabase
    .from("client_syllabus_assignments")
    .select("id")
    .eq("id", assignmentId)
    .eq("client_id", clientId)
    .eq("studio_id", studioId)
    .is("archived_at", null)
    .single();

  if (!assignment) {
    redirectWithResult(returnTo, "error", "syllabus_assignment_not_found");
  }

  const { data: userData } = await supabase.auth.getUser();

  const { error } = await supabase.from("client_syllabus_progress").upsert(
    {
      studio_id: studioId,
      client_id: clientId,
      assignment_id: assignmentId,
      template_item_id: templateItemId,
      status,
      notes: notes || null,
      updated_by: userData.user?.id ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "assignment_id,template_item_id" },
  );

  if (error) {
    redirectWithResult(returnTo, "error", "syllabus_progress_save_failed");
  }

  revalidatePath(`/app/clients/${clientId}`);
  redirectWithResult(returnTo, "success", "syllabus_progress_saved");
}

export async function removeClientSyllabusAssignmentAction(formData: FormData) {
  const clientId = getString(formData, "clientId");
  const assignmentId = getString(formData, "assignmentId");
  const returnTo = getString(formData, "returnTo") || `/app/clients/${clientId}?tab=syllabus`;

  if (!clientId || !assignmentId) {
    redirectWithResult(returnTo, "error", "syllabus_assignment_missing");
  }

  const { supabase, studioId } = await getEditableStudioContext(returnTo);

  const { error } = await supabase
    .from("client_syllabus_assignments")
    .update({
      archived_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", assignmentId)
    .eq("client_id", clientId)
    .eq("studio_id", studioId);

  if (error) {
    redirectWithResult(returnTo, "error", "syllabus_assignment_remove_failed");
  }

  revalidatePath(`/app/clients/${clientId}`);
  redirectWithResult(returnTo, "success", "syllabus_assignment_removed");
}


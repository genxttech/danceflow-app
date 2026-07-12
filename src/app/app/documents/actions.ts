"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { requireStudioFeature } from "@/lib/billing/access";
import { sendMobilePushToUser } from "@/lib/notifications/expoPush";
import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOCUMENT_FILES_BUCKET, sourceStoragePath } from "@/lib/documents/signing";
import { getPdfPageSizes, sha256Hex } from "@/lib/documents/pdf";
import { renderTemplateVersionPdf } from "@/lib/documents/template-pdf";

export type DocumentActionState = {
  error?: string;
  success?: string;
};

type DocumentScope = "studio" | "organizer";

type OrganizerOption = {
  id: string;
  name: string | null;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getBool(formData: FormData, key: string) {
  return formData.get(key) === "on" || formData.get(key) === "true";
}

function cleanText(value: string, maxLength: number) {
  return value.replace(/\s+$/g, "").slice(0, maxLength);
}

async function getCurrentUserId() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return { supabase, userId: user.id };
}

function canManageDocuments(role: string | null | undefined) {
  const value = (role ?? "").toLowerCase();

  return [
    "studio_owner",
    "studio_admin",
    "owner",
    "admin",
    "front_desk",
    "organizer_owner",
    "organizer_admin",
    "organizer_staff",
  ].includes(value);
}

async function getOrganizerOptions(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  studioId: string;
}) {
  const { supabase, userId, studioId } = params;

  const { data: organizerUsers } = await supabase
    .from("organizer_users")
    .select("organizer_id, role, active")
    .eq("user_id", userId)
    .eq("active", true);

  const organizerIds = Array.from(
    new Set(
      (organizerUsers ?? [])
        .map((row) => String(row.organizer_id ?? ""))
        .filter(Boolean),
    ),
  );

  if (!organizerIds.length) return [] satisfies OrganizerOption[];

  const { data: organizers } = await supabase
    .from("organizers")
    .select("id, name, studio_id, active")
    .in("id", organizerIds)
    .eq("active", true);

  return (organizers ?? [])
    .filter(
      (organizer) => !organizer.studio_id || organizer.studio_id === studioId,
    )
    .map((organizer) => ({
      id: String(organizer.id),
      name: typeof organizer.name === "string" ? organizer.name : "Organizer",
    }));
}

async function resolveOwnerContext(formData: FormData) {
  const { supabase, userId } = await getCurrentUserId();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const studioRole = context.studioRole ?? "";

  if (!canManageDocuments(studioRole)) {
    return {
      error: "You do not have permission to manage documents.",
    } as const;
  }

  const requestedScope =
    getString(formData, "scope") === "organizer" ? "organizer" : "studio";
  const organizerId = getString(formData, "organizerId");

  await requireStudioFeature(
    requestedScope === "organizer" ? "event_waivers" : "documents",
  );

  if (requestedScope === "organizer") {
    const organizers = await getOrganizerOptions({
      supabase,
      userId,
      studioId,
    });
    const organizer =
      organizers.find((option) => option.id === organizerId) ?? organizers[0];

    if (!organizer) {
      return {
        error: "Choose an organizer before creating organizer documents.",
      } as const;
    }

    return {
      supabase,
      userId,
      studioId,
      scope: "organizer" as DocumentScope,
      organizerId: organizer.id,
    };
  }

  return {
    supabase,
    userId,
    studioId,
    scope: "studio" as DocumentScope,
    organizerId: null as string | null,
  };
}

export async function createDocumentTemplateAction(
  formData: FormData,
): Promise<void> {
  const owner = await resolveOwnerContext(formData);

  if ("error" in owner) {
    redirect(
      `/app/documents?error=${encodeURIComponent(owner.error ?? "Unable to manage documents.")}`,
    );
  }

  const title = cleanText(getString(formData, "title"), 160);
  const description = cleanText(getString(formData, "description"), 500);
  const body = cleanText(getString(formData, "body"), 20000);
  const defaultConsentText = cleanText(getString(formData, "defaultConsentText"), 1000);
  const documentType = getString(formData, "documentType") || "waiver";
  const appliesTo = getString(formData, "appliesTo") || "manual";

  if (!title) {
    redirect("/app/documents?error=missing_title");
  }

  if (!body || body.length < 20) {
    redirect("/app/documents?error=missing_body");
  }

  const payload = {
    studio_id: owner.scope === "studio" ? owner.studioId : null,
    organizer_id: owner.scope === "organizer" ? owner.organizerId : null,
    scope: owner.scope,
    document_type: documentType,
    title,
    description: description || null,
    body,
    default_consent_text: defaultConsentText || null,
    applies_to: appliesTo,
    requires_signature: getBool(formData, "requiresSignature"),
    is_required: getBool(formData, "isRequired"),
    is_active: true,
    current_version: 1,
    created_by: owner.userId,
    updated_by: owner.userId,
  };

  const { data: template, error } = await owner.supabase
    .from("document_templates")
    .insert(payload)
    .select("id")
    .single();

  if (error || !template) {
    redirect(
      `/app/documents?error=${encodeURIComponent(error?.message ?? "Could not save the document template.")}`,
    );
  }

  const { data: version, error: versionError } = await owner.supabase
    .from("document_template_versions")
    .insert({
      template_id: template.id,
      version_number: 1,
      title,
      description: description || null,
      body,
      requires_signature: payload.requires_signature,
      is_required: payload.is_required,
      consent_text: defaultConsentText || null,
      created_by: owner.userId,
      published_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (versionError || !version) {
    redirect(
      `/app/documents?error=${encodeURIComponent(versionError?.message ?? "Could not create the template version.")}`,
    );
  }

  const { error: currentVersionError } = await owner.supabase
    .from("document_templates")
    .update({ current_version_id: version.id })
    .eq("id", template.id);

  if (currentVersionError) {
    redirect(
      `/app/documents?error=${encodeURIComponent(currentVersionError.message)}`,
    );
  }

  revalidatePath("/app/documents");
  redirect("/app/documents?success=created");
}

export async function updateDocumentTemplateAction(
  formData: FormData,
): Promise<void> {
  const owner = await resolveOwnerContext(formData);

  if ("error" in owner) {
    redirect(
      `/app/documents?error=${encodeURIComponent(owner.error ?? "Unable to manage documents.")}`,
    );
  }

  const templateId = getString(formData, "templateId");
  const title = cleanText(getString(formData, "title"), 160);
  const description = cleanText(getString(formData, "description"), 500);
  const body = cleanText(getString(formData, "body"), 20000);
  const defaultConsentText = cleanText(getString(formData, "defaultConsentText"), 1000);
  const documentType = getString(formData, "documentType") || "waiver";
  const appliesTo = getString(formData, "appliesTo") || "manual";

  if (!templateId) {
    redirect("/app/documents?error=missing_template");
  }

  if (!title || !body) {
    redirect("/app/documents?error=missing_content");
  }

  const match =
    owner.scope === "organizer"
      ? { id: templateId, organizer_id: owner.organizerId }
      : { id: templateId, studio_id: owner.studioId };

  const { data: existing, error: existingError } = await owner.supabase
    .from("document_templates")
    .select("id, current_version")
    .match(match)
    .single();

  if (existingError || !existing) {
    redirect("/app/documents?error=template_not_found");
  }

  const nextVersion = Number(existing.current_version ?? 1) + 1;

  const { data: version, error: versionError } = await owner.supabase
    .from("document_template_versions")
    .insert({
      template_id: templateId,
      version_number: nextVersion,
      title,
      description: description || null,
      body,
      requires_signature: getBool(formData, "requiresSignature"),
      is_required: getBool(formData, "isRequired"),
      consent_text: defaultConsentText || null,
      created_by: owner.userId,
      published_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (versionError || !version) {
    redirect(
      `/app/documents?error=${encodeURIComponent(versionError?.message ?? "Could not create the template version.")}`,
    );
  }

  const { error } = await owner.supabase
    .from("document_templates")
    .update({
      document_type: documentType,
      title,
      description: description || null,
      body,
      default_consent_text: defaultConsentText || null,
      applies_to: appliesTo,
      requires_signature: getBool(formData, "requiresSignature"),
      is_required: getBool(formData, "isRequired"),
      current_version: nextVersion,
      current_version_id: version.id,
      updated_by: owner.userId,
    })
    .eq("id", templateId);

  if (error) {
    redirect(`/app/documents?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/app/documents");
  redirect("/app/documents?success=updated");
}

export async function assignDocumentToClientAction(formData: FormData) {
  const owner = await resolveOwnerContext(formData);

  if ("error" in owner) {
    redirect(
      `/app/documents?error=${encodeURIComponent(
        owner.error ?? "Unable to manage documents.",
      )}`,
    );
  }

  if (owner.scope !== "studio") {
    redirect(
      "/app/documents?error=Client document assignment is available for studio documents. Organizer event waivers remain in the event workflow.",
    );
  }

  const templateId = getString(formData, "templateId");
  const clientId = getString(formData, "clientId");
  const dueDate = getString(formData, "dueDate");

  if (!templateId || !clientId) {
    redirect(
      "/app/documents?error=Choose a document and client before assigning.",
    );
  }

  const { data: template, error: templateError } = await owner.supabase
    .from("document_templates")
    .select("id,studio_id,is_active,current_version,current_version_id,title,description,body,default_consent_text")
    .eq("id", templateId)
    .eq("studio_id", owner.studioId)
    .maybeSingle();

  if (templateError || !template || !template.is_active) {
    redirect("/app/documents?error=Document template not found or inactive.");
  }

  const { data: version, error: versionError } = await owner.supabase
    .from("document_template_versions")
    .select("id,version_number,title,description,body,consent_text")
    .eq("id", template.current_version_id)
    .eq("template_id", templateId)
    .maybeSingle();

  if (versionError || !version) {
    redirect("/app/documents?error=The current document version could not be loaded.");
  }

  const { data: client, error: clientError } = await owner.supabase
    .from("clients")
    .select("id,first_name,last_name,email,portal_user_id")
    .eq("id", clientId)
    .eq("studio_id", owner.studioId)
    .maybeSingle();

  if (clientError || !client) {
    redirect("/app/documents?error=Client not found.");
  }

  const signerEmail = typeof client.email === "string" ? client.email.trim().toLowerCase() : "";
  if (!signerEmail || !signerEmail.includes("@")) {
    redirect("/app/documents?error=Add a valid client email before sending a document for signature.");
  }

  const { data: existing } = await owner.supabase
    .from("document_assignments")
    .select("id,sign_envelope_id")
    .eq("template_id", templateId)
    .eq("client_id", clientId)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();

  if (existing) {
    redirect(
      "/app/documents?error=This client already has a pending assignment for that document.",
    );
  }

  const signerName = [client.first_name, client.last_name].filter(Boolean).join(" ").trim() || signerEmail;
  const admin = createAdminClient();
  const branding = await loadStudioDocumentBranding(admin, owner.studioId);
  const pdfBytes = await renderTemplateVersionPdf({
    title: version.title || template.title,
    description: version.description ?? template.description,
    body: version.body || template.body,
    versionNumber: Number(version.version_number ?? template.current_version ?? 1),
    consentText: version.consent_text ?? template.default_consent_text,
    studioName: branding.studioName,
    studioLogoBytes: branding.studioLogoBytes,
    studioLogoMimeType: branding.studioLogoMimeType,
  });

  const pageSizes = await getPdfPageSizes(pdfBytes);
  const envelopeId = randomUUID();
  const assignmentId = randomUUID();
  const sourcePath = sourceStoragePath(owner.studioId, envelopeId);
  const dueAt = dueDate ? new Date(`${dueDate}T23:59:59`).toISOString() : null;
  const expiresAt = dueAt ?? new Date(Date.now() + 7 * 86400000).toISOString();

  const { error: uploadError } = await admin.storage
    .from(DOCUMENT_FILES_BUCKET)
    .upload(sourcePath, pdfBytes, {
      contentType: "application/pdf",
      upsert: false,
      cacheControl: "0",
    });

  if (uploadError) {
    redirect("/app/documents?error=Could not create the signing PDF.");
  }

  const { error: envelopeError } = await admin
    .from("document_sign_envelopes")
    .insert({
      id: envelopeId,
      studio_id: owner.studioId,
      template_id: templateId,
      template_version_id: version.id,
      client_id: clientId,
      assignment_id: null,
      source_kind: "template_version",
      title: version.title || template.title,
      signer_name: signerName,
      signer_email: signerEmail,
      status: "draft",
      token_hash: null,
      source_bucket: DOCUMENT_FILES_BUCKET,
      source_path: sourcePath,
      source_sha256: sha256Hex(pdfBytes),
      page_count: pageSizes.length,
      page_sizes: pageSizes,
      expires_at: expiresAt,
      created_by: owner.userId,
    });

  if (envelopeError) {
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([sourcePath]);
    redirect("/app/documents?error=Could not create the signing request.");
  }

  const { error: assignmentError } = await admin
    .from("document_assignments")
    .insert({
      id: assignmentId,
      template_id: templateId,
      template_version_id: version.id,
      studio_id: owner.studioId,
      client_id: clientId,
      assigned_to_email: signerEmail,
      status: "pending",
      due_at: dueAt,
      assigned_by: owner.userId,
      sign_envelope_id: envelopeId,
    });

  if (assignmentError) {
    await admin.from("document_sign_envelopes").delete().eq("id", envelopeId);
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([sourcePath]);
    redirect("/app/documents?error=Could not create the client assignment.");
  }

  const { error: envelopeLinkError } = await admin
    .from("document_sign_envelopes")
    .update({ assignment_id: assignmentId })
    .eq("id", envelopeId)
    .eq("studio_id", owner.studioId);

  if (envelopeLinkError) {
    await admin.from("document_assignments").delete().eq("id", assignmentId);
    await admin.from("document_sign_envelopes").delete().eq("id", envelopeId);
    await admin.storage.from(DOCUMENT_FILES_BUCKET).remove([sourcePath]);
    redirect("/app/documents?error=Could not link the signing request to the client assignment.");
  }

  await admin.from("document_sign_events").insert({
    envelope_id: envelopeId,
    event_type: "created",
    actor_user_id: owner.userId,
    summary: "Signing draft created from a document template version.",
    metadata: {
      template_id: templateId,
      template_version_id: version.id,
      client_id: clientId,
      assignment_id: assignmentId,
    },
  });

  const portalUserId =
    typeof client.portal_user_id === "string" ? client.portal_user_id : null;

  if (portalUserId) {
    await sendMobilePushToUser({
      userId: portalUserId,
      category: "account",
      title: "Document is being prepared",
      body: "Your studio is preparing a document for your signature.",
      data: {
        source: "document_sign_draft_created",
        templateId,
        envelopeId,
      },
    }).catch((pushError) => {
      console.error("Failed to send document draft mobile push", pushError);
    });
  }

  revalidatePath("/app/documents");
  revalidatePath(`/app/clients/${clientId}`);
  redirect(`/app/documents/sign/${envelopeId}/edit?source=template`);
}

export async function assignDocumentToEventAction(formData: FormData) {
  await requireStudioFeature("event_waivers");
  const owner = await resolveOwnerContext(formData);

  if ("error" in owner) {
    redirect(
      `/app/documents?error=${encodeURIComponent(
        owner.error ?? "Unable to manage documents.",
      )}`,
    );
  }

  const templateId = getString(formData, "templateId");
  const eventId = getString(formData, "eventId");

  if (!templateId || !eventId) {
    redirect(
      "/app/documents?error=Choose a document and event before attaching the waiver.",
    );
  }

  const templateQuery = owner.supabase
    .from("document_templates")
    .select("id, studio_id, organizer_id, scope, is_active, current_version")
    .eq("id", templateId)
    .eq("is_active", true);

  if (owner.scope === "organizer") {
    templateQuery.eq("organizer_id", owner.organizerId);
  } else {
    templateQuery.eq("studio_id", owner.studioId);
  }

  const { data: template, error: templateError } =
    await templateQuery.maybeSingle();

  if (templateError || !template) {
    redirect("/app/documents?error=Document template not found or inactive.");
  }

  const eventQuery = owner.supabase
    .from("events")
    .select("id, studio_id, organizer_id, name")
    .eq("id", eventId)
    .eq("studio_id", owner.studioId);

  if (owner.scope === "organizer") {
    eventQuery.eq("organizer_id", owner.organizerId);
  } else {
    eventQuery.is("organizer_id", null);
  }

  const { data: event, error: eventError } = await eventQuery.maybeSingle();

  if (eventError || !event) {
    redirect("/app/documents?error=Event not found for this document owner.");
  }

  const { data: version } = await owner.supabase
    .from("document_template_versions")
    .select("id")
    .eq("template_id", templateId)
    .eq("version_number", Number(template.current_version ?? 1))
    .maybeSingle();

  const { data: existing, error: existingError } = await owner.supabase
    .from("event_document_requirements")
    .select("id, active")
    .eq("event_id", eventId)
    .eq("template_id", templateId)
    .limit(1)
    .maybeSingle();

  if (existingError) {
    redirect(
      `/app/documents?error=${encodeURIComponent(existingError.message)}`,
    );
  }

  if (existing) {
    const { error } = await owner.supabase
      .from("event_document_requirements")
      .update({
        template_version_id: version?.id ?? null,
        is_required: true,
        active: true,
      })
      .eq("id", existing.id);

    if (error) {
      redirect(`/app/documents?error=${encodeURIComponent(error.message)}`);
    }
  } else {
    const { error } = await owner.supabase
      .from("event_document_requirements")
      .insert({
        event_id: eventId,
        template_id: templateId,
        template_version_id: version?.id ?? null,
        studio_id: owner.studioId,
        organizer_id: owner.scope === "organizer" ? owner.organizerId : null,
        is_required: true,
        active: true,
        created_by: owner.userId,
      });

    if (error) {
      redirect(`/app/documents?error=${encodeURIComponent(error.message)}`);
    }
  }

  revalidatePath("/app/documents");
  revalidatePath(`/events/${eventId}`);
  redirect("/app/documents?success=event_attached");
}

export async function removeDocumentFromEventAction(formData: FormData) {
  const owner = await resolveOwnerContext(formData);

  if ("error" in owner) {
    redirect(
      `/app/documents?error=${encodeURIComponent(
        owner.error ?? "Unable to manage documents.",
      )}`,
    );
  }

  const requirementId = getString(formData, "requirementId");

  if (!requirementId) {
    redirect("/app/documents?error=Missing event waiver requirement.");
  }

  const query = owner.supabase
    .from("event_document_requirements")
    .update({ active: false })
    .eq("id", requirementId)
    .eq("studio_id", owner.studioId);

  if (owner.scope === "organizer") {
    query.eq("organizer_id", owner.organizerId);
  } else {
    query.is("organizer_id", null);
  }

  const { error } = await query;

  if (error) {
    redirect(`/app/documents?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/app/documents");
  redirect("/app/documents?success=event_removed");
}

export async function toggleDocumentTemplateStatusAction(formData: FormData) {
  const owner = await resolveOwnerContext(formData);

  if ("error" in owner) {
    redirect(
      `/app/documents?error=${encodeURIComponent(owner.error ?? "Unable to manage documents.")}`,
    );
  }

  const templateId = getString(formData, "templateId");
  const nextStatus = getString(formData, "nextStatus") === "active";

  if (!templateId) {
    redirect("/app/documents?error=missing_template");
  }

  const query = owner.supabase
    .from("document_templates")
    .update({
      is_active: nextStatus,
      updated_by: owner.userId,
    })
    .eq("id", templateId);

  if (owner.scope === "organizer") {
    query.eq("organizer_id", owner.organizerId);
  } else {
    query.eq("studio_id", owner.studioId);
  }

  const { error } = await query;

  if (error) {
    redirect(`/app/documents?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/app/documents");
  redirect("/app/documents?success=status_updated");
}

async function loadStudioDocumentBranding(
  admin: ReturnType<typeof createAdminClient>,
  studioId: string,
) {
  const { data: studio } = await admin
    .from("studios")
    .select("name, public_name, public_logo_url")
    .eq("id", studioId)
    .maybeSingle();

  const studioName =
    String(studio?.public_name ?? studio?.name ?? "Your studio").trim() ||
    "Your studio";
  const logoUrl =
    typeof studio?.public_logo_url === "string"
      ? studio.public_logo_url.trim()
      : "";

  if (!logoUrl) {
    return {
      studioName,
      studioLogoBytes: null,
      studioLogoMimeType: null,
    } as const;
  }

  try {
    const response = await fetch(logoUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error("Logo request failed.");
    }

    const contentType = response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      ?.toLowerCase();

    if (contentType !== "image/png" && contentType !== "image/jpeg") {
      return {
        studioName,
        studioLogoBytes: null,
        studioLogoMimeType: null,
      } as const;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) {
      return {
        studioName,
        studioLogoBytes: null,
        studioLogoMimeType: null,
      } as const;
    }

    return {
      studioName,
      studioLogoBytes: bytes,
      studioLogoMimeType: contentType,
    } as const;
  } catch {
    return {
      studioName,
      studioLogoBytes: null,
      studioLogoMimeType: null,
    } as const;
  }
}

function htmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function queueDocumentAssignmentEmail(params: {
  assignmentId: string;
  studioId: string;
  clientId: string | null;
  recipientEmail: string | null;
  templateId: string;
  reason: "assignment" | "manual_reminder";
}) {
  if (!params.recipientEmail?.trim()) {
    return { queued: false, reason: "missing_email" as const };
  }

  const admin = createAdminClient();
  const [{ data: studio }, { data: template }, { data: client }] =
    await Promise.all([
      admin
        .from("studios")
        .select("name, public_name, slug")
        .eq("id", params.studioId)
        .maybeSingle(),
      admin
        .from("document_templates")
        .select("title")
        .eq("id", params.templateId)
        .maybeSingle(),
      params.clientId
        ? admin
            .from("clients")
            .select("first_name, last_name")
            .eq("id", params.clientId)
            .eq("studio_id", params.studioId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  const studioName = studio?.public_name || studio?.name || "Your studio";
  const clientName = client
    ? `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim()
    : "there";
  const documentTitle = template?.title || "a document";
  const portalUrl = studio?.slug
    ? `${process.env.NEXT_PUBLIC_APP_URL ?? "https://idanceflow.com"}/portal/${encodeURIComponent(studio.slug)}/documents`
    : `${process.env.NEXT_PUBLIC_APP_URL ?? "https://idanceflow.com"}/app`;
  const isReminder = params.reason === "manual_reminder";
  const subject = isReminder
    ? `Reminder: ${documentTitle} needs your signature`
    : `${studioName} assigned a document for your review`;
  const bodyText = `${clientName || "Hello"},\n\n${studioName} ${isReminder ? "is reminding you to review" : "assigned"} ${documentTitle}.\n\nOpen your DanceFlow portal to review and sign it: ${portalUrl}\n\nThank you,\n${studioName}`;
  const bodyHtml = `<p>${htmlEscape(clientName || "Hello")},</p><p>${htmlEscape(studioName)} ${isReminder ? "is reminding you to review" : "assigned"} <strong>${htmlEscape(documentTitle)}</strong>.</p><p><a href="${htmlEscape(portalUrl)}">Open your DanceFlow portal</a> to review and sign it.</p><p>Thank you,<br>${htmlEscape(studioName)}</p>`;
  const dedupeKey = isReminder
    ? `document:${params.assignmentId}:manual-reminder:${new Date().toISOString().slice(0, 10)}`
    : `document:${params.assignmentId}:assignment`;

  const { error } = await admin.from("outbound_deliveries").insert({
    studio_id: params.studioId,
    channel: "email",
    template_key: isReminder
      ? "document_signature_reminder"
      : "document_assignment",
    recipient_email: params.recipientEmail.trim(),
    recipient_phone: null,
    subject,
    body_text: bodyText,
    body_html: bodyHtml,
    related_table: "document_assignments",
    related_id: params.assignmentId,
    dedupe_key: dedupeKey,
    status: "queued",
    updated_at: new Date().toISOString(),
  });

  if (error && error.code !== "23505") {
    console.error("Could not queue document email", error.message);
    return { queued: false, reason: "delivery_error" as const };
  }

  await admin.from("document_operation_events").insert({
    studio_id: params.studioId,
    assignment_id: params.assignmentId,
    event_type: isReminder ? "reminder_queued" : "assignment_delivery_queued",
    summary: isReminder
      ? "Signature reminder queued."
      : "Document assignment email queued.",
    metadata: {
      channel: "email",
      recipient: params.recipientEmail,
    },
  });

  return { queued: true as const };
}

async function getManagedAssignment(formData: FormData) {
  const owner = await resolveOwnerContext(formData);

  if ("error" in owner || owner.scope !== "studio") {
    return {
      error: "You do not have permission to manage this assignment.",
    } as const;
  }

  const assignmentId = getString(formData, "assignmentId");

  if (!assignmentId) {
    return { error: "Assignment not found." } as const;
  }

  const { data, error } = await owner.supabase
    .from("document_assignments")
    .select(
      "id, studio_id, client_id, template_id, assigned_to_email, status, sign_envelope_id",
    )
    .eq("id", assignmentId)
    .eq("studio_id", owner.studioId)
    .maybeSingle();

  if (error || !data) {
    return { error: "Assignment not found." } as const;
  }

  return { owner, assignment: data } as const;
}

export async function sendDocumentReminderAction(formData: FormData) {
  const result = await getManagedAssignment(formData);

  if ("error" in result) {
    return redirect(
      `/app/documents?error=${encodeURIComponent(result.error ?? "Assignment not found.")}`,
    );
  }

  if (result.assignment.status !== "pending") {
    redirect(
      "/app/documents?error=Only pending documents can receive reminders.",
    );
  }

  if (result.assignment.sign_envelope_id) {
    const { data: envelope } = await result.owner.supabase
      .from("document_sign_envelopes")
      .select("id, status")
      .eq("id", result.assignment.sign_envelope_id)
      .eq("studio_id", result.owner.studioId)
      .maybeSingle();

    if (envelope?.status === "draft") {
      redirect(`/app/documents/sign/${envelope.id}/edit`);
    }
  }

  const queued = await queueDocumentAssignmentEmail({
    assignmentId: result.assignment.id,
    studioId: result.owner.studioId,
    clientId: result.assignment.client_id,
    recipientEmail: result.assignment.assigned_to_email,
    templateId: result.assignment.template_id,
    reason: "manual_reminder",
  });

  if (!queued.queued) {
    redirect(
      `/app/documents?error=${
        queued.reason === "missing_email"
          ? "This client does not have an email address."
          : "Could not queue the reminder."
      }`,
    );
  }

  revalidatePath("/app/documents");
  redirect("/app/documents?success=reminder_queued");
}

export async function waiveDocumentAssignmentAction(formData: FormData) {
  const result = await getManagedAssignment(formData);

  if ("error" in result) {
    return redirect(
      `/app/documents?error=${encodeURIComponent(result.error ?? "Assignment not found.")}`,
    );
  }

  const now = new Date().toISOString();
  const { error } = await result.owner.supabase
    .from("document_assignments")
    .update({ status: "waived", completed_at: now })
    .eq("id", result.assignment.id)
    .eq("studio_id", result.owner.studioId)
    .eq("status", "pending");

  if (error) {
    redirect(`/app/documents?error=${encodeURIComponent(error.message)}`);
  }

  if (result.assignment.sign_envelope_id) {
    await createAdminClient()
      .from("document_sign_envelopes")
      .update({ status: "void", voided_at: now })
      .eq("id", result.assignment.sign_envelope_id)
      .eq("studio_id", result.owner.studioId)
      .eq("status", "draft");
  }

  await createAdminClient().from("document_operation_events").insert({
    studio_id: result.owner.studioId,
    assignment_id: result.assignment.id,
    event_type: "waived",
    summary: "Required document waived by studio staff.",
    actor_user_id: result.owner.userId,
  });

  revalidatePath("/app/documents");
  redirect("/app/documents?success=waived");
}

export async function voidDocumentAssignmentAction(formData: FormData) {
  const result = await getManagedAssignment(formData);

  if ("error" in result) {
    return redirect(
      `/app/documents?error=${encodeURIComponent(result.error ?? "Assignment not found.")}`,
    );
  }

  const reason =
    cleanText(getString(formData, "reason"), 500) || "Voided by studio staff.";
  const now = new Date().toISOString();
  const { error } = await result.owner.supabase
    .from("document_assignments")
    .update({ status: "void", voided_at: now, void_reason: reason })
    .eq("id", result.assignment.id)
    .eq("studio_id", result.owner.studioId)
    .eq("status", "pending");

  if (error) {
    redirect(`/app/documents?error=${encodeURIComponent(error.message)}`);
  }

  if (result.assignment.sign_envelope_id) {
    await createAdminClient()
      .from("document_sign_envelopes")
      .update({ status: "void", voided_at: now })
      .eq("id", result.assignment.sign_envelope_id)
      .eq("studio_id", result.owner.studioId)
      .in("status", ["draft", "sent", "viewed"]);
  }

  await createAdminClient().from("document_operation_events").insert({
    studio_id: result.owner.studioId,
    assignment_id: result.assignment.id,
    event_type: "voided",
    summary: reason,
    actor_user_id: result.owner.userId,
  });

  revalidatePath("/app/documents");
  redirect("/app/documents?success=voided");
}


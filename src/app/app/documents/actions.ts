"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

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
    redirect(`/app/documents?error=${encodeURIComponent(owner.error ?? "Unable to manage documents.")}`);
  }

  const title = cleanText(getString(formData, "title"), 160);
  const description = cleanText(getString(formData, "description"), 500);
  const body = cleanText(getString(formData, "body"), 20000);
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

  const { error: versionError } = await owner.supabase
    .from("document_template_versions")
    .insert({
      template_id: template.id,
      version_number: 1,
      title,
      description: description || null,
      body,
      requires_signature: payload.requires_signature,
      is_required: payload.is_required,
      created_by: owner.userId,
    });

  if (versionError) {
    redirect(
      `/app/documents?error=${encodeURIComponent(versionError.message)}`,
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
    redirect(`/app/documents?error=${encodeURIComponent(owner.error ?? "Unable to manage documents.")}`);
  }

  const templateId = getString(formData, "templateId");
  const title = cleanText(getString(formData, "title"), 160);
  const description = cleanText(getString(formData, "description"), 500);
  const body = cleanText(getString(formData, "body"), 20000);
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

  const { error } = await owner.supabase
    .from("document_templates")
    .update({
      document_type: documentType,
      title,
      description: description || null,
      body,
      applies_to: appliesTo,
      requires_signature: getBool(formData, "requiresSignature"),
      is_required: getBool(formData, "isRequired"),
      current_version: nextVersion,
      updated_by: owner.userId,
    })
    .eq("id", templateId);

  if (error) {
    redirect(`/app/documents?error=${encodeURIComponent(error.message)}`);
  }

  const { error: versionError } = await owner.supabase
    .from("document_template_versions")
    .insert({
      template_id: templateId,
      version_number: nextVersion,
      title,
      description: description || null,
      body,
      requires_signature: getBool(formData, "requiresSignature"),
      is_required: getBool(formData, "isRequired"),
      created_by: owner.userId,
    });

  if (versionError) {
    redirect(
      `/app/documents?error=${encodeURIComponent(versionError.message)}`,
    );
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
      "/app/documents?error=Client document assignment is available for studio documents. Organizer event waivers will be handled from the event workflow.",
    );
  }

  const templateId = getString(formData, "templateId");
  const clientId = getString(formData, "clientId");
  const dueDate = getString(formData, "dueDate");

  if (!templateId || !clientId) {
    redirect("/app/documents?error=Choose a document and client before assigning.");
  }

  const { data: template, error: templateError } = await owner.supabase
    .from("document_templates")
    .select("id, studio_id, is_active, current_version")
    .eq("id", templateId)
    .eq("studio_id", owner.studioId)
    .maybeSingle();

  if (templateError || !template || !template.is_active) {
    redirect("/app/documents?error=Document template not found or inactive.");
  }

  const { data: version } = await owner.supabase
    .from("document_template_versions")
    .select("id")
    .eq("template_id", templateId)
    .eq("version_number", Number(template.current_version ?? 1))
    .maybeSingle();

  const { data: client, error: clientError } = await owner.supabase
    .from("clients")
    .select("id, email")
    .eq("id", clientId)
    .eq("studio_id", owner.studioId)
    .maybeSingle();

  if (clientError || !client) {
    redirect("/app/documents?error=Client not found.");
  }

  const { data: existing, error: existingError } = await owner.supabase
    .from("document_assignments")
    .select("id")
    .eq("template_id", templateId)
    .eq("client_id", clientId)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();

  if (existingError) {
    redirect(`/app/documents?error=${encodeURIComponent(existingError.message)}`);
  }

  if (existing) {
    redirect("/app/documents?error=This client already has a pending assignment for that document.");
  }

  const dueAt = dueDate ? new Date(`${dueDate}T23:59:59`).toISOString() : null;

  const { error } = await owner.supabase.from("document_assignments").insert({
    template_id: templateId,
    template_version_id: version?.id ?? null,
    studio_id: owner.studioId,
    client_id: clientId,
    assigned_to_email: typeof client.email === "string" ? client.email : null,
    status: "pending",
    due_at: dueAt,
    assigned_by: owner.userId,
  });

  if (error) {
    redirect(`/app/documents?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/app/documents");
  revalidatePath(`/app/clients/${clientId}`);
  redirect("/app/documents?success=assigned");
}


export async function assignDocumentToEventAction(formData: FormData) {
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
    redirect("/app/documents?error=Choose a document and event before attaching the waiver.");
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

  const { data: template, error: templateError } = await templateQuery.maybeSingle();

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
    redirect(`/app/documents?error=${encodeURIComponent(existingError.message)}`);
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
    const { error } = await owner.supabase.from("event_document_requirements").insert({
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
    redirect(`/app/documents?error=${encodeURIComponent(owner.error ?? "Unable to manage documents.")}`);
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

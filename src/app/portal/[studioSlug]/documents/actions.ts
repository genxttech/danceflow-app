"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolvePortalRelationship } from "@/lib/student-identity/portal-context";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

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

function normalizeOptionalUuid(value: string) {
  const cleaned = cleanText(value, 36);
  return cleaned && UUID_PATTERN.test(cleaned) ? cleaned : "";
}

function portalDocumentsPath(studioSlug: string, key?: string, value?: string) {
  const path = `/portal/${encodeURIComponent(studioSlug)}/documents`;
  return key && value ? `${path}?${key}=${encodeURIComponent(value)}` : path;
}

async function getPortalClient(params: { studioSlug: string; clientId?: string | null }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(params.studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug, public_name")
    .eq("slug", params.studioSlug)
    .maybeSingle();

  if (studioError || !studio) {
    redirect("/login");
  }

  const relationship = await resolvePortalRelationship({
    userId: user.id,
    studioId: studio.id,
    requestedClientId: params.clientId ?? null,
    permission: "can_sign_documents",
  });

  if (!relationship) {
    redirect(`/portal/${encodeURIComponent(params.studioSlug)}`);
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email")
    .eq("studio_id", studio.id)
    .eq("id", relationship.clientId)
    .maybeSingle();

  if (clientError) throw clientError;
  if (!client) redirect(`/portal/${encodeURIComponent(params.studioSlug)}`);

  return { supabase, user, studio, client };
}

async function getTemplateVersion(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  templateId: string;
  templateVersionId?: string | null;
}) {
  if (params.templateVersionId) {
    const { data: version, error: versionError } = await params.supabase
      .from("document_template_versions")
      .select("id, template_id, version_number, title, description, body, requires_signature, is_required")
      .eq("id", params.templateVersionId)
      .eq("template_id", params.templateId)
      .maybeSingle();

    if (versionError) throw versionError;
    if (version) return version;
  }

  const { data: latestVersion, error: latestVersionError } = await params.supabase
    .from("document_template_versions")
    .select("id, template_id, version_number, title, description, body, requires_signature, is_required")
    .eq("template_id", params.templateId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestVersionError) throw latestVersionError;
  return latestVersion;
}

export async function signPortalDocumentAction(formData: FormData) {
  const studioSlug = normalizeSlug(getString(formData, "studioSlug"));
  const assignmentId = normalizeOptionalUuid(getString(formData, "assignmentId"));
  const templateId = normalizeOptionalUuid(getString(formData, "templateId"));
  const templateVersionId = normalizeOptionalUuid(getString(formData, "templateVersionId"));
  const signerName = cleanText(getString(formData, "signerName"), 160);
  const consentAccepted = getString(formData, "consentAccepted") === "on";
  const clientId = normalizeOptionalUuid(getString(formData, "clientId")) || null;

  if (!studioSlug) {
    redirect("/login");
  }

  if (!templateId && !assignmentId) {
    redirect(portalDocumentsPath(studioSlug, "error", "missing_document"));
  }

  if (!signerName || signerName.length < 2) {
    redirect(portalDocumentsPath(studioSlug, "error", "missing_signature_name"));
  }

  if (!consentAccepted) {
    redirect(portalDocumentsPath(studioSlug, "error", "missing_consent"));
  }

  const { supabase, user, studio, client } = await getPortalClient({ studioSlug, clientId });

  let assignment: {
    id: string;
    template_id: string;
    template_version_id: string | null;
    status: string;
    event_id: string | null;
    event_registration_id: string | null;
    organizer_id: string | null;
    organizer_contact_id: string | null;
  } | null = null;

  if (assignmentId) {
    const { data, error } = await supabase
      .from("document_assignments")
      .select("id, template_id, template_version_id, status, event_id, event_registration_id, organizer_id, organizer_contact_id")
      .eq("id", assignmentId)
      .eq("client_id", client.id)
      .eq("studio_id", studio.id)
      .neq("status", "void")
      .maybeSingle();

    if (error) throw error;
    assignment = data;

    if (!assignment) {
      redirect(portalDocumentsPath(studioSlug, "error", "document_not_found"));
    }
  }

  const resolvedTemplateId = assignment?.template_id ?? templateId;
  const resolvedTemplateVersionId = assignment?.template_version_id ?? (templateVersionId || null);

  const { data: template, error: templateError } = await supabase
    .from("document_templates")
    .select("id, studio_id, organizer_id, title, body, current_version, requires_signature, is_required, is_active, applies_to")
    .eq("id", resolvedTemplateId)
    .eq("studio_id", studio.id)
    .maybeSingle();

  if (templateError) throw templateError;

  if (!template || !template.is_active) {
    redirect(portalDocumentsPath(studioSlug, "error", "document_not_found"));
  }

  if (!assignment && template.studio_id !== studio.id) {
    redirect(portalDocumentsPath(studioSlug, "error", "document_not_found"));
  }

  if (!assignment && template.applies_to !== "all_clients") {
    redirect(portalDocumentsPath(studioSlug, "error", "document_not_assigned"));
  }

  if (assignment?.status === "signed") {
    redirect(portalDocumentsPath(studioSlug, "success", "signed"));
  }

  const existingSignatureQuery = supabase
    .from("document_signatures")
    .select("id")
    .eq("studio_id", studio.id)
    .eq("client_id", client.id)
    .eq("template_id", resolvedTemplateId)
    .limit(1);

  if (assignment?.id) {
    existingSignatureQuery.eq("assignment_id", assignment.id);
  } else if (resolvedTemplateVersionId) {
    existingSignatureQuery.eq("template_version_id", resolvedTemplateVersionId);
  }

  const { data: existingSignature, error: existingSignatureError } =
    await existingSignatureQuery.maybeSingle();

  if (existingSignatureError) {
    throw existingSignatureError;
  }

  if (existingSignature?.id) {
    if (assignment?.id) {
      await supabase
        .from("document_assignments")
        .update({ status: "signed", signed_at: new Date().toISOString() })
        .eq("id", assignment.id)
        .eq("studio_id", studio.id)
        .eq("client_id", client.id);
    }

    redirect(portalDocumentsPath(studioSlug, "success", "signed"));
  }

  const version = await getTemplateVersion({
    supabase,
    templateId: resolvedTemplateId,
    templateVersionId: resolvedTemplateVersionId,
  });

  const signedBody = String(version?.body ?? template.body ?? "");
  const consentText =
    "I have reviewed this document and agree to sign it electronically.";

  const headerStore = await headers();
  const userAgent = headerStore.get("user-agent");
  const signerIp =
    headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headerStore.get("x-real-ip") ||
    headerStore.get("cf-connecting-ip") ||
    null;
  const signedAt = new Date().toISOString();

  const { data: insertedSignature, error: signatureError } = await supabase.from("document_signatures").insert({
    assignment_id: assignment?.id ?? null,
    template_id: resolvedTemplateId,
    template_version_id: version?.id ?? null,
    studio_id: studio.id,
    organizer_id: template.organizer_id ?? assignment?.organizer_id ?? null,
    client_id: client.id,
    event_id: assignment?.event_id ?? null,
    event_registration_id: assignment?.event_registration_id ?? null,
    organizer_contact_id: assignment?.organizer_contact_id ?? null,
    signer_name: signerName,
    signer_email: client.email ?? user.email ?? null,
    signer_user_id: user.id,
    signed_body: signedBody,
    signature_text: signerName,
    consent_text: consentText,
    user_agent: userAgent,
    ip_address: signerIp,
    signed_at: signedAt,
    metadata: {
      source: "portal_document_center",
      studioSlug,
    },
  })
  .select("id")
  .single();

  if (signatureError) {
    redirect(portalDocumentsPath(studioSlug, "error", "signing_failed"));
  }

  if (assignment) {
    const { error: assignmentError } = await supabase
      .from("document_assignments")
      .update({ status: "signed", signed_at: signedAt })
      .eq("id", assignment.id)
      .eq("studio_id", studio.id)
      .eq("client_id", client.id)
      .neq("status", "void");

    if (assignmentError) {
      redirect(portalDocumentsPath(studioSlug, "error", "signing_failed"));
    }
  }

  if (insertedSignature?.id) {
    const { error: auditError } = await supabase
      .from("document_signature_audit_events")
      .insert({
        signature_id: insertedSignature.id,
        assignment_id: assignment?.id ?? null,
        template_id: resolvedTemplateId,
        template_version_id: version?.id ?? null,
        studio_id: studio.id,
        organizer_id: template.organizer_id ?? assignment?.organizer_id ?? null,
        event_id: assignment?.event_id ?? null,
        event_registration_id: assignment?.event_registration_id ?? null,
        actor_user_id: user.id,
        actor_email: client.email ?? user.email ?? null,
        event_type: "signed",
        event_summary: "Portal client signed document.",
        ip_address: signerIp,
        user_agent: userAgent,
        metadata: { source: "portal_document_center", studioSlug },
      });

    if (auditError) {
      console.error("portal document signature audit unavailable", auditError.message);
    }
  }

  revalidatePath(`/portal/${studioSlug}/documents`);
  redirect(portalDocumentsPath(studioSlug, "success", "signed"));
}

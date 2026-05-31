"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function cleanText(value: string, maxLength: number) {
  return value.replace(/\s+$/g, "").slice(0, maxLength);
}

async function getPortalClient(params: { studioSlug: string }) {
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
    .single();

  if (studioError || !studio) {
    redirect("/login");
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, portal_user_id")
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id)
    .maybeSingle();

  if (clientError) {
    throw clientError;
  }

  if (!client) {
    redirect(`/login?studio=${encodeURIComponent(params.studioSlug)}`);
  }

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
  const studioSlug = getString(formData, "studioSlug");
  const assignmentId = getString(formData, "assignmentId");
  const templateId = getString(formData, "templateId");
  const templateVersionId = getString(formData, "templateVersionId");
  const signerName = cleanText(getString(formData, "signerName"), 160);
  const consentAccepted = getString(formData, "consentAccepted") === "on";

  if (!studioSlug) {
    redirect("/login");
  }

  if (!templateId && !assignmentId) {
    redirect(`/portal/${encodeURIComponent(studioSlug)}/documents?error=missing_document`);
  }

  if (!signerName || signerName.length < 2) {
    redirect(`/portal/${encodeURIComponent(studioSlug)}/documents?error=missing_signature_name`);
  }

  if (!consentAccepted) {
    redirect(`/portal/${encodeURIComponent(studioSlug)}/documents?error=missing_consent`);
  }

  const { supabase, user, studio, client } = await getPortalClient({ studioSlug });

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
      redirect(`/portal/${encodeURIComponent(studioSlug)}/documents?error=document_not_found`);
    }
  }

  const resolvedTemplateId = assignment?.template_id ?? templateId;
  const resolvedTemplateVersionId = assignment?.template_version_id ?? (templateVersionId || null);

  const { data: template, error: templateError } = await supabase
    .from("document_templates")
    .select("id, studio_id, organizer_id, title, body, current_version, requires_signature, is_required, is_active, applies_to")
    .eq("id", resolvedTemplateId)
    .maybeSingle();

  if (templateError) throw templateError;

  if (!template || !template.is_active) {
    redirect(`/portal/${encodeURIComponent(studioSlug)}/documents?error=document_not_found`);
  }

  if (!assignment && template.studio_id !== studio.id) {
    redirect(`/portal/${encodeURIComponent(studioSlug)}/documents?error=document_not_found`);
  }

  if (!assignment && template.applies_to !== "all_clients") {
    redirect(`/portal/${encodeURIComponent(studioSlug)}/documents?error=document_not_assigned`);
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

  const { error: signatureError } = await supabase.from("document_signatures").insert({
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
  });

  if (signatureError) {
    redirect(
      `/portal/${encodeURIComponent(studioSlug)}/documents?error=${encodeURIComponent(
        signatureError.message,
      )}`,
    );
  }

  if (assignment) {
    const { error: assignmentError } = await supabase
      .from("document_assignments")
      .update({ status: "signed", signed_at: new Date().toISOString() })
      .eq("id", assignment.id)
      .eq("client_id", client.id);

    if (assignmentError) {
      redirect(
        `/portal/${encodeURIComponent(studioSlug)}/documents?error=${encodeURIComponent(
          assignmentError.message,
        )}`,
      );
    }
  }

  revalidatePath(`/portal/${studioSlug}/documents`);
  redirect(`/portal/${encodeURIComponent(studioSlug)}/documents?success=signed`);
}

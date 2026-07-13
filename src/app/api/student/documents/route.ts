import { NextResponse } from "next/server";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";
import { createAdminClient } from "@/lib/supabase/admin";

type AssignmentRow = {
  id: string;
  studio_id: string;
  client_id: string;
  template_id: string;
  template_version_id: string | null;
  sign_envelope_id: string | null;
  status: string | null;
  due_at: string | null;
  assigned_at: string;
  signed_at: string | null;
  document_templates:
    | {
        id: string;
        title: string | null;
        description: string | null;
        document_type: string | null;
        requires_signature: boolean | null;
        is_required: boolean | null;
      }
    | {
        id: string;
        title: string | null;
        description: string | null;
        document_type: string | null;
        requires_signature: boolean | null;
        is_required: boolean | null;
      }[]
    | null;
  studios:
    | { id: string; slug: string; name: string | null; public_name: string | null }
    | { id: string; slug: string; name: string | null; public_name: string | null }[]
    | null;
};

type EnvelopeRow = {
  id: string;
  status: string;
  completed_at: string | null;
};

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export async function GET(request: Request) {
  const user = await getStudentApiUser(request);

  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const supabase = createAdminClient();

  const { data: links, error: linksError } = await supabase
    .from("client_account_links")
    .select("client_id")
    .eq("user_id", user.id)
    .eq("status", "linked")
    .eq("can_sign_documents", true);

  if (linksError) {
    return NextResponse.json({ error: linksError.message }, { status: 400 });
  }

  const clientIds = Array.from(
    new Set((links ?? []).map((link) => String(link.client_id))),
  );

  if (!clientIds.length) {
    return NextResponse.json({ documents: [] });
  }

  const { data, error } = await supabase
    .from("document_assignments")
    .select(`
      id,
      studio_id,
      client_id,
      template_id,
      template_version_id,
      sign_envelope_id,
      status,
      due_at,
      assigned_at,
      signed_at,
      document_templates:template_id (
        id,
        title,
        description,
        document_type,
        requires_signature,
        is_required
      ),
      studios:studio_id (
        id,
        slug,
        name,
        public_name
      )
    `)
    .in("client_id", clientIds)
    .neq("status", "void")
    .order("assigned_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const assignments = (data ?? []) as unknown as AssignmentRow[];
  const envelopeIds = assignments
    .map((row) => row.sign_envelope_id)
    .filter((id): id is string => Boolean(id));

  const envelopesById = new Map<string, EnvelopeRow>();

  if (envelopeIds.length) {
    const { data: envelopes, error: envelopesError } = await supabase
      .from("document_sign_envelopes")
      .select("id, status, completed_at")
      .in("id", envelopeIds);

    if (envelopesError) {
      return NextResponse.json(
        { error: envelopesError.message },
        { status: 400 },
      );
    }

    for (const envelope of (envelopes ?? []) as EnvelopeRow[]) {
      envelopesById.set(envelope.id, envelope);
    }
  }

  const documents = assignments.map((row) => {
    const template = firstJoin(row.document_templates);
    const studio = firstJoin(row.studios);
    const envelope = row.sign_envelope_id
      ? envelopesById.get(row.sign_envelope_id) ?? null
      : null;
    const signedAt = row.signed_at ?? envelope?.completed_at ?? null;
    const status =
      row.status === "signed" || envelope?.status === "completed" || signedAt
        ? "signed"
        : row.status || "assigned";

    return {
      id: row.id,
      studioId: row.studio_id,
      clientId: row.client_id,
      studioName: studio?.public_name || studio?.name || "Studio",
      studioSlug: studio?.slug || null,
      title: template?.title || "Document",
      description: template?.description || null,
      documentType: template?.document_type || "document",
      required: template?.is_required === true,
      requiresSignature: template?.requires_signature !== false,
      status,
      dueAt: row.due_at,
      assignedAt: row.assigned_at,
      signedAt,
      envelopeStatus: envelope?.status ?? null,
      nativeSigningAvailable: Boolean(row.sign_envelope_id),
    };
  });

  return NextResponse.json({ documents });
}

import { NextResponse } from "next/server";
import { getStudentApiUser } from "@/lib/auth/studentApiAuth";
import { createAdminClient } from "@/lib/supabase/admin";

type AssignmentRow = {
  id: string;
  studio_id: string;
  client_id: string;
  template_id: string;
  template_version_id: string | null;
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

function firstJoin<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function webBaseUrl(request: Request) {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return (configured || new URL(request.url).origin).replace(/\/$/, "");
}

export async function GET(request: Request) {
  const user = await getStudentApiUser(request);

  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: clients, error: clientsError } = await supabase
    .from("clients")
    .select("id, studio_id")
    .eq("portal_user_id", user.id);

  if (clientsError) {
    return NextResponse.json({ error: clientsError.message }, { status: 400 });
  }

  const clientIds = (clients ?? []).map((client) => client.id);
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

  const base = webBaseUrl(request);
  const documents = ((data ?? []) as unknown as AssignmentRow[]).map((row) => {
    const template = firstJoin(row.document_templates);
    const studio = firstJoin(row.studios);
    const status = row.status || (row.signed_at ? "signed" : "assigned");
    const portalUrl = studio?.slug
      ? `${base}/portal/${encodeURIComponent(studio.slug)}/documents#assignment-${encodeURIComponent(row.id)}`
      : null;

    return {
      id: row.id,
      studioId: row.studio_id,
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
      signedAt: row.signed_at,
      actionUrl: portalUrl,
    };
  });

  return NextResponse.json({ documents });
}

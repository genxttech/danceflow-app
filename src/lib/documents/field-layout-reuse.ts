import { createAdminClient } from "@/lib/supabase/admin";

/*
  Phase 8D -- reuse the signing-field layout of a template version. Fields are stored per envelope; a template
  version renders the same PDF for every client (no client-specific content), so the layout staff already placed and
  SENT for that version is copied onto a new draft when the page geometry is identical. Staff still review the
  layout before sending; nothing is sent automatically. No new template-builder architecture.
*/

const FINALIZED_STATUSES = ["sent", "viewed", "started", "completed", "expired", "declined"];

function samePages(a: unknown, b: unknown) {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

export async function reuseFieldLayoutFromVersion(params: {
  studioId: string;
  templateVersionId: string;
  newEnvelopeId: string;
  pageCount: number;
  pageSizes: unknown;
}) {
  const admin = createAdminClient();
  const { data: candidates } = await admin
    .from("document_sign_envelopes")
    .select("id, page_count, page_sizes")
    .eq("studio_id", params.studioId)
    .eq("template_version_id", params.templateVersionId)
    .eq("source_kind", "template_version")
    .in("status", FINALIZED_STATUSES)
    .neq("id", params.newEnvelopeId)
    .order("created_at", { ascending: false })
    .limit(5);

  const source = ((candidates ?? []) as Array<{ id: string; page_count: number; page_sizes: unknown }>).find(
    (candidate) => candidate.page_count === params.pageCount && samePages(candidate.page_sizes, params.pageSizes),
  );
  if (!source) return false;

  const { data: fields } = await admin
    .from("document_sign_fields")
    .select("field_type,page_number,x,y,width,height,label,required,placeholder_text,default_value,sort_order")
    .eq("envelope_id", source.id)
    .order("sort_order");
  const rows = (fields ?? []) as Array<Record<string, unknown>>;
  if (!rows.length || !rows.some((field) => field.field_type === "signature")) return false;

  const { error } = await admin
    .from("document_sign_fields")
    .insert(rows.map((field) => ({ ...field, envelope_id: params.newEnvelopeId })));
  return !error;
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadCompetitionRegistrationCatalog } from "@/lib/competition/registrationServer";
import CompetitionRegistrationBuilder from "./CompetitionRegistrationBuilder";

export default async function CompetitionRegisterPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ success?: string; order?: string; error?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: event, error } = await supabase
    .from("events")
    .select("id, slug, name, event_type, status, visibility, registration_required, registration_opens_at, registration_closes_at, account_required_for_registration")
    .eq("slug", slug)
    .maybeSingle();
  if (error || !event || event.status !== "published" || !["public", "unlisted"].includes(event.visibility)) notFound();
  if (!event.registration_required) redirect(`/events/${encodeURIComponent(slug)}`);
  if (event.account_required_for_registration && !user) redirect(`/login?next=${encodeURIComponent(`/events/${slug}/competition/register`)}`);

  const now = Date.now();
  const registrationOpen = (!event.registration_opens_at || new Date(event.registration_opens_at).getTime() <= now)
    && (!event.registration_closes_at || new Date(event.registration_closes_at).getTime() >= now);
  const catalog = await loadCompetitionRegistrationCatalog(supabase as any, event.id);
  const { data: requirements, error: requirementError } = await supabase
    .from("event_document_requirements")
    .select("id, template_id, template_version_id, document_templates:template_id(id, title, description, body, requires_signature)")
    .eq("event_id", event.id)
    .eq("active", true)
    .eq("is_required", true)
    .order("created_at");
  if (requirementError) throw new Error(`Could not load required documents: ${requirementError.message}`);
  const documents = (requirements ?? []).map((requirement: any) => {
    const template = Array.isArray(requirement.document_templates) ? requirement.document_templates[0] : requirement.document_templates;
    return template ? { id: requirement.id, templateId: requirement.template_id, templateVersionId: requirement.template_version_id, title: template.title, description: template.description, body: template.body, requiresSignature: Boolean(template.requires_signature) } : null;
  }).filter(Boolean);

  return <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
    <header className="border-b border-slate-200 pb-5"><Link href={`/events/${encodeURIComponent(slug)}`} className="text-sm font-medium text-slate-600 hover:text-slate-950">Back to event</Link><h1 className="mt-2 text-2xl font-semibold text-slate-950">Competition Registration</h1><p className="mt-1 text-sm text-slate-600">{event.name}</p></header>
    {query.success === "paid" ? <div className="my-6 border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"><p className="font-semibold">Registration payment completed</p><p className="mt-1">Your entries were submitted. A confirmation will be sent to the registration contact.</p></div> : null}
    {query.error ? <div className="my-6 border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Registration checkout could not be completed. Review the entries and try again.</div> : null}
    {!registrationOpen ? <div className="mt-8 border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">Competition registration is not currently open.</div> : catalog.programs.length === 0 ? <div className="mt-8 border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600">Competition registration options have not been published yet.</div> : <CompetitionRegistrationBuilder eventSlug={slug} catalog={catalog} currentUserEmail={user?.email ?? ""} requiredDocuments={documents as any} />}
  </main>;
}

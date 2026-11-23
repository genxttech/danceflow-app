import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canConfigureStudentIntake, isStudentIntakeConfigAvailable } from "@/lib/intake/access";
import { loadConfigView, loadTemplateDraft } from "@/lib/intake/studioConfigLoader";
import { createSupabaseReconcileRpc, type StudioGateStatus } from "@/lib/intake/reconcilePreview";
import { loadPreviewView, type PreviewView } from "@/lib/intake/previewView";
import StudentIntakeWorkspace, { type BuilderSeed } from "./StudentIntakeWorkspace";

type SearchParams = Promise<{ template?: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StudentIntakeSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const context = await getCurrentStudioContext();

  // Owner/admin only, and only for studios the feature has been made available to. Anyone else lands on Settings
  // without learning the page exists.
  if (!canConfigureStudentIntake(context.studioRole) || !isStudentIntakeConfigAvailable(context.studioId)) {
    redirect("/app/settings");
  }

  const query = await searchParams;
  const supabase = await createClient();
  const config = await loadConfigView(supabase, context.studioId);

  let seed: BuilderSeed | null = null;
  if (query.template && UUID.test(query.template)) {
    const loaded = await loadTemplateDraft(supabase, context.studioId, query.template);
    if (loaded) {
      seed = { templateId: query.template, draft: loaded.draft, basedOn: loaded.basedOn, versionNumber: loaded.versionNumber };
    }
  }

  // The preview RPCs are service_role only and read-only. The studio id is the caller's own, from the session.
  let preview: PreviewView | null = null;
  let previewError = false;
  let status: StudioGateStatus | null = null;
  try {
    const rpc = createSupabaseReconcileRpc(createAdminClient());
    status = await rpc.status(context.studioId);
    preview = await loadPreviewView({ studioId: context.studioId, rpc, userClient: supabase });
  } catch {
    previewError = true;
  }

  return (
    <div className="space-y-6 bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.08),transparent_28%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.09),transparent_26%)] p-1">
      <section className="overflow-hidden rounded-[30px] border border-violet-200 bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,#111827_0%,#4c1d95_52%,#f97316_145%)] px-6 py-7 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-orange-200">Studio Operations</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Student Intake</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80">
            Ask new students a few questions before their first lesson. Choose a form, say which lessons use it, and see who would be asked.
          </p>
        </div>
      </section>

      <div className="flex justify-end">
        <Link href="/app/settings" className="text-sm font-semibold text-violet-700 hover:text-violet-900">Back to settings</Link>
      </div>

      <StudentIntakeWorkspace
        config={config}
        preview={preview}
        previewError={previewError}
        gateAOpen={status?.gateAOpen === true}
        seed={seed}
      />
    </div>
  );
}

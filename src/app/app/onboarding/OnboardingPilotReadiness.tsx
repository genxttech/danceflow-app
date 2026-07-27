import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileCheck2,
  Gauge,
  Rocket,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";

type Props = {
  studioId: string;
  projectId: string | null;
  targetGoLiveDate: string | null;
};

type ImportBatch = {
  id: string;
  status: string;
  reconciliation_status: string | null;
  stage_key: string | null;
  created_at: string;
};

type Milestone = {
  milestone_key: string;
  status: string;
  required_for_launch: boolean;
};

function percent(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function daysUntil(value: string | null) {
  if (!value) return 30;
  return Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 86400000));
}

export async function OnboardingPilotReadiness({
  studioId,
  projectId,
  targetGoLiveDate,
}: Props) {
  if (!projectId) return null;

  const supabase = await createClient();
  const [
    { data: milestones },
    { data: exceptions },
    { data: decisions },
    { data: batches },
    { data: activationEvents },
  ] = await Promise.all([
    supabase
      .from("onboarding_milestones")
      .select("milestone_key, status, required_for_launch")
      .eq("onboarding_project_id", projectId),
    supabase
      .from("onboarding_exceptions")
      .select("id, severity, status")
      .eq("onboarding_project_id", projectId)
      .in("status", ["open", "in_review"]),
    supabase
      .from("onboarding_decisions")
      .select("id, status")
      .eq("onboarding_project_id", projectId)
      .eq("status", "pending"),
    supabase
      .from("import_batches")
      .select("id, status, reconciliation_status, stage_key, created_at")
      .eq("studio_id", studioId)
      .eq("onboarding_project_id", projectId)
      .order("created_at", { ascending: false }),
    supabase
      .from("onboarding_activation_events")
      .select("event_key, occurred_at")
      .eq("onboarding_project_id", projectId),
  ]);

  const milestoneRows = (milestones ?? []) as Milestone[];
  const importRows = (batches ?? []) as ImportBatch[];
  const required = milestoneRows.filter((row) => row.required_for_launch);
  const requiredReady = required.filter((row) => ["completed", "waived"].includes(row.status));
  const completedImports = importRows.filter((row) =>
    ["completed", "completed_with_warnings"].includes(row.status),
  );
  const reconciledImports = completedImports.filter((row) =>
    ["reconciled", "accepted", "not_required"].includes(row.reconciliation_status ?? ""),
  );
  const openExceptionCount = (exceptions ?? []).length;
  const pendingDecisionCount = (decisions ?? []).length;
  const activationKeys = new Set((activationEvents ?? []).map((row) => row.event_key));
  const activationChecks = [
    "first_import_completed",
    "first_booking_created",
    "first_payment_recorded",
    "first_portal_login",
    "first_aria_action_completed",
  ];
  const activationCount = activationChecks.filter((key) => activationKeys.has(key)).length;

  const milestoneScore = percent(requiredReady.length, required.length);
  const reconciliationScore = percent(reconciledImports.length, completedImports.length);
  const activationScore = percent(activationCount, activationChecks.length);
  const pilotScore = Math.round(
    milestoneScore * 0.55 + reconciliationScore * 0.25 + activationScore * 0.2,
  );
  const blocked = openExceptionCount > 0 || pendingDecisionCount > 0;

  const metrics = [
    { label: "Pilot readiness", value: `${pilotScore}%`, icon: Gauge },
    { label: "Required milestones", value: `${requiredReady.length}/${required.length}`, icon: CheckCircle2 },
    { label: "Imports reconciled", value: `${reconciledImports.length}/${completedImports.length}`, icon: FileCheck2 },
    { label: "Activation signals", value: `${activationCount}/${activationChecks.length}`, icon: Activity },
    { label: "Open exceptions", value: String(openExceptionCount), icon: AlertTriangle },
    { label: "Days to target", value: String(daysUntil(targetGoLiveDate)), icon: Clock3 },
  ];

  return (
    <section className="overflow-hidden rounded-[28px] border border-[#E9D5FF] bg-white shadow-sm">
      <div className="bg-gradient-to-r from-[#111827] via-[#4C1D95] to-[#7C2D92] p-6 text-white">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
              Pilot readiness and activation
            </p>
            <h2 className="mt-2 text-2xl font-semibold">Prove the studio is ready to operate</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/80">
              Readiness combines required setup, migration reconciliation, and real activation signals. Open exceptions and owner decisions remain visible instead of being hidden by a percentage.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-2xl bg-white/10 px-4 py-3 ring-1 ring-white/15">
            <Rocket className="h-5 w-5 text-[#FDBA74]" />
            <div>
              <p className="text-xs text-white/70">Launch state</p>
              <p className="font-semibold">{blocked ? "Needs attention" : pilotScore >= 85 ? "Pilot ready" : "In progress"}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto p-5">
        <div className="flex min-w-max gap-3 md:grid md:min-w-0 md:grid-cols-3 xl:grid-cols-6">
          {metrics.map((metric) => {
            const Icon = metric.icon;
            return (
              <div key={metric.label} className="w-44 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:w-auto">
                <Icon className="h-4 w-4 text-[#6B21A8]" />
                <p className="mt-3 text-2xl font-semibold text-slate-950">{metric.value}</p>
                <p className="mt-1 text-xs font-medium text-slate-500">{metric.label}</p>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 border-t border-[#F3E8FF] bg-[#FCF8FF] p-5 lg:grid-cols-3">
        <div className="rounded-2xl border border-[#E9D5FF] bg-white p-4">
          <p className="text-sm font-semibold text-slate-950">Reconciliation gate</p>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {completedImports.length === 0
              ? "Complete at least one migration stage to begin reconciliation."
              : `${reconciledImports.length} of ${completedImports.length} completed import stages are reconciled.`}
          </p>
          <Link href="/app/settings/import" className="mt-3 inline-flex text-sm font-semibold text-[#6B21A8]">
            Open Migration Center
          </Link>
        </div>

        <div className="rounded-2xl border border-[#E9D5FF] bg-white p-4">
          <p className="text-sm font-semibold text-slate-950">Activation proof</p>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Track the first successful import, booking, payment, portal login, and completed ARIA action before marking the pilot complete.
          </p>
        </div>

        <div className="rounded-2xl border border-[#E9D5FF] bg-white p-4">
          <p className="text-sm font-semibold text-slate-950">Launch blockers</p>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {openExceptionCount === 0 && pendingDecisionCount === 0
              ? "No open exceptions or owner decisions are blocking launch."
              : `${openExceptionCount} exception${openExceptionCount === 1 ? "" : "s"} and ${pendingDecisionCount} owner decision${pendingDecisionCount === 1 ? "" : "s"} remain.`}
          </p>
        </div>
      </div>
    </section>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  ShieldCheck,
  Waves,
} from "lucide-react";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { createAdminClient } from "@/lib/supabase/admin";
import { updateWaveRolloutAction } from "./actions";

type PageProps = { searchParams: Promise<{ status?: string }> };

const notices: Record<string, string> = {
  rollout_updated: "Wave rollout access was updated.",
  invalid_rollout_change: "Choose a valid studio and rollout status.",
  suspension_confirmation_required: "Type SUSPEND exactly to suspend studio posting.",
};

function relativeTokenHealth(value: string | null | undefined) {
  if (!value) return { label: "No expiry reported", tone: "slate" } as const;
  const remaining = new Date(value).getTime() - Date.now();
  if (remaining <= 0) return { label: "Authorization expired", tone: "red" } as const;
  if (remaining <= 7 * 24 * 60 * 60 * 1000) return { label: "Expires within 7 days", tone: "amber" } as const;
  return { label: "Authorization healthy", tone: "green" } as const;
}

function Badge({ tone, children }: { tone: "green" | "amber" | "red" | "slate"; children: ReactNode }) {
  const colors = {
    green: "border-emerald-200 bg-emerald-50 text-emerald-800",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    red: "border-red-200 bg-red-50 text-red-800",
    slate: "border-slate-200 bg-slate-50 text-slate-700",
  };
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${colors[tone]}`}>{children}</span>;
}

export default async function PlatformWavePage({ searchParams }: PageProps) {
  await requirePlatformAdmin();
  const params = await searchParams;
  const admin = createAdminClient();
  const [connectionsResult, studiosResult, entitlementsResult, credentialsResult, runsResult] = await Promise.all([
    admin.from("studio_wave_connections").select("id, studio_id, status, wave_business_name, scopes, posting_enabled, connected_at, last_refreshed_at, last_accounts_sync_at, last_error"),
    admin.from("studios").select("id, name"),
    admin.from("studio_wave_posting_entitlements").select("studio_id, status, notes, granted_at, updated_at"),
    admin.from("studio_wave_credentials").select("connection_id, token_expires_at"),
    admin.from("studio_wave_sync_runs").select("studio_id, status, reconciliation_status, posting_error, created_at").order("created_at", { ascending: false }).limit(1000),
  ]);

  for (const result of [connectionsResult, studiosResult, entitlementsResult, credentialsResult, runsResult]) {
    if (result.error) throw new Error(result.error.message);
  }

  const studios = new Map((studiosResult.data ?? []).map((studio) => [studio.id, studio]));
  const entitlements = new Map((entitlementsResult.data ?? []).map((entitlement) => [entitlement.studio_id, entitlement]));
  const credentials = new Map((credentialsResult.data ?? []).map((credential) => [credential.connection_id, credential]));
  const runsByStudio = new Map<string, typeof runsResult.data>();
  for (const run of runsResult.data ?? []) {
    const existing = runsByStudio.get(run.studio_id) ?? [];
    existing.push(run);
    runsByStudio.set(run.studio_id, existing);
  }

  const rows = (connectionsResult.data ?? []).map((connection) => {
    const studioRuns = runsByStudio.get(connection.studio_id) ?? [];
    const attentionCount = studioRuns.filter((run) => ["failed", "attention_required"].includes(run.status)).length;
    const unreconciledCount = studioRuns.filter((run) => run.status === "posted" && run.reconciliation_status !== "matched").length;
    return {
      connection,
      studio: studios.get(connection.studio_id),
      entitlement: entitlements.get(connection.studio_id),
      token: relativeTokenHealth(credentials.get(connection.id)?.token_expires_at),
      attentionCount,
      unreconciledCount,
      latestRun: studioRuns[0] ?? null,
    };
  }).sort((a, b) => (a.studio?.name ?? "").localeCompare(b.studio?.name ?? ""));

  const postingEnabledCount = rows.filter((row) => row.connection.posting_enabled).length;
  const attentionCount = rows.reduce((sum, row) => sum + row.attentionCount, 0);
  const unreconciledCount = rows.reduce((sum, row) => sum + row.unreconciledCount, 0);
  const platformPostingEnabled = process.env.WAVE_POSTING_ENABLED === "true";

  return (
    <div className="space-y-5 pb-10">
      <header className="overflow-hidden rounded-lg border border-[#4A1265] bg-[#2D0B45] text-white shadow-sm">
        <div className="h-1.5 bg-[#F97316]" />
        <div className="p-6">
          <Link href="/platform" className="inline-flex items-center gap-2 text-sm font-semibold text-fuchsia-200 hover:text-white"><ArrowLeft className="h-4 w-4" />Platform dashboard</Link>
          <div className="mt-5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white text-[#5B197A]"><Waves className="h-5 w-5" /></span><p className="text-xs font-bold uppercase tracking-[0.16em] text-fuchsia-200">DanceFlow Platform</p></div><h1 className="mt-4 text-3xl font-semibold">Wave rollout operations</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-purple-100">Grant studio access, monitor connection health, and stop posting when reconciliation or authorization needs attention.</p></div>
            <Badge tone={platformPostingEnabled ? "green" : "amber"}>{platformPostingEnabled ? "Platform posting available" : "Platform posting paused"}</Badge>
          </div>
        </div>
      </header>

      {params.status && notices[params.status] ? <p className="rounded-lg border border-fuchsia-200 bg-fuchsia-50 px-4 py-3 text-sm text-fuchsia-950">{notices[params.status]}</p> : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"><Building2 className="h-5 w-5 text-[#5B197A]" /><p className="mt-3 text-2xl font-semibold text-slate-950">{rows.length}</p><p className="text-sm text-slate-600">Connected studios</p></div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"><ShieldCheck className="h-5 w-5 text-emerald-700" /><p className="mt-3 text-2xl font-semibold text-slate-950">{postingEnabledCount}</p><p className="text-sm text-slate-600">Studio posting enabled</p></div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"><AlertTriangle className="h-5 w-5 text-red-700" /><p className="mt-3 text-2xl font-semibold text-slate-950">{attentionCount}</p><p className="text-sm text-slate-600">Runs needing attention</p></div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"><CircleDollarSign className="h-5 w-5 text-amber-700" /><p className="mt-3 text-2xl font-semibold text-slate-950">{unreconciledCount}</p><p className="text-sm text-slate-600">Posted runs unreconciled</p></div>
      </section>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-fuchsia-100 bg-fuchsia-50/70 px-5 py-4"><h2 className="text-lg font-semibold text-slate-950">Studio rollout</h2><p className="mt-1 text-sm text-slate-600">Posting remains protected unless the platform, rollout access, and studio authorization are all active.</p></div>
        <div className="divide-y divide-slate-200">
          {rows.map(({ connection, studio, entitlement, token, attentionCount: rowAttention, unreconciledCount: rowUnreconciled, latestRun }) => (
            <article key={connection.id} className="p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-semibold text-slate-950">{studio?.name ?? "Unknown studio"}</h3><Badge tone={connection.status === "connected" ? "green" : "red"}>{connection.status}</Badge><Badge tone={entitlement?.status === "active" || entitlement?.status === "pilot" ? "green" : entitlement?.status === "suspended" ? "red" : "slate"}>{entitlement?.status ?? "Not enabled"}</Badge></div>
                  <p className="mt-1 text-sm text-slate-600">{connection.wave_business_name ?? "No Wave business selected"}</p>
                  <div className="mt-3 flex flex-wrap gap-2"><Badge tone={token.tone}>{token.label}</Badge><Badge tone={connection.scopes?.includes("transaction:write") ? "green" : "amber"}>{connection.scopes?.includes("transaction:write") ? "Posting permission granted" : "Posting permission missing"}</Badge><Badge tone={connection.posting_enabled ? "green" : "slate"}>{connection.posting_enabled ? "Studio posting on" : "Studio posting off"}</Badge>{rowAttention ? <Badge tone="red">{rowAttention} need attention</Badge> : null}{rowUnreconciled ? <Badge tone="amber">{rowUnreconciled} unreconciled</Badge> : null}</div>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500"><span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />Accounts refreshed: {connection.last_accounts_sync_at ? new Date(connection.last_accounts_sync_at).toLocaleString() : "Never"}</span><span>Latest run: {latestRun ? `${latestRun.status.replaceAll("_", " ")} · ${new Date(latestRun.created_at).toLocaleDateString()}` : "None"}</span></div>
                  {connection.last_error ? <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{connection.last_error}</p> : null}
                </div>

                <form action={updateWaveRolloutAction} className="grid w-full gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 xl:w-[430px]">
                  <input type="hidden" name="studioId" value={connection.studio_id} />
                  <label className="text-sm font-medium text-slate-900">Rollout status<select name="status" defaultValue={entitlement?.status ?? "pilot"} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2"><option value="pilot">Pilot</option><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
                  <label className="text-sm font-medium text-slate-900">Suspension confirmation<input name="confirmation" placeholder="SUSPEND when needed" autoComplete="off" className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2" /></label>
                  <label className="text-sm font-medium text-slate-900 sm:col-span-2">Internal rollout note<textarea name="notes" defaultValue={entitlement?.notes ?? ""} rows={2} className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2" /></label>
                  <button className="rounded-md bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white hover:bg-[#46115E] sm:col-span-2">Save rollout access</button>
                </form>
              </div>
            </article>
          ))}
          {!rows.length ? <div className="p-10 text-center"><CheckCircle2 className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-3 text-sm text-slate-600">No studios have connected Wave.</p></div> : null}
        </div>
      </section>
    </div>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  Link2,
  PlugZap,
  ShieldCheck,
  Sparkles,
  Waves,
  Workflow,
} from "lucide-react";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { studioHasFeature } from "@/lib/billing/access";
import { createClient } from "@/lib/supabase/server";

type WaveConnectionRow = {
  id: string;
  status: string | null;
  wave_business_id: string | null;
  wave_business_name: string | null;
  posting_enabled: boolean | null;
  posting_mode: string | null;
  scopes: string[] | null;
  updated_at: string | null;
};

type WaveRunRow = {
  id: string;
  status: string | null;
  created_at: string | null;
  posting_error: string | null;
  reconciliation_status: string | null;
};

type StudioStripeRow = {
  stripe_connected_account_id: string | null;
  stripe_connect_details_submitted: boolean | null;
  stripe_connect_charges_enabled: boolean | null;
  stripe_connect_payouts_enabled: boolean | null;
  stripe_connect_onboarding_complete: boolean | null;
};

type IntegrationStatus = "connected" | "attention" | "available" | "locked" | "coming_soon";

function formatDate(value: string | null | undefined) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function statusLabel(status: IntegrationStatus) {
  switch (status) {
    case "connected":
      return "Connected";
    case "attention":
      return "Needs attention";
    case "available":
      return "Available";
    case "locked":
      return "Upgrade required";
    case "coming_soon":
      return "Coming soon";
  }
}

function statusClass(status: IntegrationStatus) {
  switch (status) {
    case "connected":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "attention":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "available":
      return "border-sky-200 bg-sky-50 text-sky-800";
    case "locked":
      return "border-slate-200 bg-slate-50 text-slate-700";
    case "coming_soon":
      return "border-violet-200 bg-violet-50 text-violet-800";
  }
}

function StatusBadge({ status }: { status: IntegrationStatus }) {
  return (
    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${statusClass(status)}`}>
      {statusLabel(status)}
    </span>
  );
}

function ActionLink({ href, children, external = false }: { href: string; children: React.ReactNode; external?: boolean }) {
  const className = "inline-flex items-center justify-center gap-2 rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#46115E]";

  if (external) {
    return (
      <a href={href} className={className}>
        {children}
        <ExternalLink className="h-4 w-4" />
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      {children}
      <ArrowRight className="h-4 w-4" />
    </Link>
  );
}

function IntegrationCard({
  title,
  eyebrow,
  description,
  status,
  icon: Icon,
  children,
  action,
  muted = false,
}: {
  title: string;
  eyebrow: string;
  description: string;
  status: IntegrationStatus;
  icon: typeof Waves;
  children?: React.ReactNode;
  action?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <section className={`rounded-[28px] border p-6 shadow-sm ${muted ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white"}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#5B197A] text-white">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#BE185D]">{eyebrow}</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">{title}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{description}</p>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {children ? <div className="mt-5 grid gap-3 sm:grid-cols-3">{children}</div> : null}
      {action ? <div className="mt-5 flex flex-wrap gap-3">{action}</div> : null}
    </section>
  );
}

function Signal({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-950">{value}</p>
    </div>
  );
}

export default async function StudioIntegrationHubPage() {
  const context = await getCurrentStudioContext();
  if (!canManageSettings(context.studioRole ?? "")) redirect("/app");

  const supabase = await createClient();
  const waveAvailable = await studioHasFeature("wave_accounting");

  const [{ data: studio, error: studioError }, { data: waveConnection, error: waveError }] = await Promise.all([
    supabase
      .from("studios")
      .select(
        "stripe_connected_account_id, stripe_connect_details_submitted, stripe_connect_charges_enabled, stripe_connect_payouts_enabled, stripe_connect_onboarding_complete",
      )
      .eq("id", context.studioId)
      .maybeSingle<StudioStripeRow>(),
    supabase
      .from("studio_wave_connections")
      .select("id, status, wave_business_id, wave_business_name, posting_enabled, posting_mode, scopes, updated_at")
      .eq("studio_id", context.studioId)
      .maybeSingle<WaveConnectionRow>(),
  ]);

  if (studioError) throw new Error(`Failed to load Stripe status: ${studioError.message}`);
  if (waveError) throw new Error(`Failed to load Wave status: ${waveError.message}`);

  const { data: recentWaveRuns, error: runsError } = waveConnection?.id
    ? await supabase
        .from("studio_wave_sync_runs")
        .select("id, status, created_at, posting_error, reconciliation_status")
        .eq("connection_id", waveConnection.id)
        .order("created_at", { ascending: false })
        .limit(5)
    : { data: [] as WaveRunRow[], error: null };

  if (runsError) throw new Error(`Failed to load Wave runs: ${runsError.message}`);

  const stripeConnected = Boolean(studio?.stripe_connected_account_id);
  const stripeReady = Boolean(
    studio?.stripe_connected_account_id &&
      studio?.stripe_connect_onboarding_complete &&
      studio?.stripe_connect_charges_enabled &&
      studio?.stripe_connect_payouts_enabled,
  );
  const stripeStatus: IntegrationStatus = stripeReady ? "connected" : stripeConnected ? "attention" : "available";

  const waveConnected = waveConnection?.status === "connected";
  const waveNeedsReauth = waveConnected && !waveConnection.scopes?.includes("transaction:write");
  const waveHasBusiness = Boolean(waveConnection?.wave_business_id);
  const waveStatus: IntegrationStatus = !waveAvailable
    ? "locked"
    : waveConnected && waveHasBusiness && !waveNeedsReauth
      ? "connected"
      : waveConnected
        ? "attention"
        : "available";

  const latestRun = (recentWaveRuns ?? [])[0] as WaveRunRow | undefined;
  const failedWaveRuns = (recentWaveRuns ?? []).filter((run) =>
    ["failed", "attention_required", "posting_failed", "posting_uncertain"].includes(String(run.status ?? "")),
  ).length;

  const connectedCount = [stripeReady, waveStatus === "connected"].filter(Boolean).length;
  const attentionCount = [stripeStatus, waveStatus].filter((status) => status === "attention").length;

  return (
    <main className="space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-fuchsia-200 bg-gradient-to-br from-[#5B197A] via-[#7E22CE] to-[#BE185D] text-white shadow-sm">
        <div className="p-7 sm:p-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-fuchsia-100">Studio Integration Hub</p>
              <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Connect the tools that run your studio.</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-fuchsia-50">
                Manage payments, accounting, calendars, automation, and future productivity connections from one streamlined setup page.
              </p>
            </div>
            <Link href="/app/settings" className="inline-flex items-center justify-center rounded-2xl border border-white/25 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15">
              Back to settings
            </Link>
          </div>
        </div>
        <div className="grid border-t border-white/15 bg-white/10 sm:grid-cols-3">
          <div className="p-5"><p className="text-xs uppercase tracking-[0.18em] text-fuchsia-100">Connected</p><p className="mt-2 text-2xl font-bold">{connectedCount}</p></div>
          <div className="border-t border-white/15 p-5 sm:border-l sm:border-t-0"><p className="text-xs uppercase tracking-[0.18em] text-fuchsia-100">Needs Attention</p><p className="mt-2 text-2xl font-bold">{attentionCount}</p></div>
          <div className="border-t border-white/15 p-5 sm:border-l sm:border-t-0"><p className="text-xs uppercase tracking-[0.18em] text-fuchsia-100">Coming Soon</p><p className="mt-2 text-2xl font-bold">4</p></div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <IntegrationCard
            eyebrow="Payments"
            title="Stripe Payments"
            description="Accept card payments, event ticket purchases, payment requests, terminal payments, package sales, and membership payments through Stripe Connect."
            status={stripeStatus}
            icon={CircleDollarSign}
            action={
              <ActionLink href="/app/settings/billing">
                {stripeConnected ? "Manage Stripe" : "Set up payments"}
              </ActionLink>
            }
          >
            <Signal label="Account" value={stripeConnected ? "Connected account found" : "Not connected"} />
            <Signal label="Charges" value={studio?.stripe_connect_charges_enabled ? "Enabled" : "Not enabled"} />
            <Signal label="Payouts" value={studio?.stripe_connect_payouts_enabled ? "Enabled" : "Not enabled"} />
          </IntegrationCard>

          <IntegrationCard
            eyebrow="Accounting"
            title="Wave Accounting"
            description="Connect a Wave business, map accounting categories, preview posting lines, approve review runs, and reconcile posted activity."
            status={waveStatus}
            icon={Waves}
            action={
              waveAvailable ? (
                <ActionLink href="/app/settings/integrations/wave">
                  {waveConnected ? "Manage Wave" : "Connect Wave"}
                </ActionLink>
              ) : (
                <ActionLink href="/app/settings/billing?feature=wave_accounting">Upgrade for Wave</ActionLink>
              )
            }
          >
            <Signal label="Business" value={waveConnection?.wave_business_name ?? "Not selected"} />
            <Signal label="Posting Mode" value={String(waveConnection?.posting_mode ?? "manual_review").replaceAll("_", " ")} />
            <Signal label="Latest Run" value={latestRun ? `${String(latestRun.status ?? "draft").replaceAll("_", " ")} · ${formatDate(latestRun.created_at)}` : "No runs yet"} />
          </IntegrationCard>
        </div>

        <aside className="space-y-6">
          <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-fuchsia-50 text-[#BE185D]"><Sparkles className="h-5 w-5" /></span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">ARIA Readiness</p>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Automation starts with clean connections.</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Stripe and Wave are the first operational integrations. Calendar, QuickBooks, and workflow connections will use this hub as they come online.
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Needs Attention</p>
            <div className="mt-4 space-y-3">
              {!stripeReady ? (
                <Link href="/app/settings/billing" className="block rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 hover:bg-amber-100">
                  <p className="font-semibold">Stripe setup is not fully ready.</p>
                  <p className="mt-1">Finish onboarding, charges, and payouts before relying on live payments.</p>
                </Link>
              ) : null}
              {waveNeedsReauth ? (
                <Link href="/app/settings/integrations/wave" className="block rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 hover:bg-amber-100">
                  <p className="font-semibold">Wave needs reauthorization.</p>
                  <p className="mt-1">Reconnect once to approve posting access.</p>
                </Link>
              ) : null}
              {failedWaveRuns > 0 ? (
                <Link href="/app/settings/integrations/wave" className="block rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 hover:bg-red-100">
                  <p className="font-semibold">Wave has {failedWaveRuns} recent run{failedWaveRuns === 1 ? "" : "s"} needing review.</p>
                  <p className="mt-1">Open Wave to review posting or reconciliation details.</p>
                </Link>
              ) : null}
              {stripeReady && !waveNeedsReauth && failedWaveRuns === 0 ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                  <p className="font-semibold">Core integrations look healthy.</p>
                  <p className="mt-1">No immediate integration action is needed.</p>
                </div>
              ) : null}
            </div>
          </section>
        </aside>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <IntegrationCard eyebrow="Calendar" title="Google Calendar" description="Sync lessons, classes, instructors, rooms, and reminders with Google Calendar." status="coming_soon" icon={CalendarDays} muted>
          <Signal label="Status" value="Planned" />
          <Signal label="Direction" value="Calendar productivity lane" />
          <Signal label="Setup" value="Coming soon" />
        </IntegrationCard>
        <IntegrationCard eyebrow="Accounting" title="QuickBooks Online" description="Future accounting option for studios that prefer QuickBooks over Wave." status="coming_soon" icon={BadgeCheck} muted>
          <Signal label="Status" value="Planned" />
          <Signal label="Priority" value="Next accounting integration" />
          <Signal label="Setup" value="Coming soon" />
        </IntegrationCard>
        <IntegrationCard eyebrow="Calendar" title="Outlook Calendar" description="Microsoft 365 calendar support for studios and instructors using Outlook." status="coming_soon" icon={Clock3} muted>
          <Signal label="Status" value="Planned" />
          <Signal label="Direction" value="Productivity integration" />
          <Signal label="Setup" value="Coming soon" />
        </IntegrationCard>
        <IntegrationCard eyebrow="Automation" title="Zapier / Make" description="Send DanceFlow events to external workflows without a custom integration." status="coming_soon" icon={Workflow} muted>
          <Signal label="Status" value="Planned" />
          <Signal label="Direction" value="Workflow automation" />
          <Signal label="Setup" value="Coming soon" />
        </IntegrationCard>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-100 text-slate-700"><ShieldCheck className="h-5 w-5" /></span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Integration Standard</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Every connection should have status, setup, sync health, and exceptions.</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              This hub keeps integration setup streamlined for studios and gives ARIA a clean place to surface automation readiness and exception queues later.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

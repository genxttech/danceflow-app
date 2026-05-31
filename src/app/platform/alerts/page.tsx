import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformAdmin } from "@/lib/auth/platform";

type StudioRow = {
  id: string;
  name: string;
  created_at: string;
  subscription_status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

type PlatformErrorLogRow = {
  id: string;
  severity: string;
  source: string;
  message: string;
  details: Record<string, unknown> | null;
  created_at: string;
  resolved_at: string | null;
};

type PackageDeductionErrorRow = {
  id: string;
  appointment_id: string | null;
  studio_id: string | null;
  client_id: string | null;
  client_package_id: string | null;
  appointment_type: string | null;
  error_message: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution_notes: string | null;
};

function formatDateTime(value: string | null) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatRelativeAge(value: string | null) {
  if (!value) return "—";

  const created = new Date(value).getTime();
  const diffMs = Date.now() - created;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));

  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function statusBadgeClass(status: string) {
  if (status === "active") return "bg-green-50 text-green-700 ring-1 ring-green-200";
  if (status === "trialing") return "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  if (status === "past_due") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (status === "cancelled" || status === "canceled") return "bg-red-50 text-red-700 ring-1 ring-red-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function statusLabel(status: string) {
  if (status === "trialing") return "Trial";
  if (status === "active") return "Active";
  if (status === "past_due") return "Past Due";
  if (status === "cancelled" || status === "canceled") return "Canceled";
  if (status === "no_subscription") return "No Subscription";
  if (status === "inactive") return "Inactive";
  return status.replaceAll("_", " ");
}

function severityBadgeClass(severity: string) {
  if (severity === "critical") return "bg-red-50 text-red-700 ring-1 ring-red-200";
  if (severity === "warning") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function severityPanelClass(severity: string) {
  if (severity === "critical") return "border-red-200 bg-red-50";
  if (severity === "warning") return "border-amber-200 bg-amber-50";
  return "border-slate-200 bg-slate-50";
}

function severityTextClass(severity: string) {
  if (severity === "critical") return "text-red-950";
  if (severity === "warning") return "text-amber-950";
  return "text-slate-950";
}

function isOrganizerWorkspace(studioName: string) {
  const normalizedName = studioName.trim().toLowerCase();

  return (
    normalizedName.endsWith(" organizer") ||
    normalizedName.includes(" organizer ") ||
    normalizedName.endsWith(" events") ||
    normalizedName.includes(" festival")
  );
}

function hasActiveBillingAccess(status: string | null | undefined) {
  return status === "active" || status === "trialing";
}

function hasPaidBillingFootprint(studio: StudioRow) {
  return Boolean(studio.stripe_subscription_id);
}

function recommendedErrorAction(errorLog: PlatformErrorLogRow) {
  const source = errorLog.source.toLowerCase();
  const message = errorLog.message.toLowerCase();

  if (source.includes("stripe") || message.includes("stripe")) {
    return "Check Stripe/webhook state, confirm payment status, then mark resolved once the affected record is corrected.";
  }

  if (source.includes("registration") || message.includes("registration")) {
    return "Open the related event or registration if available, confirm the user-facing flow still works, then resolve.";
  }

  if (source.includes("notification") || message.includes("email") || message.includes("resend")) {
    return "Review outbound delivery status and confirm whether the message should be retried or ignored.";
  }

  if (errorLog.severity === "critical") {
    return "Review immediately. Confirm whether users are blocked, patch the issue, then mark resolved.";
  }

  return "Review details, confirm whether action is needed, then mark resolved or leave open for follow-up.";
}

export default async function PlatformAlertsPage() {
  await requirePlatformAdmin();

  async function resolvePlatformErrorAction(formData: FormData) {
    "use server";

    await requirePlatformAdmin();

    const errorId = String(formData.get("errorId") ?? "").trim();

    if (!errorId) {
      redirect("/platform/alerts");
    }

    const supabase = await createClient();

    const { error } = await supabase
      .from("platform_error_logs")
      .update({ resolved_at: new Date().toISOString() })
      .eq("id", errorId)
      .is("resolved_at", null);

    if (error) {
      redirect("/platform/alerts?error=resolve_failed");
    }

    redirect("/platform/alerts?status=resolved");
  }

  async function resolvePackageDeductionErrorAction(formData: FormData) {
    "use server";

    await requirePlatformAdmin();

    const errorId = String(formData.get("errorId") ?? "").trim();
    const resolutionNotes = String(formData.get("resolutionNotes") ?? "").trim();

    if (!errorId) {
      redirect("/platform/alerts");
    }

    const supabase = await createClient();

    const { error } = await supabase
      .from("appointment_package_deduction_errors")
      .update({
        resolved_at: new Date().toISOString(),
        resolution_notes: resolutionNotes || null,
      })
      .eq("id", errorId)
      .is("resolved_at", null);

    if (error) {
      redirect("/platform/alerts?error=package_resolve_failed");
    }

    redirect("/platform/alerts?status=package_resolved");
  }

  const supabase = await createClient();

  const [
    { data: studios, error: studiosError },
    { data: platformErrorLogs, error: platformErrorLogsError },
    { data: packageDeductionErrors, error: packageDeductionErrorsError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, created_at, subscription_status, stripe_customer_id, stripe_subscription_id")
      .order("created_at", { ascending: false }),

    supabase
      .from("platform_error_logs")
      .select("id, severity, source, message, details, created_at, resolved_at")
      .order("created_at", { ascending: false })
      .limit(125),

    supabase
      .from("appointment_package_deduction_errors")
      .select(
        "id, appointment_id, studio_id, client_id, client_package_id, appointment_type, error_message, created_at, resolved_at, resolution_notes"
      )
      .order("created_at", { ascending: false })
      .limit(125),
  ]);

  if (studiosError) {
    throw new Error(`Failed to load studios: ${studiosError.message}`);
  }
  if (platformErrorLogsError) {
    throw new Error(`Failed to load platform error logs: ${platformErrorLogsError.message}`);
  }

  if (packageDeductionErrorsError) {
    throw new Error(
      `Failed to load package deduction errors: ${packageDeductionErrorsError.message}`
    );
  }

  const typedStudios = (studios ?? []) as StudioRow[];
  const typedPlatformErrorLogs = (platformErrorLogs ?? []) as PlatformErrorLogRow[];
  const typedPackageDeductionErrors = (packageDeductionErrors ?? []) as PackageDeductionErrorRow[];

  const billingRiskAccounts = typedStudios
    .map((studio) => {
      const status = studio.subscription_status ?? "no_subscription";

      return {
        studio,
        workspaceType: isOrganizerWorkspace(studio.name) ? "Organizer" : "Studio",
        status,
      };
    })
    .filter(({ studio, status }) => {
      if (!hasPaidBillingFootprint(studio)) return false;
      return !hasActiveBillingAccess(status);
    });

  const unresolvedPlatformErrors = typedPlatformErrorLogs.filter(
    (errorLog) => !errorLog.resolved_at
  );

  const resolvedPlatformErrors = typedPlatformErrorLogs.filter(
    (errorLog) => Boolean(errorLog.resolved_at)
  );

  const unresolvedPackageDeductionErrors = typedPackageDeductionErrors.filter(
    (errorLog) => !errorLog.resolved_at
  );

  const resolvedPackageDeductionErrors = typedPackageDeductionErrors.filter(
    (errorLog) => Boolean(errorLog.resolved_at)
  );

  const criticalErrors = unresolvedPlatformErrors.filter(
    (errorLog) => errorLog.severity === "critical"
  );
  const warningErrors = unresolvedPlatformErrors.filter(
    (errorLog) => errorLog.severity === "warning"
  );
  const monitorErrors = unresolvedPlatformErrors.filter(
    (errorLog) => errorLog.severity !== "critical" && errorLog.severity !== "warning"
  );

  const mostRecentOpenIssue = [
    ...unresolvedPlatformErrors.map((issue) => ({ type: "backend", created_at: issue.created_at })),
    ...unresolvedPackageDeductionErrors.map((issue) => ({ type: "package", created_at: issue.created_at })),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  const totalAlertCount =
    billingRiskAccounts.length +
    unresolvedPlatformErrors.length +
    unresolvedPackageDeductionErrors.length;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.42)_0%,rgba(255,255,255,0)_20%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Platform Admin
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Server Error Review
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                Work the open platform queue: billing risk, backend errors, and package deduction issues that need review before studios report them.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/platform"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Dashboard
              </Link>
              <Link
                href="/platform/billing"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Billing Risk
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
              <p className="text-sm text-red-700">Critical Errors</p>
              <p className="mt-1 text-2xl font-semibold text-red-950">{criticalErrors.length}</p>
              <p className="mt-1 text-xs text-red-700">Fix first</p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-700">Warnings</p>
              <p className="mt-1 text-2xl font-semibold text-amber-950">{warningErrors.length}</p>
              <p className="mt-1 text-xs text-amber-700">Review today</p>
            </div>

            <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
              <p className="text-sm text-orange-700">Package Issues</p>
              <p className="mt-1 text-2xl font-semibold text-orange-950">{unresolvedPackageDeductionErrors.length}</p>
              <p className="mt-1 text-xs text-orange-700">May affect balances</p>
            </div>

            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
              <p className="text-sm text-rose-700">Billing Risks</p>
              <p className="mt-1 text-2xl font-semibold text-rose-950">{billingRiskAccounts.length}</p>
              <p className="mt-1 text-xs text-rose-700">Access/billing mismatch</p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Needs Attention
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Open operations queue
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Start with critical backend errors, then billing risk, then warnings and package deduction issues.
              </p>
            </div>
            <span className="rounded-full bg-slate-950 px-3 py-1 text-sm font-semibold text-white">
              {totalAlertCount} open
            </span>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <a href="#backend-errors" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 transition hover:border-amber-300 hover:bg-amber-100">
              <p className="text-sm font-semibold text-amber-950">Backend errors</p>
              <p className="mt-1 text-2xl font-semibold text-amber-950">{unresolvedPlatformErrors.length}</p>
              <p className="mt-1 text-xs text-amber-800">Critical, warning, and monitor items</p>
            </a>
            <a href="#package-errors" className="rounded-2xl border border-orange-200 bg-orange-50 p-4 transition hover:border-orange-300 hover:bg-orange-100">
              <p className="text-sm font-semibold text-orange-950">Package errors</p>
              <p className="mt-1 text-2xl font-semibold text-orange-950">{unresolvedPackageDeductionErrors.length}</p>
              <p className="mt-1 text-xs text-orange-800">Credit/balance follow-up</p>
            </a>
            <Link href="/platform/billing" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 transition hover:border-rose-300 hover:bg-rose-100">
              <p className="text-sm font-semibold text-rose-950">Billing risk</p>
              <p className="mt-1 text-2xl font-semibold text-rose-950">{billingRiskAccounts.length}</p>
              <p className="mt-1 text-xs text-rose-800">Open billing workflow</p>
            </Link>
          </div>
        </div>

        <aside className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Triage Snapshot
          </p>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-600">Most recent open issue</dt>
              <dd className="font-semibold text-slate-950">
                {mostRecentOpenIssue ? formatRelativeAge(mostRecentOpenIssue.created_at) : "None"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-600">Resolved backend logs shown</dt>
              <dd className="font-semibold text-slate-950">{resolvedPlatformErrors.length}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-600">Resolved package issues shown</dt>
              <dd className="font-semibold text-slate-950">{resolvedPackageDeductionErrors.length}</dd>
            </div>
          </dl>
          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
            Resolve an item only after the root issue has been reviewed or the affected data has been corrected.
          </div>
        </aside>
      </section>

      {totalAlertCount === 0 ? (
        <section className="rounded-[32px] border border-green-200 bg-green-50 p-6 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-green-700">
            All Clear
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-green-950">
            No platform alerts need review
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-green-800">
            No billing risk, unresolved backend errors, or package deduction issues were found.
          </p>
        </section>
      ) : null}

      <section className="rounded-[32px] border border-rose-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-rose-700">
              Billing Risk
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              Paid access without healthy billing
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              These workspaces have a Stripe subscription footprint but are not active or trialing. Review them in the billing workflow.
            </p>
          </div>

          <Link
            href="/platform/billing"
            className="rounded-xl bg-rose-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-800"
          >
            Open Billing Risk
          </Link>
        </div>

        {billingRiskAccounts.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-green-200 bg-green-50 p-5 text-sm text-green-700">
            No billing risk accounts detected.
          </div>
        ) : (
          <div className="mt-5 grid gap-3">
            {billingRiskAccounts.slice(0, 6).map(({ studio, workspaceType, status }) => (
              <div key={studio.id} className="rounded-2xl border border-rose-100 bg-rose-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Link href={`/platform/studios/${studio.id}`} className="font-semibold text-rose-950 underline">
                      {studio.name}
                    </Link>
                    <p className="mt-1 text-xs text-rose-800">
                      {workspaceType} · Created {formatDateTime(studio.created_at)}
                    </p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(status)}`}>
                    {statusLabel(status)}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-3 text-sm text-slate-600">
                  <span>Recommended action: confirm Stripe status and suspend or restore access intentionally.</span>
                  <Link href="/platform/billing" className="font-semibold text-rose-700 underline">
                    Review billing
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section id="backend-errors" className="rounded-[32px] border border-amber-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
              Server Error Review
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              Unresolved backend errors
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Expand each issue, review the details, follow the recommended action, and mark it resolved when handled.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-semibold">
            <span className="rounded-full bg-red-50 px-3 py-1 text-red-700 ring-1 ring-red-200">Critical {criticalErrors.length}</span>
            <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700 ring-1 ring-amber-200">Warning {warningErrors.length}</span>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700 ring-1 ring-slate-200">Monitor {monitorErrors.length}</span>
          </div>
        </div>

        {unresolvedPlatformErrors.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-green-200 bg-green-50 p-5 text-sm text-green-700">
            No unresolved backend errors found.
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {unresolvedPlatformErrors.map((errorLog) => (
              <details key={errorLog.id} className={`group rounded-2xl border p-4 ${severityPanelClass(errorLog.severity)}`}>
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`font-semibold ${severityTextClass(errorLog.severity)}`}>{errorLog.source}</p>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${severityBadgeClass(errorLog.severity)}`}>
                        {errorLog.severity || "info"}
                      </span>
                      <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                        {formatRelativeAge(errorLog.created_at)}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm text-slate-700">{errorLog.message}</p>
                    <p className="mt-2 text-xs text-slate-500">Created {formatDateTime(errorLog.created_at)}</p>
                  </div>

                  <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-slate-800 ring-1 ring-slate-200">
                    <span className="group-open:hidden">Review</span>
                    <span className="hidden group-open:inline">Collapse</span>
                  </span>
                </summary>

                <div className="mt-4 space-y-4">
                  <div className="rounded-xl border border-white bg-white/80 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Recommended action</p>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{recommendedErrorAction(errorLog)}</p>
                  </div>

                  <pre className="max-h-72 overflow-auto rounded-xl bg-white p-4 text-xs text-slate-700 ring-1 ring-slate-200">
                    {JSON.stringify(errorLog.details ?? {}, null, 2)}
                  </pre>

                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
                    <p className="text-sm text-slate-600">Mark resolved after review, data correction, or code fix.</p>
                    <form action={resolvePlatformErrorAction}>
                      <input type="hidden" name="errorId" value={errorLog.id} />
                      <button type="submit" className="rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-800">
                        Mark Resolved
                      </button>
                    </form>
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </section>

      <section id="package-errors" className="rounded-[32px] border border-orange-200 bg-white p-6 shadow-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700">
            Package Deduction Review
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Appointment package credit issues
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Resolve these after the client/package balance has been checked or corrected.
          </p>
        </div>

        {unresolvedPackageDeductionErrors.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-green-200 bg-green-50 p-5 text-sm text-green-700">
            No package deduction errors found.
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {unresolvedPackageDeductionErrors.map((errorLog) => (
              <details key={errorLog.id} className="group rounded-2xl border border-orange-200 bg-orange-50 p-4">
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-orange-950">
                        {errorLog.appointment_type ?? "Appointment"} package deduction issue
                      </p>
                      <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-orange-700 ring-1 ring-orange-200">
                        {formatRelativeAge(errorLog.created_at)}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm text-orange-800">
                      {errorLog.error_message ?? "Package credit deduction needs review."}
                    </p>
                    <p className="mt-2 text-xs text-orange-700">Created {formatDateTime(errorLog.created_at)}</p>
                  </div>

                  <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-orange-800 ring-1 ring-orange-200">
                    <span className="group-open:hidden">Review</span>
                    <span className="hidden group-open:inline">Collapse</span>
                  </span>
                </summary>

                <div className="mt-4 grid gap-3 rounded-xl bg-white p-4 text-sm text-slate-700 md:grid-cols-2">
                  <p><span className="font-semibold">Appointment:</span> {errorLog.appointment_id ?? "—"}</p>
                  <p><span className="font-semibold">Studio:</span> {errorLog.studio_id ?? "—"}</p>
                  <p><span className="font-semibold">Client:</span> {errorLog.client_id ?? "—"}</p>
                  <p><span className="font-semibold">Package:</span> {errorLog.client_package_id ?? "—"}</p>
                </div>

                <form action={resolvePackageDeductionErrorAction} className="mt-4 rounded-xl border border-orange-200 bg-white p-4">
                  <input type="hidden" name="errorId" value={errorLog.id} />
                  <label className="block text-sm font-semibold text-slate-800" htmlFor={`resolutionNotes-${errorLog.id}`}>
                    Resolution notes
                  </label>
                  <textarea
                    id={`resolutionNotes-${errorLog.id}`}
                    name="resolutionNotes"
                    rows={3}
                    placeholder="Example: Applied the correct package credit and confirmed the appointment attendance."
                    className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                  />
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-slate-600">Add a note before resolving so the issue has a short audit trail.</p>
                    <button type="submit" className="rounded-xl bg-orange-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-800">
                      Mark Resolved
                    </button>
                  </div>
                </form>
              </details>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Recently Resolved</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">Review history</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">Recent resolved items are shown for context while auditing platform health.</p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="font-semibold text-slate-950">Backend errors</p>
            {resolvedPlatformErrors.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">No resolved backend errors in the latest results.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {resolvedPlatformErrors.slice(0, 6).map((errorLog) => (
                  <div key={errorLog.id} className="rounded-xl bg-white p-3 text-sm ring-1 ring-slate-200">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-slate-900">{errorLog.source}</span>
                      <span className="text-xs text-slate-500">{formatDateTime(errorLog.resolved_at)}</span>
                    </div>
                    <p className="mt-1 line-clamp-1 text-xs text-slate-600">{errorLog.message}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="font-semibold text-slate-950">Package deduction issues</p>
            {resolvedPackageDeductionErrors.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">No resolved package issues in the latest results.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {resolvedPackageDeductionErrors.slice(0, 6).map((errorLog) => (
                  <div key={errorLog.id} className="rounded-xl bg-white p-3 text-sm ring-1 ring-slate-200">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-slate-900">{errorLog.appointment_type ?? "Appointment"}</span>
                      <span className="text-xs text-slate-500">{formatDateTime(errorLog.resolved_at)}</span>
                    </div>
                    <p className="mt-1 line-clamp-1 text-xs text-slate-600">{errorLog.resolution_notes || errorLog.error_message || "Resolved"}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}





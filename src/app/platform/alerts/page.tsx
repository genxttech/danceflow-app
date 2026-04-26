import Link from "next/link";
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

export default async function PlatformAlertsPage() {
  await requirePlatformAdmin();

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
      .limit(100),

    supabase
      .from("appointment_package_deduction_errors")
      .select(
        "id, appointment_id, studio_id, client_id, client_package_id, appointment_type, error_message, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(100),
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

  const totalAlertCount =
    billingRiskAccounts.length +
    unresolvedPlatformErrors.length +
    typedPackageDeductionErrors.length;

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
                Platform Alerts
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                Review billing risk, server-side errors, and package deduction issues in one place so problems can be handled before users report them.
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
                Billing Health
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
              <p className="text-sm text-rose-700">Billing Risk</p>
              <p className="mt-1 text-2xl font-semibold text-rose-950">
                {billingRiskAccounts.length}
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-700">Server-Side Errors</p>
              <p className="mt-1 text-2xl font-semibold text-amber-950">
                {unresolvedPlatformErrors.length}
              </p>
            </div>

            <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
              <p className="text-sm text-orange-700">Package Deduction Errors</p>
              <p className="mt-1 text-2xl font-semibold text-orange-950">
                {typedPackageDeductionErrors.length}
              </p>
            </div>
          </div>
        </div>
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
            No billing risk, unresolved server-side error, or package deduction error rows were found.
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
              Paid-plan access without active subscription
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              These workspaces have a Stripe subscription id but are not active or trialing.
            </p>
          </div>

          <Link
            href="/platform/billing"
            className="rounded-xl bg-rose-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-800"
          >
            Open Billing
          </Link>
        </div>

        {billingRiskAccounts.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-green-200 bg-green-50 p-5 text-sm text-green-700">
            No billing risk accounts detected.
          </div>
        ) : (
          <div className="mt-5 overflow-hidden rounded-2xl border border-rose-100">
            <div className="grid grid-cols-12 gap-3 bg-rose-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-rose-700">
              <div className="col-span-4">Workspace</div>
              <div className="col-span-2">Type</div>
              <div className="col-span-2">Billing</div>
              <div className="col-span-2">Status</div>
              <div className="col-span-2 text-right">Review</div>
            </div>

            {billingRiskAccounts.map(({ studio, workspaceType, status }) => (
              <div
                key={studio.id}
                className="grid grid-cols-12 gap-3 border-t border-rose-100 px-4 py-4 text-sm"
              >
                <div className="col-span-4">
                  <Link
                    href={`/platform/studios/${studio.id}`}
                    className="font-semibold text-slate-950 underline"
                  >
                    {studio.name}
                  </Link>
                  <p className="mt-1 text-xs text-slate-500">
                    Created {formatDateTime(studio.created_at)}
                  </p>
                </div>
                <div className="col-span-2 text-slate-600">{workspaceType}</div>
                <div className="col-span-2 text-slate-600">Stripe subscription</div>
                <div className="col-span-2">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(status)}`}>
                    {statusLabel(status)}
                  </span>
                  <p className="mt-2 text-xs text-slate-500">
                    Stripe sub {studio.stripe_subscription_id ? `${studio.stripe_subscription_id.slice(0, 12)}…` : "—"}
                  </p>
                </div>
                <div className="col-span-2 text-right">
                  <Link href="/platform/billing" className="text-sm font-semibold underline">
                    Billing
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-[32px] border border-amber-200 bg-white p-6 shadow-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
            Server-Side Errors
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Unresolved backend errors
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            These are rows from platform_error_logs. Phase 2 can add acknowledgement, resolution workflows, and email notifications.
          </p>
        </div>

        {unresolvedPlatformErrors.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-green-200 bg-green-50 p-5 text-sm text-green-700">
            No unresolved server-side errors found.
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {unresolvedPlatformErrors.map((errorLog) => (
              <details
                key={errorLog.id}
                className="group rounded-2xl border border-amber-200 bg-amber-50 p-4"
              >
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-amber-950">{errorLog.source}</p>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${severityBadgeClass(errorLog.severity)}`}>
                        {errorLog.severity}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm text-amber-800">
                      {errorLog.message}
                    </p>
                    <p className="mt-2 text-xs text-amber-700">
                      {formatDateTime(errorLog.created_at)}
                    </p>
                  </div>

                  <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-amber-800 ring-1 ring-amber-200">
                    <span className="group-open:hidden">Expand</span>
                    <span className="hidden group-open:inline">Collapse</span>
                  </span>
                </summary>

                <pre className="mt-4 max-h-72 overflow-auto rounded-xl bg-white p-4 text-xs text-slate-700">
                  {JSON.stringify(errorLog.details ?? {}, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-[32px] border border-orange-200 bg-white p-6 shadow-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700">
            Package Deduction Errors
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Appointment package credit issues
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            These rows are created when the attended-appointment deduction trigger catches a non-blocking package credit error.
          </p>
        </div>

        {typedPackageDeductionErrors.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-green-200 bg-green-50 p-5 text-sm text-green-700">
            No package deduction errors found.
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {typedPackageDeductionErrors.map((errorLog) => (
              <details
                key={errorLog.id}
                className="group rounded-2xl border border-orange-200 bg-orange-50 p-4"
              >
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
                  <div>
                    <p className="font-semibold text-orange-950">
                      {errorLog.appointment_type ?? "Appointment"} package deduction error
                    </p>
                    <p className="mt-2 line-clamp-2 text-sm text-orange-800">
                      {errorLog.error_message ?? "Package credit deduction failed."}
                    </p>
                    <p className="mt-2 text-xs text-orange-700">
                      {formatDateTime(errorLog.created_at)}
                    </p>
                  </div>

                  <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-orange-800 ring-1 ring-orange-200">
                    <span className="group-open:hidden">Expand</span>
                    <span className="hidden group-open:inline">Collapse</span>
                  </span>
                </summary>

                <div className="mt-4 grid gap-3 rounded-xl bg-white p-4 text-sm text-slate-700 md:grid-cols-2">
                  <p><span className="font-semibold">Appointment:</span> {errorLog.appointment_id ?? "—"}</p>
                  <p><span className="font-semibold">Studio:</span> {errorLog.studio_id ?? "—"}</p>
                  <p><span className="font-semibold">Client:</span> {errorLog.client_id ?? "—"}</p>
                  <p><span className="font-semibold">Package:</span> {errorLog.client_package_id ?? "—"}</p>
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}


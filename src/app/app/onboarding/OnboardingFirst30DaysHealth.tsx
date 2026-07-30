import Link from "next/link";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  FileWarning,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { ARIA_AUTOMATION_PACKS } from "@/lib/aria/automation-catalog";

const FINANCIAL_GUARD_RULE_KEYS = [
  "aria_payment_exception",
  "aria_event_unpaid_registration",
  "aria_external_payment_missing",
];

function daysSince(value: string | null | undefined) {
  if (!value) return 0;
  const started = new Date(value).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 86400000));
}

type HealthSignal = {
  key: string;
  title: string;
  detail: string;
  healthy: boolean;
  href: string;
  icon: typeof CheckCircle2;
};

export async function OnboardingFirst30DaysHealth({
  studioId,
  projectId,
  startedAt,
}: {
  studioId: string;
  projectId: string | null;
  startedAt: string | null;
}) {
  const supabase = await createClient();
  const dayNumber = Math.min(30, daysSince(startedAt) + 1);

  const [
    { data: packPreferences, error: packError },
    { data: financialPolicies, error: policyError },
    { data: financialRules, error: ruleError },
    { data: importBatches, error: importError },
    { data: clients, error: clientsError },
    { data: clientLinks, error: linksError },
    { data: exceptions, error: exceptionsError },
  ] = await Promise.all([
    supabase
      .from("aria_automation_pack_preferences")
      .select("pack_key, enabled")
      .eq("studio_id", studioId),
    supabase
      .from("aria_action_policies")
      .select("rule_key, auto_approve")
      .eq("studio_id", studioId)
      .in("rule_key", FINANCIAL_GUARD_RULE_KEYS),
    supabase
      .from("automation_rules")
      .select("rule_key, mode")
      .eq("studio_id", studioId)
      .in("rule_key", FINANCIAL_GUARD_RULE_KEYS),
    supabase
      .from("import_batches")
      .select("id, status, created_at")
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("clients")
      .select("id")
      .eq("studio_id", studioId)
      .limit(500),
    supabase
      .from("client_account_links")
      .select("client_id, status")
      .eq("studio_id", studioId)
      .eq("status", "linked")
      .limit(500),
    projectId
      ? supabase
          .from("onboarding_exceptions")
          .select("id, severity, status")
          .eq("onboarding_project_id", projectId)
          .in("status", ["open", "in_review"])
      : Promise.resolve({ data: [], error: null }),
  ]);

  const queryErrors = [
    packError,
    policyError,
    ruleError,
    importError,
    clientsError,
    linksError,
    exceptionsError,
  ].filter(Boolean);

  if (queryErrors.length > 0) {
    return (
      <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-orange-700" />
          <div>
            <p className="text-sm font-semibold text-orange-950">
              First-30-day monitoring could not load completely.
            </p>
            <p className="mt-1 text-sm leading-6 text-orange-800">
              The studio can keep working. Reopen this panel after the current data request succeeds.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const enabledPackKeys = new Set(
    (packPreferences ?? [])
      .filter((row) => row.enabled !== false)
      .map((row) => String(row.pack_key)),
  );
  const expectedPackKeys = ARIA_AUTOMATION_PACKS.filter(
    (pack) => pack.defaultEnabled,
  ).map((pack) => pack.key);
  const missingPackKeys = expectedPackKeys.filter(
    (packKey) => !enabledPackKeys.has(packKey),
  );

  const unsafePolicies = (financialPolicies ?? []).filter(
    (row) => row.auto_approve === true,
  );
  const unsafeRules = (financialRules ?? []).filter(
    (row) => row.mode === "auto_send",
  );

  const failedImports = (importBatches ?? []).filter((batch) =>
    ["failed", "partial_failure", "error"].includes(
      String(batch.status ?? "").toLowerCase(),
    ),
  );
  const openExceptions = exceptions ?? [];

  const clientCount = clients?.length ?? 0;
  const linkedClientIds = new Set(
    (clientLinks ?? []).map((row) => String(row.client_id)),
  );
  const linkedCount = linkedClientIds.size;
  const appAdoptionPercent =
    clientCount > 0 ? Math.round((linkedCount / clientCount) * 100) : 0;

  const signals: HealthSignal[] = [
    {
      key: "aria-packs",
      title: "ARIA operating baseline",
      detail:
        missingPackKeys.length === 0
          ? `All ${expectedPackKeys.length} default operational packs are active.`
          : `${missingPackKeys.length} default operational pack${
              missingPackKeys.length === 1 ? " is" : "s are"
            } missing or disabled.`,
      healthy: missingPackKeys.length === 0,
      href: "/app/automations",
      icon: Bot,
    },
    {
      key: "financial-safety",
      title: "Financial safety boundary",
      detail:
        unsafePolicies.length === 0 && unsafeRules.length === 0
          ? "Protected financial exception rules remain review-only and non-executable."
          : "A protected financial rule is configured too permissively and needs immediate review.",
      healthy: unsafePolicies.length === 0 && unsafeRules.length === 0,
      href: "/app/automations",
      icon: ShieldCheck,
    },
    {
      key: "migration-health",
      title: "Migration and reconciliation",
      detail:
        failedImports.length === 0 && openExceptions.length === 0
          ? "No recent failed imports or unresolved onboarding exceptions are open."
          : `${failedImports.length} failed import${
              failedImports.length === 1 ? "" : "s"
            } and ${openExceptions.length} open onboarding exception${
              openExceptions.length === 1 ? "" : "s"
            } need review.`,
      healthy: failedImports.length === 0 && openExceptions.length === 0,
      href: "/app/settings/import",
      icon: FileWarning,
    },
    {
      key: "student-adoption",
      title: "Student account adoption",
      detail:
        clientCount === 0
          ? "Student account adoption will begin after client records are added."
          : `${linkedCount} of ${clientCount} sampled clients are linked to a DanceFlow account (${appAdoptionPercent}%).`,
      healthy: clientCount === 0 || linkedCount > 0,
      href: "/app/clients",
      icon: Smartphone,
    },
  ];

  const issues = signals.filter((signal) => !signal.healthy);

  return (
    <div>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
            First 30 days
          </p>
          <h3 className="mt-2 text-xl font-semibold text-slate-950">
            ARIA is watching the launch, not asking you to configure it.
          </h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            This checks the operational signals most likely to reveal a weak launch:
            automation defaults, financial safety, migration health, and student adoption.
          </p>
        </div>
        <span className="self-start rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700 ring-1 ring-violet-200">
          Day {dayNumber} of 30
        </span>
      </div>

      <div className="mt-5 space-y-3">
        {signals.map((signal) => {
          const Icon = signal.icon;
          return (
            <Link
              key={signal.key}
              href={signal.href}
              className={`flex items-start gap-3 rounded-2xl border p-4 transition hover:shadow-sm ${
                signal.healthy
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-orange-200 bg-orange-50"
              }`}
            >
              <div
                className={`rounded-full p-2 ${
                  signal.healthy
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-orange-100 text-orange-700"
                }`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-slate-950">
                    {signal.title}
                  </p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      signal.healthy
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-orange-100 text-orange-700"
                    }`}
                  >
                    {signal.healthy ? "Healthy" : "Needs attention"}
                  </span>
                </div>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  {signal.detail}
                </p>
              </div>
            </Link>
          );
        })}
      </div>

      <div
        className={`mt-5 rounded-2xl border p-4 ${
          issues.length === 0
            ? "border-emerald-200 bg-emerald-50"
            : "border-orange-200 bg-orange-50"
        }`}
      >
        <div className="flex items-start gap-3">
          {issues.length === 0 ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
          ) : (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-orange-700" />
          )}
          <div>
            <p className="text-sm font-semibold text-slate-950">
              {issues.length === 0
                ? "No first-30-day launch risks are currently visible."
                : `${issues.length} launch health signal${
                    issues.length === 1 ? "" : "s"
                  } need attention.`}
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {issues.length === 0
                ? "Continue normal studio operations. ARIA can surface exceptions as real activity accumulates."
                : "Open only the affected area above. Routine setup remains automated and does not need to be revisited."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

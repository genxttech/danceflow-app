import type { SupabaseClient } from "@supabase/supabase-js";

type Props = {
  supabase: SupabaseClient;
  studioId: string;
};

type ImportBatchRow = {
  id: string;
  import_type: string;
  status: string;
  failed_rows: number;
  reconciliation_status: string;
  summary: Record<string, unknown> | null;
  completed_at: string | null;
};

type StageDefinition = {
  key: string;
  label: string;
  description: string;
  required: boolean;
};

const STAGES: StageDefinition[] = [
  {
    key: "clients",
    label: "Clients",
    description: "Identity, contacts, and relationships",
    required: true,
  },
  {
    key: "instructors",
    label: "Staff",
    description: "Teaching staff and safe role review",
    required: true,
  },
  {
    key: "packages",
    label: "Packages",
    description: "Pricing options and visits remaining",
    required: false,
  },
  {
    key: "memberships",
    label: "Contracts",
    description: "Membership periods and billing state",
    required: false,
  },
  {
    key: "appointments",
    label: "Schedule",
    description: "Appointments, classes, and enrollments",
    required: true,
  },
  {
    key: "attendance",
    label: "Attendance",
    description: "Visits without repeat balance deductions",
    required: false,
  },
  {
    key: "payments",
    label: "Payments",
    description: "Sales, refunds, and chargebacks",
    required: true,
  },
  {
    key: "account_credits",
    label: "Account Credits",
    description: "Client balances and ledger reconciliation",
    required: false,
  },
];

function readNumber(summary: Record<string, unknown> | null, key: string) {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stageTone(status: "ready" | "attention" | "not_started" | "optional") {
  if (status === "ready") return "border-green-200 bg-green-50 text-green-700";
  if (status === "attention") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "optional") return "border-violet-200 bg-violet-50 text-violet-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function statusLabel(status: "ready" | "attention" | "not_started" | "optional") {
  if (status === "ready") return "Ready";
  if (status === "attention") return "Needs review";
  if (status === "optional") return "Optional";
  return "Not started";
}

export default async function MindbodyMigrationPilotReadiness({
  supabase,
  studioId,
}: Props) {
  const { data, error } = await supabase
    .from("import_batches")
    .select(
      "id, import_type, status, failed_rows, reconciliation_status, summary, completed_at",
    )
    .eq("studio_id", studioId)
    .eq("source_system", "mindbody")
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <section className="rounded-3xl border border-amber-200 bg-amber-50 p-6">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-amber-700">
          Mindbody Pilot Readiness
        </p>
        <p className="mt-2 text-sm text-amber-800">
          Readiness data could not be loaded. Refresh after confirming the
          migration foundation and access policies.
        </p>
      </section>
    );
  }

  const batches = (data ?? []) as ImportBatchRow[];
  const latestByStage = new Map<string, ImportBatchRow>();

  for (const batch of batches) {
    if (!latestByStage.has(batch.import_type)) {
      latestByStage.set(batch.import_type, batch);
    }
  }

  const stageResults = STAGES.map((stage) => {
    const batch = latestByStage.get(stage.key) ?? null;
    let status: "ready" | "attention" | "not_started" | "optional";

    if (!batch) {
      status = stage.required ? "not_started" : "optional";
    } else if (
      batch.failed_rows > 0 ||
      batch.status === "failed" ||
      batch.reconciliation_status === "needs_review"
    ) {
      status = "attention";
    } else if (
      batch.status === "completed" &&
      batch.reconciliation_status === "reconciled"
    ) {
      status = "ready";
    } else {
      status = "attention";
    }

    return { stage, batch, status };
  });

  const requiredStages = stageResults.filter((row) => row.stage.required);
  const requiredReady = requiredStages.filter((row) => row.status === "ready").length;
  const attentionCount = stageResults.filter((row) => row.status === "attention").length;
  const failedRows = batches.reduce(
    (total, batch) => total + Number(batch.failed_rows ?? 0),
    0,
  );

  const relationshipReviewRows = batches.reduce(
    (total, batch) => total + readNumber(batch.summary, "relationship_review_rows"),
    0,
  );
  const futureBillingSetupRequired = batches.reduce(
    (total, batch) => total + readNumber(batch.summary, "future_billing_setup_required"),
    0,
  );
  const waitlistRows = batches.reduce(
    (total, batch) => total + readNumber(batch.summary, "waitlist_rows"),
    0,
  );
  const remainingVisitUnits = batches.reduce(
    (total, batch) => total + readNumber(batch.summary, "current_balance_units"),
    0,
  );
  const netCreditChange = batches.reduce(
    (total, batch) => total + readNumber(batch.summary, "net_credit_change"),
    0,
  );

  const pilotReady =
    requiredReady === requiredStages.length &&
    attentionCount === 0 &&
    failedRows === 0;

  return (
    <section className="overflow-hidden rounded-3xl border border-[#E9D5FF] bg-white shadow-sm">
      <div className="bg-gradient-to-r from-[#241033] via-[#5B197A] to-[#F97316] p-6 text-white">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-white/75">
              Mindbody Migration
            </p>
            <h2 className="mt-2 text-2xl font-semibold">
              Pilot readiness and reconciliation
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/85">
              Confirm identities, schedule, remaining visits, contracts,
              historical finances, and unresolved source exceptions before
              activating the migrated studio.
            </p>
          </div>

          <span
            className={`inline-flex w-fit rounded-full px-4 py-2 text-sm font-semibold ${
              pilotReady
                ? "bg-green-100 text-green-800"
                : "bg-white/15 text-white ring-1 ring-white/30"
            }`}
          >
            {pilotReady ? "Pilot ready" : "Pilot review required"}
          </span>
        </div>
      </div>

      <div className="p-5 md:p-6">
        <div className="flex snap-x gap-3 overflow-x-auto pb-2 md:grid md:grid-cols-5 md:overflow-visible">
          <div className="min-w-[11rem] snap-start rounded-2xl border border-[#E9D5FF] bg-[#FCF8FF] p-4 md:min-w-0">
            <p className="text-xs uppercase tracking-wide text-[#806F89]">
              Required stages
            </p>
            <p className="mt-2 text-2xl font-semibold text-[#2C1838]">
              {requiredReady}/{requiredStages.length}
            </p>
          </div>
          <div className="min-w-[11rem] snap-start rounded-2xl border border-[#E9D5FF] bg-[#FCF8FF] p-4 md:min-w-0">
            <p className="text-xs uppercase tracking-wide text-[#806F89]">
              Needs review
            </p>
            <p className="mt-2 text-2xl font-semibold text-[#2C1838]">
              {attentionCount}
            </p>
          </div>
          <div className="min-w-[11rem] snap-start rounded-2xl border border-[#E9D5FF] bg-[#FCF8FF] p-4 md:min-w-0">
            <p className="text-xs uppercase tracking-wide text-[#806F89]">
              Failed rows
            </p>
            <p className="mt-2 text-2xl font-semibold text-[#2C1838]">
              {failedRows}
            </p>
          </div>
          <div className="min-w-[11rem] snap-start rounded-2xl border border-[#E9D5FF] bg-[#FCF8FF] p-4 md:min-w-0">
            <p className="text-xs uppercase tracking-wide text-[#806F89]">
              Relationship review
            </p>
            <p className="mt-2 text-2xl font-semibold text-[#2C1838]">
              {relationshipReviewRows}
            </p>
          </div>
          <div className="min-w-[11rem] snap-start rounded-2xl border border-[#E9D5FF] bg-[#FCF8FF] p-4 md:min-w-0">
            <p className="text-xs uppercase tracking-wide text-[#806F89]">
              Billing setup
            </p>
            <p className="mt-2 text-2xl font-semibold text-[#2C1838]">
              {futureBillingSetupRequired}
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {stageResults.map(({ stage, batch, status }) => (
            <div
              key={stage.key}
              className="rounded-2xl border border-[#E9D5FF] bg-white p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-[#2C1838]">{stage.label}</p>
                  <p className="mt-1 text-xs leading-5 text-[#806F89]">
                    {stage.description}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${stageTone(
                    status,
                  )}`}
                >
                  {statusLabel(status)}
                </span>
              </div>

              <div className="mt-4 text-xs text-[#6F5A7A]">
                {batch ? (
                  <>
                    <p>Status: {batch.status.replaceAll("_", " ")}</p>
                    <p className="mt-1">
                      Reconciliation: {batch.reconciliation_status.replaceAll("_", " ")}
                    </p>
                  </>
                ) : (
                  <p>
                    {stage.required
                      ? "Complete this stage before activation."
                      : "Run only when the source studio has this data."}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
            <p className="text-sm font-semibold text-violet-800">
              Remaining visits preserved
            </p>
            <p className="mt-2 text-2xl font-semibold text-violet-900">
              {remainingVisitUnits}
            </p>
            <p className="mt-1 text-xs text-violet-700">
              Current package visits without historical re-deduction.
            </p>
          </div>

          <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
            <p className="text-sm font-semibold text-orange-800">
              Net account-credit change
            </p>
            <p className="mt-2 text-2xl font-semibold text-orange-900">
              ${netCreditChange.toFixed(2)}
            </p>
            <p className="mt-1 text-xs text-orange-700">
              Imported credits minus debits.
            </p>
          </div>

          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-800">
              Waitlist review
            </p>
            <p className="mt-2 text-2xl font-semibold text-amber-900">
              {waitlistRows}
            </p>
            <p className="mt-1 text-xs text-amber-700">
              Class roster exceptions requiring review.
            </p>
          </div>

          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-800">
              Activation gate
            </p>
            <p className="mt-2 text-sm leading-6 text-amber-900">
              Do not activate until required stages reconcile, failed rows are
              resolved, waitlists are reviewed, and future billing is set up
              intentionally.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

import Link from "next/link";
import { AlertTriangle, CheckCircle2, CircleDashed, ShieldCheck } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";

type ImportBatch = {
  id: string;
  import_type: string;
  status: string;
  mode: string;
  failed_rows: number;
  reconciliation_status: string;
  created_at: string;
  summary: Record<string, unknown> | null;
};

type StageStatus = {
  key: string;
  label: string;
  required: boolean;
  batch: ImportBatch | null;
  ready: boolean;
  detail: string;
};

const STAGES = [
  { key: "products", label: "Catalog and variants", required: true },
  { key: "inventory", label: "Inventory", required: true },
  { key: "retail_orders", label: "Customers and historical commerce", required: true },
  { key: "digital_entitlements", label: "Digital access", required: false },
] as const;

function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestByType(batches: ImportBatch[]) {
  const result = new Map<string, ImportBatch>();
  for (const batch of batches) {
    if (!result.has(batch.import_type)) result.set(batch.import_type, batch);
  }
  return result;
}

function statusLabel(batch: ImportBatch | null) {
  if (!batch) return "Not tested";
  if (batch.failed_rows > 0 || batch.reconciliation_status === "needs_review") {
    return "Needs review";
  }
  if (
    ["completed", "completed_with_warnings"].includes(batch.status) &&
    batch.reconciliation_status === "reconciled"
  ) {
    return "Reconciled";
  }
  if (batch.status === "validated" && batch.mode === "dry_run") return "Dry run ready";
  return batch.status.replaceAll("_", " ");
}

function stageDetail(batch: ImportBatch | null) {
  if (!batch) return "No Square batch has been completed for this stage.";
  const summary = batch.summary ?? {};
  const rows =
    number(summary.row_count) ||
    number(summary.ready_rows) ||
    number(summary.square_order_count);
  const failures = batch.failed_rows || number(summary.execution_error_count);
  if (failures > 0) return `${failures} row${failures === 1 ? "" : "s"} need attention.`;
  if (rows > 0) return `${rows} source record${rows === 1 ? "" : "s"} reviewed.`;
  return `Latest batch: ${statusLabel(batch)}.`;
}

export default async function SquareMigrationPilotReadiness({
  supabase,
  studioId,
}: {
  supabase: SupabaseClient;
  studioId: string;
}) {
  const [
    { data: batches, error: batchesError },
    { count: productCount, error: productsError },
    { count: variantCount, error: variantsError },
    { count: orderCount, error: ordersError },
    { count: paymentCount, error: paymentsError },
    { count: deferredOrderCount, error: deferredError },
    { count: entitlementCount, error: entitlementsError },
  ] = await Promise.all([
    supabase
      .from("import_batches")
      .select(
        "id, import_type, status, mode, failed_rows, reconciliation_status, created_at, summary",
      )
      .eq("studio_id", studioId)
      .eq("source_system", "square")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("commerce_catalog_items")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("source_system", "square"),
    supabase
      .from("commerce_product_variants")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("source_system", "square"),
    supabase
      .from("commerce_orders")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("source_system", "square"),
    supabase
      .from("payments")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("source_system", "square"),
    supabase
      .from("commerce_orders")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .eq("source_system", "square")
      .eq("accounting_sync_mode", "deferred"),
    supabase
      .from("commerce_entitlements")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .contains("metadata", { source: "square_import" }),
  ]);

  const loadError =
    batchesError ||
    productsError ||
    variantsError ||
    ordersError ||
    paymentsError ||
    deferredError ||
    entitlementsError;

  if (loadError) {
    return (
      <section className="rounded-3xl border border-rose-200 bg-rose-50 p-5 text-rose-900">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <h2 className="font-semibold">Square pilot readiness could not load</h2>
            <p className="mt-1 text-sm">{loadError.message}</p>
          </div>
        </div>
      </section>
    );
  }

  const typedBatches = (batches ?? []) as ImportBatch[];
  const latest = latestByType(typedBatches);
  const stages: StageStatus[] = STAGES.map((stage) => {
    const batch = latest.get(stage.key) ?? null;
    const ready =
      batch !== null &&
      batch.failed_rows === 0 &&
      batch.reconciliation_status === "reconciled" &&
      ["completed", "completed_with_warnings"].includes(batch.status);

    return {
      ...stage,
      batch,
      ready,
      detail: stageDetail(batch),
    };
  });

  const requiredStages = stages.filter((stage) => stage.required);
  const requiredReady = requiredStages.filter((stage) => stage.ready).length;
  const failedRows = typedBatches.reduce(
    (sum, batch) => sum + Number(batch.failed_rows ?? 0),
    0,
  );
  const needsReviewBatches = typedBatches.filter(
    (batch) =>
      batch.reconciliation_status === "needs_review" ||
      batch.failed_rows > 0 ||
      batch.status === "failed",
  ).length;

  const accountingProtected =
    Number(orderCount ?? 0) === 0 ||
    Number(deferredOrderCount ?? 0) === Number(orderCount ?? 0);
  const coreReady =
    requiredReady === requiredStages.length &&
    failedRows === 0 &&
    needsReviewBatches === 0 &&
    accountingProtected;

  const readinessScore = Math.round(
    (requiredReady / requiredStages.length) * 70 +
      (accountingProtected ? 20 : 0) +
      (failedRows === 0 && needsReviewBatches === 0 ? 10 : 0),
  );

  const metrics = [
    {
      label: "Pilot readiness",
      value: `${readinessScore}%`,
      detail: coreReady ? "Core Square stages reconciled" : "More review required",
    },
    {
      label: "Catalog",
      value: `${productCount ?? 0} / ${variantCount ?? 0}`,
      detail: "Products / variants",
    },
    {
      label: "Historical commerce",
      value: `${orderCount ?? 0}`,
      detail: `${paymentCount ?? 0} linked payments`,
    },
    {
      label: "Digital access",
      value: `${entitlementCount ?? 0}`,
      detail: "Imported entitlements",
    },
  ];

  return (
    <section className="overflow-hidden rounded-[30px] border border-[var(--brand-border)] bg-white shadow-sm">
      <div className="bg-[linear-gradient(135deg,#24113d_0%,var(--brand-primary)_58%,#f97316_145%)] p-6 text-white md:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/70">
              Square migration pilot
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">
              Reconciliation and go-live readiness
            </h2>
            <p className="mt-2 text-sm leading-6 text-white/80">
              Confirm that catalog, inventory, historical commerce, accounting
              protection, and optional digital access are safe before closing the
              migration project.
            </p>
          </div>
          <div className="inline-flex w-fit items-center gap-2 rounded-2xl border border-white/15 bg-white/10 px-4 py-3">
            {coreReady ? (
              <ShieldCheck className="h-5 w-5 text-emerald-200" />
            ) : (
              <CircleDashed className="h-5 w-5 text-amber-200" />
            )}
            <div>
              <p className="text-xs text-white/70">Current decision</p>
              <p className="font-semibold">
                {coreReady ? "Ready for pilot sign-off" : "Continue reconciliation"}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-5 py-5 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible lg:grid-cols-4">
        {metrics.map((metric) => (
          <div
            key={metric.label}
            className="min-w-[220px] snap-start rounded-2xl border border-violet-100 bg-[linear-gradient(145deg,#fff_0%,#faf5ff_100%)] p-4 sm:min-w-0"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
              {metric.label}
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {metric.value}
            </p>
            <p className="mt-1 text-xs text-slate-500">{metric.detail}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-5 border-t border-violet-100 p-5 lg:grid-cols-[1.35fr_0.65fr] lg:p-6">
        <div>
          <h3 className="text-lg font-semibold text-slate-950">
            Stage reconciliation
          </h3>
          <div className="mt-4 space-y-3">
            {stages.map((stage) => (
              <article
                key={stage.key}
                className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  {stage.ready ? (
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                  ) : (
                    <CircleDashed className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                  )}
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-slate-950">{stage.label}</p>
                      {!stage.required ? (
                        <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
                          Optional
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-slate-600">{stage.detail}</p>
                  </div>
                </div>
                <span
                  className={`w-fit rounded-full px-3 py-1 text-xs font-semibold capitalize ${
                    stage.ready
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-amber-50 text-amber-800"
                  }`}
                >
                  {statusLabel(stage.batch)}
                </span>
              </article>
            ))}
          </div>
        </div>

        <aside className="rounded-2xl border border-violet-200 bg-violet-50/70 p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
            Pilot safeguards
          </p>
          <div className="mt-4 space-y-4 text-sm">
            <div>
              <p className="font-semibold text-slate-950">
                Historical accounting
              </p>
              <p className="mt-1 text-slate-600">
                {accountingProtected
                  ? `${deferredOrderCount ?? 0} of ${orderCount ?? 0} Square orders remain deferred.`
                  : "One or more imported Square orders are not accounting-deferred."}
              </p>
            </div>
            <div>
              <p className="font-semibold text-slate-950">Rerun safety</p>
              <p className="mt-1 text-slate-600">
                Source IDs, SKU/barcode conflict checks, inventory deltas, and
                duplicate-entitlement guards protect create-or-update reruns.
              </p>
            </div>
            <div>
              <p className="font-semibold text-slate-950">Open exceptions</p>
              <p className="mt-1 text-slate-600">
                {needsReviewBatches === 0 && failedRows === 0
                  ? "No failed rows or batches currently need review."
                  : `${needsReviewBatches} batch${needsReviewBatches === 1 ? "" : "es"} and ${failedRows} failed row${failedRows === 1 ? "" : "s"} remain.`}
              </p>
            </div>
          </div>

          <Link
            href="/app/onboarding"
            className="mt-5 inline-flex rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white hover:opacity-95"
          >
            Review onboarding readiness
          </Link>
        </aside>
      </div>
    </section>
  );
}

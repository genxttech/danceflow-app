import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  BadgeCheck,
  Building2,
  CheckCircle2,
  ExternalLink,
  HeartPulse,
  Link2,
  LockKeyhole,
  ShieldCheck,
  Unplug,
  UsersRound,
} from "lucide-react";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import {
  checkGustoConnectionAction,
  disconnectGustoAction,
  syncGustoWorkersAction,
  saveGustoWorkerMatchAction,
  clearGustoWorkerMatchAction,
  createGustoDemoWorkerAction,
} from "./actions";

type PageProps = {
  searchParams: Promise<{ status?: string }>;
};

const statusText: Record<string, string> = {
  connected: "Gusto is connected to this DanceFlow studio.",
  disconnected: "Gusto was disconnected from this studio.",
  health_check_succeeded: "The Gusto connection is healthy.",
  health_check_failed:
    "Gusto could not be reached. Review the connection details and reconnect if needed.",
  connection_unavailable:
    "Connect or reconnect Gusto before checking its health.",
  oauth_denied: "Gusto authorization was cancelled.",
  invalid_state:
    "The Gusto authorization session expired. Start the connection again.",
  forbidden: "Your current studio role cannot manage this connection.",
  connection_failed:
    "Gusto could not be connected. Review server configuration and logs.",
  workers_synced: "The Gusto worker roster was refreshed.",
  worker_sync_failed: "The Gusto worker roster could not be refreshed.",
  worker_matched: "The DanceFlow instructor was matched to the Gusto worker.",
  worker_match_cleared: "The Gusto worker match was cleared.",
  worker_match_invalid: "Choose a valid DanceFlow instructor and Gusto worker.",
  worker_match_failed: "The worker match could not be saved.",
  demo_worker_created: "The test employee was created in Gusto. Refresh the worker roster to reconcile it.",
  demo_worker_failed: "Gusto could not create the test employee. Review the local server log and application scopes.",
  demo_worker_invalid: "Choose a valid DanceFlow instructor before creating a test employee.",
  demo_worker_missing_identity: "The instructor needs a first name, last name, and email before a matching test employee can be created.",
  demo_worker_forbidden: "Test employees can only be created in the Gusto demo environment.",
};

function formatDate(value: string | null | undefined) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export default async function GustoSettingsPage({
  searchParams,
}: PageProps) {
  const context = await getCurrentStudioContext();
  if (!canManageSettings(context.studioRole ?? "")) redirect("/app");

  const params = await searchParams;
  const supabase = await createClient();
  const [{ data: connection }, { data: auditEvents }] =
    await Promise.all([
      supabase
        .from("studio_gusto_connections")
        .select(
          "id, status, environment, gusto_company_uuid, gusto_company_name, scopes, connected_at, last_health_check_at, last_health_status, last_error, updated_at",
        )
        .eq("studio_id", context.studioId)
        .maybeSingle(),
      supabase
        .from("studio_gusto_audit_events")
        .select(
          "id, event_type, outcome, details, created_at",
        )
        .eq("studio_id", context.studioId)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

  const connected = connection?.status === "connected";
  const needsReauth = connection?.status === "needs_reauth";
  const statusMessage =
    params.status && statusText[params.status]
      ? statusText[params.status]
      : null;


  const [{ data: gustoWorkers }, { data: workerMatches }, { data: instructors }] = connected
    ? await Promise.all([
        supabase
          .from("studio_gusto_workers")
          .select("gusto_worker_uuid, gusto_worker_type, first_name, last_name, email, active, onboarding_status, synced_at")
          .eq("studio_id", context.studioId)
          .eq("connection_id", connection.id)
          .order("active", { ascending: false })
          .order("first_name", { ascending: true }),
        supabase
          .from("studio_gusto_worker_matches")
          .select("instructor_id, gusto_worker_uuid, gusto_worker_type, match_method, matched_points, confirmed_at")
          .eq("studio_id", context.studioId)
          .eq("connection_id", connection.id),
        supabase
          .from("instructors")
          .select("id, first_name, last_name, email, active")
          .eq("studio_id", context.studioId)
          .eq("active", true)
          .order("first_name", { ascending: true }),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  const matchByInstructor = new Map(
    (workerMatches ?? []).map((match) => [match.instructor_id, match]),
  );
  const workerByUuid = new Map(
    (gustoWorkers ?? []).map((worker) => [worker.gusto_worker_uuid, worker]),
  );
  const matchedWorkerUuids = new Set(
    (workerMatches ?? []).map((match) => match.gusto_worker_uuid),
  );
  const unmatchedWorkers = (gustoWorkers ?? []).filter(
    (worker) => !matchedWorkerUuids.has(worker.gusto_worker_uuid),
  );

  return (
    <main className="space-y-6 pb-10">
      <header className="overflow-hidden rounded-[32px] border border-violet-300 bg-gradient-to-br from-[#26103D] via-[#5B197A] to-[#7E22CE] text-white shadow-sm">
        <div className="p-6 sm:p-8">
          <Link
            href="/app/settings/integrations"
            className="inline-flex items-center gap-2 text-sm font-semibold text-violet-100 hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to integrations
          </Link>
          <div className="mt-6 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-200">
                Payroll execution
              </p>
              <h1 className="mt-3 text-3xl font-semibold sm:text-4xl">
                Connect DanceFlow Payroll Prep to Gusto
              </h1>
              <p className="mt-3 text-sm leading-6 text-violet-50 sm:text-base">
                DanceFlow remains the operational source of truth for
                instructor earnings and payroll review. Gusto will handle
                specialized payroll execution after explicit human approval.
              </p>
            </div>
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold">
              {connected ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <Link2 className="h-4 w-4" />
              )}
              {connected
                ? "Connected"
                : needsReauth
                  ? "Reconnect required"
                  : "Not connected"}
            </span>
          </div>
        </div>
      </header>

      {statusMessage ? (
        <div className="rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm font-medium text-violet-950">
          {statusMessage}
        </div>
      ) : null}

      {!connected ? (
        <section className="grid overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm md:grid-cols-[1fr_auto] md:items-center">
          <div className="p-6">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#BE185D]">
              Connection foundation
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              {needsReauth ? "Reconnect Gusto" : "Link an existing Gusto company"}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              A primary administrator or full-access Gusto administrator
              must authorize the connection and choose one company.
            </p>
            <a
              href="/api/integrations/gusto/connect"
              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#5B197A] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#46115E]"
            >
              <Link2 className="h-4 w-4" />
              {needsReauth ? "Reconnect Gusto" : "Connect Gusto"}
            </a>
          </div>
          <div className="hidden h-full min-h-52 w-60 items-center justify-center bg-violet-50 text-[#5B197A] md:flex">
            <Building2 className="h-20 w-20" strokeWidth={1.25} />
          </div>
        </section>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <Building2 className="h-5 w-5 text-[#5B197A]" />
              <p className="mt-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                Company
              </p>
              <p className="mt-2 font-semibold text-slate-950">
                {connection.gusto_company_name ?? "Connected company"}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <ShieldCheck className="h-5 w-5 text-[#5B197A]" />
              <p className="mt-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                Environment
              </p>
              <p className="mt-2 font-semibold capitalize text-slate-950">
                {connection.environment}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <HeartPulse className="h-5 w-5 text-[#5B197A]" />
              <p className="mt-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                Last health check
              </p>
              <p className="mt-2 font-semibold text-slate-950">
                {formatDate(connection.last_health_check_at)}
              </p>
              <p className="mt-1 text-xs capitalize text-slate-500">
                {connection.last_health_status ?? "Not checked"}
              </p>
            </div>
          </section>

          {connection.last_error ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              <p className="font-semibold">Connection needs attention</p>
              <p className="mt-1">{connection.last_error}</p>
            </div>
          ) : null}

          <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#BE185D]">
                  Connection controls
                </p>
                <h2 className="mt-2 text-xl font-semibold text-slate-950">
                  Securely linked to one Gusto company
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                  Tokens are encrypted server-side and are never exposed to
                  the browser. This slice does not send workers, hours,
                  earnings, or payroll submissions.
                </p>
              </div>
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
                <BadgeCheck className="h-3.5 w-3.5" />
                Connection only
              </span>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <form action={checkGustoConnectionAction}>
                <button className="inline-flex items-center gap-2 rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white">
                  <HeartPulse className="h-4 w-4" />
                  Check connection
                </button>
              </form>
              <a
                href="/api/integrations/gusto/connect"
                className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-2 text-sm font-semibold text-violet-900"
              >
                <ExternalLink className="h-4 w-4" />
                Reauthorize
              </a>
              <form action={disconnectGustoAction}>
                <button className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700">
                  <Unplug className="h-4 w-4" />
                  Disconnect
                </button>
              </form>
            </div>
          </section>
        </>
      )}



      {connected ? (
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#BE185D]">Worker reconciliation</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-950">Match DanceFlow instructors to Gusto workers</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                DanceFlow automatically confirms only exact full-name and email matches. Every other match requires explicit review before payroll data can be prepared for Gusto.
              </p>
            </div>
            <form action={syncGustoWorkersAction}>
              <button className="rounded-xl bg-[#5B197A] px-4 py-2 text-sm font-semibold text-white">Refresh worker roster</button>
            </form>
          </div>

          <div className="mt-6 space-y-4">
            {(instructors ?? []).length ? (instructors ?? []).map((instructor) => {
              const match = matchByInstructor.get(instructor.id);
              const matchedWorker = match ? workerByUuid.get(match.gusto_worker_uuid) : null;
              return (
                <div key={instructor.id} className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="font-semibold text-slate-950">{`${instructor.first_name ?? ""} ${instructor.last_name ?? ""}`.trim()}</p>
                      <p className="text-sm text-slate-500">{instructor.email ?? "No instructor email recorded"}</p>
                      {matchedWorker ? (
                        <p className="mt-2 text-sm font-medium text-emerald-700">
                          Matched to {`${matchedWorker.first_name ?? ""} ${matchedWorker.last_name ?? ""}`.trim()} · {matchedWorker.gusto_worker_type}
                        </p>
                      ) : (
                        <p className="mt-2 text-sm text-amber-700">Review required before this instructor can be included in a Gusto payroll export.</p>
                      )}
                    </div>
                    {matchedWorker ? (
                      <form action={clearGustoWorkerMatchAction}>
                        <input type="hidden" name="instructorId" value={instructor.id} />
                        <button className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700">Clear match</button>
                      </form>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <form action={saveGustoWorkerMatchAction} className="flex flex-col gap-2 sm:flex-row">
                          <input type="hidden" name="instructorId" value={instructor.id} />
                          <select name="workerUuid" required className="min-w-64 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
                            <option value="">Choose Gusto worker</option>
                            {unmatchedWorkers.map((worker) => (
                              <option key={worker.gusto_worker_uuid} value={worker.gusto_worker_uuid}>
                                {`${worker.first_name ?? ""} ${worker.last_name ?? ""}`.trim()} · {worker.gusto_worker_type}{worker.email ? ` · ${worker.email}` : ""}
                              </option>
                            ))}
                          </select>
                          <button className="rounded-xl bg-violet-50 px-3 py-2 text-sm font-semibold text-violet-900">Confirm match</button>
                        </form>
                        {connection.environment === "demo" ? (
                          <form action={createGustoDemoWorkerAction}>
                            <input type="hidden" name="instructorId" value={instructor.id} />
                            <button className="rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-semibold text-orange-900">
                              Create matching test employee
                            </button>
                          </form>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              );
            }) : <p className="text-sm text-slate-500">No active DanceFlow instructors were found.</p>}
          </div>

          {(gustoWorkers ?? []).length === 0 ? (
            <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-950">
              Refresh the worker roster to load employees and contractors from the connected Gusto demo company.
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-orange-50 text-orange-700">
            <LockKeyhole className="h-5 w-5" />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Guardrails
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              No payroll submission in this slice
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Worker mapping, payroll draft creation, and final payroll
              submission remain separate reviewed phases. ARIA will never
              submit payroll automatically.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <UsersRound className="mt-1 h-5 w-5 text-[#5B197A]" />
          <div>
            <h2 className="text-xl font-semibold text-slate-950">
              Recent connection activity
            </h2>
            <div className="mt-4 space-y-3">
              {(auditEvents ?? []).length ? (
                (auditEvents ?? []).map((event) => (
                  <div
                    key={event.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold capitalize text-slate-950">
                        {event.event_type.replaceAll("_", " ")}
                      </p>
                      <span className="text-xs capitalize text-slate-500">
                        {event.outcome}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatDate(event.created_at)}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-500">
                  No Gusto connection activity yet.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

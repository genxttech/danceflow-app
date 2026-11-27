"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CLASS_HEADLINE, QUALIFICATION_RULES, explainOutcome } from "@/lib/intake/eligibilityExplain";
import { nextAction, canTurnOn, SERVICE_TYPES, SERVICE_TYPE_LABEL, type ConfigView, type ServiceType } from "@/lib/intake/studioConfig";
import type { PreviewView } from "@/lib/intake/previewView";
import { starterDraft, type Draft } from "@/lib/intake/templateSchema";
import { setDefaultTemplateAction, setIntakeEnabledAction, setServiceTypeAction } from "./actions";
import TemplateBuilderPanel from "./TemplateBuilderPanel";

export type BuilderSeed = {
  templateId: string;
  draft: Draft;
  basedOn: "new" | "draft" | "published";
  versionNumber: number | null;
};

const card = "rounded-2xl border border-violet-200 bg-white p-5 shadow-sm";
const primary = "rounded-xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50";
const secondary = "rounded-xl border border-violet-300 bg-white px-3 py-1.5 text-sm font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50";
const TONE: Record<string, string> = {
  positive: "bg-emerald-50 text-emerald-800 border-emerald-200",
  neutral: "bg-slate-100 text-slate-700 border-slate-200",
  attention: "bg-amber-50 text-amber-900 border-amber-200",
};

function formatWhen(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function StudentIntakeWorkspace({
  config,
  preview,
  previewError,
  gateAOpen,
  seed,
}: {
  config: ConfigView;
  preview: PreviewView | null;
  previewError: boolean;
  gateAOpen: boolean;
  /** Builder opened from the URL (?template=…). */
  seed: BuilderSeed | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [builder, setBuilder] = useState<BuilderSeed | null>(seed);
  const [builderKey, setBuilderKey] = useState(0);
  const [confirmEnable, setConfirmEnable] = useState(false);

  const next = nextAction(config);
  const run = (task: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      setError(null);
      const result = await task();
      if (!result.ok) setError(result.error ?? "Something went wrong.");
      else router.refresh();
    });

  const openNew = () => {
    setBuilderKey((k) => k + 1);
    setBuilder({ templateId: "", draft: starterDraft(), basedOn: "new", versionNumber: null });
  };
  const openEdit = (templateId: string) => router.push(`/app/settings/student-intake?template=${templateId}`);
  const closeBuilder = () => {
    setBuilder(null);
    if (seed) router.replace("/app/settings/student-intake");
  };

  const publishedTemplates = config.templates.filter((t) => !t.archived && t.publishedVersion);

  const onNextAction = () => {
    if (next.kind === "create_template") openNew();
    else if (next.kind === "publish_template") openEdit(next.templateId);
    else if (next.kind === "choose_default") document.getElementById("default-form")?.scrollIntoView({ behavior: "smooth" });
    else if (next.kind === "turn_on") document.getElementById("turn-on")?.scrollIntoView({ behavior: "smooth" });
    else document.getElementById("preview")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="space-y-6">
      {!gateAOpen ? (
        <div role="note" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
          <strong>Student Intake is not live yet.</strong> You can set up and publish forms now. No student is contacted, no invitation or email is sent, and no answers are collected until the feature is released.
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">{error}</p>
      ) : null}

      <section className={`${card} flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`} aria-labelledby="next-step">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">Next step</p>
          <h2 id="next-step" className="mt-1 text-xl font-semibold text-slate-950">{next.title}</h2>
          <p className="mt-1 text-sm text-slate-600">{next.detail}</p>
        </div>
        <button type="button" className={primary} onClick={onNextAction}>
          {next.kind === "create_template" ? "Create form" : next.kind === "publish_template" ? "Open form" : next.kind === "review_preview" ? "See preview" : "Go"}
        </button>
      </section>

      <section className={card} aria-labelledby="forms-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="forms-heading" className="text-xl font-semibold text-slate-950">Intake forms</h2>
            <p className="mt-1 text-sm text-slate-600">Students only ever see a published version.</p>
          </div>
          <button type="button" className={secondary} onClick={openNew}>New form</button>
        </div>
        {config.templates.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No forms yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-200 rounded-xl border border-slate-200">
            {config.templates.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="font-semibold text-slate-950">
                    {t.name}
                    {t.isDefault ? <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800">Default</span> : null}
                    {t.archived ? <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">Archived</span> : null}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-600">
                    {t.publishedVersion ? `Published: version ${t.publishedVersion.number}` : "Not published yet"}
                    {t.draftVersion ? ` · Unpublished changes (draft v${t.draftVersion.number})` : ""}
                    {t.assignedTypes.length ? ` · Used for ${t.assignedTypes.map((type) => SERVICE_TYPE_LABEL[type].toLowerCase()).join(", ")}` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  {!t.archived ? <button type="button" className={secondary} onClick={() => openEdit(t.id)}>Edit</button> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={card} aria-labelledby="use-heading">
        <h2 id="use-heading" className="text-xl font-semibold text-slate-950">Which form each lesson type uses</h2>
        <p className="mt-1 text-sm text-slate-600">
          Choose which lesson types ask a new student to complete intake. A lesson type that is not ticked never asks, even when intake is on. Group classes are not included in this version.
        </p>
        <div id="default-form" className="mt-4 space-y-3">
          <label className="grid gap-1 sm:grid-cols-[14rem_1fr] sm:items-center">
            <span className="text-sm font-semibold text-slate-900">Default form</span>
            <select
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              value={config.defaultTemplateId ?? ""}
              disabled={pending || publishedTemplates.length === 0}
              onChange={(e) => e.target.value && run(() => setDefaultTemplateAction(e.target.value))}
            >
              <option value="">{publishedTemplates.length ? "Choose a form…" : "Publish a form first"}</option>
              {publishedTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          {SERVICE_TYPES.map((type: ServiceType) => (
            <div key={type} className="grid gap-2 sm:grid-cols-[14rem_1fr] sm:items-center">
              <label className="flex items-center gap-2 text-sm text-slate-800">
                <input
                  type="checkbox"
                  checked={config.selected[type]}
                  disabled={pending || publishedTemplates.length === 0}
                  onChange={(e) => run(() => setServiceTypeAction(type, e.target.checked, config.assignments[type] ?? ""))}
                />
                <span>{SERVICE_TYPE_LABEL[type]}</span>
              </label>
              <select
                aria-label={`Form for ${SERVICE_TYPE_LABEL[type]}`}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                value={config.assignments[type] ?? ""}
                disabled={pending || publishedTemplates.length === 0 || !config.selected[type]}
                onChange={(e) => run(() => setServiceTypeAction(type, true, e.target.value))}
              >
                <option value="">Use the default form</option>
                {publishedTemplates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </section>

      <section id="turn-on" className={card} aria-labelledby="enable-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="enable-heading" className="text-xl font-semibold text-slate-950">Student Intake is {config.enabled ? "on" : "off"}</h2>
            <p className="mt-1 max-w-xl text-sm text-slate-600">
              {config.enabled
                ? `On since ${config.enabledAt ? new Date(config.enabledAt).toLocaleDateString() : "—"}. Only lessons booked after that date are considered.`
                : canTurnOn(config)
                  ? "Turning it on starts the clock: only lessons booked from now on are ever considered. Existing bookings are not back-filled."
                  : "Choose a default form with a published version to turn this on."}
            </p>
          </div>
          {config.enabled ? (
            <button type="button" className={secondary} disabled={pending} onClick={() => run(() => setIntakeEnabledAction(false))}>Turn off</button>
          ) : confirmEnable ? (
            <div className="flex gap-2">
              <button type="button" className={primary} disabled={pending} onClick={() => { setConfirmEnable(false); run(() => setIntakeEnabledAction(true)); }}>Yes, turn on</button>
              <button type="button" className={secondary} onClick={() => setConfirmEnable(false)}>Not yet</button>
            </div>
          ) : (
            <button type="button" className={primary} disabled={pending || !canTurnOn(config)} onClick={() => setConfirmEnable(true)}>Turn on…</button>
          )}
        </div>
      </section>

      <section id="preview" className={card} aria-labelledby="preview-heading">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="preview-heading" className="text-xl font-semibold text-slate-950">Who would be asked</h2>
            <p className="mt-1 text-sm text-slate-600">A read-only look at upcoming lessons. Nothing is created or sent from here.</p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">Preview only</span>
        </div>

        <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm">
          <summary className="cursor-pointer font-semibold text-violet-800">How a lesson qualifies</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700">
            {QUALIFICATION_RULES.map((rule) => (<li key={rule}>{rule}</li>))}
          </ul>
        </details>

        {previewError ? (
          <p className="mt-4 text-sm text-rose-700">The preview could not be loaded right now. Your settings are unaffected.</p>
        ) : !config.enabled || !preview ? (
          <p className="mt-4 text-sm text-slate-600">Turn Student Intake on to see which upcoming lessons would qualify. Only lessons booked after you turn it on appear here.</p>
        ) : preview.rows.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">No lessons booked since you turned Student Intake on are waiting to be evaluated.</p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-2">
              {(Object.entries(preview.counts) as [keyof typeof CLASS_HEADLINE, number][]).map(([cls, count]) => (
                <span key={cls} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">{CLASS_HEADLINE[cls]}: {count}</span>
              ))}
            </div>
            <ul className="mt-3 divide-y divide-slate-200 rounded-xl border border-slate-200">
              {preview.rows.map((row) => {
                const info = explainOutcome(row.outcome);
                return (
                  <li key={row.appointmentId} className="px-4 py-3">
                    <details>
                      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                        <span className="text-sm text-slate-900">
                          <span className="font-semibold">{row.clientName}</span> · {formatWhen(row.startsAt)} · {row.appointmentType ? row.appointmentType.replace(/_/g, " ") : "lesson"}
                        </span>
                        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE[info.tone]}`}>{info.label}</span>
                      </summary>
                      <div className="mt-2 text-sm leading-6 text-slate-700">
                        <p className="font-medium text-slate-900">{info.summary}</p>
                        <p>{info.reason}</p>
                        {info.nextStep ? <p className="mt-1 text-violet-800">{info.nextStep}</p> : null}
                        {row.templateVersion ? <p className="mt-1 text-xs text-slate-500">Form version that would apply: {row.templateVersion}</p> : null}
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
            {preview.truncated ? <p className="mt-2 text-xs text-slate-500">Showing the first {preview.rows.length} lessons.</p> : null}
          </>
        )}
      </section>

      {builder ? (
        <TemplateBuilderPanel
          key={`${builder.templateId || "new"}-${builderKey}`}
          open
          onClose={closeBuilder}
          templateId={builder.templateId}
          initialDraft={builder.draft}
          basedOn={builder.basedOn}
          versionNumber={builder.versionNumber}
        />
      ) : null}
    </div>
  );
}

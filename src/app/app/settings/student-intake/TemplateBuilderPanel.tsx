"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ResponsiveDetailPanel from "@/components/app/workspace/ResponsiveDetailPanel";
import {
  AUDIENCES,
  AUDIENCE_LABEL,
  CHOICE_TYPES,
  FIELD_TYPES,
  FIELD_TYPE_LABEL,
  VISIBILITIES,
  VISIBILITY_LABEL,
  moveItem,
  newField,
  newSection,
  optionsFromLines,
  rekeyFromLabel,
  validateDraft,
  draftToSchema,
  type Audience,
  type Draft,
  type DraftField,
  type DraftSection,
  type FieldType,
  type Visibility,
} from "@/lib/intake/templateSchema";
import { publishVersionAction, saveTemplateDraftAction } from "./actions";

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200";
const smallButton =
  "rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:border-violet-300 hover:text-violet-800 disabled:opacity-40";

export default function TemplateBuilderPanel({
  open,
  onClose,
  templateId,
  initialDraft,
  basedOn,
  versionNumber,
}: {
  open: boolean;
  onClose: () => void;
  /** Empty for a new form. */
  templateId: string;
  initialDraft: Draft;
  basedOn: "new" | "draft" | "published";
  versionNumber: number | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [currentTemplateId, setCurrentTemplateId] = useState(templateId);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [pending, startTransition] = useTransition();
  const issues = useMemo(() => validateDraft(draft), [draft]);

  const updateSection = (index: number, change: Partial<DraftSection>) =>
    setDraft((d) => ({ ...d, sections: d.sections.map((s, i) => (i === index ? { ...s, ...change } : s)) }));
  const updateField = (si: number, fi: number, change: Partial<DraftField>) =>
    setDraft((d) => ({
      ...d,
      sections: d.sections.map((s, i) => (i === si ? { ...s, fields: s.fields.map((f, j) => (j === fi ? { ...f, ...change } : f)) } : s)),
    }));

  const persist = async () => {
    const result = await saveTemplateDraftAction(currentTemplateId, draft.name, JSON.stringify(draftToSchema(draft)));
    if (result.ok) {
      setCurrentTemplateId(result.templateId);
      setDraft((d) => ({ ...d, sections: d.sections.map((sec) => ({ ...sec, fields: sec.fields.map((f) => ({ ...f, autoKey: false })) })) }));
    }
    return result;
  };

  const saveDraft = () =>
    startTransition(async () => {
      setMessage(null);
      const result = await persist();
      if (result.ok) {
        setMessage({ tone: "ok", text: "Draft saved. Students do not see it until you publish." });
        router.refresh();
      } else setMessage({ tone: "error", text: result.error });
    });

  const publish = () =>
    startTransition(async () => {
      setMessage(null);
      const saved = await persist();
      if (!saved.ok) {
        setMessage({ tone: "error", text: saved.error });
        return;
      }
      const published = await publishVersionAction(saved.versionId);
      if (!published.ok) {
        setMessage({ tone: "error", text: published.error });
        return;
      }
      setConfirmPublish(false);
      router.refresh();
      onClose();
    });

  return (
    <ResponsiveDetailPanel
      open={open}
      onClose={onClose}
      title={currentTemplateId ? "Edit intake form" : "New intake form"}
      description={
        basedOn === "published" && versionNumber
          ? `Editing creates a new version. Version ${versionNumber} stays as it is for anyone already using it.`
          : "Changes stay in a draft until you publish."
      }
      footer={
        <div className="space-y-3">
          {message ? (
            <p
              role="status"
              className={`rounded-xl px-3 py-2 text-sm font-medium ${message.tone === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}
            >
              {message.text}
            </p>
          ) : null}
          {issues.length > 0 ? <p className="text-xs text-slate-500">To publish: {issues[0].message}</p> : null}
          {confirmPublish ? (
            <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-sm text-violet-950">
              <p className="font-semibold">Publish this version?</p>
              <p className="mt-1 text-xs leading-5">
                A published version can’t be edited. Later changes become a new version, and anyone who already finished an earlier version is not asked again.
              </p>
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={pending || issues.length > 0} onClick={publish} className="rounded-xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50">
                  {pending ? "Publishing…" : "Yes, publish"}
                </button>
                <button type="button" onClick={() => setConfirmPublish(false)} className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
                  Not yet
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={pending || issues.length > 0} onClick={() => setConfirmPublish(true)} className="rounded-xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:opacity-50">
                Publish…
              </button>
              <button type="button" disabled={pending || !draft.name.trim()} onClick={saveDraft} className="rounded-xl border border-violet-300 bg-white px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50">
                {pending ? "Saving…" : "Save draft"}
              </button>
            </div>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        <label className="block">
          <span className="text-sm font-semibold text-slate-900">Form name</span>
          <input className={`${inputClass} mt-1`} value={draft.name} maxLength={200} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="e.g. New student intake" />
        </label>

        {draft.sections.map((section, si) => (
          <section key={section.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start gap-2">
              <input
                aria-label={`Section ${si + 1} title`}
                className={`${inputClass} font-semibold`}
                value={section.title}
                maxLength={500}
                placeholder="Section title"
                onChange={(e) => updateSection(si, { title: e.target.value })}
              />
              <div className="flex shrink-0 gap-1">
                <button type="button" className={smallButton} disabled={si === 0} aria-label="Move section up" onClick={() => setDraft((d) => ({ ...d, sections: moveItem(d.sections, si, -1) }))}>↑</button>
                <button type="button" className={smallButton} disabled={si === draft.sections.length - 1} aria-label="Move section down" onClick={() => setDraft((d) => ({ ...d, sections: moveItem(d.sections, si, 1) }))}>↓</button>
                <button type="button" className={smallButton} aria-label="Remove section" onClick={() => setDraft((d) => ({ ...d, sections: d.sections.filter((_, i) => i !== si) }))}>✕</button>
              </div>
            </div>
            <label className="mt-3 block text-xs font-semibold text-slate-600">
              Who answers this section
              <select className={`${inputClass} mt-1`} value={section.audience} onChange={(e) => updateSection(si, { audience: e.target.value as Audience })}>
                {AUDIENCES.map((audience) => (
                  <option key={audience} value={audience}>{AUDIENCE_LABEL[audience]}</option>
                ))}
              </select>
            </label>

            <ul className="mt-4 space-y-3">
              {section.fields.map((field, fi) => (
                <li key={field.id} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                  <div className="flex items-start gap-2">
                    <input
                      aria-label="Question"
                      className={inputClass}
                      value={field.label}
                      maxLength={500}
                      placeholder="Question wording"
                      onChange={(e) =>
                        updateField(si, fi, {
                          label: e.target.value,
                          key: rekeyFromLabel(draft, field, e.target.value),
                        })
                      }
                    />
                    <div className="flex shrink-0 gap-1">
                      <button type="button" className={smallButton} disabled={fi === 0} aria-label="Move question up" onClick={() => updateSection(si, { fields: moveItem(section.fields, fi, -1) })}>↑</button>
                      <button type="button" className={smallButton} disabled={fi === section.fields.length - 1} aria-label="Move question down" onClick={() => updateSection(si, { fields: moveItem(section.fields, fi, 1) })}>↓</button>
                      <button type="button" className={smallButton} aria-label="Remove question" onClick={() => updateSection(si, { fields: section.fields.filter((_, i) => i !== fi) })}>✕</button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <select
                      aria-label="Answer type"
                      className={`${inputClass} max-w-[16rem]`}
                      value={field.type}
                      onChange={(e) => {
                        const type = e.target.value as FieldType;
                        updateField(si, fi, {
                          type,
                          options: CHOICE_TYPES.includes(type) ? (field.options.length ? field.options : [{ key: "option_1", label: "" }]) : [],
                        });
                      }}
                    >
                      {FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>{FIELD_TYPE_LABEL[type]}</option>
                      ))}
                    </select>
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" checked={field.required} onChange={(e) => updateField(si, fi, { required: e.target.checked })} />
                      Required
                    </label>
                  </div>
                  {CHOICE_TYPES.includes(field.type) ? (
                    <label className="mt-2 block text-xs font-semibold text-slate-600">
                      Choices (one per line)
                      <textarea
                        className={`${inputClass} mt-1 font-normal`}
                        rows={Math.max(3, field.options.length + 1)}
                        defaultValue={field.options.map((o) => o.label).join("\n")}
                        onBlur={(e) => updateField(si, fi, { options: optionsFromLines(field, e.target.value) })}
                      />
                    </label>
                  ) : null}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-semibold text-violet-700">Who can see the answer</summary>
                    <select className={`${inputClass} mt-2`} value={field.visibility} onChange={(e) => updateField(si, fi, { visibility: e.target.value as Visibility })}>
                      {VISIBILITIES.map((v) => (
                        <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>
                      ))}
                    </select>
                  </details>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="mt-3 text-sm font-semibold text-violet-700 hover:text-violet-900"
              onClick={() => updateSection(si, { fields: [...section.fields, newField(draft, "short_text")] })}
            >
              + Add question
            </button>
          </section>
        ))}

        <button type="button" className="rounded-xl border border-dashed border-violet-300 px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50" onClick={() => setDraft((d) => ({ ...d, sections: [...d.sections, newSection(d, "")] }))}>
          + Add section
        </button>
      </div>
    </ResponsiveDetailPanel>
  );
}

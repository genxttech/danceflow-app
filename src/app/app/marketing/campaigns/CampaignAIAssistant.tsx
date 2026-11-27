"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import {
  applyCampaignAiSuggestionToDraftAction,
  generateCampaignDraftAssistantAction,
  type CampaignAIAssistantState,
} from "./ai-actions";

type CampaignAIAssistantProps = {
  campaignContext: "studio" | "organizer";
  audienceLabel?: string;
  eventName?: string | null;
  currentSubject?: string | null;
  currentPreviewText?: string | null;
  currentBodyText?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  compact?: boolean;
  /** Studio draft only: when set, generated copy can be applied to this draft after an explicit confirmation. */
  applyToCampaignId?: string;
};

const initialState: CampaignAIAssistantState = {
  ok: false,
};

const taskOptions = [
  { value: "generate", label: "Generate a new draft" },
  { value: "improve", label: "Improve this message" },
  { value: "shorter", label: "Make it shorter" },
  { value: "warmer", label: "Make it warmer" },
  { value: "exciting", label: "Make it more exciting" },
  { value: "subject_lines", label: "Create subject lines" },
];

export default function CampaignAIAssistant({
  campaignContext,
  audienceLabel = "selected audience",
  eventName,
  currentSubject,
  currentPreviewText,
  currentBodyText,
  ctaLabel,
  ctaUrl,
  compact = false,
  applyToCampaignId,
}: CampaignAIAssistantProps) {
  const [state, setState] = useState<CampaignAIAssistantState>(initialState);
  const [task, setTask] = useState(currentBodyText ? "improve" : "generate");
  const [goal, setGoal] = useState("");
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [chosenSubject, setChosenSubject] = useState("");
  const [applyPreview, setApplyPreview] = useState(true);
  const [applyBody, setApplyBody] = useState(true);

  function handleGenerate() {
    startTransition(async () => {
      const formData = new FormData();

      formData.set("campaignContext", campaignContext);
      formData.set("audienceLabel", audienceLabel);
      formData.set("eventName", eventName ?? "");
      formData.set("currentSubject", currentSubject ?? "");
      formData.set("currentPreviewText", currentPreviewText ?? "");
      formData.set("currentBodyText", currentBodyText ?? "");
      formData.set("ctaLabel", ctaLabel ?? "");
      formData.set("ctaUrl", ctaUrl ?? "");
      formData.set("task", task);
      formData.set("goal", goal);

      const result = await generateCampaignDraftAssistantAction(
        initialState,
        formData,
      );

      setState(result);
      setConfirming(false);
      setChosenSubject("");
    });
  }

  return (
    <section className="rounded-3xl border border-[#A64AC9]/20 bg-gradient-to-br from-white via-[#F8F1FB] to-[#FFF4EE] p-4 shadow-sm sm:p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-2xl bg-white p-2 text-[#A64AC9] shadow-sm">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-base font-bold text-[var(--brand-text)]">
            AI campaign helper
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
            Generate a starting draft, then review and edit before sending.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div
          className={
            compact ? "space-y-3" : "grid gap-3 sm:grid-cols-[220px_1fr]"
          }
        >
          <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
            Help me
            <select
              value={task}
              onChange={(event) => setTask(event.target.value)}
              className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
            >
              {taskOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
            Goal or details
            <input
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
              placeholder="Promote a workshop, thank attendees, invite clients back..."
            />
          </label>
        </div>

        <button
          type="button"
          onClick={handleGenerate}
          disabled={isPending}
          className="inline-flex w-full items-center justify-center rounded-2xl bg-[#4D1F47] px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#3D1839] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {isPending ? "Generating..." : "Generate copy"}
        </button>
      </div>

      {state.error ? (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">
          {state.error}
        </div>
      ) : null}

      {state.ok ? (
        <div className="mt-4 space-y-3 rounded-2xl border border-[var(--brand-border)] bg-white p-4">
          {state.subjectIdeas?.length ? (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-[var(--brand-muted)]">
                Subject ideas
              </p>
              <ul className="mt-2 space-y-1 text-sm leading-6 text-[var(--brand-text)]">
                {state.subjectIdeas.map((subject) => (
                  <li key={subject}>• {subject}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {state.previewText ? (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-[var(--brand-muted)]">
                Preview text
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--brand-text)]">
                {state.previewText}
              </p>
            </div>
          ) : null}

          {state.bodyText ? (
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-[var(--brand-muted)]">
                Message draft
              </p>
              <textarea
                readOnly
                rows={compact ? 8 : 10}
                value={state.bodyText}
                className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-soft-bg)] px-4 py-3 text-sm leading-6 text-[var(--brand-text)]"
              />
              <p className="mt-2 text-xs leading-5 text-[var(--brand-muted)]">
                Copy the parts you want to use into your campaign, then edit
                before sending.
              </p>
            </div>
          ) : null}

          {applyToCampaignId && (state.subjectIdeas?.length || state.previewText || state.bodyText) ? (
            <div className="border-t border-[var(--brand-border)] pt-3">
              {!confirming ? (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="inline-flex items-center justify-center rounded-2xl border border-[#4D1F47] px-4 py-2 text-sm font-bold text-[#4D1F47] transition hover:bg-[#F8F1FB]"
                >
                  Apply to draft...
                </button>
              ) : (
                <form action={applyCampaignAiSuggestionToDraftAction} className="space-y-3">
                  <input type="hidden" name="campaignId" value={applyToCampaignId} />
                  <input type="hidden" name="confirmApply" value="yes" />
                  <p className="text-sm font-semibold text-[var(--brand-text)]">
                    This replaces the selected parts of the draft. Nothing is sent.
                  </p>
                  {state.subjectIdeas?.length ? (
                    <fieldset className="space-y-1 text-sm">
                      <legend className="font-semibold">Subject</legend>
                      <label className="flex items-center gap-2">
                        <input type="radio" checked={chosenSubject === ""} onChange={() => setChosenSubject("")} />
                        Keep the current subject
                      </label>
                      {state.subjectIdeas.map((subject) => (
                        <label key={subject} className="flex items-center gap-2">
                          <input type="radio" checked={chosenSubject === subject} onChange={() => setChosenSubject(subject)} />
                          {subject}
                        </label>
                      ))}
                      <input type="hidden" name="subject" value={chosenSubject} />
                    </fieldset>
                  ) : null}
                  {state.previewText ? (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={applyPreview} onChange={(event) => setApplyPreview(event.target.checked)} />
                      Replace the preview text
                      <input type="hidden" name="previewText" value={applyPreview ? state.previewText : ""} />
                    </label>
                  ) : null}
                  {state.bodyText ? (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={applyBody} onChange={(event) => setApplyBody(event.target.checked)} />
                      Replace the message
                      <input type="hidden" name="bodyText" value={applyBody ? state.bodyText : ""} />
                    </label>
                  ) : null}
                  <div className="flex gap-2">
                    <button type="submit" className="inline-flex items-center justify-center rounded-2xl bg-[#4D1F47] px-4 py-2 text-sm font-bold text-white transition hover:bg-[#3D1839]">
                      Confirm and apply
                    </button>
                    <button type="button" onClick={() => setConfirming(false)} className="inline-flex items-center justify-center rounded-2xl border border-[var(--brand-border)] px-4 py-2 text-sm font-semibold">
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

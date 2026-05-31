"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { ArrowRight, Copy, Sparkles } from "lucide-react";
import {
  generateFollowUpMessageAction,
  type FollowUpMessageState,
} from "./follow-up-ai-actions";

export type SuggestedFollowUpItem = {
  id: string;
  personName: string;
  reason: string;
  suggestedAction: string;
  context?: string;
  href: string;
  priority: "high" | "medium" | "low";
  type: "client" | "lead" | "event_attendee" | "package";
};

type SuggestedFollowUpsCardProps = {
  suggestions: SuggestedFollowUpItem[];
  aiEnabled: boolean;
};

const initialState: FollowUpMessageState = {
  ok: false,
};

function priorityClass(priority: SuggestedFollowUpItem["priority"]) {
  if (priority === "high")
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  if (priority === "medium")
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function typeLabel(type: SuggestedFollowUpItem["type"]) {
  if (type === "event_attendee") return "Event attendee";
  if (type === "package") return "Package";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export default function SuggestedFollowUpsCard({
  suggestions,
  aiEnabled,
}: SuggestedFollowUpsCardProps) {
  const [selectedId, setSelectedId] = useState(suggestions[0]?.id ?? "");
  const [tone, setTone] = useState("friendly and professional");
  const [state, setState] = useState<FollowUpMessageState>(initialState);
  const [isPending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  const selectedSuggestion = useMemo(
    () =>
      suggestions.find((item) => item.id === selectedId) ??
      suggestions[0] ??
      null,
    [selectedId, suggestions],
  );

  if (suggestions.length === 0) {
    return (
      <section className="rounded-[32px] border border-[#E9D5FF] bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[#F3E8FF] p-3 text-[#6B21A8]">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
              Suggested Follow-Ups
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Nothing urgent right now
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              DanceFlow did not find obvious follow-up opportunities from recent
              client, lead, package, or event activity.
            </p>
          </div>
        </div>
      </section>
    );
  }

  function handleGenerateMessage() {
    if (!selectedSuggestion) return;

    setCopied(false);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("personName", selectedSuggestion.personName);
      formData.set("reason", selectedSuggestion.reason);
      formData.set("suggestedAction", selectedSuggestion.suggestedAction);
      formData.set("context", selectedSuggestion.context ?? "");
      formData.set("tone", tone);

      const result = await generateFollowUpMessageAction(
        initialState,
        formData,
      );
      setState(result);
    });
  }

  async function handleCopy() {
    if (!state.message) return;

    await navigator.clipboard.writeText(state.message);
    setCopied(true);
  }

  return (
    <section className="overflow-hidden rounded-[32px] border border-[#E9D5FF] bg-white shadow-sm">
      <div className="border-b border-[#F3E8FF] bg-gradient-to-r from-[#FCF8FF] via-white to-[#FFF7ED] px-6 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-white p-3 text-[#6B21A8] shadow-sm ring-1 ring-[#E9D5FF]">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#7C2D92]">
                Suggested Follow-Ups
              </p>
              <h2 className="mt-2 text-xl font-semibold text-slate-950">
                People who may need attention
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
                Review suggested next steps and generate a short message when
                you are ready to reach out.
              </p>
            </div>
          </div>

          <span className="inline-flex self-start rounded-full bg-[#F3E8FF] px-3 py-1.5 text-xs font-semibold text-[#6B21A8] ring-1 ring-[#E9D5FF]">
            {suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div className="grid gap-5 p-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <div className="space-y-3">
          {suggestions.slice(0, 6).map((suggestion) => {
            const selected = selectedSuggestion?.id === suggestion.id;

            return (
              <button
                key={suggestion.id}
                type="button"
                onClick={() => {
                  setSelectedId(suggestion.id);
                  setState(initialState);
                  setCopied(false);
                }}
                className={`w-full rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-sm ${
                  selected
                    ? "border-[#A64AC9] bg-[#FCF8FF] shadow-sm"
                    : "border-slate-200 bg-slate-50 hover:border-[#D8B4FE] hover:bg-white"
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-950">
                        {suggestion.personName}
                      </h3>
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${priorityClass(suggestion.priority)}`}
                      >
                        {suggestion.priority}
                      </span>
                      <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                        {typeLabel(suggestion.type)}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-700">
                      {suggestion.reason}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-slate-500">
                      {suggestion.suggestedAction}
                    </p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          {selectedSuggestion ? (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Selected follow-up
                </p>
                <h3 className="mt-2 text-base font-semibold text-slate-950">
                  {selectedSuggestion.personName}
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {selectedSuggestion.reason}
                </p>
                <Link
                  href={selectedSuggestion.href}
                  className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-[#6B21A8] hover:underline"
                >
                  Open record
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>

              <label className="block space-y-2 text-sm font-semibold text-slate-900">
                Message tone
                <select
                  value={tone}
                  onChange={(event) => setTone(event.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
                >
                  <option value="friendly and professional">
                    Friendly and professional
                  </option>
                  <option value="short and casual">Short and casual</option>
                  <option value="warm and encouraging">
                    Warm and encouraging
                  </option>
                  <option value="direct and action-oriented">
                    Direct and action-oriented
                  </option>
                </select>
              </label>

              <button
                type="button"
                onClick={handleGenerateMessage}
                disabled={!aiEnabled || isPending}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#4D1F47] px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#3D1839] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Sparkles className="h-4 w-4" />
                {isPending ? "Generating..." : "Generate message"}
              </button>

              {!aiEnabled ? (
                <p className="text-xs leading-5 text-slate-500">
                  AI follow-up help is not enabled for this workspace yet.
                </p>
              ) : null}

              {state.error ? (
                <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">
                  {state.error}
                </div>
              ) : null}

              {state.message ? (
                <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Draft message
                  </p>
                  <textarea
                    readOnly
                    rows={7}
                    value={state.message}
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-800"
                  />
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-[#D8B4FE] hover:text-[#6B21A8]"
                  >
                    <Copy className="h-4 w-4" />
                    {copied ? "Copied" : "Copy message"}
                  </button>
                  <p className="text-xs leading-5 text-slate-500">
                    Review and edit before sending. This does not send anything
                    automatically.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

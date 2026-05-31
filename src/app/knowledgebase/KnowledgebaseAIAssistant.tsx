"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Bot, Sparkles } from "lucide-react";
import {
  askKnowledgebaseAssistantAction,
  type KnowledgebaseAssistantState,
} from "./ai-actions";

const initialState: KnowledgebaseAssistantState = {
  ok: false,
};

const exampleQuestions = [
  "How do I create an event?",
  "How do I check in someone with a QR code?",
  "How do I assign a syllabus?",
  "How do I create a campaign?",
];

export default function KnowledgebaseAIAssistant() {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<KnowledgebaseAssistantState>(initialState);
  const [isPending, startTransition] = useTransition();

  function handleAsk() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("question", question);

      const result = await askKnowledgebaseAssistantAction(initialState, formData);
      setState(result);
    });
  }

  return (
    <section className="overflow-hidden rounded-[32px] border border-[#A64AC9]/20 bg-white shadow-sm">
      <div className="bg-[linear-gradient(135deg,#4D1F47_0%,#A64AC9_55%,#FF7A3D_100%)] px-6 py-6 text-white md:px-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-white/15 p-3 text-white shadow-sm">
              <Bot className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Help Assistant
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                Ask a question about using DanceFlow
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-7 text-white/85">
                Get a quick answer from the knowledgebase, then open the related
                guide for more detail.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-white/20 bg-white/10 px-4 py-3 text-xs leading-5 text-white/80 md:max-w-sm">
            For account, billing, or technical issues, contact support so your
            workspace can be reviewed directly.
          </div>
        </div>
      </div>

      <div className="space-y-4 p-6 md:p-8">
        <label className="block space-y-2 text-sm font-semibold text-slate-900">
          What do you need help with?
          <textarea
            rows={3}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-normal leading-6 text-slate-800 outline-none transition focus:border-[#A64AC9] focus:ring-2 focus:ring-[#A64AC9]/20"
            placeholder="Example: How do I set up early bird ticket pricing for an event?"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          {exampleQuestions.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setQuestion(example)}
              className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-[#A64AC9]/30 hover:bg-[#F8F1FB] hover:text-[#4D1F47]"
            >
              {example}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={handleAsk}
          disabled={isPending || question.trim().length < 6}
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#4D1F47] px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#3D1839] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          <Sparkles className="h-4 w-4" />
          {isPending ? "Finding an answer..." : "Ask DanceFlow Help"}
        </button>

        {state.error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-800">
            {state.error}
          </div>
        ) : null}

        {state.ok && state.answer ? (
          <div className="space-y-4 rounded-3xl border border-slate-200 bg-slate-50 p-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Answer
              </p>
              <div className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-800">
                {state.answer}
              </div>
            </div>

            {state.relatedArticles?.length ? (
              <div className="border-t border-slate-200 pt-4">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                  Related guides
                </p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {state.relatedArticles.map((article) => (
                    <Link
                      key={article.href}
                      href={article.href}
                      className="rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-[#A64AC9]/40 hover:shadow-sm"
                    >
                      <p className="text-xs font-semibold uppercase tracking-wide text-[#A64AC9]">
                        {article.category}
                      </p>
                      <h3 className="mt-2 text-sm font-semibold text-slate-950">
                        {article.title}
                      </h3>
                      <p className="mt-2 text-xs leading-5 text-slate-600">
                        {article.description}
                      </p>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

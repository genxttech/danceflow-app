"use client";

import { useState } from "react";

export default function CopyCalendarFeedButton({
  feedUrl,
  buttonLabel = "Copy Link",
  copiedLabel = "Copied",
  tip = "Tip: Some calendar tools refresh subscribed calendars on their own schedule, so website updates may not appear instantly.",
  multiline = false,
}: {
  feedUrl: string;
  buttonLabel?: string;
  copiedLabel?: string;
  tip?: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copyFeedUrl() {
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);

      window.setTimeout(() => {
        setCopied(false);
      }, 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-3 sm:flex-row sm:items-start">
        {multiline ? (
          <textarea
            value={feedUrl}
            readOnly
            rows={5}
            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs leading-5 text-slate-700 outline-none"
            onFocus={(event) => event.currentTarget.select()}
          />
        ) : (
          <input
            value={feedUrl}
            readOnly
            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none"
            onFocus={(event) => event.currentTarget.select()}
          />
        )}

        <button
          type="button"
          onClick={copyFeedUrl}
          className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          {copied ? copiedLabel : buttonLabel}
        </button>
      </div>

      {tip ? <p className="text-xs leading-5 text-slate-500">{tip}</p> : null}
    </div>
  );
}

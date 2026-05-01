"use client";

import { useMemo, useState } from "react";

type ShareButtonProps = {
  title: string;
  text?: string;
  url?: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
};

function buildShareUrl(url?: string) {
  if (typeof window === "undefined") return url ?? "";

  if (!url) return window.location.href;

  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return window.location.href;
  }
}

export default function ShareButton({
  title,
  text,
  url,
  label = "Share",
  copiedLabel = "Link copied",
  className,
}: ShareButtonProps) {
  const [copied, setCopied] = useState(false);

  const buttonClassName = useMemo(
    () =>
      className ||
      "inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50",
    [className]
  );

  async function handleShare() {
    const shareUrl = buildShareUrl(url);
    const shareText = text || title;

    try {
      if (navigator.share) {
        await navigator.share({
          title,
          text: shareText,
          url: shareUrl,
        });
        return;
      }

      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      try {
        await navigator.clipboard.writeText(shareUrl);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      } catch {
        setCopied(false);
      }
    }
  }

  return (
    <button
      type="button"
      onClick={handleShare}
      className={buttonClassName}
      aria-label={copied ? copiedLabel : label}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
        <path d="M16 6l-4-4-4 4" />
        <path d="M12 2v14" />
      </svg>
      <span>{copied ? copiedLabel : label}</span>
    </button>
  );
}
